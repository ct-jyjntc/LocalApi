import { Router } from "express";
import { PaymentError, getLinuxDoCheckout, handleLinuxDoNotification } from "../services/payments";

export const paymentsRouter = Router();

paymentsRouter.get("/payment/linuxdo/notify", (req, res) => {
  try {
    handleLinuxDoNotification(req.query);
    res.type("text/plain").status(200).send("success");
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Payment notification failed";
    res.type("text/plain").status(status).send(message);
  }
});

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

paymentsRouter.get("/payment/linuxdo/checkout/:orderNo", (req, res) => {
  try {
    const submission = getLinuxDoCheckout(req.params.orderNo);
    const fields = Object.entries(submission.params)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    res
      .status(200)
      .set({
        "cache-control": "no-store, max-age=0",
        "content-security-policy": "default-src 'none'; form-action https://credit.linux.do; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      })
      .type("html")
      .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在前往 LINUX DO Credit</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#18181b;font:14px system-ui,sans-serif}.box{width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #e4e4e7;border-radius:12px;background:#fff;text-align:center}.dot{width:24px;height:24px;margin:0 auto 16px;border:2px solid #d4d4d8;border-top-color:#18181b;border-radius:50%;animation:spin .8s linear infinite}p{color:#71717a;line-height:1.6}button{margin-top:12px;padding:9px 16px;border:0;border-radius:8px;background:#18181b;color:#fff;cursor:pointer}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="dot"></div><strong>正在前往 LINUX DO Credit</strong><p>如果没有自动跳转，请点击下方按钮。</p><form id="payment-form" method="post" action="${escapeHtml(submission.action)}">${fields}<button type="submit">继续支付</button></form></div><script>document.getElementById('payment-form').submit()</script></body></html>`);
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to prepare payment";
    res.status(status).type("text/plain").send(message);
  }
});
