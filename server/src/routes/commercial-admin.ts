import { Router, Response } from "express";
import { z } from "zod";
import {
  adjustWallet,
  deleteModelPrice,
  listModelPrices,
  listUsageRecords,
  listWalletLedger,
  upsertModelPrice,
} from "../services/billing";
import {
  assignPlan,
  cancelSubscription,
  createPlan,
  deletePlan,
  listPlans,
  PlanTransactionError,
  reorderPlans,
  updatePlan,
} from "../services/plans";
import { createUser, deleteUser, listUsers, updateUser } from "../services/users";
import { listAuditLogs, writeAudit } from "../services/audit";
import {
  PaymentError,
  cancelPaymentOrder,
  deletePaymentOrder,
  getPaymentChannelAdmin,
  listPaymentOrders,
  listPaymentRefunds,
  refundPaymentOrder,
  syncPaymentOrder,
  updatePaymentChannel,
} from "../services/payments";
import { createUserTier, deleteUserTier, listUserTiers, TierError, updateUserTier } from "../services/tiers";

export const commercialAdminRouter = Router();

function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Invalid request body", issues: parsed.error.issues });
  return null;
}

const models = z.array(z.string().trim().min(1).max(200)).max(256).optional();
const limits = {
  rpm_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  tpm_limit: z.coerce.number().int().min(0).max(100_000_000).optional(),
  concurrency_limit: z.coerce.number().int().min(0).max(10_000).optional(),
};
const userSchema = z.object({
  username: z.string().trim().min(2).max(120),
  display_name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).max(256),
  status: z.enum(["active", "suspended", "disabled"]).optional(),
});
const userPatchSchema = userSchema.omit({ username: true }).partial();
const priceSchema = z.object({
  model: z.string().trim().min(1).max(200),
  input_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  output_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cache_read_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  cache_write_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  enabled: z.boolean().optional(),
});
const planSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  cycle_days: z.coerce.number().int().min(1).max(3650).optional(),
  price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  included_credits_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  allowed_models: models,
  ...limits,
  overage_enabled: z.boolean().optional(),
  stock_limit: z.coerce.number().int().min(0).max(100_000_000).optional(),
  enabled: z.boolean().optional(),
});
const paymentChannelSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  client_id: z.string().trim().max(256).optional(),
  client_secret: z.string().trim().max(512).optional(),
  gateway_url: z.string().url().max(500).optional(),
  exchange_rate_micros: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  min_amount_minor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  max_amount_minor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  fee_bps: z.coerce.number().int().min(0).max(10_000).optional(),
  fee_fixed_minor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const tierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  threshold_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rpm_limit: z.coerce.number().int().min(0).max(1_000_000),
  tpm_limit: z.coerce.number().int().min(0).max(100_000_000),
  concurrency_limit: z.coerce.number().int().min(0).max(10_000),
  enabled: z.boolean().optional(),
});

function paymentFailure(res: Response, error: unknown) {
  if (error instanceof PaymentError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: error instanceof Error ? error.message : "Payment operation failed" });
}

