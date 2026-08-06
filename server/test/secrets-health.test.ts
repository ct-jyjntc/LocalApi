import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("secrets health: startup check detects missing/wrong SECRETS_KEY and plaintext", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-secrets-health-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "health-check-key";

  // Dynamic imports: src/db binds its file path at module load.
  const { initDb, db, setSetting } = await import("../src/db");
  const { checkSecretsHealth } = await import("../src/utils/secrets-health");
  const { encryptSecret, tryDecryptSecret } = await import("../src/utils/secrets");

  try {
    initDb();

    // Empty database → healthy, no issues.
    let health = checkSecretsHealth();
    assert.equal(health.encryptedCount, 0);
    assert.equal(health.plaintextCount, 0);
    assert.deepEqual(health.issues, []);

    // A plaintext credential without SECRETS_KEY → warning only.
    setSetting("admin_token", "x"); // unrelated; ensure settings scan scope stays clean
    db.prepare(
      "INSERT INTO providers (id, name, base_url, api_key, models, model_mappings, enabled, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 60000, ?, ?)",
    ).run("p1", "Plain Provider", "https://api.example.com", "sk-plain-123", "[]", "{}", new Date().toISOString(), new Date().toISOString());
    delete process.env.SECRETS_KEY;
    health = checkSecretsHealth();
    assert.equal(health.encryptedCount, 0);
    assert.equal(health.plaintextCount, 1);
    assert.deepEqual(health.issues, [], "plaintext alone is a warning, not a blocker");

    // Encrypted credential + MISSING key → blocker.
    process.env.SECRETS_KEY = "health-check-key";
    const encrypted = encryptSecret("sk-secret-456");
    assert.ok(encrypted.startsWith("enc:v1:"), "encryptSecret must produce an enc:v1: value");
    db.prepare("UPDATE providers SET api_key = ? WHERE id = 'p1'").run(encrypted);
    delete process.env.SECRETS_KEY;
    health = checkSecretsHealth();
    assert.equal(health.encryptedCount, 1);
    assert.equal(health.plaintextCount, 0);
    assert.equal(health.issues.length, 1);
    assert.match(health.issues[0], /SECRETS_KEY is not set/i);

    // Encrypted credential + WRONG key → blocker.
    process.env.SECRETS_KEY = "wrong-key";
    health = checkSecretsHealth();
    assert.equal(health.issues.length, 1);
    assert.match(health.issues[0], /does not match/i);

    // Encrypted credential + CORRECT key → healthy.
    process.env.SECRETS_KEY = "health-check-key";
    health = checkSecretsHealth();
    assert.deepEqual(health.issues, []);
    assert.equal(health.encryptedCount, 1);

    // tryDecryptSecret: correct key → plaintext back; wrong key → null.
    process.env.SECRETS_KEY = "health-check-key";
    assert.equal(tryDecryptSecret(encrypted), "sk-secret-456");
    process.env.SECRETS_KEY = "wrong-key";
    assert.equal(tryDecryptSecret(encrypted), null, "wrong key must not decrypt");
    assert.equal(tryDecryptSecret("plain-value"), "plain-value", "non-encrypted values pass through");
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
