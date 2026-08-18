import { Router, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { getAllSettings, getSetting, setSetting } from "../db";
import {
  BrandIconError,
  BRAND_ICON_MAX_BYTES,
  clearBrandIcon,
  getBrandIconUrl,
  getBrandName,
  getBrandTagline,
  saveBrandIcon,
} from "../services/branding";
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
  listApiKeysPage,
  updateApiKey,
} from "../services/keys";
import { clearLogs, getDashboardStats, getLog, listLogsFiltered } from "../services/logs";
import {
  createProvider,
  deleteProvider,
  listProviders,
  reorderProviders,
  sanitizeProvider,
  updateProvider,
} from "../services/providers";
import {
  createProxyLibrary,
  createProxyNode,
  DEFAULT_PROXY_TEST_URL,
  deleteProxyLibrary,
  deleteProxyNode,
  getProxyLibrary,
  listProxyLibraries,
  listProxyNodes,
  listProxyNodesByLibrary,
  refreshProxyLibrary,
  sanitizeProxyLibrary,
  sanitizeProxyNode,
  updateProxyLibrary,
  updateProxyNode,
} from "../services/proxies";
import { consumeAdminAuthFailure, requireAdmin, verifyAdminToken } from "../middleware/auth";
import { consumeRateLimit, resetRateLimit } from "../services/rate-limit";
import { getClientIp } from "../utils/client-ip";
import { hashAdminSecret } from "../utils/admin-secret";
import { DEFAULT_ADMIN_ENTRY_PATH, isValidAdminEntryPath, normalizeAdminEntryPath } from "../utils/admin-entry";
import { commercialAdminRouter } from "./commercial-admin";
import { testProviderConnection } from "../services/proxy";
import { getCheckinSettings, updateCheckinSettings } from "../services/checkin";
import { moduleRegistry } from "../modules/registry";
import { modulesAdminRouter } from "./modules-admin";

export const adminRouter = Router();

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "base_url must use http or https",
  });
const modelMappingsSchema = z
  .record(z.string().trim().min(1).max(200), z.string().trim().min(1).max(200))
  .optional();
const proxyUrl = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => /^(https?|socks4a?|socks5h?|socks):\/\//i.test(value), {
    message: "proxy url must use http/https/socks4/socks5 scheme",
  });
const proxyNodeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: proxyUrl,
  enabled: z.boolean().optional(),
});
const proxyNodePatchSchema = proxyNodeSchema.partial();
const proxyLibrarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "library url must use http or https",
    }),
  default_protocol: z.enum(["http", "https", "socks4", "socks5"]).optional(),
  enabled: z.boolean().optional(),
  auto_update: z.boolean().optional(),
  update_interval_ms: z.coerce.number().int().min(60_000).max(31_536_000_000).optional(),
});
const proxyLibraryPatchSchema = proxyLibrarySchema.partial();
const proxyIdsSchema = z.array(z.string().trim().min(1).max(100)).max(32).optional();
const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  base_url: httpUrl,
  api_key: z.string().max(16_384).optional(),
  api_keys: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
  model_mappings: modelMappingsSchema,
  proxy_ids: proxyIdsSchema,
  enabled: z.boolean().optional(),
  timeout_ms: z.coerce.number().int().min(100).max(600_000).optional(),
});
const providerPatchSchema = providerSchema.partial();
const providerTestSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
});
const keySchema = z.object({
  name: z.string().trim().min(1).max(120),
  rate_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  tpm_limit: z.coerce.number().int().min(0).max(100_000_000).optional(),
  concurrency_limit: z.coerce.number().int().min(0).max(10_000).optional(),
  allowed_models: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
  expires_at: z.string().datetime().nullable().optional(),
  user_id: z.string().uuid().nullable().optional(),
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
  max_retries: z.coerce.number().int().min(0).max(100).optional(),
  other_max_retries: z.coerce.number().int().min(0).max(100).optional(),
  retry_delay_ms: z.coerce.number().int().min(0).max(10_000).optional(),
  cache_enabled: z.boolean().optional(),
  cache_ttl_seconds: z.coerce.number().int().min(1).max(604_800).optional(),
  cache_max_entries: z.coerce.number().int().min(10).max(100_000).optional(),
  cache_methods: z.array(z.enum(["GET", "POST"])).max(2).optional(),
  cache_paths: z.array(z.string().startsWith("/").max(300)).max(100).optional(),
  brand_name: z.string().trim().min(1).max(80).optional(),
  brand_tagline: z.string().trim().max(20).optional(),
  company_name: z.string().trim().max(160).optional(),
  announcement_enabled: z.boolean().optional(),
  announcement_title: z.string().trim().max(120).optional(),
  announcement_content: z.string().trim().max(4000).optional(),
  announcement_banner: z.boolean().optional(),
  announcement_popup: z.boolean().optional(),
  public_base_url: z.string().trim().max(255).refine(isValidPublicBaseUrl, {
    message: "public_base_url must be an http(s) URL or domain without a path",
  }).optional(),
  admin_entry_path: z.string().trim().max(65).refine(isValidAdminEntryPath, {
    message: "admin_entry_path must be a single safe path segment",
  }).optional(),
  proxy_test_url: z.string().trim().max(255).optional(),
  registration_enabled: z.boolean().optional(),
  password_login_enabled: z.boolean().optional(),
  wallet_free_model_topup_required: z.boolean().optional(),
  wallet_free_model_min_topup_micros: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
  wallet_free_prompt_claim_required: z.boolean().optional(),
  linuxdo_registration_enabled: z.boolean().optional(),
  linuxdo_login_enabled: z.boolean().optional(),
  linuxdo_client_id: z.string().trim().max(256).optional(),
  linuxdo_client_secret: z.string().max(4096).optional(),
  linuxdo_relay_url: z
    .string()
    .trim()
    .max(512)
    .refine(
      (value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "linuxdo_relay_url must be an http(s) URL" },
    )
    .optional(),
  linuxdo_relay_secret: z.string().max(4096).optional(),
  checkin_enabled: z.boolean().optional(),
  checkin_points_min: z.coerce.number().min(0).max(1_000_000).optional(),
  checkin_points_max: z.coerce.number().min(0).max(1_000_000).optional(),
  points_balance_cap: z.coerce.number().min(0).max(1_000_000_000).optional(),
  points_exchange_rate: z.coerce.number().min(0).max(1_000_000).optional(),
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

// Public entry check and login (must be before requireAdmin)
adminRouter.post("/entry", (req, res) => {
  const path = typeof req.body?.path === "string" ? req.body.path : "";
  const limiterKey = `admin-entry:${getClientIp(req)}`;
  const rate = consumeRateLimit(limiterKey, 30, 5 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many entry attempts", ok: false });
  }
  if (!matchesAdminEntryPath(path)) {
    return res.status(404).json({ error: "Not found", ok: false });
  }
  return res.json({ ok: true });
});

adminRouter.post("/login", (req, res) => {
  const password =
    (typeof req.body?.password === "string" && req.body.password) ||
    (typeof req.body?.admin_password === "string" && req.body.admin_password) ||
    "";
  const entryPath = typeof req.body?.entry_path === "string" ? req.body.entry_path : "";
  const limiterKey = `admin-login:${getClientIp(req)}`;
  const rate = consumeRateLimit(limiterKey, 5, 5 * 60_000);
  if (!rate.allowed) {
    res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ error: "Too many login attempts", ok: false });
  }
  if (!matchesAdminEntryPath(entryPath)) {
    return res.status(404).json({ error: "Not found", ok: false });
  }
  if (!password || !verifyAdminToken(password)) {
    // Also counts against the shared per-IP budget so /login and protected
    // endpoints cannot be used as two independent brute-force pipelines.
    const shared = consumeAdminAuthFailure(req);
    if (!shared.allowed) {
      res.setHeader("retry-after", String(Math.ceil(shared.retryAfterMs / 1000)));
      return res.status(429).json({ error: "Too many login attempts", ok: false });
    }
    return res.status(401).json({ error: "Invalid admin password", ok: false });
  }
  resetRateLimit(limiterKey);
  return res.json({ ok: true });
});

adminRouter.use(requireAdmin);
adminRouter.use("/commercial", commercialAdminRouter);

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

