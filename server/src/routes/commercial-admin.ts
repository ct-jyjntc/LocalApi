import { Router, Response } from "express";
import { z } from "zod";
import {
  adjustWallet,
  deleteModelPrice,
  listModelPrices,
  listUsageRecordsPage,
  listWalletLedgerPage,
  upsertModelPrice,
} from "../services/billing";
import { parsePriceWindows } from "../services/price-windows";
import {
  adjustSubscriptionCredits,
  assignPlan,
  cancelSubscription,
  createPlan,
  deletePlan,
  listPlans,
  PlanTransactionError,
  reorderPlans,
  updatePlan,
} from "../services/plans";
import { adjustPoints, CheckinError } from "../services/checkin";
import { createUser, deleteUser, deleteUsers, listUsersPage, setUsersStatus, updateUser } from "../services/users";
import { listRiskRadar, resolveRiskGroup } from "../services/risk-radar";
import { analyzeRiskGroup, getRiskRadarAIModel, setRiskRadarAIModel } from "../services/risk-ai";
import { listAuditLogs, writeAudit } from "../services/audit";
import {
  PaymentError,
  cancelPaymentOrder,
  deletePaymentOrder,
  getPaymentChannelAdmin,
  getPaymentChannelsAdmin,
  listPaymentOrdersPage,
  listPaymentRefunds,
  refundPaymentOrder,
  syncPaymentOrder,
  updatePaymentChannel,
} from "../services/payments";
import { createUserTier, deleteUserTier, listUserTiers, TierError, updateUserTier } from "../services/tiers";
import { listAllFeedback, replyFeedback, setFeedbackStatus } from "../services/feedback";
import {
  createPromptPreset,
  deletePromptPreset,
  getPromptPreset,
  listPromptPresets,
} from "../services/prompt-presets";

export const commercialAdminRouter = Router();

function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Invalid request body", issues: parsed.error.issues });
  return null;
}

const models = z.array(z.string().trim().min(1).max(200)).max(256).optional();
const feedbackAttachmentSchema = z.object({
  name: z.string().max(160),
  type: z.string().regex(/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i),
  data: z.string().max(3_000_000).refine(
    (value) => /^(?:data:image\/[a-z0-9.+-]+;base64,)?[A-Za-z0-9+/=\s]+$/.test(value),
    { message: "Attachment data must be base64" },
  ),
});
const limits = {
  rpm_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  tpm_limit: z.coerce.number().int().min(0).max(100_000_000).optional(),
  concurrency_limit: z.coerce.number().int().min(0).max(10_000).optional(),
};
const userSchema = z.object({
  username: z.string().trim().min(2).max(120),
  display_name: z.string().trim().max(120).optional().transform((value) => value || undefined),
  password: z.string().min(8).max(256),
  status: z.enum(["active", "suspended", "disabled"]).optional(),
  // Admin-only LinuxDo identity binding. Empty string clears the binding.
  linuxdo_uid: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => (value ? value : null)),
});
const userPatchSchema = userSchema.omit({ username: true }).partial();
const priceWindowSchema = z.object({
  start: z.string().trim().min(4).max(8),
  end: z.string().trim().min(4).max(8),
  days: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),
  input_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  output_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cache_read_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  cache_write_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const priceSchema = z.object({
  model: z.string().trim().min(1).max(200),
  input_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  output_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cache_read_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  cache_write_price_micros: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  reasoning_enabled: z.boolean().optional(),
  reasoning_effort: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  image_input: z.boolean().optional(),
  context_window: z.coerce.number().int().min(0).max(10_000_000).optional(),
  max_output_tokens: z.coerce.number().int().min(0).max(10_000_000).optional(),
  enabled: z.boolean().optional(),
  windows: z.array(priceWindowSchema).max(16).optional(),
  prompt_preset_ids: z.array(z.string().uuid()).max(20).optional(),
});
const promptPresetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filename: z.string().trim().max(200).optional().default(""),
  content: z.string().min(1).max(2_000_000),
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
  visible: z.boolean().optional(),
});
const paymentChannelSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  client_id: z.string().trim().max(256).optional(),
  client_secret: z.string().trim().max(16_000).optional(),
  gateway_url: z.string().url().max(500).optional(),
  exchange_rate_micros: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  min_amount_minor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  max_amount_minor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  fee_bps: z.coerce.number().int().min(0).max(10_000).optional(),
  fee_fixed_minor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  alipay_public_key: z.string().trim().max(16_000).optional(),
  seller_id: z.string().trim().max(64).optional(),
  web_enabled: z.boolean().optional(),
  wap_enabled: z.boolean().optional(),
  wechat_app_id: z.string().trim().max(128).optional(),
  wechat_serial_no: z.string().trim().max(128).optional(),
  wechat_private_key: z.string().trim().max(16_000).optional(),
  wechat_platform_certificate: z.string().trim().max(32_000).optional(),
  wechat_platform_serial_no: z.string().trim().max(128).optional(),
  wechat_native_enabled: z.boolean().optional(),
  wechat_h5_enabled: z.boolean().optional(),
  wechat_h5_type: z.enum(["Wap", "iOS", "Android"]).optional(),
  wechat_h5_app_name: z.string().trim().max(128).optional(),
  wechat_h5_app_url: z.union([z.string().url().max(500), z.literal("")]).optional(),
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

