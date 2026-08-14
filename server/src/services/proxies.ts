import { v4 as uuid } from "uuid";
import fetch from "node-fetch";
import { db, getSetting, ProxyLibrary, ProxyNode } from "../db";
import { proxyAgentFor } from "./proxy-agent-pool";
import { nowIso } from "../utils/time";
import { encryptSecret, tryDecryptSecret } from "../utils/secrets";

// ---------------------------------------------------------------------------
// URL parsing (http / https / socks4 / socks5, optional auth)
// ---------------------------------------------------------------------------

export type ProxyTarget = {
  type: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  userId?: string;
  password?: string;
};

export const PROXY_PROTOCOLS = ["http", "https", "socks4", "socks5"] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

const DEFAULT_PORTS: Record<ProxyProtocol, number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};

/** Parse a proxy URL; returns null when the scheme/host/port are invalid. */
export function parseProxyUrl(raw: string): ProxyTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  let type: ProxyProtocol;
  if (scheme === "http") type = "http";
  else if (scheme === "https") type = "https";
  else if (scheme === "socks4" || scheme === "socks4a") type = "socks4";
  else if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h") type = "socks5";
  else return null;
  const port = Number(url.port || DEFAULT_PORTS[type]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = url.hostname;
  if (!host) return null;
  const out: ProxyTarget = { type, host, port };
  if (url.username || url.password) {
    out.userId = decodeURIComponent(url.username);
    if (url.password) out.password = decodeURIComponent(url.password);
  }
  return out;
}

/**
 * Normalize one line of a proxy library: bare "host:port" lines get the
 * library's default protocol prepended; lines with a scheme are validated.
 * Returns null for invalid/empty lines.
 */