adminRouter.post("/providers/reorder", (req, res) => {
  const body = parseBody(z.object({ ids: z.array(z.string()).min(1) }), req.body, res);
  if (!body) return;
  reorderProviders(body.ids);
  return res.json({ ok: true });
});

adminRouter.post("/providers/:id/test", async (req, res) => {
  const body = parseBody(providerTestSchema, req.body ?? {}, res);
  if (!body) return;
  const result = await testProviderConnection(req.params.id, body.model);
  if (!result) return res.status(404).json({ error: "Provider not found" });
  return res.json(result);
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

// Proxy nodes + libraries
adminRouter.get("/proxies", (_req, res) => {
  res.json({
    items: listProxyNodes().map(sanitizeProxyNode),
    libraries: listProxyLibraries().map(sanitizeProxyLibrary),
  });
});

adminRouter.post("/proxies", (req, res) => {
  const body = parseBody(proxyNodeSchema, req.body, res);
  if (!body) return;
  const node = createProxyNode(body);
  if (!node) return res.status(400).json({ error: "Invalid proxy url" });
  return res.status(201).json(sanitizeProxyNode(node));
});

// Libraries (must be registered before /proxies/:id routes)
adminRouter.post("/proxies/libraries", async (req, res) => {
  const body = parseBody(proxyLibrarySchema, req.body, res);
  if (!body) return;
  const library = createProxyLibrary(body);
  if (!library) return res.status(400).json({ error: "Invalid library url" });
  let importResult: { added: number; removed: number; total: number } | null = null;
  let importError: string | null = null;
  try {
    importResult = await refreshProxyLibrary(library.id);
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  return res.status(201).json({ ...sanitizeProxyLibrary(library), import: importResult, import_error: importError });
});

adminRouter.patch("/proxies/libraries/:id", (req, res) => {
  const body = parseBody(proxyLibraryPatchSchema, req.body, res);
  if (!body) return;
  const updated = updateProxyLibrary(req.params.id, body);
  if (!updated) return res.status(404).json({ error: "Proxy library not found" });
  return res.json(sanitizeProxyLibrary(updated));
});

adminRouter.delete("/proxies/libraries/:id", (req, res) => {
  const ok = deleteProxyLibrary(req.params.id);
  if (!ok) return res.status(404).json({ error: "Proxy library not found" });
  return res.json({ ok: true });
});

adminRouter.post("/proxies/libraries/:id/refresh", async (req, res) => {
  const library = getProxyLibrary(req.params.id);
  if (!library) return res.status(404).json({ error: "Proxy library not found" });
  try {
    const result = await refreshProxyLibrary(library.id);
    return res.json(result ?? { added: 0, removed: 0, total: 0 });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Refresh failed" });
  }
});

adminRouter.patch("/proxies/:id", (req, res) => {
  const body = parseBody(proxyNodePatchSchema, req.body, res);
  if (!body) return;
  const updated = updateProxyNode(req.params.id, body);
  if (!updated) return res.status(404).json({ error: "Proxy node not found" });
  return res.json(sanitizeProxyNode(updated));
});

adminRouter.delete("/proxies/:id", (req, res) => {
  const ok = deleteProxyNode(req.params.id);
  if (!ok) return res.status(404).json({ error: "Proxy node not found" });
  return res.json({ ok: true });
});

// API Keys
adminRouter.get("/keys", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json(
    listApiKeysPage({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      q,
    }),
  );
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
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const str = (key: string) => (typeof req.query[key] === "string" ? String(req.query[key]) : "");
  res.json(
    listLogsFiltered({
      limit,
      offset,
      q: str("q"),
      status: str("status") || "all",
      method: str("method"),
      stream: str("stream") || "all",
      provider: str("provider"),
      model: str("model"),
      userId: str("user_id") || undefined,
    }),
  );
});

adminRouter.get("/logs/:id", (req, res) => {
  const log = getLog(req.params.id);
  if (!log) return res.status(404).json({ error: "Log not found" });
  return res.json(log);
});

adminRouter.delete("/logs", (_req, res) => {
  res.json({ ok: true, removed: clearLogs() });
});

function serializeSettings() {
  const all = getAllSettings();
  const checkin = getCheckinSettings();
  const moduleSettings = moduleRegistry.collectAdminSettings();
  return {
    admin_password_set: Boolean(all.admin_token),
    admin_password_hint: all.admin_token ? "••••••••" : "",
    port: all.port,
    max_retries: Number(all.max_retries ?? 2),
    other_max_retries: Number(all.other_max_retries ?? 0),
    retry_delay_ms: Number(all.retry_delay_ms ?? 400),
    cache_enabled: all.cache_enabled === "true",
    cache_ttl_seconds: Number(all.cache_ttl_seconds || 3600),
    cache_max_entries: Number(all.cache_max_entries || 1000),
    cache_methods: JSON.parse(all.cache_methods || "[]"),
    cache_paths: JSON.parse(all.cache_paths || "[]"),
    brand_name: getBrandName(),
    brand_tagline: getBrandTagline(),
    brand_icon_url: getBrandIconUrl(),
    company_name: all.company_name || "",
    announcement_enabled: (all.announcement_enabled ?? "false") === "true",
    announcement_title: all.announcement_title || "",
    announcement_content: all.announcement_content || "",
    announcement_banner: (all.announcement_banner ?? "true") === "true",
    announcement_popup: (all.announcement_popup ?? "true") === "true",
    announcement_updated_at: all.announcement_updated_at || "",
    public_base_url: all.public_base_url || "",
    admin_entry_path: all.admin_entry_path || DEFAULT_ADMIN_ENTRY_PATH,
    proxy_test_url: all.proxy_test_url || DEFAULT_PROXY_TEST_URL,
    registration_enabled: all.registration_enabled === "true",
    password_login_enabled: (all.password_login_enabled ?? "true") === "true",
    wallet_free_model_topup_required: (all.wallet_free_model_topup_required ?? "true") === "true",
    wallet_free_model_min_topup_micros: Number(all.wallet_free_model_min_topup_micros ?? 1_000_000) || 1_000_000,
    wallet_free_prompt_claim_required: (all.wallet_free_prompt_claim_required ?? "true") === "true",
    checkin_points_min: checkin.points_min,
    checkin_points_max: checkin.points_max,
    points_balance_cap: checkin.balance_cap,
    points_exchange_rate: checkin.exchange_rate,
    // Defaults when LinuxDo module is not active; module serialize overwrites these.
    linuxdo_login_enabled: false,
    linuxdo_client_id: "",
    linuxdo_client_secret_set: false,
    linuxdo_relay_url: "",
    linuxdo_relay_secret_set: false,
    linuxdo_configured: false,
    linuxdo_callback_url: "",
    linuxdo_authorize_ready: false,
    ...moduleSettings,
  };
}

// Settings
adminRouter.get("/settings", (_req, res) => {
  res.json(serializeSettings());
});

adminRouter.patch("/settings", (req, res) => {
  const body = parseBody(settingsSchema, req.body, res);
  if (!body) return;

  if (body.admin_password) {
    if (!body.current_admin_password || !verifyAdminToken(body.current_admin_password)) {
      return res.status(403).json({ error: "Current admin password is incorrect" });
    }
    setSetting("admin_token", hashAdminSecret(body.admin_password));
  }

  if (body.port !== undefined) setSetting("port", String(body.port));
  if (body.max_retries !== undefined) {
    setSetting("max_retries", String(body.max_retries));
  }
  if (body.other_max_retries !== undefined) {
    setSetting("other_max_retries", String(body.other_max_retries));
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
  if (body.brand_name !== undefined) setSetting("brand_name", body.brand_name);
  if (body.brand_tagline !== undefined) setSetting("brand_tagline", body.brand_tagline);
  if (body.proxy_test_url !== undefined) setSetting("proxy_test_url", body.proxy_test_url);
  if (body.company_name !== undefined) setSetting("company_name", body.company_name);
  if (
    body.announcement_enabled !== undefined ||
    body.announcement_title !== undefined ||
    body.announcement_content !== undefined ||
    body.announcement_banner !== undefined ||
    body.announcement_popup !== undefined
  ) {
    if (body.announcement_enabled !== undefined) {
      setSetting("announcement_enabled", body.announcement_enabled ? "true" : "false");
    }
    if (body.announcement_title !== undefined) {
      setSetting("announcement_title", body.announcement_title);
    }
    if (body.announcement_content !== undefined) {
      setSetting("announcement_content", body.announcement_content);
    }
    if (body.announcement_banner !== undefined) {
      setSetting("announcement_banner", body.announcement_banner ? "true" : "false");
    }
    if (body.announcement_popup !== undefined) {
      setSetting("announcement_popup", body.announcement_popup ? "true" : "false");
    }
    // Bump version so clients re-show popup after content/mode changes.
    setSetting("announcement_updated_at", new Date().toISOString());
  }
  if (body.public_base_url !== undefined) {
    setSetting("public_base_url", normalizePublicBaseUrl(body.public_base_url));
  }
  if (body.admin_entry_path !== undefined) {
    setSetting("admin_entry_path", normalizeAdminEntryPath(body.admin_entry_path));
  }
  if (body.registration_enabled !== undefined) {
    setSetting("registration_enabled", body.registration_enabled ? "true" : "false");
  }
  if (body.password_login_enabled !== undefined) {
    setSetting("password_login_enabled", body.password_login_enabled ? "true" : "false");
  }
  if (body.wallet_free_model_topup_required !== undefined) {
    setSetting("wallet_free_model_topup_required", body.wallet_free_model_topup_required ? "true" : "false");
  }
  if (body.wallet_free_model_min_topup_micros !== undefined) {
    setSetting("wallet_free_model_min_topup_micros", String(Math.max(0, Math.floor(body.wallet_free_model_min_topup_micros))));
  }
  if (body.wallet_free_prompt_claim_required !== undefined) {
    setSetting("wallet_free_prompt_claim_required", body.wallet_free_prompt_claim_required ? "true" : "false");
  }
  if (body.linuxdo_registration_enabled !== undefined) {
    setSetting(
      "linuxdo_registration_enabled",
      body.linuxdo_registration_enabled ? "true" : "false",
    );
  }

  if (
    body.checkin_enabled !== undefined
    || body.checkin_points_min !== undefined
    || body.checkin_points_max !== undefined
    || body.points_balance_cap !== undefined
    || body.points_exchange_rate !== undefined
  ) {
    try {
      updateCheckinSettings({
        enabled: body.checkin_enabled,
        points_min: body.checkin_points_min,
        points_max: body.checkin_points_max,
        balance_cap: body.points_balance_cap,
        exchange_rate: body.points_exchange_rate,
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid check-in settings",
      });
    }
  }

  try {
    // Module settings (e.g. LinuxDo OAuth) apply against the raw body so optional secrets pass through.
    moduleRegistry.applyAdminSettings(
      req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {},
    );
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid module settings",
    });
  }

  res.json(serializeSettings());
});

const brandIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRAND_ICON_MAX_BYTES },
});

