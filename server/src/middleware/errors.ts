import type { ErrorRequestHandler, RequestHandler } from "express";

/**
 * M11: Express's default error responses are HTML pages that leak stack
 * traces and filesystem paths to API clients. These two middleware replace
 * them with JSON:
 *   - notFoundJson: unmatched routes -> {"error":"Not found"} (Express's
 *     default 404 is an HTML page too).
 *   - errorHandler: maps well-known body-parser/multer failures to the right
 *     status codes (413 instead of a 500) and never serializes stack traces.
 */
export const notFoundJson: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Response already committed (e.g. mid-stream): let the default handler
  // destroy the socket; we cannot send JSON anymore.
  if (res.headersSent) return next(err);

  const type = (err as { type?: string } | null)?.type;
  const code = (err as { code?: string } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;

  if (type === "entity.too.large") {
    // body-parser/json limit exceeded — a request problem, not a server one.
    return res.status(413).json({ error: "Request body too large" });
  }
  if (type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  if (code === "LIMIT_FILE_SIZE") {
    // multer file size limit — 413, not 500.
    return res.status(413).json({ error: "File too large" });
  }
  if (typeof status === "number" && status >= 400 && status < 500) {
    // Errors the app itself labeled 4xx keep their status and message.
    const message = (err as { message?: string } | null)?.message;
    return res.status(status).json({ error: message ?? "Request failed" });
  }

  console.error("[error] Unhandled error:", err);
  // Never leak the stack trace or internal paths to clients.
  return res.status(500).json({ error: "Internal server error" });
};
