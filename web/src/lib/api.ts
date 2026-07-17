const TOKEN_KEY = "localapi_admin_token";
const USER_TOKEN_KEY = "localapi_user_token";
const ADMIN_ENTRY_KEY = "localapi_admin_entry_path";

export function getAdminToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setAdminToken(token: string) {
  if (!token) {
    localStorage.removeItem(TOKEN_KEY);
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getAdminEntryPath(): string {
  return sessionStorage.getItem(ADMIN_ENTRY_KEY) || "/admin";
}

export function setAdminEntryPath(path: string) {
  sessionStorage.setItem(ADMIN_ENTRY_KEY, path || "/admin");
}

export function getUserToken(): string {
  return localStorage.getItem(USER_TOKEN_KEY) || "";
}

export function setUserToken(token: string) {
  if (token) localStorage.setItem(USER_TOKEN_KEY, token);
  else localStorage.removeItem(USER_TOKEN_KEY);
}

export function clearUserToken() {
  localStorage.removeItem(USER_TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts?: { auth?: "admin" | "user" | false },
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (opts?.auth === "user") {
    const token = getUserToken();
    if (token) headers.set("x-user-token", token);
  } else if (opts?.auth !== false) {
    const token = getAdminToken();
    if (token) headers.set("x-admin-token", token);
  }

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error?.message || data.error || message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, String(message));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type DashboardStats = {
  totalRequests: number;
  cachedRequests: number;
  errorRequests: number;
  avgLatencyMs: number;
  requestBytes: number;
  responseBytes: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  last24h: number;
  providers: number;
  keys: number;
  cacheEntries: number;
  hitRate: number;
  recent: Array<{
    id: string;
    method: string;
    path: string;
    model: string | null;
    status_code: number;
    latency_ms: number;
    cached: boolean;
    created_at: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
    cached_tokens?: number;
  }>;
  byHour: Array<{ bucket: string; count: number; cached_count: number }>;
};

export type Provider = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  api_keys?: string[];
  key_count?: number;
  has_api_key: boolean;
  models: string[];
  enabled: boolean;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
};

export type ProviderTestResult = {
  ok: boolean;
  provider_id: string;
  provider_name: string;
  model: string;
  path: string;
  status_code: number | null;
  attempts: number;
  max_retries: number;
  latency_ms: number;
  error: string | null;
  response_preview: string;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  enabled: boolean;
  rate_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  allowed_models: string[];
  expires_at: string | null;
  user_id: string | null;
  created_at: string;
  last_used_at: string | null;
  key?: string | null;
};

export type LogRow = {
  id: string;
  method: string;
  path: string;
  model: string | null;
  provider_id: string | null;
  provider_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  status_code: number;
  latency_ms: number;
  cached: boolean;
  request_bytes: number;
  response_bytes: number;
  error: string | null;
  created_at: string;
  input_text: string | null;
  output_text: string | null;
  reasoning_text: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  usage_estimated?: boolean;
  stream: boolean;
  user_id?: string | null;
  usage_id?: string | null;
  cost_micros?: number;
};

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  status: string;
  allowed_models: string[];
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  balance_micros?: number;
  reserved_micros?: number;
  lifetime_spent_micros?: number;
  subscription_id?: string | null;
  plan_id?: string | null;
  plan_name?: string | null;
  period_end?: string | null;
  remaining_credits_micros?: number | null;
  lifetime_topup_micros?: number;
  tier?: TierSummary;
};

export type UserTier = {
  id: string;
  name: string;
  description: string;
  threshold_micros: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type TierSummary = {
  current: UserTier | null;
  next: UserTier | null;
  lifetime_topup_micros: number;
  next_required_micros: number;
};

export type ModelPrice = {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
export type FeedbackAttachment = { name: string; type: string; data: string };
export type FeedbackMessage = { id: string; sender_type: "user" | "admin"; body: string; attachments: FeedbackAttachment[]; created_at: string };
export type FeedbackThread = { id: string; user_id: string; username?: string; display_name?: string; subject: string; status: "open" | "resolved"; created_at: string; updated_at: string; messages: FeedbackMessage[] };

export type PlanRow = {
  id: string;
  name: string;
  description: string;
  cycle_days: number;
  price_micros: number;
  included_credits_micros: number;
  allowed_models: string[];
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  overage_enabled: boolean;
  stock_limit: number;
  stock_used: number;
  stock_available: number | null;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type PaymentChannel = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  client_id?: string;
  client_secret?: string;
  gateway_url?: string;
  asset?: string;
  payment_modes?: string[];
  exchange_rate_micros: number;
  min_amount_minor: number;
  max_amount_minor: number;
  fee_bps: number;
  fee_fixed_minor: number;
  notify_url?: string;
  return_url?: string;
  alipay_public_key?: string;
  seller_id?: string;
  web_enabled?: boolean;
  wap_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PaymentOrder = {
  id: string;
  order_no: string;
  user_id: string;
  username?: string;
  display_name?: string;
  channel_id: string;
  channel_name?: string;
  channel_trade_no: string | null;
  purpose: string;
  status: "pending" | "paid" | "credited" | "failed" | "expired" | "cancelled" | "refunding" | "refunded";
  amount_minor: number;
  amount: string;
  fee_minor: number;
  fee: string;
  asset: string;
  credited_micros: number;
  credited_amount: number;
  exchange_rate_micros: number;
  title: string;
  pay_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  paid_at: string | null;
  credited_at: string | null;
  refunded_at: string | null;
};

export type PaymentRefund = {
  id: string;
  refund_no: string;
  order_id: string;
  order_no: string;
  username: string;
  amount_minor: number;
  debit_micros: number;
  status: string;
  reason: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  period_start: string;
  period_end: string;
  entitlement_end: string;
  remaining_credits_micros: number;
  reserved_micros: number;
  price_micros_snapshot: number;
  auto_renew: number;
  overage_enabled: number;
  plan: PlanRow;
};

export type PlanOrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  previous_plan_id: string | null;
  previous_plan_name: string | null;
  subscription_id: string | null;
  type: "purchase" | "upgrade" | "renewal" | "auto_renewal";
  status: "completed" | "failed";
  list_price_micros: number;
  credit_micros: number;
  amount_micros: number;
  balance_after_micros: number;
  description: string;
  created_at: string;
  completed_at: string | null;
};

export type PlanTransactionResult = {
  order: PlanOrderRow;
  subscription: SubscriptionRow | null;
};

export type CommerceOrder = {
  id: string;
  order_no: string;
  source: "payment" | "plan";
  kind: string;
  status: string;
  title: string;
  settlement_micros: number;
  external_amount: string | null;
  external_asset: string | null;
  discount_micros: number;
  channel_name: string | null;
  pay_url: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  actions: { pay: boolean; sync: boolean; cancel: boolean; delete: boolean };
};

export type WalletLedgerRow = {
  id: string;
  user_id: string;
  type: string;
  amount_micros: number;
  balance_after_micros: number;
  usage_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  description: string;
  created_at: string;
};

export type Wallet = {
  user_id: string;
  balance_micros: number;
  reserved_micros: number;
  lifetime_spent_micros: number;
  lifetime_topup_micros: number;
  updated_at: string;
};

export type UsageRow = {
  id: string;
  request_id: string;
  user_id: string;
  api_key_id: string;
  model: string;
  status: string;
  status_code: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_micros: number;
  plan_cost_micros: number;
  wallet_cost_micros: number;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  estimated_prompt_tokens: number;
  estimated_completion_tokens: number;
  reserved_plan_micros: number;
  reserved_wallet_micros: number;
  subscription_id: string | null;
  billing_mode: "wallet" | "coding";
  cache_write_tokens: number;
  ordinary_input_tokens: number;
  cache_read_tokens: number;
  input_cost_micros: number;
  cache_read_cost_micros: number;
  cache_write_cost_micros: number;
  output_cost_micros: number;
  created_at: string;
  completed_at: string | null;
  error: string | null;
};

export type UsageTrendPoint = {
  date: string;
  requests: number;
  cost_micros: number;
  total_tokens: number;
};

export type Settings = {
  admin_password_set?: boolean;
  admin_password_hint?: string;
  admin_token?: string;
  port: string;
  max_retries?: number;
  retry_delay_ms?: number;
  cache_enabled: boolean;
  cache_ttl_seconds: number;
  cache_max_entries: number;
  cache_methods: string[];
  cache_paths: string[];
  brand_name: string;
  company_name: string;
  public_base_url: string;
  admin_entry_path: string;
  registration_enabled: boolean;
};

export type Branding = {
  brand_name: string;
  company_name: string;
  public_base_url: string;
};

export const api = {
  branding: () => request<Branding>("/branding", {}, { auth: false }),
  adminEntry: (path: string) =>
    request<{ ok: boolean }>(
      "/admin/api/entry",
      { method: "POST", body: JSON.stringify({ path }) },
      { auth: false },
    ),
  login: (password: string, entryPath: string) =>
    request<{ ok: boolean }>(
      "/admin/api/login",
      {
        method: "POST",
        body: JSON.stringify({ password, entry_path: entryPath }),
      },
      { auth: false },
    ),
  health: () => request<{ ok: boolean }>("/admin/api/health"),
  dashboard: () => request<DashboardStats>("/admin/api/dashboard"),
  providers: {
    list: () => request<{ items: Provider[] }>("/admin/api/providers"),
    create: (
      body: Partial<Provider> & {
        name: string;
        base_url: string;
        api_keys?: string[];
      },
    ) =>
      request<Provider>("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: Partial<Provider> & { api_keys?: string[] },
    ) =>
      request<Provider>(`/admin/api/providers/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/admin/api/providers/${id}`, {
        method: "DELETE",
      }),
    test: (id: string, model?: string) =>
      request<ProviderTestResult>(`/admin/api/providers/${id}/test`, {
        method: "POST",
        body: JSON.stringify(model ? { model } : {}),
      }),
  },
  keys: {
    list: () => request<{ items: ApiKeyRow[] }>("/admin/api/keys"),
    create: (body: { name: string; rate_limit?: number; enabled?: boolean }) =>
      request<ApiKeyRow>("/admin/api/keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: Partial<{ name: string; enabled: boolean; rate_limit: number }>,
    ) =>
      request<ApiKeyRow>(`/admin/api/keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/admin/api/keys/${id}`, { method: "DELETE" }),
  },
  logs: {
    list: (limit = 100, offset = 0) =>
      request<{ items: LogRow[]; total: number }>(
        `/admin/api/logs?limit=${limit}&offset=${offset}`,
      ),
    get: (id: string) => request<LogRow>(`/admin/api/logs/${id}`),
    clear: () =>
      request<{ ok: boolean; removed: number }>("/admin/api/logs", {
        method: "DELETE",
      }),
  },
  settings: {
    get: () => request<Settings>("/admin/api/settings"),
    update: (body: {
      admin_password?: string;
      current_admin_password?: string;
      admin_token?: string;
      cache_enabled?: boolean;
      port?: string | number;
      max_retries?: number;
      retry_delay_ms?: number;
      brand_name?: string;
      company_name?: string;
      public_base_url?: string;
      admin_entry_path?: string;
      registration_enabled?: boolean;
    }) =>
      request<Settings>("/admin/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },
  commercial: {
    feedback: {
      list: () => request<{ items: FeedbackThread[] }>("/admin/api/commercial/feedback"),
      reply: (id: string, body: string, attachments: FeedbackAttachment[] = []) => request<{ messages: FeedbackMessage[] }>(`/admin/api/commercial/feedback/${id}/replies`, { method: "POST", body: JSON.stringify({ body, attachments }) }),
      status: (id: string, status: "open" | "resolved") => request<{ ok: boolean }>(`/admin/api/commercial/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    },
    users: {
      list: () => request<{ items: UserRow[] }>("/admin/api/commercial/users"),
      create: (body: {
        username: string;
        display_name?: string;
        password: string;
        status?: string;
        allowed_models?: string[];
        rpm_limit?: number;
        tpm_limit?: number;
        concurrency_limit?: number;
      }) => request<UserRow>("/admin/api/commercial/users", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: Partial<UserRow> & { password?: string }) =>
        request<UserRow>(`/admin/api/commercial/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<{ ok: boolean }>(`/admin/api/commercial/users/${id}`, { method: "DELETE" }),
      adjustWallet: (id: string, amount_micros: number, description: string) =>
        request<Wallet>(`/admin/api/commercial/users/${id}/wallet`, {
          method: "POST",
          body: JSON.stringify({ amount_micros, description }),
        }),
      assignPlan: (id: string, plan_id: string, auto_renew = true) =>
        request<SubscriptionRow>(`/admin/api/commercial/users/${id}/subscription`, {
          method: "POST",
          body: JSON.stringify({ plan_id, auto_renew }),
        }),
      cancelPlan: (id: string) =>
        request<{ ok: boolean }>(`/admin/api/commercial/users/${id}/subscription`, { method: "DELETE" }),
    },
    tiers: {
      list: () => request<{ items: UserTier[] }>("/admin/api/commercial/tiers"),
      create: (body: Omit<UserTier, "id" | "created_at" | "updated_at">) =>
        request<UserTier>("/admin/api/commercial/tiers", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: Partial<Omit<UserTier, "id" | "created_at" | "updated_at">>) =>
        request<UserTier>(`/admin/api/commercial/tiers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<{ ok: boolean }>(`/admin/api/commercial/tiers/${id}`, { method: "DELETE" }),
    },
    prices: {
      list: () => request<{ items: ModelPrice[] }>("/admin/api/commercial/prices"),
      upsert: (model: string, body: Omit<ModelPrice, "model" | "created_at" | "updated_at">) =>
        request<ModelPrice>(`/admin/api/commercial/prices/${encodeURIComponent(model)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      remove: (model: string) =>
        request<{ ok: boolean }>(`/admin/api/commercial/prices/${encodeURIComponent(model)}`, { method: "DELETE" }),
    },
    plans: {
      list: () => request<{ items: PlanRow[] }>("/admin/api/commercial/plans"),
      create: (body: {
        name: string;
        description?: string;
        cycle_days?: number;
        price_micros?: number;
        included_credits_micros?: number;
        allowed_models?: string[];
        rpm_limit?: number;
        tpm_limit?: number;
        concurrency_limit?: number;
        stock_limit?: number;
        overage_enabled?: boolean;
        enabled?: boolean;
      }) =>
        request<PlanRow>("/admin/api/commercial/plans", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: Partial<{
        name: string;
        description: string;
        cycle_days: number;
        price_micros: number;
        included_credits_micros: number;
        allowed_models: string[];
        rpm_limit: number;
        tpm_limit: number;
        concurrency_limit: number;
        stock_limit: number;
        overage_enabled: boolean;
        enabled: boolean;
      }>) =>
        request<PlanRow>(`/admin/api/commercial/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<{ ok: boolean }>(`/admin/api/commercial/plans/${id}`, { method: "DELETE" }),
      reorder: (ids: string[]) =>
        request<{ items: PlanRow[] }>("/admin/api/commercial/plans/reorder", {
          method: "PUT",
          body: JSON.stringify({ ids }),
        }),
    },
    usage: (limit = 200) => request<{ items: UsageRow[] }>(`/admin/api/commercial/usage?limit=${limit}`),
    payments: {
      channel: () => request<PaymentChannel>("/admin/api/commercial/payments/channel"),
      updateChannel: (body: Partial<PaymentChannel>) =>
        request<PaymentChannel>("/admin/api/commercial/payments/channel", {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      channels: () => request<{ items: PaymentChannel[] }>("/admin/api/commercial/payments/channels"),
      updateChannelById: (id: string, body: Partial<PaymentChannel>) =>
        request<PaymentChannel>(`/admin/api/commercial/payments/channels/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      orders: (status?: string, limit = 200) =>
        request<{ items: PaymentOrder[] }>(
          `/admin/api/commercial/payments/orders?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ""}`,
        ),
      sync: (id: string) =>
        request<PaymentOrder>(`/admin/api/commercial/payments/orders/${id}/sync`, { method: "POST" }),
      refund: (id: string, reason: string) =>
        request<PaymentOrder>(`/admin/api/commercial/payments/orders/${id}/refund`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        }),
      cancel: (id: string) =>
        request<PaymentOrder>(`/admin/api/commercial/payments/orders/${id}/cancel`, { method: "POST" }),
      remove: (id: string) =>
        request<{ ok: boolean }>(`/admin/api/commercial/payments/orders/${id}`, { method: "DELETE" }),
      refunds: (limit = 200) =>
        request<{ items: PaymentRefund[] }>(`/admin/api/commercial/payments/refunds?limit=${limit}`),
    },
  },
};

export const userApi = {
  feedback: {
    list: () => request<{ items: FeedbackThread[] }>("/user/api/feedback", {}, { auth: "user" }),
    create: (subject: string, body: string, attachments: FeedbackAttachment[]) => request<FeedbackThread>("/user/api/feedback", { method: "POST", body: JSON.stringify({ subject, body, attachments }) }, { auth: "user" }),
    reply: (id: string, body: string, attachments: FeedbackAttachment[]) => request<{ messages: FeedbackMessage[] }>(`/user/api/feedback/${id}/replies`, { method: "POST", body: JSON.stringify({ body, attachments }) }, { auth: "user" }),
  },
  config: () => request<{ registration_enabled: boolean; linuxdo_enabled: boolean }>("/user/api/config", {}, { auth: false }),
  login: (username: string, password: string) =>
    request<{ token: string; expires_at: string; user: UserRow }>(
      "/user/api/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      { auth: false },
    ),
  register: (username: string, password: string, display_name?: string) =>
    request<{ token: string; expires_at: string; user: UserRow }>(
      "/user/api/register",
      { method: "POST", body: JSON.stringify({ username, password, display_name }) },
      { auth: false },
    ),
  logout: () => request<{ ok: boolean }>("/user/api/logout", { method: "POST" }, { auth: "user" }),
  me: () =>
    request<{ user: UserRow; wallet: Wallet | null; tier: TierSummary; subscription: SubscriptionRow | null; prices: ModelPrice[] }>(
      "/user/api/me",
      {},
      { auth: "user" },
    ),
  dashboard: () =>
    request<{
      user: UserRow;
      wallet: Wallet | null;
      subscription: SubscriptionRow | null;
      totals: { requests: number; cost_micros: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number; total_tokens: number };
      trend: UsageTrendPoint[];
    }>("/user/api/dashboard", {}, { auth: "user" }),
  keys: {
    list: () => request<{ items: ApiKeyRow[] }>("/user/api/keys", {}, { auth: "user" }),
    create: (body: Partial<ApiKeyRow> & { name: string }) =>
      request<ApiKeyRow>("/user/api/keys", { method: "POST", body: JSON.stringify(body) }, { auth: "user" }),
    update: (id: string, body: Partial<ApiKeyRow>) =>
      request<ApiKeyRow>(`/user/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }, { auth: "user" }),
    remove: (id: string) => request<{ ok: boolean }>(`/user/api/keys/${id}`, { method: "DELETE" }, { auth: "user" }),
  },
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>(
      "/user/api/me/password",
      { method: "PATCH", body: JSON.stringify({ current_password, new_password }) },
      { auth: "user" },
    ),
  usage: (limit = 200) => request<{ items: UsageRow[] }>(`/user/api/usage?limit=${limit}`, {}, { auth: "user" }),
  commerce: {
    orders: (limit = 200) =>
      request<{ items: CommerceOrder[] }>(`/user/api/commerce/orders?limit=${limit}`, {}, { auth: "user" }),
    ledger: (limit = 200) =>
      request<{ items: WalletLedgerRow[] }>(`/user/api/commerce/ledger?limit=${limit}`, {}, { auth: "user" }),
  },
  payments: {
    config: () => request<{ channel: PaymentChannel | null; channels: PaymentChannel[] }>("/user/api/payments/config", {}, { auth: "user" }),
    orders: (limit = 200) =>
      request<{ items: PaymentOrder[] }>(`/user/api/payments/orders?limit=${limit}`, {}, { auth: "user" }),
    createTopup: (amount: string, channel_id?: string, mode?: "page" | "wap") =>
      request<PaymentOrder>(
        "/user/api/payments/topups",
        { method: "POST", body: JSON.stringify({ amount, channel_id, mode }) },
        { auth: "user" },
      ),
    sync: (id: string) =>
      request<PaymentOrder>(`/user/api/payments/orders/${id}/sync`, { method: "POST" }, { auth: "user" }),
    cancel: (id: string) =>
      request<PaymentOrder>(`/user/api/payments/orders/${id}/cancel`, { method: "POST" }, { auth: "user" }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/user/api/payments/orders/${id}`, { method: "DELETE" }, { auth: "user" }),
  },
  subscription: {
    setAutoRenew: (enabled: boolean) =>
      request<SubscriptionRow>(
        "/user/api/subscription/auto-renew",
        { method: "PATCH", body: JSON.stringify({ enabled }) },
        { auth: "user" },
      ),
    setOverage: (enabled: boolean) =>
      request<SubscriptionRow>(
        "/user/api/subscription/overage",
        { method: "PATCH", body: JSON.stringify({ enabled }) },
        { auth: "user" },
      ),
    upgrade: (plan_id: string) =>
      request<PlanTransactionResult>(
        "/user/api/subscription/upgrade",
        { method: "POST", body: JSON.stringify({ plan_id, request_id: crypto.randomUUID() }) },
        { auth: "user" },
      ),
    renew: () =>
      request<PlanTransactionResult>(
        "/user/api/subscription/renew",
        { method: "POST", body: JSON.stringify({ request_id: crypto.randomUUID() }) },
        { auth: "user" },
      ),
  },
  plans: {
    list: () => request<{ items: PlanRow[] }>("/user/api/plans", {}, { auth: "user" }),
    purchase: (id: string) =>
      request<PlanTransactionResult>(
        `/user/api/plans/${id}/purchase`,
        { method: "POST", body: JSON.stringify({ request_id: crypto.randomUUID() }) },
        { auth: "user" },
      ),
    orders: (limit = 100) =>
      request<{ items: PlanOrderRow[] }>(`/user/api/plan-orders?limit=${limit}`, {}, { auth: "user" }),
  },
};
