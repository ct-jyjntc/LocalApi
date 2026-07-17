import assert from "node:assert/strict";
import test from "node:test";
import {
  createResponseLogCollector,
  extractFromResponse,
  extractInput,
} from "../src/utils/content";

test("request and non-stream response content are not truncated", () => {
  const input = "input-".repeat(5000);
  const output = "output-".repeat(5000);
  const reasoning = "reasoning-".repeat(5000);

  assert.equal(
    extractInput({ messages: [{ role: "user", content: input }] }, "/v1/chat/completions"),
    `user: ${input}`,
  );

  const extracted = extractFromResponse(
    JSON.stringify({
      choices: [{ message: { content: output, reasoning_content: reasoning } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  );
  assert.equal(extracted.output_text, output);
  assert.equal(extracted.reasoning_text, reasoning);
});

test("stream collector keeps content and reasoning beyond the former 64KiB limit", () => {
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
  assert.equal(extracted.output_text, outputA + outputB);
  assert.equal(extracted.reasoning_text, reasoning);
  assert.equal(extracted.prompt_tokens, 1234);
  assert.equal(extracted.completion_tokens, 5678);
  assert.equal(extracted.reasoning_tokens, 321);
  assert.equal(extracted.total_tokens, 6912);
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
  assert.equal(extracted.output_text, '[tool] search\n{"query":"hello"}');
  assert.equal(extracted.reasoning_text, "thinking");
  assert.equal(extracted.total_tokens, 181);
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
});
