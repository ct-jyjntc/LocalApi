import { v4 as uuid } from "uuid";
import { db, Provider } from "../db";
import { nowIso } from "../utils/time";
import { decryptSecret, encryptSecret } from "../utils/secrets";

/** Parse stored provider key field into a list of non-empty keys. */
export function parseProviderKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = decryptSecret(raw).trim();
  if (!s) return [];

  // JSON array
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((k) => k.trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  // Multi-line or comma-separated
  return s
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Serialize keys for storage (JSON array). */
export function serializeProviderKeys(keys: string[]): string {
  const clean = keys.map((k) => k.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const serialized = clean.length === 1 ? clean[0] : JSON.stringify(clean);
  return encryptSecret(serialized);
}

/** Round-robin pick for multi-key providers. */
const keyCursor = new Map<string, number>();
let providerCache: Provider[] | null = null;
const providerRuntime = new Map<string, { keys: string[]; models: string[] }>();

function rebuildProviderRuntime(rows: Provider[]) {
  providerRuntime.clear();
  for (const row of rows) {
    providerRuntime.set(row.id, {
      keys: parseProviderKeys(row.api_key),
      models: safeParseModels(row.models),
    });
  }
}

function loadProviders() {
  const rows = db
    .prepare("SELECT * FROM providers ORDER BY created_at DESC")
    .all() as Provider[];
  const update = db.prepare("UPDATE providers SET api_key = ? WHERE id = ?");
  for (const row of rows) {
    if (!row.api_key) continue;
    const encrypted = encryptSecret(row.api_key);
    if (encrypted !== row.api_key) {
      update.run(encrypted, row.id);
      row.api_key = encrypted;
    }
  }
  rebuildProviderRuntime(rows);
  return rows;
}

function ensureProviderCache() {
  if (providerCache) return;
  providerCache = loadProviders();
}

export function refreshProviderCache() {
  providerCache = loadProviders();
}

export function pickProviderKey(provider: Provider): string {
  const keys = providerRuntime.get(provider.id)?.keys ?? parseProviderKeys(provider.api_key);
  if (keys.length === 0) return "";
  if (keys.length === 1) return keys[0];
  const idx = keyCursor.get(provider.id) ?? 0;
  const key = keys[idx % keys.length];
  keyCursor.set(provider.id, idx + 1);
  return key;
}

export function listProviders(): Provider[] {
  ensureProviderCache();
  return providerCache!;
}

export function getProvider(id: string): Provider | undefined {
  return db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as
    | Provider
    | undefined;
}

export function createProvider(input: {
  name: string;
  base_url: string;
  api_key?: string;
  api_keys?: string[];
  models?: string[];
  enabled?: boolean;
  timeout_ms?: number;
}): Provider {
  const now = nowIso();
  const id = uuid();
  const keys =
    input.api_keys !== undefined
      ? serializeProviderKeys(input.api_keys)
      : serializeProviderKeys(parseProviderKeys(input.api_key ?? ""));
  db.prepare(
    `INSERT INTO providers (
      id, name, base_url, api_key, models, enabled, timeout_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.base_url.replace(/\/+$/, ""),
    keys,
    JSON.stringify(input.models ?? []),
    input.enabled === false ? 0 : 1,
    input.timeout_ms ?? 60000,
    now,
    now,
  );
  refreshProviderCache();
  return getProvider(id)!;
}

export function updateProvider(
  id: string,
  input: Partial<{
    name: string;
    base_url: string;
    api_key: string;
    api_keys: string[];
    models: string[];
    enabled: boolean;
    timeout_ms: number;
  }>,
): Provider | null {
  const existing = getProvider(id);
  if (!existing) return null;

  const name = input.name ?? existing.name;
  const base_url = (input.base_url ?? existing.base_url).replace(/\/+$/, "");

  let api_key = existing.api_key;
  if (input.api_keys !== undefined) {
    // Empty array clears all keys — intentional for editable full list
    api_key = serializeProviderKeys(input.api_keys);
  } else if (input.api_key !== undefined) {
    // Allow multi-line string update (empty string clears)
    api_key = serializeProviderKeys(parseProviderKeys(input.api_key));
  }

  const models =
    input.models !== undefined
      ? JSON.stringify(input.models)
      : existing.models;
  const enabled =
    input.enabled !== undefined
      ? input.enabled
        ? 1
        : 0
      : existing.enabled;
  const timeout_ms = input.timeout_ms ?? existing.timeout_ms;

  db.prepare(
    `UPDATE providers SET
      name = ?, base_url = ?, api_key = ?, models = ?, enabled = ?,
      timeout_ms = ?, updated_at = ?
     WHERE id = ?`,
  ).run(name, base_url, api_key, models, enabled, timeout_ms, nowIso(), id);

  refreshProviderCache();
  return getProvider(id)!;
}

export function deleteProvider(id: string): boolean {
  keyCursor.delete(id);
  const deleted = db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
  if (deleted) refreshProviderCache();
  return deleted;
}

export function listProvidersForModel(model?: string | null): Provider[] {
  const providers = listProviders().filter((p) => p.enabled === 1);
  if (providers.length === 0) return [];
  if (!model) return providers;

  const exact = providers.filter((provider) => {
    const models = providerRuntime.get(provider.id)?.models ?? safeParseModels(provider.models);
    return models.includes(model) || models.includes("*");
  });
  if (exact.length) return exact;

  const lower = model.toLowerCase();
  return providers.filter((provider) => {
    const models = providerRuntime.get(provider.id)?.models ?? safeParseModels(provider.models);
    return models.some(
      (candidate) => lower.startsWith(candidate.toLowerCase()) || candidate.toLowerCase().startsWith(lower),
    );
  });
}

export function resolveProviderForModel(model?: string | null): Provider | null {
  return listProvidersForModel(model)[0] ?? null;
}

export function sanitizeProvider(p: Provider) {
  const runtime = providerRuntime.get(p.id);
  const keys = runtime?.keys ?? parseProviderKeys(p.api_key);
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: keys[0] ?? "",
    api_keys: keys,
    key_count: keys.length,
    has_api_key: keys.length > 0,
    models: runtime?.models ?? safeParseModels(p.models),
    enabled: p.enabled === 1,
    timeout_ms: p.timeout_ms,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function safeParseModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
