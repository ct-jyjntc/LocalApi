import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db, User } from "../db";
import { sha256 } from "../utils/hash";
import { hashPassword, verifyPassword } from "../utils/password";
import { nowIso } from "../utils/time";
import { deleteApiKeysForUser, refreshApiKeyCache } from "./keys";
import { resolveTierForTopup } from "./tiers";

const SESSION_DAYS = 7;

function parseModels(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function publicUser(row: User, lifetimeTopupMicros?: number) {
  const topup = lifetimeTopupMicros ?? ((db.prepare(
    "SELECT lifetime_topup_micros FROM wallet_accounts WHERE user_id = ?",
  ).get(row.id) as { lifetime_topup_micros: number } | undefined)?.lifetime_topup_micros ?? 0);
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    status: row.status,
    allowed_models: parseModels(row.allowed_models),
    rpm_limit: row.rpm_limit,
    tpm_limit: row.tpm_limit,
    concurrency_limit: row.concurrency_limit,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
    tier: resolveTierForTopup(topup),
  };
}

export function getUser(id: string): User | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined) ?? null;
}

export function getUserByUsername(username: string): User | null {
  return (
    (db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.trim()) as
      | User
      | undefined) ?? null
  );
}

export function listUsers() {
  return db
    .prepare(
      `SELECT u.*,
              COALESCE(w.balance_micros, 0) AS balance_micros,
              COALESCE(w.reserved_micros, 0) AS reserved_micros,
              COALESCE(w.lifetime_spent_micros, 0) AS lifetime_spent_micros,
              COALESCE(w.lifetime_topup_micros, 0) AS lifetime_topup_micros,
              COALESCE(pa.balance, 0) AS points_balance_cents,
              COALESCE(pa.lifetime_earned, 0) AS points_lifetime_earned_cents,
              COALESCE(pa.lifetime_spent, 0) AS points_lifetime_spent_cents,
              s.id AS subscription_id, s.plan_id, s.period_end, s.period_start,
              s.remaining_credits_micros, s.reserved_micros AS plan_reserved_micros,
              s.status AS subscription_status,
              p.name AS plan_name,
              p.included_credits_micros AS plan_included_credits_micros
       FROM users u
       LEFT JOIN wallet_accounts w ON w.user_id = u.id
       LEFT JOIN points_accounts pa ON pa.user_id = u.id
       LEFT JOIN subscriptions s ON s.id = (
         SELECT id FROM subscriptions sx
         WHERE sx.user_id = u.id AND sx.status = 'active'
         ORDER BY sx.created_at DESC LIMIT 1
       )
       LEFT JOIN plans p ON p.id = s.plan_id
       ORDER BY u.created_at DESC`,
    )
    .all()
    .map((row) => {
      const user = publicUser(row as User, Number((row as Record<string, unknown>).lifetime_topup_micros || 0));
      const extra = row as Record<string, unknown>;
      const pointsCents = Number(extra.points_balance_cents || 0);
      const earnedCents = Number(extra.points_lifetime_earned_cents || 0);
      const spentCents = Number(extra.points_lifetime_spent_cents || 0);
      return {
        ...user,
        ...extra,
        password_hash: undefined,
        allowed_models: user.allowed_models,
        points_balance: pointsCents / 100,
        points_lifetime_earned: earnedCents / 100,
        points_lifetime_spent: spentCents / 100,
        points_balance_cents: undefined,
        points_lifetime_earned_cents: undefined,
        points_lifetime_spent_cents: undefined,
      };
    });
}

export function createUser(input: {
  username: string;
  display_name?: string;
  password: string;
  status?: string;
  allowed_models?: string[];
  rpm_limit?: number;
  tpm_limit?: number;
  concurrency_limit?: number;
}) {
  const id = uuid();
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, password_hash, status, allowed_models,
        rpm_limit, tpm_limit, concurrency_limit, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      input.username.trim(),
      input.display_name?.trim() || input.username.trim(),
      hashPassword(input.password),
      input.status ?? "active",
      JSON.stringify(input.allowed_models ?? []),
      input.rpm_limit ?? 0,
      input.tpm_limit ?? 0,
      input.concurrency_limit ?? 0,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO wallet_accounts (user_id, balance_micros, reserved_micros, lifetime_spent_micros, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
    ).run(id, now);
  })();
  return publicUser(getUser(id)!);
}

export function updateUser(
  id: string,
  input: Partial<{
    display_name: string;
    password: string;
    status: string;
    allowed_models: string[];
    rpm_limit: number;
    tpm_limit: number;
    concurrency_limit: number;
  }>,
) {
  const user = getUser(id);
  if (!user) return null;
  db.prepare(
    `UPDATE users SET display_name = ?, password_hash = ?, status = ?, allowed_models = ?,
      rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.display_name?.trim() || user.display_name,
    input.password ? hashPassword(input.password) : user.password_hash,
    input.status ?? user.status,
    input.allowed_models ? JSON.stringify(input.allowed_models) : user.allowed_models,
    input.rpm_limit ?? user.rpm_limit,
    input.tpm_limit ?? user.tpm_limit,
    input.concurrency_limit ?? user.concurrency_limit,
    nowIso(),
    id,
  );
  if (input.status && input.status !== "active") {
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
  }
  return publicUser(getUser(id)!);
}

export function changeUserPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = getUser(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) return false;
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(hashPassword(newPassword), nowIso(), userId);
  return true;
}

export function deleteUser(id: string) {
  let deleted = false;
  db.transaction(() => {
    deleteApiKeysForUser(id, false);
    db.prepare("DELETE FROM payment_refunds WHERE order_id IN (SELECT id FROM payment_orders WHERE user_id = ?)").run(id);
    // These historical/commercial tables intentionally retain a restrictive
    // user foreign key, so remove their user-scoped records explicitly.
    for (const table of ["payment_orders", "coupon_redemptions", "invoices", "renewal_jobs", "plan_orders"]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    }
    const active = db
      .prepare("SELECT plan_id FROM subscriptions WHERE user_id = ? AND status = 'active'")
      .get(id) as { plan_id: string } | undefined;
    deleted = db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
    if (deleted && active) {
      db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
        .run(nowIso(), active.plan_id);
    }
  })();
  if (deleted) refreshApiKeyCache();
  return deleted;
}

export function authenticateUser(username: string, password: string): User | null {
  const user = getUserByUsername(username);
  if (!user || user.status !== "active" || !verifyPassword(password, user.password_hash)) return null;
  db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(
    nowIso(),
    nowIso(),
    user.id,
  );
  return getUser(user.id);
}

export function createUserSession(userId: string) {
  const token = `lus_${crypto.randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), userId, sha256(`localapi:user-session:${token}`), expires, now.toISOString(), now.toISOString());
  return { token, expires_at: expires };
}

export function authenticateUserSession(raw: string | null | undefined): User | null {
  const token = raw?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.*
       FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(`localapi:user-session:${token}`)) as (User & { session_id: string; expires_at: string }) | undefined;
  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) {
    if (row?.session_id) db.prepare("DELETE FROM user_sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  db.prepare("UPDATE user_sessions SET last_used_at = ? WHERE id = ?").run(nowIso(), row.session_id);
  return row;
}

export function revokeUserSession(raw: string | null | undefined) {
  const token = raw?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  return (
    db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(
      sha256(`localapi:user-session:${token}`),
    ).changes > 0
  );
}
