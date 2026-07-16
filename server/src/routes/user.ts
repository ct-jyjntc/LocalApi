import { Router, Request, Response } from "express";
import { z } from "zod";
import { getSetting, type User } from "../db";
import { requireUser } from "../middleware/auth";
import { createApiKey, deleteApiKey, listApiKeys, updateApiKey } from "../services/keys";
import {
  PlanTransactionError,
  getActiveSubscription,
  listPlanOrders,
  listPlans,
  purchasePlan,
  renewPlan,
  setSubscriptionAutoRenew,
  setSubscriptionOverage,
  upgradePlan,
} from "../services/plans";
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
  changeUserPassword,
  getUserByUsername,
} from "../services/users";
import { resolveUserTier } from "../services/tiers";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";
import { writeAudit } from "../services/audit";
import {
  PaymentError,
  cancelPaymentOrder,
  createTopupOrder,
  deletePaymentOrder,
  getPaymentChannelPublic,
  getPaymentOrder,
  listPaymentOrders,
  syncPaymentOrder,
} from "../services/payments";
import { listCommerceLedger, listCommerceOrders } from "../services/commerce";

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
const userKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const userKeyPatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional() });
const topupSchema = z.object({
  amount: z.union([
    z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
    z.coerce.number().positive(),
  ]),
});

function paymentFailure(res: Response, error: unknown) {
  if (error instanceof PaymentError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : "Payment operation failed" });
}

function planFailure(res: Response, error: unknown) {
  if (error instanceof PlanTransactionError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : "Plan operation failed" });
}

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
    tier: resolveUserTier(user.id),
    subscription: getActiveSubscription(user.id),
    prices: listModelPrices().filter((price) => price.enabled),
  });
});
userRouter.patch("/me/password", (req, res) => {
  const body = parseBody(
    z.object({ current_password: z.string().min(8).max(256), new_password: z.string().min(8).max(256) }),
    req.body,
    res,
  );
  if (!body) return;
  const ok = changeUserPassword(requestUser(req).id, body.current_password, body.new_password);
  if (!ok) return res.status(400).json({ error: "Current password is incorrect", code: "invalid_current_password" });
  return res.json({ ok: true });
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
  const body = parseBody(userKeyCreateSchema, req.body, res);
  if (!body) return;
  return res.status(201).json(createApiKey({ name: body.name, user_id: requestUser(req).id }));
});
userRouter.patch("/keys/:id", (req, res) => {
  const body = parseBody(userKeyPatchSchema, req.body, res);
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

userRouter.get("/payments/config", (_req, res) => {
  return res.json({ channel: getPaymentChannelPublic() });
});
userRouter.patch("/subscription/auto-renew", (req, res) => {
  const body = parseBody(z.object({ enabled: z.boolean() }), req.body, res);
  if (!body) return;
  const subscription = setSubscriptionAutoRenew(requestUser(req).id, body.enabled);
  if (!subscription) return res.status(404).json({ error: "Active subscription not found" });
  return res.json(subscription);
});
userRouter.patch("/subscription/overage", (req, res) => {
  const body = parseBody(z.object({ enabled: z.boolean() }), req.body, res);
  if (!body) return;
  try {
    const subscription = setSubscriptionOverage(requestUser(req).id, body.enabled);
    if (!subscription) return res.status(404).json({ error: "Active subscription not found" });
    return res.json(subscription);
  } catch (error) {
    return planFailure(res, error);
  }
});
userRouter.get("/plans", (_req, res) => {
  return res.json({ items: listPlans(true) });
});
userRouter.get("/plan-orders", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  return res.json({ items: listPlanOrders(requestUser(req).id, limit) });
});
userRouter.get("/commerce/orders", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  return res.json({ items: listCommerceOrders(requestUser(req).id, limit) });
});
userRouter.get("/commerce/ledger", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  return res.json({ items: listCommerceLedger(requestUser(req).id, limit) });
});
userRouter.post("/plans/:id/purchase", (req, res) => {
  const body = parseBody(z.object({ request_id: z.string().uuid().optional() }), req.body, res);
  if (!body) return;
  const user = requestUser(req);
  const rate = consumeRateLimit(`plan-transaction:${user.id}`, 10, 60_000);
  if (!rate.allowed) return res.status(429).json({ error: "Too many plan operations", code: "plan_rate_limited" });
  try {
    return res.status(201).json(purchasePlan(user.id, req.params.id, body.request_id));
  } catch (error) {
    return planFailure(res, error);
  }
});
userRouter.post("/subscription/upgrade", (req, res) => {
  const body = parseBody(
    z.object({ plan_id: z.string().uuid(), request_id: z.string().uuid().optional() }),
    req.body,
    res,
  );
  if (!body) return;
  const user = requestUser(req);
  const rate = consumeRateLimit(`plan-transaction:${user.id}`, 10, 60_000);
  if (!rate.allowed) return res.status(429).json({ error: "Too many plan operations", code: "plan_rate_limited" });
  try {
    return res.json(upgradePlan(user.id, body.plan_id, body.request_id));
  } catch (error) {
    return planFailure(res, error);
  }
});
userRouter.post("/subscription/renew", (req, res) => {
  const body = parseBody(z.object({ request_id: z.string().uuid().optional() }), req.body, res);
  if (!body) return;
  const user = requestUser(req);
  const rate = consumeRateLimit(`plan-transaction:${user.id}`, 10, 60_000);
  if (!rate.allowed) return res.status(429).json({ error: "Too many plan operations", code: "plan_rate_limited" });
  try {
    return res.json(renewPlan(user.id, body.request_id));
  } catch (error) {
    return planFailure(res, error);
  }
});
userRouter.get("/payments/orders", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  return res.json({ items: listPaymentOrders({ userId: requestUser(req).id, limit }) });
});
userRouter.get("/payments/orders/:id", (req, res) => {
  const order = getPaymentOrder(req.params.id, requestUser(req).id);
  if (!order) return res.status(404).json({ error: "Payment order not found" });
  return res.json(order);
});
userRouter.post("/payments/topups", async (req, res) => {
  const body = parseBody(topupSchema, req.body, res);
  if (!body) return;
  const user = requestUser(req);
  const rate = consumeRateLimit(`payment-topup:${user.id}`, 10, 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many payment orders", code: "payment_rate_limited" });
  }
  try {
    const order = await createTopupOrder(user.id, body.amount);
    return res.status(201).json(order);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
userRouter.post("/payments/orders/:id/sync", async (req, res) => {
  const user = requestUser(req);
  const rate = consumeRateLimit(`payment-sync:${user.id}`, 30, 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many payment queries", code: "payment_rate_limited" });
  }
  try {
    return res.json(await syncPaymentOrder(req.params.id, user.id));
  } catch (error) {
    return paymentFailure(res, error);
  }
});
userRouter.post("/payments/orders/:id/cancel", (req, res) => {
  try {
    return res.json(cancelPaymentOrder(req.params.id, requestUser(req).id));
  } catch (error) {
    return paymentFailure(res, error);
  }
});
userRouter.delete("/payments/orders/:id", (req, res) => {
  try {
    return res.json({ ok: deletePaymentOrder(req.params.id, requestUser(req).id) });
  } catch (error) {
    return paymentFailure(res, error);
  }
});
