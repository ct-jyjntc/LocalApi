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
  updatePlan,
} from "../services/plans";
import { createUser, deleteUser, listUsers, updateUser } from "../services/users";
import { listAuditLogs, writeAudit } from "../services/audit";

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
  allowed_models: models,
  ...limits,
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
  included_credits_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  allowed_models: models,
  ...limits,
  overage_enabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

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
  const subscription = assignPlan(req.params.id, body.plan_id, body.auto_renew !== false);
  if (!subscription) return res.status(404).json({ error: "Plan not found or disabled" });
  writeAudit({ action: "subscription.assign", target_type: "user", target_id: req.params.id, detail: body });
  return res.json(subscription);
});
commercialAdminRouter.delete("/users/:id/subscription", (req, res) => {
  const ok = cancelSubscription(req.params.id);
  writeAudit({ action: "subscription.cancel", target_type: "user", target_id: req.params.id });
  return res.json({ ok });
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
