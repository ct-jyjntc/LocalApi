import crypto from "crypto";

const PREFIX = "sha256:";

export function hashAdminSecret(secret: string) {
  return `${PREFIX}${crypto.createHash("sha256").update(`localapi:admin:${secret}`, "utf8").digest("hex")}`;
}

export function isHashedAdminSecret(value: string) {
  return value.startsWith(PREFIX) && value.length === PREFIX.length + 64;
}
