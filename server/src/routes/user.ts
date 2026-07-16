import { Router, Request, Response } from "express";
import { z } from "zod";
import { getSetting, type User } from "../db";
import { requireUser } from "../middleware/auth";
import { createApiKey, deleteApiKey, listApiKeys, updateApiKey } from "../services/keys";
import { getActiveSubscription } from "../services/plans";
import {
  getWallet,
  getUsageTotals,
  listDailyUsage,
  listModelPrices,
  listUsageRecords,
  listWalletLedger,
} from "../services/billing";
import {
  authenticateUser,
  createUserSession,
  publicUser,
  revokeUserSession,
  createUser,
  getUserByUsername,
} from "../services/users";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";
import { writeAudit } from "../services/audit";

export const userRouter = Router();

function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Invalid request body", issues: parsed.error.issues });
  return null;
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(256),
});
const registerSchema = z.object({
  username: z.string().trim().min(2).max(120),
  display_name: z.string().trim().max(120).optional(),
  password: z.string().min(8).max(256),
});
const keySchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  rate_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  tpm_limit: z.coerce.number().int().min(0).max(100_000_000).optional(),
  concurrency_limit: z.coerce.number().int().min(0).max(10_000).optional(),
  allowed_models: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

userRouter.post("/login", (req, res) => {
  const body = parseBody(loginSchema, req.body, res);
  if (!body) return;
  const limiterKey = `user-login:${req.ip || req.socket.remoteAddress || "unknown"}:${body.username.toLowerCase()}`;
  const rate = consumeRateLimit(limiterKey, 8, 5 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many login attempts" });
  }
  const user = authenticateUser(body.username, body.password);
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  resetRateLimit(limiterKey);
  const session = createUserSession(user.id);
  return res.json({ ...session, user: publicUser(user) });
});

userRouter.get("/config", (_req, res) => {
  return res.json({ registration_enabled: getSetting("registration_enabled") === "true" });
});

userRouter.post("/register", (req, res) => {
  if (getSetting("registration_enabled") !== "true") {
    return res.status(403).json({ error: "Registration is currently closed", code: "registration_closed" });
  }
  const body = parseBody(registerSchema, req.body, res);
  if (!body) return;
  const limiterKey = `user-register:${req.ip || req.socket.remoteAddress || "unknown"}:${body.username.toLowerCase()}`;
  const rate = consumeRateLimit(limiterKey, 3, 15 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many registration attempts" });
  }
  if (getUserByUsername(body.username)) {
    return res.status(409).json({ error: "Username is already registered", code: "username_taken" });
  }
  try {
    const user = createUser({
      username: body.username,
      display_name: body.display_name || body.username,
      password: body.password,
    });
    writeAudit({ action: "user.register", target_type: "user", target_id: user.id, detail: { username: user.username } });
    resetRateLimit(limiterKey);
    const session = createUserSession(user.id);
    return res.status(201).json({ ...session, user });
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : "Unable to register" });
  }
});

userRouter.use(requireUser);

function requestUser(req: Request) {
  return (req as Request & { user: User }).user;
}

userRouter.post("/logout", (req, res) => {
  revokeUserSession(req.header("x-user-token") || req.header("authorization"));
  return res.json({ ok: true });
});

userRouter.get("/me", (req, res) => {
  const user = requestUser(req);
  return res.json({
    user: publicUser(user),
    wallet: getWallet(user.id) ?? null,
    subscription: getActiveSubscription(user.id),
    prices: listModelPrices().filter((price) => price.enabled),
  });
});

userRouter.get("/dashboard", (req, res) => {
  const user = requestUser(req);
  return res.json({
    user: publicUser(user),
    wallet: getWallet(user.id) ?? null,
    subscription: getActiveSubscription(user.id),
    totals: getUsageTotals(user.id),
    trend: listDailyUsage(user.id, 30),
  });
});

userRouter.get("/keys", (req, res) => res.json({ items: listApiKeys(requestUser(req).id) }));
userRouter.post("/keys", (req, res) => {
  const body = parseBody(keySchema, req.body, res);
  if (!body) return;
  return res.status(201).json(createApiKey({ ...body, user_id: requestUser(req).id }));
});
userRouter.patch("/keys/:id", (req, res) => {
  const body = parseBody(keySchema.partial(), req.body, res);
  if (!body) return;
  const updated = updateApiKey(req.params.id, body, requestUser(req).id);
  if (!updated) return res.status(404).json({ error: "API key not found" });
  return res.json(updated);
});
userRouter.delete("/keys/:id", (req, res) => {
  const ok = deleteApiKey(req.params.id, requestUser(req).id);
  if (!ok) return res.status(404).json({ error: "API key not found" });
  return res.json({ ok: true });
});

userRouter.get("/usage", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  return res.json({ items: listUsageRecords(requestUser(req).id, limit) });
});
userRouter.get("/ledger", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  return res.json({ items: listWalletLedger(requestUser(req).id, limit) });
});
