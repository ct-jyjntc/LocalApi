import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-oauth-broker-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "oauth-broker-test-secret";
  process.env.NODE_ENV = "test";
}

test("oauth broker: state lifecycle, one-time exchange, token rotation", async () => {
  boot();
  const { initDb, db } = await import("../src/db");
  const {
    createOAuthLoginState,
    getOAuthStateStatus,
    setOAuthStateDecision,
    consumeOAuthState,
    issueOAuthTokenPair,
    refreshOAuthTokenPair,
    authenticateOAuthToken,
    revokeOAuthTokensForUser,
    OAUTH_STATE_TTL_MS,
  } = await import("../src/services/oauth");
  const { createUser } = await import("../src/services/users");

  initDb();
  const user = createUser({ username: "oauth_user", password: "password-123" });

  // ── state lifecycle ─────────────────────────────────────────────────────
  const { state, expiresInMs } = createOAuthLoginState();
  assert.equal(expiresInMs, OAUTH_STATE_TTL_MS);
  assert.ok(state.length >= 32);

  let status = getOAuthStateStatus(state);
  assert.deepEqual(status, { found: true, authorized: false, denied: false, expired: false });

  // consume before authorize → rejected
  assert.equal(consumeOAuthState(state), null);

  // decision is sticky
  assert.equal(setOAuthStateDecision(state, "allow", user.id), true);
  assert.equal(setOAuthStateDecision(state, "allow", user.id), false);
  assert.equal(setOAuthStateDecision(state, "deny", user.id), false);
  status = getOAuthStateStatus(state);
  assert.equal(status.authorized, true);

  // one-time consume
  const consumed = consumeOAuthState(state);
  assert.deepEqual(consumed, { userId: user.id });
  assert.equal(consumeOAuthState(state), null);
  assert.equal(getOAuthStateStatus(state).found, false);

  // expired state → expired flag (authorize + consume both reject)
  const { state: stale } = createOAuthLoginState();
  db.prepare("UPDATE oauth_states SET expires_at = ? WHERE state_hash = ?").run(
    new Date(Date.now() - 1000).toISOString(),
    require("node:crypto").createHash("sha256").update(stale).digest("hex"),
  );
  assert.equal(getOAuthStateStatus(stale).expired, true);
  assert.equal(setOAuthStateDecision(stale, "allow", user.id), false);
  assert.equal(consumeOAuthState(stale), null);

  // denied state never authorizes
  const { state: deniedState } = createOAuthLoginState();
  assert.equal(setOAuthStateDecision(deniedState, "deny", user.id), true);
  assert.equal(getOAuthStateStatus(deniedState).denied, true);
  assert.equal(consumeOAuthState(deniedState), null);

  // ── token pair + rotation ───────────────────────────────────────────────
  const pair = issueOAuthTokenPair(user.id);
  assert.ok(pair.accessToken.startsWith("oat_"));
  assert.ok(pair.refreshToken.startsWith("ort_"));

  const key = authenticateOAuthToken(pair.accessToken);
  assert.ok(key, "access token must authenticate");
  assert.equal(key!.user_id, user.id);
  assert.equal(key!.id, key!.id); // stable synthetic id
  assert.equal(authenticateOAuthToken("la_bogus"), null, "la_ keys are not oauth tokens");
  assert.equal(authenticateOAuthToken("oat_bogus"), null);
  assert.equal(authenticateOAuthToken("Bearer " + pair.accessToken)?.user_id, user.id);

  // refresh rotates the whole pair: old refresh AND old access die
  const rotated = refreshOAuthTokenPair(pair.refreshToken)!;
  assert.equal(rotated.userId, user.id);
  assert.notEqual(rotated.accessToken, pair.accessToken);
  assert.equal(refreshOAuthTokenPair(pair.refreshToken), null, "old refresh must be dead");
  assert.equal(
    authenticateOAuthToken(pair.accessToken),
    null,
    "old access dies on rotation (plaintext never stored, no replay)",
  );
  assert.ok(authenticateOAuthToken(rotated.accessToken));

  // garbage refresh
  assert.equal(refreshOAuthTokenPair("ort_garbage"), null);
});

