"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
const crypto_1 = __importDefault(require("crypto"));
const oauth_1 = require("../oauth");
const STATE_TTL_MS = 10 * 60_000;
const EXCHANGE_CODE_TTL_MS = 2 * 60_000;
const NONCE_COOKIE = "linuxdo_nonce";
function parseCookies(header) {
    const out = {};
    if (!header)
        return out;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0)
            continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!key || !value)
            continue;
        try {
            out[key] = decodeURIComponent(value);
        }
        catch {
            // Malformed cookie value: ignore.
        }
    }
    return out;
}
/**
 * OAuth login flow (security notes):
 * - `state` binds the authorization request to this server (one-time, 10 min).
 * - The callback NEVER puts the session token in the URL. It issues a short-lived
 *   one-time exchange code instead, so no full-access token ever lands in
 *   browser history, proxy access logs or Referer headers.
 * - The exchange code is additionally bound to a per-browser nonce cookie set
 *   when the login flow started. A code delivered out-of-band (e.g. an attacker
 *   sending their own code URL to a victim) is rejected because the victim's
 *   browser does not hold the matching nonce.
 */
function createAuthRoutes(ctx) {
    const router = ctx.createRouter();
    const states = new Map();
    const exchangeCodes = new Map();
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [state, entry] of states) {
            if (entry.expiresAt <= now)
                states.delete(state);
        }
        for (const [code, entry] of exchangeCodes) {
            if (entry.expiresAt <= now)
                exchangeCodes.delete(code);
        }
    }, 60_000);
    cleanup.unref?.();
    router.get("/auth/linuxdo", (req, res) => {
        const config = (0, oauth_1.getLinuxDoOAuthConfig)(ctx);
        const publicBase = ctx.getPublicBaseUrl();
        if (!(0, oauth_1.isLinuxDoOAuthEnabled)(ctx, config) || !publicBase) {
            return res.status(503).send("LinuxDo login is not configured");
        }
        const limiterKey = `linuxdo-oauth:${req.ip || req.socket?.remoteAddress || "unknown"}`;
        const rate = ctx.rateLimit.consume(limiterKey, 30, 5 * 60_000);
        if (!rate.allowed) {
            res.setHeader("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
            return res.status(429).send("Too many OAuth requests");
        }
        const state = crypto_1.default.randomBytes(24).toString("hex");
        const nonce = crypto_1.default.randomBytes(16).toString("base64url");
        states.set(state, { expiresAt: Date.now() + STATE_TTL_MS, nonce });
        res.cookie(NONCE_COOKIE, nonce, {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            maxAge: STATE_TTL_MS,
        });
        const url = new URL(`${config.base_url}/oauth2/authorize`);
        url.search = new URLSearchParams({
            client_id: config.client_id,
            redirect_uri: (0, oauth_1.getLinuxDoCallbackUrl)(publicBase),
            response_type: "code",
            scope: "openid profile",
            state,
        }).toString();
        return res.redirect(url.toString());
    });
    router.get("/auth/linuxdo/callback", async (req, res) => {
        const state = String(req.query?.state || "");
        const entry = states.get(state);
        states.delete(state);
        const code = String(req.query?.code || "");
        if (!entry || entry.expiresAt < Date.now() || !code) {
            return res.status(400).send("Invalid or expired OAuth request");
        }
        const publicBase = ctx.getPublicBaseUrl();
        if (!publicBase || !(0, oauth_1.isLinuxDoOAuthEnabled)(ctx)) {
            return res.status(503).send("LinuxDo login is not configured");
        }
        try {
            const profile = await (0, oauth_1.exchangeLinuxDoCode)(ctx, code, (0, oauth_1.getLinuxDoCallbackUrl)(publicBase));
            // Identity binding: resolve the account by the LinuxDo profile id, never
            // by username — usernames are attacker-chosen and would allow an attacker
            // to register a same-named LinuxDo account and take over an existing one.
            const linuxdoUid = String(profile.id ?? "").trim();
            if (!linuxdoUid || linuxdoUid.length > 128) {
                return res.status(502).send("LinuxDo profile is missing a valid id; login rejected");
            }
            const username = (profile.username || `linuxdo_${linuxdoUid}`).trim();
            let user = ctx.users.getByLinuxDoUid(linuxdoUid);
            if (!user) {
                const existing = ctx.users.getByUsername(username);
                if (existing) {
                    // Pre-migration accounts were created by username only and have no
                    // linuxdo_uid. Claim that unbound account on first successful OAuth
                    // so existing LinuxDo users keep working. If the username is already
                    // bound to a different uid, refuse (account-takeover guard).
                    if (!existing.linuxdo_uid) {
                        user = ctx.users.bindLinuxDoUid(existing.id, linuxdoUid) ?? existing;
                    }
                    else {
                        return res
                            .status(409)
                            .send("该用户名已被其他账号占用且未绑定当前 LinuxDo 账号，登录已拒绝。" +
                            "如确为本人的账号，请先用密码登录，或联系管理员绑定 LinuxDo 账号。");
                    }
                }
                const linuxdoRegistrationEnabled = (ctx.getSetting("linuxdo_registration_enabled") ?? "true") === "true";
                if (!linuxdoRegistrationEnabled) {
                    return res
                        .status(403)
                        .send("LinuxDo registration is closed. Please sign in with an existing account or contact the administrator.");
                }
                user = ctx.users.create({
                    username,
                    display_name: profile.name || username,
                    password: crypto_1.default.randomBytes(32).toString("base64url"),
                    linuxdo_uid: linuxdoUid,
                });
            }
            // One-time exchange code instead of the session token in the URL.
            const exchangeCode = crypto_1.default.randomBytes(24).toString("base64url");
            exchangeCodes.set(exchangeCode, {
                userId: user.id,
                expiresAt: Date.now() + EXCHANGE_CODE_TTL_MS,
                nonce: entry.nonce,
            });
            return res.redirect(`${publicBase}/?linuxdo_code=${encodeURIComponent(exchangeCode)}`);
        }
        catch (error) {
            return res.status(502).send(error instanceof Error ? error.message : "LinuxDo login failed");
        }
    });
    // Exchanges a one-time login code for a session token. The code alone is
    // worthless: the browser must also present the nonce cookie that was set when
    // this login flow started, which prevents out-of-band code injection.
    router.post("/auth/linuxdo/exchange", (req, res) => {
        const body = (req.body ?? {});
        const exchangeCode = String(body.code || "").trim();
        const entry = exchangeCodes.get(exchangeCode);
        if (!entry || entry.expiresAt < Date.now()) {
            exchangeCodes.delete(exchangeCode);
            return res.status(400).json({ error: "Invalid or expired login code" });
        }
        const cookies = parseCookies(req.headers.cookie);
        if (!cookies[NONCE_COOKIE] || cookies[NONCE_COOKIE] !== entry.nonce) {
            exchangeCodes.delete(exchangeCode);
            return res.status(403).json({ error: "Login code does not match this browser" });
        }
        exchangeCodes.delete(exchangeCode);
        const session = ctx.users.createSession(entry.userId);
        return res.json({ token: session.token, expires_at: session.expires_at });
    });
    return {
        router,
        cleanup() {
            clearInterval(cleanup);
            states.clear();
            exchangeCodes.clear();
        },
    };
}
