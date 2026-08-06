import crypto from "crypto";

const PREFIX = "enc:v1:";

function encryptionKey() {
  const configured = process.env.SECRETS_KEY?.trim();
  if (!configured) return null;
  return crypto.createHash("sha256").update(configured).digest();
}

export function encryptSecret(value: string) {
  if (!value || value.startsWith(PREFIX)) return value;
  const key = encryptionKey();
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string) {
  if (!value.startsWith(PREFIX)) return value;
  const key = encryptionKey();
  if (!key) throw new Error("SECRETS_KEY is required to decrypt provider credentials");
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted secret format");
  const [ivRaw, tagRaw, encryptedRaw] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Non-throwing variant: returns null when the value is encrypted but cannot
 * be decrypted with the current SECRETS_KEY. Callers on request paths use
 * this so a wrong/missing key degrades to a per-request failure (401 / empty
 * key list) instead of crashing the process.
 */
export function tryDecryptSecret(value: string): string | null {
  if (!value.startsWith(PREFIX)) return value;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}
