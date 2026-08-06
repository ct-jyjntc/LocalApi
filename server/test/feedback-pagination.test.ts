import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

/**
 * M10 regressions: feedback lists are paginated (they used to load every
 * thread AND every message with its base64 attachments into memory, growing
 * without bound), and the user feedback endpoints are rate-limited per user
 * (each message can carry 3×3 MB of base64 -> unbounded disk growth without
 * a limit).
 */
test("feedback: paginated lists + per-user rate limiting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-feedback-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "feedback-test-secret";

  // Dynamic imports only: src/db opens its database file at module load.
  const { db, initDb } = await import("../src/db");
  const { createUser, createUserSession } = await import("../src/services/users");
  const { createFeedback, listAllFeedback, listUserFeedback } = await import("../src/services/feedback");
  const { clearRateLimits } = await import("../src/services/rate-limit");
  const express = (await import("express")).default;
  const { userRouter } = await import("../src/routes/user");

  let server: http.Server | null = null;
  try {
    initDb();
    clearRateLimits();
    const user = createUser({ username: "feedback-user", password: "password-123" });
    const session = createUserSession(user.id);
    const auth = { "x-user-token": session.token, "content-type": "application/json" };

    // Create 3 threads via the service (bypasses the route-level rate limit).
    for (let i = 0; i < 3; i++) {
      createFeedback(user.id, `subject-${i}`, "body", []);
    }

    // Service-level pagination on both lists.
    const page = listUserFeedback(user.id, 2, 0);
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
    assert.equal(listUserFeedback(user.id, 2, 2).items.length, 1);
    const adminPage = listAllFeedback(2, 0);
    assert.equal(adminPage.total, 3);
    assert.equal(adminPage.items.length, 2);
    assert.equal(listAllFeedback(2, 2).items.length, 1);

    const app = express();
    app.use(express.json());
    app.use("/user/api", userRouter);
    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/user/api/feedback`;

    // Route-level pagination: ?limit=&offset= are honored.
    const pageRes = await fetch(`${base}?limit=2&offset=1`, { headers: auth });
    assert.equal(pageRes.status, 200);
    const pageBody = (await pageRes.json()) as { total: number; items: unknown[] };
    assert.equal(pageBody.total, 3);
    assert.equal(pageBody.items.length, 2);

    // Creating threads is rate-limited: 10 per 10 minutes per user.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(base, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ subject: `s-${i}`, body: "b" }),
      });
      assert.equal(res.status, 201, `thread POST #${i + 1} should be accepted`);
    }
    const limited = await fetch(base, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ subject: "s-over", body: "b" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { code: string }).code, "feedback_rate_limited");
    assert.ok(limited.headers.get("retry-after"), "429 carries retry-after");

    // Replies share the same per-user budget (fresh user, independent quota).
    const user2 = createUser({ username: "feedback-user-2", password: "password-123" });
    const session2 = createUserSession(user2.id);
    const auth2 = { "x-user-token": session2.token, "content-type": "application/json" };
    createFeedback(user2.id, "thread-for-replies", "b", []);
    const threadId = (listUserFeedback(user2.id).items[0] as { id: string }).id;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/${threadId}/replies`, {
        method: "POST",
        headers: auth2,
        body: JSON.stringify({ body: "r" }),
      });
      assert.equal(res.status, 200, `reply POST #${i + 1} should be accepted`);
    }
    const limitedReply = await fetch(`${base}/${threadId}/replies`, {
      method: "POST",
      headers: auth2,
      body: JSON.stringify({ body: "r" }),
    });
    assert.equal(limitedReply.status, 429, "replies are rate-limited with the same budget");

    // A third user still has a full quota — limits are per-user, not global.
    const user3 = createUser({ username: "feedback-user-3", password: "password-123" });
    const session3 = createUserSession(user3.id);
    const otherOk = await fetch(base, {
      method: "POST",
      headers: { "x-user-token": session3.token, "content-type": "application/json" },
      body: JSON.stringify({ subject: "other-user", body: "b" }),
    });
    assert.equal(otherOk.status, 201, "other users keep their own quota");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
