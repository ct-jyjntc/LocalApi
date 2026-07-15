import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dataDir = path.resolve(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "localapi.db");
export const db: Database.Database = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Keep the synchronous SQLite calls short and cooperative under concurrent load.
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("temp_store = MEMORY");
db.pragma("cache_size = -32768");
db.pragma("mmap_size = 268435456");

const settingsCache = new Map<string, string>();
let settingsCacheReady = false;

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 60000,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      key_plain TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cache_entries (
      id TEXT PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_headers TEXT NOT NULL DEFAULT '{}',
      response_body TEXT NOT NULL,
      body_size INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      ttl_seconds INTEGER NOT NULL DEFAULT 3600,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_hit_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cache_key ON cache_entries(cache_key);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      provider_id TEXT,
      provider_name TEXT,
      api_key_id TEXT,
      api_key_name TEXT,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      cached INTEGER NOT NULL DEFAULT 0,
      request_bytes INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      input_text TEXT,
      output_text TEXT,
      reasoning_text TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      stream INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
  `);

  // Migrate older DBs that lack detail columns
  const keyCols = (
    db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!keyCols.includes("key_plain")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN key_plain TEXT");
  }

  const logCols = (
    db.prepare("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  const addLogCol = (name: string, ddl: string) => {
    if (!logCols.includes(name)) {
      db.exec(`ALTER TABLE request_logs ADD COLUMN ${ddl}`);
    }
  };
  addLogCol("input_text", "input_text TEXT");
  addLogCol("output_text", "output_text TEXT");
  addLogCol("reasoning_text", "reasoning_text TEXT");
  addLogCol("prompt_tokens", "prompt_tokens INTEGER NOT NULL DEFAULT 0");
  addLogCol("completion_tokens", "completion_tokens INTEGER NOT NULL DEFAULT 0");
  addLogCol("reasoning_tokens", "reasoning_tokens INTEGER NOT NULL DEFAULT 0");
  addLogCol("cached_tokens", "cached_tokens INTEGER NOT NULL DEFAULT 0");
  addLogCol("total_tokens", "total_tokens INTEGER NOT NULL DEFAULT 0");
  addLogCol("stream", "stream INTEGER NOT NULL DEFAULT 0");

  db.exec(`

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaults: Record<string, string> = {
    // Local response cache is disabled — only upstream usage.cached_tokens is tracked.
    cache_enabled: "false",
    cache_ttl_seconds: "3600",
    cache_max_entries: "1000",
    cache_methods: '["GET","POST"]',
    cache_paths: '["/v1/chat/completions","/v1/embeddings","/v1/models"]',
    admin_token: "a2366021253",
    port: "5555",
    // Upstream request retries (network / 429 / 5xx). 0 = no retry.
    max_retries: "2",
    retry_delay_ms: "400",
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }

  // Force-disable any previously enabled local response cache
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('cache_enabled', 'false')
     ON CONFLICT(key) DO UPDATE SET value = 'false'`,
  ).run();

  // Migrate legacy default admin password → user-specified password
  const currentAdmin = getSetting("admin_token");
  if (!currentAdmin || currentAdmin === "localapi-admin") {
    setSetting("admin_token", "a2366021253");
  }

  // Force single-port deployment
  const currentPort = getSetting("port");
  if (!currentPort || currentPort === "8787" || currentPort === "5173") {
    setSetting("port", "5555");
  }

  refreshSettingsCache();
}

export type Provider = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string;
  enabled: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
};

export type ApiKey = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_plain: string | null;
  enabled: number;
  rate_limit: number;
  created_at: string;
  last_used_at: string | null;
};

export type CacheEntry = {
  id: string;
  cache_key: string;
  method: string;
  path: string;
  model: string | null;
  request_hash: string;
  status_code: number;
  response_headers: string;
  response_body: string;
  body_size: number;
  hit_count: number;
  ttl_seconds: number;
  created_at: string;
  expires_at: string;
  last_hit_at: string | null;
};

export type RequestLog = {
  id: string;
  method: string;
  path: string;
  model: string | null;
  provider_id: string | null;
  provider_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  status_code: number;
  latency_ms: number;
  cached: number;
  request_bytes: number;
  response_bytes: number;
  error: string | null;
  created_at: string;
  input_text: string | null;
  output_text: string | null;
  reasoning_text: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  stream: number;
};

export function getSetting(key: string): string | null {
  if (settingsCacheReady) return settingsCache.get(key) ?? null;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
  settingsCache.set(key, value);
}

export function getAllSettings(): Record<string, string> {
  if (settingsCacheReady) return Object.fromEntries(settingsCache);
  return Object.fromEntries(
    (db.prepare("SELECT key, value FROM settings").all() as Array<{
      key: string;
      value: string;
    }>).map((r) => [r.key, r.value]),
  );
}

function refreshSettingsCache() {
  settingsCache.clear();
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  for (const row of rows) settingsCache.set(row.key, row.value);
  settingsCacheReady = true;
}
