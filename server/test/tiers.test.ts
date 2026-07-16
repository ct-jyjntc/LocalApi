import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("wallet tiers, Coding Plan limits, overage preference and password changes stay independent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-tiers-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "tiers-test-secret";
  const { db, initDb } = await import("../src/db");
  const { createUser, authenticateUser, changeUserPassword } = await import("../src/services/users");
  const { createApiKey } = await import("../src/services/keys");
  const { beginRequestAccess, AccessError, clearAccessState } = await import("../src/services/access");
  const { createPlan, assignPlan, setSubscriptionOverage } = await import("../src/services/plans");
  const { adjustWallet, reserveUsage, settleUsage, upsertModelPrice, BillingError } = await import("../src/services/billing");
  const { createUserTier, deleteUserTier, listUserTiers, resolveUserTier, TierError, updateUserTier } = await import("../src/services/tiers");

  try {
    initDb();
    const base = listUserTiers()[0];
    updateUserTier(base.id, { rpm_limit: 1, tpm_limit: 0, concurrency_limit: 0 });
    const plus = createUserTier({ name: "Plus", threshold_micros: 10_000_000, rpm_limit: 2, tpm_limit: 20_000, concurrency_limit: 2 });
    createUserTier({ name: "Pro", threshold_micros: 100_000_000, rpm_limit: 10, tpm_limit: 100_000, concurrency_limit: 10 });
    const user = createUser({ username: "tier-user", password: "password-123" });
    assert.equal(resolveUserTier(user.id).current?.id, base.id);
    db.prepare("UPDATE wallet_accounts SET lifetime_topup_micros = 15000000 WHERE user_id = ?").run(user.id);
    assert.equal(resolveUserTier(user.id).current?.id, plus.id);
    assert.equal(resolveUserTier(user.id).next_required_micros, 85_000_000);
    assert.throws(() => deleteUserTier(base.id), (error) => error instanceof TierError && error.code === "base_tier_required");

    updateUserTier(plus.id, { rpm_limit: 1 });
    const keyPublic = createApiKey({ name: "user-key", user_id: user.id, rate_limit: 999, allowed_models: ["blocked-model"] });
    const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyPublic.id) as import("../src/db").ApiKey;
    clearAccessState();
    const walletAccess = beginRequestAccess(key, "wallet-model", { model: "wallet-model", max_tokens: 1 }, { billingMode: "wallet" });
    walletAccess.release(1);
    assert.throws(
      () => beginRequestAccess(key, "wallet-model", { model: "wallet-model", max_tokens: 1 }, { billingMode: "wallet" }),
      (error) => error instanceof AccessError && error.code === "rpm_limit_exceeded",
    );

    const plan = createPlan({ name: "Independent Coding", included_credits_micros: 1_000_000, allowed_models: ["coding-model"], rpm_limit: 1, overage_enabled: true });
    const subscription = assignPlan(user.id, plan.id)!;
    const codingAccess = beginRequestAccess(key, "coding-model", { model: "coding-model", max_tokens: 1 }, { billingMode: "coding" });
    codingAccess.release(1);
    assert.throws(
      () => beginRequestAccess(key, "coding-model", { model: "coding-model", max_tokens: 1 }, { billingMode: "coding" }),
      (error) => error instanceof AccessError && error.code === "rpm_limit_exceeded",
    );
    assert.throws(
      () => beginRequestAccess(key, "wallet-model", { model: "wallet-model", max_tokens: 1 }, { billingMode: "coding" }),
      (error) => error instanceof AccessError && error.code === "model_not_allowed",
    );

    upsertModelPrice({ model: "coding-model", input_price_micros: 1_000_000, output_price_micros: 1_000_000 });
    db.prepare("UPDATE subscriptions SET remaining_credits_micros = 0 WHERE id = ?").run(subscription.id);
    setSubscriptionOverage(user.id, false);
    assert.throws(
      () => reserveUsage({ requestId: "tier-overage-off", userId: user.id, apiKeyId: key.id, model: "coding-model", body: { max_tokens: 1 }, billingMode: "coding" }),
      (error) => error instanceof BillingError && error.code === "plan_quota_exhausted",
    );
    adjustWallet(user.id, 1_000_000, "test wallet");
    assert.equal(setSubscriptionOverage(user.id, true)?.overage_enabled, 1);
    const reservation = reserveUsage({ requestId: "tier-overage-on", userId: user.id, apiKeyId: key.id, model: "coding-model", body: { max_tokens: 1 }, billingMode: "coding" });
    assert.ok(reservation.reservedWallet > 0);
    settleUsage(reservation, { statusCode: 200, promptTokens: 1, completionTokens: 1, totalTokens: 2 });

    assert.equal(changeUserPassword(user.id, "wrong-password", "new-password-123"), false);
    assert.equal(changeUserPassword(user.id, "password-123", "new-password-123"), true);
    assert.equal(authenticateUser("tier-user", "password-123"), null);
    assert.ok(authenticateUser("tier-user", "new-password-123"));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
