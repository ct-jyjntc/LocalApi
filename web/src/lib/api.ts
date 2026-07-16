const TOKEN_KEY = "localapi_admin_token";
const USER_TOKEN_KEY = "localapi_user_token";

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

export type PlanRow = {
  id: string;
  name: string;
  description: string;
  cycle_days: number;
  included_credits_micros: number;
  allowed_models: string[];
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  overage_enabled: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  period_start: string;
  period_end: string;
  remaining_credits_micros: number;
  reserved_micros: number;
  auto_renew: number;
  plan: PlanRow;
};

export type Wallet = {
  user_id: string;
  balance_micros: number;
  reserved_micros: number;
  lifetime_spent_micros: number;
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
};

export const api = {
  login: (password: string) =>
    request<{ ok: boolean }>(
      "/admin/api/login",
      {
        method: "POST",
        body: JSON.stringify({ password }),
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
    list: (limit = 100) =>
      request<{ items: LogRow[]; total: number }>(
        `/admin/api/logs?limit=${limit}`,
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
    }) =>
      request<Settings>("/admin/api/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },
  commercial: {
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
      create: (body: Omit<PlanRow, "id" | "created_at" | "updated_at">) =>
        request<PlanRow>("/admin/api/commercial/plans", { method: "POST", body: JSON.stringify(body) }),
      update: (id: string, body: Partial<PlanRow>) =>
        request<PlanRow>(`/admin/api/commercial/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
      remove: (id: string) => request<{ ok: boolean }>(`/admin/api/commercial/plans/${id}`, { method: "DELETE" }),
    },
    usage: (limit = 200) => request<{ items: UsageRow[] }>(`/admin/api/commercial/usage?limit=${limit}`),
  },
};

export const userApi = {
  login: (username: string, password: string) =>
    request<{ token: string; expires_at: string; user: UserRow }>(
      "/user/api/login",
      { method: "POST", body: JSON.stringify({ username, password }) },
      { auth: false },
    ),
  logout: () => request<{ ok: boolean }>("/user/api/logout", { method: "POST" }, { auth: "user" }),
  me: () =>
    request<{ user: UserRow; wallet: Wallet | null; subscription: SubscriptionRow | null; prices: ModelPrice[] }>(
      "/user/api/me",
      {},
      { auth: "user" },
    ),
  dashboard: () =>
    request<{
      user: UserRow;
      wallet: Wallet | null;
      subscription: SubscriptionRow | null;
      totals: { requests: number; cost_micros: number; prompt_tokens: number; completion_tokens: number; cached_tokens: number };
      recent: UsageRow[];
    }>("/user/api/dashboard", {}, { auth: "user" }),
  keys: {
    list: () => request<{ items: ApiKeyRow[] }>("/user/api/keys", {}, { auth: "user" }),
    create: (body: Partial<ApiKeyRow> & { name: string }) =>
      request<ApiKeyRow>("/user/api/keys", { method: "POST", body: JSON.stringify(body) }, { auth: "user" }),
    update: (id: string, body: Partial<ApiKeyRow>) =>
      request<ApiKeyRow>(`/user/api/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }, { auth: "user" }),
    remove: (id: string) => request<{ ok: boolean }>(`/user/api/keys/${id}`, { method: "DELETE" }, { auth: "user" }),
  },
  usage: (limit = 200) => request<{ items: UsageRow[] }>(`/user/api/usage?limit=${limit}`, {}, { auth: "user" }),
};
