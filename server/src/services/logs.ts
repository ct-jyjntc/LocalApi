import { v4 as uuid } from "uuid";
import { db, RequestLog } from "../db";
import { nowIso } from "../utils/time";

type LogInput = {
  method: string;
  path: string;
  model?: string | null;
  provider_id?: string | null;
  provider_name?: string | null;
  api_key_id?: string | null;
  api_key_name?: string | null;
  status_code: number;
  latency_ms: number;
  cached?: boolean;
  request_bytes?: number;
  response_bytes?: number;
  error?: string | null;
  input_text?: string | null;
  output_text?: string | null;
  reasoning_text?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  total_tokens?: number;
  usage_estimated?: boolean;
  stream?: boolean;
  user_id?: string | null;
  usage_id?: string | null;
  cost_micros?: number;
};

const pendingLogs: Array<LogInput & { id: string }> = [];
const MAX_PENDING_LOGS = 10_000;
const STORE_LOG_CONTENT = process.env.LOG_CONTENT === "true";
const MAX_LOG_ROWS = Number(process.env.MAX_LOG_ROWS || 5_000);
let insertLogStatement: ReturnType<typeof db.prepare> | null = null;
let logsSincePrune = 0;

type DashboardStats = ReturnType<typeof computeDashboardStats>;
let dashboardCache: { at: number; value: DashboardStats } | null = null;
const DASHBOARD_TTL_MS = 5_000;

function invalidateDashboardCache() {
  dashboardCache = null;
}