adminRouter.post("/settings/brand-icon", brandIconUpload.single("file"), (req, res) => {
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ error: "Image file is required" });
  }
  try {
    saveBrandIcon(req.file.buffer);
    return res.json(serializeSettings());
  } catch (error) {
    if (error instanceof BrandIconError) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: "Unable to save brand icon" });
  }
});

adminRouter.delete("/settings/brand-icon", (_req, res) => {
  clearBrandIcon();
  return res.json(serializeSettings());
});

adminRouter.use(modulesAdminRouter);
adminRouter.use(moduleRegistry.adminHost.router);

adminRouter.get("/meta", (_req, res) => {
  res.json({
    admin_token_configured: Boolean(getSetting("admin_token")),
    version: "1.0.0",
  });
});

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return `${url.protocol}//${url.host}`;
}

function isValidPublicBaseUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const normalized = normalizePublicBaseUrl(value);
    const url = new URL(normalized);
    const original = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    return Boolean(url.hostname) && (original.pathname === "/" || original.pathname === "") && !original.search && !original.hash;
  } catch {
    return false;
  }
}

function matchesAdminEntryPath(value: string): boolean {
  const configured = getSetting("admin_entry_path") || DEFAULT_ADMIN_ENTRY_PATH;
  return isValidAdminEntryPath(value) && normalizeAdminEntryPath(value) === configured;
}
