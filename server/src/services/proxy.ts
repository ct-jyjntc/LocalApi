import http from "http";
import https from "https";
import { once } from "events";
import fetch, { Response as FetchResponse } from "node-fetch";
import type { Response as ExpressResponse } from "express";
import { v4 as uuid } from "uuid";
import { ApiKey, getSetting, Provider } from "../db";
import { writeLog } from "./logs";
import {
  getProvider,
  listProviders,
  listProvidersForModel,
  mapProviderModel,
  pickProviderKey,
} from "./providers";
import { createResponseLogCollector, extractIO } from "../utils/content";
import { createUpstreamTimeout, upstreamTimeoutError } from "./upstream-timeout";
import { AccessError, beginRequestAccess, RequestAccess } from "./access";
import {
  buildProviderAffinityKey,
  forgetProviderAffinity,
  orderProvidersForConversation,
  rememberProviderAffinity,
} from "./provider-affinity";
import {
  BillingError,
  BillingReservation,
  estimateRequestTokens,
  reserveUsage,
  settleUsage,
} from "./billing";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const configuredMaxSockets = Number(process.env.UPSTREAM_MAX_SOCKETS || 256);
const maxSockets = Number.isFinite(configuredMaxSockets)
  ? Math.max(16, Math.floor(configuredMaxSockets))
  : 256;
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets,
  maxFreeSockets: Math.min(64, maxSockets),
  scheduling: "lifo",
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets,
  maxFreeSockets: Math.min(64, maxSockets),
  scheduling: "lifo",
});

export type ProxyContext = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: string | Buffer;
  bodyStream?: NodeJS.ReadableStream;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  apiKey?: ApiKey | null;
  billingMode?: "wallet" | "coding";
  clientPath?: string;
};

type ProxyResult = {
  statusCode: number;
  responseBytes: number;
  io: ReturnType<typeof extractIO>;
  error: string | null;
};

type UpstreamHandle = {
  response: FetchResponse;
  abort: () => void;
  clearTimeout: () => void;
  didTimeout: () => boolean;
  onBodyChunk: (streaming: boolean) => void;
};

/** After first stream byte, abort if no further data for this long (upstream stall). */
const STREAM_IDLE_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.STREAM_IDLE_TIMEOUT_MS || 3 * 60_000) || 3 * 60_000,
);

/** Absolute max lifetime for any single proxied request. */
const REQUEST_MAX_MS = Math.max(
  60_000,
  Number(process.env.REQUEST_MAX_MS || 15 * 60_000) || 15 * 60_000,
);

function bindClientAbort(res: ExpressResponse, onAbort: () => void) {
  const req = res.req;
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onAbort();
  };
  // Only treat a response close as abort when we never finished writing.
  // Do NOT key off req "close"/destroyed — those fire on normal request completion too.
  res.once("close", () => {
    if (!res.writableEnded) fire();
  });
  req?.once("aborted", fire);
  return () => {
    fired = true;
  };
}

function pickModel(body: unknown, query: Record<string, unknown>): string | null {
  if (body && typeof body === "object" && "model" in (body as object)) {
    const m = (body as { model?: unknown }).model;
    if (typeof m === "string") return m;
  }
  if (typeof query.model === "string") return query.model;
  return null;
}

function isStreamBody(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as { stream?: boolean }).stream === true,
  );
}

function headersToObject(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === "authorization") continue;
    out[key] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

function clampRetryCount(value: unknown, fallback: number) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : fallback;
}

/** Retries for normal upstream failures: 401/403/408/429/5xx + network errors. */
export function getMaxRetries(): number {
  return clampRetryCount(getSetting("max_retries"), 2);
}

/** Retries for all other upstream failures (e.g. HTTP 400 business errors). */
export function getOtherMaxRetries(): number {
  return clampRetryCount(getSetting("other_max_retries"), 0);
}

export function getRetryDelayMs(): number {
  const n = Number(getSetting("retry_delay_ms") ?? 400);
  return Number.isFinite(n) ? Math.max(0, Math.min(10_000, Math.floor(n))) : 400;
}

