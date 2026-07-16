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

  const [failingPort, healthyPort, retryingPort] = await Promise.all([
    listen(failingUpstream),
    listen(healthyUpstream),
    listen(retryingUpstream),
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
    assert.match(firstResponse.headers.get("x-provider") || "", new RegExp(`^${healthy.id}:`));
    assert.equal(firstResponse.headers.get("x-retry-attempts"), "2");
    assert.equal(failingRequests, 1);
    assert.equal(healthyRequests, 1);

    const secondResponse = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(continuedBody),
    });
    assert.equal(secondResponse.status, 200);
    assert.match(secondResponse.headers.get("x-provider") || "", new RegExp(`^${healthy.id}:`));
    assert.equal(failingRequests, 1);
    assert.equal(healthyRequests, 2);

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
    await Promise.all([close(failingUpstream), close(healthyUpstream), close(retryingUpstream)]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
