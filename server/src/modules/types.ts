import type { RequestHandler, Response, Router } from "express";

export type ModuleManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  main: string;
  minCoreVersion?: string;
  features?: string[];
};

export type PaymentChannelSeed = {
  id: string;
  provider: string;
  name: string;
  gateway_url?: string;
  exchange_rate_micros?: number;
  min_amount_minor?: number;
  max_amount_minor?: number;
  fee_bps?: number;
  fee_fixed_minor?: number;
  config_json?: string;
};

export type PaymentChannelLike = {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  client_id: string;
  client_secret: string;
  gateway_url: string;
  exchange_rate_micros: number;
  min_amount_minor: number;
  max_amount_minor: number;
  fee_bps: number;
  fee_fixed_minor: number;
  config_json: string;
};

export type PaymentProviderAdapter = {
  provider: string;
  channelId: string;
  asset: string;
  pathSegment: string;
  isConfigured(channel: PaymentChannelLike): boolean;
  getCredentials(channel: PaymentChannelLike): {
    clientId: string;
    clientSecret: string;
    gatewayUrl?: string;
  };
  queryOrder(
    credentials: { clientId: string; clientSecret: string; gatewayUrl?: string },
    orderNo: string,
  ): Promise<{
    found: boolean;
    paid: boolean;
    tradeNo: string | null;
    money: string | null;
  }>;
  refund(
    credentials: { clientId: string; clientSecret: string; gatewayUrl?: string },
    input: { tradeNo: string; orderNo: string; money: string },
  ): Promise<unknown>;
  getCheckout?(orderNo: string): {
    action: string;
    params: Record<string, string>;
  };
  handleNotify?(query: Record<string, unknown>): unknown;
};

export type AuthProviderAdapter = {
  id: string;
  publicStatus(): Record<string, unknown>;
};

export type AdminSettingsContribution = {
  serialize(): Record<string, unknown>;
  apply(body: Record<string, unknown>): void;
  settingKeys?: string[];
};

export type PendingPaymentOrder = {
  id: string;
  order_no: string;
  title: string;
  amount_minor: number;
  status: string;
  channel_id: string;
};

export type ModuleContext = {
  moduleId: string;
  /** Create an Express router from the host process (modules must not depend on express). */
  createRouter(): Router;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  encryptSecret(value: string): string;
  decryptSecret(value: string): string;
  getPublicBaseUrl(): string;
  registerPaymentProvider(adapter: PaymentProviderAdapter): void;
  registerAuthProvider(adapter: AuthProviderAdapter): void;
  contributeAdminSettings(contribution: AdminSettingsContribution): void;
  mountUserRoutes(router: Router | RequestHandler): void;
  mountAdminRoutes(router: Router | RequestHandler): void;
  mountPaymentRoutes(router: Router | RequestHandler): void;
  users: {
    getByUsername(username: string): { id: string; username: string; display_name: string } | null;
    getByLinuxDoUid(uid: string): { id: string; username: string; display_name: string } | null;
    create(input: {
      username: string;
      display_name?: string;
      password: string;
      linuxdo_uid?: string | null;
    }): { id: string; username: string; display_name: string };
    createSession(userId: string): { token: string; expires_at: string };
  };
  rateLimit: {
    consume(
      key: string,
      limit: number,
      windowMs: number,
    ): { allowed: boolean; retryAfterMs: number; remaining: number };
  };
  ensurePaymentChannel(seed: PaymentChannelSeed): void;
  disablePaymentChannel(id: string): void;
  enablePaymentChannel(id: string): void;
  getPaymentChannel(id: string): PaymentChannelLike | null;
  renderPaymentCheckoutPage(
    res: Response,
    submission: { action: string; params: Record<string, string> },
    providerName: string,
    options?: { allowRetry?: boolean },
  ): void;
  requirePendingPaymentOrder(channelId: string, orderNo: string): PendingPaymentOrder;
  formatAssetAmount(amountMinor: number): string;
  creditNotifiedOrder(input: {
    channelId: string;
    orderNo: string;
    tradeNo: string;
    money: string;
    payload: unknown;
    externalId: string;
  }): void;
  paymentError(status: number, code: string, message: string): Error;
};

export type ModuleDefinition = {
  activate(ctx: ModuleContext): void | Promise<void>;
  deactivate?(ctx: ModuleContext): void | Promise<void>;
};

export type InstalledModuleRecord = {
  id: string;
  name: string;
  version: string;
  enabled: number;
  installed_at: string;
  updated_at: string;
  manifest_json: string;
};

export type PublicModuleInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  features: string[];
};

export type AdminModuleInfo = PublicModuleInfo & {
  installed_at: string;
  updated_at: string;
  active: boolean;
};
