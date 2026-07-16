import { Router, Response } from "express";
import { z } from "zod";
import {
  clearCache,
  deleteCacheEntry,
  getCacheStats,
  listCache,
  updateCacheConfig,
} from "../services/cache";
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  updateApiKey,
} from "../services/keys";
import { clearLogs, getDashboardStats, getLog, listLogs } from "../services/logs";
import {
  createProvider,
  deleteProvider,
  listProviders,
  sanitizeProvider,
  updateProvider,
} from "../services/providers";
import { getAllSettings, getSetting, setSetting } from "../db";
import { requireAdmin, verifyAdminToken } from "../middleware/auth";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";

export const adminRouter = Router();

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "base_url must use http or https",
  });
const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  base_url: httpUrl,
  api_key: z.string().max(16_384).optional(),
  api_keys: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
  enabled: z.boolean().optional(),
  timeout_ms: z.coerce.number().int().min(100).max(600_000).optional(),
});
const providerPatchSchema = providerSchema.partial();
const keySchema = z.object({
  name: z.string().trim().min(1).max(120),
  rate_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});
const keyPatchSchema = keySchema.partial();
const cacheConfigSchema = z.object({
  enabled: z.boolean().optional(),
  ttl_seconds: z.coerce.number().int().min(1).max(604_800).optional(),
  ttlSeconds: z.coerce.number().int().min(1).max(604_800).optional(),
  max_entries: z.coerce.number().int().min(10).max(100_000).optional(),
  maxEntries: z.coerce.number().int().min(10).max(100_000).optional(),
  methods: z.array(z.enum(["GET", "POST"])).max(2).optional(),
  paths: z.array(z.string().startsWith("/").max(300)).max(100).optional(),
});
const settingsSchema = z.object({
  admin_password: z.string().trim().min(8).max(256).optional(),
  current_admin_password: z.string().max(256).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  max_retries: z.coerce.number().int().min(0).optional(),
  retry_delay_ms: z.coerce.number().int().min(0).max(10_000).optional(),
  cache_enabled: z.boolean().optional(),
  cache_ttl_seconds: z.coerce.number().int().min(1).max(604_800).optional(),
  cache_max_entries: z.coerce.number().int().min(10).max(100_000).optional(),
  cache_methods: z.array(z.enum(["GET", "POST"])).max(2).optional(),
  cache_paths: z.array(z.string().startsWith("/").max(300)).max(100).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  res.status(400).json({
    error: "Invalid request body",
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
  return null;
}

// Public login (must be before requireAdmin)
adminRouter.post("/login", (req, res) => {
  const password =
    (typeof req.body?.password === "string" && req.body.password) ||
    (typeof req.body?.admin_password === "string" && req.body.admin_password) ||
    "";
  const limiterKey = `admin-login:${req.ip || req.socket.remoteAddress || "unknown"}`;
  const rate = consumeRateLimit(limiterKey, 5, 5 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many login attempts", ok: false });
  }
  if (!password || !verifyAdminToken(password)) {
    return res.status(401).json({ error: "Invalid admin password", ok: false });
  }
  resetRateLimit(limiterKey);
  return res.json({ ok: true });
});

adminRouter.use(requireAdmin);

adminRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "localapi", time: new Date().toISOString() });
});

adminRouter.get("/dashboard", (_req, res) => {
  res.json(getDashboardStats());
});

// Providers
adminRouter.get("/providers", (_req, res) => {
  res.json({ items: listProviders().map(sanitizeProvider) });
});

adminRouter.post("/providers", (req, res) => {
  const body = parseBody(providerSchema, req.body, res);
  if (!body) return;
  const provider = createProvider(body);
  clearCache();
  return res.status(201).json(sanitizeProvider(provider));
});

adminRouter.patch("/providers/:id", (req, res) => {
  const body = parseBody(providerPatchSchema, req.body, res);
  if (!body) return;
  const updated = updateProvider(req.params.id, body);
  if (!updated) return res.status(404).json({ error: "Provider not found" });
  clearCache();
  return res.json(sanitizeProvider(updated));
});

adminRouter.delete("/providers/:id", (req, res) => {
  const ok = deleteProvider(req.params.id);
  if (!ok) return res.status(404).json({ error: "Provider not found" });
  clearCache();
  return res.json({ ok: true });
});

// API Keys
adminRouter.get("/keys", (_req, res) => {
  res.json({ items: listApiKeys() });
});

adminRouter.post("/keys", (req, res) => {
  const body = parseBody(keySchema, req.body, res);
  if (!body) return;
  const key = createApiKey(body);
  return res.status(201).json(key);
});

adminRouter.patch("/keys/:id", (req, res) => {
  const body = parseBody(keyPatchSchema, req.body, res);
  if (!body) return;
  const updated = updateApiKey(req.params.id, body);
  if (!updated) return res.status(404).json({ error: "Key not found" });
  return res.json(updated);
});

