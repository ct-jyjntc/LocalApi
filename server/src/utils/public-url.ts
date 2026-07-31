import { getSetting } from "../db";

function envValue(name: string) {
  return process.env[name]?.trim() || "";
}

/** Public site origin used for OAuth callbacks and payment return URLs. */
export function getPublicBaseUrl() {
  // Prefer admin setting so each deployment domain can be changed without redeploying env.
  return (getSetting("public_base_url") || envValue("PUBLIC_BASE_URL") || "").replace(/\/$/, "");
}