commercialAdminRouter.get("/users", (_req, res) => res.json({ items: listUsers() }));
commercialAdminRouter.post("/users", (req, res) => {
  const body = parseBody(userSchema, req.body, res);
  if (!body) return;
  try {
    const user = createUser(body);
    writeAudit({ action: "user.create", target_type: "user", target_id: user.id, detail: { username: user.username } });
    return res.status(201).json(user);
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : "User already exists" });
  }
});
commercialAdminRouter.patch("/users/:id", (req, res) => {
  const body = parseBody(userPatchSchema, req.body, res);
  if (!body) return;
  const user = updateUser(req.params.id, body);
  if (!user) return res.status(404).json({ error: "User not found" });
  writeAudit({ action: "user.update", target_type: "user", target_id: user.id, detail: body });
  return res.json(user);
});
commercialAdminRouter.delete("/users/:id", (req, res) => {
  const ok = deleteUser(req.params.id);
  if (!ok) return res.status(404).json({ error: "User not found" });
  writeAudit({ action: "user.delete", target_type: "user", target_id: req.params.id });
  return res.json({ ok: true });
});
commercialAdminRouter.post("/users/:id/wallet", (req, res) => {
  const body = parseBody(
    z.object({
      amount_micros: z.coerce.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      description: z.string().trim().min(1).max(500),
    }),
    req.body,
    res,
  );
  if (!body) return;
  const wallet = adjustWallet(req.params.id, body.amount_micros, body.description);
  writeAudit({ action: "wallet.adjust", target_type: "user", target_id: req.params.id, detail: body });
  return res.json(wallet);
});
commercialAdminRouter.get("/users/:id/ledger", (req, res) => {
  return res.json({ items: listWalletLedger(req.params.id, 500) });
});
commercialAdminRouter.post("/users/:id/subscription", (req, res) => {
  const body = parseBody(z.object({ plan_id: z.string().uuid(), auto_renew: z.boolean().optional() }), req.body, res);
  if (!body) return;
  let subscription;
  try {
    subscription = assignPlan(req.params.id, body.plan_id, body.auto_renew !== false);
  } catch (error) {
    if (error instanceof Error && error.message === "Plan inventory is exhausted") {
      return res.status(409).json({ error: error.message, code: "plan_inventory_exhausted" });
    }
    return res.status(404).json({ error: error instanceof Error ? error.message : "Plan not found or disabled" });
  }
  if (!subscription) return res.status(404).json({ error: "Plan not found or disabled" });
  writeAudit({ action: "subscription.assign", target_type: "user", target_id: req.params.id, detail: body });
  return res.json(subscription);
});
commercialAdminRouter.delete("/users/:id/subscription", (req, res) => {
  const ok = cancelSubscription(req.params.id);
  writeAudit({ action: "subscription.cancel", target_type: "user", target_id: req.params.id });
  return res.json({ ok });
});

commercialAdminRouter.get("/tiers", (_req, res) => res.json({ items: listUserTiers() }));
commercialAdminRouter.post("/tiers", (req, res) => {
  const body = parseBody(tierSchema, req.body, res);
  if (!body) return;
  try {
    const tier = createUserTier(body);
    writeAudit({ action: "tier.create", target_type: "user_tier", target_id: tier.id, detail: body });
    return res.status(201).json(tier);
  } catch (error) {
    const status = error instanceof TierError ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : "Unable to create tier" });
  }
});
commercialAdminRouter.patch("/tiers/:id", (req, res) => {
  const body = parseBody(tierSchema.partial(), req.body, res);
  if (!body) return;
  try {
    const tier = updateUserTier(req.params.id, body);
    if (!tier) return res.status(404).json({ error: "Tier not found" });
    writeAudit({ action: "tier.update", target_type: "user_tier", target_id: tier.id, detail: body });
    return res.json(tier);
  } catch (error) {
    const status = error instanceof TierError ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : "Unable to update tier" });
  }
});
commercialAdminRouter.delete("/tiers/:id", (req, res) => {
  try {
    const ok = deleteUserTier(req.params.id);
    if (!ok) return res.status(404).json({ error: "Tier not found" });
    writeAudit({ action: "tier.delete", target_type: "user_tier", target_id: req.params.id });
    return res.json({ ok: true });
  } catch (error) {
    const status = error instanceof TierError ? error.status : 500;
    return res.status(status).json({ error: error instanceof Error ? error.message : "Unable to delete tier" });
  }
});

commercialAdminRouter.get("/prices", (_req, res) => res.json({ items: listModelPrices() }));
commercialAdminRouter.put("/prices/:model", (req, res) => {
  const decodedModel = decodeURIComponent(req.params.model);
  const body = parseBody(priceSchema.omit({ model: true }).extend({ model: z.string().optional() }), req.body, res);
  if (!body) return;
  const price = upsertModelPrice({ ...body, model: decodedModel });
  writeAudit({ action: "price.upsert", target_type: "model", target_id: decodedModel, detail: body });
  return res.json(price);
});
commercialAdminRouter.delete("/prices/:model", (req, res) => {
  const model = decodeURIComponent(req.params.model);
  const ok = deleteModelPrice(model);
  writeAudit({ action: "price.delete", target_type: "model", target_id: model });
  return res.json({ ok });
});

