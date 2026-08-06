import { v4 as uuid } from "uuid";
import {
  db,
  getSetting,
  type PaymentChannel,
  type PaymentOrder,
} from "../db";
import { decryptSecret, encryptSecret } from "../utils/secrets";
import { nowIso } from "../utils/time";
import type { PaymentChannelSeed } from "../modules/types";
import {
  getPaymentProvider,
  getPaymentProviderByChannelId,
} from "./payment-providers";
import {
  buildAlipayPaymentSubmission,
  queryAlipayOrder,
  queryAlipayRefund,
  refundAlipayOrder,
  verifyAlipaySignature,
  type AlipayCredentials,
  type AlipayPayMode,
} from "./alipay";
import {
  createWechatPayOrder,
  decodeWechatPayNotification,
  queryWechatPayOrder,
  queryWechatPayRefund,
  refundWechatPayOrder,
  WechatPayRequestError,
  type WechatPayCredentials,
  type WechatPayMode,
  type WechatPayNotificationHeaders,
} from "./wechatpay";

const LINUXDO_CHANNEL_ID = "linuxdo-credit";
const ALIPAY_CHANNEL_ID = "alipay";
const WECHATPAY_CHANNEL_ID = "wechatpay";
const CENTS_PER_ASSET = 100n;

type AlipayChannelConfig = {
  alipay_public_key?: string;
  seller_id?: string;
  web_enabled?: boolean;
  wap_enabled?: boolean;
};

type WechatPayChannelConfig = {
  wechat_app_id?: string;
  wechat_serial_no?: string;
  wechat_private_key?: string;
  wechat_platform_certificate?: string;
  wechat_platform_serial_no?: string;
  wechat_native_enabled?: boolean;
  wechat_h5_enabled?: boolean;
  wechat_h5_type?: string;
  wechat_h5_app_name?: string;
  wechat_h5_app_url?: string;
};

type PaymentChannelConfig = AlipayChannelConfig & WechatPayChannelConfig;

export class PaymentError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizedBaseUrl(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

function configuredPublicBaseUrl() {
  return normalizedBaseUrl(getSetting("public_base_url") || process.env.PUBLIC_BASE_URL || "");
}

function channelCredentials(channel: PaymentChannel) {
  return {
    clientId: channel.client_id.trim(),
    clientSecret: decryptSecret(channel.client_secret),
    gatewayUrl: channel.gateway_url,
  };
}

function parseChannelConfig(channel: PaymentChannel) {
  try {
    const value = JSON.parse(channel.config_json || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as PaymentChannelConfig : {};
  } catch {
    return {};
  }
}

function alipayCredentials(channel: PaymentChannel): AlipayCredentials {
  const config = parseChannelConfig(channel);
  return {
    appId: channel.client_id.trim(),
    privateKey: decryptSecret(channel.client_secret),
    alipayPublicKey: config.alipay_public_key?.trim() || "",
    sellerId: config.seller_id?.trim() || "",
    gatewayUrl: channel.gateway_url,
  };
}

function wechatPayCredentials(channel: PaymentChannel): WechatPayCredentials {
  const config = parseChannelConfig(channel);
  return {
    mchId: channel.client_id.trim(),
    apiV3Key: decryptSecret(channel.client_secret),
    appId: config.wechat_app_id?.trim() || "",
    serialNo: config.wechat_serial_no?.trim() || "",
    privateKey: decryptSecret(config.wechat_private_key?.trim() || ""),
    verificationKey: decryptSecret(config.wechat_platform_certificate?.trim() || ""),
    verificationSerialNo: config.wechat_platform_serial_no?.trim() || "",
    gatewayUrl: channel.gateway_url,
    h5Type: config.wechat_h5_type?.trim() || "Wap",
    h5AppName: config.wechat_h5_app_name?.trim() || "",
    h5AppUrl: config.wechat_h5_app_url?.trim() || "",
  };
}

function channelProviderPath(provider: string) {
  const adapter = getPaymentProvider(provider);
  if (adapter) return adapter.pathSegment;
  if (provider === "alipay") return "alipay";
  if (provider === "wechatpay") return "wechatpay";
  if (provider === "linuxdo_credit") return "linuxdo";
  return provider.replace(/_/g, "-");
}

function channelAsset(provider: string) {
  const adapter = getPaymentProvider(provider);
  if (adapter) return adapter.asset;
  return provider === "alipay" || provider === "wechatpay" ? "CNY" : "LDC";
}

function resolvePaymentAdapter(channel: PaymentChannel) {
  return getPaymentProviderByChannelId(channel.id) || getPaymentProvider(channel.provider);
}

function secretConfigValue(current: string | undefined, incoming: string | undefined) {
  if (incoming === undefined) return current || "";
  return incoming.trim() ? encryptSecret(incoming.trim()) : "";
}

function normalizeClientIp(value?: string) {
  const first = (value || "").split(",", 1)[0]?.trim() || "127.0.0.1";
  if (first === "::1") return "127.0.0.1";
  if (first.startsWith("::ffff:")) return first.slice(7);
  return first;
}

function wechatVerificationConfigured(key: string, serialNo?: string) {
  const verificationKey = key.trim();
  if (!verificationKey) return false;
  const usesPublicKey = /-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(verificationKey);
  return !usesPublicKey || serialNo?.trim().startsWith("PUB_KEY_ID_") === true;
}

function requireConfiguredChannel(id: string, options: { allowDisabled?: boolean } = {}) {
  const channel = getPaymentChannel(id);
  if (!channel || (!options.allowDisabled && channel.enabled !== 1)) {
    throw new PaymentError(503, "payment_channel_unavailable", "Payment channel is not enabled");
  }
  const adapter = resolvePaymentAdapter(channel);
  if (adapter) {
    if (!adapter.isConfigured(channel)) {
      throw new PaymentError(503, "payment_channel_incomplete", `${channel.name} credentials are incomplete`);
    }
    return {
      channel,
      paymentAdapter: adapter,
      pluginCredentials: adapter.getCredentials(channel),
    };
  }
  if (channel.provider === "alipay") {
    const credentials = alipayCredentials(channel);
    if (!credentials.appId || !credentials.privateKey || !credentials.alipayPublicKey) {
      throw new PaymentError(503, "payment_channel_incomplete", "Alipay credentials are incomplete");
    }
    return { channel, alipayCredentials: credentials };
  }
  if (channel.provider === "wechatpay") {
    let credentials: WechatPayCredentials;
    try {
      credentials = wechatPayCredentials(channel);
    } catch {
      throw new PaymentError(503, "payment_channel_incomplete", "WeChat Pay credentials cannot be decrypted");
    }
    if (
      !credentials.mchId
      || !credentials.apiV3Key
      || !credentials.appId
      || !credentials.serialNo
      || !credentials.privateKey
      || !wechatVerificationConfigured(credentials.verificationKey, credentials.verificationSerialNo)
    ) {
      throw new PaymentError(503, "payment_channel_incomplete", "WeChat Pay credentials are incomplete");
    }
    if (Buffer.byteLength(credentials.apiV3Key, "utf8") !== 32) {
      throw new PaymentError(503, "payment_channel_incomplete", "WeChat Pay API v3 key must be exactly 32 bytes");
    }
    return { channel, wechatPayCredentials: credentials };
  }
  throw new PaymentError(503, "payment_channel_unsupported", "Payment channel provider is not supported");
}

export function parseAssetAmount(value: string | number) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new PaymentError(400, "invalid_amount", "Amount must have at most two decimal places");
  }
  const [whole, fraction = ""] = text.split(".");
  const minor = BigInt(whole) * CENTS_PER_ASSET + BigInt(fraction.padEnd(2, "0"));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentError(400, "invalid_amount", "Amount is outside the supported range");
  }
  return Number(minor);
}

