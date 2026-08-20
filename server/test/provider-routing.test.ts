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

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

test("provider retries fail over while the same conversation keeps its healthy channel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-provider-routing-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "provider-routing-test-secret";

  let failingRequests = 0;
  let healthyRequests = 0;
  let testRequests = 0;
  let stallingRequests = 0;
  const failingUpstream = http.createServer((_req, res) => {
    failingRequests += 1;
    jsonResponse(res, 503, { error: { message: "temporarily unavailable" } });
  });
  const healthyUpstream = http.createServer((_req, res) => {
    healthyRequests += 1;
    jsonResponse(res, 200, {
      id: `healthy-${healthyRequests}`,
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const retryingUpstream = http.createServer((_req, res) => {
    testRequests += 1;
    if (testRequests < 3) {
      jsonResponse(res, 503, { error: { message: "retry me" } });
      return;
    }
    jsonResponse(res, 200, {
      id: "test-ok",
      choices: [{ message: { role: "assistant", content: "OK" } }],
    });
  });
  const stallingUpstream = http.createServer((_req, res) => {
    stallingRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    setTimeout(() => res.end('{"late":true}'), 300);
  });

  const [failingPort, healthyPort, retryingPort, stallingPort] = await Promise.all([
    listen(failingUpstream),
    listen(healthyUpstream),
    listen(retryingUpstream),
    listen(stallingUpstream),
  ]);

  const { default: express } = await import("express");
  const { db, initDb, setSetting } = await import("../src/db");
  const { createProvider } = await import("../src/services/providers");
  const { handleProxyHttp, testProviderConnection } = await import("../src/services/proxy");
  const {
    buildProviderAffinityKey,
    orderProvidersForConversation,
    rememberProviderAffinity,
    resetProviderAffinityForTests,
  } = await import("../src/services/provider-affinity");

  let relay: http.Server | null = null;
  try {
    initDb();
    resetProviderAffinityForTests();
    setSetting("max_retries", "1");
    setSetting("retry_delay_ms", "0");
    const failing = createProvider({
      name: "failing",
      base_url: `http://127.0.0.1:${failingPort}`,
      models: ["shared-model"],
    });
    const healthy = createProvider({
      name: "healthy",
      base_url: `http://127.0.0.1:${healthyPort}`,
      models: ["shared-model"],
    });
    assert.equal(
      orderProvidersForConversation([failing, healthy], null, () => 0.99)[0].id,
      healthy.id,
    );

    const firstBody = {
      model: "shared-model",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Start this conversation" },
      ],
    };
    const continuedBody = {
      ...firstBody,
      messages: [
        ...firstBody.messages,
        { role: "assistant", content: "ok" },
        { role: "user", content: "Continue" },
      ],
    };
    const firstAffinity = buildProviderAffinityKey({
      model: firstBody.model,
      body: firstBody,
      headers: {},
      apiKeyId: "test-key",
      billingMode: "wallet",
    });
    const continuedAffinity = buildProviderAffinityKey({
      model: continuedBody.model,
      body: continuedBody,
      headers: {},
      apiKeyId: "test-key",
      billingMode: "wallet",
    });
    assert.equal(firstAffinity, continuedAffinity);
    rememberProviderAffinity(firstAffinity, failing.id);

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

    const firstResponse = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstBody),
    });
    assert.equal(firstResponse.status, 200);
    // Failover proof via upstream counters (the x-provider/x-retry-attempts
    // headers are deliberately stripped from client responses — they leak
    // relay internals). Affinity pinned the first attempt to the failing
    // channel; the 200 means the retry was served by the healthy one.
    assert.equal(failingRequests, 1);
    assert.equal(healthyRequests, 1);

    const secondResponse = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(continuedBody),
    });
    assert.equal(secondResponse.status, 200);
    // Same conversation sticks to its healthy channel: no new failing hit.
    assert.equal(failingRequests, 1);
    assert.equal(healthyRequests, 2);

    const stalling = createProvider({
      name: "stalling",
      base_url: `http://127.0.0.1:${stallingPort}`,
      models: ["timeout-model"],
      timeout_ms: 100,
    });
    const timeoutHealthy = createProvider({
      name: "timeout-healthy",
      base_url: `http://127.0.0.1:${healthyPort}`,
      models: ["timeout-model"],
    });
    const timeoutBody = { model: "timeout-model", messages: [{ role: "user", content: "hello" }] };
    const timeoutAffinity = buildProviderAffinityKey({ model: timeoutBody.model, body: timeoutBody, headers: {}, apiKeyId: "test-key", billingMode: "wallet" });
    rememberProviderAffinity(timeoutAffinity, stalling.id);
    const healthyBefore = healthyRequests;
    const timeoutResponse = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(timeoutBody),
    });
    assert.equal(timeoutResponse.status, 200);
    // Stalling channel hit once, then the retry landed on the healthy channel.
    assert.equal(healthyRequests, healthyBefore + 1);
    assert.equal(stallingRequests, 1);

    setSetting("max_retries", "2");
    const testProvider = createProvider({
      name: "retrying-test",
      base_url: `http://127.0.0.1:${retryingPort}`,
      models: ["test-model"],
    });
    const result = await testProviderConnection(testProvider.id, "test-model");
    assert.ok(result?.ok);
    assert.equal(result?.attempts, 3);
    assert.equal(result?.max_retries, 2);
    assert.equal(testRequests, 3);
  } finally {
    if (relay) await close(relay);
    await Promise.all([close(failingUpstream), close(healthyUpstream), close(retryingUpstream), close(stallingUpstream)]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
