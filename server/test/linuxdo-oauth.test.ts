import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createAuthRoutes } from "../../modules/linuxdo/src/routes/auth";
import { seedLinuxDoOAuthFromEnv } from "../../modules/linuxdo/src/oauth";
import type { ModuleContext } from "../../modules/linuxdo/src/types";

test("linuxdo oauth: one-time code, token never in URL, nonce-bound exchange", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-linuxdo-oauth-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "linuxdo-oauth-test-secret";
  process.env.LINUXDO_CLIENT_ID = "oauth-test-client";
  process.env.LINUXDO_RELAY_URL = "http://relay.test";
  process.env.LINUXDO_RELAY_SECRET = "relay-secret";

  const { getSetting, initDb, setSetting } = await import("../src/db");
  const { decryptSecret, encryptSecret } = await import("../src/utils/secrets");
  const { getPublicBaseUrl } = await import("../src/utils/public-url");
  const { consumeRateLimit } = await import("../src/services/rate-limit");
  const {
    createUser,
    createUserSession,
    getUserByLinuxDoUid,
    getUserByUsername,
    updateUser,
  } = await import("../src/services/users");

  // Fake only the LinuxDo relay exchange; every other request passes through
  // to the real network (the local test server).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://relay.test")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 777, username: "linuxdo_test_user", name: "Tester" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const ctx = {
    moduleId: "linuxdo",
    createRouter: () => express.Router(),
    getSetting: (key: string) => getSetting(key) ?? undefined,
    setSetting: (key: string, value: string) => setSetting(key, value),
    encryptSecret,
    decryptSecret,
    getPublicBaseUrl,
    registerPaymentProvider: () => undefined,
    registerAuthProvider: () => undefined,
    contributeAdminSettings: () => undefined,
    mountUserRoutes: () => undefined,
    mountAdminRoutes: () => undefined,
    mountPaymentRoutes: () => undefined,
    users: {
      getByUsername: (username: string) => {
        const user = getUserByUsername(username);
        return user
          ? { id: user.id, username: user.username, display_name: user.display_name, linuxdo_uid: user.linuxdo_uid ?? null }
          : null;
      },
      getByLinuxDoUid: (uid: string) => {
        const user = getUserByLinuxDoUid(uid);
        return user
          ? { id: user.id, username: user.username, display_name: user.display_name, linuxdo_uid: user.linuxdo_uid ?? null }
          : null;
      },
      bindLinuxDoUid: (userId: string, uid: string) => {
        const updated = updateUser(userId, { linuxdo_uid: uid });
        return updated ? { id: updated.id, username: updated.username, display_name: updated.display_name } : null;
      },
      create: (input: { username: string; display_name?: string; password: string; linuxdo_uid?: string }) => {
        const created = createUser(input);
        return { id: created.id, username: created.username, display_name: created.display_name };
      },
      createSession: (userId: string) => createUserSession(userId),
    },
    rateLimit: {
      consume: (key: string, limit: number, windowMs: number) =>
        consumeRateLimit(key, limit, windowMs),
    },
  } as unknown as ModuleContext;

  let server: import("node:http").Server | null = null;
  try {
    initDb();
    setSetting("public_base_url", "https://example.com");
    setSetting("linuxdo_login_enabled", "true");
    seedLinuxDoOAuthFromEnv(ctx);

    const { router, cleanup } = createAuthRoutes(ctx);
    const app = express();
    app.use("/user/api", express.json(), router);
    server = app.listen(0) as unknown as import("node:http").Server;
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/user/api`;

    // Full flow helper: start login → callback → returns nonce + one-time code.
    // NOTE: the callback and exchange routes burn their tokens on ANY use or
    // failed attempt, so every negative case needs a fresh flow.
    const startFlow = async () => {
      const startRes = await fetch(`${base}/auth/linuxdo`, { redirect: "manual" });
      assert.equal(startRes.status, 302);
      const state = new URL(startRes.headers.get("location")!).searchParams.get("state");
      assert.ok(state, "state param must be present");
      const setCookie = startRes.headers.get("set-cookie") || "";
      const nonce = setCookie.match(/linuxdo_nonce=([^;]+)/)?.[1];
      assert.ok(nonce, "nonce cookie must be set");
      const cbRes = await fetch(`${base}/auth/linuxdo/callback?state=${state}&code=fake-code`, {
        redirect: "manual",
      });
      assert.equal(cbRes.status, 302);
      const cbLocation = cbRes.headers.get("location") || "";
      assert.ok(!cbLocation.includes("lus_"), "session token must never appear in the URL");
      assert.ok(!cbLocation.includes("linuxdo_token"), "legacy linuxdo_token param must be gone");
      const exchangeCode = new URL(cbLocation).searchParams.get("linuxdo_code");
      assert.ok(exchangeCode, "callback must redirect with a one-time code");
      return { nonce, exchangeCode };
    };
    const post = (code: string, cookie?: string) =>
      fetch(`${base}/auth/linuxdo/exchange`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ code }),
      });

    // Flow 1: no nonce cookie → rejected (out-of-band code attack).
    {
      const { exchangeCode } = await startFlow();
      const noCookie = await post(exchangeCode);
      assert.equal(noCookie.status, 403, "exchange without the originating browser nonce must fail");
    }

    // Flow 2: WRONG nonce → rejected.
    {
      const { exchangeCode } = await startFlow();
      const wrongNonce = await post(exchangeCode, "linuxdo_nonce=wrong");
      assert.equal(wrongNonce.status, 403, "exchange with a wrong nonce must fail");
    }

    // Flow 3: correct nonce → session token; then the code is burned.
    {
      const { nonce, exchangeCode } = await startFlow();
      const ok = await post(exchangeCode, `linuxdo_nonce=${nonce}`);
      assert.equal(ok.status, 200);
      const exchanged = (await ok.json()) as { token: string };
      assert.match(exchanged.token, /^lus_/, "exchange must return a real session token");
      const replay = await post(exchangeCode, `linuxdo_nonce=${nonce}`);
      assert.equal(replay.status, 400, "exchange code must be single-use");
    }

    // 7. The new user is bound by uid (C2 regression inside the flow).
    const bound = getUserByLinuxDoUid("777");
    assert.ok(bound, "OAuth-created user must be bound to the LinuxDo uid");
    assert.equal(bound!.username, "linuxdo_test_user");
  } finally {
    globalThis.fetch = originalFetch;
    server?.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
    delete process.env.LINUXDO_CLIENT_ID;
    delete process.env.LINUXDO_RELAY_URL;
    delete process.env.LINUXDO_RELAY_SECRET;
  }
});
