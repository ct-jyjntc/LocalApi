import type { AuthProviderAdapter } from "../modules/types";

const providers = new Map<string, AuthProviderAdapter>();

export function registerAuthProvider(adapter: AuthProviderAdapter) {
  if (!adapter.id) throw new Error("Auth provider requires id");
  providers.set(adapter.id, adapter);
}

export function unregisterAuthProvider(id: string) {
  providers.delete(id);
}

export function getAuthProvider(id: string) {
  return providers.get(id) ?? null;
}

export function listAuthProviders() {
  return [...providers.values()];
}

export function mergeAuthProviderPublicStatus() {
  const merged: Record<string, unknown> = {};
  for (const provider of providers.values()) {
    Object.assign(merged, provider.publicStatus());
  }
  return merged;
}

export function clearAuthProviders() {
  providers.clear();
}
