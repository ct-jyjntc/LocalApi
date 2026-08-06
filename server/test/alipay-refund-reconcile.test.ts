import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("alipay refund: lost response leaves the refund pending, sync reconciles it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-alipay-refund-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "alipay-refund-test-secret";

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { getPaymentOrder, refundPaymentOrder, syncPaymentOrder, updatePaymentChannel } = await import(
    "../src/services/payments"
  );

  // "Merchant" keypair: responses from the fake gateway are signed with the
  // private key; the channel config carries the matching public key, so the
  // real signature-verification path runs end to end.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipayPublicKey = publicKey
    .export({ type: "spki", format: "pem" })
    .toString()
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

  let refundCalls = 0;
  let queryMode: "success" | "not-found" = "success";
  let gateway: http.Server | null = null;

  try {
    gateway = http.createServer((req, res) => {
      req.setEncoding("utf8");
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const method = params.get("method");
        if (method === "alipay.trade.refund") {
          refundCalls += 1;
          // The request reached the gateway but the response is lost:
          // destroy the socket mid-flight.
          req.socket.destroy();
          return;
        }
        if (method === "alipay.trade.fastpay.refund.query") {
          const payload = queryMode === "success"
            ? {
                code: "10000",
                msg: "Success",
                out_trade_no: "ALI-ORDER-1",
                refund_amount: "10.00",
                refund_status: "REFUND_SUCCESS",
              }
            : { code: "40004", msg: "Business Failed", sub_code: "TRADE_NOT_EXIST" };
          const text = JSON.stringify(payload);
          const sign = crypto.sign("RSA-SHA256", Buffer.from(text, "utf8"), privateKey).toString("base64");
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(JSON.stringify({ alipay_trade_fastpay_refund_query_response: payload, sign }));
          return;
        }
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`unexpected method: ${method}`);
      });
    });
    await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as AddressInfo).port;
    const gatewayUrl = `http://127.0.0.1:${port}/gateway.do`;

    initDb();
    setSetting("public_base_url", "https://api.example.com");
    const user = createUser({ username: "alipay-refund-user", password: "password-123" });
    updatePaymentChannel({
      enabled: true,
      client_id: "app-1",
      client_secret: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      gateway_url: gatewayUrl,
      alipay_public_key: alipayPublicKey,
      web_enabled: true,
      wap_enabled: true,
    }, "alipay");
    db.prepare(
      `INSERT INTO payment_orders (
        id, order_no, user_id, channel_id, purpose, status, amount_minor,
        fee_minor, asset, credited_micros, exchange_rate_micros, title,
        metadata, channel_trade_no, created_at, updated_at
      ) VALUES (?, ?, ?, 'alipay', 'wallet_topup', 'credited', 1000,
        0, 'CNY', 10000000, 1000000, 'Test topup', '{}', 'ALI-TRADE-1', ?, ?)`,
    ).run("alipay-order-1", "ALI-ORDER-1", user.id, new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE wallet_accounts SET balance_micros = 10000000 WHERE user_id = ?").run(user.id);

    // 1. The refund call fails AFTER the request reached Alipay: the refund
    //    must stay pending (processing), NOT failed, and the reserve must not
    //    be released — otherwise a second refund could double-pay.
    await assert.rejects(
      () => refundPaymentOrder("alipay-order-1", "customer request"),
      /refund pending|refund_pending/i,
    );
    const pending = db.prepare("SELECT * FROM payment_refunds WHERE order_id = 'alipay-order-1'").get() as {
      status: string;
    };
    assert.equal(pending.status, "processing", "lost-response refund must stay pending");
    const reservedWallet = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(user.id) as { balance_micros: number; reserved_micros: number };
    assert.equal(reservedWallet.reserved_micros, 10_000_000, "reserve must be held until reconciliation");
    assert.equal(refundCalls, 1);
    const orderStillRefunding = getPaymentOrder("alipay-order-1");
    assert.equal(orderStillRefunding?.status, "refunding");

    // 2. Reconciliation: Alipay reports the refund as accepted → complete.
    const synced = await syncPaymentOrder("alipay-order-1");
    assert.equal(synced?.status, "refunded");
    const completed = db.prepare("SELECT status FROM payment_refunds WHERE order_id = 'alipay-order-1'").get() as {
      status: string;
    };
    assert.equal(completed.status, "succeeded");
    const finalWallet = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(user.id) as { balance_micros: number; reserved_micros: number };
    assert.equal(finalWallet.balance_micros, 0);
    assert.equal(finalWallet.reserved_micros, 0);

    // 3. Opposite case: the refund was NEVER accepted. A new order, query
    //    reports not found → refund fails and the reserve is released.
    db.prepare(
      `INSERT INTO payment_orders (
        id, order_no, user_id, channel_id, purpose, status, amount_minor,
        fee_minor, asset, credited_micros, exchange_rate_micros, title,
        metadata, channel_trade_no, created_at, updated_at
      ) VALUES (?, ?, ?, 'alipay', 'wallet_topup', 'credited', 500,
        0, 'CNY', 5000000, 1000000, 'Test topup 2', '{}', 'ALI-TRADE-2', ?, ?)`,
    ).run("alipay-order-2", "ALI-ORDER-2", user.id, new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE wallet_accounts SET balance_micros = 5000000 WHERE user_id = ?").run(user.id);
    queryMode = "not-found";
    await assert.rejects(
      () => refundPaymentOrder("alipay-order-2", "customer request"),
      /refund pending|refund_pending/i,
    );
    const synced2 = await syncPaymentOrder("alipay-order-2");
    assert.equal(synced2?.status, "credited", "unaccepted refund must return the order to credited");
    const failed = db.prepare("SELECT status FROM payment_refunds WHERE order_id = 'alipay-order-2'").get() as {
      status: string;
    };
    assert.equal(failed.status, "failed");
    const wallet2 = db.prepare("SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?")
      .get(user.id) as { balance_micros: number; reserved_micros: number };
    assert.equal(wallet2.reserved_micros, 0, "reserve must be released for an unaccepted refund");
    assert.equal(wallet2.balance_micros, 5_000_000);
  } finally {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    db.close();
    delete process.env.LOCALAPI_DATA_DIR;
    delete process.env.SECRETS_KEY;
  }
});
