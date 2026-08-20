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

test("request translation: all six directions carry the essentials", async () => {
  const {
    fromAnthropicRequest,
    fromChatCompletionsRequest,
    fromResponsesRequest,
    toAnthropicRequest,
    toChatCompletionsRequest,
    toResponsesRequest,
  } = await import("../src/protocol/request");

  // anthropic → chat completions
  const anthropicBody = {
    model: "claude-x",
    max_tokens: 1024,
    system: "be terse",
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "sh" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
      },
    ],
    tools: [{ name: "weather", description: "get weather", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "weather" },
    stream: true,
  };
  const cc = toChatCompletionsRequest(fromAnthropicRequest(anthropicBody)!);
  assert.equal(cc.model, "claude-x");
  assert.equal(cc.max_tokens, 1024);
  assert.equal(cc.reasoning_effort, "high");
  assert.equal(cc.stream, true);
  const ccMessages = cc.messages as Array<Record<string, unknown>>;
  assert.equal(ccMessages[0].role, "system");
  assert.equal(ccMessages[0].content, "be terse");
  assert.equal(ccMessages[1].role, "user");
  const assistant = ccMessages[2];
  assert.equal(assistant.role, "assistant");
  const toolCalls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
  assert.equal(toolCalls[0].id, "toolu_1");
  assert.equal(toolCalls[0].function.name, "weather");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "sh" });
  const toolMsg = ccMessages[3];
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.equal(toolMsg.content, "sunny");
  const ccTools = cc.tools as Array<{ function: { name: string; parameters: unknown } }>;
  assert.equal(ccTools[0].function.name, "weather");
  assert.deepEqual(cc.tool_choice, { type: "function", function: { name: "weather" } });

  // chat completions → anthropic (round trip)
  const anthropic = toAnthropicRequest(fromChatCompletionsRequest(cc)!);
  assert.equal(anthropic.model, "claude-x");
  assert.equal(anthropic.max_tokens, 1024);
  assert.deepEqual(anthropic.output_config, { effort: "high" });
  assert.equal(anthropic.system, "be terse");
  const aMessages = anthropic.messages as Array<{ role: string; content: Array<{ type: string }> }>;
  assert.equal(aMessages[0].role, "user");
  const aAssistant = aMessages.find((m) => m.role === "assistant")!;
  const aToolUse = aAssistant.content.find((b) => b.type === "tool_use") as { id: string; name: string; input: unknown };
  assert.equal(aToolUse.id, "toolu_1");
  assert.deepEqual(aToolUse.input, { city: "sh" });
  const aToolResultMsg = aMessages.find(
    (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
  )!;
  assert.equal((aToolResultMsg.content[0] as { tool_use_id: string }).tool_use_id, "toolu_1");
  assert.deepEqual(anthropic.tool_choice, { type: "tool", name: "weather" });

  // responses → chat completions
  const responsesBody = {
    model: "gpt-x",
    instructions: "be terse",
    max_output_tokens: 512,
    reasoning: { effort: "low" },
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"sh"}' },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ],
    tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
  };
  const ccFromResponses = toChatCompletionsRequest(fromResponsesRequest(responsesBody)!);
  assert.equal(ccFromResponses.max_tokens, 512);
  assert.equal(ccFromResponses.reasoning_effort, "low");
  const rccMessages = ccFromResponses.messages as Array<Record<string, unknown>>;
  assert.equal(rccMessages[0].role, "system");
  assert.equal(rccMessages[1].role, "user");
  const rccAssistant = rccMessages[2];
  assert.equal(
    (rccAssistant.tool_calls as Array<{ id: string }>)[0].id,
    "call_1",
  );
  assert.equal(rccMessages[3].role, "tool");
  assert.equal(rccMessages[3].tool_call_id, "call_1");

  // chat completions → responses (round trip)
  const responses = toResponsesRequest(fromChatCompletionsRequest(ccFromResponses)!);
  assert.equal(responses.max_output_tokens, 512);
  assert.deepEqual(responses.reasoning, { effort: "low" });
  assert.equal(responses.instructions, "be terse");
  const rInput = responses.input as Array<Record<string, unknown>>;
  assert.equal(rInput[0].type, "message");
  const fc = rInput.find((i) => i.type === "function_call") as { call_id: string; name: string };
  assert.equal(fc.call_id, "call_1");
  const fco = rInput.find((i) => i.type === "function_call_output") as { call_id: string; output: string };
  assert.equal(fco.output, "sunny");

  // anthropic → responses and responses → anthropic (cross pair)
  const respFromAnthropic = toResponsesRequest(fromAnthropicRequest(anthropicBody)!);
  assert.deepEqual(respFromAnthropic.reasoning, { effort: "high" });
  assert.equal(respFromAnthropic.instructions, "be terse");
  const anthropicFromResponses = toAnthropicRequest(fromResponsesRequest(responsesBody)!);
  assert.deepEqual(anthropicFromResponses.output_config, { effort: "low" });
  assert.equal(anthropicFromResponses.system, "be terse");
  assert.equal(anthropicFromResponses.max_tokens, 512);
});

