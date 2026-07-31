import type { ModuleContext, PaymentProviderAdapter } from "../types";

const providers = new WeakMap<ModuleContext, PaymentProviderAdapter>();

export function setPaymentProvider(ctx: ModuleContext, adapter: PaymentProviderAdapter) {
  providers.set(ctx, adapter);
}

export function getPaymentProvider(ctx: ModuleContext) {
  return providers.get(ctx) ?? null;
}
