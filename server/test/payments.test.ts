import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("LINUX DO EasyPay signature follows ASCII ordering and excludes signature fields", async () => {
  const { linuxDoSignSource, signLinuxDoEasyPay, verifyLinuxDoEasyPaySignature } = await import(
    "../src/services/linuxdo-credit"
  );
  const params = {
    pid: "client-1",
    type: "epay",
    out_trade_no: "LA123",
    name: "LocalAPI 账户充值",
    money: "10.00",
    notify_url: "https://api.example.com/payment/linuxdo/notify",
    return_url: "https://api.example.com/payments",
    sign: "ignored",
    sign_type: "MD5",
    empty: "",
  };
  assert.equal(
    linuxDoSignSource(params, "secret-1"),
    "money=10.00&name=LocalAPI 账户充值&notify_url=https://api.example.com/payment/linuxdo/notify&out_trade_no=LA123&pid=client-1&return_url=https://api.example.com/payments&type=epaysecret-1",
  );
  assert.equal(signLinuxDoEasyPay(params, "secret-1"), "e9c6ec10b67f730dddb535df9ed969fb");
  assert.equal(verifyLinuxDoEasyPaySignature(params, "secret-1", "E9C6EC10B67F730DDDB535DF9ED969FB"), true);
  assert.equal(verifyLinuxDoEasyPaySignature(params, "wrong", "e9c6ec10b67f730dddb535df9ed969fb"), false);
});