// L4: retry delays must honor the client abort signal — otherwise a
// disconnected client still burns the full retry budget (and upstream
// slots) while sleeping between attempts.
function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Client disconnected"), { name: "AbortError" }));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Client disconnected"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Normal retry class used by settings → max_retries. */
function isNormalRetryableStatus(status: number): boolean {
  return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableStatus(status: number): boolean {
  // Keep broader classification for affinity / diagnostics; retry budgets use the split helpers.
  return isNormalRetryableStatus(status) || [404, 409].includes(status);
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const e = err as { name?: string; type?: string; code?: string };
  if (e.name === "AbortError") return true;
  const code = String(e.code || e.type || "");
  return ["ECONN", "ETIMEDOUT", "EAI_", "ENOTFOUND", "EPIPE", "system", "request-timeout"]
    .some((part) => code.includes(part));
}

function isRetrySafe(ctx: ProxyContext) {
  const method = ctx.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method)) return true;
  const value = ctx.headers["idempotency-key"] || ctx.headers["x-idempotency-key"];
  return Boolean(Array.isArray(value) ? value[0] : value);
}

function canRetryNormalStatus(ctx: ProxyContext, status: number) {
  if (ctx.bodyStream) return false;
  if (!isNormalRetryableStatus(status)) return false;
  // Auth/rate-limit/gateway failures are safe to rotate. Generic 500 needs idempotency
  // because upstream work may already have started.
  if ([401, 403, 408, 429, 502, 503, 504].includes(status)) return true;
  return isRetrySafe(ctx);
}

function canRetryOtherStatus(ctx: ProxyContext, status: number) {
  if (ctx.bodyStream) return false;
  if (status < 400 || isNormalRetryableStatus(status)) return false;
  // 4xx business/client errors were usually rejected without side effects.
  if (status < 500) return true;
  return isRetrySafe(ctx);
}

/** @deprecated use canRetryNormalStatus; kept for internal call sites during transition */
function canRetryStatus(ctx: ProxyContext, status: number) {
  return canRetryNormalStatus(ctx, status) || canRetryOtherStatus(ctx, status);
}

function buildUpstreamUrl(
  provider: Provider,
  path: string,
  query: Record<string, unknown>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, String(item));
    } else {
      qs.set(k, String(v));
    }
  }
  const queryString = qs.toString();
  return `${provider.base_url}${path}${queryString ? `?${queryString}` : ""}`;
}

function buildUpstreamHeaders(
  provider: Provider,
  ctx: ProxyContext,
): Record<string, string> {
  const headers = headersToObject(ctx.headers);
  const upstreamKey = pickProviderKey(provider);
  if (upstreamKey) headers.authorization = `Bearer ${upstreamKey}`;
  if (!headers.accept) {
    headers.accept = isStreamBody(ctx.body) ? "text/event-stream" : "application/json";
  }
  return headers;
}

function agentFor(url: string) {
  return url.startsWith("https:") ? httpsAgent : httpAgent;
}

function withMappedModel(provider: Provider, ctx: ProxyContext): ProxyContext {
  const publicModel = pickModel(ctx.body, ctx.query);
  if (!publicModel) return ctx;
  const upstreamModel = mapProviderModel(provider, publicModel);
  if (upstreamModel === publicModel) return ctx;

  const nextQuery =
    typeof ctx.query.model === "string"
      ? { ...ctx.query, model: upstreamModel }
      : ctx.query;

  if (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)) {
    const nextBody = {
      ...(ctx.body as Record<string, unknown>),
      model: upstreamModel,
    };
    // If we rewrote JSON, drop the original raw/stream body so upstream gets the mapped model.
    return {
      ...ctx,
      query: nextQuery,
      body: nextBody,
      rawBody: Buffer.from(JSON.stringify(nextBody)),
      bodyStream: undefined,
    };
  }

  return { ...ctx, query: nextQuery };
}

