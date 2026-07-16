import crypto from "crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, saltRaw, keyRaw] = encoded.split(":");
  if (scheme !== "scrypt" || !saltRaw || !keyRaw) return false;
  try {
    const expected = Buffer.from(keyRaw, "base64url");
    const actual = crypto.scryptSync(
      password,
      Buffer.from(saltRaw, "base64url"),
      expected.length,
    );
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
