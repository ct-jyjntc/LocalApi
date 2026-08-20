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

test("reasoning-effort helpers: per-protocol extract and rewrite", async () => {
  const { extractRequestEffort, rewriteRequestEffort } = await import("../src/utils/reasoning-effort");

  // chat/completions: flat reasoning_effort only
  assert.equal(extractRequestEffort({ reasoning_effort: "high" }, "/v1/chat/completions"), "high");
  assert.equal(extractRequestEffort({ reasoning: { effort: "high" } }, "/v1/chat/completions"), null);
  assert.deepEqual(
    rewriteRequestEffort({ reasoning_effort: "max", model: "m" }, "/v1/chat/completions", "high"),
    { body: { reasoning_effort: "high", model: "m" }, changed: true },
  );

  // responses: reasoning.effort, top-level reasoning_effort as fallback
  assert.equal(extractRequestEffort({ reasoning: { effort: "low" } }, "/v1/responses"), "low");
  assert.equal(extractRequestEffort({ reasoning_effort: "low" }, "/v1/responses"), "low");
  assert.equal(extractRequestEffort({ output_config: { effort: "low" } }, "/v1/responses"), null);
  const responsesRewrite = rewriteRequestEffort(
    { reasoning: { effort: "max", summary: "auto" } },
    "/v1/responses",
    "high",
  );
  assert.deepEqual(responsesRewrite.body, { reasoning: { effort: "high", summary: "auto" } });
  assert.equal(responsesRewrite.changed, true);

  // messages: output_config.effort (Anthropic effort param), flat fallback
  assert.equal(extractRequestEffort({ output_config: { effort: "max" } }, "/v1/messages"), "max");
  assert.equal(extractRequestEffort({ reasoning_effort: "max" }, "/v1/messages"), "max");
  const messagesRewrite = rewriteRequestEffort(
    { output_config: { effort: "max" } },
    "/v1/messages",
    "high",
  );
  assert.deepEqual(messagesRewrite.body, { output_config: { effort: "high" } });

  // both locations set: they cannot disagree after a rewrite
  const both = rewriteRequestEffort(
    { output_config: { effort: "max" }, reasoning_effort: "max" },
    "/v1/messages",
    "high",
  );
  assert.deepEqual(both.body, { output_config: { effort: "high" }, reasoning_effort: "high" });

  // nothing to rewrite: identity
  const noop = { model: "m", messages: [] };
  assert.deepEqual(rewriteRequestEffort(noop, "/v1/messages", "high"), { body: noop, changed: false });
  assert.equal(extractRequestEffort(noop, "/v1/responses"), null);
});

