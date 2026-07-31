import type { ModuleContext, PaymentChannelLike, PaymentProviderAdapter } from "./types";
import {
  buildLinuxDoPaymentSubmission,
  queryLinuxDoOrder,
  refundLinuxDoOrder,
  verifyLinuxDoEasyPaySignature,
  type LinuxDoNotify,
} from "./credit";

export const LINUXDO_CHANNEL_ID = "linuxdo-credit";
export const LINUXDO_PROVIDER = "linuxdo_credit";

function credentialsFromChannel(ctx: ModuleContext, channel: PaymentChannelLike) {
  return {
    clientId: channel.client_id.trim(),
    clientSecret: channel.client_secret ? ctx.decryptSecret(channel.client_secret) : "",
    gatewayUrl: channel.gateway_url,
  };
}

export function createPaymentProvider(ctx: ModuleContext): PaymentProviderAdapter {
  return {
    provider: LINUXDO_PROVIDER,
    channelId: LINUXDO_CHANNEL_ID,
    asset: "LDC",
    pathSegment: "linuxdo",
    isConfigured(channel) {
      const credentials = credentialsFromChannel(ctx, channel);
      return Boolean(credentials.clientId && credentials.clientSecret);
    },
    getCredentials(channel) {
      return credentialsFromChannel(ctx, channel);
    },
    queryOrder(credentials, orderNo) {
      return queryLinuxDoOrder(credentials, orderNo);
    },
    refund(credentials, input) {
      return refundLinuxDoOrder(credentials, input);
    },
    getCheckout(orderNo: string) {
      const order = ctx.requirePendingPaymentOrder(LINUXDO_CHANNEL_ID, orderNo);
      const publicBaseUrl = ctx.getPublicBaseUrl();
      if (!publicBaseUrl) {
        throw ctx.paymentError(503, "public_base_url_required", "Set a public domain before accepting payments");
      }
      const channel = ctx.getPaymentChannel(LINUXDO_CHANNEL_ID);
      if (!channel || !this.isConfigured(channel)) {
        throw ctx.paymentError(503, "payment_channel_incomplete", "LINUX DO Credit credentials are incomplete");
      }
      const credentials = this.getCredentials(channel);
      return buildLinuxDoPaymentSubmission(credentials, {
        orderNo: order.order_no,
        name: order.title,
        money: ctx.formatAssetAmount(order.amount_minor),
        notifyUrl: `${publicBaseUrl}/payment/linuxdo/notify`,
        returnUrl: `${publicBaseUrl}/payments?order_no=${encodeURIComponent(order.order_no)}`,
      });
    },
    handleNotify(query: Record<string, unknown>) {
      const channel = ctx.getPaymentChannel(LINUXDO_CHANNEL_ID);
      if (!channel || !this.isConfigured(channel)) {
        throw ctx.paymentError(503, "payment_channel_incomplete", "LINUX DO Credit credentials are incomplete");
      }
      const credentials = this.getCredentials(channel);
      const notify = Object.fromEntries(
        Object.entries(query).map(([key, value]) => [
          key,
          Array.isArray(value) ? String(value[0] ?? "") : String(value ?? ""),
        ]),
      ) as LinuxDoNotify;
      const required = ["pid", "trade_no", "out_trade_no", "type", "name", "money", "trade_status", "sign"] as const;
      if (required.some((key) => !notify[key])) {
        throw ctx.paymentError(400, "invalid_notification", "Missing notification fields");
      }
      if (notify.pid !== credentials.clientId || notify.type !== "epay" || notify.trade_status !== "TRADE_SUCCESS") {
        throw ctx.paymentError(400, "invalid_notification", "Unexpected notification values");
      }
      if (!verifyLinuxDoEasyPaySignature(notify, credentials.clientSecret, notify.sign)) {
        throw ctx.paymentError(400, "invalid_signature", "Invalid payment notification signature");
      }
      return ctx.creditNotifiedOrder({
        channelId: LINUXDO_CHANNEL_ID,
        orderNo: notify.out_trade_no,
        tradeNo: notify.trade_no,
        money: notify.money,
        payload: notify,
        externalId: `${notify.trade_no}:${notify.out_trade_no}`,
      });
    },
  };
}
