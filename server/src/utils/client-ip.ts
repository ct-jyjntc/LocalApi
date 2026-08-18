import type { Request } from "express";

/**
 * Extract the real client IP from an Express request.
 *
 * Priority:
 *  1. `x-real-ip` header (set by nginx in our HA setup)
 *  2. first entry of `x-forwarded-for` header (comma-separated, leftmost hop)
 *  3. `req.ip` (Express-derived, depends on `trust proxy` setting)
 *  4. `req.socket.remoteAddress` (raw TCP peer)
 *  5. `fallback` argument (defaults to "unknown")
 *
 * Why a dedicated helper: in the HA deployment, nginx on host 161 proxies to
 * the node app on host 160. Without reading the forwarded headers, `req.ip`
 * on 160 resolves to 161's internal IP rather than the real client. nginx is
 * configured to set both `X-Real-IP` and `X-Forwarded-For`, so we prefer those
 * before falling back to Express's own derivation. This keeps the rate-limit
 * keys and audit/风控 records tied to the actual client regardless of the
 * `TRUST_PROXY` env (which we manage separately at deploy time).
 */
export function getClientIp(req: Request, fallback: string = "unknown"): string {
  const headers = req.headers as Record<string, string | string[] | undefined>;

  // 1. x-real-ip — single authoritative value set by our nginx.
  const xRealIp = headers["x-real-ip"];
  if (typeof xRealIp === "string") {
    const trimmed = xRealIp.trim();
    if (trimmed) return trimmed;
  } else if (Array.isArray(xRealIp) && xRealIp.length > 0) {
    const first = xRealIp[0]?.trim();
    if (first) return first;
  }

  // 2. x-forwarded-for — leftmost entry is the original client.
  const xForwardedFor = headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string") {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    const first = xForwardedFor[0]?.split(",")[0]?.trim();
    if (first) return first;
  }

  // 3. Express-derived IP (respects `trust proxy` if enabled).
  if (req.ip) return req.ip;

  // 4. Raw TCP peer — last resort before the fallback.
  const remote = req.socket?.remoteAddress;
  if (remote) return remote;

  return fallback;
}
