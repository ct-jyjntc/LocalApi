import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("LinuxDo OAuth login resolves by uid binding, never by username", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-linuxdo-binding-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "linuxdo-binding-test-secret";

  const { db, initDb } = await import("../src/db");
  const {
    createUser,
    getUser,
    getUserByLinuxDoUid,
    getUserByUsername,
    updateUser,
  } = await import("../src/services/users");

  // Decision logic mirrored from modules/linuxdo/src/routes/auth.ts callback:
  // resolve by uid first; on miss, refuse when the username is already taken by
  // a different, unbound account (would be an account-takeover vector).
  function resolveOAuthUser(uid: string, username: string) {
    const bound = getUserByLinuxDoUid(uid);
    if (bound) return { user: bound, created: false };
    const existing = getUserByUsername(username);
    if (existing) return { conflict: true };
    const created = createUser({
      username,
      password: "random-password-not-user-facing",
      linuxdo_uid: uid,
    });
    return { user: getUser(created.id)!, created: true };
  }

  try {
    initDb();
    // Password-registered victim account "bob" with no LinuxDo binding.
    createUser({ username: "bob", password: "password-123" });

    // Attacker registers a LinuxDo account named "bob" (uid 9999) and logs in.
    const attack = resolveOAuthUser("9999", "bob");
    assert.ok(attack.conflict, "same-named unbound account must refuse OAuth login");
    assert.equal(getUserByLinuxDoUid("9999"), null, "no binding may be created for the attacker");

    // Victim can still log in with their password.
    assert.ok(getUserByUsername("bob"), "password account must remain intact");

    // Fresh OAuth registration binds the uid and resolves on next login.
    const first = resolveOAuthUser("1001", "linuxdo_alice");
    assert.ok(!first.conflict && first.created);
    const second = resolveOAuthUser("1001", "linuxdo_alice");
    assert.ok(!second.conflict && !second.created);
    assert.equal(second.user!.id, first.user!.id, "same uid must resolve to the same account");

    // A same-named account bound to a DIFFERENT uid still refuses.
    createUser({ username: "carol", password: "password-123", linuxdo_uid: "2001" });
    const other = resolveOAuthUser("2002", "carol");
    assert.ok(other.conflict, "username taken by another uid-bound account must refuse");

    // Admin can bind an unbound account (recovery path for pre-migration users).
    const bob = getUserByUsername("bob")!;
    const bound = updateUser(bob.id, { linuxdo_uid: "3001" });
    assert.equal(bound?.linuxdo_uid, "3001");
    assert.equal(getUserByLinuxDoUid("3001")?.id, bob.id);

    // uid binding is unique: a second user cannot claim the same uid.
    const alice = getUserByUsername("linuxdo_alice")!;
    assert.throws(() => updateUser(alice.id, { linuxdo_uid: "3001" }));

    // Admin can unbind.
    const unbound = updateUser(bob.id, { linuxdo_uid: null });
    assert.equal(unbound?.linuxdo_uid, null);
    assert.equal(getUserByLinuxDoUid("3001"), null);

    // Migration column exists on the schema.
    const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(cols.includes("linuxdo_uid"), "users.linuxdo_uid column must exist");
  } finally {
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
