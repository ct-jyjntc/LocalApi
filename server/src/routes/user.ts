import { Router, Request, Response } from "express";
import { z } from "zod";
import { getSetting, type User } from "../db";
import { requireUser } from "../middleware/auth";
import { createApiKey, deleteApiKey, listApiKeysPage, updateApiKey } from "../services/keys";
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
  getPublicWallet,
  getUsageTotals,
  listDailyUsage,
  listModelPrices,
  listUsageRecordsPage,
  listWalletLedgerPage,
} from "../services/billing";
import { applyPriceWindows } from "../services/price-windows";
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
import { createCaptcha, verifyCaptcha } from "../services/captcha";
import { writeAudit } from "../services/audit";
import {
  PaymentError,
  cancelPaymentOrder,
  createTopupOrder,
  deletePaymentOrder,
  getPaymentChannelPublic,
  getPaymentChannelsPublic,
  getPaymentOrder,
  listPaymentOrdersPage,
  syncPaymentOrder,
} from "../services/payments";
import { listCommerceLedgerPage, listCommerceOrdersPage } from "../services/commerce";
import { createFeedback, getFeedbackThread, listUserFeedback, replyFeedback } from "../services/feedback";
import {
  CheckinError,
  exchangePoints,
  getCheckinSettings,
  getCheckinStatus,
  performCheckin,
} from "../services/checkin";
import { mergeAuthProviderPublicStatus } from "../services/auth-providers";

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
  captcha_id: z.string().trim().min(1).max(80),
  captcha_answer: z.string().trim().min(1).max(16),
});
const userKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const userKeyPatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional() });
// L21: the number branch used to accept 1.234 via z.coerce.number().positive()
// while the string branch only allowed 2 decimals. Force the same 2-decimal
// rule for both so client rounding cannot disagree with the server.
const topupSchema = z.object({
  amount: z.union([
    z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
    z.number().positive().refine((n) => Number.isFinite(n) && /^\d+(?:\.\d{1,2})?$/.test(String(n)), {
      message: "Amount must have at most two decimal places",
    }),
  ]),
  channel_id: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["page", "wap", "native", "h5"]).optional(),
  client_request_id: z.string().trim().min(8).max(80).optional(),
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
  if ((getSetting("password_login_enabled") ?? "true") !== "true") {
    return res.status(403).json({
      error: "Password login is currently disabled",
      code: "password_login_disabled",
    });
  }
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
  const passwordRegistration = getSetting("registration_enabled") === "true";
  const passwordLogin = (getSetting("password_login_enabled") ?? "true") === "true";
  const authStatus = mergeAuthProviderPublicStatus();
  const linuxdoLogin = Boolean(authStatus.linuxdo_enabled);
  // Default true for backward compatibility when setting is missing.
  const linuxdoRegistration = (getSetting("linuxdo_registration_enabled") ?? "true") === "true";
  return res.json({
    registration_enabled: passwordRegistration,
    password_registration_enabled: passwordRegistration,
    password_login_enabled: passwordLogin,
    linuxdo_enabled: linuxdoLogin,
    linuxdo_login_enabled: linuxdoLogin,
    linuxdo_registration_enabled: linuxdoLogin && linuxdoRegistration,
    captcha_enabled: true,
    // Drive user-console feature flags (e.g. sidebar "Check-in").
    checkin_enabled: getCheckinSettings().enabled,
    ...authStatus,
  });
});

userRouter.get("/captcha", (req, res) => {
  if (getSetting("registration_enabled") !== "true") {
    return res.status(403).json({ error: "Registration is currently closed", code: "registration_closed" });
  }
  const limiterKey = `user-captcha:${req.ip || req.socket.remoteAddress || "unknown"}`;
  const rate = consumeRateLimit(limiterKey, 30, 10 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many captcha requests", code: "captcha_rate_limited" });
  }
  return res.json(createCaptcha());
});

