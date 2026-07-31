import type { PaymentProviderAdapter } from "../modules/types";

const providers = new Map<string, PaymentProviderAdapter>();
const byChannel = new Map<string, PaymentProviderAdapter>();

export function registerPaymentProvider(adapter: PaymentProviderAdapter) {
  if (!adapter.provider || !adapter.channelId) {
    throw new Error("Payment provider requires provider and channelId");
  }
  providers.set(adapter.provider, adapter);
  byChannel.set(adapter.channelId, adapter);
}

export function unregisterPaymentProvider(providerOrChannel: string) {
  const byProvider = providers.get(providerOrChannel);
  if (byProvider) {
    providers.delete(byProvider.provider);
    byChannel.delete(byProvider.channelId);
    return;
  }
  const byId = byChannel.get(providerOrChannel);
  if (byId) {
    providers.delete(byId.provider);
    byChannel.delete(byId.channelId);
  }
}

export function getPaymentProvider(provider: string) {
  return providers.get(provider) ?? null;
}

export function getPaymentProviderByChannelId(channelId: string) {
  return byChannel.get(channelId) ?? null;
}

export function listPaymentProviders() {
  return [...providers.values()];
}

export function clearPaymentProviders() {
  providers.clear();
  byChannel.clear();
}
