import crypto from "crypto";
import fetch, { type RequestInit, type Response } from "node-fetch";

export type WechatPayMode = "native" | "h5";

export type WechatPayCredentials = {
  mchId: string;
  apiV3Key: string;
  appId: string;
  serialNo: string;
  privateKey: string;
  verificationKey: string;
  verificationSerialNo?: string;
  gatewayUrl?: string;
  h5Type?: string;
  h5AppName?: string;
  h5AppUrl?: string;
};

export type WechatPayNotificationHeaders = Record<string, string | string[] | undefined>;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_GATEWAY = "https://api.mch.weixin.qq.com";
const NOTIFICATION_TOLERANCE_SECONDS = 5 * 60;

/** An error returned by the WeChat Pay API, retaining the HTTP status for 404 handling. */
export class WechatPayRequestError extends Error {
  status: number;
  body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = "WechatPayRequestError";
    this.status = status;
    this.body = body;
  }
}

function normalizedGateway(value?: string) {
  return (value?.trim() || DEFAULT_GATEWAY).replace(/\/+$/, "");
}

function wrapPem(value: string, type: "PRIVATE KEY" | "RSA PRIVATE KEY" | "CERTIFICATE") {
  const trimmed = value.trim().replace(/\\n/g, "\n").replace(/\r/g, "");
  if (!trimmed) return "";
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || trimmed;
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

export function normalizeWechatPrivateKey(value: string) {
  return wrapPem(value, "PRIVATE KEY");
}

export function normalizeWechatVerificationKey(value: string) {
  return wrapPem(value, "CERTIFICATE");
}

function apiV3KeyBytes(value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length !== 32) {
    throw new Error("WeChat Pay API v3 key must be exactly 32 bytes");
  }
  return bytes;
}

