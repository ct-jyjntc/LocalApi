import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "path";
import fs from "fs";
import { initDb, getSetting, setSetting } from "./db";
import { adminRouter } from "./routes/admin";
import { proxyRouter } from "./routes/proxy";
import { createProvider, listProviders } from "./services/providers";
import { createApiKey, listApiKeys } from "./services/keys";

initDb();

// Single-port app
const SINGLE_PORT = Number(process.env.PORT || 5555);
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
    console.log(`[seed] Admin password: ${getSetting("admin_token")}`);
  }
}

seedIfEmpty();

const app = express();
app.disable("x-powered-by");
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "localapi", port: SINGLE_PORT });
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
app.use(proxyRouter);

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
  app.use(express.static(webDist));
  // SPA fallback for client routes (not API)
  app.get("/{*spa}", (req, res, next) => {
    if (
      req.path.startsWith("/admin/api") ||
      req.path.startsWith("/v1") ||
      req.path === "/health"
    ) {
      return next();
    }
    return res.sendFile(path.join(webDist, "index.html"));
  });
  console.log(`[ui] Serving admin console from ${webDist}`);
} else {
  console.warn(
    "[ui] web/dist not found. Run `npm run build --prefix web` first.",
  );
}

const server = app.listen(SINGLE_PORT, "0.0.0.0", () => {
  console.log(`LocalAPI on http://127.0.0.1:${SINGLE_PORT}`);
  console.log(`  Admin UI : http://127.0.0.1:${SINGLE_PORT}/`);
  console.log(`  Admin API: http://127.0.0.1:${SINGLE_PORT}/admin/api`);
  console.log(`  Proxy    : http://127.0.0.1:${SINGLE_PORT}/v1/*`);
});

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
