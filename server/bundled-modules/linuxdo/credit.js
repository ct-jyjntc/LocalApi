"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.linuxDoSignSource = linuxDoSignSource;
exports.signLinuxDoEasyPay = signLinuxDoEasyPay;
exports.verifyLinuxDoEasyPaySignature = verifyLinuxDoEasyPaySignature;
exports.buildLinuxDoPaymentSubmission = buildLinuxDoPaymentSubmission;
exports.queryLinuxDoOrder = queryLinuxDoOrder;
exports.refundLinuxDoOrder = refundLinuxDoOrder;
const crypto_1 = __importDefault(require("crypto"));
function normalizedGateway(value) {
    return (value?.trim() || "https://credit.linux.do/epay").replace(/\/+$/, "");
}
function relayConfig() {
    return {
        relayUrl: process.env.LINUXDO_RELAY_URL?.trim().replace(/\/$/, "") || "",
        relaySecret: process.env.LINUXDO_RELAY_SECRET?.trim() || "",
    };
}
async function relayRequest(path, body) {
    const { relayUrl, relaySecret } = relayConfig();
    const response = await fetch(`${relayUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-relay-secret": relaySecret,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        throw new Error(`LINUX DO relay failed (${response.status})`);
    return responseJson(response);
}
function linuxDoSignSource(params, secret) {
    const pairs = Object.entries(params)
        .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "" && value !== null && value !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${String(value)}`);
    return `${pairs.join("&")}${secret}`;
}
function signLinuxDoEasyPay(params, secret) {
    return crypto_1.default.createHash("md5").update(linuxDoSignSource(params, secret), "utf8").digest("hex");
}
function verifyLinuxDoEasyPaySignature(params, secret, signature) {
    const expected = Buffer.from(signLinuxDoEasyPay(params, secret).toLowerCase());
    const received = Buffer.from(signature.trim().toLowerCase());
    return expected.length === received.length && crypto_1.default.timingSafeEqual(expected, received);
}
function buildLinuxDoPaymentSubmission(credentials, input) {
    const params = {
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
async function responseJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`LINUX DO Credit returned an invalid response (${response.status})`);
    }
}
async function queryLinuxDoOrder(credentials, orderNo) {
    const { relayUrl, relaySecret } = relayConfig();
    if (relayUrl && relaySecret) {
        const body = await relayRequest("/credit/query", { order_no: orderNo });
        return {
            found: Number(body.code) === 1,
            paid: Number(body.code) === 1 && Number(body.status) === 1,
            tradeNo: typeof body.trade_no === "string" ? body.trade_no : null,
            money: typeof body.money === "string" || typeof body.money === "number" ? String(body.money) : null,
            raw: body,
        };
    }
    const url = new URL(`${normalizedGateway(credentials.gatewayUrl)}/api.php`);
    url.searchParams.set("act", "order");
    url.searchParams.set("pid", credentials.clientId);
    url.searchParams.set("key", credentials.clientSecret);
    url.searchParams.set("out_trade_no", orderNo);
    const timeout = withTimeout();
    try {
        const response = await fetch(url.toString(), { signal: timeout.signal });
        const body = await responseJson(response);
        return {
            found: Number(body.code) === 1,
            paid: Number(body.code) === 1 && Number(body.status) === 1,
            tradeNo: typeof body.trade_no === "string" ? body.trade_no : null,
            money: typeof body.money === "string" || typeof body.money === "number" ? String(body.money) : null,
            raw: body,
        };
    }
    finally {
        timeout.clear();
    }
}
async function refundLinuxDoOrder(credentials, input) {
    const { relayUrl, relaySecret } = relayConfig();
    if (relayUrl && relaySecret) {
        const body = await relayRequest("/credit/refund", {
            trade_no: input.tradeNo,
            order_no: input.orderNo,
            money: input.money,
        });
        if (Number(body.code) !== 1) {
            throw new Error(typeof body.msg === "string" ? body.msg : "LINUX DO Credit refund failed");
        }
        return body;
    }
    const timeout = withTimeout();
    try {
        const response = await fetch(`${normalizedGateway(credentials.gatewayUrl)}/api.php`, {
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
    }
    finally {
        timeout.clear();
    }
}
