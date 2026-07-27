import { getSetting, setSetting } from "../db";
import { decryptSecret, encryptSecret } from "../utils/secrets";

export type LinuxDoOAuthConfig = {
  enabled: boolean;
  client_id: string;
  client_secret: string;
  relay_url: string;
  relay_secret: string;
  base_url: string;
};

export type LinuxDoOAuthPublicConfig = {
  enabled: boolean;
  client_id: string;
  client_secret_set: boolean;
  relay_url: string;
  relay_secret_set: boolean;
  configured: boolean;
  callback_url: string;
  authorize_ready: boolean;
};

function envValue(name: string) {
  return process.env[name]?.trim() || "";
}

function normalizeRelayUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function readStoredSecret(key: string) {
  const raw = getSetting(key)?.trim() || "";
  if (!raw) return "";
  try {
    return decryptSecret(raw);
  } catch {
    return "";
  }
}

function resolveSetting(key: string, envName: string) {
  const stored = getSetting(key)?.trim() || "";
  return stored || envValue(envName);
}

export function getPublicBaseUrl() {
  // Prefer admin setting so each deployment domain can be changed without redeploying env.
  return (getSetting("public_base_url") || envValue("PUBLIC_BASE_URL") || "").replace(/\/$/, "");
}

export function getLinuxDoOAuthConfig(): LinuxDoOAuthConfig {
  return {
    enabled: (getSetting("linuxdo_login_enabled") ?? "false") === "true",
    client_id: resolveSetting("linuxdo_client_id", "LINUXDO_CLIENT_ID"),
    client_secret:
      readStoredSecret("linuxdo_client_secret") || envValue("LINUXDO_CLIENT_SECRET"),
    relay_url: normalizeRelayUrl(
      resolveSetting("linuxdo_relay_url", "LINUXDO_RELAY_URL"),
    ),
    relay_secret:
      readStoredSecret("linuxdo_relay_secret") || envValue("LINUXDO_RELAY_SECRET"),
    base_url: "https://connect.linux.do",
  };
}

export function isLinuxDoOAuthConfigured(config = getLinuxDoOAuthConfig()) {
  if (!config.client_id || !getPublicBaseUrl()) return false;
  if (config.relay_url) return true;
  return Boolean(config.client_secret);
}

export function isLinuxDoOAuthEnabled(config = getLinuxDoOAuthConfig()) {
  return config.enabled && isLinuxDoOAuthConfigured(config);
}

export function getLinuxDoCallbackUrl(publicBase = getPublicBaseUrl()) {
  if (!publicBase) return "";
  return `${publicBase}/user/api/auth/linuxdo/callback`;
}

export function getLinuxDoOAuthPublicConfig(): LinuxDoOAuthPublicConfig {
  const config = getLinuxDoOAuthConfig();
  const configured = isLinuxDoOAuthConfigured(config);
  return {
    enabled: config.enabled,
    client_id: config.client_id,
    client_secret_set: Boolean(config.client_secret),
    relay_url: config.relay_url,
    relay_secret_set: Boolean(config.relay_secret),
    configured,
    callback_url: getLinuxDoCallbackUrl(),
    authorize_ready: isLinuxDoOAuthEnabled(config),
  };
}

export type LinuxDoOAuthUpdateInput = {
  enabled?: boolean;
  client_id?: string;
  client_secret?: string;
  relay_url?: string;
  relay_secret?: string;
};

export function updateLinuxDoOAuthConfig(input: LinuxDoOAuthUpdateInput) {
  const current = getLinuxDoOAuthConfig();

  if (input.client_id !== undefined) {
    setSetting("linuxdo_client_id", input.client_id.trim());
  }

  if (input.client_secret !== undefined) {
    const next = input.client_secret.trim();
    // Empty means keep existing secret so the admin form can leave it blank.
    if (next) setSetting("linuxdo_client_secret", encryptSecret(next));
  }

  if (input.relay_url !== undefined) {
    setSetting("linuxdo_relay_url", normalizeRelayUrl(input.relay_url));
  }

  if (input.relay_secret !== undefined) {
    const next = input.relay_secret.trim();
    if (next) setSetting("linuxdo_relay_secret", encryptSecret(next));
    else if (input.relay_secret === "") {
      // Explicit empty clears relay secret when relay is unused.
      setSetting("linuxdo_relay_secret", "");
    }
  }

  if (input.enabled !== undefined) {
    setSetting("linuxdo_login_enabled", input.enabled ? "true" : "false");
  }

  const next = getLinuxDoOAuthConfig();
  if (next.enabled && !isLinuxDoOAuthConfigured(next)) {
    // Roll back enable if required fields are still missing.
    if (input.enabled) {
      setSetting("linuxdo_login_enabled", current.enabled ? "true" : "false");
      throw new Error(
        "LinuxDo login requires public domain, Client ID, and either Client Secret or Relay URL",
      );
    }
    setSetting("linuxdo_login_enabled", "false");
  }

  return getLinuxDoOAuthPublicConfig();
}

/** Seed DB settings from env once, so deployments can move off env later. */
export function seedLinuxDoOAuthFromEnv() {
  const seedIfEmpty = (key: string, value: string, encrypt = false) => {
    if (!value) return;
    if (getSetting(key)?.trim()) return;
    setSetting(key, encrypt ? encryptSecret(value) : value);
  };

  const hadStoredClientId = Boolean(getSetting("linuxdo_client_id")?.trim());
  seedIfEmpty("linuxdo_client_id", envValue("LINUXDO_CLIENT_ID"));
  seedIfEmpty("linuxdo_client_secret", envValue("LINUXDO_CLIENT_SECRET"), true);
  seedIfEmpty("linuxdo_relay_url", normalizeRelayUrl(envValue("LINUXDO_RELAY_URL")));
  seedIfEmpty("linuxdo_relay_secret", envValue("LINUXDO_RELAY_SECRET"), true);

  // First-time import from env: turn login on automatically when credentials are ready.
  if (!hadStoredClientId && envValue("LINUXDO_CLIENT_ID") && isLinuxDoOAuthConfigured()) {
    setSetting("linuxdo_login_enabled", "true");
  } else if (getSetting("linuxdo_login_enabled") == null) {
    setSetting("linuxdo_login_enabled", "false");
  }
}

export async function exchangeLinuxDoCode(code: string, redirectUri: string) {
  const config = getLinuxDoOAuthConfig();
  if (!isLinuxDoOAuthConfigured(config)) {
    throw new Error("LinuxDo login is not configured");
  }

  if (config.relay_url) {
    const response = await fetch(`${config.relay_url}/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-secret": config.relay_secret,
      },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    if (!response.ok) {
      throw new Error(`OAuth relay failed (${response.status})`);
    }
    return (await response.json()) as {
      username?: string;
      name?: string;
      id?: string | number;
    };
  }

  const tokenRes = await fetch(`${config.base_url}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.client_id,
      client_secret: config.client_secret,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`LinuxDo token exchange failed (${tokenRes.status})`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new Error("LinuxDo token response missing access_token");
  }

  const profileRes = await fetch(`${config.base_url}/api/user`, {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/json",
    },
  });
  if (!profileRes.ok) {
    throw new Error(`LinuxDo profile request failed (${profileRes.status})`);
  }
  return (await profileRes.json()) as {
    username?: string;
    name?: string;
    id?: string | number;
  };
}
