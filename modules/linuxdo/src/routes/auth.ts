import crypto from "crypto";
import type { ModuleContext } from "../types";
import {
  exchangeLinuxDoCode,
  getLinuxDoCallbackUrl,
  getLinuxDoOAuthConfig,
  isLinuxDoOAuthEnabled,
} from "../oauth";

export function createAuthRoutes(ctx: ModuleContext) {
  const router = ctx.createRouter();
  const linuxdoStates = new Map<string, number>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [state, expiresAt] of linuxdoStates) {
      if (expiresAt <= now) linuxdoStates.delete(state);
    }
  }, 60_000);
  cleanup.unref?.();

  router.get("/auth/linuxdo", (req, res) => {
    const config = getLinuxDoOAuthConfig(ctx);
    const publicBase = ctx.getPublicBaseUrl();
    if (!isLinuxDoOAuthEnabled(ctx, config) || !publicBase) {
      return res.status(503).send("LinuxDo login is not configured");
    }
    const limiterKey = `linuxdo-oauth:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    const rate = ctx.rateLimit.consume(limiterKey, 30, 5 * 60_000);
    if (!rate.allowed) {
      res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).send("Too many OAuth requests");
    }
    const state = crypto.randomBytes(24).toString("hex");
    linuxdoStates.set(state, Date.now() + 10 * 60_000);
    const url = new URL(`${config.base_url}/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: config.client_id,
      redirect_uri: getLinuxDoCallbackUrl(publicBase),
      response_type: "code",
      scope: "openid profile",
      state,
    }).toString();
    return res.redirect(url.toString());
  });

  router.get("/auth/linuxdo/callback", async (req, res) => {
    const state = String(req.query?.state || "");
    const expires = linuxdoStates.get(state);
    linuxdoStates.delete(state);
    const code = String(req.query?.code || "");
    if (!expires || expires < Date.now() || !code) {
      return res.status(400).send("Invalid or expired OAuth request");
    }
    const publicBase = ctx.getPublicBaseUrl();
    if (!publicBase || !isLinuxDoOAuthEnabled(ctx)) {
      return res.status(503).send("LinuxDo login is not configured");
    }
    try {
      const profile = await exchangeLinuxDoCode(ctx, code, getLinuxDoCallbackUrl(publicBase));
      const username = (profile.username || `linuxdo_${profile.id || crypto.randomBytes(6).toString("hex")}`).trim();
      let user = ctx.users.getByUsername(username);
      if (!user) {
        const linuxdoRegistrationEnabled =
          (ctx.getSetting("linuxdo_registration_enabled") ?? "true") === "true";
        if (!linuxdoRegistrationEnabled) {
          return res
            .status(403)
            .send("LinuxDo registration is closed. Please sign in with an existing account or contact the administrator.");
        }
        user = ctx.users.create({
          username,
          display_name: profile.name || username,
          password: crypto.randomBytes(32).toString("base64url"),
        });
      }
      const session = ctx.users.createSession(user.id);
      return res.redirect(`${publicBase}/?linuxdo_token=${encodeURIComponent(session.token)}`);
    } catch (error) {
      return res.status(502).send(error instanceof Error ? error.message : "LinuxDo login failed");
    }
  });

  return router;
}
