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

test("effort mapping: validation, fall-through routing, and upstream rewrite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-effort-routing-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "effort-routing-secret";

  const seen: Record<string, { requests: number; lastEffort: string | null }> = {
    p1: { requests: 0, lastEffort: null },
    p2: { requests: 0, lastEffort: null },
    p3: { requests: 0, lastEffort: null },
  };
  const makeUpstream = (key: string) =>
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen[key].requests += 1;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          seen[key].lastEffort = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : null;
        } catch {
          seen[key].lastEffort = null;
        }
        const body = JSON.stringify({
          id: `${key}-${seen[key].requests}`,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      });
    });
  const upstream1 = makeUpstream("p1");
  const upstream2 = makeUpstream("p2");
  const upstream3 = makeUpstream("p3");
  const [port1, port2, port3] = await Promise.all([listen(upstream1), listen(upstream2), listen(upstream3)]);

  const { default: express } = await import("express");
  const { db, initDb, setSetting } = await import("../src/db");
  const { createProvider, mapProviderEffort, normalizeModelEfforts, supportedEffortsForModel } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");
  const { resetProviderAffinityForTests } = await import("../src/services/provider-affinity");

  let relay: http.Server | null = null;
  try {
    initDb();
    resetProviderAffinityForTests();
    setSetting("max_retries", "0");
    setSetting("other_max_retries", "0");
    setSetting("retry_delay_ms", "0");

    // Validation: any non-empty level name is accepted (unknown levels are
    // kept — new upstream levels must not require a relay release); empty
    // names and unserved models are dropped.
    assert.deepEqual(
      normalizeModelEfforts(
        {
          "m-a": { low: "low", medium: "mid", max: "high", ultra: "high", "": "y" },
          "m-not-served": { low: "low" },
        },
        ["m-a"],
      ),
      { "m-a": { low: "low", medium: "mid", max: "high", ultra: "high" } },
    );
    assert.deepEqual(normalizeModelEfforts({}, ["m-a"]), {});
    assert.deepEqual(normalizeModelEfforts(null, ["m-a"]), {});

    // P1 natively speaks low/high — identity mapping.
    const p1 = createProvider({
      name: "p1",
      base_url: `http://127.0.0.1:${port1}`,
      models: ["m-a"],
      model_efforts: { "m-a": { low: "low", high: "high" } },
    });
    // P2's upstream only accepts low/high, but publicly it serves max (max → high).
    const p2 = createProvider({
      name: "p2",
      base_url: `http://127.0.0.1:${port2}`,
      models: ["m-a"],
      model_efforts: { "m-a": { max: "high" } },
    });
    // P3 has no effort config: accepts anything, passes through unchanged.
    createProvider({
      name: "p3",
      base_url: `http://127.0.0.1:${port3}`,
      models: ["m-b"],
    });

    // Unit-level mapping checks.
    assert.equal(mapProviderEffort(p1, "m-a", "high"), "high");
    assert.equal(mapProviderEffort(p1, "m-a", "max"), null);
    assert.equal(mapProviderEffort(p2, "m-a", "max"), "high");
    assert.equal(mapProviderEffort(p2, "m-a", "low"), null);
    assert.deepEqual(supportedEffortsForModel("m-a"), ["low", "high", "max"]);

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
    const send = (body: unknown) =>
      fetch(`http://127.0.0.1:${relayPort}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // effort=max: P1 doesn't cover it → skipped entirely; P2 serves it as "high".
    const maxResp = await send({ model: "m-a", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" });
    assert.equal(maxResp.status, 200);
    assert.equal(seen.p1.requests, 0);
    assert.equal(seen.p2.requests, 1);
    assert.equal(seen.p2.lastEffort, "high");

    // effort=low: only P1 covers it (P2's mapping lacks low) → P1 gets "low".
    const lowResp = await send({ model: "m-a", messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" });
    assert.equal(lowResp.status, 200);
    assert.equal(seen.p1.requests, 1);
    assert.equal(seen.p1.lastEffort, "low");
    assert.equal(seen.p2.requests, 1);

    // effort=medium: nobody covers it → 400 before touching any upstream.
    const mediumResp = await send({ model: "m-a", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" });
    assert.equal(mediumResp.status, 400);
    const mediumError = (await mediumResp.json()) as { error?: { message?: string } };
    assert.match(mediumError.error?.message ?? "", /low, high, max/);
    assert.equal(seen.p1.requests, 1);
    assert.equal(seen.p2.requests, 1);

    // No effort config on P3: any effort passes through untouched.
    const anyResp = await send({ model: "m-b", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" });
    assert.equal(anyResp.status, 200);
    assert.equal(seen.p3.requests, 1);
    assert.equal(seen.p3.lastEffort, "max");
  } finally {
    if (relay) await close(relay);
    await Promise.all([close(upstream1), close(upstream2), close(upstream3)]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
