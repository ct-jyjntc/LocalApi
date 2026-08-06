import { v4 as uuid } from "uuid";
import { db, Plan, PlanOrder, Subscription } from "../db";
import { nowIso } from "../utils/time";
import {
  cleanupStaleReservations,
  releaseUserPendingReservations,
  spendWalletMicros,
} from "./billing";

export class PlanTransactionError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseModels(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function publicPlan(row: Plan) {
  return {
    ...row,
    allowed_models: parseModels(row.allowed_models),
    enabled: row.enabled === 1,
    overage_enabled: row.overage_enabled === 1,
    stock_available: row.stock_limit > 0 ? Math.max(0, row.stock_limit - row.stock_used) : null,
  };
}

export function maintainDueSubscriptions() {
  const rows = db.prepare(
    `SELECT DISTINCT user_id FROM subscriptions
     WHERE status = 'active' AND reserved_micros = 0 AND period_end <= ?`,
  ).all(nowIso()) as Array<{ user_id: string }>;
  for (const row of rows) maintainActiveSubscription(row.user_id);
  return rows.length;
}

export function listPlans(enabledOnly = false) {
  const rows = db
    .prepare(`SELECT * FROM plans ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY sort_order ASC, created_at DESC`)
    .all() as Plan[];
  return rows.map(publicPlan);
}

export function reorderPlans(ids: string[]) {
  const existing = db.prepare("SELECT id FROM plans ORDER BY sort_order ASC, created_at DESC").all() as Array<{ id: string }>;
  if (ids.length !== existing.length || new Set(ids).size !== ids.length) {
    throw new PlanTransactionError(400, "invalid_plan_order", "Plan order must include every plan exactly once");
  }
  const known = new Set(existing.map((row) => row.id));
  if (ids.some((id) => !known.has(id))) {
    throw new PlanTransactionError(400, "invalid_plan_order", "Plan order contains an unknown plan");
  }
  const now = nowIso();
  const update = db.prepare("UPDATE plans SET sort_order = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => ids.forEach((id, index) => update.run(index, now, id)))();
  return listPlans();
}

export function getPlan(id: string): Plan | null {
  return (db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Plan | undefined) ?? null;
}

export function createPlan(input: {
  name: string;
  description?: string;
  cycle_days?: number;
  price_micros?: number;
  included_credits_micros?: number;
  allowed_models?: string[];
  rpm_limit?: number;
  tpm_limit?: number;
  concurrency_limit?: number;
  overage_enabled?: boolean;
  stock_limit?: number;
  enabled?: boolean;
}) {
  const id = uuid();
  const now = nowIso();
  const nextOrder = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM plans").get() as { value: number }).value;
  db.prepare(
    `INSERT INTO plans (
      id, name, description, cycle_days, price_micros, included_credits_micros, allowed_models,
      rpm_limit, tpm_limit, concurrency_limit, overage_enabled, stock_limit, stock_used, sort_order,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.description?.trim() || "",
    input.cycle_days ?? 30,
    input.price_micros ?? 0,
    input.included_credits_micros ?? 0,
    JSON.stringify(input.allowed_models ?? []),
    input.rpm_limit ?? 0,
    input.tpm_limit ?? 0,
    input.concurrency_limit ?? 0,
    input.overage_enabled === false ? 0 : 1,
    Math.max(0, Math.floor(input.stock_limit ?? 0)),
    nextOrder,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return publicPlan(getPlan(id)!);
}

export function updatePlan(id: string, input: Partial<{
  name: string;
  description: string;
  cycle_days: number;
  price_micros: number;
  included_credits_micros: number;
  allowed_models: string[];
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  overage_enabled: boolean;
  stock_limit: number;
  enabled: boolean;
}>) {
  const plan = getPlan(id);
  if (!plan) return null;
  db.prepare(
    `UPDATE plans SET name = ?, description = ?, cycle_days = ?, price_micros = ?, included_credits_micros = ?,
      allowed_models = ?, rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?,
      overage_enabled = ?, stock_limit = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.name?.trim() || plan.name,
    input.description?.trim() ?? plan.description,
    input.cycle_days ?? plan.cycle_days,
    input.price_micros ?? plan.price_micros,
    input.included_credits_micros ?? plan.included_credits_micros,
    input.allowed_models ? JSON.stringify(input.allowed_models) : plan.allowed_models,
    input.rpm_limit ?? plan.rpm_limit,
    input.tpm_limit ?? plan.tpm_limit,
    input.concurrency_limit ?? plan.concurrency_limit,
    input.overage_enabled !== undefined ? (input.overage_enabled ? 1 : 0) : plan.overage_enabled,
    input.stock_limit !== undefined ? Math.max(0, Math.floor(input.stock_limit)) : plan.stock_limit,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : plan.enabled,
    nowIso(),
    id,
  );
  return publicPlan(getPlan(id)!);
}

export function deletePlan(id: string) {
  const used = db.prepare("SELECT 1 FROM subscriptions WHERE plan_id = ? LIMIT 1").get(id);
  if (used) {
    db.prepare("UPDATE plans SET enabled = 0, updated_at = ? WHERE id = ?").run(nowIso(), id);
    return true;
  }
  return db.prepare("DELETE FROM plans WHERE id = ?").run(id).changes > 0;
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

function newPlanOrderNo() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `PO${stamp}${uuid().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

function getPlanOrder(id: string) {
  return db.prepare(
    `SELECT plan_orders.*, plans.name AS plan_name, previous.name AS previous_plan_name
     FROM plan_orders
     JOIN plans ON plans.id = plan_orders.plan_id
     LEFT JOIN plans previous ON previous.id = plan_orders.previous_plan_id
     WHERE plan_orders.id = ?`,
  ).get(id) as (PlanOrder & { plan_name: string; previous_plan_name: string | null }) | undefined;
}

export function listPlanOrders(userId: string, limit = 100) {
  return db.prepare(
    `SELECT plan_orders.*, plans.name AS plan_name, previous.name AS previous_plan_name
     FROM plan_orders
     JOIN plans ON plans.id = plan_orders.plan_id
     LEFT JOIN plans previous ON previous.id = plan_orders.previous_plan_id
     WHERE plan_orders.user_id = ?
     ORDER BY plan_orders.created_at DESC, plan_orders.id DESC LIMIT ?`,
  ).all(userId, Math.min(Math.max(1, limit), 500)) as Array<PlanOrder & {
    plan_name: string;
    previous_plan_name: string | null;
  }>;
}

function existingPlanTransaction(userId: string, requestId: string) {
  // L10: idempotency_key is globally UNIQUE. Look up by key alone first so a
  // cross-user collision returns the owner's order (or a clear 409) instead
  // of a raw SQLITE_CONSTRAINT 500 when the INSERT races the UNIQUE index.
  const anyOwner = db.prepare(
    "SELECT id, user_id FROM plan_orders WHERE idempotency_key = ?",
  ).get(requestId) as { id: string; user_id: string } | undefined;
  if (!anyOwner) return null;
  if (anyOwner.user_id !== userId) {
    throw new PlanTransactionError(
      409,
      "idempotency_key_conflict",
      "Idempotency key is already in use",
    );
  }
  return {
    order: getPlanOrder(anyOwner.id),
    subscription: getActiveSubscription(userId),
  };
}

function walletForUpdate(userId: string) {
  const wallet = db.prepare(
    "SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?",
  ).get(userId) as { balance_micros: number; reserved_micros: number } | undefined;
  if (!wallet) throw new PlanTransactionError(402, "wallet_missing", "User wallet is unavailable");
  return wallet;
}

function debitWallet(input: {
  userId: string;
  amountMicros: number;
  orderId: string;
  type: string;
  description: string;
  now: string;
}) {
  const wallet = walletForUpdate(input.userId);
  if (wallet.balance_micros - wallet.reserved_micros < input.amountMicros) {
    throw new PlanTransactionError(402, "insufficient_balance", "Insufficient wallet balance");
  }
  if (input.amountMicros > 0) {
    // Spend hidden check-in credits first so using balance frees the points hold cap.
    try {
      spendWalletMicros(input.userId, input.amountMicros, input.now);
    } catch {
      throw new PlanTransactionError(402, "insufficient_balance", "Insufficient wallet balance");
    }
  }
  const balance = (db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(input.userId) as {
    balance_micros: number;
  }).balance_micros;
  if (input.amountMicros > 0) {
    db.prepare(
      `INSERT INTO wallet_ledger (
        id, user_id, type, amount_micros, balance_after_micros,
        reference_type, reference_id, description, created_at
      ) VALUES (?, ?, ?, ?, ?, 'plan_order', ?, ?, ?)`,
    ).run(uuid(), input.userId, input.type, -input.amountMicros, balance, input.orderId, input.description, input.now);
  }
  return balance;
}

function creditWallet(input: {
  userId: string;
  amountMicros: number;
  orderId: string;
  type: string;
  description: string;
  now: string;
}) {
  if (input.amountMicros <= 0) {
    return (db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(input.userId) as {
      balance_micros: number;
    }).balance_micros;
  }
  db.prepare("UPDATE wallet_accounts SET balance_micros = balance_micros + ?, updated_at = ? WHERE user_id = ?")
    .run(input.amountMicros, input.now, input.userId);
  const balance = (db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(input.userId) as {
    balance_micros: number;
  }).balance_micros;
  db.prepare(
    `INSERT INTO wallet_ledger (
      id, user_id, type, amount_micros, balance_after_micros,
      reference_type, reference_id, description, created_at
    ) VALUES (?, ?, ?, ?, ?, 'plan_order_credit', ?, ?, ?)`,
  ).run(uuid(), input.userId, input.type, input.amountMicros, balance, input.orderId, input.description, input.now);
  return balance;
}

function requireAvailablePlan(planId: string) {
  const plan = getPlan(planId);
  if (!plan || plan.enabled !== 1) {
    throw new PlanTransactionError(404, "plan_not_found", "Plan not found or disabled");
  }
  if (plan.stock_limit > 0 && plan.stock_used >= plan.stock_limit) {
    throw new PlanTransactionError(409, "plan_inventory_exhausted", "Plan inventory is exhausted");
  }
  return plan;
}

function insertPlanOrder(input: {
  id: string;
  requestId: string;
  userId: string;
  planId: string;
  previousPlanId?: string | null;
  subscriptionId: string;
  type: "purchase" | "upgrade" | "renewal";
  listPriceMicros: number;
  creditMicros?: number;
  amountMicros: number;
  balanceAfterMicros: number;
  description: string;
  metadata?: Record<string, unknown>;
  now: string;
}) {
  db.prepare(
    `INSERT INTO plan_orders (
      id, order_no, idempotency_key, user_id, plan_id, previous_plan_id,
      subscription_id, type, status, list_price_micros, credit_micros,
      amount_micros, balance_after_micros, description, metadata, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    newPlanOrderNo(),
    input.requestId,
    input.userId,
    input.planId,
    input.previousPlanId ?? null,
    input.subscriptionId,
    input.type,
    input.listPriceMicros,
    input.creditMicros ?? 0,
    input.amountMicros,
    input.balanceAfterMicros,
    input.description,
    JSON.stringify(input.metadata ?? {}),
    input.now,
    input.now,
  );
}

function finishPlanTransaction(userId: string, orderId: string) {
  return {
    order: getPlanOrder(orderId),
    subscription: getActiveSubscription(userId),
  };
}

export type ActiveSubscription = Subscription & {
  plan: ReturnType<typeof publicPlan>;
};

function expireSubscription(row: Subscription) {
  const now = nowIso();
  db.transaction(() => {
    const changed = db.prepare(
      "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(now, row.id).changes;
    if (changed > 0) {
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, row.plan_id);
    }
  })();
}

function advancePaidPeriods(row: Subscription, plan: Plan) {
  const nowMs = Date.now();
  const entitlementEndMs = Date.parse(row.entitlement_end);
  let periodStartMs = Date.parse(row.period_start);
  let periodEndMs = Date.parse(row.period_end);
  let advanced = false;

  while (periodEndMs <= nowMs) {
    const nextEndMs = addDays(new Date(periodEndMs), plan.cycle_days).getTime();
    if (nextEndMs > entitlementEndMs) break;
    periodStartMs = periodEndMs;
    periodEndMs = nextEndMs;
    advanced = true;
  }

  // Defensive compatibility for any legacy fractional entitlement period.
  if (!advanced && periodEndMs <= nowMs && entitlementEndMs > nowMs) {
    periodStartMs = periodEndMs;
    periodEndMs = entitlementEndMs;
    advanced = true;
  }

  if (!advanced) return row;
  db.prepare(
    `UPDATE subscriptions SET period_start = ?, period_end = ?,
      remaining_credits_micros = ?, reserved_micros = 0, updated_at = ? WHERE id = ?`,
  ).run(
    new Date(periodStartMs).toISOString(),
    new Date(periodEndMs).toISOString(),
    plan.included_credits_micros,
    nowIso(),
    row.id,
  );
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(row.id) as Subscription;
}

function autoRenewSubscription(row: Subscription, plan: Plan) {
  const dueAt = row.entitlement_end;
  return db.transaction(() => {
    const now = nowIso();
    const jobId = uuid();
    db.prepare(
      `INSERT OR IGNORE INTO renewal_jobs (
        id, subscription_id, user_id, due_at, status, payment_source, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 'wallet', 0, ?, ?)`,
    ).run(jobId, row.id, row.user_id, dueAt, now, now);
    const job = db.prepare("SELECT id FROM renewal_jobs WHERE subscription_id = ? AND due_at = ?")
      .get(row.id, dueAt) as { id: string };
    const wallet = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(row.user_id) as { balance_micros: number; reserved_micros: number } | undefined;
    const orderId = uuid();
    const requestId = `auto:${row.id}:${dueAt}`;
    const start = new Date();
    const end = addDays(start, plan.cycle_days);
    // Never shorten prepaid entitlement: if the stored entitlement_end still
    // reaches further than a fresh period from now (cycle changed, legacy
    // data, delayed maintenance), keep the longer end so the user is not
    // charged a full period while losing remaining prepaid days.
    const entitlementEnd = new Date(Math.max(Date.parse(row.entitlement_end) || 0, end.getTime()));

    if (!wallet || wallet.balance_micros - wallet.reserved_micros < plan.price_micros) {
      db.prepare(
        `INSERT OR IGNORE INTO plan_orders (
          id, order_no, idempotency_key, user_id, plan_id, subscription_id,
          type, status, list_price_micros, credit_micros, amount_micros,
          balance_after_micros, description, metadata, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'auto_renewal', 'failed', ?, 0, ?, ?, ?, ?, ?, ?)`,
      ).run(
        orderId,
        newPlanOrderNo(),
        requestId,
        row.user_id,
        plan.id,
        row.id,
        plan.price_micros,
        plan.price_micros,
        wallet?.balance_micros ?? 0,
        `${plan.name} 自动续费失败：余额不足`,
        JSON.stringify({ entitlement_from: start.toISOString(), entitlement_to: entitlementEnd.toISOString() }),
        now,
        now,
      );
      db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, row.plan_id);
      db.prepare(
        `UPDATE renewal_jobs SET status = 'failed', attempts = attempts + 1,
          last_error = 'Insufficient wallet balance', updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(now, now, job.id);
      return false;
    }

    if (plan.price_micros > 0) {
      spendWalletMicros(row.user_id, plan.price_micros, now);
    }
    const updatedWallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?")
      .get(row.user_id) as { balance_micros: number };
    db.prepare(
      `INSERT INTO plan_orders (
        id, order_no, idempotency_key, user_id, plan_id, subscription_id,
        type, status, list_price_micros, credit_micros, amount_micros,
        balance_after_micros, description, metadata, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'auto_renewal', 'completed', ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orderId,
      newPlanOrderNo(),
      requestId,
      row.user_id,
      plan.id,
      row.id,
      plan.price_micros,
      plan.price_micros,
      updatedWallet.balance_micros,
      `${plan.name} 自动续费`,
      JSON.stringify({ entitlement_from: start.toISOString(), entitlement_to: entitlementEnd.toISOString() }),
      now,
      now,
    );
    if (plan.price_micros > 0) {
      db.prepare(
        `INSERT INTO wallet_ledger (
          id, user_id, type, amount_micros, balance_after_micros,
          reference_type, reference_id, description, created_at
        ) VALUES (?, ?, 'plan_renewal', ?, ?, 'plan_order', ?, ?, ?)`,
      ).run(uuid(), row.user_id, -plan.price_micros, updatedWallet.balance_micros, orderId, `${plan.name} 自动续费`, now);
    }
    db.prepare(
      `UPDATE subscriptions SET period_start = ?, period_end = ?, entitlement_end = ?,
        remaining_credits_micros = ?, reserved_micros = 0,
        price_micros_snapshot = ?, updated_at = ? WHERE id = ?`,
    ).run(
      start.toISOString(),
      end.toISOString(),
      entitlementEnd.toISOString(),
      plan.included_credits_micros,
      plan.price_micros,
      now,
      row.id,
    );
    db.prepare(
      `UPDATE renewal_jobs SET status = 'completed', attempts = attempts + 1,
        last_error = NULL, updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(now, now, job.id);
    return true;
  })();
}

// L15: if a past bug left more than one active subscription for a user,
// keep the newest and cancel the rest (and free their stock). Called from
// get/maintain so every read path self-heals.
function reconcileMultipleActiveSubscriptions(userId: string) {
  const rows = db
    .prepare(
      `SELECT id, plan_id FROM subscriptions
       WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
    )
    .all(userId) as Array<{ id: string; plan_id: string }>;
  if (rows.length <= 1) return rows[0] ?? null;
  const now = nowIso();
  const [keep, ...extras] = rows;
  db.transaction(() => {
    for (const extra of extras) {
      db.prepare(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'",
      ).run(now, extra.id);
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, extra.plan_id);
    }
  })();
  return keep;
}

export function getActiveSubscription(userId: string): ActiveSubscription | null {
  reconcileMultipleActiveSubscriptions(userId);
  const row = db
    .prepare(
      `SELECT s.* FROM subscriptions s
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Subscription | undefined;
  if (!row) return null;
  const plan = getPlan(row.plan_id);
  if (!plan) return null;

  return { ...row, plan: publicPlan(plan) };
}

export function maintainActiveSubscription(
  userId: string,
  options?: { allowAutoRenew?: boolean },
): ActiveSubscription | null {
  const allowAutoRenew = options?.allowAutoRenew ?? true;
  reconcileMultipleActiveSubscriptions(userId);
  let row = db
    .prepare(
      `SELECT s.* FROM subscriptions s
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Subscription | undefined;
  if (!row) return null;
  const plan = getPlan(row.plan_id);
  if (!plan) return null;

  if (Date.parse(row.period_end) <= Date.now() && row.reserved_micros === 0) {
    row = advancePaidPeriods(row, plan);
    if (Date.parse(row.period_end) <= Date.now()) {
      // When the user is explicitly paying (purchase/renew/upgrade), do NOT
      // silently run the auto-renewal first: that would charge the wallet a
      // full period and then charge again for the user's own operation
      // (double charge). Expire instead; the caller decides the next step.
      if (row.auto_renew !== 1 || plan.enabled !== 1 || !allowAutoRenew) {
        expireSubscription(row);
        return null;
      }
      if (!autoRenewSubscription(row, plan)) return null;
      row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(row.id) as Subscription;
    }
  }

  return { ...row, plan: publicPlan(plan) };
}

export function setSubscriptionAutoRenew(userId: string, enabled: boolean) {
  const subscription = db.prepare(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  ).get(userId) as { id: string } | undefined;
  if (!subscription) return null;
  db.prepare("UPDATE subscriptions SET auto_renew = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nowIso(), subscription.id);
  return getActiveSubscription(userId);
}

export function setSubscriptionOverage(userId: string, enabled: boolean) {
  const subscription = db.prepare(
    `SELECT s.id, p.overage_enabled AS plan_overage_enabled
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`,
  ).get(userId) as { id: string; plan_overage_enabled: number } | undefined;
  if (!subscription) return null;
  if (enabled && subscription.plan_overage_enabled !== 1) {
    throw new PlanTransactionError(409, "plan_overage_disabled", "This plan does not allow wallet overage");
  }
  db.prepare("UPDATE subscriptions SET overage_enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, nowIso(), subscription.id);
  return getActiveSubscription(userId);
}

export function purchasePlan(userId: string, planId: string, requestId = uuid()) {
  const duplicate = existingPlanTransaction(userId, requestId);
  if (duplicate) return duplicate;
  // Never auto-renew here: an expired subscription must expire so the purchase
  // below is the only charge. Auto-renewing first would bill a full period and
  // then bill again for the purchase (double charge).
  maintainActiveSubscription(userId, { allowAutoRenew: false });
  const orderId = uuid();
  db.transaction(() => {
    const current = db.prepare(
      "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
    ).get(userId);
    if (current) {
      throw new PlanTransactionError(409, "active_subscription_exists", "Use upgrade while a subscription is active");
    }
    const plan = requireAvailablePlan(planId);
    const now = nowIso();
    const start = new Date();
    const subscriptionId = uuid();
    const balance = debitWallet({
      userId,
      amountMicros: plan.price_micros,
      orderId,
      type: "plan_purchase",
      description: `购买套餐 ${plan.name}`,
      now,
    });
    db.prepare("UPDATE plans SET stock_used = stock_used + 1, updated_at = ? WHERE id = ?")
      .run(now, plan.id);
    db.prepare(
      `INSERT INTO subscriptions (
        id, user_id, plan_id, status, starts_at, period_start, period_end, entitlement_end,
        remaining_credits_micros, reserved_micros, price_micros_snapshot,
        auto_renew, overage_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
    ).run(
      subscriptionId,
      userId,
      plan.id,
      start.toISOString(),
      start.toISOString(),
      addDays(start, plan.cycle_days).toISOString(),
      addDays(start, plan.cycle_days).toISOString(),
      plan.included_credits_micros,
      plan.price_micros,
      plan.overage_enabled,
      now,
      now,
    );
    insertPlanOrder({
      id: orderId,
      requestId,
      userId,
      planId: plan.id,
      subscriptionId,
      type: "purchase",
      listPriceMicros: plan.price_micros,
      amountMicros: plan.price_micros,
      balanceAfterMicros: balance,
      description: `购买套餐 ${plan.name}`,
      now,
    });
  })();
  return finishPlanTransaction(userId, orderId);
}

export function upgradePlan(userId: string, targetPlanId: string, requestId = uuid()) {
  const duplicate = existingPlanTransaction(userId, requestId);
  if (duplicate) return duplicate;
  // Drop holds left by disconnected clients so upgrades are not blocked forever.
  cleanupStaleReservations();
  releaseUserPendingReservations(userId, 2 * 60_000);
  // Do not let the auto-renewal charge first here either — the upgrade itself
  // bills the difference. An expired subscription is expired (404 below).
  const active = maintainActiveSubscription(userId, { allowAutoRenew: false });
  if (!active) throw new PlanTransactionError(404, "active_subscription_not_found", "Active subscription not found");
  const orderId = uuid();
  db.transaction(() => {
    const current = db.prepare(
      "SELECT * FROM subscriptions WHERE id = ? AND status = 'active'",
    ).get(active.id) as Subscription | undefined;
    if (!current) throw new PlanTransactionError(409, "subscription_changed", "Subscription has changed");
    if (current.reserved_micros > 0) {
      throw new PlanTransactionError(
        409,
        "subscription_in_use",
        "Wait for active Coding Plan requests to finish before upgrading (or retry in ~2 minutes after disconnect)",
      );
    }
    if (current.plan_id === targetPlanId) {
      throw new PlanTransactionError(409, "same_plan", "The target plan is already active");
    }
    const currentPlan = getPlan(current.plan_id);
    if (!currentPlan) throw new PlanTransactionError(404, "current_plan_not_found", "Current plan not found");
    const target = requireAvailablePlan(targetPlanId);
    const currentListPrice = current.price_micros_snapshot || currentPlan.price_micros;
    if (target.price_micros <= currentListPrice) {
      throw new PlanTransactionError(409, "not_an_upgrade", "The target plan price must be higher than the current plan");
    }
    const periodStart = Date.parse(current.period_start);
    const periodEnd = Date.parse(current.period_end);
    const entitlementEnd = Date.parse(current.entitlement_end);
    const duration = Math.max(1, periodEnd - periodStart);
    const remaining = Math.max(0, Math.min(duration, periodEnd - Date.now()));
    const currentCredit = Number(
      (BigInt(current.price_micros_snapshot || currentPlan.price_micros) * BigInt(Math.floor(remaining))) / BigInt(duration),
    );
    const futureDuration = Math.max(0, entitlementEnd - periodEnd);
    const cycleDuration = Math.max(1, currentPlan.cycle_days * 86_400_000);
    const futureCredit = Number(
      (BigInt(currentPlan.price_micros) * BigInt(Math.floor(futureDuration))) / BigInt(cycleDuration),
    );
    const credit = Math.min(Number.MAX_SAFE_INTEGER, currentCredit + futureCredit);
    const amount = Math.max(0, target.price_micros - credit);
    const walletCredit = Math.max(0, credit - target.price_micros);
    const now = nowIso();
    const start = new Date();
    const subscriptionId = uuid();
    let balance = debitWallet({
      userId,
      amountMicros: amount,
      orderId,
      type: "plan_upgrade",
      description: `升级套餐 ${currentPlan.name} → ${target.name}`,
      now,
    });
    if (walletCredit > 0) {
      balance = creditWallet({
        userId,
        amountMicros: walletCredit,
        orderId,
        type: "plan_upgrade_credit",
        description: `升级套餐预付余额退回 ${currentPlan.name} → ${target.name}`,
        now,
      });
    }
    db.prepare("UPDATE subscriptions SET status = 'upgraded', updated_at = ? WHERE id = ?")
      .run(now, current.id);
    db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
      .run(now, current.plan_id);
    db.prepare("UPDATE plans SET stock_used = stock_used + 1, updated_at = ? WHERE id = ?")
      .run(now, target.id);
    db.prepare(
      `INSERT INTO subscriptions (
        id, user_id, plan_id, status, starts_at, period_start, period_end, entitlement_end,
        remaining_credits_micros, reserved_micros, price_micros_snapshot,
        auto_renew, overage_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      subscriptionId,
      userId,
      target.id,
      start.toISOString(),
      start.toISOString(),
      addDays(start, target.cycle_days).toISOString(),
      addDays(start, target.cycle_days).toISOString(),
      target.included_credits_micros,
      target.price_micros,
      current.auto_renew,
      current.overage_enabled === 1 && target.overage_enabled === 1 ? 1 : 0,
      now,
      now,
    );
    insertPlanOrder({
      id: orderId,
      requestId,
      userId,
      planId: target.id,
      previousPlanId: current.plan_id,
      subscriptionId,
      type: "upgrade",
      listPriceMicros: target.price_micros,
      creditMicros: credit,
      amountMicros: amount,
      balanceAfterMicros: balance,
      description: `升级套餐 ${currentPlan.name} → ${target.name}`,
      metadata: { current_credit_micros: currentCredit, future_credit_micros: futureCredit, wallet_credit_micros: walletCredit },
      now,
    });
  })();
  return finishPlanTransaction(userId, orderId);
}

export function renewPlan(userId: string, requestId = uuid()) {
  const duplicate = existingPlanTransaction(userId, requestId);
  if (duplicate) return duplicate;
  cleanupStaleReservations();
  releaseUserPendingReservations(userId, 2 * 60_000);
  // Same double-charge guard as purchasePlan: this operation IS the renewal,
  // so the auto-renewal path must not charge first. An expired subscription
  // is expired (404 below); a prepaid one is advanced for free and extended.
  const active = maintainActiveSubscription(userId, { allowAutoRenew: false });
  if (!active) throw new PlanTransactionError(404, "active_subscription_not_found", "Active subscription not found");
  const orderId = uuid();
  db.transaction(() => {
    const current = db.prepare(
      "SELECT * FROM subscriptions WHERE id = ? AND status = 'active'",
    ).get(active.id) as Subscription | undefined;
    if (!current) throw new PlanTransactionError(409, "subscription_changed", "Subscription has changed");
    if (current.reserved_micros > 0) {
      throw new PlanTransactionError(
        409,
        "subscription_in_use",
        "Wait for active Coding Plan requests to finish before renewing (or retry in ~2 minutes after disconnect)",
      );
    }
    const plan = getPlan(current.plan_id);
    if (!plan || plan.enabled !== 1) {
      throw new PlanTransactionError(404, "plan_not_found", "Plan not found or disabled");
    }
    const now = nowIso();
    const entitlementStart = new Date(Math.max(Date.now(), Date.parse(current.entitlement_end)));
    const entitlementEnd = addDays(entitlementStart, plan.cycle_days);
    const balance = debitWallet({
      userId,
      amountMicros: plan.price_micros,
      orderId,
      type: "plan_renewal",
      description: `手动续费 ${plan.name}`,
      now,
    });
    db.prepare(
      `UPDATE subscriptions SET entitlement_end = ?, updated_at = ? WHERE id = ?`,
    ).run(
      entitlementEnd.toISOString(),
      now,
      current.id,
    );
    insertPlanOrder({
      id: orderId,
      requestId,
      userId,
      planId: plan.id,
      subscriptionId: current.id,
      type: "renewal",
      listPriceMicros: plan.price_micros,
      amountMicros: plan.price_micros,
      balanceAfterMicros: balance,
      description: `手动续费 ${plan.name}`,
      metadata: { entitlement_from: entitlementStart.toISOString(), entitlement_to: entitlementEnd.toISOString() },
      now,
    });
  })();
  return finishPlanTransaction(userId, orderId);
}

export function assignPlan(userId: string, planId: string, autoRenew = true) {
  const plan = getPlan(planId);
  if (!plan || plan.enabled !== 1) return null;
  const id = uuid();
  const start = new Date();
  const end = addDays(start, plan.cycle_days);
  const now = nowIso();
  db.transaction(() => {
    // L15: cancel EVERY active subscription for the user (not just one row)
    // so a leftover multi-active state cannot block subsequent purchases.
    const currents = db
      .prepare("SELECT id, plan_id FROM subscriptions WHERE user_id = ? AND status = 'active'")
      .all(userId) as Array<{ id: string; plan_id: string }>;
    for (const current of currents) {
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, current.plan_id);
    }
    if (currents.length) {
      db.prepare(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'active'",
      ).run(now, userId);
    }
    const latestPlan = db.prepare("SELECT stock_limit, stock_used, enabled FROM plans WHERE id = ?").get(planId) as
      | { stock_limit: number; stock_used: number; enabled: number }
      | undefined;
    // L11: surface typed PlanTransactionError so the route returns 4xx JSON
    // instead of an uncaught Error -> HTML/JSON 500.
    if (!latestPlan || latestPlan.enabled !== 1) {
      throw new PlanTransactionError(404, "plan_not_found", "Plan not found or disabled");
    }
    if (latestPlan.stock_limit > 0 && latestPlan.stock_used >= latestPlan.stock_limit) {
      throw new PlanTransactionError(409, "plan_out_of_stock", "Plan inventory is exhausted");
    }
    db.prepare("UPDATE plans SET stock_used = stock_used + 1, updated_at = ? WHERE id = ?").run(now, planId);
    db.prepare(
      `INSERT INTO subscriptions (
        id, user_id, plan_id, status, starts_at, period_start, period_end, entitlement_end,
        remaining_credits_micros, reserved_micros, price_micros_snapshot,
        auto_renew, overage_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      planId,
      start.toISOString(),
      start.toISOString(),
      end.toISOString(),
      end.toISOString(),
      plan.included_credits_micros,
      autoRenew ? 1 : 0,
      plan.overage_enabled,
      now,
      now,
    );
  })();
  return getActiveSubscription(userId);
}

export function cancelSubscription(userId: string) {
  let cancelled = false;
  db.transaction(() => {
    const current = db
      .prepare("SELECT id, plan_id FROM subscriptions WHERE user_id = ? AND status = 'active'")
      .get(userId) as { id: string; plan_id: string } | undefined;
    if (!current) return;
    const now = nowIso();
    cancelled = db.prepare("UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, current.id).changes > 0;
    db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
      .run(now, current.plan_id);
  })();
  return cancelled;
}

/**
 * Adjust active subscription remaining credits.
 * amountMicros may be negative. Result is clamped to >= 0 and never below reserved_micros.
 */
export function adjustSubscriptionCredits(
  userId: string,
  amountMicros: number,
  description = "Admin plan credit adjustment",
) {
  const delta = Math.trunc(Number(amountMicros) || 0);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new PlanTransactionError(400, "invalid_amount", "Credit adjustment must be a non-zero integer micros amount");
  }

  let subscription: ActiveSubscription | null = null;
  db.transaction(() => {
    const current = db
      .prepare(
        `SELECT id, remaining_credits_micros, reserved_micros
         FROM subscriptions WHERE user_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId) as
      | { id: string; remaining_credits_micros: number; reserved_micros: number }
      | undefined;
    if (!current) {
      throw new PlanTransactionError(404, "no_active_plan", "User has no active plan subscription");
    }

    const floor = Math.max(0, Number(current.reserved_micros) || 0);
    const next = Math.max(floor, Number(current.remaining_credits_micros) + delta);
    db.prepare(
      `UPDATE subscriptions
       SET remaining_credits_micros = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next, nowIso(), current.id);

    // Keep a lightweight audit trail in plan_orders metadata is overkill; admin audit log covers it.
    subscription = getActiveSubscription(userId);
  })();

  return {
    subscription,
    description: String(description || "").trim() || "Admin plan credit adjustment",
    amount_micros: delta,
  };
}
