/**
 * OAuth broker service (Pi-Web provider integration).
 *
 * Single owner of the OAuth authorization flow for the Pi-Web provider:
 * - `/oauth/token` consumes the state once and issues an access/refresh pair.
 * - `/oauth/refresh` rotates the whole pair (old access + old refresh die
 *   immediately; plaintext is never stored, so rotated tokens cannot replay).
 *
 * The issued access token (`oat_…`) is a drop-in API key: it authenticates
 * against both `/v1/*` (wallet billing) and `/coding/v1/*` (subscription
 * plans) via `authenticateOAuthToken`, which returns a synthetic ApiKey row
 * bound to the owning user — all downstream gating (tier/plan limits, model
 * allow-lists, subscription checks, billing) is reused unchanged.
 */
import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db, type ApiKey } from "../db";
import { nowIso } from "../utils/time";
import { sha256 } from "../utils/hash";
import { getUser } from "./users";

/** One-time authorization state TTL (matches the Pi-Web 5-minute login window). */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Access token lifetime (AtomGit-style 7 days, minus a 5-minute skew margin). */
export const OAUTH_ACCESS_TTL_MS = 7 * 24 * 3600_000 - 5 * 60_000;
/** Refresh token lifetime. */
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 3600_000;

export const OAUTH_TOKEN_PREFIX = "oat_";
export const OAUTH_REFRESH_PREFIX = "ort_";

function hashAccess(token: string): string {
  return sha256(`localapi:oauth-access:${token}`);
}
function hashRefresh(token: string): string {
  return sha256(`localapi:oauth-refresh:${token}`);
}

function generateToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export type OAuthStateRow = {
  state_hash: string;
  user_id: string | null;
  authorized: number;
  denied: number;
  expires_at: string;
  created_at: string;
};

export type OAuthTokenRow = {
  id: string;
  user_id: string;
  access_hash: string;
  refresh_hash: string;
  access_expires_at: string;
  refresh_expires_at: string;
  rotated_from: string | null;
  created_at: string;
};

