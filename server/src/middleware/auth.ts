import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getSetting } from "../db";
import { authenticateApiKey } from "../services/keys";
import { authenticateUserSession } from "../services/users";
import type { ApiKey, User } from "../db";

function secretEquals(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyAdminToken(token: string) {
  const admin = getSetting("admin_token") || "";
  return Boolean(token && admin && secretEquals(token, admin));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.header("x-admin-token") || req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: "Unauthorized admin password" });
  }
  return next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization");
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