export function normalizeProxyLine(line: string, defaultProtocol: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  if (!hasScheme) {
    const m = trimmed.match(/^([^:]+):(\d{1,5})$/);
    if (!m) return null;
    const protocol = (PROXY_PROTOCOLS as readonly string[]).includes(defaultProtocol)
      ? defaultProtocol
      : "http";
    return `${protocol}://${m[1]}:${m[2]}`;
  }
  return parseProxyUrl(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Manual proxy nodes
// ---------------------------------------------------------------------------

let nodeCache: ProxyNode[] | null = null;

function loadNodes(): ProxyNode[] {
  const rows = db
    .prepare("SELECT * FROM proxy_nodes WHERE library_id IS NULL ORDER BY created_at DESC")
    .all() as ProxyNode[];
  const update = db.prepare("UPDATE proxy_nodes SET url = ? WHERE id = ?");
  for (const row of rows) {
    if (!row.url) continue;
    const encrypted = encryptSecret(row.url);
    if (encrypted !== row.url) {
      update.run(encrypted, row.id);
      row.url = encrypted;
    }
  }
  return rows;
}

function ensureNodeCache() {
  if (nodeCache) return;
  nodeCache = loadNodes();
}

export function refreshProxyNodeCache() {
  nodeCache = loadNodes();
}

/** Manual nodes only (library nodes are listed per-library). */
export function listProxyNodes(): ProxyNode[] {
  ensureNodeCache();
  return nodeCache!;
}

export function getProxyNode(id: string): ProxyNode | undefined {
  return db.prepare("SELECT * FROM proxy_nodes WHERE id = ?").get(id) as ProxyNode | undefined;
}

export function listProxyNodesByLibrary(libraryId: string): ProxyNode[] {
  return db
    .prepare("SELECT * FROM proxy_nodes WHERE library_id = ? ORDER BY created_at ASC")
    .all(libraryId) as ProxyNode[];
}

export function createProxyNode(input: {
  name: string;
  url: string;
  enabled?: boolean;
}): ProxyNode | null {
  const url = input.url.trim();
  if (!parseProxyUrl(url)) return null;
  const now = nowIso();
  const id = uuid();
  db.prepare(
    `INSERT INTO proxy_nodes (id, name, url, enabled, library_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.name.trim(), encryptSecret(url), input.enabled === false ? 0 : 1, now, now);
  refreshProxyNodeCache();
  return getProxyNode(id) ?? null;
}

export function updateProxyNode(
  id: string,
  input: Partial<{ name: string; url: string; enabled: boolean }>,
): ProxyNode | null {
  const existing = getProxyNode(id);
  if (!existing) return null;
  // Library-owned nodes are read-only: reject direct edits.
  if (existing.library_id !== null) return null;
  const url = input.url !== undefined ? input.url.trim() : existing.url;
  if (input.url !== undefined && !parseProxyUrl(url)) return null;
  db.prepare(
    `UPDATE proxy_nodes SET
      name = ?, url = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name !== undefined ? input.name.trim() : existing.name,
    input.url !== undefined ? encryptSecret(url) : existing.url,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    nowIso(),
    id,
  );
  refreshProxyNodeCache();
  return getProxyNode(id) ?? null;
}

export function deleteProxyNode(id: string): boolean {
  const existing = getProxyNode(id);
  if (!existing || existing.library_id !== null) return false;
  const deleted = db.prepare("DELETE FROM proxy_nodes WHERE id = ?").run(id).changes > 0;
  if (deleted) refreshProxyNodeCache();
  return deleted;
}

/** API-facing shape: decrypted url, boolean enabled. */
export function sanitizeProxyNode(n: ProxyNode) {
  return {
    id: n.id,
    name: n.name,
    url: tryDecryptSecret(n.url) ?? "",
    enabled: n.enabled === 1,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Proxy libraries (online lists; nodes are read-only and shown collapsed)
// ---------------------------------------------------------------------------

export function listProxyLibraries(): ProxyLibrary[] {
  return db.prepare("SELECT * FROM proxy_libraries ORDER BY created_at DESC").all() as ProxyLibrary[];
}

export function getProxyLibrary(id: string): ProxyLibrary | undefined {
  return db
    .prepare("SELECT * FROM proxy_libraries WHERE id = ?")
    .get(id) as ProxyLibrary | undefined;
}

export function createProxyLibrary(input: {
  name: string;
  url: string;
  default_protocol?: string;
  enabled?: boolean;
  auto_update?: boolean;
  update_interval_ms?: number;
}): ProxyLibrary | null {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const now = nowIso();
  const id = uuid();
  const protocol = (PROXY_PROTOCOLS as readonly string[]).includes(input.default_protocol ?? "")
    ? input.default_protocol!
    : "http";
  db.prepare(
    `INSERT INTO proxy_libraries (id, name, url, default_protocol, enabled, auto_update, update_interval_ms, last_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    url,
    protocol,
    input.enabled === false ? 0 : 1,
    input.auto_update === true ? 1 : 0,
    Math.max(60_000, Math.floor(input.update_interval_ms ?? 3_600_000)),
    now,
    now,
  );
  return getProxyLibrary(id) ?? null;
}

export function updateProxyLibrary(
  id: string,
  input: Partial<{
    name: string;
    url: string;
    default_protocol: string;
    enabled: boolean;
    auto_update: boolean;
    update_interval_ms: number;
  }>,
): ProxyLibrary | null {
  const existing = getProxyLibrary(id);
  if (!existing) return null;
  const url = input.url !== undefined ? input.url.trim() : existing.url;
  if (input.url !== undefined && !/^https?:\/\//i.test(url)) return null;
  const protocol = input.default_protocol !== undefined
    ? (PROXY_PROTOCOLS as readonly string[]).includes(input.default_protocol)
      ? input.default_protocol
      : existing.default_protocol
    : existing.default_protocol;
  db.prepare(
    `UPDATE proxy_libraries SET
      name = ?, url = ?, default_protocol = ?, enabled = ?, auto_update = ?,
      update_interval_ms = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name !== undefined ? input.name.trim() : existing.name,
    url,
    protocol,
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    input.auto_update !== undefined ? (input.auto_update ? 1 : 0) : existing.auto_update,
    input.update_interval_ms !== undefined
      ? Math.max(60_000, Math.floor(input.update_interval_ms))
      : existing.update_interval_ms,
    nowIso(),
    id,
  );
  return getProxyLibrary(id) ?? null;
}

/** Deleting a library removes all of its nodes (they are read-only otherwise). */
export function deleteProxyLibrary(id: string): boolean {
  db.prepare("DELETE FROM proxy_nodes WHERE library_id = ?").run(id);
  const deleted = db.prepare("DELETE FROM proxy_libraries WHERE id = ?").run(id).changes > 0;
  if (deleted) refreshProxyNodeCache();
  return deleted;
}

export function sanitizeProxyLibrary(lib: ProxyLibrary) {
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM proxy_nodes WHERE library_id = ?")
    .get(lib.id) as { c: number };
  return {
    id: lib.id,
    name: lib.name,
    url: lib.url,
    default_protocol: lib.default_protocol,
    enabled: lib.enabled === 1,
    auto_update: lib.auto_update === 1,
    update_interval_ms: lib.update_interval_ms,
    last_updated_at: lib.last_updated_at,
    node_count: count.c,
    created_at: lib.created_at,
    updated_at: lib.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Library fetch / import
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
const MAX_LIBRARY_BYTES = 5 * 1024 * 1024;
const refreshing = new Set<string>();

// --- health checks ---------------------------------------------------------

export const DEFAULT_PROXY_TEST_URL = "https://www.gstatic.com/generate_204";
const HEALTH_CONCURRENCY = 20;
const HEALTH_TIMEOUT_MS = 10_000;

function proxyTestUrl(): string {
  const custom = getSetting("proxy_test_url");
  return custom && custom.trim() ? custom.trim() : DEFAULT_PROXY_TEST_URL;
}

/** One live probe: any HTTP response (any status) means the proxy link works. */
async function checkProxyAlive(proxyUrl: string, testUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(testUrl, {
      agent: proxyAgentFor(proxyUrl),
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "localapi-health/1.0", accept: "*/*" },
      timeout: HEALTH_TIMEOUT_MS,
    });
    res.body?.resume();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe all urls concurrently (bounded), return the subset that answered. */
async function filterAliveNodes(urls: string[], testUrl: string): Promise<string[]> {
  const alive: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const i = cursor;
      cursor += 1;
      if (await checkProxyAlive(urls[i], testUrl)) alive.push(urls[i]);
    }
  };
  const workers = Math.min(HEALTH_CONCURRENCY, Math.max(1, urls.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return alive;
}

async function fetchLibraryText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "text/plain,text/*,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_LIBRARY_BYTES) throw new Error("Library exceeds size limit");
    return buffer.toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * (Re)import a library: fetch the URL, normalize lines, then reconcile the
 * library's nodes (add missing, drop stale, keep existing). Idempotent; a
 * concurrent refresh for the same library is a no-op.
 */
export async function refreshProxyLibrary(
  libraryId: string,
): Promise<{
  added: number;
  removed: number;
  total: number;
  alive: number;
  dead: number;
  skipped?: boolean;
} | null> {
  const library = getProxyLibrary(libraryId);
  if (!library) return null;
  if (refreshing.has(libraryId)) return null;
  refreshing.add(libraryId);
  try {
    const text = await fetchLibraryText(library.url);
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const normalized = normalizeProxyLine(line, library.default_protocol);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    }

    // Concurrent health probe: drop dead nodes before they enter the pool.
    let aliveUrls: string[];
    if (urls.length > 0) {
      aliveUrls = await filterAliveNodes(urls, proxyTestUrl());
      // All dead is almost certainly an environment issue (test URL
      // unreachable, DNS/network down), not every node being dead: keep the
      // current pool untouched and let the next refresh try again.
      if (aliveUrls.length === 0) {
        return {
          added: 0,
          removed: 0,
          total: urls.length,
          alive: 0,
          dead: urls.length,
          skipped: true,
        };
      }
    } else {
      aliveUrls = [];
    }

    const existing = listProxyNodesByLibrary(libraryId);
    const existingByUrl = new Map(
      existing.map((node) => [tryDecryptSecret(node.url) ?? node.url, node]),
    );

    const now = nowIso();
    const insert = db.prepare(
      `INSERT INTO proxy_nodes (id, name, url, enabled, library_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const url of aliveUrls) {
      if (existingByUrl.has(url)) continue;
      insert.run(uuid(), url, encryptSecret(url), 1, libraryId, now, now);
      added += 1;
    }

    const keep = new Set(aliveUrls);
    const remove = db.prepare("DELETE FROM proxy_nodes WHERE id = ?");
    let removed = 0;
    for (const node of existing) {
      const plain = tryDecryptSecret(node.url) ?? node.url;
      if (keep.has(plain)) continue;
      remove.run(node.id);
      removed += 1;
    }

    db.prepare("UPDATE proxy_libraries SET last_updated_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      libraryId,
    );
    refreshProxyNodeCache();
    return {
      added,
      removed,
      total: urls.length,
      alive: aliveUrls.length,
      dead: urls.length - aliveUrls.length,
    };
  } finally {
    refreshing.delete(libraryId);
  }
}
