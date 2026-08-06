import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { errorHandler, notFoundJson } from "../src/middleware/errors";

/**
 * M11 regressions: Express's default error responses are HTML pages that
 * leak stack traces and filesystem paths. The global JSON middleware must:
 *   - return JSON 404 for unmatched routes,
 *   - map body-parser overruns to 413 (not 500),
 *   - map invalid JSON to 400,
 *   - map multer LIMIT_FILE_SIZE to 413,
 *   - keep app-labeled 4xx statuses/messages,
 *   - return a bare 500 for unknown errors, never leaking stack details.
 */
test("global JSON error middleware", async () => {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  // Use next(err) rather than a bare throw so the path is independent of
  // Express version quirks around synchronous exceptions.
  app.get("/boom", (_req, _res, next) => {
    next(new Error("internal-detail-secret"));
  });
  app.get("/bad", (_req, _res, next) => {
    next(Object.assign(new Error("Labeled client error"), { status: 400 }));
  });
  app.get("/ok", (_req, res) => res.json({ ok: true }));
  app.post("/parse", (_req, res) => res.json({ ok: true }));
  app.post("/multer", (_req, _res, next) => {
    next(Object.assign(new Error("file too big"), { code: "LIMIT_FILE_SIZE" }));
  });
  app.use(notFoundJson);
  app.use(errorHandler);

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // Unmatched route -> JSON 404, not an HTML page.
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type")?.includes("application/json"), true);
    assert.deepEqual(await missing.json(), { error: "Not found" });

    // Unknown 500 -> bare message, no stack trace, no paths.
    const boom = await fetch(`${base}/boom`);
    assert.equal(boom.status, 500);
    const boomBody = (await boom.json()) as { error: string };
    assert.deepEqual(boomBody, { error: "Internal server error" });
    assert.equal(JSON.stringify(boomBody).includes("internal-detail-secret"), false);
    assert.equal(JSON.stringify(boomBody).includes("/Users/"), false, "no filesystem paths leak");

    // App-labeled 4xx keeps its status and message.
    const bad = await fetch(`${base}/bad`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "Labeled client error" });

    // Healthy routes still pass through untouched.
    assert.equal((await fetch(`${base}/ok`)).status, 200);

    // body-parser limit exceeded -> 413.
    const tooBig = await fetch(`${base}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(8 * 1024) }),
    });
    assert.equal(tooBig.status, 413);
    assert.deepEqual(await tooBig.json(), { error: "Request body too large" });

    // Malformed JSON -> 400.
    const badJson = await fetch(`${base}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: "Invalid JSON body" });

    // multer file-size overrun -> 413.
    const fileLimit = await fetch(`${base}/multer`, { method: "POST" });
    assert.equal(fileLimit.status, 413);
    assert.deepEqual(await fileLimit.json(), { error: "File too large" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
