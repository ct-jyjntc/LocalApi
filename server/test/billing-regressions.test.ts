import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("long in-flight requests are still billed after stale-reservation cleanup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-billing-regressions-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "billing-regression-secret";

  const { db, initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const {
    adjustWallet,
    cleanupStaleReservations,
    getWallet,
    reserveUsage,
    settleUsage,
    upsertModelPrice,
  } = await import("../src/services/billing");
  const { createApiKey } = await import("../src/services/keys");

  try {
    initDb();
    const user = createUser({ username: "slow-bob", password: "password-123" });
    const key = createApiKey({ name: "slow-bob-key", user_id: user.id });
    adjustWallet(user.id, 10_000_000, "initial credit");
    upsertModelPrice({
      model: "slow-model",
      input_price_micros: 1_000_000,
      output_price_micros: 2_000_000,
      cache_read_price_micros: 250_000,
    });

    const reservation = reserveUsage({
      requestId: "slow-request-1",
      userId: user.id,
      apiKeyId: key.id,
      model: "slow-model",
      body: { model: "slow-model", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] },
    });
    const balanceBefore = getWallet(user.id)!.balance_micros;
    assert.ok((getWallet(user.id)?.reserved_micros ?? 0) > 0);

    // Simulate the 30s maintenance timer cancelling the reservation while the
    // request is still in flight (request ran longer than the 2-minute window):
    // age the pending row past the cleanup threshold, then run the cleanup.
    db.prepare(
      "UPDATE usage_records SET created_at = datetime('now', '-3 minutes') WHERE id = ?",
    ).run(reservation.usageId);
    const cleaned = cleanupStaleReservations();
    assert.equal(cleaned, 1);
    const walletAfterCleanup = getWallet(user.id)!;
    assert.equal(walletAfterCleanup.reserved_micros, 0, "hold must be released by cleanup");
    assert.equal(walletAfterCleanup.balance_micros, balanceBefore, "cleanup must not spend balance");

    // The request completes successfully afterwards: it MUST be billed.
    const settled = settleUsage(reservation, {
      statusCode: 200,
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 200,
      totalTokens: 1300,
    });
    assert.equal(settled.costMicros, 1850, "cost must be charged for the completed request");
    assert.equal(
      getWallet(user.id)!.balance_micros,
      balanceBefore - 1850,
      "wallet must be debited despite the row being cancelled mid-flight",
    );
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});

test("aborted requests stay uncharged even after stale-reservation cleanup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-billing-regressions-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "billing-regression-secret";

  const { initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const {
    adjustWallet,
    cleanupStaleReservations,
    getWallet,
    reserveUsage,
    settleUsage,
    upsertModelPrice,
  } = await import("../src/services/billing");
  const { createApiKey } = await import("../src/services/keys");

  try {
    initDb();
    const user = createUser({ username: "aborted-carol", password: "password-123" });
    const key = createApiKey({ name: "aborted-carol-key", user_id: user.id });
    adjustWallet(user.id, 10_000_000, "initial credit");
    upsertModelPrice({
      model: "abort-model",
      input_price_micros: 1_000_000,
      output_price_micros: 2_000_000,
      cache_read_price_micros: 250_000,
    });

    const reservation = reserveUsage({
      requestId: "abort-request-1",
      userId: user.id,
      apiKeyId: key.id,
      model: "abort-model",
      body: { model: "abort-model", max_tokens: 1000, messages: [{ role: "user", content: "hi" }] },
    });
    cleanupStaleReservations(1_000);

    const balanceBefore = getWallet(user.id)!.balance_micros;
    // Client disconnected mid-flight: settle with the abort status code (499).
    const settled = settleUsage(reservation, { statusCode: 499, error: "Client disconnected" });
    assert.equal(settled.costMicros, 0, "aborted request must not be billed");
    assert.equal(getWallet(user.id)!.balance_micros, balanceBefore, "balance must be untouched");
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
