import { listWalletLedger } from "./billing";
import { listPaymentOrders } from "./payments";
import { listPlanOrders } from "./plans";

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function listCommerceOrders(userId: string, limit = 200) {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const payments = listPaymentOrders({ userId, limit: safeLimit }).map((order) => ({
    id: order.id,
    order_no: order.order_no,
    source: "payment" as const,
    kind: "wallet_topup" as const,
    status: order.status,
    title: order.title,
    settlement_micros: ["credited", "refunding"].includes(order.status) ? order.credited_micros : 0,
    external_amount: order.amount,
    external_asset: order.asset,
    discount_micros: 0,
    channel_name: order.channel_name || null,
    pay_url: order.pay_url,
    error: order.error,
    created_at: order.created_at,
    completed_at: order.credited_at || order.refunded_at || order.paid_at,
    actions: {
      pay: order.status === "pending" && Boolean(order.pay_url),
      sync: ["pending", "paid"].includes(order.status),
      cancel: order.status === "pending",
      delete: ["failed", "expired", "cancelled"].includes(order.status),
    },
  }));
  const plans = listPlanOrders(userId, safeLimit).map((order) => {
    const metadata = parseMetadata(order.metadata);
    const walletCredit = Math.max(0, Number(metadata.wallet_credit_micros || 0));
    return {
      id: order.id,
      order_no: order.order_no,
      source: "plan" as const,
      kind: `plan_${order.type}`,
      status: order.status,
      title: order.description || order.plan_name,
      settlement_micros: -order.amount_micros + walletCredit,
      external_amount: null,
      external_asset: null,
      discount_micros: order.credit_micros,
      channel_name: null,
      pay_url: null,
      error: order.status === "failed" ? order.description : null,
      created_at: order.created_at,
      completed_at: order.completed_at,
      actions: { pay: false, sync: false, cancel: false, delete: false },
    };
  });
  return [...payments, ...plans]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, safeLimit);
}

export function listCommerceLedger(userId: string, limit = 200) {
  return listWalletLedger(userId, Math.min(Math.max(1, limit), 500));
}