/** Create a one-time authorization state; the raw value is returned exactly once. */
export function createOAuthLoginState(): { state: string; expiresInMs: number } {
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO oauth_states (state_hash, user_id, authorized, denied, expires_at, created_at)
     VALUES (?, NULL, 0, 0, ?, ?)`,
  ).run(sha256(state), expiresAt, nowIso());
  return { state, expiresInMs: OAUTH_STATE_TTL_MS };
}

export type OAuthStateStatus = {
  found: boolean;
  authorized: boolean;
  denied: boolean;
  expired: boolean;
};

/** Non-consuming status read for the poll loop (`/oauth/check`). */
export function getOAuthStateStatus(state: string): OAuthStateStatus {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(
    sha256(state),
  ) as OAuthStateRow | undefined;
  if (!row) return { found: false, authorized: false, denied: false, expired: false };
  const expired = Date.parse(row.expires_at) <= Date.now();
  return {
    found: true,
    authorized: row.authorized === 1 && !expired,
    denied: row.denied === 1,
    expired,
  };
}

/** Mark a state authorized by the given user (or denied). Returns false when invalid. */
export function setOAuthStateDecision(
  state: string,
  decision: "allow" | "deny",
  userId: string,
): boolean {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(
    sha256(state),
  ) as OAuthStateRow | undefined;
  if (!row) return false;
  if (Date.parse(row.expires_at) <= Date.now()) return false;
  if (row.authorized === 1 || row.denied === 1) return false; // already decided
  db.prepare(
    `UPDATE oauth_states SET authorized = ?, denied = ?, user_id = ? WHERE state_hash = ?`,
  ).run(decision === "allow" ? 1 : 0, decision === "deny" ? 1 : 0, userId, sha256(state));
  return true;
}

/**
 * Consume a state for token exchange. One-time use: the row is deleted
 * atomically, so a replayed state can never mint a second token pair.
 */
export function consumeOAuthState(state: string): { userId: string } | null {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").get(
    sha256(state),
  ) as OAuthStateRow | undefined;
  if (!row) return null;
  if (row.authorized !== 1 || row.denied === 1) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  if (!row.user_id) return null;
  db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(sha256(state));
  return { userId: row.user_id };
}

export type OAuthTokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  expiresInSeconds: number;
};

/** Issue a fresh access/refresh pair for a user. */
export function issueOAuthTokenPair(userId: string): OAuthTokenPair {
  const accessToken = generateToken(OAUTH_TOKEN_PREFIX);
  const refreshToken = generateToken(OAUTH_REFRESH_PREFIX);
  const now = Date.now();
  const accessExpiresAt = new Date(now + OAUTH_ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now + OAUTH_REFRESH_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO oauth_tokens (
      id, user_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, rotated_from, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    uuid(),
    userId,
    hashAccess(accessToken),
    hashRefresh(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    nowIso(),
  );
  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    expiresInSeconds: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
  };
}

/**
/**
 * Rotate a token pair. Both the access and refresh token change: the old
 * access dies immediately (its plaintext is never stored, so it cannot be
 * replayed after rotation). Pi-Web refreshes inside its credential-store
 * lock, so no request races the rotation window.
 */
export function refreshOAuthTokenPair(
  refreshToken: string,
): (OAuthTokenPair & { userId: string }) | null {
  const oldHash = hashRefresh(refreshToken);
  const row = db.prepare(
    "SELECT * FROM oauth_tokens WHERE refresh_hash = ?",
  ).get(oldHash) as OAuthTokenRow | undefined;
  if (!row) return null;
  if (Date.parse(row.refresh_expires_at) <= Date.now()) {
    db.prepare("DELETE FROM oauth_tokens WHERE id = ?").run(row.id);
    return null;
  }
  const accessToken = generateToken(OAUTH_TOKEN_PREFIX);
  const newRefresh = generateToken(OAUTH_REFRESH_PREFIX);
  const now = Date.now();
  const accessExpiresAt = new Date(now + OAUTH_ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now + OAUTH_REFRESH_TTL_MS).toISOString();
  db.prepare(
    `UPDATE oauth_tokens
     SET access_hash = ?, refresh_hash = ?, access_expires_at = ?,
         refresh_expires_at = ?, rotated_from = ?
     WHERE id = ?`,
  ).run(
    hashAccess(accessToken),
    hashRefresh(newRefresh),
    accessExpiresAt,
    refreshExpiresAt,
    oldHash,
    row.id,
  );
  return {
    userId: row.user_id,
    accessToken,
    refreshToken: newRefresh,
    accessExpiresAt,
    refreshExpiresAt,
    expiresInSeconds: Math.floor(OAUTH_ACCESS_TTL_MS / 1000),
  };
}

/** Revoke every token pair belonging to a user (logout / account suspension). */
export function revokeOAuthTokensForUser(userId: string): number {
  const result = db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").run(userId);
  return result.changes;
}

/**
 * Authenticate a raw `oat_…` access token against the proxy hot path.
 * Returns a synthetic ApiKey row bound to the owning user — identical shape
 * to a user-bound `la_` key, so `requireApiKey`/`beginRequestAccess` reuse
 * every existing gate (active account, subscription, model allow-list,
 * tier/plan rate limits, wallet billing) unchanged.
 */
export function authenticateOAuthToken(raw: string | null | undefined): ApiKey | null {
  const token = raw?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !token.startsWith(OAUTH_TOKEN_PREFIX)) return null;
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE access_hash = ?").get(
    hashAccess(token),
  ) as OAuthTokenRow | undefined;
  if (!row) return null;
  if (Date.parse(row.access_expires_at) <= Date.now()) {
    db.prepare("DELETE FROM oauth_tokens WHERE id = ?").run(row.id);
    return null;
  }
  const user = getUser(row.user_id);
  if (!user || user.status !== "active") return null;
  return {
    id: `oauth:${row.id}`,
    name: "OAuth access token",
    key_hash: row.access_hash,
    key_prefix: OAUTH_TOKEN_PREFIX,
    key_plain: null,
    enabled: 1,
    rate_limit: 0,
    created_at: row.created_at,
    last_used_at: null,
    user_id: row.user_id,
    allowed_models: "[]",
    tpm_limit: 0,
    concurrency_limit: 0,
    expires_at: null,
  };
}
