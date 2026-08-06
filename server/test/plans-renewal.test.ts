import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const DAY = 86_400_000;

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function daysFromNow(days: number) {
  return Date.now() + days * DAY;
}

/**
 * M2/M3 regressions: user-initiated plan operations (purchase / renew /
 * upgrade) must never silently trigger the auto-renewal charge first
 * (double charge), and auto-renewal must never shorten prepaid entitlement.
 */
test("plan operations: no double charge, auto-renewal keeps prepaid entitlement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-plans-renewal-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "plans-renewal-test-secret";

  const { db, initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { adjustWallet, getWallet } = await import("../src/services/billing");
  const {
    PlanTransactionError,
    createPlan,
    getActiveSubscription,
    maintainActiveSubscription,
    maintainDueSubscriptions,
    purchasePlan,
    renewPlan,
    upgradePlan,
  } = await import("../src/services/plans");

  try {
    initDb();

    // 1. Purchase after an expired auto-renew subscription: exactly one charge.
    const buyer = createUser({ username: "double-charge-purchase", password: "password-123" });
    adjustWallet(buyer.id, 20_000_000, "test balance");
    const planA = createPlan({ name: "Plan A", price_micros: 5_000_000, included_credits_micros: 5_000_000 });
    const first = purchasePlan(buyer.id, planA.id);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(daysFromNow(-10)), first.subscription!.id);

    const second = purchasePlan(buyer.id, planA.id);
    assert.equal(second.subscription?.plan_id, planA.id);
    assert.equal(second.subscription?.status, "active");
    assert.equal(getWallet(buyer.id)?.balance_micros, 10_000_000, "two purchases charged, no auto-renewal");
    const renewals = db.prepare(
      "SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ? AND type = 'plan_renewal'",
    ).get(buyer.id) as { n: number };
    assert.equal(renewals.n, 0, "no auto-renewal charge may happen inside purchase");
    const oldRow = db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(first.subscription!.id) as {
      status: string;
    };
    assert.equal(oldRow.status, "expired");
    assert.notEqual(second.subscription!.id, first.subscription!.id);
    assert.ok(Math.abs(Date.parse(second.subscription!.starts_at) - Date.now()) < 60_000);

    // 2. Renew on an expired subscription: 404, zero charges.
    const renewer = createUser({ username: "double-charge-renew", password: "password-123" });
    adjustWallet(renewer.id, 20_000_000, "test balance");
    const planB = createPlan({ name: "Plan B", price_micros: 5_000_000, included_credits_micros: 5_000_000 });
    const boughtB = purchasePlan(renewer.id, planB.id);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(daysFromNow(-10)), boughtB.subscription!.id);
    const beforeRenew = getWallet(renewer.id)!.balance_micros;
    assert.throws(
      () => renewPlan(renewer.id),
      (error) => error instanceof PlanTransactionError && error.code === "active_subscription_not_found",
    );
    assert.equal(getWallet(renewer.id)?.balance_micros, beforeRenew, "no charge on a failed renew");
    const expiredRow = db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(boughtB.subscription!.id) as {
      status: string;
    };
    assert.equal(expiredRow.status, "expired");

    // 3. Renew with prepaid entitlement left: one charge, period stacks.
    const prepaid = createUser({ username: "prepaid-renew", password: "password-123" });
    adjustWallet(prepaid.id, 20_000_000, "test balance");
    const planC = createPlan({ name: "Plan C", price_micros: 5_000_000, included_credits_micros: 5_000_000 });
    const boughtC = purchasePlan(prepaid.id, planC.id);
    const prepaidEndMs = daysFromNow(20);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(prepaidEndMs), boughtC.subscription!.id);

    const renewed = renewPlan(prepaid.id);
    assert.equal(renewed.subscription?.id, boughtC.subscription!.id, "prepaid subscription is renewed in place");
    assert.equal(getWallet(prepaid.id)?.balance_micros, 10_000_000, "one charge: 5M purchase + 5M renew");
    const renewalsC = db.prepare(
      "SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ? AND type = 'plan_renewal'",
    ).get(prepaid.id) as { n: number };
    assert.equal(renewalsC.n, 1, "exactly one renewal charge");
    const expectedEnd = prepaidEndMs + 30 * DAY;
    const actualEnd = Date.parse(getActiveSubscription(prepaid.id)!.entitlement_end);
    assert.ok(Math.abs(actualEnd - expectedEnd) < 60_000, `entitlement stacks: got ${actualEnd}, want ~${expectedEnd}`);

    // 4. Upgrade on an expired subscription: 404, zero charges.
    const upgrader = createUser({ username: "double-charge-upgrade", password: "password-123" });
    adjustWallet(upgrader.id, 50_000_000, "test balance");
    const basic = createPlan({ name: "Basic", price_micros: 5_000_000, included_credits_micros: 5_000_000 });
    const pro = createPlan({ name: "Pro", price_micros: 10_000_000, included_credits_micros: 10_000_000 });
    const boughtU = purchasePlan(upgrader.id, basic.id);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(daysFromNow(-10)), boughtU.subscription!.id);
    const beforeUpgrade = getWallet(upgrader.id)!.balance_micros;
    assert.throws(
      () => upgradePlan(upgrader.id, pro.id),
      (error) => error instanceof PlanTransactionError && error.code === "active_subscription_not_found",
    );
    assert.equal(getWallet(upgrader.id)?.balance_micros, beforeUpgrade, "no charge on a failed upgrade");

    // 5. Maintenance path (no explicit user action): auto-renewal fires once.
    const autoUser = createUser({ username: "auto-renew", password: "password-123" });
    adjustWallet(autoUser.id, 20_000_000, "test balance");
    const planD = createPlan({ name: "Plan D", price_micros: 5_000_000, included_credits_micros: 5_000_000 });
    const boughtD = purchasePlan(autoUser.id, planD.id);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(daysFromNow(-10)), boughtD.subscription!.id);

    assert.equal(maintainDueSubscriptions(), 1);
    const activeD = maintainActiveSubscription(autoUser.id)!;
    assert.equal(activeD.status, "active");
    assert.equal(getWallet(autoUser.id)?.balance_micros, 10_000_000, "one auto-renewal charge");
    const expectedAutoEnd = daysFromNow(30);
    assert.ok(Math.abs(Date.parse(activeD.entitlement_end) - expectedAutoEnd) < 60_000);

    // 6. M2: entitlement_end reaching further than a fresh period (cycle
    //    changed / legacy data) must never be shortened. Period is over but
    //    20 prepaid days remain: maintenance advances the period for free and
    //    keeps entitlement_end untouched (no charge, no truncation).
    const prepaidEnd2Ms = daysFromNow(20);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, auto_renew = 1 WHERE id = ?",
    ).run(iso(daysFromNow(-40)), iso(daysFromNow(-10)), iso(prepaidEnd2Ms), activeD.id);
    const walletBeforeAdvance = getWallet(autoUser.id)!.balance_micros;
    const advanced = maintainActiveSubscription(autoUser.id)!;
    assert.equal(Date.parse(advanced.entitlement_end), prepaidEnd2Ms, "prepaid entitlement is never shortened");
    assert.equal(getWallet(autoUser.id)?.balance_micros, walletBeforeAdvance, "advancing over prepaid days is free");
    assert.equal(Date.parse(advanced.period_end), prepaidEnd2Ms, "period is advanced onto the prepaid entitlement");
  } finally {
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
