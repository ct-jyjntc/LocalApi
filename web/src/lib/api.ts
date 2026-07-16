const TOKEN_KEY = "localapi_admin_token";

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
  opts?: { auth?: boolean },
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (opts?.auth !== false) {
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
};
