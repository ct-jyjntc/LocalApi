import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenAICompatBody } from "../src/utils/openai-compat";

test("maps developer role to system (Pi reasoning path)", () => {
  const { body, changed, changes } = normalizeOpenAICompatBody(
    {
      model: "glm-5.2",
      messages: [
        { role: "developer", content: "You are a coding assistant." },
        { role: "user", content: "ping" },
      ],
      stream: true,
      reasoning_effort: "high",
    },
    "/v1/chat/completions",
  );
  assert.equal(changed, true);
  assert.ok(changes.includes("messages.role:developer→system"));
  const messages = (body as { messages: Array<{ role: string }> }).messages;
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.equal((body as { reasoning_effort: string }).reasoning_effort, "high");
});

test("normalizes boolean / string thinking values", () => {
  for (const [input, expected] of [
    [true, { type: "enabled" }],
    [false, { type: "disabled" }],
    ["enabled", { type: "enabled" }],
    ["disabled", { type: "disabled" }],
    [{ type: true }, { type: "enabled" }],
  ] as const) {
    const { body, changed } = normalizeOpenAICompatBody(
      { model: "glm-5.2", messages: [{ role: "user", content: "x" }], thinking: input },
      "/v1/chat/completions",
    );
    assert.equal(changed, true, `expected change for thinking=${JSON.stringify(input)}`);
    assert.deepEqual((body as { thinking: unknown }).thinking, expected);
  }

  // Already-correct object form is left alone (no false-positive change).
  const already = { type: "enabled", clear_thinking: false };
  const r = normalizeOpenAICompatBody(
    { model: "glm-5.2", messages: [{ role: "user", content: "x" }], thinking: already },
    "/v1/chat/completions",
  );
  assert.equal(r.changed, false);
  assert.deepEqual((r.body as { thinking: unknown }).thinking, already);
});

test("strips OpenAI-only store / prompt_cache knobs", () => {
  const { body, changes } = normalizeOpenAICompatBody(
    {
      model: "glm-5.2",
      messages: [{ role: "user", content: "x" }],
      store: false,
      prompt_cache_key: "abc",
      prompt_cache_retention: "24h",
      max_completion_tokens: 64,
    },
    "/v1/chat/completions",
  );
  const record = body as Record<string, unknown>;
  assert.equal("store" in record, false);
  assert.equal("prompt_cache_key" in record, false);
  assert.equal("prompt_cache_retention" in record, false);
  assert.equal(record.max_completion_tokens, 64);
  assert.ok(changes.includes("strip:store"));
});

test("leaves non-chat paths untouched", () => {
  const input = {
    model: "glm-5.2",
    messages: [{ role: "developer", content: "x" }],
    thinking: true,
  };
  const { body, changed } = normalizeOpenAICompatBody(input, "/v1/embeddings");
  assert.equal(changed, false);
  assert.equal(body, input);
});

test("idempotent when already normalized", () => {
  const input = {
    model: "glm-5.2",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  };
  const { changed, changes } = normalizeOpenAICompatBody(input, "/v1/chat/completions");
  assert.equal(changed, false);
  assert.deepEqual(changes, []);
});
