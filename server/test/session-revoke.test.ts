import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * M4 regression: a password change (self-service or admin) must revoke every
 * existing session token; leaked tokens must not survive the credential change.
 */
test("password changes revoke all user sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-session-revoke-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "session-revoke-test-secret";

  const { db, initDb } = await import("../src/db");
  const {
    authenticateUser,
    authenticateUserSession,
    changeUserPassword,
    createUser,
    createUserSession,
    updateUser,
  } = await import("../src/services/users");

  try {
    initDb();
    const user = createUser({ username: "session-owner", password: "password-123" });

    // Two live sessions on different devices.
    const sessionA = createUserSession(user.id);
    const sessionB = createUserSession(user.id);
    assert.ok(authenticateUserSession(sessionA.token));
    assert.ok(authenticateUserSession(sessionB.token));

    // Wrong current password: nothing changes.
    assert.equal(changeUserPassword(user.id, "wrong-password", "new-password-123"), false);
    assert.ok(authenticateUserSession(sessionA.token), "failed change keeps sessions alive");
    const stillLive = db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?").get(user.id) as {
      n: number;
    };
    assert.equal(stillLive.n, 2);

    // Correct change: both tokens are dead immediately.
    assert.equal(changeUserPassword(user.id, "password-123", "new-password-123"), true);
    assert.equal(authenticateUserSession(sessionA.token), null, "old session A revoked");
    assert.equal(authenticateUserSession(sessionB.token), null, "old session B revoked");
    assert.equal(authenticateUser("session-owner", "password-123"), null);
    assert.ok(authenticateUser("session-owner", "new-password-123"));

    // A NEW session created after the change works.
    const sessionC = createUserSession(user.id);
    assert.ok(authenticateUserSession(sessionC.token));

    // Admin path: updateUser with a password also revokes sessions.
    updateUser(user.id, { password: "admin-reset-123" });
    assert.equal(authenticateUserSession(sessionC.token), null, "admin password reset revokes sessions");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?").get(user.id) as { n: number }).n,
      0,
    );
    // ...but a non-password admin update keeps them.
    const sessionD = createUserSession(user.id);
    updateUser(user.id, { display_name: "Renamed" });
    assert.ok(authenticateUserSession(sessionD.token), "display-name-only update keeps sessions");
  } finally {
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