commercialAdminRouter.get("/users", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  // Backward compatible: omit limit => paginated default 50.
  // Pass limit=0 to request a capped large page for lightweight maps (max 200).
  if (req.query.all === "1") {
    return res.json(listUsersPage({ limit: 200, offset: 0, q, status }));
  }
  return res.json(listUsersPage({
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
    q,
    status,
  }));
});

commercialAdminRouter.get("/risk-radar", (req, res) => {
  const hours = Number(req.query.hours ?? 72);
  return res.json(listRiskRadar(Number.isFinite(hours) ? hours : 72));
});
commercialAdminRouter.post("/risk-radar/groups/:id/resolve", (req, res) => {
  const body = parseBody(z.object({ action: z.enum(["disabled", "suspended", "ignored"]) }), req.body, res);
  if (!body) return;
  const result = resolveRiskGroup(req.params.id, body.action);
  if (!result) return res.status(404).json({ error: "Risk group not found" });
  writeAudit({
    action: "risk.group.resolve",
    target_type: "risk_group",
    target_id: req.params.id,
    detail: { action: body.action, updated: result.updated, ids: result.ids },
  });
  return res.json(result);
});
commercialAdminRouter.get("/risk-radar/ai-model", (_req, res) => {
  return res.json({ model: getRiskRadarAIModel() });
});
commercialAdminRouter.post("/risk-radar/ai-model", (req, res) => {
  const body = parseBody(z.object({ model: z.string().max(200) }), req.body, res);
  if (!body) return;
  setRiskRadarAIModel(body.model);
  return res.json({ ok: true, model: body.model });
});
commercialAdminRouter.post("/risk-radar/groups/:id/analyze", async (req, res) => {
  try {
    const result = await analyzeRiskGroup(req.params.id);
    if (!result) return res.status(404).json({ error: "Risk group not found" });
    writeAudit({
      action: "risk.group.analyze",
      target_type: "risk_group",
      target_id: req.params.id,
      detail: { score: result.score, verdict: result.verdict },
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Analysis failed" });
  }
});
// M10: the admin feedback list loads every thread AND every message with its
// base64 attachments into memory — unbounded as users file feedback. Default
// 100/page, capped at 500; the web panel can page through with limit/offset.
commercialAdminRouter.get("/feedback", (req,res)=>{const limit=Number(req.query.limit??100);const offset=Number(req.query.offset??0);return res.json(listAllFeedback(Number.isFinite(limit)?Math.min(500,Math.max(1,Math.trunc(limit))):100,Number.isFinite(offset)?Math.max(0,Math.trunc(offset)):0));});
commercialAdminRouter.post("/feedback/:id/replies",(req,res)=>{const body=parseBody(z.object({body:z.string().trim().max(5000).default(""),attachments:z.array(feedbackAttachmentSchema).max(3).default([])}).refine(v=>v.body||v.attachments.length,{message:"Reply is empty"}),req.body,res);if(!body)return;const result=replyFeedback(req.params.id,"admin",body.body,body.attachments);return result?res.json({messages:result}):res.status(404).json({error:"Feedback not found"});});
commercialAdminRouter.patch("/feedback/:id",(req,res)=>{const body=parseBody(z.object({status:z.enum(["open","resolved"])}),req.body,res);if(!body)return;return setFeedbackStatus(req.params.id,body.status)?res.json({ok:true}):res.status(404).json({error:"Feedback not found"});});
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
commercialAdminRouter.post("/users/batch/status", (req, res) => {
  const body = parseBody(
    z.object({
      ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500),
      status: z.enum(["active", "suspended", "disabled"]),
    }),
    req.body,
    res,
  );
  if (!body) return;
  const result = setUsersStatus(body.ids, body.status);
  writeAudit({
    action: "user.batch_status",
    target_type: "user",
    target_id: result.ids[0] || null,
    detail: { status: body.status, count: result.updated, ids: result.ids },
  });
  return res.json({ ok: true, ...result });
});
commercialAdminRouter.post("/users/batch/delete", (req, res) => {
  const body = parseBody(
    z.object({
      ids: z.array(z.string().trim().min(1).max(80)).min(1).max(500),
    }),
    req.body,
    res,
  );
  if (!body) return;
  const result = deleteUsers(body.ids);
  writeAudit({
    action: "user.batch_delete",
    target_type: "user",
    target_id: result.ids[0] || null,
    detail: { count: result.deleted, ids: result.ids },
  });
  return res.json({ ok: true, ...result });
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
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return res.json(listWalletLedgerPage({ userId: req.params.id, limit, offset }));
});
commercialAdminRouter.post("/users/:id/subscription", (req, res) => {
  const body = parseBody(z.object({ plan_id: z.string().uuid(), auto_renew: z.boolean().optional() }), req.body, res);
  if (!body) return;
  let subscription;
  try {
    subscription = assignPlan(req.params.id, body.plan_id, body.auto_renew !== false);
  } catch (error) {
    // L11: assignPlan now throws PlanTransactionError with status/code.
    if (error instanceof PlanTransactionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to assign plan" });
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
commercialAdminRouter.post("/users/:id/subscription/credits", (req, res) => {
  const body = parseBody(
    z.object({
      amount_micros: z.coerce.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      description: z.string().trim().min(1).max(500).optional(),
    }),
    req.body,
    res,
  );
  if (!body) return;
  try {
    const result = adjustSubscriptionCredits(req.params.id, body.amount_micros, body.description);
    writeAudit({
      action: "subscription.credits.adjust",
      target_type: "user",
      target_id: req.params.id,
      detail: body,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof PlanTransactionError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to adjust plan credits",
    });
  }
});
commercialAdminRouter.post("/users/:id/points", (req, res) => {
  const body = parseBody(
    z.object({
      points: z.coerce.number().min(-1_000_000_000).max(1_000_000_000),
      description: z.string().trim().min(1).max(500).optional(),
    }),
    req.body,
    res,
  );
  if (!body) return;
  try {
    const result = adjustPoints(req.params.id, body.points, body.description || "Admin points adjustment");
    writeAudit({
      action: "points.adjust",
      target_type: "user",
      target_id: req.params.id,
      detail: body,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof CheckinError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to adjust points",
    });
  }
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
  const price = upsertModelPrice({
    ...body,
    model: decodedModel,
    windows: body.windows ? parsePriceWindows(body.windows) : undefined,
  });
  writeAudit({ action: "price.upsert", target_type: "model", target_id: decodedModel, detail: body });
  return res.json(price);
});
commercialAdminRouter.delete("/prices/:model", (req, res) => {
  const model = decodeURIComponent(req.params.model);
  const ok = deleteModelPrice(model);
  writeAudit({ action: "price.delete", target_type: "model", target_id: model });
  return res.json({ ok });
});

// Prompt preset library: admin-uploaded system prompts bindable to models.
// Injected by the relay and excluded from user billing (see services/proxy.ts).
commercialAdminRouter.get("/prompt-presets", (_req, res) => res.json({ items: listPromptPresets() }));
commercialAdminRouter.get("/prompt-presets/:id", (req, res) => {
  const preset = getPromptPreset(req.params.id);
  if (!preset) return res.status(404).json({ error: "Preset not found" });
  return res.json(preset);
});
commercialAdminRouter.post("/prompt-presets", (req, res) => {
  const body = parseBody(promptPresetSchema, req.body, res);
  if (!body) return;
  const preset = createPromptPreset(body);
  writeAudit({
    action: "prompt_preset.create",
    target_type: "prompt_preset",
    target_id: preset.id,
    detail: { name: preset.name, filename: preset.filename, size: preset.content.length },
  });
  return res.status(201).json(preset);
});
commercialAdminRouter.delete("/prompt-presets/:id", (req, res) => {
  const ok = deletePromptPreset(req.params.id);
  writeAudit({ action: "prompt_preset.delete", target_type: "prompt_preset", target_id: req.params.id });
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
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const userId = typeof req.query.user_id === "string" ? req.query.user_id : undefined;
  return res.json(listUsageRecordsPage({ userId, limit, offset }));
});
commercialAdminRouter.get("/audit", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  return res.json({ items: listAuditLogs(limit) });
});

function defaultPaymentChannelId() {
  const channels = getPaymentChannelsAdmin() as Array<{ id?: string } | null>;
  return channels.find((item) => item?.id === "linuxdo-credit")?.id
    || channels[0]?.id
    || "linuxdo-credit";
}

commercialAdminRouter.get("/payments/channel", (_req, res) => {
  return res.json(getPaymentChannelAdmin(defaultPaymentChannelId()));
});
commercialAdminRouter.put("/payments/channel", (req, res) => {
  const body = parseBody(paymentChannelSchema, req.body, res);
  if (!body) return;
  try {
    const channelId = defaultPaymentChannelId();
    const channel = updatePaymentChannel(body, channelId);
    writeAudit({
      action: "payment.channel.update",
      target_type: "payment_channel",
      target_id: channelId,
      detail: {
        ...body,
        client_secret: body.client_secret === undefined ? undefined : "[updated]",
        alipay_public_key: body.alipay_public_key === undefined ? undefined : "[updated]",
        wechat_private_key: body.wechat_private_key === undefined ? undefined : "[updated]",
        wechat_platform_certificate: body.wechat_platform_certificate === undefined ? undefined : "[updated]",
      },
    });
    return res.json(channel);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.get("/payments/channels", (_req, res) => {
  return res.json({ items: getPaymentChannelsAdmin() });
});
commercialAdminRouter.put("/payments/channels/:id", (req, res) => {
  const body = parseBody(paymentChannelSchema, req.body, res);
  if (!body) return;
  try {
    const channel = updatePaymentChannel(body, req.params.id);
    writeAudit({
      action: "payment.channel.update",
      target_type: "payment_channel",
      target_id: req.params.id,
      detail: {
        ...body,
        client_secret: body.client_secret === undefined ? undefined : "[updated]",
        alipay_public_key: body.alipay_public_key === undefined ? undefined : "[updated]",
        wechat_private_key: body.wechat_private_key === undefined ? undefined : "[updated]",
        wechat_platform_certificate: body.wechat_platform_certificate === undefined ? undefined : "[updated]",
      },
    });
    return res.json(channel);
  } catch (error) {
    return paymentFailure(res, error);
  }
});
commercialAdminRouter.get("/payments/orders", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
  return res.json(listPaymentOrdersPage({ status, limit, offset }));
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
