import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { encryptSecret } from "../utils/secrets";

const dataDir = path.resolve(process.env.LOCALAPI_DATA_DIR || path.join(process.cwd(), "data"));
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

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      allowed_models TEXT NOT NULL DEFAULT '[]',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS wallet_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance_micros INTEGER NOT NULL DEFAULT 0,
      reserved_micros INTEGER NOT NULL DEFAULT 0,
      lifetime_spent_micros INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_prices (
      model TEXT PRIMARY KEY,
      input_price_micros INTEGER NOT NULL DEFAULT 0,
      output_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_read_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_write_price_micros INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      cycle_days INTEGER NOT NULL DEFAULT 30,
      included_credits_micros INTEGER NOT NULL DEFAULT 0,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 0,
      overage_enabled INTEGER NOT NULL DEFAULT 1,
      stock_limit INTEGER NOT NULL DEFAULT 0,
      stock_used INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL DEFAULT 'active',
      starts_at TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      remaining_credits_micros INTEGER NOT NULL DEFAULT 0,
      reserved_micros INTEGER NOT NULL DEFAULT 0,
      auto_renew INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, period_end);

    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      api_key_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      status_code INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      input_price_micros INTEGER NOT NULL DEFAULT 0,
      output_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_read_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_write_price_micros INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      plan_cost_micros INTEGER NOT NULL DEFAULT 0,
      wallet_cost_micros INTEGER NOT NULL DEFAULT 0,
      reserved_plan_micros INTEGER NOT NULL DEFAULT 0,
      reserved_wallet_micros INTEGER NOT NULL DEFAULT 0,
      subscription_id TEXT,
      estimated_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_completion_tokens INTEGER NOT NULL DEFAULT 0,
      billing_mode TEXT NOT NULL DEFAULT 'wallet',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_records(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_key_created ON usage_records(api_key_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      balance_after_micros INTEGER NOT NULL,
      usage_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
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
      stream INTEGER NOT NULL DEFAULT 0,
      user_id TEXT,
      usage_id TEXT,
      cost_micros INTEGER NOT NULL DEFAULT 0
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
  const addKeyCol = (name: string, ddl: string) => {
    if (!keyCols.includes(name)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${ddl}`);
  };
  addKeyCol("user_id", "user_id TEXT");
  addKeyCol("allowed_models", "allowed_models TEXT NOT NULL DEFAULT '[]'");
  addKeyCol("tpm_limit", "tpm_limit INTEGER NOT NULL DEFAULT 0");
  addKeyCol("concurrency_limit", "concurrency_limit INTEGER NOT NULL DEFAULT 0");
  addKeyCol("expires_at", "expires_at TEXT");
  // Encrypt legacy client secrets in place; the admin API may decrypt them
  // after authentication when the operator explicitly requests visibility.
  const plainKeys = db
    .prepare("SELECT id, key_plain FROM api_keys WHERE key_plain IS NOT NULL")
    .all() as Array<{ id: string; key_plain: string }>;
  const encryptKey = db.prepare("UPDATE api_keys SET key_plain = ? WHERE id = ?");
  for (const row of plainKeys) {
    const encrypted = encryptSecret(row.key_plain);
    if (encrypted !== row.key_plain) encryptKey.run(encrypted, row.id);
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
  addLogCol("user_id", "user_id TEXT");
  addLogCol("usage_id", "usage_id TEXT");
  addLogCol("cost_micros", "cost_micros INTEGER NOT NULL DEFAULT 0");

  const usageCols = (
    db.prepare("PRAGMA table_info(usage_records)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!usageCols.includes("subscription_id")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN subscription_id TEXT");
  }
  if (!usageCols.includes("billing_mode")) {
    db.exec("ALTER TABLE usage_records ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'wallet'");
  }

  const planCols = (
    db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!planCols.includes("stock_limit")) {
    db.exec("ALTER TABLE plans ADD COLUMN stock_limit INTEGER NOT NULL DEFAULT 0");
  }
  if (!planCols.includes("stock_used")) {
    db.exec("ALTER TABLE plans ADD COLUMN stock_used INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "UPDATE plans SET stock_used = (SELECT COUNT(*) FROM subscriptions WHERE subscriptions.plan_id = plans.id AND subscriptions.status = 'active')",
    );
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaults: Record<string, string> = {
    cache_enabled: "false",
    cache_ttl_seconds: "3600",
    cache_max_entries: "1000",
    cache_methods: '["GET"]',
    cache_paths: '["/v1/models"]',
    admin_token: process.env.ADMIN_TOKEN?.trim() || "a2366021253",
    port: "5555",
    // Upstream request retries (network / 429 / 5xx). 0 = no retry.
    max_retries: "2",
    retry_delay_ms: "400",
    brand_name: "LocalAPI",
    company_name: "",
    public_base_url: "",
    registration_enabled: "false",
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }

  // Migrate legacy default admin password → user-specified password
  const currentAdmin = getSetting("admin_token");
  const configuredAdmin = process.env.ADMIN_TOKEN?.trim();
  if (configuredAdmin && currentAdmin !== configuredAdmin) {
    setSetting("admin_token", configuredAdmin);
  } else if (!currentAdmin || currentAdmin === "localapi-admin") {
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
  user_id: string | null;
  allowed_models: string;
  tpm_limit: number;
  concurrency_limit: number;
  expires_at: string | null;
};

export type User = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: string;
  allowed_models: string;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type ModelPrice = {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type Plan = {
  id: string;
  name: string;
  description: string;
  cycle_days: number;
  included_credits_micros: number;
  allowed_models: string;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  overage_enabled: number;
  stock_limit: number;
  stock_used: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type Subscription = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  starts_at: string;
  period_start: string;
  period_end: string;
  remaining_credits_micros: number;
  reserved_micros: number;
  auto_renew: number;
  created_at: string;
  updated_at: string;
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
  user_id: string | null;
  usage_id: string | null;
  cost_micros: number;
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
