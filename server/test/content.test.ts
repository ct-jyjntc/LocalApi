import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createResponseLogCollector,
  extractFromResponse,
  extractInput,
  extractInputToDisk,
} from "../src/utils/content";
import { persistLogBodies, readLogBodies } from "../src/services/log-bodies";

test("request and non-stream response previews stay bounded", () => {
  const input = "input-".repeat(5000);
  const output = "output-".repeat(5000);
  const reasoning = "reasoning-".repeat(5000);

  const extractedInput = extractInput({ messages: [{ role: "user", content: input }] }, "/v1/chat/completions");
  assert.ok(extractedInput);
  assert.ok(extractedInput!.startsWith("user: input-"));
  assert.ok(extractedInput!.length <= 8_000);

  const extracted = extractFromResponse(
    JSON.stringify({
      choices: [{ message: { content: output, reasoning_content: reasoning } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  );
  assert.ok(extracted.output_text?.startsWith("output-"));
  assert.ok((extracted.output_text || "").length <= 8_000);
  assert.ok(extracted.reasoning_text?.startsWith("reasoning-"));
});

test("stream collector writes full body to disk and keeps a short preview", () => {
  const prev = process.env.LOCALAPI_DATA_DIR;
  process.env.LOCALAPI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-log-bodies-"));
  const outputA = "a".repeat(70_000);
  const outputB = "b".repeat(25_000);
  const reasoning = "r".repeat(30_000);
  const events = [
    { choices: [{ delta: { content: outputA } }] },
    { choices: [{ delta: { reasoning_content: reasoning } }] },
    { choices: [{ delta: { content: outputB } }] },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 5678,
        total_tokens: 6912,
        completion_tokens_details: { reasoning_tokens: 321 },
      },
    },
  ];
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const collector = createResponseLogCollector({
    stream: true,
    contentType: "text/event-stream",
  });
  const bytes = Buffer.from(payload);

  for (let offset = 0; offset < bytes.length; offset += 997) {
    collector.push(bytes.subarray(offset, offset + 997));
  }

  const extracted = collector.finish();
  assert.equal(extracted.output_text, "a".repeat(8_000));
  assert.equal(extracted.reasoning_text, "r".repeat(8_000));
  assert.equal(extracted.prompt_tokens, 1234);
  assert.equal(extracted.completion_tokens, 5678);
  assert.equal(extracted.reasoning_tokens, 321);
  assert.equal(extracted.total_tokens, 6912);
  assert.ok(extracted.output_file);
  assert.equal(fs.readFileSync(extracted.output_file!, "utf8"), outputA + outputB);
  assert.equal(fs.readFileSync(extracted.reasoning_file!, "utf8"), reasoning);
  persistLogBodies("log-test-1", { output: extracted.output_file, reasoning: extracted.reasoning_file });
  const stored = readLogBodies("log-test-1");
  assert.equal(stored?.output_text, outputA + outputB);
  assert.equal(stored?.reasoning_text, reasoning);
  if (prev === undefined) delete process.env.LOCALAPI_DATA_DIR;
  else process.env.LOCALAPI_DATA_DIR = prev;
});

test("stream collector captures OpenAI tool calls as output", () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "thinking" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "", arguments: "\"query\":\"hello\"}" } }] } }] },
    { choices: [], usage: { prompt_tokens: 155, completion_tokens: 26, total_tokens: 181 } },
  ];
  const collector = createResponseLogCollector({ stream: true, contentType: "text/event-stream" });
  collector.push(Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
  const extracted = collector.finish();
  assert.equal(extracted.output_text, '\n[tool] search\n{"query":"hello"}');
  assert.equal(extracted.reasoning_text, "thinking");
  assert.equal(extracted.total_tokens, 181);
  if (extracted.output_file) fs.unlinkSync(extracted.output_file);
  if (extracted.reasoning_file) fs.unlinkSync(extracted.reasoning_file);
});

test("stream collector captures Anthropic text, thinking and split usage", () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 6, cache_read_input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
    { type: "message_delta", usage: { input_tokens: 8, cache_read_input_tokens: 5, output_tokens: 25 } },
  ];
  const collector = createResponseLogCollector({ stream: true, contentType: "text/event-stream" });
  collector.push(Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
  const extracted = collector.finish();
  assert.equal(extracted.output_text, "hello");
  assert.equal(extracted.reasoning_text, "reason");
  assert.equal(extracted.prompt_tokens, 8);
  assert.equal(extracted.completion_tokens, 25);
  assert.equal(extracted.cached_tokens, 5);
  assert.equal(extracted.total_tokens, 33);
  if (extracted.output_file) fs.unlinkSync(extracted.output_file);
  if (extracted.reasoning_file) fs.unlinkSync(extracted.reasoning_file);
});

test("extractInputToDisk writes the full prompt off-heap", () => {
  const input = "prompt-".repeat(4000);
  const result = extractInputToDisk({ messages: [{ role: "user", content: input }] }, "/v1/chat/completions");
  assert.ok(result.preview && result.preview.length <= 8_000);
  assert.ok(result.file);
  assert.match(fs.readFileSync(result.file!, "utf8"), /user: prompt-/);
  fs.unlinkSync(result.file!);
});
