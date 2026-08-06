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
    linuxdo_uid: row.linuxdo_uid ?? null,
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

/**
 * Look up a user by their bound LinuxDo identity (profile.id).
 * This is the only identity-safe way to resolve an OAuth login — username
 * lookups are NOT safe for that purpose because usernames are attacker-chosen.
 */
export function getUserByLinuxDoUid(uid: string): User | null {
  const normalized = String(uid).trim();
  if (!normalized) return null;
  return (
    (db.prepare("SELECT * FROM users WHERE linuxdo_uid = ?").get(normalized) as
      | User
      | undefined) ?? null
  );
}

function mapUserListRow(row: Record<string, unknown>) {
  const topup = Number(row.lifetime_topup_micros || 0);
  const tier = resolveTierForTopup(topup);
  const pointsCents = Number(row.points_balance_cents || 0);
  const earnedCents = Number(row.points_lifetime_earned_cents || 0);
  const spentCents = Number(row.points_lifetime_spent_cents || 0);
  return {
    id: String(row.id),
    username: String(row.username),
    display_name: String(row.display_name),
    status: String(row.status),
    allowed_models: parseModels(String(row.allowed_models || "[]")),
    rpm_limit: Number(row.rpm_limit || 0),
    tpm_limit: Number(row.tpm_limit || 0),
    concurrency_limit: Number(row.concurrency_limit || 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at: (row.last_login_at as string | null) ?? null,
    linuxdo_uid: (row.linuxdo_uid as string | null) ?? null,
    balance_micros: Number(row.balance_micros || 0),
    reserved_micros: Number(row.reserved_micros || 0),
    lifetime_spent_micros: Number(row.lifetime_spent_micros || 0),
    lifetime_topup_micros: topup,
    subscription_id: (row.subscription_id as string | null) ?? null,
    plan_id: (row.plan_id as string | null) ?? null,
    period_end: (row.period_end as string | null) ?? null,
    period_start: (row.period_start as string | null) ?? null,
    remaining_credits_micros:
      row.remaining_credits_micros == null ? null : Number(row.remaining_credits_micros),
    plan_reserved_micros: row.plan_reserved_micros == null ? null : Number(row.plan_reserved_micros),
    subscription_status: (row.subscription_status as string | null) ?? null,
    plan_name: (row.plan_name as string | null) ?? null,
    plan_included_credits_micros:
      row.plan_included_credits_micros == null ? null : Number(row.plan_included_credits_micros),
    points_balance: pointsCents / 100,
    points_lifetime_earned: earnedCents / 100,
    points_lifetime_spent: spentCents / 100,
    // Keep shape expected by the admin UI, but drop bulky nested tier fields.
    tier: {
      current: tier.current
        ? {
            id: tier.current.id,
            name: tier.current.name,
            threshold_micros: tier.current.threshold_micros,
          }
        : null,
      next: tier.next
        ? {
            id: tier.next.id,
            name: tier.next.name,
            threshold_micros: tier.next.threshold_micros,
          }
        : null,
      lifetime_topup_micros: topup,
      next_required_micros: tier.next_required_micros,
    },
  };
}

const USER_LIST_SELECT = `
  SELECT u.id, u.username, u.display_name, u.status, u.allowed_models,
         u.rpm_limit, u.tpm_limit, u.concurrency_limit,
         u.created_at, u.updated_at, u.last_login_at, u.linuxdo_uid,
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
`;

/** Full list (kept for callers that still expect every user). Prefer listUsersPage. */
export function listUsers() {
  return db
    .prepare(`${USER_LIST_SELECT} ORDER BY u.created_at DESC`)
    .all()
    .map((row) => mapUserListRow(row as Record<string, unknown>));
}

/** Paginated admin user list with optional search. */
export function listUsersPage(input: { limit?: number; offset?: number; q?: string } = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const q = String(input.q || "").trim();
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  const where = like
    ? `WHERE u.username LIKE ? COLLATE NOCASE
         OR u.display_name LIKE ? COLLATE NOCASE
         OR IFNULL(p.name, '') LIKE ? COLLATE NOCASE`
    : "";
  const params = like ? [like, like, like] : [];
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM users u
         LEFT JOIN subscriptions s ON s.id = (
           SELECT id FROM subscriptions sx
           WHERE sx.user_id = u.id AND sx.status = 'active'
           ORDER BY sx.created_at DESC LIMIT 1
         )
         LEFT JOIN plans p ON p.id = s.plan_id
         ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const items = db
    .prepare(`${USER_LIST_SELECT} ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((row) => mapUserListRow(row as Record<string, unknown>));
  return { items, total, limit, offset };
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
  linuxdo_uid?: string | null;
}) {
  const id = uuid();
  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, display_name, password_hash, status, allowed_models,
        rpm_limit, tpm_limit, concurrency_limit, created_at, updated_at, last_login_at,
        linuxdo_uid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
      input.linuxdo_uid ? String(input.linuxdo_uid) : null,
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
    linuxdo_uid: string | null;
  }>,
) {
  const user = getUser(id);
  if (!user) return null;
  // linuxdo_uid is a deliberate admin binding/unbinding operation: null unbinds.
  const hasLinuxDoUid = "linuxdo_uid" in input;
  db.prepare(
    `UPDATE users SET display_name = ?, password_hash = ?, status = ?, allowed_models = ?,
      rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?, linuxdo_uid = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.display_name?.trim() || user.display_name,
    input.password ? hashPassword(input.password) : user.password_hash,
    input.status ?? user.status,
    input.allowed_models ? JSON.stringify(input.allowed_models) : user.allowed_models,
    input.rpm_limit ?? user.rpm_limit,
    input.tpm_limit ?? user.tpm_limit,
    input.concurrency_limit ?? user.concurrency_limit,
    hasLinuxDoUid
      ? input.linuxdo_uid
        ? String(input.linuxdo_uid).trim()
        : null
      : user.linuxdo_uid ?? null,
    nowIso(),
    id,
  );
  // Non-active status revokes sessions; a password change must too — a leaked
  // session token must not outlive the password it was issued under.
  if ((input.status && input.status !== "active") || input.password) {
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
  }
  return publicUser(getUser(id)!);
}

export function changeUserPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = getUser(userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) return false;
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(newPassword), nowIso(), userId);
    // Revoke every session: a leaked token must not survive a password change.
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
  })();
  return true;
}

