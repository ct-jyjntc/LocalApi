import { Router, Request, Response } from "express";
import { z } from "zod";
import type { User } from "../db";
import { requireUser } from "../middleware/auth";
import { createApiKey, deleteApiKey, listApiKeys, updateApiKey } from "../services/keys";
import { getLog, listLogs } from "../services/logs";
import { getActiveSubscription } from "../services/plans";
import {
  getWallet,
  listModelPrices,
  listUsageRecords,
  listWalletLedger,
} from "../services/billing";
import {
  authenticateUser,
  createUserSession,
  publicUser,
  revokeUserSession,
} from "../services/users";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";

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
  const usage = listUsageRecords(user.id, 500) as Array<Record<string, unknown>>;
  const totals = usage.reduce<{
    requests: number;
    cost_micros: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
  }>(
    (acc, row) => {
      acc.requests += 1;
      acc.cost_micros += Number(row.cost_micros || 0);
      acc.prompt_tokens += Number(row.prompt_tokens || 0);
      acc.completion_tokens += Number(row.completion_tokens || 0);
      acc.cached_tokens += Number(row.cached_tokens || 0);
      return acc;
    },
    { requests: 0, cost_micros: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 },
  );
  return res.json({
    user: publicUser(user),
    wallet: getWallet(user.id) ?? null,
    subscription: getActiveSubscription(user.id),
    totals,
    recent: usage.slice(0, 20),
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
userRouter.get("/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  return res.json(listLogs(limit, offset, requestUser(req).id));
});
userRouter.get("/logs/:id", (req, res) => {
  const log = getLog(req.params.id, requestUser(req).id);
  if (!log) return res.status(404).json({ error: "Log not found" });
  return res.json(log);
});
