import { v4 as uuid } from "uuid";
import { ApiKey, db } from "../db";
import { generateApiKey, hashApiKey } from "../utils/hash";
import { nowIso } from "../utils/time";
import { decryptSecret, encryptSecret } from "../utils/secrets";

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

  db.prepare(
    `UPDATE api_keys SET
      name = ?, enabled = ?, rate_limit = ?, tpm_limit = ?, concurrency_limit = ?,
      allowed_models = ?, expires_at = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    input.rate_limit ?? existing.rate_limit,
    input.tpm_limit ?? existing.tpm_limit,
    input.concurrency_limit ?? existing.concurrency_limit,
    input.allowed_models ? JSON.stringify(input.allowed_models) : existing.allowed_models,
    input.expires_at !== undefined ? input.expires_at : existing.expires_at,
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

export function authenticateApiKey(raw: string | undefined | null) {
  if (!raw) return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  ensureKeyCache();
  const row = keyByHash.get(hashApiKey(token));

  if (!row || row.enabled !== 1) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  pendingLastUsed.set(row.id, nowIso());
  return row;
}

function publicKey(row: ApiKey, oneTimeSecret?: string) {
  const storedSecret = row.key_plain ? decryptSecret(row.key_plain) : null;
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
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}