export function formatAssetAmount(amountMinor: number) {
  const safe = BigInt(Math.max(0, Math.floor(amountMinor)));
  return `${safe / CENTS_PER_ASSET}.${String(safe % CENTS_PER_ASSET).padStart(2, "0")}`;
}

function calculateCreditedMicros(amountMinor: number, feeMinor: number, exchangeRateMicros: number) {
  const netMinor = BigInt(Math.max(0, amountMinor - feeMinor));
  const credited = (netMinor * BigInt(exchangeRateMicros)) / CENTS_PER_ASSET;
  if (credited > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentError(400, "credited_amount_too_large", "The credited amount exceeds the supported range");
  }
  return Number(credited);
}

function calculateFeeMinor(channel: PaymentChannel, amountMinor: number) {
  const percentage = (BigInt(amountMinor) * BigInt(channel.fee_bps) + 9_999n) / 10_000n;
  const fee = percentage + BigInt(channel.fee_fixed_minor);
  return Number(fee > BigInt(amountMinor) ? BigInt(amountMinor) : fee);
}

function newOrderNo(prefix = "LA") {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${prefix}${stamp}${uuid().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

export type PublicPaymentOrder = Omit<PaymentOrder, "metadata"> & {
  username?: string;
  display_name?: string;
  channel_name?: string;
  amount: string;
  fee: string;
  credited_amount: number;
};

type PaymentRefundRecord = {
  id: string;
  refund_no: string;
  order_id: string;
  channel_id: string;
  amount_minor: number;
  debit_micros: number;
  status: string;
  reason: string;
  response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function publicOrder(row: PaymentOrder & Record<string, unknown>): PublicPaymentOrder {
  const safe: Record<string, unknown> = { ...row };
  delete safe.metadata;
  return {
    ...safe,
    id: row.id,
    order_no: row.order_no,
    user_id: row.user_id,
    status: row.status,
    amount_minor: row.amount_minor,
    fee_minor: row.fee_minor,
    asset: row.asset,
    credited_micros: row.credited_micros,
    amount: formatAssetAmount(row.amount_minor),
    fee: formatAssetAmount(row.fee_minor),
    credited_amount: row.credited_micros / 1_000_000,
  } as PublicPaymentOrder;
}

export function getPaymentChannel(id = LINUXDO_CHANNEL_ID) {
  return (db.prepare("SELECT * FROM payment_channels WHERE id = ?").get(id) as PaymentChannel | undefined) ?? null;
}

export function getPaymentChannelAdmin(id = LINUXDO_CHANNEL_ID) {
  const channel = getPaymentChannel(id);
  if (!channel) return null;
  const publicBaseUrl = configuredPublicBaseUrl();
  const config = parseChannelConfig(channel);
  const wechat = channel.provider === "wechatpay" ? (() => {
    try {
      const credentials = wechatPayCredentials(channel);
      return {
        wechat_app_id: credentials.appId,
        wechat_serial_no: credentials.serialNo,
        wechat_private_key: credentials.privateKey,
        wechat_platform_certificate: credentials.verificationKey,
        wechat_platform_serial_no: credentials.verificationSerialNo || "",
      };
    } catch {
      return {
        wechat_app_id: config.wechat_app_id || "",
        wechat_serial_no: config.wechat_serial_no || "",
        wechat_private_key: "",
        wechat_platform_certificate: "",
        wechat_platform_serial_no: config.wechat_platform_serial_no || "",
      };
    }
  })() : {};
  return {
    ...channel,
    enabled: channel.enabled === 1,
    client_secret: channel.client_secret ? decryptSecret(channel.client_secret) : "",
    ...(channel.provider === "alipay" ? {
      alipay_public_key: config.alipay_public_key || "",
      seller_id: config.seller_id || "",
      web_enabled: config.web_enabled !== false,
      wap_enabled: config.wap_enabled !== false,
    } : {}),
    ...(channel.provider === "wechatpay" ? {
      ...wechat,
      wechat_native_enabled: config.wechat_native_enabled !== false,
      wechat_h5_enabled: config.wechat_h5_enabled !== false,
      wechat_h5_type: config.wechat_h5_type || "Wap",
      wechat_h5_app_name: config.wechat_h5_app_name || "",
      wechat_h5_app_url: config.wechat_h5_app_url || "",
    } : {}),
    notify_url: publicBaseUrl ? `${publicBaseUrl}/payment/${channelProviderPath(channel.provider)}/notify` : "",
    return_url: publicBaseUrl ? `${publicBaseUrl}/payments` : "",
  };
}

export function getPaymentChannelsAdmin() {
  return (db.prepare("SELECT id FROM payment_channels ORDER BY created_at, id").all() as Array<{ id: string }>)
    .map((row) => getPaymentChannelAdmin(row.id))
    .filter(Boolean);
}

export function getPaymentChannelPublic(id = LINUXDO_CHANNEL_ID) {
  const channel = getPaymentChannel(id);
  if (!channel) return null;
  const config = parseChannelConfig(channel);
  const adapter = resolvePaymentAdapter(channel);
  const isCoreProvider = channel.provider === "alipay" || channel.provider === "wechatpay";
  // Plugin providers (e.g. linuxdo_credit) require an active module adapter.
  if (!isCoreProvider && !adapter) {
    return {
      id: channel.id,
      provider: channel.provider,
      name: channel.name,
      enabled: false,
      asset: channelAsset(channel.provider),
      payment_modes: ["redirect"],
      exchange_rate_micros: channel.exchange_rate_micros,
      min_amount_minor: channel.min_amount_minor,
      max_amount_minor: channel.max_amount_minor,
      fee_bps: channel.fee_bps,
      fee_fixed_minor: channel.fee_fixed_minor,
    };
  }
  let configured = Boolean(
    channel.client_id.trim()
    && channel.client_secret
    && configuredPublicBaseUrl(),
  );
  if (adapter) {
    configured = adapter.isConfigured(channel) && Boolean(configuredPublicBaseUrl());
  }
  if (configured && channel.provider === "alipay") configured = Boolean(config.alipay_public_key?.trim());
  if (configured && channel.provider === "wechatpay") {
    try {
      const credentials = wechatPayCredentials(channel);
      configured = Boolean(
        credentials.mchId
        && credentials.apiV3Key
        && Buffer.byteLength(credentials.apiV3Key, "utf8") === 32
        && credentials.appId
        && credentials.serialNo
        && credentials.privateKey
        && wechatVerificationConfigured(credentials.verificationKey, credentials.verificationSerialNo),
      );
    } catch {
      configured = false;
    }
  }
  return {
    id: channel.id,
    provider: channel.provider,
    name: channel.name,
    enabled: channel.enabled === 1 && configured,
    asset: channelAsset(channel.provider),
    payment_modes: channel.provider === "alipay"
      ? [config.web_enabled !== false ? "page" : null, config.wap_enabled !== false ? "wap" : null].filter(Boolean)
      : channel.provider === "wechatpay"
        ? [config.wechat_native_enabled !== false ? "native" : null, config.wechat_h5_enabled !== false ? "h5" : null].filter(Boolean)
        : ["redirect"],
    exchange_rate_micros: channel.exchange_rate_micros,
    min_amount_minor: channel.min_amount_minor,
    max_amount_minor: channel.max_amount_minor,
    fee_bps: channel.fee_bps,
    fee_fixed_minor: channel.fee_fixed_minor,
  };
}

export function getPaymentChannelsPublic() {
  return (db.prepare("SELECT id FROM payment_channels ORDER BY created_at, id").all() as Array<{ id: string }>)
    .map((row) => getPaymentChannelPublic(row.id))
    .filter((channel) => channel?.enabled);
}

export function updatePaymentChannel(input: {
  enabled?: boolean;
  name?: string;
  client_id?: string;
  client_secret?: string;
  gateway_url?: string;
  exchange_rate_micros?: number;
  min_amount_minor?: number;
  max_amount_minor?: number;
  fee_bps?: number;
  fee_fixed_minor?: number;
  alipay_public_key?: string;
  seller_id?: string;
  web_enabled?: boolean;
  wap_enabled?: boolean;
  wechat_app_id?: string;
  wechat_serial_no?: string;
  wechat_private_key?: string;
  wechat_platform_certificate?: string;
  wechat_platform_serial_no?: string;
  wechat_native_enabled?: boolean;
  wechat_h5_enabled?: boolean;
  wechat_h5_type?: string;
  wechat_h5_app_name?: string;
  wechat_h5_app_url?: string;
}, id = LINUXDO_CHANNEL_ID) {
  const current = getPaymentChannel(id);
  if (!current) throw new PaymentError(404, "payment_channel_not_found", "Payment channel not found");
  const currentConfig = parseChannelConfig(current);
  const config: PaymentChannelConfig = current.provider === "alipay" ? {
    alipay_public_key: input.alipay_public_key === undefined ? currentConfig.alipay_public_key || "" : input.alipay_public_key.trim(),
    seller_id: input.seller_id === undefined ? currentConfig.seller_id || "" : input.seller_id.trim(),
    web_enabled: input.web_enabled ?? currentConfig.web_enabled ?? true,
    wap_enabled: input.wap_enabled ?? currentConfig.wap_enabled ?? true,
  } : current.provider === "wechatpay" ? {
    wechat_app_id: input.wechat_app_id === undefined ? currentConfig.wechat_app_id || "" : input.wechat_app_id.trim(),
    wechat_serial_no: input.wechat_serial_no === undefined ? currentConfig.wechat_serial_no || "" : input.wechat_serial_no.trim(),
    wechat_private_key: secretConfigValue(currentConfig.wechat_private_key, input.wechat_private_key),
    wechat_platform_certificate: secretConfigValue(currentConfig.wechat_platform_certificate, input.wechat_platform_certificate),
    wechat_platform_serial_no: input.wechat_platform_serial_no === undefined ? currentConfig.wechat_platform_serial_no || "" : input.wechat_platform_serial_no.trim(),
    wechat_native_enabled: input.wechat_native_enabled ?? currentConfig.wechat_native_enabled ?? true,
    wechat_h5_enabled: input.wechat_h5_enabled ?? currentConfig.wechat_h5_enabled ?? true,
    wechat_h5_type: input.wechat_h5_type === undefined ? currentConfig.wechat_h5_type || "Wap" : input.wechat_h5_type.trim() || "Wap",
    wechat_h5_app_name: input.wechat_h5_app_name === undefined ? currentConfig.wechat_h5_app_name || "" : input.wechat_h5_app_name.trim(),
    wechat_h5_app_url: input.wechat_h5_app_url === undefined ? currentConfig.wechat_h5_app_url || "" : input.wechat_h5_app_url.trim(),
  } : currentConfig;
  const next = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
    name: input.name?.trim() || current.name,
    client_id: input.client_id === undefined ? current.client_id : input.client_id.trim(),
    client_secret:
      input.client_secret === undefined
        ? current.client_secret
        : input.client_secret
          ? encryptSecret(input.client_secret.trim())
          : "",
    gateway_url: (input.gateway_url?.trim() || current.gateway_url).replace(/\/+$/, ""),
    exchange_rate_micros: input.exchange_rate_micros ?? current.exchange_rate_micros,
    min_amount_minor: input.min_amount_minor ?? current.min_amount_minor,
    max_amount_minor: input.max_amount_minor ?? current.max_amount_minor,
    fee_bps: input.fee_bps ?? current.fee_bps,
    fee_fixed_minor: input.fee_fixed_minor ?? current.fee_fixed_minor,
    config_json: JSON.stringify(config),
  };
  if (next.max_amount_minor < next.min_amount_minor) {
    throw new PaymentError(400, "invalid_amount_range", "Maximum amount must be greater than or equal to minimum amount");
  }
  const wechatConfigComplete = current.provider === "wechatpay"
    ? (() => {
      try {
        const apiV3Key = decryptSecret(next.client_secret);
        const privateKey = decryptSecret(config.wechat_private_key || "");
        const verificationKey = decryptSecret(config.wechat_platform_certificate || "");
        return Boolean(
          next.client_id
          && apiV3Key
          && Buffer.byteLength(apiV3Key, "utf8") === 32
          && config.wechat_app_id?.trim()
          && config.wechat_serial_no?.trim()
          && privateKey
          && wechatVerificationConfigured(verificationKey, config.wechat_platform_serial_no),
        );
      } catch {
        return false;
      }
    })()
    : true;
  if (next.enabled && (
    !next.client_id
    || !next.client_secret
    || (current.provider === "alipay" && !config.alipay_public_key)
    || (current.provider === "wechatpay" && !wechatConfigComplete)
  )) {
    throw new PaymentError(400, "payment_channel_incomplete", "Complete all required credentials before enabling the channel");
  }
  if (current.provider === "alipay" && next.enabled && !config.web_enabled && !config.wap_enabled) {
    throw new PaymentError(400, "payment_mode_required", "Enable at least one Alipay payment mode");
  }
  if (current.provider === "wechatpay" && next.enabled && !config.wechat_native_enabled && !config.wechat_h5_enabled) {
    throw new PaymentError(400, "payment_mode_required", "Enable at least one WeChat Pay payment mode");
  }
  if (current.provider === "wechatpay" && next.enabled && !/^https:\/\//i.test(configuredPublicBaseUrl())) {
    throw new PaymentError(400, "wechat_https_required", "WeChat Pay requires an HTTPS public domain");
  }
  db.prepare(
    `UPDATE payment_channels SET enabled = ?, name = ?, client_id = ?, client_secret = ?, gateway_url = ?,
      exchange_rate_micros = ?, min_amount_minor = ?, max_amount_minor = ?, fee_bps = ?, fee_fixed_minor = ?, config_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.enabled,
    next.name,
    next.client_id,
    next.client_secret,
    next.gateway_url,
    next.exchange_rate_micros,
    next.min_amount_minor,
    next.max_amount_minor,
    next.fee_bps,
    next.fee_fixed_minor,
    next.config_json,
    nowIso(),
    id,
  );
  return getPaymentChannelAdmin(id);
}

export async function createTopupOrder(
  userId: string,
  amount: string | number,
  options: {
    channelId?: string;
    mode?: AlipayPayMode | WechatPayMode;
    clientIp?: string;
    /** Client-generated idempotency key to absorb double-clicks / retries. */
    clientRequestId?: string;
  } = {},
) {
  const fallback = getPaymentChannelsPublic()[0];
  const channelId = options.channelId || fallback?.id;
  if (!channelId) {
    throw new PaymentError(503, "payment_channel_unavailable", "No payment channel is available");
  }
  const { channel } = requireConfiguredChannel(channelId);
  const publicBaseUrl = configuredPublicBaseUrl();
  if (!publicBaseUrl) {
    throw new PaymentError(503, "public_base_url_required", "Set a public domain before accepting payments");
  }
  const amountMinor = parseAssetAmount(amount);
  if (amountMinor < channel.min_amount_minor || amountMinor > channel.max_amount_minor) {
    throw new PaymentError(
      400,
      "amount_out_of_range",
      `Amount must be between ${formatAssetAmount(channel.min_amount_minor)} and ${formatAssetAmount(channel.max_amount_minor)} ${channelAsset(channel.provider)}`,
    );
  }
  const config = parseChannelConfig(channel);
  const mode = options.mode || (
    channel.provider === "alipay" ? "page" : channel.provider === "wechatpay" ? "native" : "redirect"
  );
  if (channel.provider === "alipay") {
    if (mode !== "page" && mode !== "wap") throw new PaymentError(400, "invalid_payment_mode", "Invalid Alipay payment mode");
    if (mode === "page" && config.web_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "Alipay PC web payment is disabled");
    if (mode === "wap" && config.wap_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "Alipay mobile web payment is disabled");
  }
  if (channel.provider === "wechatpay") {
    if (mode !== "native" && mode !== "h5") throw new PaymentError(400, "invalid_payment_mode", "Invalid WeChat Pay payment mode");
    if (mode === "native" && config.wechat_native_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "WeChat Pay Native QR payment is disabled");
    if (mode === "h5" && config.wechat_h5_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "WeChat Pay H5 payment is disabled");
  }
  const clientRequestId = String(options.clientRequestId || "").trim().slice(0, 80);
  if (clientRequestId) {
    // Return the same pending order for repeated clicks within 10 minutes.
    const recent = db
      .prepare(
        `SELECT * FROM payment_orders
         WHERE user_id = ? AND channel_id = ? AND status = 'pending' AND deleted_at IS NULL
           AND created_at >= ?
           AND metadata LIKE ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(
        userId,
        channel.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
        `%"client_request_id":"${clientRequestId.replace(/["%_]/g, "")}"%`,
      ) as PaymentOrder | undefined;
    if (recent) return getPaymentOrder(recent.id, userId);
  }
  const feeMinor = calculateFeeMinor(channel, amountMinor);
  const creditedMicros = calculateCreditedMicros(amountMinor, feeMinor, channel.exchange_rate_micros);
  if (creditedMicros <= 0) {
    throw new PaymentError(400, "amount_too_small", "The credited amount must be greater than zero");
  }
  const now = nowIso();
  const metadata: Record<string, unknown> = {};
  if (channel.provider === "alipay" || channel.provider === "wechatpay") {
    metadata.pay_mode = mode;
    if (channel.provider === "wechatpay") metadata.payer_client_ip = normalizeClientIp(options.clientIp);
  }
  if (clientRequestId) metadata.client_request_id = clientRequestId;
  const order: PaymentOrder = {
    id: uuid(),
    order_no: newOrderNo(),
    user_id: userId,
    channel_id: channel.id,
    channel_trade_no: null,
    purpose: "wallet_topup",
    status: "pending",
    amount_minor: amountMinor,
    fee_minor: feeMinor,
    asset: channelAsset(channel.provider),
    credited_micros: creditedMicros,
    exchange_rate_micros: channel.exchange_rate_micros,
    title: `${getSetting("brand_name") || "LocalAPI"} 账户充值`,
    pay_url: null,
    error: null,
    metadata: JSON.stringify(metadata),
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    paid_at: null,
    credited_at: null,
    refunded_at: null,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO payment_orders (
      id, order_no, user_id, channel_id, channel_trade_no, purpose, status,
      amount_minor, fee_minor, asset, credited_micros, exchange_rate_micros,
      title, pay_url, error, metadata, created_at, updated_at, expires_at,
      paid_at, credited_at, refunded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.id,
    order.order_no,
    order.user_id,
    order.channel_id,
    order.channel_trade_no,
    order.purpose,
    order.status,
    order.amount_minor,
    order.fee_minor,
    order.asset,
    order.credited_micros,
    order.exchange_rate_micros,
    order.title,
    order.pay_url,
    order.error,
    order.metadata,
    order.created_at,
    order.updated_at,
    order.expires_at,
    order.paid_at,
    order.credited_at,
    order.refunded_at,
  );

  const payUrl = `${publicBaseUrl}/payment/${channelProviderPath(channel.provider)}/checkout/${encodeURIComponent(order.order_no)}`;
  db.prepare("UPDATE payment_orders SET pay_url = ?, error = NULL, updated_at = ? WHERE id = ?")
    .run(payUrl, nowIso(), order.id);
  return getPaymentOrder(order.id, userId);
}

export function getLinuxDoCheckout(orderNo: string) {
  const provider = getPaymentProvider("linuxdo_credit") || getPaymentProviderByChannelId(LINUXDO_CHANNEL_ID);
  if (!provider?.getCheckout) {
    throw new PaymentError(503, "payment_module_unavailable", "LinuxDo payment module is not active");
  }
  return provider.getCheckout(orderNo);
}

export function getAlipayCheckout(orderNo: string) {
  const { channel, alipayCredentials: credentials } = requireConfiguredChannel(ALIPAY_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "Alipay credentials are incomplete");
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id || order.deleted_at) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  if (order.status !== "pending") {
    throw new PaymentError(409, "payment_order_not_pending", "Payment order is no longer pending");
  }
  const publicBaseUrl = configuredPublicBaseUrl();
  if (!publicBaseUrl) throw new PaymentError(503, "public_base_url_required", "Set a public domain before accepting payments");
  let metadata: { pay_mode?: AlipayPayMode } = {};
  try { metadata = JSON.parse(order.metadata || "{}"); } catch { metadata = {}; }
  return buildAlipayPaymentSubmission(credentials, {
    mode: metadata.pay_mode === "wap" ? "wap" : "page",
    orderNo: order.order_no,
    subject: order.title,
    totalAmount: formatAssetAmount(order.amount_minor),
    notifyUrl: `${publicBaseUrl}/payment/alipay/notify`,
    returnUrl: `${publicBaseUrl}/payments?order_no=${encodeURIComponent(order.order_no)}`,
    quitUrl: `${publicBaseUrl}/payments?order_no=${encodeURIComponent(order.order_no)}`,
  });
}

type WechatCheckoutMetadata = {
  pay_mode?: WechatPayMode;
  payer_client_ip?: string;
  wechat_code_url?: string;
  wechat_h5_url?: string;
};

function paymentOrderMetadata(order: PaymentOrder) {
  try {
    const parsed = JSON.parse(order.metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function getWechatCheckout(orderNo: string, clientIp?: string) {
  const { channel, wechatPayCredentials: credentials } = requireConfiguredChannel(WECHATPAY_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "WeChat Pay credentials are incomplete");
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id || order.deleted_at) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  if (order.status !== "pending") {
    throw new PaymentError(409, "payment_order_not_pending", "Payment order is no longer pending");
  }
  const publicBaseUrl = configuredPublicBaseUrl();
  if (!publicBaseUrl) throw new PaymentError(503, "public_base_url_required", "Set a public domain before accepting payments");

  const rawMetadata = paymentOrderMetadata(order);
  const metadata: WechatCheckoutMetadata = {
    pay_mode: rawMetadata.pay_mode === "h5" ? "h5" : "native",
    payer_client_ip: typeof rawMetadata.payer_client_ip === "string"
      ? rawMetadata.payer_client_ip
      : normalizeClientIp(clientIp),
    wechat_code_url: typeof rawMetadata.wechat_code_url === "string" ? rawMetadata.wechat_code_url : undefined,
    wechat_h5_url: typeof rawMetadata.wechat_h5_url === "string" ? rawMetadata.wechat_h5_url : undefined,
  };
  const payMode: WechatPayMode = metadata.pay_mode || "native";

  if (payMode === "native" && metadata.wechat_code_url) {
    return { mode: "native" as const, codeUrl: metadata.wechat_code_url, orderNo: order.order_no };
  }
  if (payMode === "h5" && metadata.wechat_h5_url) {
    return { mode: "h5" as const, h5Url: metadata.wechat_h5_url, orderNo: order.order_no };
  }

  const checkoutCredentials = {
    ...credentials,
    h5AppName: credentials.h5AppName || getSetting("brand_name") || "LocalAPI",
    h5AppUrl: credentials.h5AppUrl || publicBaseUrl,
  };
  const created = await createWechatPayOrder(checkoutCredentials, {
    mode: payMode,
    orderNo: order.order_no,
    description: order.title,
    amountMinor: order.amount_minor,
    notifyUrl: `${publicBaseUrl}/payment/wechatpay/notify`,
    payerClientIp: metadata.payer_client_ip,
  });
  const nextMetadata: Record<string, unknown> = {
    ...rawMetadata,
    pay_mode: payMode,
    payer_client_ip: metadata.payer_client_ip,
    ...(created.mode === "native" ? { wechat_code_url: created.codeUrl } : { wechat_h5_url: created.h5Url }),
  };
  db.prepare("UPDATE payment_orders SET metadata = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(nextMetadata), nowIso(), order.id);
  if (created.mode === "native") {
    return { mode: "native" as const, codeUrl: created.codeUrl, orderNo: order.order_no };
  }
  return { mode: "h5" as const, h5Url: created.h5Url, orderNo: order.order_no };
}

export function getPaymentOrder(idOrNo: string, userId?: string) {
  const row = db.prepare(
    `SELECT payment_orders.*, users.username, users.display_name, payment_channels.name AS channel_name
     FROM payment_orders
     JOIN users ON users.id = payment_orders.user_id
     JOIN payment_channels ON payment_channels.id = payment_orders.channel_id
     WHERE (payment_orders.id = ? OR payment_orders.order_no = ?)
       AND payment_orders.deleted_at IS NULL
       AND (? IS NULL OR payment_orders.user_id = ?)`,
  ).get(idOrNo, idOrNo, userId ?? null, userId ?? null) as (PaymentOrder & Record<string, unknown>) | undefined;
  return row ? publicOrder(row) : null;
}

export function listPaymentOrders(input: {
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return listPaymentOrdersPage(input).items;
}

export function listPaymentOrdersPage(input: {
  userId?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const conditions: string[] = ["payment_orders.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (input.userId) {
    conditions.push("payment_orders.user_id = ?");
    params.push(input.userId);
  }
  if (input.status) {
    conditions.push("payment_orders.status = ?");
    params.push(input.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 500);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM payment_orders
         JOIN users ON users.id = payment_orders.user_id
         JOIN payment_channels ON payment_channels.id = payment_orders.channel_id
         ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT payment_orders.*, users.username, users.display_name, payment_channels.name AS channel_name
       FROM payment_orders
       JOIN users ON users.id = payment_orders.user_id
       JOIN payment_channels ON payment_channels.id = payment_orders.channel_id
       ${where}
       ORDER BY payment_orders.created_at DESC, payment_orders.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<PaymentOrder & Record<string, unknown>>;
  return { items: rows.map(publicOrder), total, limit, offset };
}

function ensureAmountMatches(order: PaymentOrder, value: string | number | null | undefined) {
  if (value === null || value === undefined) return;
  if (parseAssetAmount(value) !== order.amount_minor) {
    throw new PaymentError(400, "payment_amount_mismatch", "Payment amount does not match the order");
  }
}

function creditOrderInTransaction(orderId: string, tradeNo: string | null, paidAt = nowIso()) {
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(orderId) as PaymentOrder | undefined;
  if (!order) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  if (["refunding", "refunded"].includes(order.status)) return order;
  if (order.status === "credited") return order;

  const now = nowIso();
  db.prepare(
    `UPDATE payment_orders SET status = 'paid', channel_trade_no = COALESCE(channel_trade_no, ?),
      paid_at = COALESCE(paid_at, ?), updated_at = ?, error = NULL, deleted_at = NULL WHERE id = ?`,
  ).run(tradeNo, paidAt, now, order.id);

  const existingLedger = db.prepare(
    "SELECT id FROM wallet_ledger WHERE reference_type = 'payment_order' AND reference_id = ?",
  ).get(order.id) as { id: string } | undefined;
  if (!existingLedger) {
    db.prepare(
      `INSERT OR IGNORE INTO wallet_accounts (user_id, balance_micros, reserved_micros, lifetime_spent_micros, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
    ).run(order.user_id, now);
    db.prepare(
      `UPDATE wallet_accounts SET balance_micros = balance_micros + ?,
        lifetime_topup_micros = lifetime_topup_micros + ?, updated_at = ? WHERE user_id = ?`,
    ).run(order.credited_micros, order.credited_micros, now, order.user_id);
    const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(order.user_id) as {
      balance_micros: number;
    };
    const channel = getPaymentChannel(order.channel_id);
    db.prepare(
      `INSERT INTO wallet_ledger (
        id, user_id, type, amount_micros, balance_after_micros, reference_type, reference_id, description, created_at
      ) VALUES (?, ?, 'payment_topup', ?, ?, 'payment_order', ?, ?, ?)`,
    ).run(
      uuid(),
      order.user_id,
      order.credited_micros,
      wallet.balance_micros,
      order.id,
      `${channel?.name || order.channel_id} 充值 ${formatAssetAmount(order.amount_minor)} ${order.asset}`,
      now,
    );
  }
  db.prepare(
    `UPDATE payment_orders SET status = 'credited', credited_at = COALESCE(credited_at, ?),
      updated_at = ?, error = NULL, deleted_at = NULL WHERE id = ?`,
  ).run(now, now, order.id);
  return db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(order.id) as PaymentOrder;
}

function activePaymentRefund(orderId: string) {
  return db.prepare(
    `SELECT * FROM payment_refunds
     WHERE order_id = ? AND status IN ('pending', 'processing')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(orderId) as PaymentRefundRecord | undefined;
}

function completeRefundInTransaction(
  orderId: string,
  refundId: string,
  response: Record<string, unknown>,
  completedAt = nowIso(),
) {
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(orderId) as PaymentOrder | undefined;
  const refund = db.prepare("SELECT * FROM payment_refunds WHERE id = ?").get(refundId) as PaymentRefundRecord | undefined;
  if (!order || !refund) throw new PaymentError(404, "payment_refund_not_found", "Payment refund not found");
  if (order.status === "refunded" || refund.status === "succeeded") return;
  const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(order.user_id) as {
    balance_micros: number;
  } | undefined;
  if (!wallet || wallet.balance_micros < refund.debit_micros) {
    throw new PaymentError(409, "insufficient_refundable_balance", "The credited balance is no longer available for refund");
  }
  // Prefer non-checkin balance for payment refunds; clamp check-in pool to remaining total.
  const fullWallet = db
    .prepare("SELECT balance_micros, checkin_balance_micros FROM wallet_accounts WHERE user_id = ?")
    .get(order.user_id) as { balance_micros: number; checkin_balance_micros: number };
  const checkinBal = Math.max(0, Number(fullWallet.checkin_balance_micros || 0));
  const regularBal = Math.max(0, fullWallet.balance_micros - checkinBal);
  const fromRegular = Math.min(refund.debit_micros, regularBal);
  const fromCheckin = refund.debit_micros - fromRegular;
  db.prepare(
    `UPDATE wallet_accounts SET balance_micros = balance_micros - ?,
      checkin_balance_micros = MAX(0, checkin_balance_micros - ?),
      reserved_micros = MAX(0, reserved_micros - ?),
      lifetime_topup_micros = MAX(0, lifetime_topup_micros - ?),
      updated_at = ? WHERE user_id = ?`,
  ).run(
    refund.debit_micros,
    fromCheckin,
    refund.debit_micros,
    refund.debit_micros,
    completedAt,
    order.user_id,
  );
  const nextWallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(order.user_id) as {
    balance_micros: number;
  };
  db.prepare(
    `INSERT OR IGNORE INTO wallet_ledger (
      id, user_id, type, amount_micros, balance_after_micros, reference_type, reference_id, description, created_at
    ) VALUES (?, ?, 'payment_refund', ?, ?, 'payment_refund', ?, ?, ?)`,
  ).run(
    uuid(),
    order.user_id,
    -refund.debit_micros,
    nextWallet.balance_micros,
    refund.id,
    `充值退款 ${order.order_no}`,
    completedAt,
  );
  db.prepare(
    `UPDATE payment_refunds SET status = 'succeeded', response = ?, error = NULL,
      updated_at = ?, completed_at = ? WHERE id = ?`,
  ).run(JSON.stringify(response), completedAt, completedAt, refund.id);
  db.prepare(
    `UPDATE payment_orders SET status = 'refunded', refunded_at = COALESCE(refunded_at, ?),
      error = NULL, updated_at = ? WHERE id = ?`,
  ).run(completedAt, completedAt, order.id);
}

function failRefundInTransaction(orderId: string, refundId: string, message: string) {
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(orderId) as PaymentOrder | undefined;
  const refund = db.prepare("SELECT * FROM payment_refunds WHERE id = ?").get(refundId) as PaymentRefundRecord | undefined;
  if (!order || !refund || refund.status === "succeeded" || refund.status === "failed") return;
  const failedAt = nowIso();
  db.prepare(
    "UPDATE wallet_accounts SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE user_id = ?",
  ).run(refund.debit_micros, failedAt, order.user_id);
  db.prepare("UPDATE payment_orders SET status = 'credited', error = ?, updated_at = ? WHERE id = ?")
    .run(message, failedAt, order.id);
  db.prepare(
    "UPDATE payment_refunds SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
  ).run(message, failedAt, refund.id);
}

async function syncAlipayRefund(order: PaymentOrder, userId?: string) {
  const refund = activePaymentRefund(order.id);
  if (!refund) return getPaymentOrder(order.id, userId);
  const configured = requireConfiguredChannel(order.channel_id, { allowDisabled: true });
  let result: { found: boolean; refundStatus: string | null; raw: Record<string, unknown> };
  try {
    result = await queryAlipayRefund(configured.alipayCredentials!, {
      tradeNo: order.channel_trade_no || undefined,
      orderNo: order.order_no,
      refundNo: refund.refund_no,
    });
  } catch (error) {
    // Query itself failed (network/signature): keep the refund pending and
    // let the next sync retry. Never fail here — the money may have moved.
    throw error;
  }
  if (result.found && result.refundStatus === "REFUND_SUCCESS") {
    db.transaction(() => completeRefundInTransaction(order.id, refund.id, result.raw))();
  } else if (!result.found) {
    db.transaction(() => failRefundInTransaction(order.id, refund.id, "Alipay refund was not found"))();
  } else {
    // REFUND_CLOSED or pending: keep reconciling on the next sync.
    db.prepare(
      `UPDATE payment_refunds SET status = 'processing', response = ?, error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'processing')`,
    ).run(JSON.stringify(result.raw), nowIso(), refund.id);
  }
  return getPaymentOrder(order.id, userId);
}

async function syncWechatPayRefund(order: PaymentOrder, userId?: string) {
  const refund = activePaymentRefund(order.id);
  if (!refund) return getPaymentOrder(order.id, userId);
  const configured = requireConfiguredChannel(order.channel_id, { allowDisabled: true });
  let response: Record<string, unknown>;
  try {
    response = await queryWechatPayRefund(configured.wechatPayCredentials!, refund.refund_no);
  } catch (error) {
    if (error instanceof WechatPayRequestError && error.status === 404) {
      db.transaction(() => failRefundInTransaction(order.id, refund.id, "WeChat Pay refund was not found"))();
      return getPaymentOrder(order.id, userId);
    }
    throw error;
  }
  const status = typeof response.status === "string" ? response.status : "";
  if (status === "SUCCESS") {
    db.transaction(() => completeRefundInTransaction(order.id, refund.id, response))();
  } else if (status === "CLOSED" || status === "ABNORMAL") {
    db.transaction(() => failRefundInTransaction(order.id, refund.id, `WeChat Pay refund ${status.toLowerCase()}`))();
  } else {
    db.prepare(
      `UPDATE payment_refunds SET status = 'processing', response = ?, error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'processing')`,
    ).run(JSON.stringify(response), nowIso(), refund.id);
  }
  return getPaymentOrder(order.id, userId);
}

export async function syncPaymentOrder(idOrNo: string, userId?: string) {
  const visible = getPaymentOrder(idOrNo, userId);
  if (!visible) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(visible.id) as PaymentOrder;
  if (order.status === "refunding") {
    if (order.channel_id === WECHATPAY_CHANNEL_ID) return syncWechatPayRefund(order, userId);
    if (order.channel_id === ALIPAY_CHANNEL_ID) return syncAlipayRefund(order, userId);
  }
  if (["credited", "refunding", "refunded"].includes(order.status)) return visible;
  const configured = requireConfiguredChannel(order.channel_id, { allowDisabled: true });
  let result: { paid: boolean; tradeNo: string | null; money?: string | null; totalAmount?: string | null; closed?: boolean };
  if (order.channel_id === ALIPAY_CHANNEL_ID) {
    result = await queryAlipayOrder(configured.alipayCredentials!, order.order_no);
  } else if (order.channel_id === WECHATPAY_CHANNEL_ID) {
    result = await queryWechatPayOrder(configured.wechatPayCredentials!, order.order_no);
  } else if (configured.paymentAdapter && configured.pluginCredentials) {
    result = await configured.paymentAdapter.queryOrder(configured.pluginCredentials, order.order_no);
  } else {
    throw new PaymentError(503, "payment_channel_unsupported", "Payment channel provider is not supported");
  }
  if (result.paid) {
    ensureAmountMatches(order, "totalAmount" in result && result.totalAmount != null ? result.totalAmount : result.money);
    db.transaction(() => creditOrderInTransaction(order.id, result.tradeNo))();
  } else if ("closed" in result && result.closed && order.status === "pending") {
    db.prepare("UPDATE payment_orders SET status = 'expired', pay_url = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), order.id);
  }
  return getPaymentOrder(order.id, userId);
}

export function handleLinuxDoNotification(query: Record<string, unknown>) {
  const provider = getPaymentProvider("linuxdo_credit") || getPaymentProviderByChannelId(LINUXDO_CHANNEL_ID);
  if (!provider?.handleNotify) {
    throw new PaymentError(503, "payment_module_unavailable", "LinuxDo payment module is not active");
  }
  return provider.handleNotify(query);
}

/** Idempotent credit path used by payment modules after signature verification. */
export function creditNotifiedOrder(input: {
  channelId: string;
  orderNo: string;
  tradeNo: string;
  money: string;
  payload: unknown;
  externalId: string;
}) {
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(input.orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== input.channelId) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  ensureAmountMatches(order, input.money);
  db.transaction(() => {
    const eventId = uuid();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO payment_events (
        id, order_id, channel_id, event_type, external_id, payload, verified, processed, created_at
      ) VALUES (?, ?, ?, 'payment.notify', ?, ?, 1, 0, ?)`,
    ).run(eventId, order.id, input.channelId, input.externalId, JSON.stringify(input.payload), nowIso());
    if (insert.changes === 0) {
      const existing = db.prepare(
        `SELECT id, processed FROM payment_events
         WHERE channel_id = ? AND event_type = 'payment.notify' AND external_id = ?`,
      ).get(input.channelId, input.externalId) as { id: string; processed: number } | undefined;
      if (!existing || existing.processed === 1) return;
      creditOrderInTransaction(order.id, input.tradeNo);
      db.prepare("UPDATE payment_events SET processed = 1, error = NULL, processed_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      return;
    }
    creditOrderInTransaction(order.id, input.tradeNo);
    db.prepare("UPDATE payment_events SET processed = 1, processed_at = ? WHERE id = ?")
      .run(nowIso(), eventId);
  })();
  return getPaymentOrder(order.id);
}

export function requirePendingPaymentOrder(channelId: string, orderNo: string) {
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channelId || order.deleted_at) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  if (order.status !== "pending") {
    throw new PaymentError(409, "payment_order_not_pending", "Payment order is no longer pending");
  }
  return {
    id: order.id,
    order_no: order.order_no,
    title: order.title,
    amount_minor: order.amount_minor,
    status: order.status,
    channel_id: order.channel_id,
  };
}

export function ensurePaymentChannel(seed: PaymentChannelSeed) {
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO payment_channels (
      id, provider, name, enabled, client_id, client_secret, gateway_url,
      exchange_rate_micros, min_amount_minor, max_amount_minor,
      fee_bps, fee_fixed_minor, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.provider,
    seed.name,
    seed.gateway_url || "",
    seed.exchange_rate_micros ?? 1_000_000,
    seed.min_amount_minor ?? 100,
    seed.max_amount_minor ?? 100_000,
    seed.fee_bps ?? 0,
    seed.fee_fixed_minor ?? 0,
    seed.config_json || "{}",
    now,
    now,
  );
}

export function disablePaymentChannel(id: string) {
  db.prepare("UPDATE payment_channels SET enabled = 0, updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function enablePaymentChannel(id: string) {
  db.prepare("UPDATE payment_channels SET enabled = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function handleAlipayNotification(form: Record<string, unknown>) {
  const { channel, alipayCredentials: credentials } = requireConfiguredChannel(ALIPAY_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "Alipay credentials are incomplete");
  const notify = Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "")]),
  ) as Record<string, string>;
  const signature = notify.sign || "";
  if (!signature || !verifyAlipaySignature(notify, signature, credentials.alipayPublicKey)) {
    throw new PaymentError(400, "invalid_signature", "Invalid Alipay notification signature");
  }
  if (notify.app_id !== credentials.appId || !["TRADE_SUCCESS", "TRADE_FINISHED"].includes(notify.trade_status)) {
    throw new PaymentError(400, "invalid_notification", "Unexpected Alipay notification values");
  }
  if (credentials.sellerId && notify.seller_id !== credentials.sellerId) {
    throw new PaymentError(400, "invalid_seller", "Alipay seller does not match the configured merchant");
  }
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(notify.out_trade_no) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  ensureAmountMatches(order, notify.total_amount);
  const externalId = `${notify.notify_id || notify.trade_no}:${notify.out_trade_no}`;
  db.transaction(() => {
    const eventId = uuid();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO payment_events (
        id, order_id, channel_id, event_type, external_id, payload, verified, processed, created_at
      ) VALUES (?, ?, ?, 'payment.notify', ?, ?, 1, 0, ?)`,
    ).run(eventId, order.id, channel.id, externalId, JSON.stringify(notify), nowIso());
    if (insert.changes === 0) {
      const existing = db.prepare(
        "SELECT id, processed FROM payment_events WHERE channel_id = ? AND event_type = 'payment.notify' AND external_id = ?",
      ).get(channel.id, externalId) as { id: string; processed: number } | undefined;
      if (!existing || existing.processed === 1) return;
      creditOrderInTransaction(order.id, notify.trade_no, notify.gmt_payment || nowIso());
      db.prepare("UPDATE payment_events SET processed = 1, error = NULL, processed_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      return;
    }
    creditOrderInTransaction(order.id, notify.trade_no, notify.gmt_payment || nowIso());
    db.prepare("UPDATE payment_events SET processed = 1, processed_at = ? WHERE id = ?").run(nowIso(), eventId);
  })();
  return getPaymentOrder(order.id);
}

export function handleWechatPayNotification(
  rawBody: string | Buffer,
  headers: WechatPayNotificationHeaders,
) {
  const { channel, wechatPayCredentials: credentials } = requireConfiguredChannel(WECHATPAY_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "WeChat Pay credentials are incomplete");
  let decoded;
  try {
    decoded = decodeWechatPayNotification(rawBody, headers, credentials);
  } catch (error) {
    throw new PaymentError(400, "invalid_signature", error instanceof Error ? error.message : "Invalid WeChat Pay notification");
  }
  const eventType = typeof decoded.envelope.event_type === "string" ? decoded.envelope.event_type : "";
  const transaction = decoded.transaction;
  if (eventType === "REFUND.SUCCESS") {
    const orderNo = typeof transaction.out_trade_no === "string" ? transaction.out_trade_no : "";
    const refundNo = typeof transaction.out_refund_no === "string" ? transaction.out_refund_no : "";
    const refundId = typeof transaction.refund_id === "string" ? transaction.refund_id : refundNo;
    const amount = transaction.amount && typeof transaction.amount === "object" && !Array.isArray(transaction.amount)
      ? transaction.amount as Record<string, unknown>
      : {};
    const refundMinor = typeof amount.refund === "number" || typeof amount.refund === "string" ? Number(amount.refund) : NaN;
    if (
      transaction.mchid !== credentials.mchId
      || transaction.refund_status !== "SUCCESS"
      || !orderNo
      || !refundNo
      || !Number.isSafeInteger(refundMinor)
      || refundMinor <= 0
    ) {
      throw new PaymentError(400, "invalid_notification", "Unexpected WeChat Pay refund notification values");
    }
    const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
    const refund = order
      ? db.prepare("SELECT * FROM payment_refunds WHERE order_id = ? AND refund_no = ?").get(order.id, refundNo) as PaymentRefundRecord | undefined
      : undefined;
    if (!order || order.channel_id !== channel.id || !refund) {
      throw new PaymentError(404, "payment_refund_not_found", "Payment refund not found");
    }
    if (refund.amount_minor !== refundMinor) {
      throw new PaymentError(400, "payment_amount_mismatch", "Refund amount does not match the order");
    }
    const externalId = `${refundId}:${orderNo}`;
    db.transaction(() => {
      const eventId = uuid();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO payment_events (
          id, order_id, channel_id, event_type, external_id, payload, verified, processed, created_at
        ) VALUES (?, ?, ?, 'refund.notify', ?, ?, 1, 0, ?)`,
      ).run(eventId, order.id, channel.id, externalId, JSON.stringify(transaction), nowIso());
      if (insert.changes === 0) {
        const existing = db.prepare(
          "SELECT id, processed FROM payment_events WHERE channel_id = ? AND event_type = 'refund.notify' AND external_id = ?",
        ).get(channel.id, externalId) as { id: string; processed: number } | undefined;
        if (!existing || existing.processed === 1) return;
        completeRefundInTransaction(order.id, refund.id, transaction, typeof transaction.success_time === "string" ? transaction.success_time : nowIso());
        db.prepare("UPDATE payment_events SET processed = 1, error = NULL, processed_at = ? WHERE id = ?")
          .run(nowIso(), existing.id);
        return;
      }
      completeRefundInTransaction(order.id, refund.id, transaction, typeof transaction.success_time === "string" ? transaction.success_time : nowIso());
      db.prepare("UPDATE payment_events SET processed = 1, processed_at = ? WHERE id = ?")
        .run(nowIso(), eventId);
    })();
    return getPaymentOrder(order.id);
  }
  if (eventType !== "TRANSACTION.SUCCESS") return null;
  if (
    transaction.mchid !== credentials.mchId
    || transaction.appid !== credentials.appId
    || transaction.trade_state !== "SUCCESS"
  ) {
    throw new PaymentError(400, "invalid_notification", "Unexpected WeChat Pay transaction values");
  }
  const orderNo = typeof transaction.out_trade_no === "string" ? transaction.out_trade_no : "";
  const tradeNo = typeof transaction.transaction_id === "string" ? transaction.transaction_id : "";
  const amount = transaction.amount && typeof transaction.amount === "object" && !Array.isArray(transaction.amount)
    ? transaction.amount as Record<string, unknown>
    : {};
  const totalMinor = typeof amount.total === "number" || typeof amount.total === "string" ? Number(amount.total) : NaN;
  if (
    !orderNo
    || !tradeNo
    || !Number.isSafeInteger(totalMinor)
    || totalMinor <= 0
    || (amount.currency !== undefined && amount.currency !== "CNY")
  ) {
    throw new PaymentError(400, "invalid_notification", "Missing WeChat Pay transaction fields");
  }
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  ensureAmountMatches(order, formatAssetAmount(totalMinor));
  const externalId = `${tradeNo}:${orderNo}`;
  const paidAt = typeof transaction.success_time === "string" && transaction.success_time ? transaction.success_time : nowIso();
  db.transaction(() => {
    const eventId = uuid();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO payment_events (
        id, order_id, channel_id, event_type, external_id, payload, verified, processed, created_at
      ) VALUES (?, ?, ?, 'payment.notify', ?, ?, 1, 0, ?)`,
    ).run(eventId, order.id, channel.id, externalId, JSON.stringify(transaction), nowIso());
    if (insert.changes === 0) {
      const existing = db.prepare(
        "SELECT id, processed FROM payment_events WHERE channel_id = ? AND event_type = 'payment.notify' AND external_id = ?",
      ).get(channel.id, externalId) as { id: string; processed: number } | undefined;
      if (!existing || existing.processed === 1) return;
      creditOrderInTransaction(order.id, tradeNo, paidAt);
      db.prepare("UPDATE payment_events SET processed = 1, error = NULL, processed_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      return;
    }
    creditOrderInTransaction(order.id, tradeNo, paidAt);
    db.prepare("UPDATE payment_events SET processed = 1, processed_at = ? WHERE id = ?")
      .run(nowIso(), eventId);
  })();
  return getPaymentOrder(order.id);
}

export async function refundPaymentOrder(idOrNo: string, reason: string) {
  const visible = getPaymentOrder(idOrNo);
  if (!visible) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(visible.id) as PaymentOrder;
  if (order.status === "refunded") return getPaymentOrder(order.id);
  if (order.status === "refunding") return getPaymentOrder(order.id);
  if (order.status !== "credited" || !order.channel_trade_no) {
    throw new PaymentError(409, "payment_not_refundable", "Only credited orders can be refunded");
  }
  const configured = requireConfiguredChannel(order.channel_id, { allowDisabled: true });
  const refundId = uuid();
  const refundNo = newOrderNo("RF");
  const now = nowIso();
  db.transaction(() => {
    const wallet = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(order.user_id) as { balance_micros: number; reserved_micros: number } | undefined;
    if (!wallet || wallet.balance_micros - wallet.reserved_micros < order.credited_micros) {
      throw new PaymentError(409, "insufficient_refundable_balance", "The credited balance has already been used and cannot be refunded");
    }
    db.prepare("UPDATE wallet_accounts SET reserved_micros = reserved_micros + ?, updated_at = ? WHERE user_id = ?")
      .run(order.credited_micros, now, order.user_id);
    db.prepare("UPDATE payment_orders SET status = 'refunding', updated_at = ? WHERE id = ?")
      .run(now, order.id);
    db.prepare(
      `INSERT INTO payment_refunds (
        id, refund_no, order_id, channel_id, amount_minor, debit_micros,
        status, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(refundId, refundNo, order.id, order.channel_id, order.amount_minor, order.credited_micros, reason, now, now);
  })();

  try {
    let response: Record<string, unknown>;
    if (order.channel_id === ALIPAY_CHANNEL_ID) {
      response = await refundAlipayOrder(configured.alipayCredentials!, {
        tradeNo: order.channel_trade_no,
        orderNo: order.order_no,
        refundNo,
        amount: formatAssetAmount(order.amount_minor),
        reason,
      }) as Record<string, unknown>;
    } else if (order.channel_id === WECHATPAY_CHANNEL_ID) {
      response = await refundWechatPayOrder(configured.wechatPayCredentials!, {
        tradeNo: order.channel_trade_no || undefined,
        orderNo: order.order_no,
        refundNo,
        amountMinor: order.amount_minor,
        reason,
        notifyUrl: `${configuredPublicBaseUrl()}/payment/wechatpay/notify`,
      }) as Record<string, unknown>;
    } else if (configured.paymentAdapter && configured.pluginCredentials) {
      response = await configured.paymentAdapter.refund(configured.pluginCredentials, {
        tradeNo: order.channel_trade_no,
        orderNo: order.order_no,
        money: formatAssetAmount(order.amount_minor),
      }) as Record<string, unknown>;
    } else {
      throw new PaymentError(503, "payment_channel_unsupported", "Payment channel provider is not supported");
    }
    const status = order.channel_id === WECHATPAY_CHANNEL_ID && "status" in response
      ? String(response.status || "")
      : "SUCCESS";
    if (status === "PROCESSING") {
      db.prepare(
        `UPDATE payment_refunds SET status = 'processing', response = ?, error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'processing')`,
      ).run(JSON.stringify(response), nowIso(), refundId);
      return getPaymentOrder(order.id);
    }
    db.transaction(() => completeRefundInTransaction(order.id, refundId, response))();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund failed";
    const latest = getPaymentOrder(order.id);
    if (latest?.status === "refunded") return latest;
    // A failed call does NOT mean the refund was not accepted: the request may
    // have reached the gateway with the response lost (timeout, signature
    // failure). Marking it failed here would let the wallet be re-refunded
    // later — a double refund. Leave the refund pending; syncPaymentOrder
    // reconciles with the gateway and only then completes or fails it.
    db.prepare(
      `UPDATE payment_refunds SET status = 'processing', error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'processing')`,
    ).run(message, nowIso(), refundId);
    throw new PaymentError(502, "refund_pending", `${message} (refund pending reconciliation)`);
  }
  return getPaymentOrder(order.id);
}

export function listPaymentRefunds(limit = 200) {
  return db.prepare(
    `SELECT payment_refunds.*, payment_orders.order_no, users.username
     FROM payment_refunds
     JOIN payment_orders ON payment_orders.id = payment_refunds.order_id
     JOIN users ON users.id = payment_orders.user_id
     ORDER BY payment_refunds.created_at DESC LIMIT ?`,
  ).all(Math.min(Math.max(1, limit), 1000));
}

function mutablePaymentOrder(idOrNo: string, userId?: string) {
  return db.prepare(
    `SELECT * FROM payment_orders
     WHERE (id = ? OR order_no = ?) AND deleted_at IS NULL AND (? IS NULL OR user_id = ?)`,
  ).get(idOrNo, idOrNo, userId ?? null, userId ?? null) as PaymentOrder | undefined;
}

export function cancelPaymentOrder(idOrNo: string, userId?: string) {
  const order = mutablePaymentOrder(idOrNo, userId);
  if (!order) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  if (order.status === "cancelled") return getPaymentOrder(order.id, userId);
  if (order.status !== "pending") {
    throw new PaymentError(409, "payment_order_not_cancellable", "Only pending orders can be cancelled");
  }
  db.prepare(
    `UPDATE payment_orders SET status = 'cancelled', pay_url = NULL,
      error = NULL, updated_at = ? WHERE id = ?`,
  ).run(nowIso(), order.id);
  return getPaymentOrder(order.id, userId);
}

export function deletePaymentOrder(idOrNo: string, userId?: string) {
  const order = mutablePaymentOrder(idOrNo, userId);
  if (!order) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  if (["paid", "credited", "refunding", "refunded"].includes(order.status)) {
    throw new PaymentError(409, "successful_payment_not_deletable", "Successful payment orders cannot be deleted");
  }
  db.prepare("UPDATE payment_orders SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), order.id);
  return true;
}
