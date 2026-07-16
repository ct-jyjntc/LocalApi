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
  };
}

export function listPlans(enabledOnly = false) {
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
  enabled?: boolean;
}) {
  const id = uuid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO plans (
      id, name, description, cycle_days, included_credits_micros, allowed_models,
      rpm_limit, tpm_limit, concurrency_limit, overage_enabled, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  enabled: boolean;
}>) {
  const plan = getPlan(id);
  if (!plan) return null;
  db.prepare(
    `UPDATE plans SET name = ?, description = ?, cycle_days = ?, included_credits_micros = ?,
      allowed_models = ?, rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?,
      overage_enabled = ?, enabled = ?, updated_at = ? WHERE id = ?`,
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
      db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
      return null;
    }
  }

  return { ...row, plan: publicPlan(plan) };
}

export function assignPlan(userId: string, planId: string, autoRenew = true) {
  const plan = getPlan(planId);
  if (!plan || plan.enabled !== 1) return null;
  const id = uuid();
  const start = new Date();
  const end = addDays(start, plan.cycle_days);
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'active'",
    ).run(now, userId);
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
  return (
    db.prepare(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'active'",
    ).run(nowIso(), userId).changes > 0
  );
}
