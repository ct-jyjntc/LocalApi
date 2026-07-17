import crypto from "crypto";
import fetch, { type RequestInit, type Response } from "node-fetch";

export type AlipayCredentials = {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  sellerId?: string;
  gatewayUrl?: string;
};

export type AlipayPayMode = "page" | "wap";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type AlipayApiResponse = Record<string, unknown> & {
  code?: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
};

const DEFAULT_GATEWAY = "https://openapi.alipay.com/gateway.do";

function normalizeGateway(value?: string) {
  const raw = value?.trim() || DEFAULT_GATEWAY;
  try {
    const url = new URL(raw);
    // Alipay requires charset to be present in the gateway query string for
    // page/WAP form submissions. Keep an explicitly configured value intact.
    if (!url.searchParams.has("charset")) url.searchParams.set("charset", "UTF-8");
    return url.toString();
  } catch {
    return raw;
  }
}

function wrapPem(value: string, type: "PRIVATE KEY" | "RSA PRIVATE KEY" | "PUBLIC KEY") {
  const trimmed = value.trim().replace(/\r/g, "");
  if (!trimmed) return "";
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || trimmed;
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

export function normalizeAlipayPrivateKey(value: string) {
  return wrapPem(value, "PRIVATE KEY");
}

export function normalizeAlipayPublicKey(value: string) {
  return wrapPem(value, "PUBLIC KEY");
}

export function alipaySignSource(params: Record<string, unknown>) {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && value !== "" && value !== null && value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}

export function signAlipayParams(params: Record<string, unknown>, privateKey: string) {
  const source = Buffer.from(alipaySignSource(params), "utf8");
  const trimmed = privateKey.trim();
  const candidates = trimmed.includes("-----BEGIN")
    ? [trimmed]
    : [wrapPem(trimmed, "PRIVATE KEY"), wrapPem(trimmed, "RSA PRIVATE KEY")];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return crypto.sign("RSA-SHA256", source, candidate).toString("base64");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Invalid Alipay private key");
}

export function verifyAlipaySignature(
  params: Record<string, unknown>,
  signature: string,
  alipayPublicKey: string,
) {
  const notificationParams = Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== "sign" && key !== "sign_type"),
  );
  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(alipaySignSource(notificationParams), "utf8"),
    normalizeAlipayPublicKey(alipayPublicKey),
    Buffer.from(signature, "base64"),
  );
}

function alipayTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function signedParams(
  credentials: AlipayCredentials,
  method: string,
  bizContent: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  const params: Record<string, string> = {
    app_id: credentials.appId,
    method,
    format: "JSON",
    charset: "UTF-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(bizContent),
    ...extra,
  };
  params.sign = signAlipayParams(params, credentials.privateKey);
  return params;
}

export function buildAlipayPaymentSubmission(
  credentials: AlipayCredentials,
  input: {
    mode: AlipayPayMode;
    orderNo: string;
    subject: string;
    totalAmount: string;
    notifyUrl: string;
    returnUrl: string;
    quitUrl?: string;
  },
) {
  const bizContent: Record<string, unknown> = {
    out_trade_no: input.orderNo,
    total_amount: input.totalAmount,
    subject: input.subject,
    product_code: input.mode === "wap" ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY",
    timeout_express: "30m",
  };
  if (input.mode === "wap") bizContent.quit_url = input.quitUrl || input.returnUrl;
  return {
    action: normalizeGateway(credentials.gatewayUrl),
    params: signedParams(
      credentials,
      input.mode === "wap" ? "alipay.trade.wap.pay" : "alipay.trade.page.pay",
      bizContent,
      { notify_url: input.notifyUrl, return_url: input.returnUrl },
    ),
  };
}

function withTimeout(timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function responseKey(method: string) {
  return `${method.replaceAll(".", "_")}_response`;
}

function extractJsonValueSource(text: string, key: string) {
  const marker = `"${key}"`;
  const keyAt = text.indexOf(marker);
  if (keyAt < 0) return null;
  const colonAt = text.indexOf(":", keyAt + marker.length);
  if (colonAt < 0) return null;
  let start = colonAt + 1;
  while (/\s/.test(text[start] || "")) start += 1;
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function apiError(body: AlipayApiResponse) {
  const detail = body.sub_msg || body.sub_code || body.msg || body.code || "unknown error";
  return new Error(`Alipay request failed: ${detail}`);
}

async function callAlipayApi(
  credentials: AlipayCredentials,
  method: string,
  bizContent: Record<string, unknown>,
  fetcher: FetchLike = fetch,
) {
  const params = signedParams(credentials, method, bizContent);
  const timeout = withTimeout();
  try {
    const response = await fetcher(normalizeGateway(credentials.gatewayUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams(params).toString(),
      signal: timeout.signal,
    });
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Alipay returned an invalid response (${response.status})`);
    }
    const key = responseKey(method);
    const body = parsed[key] as AlipayApiResponse | undefined;
    if (!body || typeof body !== "object") throw new Error("Alipay response payload is missing");
    const signature = typeof parsed.sign === "string" ? parsed.sign : "";
    const signedBody = extractJsonValueSource(text, key);
    if (!signature || !signedBody || !crypto.verify(
      "RSA-SHA256",
      Buffer.from(signedBody, "utf8"),
      normalizeAlipayPublicKey(credentials.alipayPublicKey),
      Buffer.from(signature, "base64"),
    )) {
      throw new Error("Alipay response signature verification failed");
    }
    return body;
  } finally {
    timeout.clear();
  }
}

export async function queryAlipayOrder(
  credentials: AlipayCredentials,
  orderNo: string,
  fetcher: FetchLike = fetch,
) {
  const body = await callAlipayApi(credentials, "alipay.trade.query", { out_trade_no: orderNo }, fetcher);
  if (body.code !== "10000") {
    if (body.sub_code === "ACQ.TRADE_NOT_EXIST") {
      return { found: false, paid: false, closed: false, tradeNo: null, totalAmount: null, raw: body };
    }
    throw apiError(body);
  }
  const status = typeof body.trade_status === "string" ? body.trade_status : "";
  return {
    found: true,
    paid: status === "TRADE_SUCCESS" || status === "TRADE_FINISHED",
    closed: status === "TRADE_CLOSED",
    tradeNo: typeof body.trade_no === "string" ? body.trade_no : null,
    totalAmount: typeof body.total_amount === "string" ? body.total_amount : null,
    raw: body,
  };
}

export async function refundAlipayOrder(
  credentials: AlipayCredentials,
  input: { tradeNo?: string; orderNo: string; refundNo: string; amount: string; reason: string },
  fetcher: FetchLike = fetch,
) {
  const body = await callAlipayApi(credentials, "alipay.trade.refund", {
    ...(input.tradeNo ? { trade_no: input.tradeNo } : { out_trade_no: input.orderNo }),
    refund_amount: input.amount,
    refund_reason: input.reason,
    out_request_no: input.refundNo,
  }, fetcher);
  if (body.code !== "10000") throw apiError(body);
  if (body.fund_change !== "Y") {
    const query = await callAlipayApi(credentials, "alipay.trade.fastpay.refund.query", {
      ...(input.tradeNo ? { trade_no: input.tradeNo } : { out_trade_no: input.orderNo }),
      out_request_no: input.refundNo,
    }, fetcher);
    if (query.code !== "10000" || query.refund_status !== "REFUND_SUCCESS") {
      throw new Error("Alipay refund result is pending or could not be confirmed");
    }
    return query;
  }
  return body;
}
