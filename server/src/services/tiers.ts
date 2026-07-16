import { v4 as uuid } from "uuid";
import { db, type UserTier } from "../db";
import { nowIso } from "../utils/time";

export class TierError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicTier(row: UserTier) {
  return { ...row, enabled: row.enabled === 1 };
}

let enabledTierCache: ReturnType<typeof publicTier>[] | null = null;

function enabledTiers() {
  if (!enabledTierCache) {
    enabledTierCache = (db.prepare(
      "SELECT * FROM user_tiers WHERE enabled = 1 ORDER BY threshold_micros ASC, created_at ASC",
    ).all() as UserTier[]).map(publicTier);
  }
  return enabledTierCache;
}

function refreshTierCache() {
  enabledTierCache = null;
}

export function listUserTiers(enabledOnly = false) {
  return (db.prepare(
    `SELECT * FROM user_tiers ${enabledOnly ? "WHERE enabled = 1" : ""}
     ORDER BY threshold_micros ASC, created_at ASC`,
  ).all() as UserTier[]).map(publicTier);
}

export function getUserTier(id: string) {
  const row = db.prepare("SELECT * FROM user_tiers WHERE id = ?").get(id) as UserTier | undefined;
  return row ? publicTier(row) : null;
}

function ensureEnabledBaseTier() {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM user_tiers WHERE enabled = 1 AND threshold_micros = 0",
  ).get() as { count: number };
  if (row.count < 1) throw new TierError(409, "base_tier_required", "At least one enabled tier must start at zero");
}

export function createUserTier(input: {
  name: string;
  description?: string;
  threshold_micros?: number;
  rpm_limit?: number;
  tpm_limit?: number;
  concurrency_limit?: number;
  enabled?: boolean;
}) {
  const id = uuid();
  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO user_tiers (
          id, name, description, threshold_micros, rpm_limit, tpm_limit,
          concurrency_limit, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name.trim(),
        input.description?.trim() || "",
        Math.max(0, Math.floor(input.threshold_micros ?? 0)),
        Math.max(0, Math.floor(input.rpm_limit ?? 0)),
        Math.max(0, Math.floor(input.tpm_limit ?? 0)),
        Math.max(0, Math.floor(input.concurrency_limit ?? 0)),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
      ensureEnabledBaseTier();
    })();
  } catch (error) {
    if (error instanceof TierError) throw error;
    throw new TierError(409, "tier_conflict", error instanceof Error ? error.message : "Tier already exists");
  }
  refreshTierCache();
  return getUserTier(id)!;
}

export function updateUserTier(id: string, input: Partial<{
  name: string;
  description: string;
  threshold_micros: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  enabled: boolean;
}>) {
  const current = db.prepare("SELECT * FROM user_tiers WHERE id = ?").get(id) as UserTier | undefined;
  if (!current) return null;
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE user_tiers SET name = ?, description = ?, threshold_micros = ?,
          rpm_limit = ?, tpm_limit = ?, concurrency_limit = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.name?.trim() || current.name,
        input.description?.trim() ?? current.description,
        Math.max(0, Math.floor(input.threshold_micros ?? current.threshold_micros)),
        Math.max(0, Math.floor(input.rpm_limit ?? current.rpm_limit)),
        Math.max(0, Math.floor(input.tpm_limit ?? current.tpm_limit)),
        Math.max(0, Math.floor(input.concurrency_limit ?? current.concurrency_limit)),
        input.enabled === undefined ? current.enabled : (input.enabled ? 1 : 0),
        nowIso(),
        id,
      );
      ensureEnabledBaseTier();
    })();
  } catch (error) {
    if (error instanceof TierError) throw error;
    throw new TierError(409, "tier_conflict", error instanceof Error ? error.message : "Tier conflicts with another tier");
  }
  refreshTierCache();
  return getUserTier(id);
}

export function deleteUserTier(id: string) {
  let deleted = false;
  db.transaction(() => {
    deleted = db.prepare("DELETE FROM user_tiers WHERE id = ?").run(id).changes > 0;
    if (deleted) ensureEnabledBaseTier();
  })();
  if (deleted) refreshTierCache();
  return deleted;
}

export function resolveTierForTopup(lifetimeTopupMicros: number) {
  const amount = Math.max(0, lifetimeTopupMicros);
  const tiers = enabledTiers();
  const current = [...tiers].reverse().find((tier) => tier.threshold_micros <= amount) ?? null;
  const next = tiers.find((tier) => tier.threshold_micros > amount) ?? null;
  return {
    current,
    next,
    lifetime_topup_micros: amount,
    next_required_micros: next ? Math.max(0, next.threshold_micros - amount) : 0,
  };
}

export function resolveUserTier(userId: string) {
  const wallet = db.prepare(
    "SELECT lifetime_topup_micros FROM wallet_accounts WHERE user_id = ?",
  ).get(userId) as { lifetime_topup_micros: number } | undefined;
  return resolveTierForTopup(wallet?.lifetime_topup_micros ?? 0);
}