test("payment notifications credit the wallet exactly once and full refunds debit it atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-payments-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "payments-test-secret";

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const {
    handleLinuxDoNotification,
    cancelPaymentOrder,
    createTopupOrder,
    deletePaymentOrder,
    getPaymentOrder,
    getLinuxDoCheckout,
    refundPaymentOrder,
    updatePaymentChannel,
  } = await import("../src/services/payments");
  const { signLinuxDoEasyPay, verifyLinuxDoEasyPaySignature } = await import("../src/services/linuxdo-credit");

  let refundServer: http.Server | null = null;
  try {
    initDb();
    const user = createUser({ username: "payer", password: "password-123" });
    updatePaymentChannel({
      enabled: true,
      client_id: "pid-1",
      client_secret: "secret-1",
      exchange_rate_micros: 1_000_000,
    });
    setSetting("public_base_url", "https://api.example.com");
    const storedChannel = db.prepare("SELECT client_secret FROM payment_channels WHERE id = 'linuxdo-credit'").get() as {
      client_secret: string;
    };
    assert.ok(storedChannel.client_secret.startsWith("enc:v1:"));
    const browserOrder = await createTopupOrder(user.id, "10");
    assert.equal(
      browserOrder?.pay_url,
      `https://api.example.com/payment/linuxdo/checkout/${browserOrder?.order_no}`,
    );
    const checkout = getLinuxDoCheckout(browserOrder!.order_no);
    assert.equal(checkout.action, "https://credit.linux.do/epay/pay/submit.php");
    assert.equal(checkout.params.money, "10.00");
    assert.equal(checkout.params.notify_url, "https://api.example.com/payment/linuxdo/notify");
    assert.equal(checkout.params.return_url, `https://api.example.com/payments?order_no=${browserOrder!.order_no}`);
    assert.equal(verifyLinuxDoEasyPaySignature(checkout.params, "secret-1", checkout.params.sign), true);

    const cancelUser = createUser({ username: "cancel-payer", password: "password-123" });
    const cancelledOrder = await createTopupOrder(cancelUser.id, "10");
    assert.equal(cancelPaymentOrder(cancelledOrder!.id, cancelUser.id)?.status, "cancelled");
    assert.throws(() => getLinuxDoCheckout(cancelledOrder!.order_no), /no longer pending/);
    assert.equal(deletePaymentOrder(cancelledOrder!.id, cancelUser.id), true);
    assert.equal(getPaymentOrder(cancelledOrder!.id, cancelUser.id), null);

    const lateNotify: Record<string, string> = {
      pid: "pid-1",
      trade_no: "LDC-LATE-TRADE-1",
      out_trade_no: cancelledOrder!.order_no,
      type: "epay",
      name: "LocalAPI 账户充值",
      money: "10.00",
      trade_status: "TRADE_SUCCESS",
    };
    lateNotify.sign = signLinuxDoEasyPay(lateNotify, "secret-1");
    lateNotify.sign_type = "MD5";
    handleLinuxDoNotification(lateNotify);
    assert.equal(getPaymentOrder(cancelledOrder!.id, cancelUser.id)?.status, "credited");
    const cancelWallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?")
      .get(cancelUser.id) as { balance_micros: number };
    assert.equal(cancelWallet.balance_micros, 10_000_000);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO payment_orders (
        id, order_no, user_id, channel_id, purpose, status, amount_minor,
        fee_minor, asset, credited_micros, exchange_rate_micros, title,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'linuxdo-credit', 'wallet_topup', 'pending', 1000,
        0, 'LDC', 10000000, 1000000, 'Test topup', '{}', ?, ?)`,
    ).run("payment-order-1", "LA-PAYMENT-1", user.id, now, now);

    const notify: Record<string, string> = {
      pid: "pid-1",
      trade_no: "LDC-TRADE-1",
      out_trade_no: "LA-PAYMENT-1",
      type: "epay",
      name: "Test topup",
      money: "10.00",
      trade_status: "TRADE_SUCCESS",
    };
    notify.sign = signLinuxDoEasyPay(notify, "secret-1");
    notify.sign_type = "MD5";

    handleLinuxDoNotification(notify);
    handleLinuxDoNotification(notify);

    const wallet = db.prepare("SELECT balance_micros, lifetime_topup_micros FROM wallet_accounts WHERE user_id = ?").get(user.id) as {
      balance_micros: number;
      lifetime_topup_micros: number;
    };
    const order = db.prepare("SELECT status, channel_trade_no FROM payment_orders WHERE id = 'payment-order-1'").get() as {
      status: string;
      channel_trade_no: string;
    };
    const events = db.prepare("SELECT COUNT(*) AS count FROM payment_events WHERE order_id = 'payment-order-1'").get() as { count: number };
    const ledger = db.prepare("SELECT COUNT(*) AS count FROM wallet_ledger WHERE reference_id = 'payment-order-1'").get() as {
      count: number;
    };
    assert.equal(wallet.balance_micros, 10_000_000);
    assert.equal(wallet.lifetime_topup_micros, 10_000_000);
    assert.equal(order.status, "credited");
    assert.equal(order.channel_trade_no, "LDC-TRADE-1");
    assert.equal(events.count, 1);
    assert.equal(ledger.count, 1);

    let refundBody = "";
    refundServer = http.createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => { refundBody += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 1, msg: "退款成功" }));
      });
    });
    await new Promise<void>((resolve) => refundServer!.listen(0, "127.0.0.1", resolve));
    const address = refundServer.address() as AddressInfo;
    updatePaymentChannel({ gateway_url: `http://127.0.0.1:${address.port}` });

    const refunded = await refundPaymentOrder("payment-order-1", "customer request");
    const refundedWallet = db.prepare("SELECT balance_micros, reserved_micros, lifetime_topup_micros FROM wallet_accounts WHERE user_id = ?")
      .get(user.id) as { balance_micros: number; reserved_micros: number; lifetime_topup_micros: number };
    const refundLedger = db.prepare("SELECT amount_micros FROM wallet_ledger WHERE type = 'payment_refund'").get() as {
      amount_micros: number;
    };
    const sent = new URLSearchParams(refundBody);
    assert.equal(refunded?.status, "refunded");
    assert.equal(refundedWallet.balance_micros, 0);
    assert.equal(refundedWallet.reserved_micros, 0);
    assert.equal(refundedWallet.lifetime_topup_micros, 0);
    assert.equal(refundLedger.amount_micros, -10_000_000);
    assert.equal(sent.get("pid"), "pid-1");
    assert.equal(sent.get("key"), "secret-1");
    assert.equal(sent.get("trade_no"), "LDC-TRADE-1");
    assert.equal(sent.get("out_trade_no"), "LA-PAYMENT-1");
    assert.equal(sent.get("money"), "10.00");
  } finally {
    if (refundServer) await new Promise<void>((resolve) => refundServer!.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