commercialAdminRouter.get("/plans", (_req, res) => res.json({ items: listPlans() }));
commercialAdminRouter.post("/plans", (req, res) => {
  const body = parseBody(planSchema, req.body, res);
  if (!body) return;
  try {
    const plan = createPlan(body);
    writeAudit({ action: "plan.create", target_type: "plan", target_id: plan.id, detail: body });
    return res.status(201).json(plan);
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : "Plan already exists" });
  }
});
commercialAdminRouter.put("/plans/reorder", (req, res) => {
  const body = parseBody(z.object({ ids: z.array(z.string().uuid()).min(1).max(10_000) }), req.body, res);
  if (!body) return;
  try {
    const items = reorderPlans(body.ids);
    writeAudit({ action: "plan.reorder", target_type: "plan", detail: { ids: body.ids } });
    return res.json({ items });
  } catch (error) {
    if (error instanceof PlanTransactionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to reorder plans" });
  }
});
commercialAdminRouter.patch("/plans/:id", (req, res) => {
  const body = parseBody(planSchema.partial(), req.body, res);
  if (!body) return;
  const plan = updatePlan(req.params.id, body);
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  writeAudit({ action: "plan.update", target_type: "plan", target_id: req.params.id, detail: body });
  return res.json(plan);
});
commercialAdminRouter.delete("/plans/:id", (req, res) => {
  const ok = deletePlan(req.params.id);
  writeAudit({ action: "plan.delete", target_type: "plan", target_id: req.params.id });
  return res.json({ ok });
});

commercialAdminRouter.get("/usage", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const userId = typeof req.query.user_id === "string" ? req.query.user_id : undefined;
  return res.json({ items: listUsageRecords(userId, limit) });
});
commercialAdminRouter.get("/audit", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  return res.json({ items: listAuditLogs(limit) });
});

commercialAdminRouter.get("/payments/channel", (_req, res) => {
  return res.json(getPaymentChannelAdmin());
});
commercialAdminRouter.put("/payments/channel", (req, res) => {
  const body = parseBody(paymentChannelSchema, req.body, res);
  if (!body) return;
  try {
    const channel = updatePaymentChannel(body);
    writeAudit({
      action: "payment.channel.update",
      target_type: "payment_channel",
      target_id: "linuxdo-credit",
      detail: { ...body, client_secret: body.client_secret === undefined ? undefined : "[updated]" },
    });
    return res.json(channel);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.get("/payments/orders", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
  return res.json({ items: listPaymentOrders({ status, limit }) });
});
commercialAdminRouter.post("/payments/orders/:id/sync", async (req, res) => {
  try {
    const order = await syncPaymentOrder(req.params.id);
    writeAudit({ action: "payment.order.sync", target_type: "payment_order", target_id: req.params.id });
    return res.json(order);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.post("/payments/orders/:id/refund", async (req, res) => {
  const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }), req.body, res);
  if (!body) return;
  try {
    const order = await refundPaymentOrder(req.params.id, body.reason);
    writeAudit({
      action: "payment.order.refund",
      target_type: "payment_order",
      target_id: req.params.id,
      detail: { reason: body.reason },
    });
    return res.json(order);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.get("/payments/refunds", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  return res.json({ items: listPaymentRefunds(limit) });
});
commercialAdminRouter.post("/payments/orders/:id/cancel", (req, res) => {
  try {
    const order = cancelPaymentOrder(req.params.id);
    writeAudit({ action: "payment.order.cancel", target_type: "payment_order", target_id: req.params.id });
    return res.json(order);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.delete("/payments/orders/:id", (req, res) => {
  try {
    const ok = deletePaymentOrder(req.params.id);
    writeAudit({ action: "payment.order.delete", target_type: "payment_order", target_id: req.params.id });
    return res.json({ ok });
  } catch (error) {
    return paymentFailure(res, error);
  }
});
