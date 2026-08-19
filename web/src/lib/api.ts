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

// M13: broadcast when an authenticated request receives 401 so the app shell
// can drop the session and return to the login page. Login/register/public
// endpoints use auth:false and never emit this.
export const AUTH_EXPIRED_EVENT = "localapi:auth-expired";
export type AuthExpiredDetail = { mode: "admin" | "user" };

function notifyAuthExpired(mode: "admin" | "user") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AuthExpiredDetail>(AUTH_EXPIRED_EVENT, { detail: { mode } }));
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts?: { auth?: "admin" | "user" | false },
): Promise<T> {
  const headers = new Headers(init.headers);
  // FormData must keep the browser-generated multipart boundary.
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const authMode: "admin" | "user" | false =
    opts?.auth === "user" ? "user" : opts?.auth === false ? false : "admin";
  if (authMode === "user") {
    const token = getUserToken();
    if (token) headers.set("x-user-token", token);
  } else if (authMode === "admin") {
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
    // M13: an authenticated 401 means the session is gone (expired, revoked
    // after password change, etc.). Clear the matching token and notify the
    // shell so the user is bounced to login instead of staring at a stuck UI.
    if (res.status === 401 && authMode) {
      if (authMode === "admin") clearAdminToken();
      else clearUserToken();
      notifyAuthExpired(authMode);
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
  model_mappings?: Record<string, string>;
  proxy_ids?: string[];
  enabled: boolean;
  timeout_ms: number;
  sort_order: number;
  custom_headers: Record<string, string>;
  created_at: string;
  updated_at: string;
};
export type ProxyNode = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ProxyLibrary = {
  id: string;
  name: string;
  url: string;
  default_protocol: string;
  enabled: boolean;
  auto_update: boolean;
  update_interval_ms: number;
  last_updated_at: string | null;
  node_count: number;
  created_at: string;
  updated_at: string;
  import?: {
    added: number;
    removed: number;
    total: number;
    alive?: number;
    dead?: number;
    skipped?: boolean;
  } | null;
  import_error?: string | null;
};
export type ProviderTestResult = {
  ok: boolean;
  provider_id: string;
  provider_name: string;
  model: string;
  upstream_model?: string;
  path: string;
  status_code: number | null;
  attempts: number;
  max_retries: number;
  normal_max_retries?: number;
  other_max_retries?: number;
  normal_retries_used?: number;
  other_retries_used?: number;
  class_max_attempts?: number;
  retry_class?: "normal" | "other" | "none";
  stop_reason?: "ok" | "normal_budget" | "other_budget" | "non_retryable" | "error";
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
  daily_quota_micros: number;
  monthly_quota_micros: number;
  allowed_models: string[];
  expires_at: string | null;
  user_id: string | null;
  username: string | null;
  user_display_name: string | null;
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
  username?: string | null;
  display_name?: string | null;
  user_label?: string | null;
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
  period_start?: string | null;
  period_end?: string | null;
  remaining_credits_micros?: number | null;
  plan_reserved_micros?: number | null;
  plan_included_credits_micros?: number | null;
  subscription_status?: string | null;
  points_balance?: number;
  points_lifetime_earned?: number;
  points_lifetime_spent?: number;
  lifetime_topup_micros?: number;
  tier?: TierSummary;
};

export type RiskGroupMember = {
  user_id: string;
  username: string;
  display_name: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  lifetime_topup_micros: number;
  plan_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  hit_count: number;
  preview: string | null;
  client_ips: string[];
};

export type RiskGroupEvent = {
  id: string;
  created_at: string;
  actor_user_id: string;
  actor_username: string;
  peer_user_id: string;
  peer_username: string;
  similarity: number;
  exact_match: boolean;
  gap_seconds: number;
  preview: string;
  peer_preview: string;
  client_ip: string | null;
  user_agent: string | null;
};

export type RiskGroup = {
  id: string;
  model: string;
  status: string;
  reason: string;
  sample_preview: string | null;
  max_similarity: number;
  min_gap_seconds: number | null;
  window_seconds: number | null;
  member_count: number;
  hit_count: number;
  created_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_action: string | null;
  ai_score: number | null;
  ai_verdict: string | null;
  ai_analyzed_at: string | null;
  members: RiskGroupMember[];
  events: RiskGroupEvent[];
};

export type RiskRadarReport = {
  hours: number;
  generated_at: string;
  summary: { open_groups: number; members: number; resolved: number };
  groups: RiskGroup[];
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

export type UserPublic = {
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
  linuxdo_uid: string | null;
  training_consent: boolean;
  tier: TierSummary;
};

export type PriceWindow = {
  start: string;
  end: string;
  days: number[];
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
};

export type ModelPrice = {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  reasoning_enabled: boolean;
  reasoning_effort: string[];
  image_input: boolean;
  context_window: number;
  max_output_tokens: number;
  enabled: boolean;
  windows?: PriceWindow[];
  prompt_preset_ids: string[];
  active_window_index?: number | null;
  created_at: string;
  updated_at: string;
};
export type PromptPresetSummary = { id: string; name: string; filename: string; size_bytes: number; created_at: string; updated_at: string };
export type PromptPreset = PromptPresetSummary & { content: string };
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
  visible: boolean;
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
  wechat_app_id?: string;
  wechat_serial_no?: string;
  wechat_private_key?: string;
  wechat_platform_certificate?: string;
  wechat_platform_serial_no?: string;
  wechat_native_enabled?: boolean;
  wechat_h5_enabled?: boolean;
  wechat_h5_type?: string;
  wechat_h5_app_name?: string;
  wechat_h5_app_url?: string;
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
  username?: string | null;
  display_name?: string | null;
  user_label?: string | null;
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

export type ModelTrendPoint = UsageTrendPoint & { model: string };

export type Settings = {
  admin_password_set?: boolean;
  admin_password_hint?: string;
  admin_token?: string;
  port: string;
  max_retries?: number;
  other_max_retries?: number;
  retry_delay_ms?: number;
  cache_enabled: boolean;
  cache_ttl_seconds: number;
  cache_max_entries: number;
  cache_methods: string[];
  cache_paths: string[];
  brand_name: string;
  brand_tagline?: string;
  brand_icon_url?: string | null;
  company_name: string;
  proxy_test_url: string;
  announcement_enabled?: boolean;
  announcement_title?: string;
  announcement_content?: string;
  announcement_banner?: boolean;
  announcement_popup?: boolean;
  announcement_updated_at?: string;
  public_base_url: string;
  admin_entry_path: string;
  registration_enabled: boolean;
  password_login_enabled: boolean;
  wallet_free_model_topup_required?: boolean;
  wallet_free_model_min_topup_micros?: number;
  wallet_free_prompt_claim_required?: boolean;
  linuxdo_registration_enabled?: boolean;
  checkin_enabled: boolean;
  checkin_points_min: number;
  checkin_points_max: number;
  points_balance_cap: number;
  points_exchange_rate: number;
  linuxdo_login_enabled?: boolean;
  linuxdo_client_id?: string;
  linuxdo_client_secret_set?: boolean;
  linuxdo_relay_url?: string;
  linuxdo_relay_secret_set?: boolean;
  linuxdo_configured?: boolean;
  linuxdo_callback_url?: string;
  linuxdo_authorize_ready?: boolean;
};

export type InstalledModule = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  active: boolean;
  features: string[];
  installed_at: string;
  updated_at: string;
};

export type PublicModule = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  features: string[];
};

export type Announcement = {
  enabled: boolean;
  title: string;
  content: string;
  /** Top sticky ticker bar. */
  banner: boolean;
  popup: boolean;
  updated_at: string;
};

export type Branding = {
  brand_name: string;
  brand_tagline?: string;
  company_name: string;
  public_base_url: string;
  icon_url?: string | null;
  announcement?: Announcement;
};

export type CheckinStatus = {
  settings: {
    enabled: boolean;
    points_min: number;
    points_max: number;
    balance_cap: number;
    exchange_rate: number;
  };
  points: {
    balance: number;
    lifetime_earned: number;
    lifetime_spent: number;
    held?: number;
    held_from_wallet?: number;
  };
  today: string;
  checked_in_today: boolean;
  today_points: number | null;
  at_balance_cap?: boolean;
  can_checkin?: boolean;
  recent_checkins: Array<{ id: string; checkin_date: string; points: number; created_at: string }>;
  recent_ledger: Array<{
    id: string;
    type: string;
    amount: number;
    balance_after: number;
    description: string;
    created_at: string;
  }>;
  wallet: Wallet | null;
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
    reorder: (ids: string[]) =>
      request<{ ok: boolean }>("/admin/api/providers/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
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
  proxies: {
    list: () => request<{ items: ProxyNode[]; libraries: ProxyLibrary[] }>("/admin/api/proxies"),
    create: (body: { name: string; url: string; enabled?: boolean }) =>
      request<ProxyNode>("/admin/api/proxies", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (id: string, body: Partial<{ name: string; url: string; enabled: boolean }>) =>
      request<ProxyNode>(`/admin/api/proxies/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/admin/api/proxies/${id}`, {
        method: "DELETE",
      }),
    libraryCreate: (body: {
      name: string;
      url: string;
      default_protocol?: string;
      enabled?: boolean;
      auto_update?: boolean;
      update_interval_ms?: number;
    }) =>
      request<ProxyLibrary>("/admin/api/proxies/libraries", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    libraryUpdate: (
      id: string,
      body: Partial<{
        name: string;
        url: string;
        default_protocol: string;
        enabled: boolean;
        auto_update: boolean;
        update_interval_ms: number;
      }>,
    ) =>
      request<ProxyLibrary>(`/admin/api/proxies/libraries/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    libraryRemove: (id: string) =>
      request<{ ok: boolean }>(`/admin/api/proxies/libraries/${id}`, {
        method: "DELETE",
      }),
    libraryRefresh: (id: string) =>
      request<{ added: number; removed: number; total: number; alive: number; dead: number; skipped?: boolean }>(
        `/admin/api/proxies/libraries/${id}/refresh`,
        { method: "POST" },
      ),
  },
  keys: {
    list: (params?: { limit?: number; offset?: number; q?: string }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      if (params?.q) search.set("q", params.q);
      const qs = search.toString();
      return request<{ items: ApiKeyRow[]; total: number; limit: number; offset: number }>(
        `/admin/api/keys${qs ? `?${qs}` : ""}`,
      );
    },
    create: (body: { name: string; rate_limit?: number; enabled?: boolean; daily_quota_micros?: number; monthly_quota_micros?: number }) =>
      request<ApiKeyRow>("/admin/api/keys", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: Partial<{ name: string; enabled: boolean; rate_limit: number; daily_quota_micros: number; monthly_quota_micros: number }>,
    ) =>
      request<ApiKeyRow>(`/admin/api/keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/admin/api/keys/${id}`, { method: "DELETE" }),
  },
  logs: {
    list: (params?: {
      limit?: number;
      offset?: number;
      q?: string;
      status?: string;
      method?: string;
      stream?: string;
      provider?: string;
      model?: string;
      user_id?: string;
    }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      if (params?.q) search.set("q", params.q);
      if (params?.status) search.set("status", params.status);
      if (params?.method) search.set("method", params.method);
      if (params?.stream) search.set("stream", params.stream);
      if (params?.provider) search.set("provider", params.provider);
      if (params?.model) search.set("model", params.model);
      if (params?.user_id) search.set("user_id", params.user_id);
      const qs = search.toString();
      return request<{ items: LogRow[]; total: number; limit: number; offset: number }>(
        `/admin/api/logs${qs ? `?${qs}` : ""}`,
      );
    },
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
      other_max_retries?: number;
      retry_delay_ms?: number;
      brand_name?: string;
      brand_tagline?: string;
      company_name?: string;
      proxy_test_url?: string;
      announcement_enabled?: boolean;
      announcement_title?: string;
      announcement_content?: string;
      announcement_banner?: boolean;
      announcement_popup?: boolean;
      public_base_url?: string;
      admin_entry_path?: string;
      registration_enabled?: boolean;
      password_login_enabled?: boolean;
      wallet_free_model_topup_required?: boolean;
      wallet_free_model_min_topup_micros?: number;
      wallet_free_prompt_claim_required?: boolean;
      linuxdo_registration_enabled?: boolean;
      checkin_enabled?: boolean;
      checkin_points_min?: number;
      checkin_points_max?: number;
      points_balance_cap?: number;
      points_exchange_rate?: number;
      linuxdo_login_enabled?: boolean;
      linuxdo_client_id?: string;
      linuxdo_client_secret?: string;
      linuxdo_relay_url?: string;
      linuxdo_relay_secret?: string;
    }) =>
      request<Settings>("/admin/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    uploadBrandIcon: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return request<Settings>("/admin/api/settings/brand-icon", { method: "POST", body: form, headers: {} });
    },
    removeBrandIcon: () => request<Settings>("/admin/api/settings/brand-icon", { method: "DELETE" }),
  },
  modules: {
    public: () => request<{ items: PublicModule[] }>("/modules/public", {}, { auth: false }),
    list: () => request<{ items: InstalledModule[] }>("/admin/api/modules"),
    install: async (file: File, activate = true) => {
      const form = new FormData();
      form.append("file", file);
      form.append("activate", activate ? "true" : "false");
      // Do not set Content-Type — browser must add multipart boundary.
      return request<InstalledModule>("/admin/api/modules/install", {
        method: "POST",
        body: form,
        headers: {},
      });
    },
    activate: (id: string) =>
      request<InstalledModule>(`/admin/api/modules/${encodeURIComponent(id)}/activate`, {
        method: "POST",
      }),
    deactivate: (id: string) =>
      request<InstalledModule>(`/admin/api/modules/${encodeURIComponent(id)}/deactivate`, {
        method: "POST",
      }),
    uninstall: (id: string, purgeSettings = false) =>
      request<{ ok: boolean }>(
        `/admin/api/modules/${encodeURIComponent(id)}?purgeSettings=${purgeSettings ? "1" : "0"}`,
        { method: "DELETE" },
      ),
  },
  commercial: {
    feedback: {
      list: () => request<{ items: FeedbackThread[] }>("/admin/api/commercial/feedback"),
      reply: (id: string, body: string, attachments: FeedbackAttachment[] = []) => request<{ messages: FeedbackMessage[] }>(`/admin/api/commercial/feedback/${id}/replies`, { method: "POST", body: JSON.stringify({ body, attachments }) }),
      status: (id: string, status: "open" | "resolved") => request<{ ok: boolean }>(`/admin/api/commercial/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    },
    users: {
      list: (params?: { limit?: number; offset?: number; q?: string; status?: string }) => {
        const search = new URLSearchParams();
        if (params?.limit != null) search.set("limit", String(params.limit));
        if (params?.offset != null) search.set("offset", String(params.offset));
        if (params?.q) search.set("q", params.q);
        if (params?.status) search.set("status", params.status);
        const qs = search.toString();
        return request<{ items: UserRow[]; total: number; limit: number; offset: number }>(
          `/admin/api/commercial/users${qs ? `?${qs}` : ""}`,
        );
      },
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
      batchStatus: (ids: string[], status: "active" | "suspended" | "disabled") =>
        request<{ ok: boolean; updated: number; ids: string[]; status: string }>(
          "/admin/api/commercial/users/batch/status",
          { method: "POST", body: JSON.stringify({ ids, status }) },
        ),
      batchDelete: (ids: string[]) =>
        request<{ ok: boolean; deleted: number; ids: string[] }>(
          "/admin/api/commercial/users/batch/delete",
          { method: "POST", body: JSON.stringify({ ids }) },
        ),
      adjustWallet: (id: string, amount_micros: number, description: string) =>
        request<Wallet>(`/admin/api/commercial/users/${id}/wallet`, {
          method: "POST",
          body: JSON.stringify({ amount_micros, description }),
        }),
      adjustPoints: (id: string, points: number, description: string) =>
        request<{ points: { balance: number; lifetime_earned: number; lifetime_spent: number } }>(
          `/admin/api/commercial/users/${id}/points`,
          { method: "POST", body: JSON.stringify({ points, description }) },
        ),
      adjustPlanCredits: (id: string, amount_micros: number, description: string) =>
        request<{ subscription: SubscriptionRow | null; amount_micros: number }>(
          `/admin/api/commercial/users/${id}/subscription/credits`,
          { method: "POST", body: JSON.stringify({ amount_micros, description }) },
        ),
      assignPlan: (id: string, plan_id: string, auto_renew = true) =>
        request<SubscriptionRow>(`/admin/api/commercial/users/${id}/subscription`, {
          method: "POST",
          body: JSON.stringify({ plan_id, auto_renew }),
        }),
      cancelPlan: (id: string) =>
        request<{ ok: boolean }>(`/admin/api/commercial/users/${id}/subscription`, { method: "DELETE" }),
    },
    riskRadar: (hours = 72) =>
      request<RiskRadarReport>(`/admin/api/commercial/risk-radar?hours=${hours}`),
    resolveRiskGroup: (id: string, action: "disabled" | "suspended" | "ignored") =>
      request<{ ok: boolean; group_id: string; action: string; updated: number; ids: string[] }>(
        `/admin/api/commercial/risk-radar/groups/${id}/resolve`,
        { method: "POST", body: JSON.stringify({ action }) },
      ),
    getRiskAIModel: () =>
      request<{ model: string }>(`/admin/api/commercial/risk-radar/ai-model`),
    setRiskAIModel: (model: string) =>
      request<{ ok: boolean; model: string }>(
        `/admin/api/commercial/risk-radar/ai-model`,
        { method: "POST", body: JSON.stringify({ model }) },
      ),
    analyzeRiskGroup: (id: string) =>
      request<{ score: number; verdict: string; analyzed_at: string }>(
        `/admin/api/commercial/risk-radar/groups/${id}/analyze`,
        { method: "POST" },
      ),
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
    promptPresets: {
      list: () => request<{ items: PromptPresetSummary[] }>("/admin/api/commercial/prompt-presets"),
      get: (id: string) => request<PromptPreset>(`/admin/api/commercial/prompt-presets/${id}`),
      create: (body: { name: string; filename?: string; content: string }) =>
        request<PromptPreset>("/admin/api/commercial/prompt-presets", { method: "POST", body: JSON.stringify(body) }),
      remove: (id: string) =>
        request<{ ok: boolean }>(`/admin/api/commercial/prompt-presets/${id}`, { method: "DELETE" }),
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
        visible: boolean;
      }>) =>
        request<PlanRow>(`/admin/api/commercial/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<{ ok: boolean }>(`/admin/api/commercial/plans/${id}`, { method: "DELETE" }),
      reorder: (ids: string[]) =>
        request<{ items: PlanRow[] }>("/admin/api/commercial/plans/reorder", {
          method: "PUT",
          body: JSON.stringify({ ids }),
        }),
    },
    usage: (params?: { limit?: number; offset?: number; user_id?: string }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      if (params?.user_id) search.set("user_id", params.user_id);
      const qs = search.toString();
      return request<{ items: UsageRow[]; total: number; limit: number; offset: number }>(
        `/admin/api/commercial/usage${qs ? `?${qs}` : ""}`,
      );
    },
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
      orders: (params?: { status?: string; limit?: number; offset?: number }) => {
        const search = new URLSearchParams();
        if (params?.limit != null) search.set("limit", String(params.limit));
        if (params?.offset != null) search.set("offset", String(params.offset));
        if (params?.status) search.set("status", params.status);
        const qs = search.toString();
        return request<{ items: PaymentOrder[]; total: number; limit: number; offset: number }>(
          `/admin/api/commercial/payments/orders${qs ? `?${qs}` : ""}`,
        );
      },
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
  config: () =>
    request<{
      registration_enabled: boolean;
      password_registration_enabled?: boolean;
      password_login_enabled?: boolean;
      linuxdo_enabled: boolean;
      linuxdo_login_enabled?: boolean;
      linuxdo_registration_enabled?: boolean;
      captcha_enabled: boolean;
      checkin_enabled?: boolean;
    }>("/user/api/config", {}, { auth: false }),
  captcha: () =>
    request<{ captcha_id: string; image: string; expires_in: number }>("/user/api/captcha", {}, { auth: false }),
  login: (username: string, password: string) =>
    request<{ token: string; expires_at: string; user: UserRow }>(
      "/user/api/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      { auth: false },
    ),
  register: (username: string, password: string, display_name: string | undefined, captcha_id: string, captcha_answer: string) =>
    request<{ token: string; expires_at: string; user: UserRow }>(
      "/user/api/register",
      { method: "POST", body: JSON.stringify({ username, password, display_name, captcha_id, captcha_answer }) },
      { auth: false },
    ),
  logout: () => request<{ ok: boolean }>("/user/api/logout", { method: "POST" }, { auth: "user" }),
  linuxdoExchange: (code: string) =>
    request<{ token: string; expires_at: string }>(
      "/user/api/auth/linuxdo/exchange",
      { method: "POST", body: JSON.stringify({ code }) },
      { auth: false },
    ),
  oauth: {
    authorize: (state: string, action: "allow" | "deny") =>
      request<{ ok: boolean }>(
        "/oauth/authorize",
        { method: "POST", body: JSON.stringify({ state, action }) },
        { auth: "user" },
      ),
  },
  me: () =>
    request<{ user: UserPublic; wallet: Wallet | null; tier: TierSummary; all_tiers: UserTier[]; subscription: SubscriptionRow | null; prices: ModelPrice[] }>(
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
      trendByModel: ModelTrendPoint[];
    }>("/user/api/dashboard", {}, { auth: "user" }),
  keys: {
    list: (params?: { limit?: number; offset?: number }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      const qs = search.toString();
      return request<{ items: ApiKeyRow[]; total: number; limit: number; offset: number }>(
        `/user/api/keys${qs ? `?${qs}` : ""}`,
        {},
        { auth: "user" },
      );
    },
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
  updatePreferences: (preferences: { training_consent?: boolean }) =>
    request<{ ok: boolean }>(
      "/user/api/me/preferences",
      { method: "PATCH", body: JSON.stringify(preferences) },
      { auth: "user" },
    ),
  usage: (params?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit != null) search.set("limit", String(params.limit));
    if (params?.offset != null) search.set("offset", String(params.offset));
    const qs = search.toString();
    return request<{ items: UsageRow[]; total: number; limit: number; offset: number }>(
      `/user/api/usage${qs ? `?${qs}` : ""}`,
      {},
      { auth: "user" },
    );
  },
  checkin: {
    status: () => request<CheckinStatus>("/user/api/checkin", {}, { auth: "user" }),
    perform: () =>
      request<{
        record: { id: string; checkin_date: string; points: number; created_at: string };
        points: { balance: number; lifetime_earned: number; lifetime_spent: number };
        status: CheckinStatus;
      }>("/user/api/checkin", { method: "POST" }, { auth: "user" }),
    exchange: (points: number) =>
      request<{
        points_spent: number;
        balance_credited_micros: number;
        points: { balance: number; lifetime_earned: number; lifetime_spent: number };
        wallet: Wallet | null;
        status: CheckinStatus;
      }>("/user/api/points/exchange", { method: "POST", body: JSON.stringify({ points }) }, { auth: "user" }),
  },
  commerce: {
    orders: (params?: { limit?: number; offset?: number }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      const qs = search.toString();
      return request<{ items: CommerceOrder[]; total: number; limit: number; offset: number }>(
        `/user/api/commerce/orders${qs ? `?${qs}` : ""}`,
        {},
        { auth: "user" },
      );
    },
    ledger: (params?: { limit?: number; offset?: number }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      const qs = search.toString();
      return request<{ items: WalletLedgerRow[]; total: number; limit: number; offset: number }>(
        `/user/api/commerce/ledger${qs ? `?${qs}` : ""}`,
        {},
        { auth: "user" },
      );
    },
  },
  payments: {
    config: () => request<{ channel: PaymentChannel | null; channels: PaymentChannel[] }>("/user/api/payments/config", {}, { auth: "user" }),
    orders: (params?: { limit?: number; offset?: number }) => {
      const search = new URLSearchParams();
      if (params?.limit != null) search.set("limit", String(params.limit));
      if (params?.offset != null) search.set("offset", String(params.offset));
      const qs = search.toString();
      return request<{ items: PaymentOrder[]; total: number; limit: number; offset: number }>(
        `/user/api/payments/orders${qs ? `?${qs}` : ""}`,
        {},
        { auth: "user" },
      );
    },
    createTopup: (
      amount: string,
      channel_id?: string,
      mode?: "page" | "wap" | "native" | "h5",
      client_request_id?: string,
    ) =>
      request<PaymentOrder>(
        "/user/api/payments/topups",
        {
          method: "POST",
          body: JSON.stringify({ amount, channel_id, mode, client_request_id }),
        },
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
