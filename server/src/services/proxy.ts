import http from "http";
import https from "https";
import fetch, { Response as FetchResponse } from "node-fetch";
import type { Response as ExpressResponse } from "express";
import { v4 as uuid } from "uuid";
import { ApiKey, getSetting, Provider } from "../db";
import { writeLog } from "./logs";
import { getProvider, listProviders, listProvidersForModel, pickProviderKey } from "./providers";
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
  maxSockets,
  maxFreeSockets: Math.min(64, maxSockets),
  scheduling: "lifo",
});
const httpsAgent = new https.Agent({
  keepAlive: true,
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

export function getMaxRetries(): number {
  const n = Number(getSetting("max_retries") ?? 2);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 2;
}

export function getRetryDelayMs(): number {
  const n = Number(getSetting("retry_delay_ms") ?? 400);
  return Number.isFinite(n) ? Math.max(0, Math.min(10_000, Math.floor(n))) : 400;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return [401, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(status);
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

function canRetryStatus(ctx: ProxyContext, status: number) {
  if (ctx.bodyStream) return false;
  // Authentication/model/gateway failures explicitly rejected the request and
  // are safe to rotate to another configured provider. A generic 500 still
  // requires caller-provided idempotency because upstream work may have run.
  if ([401, 403, 404, 408, 409, 429, 502, 503, 504].includes(status)) return true;
  return isRetrySafe(ctx);
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

async function openUpstream(
  provider: Provider,
  ctx: ProxyContext,
  path: string,
): Promise<UpstreamHandle> {
  const url = buildUpstreamUrl(provider, path, ctx.query);
  const headers = buildUpstreamHeaders(provider, ctx);
  const controller = new AbortController();
  const timeout = createUpstreamTimeout(controller, provider.timeout_ms);

  try {
    const init: Parameters<typeof fetch>[1] = {
      method: ctx.method,
      headers,
      signal: controller.signal as AbortSignal,
      agent: agentFor(url),
      // Keep upstream compression intact; the relay never re-encodes payloads.
      compress: false,
    };

    const method = ctx.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      if (ctx.rawBody !== undefined) {
        init.body = ctx.rawBody;
      } else if (ctx.bodyStream) {
        init.body = ctx.bodyStream as never;
      } else if (ctx.body !== undefined) {
        init.body = JSON.stringify(ctx.body);
        if (!headers["content-type"]) headers["content-type"] = "application/json";
      }
    }

    const response = await fetch(url, init);
    return {
      response,
      abort: timeout.abort,
      clearTimeout: timeout.clear,
      didTimeout: timeout.didTimeout,
      onBodyChunk: timeout.onBodyChunk,
    };
  } catch (error) {
    const timedOut = timeout.didTimeout();
    timeout.abort();
    if (timedOut) throw upstreamTimeoutError(error);
    throw error;
  }
}

export type ProviderTestResult = {
  ok: boolean;
  provider_id: string;
  provider_name: string;
  model: string;
  path: string;
  status_code: number | null;
  attempts: number;
  max_retries: number;
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
  const maxRetries = getMaxRetries();
  const started = Date.now();
  if (!model) {
    return {
      ok: false,
      provider_id: provider.id,
      provider_name: provider.name,
      model: "",
      path: "/v1/chat/completions",
      status_code: null,
      attempts: 0,
      max_retries: maxRetries,
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
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let responsePreview = "";

  while (attempts <= maxRetries) {
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
          ok: true,
          provider_id: provider.id,
          provider_name: provider.name,
          model,
          path,
          status_code: statusCode,
          attempts,
          max_retries: maxRetries,
          latency_ms: Date.now() - started,
          error: null,
          response_preview: responsePreview,
        };
      }
      errorMessage = `Upstream HTTP ${statusCode}`;
      const retryable =
        [401, 403, 408, 429, 500, 502, 503, 504].includes(statusCode) &&
        attempts <= maxRetries;
      if (!retryable) break;
    } catch (error) {
      handle?.abort();
      errorMessage = error instanceof Error ? error.message : String(error);
      if (attempts > maxRetries || !isRetryableError(error)) break;
    }
    await sleep(retryDelay * attempts);
  }

  return {
    ok: false,
    provider_id: provider.id,
    provider_name: provider.name,
    model,
    path,
    status_code: statusCode,
    attempts,
    max_retries: maxRetries,
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
}): Promise<ProxyResult> {
  const { ctx, res, handle, provider, model, path, attempts, started, stream } = params;
  const upstream = handle.response;
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
  const streamingResponse =
    stream || /\btext\/event-stream\b/i.test(upstream.headers.get("content-type") || "");
  res.status(upstream.status);
  let clientStatus = upstream.status;

  const body = upstream.body;
  if (!body) {
    handle.clearTimeout();
    res.end();
    return {
      statusCode: upstream.status,
      responseBytes: 0,
      io: extractIO({ path, body: ctx.body, stream }),
      error: attempts > 1 ? `ok after ${attempts} attempt(s)` : null,
    };
  }

  const responseCollector = createResponseLogCollector({
    stream: streamingResponse,
    contentType: upstream.headers.get("content-type"),
  });
  let responseBytes = 0;
  let bodyEnded = false;
  let clientFinished = false;
  let streamError: string | null = null;

  await new Promise<void>((resolve) => {
    const onClientFinish = () => {
      clientFinished = true;
    };
    const onClientClose = () => {
      if (bodyEnded || clientFinished) return;
      streamError = streamError || "Client disconnected";
      handle.abort();
      const destroy = body as { destroy?: (error?: Error) => void };
      destroy.destroy?.();
      resolve();
    };
    const onData = (chunk: Buffer) => {
      if (responseBytes === 0) handle.onBodyChunk(streamingResponse);
      responseBytes += chunk.length;
      responseCollector.push(chunk);
    };
    const onEnd = () => {
      bodyEnded = true;
      handle.clearTimeout();
      resolve();
    };
    const onError = (error: unknown) => {
      bodyEnded = true;
      const timedOut =
        handle.didTimeout() ||
        (error instanceof Error && /timeout/i.test(error.message));
      streamError =
        streamError ||
        (handle.didTimeout()
          ? "Upstream response timed out"
          : error instanceof Error
            ? error.message
            : String(error));
      handle.abort();
      if (timedOut && responseBytes === 0 && !res.headersSent) {
        clientStatus = 504;
        res.status(504).json({
          error: { message: "Upstream response timed out", type: "timeout_error" },
        });
      } else if (!res.writableEnded) {
        res.destroy(error instanceof Error ? error : undefined);
      }
      resolve();
    };

    res.once("finish", onClientFinish);
    res.once("close", onClientClose);
    body.on("data", onData);
    body.once("end", onEnd);
    body.once("error", onError);
    body.pipe(res);
  });

  const baseIo = extractIO({ path, body: ctx.body, stream });
  const io = { ...baseIo, ...responseCollector.finish() };
  return {
    statusCode: clientStatus,
    responseBytes,
    io,
    error:
      streamError ||
      (attempts > 1
        ? upstream.status >= 200 && upstream.status < 400
          ? `ok after ${attempts} attempt(s)`
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
  let usageId: string | null = null;
  let costMicros = 0;
  let settlementError: string | null = null;
  if (billing) {
    try {
      const settled = settleUsage(billing, {
        statusCode: result.statusCode,
        promptTokens: result.io.prompt_tokens,
        completionTokens: result.io.completion_tokens,
        cachedTokens: result.io.cached_tokens,
        reasoningTokens: result.io.reasoning_tokens,
        totalTokens: result.io.total_tokens,
        outputText: result.io.output_text,
        reasoningText: result.io.reasoning_text,
        error: result.error,
      });
      usageId = settled.usageId;
      costMicros = settled.costMicros;
    } catch (error) {
      settlementError = `Billing settlement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  access?.release(result.io.total_tokens || result.io.prompt_tokens + result.io.completion_tokens);
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
    input_text: result.io.input_text,
    output_text: result.io.output_text,
    reasoning_text: result.io.reasoning_text,
    prompt_tokens: result.io.prompt_tokens,
    completion_tokens: result.io.completion_tokens,
    reasoning_tokens: result.io.reasoning_tokens,
    cached_tokens: result.io.cached_tokens,
    total_tokens: result.io.total_tokens,
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
  const maxRetries = getMaxRetries();
  const retryDelay = getRetryDelayMs();
  const replayableBody = !ctx.bodyStream;
  const retrySafe = isRetrySafe(ctx);

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
  const releaseAccess = (tokens: number) => {
    if (accessReleased) return;
    accessReleased = true;
    access?.release(tokens);
  };
  try {
    if (ctx.apiKey) access = beginRequestAccess(ctx.apiKey, model, ctx.body, { billingMode: ctx.billingMode });
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

  let billing: BillingReservation | null = null;
  try {
    if (ctx.apiKey?.user_id) {
      if (!model) throw new BillingError(400, "model_required", "A model is required for billed requests");
      billing = reserveUsage({
        requestId: uuid(),
        userId: ctx.apiKey.user_id,
        apiKeyId: ctx.apiKey.id,
        model,
        body: ctx.body,
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

  let lastError: string | null = null;
  let attempts = 0;
  let lastProvider: Provider | null = null;

  while (attempts <= maxRetries) {
    attempts += 1;
    const provider = providerOrder[(attempts - 1) % providerOrder.length];
    lastProvider = provider;
    let handle: UpstreamHandle | undefined;
    try {
      handle = await openUpstream(provider, ctx, path);
      const providerFailure =
        isRetryableStatus(handle.response.status) &&
        replayableBody &&
        canRetryStatus(ctx, handle.response.status);
      const retryable = providerFailure && attempts <= maxRetries;
      if (retryable) {
        try {
          await handle.response.buffer();
        } finally {
          handle.clearTimeout();
        }
        forgetProviderAffinity(affinityKey, provider.id);
        lastError = `Upstream HTTP ${handle.response.status}`;
        await sleep(retryDelay * attempts);
        continue;
      }

      if (providerFailure) forgetProviderAffinity(affinityKey, provider.id);
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
      accessReleased = true;
      return;
    } catch (error) {
      handle?.abort();
      lastError = error instanceof Error ? error.message : String(error);
      if (
        !res.headersSent &&
        replayableBody &&
        retrySafe &&
        attempts <= maxRetries &&
        isRetryableError(error)
      ) {
        forgetProviderAffinity(affinityKey, provider.id);
        await sleep(retryDelay * attempts);
        continue;
      }
      forgetProviderAffinity(affinityKey, provider.id);
      break;
    }
  }

  if (billing) {
    try {
      settleUsage(billing, { statusCode: 502, error: lastError || "Upstream request failed" });
    } catch {
      // Stale reservations are recovered by the startup cleanup.
    }
  }
  releaseAccess(0);

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
    status_code: 502,
    latency_ms: Date.now() - started,
    cached: false,
    error: lastError || "Upstream request failed",
    input_text: baseIo.input_text,
    stream,
    request_bytes: requestBytes(ctx),
  });

  if (!res.headersSent) {
    const timedOut = /aborted|timeout/i.test(lastError || "");
    const status = timedOut ? 504 : 502;
    res.status(status).json({
      error: {
        message: `Upstream request failed after ${attempts} attempt(s): ${lastError || "unknown"}`,
        type: timedOut ? "timeout_error" : "proxy_error",
        attempts,
      },
    });
  }
}