adminRouter.delete("/keys/:id", (req, res) => {
  const ok = deleteApiKey(req.params.id);
  if (!ok) return res.status(404).json({ error: "Key not found" });
  return res.json({ ok: true });
});

// Cache
adminRouter.get("/cache", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  res.json({ ...listCache(limit, offset), stats: getCacheStats() });
});

adminRouter.get("/cache/stats", (_req, res) => {
  res.json(getCacheStats());
});

adminRouter.patch("/cache/config", (req, res) => {
  const body = parseBody(cacheConfigSchema, req.body, res);
  if (!body) return;
  const config = updateCacheConfig({
    enabled: body.enabled,
    ttlSeconds: body.ttl_seconds ?? body.ttlSeconds,
    maxEntries: body.max_entries ?? body.maxEntries,
    methods: body.methods,
    paths: body.paths,
  });
  res.json(config);
});

adminRouter.delete("/cache/:id", (req, res) => {
  const ok = deleteCacheEntry(req.params.id);
  if (!ok) return res.status(404).json({ error: "Cache entry not found" });
  return res.json({ ok: true });
});

adminRouter.delete("/cache", (_req, res) => {
  const removed = clearCache();
  res.json({ ok: true, removed });
});

// Logs
adminRouter.get("/logs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  res.json(listLogs(limit, offset));
});

adminRouter.get("/logs/:id", (req, res) => {
  const log = getLog(req.params.id);
  if (!log) return res.status(404).json({ error: "Log not found" });
  return res.json(log);
});

adminRouter.delete("/logs", (_req, res) => {
  res.json({ ok: true, removed: clearLogs() });
});

// Settings
adminRouter.get("/settings", (_req, res) => {
  const all = getAllSettings();
  res.json({
    // Never return the full password to the browser — only a mask + length hint
    admin_password_set: Boolean(all.admin_token),
    admin_password_hint: maskSecret(all.admin_token || ""),
    port: all.port,
    max_retries: Number(all.max_retries ?? 2),
    retry_delay_ms: Number(all.retry_delay_ms ?? 400),
    cache_enabled: all.cache_enabled === "true",
    cache_ttl_seconds: Number(all.cache_ttl_seconds || 3600),
    cache_max_entries: Number(all.cache_max_entries || 1000),
    cache_methods: JSON.parse(all.cache_methods || "[]"),
    cache_paths: JSON.parse(all.cache_paths || "[]"),
  });
});

adminRouter.patch("/settings", (req, res) => {
  const body = parseBody(settingsSchema, req.body, res);
  if (!body) return;

  if (body.admin_password) {
    if (!body.current_admin_password || !verifyAdminToken(body.current_admin_password)) {
      return res.status(403).json({ error: "Current admin password is incorrect" });
    }
    setSetting("admin_token", body.admin_password);
  }

  if (body.port !== undefined) setSetting("port", String(body.port));
  if (body.max_retries !== undefined) {
    setSetting("max_retries", String(body.max_retries));
  }
  if (body.retry_delay_ms !== undefined) {
    setSetting("retry_delay_ms", String(body.retry_delay_ms));
  }
  if (body.cache_enabled !== undefined) {
    setSetting("cache_enabled", body.cache_enabled ? "true" : "false");
  }
  if (body.cache_ttl_seconds !== undefined) {
    setSetting("cache_ttl_seconds", String(body.cache_ttl_seconds));
  }
  if (body.cache_max_entries !== undefined) {
    setSetting("cache_max_entries", String(body.cache_max_entries));
  }
  if (Array.isArray(body.cache_methods)) {
    setSetting("cache_methods", JSON.stringify(body.cache_methods));
  }
  if (Array.isArray(body.cache_paths)) {
    setSetting("cache_paths", JSON.stringify(body.cache_paths));
  }

  const all = getAllSettings();
  res.json({
    admin_password_set: Boolean(all.admin_token),
    admin_password_hint: maskSecret(all.admin_token || ""),
    port: all.port,
    max_retries: Number(all.max_retries ?? 2),
    retry_delay_ms: Number(all.retry_delay_ms ?? 400),
    cache_enabled: all.cache_enabled === "true",
    cache_ttl_seconds: Number(all.cache_ttl_seconds || 3600),
    cache_max_entries: Number(all.cache_max_entries || 1000),
    cache_methods: JSON.parse(all.cache_methods || "[]"),
    cache_paths: JSON.parse(all.cache_paths || "[]"),
  });
});

adminRouter.get("/meta", (_req, res) => {
  res.json({
    admin_token_configured: Boolean(getSetting("admin_token")),
    version: "1.0.0",
  });
});

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`;
}
