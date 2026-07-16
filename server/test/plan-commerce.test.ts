import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("plan purchase, prorated upgrade and renewal are atomic and idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-plan-commerce-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "plan-commerce-test-secret";

  const { db, initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { adjustWallet, getWallet } = await import("../src/services/billing");
  const {
    PlanTransactionError,
    createPlan,
    getActiveSubscription,
    listPlans,
    listPlanOrders,
    purchasePlan,
    reorderPlans,
    renewPlan,
    upgradePlan,
  } = await import("../src/services/plans");
  const { listCommerceOrders } = await import("../src/services/commerce");

  try {
    initDb();
    const user = createUser({ username: "buyer", password: "password-123" });
    adjustWallet(user.id, 100_000_000, "commerce test balance");
    const basic = createPlan({
      name: "Basic Commerce",
      price_micros: 10_000_000,
      included_credits_micros: 15_000_000,
      stock_limit: 1,
    });
    const pro = createPlan({
      name: "Pro Commerce",
      price_micros: 20_000_000,
      included_credits_micros: 35_000_000,
      stock_limit: 1,
    });
    assert.deepEqual(listPlans().map((plan) => plan.id), [basic.id, pro.id]);
    reorderPlans([pro.id, basic.id]);
    assert.deepEqual(listPlans().map((plan) => plan.id), [pro.id, basic.id]);

    const purchaseRequest = "11111111-1111-4111-8111-111111111111";
    const purchased = purchasePlan(user.id, basic.id, purchaseRequest);
    assert.equal(purchased.subscription?.plan_id, basic.id);
    assert.equal(purchased.subscription?.price_micros_snapshot, 10_000_000);
    assert.equal(getWallet(user.id)?.balance_micros, 90_000_000);
    const duplicatePurchase = purchasePlan(user.id, basic.id, purchaseRequest);
    assert.equal(duplicatePurchase.order?.id, purchased.order?.id);
    assert.equal(getWallet(user.id)?.balance_micros, 90_000_000);

    const now = Date.now();
    const simulatedEnd = new Date(now + 15 * 86_400_000).toISOString();
    db.prepare("UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ? WHERE id = ?")
      .run(new Date(now - 15 * 86_400_000).toISOString(), simulatedEnd, simulatedEnd, purchased.subscription!.id);
    const beforeUpgrade = getWallet(user.id)!.balance_micros;
    const upgradeRequest = "22222222-2222-4222-8222-222222222222";
    const upgraded = upgradePlan(user.id, pro.id, upgradeRequest);
    assert.equal(upgraded.subscription?.plan_id, pro.id);
    assert.equal(upgraded.subscription?.price_micros_snapshot, 20_000_000);
    const upgradeCharge = beforeUpgrade - getWallet(user.id)!.balance_micros;
    assert.ok(upgradeCharge >= 14_999_000 && upgradeCharge <= 15_001_000);
    const duplicateUpgrade = upgradePlan(user.id, pro.id, upgradeRequest);
    assert.equal(duplicateUpgrade.order?.id, upgraded.order?.id);
    assert.equal(getWallet(user.id)!.balance_micros, beforeUpgrade - upgradeCharge);

    const beforeRenewal = getWallet(user.id)!.balance_micros;
    db.prepare("UPDATE subscriptions SET remaining_credits_micros = ? WHERE id = ?")
      .run(12_345_678, upgraded.subscription!.id);
    const beforeRenewalSubscription = getActiveSubscription(user.id)!;
    const renewalRequest = "33333333-3333-4333-8333-333333333333";
    const renewed = renewPlan(user.id, renewalRequest);
    assert.equal(renewed.subscription?.plan_id, pro.id);
    assert.equal(renewed.subscription?.remaining_credits_micros, 12_345_678);
    assert.equal(renewed.subscription?.period_start, beforeRenewalSubscription.period_start);
    assert.equal(renewed.subscription?.period_end, beforeRenewalSubscription.period_end);
    assert.ok(Math.abs(Date.parse(renewed.subscription!.entitlement_end) - Date.parse(beforeRenewalSubscription.entitlement_end) - 30 * 86_400_000) < 1_000);
    assert.equal(getWallet(user.id)?.balance_micros, beforeRenewal - 20_000_000);
    assert.equal(listPlanOrders(user.id).length, 3);

    const beforeSecondRenewalEnd = renewed.subscription!.entitlement_end;
    renewPlan(user.id, "55555555-5555-4555-8555-555555555555");
    const afterSecondRenewal = getActiveSubscription(user.id)!;
    assert.ok(Math.abs(Date.parse(afterSecondRenewal.entitlement_end) - Date.parse(beforeSecondRenewalEnd) - 30 * 86_400_000) < 1_000);
    assert.equal(afterSecondRenewal.remaining_credits_micros, 12_345_678);

    const dueAt = new Date(Date.now() - 60_000);
    const paidThrough = new Date(dueAt.getTime() + 60 * 86_400_000);
    db.prepare(
      "UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?, remaining_credits_micros = ?, reserved_micros = 0 WHERE id = ?",
    ).run(
      new Date(dueAt.getTime() - 30 * 86_400_000).toISOString(),
      dueAt.toISOString(),
      paidThrough.toISOString(),
      1_000_000,
      upgraded.subscription!.id,
    );
    const beforePaidRolloverBalance = getWallet(user.id)!.balance_micros;
    const rolled = getActiveSubscription(user.id)!;
    assert.ok(Date.parse(rolled.period_end) > Date.now());
    assert.equal(rolled.remaining_credits_micros, 35_000_000);
    assert.equal(getWallet(user.id)!.balance_micros, beforePaidRolloverBalance);
    assert.equal(listPlanOrders(user.id).filter((order) => order.type === "auto_renewal").length, 0);
    const commerceOrders = listCommerceOrders(user.id, 20);
    assert.equal(commerceOrders.some((order) => order.kind === "plan_purchase"), true);
    assert.equal(commerceOrders.filter((order) => order.kind === "plan_renewal").length, 2);

    const poorUser = createUser({ username: "poor-buyer", password: "password-123" });
    assert.throws(
      () => purchasePlan(poorUser.id, basic.id, "44444444-4444-4444-8444-444444444444"),
      (error) => error instanceof PlanTransactionError && error.code === "insufficient_balance",
    );
    assert.equal(listPlanOrders(poorUser.id).length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
