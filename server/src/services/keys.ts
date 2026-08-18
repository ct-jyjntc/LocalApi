import { v4 as uuid } from "uuid";
import { ApiKey, db } from "../db";
import { generateApiKey, hashApiKey } from "../utils/hash";
import { nowIso } from "../utils/time";
import { encryptSecret, tryDecryptSecret } from "../utils/secrets";

import { authenticateOAuthToken } from "./oauth";
const keyByHash = new Map<string, ApiKey>();
const pendingLastUsed = new Map<string, string>();
let keyCacheReady = false;

function ensureKeyCache() {
  if (keyCacheReady) return;
  keyByHash.clear();
  const rows = db.prepare("SELECT * FROM api_keys").all() as ApiKey[];
  for (const row of rows) keyByHash.set(row.key_hash, row);
  keyCacheReady = true;
}

export function refreshApiKeyCache() {
  keyCacheReady = false;
  ensureKeyCache();
}

function flushLastUsed() {
  if (pendingLastUsed.size === 0) return;
  const rows = [...pendingLastUsed.entries()];
  pendingLastUsed.clear();
  try {
    const update = db.prepare(
      "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
    );
    db.transaction(() => {
      for (const [id, timestamp] of rows) update.run(timestamp, id);
    })();
  } catch {
    // A transient database error should not take down the proxy hot path.
    for (const [id, timestamp] of rows) pendingLastUsed.set(id, timestamp);
  }
}

const lastUsedTimer = setInterval(flushLastUsed, 5000);
lastUsedTimer.unref?.();

export function listApiKeys(userId?: string) {
  const rows = db
    .prepare(
      `SELECT * FROM api_keys ${userId ? "WHERE user_id = ?" : ""} ORDER BY created_at DESC`,
    )
    .all(...(userId ? [userId] : [])) as ApiKey[];
  return rows.map((row) => publicKey(row));
}

export function listApiKeysPage(input: { userId?: string; limit?: number; offset?: number; q?: string } = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const q = String(input.q || "").trim();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.userId) {
    conditions.push("user_id = ?");
    params.push(input.userId);
  }
  if (q) {
    conditions.push("(name LIKE ? COLLATE NOCASE OR key_prefix LIKE ? COLLATE NOCASE)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    params.push(like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM api_keys ${where}`).get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT k.*, u.username AS username, u.display_name AS user_display_name
       FROM api_keys k
       LEFT JOIN users u ON u.id = k.user_id
       ${where}
       ORDER BY k.created_at DESC, k.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as (ApiKey & { username: string | null; user_display_name: string | null })[];
  return { items: rows.map((row) => publicKey(row)), total, limit, offset };
}

export function createApiKey(input: {
  name: string;
  rate_limit?: number;
  tpm_limit?: number;
  concurrency_limit?: number;
  allowed_models?: string[];
  expires_at?: string | null;
  user_id?: string | null;
  enabled?: boolean;
}) {
  const raw = generateApiKey();
  const id = uuid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO api_keys (
      id, name, key_hash, key_prefix, key_plain, enabled, rate_limit, created_at, last_used_at,
      user_id, allowed_models, tpm_limit, concurrency_limit, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    hashApiKey(raw),
    raw.slice(0, 10),
    encryptSecret(raw),
    input.enabled === false ? 0 : 1,
    input.rate_limit ?? 0,
    now,
    input.user_id ?? null,
    JSON.stringify(input.allowed_models ?? []),
    input.tpm_limit ?? 0,
    input.concurrency_limit ?? 0,
    input.expires_at ?? null,
  );
  refreshApiKeyCache();
  return publicKey(
    db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKey,
    raw,
  );
}

export function updateApiKey(
  id: string,
  input: Partial<{
    name: string;
    enabled: boolean;
    rate_limit: number;
    tpm_limit: number;
    concurrency_limit: number;
    allowed_models: string[];
    expires_at: string | null;
  }>,
  userId?: string,
) {
  const existing = db.prepare(
    `SELECT * FROM api_keys WHERE id = ? ${userId ? "AND user_id = ?" : ""}`,
  ).get(...(userId ? [id, userId] : [id])) as
    | ApiKey
    | undefined;
  if (!existing) return null;

  const safeInput = userId
    ? { name: input.name, enabled: input.enabled }
    : input;

  db.prepare(
    `UPDATE api_keys SET
      name = ?, enabled = ?, rate_limit = ?, tpm_limit = ?, concurrency_limit = ?,
      allowed_models = ?, expires_at = ?
     WHERE id = ?`,
  ).run(
    safeInput.name ?? existing.name,
    safeInput.enabled !== undefined ? (safeInput.enabled ? 1 : 0) : existing.enabled,
    safeInput.rate_limit ?? existing.rate_limit,
    safeInput.tpm_limit ?? existing.tpm_limit,
    safeInput.concurrency_limit ?? existing.concurrency_limit,
    safeInput.allowed_models ? JSON.stringify(safeInput.allowed_models) : existing.allowed_models,
    safeInput.expires_at !== undefined ? safeInput.expires_at : existing.expires_at,
    id,
  );

  refreshApiKeyCache();
  return publicKey(db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKey);
}

export function deleteApiKey(id: string, userId?: string) {
  const deleted = db
    .prepare(`DELETE FROM api_keys WHERE id = ? ${userId ? "AND user_id = ?" : ""}`)
    .run(...(userId ? [id, userId] : [id])).changes > 0;
  if (deleted) {
    pendingLastUsed.delete(id);
    refreshApiKeyCache();
  }
  return deleted;
}

export function deleteApiKeysForUser(userId: string, refresh = true) {
  const rows = db.prepare("SELECT id FROM api_keys WHERE user_id = ?").all(userId) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const deleted = db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId).changes;
  for (const row of rows) pendingLastUsed.delete(row.id);
  if (refresh) refreshApiKeyCache();
  return deleted;
}

export function authenticateApiKey(raw: string | undefined | null) {
  if (!raw) return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  ensureKeyCache();
  const row = keyByHash.get(hashApiKey(token));

  if (row) {
    if (row.enabled !== 1) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
    pendingLastUsed.set(row.id, nowIso());
    return row;
  }

  // OAuth broker access tokens (oat_…) are drop-in user-bound API keys —
  // see services/oauth.ts. Keep the proxy hot path single-owner: the
  // synthetic ApiKey row flows through every existing gate unchanged.
  const oauthKey = authenticateOAuthToken(token);
  if (oauthKey) return oauthKey;
  return null;
}

function publicKey(row: ApiKey, oneTimeSecret?: string) {
  // A stored secret that cannot be decrypted (wrong/missing SECRETS_KEY) is
  // shown as unavailable rather than crashing the admin listing.
  const storedSecret = row.key_plain ? tryDecryptSecret(row.key_plain) : null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    key: oneTimeSecret ?? storedSecret,
    enabled: row.enabled === 1,
    rate_limit: row.rate_limit,
    tpm_limit: row.tpm_limit,
    concurrency_limit: row.concurrency_limit,
    allowed_models: (() => {
      try {
        return JSON.parse(row.allowed_models || "[]") as string[];
      } catch {
        return [];
      }
    })(),
    expires_at: row.expires_at,
    user_id: row.user_id,
    username: row.username ?? null,
    user_display_name: row.user_display_name ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}
