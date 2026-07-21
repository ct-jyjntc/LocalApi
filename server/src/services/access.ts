import { ApiKey } from "../db";
import { estimateRequestTokens } from "./billing";
import { consumeRateLimit } from "./rate-limit";
import { getActiveSubscription, maintainActiveSubscription } from "./plans";
import { getUser } from "./users";
import { resolveUserTier } from "./tiers";

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

const tokenWindows = new Map<string, TokenWindow>();
const concurrency = new Map<string, number>();

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
  options: { billingMode?: "wallet" | "coding"; estimatedTokens?: { prompt: number; completion: number } } = {},
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
      throw new AccessError(403, "model_not_allowed", `Model ${model} is not allowed for this account`);
    }
  }

  const rpm = user
    ? (billingMode === "coding" ? subscription?.plan.rpm_limit || 0 : tier?.rpm_limit || 0)
    : key.rate_limit;
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
  const active = concurrency.get(concurrencyScope) ?? 0;
  if (limit > 0 && active >= limit) {
    throw new AccessError(429, "concurrency_limit_exceeded", "Concurrent request limit exceeded", 1);
  }
  concurrency.set(concurrencyScope, active + 1);

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
    concurrency.set(concurrencyScope, Math.max(0, (concurrency.get(concurrencyScope) ?? 1) - 1));
    throw error;
  }

  let released = false;
  return {
    userId: user?.id ?? null,
    release(actualTokens) {
      if (released) return;
      released = true;
      tokenReservation.settle(actualTokens);
      const next = Math.max(0, (concurrency.get(concurrencyScope) ?? 1) - 1);
      if (next === 0) concurrency.delete(concurrencyScope);
      else concurrency.set(concurrencyScope, next);
    },
  };
}

export function clearAccessState() {
  tokenWindows.clear();
  concurrency.clear();
}
