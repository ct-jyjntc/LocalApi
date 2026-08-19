import { ApiKey, db, getSetting } from "../db";
import { estimateRequestTokens, getModelPrice } from "./billing";
import { consumeRateLimit } from "./rate-limit";
import { getActiveSubscription, maintainActiveSubscription } from "./plans";
import { getUser } from "./users";
import { resolveUserTier } from "./tiers";
import { observeWalletFreePrompt } from "./free-prompt-claims";

export class AccessError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type TokenWindow = {
  startedAt: number;
  used: number;
  reserved: number;
};

/** Max time a single request may hold a concurrency slot (self-heal leaks). */
const CONCURRENCY_HOLD_MAX_MS = Math.max(
  60_000,
  Number(process.env.CONCURRENCY_HOLD_MAX_MS || 12 * 60_000) || 12 * 60_000,
);

type ConcurrencyState = {
  /** Monotonic acquire timestamps still held. */
  holds: number[];
};

const tokenWindows = new Map<string, TokenWindow>();
const concurrency = new Map<string, ConcurrencyState>();

function parseModels(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function allows(models: string[], model: string) {
  return models.length === 0 || models.includes("*") || models.includes(model);
}

/** Wallet-only gate: a free model is one with all listed prices at zero. */
export const WALLET_FREE_MODEL_MIN_TOPUP_MICROS_DEFAULT = 1_000_000;

export function isWalletFreeModelTopupRequired() {
  return (getSetting("wallet_free_model_topup_required") ?? "true") === "true";
}

export function walletFreeModelMinTopupMicros() {
  const raw = Number(getSetting("wallet_free_model_min_topup_micros") ?? WALLET_FREE_MODEL_MIN_TOPUP_MICROS_DEFAULT);
  if (!Number.isFinite(raw) || raw <= 0) return WALLET_FREE_MODEL_MIN_TOPUP_MICROS_DEFAULT;
  return Math.floor(raw);
}

export function isFreePricedModel(model: string) {
  const price = getModelPrice(model);
  if (!price) return false;
  return (
    Number(price.input_price_micros || 0) <= 0 &&
    Number(price.output_price_micros || 0) <= 0 &&
    Number(price.cache_read_price_micros || 0) <= 0 &&
    Number(price.cache_write_price_micros || 0) <= 0
  );
}

function reserveTokenWindow(scope: string, limit: number, estimated: number) {
  if (limit <= 0) return { settle: (_actual: number) => undefined };
  const now = Date.now();
  let state = tokenWindows.get(scope);
  if (!state || now - state.startedAt >= 60_000) {
    state = { startedAt: now, used: 0, reserved: 0 };
    tokenWindows.set(scope, state);
  }
  if (state.used + state.reserved + estimated > limit) {
    throw new AccessError(
      429,
      "tpm_limit_exceeded",
      "Token-per-minute limit exceeded",
      Math.ceil((60_000 - (now - state.startedAt)) / 1000),
    );
  }
  state.reserved += estimated;
  let settled = false;
  return {
    settle(actual: number) {
      if (settled) return;
      settled = true;
      state!.reserved = Math.max(0, state!.reserved - estimated);
      state!.used += Math.max(0, actual);
    },
  };
}

function pruneConcurrencyHolds(state: ConcurrencyState, now = Date.now()) {
  const cutoff = now - CONCURRENCY_HOLD_MAX_MS;
  if (state.holds.length === 0) return 0;
  // Holds are roughly chronological; drop anything older than max lifetime.
  state.holds = state.holds.filter((startedAt) => startedAt >= cutoff);
  return state.holds.length;
}

function activeConcurrency(scope: string, now = Date.now()) {
  const state = concurrency.get(scope);
  if (!state) return 0;
  const count = pruneConcurrencyHolds(state, now);
  if (count === 0) concurrency.delete(scope);
  return count;
}

function yuan(micros: number) {
  return `¥${(micros / 1_000_000).toFixed(2)}`;
}

function secondsUntilNextShanghaiMidnight() {
  const shifted = Date.now() + 8 * 3600_000;
  const nextShifted = Math.ceil(shifted / 86_400_000) * 86_400_000;
  return Math.max(1, Math.ceil((nextShifted - 8 * 3600_000 - Date.now()) / 1000));
}

function secondsUntilNextShanghaiMonth() {
  const shifted = new Date(Date.now() + 8 * 3600_000);
  const nextUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - 8 * 3600_000;
  return Math.max(1, Math.ceil((nextUtc - Date.now()) / 1000));
}

/**
 * Per-key spend budgets (day / month, UTC+8 boundaries). Counts completed
 * charges plus in-flight reservations so a burst of parallel requests cannot
 * blow past the cap before the first request settles.
 */
function enforceKeyQuotas(key: ApiKey) {
  const daily = Math.max(0, key.daily_quota_micros || 0);
  const monthly = Math.max(0, key.monthly_quota_micros || 0);
  if (daily <= 0 && monthly <= 0) return;
  const shifted = new Date(Date.now() + 8 * 3600_000);
  const monthStartUtc = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 3600_000,
  ).toISOString();
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN day = strftime('%Y-%m-%d', 'now', '+8 hours') THEN v ELSE 0 END), 0) AS used_today,
       COALESCE(SUM(v), 0) AS used_month
     FROM (
       SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS day,
              CASE WHEN status = 'completed' THEN cost_micros
                   WHEN status = 'pending' THEN reserved_plan_micros + reserved_wallet_micros
                   ELSE 0 END AS v
       FROM usage_records
       WHERE api_key_id = ? AND created_at >= ?
     )`,
  ).get(key.id, monthStartUtc) as { used_today: number; used_month: number };
  if (daily > 0 && row.used_today >= daily) {
    throw new AccessError(
      429,
      "daily_quota_exceeded",
      `Daily quota exceeded for this API key: used ${yuan(row.used_today)} of ${yuan(daily)} (resets at 00:00 UTC+8)`,
      secondsUntilNextShanghaiMidnight(),
    );
  }
  if (monthly > 0 && row.used_month >= monthly) {
    throw new AccessError(
      429,
      "monthly_quota_exceeded",
      `Monthly quota exceeded for this API key: used ${yuan(row.used_month)} of ${yuan(monthly)} (resets on the 1st, UTC+8)`,
      secondsUntilNextShanghaiMonth(),
    );
  }
}

export type RequestAccess = {
  userId: string | null;
  release: (actualTokens: number) => void;
};

export function isModelAllowedForKey(key: ApiKey, model: string, options: { includeSubscription?: boolean } = {}) {
  const user = key.user_id ? getUser(key.user_id) : null;
  if (key.user_id && (!user || user.status !== "active")) return false;
  if (!user) return allows(parseModels(key.allowed_models), model);
  if (options.includeSubscription === false) return true;
  const subscription = getActiveSubscription(user.id);
  return Boolean(subscription && allows(parseModels(subscription.plan.allowed_models), model));
}

export function beginRequestAccess(
  key: ApiKey,
  model: string | null,
  body: unknown,
  options: {
    billingMode?: "wallet" | "coding";
    estimatedTokens?: { prompt: number; completion: number };
    clientIp?: string | null;
    userAgent?: string | null;
    apiKeyId?: string | null;
  } = {},
): RequestAccess {
  const billingMode = options.billingMode ?? "wallet";
  const user = key.user_id ? getUser(key.user_id) : null;
  if (key.user_id && (!user || user.status !== "active")) {
    throw new AccessError(403, "user_suspended", "User account is not active");
  }
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    throw new AccessError(401, "api_key_expired", "API key has expired");
  }

  const subscription = billingMode === "coding" && user ? maintainActiveSubscription(user.id) : null;
  const tier = billingMode === "wallet" && user ? resolveUserTier(user.id).current : null;
  if (billingMode === "coding" && key.user_id && !subscription) {
    throw new AccessError(402, "coding_plan_required", "An active Coding Plan is required for /coding requests");
  }
  if (model) {
    if (!isModelAllowedForKey(key, model, { includeSubscription: billingMode === "coding" })) {
      const allowedSource = billingMode === "coding"
        ? parseModels(subscription?.plan.allowed_models)
        : parseModels(key.allowed_models);
      const hint = allowedSource.length > 0 && !allowedSource.includes("*")
        ? ` Allowed models for this account: ${allowedSource.join(", ")}.`
        : "";
      throw new AccessError(403, "model_not_allowed", `Model ${model} is not allowed for this account.${hint}`);
    }
    if (billingMode === "wallet" && user && isFreePricedModel(model)) {
      if (isWalletFreeModelTopupRequired()) {
        const topup = resolveUserTier(user.id).lifetime_topup_micros;
        const required = walletFreeModelMinTopupMicros();
        if (topup < required) {
          throw new AccessError(
            402,
            "free_model_topup_required",
            `Free models on the API endpoint require a lifetime top-up of at least ¥${(required / 1_000_000).toFixed(required % 1_000_000 === 0 ? 0 : 2)}. Coding Plan users should call /coding instead.`,
          );
        }
      }
      observeWalletFreePrompt(user.id, model, body, {
        clientIp: options.clientIp,
        userAgent: options.userAgent,
        apiKeyId: options.apiKeyId ?? key.id,
      });
    }
  }

  enforceKeyQuotas(key);

  const planRpm = user
    ? (billingMode === "coding" ? subscription?.plan.rpm_limit || 0 : tier?.rpm_limit || 0)
    : 0;
  const keyRpm = Math.max(0, key.rate_limit || 0);
  // A key-level RPM cap can only tighten the plan/tier limit, never raise it.
  const rpm = user
    ? (planRpm > 0 && keyRpm > 0 ? Math.min(planRpm, keyRpm) : planRpm || keyRpm)
    : keyRpm;
  const accessScope = `${billingMode}:${user?.id || key.id}`;
  const rpmState = consumeRateLimit(`commercial:rpm:${accessScope}`, rpm);
  if (!rpmState.allowed) {
    throw new AccessError(
      429,
      "rpm_limit_exceeded",
      "Request-per-minute limit exceeded",
      Math.ceil(rpmState.retryAfterMs / 1000),
    );
  }

  const limit = user
    ? (billingMode === "coding" ? subscription?.plan.concurrency_limit || 0 : tier?.concurrency_limit || 0)
    : key.concurrency_limit;
  const concurrencyScope = `commercial:concurrency:${accessScope}`;
  const now = Date.now();
  const active = activeConcurrency(concurrencyScope, now);
  if (limit > 0 && active >= limit) {
    throw new AccessError(429, "concurrency_limit_exceeded", "Concurrent request limit exceeded", 1);
  }
  let state = concurrency.get(concurrencyScope);
  if (!state) {
    state = { holds: [] };
    concurrency.set(concurrencyScope, state);
  }
  const holdStartedAt = now;
  state.holds.push(holdStartedAt);

  const estimated = options.estimatedTokens ?? estimateRequestTokens(body);
  const tpm = user
    ? (billingMode === "coding" ? subscription?.plan.tpm_limit || 0 : tier?.tpm_limit || 0)
    : key.tpm_limit;
  let tokenReservation: ReturnType<typeof reserveTokenWindow>;
  try {
    tokenReservation = reserveTokenWindow(
      `commercial:tpm:${accessScope}`,
      tpm,
      estimated.prompt + estimated.completion,
    );
  } catch (error) {
    // Roll back the concurrency hold we just took.
    const current = concurrency.get(concurrencyScope);
    if (current) {
      const idx = current.holds.lastIndexOf(holdStartedAt);
      if (idx >= 0) current.holds.splice(idx, 1);
      if (current.holds.length === 0) concurrency.delete(concurrencyScope);
    }
    throw error;
  }

  let released = false;
  return {
    userId: user?.id ?? null,
    release(actualTokens) {
      if (released) return;
      released = true;
      tokenReservation.settle(actualTokens);
      const current = concurrency.get(concurrencyScope);
      if (current) {
        const idx = current.holds.lastIndexOf(holdStartedAt);
        if (idx >= 0) current.holds.splice(idx, 1);
        else if (current.holds.length > 0) current.holds.shift();
        if (current.holds.length === 0) concurrency.delete(concurrencyScope);
      }
    },
  };
}

export function clearAccessState() {
  tokenWindows.clear();
  concurrency.clear();
}

/** Test/debug helper. */
export function getConcurrencyDebug() {
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const [scope, state] of concurrency.entries()) {
    out[scope] = pruneConcurrencyHolds(state, now);
  }
  return out;
}
