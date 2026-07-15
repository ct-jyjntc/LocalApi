import crypto from "crypto";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashApiKey(raw: string): string {
  return sha256(`localapi:key:${raw}`);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function buildCacheKey(parts: {
  method: string;
  path: string;
  model?: string | null;
  body?: unknown;
  query?: Record<string, unknown>;
}): string {
  const payload = stableStringify({
    method: parts.method.toUpperCase(),
    path: parts.path,
    model: parts.model ?? null,
    body: parts.body ?? null,
    query: parts.query ?? null,
  });
  return sha256(payload);
}

export function generateApiKey(): string {
  const raw = crypto.randomBytes(24).toString("base64url");
  return `la_${raw}`;
}
