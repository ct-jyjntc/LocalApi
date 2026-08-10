import { v4 as uuid } from "uuid";
import { db, ProxyNode } from "../db";
import { nowIso } from "../utils/time";
import { encryptSecret, tryDecryptSecret } from "../utils/secrets";

let nodeCache: ProxyNode[] | null = null;

/** Parse a proxy node URL into the socks library shape, or null when invalid. */
export type SocksTarget =
  | { type: 5; host: string; port: number; userId?: string; password?: string }
  | { type: 4; host: string; port: number; userId?: string };

export function parseProxyUrl(raw: string): SocksTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  let type: 4 | 5;
  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h") type = 5;
  else if (scheme === "socks4" || scheme === "socks4a") type = 4;
  else return null;
  const port = Number(url.port || (type === 4 ? 1080 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = url.hostname;
  if (!host) return null;
  const base = { type, host, port } as SocksTarget;
  if (url.username || url.password) {
    base.userId = decodeURIComponent(url.username);
    if (type === 5) {
      (base as { password?: string }).password = decodeURIComponent(url.password);
    }
  }
  return base;
}


function loadNodes(): ProxyNode[] {
  const rows = db.prepare("SELECT * FROM proxy_nodes ORDER BY created_at DESC").all() as ProxyNode[];
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

export function listProxyNodes(): ProxyNode[] {
  ensureNodeCache();
  return nodeCache!;
}

export function getProxyNode(id: string): ProxyNode | undefined {
  return db.prepare("SELECT * FROM proxy_nodes WHERE id = ?").get(id) as ProxyNode | undefined;
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
    `INSERT INTO proxy_nodes (id, name, url, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    encryptSecret(url),
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  refreshProxyNodeCache();
  return getProxyNode(id) ?? null;
}

export function updateProxyNode(
  id: string,
  input: Partial<{ name: string; url: string; enabled: boolean }>,
): ProxyNode | null {
  const existing = getProxyNode(id);
  if (!existing) return null;
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
