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
