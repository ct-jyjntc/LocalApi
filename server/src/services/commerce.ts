import { listWalletLedger, listWalletLedgerPage } from "./billing";
import { listPaymentOrders, listPaymentOrdersPage } from "./payments";
import { listPlanOrders } from "./plans";
import { db } from "../db";

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapPaymentOrder(order: ReturnType<typeof listPaymentOrders>[number]) {
  return {
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
      sync: ["pending", "paid", "refunding"].includes(order.status),
      cancel: order.status === "pending",
      delete: ["failed", "expired", "cancelled"].includes(order.status),
    },
  };
}

function mapPlanOrder(order: ReturnType<typeof listPlanOrders>[number]) {
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
    external_amount: null as string | null,
    external_asset: null as string | null,
    discount_micros: order.credit_micros,
    channel_name: null as string | null,
    pay_url: null as string | null,
    error: order.status === "failed" ? order.description : null,
    created_at: order.created_at,
    completed_at: order.completed_at,
    actions: { pay: false, sync: false, cancel: false, delete: false },
  };
}

export function listCommerceOrders(userId: string, limit = 200) {
  return listCommerceOrdersPage({ userId, limit, offset: 0 }).items;
}

/** Merge payment + plan orders with server-side windowing. */
export function listCommerceOrdersPage(input: {
  userId: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  // Fetch a window large enough to merge/sort accurately for the requested page.
  const window = Math.min(1000, offset + limit);
  const payments = listPaymentOrders({ userId: input.userId, limit: window }).map(mapPaymentOrder);
  const plans = listPlanOrders(input.userId, window).map(mapPlanOrder);
  const merged = [...payments, ...plans].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  const paymentTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM payment_orders
         WHERE user_id = ? AND deleted_at IS NULL`,
      )
      .get(input.userId) as { c: number }
  ).c;
  const planTotal = (
    db.prepare("SELECT COUNT(*) AS c FROM plan_orders WHERE user_id = ?").get(input.userId) as {
      c: number;
    }
  ).c;
  const total = paymentTotal + planTotal;
  return {
    items: merged.slice(offset, offset + limit),
    total,
    limit,
    offset,
  };
}

export function listCommerceLedger(userId: string, limit = 200) {
  return listWalletLedger(userId, Math.min(Math.max(1, limit), 500));
}

export function listCommerceLedgerPage(input: {
  userId: string;
  limit?: number;
  offset?: number;
}) {
  return listWalletLedgerPage(input);
}
