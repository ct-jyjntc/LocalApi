import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

test("admin endpoints: failed token guesses are rate-limited per IP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-admin-bruteforce-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "admin-bruteforce-test-secret";

  // Dynamic imports only: src/db opens its database file at module load, so
  // static imports would bind it to cwd/data before the env is set.
  const { adminRouter } = await import("../src/routes/admin");
  const { clearRateLimits } = await import("../src/services/rate-limit");
  const { initDb, setSetting } = await import("../src/db");
  const { hashAdminSecret } = await import("../src/utils/admin-secret");

  let server: import("node:http").Server | null = null;
  try {
    initDb();
    setSetting("admin_token", hashAdminSecret("correct-password"));
    clearRateLimits();

    const app = express();
    app.use("/admin/api", express.json(), adminRouter);
    server = app.listen(0) as unknown as import("node:http").Server;
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/admin/api`;

    const guess = (token: string) =>
      fetch(`${base}/health`, { headers: { "x-admin-token": token } });

    // Correct token works.
    const ok = await guess("correct-password");
    assert.equal(ok.status, 200);

    // 10 wrong guesses → 401 each (the failure budget).
    for (let i = 0; i < 10; i++) {
      const res = await guess(`wrong-${i}`);
      assert.equal(res.status, 401, `guess ${i} must be 401, got ${res.status}`);
    }

    // 11th guess from the same IP → 429, with retry-after.
    const blocked = await guess("wrong-11");
    assert.equal(blocked.status, 429, "exceeding the failure budget must return 429");
    assert.ok(blocked.headers.get("retry-after"), "429 must carry retry-after");

    // The correct token still works during lockout and RESETS the budget
    // (legit admin is never locked out by their own mistakes).
    const okDuringLockout = await guess("correct-password");
    assert.equal(okDuringLockout.status, 200);
    const afterReset = await guess("wrong-12");
    assert.equal(afterReset.status, 401, "successful auth must reset the failure budget");

    // /login failures consume the SAME shared budget (no second pipeline):
    // burn the remaining 9 via login + endpoint mix, then verify the whole
    // IP is locked on every route.
    const login = (password: string) =>
      fetch(`${base}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, entry_path: "/admin" }),
      });
    const loginFail = await login("wrong-login");
    assert.equal(loginFail.status, 401);
    for (let i = 0; i < 8; i++) {
      const res = await guess(`wrong-${i}`);
      assert.equal(res.status, 401, `post-reset guess ${i} must be 401`);
    }
    // Budget (10) exhausted: wrong guesses on any endpoint AND login → 429.
    const endpointLocked = await guess("wrong-final");
    assert.equal(endpointLocked.status, 429, "endpoint must be locked after shared budget exhaustion");
    const loginLocked = await login("wrong-final");
    assert.equal(loginLocked.status, 429, "login must be locked while the shared budget is exhausted");
    // Other endpoints share the same per-IP budget.
    const dashboardLocked = await fetch(`${base}/dashboard`, {
      headers: { "x-admin-token": "wrong-final-2" },
    });
    assert.equal(dashboardLocked.status, 429, "lockout must cover every admin endpoint");
  } finally {
    server?.close();
    clearRateLimits();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
