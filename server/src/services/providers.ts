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
const providerRuntime = new Map<
  string,
  { keys: string[]; models: string[]; mappings: Record<string, string> }
>();

function rebuildProviderRuntime(rows: Provider[]) {
  providerRuntime.clear();
  for (const row of rows) {
    providerRuntime.set(row.id, {
      keys: parseProviderKeys(row.api_key),
      models: safeParseModels(row.models),
      mappings: safeParseMappings(row.model_mappings),
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
  model_mappings?: Record<string, string>;
  enabled?: boolean;
  timeout_ms?: number;
}): Provider {
  const now = nowIso();
  const id = uuid();
  const keys =
    input.api_keys !== undefined
      ? serializeProviderKeys(input.api_keys)
      : serializeProviderKeys(parseProviderKeys(input.api_key ?? ""));
  const models = normalizeModels(input.models ?? []);
  const mappings = normalizeMappings(input.model_mappings ?? {}, models);
  db.prepare(
    `INSERT INTO providers (
      id, name, base_url, api_key, models, model_mappings, enabled, timeout_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.base_url.replace(/\/+$/, ""),
    keys,
    JSON.stringify(models),
    JSON.stringify(mappings),
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
    model_mappings: Record<string, string>;
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
      ? normalizeModels(input.models)
      : safeParseModels(existing.models);
  const mappings =
    input.model_mappings !== undefined || input.models !== undefined
      ? normalizeMappings(
          input.model_mappings !== undefined
            ? input.model_mappings
            : safeParseMappings(existing.model_mappings),
          models,
        )
      : safeParseMappings(existing.model_mappings);
  const enabled =
    input.enabled !== undefined
      ? input.enabled
        ? 1
        : 0
      : existing.enabled;
  const timeout_ms = input.timeout_ms ?? existing.timeout_ms;

  db.prepare(
    `UPDATE providers SET
      name = ?, base_url = ?, api_key = ?, models = ?, model_mappings = ?, enabled = ?,
      timeout_ms = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    base_url,
    api_key,
    JSON.stringify(models),
    JSON.stringify(mappings),
    enabled,
    timeout_ms,
    nowIso(),
    id,
  );

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
  return exact;
}

export function resolveProviderForModel(model?: string | null): Provider | null {
  return listProvidersForModel(model)[0] ?? null;
}

export function sanitizeProvider(p: Provider) {
  const runtime = providerRuntime.get(p.id);
  const keys = runtime?.keys ?? parseProviderKeys(p.api_key);
  const models = runtime?.models ?? safeParseModels(p.models);
  const model_mappings = runtime?.mappings ?? safeParseMappings(p.model_mappings);
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    api_key: "",
    api_keys: [],
    key_count: keys.length,
    has_api_key: keys.length > 0,
    models,
    model_mappings,
    enabled: p.enabled === 1,
    timeout_ms: p.timeout_ms,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** Map a public/client model name to the upstream model name for this provider. */
export function mapProviderModel(provider: Provider, publicModel: string): string {
  const model = publicModel.trim();
  if (!model) return model;
  const mappings =
    providerRuntime.get(provider.id)?.mappings ?? safeParseMappings(provider.model_mappings);
  const mapped = mappings[model]?.trim();
  return mapped || model;
}

/**
 * Parse editor lines:
 *   public-model
 *   public-model => upstream-model
 *   public-model -> upstream-model
 */
export function parseModelsEditor(raw: string): {
  models: string[];
  model_mappings: Record<string, string>;
} {
  const models: string[] = [];
  const model_mappings: Record<string, string> = {};
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)\s*(?:=>|->|=)\s*(.+)$/);
    const publicName = (match ? match[1] : trimmed).trim();
    const upstreamName = (match ? match[2] : "").trim();
    if (!publicName || publicName === "*") {
      if (publicName === "*" && !seen.has("*")) {
        models.push("*");
        seen.add("*");
      }
      continue;
    }
    if (!seen.has(publicName)) {
      models.push(publicName);
      seen.add(publicName);
    }
    if (upstreamName && upstreamName !== publicName) {
      model_mappings[publicName] = upstreamName;
    }
  }

  return { models, model_mappings };
}

export function formatModelsEditor(
  models: string[],
  mappings: Record<string, string> = {},
): string {
  return models
    .map((model) => {
      const upstream = mappings[model]?.trim();
      return upstream && upstream !== model ? `${model} => ${upstream}` : model;
    })
    .join("\n");
}

function safeParseModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeParseMappings(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const publicName = String(key || "").trim();
      const upstream = String(value ?? "").trim();
      if (!publicName || publicName === "*" || !upstream || upstream === publicName) continue;
      out[publicName] = upstream;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeModels(models: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of models) {
    const model = String(item || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

function normalizeMappings(
  mappings: Record<string, string>,
  models: string[],
): Record<string, string> {
  const allowed = new Set(models.filter((m) => m && m !== "*"));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mappings || {})) {
    const publicName = String(key || "").trim();
    const upstream = String(value ?? "").trim();
    if (!publicName || publicName === "*" || !upstream || upstream === publicName) continue;
    if (allowed.size > 0 && !allowed.has(publicName)) continue;
    out[publicName] = upstream;
  }
  return out;
}
