import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

function listen(server: http.Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

// A provider model mapping means the upstream's raw payloads carry the
// UPSTREAM's real model name. Without a dialect translator nothing rewrote
// them, leaking the channel's backend to clients. These tests pin the echo
// rewrite for the plain passthrough path (no injection, no translation).
test("leak: mapped upstream model name is echoed back as the public name (non-stream + error body)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-model-leak-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "model-leak-secret";

  const upstream = http.createServer((req, res) => {
    readBody(req).then((parsed) => {
      // Upstream only ever answers with its REAL model name.
      const fail = Array.isArray(parsed.messages)
        && (parsed.messages[0] as { content?: string })?.content === "fail";
      const body = fail
        ? JSON.stringify({
            error: {
              message: "model `real-upstream-model` is currently overloaded",
              type: "invalid_request_error",
            },
          })
        : JSON.stringify({
            id: "chatcmpl-up",
            object: "chat.completion",
            model: "real-upstream-model",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          });
      res.writeHead(fail ? 400 : 200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  });
  const upstreamPort = await listen(upstream);

  const { default: express } = await import("express");
  const { db, initDb, setSetting } = await import("../src/db");
  const { createProvider } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");
  const { resetProviderAffinityForTests } = await import("../src/services/provider-affinity");

  let relay: http.Server | null = null;
  try {
    initDb();
    resetProviderAffinityForTests();
    setSetting("max_retries", "0");
    setSetting("other_max_retries", "0");
    setSetting("retry_delay_ms", "0");

    createProvider({
      name: "leak-cc",
      base_url: `http://127.0.0.1:${upstreamPort}`,
      models: ["public-model"],
      model_mappings: { "public-model": "real-upstream-model" },
    });

    const app = express();
    app.use(express.json());
    app.post("/chat", async (req, res) => {
      await handleProxyHttp(
        {
          method: "POST",
          path: "/v1/chat/completions",
          query: {},
          headers: { "content-type": "application/json" },
          body: req.body,
          apiKeyId: "test-key",
        },
        res,
      );
    });
    relay = http.createServer(app);
    const relayPort = await listen(relay);

    // Success path: client must see the public name, never the upstream one.
    const okResp = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(okResp.status, 200);
    const okText = await okResp.text();
    assert.ok(!okText.includes("real-upstream-model"), `upstream model leaked: ${okText}`);
    assert.equal((JSON.parse(okText) as { model: string }).model, "public-model");

    // Error path: the upstream's error message echoes its model name too.
    const errResp = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "public-model", messages: [{ role: "user", content: "fail" }] }),
    });
    assert.equal(errResp.status, 400);
    const errText = await errResp.text();
    assert.ok(!errText.includes("real-upstream-model"), `upstream model leaked in error: ${errText}`);
    assert.ok(errText.includes("public-model"), `error should reference the public model: ${errText}`);
  } finally {
    if (relay) await close(relay);
    await close(upstream);
    // db stays open: the tests below share this process's module-level
    // db singleton (it cannot reopen after close).
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("leak: streaming anthropic frames echo the public model name (nested message.model)", async () => {
  const frames = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "real-claude-x", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  const upstream = http.createServer((req, res) => {
    readBody(req).then(() => {
      const body = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}`).join("\n\n") + "\n\n";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body);
    });
  });
  const upstreamPort = await listen(upstream);

  const { default: express } = await import("express");
  const { setSetting } = await import("../src/db");
  const { createProvider } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");
  const { resetProviderAffinityForTests } = await import("../src/services/provider-affinity");

  let relay: http.Server | null = null;
  try {
    resetProviderAffinityForTests();
    setSetting("max_retries", "0");
    setSetting("other_max_retries", "0");
    setSetting("retry_delay_ms", "0");

    // Same-dialect channel (anthropic → anthropic): NO translator runs, so
    // without the echo rewrite the nested message.model leaks verbatim.
    createProvider({
      name: "leak-anthropic",
      base_url: `http://127.0.0.1:${upstreamPort}`,
      models: ["public-claude"],
      model_mappings: { "public-claude": "real-claude-x" },
      protocols: ["anthropic-messages"],
    });

    const app = express();
    app.use(express.json());
    app.post("/messages", async (req, res) => {
      await handleProxyHttp(
        {
          method: "POST",
          path: "/v1/messages",
          query: {},
          headers: { "content-type": "application/json" },
          body: req.body,
          apiKeyId: "test-key",
        },
        res,
      );
    });
    relay = http.createServer(app);
    const relayPort = await listen(relay);

    const resp = await fetch(`http://127.0.0.1:${relayPort}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "public-claude",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(!text.includes("real-claude-x"), `upstream model leaked in stream: ${text}`);
    const start = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; message?: { model?: string } })
      .find((e) => e.type === "message_start");
    assert.equal(start?.message?.model, "public-claude");
  } finally {
    if (relay) await close(relay);
    await close(upstream);
  }
});

test("leak: /v1/models dedupes ids and never exposes channel names", async () => {
  const { default: express } = await import("express");
  const { createProvider } = await import("../src/services/providers");
  const { createApiKey, deleteApiKey } = await import("../src/services/keys");
  const { setSetting } = await import("../src/db");
  const { proxyRouter } = await import("../src/routes/proxy");

  setSetting("brand_name", "LeakBrand");

  createProvider({
    name: "channel-alpha",
    base_url: "http://127.0.0.1:1",
    models: ["leak-m-a", "leak-m-shared"],
  });
  createProvider({
    name: "channel-beta",
    base_url: "http://127.0.0.1:2",
    models: ["leak-m-shared", "leak-m-b"],
  });

  const key = createApiKey({ name: "models-leak-test" });
  const app = express();
  app.use(proxyRouter);
  const relay = http.createServer(app);
  const relayPort = await listen(relay);
  try {
    const resp = await fetch(`http://127.0.0.1:${relayPort}/v1/models`, {
      headers: { authorization: `Bearer ${key.key}` },
    });
    assert.equal(resp.status, 200);
    const json = (await resp.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ours = json.data.filter((m) => m.id.startsWith("leak-m-"));
    const ids = ours.map((m) => m.id);
    assert.deepEqual([...ids].sort(), ["leak-m-a", "leak-m-b", "leak-m-shared"]);
    assert.equal(new Set(ids).size, ids.length, "duplicate model ids");
    for (const m of ours) {
      assert.equal(m.owned_by, "LeakBrand", `owned_by should be the brand name: ${JSON.stringify(m)}`);
    }
  } finally {
    await close(relay);
    deleteApiKey(key.id);
  }
});
