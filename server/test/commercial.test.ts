import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("user wallet, price snapshot and usage settlement are atomic", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-commercial-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "commercial-test-secret";

  const { db, initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const {
    adjustWallet,
    calculateCostMicros,
    getWallet,
    reserveUsage,
    settleUsage,
    upsertModelPrice,
  } = await import("../src/services/billing");
  const { createApiKey } = await import("../src/services/keys");
  const { beginRequestAccess, AccessError } = await import("../src/services/access");

  try {
    initDb();
    const user = createUser({ username: "alice", password: "password-123" });
    const key = createApiKey({ name: "alice-key", user_id: user.id });
    adjustWallet(user.id, 10_000_000, "initial credit");
    const price = upsertModelPrice({
      model: "glm-test",
      input_price_micros: 1_000_000,
      output_price_micros: 2_000_000,
      cache_read_price_micros: 250_000,
    })!;

    assert.equal(
      calculateCostMicros(price, {
        prompt_tokens: 1000,
        cached_tokens: 200,
        completion_tokens: 500,
      }),
      1850,
    );

    const reservation = reserveUsage({
      requestId: "request-1",
      userId: user.id,
      apiKeyId: key.id,
      model: "glm-test",
      body: { model: "glm-test", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] },
    });
    assert.ok((getWallet(user.id)?.reserved_micros ?? 0) > 0);

    const settled = settleUsage(reservation, {
      statusCode: 200,
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 200,
      totalTokens: 1500,
    });
    assert.equal(settled.costMicros, 1850);
    assert.equal(getWallet(user.id)?.reserved_micros, 0);
    assert.equal(getWallet(user.id)?.balance_micros, 9_998_150);

    const usage = db.prepare("SELECT * FROM usage_records WHERE id = ?").get(settled.usageId) as {
      status: string;
      cost_micros: number;
    };
    assert.equal(usage.status, "completed");
    assert.equal(usage.cost_micros, 1850);

    const limitedPublicKey = createApiKey({
      name: "limited",
      user_id: user.id,
      allowed_models: ["glm-test"],
      tpm_limit: 1,
      concurrency_limit: 1,
    });
    const limitedKey = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(limitedPublicKey.id) as import("../src/db").ApiKey;
    assert.throws(
      () => beginRequestAccess(limitedKey, "glm-test", { model: "glm-test", messages: [{ role: "user", content: "hello" }] }),
      (error) => error instanceof AccessError && error.status === 429 && error.code === "tpm_limit_exceeded",
    );
    assert.throws(
      () => beginRequestAccess(limitedKey, "other-model", { model: "other-model" }),
      (error) => error instanceof AccessError && error.status === 403 && error.code === "model_not_allowed",
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