test("oauth broker: HTTP flow with session auth, one-time state, refresh over wire", async () => {
  boot();
  const { initDb } = await import("../src/db");
  const { createUser, createUserSession } = await import("../src/services/users");
  const { oauthRouter } = await import("../src/routes/oauth");
  const { requireApiKey } = await import("../src/middleware/auth");


  initDb();
  const user = createUser({ username: "http_user", password: "password-123" });
  const session = createUserSession(user.id);

  const app = express();
  app.use(express.json());
  app.use("/oauth", oauthRouter);
  app.get("/probe", requireApiKey, (req, res) => {
    res.json({ user_id: (req as express.Request & { apiKey?: { user_id: string | null } }).apiKey?.user_id ?? null });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const get = (url: string, headers: Record<string, string> = {}) =>
      fetch(base + url, { headers });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    // login start
    const loginRes = await get("/oauth/login");
    assert.equal(loginRes.status, 200);
    const login = (await loginRes.json()) as { login_url: string; state: string; expires_in: number };
    assert.ok(login.login_url.includes(`state=${encodeURIComponent(login.state)}`));
    assert.ok(login.expires_in > 0);

    // unauthenticated consent → 401
    const unauthRes = await post("/oauth/authorize", { state: login.state, action: "allow" });
    assert.equal(unauthRes.status, 401);

    // check before authorize
    assert.equal(((await (await get(`/oauth/check?state=${login.state}`)).json()) as { valid: boolean }).valid, false);

    // consent with session
    const authHeader = { "x-user-token": session.token };
    const consentRes = await post("/oauth/authorize", { state: login.state, action: "allow" }, authHeader);
    assert.equal(consentRes.status, 200);

    // check flips
    assert.equal(((await (await get(`/oauth/check?state=${login.state}`)).json()) as { valid: boolean }).valid, true);

    // exchange
    const tokenRes = await get(`/oauth/token?state=${login.state}`);
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      user: { id: string; username: string };
    };
    assert.equal(tokens.token_type, "bearer");
    assert.equal(tokens.user.id, user.id);
    assert.equal(tokens.user.username, "http_user");
    assert.ok(tokens.expires_in > 0);

    // state is single-use
    assert.equal((await get(`/oauth/token?state=${login.state}`)).status, 400);

    // access token works on the protected proxy-style route
    const probe = await get("/probe", { authorization: `Bearer ${tokens.access_token}` });
    assert.equal(probe.status, 200);
    assert.equal(((await probe.json()) as { user_id: string }).user_id, user.id);

    // refresh over the wire; old refresh rejected
    const refreshRes = await post("/oauth/refresh", { refresh_token: tokens.refresh_token });
    assert.equal(refreshRes.status, 200);
    const refreshed = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    assert.ok(refreshed.access_token.startsWith("oat_"));
    const staleRefresh = await post("/oauth/refresh", { refresh_token: tokens.refresh_token });
    assert.equal(staleRefresh.status, 401);
    const probe2 = await get("/probe", { authorization: `Bearer ${refreshed.access_token}` });
    assert.equal(probe2.status, 200);

    // expired state → 410 on exchange
    const login2 = (await (await get("/oauth/login")).json()) as { state: string };
    const { sha256 } = await import("../src/utils/hash");
    const { db } = await import("../src/db");
    db.prepare("UPDATE oauth_states SET expires_at = ? WHERE state_hash = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      sha256(login2.state),
    );
    assert.equal((await get(`/oauth/token?state=${login2.state}`)).status, 410);

    // deny path
    const login3 = (await (await get("/oauth/login")).json()) as { state: string };
    await post("/oauth/authorize", { state: login3.state, action: "deny" }, authHeader);
    assert.equal(
      ((await (await get(`/oauth/check?state=${login3.state}`)).json()) as { valid: boolean }).valid,
      false,
    );
    assert.equal((await get(`/oauth/token?state=${login3.state}`)).status, 400);
  } finally {
    server.close();
  }
});

test("oauth broker: synthetic key flows through wallet/coding access gates", async () => {
  boot();
  const { initDb } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { adjustWallet } = await import("../src/services/billing");
  const { createPlan, purchasePlan } = await import("../src/services/plans");
  const { issueOAuthTokenPair, authenticateOAuthToken } = await import("../src/services/oauth");
  const { AccessError, beginRequestAccess } = await import("../src/services/access");

  initDb();
  const user = createUser({ username: "gated_user", password: "password-123" });
  adjustWallet(user.id, 100_000_000, "oauth test balance");
  const plan = createPlan({
    name: "OAuth Coding Plan",
    price_micros: 1_000_000,
    included_credits_micros: 5_000_000,
    allowed_models: ["glm-5.2"],
  });
  const key = authenticateOAuthToken(issueOAuthTokenPair(user.id).accessToken)!;

  // wallet mode: allowed (user keys are open in wallet mode), balance debited later by billing
  const walletAccess = beginRequestAccess(key, "glm-5.2", { model: "glm-5.2", messages: [] }, { billingMode: "wallet" });
  assert.equal(walletAccess.userId, user.id);
  walletAccess.release(10);

  // coding mode without subscription → 402
  assert.throws(
    () => beginRequestAccess(key, "glm-5.2", { model: "glm-5.2", messages: [] }, { billingMode: "coding" }),
    (error: unknown) => error instanceof AccessError && error.status === 402 && error.code === "coding_plan_required",
  );

  // subscribe, then coding passes; non-plan model → 403
  purchasePlan(user.id, plan.id, "oauth-test-request-id");
  const codingAccess = beginRequestAccess(key, "glm-5.2", { model: "glm-5.2", messages: [] }, { billingMode: "coding" });
  codingAccess.release(10);
  assert.throws(
    () => beginRequestAccess(key, "gpt-4o", { model: "gpt-4o", messages: [] }, { billingMode: "coding" }),
    (error: unknown) => error instanceof AccessError && error.status === 403 && error.code === "model_not_allowed",
  );
});
