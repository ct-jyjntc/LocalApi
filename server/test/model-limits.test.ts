import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyModelLimits, ModelLimitError } from "../src/utils/model-limits";

test("model limits: clamp max output and reject oversized context", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-model-limits-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "model-limits-test-secret";

  const { initDb } = await import("../src/db");
  const { upsertModelPrice } = await import("../src/services/billing");

  try {
    initDb();
    upsertModelPrice({
      model: "capped-model",
      input_price_micros: 1,
      output_price_micros: 1,
      context_window: 100,
      max_output_tokens: 32,
    });

    const clamped = applyModelLimits(
      {
        model: "capped-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 999,
        max_completion_tokens: 500,
      },
      "/v1/chat/completions",
    );
    const record = clamped.body as Record<string, unknown>;
    assert.equal(record.max_tokens, 32);
    assert.equal(record.max_completion_tokens, 32);
    assert.ok(clamped.changes.includes("clamp:max_tokens"));

    assert.throws(
      () =>
        applyModelLimits(
          {
            model: "capped-model",
            messages: [{ role: "user", content: "x".repeat(800) }],
            max_tokens: 10,
          },
          "/v1/chat/completions",
        ),
      (error: unknown) => error instanceof ModelLimitError && error.code === "context_length_exceeded",
    );

    const unset = applyModelLimits(
      {
        model: "capped-model",
        messages: [{ role: "user", content: "hi" }],
      },
      "/v1/chat/completions",
    );
    assert.equal((unset.body as Record<string, unknown>).max_tokens, 32);

    // responses dialect: max_output_tokens is the output cap field, and an
    // injected default uses the dialect's own spelling (strict upstreams
    // reject unknown fields like max_tokens on /v1/responses).
    const responsesClamped = applyModelLimits(
      { model: "capped-model", input: "hi", max_output_tokens: 999 },
      "/v1/responses",
    );
    assert.equal((responsesClamped.body as Record<string, unknown>).max_output_tokens, 32);
    const responsesDefault = applyModelLimits(
      { model: "capped-model", input: "hi" },
      "/v1/responses",
    ).body as Record<string, unknown>;
    assert.equal(responsesDefault.max_output_tokens, 32);
    assert.equal(responsesDefault.max_tokens, undefined);

    const unlimited = applyModelLimits(
      {
        model: "unknown-model",
        messages: [{ role: "user", content: "x".repeat(800) }],
        max_tokens: 99999,
      },
      "/v1/chat/completions",
    );
    assert.equal((unlimited.body as Record<string, unknown>).max_tokens, 99999);
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
