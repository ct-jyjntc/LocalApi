import { Router, Request, Response } from "express";
import { requireApiKey } from "../middleware/auth";
import { listProviders } from "../services/providers";
import { handleProxyHttp } from "../services/proxy";
import { lookupCache, storeCache } from "../services/cache";
import type { ApiKey } from "../db";
import { isModelAllowedForKey } from "../services/access";
import { getModelPrice } from "../services/billing";
import { maintainActiveSubscription } from "../services/plans";
import { normalizeOpenAICompatBody } from "../utils/openai-compat";

export const proxyRouter = Router();
const MAX_BUFFERED_BODY = 20 * 1024 * 1024;
type BillingMode = "wallet" | "coding";
type BillingRequest = Request & { billingMode?: BillingMode };

function isBufferableContentType(value: string) {
  return (
    value.startsWith("application/json") ||
    value.includes("+json") ||
    value.startsWith("application/x-www-form-urlencoded") ||
    value.startsWith("text/")
  );
}

function readRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BUFFERED_BODY) {
        fail(new Error("Request body exceeds 20MB limit"));
        return;
      }
      chunks.push(buffer);
    });
    req.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.once("error", fail);
    req.once("aborted", () => fail(new Error("Client aborted request")));
  });
}

function ensureStreamUsage(body: unknown, path: string) {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if (record.stream !== true) return body;
  if (path !== "/v1/chat/completions" && path !== "/v1/completions") return body;
  const existing =
    record.stream_options && typeof record.stream_options === "object"
      ? (record.stream_options as Record<string, unknown>)
      : {};
  return {
    ...record,
    stream_options: { ...existing, include_usage: true },
  };
}

// Only protect API proxy paths — never intercept the admin SPA/static files.
const v1 = Router();
v1.use(requireApiKey);

// OpenAI-compatible models list (aggregated)
v1.get("/models", async (req: Request, res: Response) => {
  const apiKey = (req as Request & { apiKey?: ApiKey }).apiKey;
  const billingMode = (req as BillingRequest).billingMode ?? "wallet";
  if (billingMode === "coding" && apiKey?.user_id && !maintainActiveSubscription(apiKey.user_id)) {
    return res.status(402).json({
      error: { message: "An active Coding Plan is required for /coding requests", type: "coding_plan_required" },
    });
  }
  if (!apiKey?.user_id) {
    const cached = lookupCache({
      method: "GET",
      path: "/v1/models",
      query: req.query as Record<string, unknown>,
    });
    if (cached.hit) {
      const headers = JSON.parse(cached.entry.response_headers) as Record<string, string>;
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      res.setHeader("x-cache", "HIT");
      res.status(cached.entry.status_code).send(cached.entry.response_body);
      return;
    }
  }

  const providers = listProviders().filter((p) => p.enabled === 1);
  const data: Array<{
    id: string;
    object: string;
    owned_by: string;
    reasoning?: { enabled: boolean; effort: string[] };
    image_input?: boolean;
    context_window?: number;
    max_output_tokens?: number;
  }> = [];

  for (const p of providers) {
    try {
      const models = JSON.parse(p.models) as string[];
      for (const m of models) {
        if (m === "*") continue;
        const price = getModelPrice(m);
        if (apiKey?.user_id && (!isModelAllowedForKey(apiKey, m, { includeSubscription: billingMode === "coding" }) || !price?.enabled)) continue;
        data.push({
          id: m,
          object: "model",
          owned_by: p.name,
          ...(price
            ? {
                reasoning: { enabled: price.reasoning_enabled, effort: price.reasoning_effort },
                image_input: price.image_input,
                ...(price.context_window > 0 ? { context_window: price.context_window } : {}),
                ...(price.max_output_tokens > 0 ? { max_output_tokens: price.max_output_tokens } : {}),
              }
            : {}),
        });
      }
    } catch {
      // skip
    }
  }

  if (data.length === 0 && providers.length > 0 && !apiKey?.user_id) {
    await handleProxyHttp(
      {
        method: "GET",
        path: "/v1/models",
        query: req.query as Record<string, unknown>,
        headers: req.headers as Record<string, string | string[] | undefined>,
        apiKeyId: apiKey?.id,
        apiKeyName: apiKey?.name,
        apiKey,
      },
      res,
    );
    return;
  }

  const payload = JSON.stringify({ object: "list", data });
  if (!apiKey?.user_id) {
    storeCache({
      method: "GET",
      path: "/v1/models",
      query: req.query as Record<string, unknown>,
      statusCode: 200,
      responseHeaders: { "content-type": "application/json; charset=utf-8" },
      responseBody: payload,
    });
    res.setHeader("x-cache", "MISS");
  }
  res.type("application/json").send(payload);
});

async function handleProxy(req: Request, res: Response) {
  const apiKey = (req as Request & { apiKey?: ApiKey })
    .apiKey;
  // req.path here is relative to /v1 mount
  const path = `/v1${req.path.startsWith("/") ? req.path : `/${req.path}`}`;
  const billingMode = (req as BillingRequest).billingMode ?? "wallet";
  const clientPath = `${req.baseUrl}${req.path.startsWith("/") ? req.path : `/${req.path}`}`;

  const contentType = (req.header("content-type") || "").toLowerCase();
  let body: unknown;
  let rawBody: Buffer | undefined;
  let bodyStream: NodeJS.ReadableStream | undefined;
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (isBufferableContentType(contentType)) {
        rawBody = await readRawBody(req);
        if (rawBody.length > 0) {
          if (contentType.startsWith("application/json") || contentType.includes("+json")) {
            try {
              body = JSON.parse(rawBody.toString("utf8"));
              body = ensureStreamUsage(body, path);
              // Pi / OpenAI SDK → Z.ai / DeepSeek-style pool compatibility
              // (developer role, boolean thinking, store, prompt_cache_*).
              body = normalizeOpenAICompatBody(body, path).body;
              rawBody = Buffer.from(JSON.stringify(body));
            } catch {
              res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } });
              return;
            }
          } else {
            body = rawBody.toString("utf8");
          }
        }
      } else if (!req.readableEnded) {
        // Preserve multipart and binary uploads as a true stream. These bodies
        // cannot be replayed safely, so the proxy disables retries for them.
        bodyStream = req;
      }
    }
  } catch (error) {
    res.status(413).json({
      error: {
        message: error instanceof Error ? error.message : "Request body rejected",
        type: "invalid_request_error",
      },
    });
    return;
  }

  await handleProxyHttp(
    {
      method: req.method,
      path,
      query: req.query as Record<string, unknown>,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      rawBody,
      bodyStream,
      apiKeyId: apiKey?.id,
      apiKeyName: apiKey?.name,
      apiKey,
      billingMode,
      clientPath,
    },
    res,
  );
}

v1.post("/chat/completions", handleProxy);
v1.post("/completions", handleProxy);
v1.post("/embeddings", handleProxy);
v1.post("/images/generations", handleProxy);
v1.post("/audio/transcriptions", handleProxy);
v1.post("/audio/speech", handleProxy);
// Express 5 named wildcard
v1.all("/{*rest}", handleProxy);

function billingMode(mode: BillingMode) {
  return (req: Request, _res: Response, next: () => void) => {
    (req as BillingRequest).billingMode = mode;
    next();
  };
}

proxyRouter.use("/coding/v1", billingMode("coding"), v1);
proxyRouter.use("/coding", billingMode("coding"), v1);
proxyRouter.use("/v1", billingMode("wallet"), v1);
