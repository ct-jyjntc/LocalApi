import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

function keyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("Alipay page/WAP orders, notifications and refunds use RSA2 and remain idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-alipay-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "alipay-test-secret";
  const appKeys = keyPair();
  const alipayKeys = keyPair();

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { alipaySignSource } = await import("../src/services/alipay");
  const {
    createTopupOrder,
    getAlipayCheckout,
    getPaymentChannelAdmin,
    getPaymentOrder,
    handleAlipayNotification,
    refundPaymentOrder,
    updatePaymentChannel,
  } = await import("../src/services/payments");

  let gateway: http.Server | null = null;
  try {
    initDb();
    const user = createUser({ username: "alipay-payer", password: "password-123" });
    setSetting("public_base_url", "https://api.example.com");
    updatePaymentChannel({
      enabled: true,
      client_id: "2026000000000001",
      client_secret: appKeys.privateKey,
      alipay_public_key: alipayKeys.publicKey,
      seller_id: "2088000000000001",
      exchange_rate_micros: 2_000_000,
      min_amount_minor: 100,
      max_amount_minor: 100_000,
      web_enabled: true,
      wap_enabled: true,
    }, "alipay");

    const stored = db.prepare("SELECT client_secret FROM payment_channels WHERE id = 'alipay'").get() as { client_secret: string };
    assert.ok(stored.client_secret.startsWith("enc:v1:"));
    assert.equal(getPaymentChannelAdmin("alipay")?.client_secret, appKeys.privateKey.trim());

    const order = await createTopupOrder(user.id, "10", { channelId: "alipay", mode: "wap" });
    assert.equal(order?.asset, "CNY");
    assert.equal(order?.credited_micros, 20_000_000);
    assert.equal(order?.pay_url, `https://api.example.com/payment/alipay/checkout/${order?.order_no}`);

    const checkout = getAlipayCheckout(order!.order_no);
    assert.equal(checkout.action, "https://openapi.alipay.com/gateway.do");
    assert.equal(checkout.params.method, "alipay.trade.wap.pay");
    const biz = JSON.parse(checkout.params.biz_content) as Record<string, string>;
    assert.equal(biz.product_code, "QUICK_WAP_WAY");
    assert.equal(biz.total_amount, "10.00");
    assert.equal(checkout.params.notify_url, "https://api.example.com/payment/alipay/notify");
    assert.equal(crypto.verify(
      "RSA-SHA256",
      Buffer.from(alipaySignSource(checkout.params), "utf8"),
      appKeys.publicKey,
      Buffer.from(checkout.params.sign, "base64"),
    ), true);

    const notification: Record<string, string> = {
      notify_id: "notify-1",
      app_id: "2026000000000001",
      seller_id: "2088000000000001",
      trade_no: "2026071700000001",
      out_trade_no: order!.order_no,
      trade_status: "TRADE_SUCCESS",
      total_amount: "10.00",
      gmt_payment: "2026-07-17 12:00:00",
      sign_type: "RSA2",
    };
    const notifySource = alipaySignSource(Object.fromEntries(
      Object.entries(notification).filter(([key]) => key !== "sign_type"),
    ));
    notification.sign = crypto.sign("RSA-SHA256", Buffer.from(notifySource, "utf8"), alipayKeys.privateKey).toString("base64");
    handleAlipayNotification(notification);
    handleAlipayNotification(notification);

    assert.equal(getPaymentOrder(order!.id, user.id)?.status, "credited");
    const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(user.id) as { balance_micros: number };
    assert.equal(wallet.balance_micros, 20_000_000);
    const ledgerCount = db.prepare("SELECT COUNT(*) AS count FROM wallet_ledger WHERE reference_id = ?").get(order!.id) as { count: number };
    assert.equal(ledgerCount.count, 1);

    let refundRequest = new URLSearchParams();
    gateway = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        refundRequest = new URLSearchParams(raw);
        const body = {
          code: "10000",
          msg: "Success",
          trade_no: "2026071700000001",
          out_trade_no: order!.order_no,
          buyer_logon_id: "buyer@example.com",
          fund_change: "Y",
          refund_fee: "10.00",
        };
        const signedBody = JSON.stringify(body);
        const sign = crypto.sign("RSA-SHA256", Buffer.from(signedBody, "utf8"), alipayKeys.privateKey).toString("base64");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"alipay_trade_refund_response":${signedBody},"sign":${JSON.stringify(sign)}}`);
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
    const address = gateway.address() as AddressInfo;
    updatePaymentChannel({ gateway_url: `http://127.0.0.1:${address.port}` }, "alipay");

    const refunded = await refundPaymentOrder(order!.id, "customer request");
    assert.equal(refunded?.status, "refunded");
    const refundBiz = JSON.parse(refundRequest.get("biz_content") || "{}") as Record<string, string>;
    assert.equal(refundRequest.get("method"), "alipay.trade.refund");
    assert.equal(refundBiz.trade_no, "2026071700000001");
    assert.equal(refundBiz.refund_amount, "10.00");
    assert.match(refundBiz.out_request_no, /^RF/);
  } finally {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
