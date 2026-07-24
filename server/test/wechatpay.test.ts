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

function encryptResource(value: Record<string, unknown>, apiV3Key: string) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(nonce, "utf8"));
  cipher.setAAD(Buffer.from("transaction", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    original_type: "transaction",
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: ciphertext.toString("base64"),
    associated_data: "transaction",
    nonce,
  };
}

function signedNotification(
  transaction: Record<string, unknown>,
  platformPrivateKey: string,
  apiV3Key: string,
  eventType = "TRANSACTION.SUCCESS",
  serialNo = "platform-serial",
) {
  const envelope = {
    id: `notification-${crypto.randomUUID()}`,
    create_time: new Date().toISOString(),
    resource_type: "encrypt-resource",
    event_type: eventType,
    summary: "支付成功",
    resource: encryptResource(transaction, apiV3Key),
  };
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = crypto.sign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"),
    platformPrivateKey,
  ).toString("base64");
  return {
    body,
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": nonce,
      "wechatpay-signature": signature,
      "wechatpay-serial": serialNo,
    },
  };
}

test("WeChat Pay API v3 checkout, notification decryption, query and refund are idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-wechatpay-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "wechatpay-test-secret";
  const merchantKeys = keyPair();
  const platformKeys = keyPair();
  const apiV3Key = "0123456789abcdef0123456789abcdef";
  const publicKeyId = "PUB_KEY_ID_test";

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const {
    createTopupOrder,
    getPaymentChannelAdmin,
    getPaymentOrder,
    getWechatCheckout,
    handleWechatPayNotification,
    refundPaymentOrder,
    syncPaymentOrder,
    updatePaymentChannel,
  } = await import("../src/services/payments");
  const { wechatPaySignSource } = await import("../src/services/wechatpay");

  let gateway: http.Server | null = null;
  let nativeRequests = 0;
  let h5Requests = 0;
  let queryRequests = 0;
  let refundQueryRequests = 0;
  let refundBody: Record<string, unknown> | null = null;
  try {
    initDb();
    const user = createUser({ username: "wechat-payer", password: "password-123" });
    setSetting("public_base_url", "https://api.example.com");

    gateway = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        if (req.url === "/v3/pay/transactions/native" && req.method === "POST") {
          nativeRequests += 1;
          const body = JSON.parse(raw) as Record<string, unknown>;
          assert.equal(body.appid, "wx-test-app");
          assert.equal(body.mchid, "1900000001");
          assert.equal((body.amount as Record<string, unknown>).total, 1000);
          const authorization = String(req.headers.authorization || "");
          assert.equal(req.headers["wechatpay-serial"], publicKeyId);
          const signature = authorization.match(/signature="([^"]+)"/)?.[1] || "";
          const timestamp = authorization.match(/timestamp="([^"]+)"/)?.[1] || "";
          const nonce = authorization.match(/nonce_str="([^"]+)"/)?.[1] || "";
          assert.equal(
            crypto.verify(
              "RSA-SHA256",
              Buffer.from(wechatPaySignSource("POST", req.url || "", timestamp, nonce, raw), "utf8"),
              merchantKeys.publicKey,
              Buffer.from(signature, "base64"),
            ),
            true,
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=test" }));
          return;
        }
        if (req.url === "/v3/pay/transactions/h5" && req.method === "POST") {
          h5Requests += 1;
          const body = JSON.parse(raw) as Record<string, unknown>;
          assert.equal((body.scene_info as Record<string, unknown>).payer_client_ip, "203.0.113.5");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ h5_url: "https://pay.wechat.example/h5" }));
          return;
        }
        if (req.url?.startsWith("/v3/pay/transactions/out-trade-no/") && req.method === "GET") {
          queryRequests += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            trade_state: "SUCCESS",
            transaction_id: "wx-query-trade",
            amount: { total: 1000, payer_total: 1000 },
          }));
          return;
        }
        if (req.url === "/v3/refund/domestic/refunds" && req.method === "POST") {
          refundBody = JSON.parse(raw) as Record<string, unknown>;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            refund_id: "wx-refund-1",
            out_refund_no: refundBody.out_refund_no,
            status: "PROCESSING",
          }));
          return;
        }
        if (req.url?.startsWith("/v3/refund/domestic/refunds/") && req.method === "GET") {
          refundQueryRequests += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            refund_id: "wx-refund-1",
            out_refund_no: req.url.split("/").at(-1),
            status: "PROCESSING",
          }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "NOT_FOUND", message: "not found" }));
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
    const address = gateway.address() as AddressInfo;

    updatePaymentChannel({
      enabled: true,
      name: "微信支付测试",
      client_id: "1900000001",
      client_secret: apiV3Key,
      gateway_url: `http://127.0.0.1:${address.port}`,
      wechat_app_id: "wx-test-app",
      wechat_serial_no: "merchant-serial",
      wechat_private_key: merchantKeys.privateKey,
      wechat_platform_certificate: platformKeys.publicKey,
      wechat_platform_serial_no: publicKeyId,
      wechat_h5_app_name: "LocalAPI",
      wechat_h5_app_url: "https://api.example.com",
    }, "wechatpay");
    assert.equal(getPaymentChannelAdmin("wechatpay")?.client_id, "1900000001");
    assert.equal(getPaymentChannelAdmin("wechatpay")?.wechat_private_key, merchantKeys.privateKey.trim());

    const nativeOrder = await createTopupOrder(user.id, "10", {
      channelId: "wechatpay",
      mode: "native",
      clientIp: "203.0.113.5",
    });
    assert.equal(nativeOrder?.asset, "CNY");
    assert.equal(nativeOrder?.pay_url, `https://api.example.com/payment/wechatpay/checkout/${nativeOrder?.order_no}`);
    const nativeCheckout = await getWechatCheckout(nativeOrder!.order_no, "203.0.113.5");
    assert.equal(nativeCheckout.mode, "native");
    assert.equal(nativeCheckout.codeUrl, "weixin://wxpay/bizpayurl?pr=test");
    await getWechatCheckout(nativeOrder!.order_no, "203.0.113.5");
    assert.equal(nativeRequests, 1);

    const notification = signedNotification({
      mchid: "1900000001",
      appid: "wx-test-app",
      out_trade_no: nativeOrder!.order_no,
      transaction_id: "wx-native-trade",
      trade_state: "SUCCESS",
      success_time: new Date().toISOString(),
      amount: { total: 1000, payer_total: 1000, currency: "CNY", payer_currency: "CNY" },
    }, platformKeys.privateKey, apiV3Key, "TRANSACTION.SUCCESS", publicKeyId);
    handleWechatPayNotification(notification.body, notification.headers);
    handleWechatPayNotification(notification.body, notification.headers);
    assert.equal(getPaymentOrder(nativeOrder!.id, user.id)?.status, "credited");
    const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(user.id) as { balance_micros: number };
    assert.equal(wallet.balance_micros, 10_000_000);

    const h5Order = await createTopupOrder(user.id, "10", {
      channelId: "wechatpay",
      mode: "h5",
      clientIp: "203.0.113.5",
    });
    const h5Checkout = await getWechatCheckout(h5Order!.order_no, "203.0.113.5");
    assert.equal(h5Checkout.mode, "h5");
    assert.equal(h5Checkout.h5Url, "https://pay.wechat.example/h5");
    assert.equal(h5Requests, 1);
    await syncPaymentOrder(h5Order!.id, user.id);
    assert.equal(queryRequests, 1);
    assert.equal(getPaymentOrder(h5Order!.id, user.id)?.status, "credited");

    const refunding = await refundPaymentOrder(nativeOrder!.id, "customer request");
    assert.equal(refunding?.status, "refunding");
    assert.equal((refundBody?.amount as Record<string, unknown>).refund, 1000);
    assert.equal(refundBody?.transaction_id, "wx-native-trade");
    assert.equal(refundBody?.notify_url, "https://api.example.com/payment/wechatpay/notify");
    await syncPaymentOrder(nativeOrder!.id, user.id);
    assert.equal(refundQueryRequests, 1);
    assert.equal(getPaymentOrder(nativeOrder!.id, user.id)?.status, "refunding");

    const refundNo = String(refundBody?.out_refund_no || "");
    const refundNotification = signedNotification({
      mchid: "1900000001",
      out_trade_no: nativeOrder!.order_no,
      transaction_id: "wx-native-trade",
      out_refund_no: refundNo,
      refund_id: "wx-refund-1",
      refund_status: "SUCCESS",
      success_time: new Date().toISOString(),
      amount: { total: 1000, refund: 1000, payer_total: 1000, payer_refund: 1000 },
    }, platformKeys.privateKey, apiV3Key, "REFUND.SUCCESS", publicKeyId);
    handleWechatPayNotification(refundNotification.body, refundNotification.headers);
    handleWechatPayNotification(refundNotification.body, refundNotification.headers);
    assert.equal(getPaymentOrder(nativeOrder!.id, user.id)?.status, "refunded");
    const refundedWallet = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(user.id) as { balance_micros: number; reserved_micros: number };
    assert.equal(refundedWallet.balance_micros, 10_000_000);
    assert.equal(refundedWallet.reserved_micros, 0);
  } finally {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
