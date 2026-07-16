import { v4 as uuid } from "uuid";
import { db, Plan, Subscription } from "../db";
import { nowIso } from "../utils/time";

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

function expireDueSubscriptions() {
  const rows = db.prepare(
    `SELECT id, plan_id FROM subscriptions
     WHERE status = 'active' AND auto_renew = 0 AND reserved_micros = 0 AND period_end <= ?`,
  ).all(nowIso()) as Array<{ id: string; plan_id: string }>;
  if (rows.length === 0) return;
  const now = nowIso();
  db.transaction(() => {
    for (const row of rows) {
      db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, row.plan_id);
    }
  })();
}

export function listPlans(enabledOnly = false) {
  expireDueSubscriptions();
  const rows = db
    .prepare(`SELECT * FROM plans ${enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY created_at DESC`)
    .all() as Plan[];
  return rows.map(publicPlan);
}

export function getPlan(id: string): Plan | null {
  return (db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Plan | undefined) ?? null;
}

export function createPlan(input: {
  name: string;
  description?: string;
  cycle_days?: number;
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
  db.prepare(
    `INSERT INTO plans (
      id, name, description, cycle_days, included_credits_micros, allowed_models,
      rpm_limit, tpm_limit, concurrency_limit, overage_enabled, stock_limit, stock_used, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.description?.trim() || "",
    input.cycle_days ?? 30,
    input.included_credits_micros ?? 0,
    JSON.stringify(input.allowed_models ?? []),
    input.rpm_limit ?? 0,
    input.tpm_limit ?? 0,
    input.concurrency_limit ?? 0,
    input.overage_enabled === false ? 0 : 1,
    Math.max(0, Math.floor(input.stock_limit ?? 0)),
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
    `UPDATE plans SET name = ?, description = ?, cycle_days = ?, included_credits_micros = ?,
      allowed_models = ?, rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?,
      overage_enabled = ?, stock_limit = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.name?.trim() || plan.name,
    input.description?.trim() ?? plan.description,
    input.cycle_days ?? plan.cycle_days,
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

export type ActiveSubscription = Subscription & {
  plan: ReturnType<typeof publicPlan>;
};

export function getActiveSubscription(userId: string): ActiveSubscription | null {
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
    if (row.auto_renew === 1 && plan.enabled === 1) {
      const start = new Date();
      const end = addDays(start, plan.cycle_days);
      db.prepare(
        `UPDATE subscriptions SET period_start = ?, period_end = ?,
          remaining_credits_micros = ?, reserved_micros = 0, updated_at = ? WHERE id = ?`,
      ).run(start.toISOString(), end.toISOString(), plan.included_credits_micros, nowIso(), row.id);
      row = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(row.id) as Subscription;
    } else {
      const expiredId = row.id;
      const expiredPlanId = row.plan_id;
      db.transaction(() => {
        db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), expiredId);
        db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?").run(nowIso(), expiredPlanId);
      })();
      return null;
    }
  }

  return { ...row, plan: publicPlan(plan) };
}

export function assignPlan(userId: string, planId: string, autoRenew = true) {
  expireDueSubscriptions();
  const plan = getPlan(planId);
  if (!plan || plan.enabled !== 1) return null;
  const id = uuid();
  const start = new Date();
  const end = addDays(start, plan.cycle_days);
  const now = nowIso();
  db.transaction(() => {
    const current = db
      .prepare("SELECT plan_id FROM subscriptions WHERE user_id = ? AND status = 'active'")
      .get(userId) as { plan_id: string } | undefined;
    if (current) {
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(now, current.plan_id);
    }
    db.prepare(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'active'",
    ).run(now, userId);
    const latestPlan = db.prepare("SELECT stock_limit, stock_used, enabled FROM plans WHERE id = ?").get(planId) as
      | { stock_limit: number; stock_used: number; enabled: number }
      | undefined;
    if (!latestPlan || latestPlan.enabled !== 1) throw new Error("Plan not found or disabled");
    if (latestPlan.stock_limit > 0 && latestPlan.stock_used >= latestPlan.stock_limit) {
      throw new Error("Plan inventory is exhausted");
    }
    db.prepare("UPDATE plans SET stock_used = stock_used + 1, updated_at = ? WHERE id = ?").run(now, planId);
    db.prepare(
      `INSERT INTO subscriptions (
        id, user_id, plan_id, status, starts_at, period_start, period_end,
        remaining_credits_micros, reserved_micros, auto_renew, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      userId,
      planId,
      start.toISOString(),
      start.toISOString(),
      end.toISOString(),
      plan.included_credits_micros,
      autoRenew ? 1 : 0,
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
