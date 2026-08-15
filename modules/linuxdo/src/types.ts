/**
 * Structural ModuleContext type used by the packaged module.
 * Must stay compatible with server/src/modules/types.ts ModuleContext.
 * Modules must not import express — use ctx.createRouter() instead.
 */

export type RequestHandler = (req: any, res: any, next: any) => any;
export type Response = {
  status(code: number): Response;
  type(value: string): Response;
  send(body?: any): any;
  set(fields: Record<string, string>): Response;
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
  redirect(url: string): void;
  json(body: unknown): any;
};
export type Router = RequestHandler & {
  get(path: string, ...handlers: RequestHandler[]): Router;
  post(path: string, ...handlers: RequestHandler[]): Router;
  use(...handlers: any[]): Router;
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

export type ModuleContext = {
  moduleId: string;
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
    getByUsername(username: string): { id: string; username: string; display_name: string; linuxdo_uid?: string | null } | null;
    getByLinuxDoUid(uid: string): { id: string; username: string; display_name: string; linuxdo_uid?: string | null } | null;
    bindLinuxDoUid(userId: string, uid: string): { id: string; username: string; display_name: string } | null;
    create(input: {
      username: string;
      display_name?: string;
      password: string;
      linuxdo_uid?: string;
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
  ensurePaymentChannel(seed: {
    id: string;
    provider: string;
    name: string;
    gateway_url?: string;
    exchange_rate_micros?: number;
    min_amount_minor?: number;
    max_amount_minor?: number;
  }): void;
  disablePaymentChannel(id: string): void;
  enablePaymentChannel(id: string): void;
  getPaymentChannel(id: string): PaymentChannelLike | null;
  renderPaymentCheckoutPage(
    res: Response,
    submission: { action: string; params: Record<string, string> },
    providerName: string,
    options?: { allowRetry?: boolean },
  ): void;
  requirePendingPaymentOrder(channelId: string, orderNo: string): {
    id: string;
    order_no: string;
    title: string;
    amount_minor: number;
    status: string;
    channel_id: string;
  };
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
