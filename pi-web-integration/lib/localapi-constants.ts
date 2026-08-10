/**
 * Wire constants for the LocalApi OAuth provider (Pi-Web integration).
 * Server-only, shared with lib/localapi-provider.ts.
 *
 * Override the instance URL with LOCALAPI_BASE_URL when the relay is not on
 * this machine's default port.
 */
export const LOCALAPI_PROVIDER_ID = "localapi";
export const LOCALAPI_DISPLAY_NAME = "LocalApi";
export const LOCALAPI_BASE_URL = (
  process.env.LOCALAPI_BASE_URL || "http://127.0.0.1:5555"
).replace(/\/+$/, "");

/** Wallet channel: OpenAI-compatible proxy, billed from the wallet balance. */
export const LOCALAPI_WALLET_BASE_URL = `${LOCALAPI_BASE_URL}/v1`;
/** Subscription channel: same proxy shape, gated by the Coding Plan. */
export const LOCALAPI_CODING_BASE_URL = `${LOCALAPI_BASE_URL}/coding/v1`;

export const LOCALAPI_LOGIN_URL = `${LOCALAPI_BASE_URL}/oauth/login`;
export const LOCALAPI_CHECK_URL = `${LOCALAPI_BASE_URL}/oauth/check`;
export const LOCALAPI_TOKEN_URL = `${LOCALAPI_BASE_URL}/oauth/token`;
export const LOCALAPI_REFRESH_URL = `${LOCALAPI_BASE_URL}/oauth/refresh`;
