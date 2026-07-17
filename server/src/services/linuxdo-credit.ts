import crypto from "crypto";
import fetch, { type RequestInit, type Response } from "node-fetch";

export type LinuxDoCredentials = {
  clientId: string;
  clientSecret: string;
  gatewayUrl?: string;
};

export type LinuxDoNotify = {
  pid: string;
  trade_no: string;
  out_trade_no: string;
  type: string;
  name: string;
  money: string;
  trade_status: string;
  sign: string;
  sign_type?: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const relayUrl = process.env.LINUXDO_RELAY_URL?.trim().replace(/\/$/, "") || "";
const relaySecret = process.env.LINUXDO_RELAY_SECRET?.trim() || "";

async function relayRequest(path: string, body: Record<string, string>) {
  const response = await fetch(`${relayUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-relay-secret": relaySecret }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`LINUX DO relay failed (${response.status})`);
  return responseJson(response);
}

function normalizedGateway(value?: string) {
  return (value?.trim() || "https://credit.linux.do/epay").replace(/\/+$/, "");
}

export function linuxDoSignSource(
  params: Record<string, string | number | null | undefined>,
  secret: string,
) {
  const pairs = Object.entries(params)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "" && value !== null && value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`);
  return `${pairs.join("&")}${secret}`;
}

export function signLinuxDoEasyPay(
  params: Record<string, string | number | null | undefined>,
  secret: string,
) {
  return crypto.createHash("md5").update(linuxDoSignSource(params, secret), "utf8").digest("hex");
}

export function verifyLinuxDoEasyPaySignature(
  params: Record<string, string | number | null | undefined>,
  secret: string,
  signature: string,
) {
  const expected = Buffer.from(signLinuxDoEasyPay(params, secret).toLowerCase());
  const received = Buffer.from(signature.trim().toLowerCase());
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export function buildLinuxDoPaymentSubmission(
  credentials: LinuxDoCredentials,
  input: {
    orderNo: string;
    name: string;
    money: string;
    notifyUrl: string;
    returnUrl: string;
  },
) {
  const params: Record<string, string> = {
    pid: credentials.clientId,
    type: "epay",
    out_trade_no: input.orderNo,
    name: input.name,
    money: input.money,
    notify_url: input.notifyUrl,
    return_url: input.returnUrl,
  };
  params.sign = signLinuxDoEasyPay(params, credentials.clientSecret);
  params.sign_type = "MD5";
  return {
    action: `${normalizedGateway(credentials.gatewayUrl)}/pay/submit.php`,
    params,
  };
}

function withTimeout(timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function responseJson(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`LINUX DO Credit returned an invalid response (${response.status})`);
  }
}

export async function createLinuxDoPayment(
  credentials: LinuxDoCredentials,
  input: {
    orderNo: string;
    name: string;
    money: string;
    notifyUrl: string;
    returnUrl: string;
  },
  fetcher: FetchLike = fetch,
) {
  const submission = buildLinuxDoPaymentSubmission(credentials, input);
  const timeout = withTimeout();
  try {
    const response = await fetcher(submission.action, {
      method: "POST",
      body: new URLSearchParams(submission.params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      signal: timeout.signal,
    });
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      return { payUrl: new URL(location, normalizedGateway(credentials.gatewayUrl)).toString() };
    }
    const body = await response.text();
    throw new Error(
      `LINUX DO Credit rejected the order (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  } finally {
    timeout.clear();
  }
}

export async function queryLinuxDoOrder(
  credentials: LinuxDoCredentials,
  orderNo: string,
  fetcher: FetchLike = fetch,
) {
  if (relayUrl && relaySecret) {
    const body = await relayRequest("/credit/query", { order_no: orderNo });
    return { found: Number(body.code) === 1, paid: Number(body.code) === 1 && Number(body.status) === 1, tradeNo: typeof body.trade_no === "string" ? body.trade_no : null, money: typeof body.money === "string" || typeof body.money === "number" ? String(body.money) : null, raw: body };
  }
  const url = new URL(`${normalizedGateway(credentials.gatewayUrl)}/api.php`);
  url.searchParams.set("act", "order");
  url.searchParams.set("pid", credentials.clientId);
  url.searchParams.set("key", credentials.clientSecret);
  url.searchParams.set("out_trade_no", orderNo);
  const timeout = withTimeout();
  try {
    const response = await fetcher(url.toString(), { signal: timeout.signal });
    const body = await responseJson(response);
    return {
      found: Number(body.code) === 1,
      paid: Number(body.code) === 1 && Number(body.status) === 1,
      tradeNo: typeof body.trade_no === "string" ? body.trade_no : null,
      money: typeof body.money === "string" || typeof body.money === "number" ? String(body.money) : null,
      raw: body,
    };
  } finally {
    timeout.clear();
  }
}

export async function refundLinuxDoOrder(
  credentials: LinuxDoCredentials,
  input: { tradeNo: string; orderNo: string; money: string },
  fetcher: FetchLike = fetch,
) {
  if (relayUrl && relaySecret) {
    const body = await relayRequest("/credit/refund", { trade_no: input.tradeNo, order_no: input.orderNo, money: input.money });
    if (Number(body.code) !== 1) throw new Error(typeof body.msg === "string" ? body.msg : "LINUX DO Credit refund failed");
    return body;
  }
  const timeout = withTimeout();
  try {
    const response = await fetcher(`${normalizedGateway(credentials.gatewayUrl)}/api.php`, {
      method: "POST",
      body: new URLSearchParams({
        pid: credentials.clientId,
        key: credentials.clientSecret,
        trade_no: input.tradeNo,
        out_trade_no: input.orderNo,
        money: input.money,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: timeout.signal,
    });
    const body = await responseJson(response);
    if (Number(body.code) !== 1) {
      throw new Error(typeof body.msg === "string" ? body.msg : "LINUX DO Credit refund failed");
    }
    return body;
  } finally {
    timeout.clear();
  }
}
