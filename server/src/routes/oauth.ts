/**
 * OAuth broker routes for the Pi-Web provider integration.
 *
 * Flow (AtomGit broker pattern, no callback port needed):
 *   GET  /oauth/login      → { login_url, state }   (Pi-Web opens login_url)
 *   GET  /oauth/authorize  → SPA consent page (frontend, not here)
 *   POST /oauth/authorize  → { state, action } with user session → binds user
 *   GET  /oauth/check      → { valid }              (Pi-Web polls)
 *   GET  /oauth/token      → { access_token, refresh_token, expires_in, user }
 *   POST /oauth/refresh    → rotated token pair
 *
 * The access token (`oat_…`) doubles as a user-bound API key for both the
 * wallet (`/v1/*`) and subscription (`/coding/v1/*`) endpoint families —
 * see services/oauth.ts.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireUser } from "../middleware/auth";
import { consumeRateLimit } from "../services/rate-limit";
import { getPublicBaseUrl } from "../utils/public-url";
import { publicUser, getUser } from "../services/users";
import {
  consumeOAuthState,
  createOAuthLoginState,
  getOAuthStateStatus,
  issueOAuthTokenPair,
  refreshOAuthTokenPair,
  setOAuthStateDecision,
} from "../services/oauth";

export const oauthRouter = Router();

const LOGIN_RATE_LIMIT = 30;
const LOGIN_RATE_WINDOW_MS = 5 * 60_000;

function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function buildLoginUrl(req: Request, state: string): string {
  const base = (getPublicBaseUrl() || `${req.protocol}://${req.get("host") || ""}`).replace(/\/+$/, "");
  return `${base}/oauth/authorize?state=${encodeURIComponent(state)}`;
}

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: message, code });
}

/** Start a login: mint a one-time state and hand back the browser URL. */
oauthRouter.get("/login", (req: Request, res: Response) => {
  const limiterKey = `oauth-login:${clientIp(req)}`;
  const rate = consumeRateLimit(limiterKey, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return sendError(res, 429, "rate_limited", "Too many OAuth login requests");
  }
  const { state, expiresInMs } = createOAuthLoginState();
  return res.json({
    login_url: buildLoginUrl(req, state),
    state,
    expires_in: Math.floor(expiresInMs / 1000),
  });
});

/** Poll target: never consumes the state, so the loop can retry freely. */
oauthRouter.get("/check", (req: Request, res: Response) => {
  const state = String(req.query?.state || "");
  if (!state) return sendError(res, 400, "invalid_state", "Missing state");
  const status = getOAuthStateStatus(state);
  return res.json({ valid: status.found && status.authorized });
});

/** Browser consent decision (authenticated with a user session token). */
oauthRouter.post("/authorize", requireUser, (req: Request, res: Response) => {
  const body = z
    .object({ state: z.string().min(1), action: z.enum(["allow", "deny"]) })
    .safeParse(req.body ?? {});
  if (!body.success) return sendError(res, 400, "invalid_state", "Missing or malformed state/action");
  const user = (req as Request & { user?: { id: string } }).user;
  const status = getOAuthStateStatus(body.data.state);
  if (!status.found) return sendError(res, 400, "invalid_state", "Unknown state");
  if (status.expired) return sendError(res, 410, "state_expired", "Authorization request expired");
  const decided = setOAuthStateDecision(body.data.state, body.data.action, user!.id);
  if (!decided) return sendError(res, 400, "invalid_state", "State already decided or expired");
  return res.json({ ok: true });
});

/** One-time exchange: consume the state and mint an access/refresh pair. */
oauthRouter.get("/token", (req: Request, res: Response) => {
  const state = String(req.query?.state || "");
  if (!state) return sendError(res, 400, "invalid_state", "Missing state");
  const status = getOAuthStateStatus(state);
  if (status.found && status.expired) {
    return sendError(res, 410, "state_expired", "Authorization request expired");
  }
  const consumed = consumeOAuthState(state);
  if (!consumed) return sendError(res, 400, "invalid_state", "Invalid, already used or unauthorized state");
  const pair = issueOAuthTokenPair(consumed.userId);
  const user = getUser(consumed.userId);
  return res.json({
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    token_type: "bearer",
    expires_in: pair.expiresInSeconds,
    user: user ? publicUser(user) : { id: consumed.userId },
  });
});

/** Rotate a refresh token (old refresh dies immediately). */
oauthRouter.post("/refresh", (req: Request, res: Response) => {
  const body = z.object({ refresh_token: z.string().min(1) }).safeParse(req.body ?? {});
  if (!body.success) return sendError(res, 400, "invalid_grant", "Missing refresh_token");
  const pair = refreshOAuthTokenPair(body.data.refresh_token);
  if (!pair) return sendError(res, 401, "invalid_grant", "Invalid or expired refresh token");
  const user = getUser(pair.userId);
  return res.json({
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    token_type: "bearer",
    expires_in: pair.expiresInSeconds,
    user: user ? publicUser(user) : undefined,
  });
});
