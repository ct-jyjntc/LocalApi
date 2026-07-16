export const DEFAULT_ADMIN_ENTRY_PATH = "/admin";

const reservedAdminPaths = new Set([
  "/billing", "/branding", "/coding", "/docs", "/health", "/keys",
  "/logs", "/plans", "/pricing", "/providers", "/settings", "/usage",
  "/user", "/users", "/v1",
]);

export function normalizeAdminEntryPath(value: string): string {
  const segment = value.trim().replace(/^\/+|\/+$/g, "");
  return segment ? `/${segment}` : "";
}

export function isValidAdminEntryPath(value: string): boolean {
  const normalized = normalizeAdminEntryPath(value);
  return /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(normalized) && !reservedAdminPaths.has(normalized.toLowerCase());
}
