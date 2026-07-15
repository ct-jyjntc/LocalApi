import { Request, Response, NextFunction } from "express";
import { getSetting } from "../db";
import { authenticateApiKey } from "../services/keys";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.header("x-admin-token") || req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  const admin = getSetting("admin_token") || "a2366021253";

  if (!token || token !== admin) {
    return res.status(401).json({ error: "Unauthorized admin password" });
  }
  return next();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization");
  const key = authenticateApiKey(auth);
  if (!key) {
    // Allow admin token as super-key for testing
    const admin = getSetting("admin_token") || "localapi-admin";
    const raw = auth?.replace(/^Bearer\s+/i, "").trim();
    if (raw && raw === admin) {
      (req as Request & { apiKey?: { id: string; name: string } }).apiKey = {
        id: "admin",
        name: "admin",
      };
      return next();
    }
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key",
        type: "authentication_error",
      },
    });
  }
  (req as Request & { apiKey?: { id: string; name: string } }).apiKey = {
    id: key.id,
    name: key.name,
  };
  return next();
}