export function deleteUser(id: string) {
  let deleted = false;
  db.transaction(() => {
    deleted = deleteUserInTransaction(id);
  })();
  if (deleted) refreshApiKeyCache();
  return deleted;
}

function uniqueUserIds(ids: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Soft-disable/suspend/activate many users; non-active statuses revoke sessions. */
export function setUsersStatus(ids: string[], status: "active" | "suspended" | "disabled") {
  const userIds = uniqueUserIds(ids).slice(0, 500);
  if (!userIds.length) return { updated: 0, ids: [] as string[] };
  const now = nowIso();
  const updatedIds: string[] = [];
  db.transaction(() => {
    const update = db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?");
    const clearSessions = db.prepare("DELETE FROM user_sessions WHERE user_id = ?");
    for (const id of userIds) {
      if (!getUser(id)) continue;
      if (update.run(status, now, id).changes > 0) {
        updatedIds.push(id);
        if (status !== "active") clearSessions.run(id);
      }
    }
  })();
  return { updated: updatedIds.length, ids: updatedIds, status };
}

function deleteUserInTransaction(id: string) {
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
  const deleted = db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  if (deleted && active) {
    db.prepare("UPDATE plans SET stock_used = MAX(0, stock_used - 1), updated_at = ? WHERE id = ?")
      .run(nowIso(), active.plan_id);
  }
  return deleted;
}

/** Hard-delete many users; reuses single-user cascade rules. */
export function deleteUsers(ids: string[]) {
  const userIds = uniqueUserIds(ids).slice(0, 500);
  if (!userIds.length) return { deleted: 0, ids: [] as string[] };
  const deletedIds: string[] = [];
  db.transaction(() => {
    for (const id of userIds) {
      if (deleteUserInTransaction(id)) deletedIds.push(id);
    }
  })();
  if (deletedIds.length) refreshApiKeyCache();
  return { deleted: deletedIds.length, ids: deletedIds };
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
