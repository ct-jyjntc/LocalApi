import { v4 as uuid } from "uuid";
import { db, Provider } from "../db";
import { nowIso } from "../utils/time";
import { encryptSecret, tryDecryptSecret } from "../utils/secrets";
import { getProxyLibrary, getProxyNode, listProxyNodesByLibrary } from "./proxies";
/** Parse stored provider key field into a list of non-empty keys. */
export function parseProviderKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Undecryptable credentials (wrong/missing SECRETS_KEY) parse to an empty
  // key list instead of throwing on the proxy path.
  const s = (tryDecryptSecret(raw) ?? "").trim();
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
const proxyCursor = new Map<string, number>();
let providerCache: Provider[] | null = null;
const providerRuntime = new Map<
  string,
  { keys: string[]; models: string[]; mappings: Record<string, string>; proxyIds: string[] }
>();

function rebuildProviderRuntime(rows: Provider[]) {
  providerRuntime.clear();
  for (const row of rows) {
    providerRuntime.set(row.id, {
      keys: parseProviderKeys(row.api_key),
      models: safeParseModels(row.models),
      mappings: safeParseMappings(row.model_mappings),
      proxyIds: safeParseProxyIds(row.proxy_ids),
    });
  }
}

function loadProviders() {
  const rows = db
    .prepare("SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC")
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

/**
 * Round-robin pick among the provider's assigned proxy nodes.
 * Returns the selected node's id, or null when the provider has no proxy.
 */
export function pickProviderProxy(provider: Provider): string | null {
  const ids = providerRuntime.get(provider.id)?.proxyIds ?? safeParseProxyIds(provider.proxy_ids);
  if (ids.length === 0) return null;
  // Candidate pool: plain node ids plus library ids expanded to their nodes.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const node = getProxyNode(id);
    if (node && node.enabled === 1) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        candidates.push(node.id);
      }
      continue;
    }
    const library = getProxyLibrary(id);
    if (library && library.enabled === 1) {
      for (const n of listProxyNodesByLibrary(id)) {
        if (n.enabled !== 1 || seen.has(n.id)) continue;
        seen.add(n.id);
        candidates.push(n.id);
      }
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const idx = proxyCursor.get(provider.id) ?? 0;
  const picked = candidates[idx % candidates.length];
  proxyCursor.set(provider.id, idx + 1);
  return picked;
}

/** Sanitize custom headers: only allow string values, drop empty keys. */
function sanitizeCustomHeaders(input?: Record<string, string>): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = k.trim();
    if (!key || key.toLowerCase() === "authorization" || key.toLowerCase() === "host") continue;
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return out;
}

function safeParseCustomHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    return sanitizeCustomHeaders(JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

/** Next sort_order value for a new provider (appends to the end). */
function nextSortOrder(): number {
  const row = db.prepare("SELECT MAX(sort_order) AS m FROM providers").get() as { m: number | null } | undefined;
  return (row?.m ?? -1) + 1;
}

/** Reorder providers by dragging. Accepts an ordered list of provider ids. */
export function reorderProviders(orderedIds: string[]) {
  const now = nowIso();
  const update = db.prepare("UPDATE providers SET sort_order = ?, updated_at = ? WHERE id = ?");
  db.transaction(() => {
    orderedIds.forEach((id, idx) => update.run(idx, now, id));
  })();
  refreshProviderCache();
  return true;
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
  proxy_ids?: string[];
  enabled?: boolean;
  timeout_ms?: number;
  custom_headers?: Record<string, string>;
}): Provider {
  const now = nowIso();
  const id = uuid();
  const keys =
    input.api_keys !== undefined
      ? serializeProviderKeys(input.api_keys)
      : serializeProviderKeys(parseProviderKeys(input.api_key ?? ""));
  const models = normalizeModels(input.models ?? []);
  const mappings = normalizeMappings(input.model_mappings ?? {}, models);
  const proxyIds = normalizeProxyIds(input.proxy_ids ?? []);
  db.prepare(
    `INSERT INTO providers (
      id, name, base_url, api_key, models, model_mappings, proxy_ids, enabled, timeout_ms, sort_order, custom_headers, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.base_url.replace(/\/+$/, ""),
    keys,
    JSON.stringify(models),
    JSON.stringify(mappings),
    JSON.stringify(proxyIds),
    input.enabled === false ? 0 : 1,
    input.timeout_ms ?? 60000,
    nextSortOrder(),
    JSON.stringify(sanitizeCustomHeaders(input.custom_headers)),
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
    proxy_ids: string[];
    enabled?: boolean;
    timeout_ms?: number;
    custom_headers?: Record<string, string>;
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
  const proxyIds =
    input.proxy_ids !== undefined
      ? normalizeProxyIds(input.proxy_ids)
      : safeParseProxyIds(existing.proxy_ids);
  const enabled =
    input.enabled !== undefined
      ? input.enabled
        ? 1
        : 0
      : existing.enabled;
  const timeout_ms = input.timeout_ms ?? existing.timeout_ms;
  const customHeaders =
    input.custom_headers !== undefined
      ? sanitizeCustomHeaders(input.custom_headers)
      : safeParseCustomHeaders(existing.custom_headers);

  db.prepare(
    `UPDATE providers SET
      name = ?, base_url = ?, api_key = ?, models = ?, model_mappings = ?, proxy_ids = ?,
      enabled = ?, timeout_ms = ?, custom_headers = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    base_url,
    api_key,
    JSON.stringify(models),
    JSON.stringify(mappings),
    JSON.stringify(proxyIds),
    enabled,
    timeout_ms,
    JSON.stringify(customHeaders),
    nowIso(),
    id,
  );

  refreshProviderCache();
  return getProvider(id)!;
}

export function deleteProvider(id: string): boolean {
  keyCursor.delete(id);
  proxyCursor.delete(id);
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
  const proxy_ids = runtime?.proxyIds ?? safeParseProxyIds(p.proxy_ids);
  const custom_headers = safeParseCustomHeaders(p.custom_headers);
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
    proxy_ids,
    enabled: p.enabled === 1,
    timeout_ms: p.timeout_ms,
    sort_order: p.sort_order,
    custom_headers,
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

function safeParseProxyIds(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeProxyIds(ids: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of ids) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