async function openUpstream(
  provider: Provider,
  ctx: ProxyContext,
  path: string,
  externalSignal?: AbortSignal,
): Promise<UpstreamHandle> {
  const mappedCtx = withMappedModel(provider, ctx);
  const url = buildUpstreamUrl(provider, path, mappedCtx.query);
  const headers = buildUpstreamHeaders(provider, mappedCtx);
  const controller = new AbortController();
  const timeout = createUpstreamTimeout(controller, provider.timeout_ms);
  const onExternalAbort = () => {
    timeout.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const init: Parameters<typeof fetch>[1] = {
      method: mappedCtx.method,
      headers,
      signal: controller.signal as AbortSignal,
      agent: agentFor(url),
      // Keep upstream compression intact; the relay never re-encodes payloads.
      compress: false,
    };

    const method = mappedCtx.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      if (mappedCtx.rawBody !== undefined) {
        init.body = mappedCtx.rawBody;
      } else if (mappedCtx.bodyStream) {
        init.body = mappedCtx.bodyStream as never;
      } else if (mappedCtx.body !== undefined) {
        init.body = JSON.stringify(mappedCtx.body);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      }
    }

    const response = await fetch(url, init);
    return {
      response,
      abort: () => {
        timeout.abort();
        externalSignal?.removeEventListener?.("abort", onExternalAbort);
      },
      clearTimeout: timeout.clear,
      didTimeout: timeout.didTimeout,
      onBodyChunk: timeout.onBodyChunk,
    };
  } catch (error) {
    const timedOut = timeout.didTimeout();
    timeout.abort();
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
    if (timedOut) throw upstreamTimeoutError(error);
    if (externalSignal?.aborted) {
      throw Object.assign(new Error("Client disconnected"), { code: "CLIENT_ABORT" });
    }
    throw error;
  }
}

export type ProviderTestResult = {
  ok: boolean;
  provider_id: string;
  provider_name: string;
  model: string;
  /** Model name actually sent upstream after mapping. */
  upstream_model: string;
  path: string;
  status_code: number | null;
  attempts: number;
  /** Total retry budget (normal + other). Kept for backward compatibility. */
  max_retries: number;
  normal_max_retries: number;
  other_max_retries: number;
  normal_retries_used: number;
  other_retries_used: number;
  /** Max attempts allowed for the final failure class (1 + class budget). */
  class_max_attempts: number;
  /** Which retry class the final failure belonged to. */
  retry_class: "normal" | "other" | "none";
  stop_reason: "ok" | "normal_budget" | "other_budget" | "non_retryable" | "error";
  latency_ms: number;
  error: string | null;
  response_preview: string;
};

function providerTestModel(provider: Provider, requested?: string | null) {
  if (requested?.trim()) return requested.trim();
  try {
    const models = JSON.parse(provider.models) as unknown;
    if (Array.isArray(models)) {
      const concrete = models.map(String).find((model) => model && model !== "*");
      if (concrete) return concrete;
    }
  } catch {
    // The caller receives a clear missing-model result below.
  }
  return "";
}

function previewBody(buffer: Buffer) {
  if (!buffer.length) return "";
  return buffer.toString("utf8", 0, Math.min(buffer.length, 1000)).trim();
}