userRouter.post("/register", (req, res) => {
  if (getSetting("registration_enabled") !== "true") {
    return res.status(403).json({ error: "Registration is currently closed", code: "registration_closed" });
  }
  const body = parseBody(registerSchema, req.body, res);
  if (!body) return;
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const limiterKey = `user-register:${clientIp}:${body.username.toLowerCase()}`;
  const ipLimiterKey = `user-register-ip:${clientIp}`;
  const rate = consumeRateLimit(limiterKey, 3, 15 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many registration attempts" });
  }
  const ipRate = consumeRateLimit(ipLimiterKey, 8, 15 * 60_000);
  if (!ipRate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(ipRate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many registration attempts" });
  }
  const captcha = verifyCaptcha(body.captcha_id, body.captcha_answer);
  if (!captcha.ok) {
    const message =
      captcha.code === "captcha_expired"
        ? "Captcha expired, please refresh"
        : captcha.code === "captcha_required"
          ? "Captcha is required"
          : "Incorrect captcha answer";
    return res.status(400).json({ error: message, code: captcha.code });
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
    wallet: getPublicWallet(user.id),
    tier: resolveUserTier(user.id),
    subscription: getActiveSubscription(user.id),
    prices: listModelPrices().filter((price) => price.enabled).map((price) => applyPriceWindows(price)),
  });
});
// L22: require a concrete image/* subtype and a base64 payload (data-URL or
// bare). The previous schema only checked /^image\// and accepted any string.
const attachmentSchema = z.object({
  name: z.string().max(160),
  type: z.string().regex(/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i),
  data: z.string().max(3_000_000).refine(
    (value) => /^(?:data:image\/[a-z0-9.+-]+;base64,)?[A-Za-z0-9+/=\s]+$/.test(value),
    { message: "Attachment data must be base64" },
  ),
});
// Feedback is stored as base64 attachments in SQLite, so both list endpoints
// are paginated (M10) — otherwise a busy user (or an admin panel with many
// users) loads every thread and every attachment into memory at once.
function feedbackPage(req: Request) {
  const limit = Number(req.query.limit ?? 100);
  const offset = Number(req.query.offset ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 100,
    offset: Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0,
  };
}
// One shared per-user budget for creating threads AND replying (M10): each
// message can carry up to 3×3 MB of base64 attachments, so unbounded posting
// is unbounded disk growth.
const FEEDBACK_RATE_LIMIT = 10;
const FEEDBACK_RATE_WINDOW_MS = 10 * 60_000;
function consumeFeedbackRate(userId: string, res: Response): boolean {
  const rate = consumeRateLimit(`feedback:${userId}`, FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_MS);
  if (rate.allowed) return true;
  res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
  res.status(429).json({ error: "Too many feedback messages", code: "feedback_rate_limited" });
  return false;
}
userRouter.get("/feedback", (req, res) => { const page = feedbackPage(req); return res.json(listUserFeedback(requestUser(req).id, page.limit, page.offset)); });
userRouter.post("/feedback", (req, res) => { if (!consumeFeedbackRate(requestUser(req).id, res)) return; const body=parseBody(z.object({subject:z.string().trim().min(2).max(160),body:z.string().trim().min(1).max(5000),attachments:z.array(attachmentSchema).max(3).default([])}),req.body,res); if(!body)return; return res.status(201).json(createFeedback(requestUser(req).id,body.subject,body.body,body.attachments)); });
userRouter.post("/feedback/:id/replies", (req,res)=>{const user=requestUser(req);if(!consumeFeedbackRate(user.id,res))return;const thread=getFeedbackThread(req.params.id);if(!thread||thread.user_id!==user.id)return res.status(404).json({error:"Feedback not found"});if(thread.status!=="open")return res.status(409).json({error:"Resolved feedback must be reopened by an administrator before replying",code:"feedback_resolved"});const body=parseBody(z.object({body:z.string().trim().max(5000).default(""),attachments:z.array(attachmentSchema).max(3).default([])}).refine(v=>v.body||v.attachments.length,{message:"Reply is empty"}),req.body,res);if(!body)return;const result=replyFeedback(req.params.id,"user",body.body,body.attachments,user.id);return result?res.json({messages:result}):res.status(404).json({error:"Feedback not found"});});
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
    wallet: getPublicWallet(user.id),
    subscription: getActiveSubscription(user.id),
    totals: getUsageTotals(user.id),
    trend: listDailyUsage(user.id, 30),
  });
});

userRouter.get("/keys", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listApiKeysPage({ userId: requestUser(req).id, limit, offset }));
});
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
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listUsageRecordsPage({ userId: requestUser(req).id, limit, offset }));
});
userRouter.get("/ledger", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listWalletLedgerPage({ userId: requestUser(req).id, limit, offset }));
});

userRouter.get("/checkin", (req, res) => {
  return res.json(getCheckinStatus(requestUser(req).id));
});

userRouter.post("/checkin", (req, res) => {
  try {
    const rate = consumeRateLimit(`checkin:${requestUser(req).id}`, 5, 60_000);
    if (!rate.allowed) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: "Too many check-in attempts", code: "rate_limited" });
    }
    return res.json(performCheckin(requestUser(req).id));
  } catch (error) {
    if (error instanceof CheckinError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : "Check-in failed" });
  }
});

userRouter.post("/points/exchange", (req, res) => {
  const body = parseBody(
    z.object({
      // Allow up to 2 decimal places (validated/rounded server-side).
      points: z.coerce.number().positive().max(1_000_000_000),
    }),
    req.body,
    res,
  );
  if (!body) return;
  try {
    const rate = consumeRateLimit(`points-exchange:${requestUser(req).id}`, 20, 60_000);
    if (!rate.allowed) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: "Too many exchange attempts", code: "rate_limited" });
    }
    return res.json(exchangePoints(requestUser(req).id, body.points));
  } catch (error) {
    if (error instanceof CheckinError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : "Exchange failed" });
  }
});

userRouter.get("/payments/config", (_req, res) => {
  const channels = getPaymentChannelsPublic();
  return res.json({ channel: getPaymentChannelPublic(), channels });
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
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listCommerceOrdersPage({ userId: requestUser(req).id, limit, offset }));
});
userRouter.get("/commerce/ledger", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listCommerceLedgerPage({ userId: requestUser(req).id, limit, offset }));
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
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listPaymentOrdersPage({ userId: requestUser(req).id, limit, offset }));
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
    const order = await createTopupOrder(user.id, body.amount, {
      channelId: body.channel_id,
      mode: body.mode,
      clientIp: req.ip || req.socket.remoteAddress || undefined,
      clientRequestId: body.client_request_id,
    });
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
