/**
 * Deep redaction for audit-log details. Sensitive fields (passwords, secrets,
 * tokens, API keys) are replaced with a placeholder so they never reach disk.
 * Recursion is depth-limited so a hostile/cyclic object cannot blow the stack.
 */

const SENSITIVE_KEYS = new Set([
  "password",
  "admin_password",
  "current_admin_password",
  "api_key",
  "api_keys",
  "key_plain",
  "client_secret",
  "clientSecret",
  "secret",
  "relay_secret",
  "token",
  "auth_token",
  "authorization",
  "private_key",
  "verification_key",
  "webhook_secret",
]);

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}