export async function testProviderConnection(
  providerId: string,
  requestedModel?: string | null,
): Promise<ProviderTestResult | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const model = providerTestModel(provider, requestedModel);
  const upstreamModel = model ? mapProviderModel(provider, model) : "";
  // Use the same dual budgets as production proxy (no hidden caps).
  const normalMaxRetries = getMaxRetries();
  const otherMaxRetries = getOtherMaxRetries();
  const maxRetries = normalMaxRetries + otherMaxRetries;
  const started = Date.now();

  const baseResult = {
    provider_id: provider.id,
    provider_name: provider.name,
    model,
    upstream_model: upstreamModel,
    path: "/v1/chat/completions",
    max_retries: maxRetries,
    normal_max_retries: normalMaxRetries,
    other_max_retries: otherMaxRetries,
    normal_retries_used: 0,
    other_retries_used: 0,
    class_max_attempts: 1,
    retry_class: "none" as const,
  };

  if (!model) {
    return {
      ...baseResult,
      ok: false,
      model: "",
      upstream_model: "",
      status_code: null,
      attempts: 0,
      stop_reason: "non_retryable",
      latency_ms: 0,
      error: "A concrete model is required to test this provider",
      response_preview: "",
    };
  }

  const path = "/v1/chat/completions";
  const ctx: ProxyContext = {
    method: "POST",
    path,
    query: {},
    headers: { "content-type": "application/json", accept: "application/json" },
    body: {
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      stream: false,
    },
  };
  const retryDelay = getRetryDelayMs();
  let attempts = 0;
  let normalRetriesUsed = 0;
  let otherRetriesUsed = 0;
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let responsePreview = "";
  let retryClass: "normal" | "other" | "none" = "none";
  let stopReason: ProviderTestResult["stop_reason"] = "error";
  const hardCap = 1 + normalMaxRetries + otherMaxRetries;

  while (attempts < hardCap) {
    attempts += 1;
    let handle: UpstreamHandle | undefined;
    try {
      handle = await openUpstream(provider, ctx, path);
      statusCode = handle.response.status;
      const body = await handle.response.buffer();
      handle.clearTimeout();
      responsePreview = previewBody(body);
      if (statusCode >= 200 && statusCode < 300) {
        return {
          ...baseResult,
          ok: true,
          status_code: statusCode,
          attempts,
          normal_retries_used: normalRetriesUsed,
          other_retries_used: otherRetriesUsed,
          class_max_attempts: attempts,
          retry_class: "none",
          stop_reason: "ok",
          latency_ms: Date.now() - started,
          error: null,
          response_preview: responsePreview,
        };
      }

      errorMessage = `Upstream HTTP ${statusCode}`;
      if (isNormalRetryableStatus(statusCode)) {
        retryClass = "normal";
        if (normalRetriesUsed < normalMaxRetries) {
          normalRetriesUsed += 1;
          await sleep(retryDelay * attempts);
          continue;
        }
        stopReason = "normal_budget";
        break;
      }

      if (statusCode >= 400) {
        retryClass = "other";
        if (otherRetriesUsed < otherMaxRetries) {
          otherRetriesUsed += 1;
          await sleep(retryDelay * attempts);
          continue;
        }
        stopReason = otherMaxRetries > 0 ? "other_budget" : "non_retryable";
        break;
      }

      retryClass = "none";
      stopReason = "non_retryable";
      break;
    } catch (error) {
      handle?.abort();
      errorMessage = error instanceof Error ? error.message : String(error);
      if (isRetryableError(error)) {
        retryClass = "normal";
        if (normalRetriesUsed < normalMaxRetries) {
          normalRetriesUsed += 1;
          await sleep(retryDelay * attempts);
          continue;
        }
        stopReason = "normal_budget";
        break;
      }
      retryClass = "other";
      if (otherRetriesUsed < otherMaxRetries) {
        otherRetriesUsed += 1;
        await sleep(retryDelay * attempts);
        continue;
      }
      stopReason = otherMaxRetries > 0 ? "other_budget" : "non_retryable";
      break;
    }
  }

  const classMaxAttempts =
    retryClass === "normal"
      ? 1 + normalMaxRetries
      : retryClass === "other"
        ? 1 + otherMaxRetries
        : 1;

  return {
    ...baseResult,
    ok: false,
    status_code: statusCode,
    attempts,
    normal_retries_used: normalRetriesUsed,
    other_retries_used: otherRetriesUsed,
    class_max_attempts: classMaxAttempts,
    retry_class: retryClass,
    stop_reason: stopReason,
    latency_ms: Date.now() - started,
    error: errorMessage || "Provider test failed",
    response_preview: responsePreview,
  };
}

function applyUpstreamHeaders(
  res: ExpressResponse,
  upstream: FetchResponse,
  providerLabel: string,
) {
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    try {
      res.setHeader(key, value);
    } catch {
      // Ignore invalid upstream header values.
    }
  });
  res.setHeader("x-provider", providerLabel.replace(/[^\x20-\x7E]/g, "_"));
}

