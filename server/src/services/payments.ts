import { v4 as uuid } from "uuid";
import {
  db,
  getSetting,
  type PaymentChannel,
  type PaymentOrder,
} from "../db";
import { decryptSecret, encryptSecret } from "../utils/secrets";
import { nowIso } from "../utils/time";
import {
  buildLinuxDoPaymentSubmission,
  queryLinuxDoOrder,
  refundLinuxDoOrder,
  verifyLinuxDoEasyPaySignature,
  type LinuxDoNotify,
} from "./linuxdo-credit";
import {
  buildAlipayPaymentSubmission,
  queryAlipayOrder,
  refundAlipayOrder,
  verifyAlipaySignature,
  type AlipayCredentials,
  type AlipayPayMode,
} from "./alipay";

const LINUXDO_CHANNEL_ID = "linuxdo-credit";
const ALIPAY_CHANNEL_ID = "alipay";
const CENTS_PER_ASSET = 100n;

type AlipayChannelConfig = {
  alipay_public_key?: string;
  seller_id?: string;
  web_enabled?: boolean;
  wap_enabled?: boolean;
};

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
    return value && typeof value === "object" && !Array.isArray(value) ? value as AlipayChannelConfig : {};
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

function requireConfiguredChannel(id: string, options: { allowDisabled?: boolean } = {}) {
  const channel = getPaymentChannel(id);
  if (!channel || (!options.allowDisabled && channel.enabled !== 1)) {
    throw new PaymentError(503, "payment_channel_unavailable", "Payment channel is not enabled");
  }
  if (channel.provider === "linuxdo_credit") {
    const credentials = channelCredentials(channel);
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new PaymentError(503, "payment_channel_incomplete", "LINUX DO Credit credentials are incomplete");
    }
    return { channel, linuxDoCredentials: credentials };
  }
  if (channel.provider === "alipay") {
    const credentials = alipayCredentials(channel);
    if (!credentials.appId || !credentials.privateKey || !credentials.alipayPublicKey) {
      throw new PaymentError(503, "payment_channel_incomplete", "Alipay credentials are incomplete");
    }
    return { channel, alipayCredentials: credentials };
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
  const publicBaseUrl = normalizedBaseUrl(getSetting("public_base_url") || "");
  const config = parseChannelConfig(channel);
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
    notify_url: publicBaseUrl ? `${publicBaseUrl}/payment/${channel.provider === "alipay" ? "alipay" : "linuxdo"}/notify` : "",
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
  const configured = Boolean(
    channel.client_id.trim()
    && channel.client_secret
    && normalizedBaseUrl(getSetting("public_base_url") || "")
    && (channel.provider !== "alipay" || config.alipay_public_key?.trim()),
  );
  return {
    id: channel.id,
    provider: channel.provider,
    name: channel.name,
    enabled: channel.enabled === 1 && configured,
    asset: channel.provider === "alipay" ? "CNY" : "LDC",
    payment_modes: channel.provider === "alipay"
      ? [config.web_enabled !== false ? "page" : null, config.wap_enabled !== false ? "wap" : null].filter(Boolean)
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
}, id = LINUXDO_CHANNEL_ID) {
  const current = getPaymentChannel(id);
  if (!current) throw new PaymentError(404, "payment_channel_not_found", "Payment channel not found");
  const currentConfig = parseChannelConfig(current);
  const config: AlipayChannelConfig = current.provider === "alipay" ? {
    alipay_public_key: input.alipay_public_key === undefined ? currentConfig.alipay_public_key || "" : input.alipay_public_key.trim(),
    seller_id: input.seller_id === undefined ? currentConfig.seller_id || "" : input.seller_id.trim(),
    web_enabled: input.web_enabled ?? currentConfig.web_enabled ?? true,
    wap_enabled: input.wap_enabled ?? currentConfig.wap_enabled ?? true,
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
  if (next.enabled && (!next.client_id || !next.client_secret || (current.provider === "alipay" && !config.alipay_public_key))) {
    throw new PaymentError(400, "payment_channel_incomplete", "Complete all required credentials before enabling the channel");
  }
  if (current.provider === "alipay" && next.enabled && !config.web_enabled && !config.wap_enabled) {
    throw new PaymentError(400, "payment_mode_required", "Enable at least one Alipay payment mode");
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
  options: { channelId?: string; mode?: AlipayPayMode } = {},
) {
  const fallback = getPaymentChannelsPublic()[0];
  const channelId = options.channelId || fallback?.id || LINUXDO_CHANNEL_ID;
  const { channel } = requireConfiguredChannel(channelId);
  const publicBaseUrl = normalizedBaseUrl(getSetting("public_base_url") || "");
  if (!publicBaseUrl) {
    throw new PaymentError(503, "public_base_url_required", "Set a public domain before accepting payments");
  }
  const amountMinor = parseAssetAmount(amount);
  if (amountMinor < channel.min_amount_minor || amountMinor > channel.max_amount_minor) {
    throw new PaymentError(
      400,
      "amount_out_of_range",
      `Amount must be between ${formatAssetAmount(channel.min_amount_minor)} and ${formatAssetAmount(channel.max_amount_minor)} ${channel.provider === "alipay" ? "CNY" : "LDC"}`,
    );
  }
  const config = parseChannelConfig(channel);
  const mode: AlipayPayMode = options.mode || "page";
  if (channel.provider === "alipay") {
    if (mode === "page" && config.web_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "Alipay PC web payment is disabled");
    if (mode === "wap" && config.wap_enabled === false) throw new PaymentError(400, "payment_mode_disabled", "Alipay mobile web payment is disabled");
  }
  const feeMinor = calculateFeeMinor(channel, amountMinor);
  const creditedMicros = calculateCreditedMicros(amountMinor, feeMinor, channel.exchange_rate_micros);
  if (creditedMicros <= 0) {
    throw new PaymentError(400, "amount_too_small", "The credited amount must be greater than zero");
  }
  const now = nowIso();
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
    asset: channel.provider === "alipay" ? "CNY" : "LDC",
    credited_micros: creditedMicros,
    exchange_rate_micros: channel.exchange_rate_micros,
    title: `${getSetting("brand_name") || "LocalAPI"} 账户充值`,
    pay_url: null,
    error: null,
    metadata: JSON.stringify(channel.provider === "alipay" ? { pay_mode: mode } : {}),
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

  const payUrl = `${publicBaseUrl}/payment/${channel.provider === "alipay" ? "alipay" : "linuxdo"}/checkout/${encodeURIComponent(order.order_no)}`;
  db.prepare("UPDATE payment_orders SET pay_url = ?, error = NULL, updated_at = ? WHERE id = ?")
    .run(payUrl, nowIso(), order.id);
  return getPaymentOrder(order.id, userId);
}

export function getLinuxDoCheckout(orderNo: string) {
  const { channel, linuxDoCredentials: credentials } = requireConfiguredChannel(LINUXDO_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "LINUX DO Credit credentials are incomplete");
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(orderNo) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id || order.deleted_at) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  if (order.status !== "pending") {
    throw new PaymentError(409, "payment_order_not_pending", "Payment order is no longer pending");
  }
  const publicBaseUrl = normalizedBaseUrl(getSetting("public_base_url") || "");
  if (!publicBaseUrl) {
    throw new PaymentError(503, "public_base_url_required", "Set a public domain before accepting payments");
  }
  return buildLinuxDoPaymentSubmission(credentials, {
    orderNo: order.order_no,
    name: order.title,
    money: formatAssetAmount(order.amount_minor),
    notifyUrl: `${publicBaseUrl}/payment/linuxdo/notify`,
    returnUrl: `${publicBaseUrl}/payments?order_no=${encodeURIComponent(order.order_no)}`,
  });
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
  const publicBaseUrl = normalizedBaseUrl(getSetting("public_base_url") || "");
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

export function listPaymentOrders(input: { userId?: string; status?: string; limit?: number } = {}) {
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
  const limit = Math.min(Math.max(1, input.limit ?? 200), 1000);
  params.push(limit);
  const rows = db.prepare(
    `SELECT payment_orders.*, users.username, users.display_name, payment_channels.name AS channel_name
     FROM payment_orders
     JOIN users ON users.id = payment_orders.user_id
     JOIN payment_channels ON payment_channels.id = payment_orders.channel_id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY payment_orders.created_at DESC LIMIT ?`,
  ).all(...params) as Array<PaymentOrder & Record<string, unknown>>;
  return rows.map(publicOrder);
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

export async function syncPaymentOrder(idOrNo: string, userId?: string) {
  const visible = getPaymentOrder(idOrNo, userId);
  if (!visible) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(visible.id) as PaymentOrder;
  if (["credited", "refunding", "refunded"].includes(order.status)) return visible;
  const configured = requireConfiguredChannel(order.channel_id, { allowDisabled: true });
  const result = order.channel_id === ALIPAY_CHANNEL_ID
    ? await queryAlipayOrder(configured.alipayCredentials!, order.order_no)
    : await queryLinuxDoOrder(configured.linuxDoCredentials!, order.order_no);
  if (result.paid) {
    ensureAmountMatches(order, "totalAmount" in result ? result.totalAmount : result.money);
    db.transaction(() => creditOrderInTransaction(order.id, result.tradeNo))();
  } else if ("closed" in result && result.closed && order.status === "pending") {
    db.prepare("UPDATE payment_orders SET status = 'expired', pay_url = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), order.id);
  }
  return getPaymentOrder(order.id, userId);
}

export function handleLinuxDoNotification(query: Record<string, unknown>) {
  const { channel, linuxDoCredentials: credentials } = requireConfiguredChannel(LINUXDO_CHANNEL_ID, { allowDisabled: true });
  if (!credentials) throw new PaymentError(503, "payment_channel_incomplete", "LINUX DO Credit credentials are incomplete");
  const notify = Object.fromEntries(
    Object.entries(query).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "")]),
  ) as LinuxDoNotify;
  const required = ["pid", "trade_no", "out_trade_no", "type", "name", "money", "trade_status", "sign"] as const;
  if (required.some((key) => !notify[key])) {
    throw new PaymentError(400, "invalid_notification", "Missing notification fields");
  }
  if (notify.pid !== credentials.clientId || notify.type !== "epay" || notify.trade_status !== "TRADE_SUCCESS") {
    throw new PaymentError(400, "invalid_notification", "Unexpected notification values");
  }
  if (!verifyLinuxDoEasyPaySignature(notify, credentials.clientSecret, notify.sign)) {
    throw new PaymentError(400, "invalid_signature", "Invalid payment notification signature");
  }
  const order = db.prepare("SELECT * FROM payment_orders WHERE order_no = ?").get(notify.out_trade_no) as PaymentOrder | undefined;
  if (!order || order.channel_id !== channel.id) {
    throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  }
  ensureAmountMatches(order, notify.money);
  const externalId = `${notify.trade_no}:${notify.out_trade_no}`;
  db.transaction(() => {
    const eventId = uuid();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO payment_events (
        id, order_id, channel_id, event_type, external_id, payload, verified, processed, created_at
      ) VALUES (?, ?, ?, 'payment.notify', ?, ?, 1, 0, ?)`,
    ).run(eventId, order.id, channel.id, externalId, JSON.stringify(notify), nowIso());
    if (insert.changes === 0) {
      const existing = db.prepare(
        `SELECT id, processed FROM payment_events
         WHERE channel_id = ? AND event_type = 'payment.notify' AND external_id = ?`,
      ).get(channel.id, externalId) as { id: string; processed: number } | undefined;
      if (!existing || existing.processed === 1) return;
      creditOrderInTransaction(order.id, notify.trade_no);
      db.prepare("UPDATE payment_events SET processed = 1, error = NULL, processed_at = ? WHERE id = ?")
        .run(nowIso(), existing.id);
      return;
    }
    creditOrderInTransaction(order.id, notify.trade_no);
    db.prepare("UPDATE payment_events SET processed = 1, processed_at = ? WHERE id = ?")
      .run(nowIso(), eventId);
  })();
  return getPaymentOrder(order.id);
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

export async function refundPaymentOrder(idOrNo: string, reason: string) {
  const visible = getPaymentOrder(idOrNo);
  if (!visible) throw new PaymentError(404, "payment_order_not_found", "Payment order not found");
  const order = db.prepare("SELECT * FROM payment_orders WHERE id = ?").get(visible.id) as PaymentOrder;
  if (order.status === "refunded") return getPaymentOrder(order.id);
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
    const response = order.channel_id === ALIPAY_CHANNEL_ID
      ? await refundAlipayOrder(configured.alipayCredentials!, {
        tradeNo: order.channel_trade_no,
        orderNo: order.order_no,
        refundNo,
        amount: formatAssetAmount(order.amount_minor),
        reason,
      })
      : await refundLinuxDoOrder(configured.linuxDoCredentials!, {
        tradeNo: order.channel_trade_no,
        orderNo: order.order_no,
        money: formatAssetAmount(order.amount_minor),
      });
    db.transaction(() => {
      const completed = nowIso();
      db.prepare(
        `UPDATE wallet_accounts SET balance_micros = balance_micros - ?,
          reserved_micros = MAX(0, reserved_micros - ?),
          lifetime_topup_micros = MAX(0, lifetime_topup_micros - ?),
          updated_at = ? WHERE user_id = ?`,
      ).run(order.credited_micros, order.credited_micros, order.credited_micros, completed, order.user_id);
      const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(order.user_id) as {
        balance_micros: number;
      };
      db.prepare(
        `INSERT INTO wallet_ledger (
          id, user_id, type, amount_micros, balance_after_micros, reference_type, reference_id, description, created_at
        ) VALUES (?, ?, 'payment_refund', ?, ?, 'payment_refund', ?, ?, ?)`,
      ).run(uuid(), order.user_id, -order.credited_micros, wallet.balance_micros, refundId, `充值退款 ${order.order_no}`, completed);
      db.prepare(
        `UPDATE payment_refunds SET status = 'succeeded', response = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(JSON.stringify(response), completed, completed, refundId);
      db.prepare("UPDATE payment_orders SET status = 'refunded', refunded_at = ?, updated_at = ? WHERE id = ?")
        .run(completed, completed, order.id);
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refund failed";
    db.transaction(() => {
      const failedAt = nowIso();
      db.prepare("UPDATE wallet_accounts SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE user_id = ?")
        .run(order.credited_micros, failedAt, order.user_id);
      db.prepare("UPDATE payment_orders SET status = 'credited', error = ?, updated_at = ? WHERE id = ?")
        .run(message, failedAt, order.id);
      db.prepare("UPDATE payment_refunds SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run(message, failedAt, refundId);
    })();
    throw new PaymentError(502, "refund_failed", message);
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
