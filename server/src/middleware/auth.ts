import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getSetting } from "../db";
import { authenticateApiKey } from "../services/keys";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";
import { authenticateUserSession } from "../services/users";
import { hashAdminSecret, isHashedAdminSecret } from "../utils/admin-secret";
import type { ApiKey, User } from "../db";

// The admin token IS the admin password, so every admin endpoint is a login
// oracle. Without a failure budget here, an attacker who skips /login can
// brute-force the token against any protected endpoint at unlimited rate.
const ADMIN_AUTH_MAX_FAILURES = 10;
const ADMIN_AUTH_WINDOW_MS = 5 * 60_000;

function adminAuthFailKey(req: Request) {
  return `admin-auth-fail:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

function secretEquals(left: string, right: string) {
  const a = crypto.createHash("sha256").update(left, "utf8").digest();
  const b = crypto.createHash("sha256").update(right, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function verifyAdminToken(token: string) {
  const stored = getSetting("admin_token") || "";
  if (!token || !stored) return false;
  const expected = isHashedAdminSecret(stored) ? stored : hashAdminSecret(stored);
  return secretEquals(hashAdminSecret(token), expected);
}

/** Consume the shared per-IP failure budget used by /login AND requireAdmin. */
export function consumeAdminAuthFailure(req: Request) {
  return consumeRateLimit(adminAuthFailKey(req), ADMIN_AUTH_MAX_FAILURES, ADMIN_AUTH_WINDOW_MS);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.header("x-admin-token") || req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyAdminToken(token)) {
    const rate = consumeAdminAuthFailure(req);
    if (!rate.allowed) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: "Too many failed admin authentication attempts" });
    }
    return res.status(401).json({ error: "Unauthorized admin password" });
  }
  resetRateLimit(adminAuthFailKey(req));
  return next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  // Anthropic-style clients authenticate with x-api-key instead of an
  // Authorization bearer; accept both against the same key store.
  const auth = req.header("authorization") ?? req.header("x-api-key");
  const key = authenticateApiKey(auth);
  if (!key) {
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key",
        type: "authentication_error",
      },
    });
  }

  (req as Request & { apiKey?: ApiKey }).apiKey = key;
  return next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.header("x-user-token") || req.header("authorization");
  const user = authenticateUserSession(header);
  if (!user) return res.status(401).json({ error: "Invalid or expired user session" });
  (req as Request & { user?: User }).user = user;
  return next();
}