test("protocols: effort routing/rewrite works for responses and anthropic-messages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-protocol-effort-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "protocol-effort-secret";

  const seen: Record<string, { requests: number; lastBody: Record<string, unknown> | null }> = {
    p1: { requests: 0, lastBody: null },
    p2: { requests: 0, lastBody: null },
  };
  const makeUpstream = (key: string) =>
    http.createServer((req, res) => {
      readBody(req).then((parsed) => {
        seen[key].requests += 1;
        seen[key].lastBody = parsed;
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
  const [port1, port2] = await Promise.all([listen(upstream1), listen(upstream2)]);

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

    // P1 natively speaks low/high; P2 publicly serves max (max → high).
    // Both declare all three dialects so these tests exercise same-protocol
    // passthrough rewriting (cross-protocol translation has its own suite).
    const ALL_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
    createProvider({
      name: "p1",
      base_url: `http://127.0.0.1:${port1}`,
      models: ["m-x"],
      model_efforts: { "m-x": { low: "low", high: "high" } },
      protocols: ALL_PROTOCOLS,
    });
    createProvider({
      name: "p2",
      base_url: `http://127.0.0.1:${port2}`,
      models: ["m-x"],
      model_efforts: { "m-x": { max: "high" } },
      protocols: ALL_PROTOCOLS,
    });

    const app = express();
    app.use(express.json());
    const mount = (route: string, proxyPath: string) =>
      app.post(route, async (req, res) => {
        await handleProxyHttp(
          {
            method: "POST",
            path: proxyPath,
            query: {},
            headers: { "content-type": "application/json" },
            body: req.body,
            apiKeyId: "test-key",
          },
          res,
        );
      });
    mount("/chat", "/v1/chat/completions");
    mount("/responses", "/v1/responses");
    mount("/messages", "/v1/messages");
    relay = http.createServer(app);
    const relayPort = await listen(relay);
    const send = (route: string, body: unknown) =>
      fetch(`http://127.0.0.1:${relayPort}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // responses: reasoning.effort=max → P1 skipped, P2 receives reasoning.effort=high
    const responsesResp = await send("/responses", {
      model: "m-x",
      input: "hi",
      reasoning: { effort: "max" },
    });
    assert.equal(responsesResp.status, 200);
    assert.equal(seen.p1.requests, 0);
    assert.equal(seen.p2.requests, 1);
    assert.deepEqual(seen.p2.lastBody?.reasoning, { effort: "high" });
    assert.equal(seen.p2.lastBody?.reasoning_effort, undefined);

    // messages: output_config.effort=max → P2 receives output_config.effort=high
    const messagesResp = await send("/messages", {
      model: "m-x",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    assert.equal(messagesResp.status, 200);
    assert.equal(seen.p1.requests, 0);
    assert.equal(seen.p2.requests, 2);
    assert.deepEqual(seen.p2.lastBody?.output_config, { effort: "high" });
    assert.equal(seen.p2.lastBody?.reasoning_effort, undefined);

    // messages with the flat alias: rewritten in place at the flat location
    const flatResp = await send("/messages", {
      model: "m-x",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
    });
    assert.equal(flatResp.status, 200);
    assert.equal(seen.p2.requests, 3);
    assert.equal(seen.p2.lastBody?.reasoning_effort, "high");
    assert.equal(seen.p2.lastBody?.output_config, undefined);

    // unsupported effort still 400s regardless of dialect
    const badResp = await send("/responses", {
      model: "m-x",
      input: "hi",
      reasoning: { effort: "medium" },
    });
    assert.equal(badResp.status, 400);
    const badBody = (await badResp.json()) as { error?: { code?: string } };
    assert.equal(badBody.error?.code, "effort_not_supported");
    assert.equal(seen.p2.requests, 3);

    // Router level: /v1/responses and /v1/messages are served, x-api-key
    // authenticates, and other /v1/* paths stay closed. Reuses this test's
    // db (the db handle is a module singleton that cannot reopen).
    const { createApiKey } = await import("../src/services/keys");
    const { proxyRouter } = await import("../src/routes/proxy");
    createProvider({ name: "p9", base_url: `http://127.0.0.1:${port2}`, models: ["m-y"] });
    const { key: secret } = createApiKey({ name: "proto-test" });
    const routerApp = express();
    routerApp.use(proxyRouter);
    const routerServer = http.createServer(routerApp);
    const routerPort = await listen(routerServer);
    try {
      const post = (route: string, headers: Record<string, string>, body: unknown) =>
        fetch(`http://127.0.0.1:${routerPort}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });

      // Anthropic-style auth: x-api-key instead of Authorization
      const viaXApiKey = await post("/v1/messages", { "x-api-key": secret }, {
        model: "m-y",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(viaXApiKey.status, 200);

      const viaBearer = await post("/v1/responses", { authorization: `Bearer ${secret}` }, {
        model: "m-y",
        input: "hi",
      });
      assert.equal(viaBearer.status, 200);

      const unauthenticated = await post("/v1/messages", {}, { model: "m-y", messages: [] });
      assert.equal(unauthenticated.status, 401);

      const embeddings = await post("/v1/embeddings", { authorization: `Bearer ${secret}` }, { input: "x" });
      assert.equal(embeddings.status, 404);
    } finally {
      await close(routerServer);
    }
  } finally {
    if (relay) await close(relay);
    await Promise.all([close(upstream1), close(upstream2)]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("protocols: responses-API output and usage extraction", async () => {
  const { extractFromResponse, createResponseLogCollector } = await import("../src/utils/content");

  // Non-streaming responses payload: output_text parts and input/output usage.
  const json = JSON.stringify({
    id: "resp-1",
    object: "response",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking hard" }] },
      { type: "message", content: [{ type: "output_text", text: "final answer" }] },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  });
  const extracted = extractFromResponse(json);
  assert.equal(extracted.output_text, "final answer");
  assert.equal(extracted.reasoning_text, "thinking hard");
  assert.equal(extracted.prompt_tokens, 11);
  assert.equal(extracted.completion_tokens, 7);
  assert.equal(extracted.cached_tokens, 5);
  assert.equal(extracted.reasoning_tokens, 3);
  assert.equal(extracted.total_tokens, 18);

  // Streaming: deltas plus the terminal response.completed event's usage.
  const collector = createResponseLogCollector({ stream: true, contentType: "text/event-stream" });
  collector.push(Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"hel"}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
  ));
  collector.push(Buffer.from(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}\n\n',
  ));
  const finished = collector.finish();
  assert.equal(finished.output_text, "hello");
  assert.equal(finished.prompt_tokens, 10);
  assert.equal(finished.completion_tokens, 4);
  assert.equal(finished.cached_tokens, 2);
  assert.equal(finished.reasoning_tokens, 1);
  assert.equal(finished.total_tokens, 14);
});
