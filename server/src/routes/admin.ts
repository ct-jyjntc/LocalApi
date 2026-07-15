import { Router } from "express";
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
import { clearLogs, getDashboardStats, listLogs } from "../services/logs";
import {
  createProvider,
  deleteProvider,
  listProviders,
  sanitizeProvider,
  updateProvider,
} from "../services/providers";
import { getAllSettings, getSetting, setSetting } from "../db";
import { requireAdmin } from "../middleware/auth";

export const adminRouter = Router();

// Public login (must be before requireAdmin)
adminRouter.post("/login", (req, res) => {
  const password =
    (typeof req.body?.password === "string" && req.body.password) ||
    (typeof req.body?.admin_password === "string" && req.body.admin_password) ||
    "";
  const admin = getSetting("admin_token") || "a2366021253";
  if (!password || password !== admin) {
    return res.status(401).json({ error: "Invalid admin password", ok: false });
  }
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
  const { name, base_url, api_key, api_keys, models, enabled, timeout_ms } =
    req.body ?? {};
  if (!name || !base_url) {
    return res.status(400).json({ error: "name and base_url are required" });
  }
  const provider = createProvider({
    name,
    base_url,
    api_key,
    api_keys: Array.isArray(api_keys) ? api_keys : undefined,
    models,
    enabled,
    timeout_ms,
  });
  return res.status(201).json(sanitizeProvider(provider));
});

adminRouter.patch("/providers/:id", (req, res) => {
  const body = req.body ?? {};
  const updated = updateProvider(req.params.id, {
    ...body,
    api_keys: Array.isArray(body.api_keys) ? body.api_keys : undefined,
  });
  if (!updated) return res.status(404).json({ error: "Provider not found" });
  return res.json(sanitizeProvider(updated));
});

adminRouter.delete("/providers/:id", (req, res) => {
  const ok = deleteProvider(req.params.id);
  if (!ok) return res.status(404).json({ error: "Provider not found" });
  return res.json({ ok: true });
});

// API Keys
adminRouter.get("/keys", (_req, res) => {
  res.json({ items: listApiKeys() });
});

adminRouter.post("/keys", (req, res) => {
  const { name, rate_limit, enabled } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const key = createApiKey({ name, rate_limit, enabled });
  return res.status(201).json(key);
});

adminRouter.patch("/keys/:id", (req, res) => {
  const updated = updateApiKey(req.params.id, req.body ?? {});
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
  const body = req.body ?? {};
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
  const body = req.body ?? {};

  // Change admin password (optional confirmation with current)
  if (typeof body.admin_password === "string" && body.admin_password.trim()) {
    const next = body.admin_password.trim();
    if (next.length < 4) {
      return res.status(400).json({ error: "Admin password must be at least 4 characters" });
    }
    if (typeof body.current_admin_password === "string") {
      const current = getSetting("admin_token") || "";
      if (body.current_admin_password !== current) {
        return res.status(403).json({ error: "Current admin password is incorrect" });
      }
    }
    setSetting("admin_token", next);
  }

  // Legacy field name still accepted
  if (typeof body.admin_token === "string" && body.admin_token.trim()) {
    setSetting("admin_token", body.admin_token.trim());
  }

  if (body.port !== undefined) setSetting("port", String(body.port));
  if (body.max_retries !== undefined) {
    const n = Math.max(0, Math.min(10, Number(body.max_retries) || 0));
    setSetting("max_retries", String(n));
  }
  if (body.retry_delay_ms !== undefined) {
    const n = Math.max(0, Math.min(10_000, Number(body.retry_delay_ms) || 0));
    setSetting("retry_delay_ms", String(n));
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
