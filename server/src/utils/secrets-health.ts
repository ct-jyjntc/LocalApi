import { db } from "../db";
import { tryDecryptSecret } from "./secrets";

export type SecretsHealth = {
  /** Number of stored fields that carry the enc:v1: prefix. */
  encryptedCount: number;
  /** Number of non-empty credential fields stored WITHOUT encryption. */
  plaintextCount: number;
  /** Human-readable problems that must be fixed before starting. */
  issues: string[];
};

const ENC_PREFIX = "enc:v1:";

/**
 * Scans every table that stores credentials and verifies that the current
 * SECRETS_KEY (if any) can actually decrypt what is on disk. Run once at
 * startup so a wrong/missing key fails loudly instead of turning every
 * request that touches a credential into a 500.
 */
export function checkSecretsHealth(): SecretsHealth {
  const keyConfigured = Boolean(process.env.SECRETS_KEY?.trim());

  const encrypted: string[] = [];
  const plaintext: string[] = [];

  const scan = (rows: Array<{ value: string | null }>, label: string) => {
    for (const row of rows) {
      const value = (row.value ?? "").trim();
      if (!value) continue;
      if (value.startsWith(ENC_PREFIX)) encrypted.push(value);
      else plaintext.push(label);
    }
  };

  scan(
    db.prepare("SELECT api_key AS value FROM providers WHERE api_key != ''").all() as Array<{
      value: string | null;
    }>,
    "providers.api_key",
  );
  scan(
    db
      .prepare("SELECT key_plain AS value FROM api_keys WHERE key_plain IS NOT NULL AND key_plain != ''")
      .all() as Array<{ value: string | null }>,
    "api_keys.key_plain",
  );
  scan(
    db
      .prepare("SELECT client_secret AS value FROM payment_channels WHERE client_secret != ''")
      .all() as Array<{ value: string | null }>,
    "payment_channels.client_secret",
  );
  scan(
    db
      .prepare(
        "SELECT value FROM settings WHERE key IN ('linuxdo_client_secret', 'linuxdo_relay_secret') AND value != ''",
      )
      .all() as Array<{ value: string | null }>,
    "settings (linuxdo secrets)",
  );

  const issues: string[] = [];
  if (encrypted.length > 0 && !keyConfigured) {
    issues.push(
      `SECRETS_KEY is not set but ${encrypted.length} credential field(s) are encrypted (enc:v1:). ` +
        "Set SECRETS_KEY to the key that was configured when they were written, otherwise they cannot be read.",
    );
  } else if (encrypted.length > 0 && keyConfigured) {
    let failed = 0;
    for (const value of encrypted) {
      if (tryDecryptSecret(value) === null) failed += 1;
    }
    if (failed > 0) {
      issues.push(
        `SECRETS_KEY does not match the stored credentials: ${failed} of ${encrypted.length} encrypted ` +
          "field(s) failed to decrypt. Restore the original SECRETS_KEY, or delete and re-enter those credentials.",
      );
    }
  }

  return { encryptedCount: encrypted.length, plaintextCount: plaintext.length, issues };
}