test("response translation: non-streaming JSON across dialects", async () => {
  const { translateResponseBody } = await import("../src/protocol");

  // anthropic → chat completions
  const anthropicJson = JSON.stringify({
    id: "msg_1",
    type: "message",
    model: "upstream-name",
    content: [
      { type: "thinking", thinking: "thinking..." },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "toolu_9", name: "weather", input: { city: "sh" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const asCc = JSON.parse(
    translateResponseBody("anthropic-messages", "openai-completions", anthropicJson, "public-model")!,
  );
  assert.equal(asCc.object, "chat.completion");
  assert.equal(asCc.model, "public-model");
  const msg = asCc.choices[0].message;
  assert.equal(msg.content, "answer");
  assert.equal(msg.reasoning_content, "thinking...");
  assert.equal(msg.tool_calls[0].id, "toolu_9");
  assert.equal(msg.tool_calls[0].function.name, "weather");
  assert.equal(asCc.choices[0].finish_reason, "tool_calls");
  assert.equal(asCc.usage.prompt_tokens, 10);
  assert.equal(asCc.usage.completion_tokens, 5);

  // chat completions → anthropic
  const asAnthropic = JSON.parse(
    translateResponseBody("openai-completions", "anthropic-messages", JSON.stringify(asCc), "public-model")!,
  );
  assert.equal(asAnthropic.type, "message");
  assert.equal(asAnthropic.stop_reason, "tool_use");
  const types = asAnthropic.content.map((b: { type: string }) => b.type);
  assert.deepEqual(types, ["thinking", "text", "tool_use"]);
  assert.equal(asAnthropic.usage.input_tokens, 10);

  // chat completions → responses
  const asResponses = JSON.parse(
    translateResponseBody("openai-completions", "openai-responses", JSON.stringify(asCc), "public-model")!,
  );
  assert.equal(asResponses.object, "response");
  assert.equal(asResponses.status, "completed");
  const outTypes = asResponses.output.map((i: { type: string }) => i.type);
  assert.deepEqual(outTypes, ["reasoning", "message", "function_call"]);
  assert.equal(asResponses.usage.input_tokens, 10);
  assert.equal(asResponses.usage.total_tokens, 15);

  // error envelope adapts to the client dialect
  const anthropicError = JSON.parse(
    translateResponseBody("openai-completions", "anthropic-messages", JSON.stringify({ error: { message: "boom", type: "rate_limit" } }), "m")!,
  );
  assert.equal(anthropicError.type, "error");
  assert.equal(anthropicError.error.message, "boom");

  // unparseable input passes through as null
  assert.equal(translateResponseBody("openai-completions", "anthropic-messages", "not json", "m"), null);
});

test("stream translation: anthropic SSE → completions chunks → responses events", async () => {
  const { createSseTranslator } = await import("../src/protocol");

  // anthropic source → completions client
  const anthropicSse = [
    { type: "message_start", message: { model: "upstream-x", usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think " } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hel" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "weather" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"sh"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const toCc = createSseTranslator("anthropic-messages", "openai-completions", "public-model");
  const ccLines: string[] = [];
  for (const frame of anthropicSse) {
    ccLines.push(...toCc.translateData(JSON.stringify(frame)));
  }
  ccLines.push(...toCc.end());
  const ccFrames = ccLines
    .join("\n")
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
  const texts = ccFrames
    .map((f) => f.choices?.[0]?.delta?.content)
    .filter(Boolean);
  assert.deepEqual(texts, ["hel", "lo"]);
  assert.ok(ccFrames.some((f) => f.choices?.[0]?.delta?.reasoning_content === "think "));
  const toolStart = ccFrames.find((f) => f.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "weather");
  assert.ok(toolStart);
  assert.equal(toolStart.choices[0].delta.tool_calls[0].id, "toolu_1");
  const args = ccFrames
    .map((f) => f.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
    .filter(Boolean);
  assert.deepEqual(args, ['{"city":', '"sh"}']);
  assert.ok(ccFrames.some((f) => f.choices?.[0]?.finish_reason === "tool_calls"));
  const usageFrame = ccFrames.find((f) => f.usage);
  assert.equal(usageFrame.usage.prompt_tokens, 12);
  assert.equal(usageFrame.usage.completion_tokens, 7);
  assert.ok(ccLines.includes("data: [DONE]"));

  // completions source → responses client
  const toResponses = createSseTranslator("openai-completions", "openai-responses", "public-model");
  const ccSource = [
    { choices: [{ index: 0, delta: { content: "hel" } }] },
    { choices: [{ index: 0, delta: { content: "lo" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  const respLines: string[] = [];
  for (const frame of ccSource) {
    respLines.push(...toResponses.translateData(JSON.stringify(frame)));
  }
  respLines.push(...toResponses.end());
  const respEvents = respLines
    .join("\n")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.replace(/^data: /, "")));
  assert.equal(respEvents[0].type, "response.created");
  assert.equal(respEvents[0].response.model, "public-model");
  const deltas = respEvents.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  assert.deepEqual(deltas, ["hel", "lo"]);
  const completed = respEvents.find((e) => e.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.response.status, "completed");
  assert.equal(completed.response.usage.input_tokens, 3);
  assert.equal(completed.response.usage.output_tokens, 2);
  const messageItem = completed.response.output.find((i: { type: string }) => i.type === "message");
  assert.equal(messageItem.content[0].text, "hello");

  // completions source → anthropic client
  const toAnthropic = createSseTranslator("openai-completions", "anthropic-messages", "public-model");
  const anthropicLines: string[] = [];
  for (const frame of ccSource) {
    anthropicLines.push(...toAnthropic.translateData(JSON.stringify(frame)));
  }
  anthropicLines.push(...toAnthropic.end());
  const anthropicEvents = anthropicLines
    .join("\n")
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(anthropicEvents[0].type, "message_start");
  assert.equal(anthropicEvents[0].message.model, "public-model");
  const textDeltas = anthropicEvents
    .filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta")
    .map((e) => e.delta.text);
  assert.deepEqual(textDeltas, ["hel", "lo"]);
  const messageDelta = anthropicEvents.find((e) => e.type === "message_delta");
  assert.equal(messageDelta.delta.stop_reason, "end_turn");
  assert.equal(messageDelta.usage.output_tokens, 2);
  assert.ok(anthropicEvents.some((e) => e.type === "message_stop"));
});

test("integration: anthropic client → completions-only channel, with effort mapping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-protocol-translate-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "protocol-translate-secret";

  const seen = { requests: 0, lastBody: null as Record<string, unknown> | null, lastPath: "" };
  // Upstream only speaks openai-completions.
  const upstream = http.createServer((req, res) => {
    readBody(req).then((parsed) => {
      seen.requests += 1;
      seen.lastBody = parsed;
      seen.lastPath = req.url ?? "";
      const body = JSON.stringify({
        id: "chatcmpl-up",
        object: "chat.completion",
        model: "upstream-glm",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "translated answer", reasoning_content: "upstream thought" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
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

    // Channel defaults to openai-completions only, with max → high effort mapping.
    createProvider({
      name: "cc-only",
      base_url: `http://127.0.0.1:${upstreamPort}`,
      models: ["glm-5.2"],
      model_efforts: { "glm-5.2": { max: "high" } },
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
        model: "glm-5.2",
        max_tokens: 256,
        system: "be terse",
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(resp.status, 200);

    // Upstream received a chat-completions-shaped request at the cc path,
    // with the effort mapped into the flat reasoning_effort field.
    assert.equal(seen.lastPath, "/v1/chat/completions");
    assert.equal(seen.lastBody?.model, "glm-5.2");
    assert.equal(seen.lastBody?.max_tokens, 256);
    assert.equal(seen.lastBody?.reasoning_effort, "high");
    assert.equal(seen.lastBody?.output_config, undefined);
    const upMessages = seen.lastBody?.messages as Array<Record<string, unknown>>;
    assert.equal(upMessages[0].role, "system");
    assert.equal(upMessages[0].content, "be terse");
    assert.equal(upMessages[1].role, "user");

    // Client received an anthropic-shaped response with the public model name.
    const json = (await resp.json()) as {
      type: string;
      model: string;
      content: Array<{ type: string; text?: string; thinking?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(json.type, "message");
    assert.equal(json.model, "glm-5.2");
    assert.deepEqual(
      json.content.map((b) => b.type),
      ["thinking", "text"],
    );
    assert.equal(json.content[0].thinking, "upstream thought");
    assert.equal(json.content[1].text, "translated answer");
    assert.equal(json.stop_reason, "end_turn");
    assert.equal(json.usage.input_tokens, 20);
    assert.equal(json.usage.output_tokens, 8);
  } finally {
    if (relay) await close(relay);
    await close(upstream);
    // db stays open: the streaming integration test below shares this
    // process's module-level db singleton (it cannot reopen after close).
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: streaming responses client → completions-only channel", async () => {
  // Shares the previous test's module-level db (already migrated). A fresh
  // provider name/model keeps routing unambiguous.

  // Upstream speaks completions SSE.
  const upstream = http.createServer((req, res) => {
    readBody(req).then(() => {
      const frames = [
        { id: "c1", object: "chat.completion.chunk", model: "upstream-glm", choices: [{ index: 0, delta: { role: "assistant", content: "str" } }] },
        { id: "c1", object: "chat.completion.chunk", model: "upstream-glm", choices: [{ index: 0, delta: { content: "eam" } }] },
        { id: "c1", object: "chat.completion.chunk", model: "upstream-glm", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "c1", object: "chat.completion.chunk", model: "upstream-glm", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ];
      const body = frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body);
    });
  });
  const upstreamPort = await listen(upstream);

  const { default: express } = await import("express");
  const { db, setSetting } = await import("../src/db");
  const { createProvider } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");
  const { resetProviderAffinityForTests } = await import("../src/services/provider-affinity");

  let relay: http.Server | null = null;
  try {
    resetProviderAffinityForTests();
    setSetting("max_retries", "0");
    setSetting("other_max_retries", "0");
    setSetting("retry_delay_ms", "0");
    createProvider({
      name: "cc-only-stream",
      base_url: `http://127.0.0.1:${upstreamPort}`,
      models: ["glm-5.3"],
    });

    const app = express();
    app.use(express.json());
    app.post("/responses", async (req, res) => {
      await handleProxyHttp(
        {
          method: "POST",
          path: "/v1/responses",
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

    const resp = await fetch(`http://127.0.0.1:${relayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-5.3", input: "hi", stream: true }),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await resp.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; delta?: string; response?: Record<string, unknown> });
    assert.equal(events[0].type, "response.created");
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
    assert.deepEqual(deltas, ["str", "eam"]);
    const completed = events.find((e) => e.type === "response.completed");
    assert.ok(completed);
    assert.equal(completed!.response!.model, "glm-5.3");
    const usage = completed!.response!.usage as { input_tokens: number; output_tokens: number };
    assert.equal(usage.input_tokens, 5);
    assert.equal(usage.output_tokens, 2);

    // Frame boundaries: every blank-line-separated block must be a
    // self-contained frame with exactly one parseable data payload —
    // strict SSE clients (Claude Code) fail hard when frames run together.
    const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim());
    assert.ok(blocks.length >= 3, "expected several SSE frames");
    for (const block of blocks) {
      const dataLines = block.split("\n").filter((l) => l.startsWith("data: "));
      assert.equal(dataLines.length, 1, `block must hold exactly one data line: ${block}`);
      JSON.parse(dataLines[0].slice(6));
    }
  } finally {
    if (relay) await close(relay);
    await close(upstream);
    db.close();
  }
});
