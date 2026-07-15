import http from "http";
import https from "https";
import fetch, { Response as FetchResponse } from "node-fetch";
import type { Response as ExpressResponse } from "express";
import { getSetting, Provider } from "../db";
import { writeLog } from "./logs";
import { pickProviderKey, resolveProviderForModel } from "./providers";
import { extractIO } from "../utils/content";

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

const MAX_LOG_BYTES = 64 * 1024;
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
};

type UpstreamHandle = {
  response: FetchResponse;
  abort: () => void;
  clearTimeout: () => void;
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

function getMaxRetries(): number {
  const n = Number(getSetting("max_retries") ?? 2);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.floor(n))) : 2;
}

function getRetryDelayMs(): number {
  const n = Number(getSetting("retry_delay_ms") ?? 400);
  return Number.isFinite(n) ? Math.max(0, Math.min(10_000, Math.floor(n))) : 400;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const e = err as { name?: string; type?: string; code?: string };
  if (e.name === "AbortError") return true;
  const code = String(e.code || e.type || "");
  return ["ECONN", "ETIMEDOUT", "EAI_", "ENOTFOUND", "EPIPE", "system", "request-timeout"]
    .some((part) => code.includes(part));
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimeoutIfSet = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const abort = () => {
    clearTimeoutIfSet();
    controller.abort();
  };
  timer = setTimeout(() => controller.abort(), Math.max(1, provider.timeout_ms));

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
    return { response, abort, clearTimeout: clearTimeoutIfSet };
  } catch (error) {
    abort();
    throw error;
  }
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
}) {
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
  res.status(upstream.status);
  let clientStatus = upstream.status;

  const body = upstream.body;
  if (!body) {
    handle.clearTimeout();
    writeLog({
      method: ctx.method,
      path,
      model,
      provider_id: provider.id,
      provider_name: provider.name,
      api_key_id: ctx.apiKeyId,
      api_key_name: ctx.apiKeyName,
      status_code: upstream.status,
      latency_ms: Date.now() - started,
      cached: false,
      request_bytes: requestBytes(ctx),
      response_bytes: 0,
      input_text: extractIO({ path, body: ctx.body, stream }).input_text,
      stream,
    });
    res.end();
    return;
  }

  const sampled: Buffer[] = [];
  let sampledBytes = 0;
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
      responseBytes += chunk.length;
      if (sampledBytes < MAX_LOG_BYTES) {
        const take = chunk.subarray(0, MAX_LOG_BYTES - sampledBytes);
        if (take.length) {
          sampled.push(Buffer.from(take));
          sampledBytes += take.length;
        }
      }
    };
    const onEnd = () => {
      bodyEnded = true;
      handle.clearTimeout();
      resolve();
    };
    const onError = (error: unknown) => {
      bodyEnded = true;
      streamError = error instanceof Error ? error.message : String(error);
      handle.abort();
      const timedOut =
        error instanceof Error &&
        (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
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

  const sample = Buffer.concat(sampled).toString("utf8");
  const io = extractIO({ path, body: ctx.body, responseBody: sample, stream });
  writeLog({
    method: ctx.method,
    path,
    model,
    provider_id: provider.id,
    provider_name: provider.name,
    api_key_id: ctx.apiKeyId,
    api_key_name: ctx.apiKeyName,
    status_code: clientStatus,
    latency_ms: Date.now() - started,
    cached: (io.cached_tokens ?? 0) > 0,
    request_bytes: requestBytes(ctx),
    response_bytes: responseBytes,
    input_text: io.input_text,
    output_text: io.output_text,
    reasoning_text: io.reasoning_text,
    prompt_tokens: io.prompt_tokens,
    completion_tokens: io.completion_tokens,
    reasoning_tokens: io.reasoning_tokens,
    cached_tokens: io.cached_tokens,
    total_tokens: io.total_tokens,
    stream,
    error: streamError || (attempts > 1 ? `ok after ${attempts} attempt(s)` : null),
  });
}

export async function handleProxyHttp(
  ctx: ProxyContext,
  res: ExpressResponse,
): Promise<void> {
  const started = Date.now();
  const model = pickModel(ctx.body, ctx.query);
  const path = ctx.path.startsWith("/") ? ctx.path : `/${ctx.path}`;
  const stream = isStreamBody(ctx.body);
  const baseIo = extractIO({ path, body: ctx.body, stream });
  const maxRetries = getMaxRetries();
  const retryDelay = getRetryDelayMs();
  const canReplayBody = !ctx.bodyStream;

  const provider = resolveProviderForModel(model);
  if (!provider) {
    writeLog({
      method: ctx.method,
      path,
      model,
      api_key_id: ctx.apiKeyId,
      api_key_name: ctx.apiKeyName,
      status_code: 502,
      latency_ms: Date.now() - started,
      cached: false,
      error: "No enabled provider configured",
      input_text: baseIo.input_text,
      stream,
    });
    res.status(502).json({
      error: { message: "No enabled upstream provider configured", type: "proxy_error" },
    });
    return;
  }

  let lastError: string | null = null;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts += 1;
    let handle: UpstreamHandle | undefined;
    try {
      handle = await openUpstream(provider, ctx, path);
      const retryable = isRetryableStatus(handle.response.status) && canReplayBody && attempts <= maxRetries;
      if (retryable) {
        try {
          await handle.response.buffer();
        } finally {
          handle.clearTimeout();
        }
        lastError = `Upstream HTTP ${handle.response.status}`;
        await sleep(retryDelay * attempts);
        continue;
      }

      await pipeResponseToClient({
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
      return;
    } catch (error) {
      handle?.abort();
      lastError = error instanceof Error ? error.message : String(error);
      if (!res.headersSent && canReplayBody && attempts <= maxRetries && isRetryableError(error)) {
        await sleep(retryDelay * attempts);
        continue;
      }
      break;
    }
  }

  writeLog({
    method: ctx.method,
    path,
    model,
    provider_id: provider.id,
    provider_name: provider.name,
    api_key_id: ctx.apiKeyId,
    api_key_name: ctx.apiKeyName,
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
