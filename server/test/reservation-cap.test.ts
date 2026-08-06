import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * M6 regression: reserving the full client-supplied max_tokens (up to
 * 1,000,000) makes legit requests fail with 429 (TPM window) or 402
 * (wallet hold). Reservations must be capped; settlement still charges the
 * real token count.
 */
test("max_tokens reservations are capped, actual usage still settles", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-reservation-cap-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "reservation-cap-test-secret";

  const { db, initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { createApiKey } = await import("../src/services/keys");
  const { beginRequestAccess, clearAccessState } = await import("../src/services/access");
  const {
    RESERVATION_COMPLETION_CAP,
    adjustWallet,
    estimateRequestTokens,
    reserveUsage,
    settleUsage,
    upsertModelPrice,
  } = await import("../src/services/billing");
  const { createUserTier, resolveUserTier, updateUserTier } = await import("../src/services/tiers");

  try {
    initDb();

    // Unit: the completion reservation is capped regardless of the field used.
    assert.equal(estimateRequestTokens({ max_tokens: 1_000_000 }).completion, RESERVATION_COMPLETION_CAP);
    assert.equal(estimateRequestTokens({ max_completion_tokens: 999_999 }).completion, RESERVATION_COMPLETION_CAP);
    assert.equal(estimateRequestTokens({ maxOutputTokens: 10_000_000 }).completion, RESERVATION_COMPLETION_CAP);
    assert.equal(estimateRequestTokens({ max_tokens: 100 }).completion, 100, "small requests keep their reservation");
    assert.equal(estimateRequestTokens({}).completion, RESERVATION_COMPLETION_CAP);
    assert.equal(estimateRequestTokens({ max_tokens: 0 }).completion, 1);

    // Integration: wallet hold. output = 1 micro/token, wallet holds 5000
    // micros. max_tokens=1_000_000 previously required a 1,000,000-micro
    // hold -> 402 insufficient_balance. Now the capped hold fits.
    upsertModelPrice({ model: "wallet-model", input_price_micros: 100_000, output_price_micros: 1_000_000 });
    const user = createUser({ username: "cap-user", password: "password-123" });
    adjustWallet(user.id, 5_000, "cap test balance");
    const keyPublic = createApiKey({ name: "cap-key", user_id: user.id, rate_limit: 0 });
    const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyPublic.id) as import("../src/db").ApiKey;

    const reservation = reserveUsage({
      requestId: "cap-res-1",
      userId: user.id,
      apiKeyId: key.id,
      model: "wallet-model",
      body: { max_tokens: 1_000_000 },
    });
    assert.ok(reservation.reservedWallet > 0 && reservation.reservedWallet <= 5_000, "hold fits the small wallet");
    assert.equal(reservation.estimatedCompletion, RESERVATION_COMPLETION_CAP);

    // Settlement still charges the REAL tokens (10 completion tokens here).
    settleUsage(reservation, { statusCode: 200, promptTokens: 5, completionTokens: 10, totalTokens: 15 });
    const ledger = db.prepare(
      "SELECT amount_micros FROM wallet_ledger WHERE user_id = ? AND type = 'usage'",
    ).all(user.id) as Array<{ amount_micros: number }>;
    assert.equal(ledger.length, 1);
    assert.ok(ledger[0].amount_micros < 0 && ledger[0].amount_micros > -100, "real usage charged, not the capped hold");

    // Integration: TPM window. tier limit 20,000 TPM; a 1,000,000 max_tokens
    // request previously reserved ~1,000,006 tokens -> instant 429. Capped it
    // fits and the request is admitted.
    const plus = createUserTier({ name: "CapPlus", threshold_micros: 10_000_000, rpm_limit: 0, tpm_limit: 20_000, concurrency_limit: 0 });
    db.prepare("UPDATE wallet_accounts SET lifetime_topup_micros = 15_000_000 WHERE user_id = ?").run(user.id);
    assert.equal(resolveUserTier(user.id).current?.id, plus.id);
    updateUserTier(plus.id, { tpm_limit: 20_000 });
    clearAccessState();
    adjustWallet(user.id, 50_000, "more balance");
    const access = beginRequestAccess(
      key,
      "wallet-model",
      { model: "wallet-model", max_tokens: 1_000_000 },
      { billingMode: "wallet" },
    );
    access.release(15);
  } finally {
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
