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
let insertLogStatement: ReturnType<typeof db.prepare> | null = null;
let logsSincePrune = 0;

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
        db.prepare(
          `DELETE FROM request_logs WHERE id IN (
            SELECT id FROM request_logs ORDER BY created_at DESC LIMIT -1 OFFSET 5000
          )`,
        ).run();
        logsSincePrune = 0;
      }
    })();
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

function mapLog(l: RequestLog) {
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
  };
}

export function listLogs(limit = 100, offset = 0, userId?: string) {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const items = db
    .prepare(
      `SELECT
         id, method, path, model, provider_id, provider_name, api_key_id, api_key_name,
         status_code, latency_ms, cached, request_bytes, response_bytes, error, created_at,
         NULL AS input_text, NULL AS output_text, NULL AS reasoning_text,
         prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, total_tokens, usage_estimated, stream,
         user_id, usage_id, cost_micros
       FROM request_logs ${userId ? "WHERE user_id = ?" : ""}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...(userId ? [userId, limit, offset] : [limit, offset])) as RequestLog[];
  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM request_logs ${userId ? "WHERE user_id = ?" : ""}`)
      .get(...(userId ? [userId] : [])) as { c: number }
  ).c;
  return {
    items: items.map(mapLog),
    total,
  };
}

export function getLog(id: string, userId?: string) {
  flushLogs(Number.MAX_SAFE_INTEGER);
  const row = db.prepare(`SELECT * FROM request_logs WHERE id = ? ${userId ? "AND user_id = ?" : ""}`)
    .get(...(userId ? [id, userId] : [id])) as
    | RequestLog
    | undefined;
  return row ? mapLog(row) : null;
}

export function clearLogs() {
  flushLogs(Number.MAX_SAFE_INTEGER);
  return db.prepare("DELETE FROM request_logs").run().changes;
}

export function getDashboardStats() {
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
