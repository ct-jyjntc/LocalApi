import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("payment migration upgrades an existing wallet ledger before creating its idempotency index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-payment-migration-"));
  const filename = path.join(dir, "localapi.db");
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE users (
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
    CREATE TABLE wallet_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount_micros INTEGER NOT NULL,
      balance_after_micros INTEGER NOT NULL,
      usage_id TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  legacy.close();
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "migration-test-secret";

  const { db, initDb } = await import("../src/db");
  try {
    initDb();
    const columns = (db.prepare("PRAGMA table_info(wallet_ledger)").all() as Array<{ name: string }>).map((row) => row.name);
    const indexes = db.prepare("PRAGMA index_list(wallet_ledger)").all() as Array<{ name: string }>;
    assert.ok(columns.includes("reference_type"));
    assert.ok(columns.includes("reference_id"));
    assert.ok(indexes.some((index) => index.name === "idx_wallet_ledger_reference"));
    assert.ok(db.prepare("SELECT id FROM payment_channels WHERE id = 'linuxdo-credit'").get());
    assert.ok(db.prepare("SELECT id FROM payment_channels WHERE id = 'alipay'").get());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
