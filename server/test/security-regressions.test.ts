import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("security and billing regressions remain fixed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-security-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "security-test-secret";
  process.env.ADMIN_TOKEN = "security-admin-password";

  const { db, getSetting, initDb } = await import("../src/db");
  const { verifyAdminToken } = await import("../src/middleware/auth");
  const { createUser, deleteUser } = await import("../src/services/users");
  const { authenticateApiKey, createApiKey, updateApiKey } = await import("../src/services/keys");
  const {
    adjustWallet,
    estimateRequestTokens,
    getWallet,
    reserveUsage,
    settleUsage,
    upsertModelPrice,
    BillingError,
  } = await import("../src/services/billing");
  const {
    createProvider,
    listProvidersForModel,
    sanitizeProvider,
  } = await import("../src/services/providers");
  const {
    assignPlan,
    createPlan,
    getActiveSubscription,
    listPlans,
    maintainDueSubscriptions,
  } = await import("../src/services/plans");

  try {
    initDb();
    assert.match(getSetting("admin_token") || "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(verifyAdminToken("security-admin-password"), true);
    assert.equal(verifyAdminToken("security-admin-password-wrong"), false);

    const user = createUser({ username: "restricted-user", password: "password-123" });
    const publicKey = createApiKey({
      name: "restricted",
      user_id: user.id,
      rate_limit: 7,
      tpm_limit: 8,
      concurrency_limit: 9,
      allowed_models: ["only-this"],
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    const updated = updateApiKey(publicKey.id, { name: "renamed" }, user.id)!;
    assert.equal(updated.rate_limit, 7);
    assert.equal(updated.tpm_limit, 8);
    assert.equal(updated.concurrency_limit, 9);
    assert.deepEqual(updated.allowed_models, ["only-this"]);
    assert.equal(updated.expires_at, "2030-01-01T00:00:00.000Z");
    assert.equal(deleteUser(user.id), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE id = ?").get(publicKey.id).count, 0);
    assert.equal(authenticateApiKey(publicKey.key), null);

    const payer = createUser({ username: "payer", password: "password-123" });
    const payerKey = createApiKey({ name: "payer-key", user_id: payer.id });
    adjustWallet(payer.id, 10, "test balance");
    upsertModelPrice({ model: "priced", input_price_micros: 1_000_000, output_price_micros: 1_000_000 });
    assert.throws(
      () => reserveUsage({
        requestId: "underfunded",
        userId: payer.id,
        apiKeyId: payerKey.id,
        model: "priced",
        body: {},
        estimate: { prompt: 10, completion: 10 },
      }),
      (error) => error instanceof BillingError && error.code === "insufficient_balance",
    );
    const reservation = reserveUsage({
      requestId: "actual-overrun",
      userId: payer.id,
      apiKeyId: payerKey.id,
      model: "priced",
      body: {},
      estimate: { prompt: 1, completion: 1 },
    });
    settleUsage(reservation, { statusCode: 200, promptTokens: 100, completionTokens: 100, totalTokens: 200 });
    assert.equal(getWallet(payer.id)?.balance_micros, 0);
    assert.equal((db.prepare("SELECT status FROM users WHERE id = ?").get(payer.id) as { status: string }).status, "suspended");

    const body = { model: "priced", messages: [{ role: "user", content: "hello" }], max_tokens: 10 };
    assert.deepEqual(estimateRequestTokens(body, 1), estimateRequestTokens(body, 100_000));

    const provider = createProvider({
      name: "exact-only",
      base_url: "https://example.com",
      api_key: "upstream-secret",
      models: ["gpt-4o"],
    });
    assert.equal(listProvidersForModel("gpt-4").length, 0);
    assert.equal(listProvidersForModel("gpt-4o").length, 1);
    assert.equal(sanitizeProvider(provider).api_key, "");
    assert.deepEqual(sanitizeProvider(provider).api_keys, []);

    const subscriber = createUser({ username: "subscriber", password: "password-123" });
    const plan = createPlan({ name: "No side effects", cycle_days: 30 });
    const subscription = assignPlan(subscriber.id, plan.id, false)!;
    const due = new Date(Date.now() - 60_000).toISOString();
    db.prepare("UPDATE subscriptions SET period_end = ?, entitlement_end = ? WHERE id = ?")
      .run(due, due, subscription.id);
    listPlans(true);
    assert.ok(getActiveSubscription(subscriber.id));
    assert.equal(maintainDueSubscriptions(), 1);
    assert.equal(getActiveSubscription(subscriber.id), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
