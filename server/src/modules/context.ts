import { Router, type RequestHandler, type Response } from "express";
import { getSetting, setSetting } from "../db";
import { decryptSecret, encryptSecret } from "../utils/secrets";
import { getPublicBaseUrl } from "../utils/public-url";
import { consumeRateLimit } from "../services/rate-limit";
import {
  createUser,
  createUserSession,
  getUserByUsername,
} from "../services/users";
import {
  PaymentError,
  creditNotifiedOrder,
  disablePaymentChannel,
  ensurePaymentChannel,
  formatAssetAmount,
  getPaymentChannel,
  requirePendingPaymentOrder,
} from "../services/payments";
import { renderPaymentCheckoutPage } from "../routes/payments";
import {
  registerAuthProvider,
  unregisterAuthProvider,
} from "../services/auth-providers";
import {
  registerPaymentProvider,
  unregisterPaymentProvider,
} from "../services/payment-providers";
import type { ModuleHostRouter } from "./host-router";
import type {
  AdminSettingsContribution,
  AuthProviderAdapter,
  ModuleContext,
  PaymentProviderAdapter,
} from "./types";

export type ModuleRuntimeHandles = {
  userHost: ModuleHostRouter;
  adminHost: ModuleHostRouter;
  paymentHost: ModuleHostRouter;
  settings: Map<string, AdminSettingsContribution>;
  paymentProviders: Set<string>;
  authProviders: Set<string>;
};

export function createModuleRuntimeHandles(
  userHost: ModuleHostRouter,
  adminHost: ModuleHostRouter,
  paymentHost: ModuleHostRouter,
): ModuleRuntimeHandles {
  return {
    userHost,
    adminHost,
    paymentHost,
    settings: new Map(),
    paymentProviders: new Set(),
    authProviders: new Set(),
  };
}

export function buildModuleContext(
  moduleId: string,
  handles: ModuleRuntimeHandles,
): ModuleContext {
  return {
    moduleId,
    createRouter() {
      return Router();
    },
    getSetting: (key) => getSetting(key) ?? undefined,
    setSetting: (key, value) => setSetting(key, value),
    encryptSecret,
    decryptSecret,
    getPublicBaseUrl,
    registerPaymentProvider(adapter: PaymentProviderAdapter) {
      registerPaymentProvider(adapter);
      handles.paymentProviders.add(adapter.provider);
      handles.paymentProviders.add(adapter.channelId);
    },
    registerAuthProvider(adapter: AuthProviderAdapter) {
      registerAuthProvider(adapter);
      handles.authProviders.add(adapter.id);
    },
    contributeAdminSettings(contribution: AdminSettingsContribution) {
      handles.settings.set(moduleId, contribution);
    },
    mountUserRoutes(router: Router | RequestHandler) {
      handles.userHost.attach(moduleId, router);
    },
    mountAdminRoutes(router: Router | RequestHandler) {
      handles.adminHost.attach(moduleId, router);
    },
    mountPaymentRoutes(router: Router | RequestHandler) {
      handles.paymentHost.attach(moduleId, router);
    },
    users: {
      getByUsername(username) {
        const user = getUserByUsername(username);
        if (!user) return null;
        return { id: user.id, username: user.username, display_name: user.display_name };
      },
      create(input) {
        const created = createUser(input);
        return {
          id: created.id,
          username: created.username,
          display_name: created.display_name,
        };
      },
      createSession(userId) {
        const session = createUserSession(userId);
        return { token: session.token, expires_at: session.expires_at };
      },
    },
    rateLimit: {
      consume(key, limit, windowMs) {
        return consumeRateLimit(key, limit, windowMs);
      },
    },
    ensurePaymentChannel,
    disablePaymentChannel,
    getPaymentChannel(id: string) {
      const channel = getPaymentChannel(id);
      return channel
        ? {
            id: channel.id,
            provider: channel.provider,
            name: channel.name,
            enabled: channel.enabled,
            client_id: channel.client_id,
            client_secret: channel.client_secret,
            gateway_url: channel.gateway_url,
            exchange_rate_micros: channel.exchange_rate_micros,
            min_amount_minor: channel.min_amount_minor,
            max_amount_minor: channel.max_amount_minor,
            fee_bps: channel.fee_bps,
            fee_fixed_minor: channel.fee_fixed_minor,
            config_json: channel.config_json,
          }
        : null;
    },
    renderPaymentCheckoutPage(
      res: Response,
      submission: { action: string; params: Record<string, string> },
      providerName: string,
      options?: { allowRetry?: boolean },
    ) {
      renderPaymentCheckoutPage(res, submission, providerName, options);
    },
    requirePendingPaymentOrder,
    formatAssetAmount,
    creditNotifiedOrder,
    paymentError(status, code, message) {
      return new PaymentError(status, code, message);
    },
  };
}

export function teardownModuleHandles(moduleId: string, handles: ModuleRuntimeHandles) {
  handles.userHost.detach(moduleId);
  handles.adminHost.detach(moduleId);
  handles.paymentHost.detach(moduleId);
  handles.settings.delete(moduleId);
  for (const key of [...handles.paymentProviders]) {
    unregisterPaymentProvider(key);
  }
  handles.paymentProviders.clear();
  for (const id of [...handles.authProviders]) {
    unregisterAuthProvider(id);
  }
  handles.authProviders.clear();
}