function requestBytes(ctx: ProxyContext) {
  if (ctx.rawBody !== undefined) {
    return typeof ctx.rawBody === "string"
      ? Buffer.byteLength(ctx.rawBody)
      : ctx.rawBody.byteLength;
  }
  const contentLength = ctx.headers["content-length"];
  const n = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function pipeResponseToClient(params: {
  ctx: ProxyContext;
  res: ExpressResponse;
  handle: UpstreamHandle;
  provider: Provider;
  model: string | null;
  path: string;
  attempts: number;
  started: number;
  stream: boolean;
  baseIo: ReturnType<typeof extractIO>;
  clientSignal?: AbortSignal;
}): Promise<ProxyResult> {
  const { res, handle, provider, attempts, stream, baseIo, clientSignal, started } = params;
  const upstream = handle.response;
  const streamingResponse =
    stream || /\btext\/event-stream\b/i.test(upstream.headers.get("content-type") || "");
  let headersCommitted = false;
  const commitHeaders = () => {
    if (headersCommitted) return;
    headersCommitted = true;
    applyUpstreamHeaders(res, upstream, `${provider.id}:${provider.name}`);
    if (attempts > 1) res.setHeader("x-retry-attempts", String(attempts));
    if (stream) {
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
    }
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
    }
    res.status(upstream.status);
  };

  const body = upstream.body;
  if (!body) {
    handle.clearTimeout();
    commitHeaders();
    res.end();
    return {
      statusCode: upstream.status,
      responseBytes: 0,
      io: baseIo,
      error: null,
    };
  }

  const responseCollector = createResponseLogCollector({
    stream: streamingResponse,
    contentType: upstream.headers.get("content-type"),
  });
  let responseBytes = 0;
  let streamError: string | null = null;
  let clientClosed = Boolean(clientSignal?.aborted);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  // Stall detector, armed ONLY while waiting for the next upstream chunk.
  // Client writes (including backpressure/drain waits) never count as
  // upstream stall: a slow reader must not kill the upstream stream. It
  // applies to buffered (non-streaming) responses too — the provider
  // timeout_ms was released on the first body chunk, so the idle timer is
  // what protects against a stalled download.
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      streamError = streamError || "Upstream stream idle timeout";
      handle.abort();
      (body as { destroy?: (err?: Error) => void }).destroy?.(new Error("Upstream stream idle timeout"));
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const forceCloseUpstream = (reason: string) => {
    clientClosed = true;
    streamError = streamError || reason;
    handle.abort();
    (body as { destroy?: (err?: Error) => void }).destroy?.(new Error(reason));
  };
  const onClientClose = () => {
    if (res.writableEnded) return;
    forceCloseUpstream("Client disconnected");
  };
  const onClientSignalAbort = () => forceCloseUpstream("Client disconnected");
  res.once("close", onClientClose);
  if (clientSignal) {
    if (clientSignal.aborted) onClientSignalAbort();
    else clientSignal.addEventListener("abort", onClientSignalAbort, { once: true });
  }
  try {
    if (clientClosed) throw new Error("Client disconnected");
    for await (const value of body) {
      if (clientClosed || clientSignal?.aborted) throw new Error("Client disconnected");
      if (Date.now() - started > REQUEST_MAX_MS) {
        forceCloseUpstream("Request max duration exceeded");
        throw new Error("Request max duration exceeded");
      }
      // Not idle: this chunk is in hand. Writing it (and waiting out client
      // backpressure) must not arm the stall timer — a paused reader is not
      // an upstream stall.
      clearIdle();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (responseBytes === 0) {
        // TTFB timeout ends once the body starts; the idle timer takes over
        // for stalls (streaming and buffered responses alike).
        handle.onBodyChunk(streamingResponse);
        commitHeaders();
      }
      responseBytes += chunk.length;
      responseCollector.push(chunk);
      if (!res.write(chunk)) {
        await Promise.race([once(res, "drain"), once(res, "close")]);
        if (clientClosed || clientSignal?.aborted) throw new Error("Client disconnected");
      }
      // Idle again: waiting for the next upstream chunk. The stream ends
      // (for await completes) before this timer can fire.
      armIdle();
    }
    handle.clearTimeout();
    clearIdle();
    if (!clientClosed) {
      commitHeaders();
      res.end();
    }
  } catch (error) {
    handle.abort();
    clearIdle();
    if (clientClosed || clientSignal?.aborted || (error instanceof Error && /Client disconnected/i.test(error.message))) {
      streamError = "Client disconnected";
    } else if (responseBytes === 0 && !res.headersSent) {
      if (handle.didTimeout() || (error instanceof Error && /timeout|aborted/i.test(error.message))) {
        throw upstreamTimeoutError(error);
      }
      throw error;
    } else {
      streamError = handle.didTimeout()
        ? "Upstream response timed out"
        : error instanceof Error ? error.message : String(error);
      if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    clearIdle();
    res.off("close", onClientClose);
    clientSignal?.removeEventListener?.("abort", onClientSignalAbort);
  }

  const io = { ...baseIo, ...responseCollector.finish() };
  // Client disconnect mid-stream should not look like a successful billable 200.
  const statusCode =
    streamError === "Client disconnected" && responseBytes > 0
      ? 499
      : upstream.status;
  return {
    statusCode,
    responseBytes,
    io,
    error:
      streamError ||
      (attempts > 1
        ? upstream.status >= 200 && upstream.status < 400
          ? null
          : `Upstream HTTP ${upstream.status} after ${attempts} attempt(s)`
        : null),
  };
}

function writeCompletedRequest(params: {
  ctx: ProxyContext;
  path: string;
  model: string | null;
  provider: Provider;
  started: number;
  stream: boolean;
  result: ProxyResult;
  billing: BillingReservation | null;
  access: RequestAccess | null;
}) {
  const { ctx, path, model, provider, started, stream, result, billing, access } = params;
  let logIo = result.io;
  let usageEstimated = false;
  if (
    result.statusCode >= 200 && result.statusCode < 400 &&
    logIo.total_tokens === 0 &&
    (logIo.output_text || logIo.reasoning_text)
  ) {
    const estimate = estimateRequestTokens(ctx.body, requestBytes(ctx));
    const completion = Math.max(1, Math.ceil(((logIo.output_text?.length || 0) + (logIo.reasoning_text?.length || 0)) / 4));
    logIo = { ...logIo, prompt_tokens: estimate.prompt, completion_tokens: completion, total_tokens: estimate.prompt + completion };
    usageEstimated = true;
  }
  let usageId: string | null = null;
  let costMicros = 0;
  let settlementError: string | null = null;
  if (billing) {
    try {
      const settled = settleUsage(billing, {
        statusCode: result.statusCode,
        promptTokens: logIo.prompt_tokens,
        completionTokens: logIo.completion_tokens,
        cachedTokens: logIo.cached_tokens,
        reasoningTokens: logIo.reasoning_tokens,
        totalTokens: logIo.total_tokens,
        outputText: logIo.output_text,
        reasoningText: logIo.reasoning_text,
        error: result.error,
      });
      usageId = settled.usageId;
      costMicros = settled.costMicros;
    } catch (error) {
      settlementError = `Billing settlement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  access?.release(logIo.total_tokens || logIo.prompt_tokens + logIo.completion_tokens);
  writeLog({
    method: ctx.method,
    path,
    model,
    provider_id: provider.id,
    provider_name: provider.name,
    api_key_id: ctx.apiKeyId,
    api_key_name: ctx.apiKeyName,
    user_id: ctx.apiKey?.user_id ?? null,
    usage_id: usageId,
    cost_micros: costMicros,
    status_code: result.statusCode,
    latency_ms: Date.now() - started,
    cached: (result.io.cached_tokens ?? 0) > 0,
    request_bytes: requestBytes(ctx),
    response_bytes: result.responseBytes,
    input_text: logIo.input_text,
    output_text: logIo.output_text,
    reasoning_text: logIo.reasoning_text,
    prompt_tokens: logIo.prompt_tokens,
    completion_tokens: logIo.completion_tokens,
    reasoning_tokens: logIo.reasoning_tokens,
    cached_tokens: logIo.cached_tokens,
    total_tokens: logIo.total_tokens,
    usage_estimated: usageEstimated,
    stream,
    error: [result.error, settlementError].filter(Boolean).join("; ") || null,
  });
}

export async function handleProxyHttp(
  ctx: ProxyContext,
  res: ExpressResponse,
): Promise<void> {
  const started = Date.now();
  const model = pickModel(ctx.body, ctx.query);
  const path = ctx.path.startsWith("/") ? ctx.path : `/${ctx.path}`;
  const logPath = ctx.clientPath || path;
  const stream = isStreamBody(ctx.body);
  const baseIo = extractIO({ path, body: ctx.body, stream });
  const estimatedTokens = estimateRequestTokens(ctx.body, requestBytes(ctx));
  const normalMaxRetries = getMaxRetries();
  const otherMaxRetries = getOtherMaxRetries();
  const maxRetries = normalMaxRetries + otherMaxRetries;
  const retryDelay = getRetryDelayMs();
  const replayableBody = !ctx.bodyStream;

  const providerCandidates = listProvidersForModel(model);
  if (providerCandidates.length === 0) {
    const hasEnabledProvider = listProviders().some((item) => item.enabled === 1);
    const statusCode = model && hasEnabledProvider ? 404 : 502;
    const message = statusCode === 404
      ? `No provider is configured for model ${model}`
      : "No enabled upstream provider configured";
    writeLog({
      method: ctx.method,
      path: logPath,
      model,
      api_key_id: ctx.apiKeyId,
      api_key_name: ctx.apiKeyName,
      status_code: statusCode,
      latency_ms: Date.now() - started,
      cached: false,
      error: message,
      input_text: baseIo.input_text,
      stream,
    });
    res.status(statusCode).json({
      error: {
        message,
        type: statusCode === 404 ? "model_not_found" : "proxy_error",
      },
    });
    return;
  }
  const affinityKey = buildProviderAffinityKey({
    model,
    body: ctx.body,
    headers: ctx.headers,
    apiKeyId: ctx.apiKeyId,
    userId: ctx.apiKey?.user_id,
    billingMode: ctx.billingMode,
  });
  const providerOrder = orderProvidersForConversation(providerCandidates, affinityKey);

  let access: RequestAccess | null = null;
  let accessReleased = false;
  let billing: BillingReservation | null = null;
  const releaseAccess = (tokens: number) => {
    if (accessReleased) return;
    accessReleased = true;
    access?.release(tokens);
  };
  /** Idempotent: settleUsage no-ops when the row is no longer pending. */
  const settleBillingSafe = (statusCode: number, error: string | null, tokens = 0) => {
    if (billing) {
      try {
        settleUsage(billing, { statusCode, error });
      } catch {
        // Periodic cleanup recovers any residual holds.
      }
    }
    releaseAccess(tokens);
  };

  // Abort upstream as soon as the client goes away (including during TTFB wait).
  const clientAbort = new AbortController();
  const unbindClientAbort = bindClientAbort(res, () => {
    if (!clientAbort.signal.aborted) clientAbort.abort();
  });
  const hardDeadline = setTimeout(() => {
    if (!clientAbort.signal.aborted) clientAbort.abort();
  }, REQUEST_MAX_MS);

  try {
    try {
      if (ctx.apiKey) access = beginRequestAccess(ctx.apiKey, model, ctx.body, { billingMode: ctx.billingMode, estimatedTokens });
    } catch (error) {
      const accessError = error instanceof AccessError ? error : new AccessError(403, "access_denied", String(error));
      if (accessError.retryAfterSeconds) res.setHeader("retry-after", String(accessError.retryAfterSeconds));
      writeLog({
        method: ctx.method,
        path: logPath,
        model,
        api_key_id: ctx.apiKeyId,
        api_key_name: ctx.apiKeyName,
        user_id: ctx.apiKey?.user_id ?? null,
        status_code: accessError.status,
        latency_ms: Date.now() - started,
        error: accessError.message,
        input_text: baseIo.input_text,
        stream,
      });
      res.status(accessError.status).json({ error: { message: accessError.message, type: accessError.code } });
      return;
    }

    try {
      if (ctx.apiKey?.user_id) {
        if (!model) throw new BillingError(400, "model_required", "A model is required for billed requests");
        billing = reserveUsage({
          requestId: uuid(),
          userId: ctx.apiKey.user_id,
          apiKeyId: ctx.apiKey.id,
          model,
          body: ctx.body,
          estimate: estimatedTokens,
          billingMode: ctx.billingMode,
        });
      }
    } catch (error) {
      releaseAccess(0);
      const billingError = error instanceof BillingError
        ? error
        : new BillingError(402, "billing_error", error instanceof Error ? error.message : String(error));
      writeLog({
        method: ctx.method,
        path: logPath,
        model,
        api_key_id: ctx.apiKeyId,
        api_key_name: ctx.apiKeyName,
        user_id: ctx.apiKey?.user_id ?? null,
        status_code: billingError.status,
        latency_ms: Date.now() - started,
        error: billingError.message,
        input_text: baseIo.input_text,
        stream,
      });
      res.status(billingError.status).json({ error: { message: billingError.message, type: billingError.code } });
      return;
    }

    if (clientAbort.signal.aborted) {
      settleBillingSafe(499, "Client disconnected", 0);
      if (!res.headersSent) {
        res.status(499).json({ error: { message: "Client disconnected", type: "client_abort" } });
      }
      return;
    }

    let lastError: string | null = null;
    let attempts = 0;
    let normalRetriesUsed = 0;
    let otherRetriesUsed = 0;
    let lastProvider: Provider | null = null;
    const hardCap = 1 + normalMaxRetries + otherMaxRetries;

    while (attempts < hardCap) {
      if (clientAbort.signal.aborted) {
        lastError = "Client disconnected";
        break;
      }
      attempts += 1;
      const provider = providerOrder[(attempts - 1) % providerOrder.length];
      lastProvider = provider;
      let handle: UpstreamHandle | undefined;
      try {
        handle = await openUpstream(provider, ctx, path, clientAbort.signal);
        const status = handle.response.status;
        const normalFailure =
          replayableBody
          && canRetryNormalStatus(ctx, status)
          && normalRetriesUsed < normalMaxRetries;
        const otherFailure =
          replayableBody
          && canRetryOtherStatus(ctx, status)
          && otherRetriesUsed < otherMaxRetries;

        if (normalFailure || otherFailure) {
          try {
            await handle.response.buffer();
          } finally {
            handle.clearTimeout();
          }
          if (normalFailure) normalRetriesUsed += 1;
          else otherRetriesUsed += 1;
          forgetProviderAffinity(affinityKey, provider.id);
          lastError = `Upstream HTTP ${status}`;
          // L4: stop sleeping once the client is gone.
          if (clientAbort.signal.aborted) break;
          await sleep(retryDelay * attempts, clientAbort.signal);
          continue;
        }

        if (isRetryableStatus(status)) forgetProviderAffinity(affinityKey, provider.id);
        else rememberProviderAffinity(affinityKey, provider.id);
        const result = await pipeResponseToClient({
          ctx,
          res,
          handle,
          provider,
          model,
          path,
          attempts,
          started,
          stream,
          baseIo,
          clientSignal: clientAbort.signal,
        });
        if (
          result.statusCode >= 200 &&
          result.statusCode < 400 &&
          result.error &&
          !result.error.startsWith("ok after")
        ) {
          forgetProviderAffinity(affinityKey, provider.id);
        }
        writeCompletedRequest({ ctx, path: logPath, model, provider, started, stream, result, billing, access });
        // writeCompletedRequest already settled billing + released access; flags prevent double-work in finally.
        accessReleased = true;
        billing = null;
        return;
      } catch (error) {
        handle?.abort();
        lastError = error instanceof Error ? error.message : String(error);
        if (clientAbort.signal.aborted || /Client disconnected/i.test(lastError)) {
          lastError = "Client disconnected";
          break;
        }
        if (!res.headersSent && replayableBody) {
          if (isRetryableError(error) && normalRetriesUsed < normalMaxRetries) {
            normalRetriesUsed += 1;
            forgetProviderAffinity(affinityKey, provider.id);
            if (clientAbort.signal.aborted) break;
            await sleep(retryDelay * attempts, clientAbort.signal);
            continue;
          }
          if (!isRetryableError(error) && otherRetriesUsed < otherMaxRetries) {
            otherRetriesUsed += 1;
            forgetProviderAffinity(affinityKey, provider.id);
            if (clientAbort.signal.aborted) break;
            await sleep(retryDelay * attempts, clientAbort.signal);
            continue;
          }
        }
        forgetProviderAffinity(affinityKey, provider.id);
        break;
      }
    }

    const clientGone = clientAbort.signal.aborted || /Client disconnected/i.test(lastError || "");
    const failStatus = clientGone ? 499 : /aborted|timeout/i.test(lastError || "") ? 504 : 502;
    settleBillingSafe(failStatus, lastError || "Upstream request failed", 0);

    writeLog({
      method: ctx.method,
      path: logPath,
      model,
      provider_id: lastProvider?.id,
      provider_name: lastProvider?.name,
      api_key_id: ctx.apiKeyId,
      api_key_name: ctx.apiKeyName,
      user_id: ctx.apiKey?.user_id ?? null,
      usage_id: billing?.usageId ?? null,
      status_code: failStatus,
      latency_ms: Date.now() - started,
      cached: false,
      error: lastError || "Upstream request failed",
      input_text: baseIo.input_text,
      stream,
      request_bytes: requestBytes(ctx),
    });

    if (!res.headersSent) {
      res.status(failStatus === 499 ? 400 : failStatus).json({
        error: {
          message: clientGone
            ? "Client disconnected"
            : `Upstream request failed after ${attempts} attempt(s): ${lastError || "unknown"}`,
          type: clientGone ? "client_abort" : failStatus === 504 ? "timeout_error" : "proxy_error",
          attempts,
        },
      });
    }
  } finally {
    clearTimeout(hardDeadline);
    unbindClientAbort();
    // Absolute safety net: never leave concurrency/billing holds behind.
    settleBillingSafe(499, "Request ended without settlement", 0);
  }
}
