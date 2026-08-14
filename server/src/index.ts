import "dotenv/config";
// M11: with NODE_ENV unset, Express runs in "development" mode and emits
// verbose HTML error pages (stack traces, filesystem paths) on every 500.
// Default to production; development servers set NODE_ENV=development
// explicitly.
process.env.NODE_ENV ??= "production";
import cors from "cors";
import express from "express";
import path from "path";
import fs from "fs";
import { initDb, getSetting, setSetting } from "./db";
import { adminRouter } from "./routes/admin";
import { proxyRouter } from "./routes/proxy";
import { userRouter } from "./routes/user";
import { oauthRouter } from "./routes/oauth";
import { paymentsRouter } from "./routes/payments";
import { createProvider, listProviders } from "./services/providers";
import { createApiKey, listApiKeys } from "./services/keys";
import { cleanupStaleReservations } from "./services/billing";
import { maintainDueSubscriptions } from "./services/plans";
import { migratePointsScaleIfNeeded } from "./services/checkin";
import { startProxyScheduler } from "./services/proxy-scheduler";
import { moduleRegistry } from "./modules/registry";
import { checkSecretsHealth } from "./utils/secrets-health";
import { applyBrandingToHtml, getPublicBrandingPayload } from "./services/branding";
import { errorHandler, notFoundJson } from "./middleware/errors";

initDb();
migratePointsScaleIfNeeded();
moduleRegistry.migrateLegacyAndBoot();

// Fail loudly at startup when stored credentials cannot be decrypted with the
// current SECRETS_KEY. Without this, a wrong/missing key turns every request
// that touches a credential into a 500 while the server looks healthy.
const secretsHealth = checkSecretsHealth();
for (const issue of secretsHealth.issues) {
  console.error(`[secrets] ${issue}`);
}
if (secretsHealth.issues.length > 0) {
  console.error(
    "[secrets] Refusing to start: stored credentials cannot be decrypted. " +
      "Restore the original SECRETS_KEY, or delete and re-enter the affected credentials.",
  );
  process.exit(1);
}
if (secretsHealth.plaintextCount > 0) {
  console.warn(
    `[secrets] ${secretsHealth.plaintextCount} credential field(s) are stored in plaintext. ` +
      "Set SECRETS_KEY before saving new credentials to enable encryption at rest.",
  );
}

// Single-port app
const SINGLE_PORT = Number(process.env.PORT || 5555);
const LISTEN_HOST = process.env.HOST?.trim() || "127.0.0.1";
if (getSetting("port") !== String(SINGLE_PORT)) {
  setSetting("port", String(SINGLE_PORT));
}

function seedIfEmpty() {
  if (listProviders().length === 0) {
    createProvider({
      name: "Mock Echo",
      base_url: "http://127.0.0.1:8790",
      api_key: "mock-key",
      models: ["mock-echo", "gpt-4o-mini"],
      enabled: true,
      timeout_ms: 15000,
    });
  }
  if (listApiKeys().length === 0) {
    const key = createApiKey({ name: "default" });
    console.log(`[seed] Default API key created: ${key.key}`);
  }
}

seedIfEmpty();
cleanupStaleReservations();
maintainDueSubscriptions();

// Recover stuck pending holds quickly (client disconnect / hung stream).
const reservationCleanupTimer = setInterval(() => {
  try {
    cleanupStaleReservations();
  } catch (error) {
    console.error("[maintenance] Failed to clean stale billing reservations", error);
  }
}, 30_000);
reservationCleanupTimer.unref?.();

const subscriptionMaintenanceTimer = setInterval(() => {
  try {
    maintainDueSubscriptions();
  } catch (error) {
    console.error("[maintenance] Failed to update due subscriptions", error);
  }
}, 60_000);
subscriptionMaintenanceTimer.unref?.();

const app = express();
app.disable("x-powered-by");
const configuredTrustProxy = process.env.TRUST_PROXY?.trim().toLowerCase();
app.set(
  "trust proxy",
  configuredTrustProxy === "true"
    ? true
    : configuredTrustProxy === "false"
      ? false
      : process.env.TRUST_PROXY?.trim() || "loopback",
);
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "localapi", port: SINGLE_PORT });
});

app.get("/branding", (_req, res) => {
  res.json(getPublicBrandingPayload());
});

app.get("/modules/public", (_req, res) => {
  res.json({ items: moduleRegistry.listPublic() });
});

