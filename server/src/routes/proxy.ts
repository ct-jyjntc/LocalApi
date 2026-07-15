import { Router, Request, Response } from "express";
import { requireApiKey } from "../middleware/auth";
import { listProviders } from "../services/providers";
import { handleProxyHttp } from "../services/proxy";

export const proxyRouter = Router();
const MAX_BUFFERED_BODY = 20 * 1024 * 1024;

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

// Only protect API proxy paths — never intercept the admin SPA/static files.
const v1 = Router();
v1.use(requireApiKey);

// OpenAI-compatible models list (aggregated)
v1.get("/models", async (req: Request, res: Response) => {
  const providers = listProviders().filter((p) => p.enabled === 1);
  const data: Array<{ id: string; object: string; owned_by: string }> = [];

  for (const p of providers) {
    try {
      const models = JSON.parse(p.models) as string[];
      for (const m of models) {
        if (m === "*") continue;
        data.push({ id: m, object: "model", owned_by: p.name });
      }
    } catch {
      // skip
    }
  }

  if (data.length === 0 && providers.length > 0) {
    const apiKey = (req as Request & { apiKey?: { id: string; name: string } })
      .apiKey;
    await handleProxyHttp(
      {
        method: "GET",
        path: "/v1/models",
        query: req.query as Record<string, unknown>,
        headers: req.headers as Record<string, string | string[] | undefined>,
        apiKeyId: apiKey?.id,
        apiKeyName: apiKey?.name,
      },
      res,
    );
    return;
  }

  return res.json({ object: "list", data });
});

async function handleProxy(req: Request, res: Response) {
  const apiKey = (req as Request & { apiKey?: { id: string; name: string } })
    .apiKey;
  // req.path here is relative to /v1 mount
  const path = `/v1${req.path.startsWith("/") ? req.path : `/${req.path}`}`;

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

proxyRouter.use("/v1", v1);