export function flushLogs(limit = 500) {
  if (pendingLogs.length === 0) return;
  const rows = pendingLogs.splice(0, Math.min(limit, pendingLogs.length));
  try {
    const insert = insertLogStatement ??= db.prepare(
    `INSERT INTO request_logs (
      id, method, path, model, provider_id, provider_name, api_key_id, api_key_name,
      status_code, latency_ms, cached, request_bytes, response_bytes, error, created_at,
      input_text, output_text, reasoning_text,
      prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, total_tokens, usage_estimated, stream
      , user_id, usage_id, cost_micros
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const input of rows) {
        insert.run(
          input.id,
          input.method.toUpperCase(),
          input.path,
          input.model ?? null,
          input.provider_id ?? null,
          input.provider_name ?? null,
          input.api_key_id ?? null,
          input.api_key_name ?? null,
          input.status_code,
          input.latency_ms,
          input.cached ? 1 : 0,
          input.request_bytes ?? 0,
          input.response_bytes ?? 0,
          input.error ?? null,
          nowIso(),
          input.input_text ?? null,
          input.output_text ?? null,
          input.reasoning_text ?? null,
          input.prompt_tokens ?? 0,
          input.completion_tokens ?? 0,
          input.reasoning_tokens ?? 0,
          input.cached_tokens ?? 0,
          input.total_tokens ?? 0,
          input.usage_estimated ? 1 : 0,
          input.stream ? 1 : 0,
          input.user_id ?? null,
          input.usage_id ?? null,
          input.cost_micros ?? 0,
        );
      }
      logsSincePrune += rows.length;
      if (logsSincePrune >= 500) {
        const keep = Number.isFinite(MAX_LOG_ROWS) && MAX_LOG_ROWS > 0 ? MAX_LOG_ROWS : 5_000;
        db.prepare(
          `DELETE FROM request_logs WHERE id IN (
            SELECT id FROM request_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?
          )`,
        ).run(keep);
        logsSincePrune = 0;
      }
    })();
    invalidateDashboardCache();
  } catch {
    pendingLogs.unshift(...rows);
    if (pendingLogs.length > MAX_PENDING_LOGS) {
      pendingLogs.splice(0, pendingLogs.length - MAX_PENDING_LOGS);
    }
  }
}

const logTimer = setInterval(flushLogs, 200);
logTimer.unref?.();
process.once("beforeExit", () => flushLogs(Number.MAX_SAFE_INTEGER));

export function writeLog(input: LogInput) {
  const id = uuid();
  pendingLogs.push({
    ...input,
    id,
    input_text: STORE_LOG_CONTENT ? input.input_text : null,
    output_text: STORE_LOG_CONTENT ? input.output_text : null,
    reasoning_text: STORE_LOG_CONTENT ? input.reasoning_text : null,
  });
  if (pendingLogs.length > MAX_PENDING_LOGS) {
    pendingLogs.splice(0, pendingLogs.length - MAX_PENDING_LOGS);
  }

  return id;
}

type RequestLogWithUser = RequestLog & {
  username?: string | null;
  display_name?: string | null;
};

function mapLog(l: RequestLogWithUser) {
  const username = l.username?.trim() || null;
  const displayName = l.display_name?.trim() || null;
  return {
    ...l,
    cached: l.cached === 1,
    stream: l.stream === 1,
    input_text: l.input_text ?? null,
    output_text: l.output_text ?? null,
    reasoning_text: l.reasoning_text ?? null,
    prompt_tokens: l.prompt_tokens ?? 0,
    completion_tokens: l.completion_tokens ?? 0,
    reasoning_tokens: l.reasoning_tokens ?? 0,
    cached_tokens: l.cached_tokens ?? 0,
    total_tokens: l.total_tokens ?? 0,
    usage_estimated: l.usage_estimated === 1,
    cost_micros: l.cost_micros ?? 0,
    username,
    display_name: displayName,
    user_label: displayName || username || null,
  };
}

export type ListLogsFilter = {
  limit?: number;
  offset?: number;
  userId?: string;
  /** Free-text search across path/model/user/provider/error/key. */
  q?: string;
  /** all | success | error */
  status?: string;
  method?: string;
  /** all | stream | nonstream */
  stream?: string;
  provider?: string;
  model?: string;
};

export function listLogs(limit = 100, offset = 0, userId?: string) {
  return listLogsFiltered({ limit, offset, userId });
}

export function listLogsFiltered(input: ListLogsFilter = {}) {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.userId) {
    conditions.push("l.user_id = ?");
    params.push(input.userId);
  }

  const q = String(input.q || "").trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    conditions.push(
      `(l.path LIKE ? COLLATE NOCASE
        OR IFNULL(l.model, '') LIKE ? COLLATE NOCASE
        OR IFNULL(l.provider_name, '') LIKE ? COLLATE NOCASE
        OR IFNULL(l.api_key_name, '') LIKE ? COLLATE NOCASE
        OR IFNULL(l.error, '') LIKE ? COLLATE NOCASE
        OR IFNULL(u.username, '') LIKE ? COLLATE NOCASE
        OR IFNULL(u.display_name, '') LIKE ? COLLATE NOCASE)`,
    );
    params.push(like, like, like, like, like, like, like);
  }

  const status = String(input.status || "all").toLowerCase();
  if (status === "success" || status === "ok") {
    conditions.push("l.status_code < 400");
  } else if (status === "error" || status === "fail" || status === "failed") {
    conditions.push("l.status_code >= 400");
  }

  const method = String(input.method || "").trim().toUpperCase();
  if (method && method !== "ALL") {
    conditions.push("UPPER(l.method) = ?");
    params.push(method);
  }

  const stream = String(input.stream || "all").toLowerCase();
  if (stream === "stream" || stream === "1" || stream === "yes") {
    conditions.push("l.stream = 1");
  } else if (stream === "nonstream" || stream === "0" || stream === "no") {
    conditions.push("l.stream = 0");
  }

  const provider = String(input.provider || "").trim();
  if (provider) {
    conditions.push("(l.provider_name LIKE ? COLLATE NOCASE OR IFNULL(l.provider_id, '') = ?)");
    params.push(`%${provider.replace(/[%_]/g, "")}%`, provider);
  }

  const model = String(input.model || "").trim();
  if (model) {
    conditions.push("IFNULL(l.model, '') LIKE ? COLLATE NOCASE");
    params.push(`%${model.replace(/[%_]/g, "")}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const fromSql = `
    FROM request_logs l
    LEFT JOIN users u ON u.id = l.user_id
    ${where}
  `;

  const total = (
    db.prepare(`SELECT COUNT(*) AS c ${fromSql}`).get(...params) as { c: number }
  ).c;

  const items = db
    .prepare(
      `SELECT
         l.id, l.method, l.path, l.model, l.provider_id, l.provider_name, l.api_key_id, l.api_key_name,
         l.status_code, l.latency_ms, l.cached, l.request_bytes, l.response_bytes, l.error, l.created_at,
         NULL AS input_text, NULL AS output_text, NULL AS reasoning_text,
         l.prompt_tokens, l.completion_tokens, l.reasoning_tokens, l.cached_tokens, l.total_tokens, l.usage_estimated, l.stream,
         l.user_id, l.usage_id, l.cost_micros,
         u.username AS username,
         u.display_name AS display_name
       ${fromSql}
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RequestLogWithUser[];

  return {
    items: items.map(mapLog),
    total,
    limit,
    offset,
  };
}

export function getLog(id: string, userId?: string) {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const row = db
    .prepare(
      `SELECT l.*, u.username AS username, u.display_name AS display_name
       FROM request_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.id = ? ${userId ? "AND l.user_id = ?" : ""}`,
    )
    .get(...(userId ? [id, userId] : [id])) as RequestLogWithUser | undefined;
  return row ? mapLog(row) : null;
}

export function clearLogs() {
  flushLogs(Number.MAX_SAFE_INTEGER);
  invalidateDashboardCache();
  return db.prepare("DELETE FROM request_logs").run().changes;
}

/** Drop stored prompt/response bodies to reclaim disk and speed up scans. */
export function stripLogContent() {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const result = db
    .prepare(
      `UPDATE request_logs
       SET input_text = NULL, output_text = NULL, reasoning_text = NULL
       WHERE input_text IS NOT NULL OR output_text IS NOT NULL OR reasoning_text IS NOT NULL`,
    )
    .run();
  invalidateDashboardCache();
  return result.changes;
}

function computeDashboardStats() {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) as cached,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
         AVG(latency_ms) as avg_latency,
         SUM(request_bytes) as req_bytes,
         SUM(response_bytes) as res_bytes,
         SUM(prompt_tokens) as prompt_tokens,
         SUM(completion_tokens) as completion_tokens,
         SUM(reasoning_tokens) as reasoning_tokens,
         SUM(cached_tokens) as cached_tokens
       FROM request_logs`,
    )
    .get() as {
    total: number;
    cached: number;
    errors: number;
    avg_latency: number | null;
    req_bytes: number | null;
    res_bytes: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    reasoning_tokens: number | null;
    cached_tokens: number | null;
  };

  const last24h = db
    .prepare(
      `SELECT COUNT(*) as c FROM request_logs
       WHERE created_at >= datetime('now', '-1 day')`,
    )
    .get() as { c: number };

  const providers = (
    db.prepare("SELECT COUNT(*) as c FROM providers WHERE enabled = 1").get() as {
      c: number;
    }
  ).c;

  const keys = (
    db.prepare("SELECT COUNT(*) as c FROM api_keys WHERE enabled = 1").get() as {
      c: number;
    }
  ).c;

  const cacheEntries = (
    db.prepare("SELECT COUNT(*) as c FROM cache_entries").get() as { c: number }
  ).c;

  const recent = db
    .prepare(
      `SELECT id, method, path, model, status_code, latency_ms, cached, created_at,
              prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, total_tokens
       FROM request_logs ORDER BY created_at DESC LIMIT 12`,
    )
    .all() as Array<{
    id: string;
    method: string;
    path: string;
    model: string | null;
    status_code: number;
    latency_ms: number;
    cached: number;
    created_at: string;
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    cached_tokens: number;
    total_tokens: number;
  }>;

  const byHour = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:00', created_at) as bucket,
              COUNT(*) as count,
              SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) as cached_count
       FROM request_logs
       WHERE created_at >= datetime('now', '-24 hours')
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all() as Array<{ bucket: string; count: number; cached_count: number }>;

  return {
    totalRequests: totals.total || 0,
    // requests where upstream reported cached_tokens > 0
    cachedRequests: totals.cached || 0,
    errorRequests: totals.errors || 0,
    avgLatencyMs: Math.round(totals.avg_latency || 0),
    requestBytes: totals.req_bytes || 0,
    responseBytes: totals.res_bytes || 0,
    promptTokens: totals.prompt_tokens || 0,
    completionTokens: totals.completion_tokens || 0,
    reasoningTokens: totals.reasoning_tokens || 0,
    cachedTokens: totals.cached_tokens || 0,
    last24h: last24h.c || 0,
    providers,
    keys,
    cacheEntries,
    // share of requests with upstream prompt-cache tokens
    hitRate:
      (totals.total || 0) > 0 ? (totals.cached || 0) / (totals.total || 1) : 0,
    recent: recent.map((r) => ({
      ...r,
      cached: (r.cached_tokens ?? 0) > 0 || r.cached === 1,
      cached_tokens: r.cached_tokens ?? 0,
      prompt_tokens: r.prompt_tokens ?? 0,
      completion_tokens: r.completion_tokens ?? 0,
      reasoning_tokens: r.reasoning_tokens ?? 0,
    })),
    byHour,
  };
}

export function getDashboardStats() {
  const now = Date.now();
  if (dashboardCache && now - dashboardCache.at < DASHBOARD_TTL_MS) {
    return dashboardCache.value;
  }
  const value = computeDashboardStats();
  dashboardCache = { at: now, value };
  return value;
}
