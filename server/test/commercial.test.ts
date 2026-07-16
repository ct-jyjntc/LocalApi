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
    const { createPlan, assignPlan, getActiveSubscription, listPlanOrders } = await import("../src/services/plans");
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

    upsertModelPrice({ model: "other-model", input_price_micros: 1_000_000, output_price_micros: 1_000_000 });
    const codingPlan = createPlan({
      name: "Coding Test Plan",
      included_credits_micros: 10_000_000,
      allowed_models: ["glm-test"],
      stock_limit: 1,
    });
    const assignedCoding = assignPlan(user.id, codingPlan.id);
    assert.ok(assignedCoding);
    const secondUser = createUser({ username: "bob", password: "password-123" });
    assert.throws(
      () => assignPlan(secondUser.id, codingPlan.id),
      /inventory is exhausted/,
    );

    const walletReservation = reserveUsage({
      requestId: "wallet-mode-request",
      userId: user.id,
      apiKeyId: key.id,
      model: "other-model",
      body: { model: "other-model", max_tokens: 1 },
      billingMode: "wallet",
    });
    assert.equal(walletReservation.subscriptionId, null);
    assert.equal(walletReservation.billingMode, "wallet");
    settleUsage(walletReservation, { statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2 });

    const codingReservation = reserveUsage({
      requestId: "coding-mode-request",
      userId: user.id,
      apiKeyId: key.id,
      model: "glm-test",
      body: { model: "glm-test", max_tokens: 1 },
      billingMode: "coding",
    });
    assert.equal(codingReservation.subscriptionId, assignedCoding!.id);
    assert.equal(codingReservation.billingMode, "coding");
    settleUsage(codingReservation, { statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    assert.throws(
      () => reserveUsage({
        requestId: "coding-disallowed-request",
        userId: user.id,
        apiKeyId: key.id,
        model: "other-model",
        body: { model: "other-model", max_tokens: 1 },
        billingMode: "coding",
      }),
      /not included in the active Coding Plan/,
    );

    const limitedPublicKey = createApiKey({
      name: "limited",
      user_id: user.id,
      allowed_models: ["glm-test"],
      tpm_limit: 1,
      concurrency_limit: 1,
    });
    const limitedKey = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(limitedPublicKey.id) as import("../src/db").ApiKey;
    const userKeyAccess = beginRequestAccess(limitedKey, "glm-test", { model: "glm-test", messages: [{ role: "user", content: "hello" }] });
    userKeyAccess.release(1);
    const unrestrictedModelAccess = beginRequestAccess(limitedKey, "other-model", { model: "other-model", max_tokens: 1 });
    unrestrictedModelAccess.release(1);

    const adminLimitedPublic = createApiKey({
      name: "admin-limited",
      allowed_models: ["glm-test"],
      tpm_limit: 1,
      concurrency_limit: 1,
    });
    const adminLimitedKey = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(adminLimitedPublic.id) as import("../src/db").ApiKey;
    assert.throws(
      () => beginRequestAccess(adminLimitedKey, "glm-test", { model: "glm-test", messages: [{ role: "user", content: "hello" }] }),
      (error) => error instanceof AccessError && error.status === 429 && error.code === "tpm_limit_exceeded",
    );
    assert.throws(
      () => beginRequestAccess(adminLimitedKey, "other-model", { model: "other-model" }),
      (error) => error instanceof AccessError && error.status === 403 && error.code === "model_not_allowed",
    );

    const renewable = createPlan({
      name: "Paid renewal plan",
      price_micros: 2_000_000,
      included_credits_micros: 5_000_000,
      cycle_days: 30,
    });
    const paidSubscription = assignPlan(user.id, renewable.id, true)!;
    const balanceBeforeRenewal = getWallet(user.id)!.balance_micros;
    const paidDue = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE subscriptions SET period_end = ?, entitlement_end = ?, reserved_micros = 0 WHERE id = ?")
      .run(paidDue, paidDue, paidSubscription.id);
    const renewed = getActiveSubscription(user.id);
    assert.ok(renewed);
    assert.ok(Date.parse(renewed!.period_end) > Date.now());
    assert.equal(getWallet(user.id)!.balance_micros, balanceBeforeRenewal - 2_000_000);
    const renewalLedger = db.prepare("SELECT amount_micros FROM wallet_ledger WHERE type = 'plan_renewal'").get() as {
      amount_micros: number;
    };
    assert.equal(renewalLedger.amount_micros, -2_000_000);
    assert.equal(listPlanOrders(user.id).some((order) => (order as { type: string }).type === "auto_renewal"), true);

    const insufficientPlan = createPlan({
      name: "Insufficient renewal plan",
      price_micros: 2_000_000,
      included_credits_micros: 5_000_000,
    });
    const unpaidSubscription = assignPlan(secondUser.id, insufficientPlan.id, true)!;
    const unpaidDue = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE subscriptions SET period_end = ?, entitlement_end = ?, reserved_micros = 0 WHERE id = ?")
      .run(unpaidDue, unpaidDue, unpaidSubscription.id);
    assert.equal(getActiveSubscription(secondUser.id), null);
    const expired = db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(unpaidSubscription.id) as {
      status: string;
    };
    assert.equal(expired.status, "expired");
    assert.equal(
      listPlanOrders(secondUser.id).some((order) => (order as { type: string; status: string }).type === "auto_renewal" && (order as { status: string }).status === "failed"),
      true,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
