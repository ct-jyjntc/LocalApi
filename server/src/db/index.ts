import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { hashAdminSecret, isHashedAdminSecret } from "../utils/admin-secret";
import { encryptSecret } from "../utils/secrets";

const dataDir = path.resolve(process.env.LOCALAPI_DATA_DIR || path.join(process.cwd(), "data"));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function getDataDir() {
  return dataDir;
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
try {
  db.pragma("auto_vacuum = INCREMENTAL");
} catch {
  // Existing files keep their vacuum mode until reclaimSqliteSpace() VACUUMs.
}

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
      model_mappings TEXT NOT NULL DEFAULT '{}',
      proxy_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 60000,
      sort_order INTEGER NOT NULL DEFAULT 0,
      custom_headers TEXT NOT NULL DEFAULT '{}',
      model_efforts TEXT NOT NULL DEFAULT '{}',
      protocols TEXT NOT NULL DEFAULT '["openai-completions"]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      library_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_libraries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      default_protocol TEXT NOT NULL DEFAULT 'http',
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_update INTEGER NOT NULL DEFAULT 0,
      update_interval_ms INTEGER NOT NULL DEFAULT 3600000,
      last_updated_at TEXT,
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
      last_login_at TEXT,
      linuxdo_uid TEXT
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
      -- Hidden pool from check-in point exchange; counts toward points hold cap until spent.
      checkin_balance_micros INTEGER NOT NULL DEFAULT 0,
      reserved_micros INTEGER NOT NULL DEFAULT 0,
      lifetime_spent_micros INTEGER NOT NULL DEFAULT 0,
      lifetime_topup_micros INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_tiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      threshold_micros INTEGER NOT NULL DEFAULT 0,
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_tiers_threshold ON user_tiers(enabled, threshold_micros DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tiers_threshold_unique ON user_tiers(threshold_micros);

    CREATE TABLE IF NOT EXISTS model_prices (
      model TEXT PRIMARY KEY,
      input_price_micros INTEGER NOT NULL DEFAULT 0,
      output_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_read_price_micros INTEGER NOT NULL DEFAULT 0,
      cache_write_price_micros INTEGER NOT NULL DEFAULT 0,
      reasoning_enabled INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT NOT NULL DEFAULT '[]',
      image_input INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      max_output_tokens INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      price_windows TEXT NOT NULL DEFAULT '[]',
      prompt_preset_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      cycle_days INTEGER NOT NULL DEFAULT 30,
      price_micros INTEGER NOT NULL DEFAULT 0,
      included_credits_micros INTEGER NOT NULL DEFAULT 0,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 0,
      overage_enabled INTEGER NOT NULL DEFAULT 1,
      stock_limit INTEGER NOT NULL DEFAULT 0,
      stock_used INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      visible INTEGER NOT NULL DEFAULT 1,
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
      entitlement_end TEXT NOT NULL,
      remaining_credits_micros INTEGER NOT NULL DEFAULT 0,
      reserved_micros INTEGER NOT NULL DEFAULT 0,
      price_micros_snapshot INTEGER NOT NULL DEFAULT 0,
      auto_renew INTEGER NOT NULL DEFAULT 1,
      overage_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, status, period_end);

    CREATE TABLE IF NOT EXISTS plan_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      idempotency_key TEXT UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
      previous_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      list_price_micros INTEGER NOT NULL DEFAULT 0,
      credit_micros INTEGER NOT NULL DEFAULT 0,
      amount_micros INTEGER NOT NULL DEFAULT 0,
      balance_after_micros INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_plan_orders_user_created ON plan_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plan_orders_subscription ON plan_orders(subscription_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS free_prompt_claims (
      model TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prefix_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (model, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_free_prompt_claims_user ON free_prompt_claims(user_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS free_prompt_claim_events (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      prefix_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_free_prompt_claim_events_created ON free_prompt_claim_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_free_prompt_claim_events_actor ON free_prompt_claim_events(actor_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS risk_prompt_observations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      exact_hash TEXT NOT NULL,
      simhash TEXT NOT NULL,
      char_len INTEGER NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      client_ip TEXT,
      user_agent TEXT,
      api_key_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_risk_obs_model_created ON risk_prompt_observations(model, created_at DESC);

    CREATE TABLE IF NOT EXISTS risk_groups (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reason TEXT NOT NULL,
      sample_hash TEXT,
      sample_preview TEXT,
      max_similarity REAL NOT NULL DEFAULT 0,
      min_gap_seconds INTEGER,
      window_seconds INTEGER,
      member_count INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_action TEXT,
      ai_score INTEGER,
      ai_verdict TEXT,
      ai_analyzed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_risk_groups_status_seen ON risk_groups(status, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS risk_group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_risk_group_members_user ON risk_group_members(user_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS risk_group_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      similarity REAL NOT NULL,
      exact_match INTEGER NOT NULL DEFAULT 0,
      gap_seconds INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      peer_preview TEXT NOT NULL DEFAULT '',
      client_ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_risk_group_events_group ON risk_group_events(group_id, created_at DESC);

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
      reference_type TEXT,
      reference_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS points_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance INTEGER NOT NULL DEFAULT 0,
      lifetime_earned INTEGER NOT NULL DEFAULT 0,
      lifetime_spent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS points_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      reference_type TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_points_ledger_user ON points_ledger(user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_points_ledger_reference
      ON points_ledger(reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS checkin_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      checkin_date TEXT NOT NULL,
      points INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_user_date ON checkin_records(user_id, checkin_date);
    CREATE INDEX IF NOT EXISTS idx_checkin_user_created ON checkin_records(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS payment_channels (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      gateway_url TEXT NOT NULL,
      exchange_rate_micros INTEGER NOT NULL DEFAULT 1000000,
      min_amount_minor INTEGER NOT NULL DEFAULT 100,
      max_amount_minor INTEGER NOT NULL DEFAULT 100000,
      fee_bps INTEGER NOT NULL DEFAULT 0,
      fee_fixed_minor INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      channel_id TEXT NOT NULL REFERENCES payment_channels(id),
      channel_trade_no TEXT,
      purpose TEXT NOT NULL DEFAULT 'wallet_topup',
      status TEXT NOT NULL DEFAULT 'pending',
      amount_minor INTEGER NOT NULL,
      fee_minor INTEGER NOT NULL DEFAULT 0,
      asset TEXT NOT NULL DEFAULT 'LDC',
      credited_micros INTEGER NOT NULL,
      exchange_rate_micros INTEGER NOT NULL,
      title TEXT NOT NULL,
      pay_url TEXT,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      paid_at TEXT,
      credited_at TEXT,
      refunded_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_user_created
      ON payment_orders(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payment_orders_status_created
      ON payment_orders(status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_channel_trade
      ON payment_orders(channel_id, channel_trade_no)
      WHERE channel_trade_no IS NOT NULL;

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
      channel_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      verified INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(channel_id, event_type, external_id)
    );

    CREATE TABLE IF NOT EXISTS payment_refunds (
      id TEXT PRIMARY KEY,
      refund_no TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
      channel_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      debit_micros INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL DEFAULT '',
      response TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(order_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS coupon_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      discount_type TEXT NOT NULL,
      discount_value INTEGER NOT NULL,
      max_redemptions INTEGER NOT NULL DEFAULT 0,
      redeemed_count INTEGER NOT NULL DEFAULT 0,
      per_user_limit INTEGER NOT NULL DEFAULT 1,
      min_order_micros INTEGER NOT NULL DEFAULT 0,
      applicable_purposes TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      starts_at TEXT,
      ends_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id TEXT PRIMARY KEY,
      coupon_id TEXT NOT NULL REFERENCES coupon_codes(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      order_id TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
      discount_micros INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      redeemed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_no TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      order_id TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      title TEXT NOT NULL,
      tax_number TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      amount_micros INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      file_url TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      issued_at TEXT
    );

    CREATE TABLE IF NOT EXISTS renewal_jobs (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_source TEXT NOT NULL DEFAULT 'wallet',
      order_id TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_jobs_subscription_due
      ON renewal_jobs(subscription_id, due_at);

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_threads_user ON feedback_threads(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS feedback_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_messages_thread ON feedback_messages(thread_id, created_at);

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
      usage_estimated INTEGER NOT NULL DEFAULT 0,
      stream INTEGER NOT NULL DEFAULT 0,
      user_id TEXT,
      usage_id TEXT,
      cost_micros INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_user_created ON request_logs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_status_created ON request_logs(status_code, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_model_created ON request_logs(model, created_at DESC);
  `);

  // Migrate older DBs that lack provider columns
  const providerCols = (
    db.prepare("PRAGMA table_info(providers)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!providerCols.includes("model_mappings")) {
    db.exec("ALTER TABLE providers ADD COLUMN model_mappings TEXT NOT NULL DEFAULT '{}'");
  }
  if (!providerCols.includes("proxy_ids")) {
    db.exec("ALTER TABLE providers ADD COLUMN proxy_ids TEXT NOT NULL DEFAULT '[]'");
  }
  if (!providerCols.includes("sort_order")) {
    db.exec("ALTER TABLE providers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    const rows = db.prepare("SELECT id FROM providers ORDER BY created_at ASC").all() as Array<{ id: string }>;
    const update = db.prepare("UPDATE providers SET sort_order = ? WHERE id = ?");
    rows.forEach((row, idx) => update.run(idx, row.id));
  }
  if (!providerCols.includes("custom_headers")) {
    db.exec("ALTER TABLE providers ADD COLUMN custom_headers TEXT NOT NULL DEFAULT '{}'");
  }
  // Replaced by per-model effort mapping (model_efforts) — drop the aborted
  // dialect/cap columns where a previous build created them.
  if (providerCols.includes("param_style")) {
    db.exec("ALTER TABLE providers DROP COLUMN param_style");
  }
  if (providerCols.includes("max_effort")) {
    db.exec("ALTER TABLE providers DROP COLUMN max_effort");
  }
  if (!providerCols.includes("model_efforts")) {
    db.exec("ALTER TABLE providers ADD COLUMN model_efforts TEXT NOT NULL DEFAULT '{}'");
  }
  // Dialects the channel speaks natively; first entry is the preferred
  // fallback when the client's dialect must be translated.
  if (!providerCols.includes("protocols")) {
    db.exec(`ALTER TABLE providers ADD COLUMN protocols TEXT NOT NULL DEFAULT '["openai-completions"]'`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_providers_sort_order ON providers(sort_order)");

  // feedback_threads: track last sender + per-party unread flags for the
  // badge counts (admin "用户" pill / user "我的反馈").
  const feedbackCols = (
    db.prepare("PRAGMA table_info(feedback_threads)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!feedbackCols.includes("last_sender_type")) {
    db.exec("ALTER TABLE feedback_threads ADD COLUMN last_sender_type TEXT NOT NULL DEFAULT 'user'");
  }
  if (!feedbackCols.includes("admin_unread")) {
    db.exec("ALTER TABLE feedback_threads ADD COLUMN admin_unread INTEGER NOT NULL DEFAULT 0");
  }
  if (!feedbackCols.includes("user_unread")) {
    db.exec("ALTER TABLE feedback_threads ADD COLUMN user_unread INTEGER NOT NULL DEFAULT 0");
  }

  const nodeCols = (
    db.prepare("PRAGMA table_info(proxy_nodes)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!nodeCols.includes("library_id")) {
    db.exec("ALTER TABLE proxy_nodes ADD COLUMN library_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_nodes_library ON proxy_nodes(library_id)");


  // Migrate older DBs that lack the LinuxDo identity binding column.
  const userCols = (
    db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!userCols.includes("linuxdo_uid")) {
    db.exec("ALTER TABLE users ADD COLUMN linuxdo_uid TEXT");
  }
  if (!userCols.includes("training_consent")) {
    db.exec("ALTER TABLE users ADD COLUMN training_consent INTEGER NOT NULL DEFAULT 1");
  }
  // The unique index must be created AFTER the ALTER above: on a legacy table,
  // CREATE INDEX ... ON users(linuxdo_uid) fails with "no such column" (IF NOT
  // EXISTS guards the index, not the column). Idempotent on new DBs.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_linuxdo_uid ON users(linuxdo_uid) WHERE linuxdo_uid IS NOT NULL",
  );

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
  addKeyCol("daily_quota_micros", "daily_quota_micros INTEGER NOT NULL DEFAULT 0");
  addKeyCol("monthly_quota_micros", "monthly_quota_micros INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    DELETE FROM api_keys
    WHERE user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = api_keys.user_id);

    CREATE TRIGGER IF NOT EXISTS api_keys_user_insert_guard
    BEFORE INSERT ON api_keys
    WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'api_keys.user_id references a missing user');
    END;

    CREATE TRIGGER IF NOT EXISTS api_keys_user_update_guard
    BEFORE UPDATE OF user_id ON api_keys
    WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = NEW.user_id)
    BEGIN
      SELECT RAISE(ABORT, 'api_keys.user_id references a missing user');
    END;

    CREATE TRIGGER IF NOT EXISTS users_delete_api_keys
    AFTER DELETE ON users
    BEGIN
      DELETE FROM api_keys WHERE user_id = OLD.id;
    END;
  `);
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

  const priceCols = (
    db.prepare("PRAGMA table_info(model_prices)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!priceCols.includes("reasoning_enabled")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN reasoning_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!priceCols.includes("reasoning_effort")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '[]'");
  }
  if (!priceCols.includes("context_window")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0");
  }
  if (!priceCols.includes("max_output_tokens")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!priceCols.includes("image_input")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN image_input INTEGER NOT NULL DEFAULT 0");
  }
  if (!priceCols.includes("price_windows")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN price_windows TEXT NOT NULL DEFAULT '[]'");
  }
  if (!priceCols.includes("prompt_preset_ids")) {
    db.exec("ALTER TABLE model_prices ADD COLUMN prompt_preset_ids TEXT NOT NULL DEFAULT '[]'");
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
  addLogCol("usage_estimated", "usage_estimated INTEGER NOT NULL DEFAULT 0");
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
  if (!planCols.includes("price_micros")) {
    db.exec("ALTER TABLE plans ADD COLUMN price_micros INTEGER NOT NULL DEFAULT 0");
  }
  if (!planCols.includes("sort_order")) {
    db.exec("ALTER TABLE plans ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    const existingPlans = db.prepare("SELECT id FROM plans ORDER BY created_at DESC, id ASC").all() as Array<{ id: string }>;
    const setOrder = db.prepare("UPDATE plans SET sort_order = ? WHERE id = ?");
    db.transaction(() => existingPlans.forEach((plan, index) => setOrder.run(index, plan.id)))();
  }
  if (!planCols.includes("visible")) {
    db.exec("ALTER TABLE plans ADD COLUMN visible INTEGER NOT NULL DEFAULT 1");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS free_prompt_claims (
      model TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prefix_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (model, fingerprint)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_free_prompt_claims_user ON free_prompt_claims(user_id, last_seen_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS free_prompt_claim_events (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      prefix_chars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_free_prompt_claim_events_created ON free_prompt_claim_events(created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_free_prompt_claim_events_actor ON free_prompt_claim_events(actor_user_id, created_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_prompt_observations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      exact_hash TEXT NOT NULL,
      simhash TEXT NOT NULL,
      char_len INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_risk_obs_model_created ON risk_prompt_observations(model, created_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_groups (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reason TEXT NOT NULL,
      sample_hash TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_action TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_risk_groups_status_seen ON risk_groups(status, last_seen_at DESC)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_group_members (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (group_id, user_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_risk_group_members_user ON risk_group_members(user_id, last_seen_at DESC)");
  const riskObsCols = (db.prepare("PRAGMA table_info(risk_prompt_observations)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!riskObsCols.includes("preview")) db.exec("ALTER TABLE risk_prompt_observations ADD COLUMN preview TEXT NOT NULL DEFAULT ''");
  if (!riskObsCols.includes("client_ip")) db.exec("ALTER TABLE risk_prompt_observations ADD COLUMN client_ip TEXT");
  if (!riskObsCols.includes("user_agent")) db.exec("ALTER TABLE risk_prompt_observations ADD COLUMN user_agent TEXT");
  if (!riskObsCols.includes("api_key_id")) db.exec("ALTER TABLE risk_prompt_observations ADD COLUMN api_key_id TEXT");
  const riskGroupCols = (db.prepare("PRAGMA table_info(risk_groups)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!riskGroupCols.includes("sample_preview")) db.exec("ALTER TABLE risk_groups ADD COLUMN sample_preview TEXT");
  if (!riskGroupCols.includes("max_similarity")) db.exec("ALTER TABLE risk_groups ADD COLUMN max_similarity REAL NOT NULL DEFAULT 0");
  if (!riskGroupCols.includes("min_gap_seconds")) db.exec("ALTER TABLE risk_groups ADD COLUMN min_gap_seconds INTEGER");
  if (!riskGroupCols.includes("window_seconds")) db.exec("ALTER TABLE risk_groups ADD COLUMN window_seconds INTEGER");
  if (!riskGroupCols.includes("ai_score")) db.exec("ALTER TABLE risk_groups ADD COLUMN ai_score INTEGER");
  if (!riskGroupCols.includes("ai_verdict")) db.exec("ALTER TABLE risk_groups ADD COLUMN ai_verdict TEXT");
  if (!riskGroupCols.includes("ai_analyzed_at")) db.exec("ALTER TABLE risk_groups ADD COLUMN ai_analyzed_at TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_group_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      similarity REAL NOT NULL,
      exact_match INTEGER NOT NULL DEFAULT 0,
      gap_seconds INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      peer_preview TEXT NOT NULL DEFAULT '',
      client_ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_risk_group_events_group ON risk_group_events(group_id, created_at DESC)");

  const subscriptionCols = (
    db.prepare("PRAGMA table_info(subscriptions)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!subscriptionCols.includes("price_micros_snapshot")) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN price_micros_snapshot INTEGER NOT NULL DEFAULT 0");
  }
  if (!subscriptionCols.includes("entitlement_end")) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN entitlement_end TEXT");
    db.exec("UPDATE subscriptions SET entitlement_end = period_end WHERE entitlement_end IS NULL");
  }
  if (!subscriptionCols.includes("overage_enabled")) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN overage_enabled INTEGER NOT NULL DEFAULT 1");
    db.exec(
      `UPDATE subscriptions SET overage_enabled = COALESCE(
        (SELECT plans.overage_enabled FROM plans WHERE plans.id = subscriptions.plan_id), 1
      )`,
    );
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_subscriptions_entitlement ON subscriptions(status, entitlement_end)");

  const walletCols = (
    db.prepare("PRAGMA table_info(wallet_accounts)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!walletCols.includes("checkin_balance_micros")) {
    db.exec("ALTER TABLE wallet_accounts ADD COLUMN checkin_balance_micros INTEGER NOT NULL DEFAULT 0");
  }
  if (!walletCols.includes("lifetime_topup_micros")) {
    db.exec("ALTER TABLE wallet_accounts ADD COLUMN lifetime_topup_micros INTEGER NOT NULL DEFAULT 0");
    db.exec(
      `UPDATE wallet_accounts SET lifetime_topup_micros = MAX(0, COALESCE((
        SELECT SUM(CASE
          WHEN wallet_ledger.type = 'payment_topup' THEN wallet_ledger.amount_micros
          WHEN wallet_ledger.type = 'payment_refund' THEN wallet_ledger.amount_micros
          ELSE 0 END)
        FROM wallet_ledger WHERE wallet_ledger.user_id = wallet_accounts.user_id
      ), 0))`,
    );
  }

  const tierNow = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO user_tiers (
      id, name, description, threshold_micros, rpm_limit, tpm_limit,
      concurrency_limit, enabled, created_at, updated_at
    ) VALUES ('tier-basic', '基础用户', '默认余额调用层级', 0, 0, 0, 0, 1, ?, ?)`,
  ).run(tierNow, tierNow);

  const ledgerCols = (
    db.prepare("PRAGMA table_info(wallet_ledger)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!ledgerCols.includes("reference_type")) {
    db.exec("ALTER TABLE wallet_ledger ADD COLUMN reference_type TEXT");
  }
  if (!ledgerCols.includes("reference_id")) {
    db.exec("ALTER TABLE wallet_ledger ADD COLUMN reference_id TEXT");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_reference
    ON wallet_ledger(reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL`);

  const paymentNow = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO payment_channels (
      id, provider, name, enabled, client_id, client_secret, gateway_url,
      exchange_rate_micros, min_amount_minor, max_amount_minor,
      fee_bps, fee_fixed_minor, config_json, created_at, updated_at
    ) VALUES ('linuxdo-credit', 'linuxdo_credit', 'LINUX DO Credit', 0, '', '',
      'https://credit.linux.do/epay', 1000000, 100, 100000, 0, 0, '{}', ?, ?)`,
  ).run(paymentNow, paymentNow);
  db.prepare(
    `INSERT OR IGNORE INTO payment_channels (
      id, provider, name, enabled, client_id, client_secret, gateway_url,
      exchange_rate_micros, min_amount_minor, max_amount_minor,
      fee_bps, fee_fixed_minor, config_json, created_at, updated_at
    ) VALUES ('alipay', 'alipay', '支付宝', 0, '', '',
      'https://openapi.alipay.com/gateway.do', 1000000, 100, 100000, 0, 0,
      '{"alipay_public_key":"","seller_id":"","web_enabled":true,"wap_enabled":true}', ?, ?)`,
  ).run(paymentNow, paymentNow);
  db.prepare(
    `INSERT OR IGNORE INTO payment_channels (
      id, provider, name, enabled, client_id, client_secret, gateway_url,
      exchange_rate_micros, min_amount_minor, max_amount_minor,
      fee_bps, fee_fixed_minor, config_json, created_at, updated_at
    ) VALUES ('wechatpay', 'wechatpay', '微信支付', 0, '', '',
      'https://api.mch.weixin.qq.com', 1000000, 100, 100000, 0, 0,
      '{"wechat_app_id":"","wechat_serial_no":"","wechat_private_key":"","wechat_platform_certificate":"","wechat_platform_serial_no":"","wechat_native_enabled":true,"wechat_h5_enabled":true,"wechat_h5_type":"Wap","wechat_h5_app_name":"","wechat_h5_app_url":""}', ?, ?)`,
  ).run(paymentNow, paymentNow);

  const paymentOrderCols = (
    db.prepare("PRAGMA table_info(payment_orders)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!paymentOrderCols.includes("deleted_at")) {
    db.exec("ALTER TABLE payment_orders ADD COLUMN deleted_at TEXT");
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS modules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT,
      authorized INTEGER NOT NULL DEFAULT 0,
      denied INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_hash TEXT NOT NULL UNIQUE,
      refresh_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      refresh_expires_at TEXT NOT NULL,
      rotated_from TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const configuredAdmin = process.env.ADMIN_TOKEN?.trim();
  const existingAdmin = db.prepare("SELECT value FROM settings WHERE key = 'admin_token'").get() as
    | { value: string }
    | undefined;
  let generatedAdmin = "";
  if (!configuredAdmin && !existingAdmin?.value) {
    generatedAdmin = `adm_${crypto.randomBytes(24).toString("base64url")}`;
  }

  const defaults: Record<string, string> = {
    cache_enabled: "false",
    cache_ttl_seconds: "3600",
    cache_max_entries: "1000",
    cache_methods: '["GET"]',
    cache_paths: '["/v1/models"]',
    admin_token: hashAdminSecret(configuredAdmin || generatedAdmin),
    admin_entry_path: "/admin",
    port: "5555",
    // Upstream request retries. max_retries = normal class; other_max_retries = all other errors.
    max_retries: "2",
    other_max_retries: "0",
    retry_delay_ms: "400",
    brand_name: "LocalAPI",
    brand_tagline: "",
    company_name: "",
    public_base_url: "",
    registration_enabled: "false",
    // Username/password sign-in for existing users.
    password_login_enabled: "true",
    // Wallet-only: require lifetime top-up before calling zero-priced models.
    wallet_free_model_topup_required: "true",
    wallet_free_model_min_topup_micros: "1000000",
    wallet_free_prompt_claim_required: "true",
    wallet_free_prompt_window_seconds: "120",
    // Allow first-time account creation via LinuxDo OAuth (existing users can still log in when LinuxDo login is on).
    linuxdo_registration_enabled: "true",
    checkin_enabled: "true",
    checkin_points_min: "1.00",
    checkin_points_max: "10.00",
    // Max points a user may hold; 0 = unlimited. At/above this value check-in is blocked.
    points_balance_cap: "0",
    // Wallet credits (micros) granted per 1 point when exchanging.
    points_exchange_micros: "10000",
    linuxdo_login_enabled: "false",
    linuxdo_client_id: "",
    linuxdo_client_secret: "",
    linuxdo_relay_url: "",
    linuxdo_relay_secret: "",
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }

  // Store only a one-way hash. Preserve custom legacy passwords while rotating
  // publicly known defaults on installations that do not set ADMIN_TOKEN.
  const currentAdmin = getSetting("admin_token");
  if (configuredAdmin) {
    setSetting("admin_token", hashAdminSecret(configuredAdmin));
  } else if (!currentAdmin) {
    generatedAdmin ||= `adm_${crypto.randomBytes(24).toString("base64url")}`;
    setSetting("admin_token", hashAdminSecret(generatedAdmin));
  } else if (!isHashedAdminSecret(currentAdmin)) {
    if (currentAdmin === "localapi-admin" || currentAdmin === "a2366021253") {
      generatedAdmin = `adm_${crypto.randomBytes(24).toString("base64url")}`;
      setSetting("admin_token", hashAdminSecret(generatedAdmin));
    } else {
      setSetting("admin_token", hashAdminSecret(currentAdmin));
    }
  }
  if (generatedAdmin) {
    console.warn(`[security] Generated initial admin password: ${generatedAdmin}`);
  }

  // Force single-port deployment
  const currentPort = getSetting("port");
  if (!currentPort || currentPort === "8787" || currentPort === "5173") {
    setSetting("port", "5555");
  }

  refreshSettingsCache();
  reclaimSqliteSpace();
}

/** Return deleted pages to the OS and checkpoint WAL. Safe on a ~10MB file. */
export function reclaimSqliteSpace() {
  try {
    const mode = Number(db.pragma("auto_vacuum", { simple: true }) ?? 0);
    if (mode !== 2) {
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      return;
    }
    const freelist = Number(db.pragma("freelist_count", { simple: true }) ?? 0);
    if (freelist > 16) db.pragma("incremental_vacuum(256)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("optimize");
  } catch {
    // ignore
  }
}

export type Provider = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string;
  model_mappings: string;
  proxy_ids: string;
  enabled: number;
  timeout_ms: number;
  sort_order: number;
  custom_headers: string;
  model_efforts: string;
  protocols: string;
  created_at: string;
  updated_at: string;
};

export type ProxyNode = {
  id: string;
  name: string;
  url: string;
  enabled: number;
  library_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ProxyLibrary = {
  id: string;
  name: string;
  url: string;
  default_protocol: string;
  enabled: number;
  auto_update: number;
  update_interval_ms: number;
  last_updated_at: string | null;
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
  daily_quota_micros: number;
  monthly_quota_micros: number;
  username?: string | null;
  user_display_name?: string | null;
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
  linuxdo_uid: string | null;
  training_consent: number;
};

export type UserTier = {
  id: string;
  name: string;
  description: string;
  threshold_micros: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type PriceWindow = {
  start: string;
  end: string;
  days: number[];
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
};

export type ModelPrice = {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  reasoning_enabled: number;
  reasoning_effort: string;
  image_input: number;
  context_window: number;
  max_output_tokens: number;
  enabled: number;
  price_windows: string;
  prompt_preset_ids: string;
  created_at: string;
  updated_at: string;
};

/**
 * API-facing shape: booleans instead of 0/1 and a parsed effort array.
 * listModelPrices()/getModelPrice() convert DB rows into this.
 */
export type ModelPriceView = Omit<
  ModelPrice,
  "reasoning_enabled" | "reasoning_effort" | "image_input" | "enabled" | "price_windows" | "prompt_preset_ids"
> & {
  reasoning_enabled: boolean;
  reasoning_effort: string[];
  image_input: boolean;
  enabled: boolean;
  windows: PriceWindow[];
  prompt_preset_ids: string[];
};

export type PromptPreset = {
  id: string;
  name: string;
  filename: string;
  content: string;
  created_at: string;
  updated_at: string;
};
export type Plan = {
  id: string;
  name: string;
  description: string;
  cycle_days: number;
  price_micros: number;
  included_credits_micros: number;
  allowed_models: string;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  overage_enabled: number;
  stock_limit: number;
  stock_used: number;
  sort_order: number;
  enabled: number;
  visible: number;
  created_at: string;
  updated_at: string;
};

export type PaymentChannel = {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  client_id: string;
  client_secret: string;
  gateway_url: string;
  exchange_rate_micros: number;
  min_amount_minor: number;
  max_amount_minor: number;
  fee_bps: number;
  fee_fixed_minor: number;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type PaymentOrder = {
  id: string;
  order_no: string;
  user_id: string;
  channel_id: string;
  channel_trade_no: string | null;
  purpose: string;
  status: string;
  amount_minor: number;
  fee_minor: number;
  asset: string;
  credited_micros: number;
  exchange_rate_micros: number;
  title: string;
  pay_url: string | null;
  error: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  paid_at: string | null;
  credited_at: string | null;
  refunded_at: string | null;
  deleted_at: string | null;
};

export type Subscription = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  starts_at: string;
  period_start: string;
  period_end: string;
  entitlement_end: string;
  remaining_credits_micros: number;
  reserved_micros: number;
  price_micros_snapshot: number;
  auto_renew: number;
  overage_enabled: number;
  created_at: string;
  updated_at: string;
};

export type PlanOrder = {
  id: string;
  order_no: string;
  idempotency_key: string | null;
  user_id: string;
  plan_id: string;
  previous_plan_id: string | null;
  subscription_id: string | null;
  type: string;
  status: string;
  list_price_micros: number;
  credit_micros: number;
  amount_micros: number;
  balance_after_micros: number;
  description: string;
  metadata: string;
  created_at: string;
  completed_at: string | null;
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
  usage_estimated: number;
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

export function deleteSetting(key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  settingsCache.delete(key);
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
