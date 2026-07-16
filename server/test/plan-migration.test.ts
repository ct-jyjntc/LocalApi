import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("plan migration preserves existing order and initializes paid entitlement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-plan-migration-"));
  const file = path.join(dir, "localapi.db");
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, status TEXT NOT NULL, allowed_models TEXT NOT NULL,
      rpm_limit INTEGER NOT NULL, tpm_limit INTEGER NOT NULL, concurrency_limit INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
      cycle_days INTEGER NOT NULL, price_micros INTEGER NOT NULL, included_credits_micros INTEGER NOT NULL,
      allowed_models TEXT NOT NULL, rpm_limit INTEGER NOT NULL, tpm_limit INTEGER NOT NULL,
      concurrency_limit INTEGER NOT NULL, overage_enabled INTEGER NOT NULL,
      stock_limit INTEGER NOT NULL, stock_used INTEGER NOT NULL, enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL,
      starts_at TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      remaining_credits_micros INTEGER NOT NULL, reserved_micros INTEGER NOT NULL,
      price_micros_snapshot INTEGER NOT NULL, auto_renew INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const old = "2026-01-01T00:00:00.000Z";
  const newer = "2026-02-01T00:00:00.000Z";
  const end = "2026-03-01T00:00:00.000Z";
  legacy.prepare("INSERT INTO users VALUES (?, ?, ?, ?, 'active', '[]', 0, 0, 0, ?, ?, NULL)")
    .run("user-1", "legacy", "Legacy", "hash", old, old);
  const insertPlan = legacy.prepare("INSERT INTO plans VALUES (?, ?, '', 30, 1, 1, '[]', 0, 0, 0, 1, 0, 0, 1, ?, ?)");
  insertPlan.run("plan-old", "Older", old, old);
  insertPlan.run("plan-new", "Newer", newer, newer);
  legacy.prepare("INSERT INTO subscriptions VALUES (?, ?, ?, 'active', ?, ?, ?, 1, 0, 1, 0, ?, ?)")
    .run("subscription-1", "user-1", "plan-new", newer, newer, end, newer, newer);
  legacy.close();

  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "plan-migration-test-secret";
  const { db, initDb } = await import("../src/db");
  try {
    initDb();
    const plans = db.prepare("SELECT id FROM plans ORDER BY sort_order ASC").all() as Array<{ id: string }>;
    assert.deepEqual(plans.map((row) => row.id), ["plan-new", "plan-old"]);
    const subscription = db.prepare("SELECT entitlement_end, overage_enabled FROM subscriptions WHERE id = ?").get("subscription-1") as { entitlement_end: string; overage_enabled: number };
    assert.equal(subscription.entitlement_end, end);
    assert.equal(subscription.overage_enabled, 1);
    assert.ok(db.prepare("SELECT id FROM user_tiers WHERE threshold_micros = 0 AND enabled = 1").get());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
