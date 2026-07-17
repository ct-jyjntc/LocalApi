import { Router, urlencoded, type Response } from "express";
import {
  PaymentError,
  getAlipayCheckout,
  getLinuxDoCheckout,
  handleAlipayNotification,
  handleLinuxDoNotification,
} from "../services/payments";

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

paymentsRouter.post("/payment/alipay/notify", urlencoded({ extended: false, limit: "1mb" }), (req, res) => {
  try {
    const body = req.body && typeof req.body === "object"
      ? req.body as Record<string, unknown>
      : {};
    handleAlipayNotification(body);
    res.type("text/plain").status(200).send("success");
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    res.type("text/plain").status(status).send("failure");
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

function checkoutPage(
  res: Response,
  submission: { action: string; params: Record<string, string> },
  providerName: string,
) {
  const directUrl = new URL(submission.action);
  for (const [name, value] of Object.entries(submission.params)) {
    directUrl.searchParams.set(name, value);
  }
  const directPaymentUrl = directUrl.toString();
  const fields = Object.entries(submission.params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const formAction = new URL(submission.action).origin;
  res
    .status(200)
    .set({
      "cache-control": "no-store, max-age=0",
      "content-security-policy": `default-src 'none'; form-action ${formAction}; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
    })
    .type("html")
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在前往 ${escapeHtml(providerName)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#18181b;font:14px system-ui,sans-serif}.box{width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #e4e4e7;border-radius:12px;background:#fff;text-align:center}.dot{width:24px;height:24px;margin:0 auto 16px;border:2px solid #d4d4d8;border-top-color:#18181b;border-radius:50%;animation:spin .8s linear infinite}p{color:#71717a;line-height:1.6}button,.direct{display:inline-block;margin-top:12px;padding:9px 16px;border:0;border-radius:999px;background:#18181b;color:#fff;cursor:pointer;font:inherit;text-decoration:none}.direct{margin-left:8px;background:#fff;color:#18181b;border:1px solid #d4d4d8}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="box"><div class="dot"></div><strong>正在前往 ${escapeHtml(providerName)}</strong><p>如果没有自动跳转，请点击下方按钮。</p><form id="payment-form" method="post" target="_top" accept-charset="UTF-8" action="${escapeHtml(submission.action)}">${fields}<button id="submit-payment" type="submit">继续支付</button><a class="direct" href="${escapeHtml(directPaymentUrl)}" target="_top" rel="noopener">直接打开</a></form></div><script>(()=>{const form=document.getElementById('payment-form');const button=document.getElementById('submit-payment');let submitted=false;form.addEventListener('submit',()=>{submitted=true;button.disabled=true;button.textContent='正在跳转…'});try{if(form.requestSubmit)form.requestSubmit();else form.submit()}catch(_){window.location.href=${JSON.stringify(directPaymentUrl)}}setTimeout(()=>{if(!submitted||document.visibilityState==='visible')window.location.href=${JSON.stringify(directPaymentUrl)}},1200)})()</script></body></html>`);
}

paymentsRouter.get("/payment/linuxdo/checkout/:orderNo", (req, res) => {
  try {
    const submission = getLinuxDoCheckout(req.params.orderNo);
    checkoutPage(res, submission, "LINUX DO Credit");
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to prepare payment";
    res.status(status).type("text/plain").send(message);
  }
});

paymentsRouter.get("/payment/alipay/checkout/:orderNo", (req, res) => {
  try {
    checkoutPage(res, getAlipayCheckout(req.params.orderNo), "支付宝");
  } catch (error) {
    const status = error instanceof PaymentError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unable to prepare payment";
    res.status(status).type("text/plain").send(message);
  }
});
