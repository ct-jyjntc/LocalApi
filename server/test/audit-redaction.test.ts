import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("audit logs: passwords and secrets are redacted, safe fields are kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-audit-redact-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "audit-redaction-test-secret";

  // Dynamic imports: src/db binds its file path at module load.
  const { initDb } = await import("../src/db");
  const { writeAudit, listAuditLogs } = await import("../src/services/audit");
  const { redact } = await import("../src/utils/redact");

  try {
    initDb();

    // Unit-level: redact() masks sensitive keys recursively, keeps the rest.
    const redacted = redact({
      username: "alice",
      password: "SuperSecret123!",
      display_name: "Alice",
      allowed_models: ["gpt-4o"],
      nested: { client_secret: "sk-live-abc", port: 5555 },
      array: [{ token: "lus_abc", name: "ok" }],
    }) as Record<string, unknown>;
    assert.equal(redacted.username, "alice");
    assert.equal(redacted.password, "[REDACTED]");
    assert.equal(redacted.display_name, "Alice");
    assert.deepEqual(redacted.allowed_models, ["gpt-4o"]);
    assert.equal((redacted.nested as Record<string, unknown>).client_secret, "[REDACTED]");
    assert.equal((redacted.nested as Record<string, unknown>).port, 5555);
    assert.deepEqual((redacted.array as Array<Record<string, unknown>>)[0], {
      token: "[REDACTED]",
      name: "ok",
    });
    // Depth guard: a deep object collapses instead of recursing forever.
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const deepRedacted = redact(deep) as Record<string, unknown>;
    let cursor: unknown = deepRedacted;
    let levels = 0;
    while (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>).child;
      levels += 1;
    }
    assert.ok(levels <= 9, "redaction must be depth-limited");

    // Integration: writeAudit persists redacted JSON for the user.update flow.
    writeAudit({
      action: "user.update",
      target_type: "user",
      target_id: "u1",
      detail: { username: "alice", password: "PlaintextHuntMe", linuxdo_uid: "777" },
    });
    const logs = listAuditLogs(10);
    const entry = logs.find((log) => log.action === "user.update") as {
      detail: string | null;
    };
    assert.ok(entry, "audit entry must exist");
    assert.ok(entry.detail, "detail must be persisted");
    assert.ok(!entry.detail.includes("PlaintextHuntMe"), "plaintext password must not reach the audit log");
    const parsed = JSON.parse(entry.detail) as Record<string, unknown>;
    assert.equal(parsed.password, "[REDACTED]");
    assert.equal(parsed.username, "alice", "non-sensitive fields are preserved");
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