// Parse bodies only for the admin API. Proxy requests are parsed selectively in
// routes/proxy.ts so multipart and binary uploads remain true streams.
app.use(
  "/admin/api",
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" }),
  express.text({ type: ["text/*", "application/x-ndjson"], limit: "20mb" }),
  adminRouter,
);
// Module user routes (e.g. LinuxDo OAuth start/callback) must run BEFORE userRouter.
// userRouter applies requireUser as a catch-all after its public login/register routes,
// which would otherwise 401 unauthenticated OAuth hits like /user/api/auth/linuxdo.
app.use(
  "/user/api",
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" }),
  moduleRegistry.userHost.router,
  userRouter,
);
app.use(paymentsRouter);
app.use(moduleRegistry.paymentHost.router);
app.use(proxyRouter);
// OAuth broker for the Pi-Web provider: /oauth/login|check|token|refresh are
// public; /oauth/authorize is the browser consent endpoint (session auth).
app.use("/oauth", express.json({ limit: "1mb" }), oauthRouter);

// Frontend static + SPA fallback on the same port
const webDistCandidates = [
  path.resolve(__dirname, "../../web/dist"),
  path.resolve(process.cwd(), "../web/dist"),
  path.resolve(process.cwd(), "web/dist"),
];
const webDist = webDistCandidates.find((p) =>
  fs.existsSync(path.join(p, "index.html")),
);

if (webDist) {
  const sendBrandedSpa = (_req: express.Request, res: express.Response) => {
    const html = applyBrandingToHtml(fs.readFileSync(path.join(webDist, "index.html"), "utf8"));
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  };

  // Never let express.static serve the unbranded shell.
  app.get("/", sendBrandedSpa);
  app.get("/index.html", sendBrandedSpa);

  // Hashed assets can be cached forever; HTML stays revalidated.
  app.use(
    express.static(webDist, {
      etag: true,
      lastModified: true,
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }
        res.setHeader("Cache-Control", "public, max-age=3600");
      },
    }),
  );
  // SPA fallback for client routes (not API)
  app.get("/{*spa}", (req, res, next) => {
    if (
      req.path.startsWith("/admin/api") ||
      req.path.startsWith("/user/api") ||
      req.path.startsWith("/oauth/login") ||
      req.path.startsWith("/oauth/check") ||
      req.path.startsWith("/oauth/token") ||
      req.path.startsWith("/coding") ||
      req.path.startsWith("/payment/") ||
      req.path === "/health" ||
      req.path === "/branding" ||
      req.path === "/modules/public"
    ) {
      return next();
    }
    return sendBrandedSpa(req, res);
  });
  console.log(`[ui] Serving admin console from ${webDist}`);
} else {
  console.warn(
    "[ui] web/dist not found. Run `npm run build --prefix web` first.",
  );
}

// M11: JSON 404 + global JSON error handler. The SPA fallback above already
// answered non-API GETs, so anything that reaches notFoundJson is a miss on an
// API/unknown route. The error handler catches body-parser overruns (413),
// multer LIMIT_FILE_SIZE (413), JSON parse failures (400) and unknown 5xx
// without leaking stack traces or filesystem paths.
app.use(notFoundJson);
app.use(errorHandler);

const server = app.listen(SINGLE_PORT, LISTEN_HOST, () => {
  console.log(`LocalAPI on http://${LISTEN_HOST}:${SINGLE_PORT}`);
  console.log(`  Admin UI : http://${LISTEN_HOST}:${SINGLE_PORT}/`);
  console.log(`  Admin API: http://${LISTEN_HOST}:${SINGLE_PORT}/admin/api`);
  console.log(`  Proxy    : http://${LISTEN_HOST}:${SINGLE_PORT}/v1/*`);
});
startProxyScheduler();

const configuredKeepAlive = Number(process.env.CLIENT_KEEP_ALIVE_MS || 65_000);
const keepAliveMs = Number.isFinite(configuredKeepAlive)
  ? Math.max(5_000, configuredKeepAlive)
  : 65_000;
const configuredRequestTimeout = Number(process.env.CLIENT_REQUEST_TIMEOUT_MS || 120_000);
const requestTimeoutMs = Number.isFinite(configuredRequestTimeout)
  ? Math.max(30_000, configuredRequestTimeout)
  : 120_000;
server.keepAliveTimeout = keepAliveMs;
server.headersTimeout = keepAliveMs + 5_000;
server.requestTimeout = requestTimeoutMs;
