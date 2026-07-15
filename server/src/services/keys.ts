import { v4 as uuid } from "uuid";
import { ApiKey, db } from "../db";
import { generateApiKey, hashApiKey } from "../utils/hash";
import { nowIso } from "../utils/time";

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

export function listApiKeys() {
  const rows = db
    .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all() as ApiKey[];
  return rows.map(publicKey);
}

export function createApiKey(input: {
  name: string;
  rate_limit?: number;
  enabled?: boolean;
}) {
  const raw = generateApiKey();
  const id = uuid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO api_keys (
      id, name, key_hash, key_prefix, key_plain, enabled, rate_limit, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.name,
    hashApiKey(raw),
    raw.slice(0, 10),
    raw,
    input.enabled === false ? 0 : 1,
    input.rate_limit ?? 0,
    now,
  );
  refreshApiKeyCache();
  return publicKey(db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKey);
}

export function updateApiKey(
  id: string,
  input: Partial<{ name: string; enabled: boolean; rate_limit: number }>,
) {
  const existing = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as
    | ApiKey
    | undefined;
  if (!existing) return null;

  db.prepare(
    `UPDATE api_keys SET
      name = ?, enabled = ?, rate_limit = ?
     WHERE id = ?`,
  ).run(
    input.name ?? existing.name,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    input.rate_limit ?? existing.rate_limit,
    id,
  );

  refreshApiKeyCache();
  return publicKey(db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKey);
}

export function deleteApiKey(id: string) {
  const deleted = db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
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

  pendingLastUsed.set(row.id, nowIso());
  return row;
}

/** Always expose full key when stored — user wants to copy anytime. */
function publicKey(row: ApiKey) {
  const plain = row.key_plain || null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    key: plain,
    enabled: row.enabled === 1,
    rate_limit: row.rate_limit,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}
