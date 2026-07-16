import { v4 as uuid } from "uuid";
import {
  CacheEntry,
  db,
  getSetting,
  setSetting,
} from "../db";
import { buildCacheKey } from "../utils/hash";
import { addSecondsIso, isExpired, nowIso } from "../utils/time";

export type CacheLookupResult =
  | { hit: true; entry: CacheEntry }
  | { hit: false };

function parseJsonArray(raw: string | null, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

export function getCacheConfig() {
  return {
    enabled: getSetting("cache_enabled") !== "false",
    ttlSeconds: Math.max(1, Number(getSetting("cache_ttl_seconds") || 3600)),
    maxEntries: Math.max(10, Number(getSetting("cache_max_entries") || 1000)),
    methods: parseJsonArray(getSetting("cache_methods"), ["GET"]).map(
      (m) => m.toUpperCase(),
    ),
    paths: parseJsonArray(getSetting("cache_paths"), [
      "/v1/models",
    ]),
  };
}

export function updateCacheConfig(partial: Partial<{
  enabled: boolean;
  ttlSeconds: number;
  maxEntries: number;
  methods: string[];
  paths: string[];
}>) {
  if (partial.enabled !== undefined) {
    setSetting("cache_enabled", partial.enabled ? "true" : "false");
  }
  if (partial.ttlSeconds !== undefined) {
    setSetting("cache_ttl_seconds", String(Math.max(1, partial.ttlSeconds)));
  }
  if (partial.maxEntries !== undefined) {
    setSetting("cache_max_entries", String(Math.max(10, partial.maxEntries)));
  }
  if (partial.methods !== undefined) {
    setSetting(
      "cache_methods",
      JSON.stringify(partial.methods.map((m) => m.toUpperCase())),
    );
  }
  if (partial.paths !== undefined) {
    setSetting("cache_paths", JSON.stringify(partial.paths));
  }
  return getCacheConfig();
}

export function purgeExpired() {
  db.prepare("DELETE FROM cache_entries WHERE expires_at <= ?").run(nowIso());
}

function enforceMaxEntries(maxEntries: number) {
  const count = (
    db.prepare("SELECT COUNT(*) as c FROM cache_entries").get() as { c: number }
  ).c;
  if (count <= maxEntries) return;

  const overflow = count - maxEntries;
  db.prepare(
    `DELETE FROM cache_entries WHERE id IN (
      SELECT id FROM cache_entries
      ORDER BY COALESCE(last_hit_at, created_at) ASC
      LIMIT ?
    )`,
  ).run(overflow);
}

export function isCacheable(
  method: string,
  path: string,
  body?: unknown,
): boolean {
  const cfg = getCacheConfig();
  if (!cfg.enabled) return false;
  if (!cfg.methods.includes(method.toUpperCase())) return false;

  const normalized = path.split("?")[0];
  if (!cfg.paths.some((p) => normalized === p || normalized.startsWith(`${p}/`))) {
    return false;
  }

  // Never cache streaming responses
  if (body && typeof body === "object" && (body as { stream?: boolean }).stream) {
    return false;
  }

  return true;
}

export function lookupCache(params: {
  method: string;
  path: string;
  model?: string | null;
  body?: unknown;
  query?: Record<string, unknown>;
}): CacheLookupResult {
  purgeExpired();
  if (!isCacheable(params.method, params.path, params.body)) {
    return { hit: false };
  }

  const cacheKey = buildCacheKey(params);
  const entry = db
    .prepare("SELECT * FROM cache_entries WHERE cache_key = ?")
    .get(cacheKey) as CacheEntry | undefined;

  if (!entry) return { hit: false };
  if (isExpired(entry.expires_at)) {
    db.prepare("DELETE FROM cache_entries WHERE id = ?").run(entry.id);
    return { hit: false };
  }

  db.prepare(
    `UPDATE cache_entries
     SET hit_count = hit_count + 1, last_hit_at = ?
     WHERE id = ?`,
  ).run(nowIso(), entry.id);

  const refreshed = db
    .prepare("SELECT * FROM cache_entries WHERE id = ?")
    .get(entry.id) as CacheEntry;

  return { hit: true, entry: refreshed };
}

export function storeCache(params: {
  method: string;
  path: string;
  model?: string | null;
  body?: unknown;
  query?: Record<string, unknown>;
  statusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  ttlSeconds?: number;
}) {
  if (!isCacheable(params.method, params.path, params.body)) return null;
  if (params.statusCode < 200 || params.statusCode >= 300) return null;

  const cfg = getCacheConfig();
  const ttl = params.ttlSeconds ?? cfg.ttlSeconds;
  const cacheKey = buildCacheKey({
    method: params.method,
    path: params.path,
    model: params.model,
    body: params.body,
    query: params.query,
  });
  const now = nowIso();
  const id = uuid();

  db.prepare(
    `INSERT INTO cache_entries (
      id, cache_key, method, path, model, request_hash, status_code,
      response_headers, response_body, body_size, hit_count, ttl_seconds,
      created_at, expires_at, last_hit_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)
    ON CONFLICT(cache_key) DO UPDATE SET
      status_code = excluded.status_code,
      response_headers = excluded.response_headers,
      response_body = excluded.response_body,
      body_size = excluded.body_size,
      ttl_seconds = excluded.ttl_seconds,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      last_hit_at = NULL`,
  ).run(
    id,
    cacheKey,
    params.method.toUpperCase(),
    params.path,
    params.model ?? null,
    cacheKey,
    params.statusCode,
    JSON.stringify(params.responseHeaders),
    params.responseBody,
    Buffer.byteLength(params.responseBody, "utf8"),
    ttl,
    now,
    addSecondsIso(ttl),
  );

  enforceMaxEntries(cfg.maxEntries);

  return db
    .prepare("SELECT * FROM cache_entries WHERE cache_key = ?")
    .get(cacheKey) as CacheEntry;
}

export function listCache(limit = 100, offset = 0) {
  purgeExpired();
  const rows = db
    .prepare(
      `SELECT id, cache_key, method, path, model, status_code, body_size,
              hit_count, ttl_seconds, created_at, expires_at, last_hit_at
       FROM cache_entries
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<Omit<CacheEntry, "response_body" | "response_headers" | "request_hash">>;

  const total = (
    db.prepare("SELECT COUNT(*) as c FROM cache_entries").get() as { c: number }
  ).c;

  return { items: rows, total };
}

export function getCacheStats() {
  purgeExpired();
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM cache_entries").get() as { c: number }
  ).c;
  const size = (
    db.prepare("SELECT COALESCE(SUM(body_size), 0) as s FROM cache_entries").get() as {
      s: number;
    }
  ).s;
  const hits = (
    db.prepare("SELECT COALESCE(SUM(hit_count), 0) as h FROM cache_entries").get() as {
      h: number;
    }
  ).h;
  const logStats = db
    .prepare(
      `SELECT
         COUNT(*) as total_requests,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) as cache_hits
       FROM request_logs`,
    )
    .get() as { total_requests: number; cache_hits: number };

  const totalReq = logStats.total_requests || 0;
  const cacheHits = logStats.cache_hits || 0;

  return {
    entries: total,
    totalBytes: size,
    cumulativeHits: hits,
    requestHits: cacheHits,
    requestTotal: totalReq,
    hitRate: totalReq > 0 ? cacheHits / totalReq : 0,
    config: getCacheConfig(),
  };
}

export function deleteCacheEntry(id: string) {
  const result = db.prepare("DELETE FROM cache_entries WHERE id = ?").run(id);
  return result.changes > 0;
}

export function clearCache() {
  const result = db.prepare("DELETE FROM cache_entries").run();
  return result.changes;
}
