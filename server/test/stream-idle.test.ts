import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

/**
 * Read an SSE response over a raw TCP socket. The caller pauses the socket
 * after the first body bytes, which stalls the TCP receive window and gives
 * the relay REAL backpressure (node's fetch/undici buffers internally and
 * never backpressures the socket, so it cannot simulate a slow reader).
 */
function readSseWithPause(port: number, request: string, pauseMs: number) {
  return new Promise<{ body: string; frames: number }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buffered = "";
    let headerDone = false;
    let paused = false;
    let body = "";
    socket.setEncoding("utf8");
    const finish = () => {
      const frames = body.split("data: ").length - 1;
      resolve({ body, frames });
    };
    socket.on("data", (chunk: string) => {
      if (!headerDone) {
        buffered += chunk;
        const marker = buffered.indexOf("\r\n\r\n");
        if (marker < 0) return;
        headerDone = true;
        body = buffered.slice(marker + 4);
        buffered = "";
        if (body.length > 0 && !paused) {
          paused = true;
          socket.pause();
          setTimeout(() => socket.resume(), pauseMs);
        }
        return;
      }
      body += chunk;
      if (!paused) {
        paused = true;
        socket.pause();
        setTimeout(() => socket.resume(), pauseMs);
      }
    });
    socket.on("error", reject);
    socket.on("close", finish);
    socket.on("end", finish);
    socket.write(request);
  });
}

function listen(server: http.Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * M7/M8 regressions: the stream idle timer must be armed only while waiting
 * for the next upstream chunk — never while the client is backpressured or
 * the upstream has already finished — and the provider timeout_ms must not
 * truncate large buffered responses mid-download.
 */
test("stream idle: backpressured client does not kill a live upstream; large buffered downloads survive timeout_ms", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-stream-idle-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "stream-idle-test-secret";
  // Speed up the stall detector so the test does not wait minutes.
  process.env.STREAM_IDLE_TIMEOUT_MS = "300";

  const CHUNK = "x".repeat(512 * 1024);
  const TOTAL_CHUNKS = 40;
  const chunkIntervalMs = 100;
  let sseChunksSent = 0;
  let sseRequestClosedEarly = false;
  const sseUpstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.on("close", () => {
      // If the relay destroyed the body while chunks were still queued, the
      // connection closes before all chunks were delivered.
      if (sseChunksSent < TOTAL_CHUNKS) sseRequestClosedEarly = true;
    });
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      sseChunksSent += 1;
      res.write(`data: ${CHUNK}\n\n`);
      if (index >= TOTAL_CHUNKS) {
        clearInterval(timer);
        res.end();
      }
    }, chunkIntervalMs);
  });

  const slowJson = http.createServer((_req, res) => {
    // Large non-streaming response delivered slowly: 16 chunks of 128 KiB
    // every 100 ms (~1.6 s total) with a tiny provider timeout.
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(16 * 128 * 1024),
    });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      res.write(Buffer.alloc(128 * 1024, 0x61));
      if (sent >= 16) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  });

  const [ssePort, slowPort] = await Promise.all([listen(sseUpstream), listen(slowJson)]);

  const { default: express } = await import("express");
  const { db, initDb } = await import("../src/db");
  const { createProvider } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");

  let relay: http.Server | null = null;
  try {
    initDb();
    const sseProvider = createProvider({
      name: "sse-upstream",
      base_url: `http://127.0.0.1:${ssePort}`,
      models: ["sse-model"],
    });
    // provider timeout_ms = 300 ms: previously fatal for a ~1.6 s download.
    const slowProvider = createProvider({
      name: "slow-json",
      base_url: `http://127.0.0.1:${slowPort}`,
      models: ["slow-model"],
      timeout_ms: 300,
    });

    const app = express();
    app.use(express.json());
    app.post("/chat", async (req, res) => {
      await handleProxyHttp({
        method: "POST",
        path: "/v1/chat/completions",
        query: {},
        headers: { "content-type": "application/json" },
        body: req.body,
        apiKeyId: "test-key",
      }, res);
    });
    relay = http.createServer(app);
    const relayPort = await listen(relay);

    // M7: SSE over a raw TCP socket. The client stops reading for 1200 ms —
    // longer than the 300 ms idle window — which stalls the receive window
    // and backpressures the relay's socket, while the upstream keeps
    // producing chunks every 100 ms. Backpressure is not an upstream stall:
    // the whole stream must arrive.
    const streamBody = { model: "sse-model", stream: true, messages: [{ role: "user", content: "hi" }] };
    const streamRequest =
      `POST /chat HTTP/1.1\r\nHost: relay\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(JSON.stringify(streamBody))}\r\nConnection: close\r\n\r\n` +
      JSON.stringify(streamBody);
    const sse = await readSseWithPause(relayPort, streamRequest, 1200);
    assert.equal(sse.frames, TOTAL_CHUNKS, "all stream chunks must reach the client");
    // The relay chunks its socket writes (~64 KiB frames), so a full chunk
    // string may be split; count payload bytes instead.
    assert.equal(sse.body.split("x").length - 1, TOTAL_CHUNKS * CHUNK.length, "payload bytes are intact");
    assert.equal(sseRequestClosedEarly, false, "upstream must not be killed by client backpressure");
    assert.equal(sseChunksSent, TOTAL_CHUNKS);

    // M8: non-streaming slow download with a tiny provider timeout_ms.
    const bufferedBody = { model: "slow-model", messages: [{ role: "user", content: "hi" }] };
    const bufferedResponse = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bufferedBody),
    });
    assert.equal(bufferedResponse.status, 200);
    const body = await bufferedResponse.arrayBuffer();
    assert.equal(body.byteLength, 16 * 128 * 1024, "the full body must arrive, not a truncated one");
    void slowProvider;
  } finally {
    if (relay) await close(relay);
    await close(sseUpstream);
    await close(slowJson);
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
    delete process.env.STREAM_IDLE_TIMEOUT_MS;
  }
});