/** The exact canonical message signed for a WeChat Pay API v3 request. */
export function wechatPaySignSource(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
) {
  return `${method.toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

export function signWechatPayRequest(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
  privateKey: string,
) {
  return crypto
    .sign(
      "RSA-SHA256",
      Buffer.from(wechatPaySignSource(method, urlPath, timestamp, nonce, body), "utf8"),
      normalizeWechatPrivateKey(privateKey),
    )
    .toString("base64");
}

export function buildWechatPayAuthorization(
  credentials: WechatPayCredentials,
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
) {
  const signature = signWechatPayRequest(
    method,
    urlPath,
    timestamp,
    nonce,
    body,
    credentials.privateKey,
  );
  return `WECHATPAY2-SHA256-RSA2048 mchid="${credentials.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${credentials.serialNo}"`;
}

function withTimeout(timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function parseResponse(response: Response) {
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // The error below includes a short response preview for diagnostics.
    }
  }
  if (!response.ok) {
    const detail = typeof body?.message === "string"
      ? body.message
      : typeof body?.code === "string"
        ? body.code
        : text.slice(0, 300) || response.statusText || "unknown error";
    throw new WechatPayRequestError(response.status, `WeChat Pay request failed: ${detail}`, body);
  }
  if (!body) {
    if (response.status === 204) return {};
    throw new WechatPayRequestError(response.status, `WeChat Pay returned an invalid response (${response.status})`);
  }
  return body;
}

async function requestWechatPay(
  credentials: WechatPayCredentials,
  method: string,
  urlPath: string,
  body: Record<string, unknown> | undefined,
  fetcher: FetchLike,
) {
  const normalizedPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const timeout = withTimeout();
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: buildWechatPayAuthorization(
        credentials,
        method,
        normalizedPath,
        timestamp,
        nonce,
        bodyText,
      ),
    };
    if (credentials.verificationSerialNo?.trim().startsWith("PUB_KEY_ID_")) {
      headers["wechatpay-serial"] = credentials.verificationSerialNo.trim();
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetcher(`${normalizedGateway(credentials.gatewayUrl)}${normalizedPath}`, {
      method: method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body: bodyText } : {}),
      signal: timeout.signal,
    });
    return await parseResponse(response);
  } finally {
    timeout.clear();
  }
}

function safeDescription(value: string) {
  return Array.from(value.trim() || "LocalAPI 账户充值").slice(0, 127).join("");
}

export type CreateWechatPayOrderInput = {
  mode: WechatPayMode;
  orderNo: string;
  description: string;
  amountMinor: number;
  notifyUrl: string;
  payerClientIp?: string;
};

export async function createWechatPayOrder(
  credentials: WechatPayCredentials,
  input: CreateWechatPayOrderInput,
  fetcher: FetchLike = fetch,
) {
  const amount = {
    total: Math.max(1, Math.floor(input.amountMinor)),
    currency: "CNY",
  };
  const body: Record<string, unknown> = {
    appid: credentials.appId,
    mchid: credentials.mchId,
    description: safeDescription(input.description),
    out_trade_no: input.orderNo,
    notify_url: input.notifyUrl,
    amount,
  };
  const path = input.mode === "native" ? "/v3/pay/transactions/native" : "/v3/pay/transactions/h5";
  if (input.mode === "h5") {
    const h5Info: Record<string, string> = {
      type: credentials.h5Type?.trim() || "Wap",
      app_name: credentials.h5AppName?.trim() || "LocalAPI",
    };
    if (credentials.h5AppUrl?.trim()) h5Info.app_url = credentials.h5AppUrl.trim();
    body.scene_info = {
      payer_client_ip: input.payerClientIp?.trim() || "127.0.0.1",
      h5_info: h5Info,
    };
  }
  const result = await requestWechatPay(credentials, "POST", path, body, fetcher);
  if (input.mode === "native") {
    const codeUrl = typeof result.code_url === "string" ? result.code_url.trim() : "";
    if (!codeUrl) throw new Error("WeChat Pay did not return a native code_url");
    return { mode: input.mode, codeUrl, raw: result } as const;
  }
  const h5Url = typeof result.h5_url === "string" ? result.h5_url.trim() : "";
  if (!h5Url) throw new Error("WeChat Pay did not return an H5 payment URL");
  return { mode: input.mode, h5Url, raw: result } as const;
}

function amountToDecimal(value: unknown) {
  const total = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(total) && total >= 0 ? (total / 100).toFixed(2) : null;
}

export async function queryWechatPayOrder(
  credentials: WechatPayCredentials,
  orderNo: string,
  fetcher: FetchLike = fetch,
) {
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(credentials.mchId)}`;
  let result: Record<string, unknown>;
  try {
    result = await requestWechatPay(credentials, "GET", path, undefined, fetcher);
  } catch (error) {
    if (error instanceof WechatPayRequestError && error.status === 404) {
      return { found: false, paid: false, closed: false, tradeNo: null, totalAmount: null, raw: error.body };
    }
    throw error;
  }
  const state = typeof result.trade_state === "string" ? result.trade_state : "";
  const amount = result.amount && typeof result.amount === "object"
    ? result.amount as Record<string, unknown>
    : {};
  return {
    found: true,
    paid: state === "SUCCESS",
    closed: ["CLOSED", "REVOKED", "PAYERROR"].includes(state),
    tradeNo: typeof result.transaction_id === "string" ? result.transaction_id : null,
    totalAmount: amountToDecimal(amount.total),
    raw: result,
  };
}

export type RefundWechatPayOrderInput = {
  tradeNo?: string;
  orderNo: string;
  refundNo: string;
  amountMinor: number;
  reason: string;
  notifyUrl?: string;
};

