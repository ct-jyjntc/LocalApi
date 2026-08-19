import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("auto risk analysis suspends high-score groups, ignores low-score groups, leaves the rest open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-risk-auto-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "risk-auto-secret";

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { refreshProviderCache } = await import("../src/services/providers");
  const { runAutoRiskAnalysis } = await import("../src/services/risk-ai");

  const scores: Record<string, number> = { "grp-ban": 95, "grp-ignore": 20, "grp-mid": 70 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = body.messages?.[1]?.content ?? "";
    const marker = Object.keys(scores).find((m) => prompt.includes(m));
    const score = marker ? scores[marker] : 50;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score, verdict: `verdict ${score}` }) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    initDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO providers (id, name, base_url, api_key, models, enabled, created_at, updated_at)
       VALUES ('p-judge', 'Judge', 'http://127.0.0.1:9', 'test-key', '["judge-model"]', 1, ?, ?)`,
    ).run(now, now);
    refreshProviderCache();
    setSetting("risk_radar_ai_model", "judge-model");

    const quiet = new Date(Date.now() - 10 * 60_000).toISOString();
    const insertMember = db.prepare(
      `INSERT INTO risk_group_members (group_id, user_id, first_seen_at, last_seen_at, hit_count) VALUES (?, ?, ?, ?, 1)`,
    );
    const makeGroup = (id: string, lastSeen: string) => {
      db.prepare(
        `INSERT INTO risk_groups (id, model, status, reason, max_similarity, member_count, hit_count, created_at, last_seen_at)
         VALUES (?, 'glm-free', 'open', ?, 1, 2, 2, ?, ?)`,
      ).run(id, `cluster ${id}`, quiet, lastSeen);
      const u1 = createUser({ username: `${id}-a`, password: "password-123" });
      const u2 = createUser({ username: `${id}-b`, password: "password-123" });
      insertMember.run(id, u1.id, quiet, quiet);
      insertMember.run(id, u2.id, quiet, quiet);
      return [u1.id, u2.id];
    };

    const banUsers = makeGroup("grp-ban", quiet);
    makeGroup("grp-ignore", quiet);
    makeGroup("grp-mid", quiet);
    const freshUsers = makeGroup("grp-fresh", now); // still active inside the window: must stay untouched

    await runAutoRiskAnalysis();

    const row = (id: string) =>
      db.prepare("SELECT status, resolved_action, ai_score FROM risk_groups WHERE id = ?").get(id) as {
        status: string;
        resolved_action: string | null;
        ai_score: number | null;
      };
    assert.deepEqual(row("grp-ban"), { status: "actioned", resolved_action: "auto_suspended", ai_score: 95 });
    assert.deepEqual(row("grp-ignore"), { status: "ignored", resolved_action: "auto_ignored", ai_score: 20 });
    assert.deepEqual(row("grp-mid"), { status: "open", resolved_action: null, ai_score: 70 });
    assert.deepEqual(row("grp-fresh"), { status: "open", resolved_action: null, ai_score: null });

    const statusOf = (uid: string) =>
      (db.prepare("SELECT status FROM users WHERE id = ?").get(uid) as { status: string }).status;
    assert.equal(statusOf(banUsers[0]), "suspended");
    assert.equal(statusOf(banUsers[1]), "suspended");
    assert.equal(statusOf(freshUsers[0]), "active");

    const audits = (
      db.prepare("SELECT action FROM admin_audit_logs").all() as Array<{ action: string }>
    ).map((r) => r.action);
    assert.ok(audits.includes("risk.group.auto_suspend"));
    assert.ok(audits.includes("risk.group.auto_ignore"));
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