export async function refundWechatPayOrder(
  credentials: WechatPayCredentials,
  input: RefundWechatPayOrderInput,
  fetcher: FetchLike = fetch,
) {
  const body: Record<string, unknown> = {
    ...(input.tradeNo ? { transaction_id: input.tradeNo } : { out_trade_no: input.orderNo }),
    out_refund_no: input.refundNo,
    reason: safeDescription(input.reason).slice(0, 80),
    ...(input.notifyUrl?.trim() ? { notify_url: input.notifyUrl.trim() } : {}),
    amount: {
      refund: Math.max(1, Math.floor(input.amountMinor)),
      total: Math.max(1, Math.floor(input.amountMinor)),
      currency: "CNY",
    },
  };
  const result = await requestWechatPay(credentials, "POST", "/v3/refund/domestic/refunds", body, fetcher);
  const status = typeof result.status === "string" ? result.status : "";
  if (status !== "SUCCESS" && status !== "PROCESSING") {
    throw new Error(`WeChat Pay refund failed with status ${status || "unknown"}`);
  }
  return result;
}

export async function queryWechatPayRefund(
  credentials: WechatPayCredentials,
  refundNo: string,
  fetcher: FetchLike = fetch,
) {
  return requestWechatPay(
    credentials,
    "GET",
    `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}`,
    undefined,
    fetcher,
  );
}

function headerValue(headers: WechatPayNotificationHeaders, name: string) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

export function verifyWechatPayNotificationSignature(
  rawBody: string | Buffer,
  headers: WechatPayNotificationHeaders,
  verificationKey: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
) {
  const timestamp = headerValue(headers, "wechatpay-timestamp");
  const nonce = headerValue(headers, "wechatpay-nonce");
  const signature = headerValue(headers, "wechatpay-signature");
  if (!timestamp || !nonce || !signature) return false;
  const timestampNumber = Number(timestamp);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? NOTIFICATION_TOLERANCE_SECONDS;
  if (!Number.isFinite(timestampNumber) || Math.abs(now - timestampNumber) > tolerance) return false;
  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody}\n`, "utf8"),
      normalizeWechatVerificationKey(verificationKey),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export type WechatPayNotification = {
  envelope: Record<string, unknown>;
  transaction: Record<string, unknown>;
  serialNo: string;
};

export function decryptWechatPayResource(
  resource: { ciphertext?: unknown; nonce?: unknown; associated_data?: unknown; algorithm?: unknown },
  apiV3Key: string,
) {
  if (resource.algorithm && resource.algorithm !== "AEAD_AES_256_GCM") {
    throw new Error("Unsupported WeChat Pay notification encryption algorithm");
  }
  const ciphertext = typeof resource.ciphertext === "string" ? resource.ciphertext : "";
  const nonce = typeof resource.nonce === "string" ? resource.nonce : "";
  const associatedData = typeof resource.associated_data === "string" ? resource.associated_data : "";
  if (!ciphertext || !nonce) throw new Error("WeChat Pay notification resource is incomplete");
  const encrypted = Buffer.from(ciphertext, "base64");
  if (encrypted.length <= 16) throw new Error("WeChat Pay notification ciphertext is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", apiV3KeyBytes(apiV3Key), Buffer.from(nonce, "utf8"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  return Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

export function decodeWechatPayNotification(
  rawBody: string | Buffer,
  headers: WechatPayNotificationHeaders,
  credentials: WechatPayCredentials,
) {
  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  if (!verifyWechatPayNotificationSignature(bodyText, headers, credentials.verificationKey)) {
    throw new Error("Invalid WeChat Pay notification signature");
  }
  const serialNo = headerValue(headers, "wechatpay-serial");
  if (credentials.verificationSerialNo?.trim() && serialNo.toLowerCase() !== credentials.verificationSerialNo.trim().toLowerCase()) {
    throw new Error("WeChat Pay verification key ID or certificate serial does not match the configured value");
  }
  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw new Error("WeChat Pay notification body is not valid JSON");
  }
  const resource = envelope.resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new Error("WeChat Pay notification resource is missing");
  }
  const plaintext = decryptWechatPayResource(resource as Record<string, unknown>, credentials.apiV3Key);
  let transaction: Record<string, unknown>;
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    transaction = parsed as Record<string, unknown>;
  } catch {
    throw new Error("WeChat Pay notification resource could not be decoded");
  }
  return { envelope, transaction, serialNo } satisfies WechatPayNotification;
}
