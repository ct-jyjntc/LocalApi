import { v4 as uuid } from "uuid";
import { db, ModelPrice } from "../db";
import { nowIso } from "../utils/time";
import { getActiveSubscription } from "./plans";

export const MICROS_PER_CREDIT = 1_000_000;
const PRICE_TOKEN_UNIT = 1_000_000n;

export class BillingError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function listModelPrices() {
  return (db.prepare("SELECT * FROM model_prices ORDER BY model").all() as ModelPrice[]).map((row) => ({
    ...row,
    enabled: row.enabled === 1,
  }));
}

export function getModelPrice(model: string): ModelPrice | null {
  return (
    (db.prepare("SELECT * FROM model_prices WHERE model = ?").get(model) as ModelPrice | undefined) ?? null
  );
}

export function upsertModelPrice(input: {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros?: number;
  cache_write_price_micros?: number;
  enabled?: boolean;
}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO model_prices (
      model, input_price_micros, output_price_micros, cache_read_price_micros,
      cache_write_price_micros, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      input_price_micros = excluded.input_price_micros,
      output_price_micros = excluded.output_price_micros,
      cache_read_price_micros = excluded.cache_read_price_micros,
      cache_write_price_micros = excluded.cache_write_price_micros,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at`,
  ).run(
    input.model.trim(),
    input.input_price_micros,
    input.output_price_micros,
    input.cache_read_price_micros ?? 0,
    input.cache_write_price_micros ?? 0,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getModelPrice(input.model.trim());
}

export function deleteModelPrice(model: string) {
  return db.prepare("DELETE FROM model_prices WHERE model = ?").run(model).changes > 0;
}

export function calculateCostMicros(
  price: Pick<ModelPrice, "input_price_micros" | "output_price_micros" | "cache_read_price_micros" | "cache_write_price_micros">,
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cache_write_tokens?: number },
) {
  const cached = Math.max(0, Math.min(usage.prompt_tokens, usage.cached_tokens ?? 0));
  const ordinaryInput = Math.max(0, usage.prompt_tokens - cached);
  const numerator =
    BigInt(ordinaryInput) * BigInt(price.input_price_micros) +
    BigInt(cached) * BigInt(price.cache_read_price_micros) +
    BigInt(Math.max(0, usage.cache_write_tokens ?? 0)) * BigInt(price.cache_write_price_micros) +
    BigInt(Math.max(0, usage.completion_tokens)) * BigInt(price.output_price_micros);
  return Number((numerator + PRICE_TOKEN_UNIT - 1n) / PRICE_TOKEN_UNIT);
}

function parseAllowedModels(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  try {
    return parseAllowedModels(JSON.parse(value));
  } catch {
    return [];
  }
}

function modelAllowed(models: string[], model: string) {
  return models.length === 0 || models.includes("*") || models.includes(model);
}

export function estimateRequestTokens(body: unknown) {
  let chars = 0;
  try {
    chars = JSON.stringify(body ?? "").length;
  } catch {
    chars = String(body ?? "").length;
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const requested = Number(
    record.max_tokens ?? record.max_completion_tokens ?? record.maxOutputTokens ?? 4096,
  );
  return {
    prompt: Math.max(1, Math.ceil(chars / 4)),
    completion: Number.isFinite(requested) ? Math.max(1, Math.min(1_000_000, Math.floor(requested))) : 4096,
  };
}

export type BillingReservation = {
  usageId: string;
  requestId: string;
  userId: string;
  apiKeyId: string;
  model: string;
  price: ModelPrice;
  estimatedPrompt: number;
  estimatedCompletion: number;
  reservedPlan: number;
  reservedWallet: number;
  subscriptionId: string | null;
  overageEnabled: boolean;
};

export function reserveUsage(input: {
  requestId: string;
  userId: string;
  apiKeyId: string;
  model: string;
  body: unknown;
}): BillingReservation {
  const price = getModelPrice(input.model);
  if (!price || price.enabled !== 1) {
    throw new BillingError(402, "model_not_priced", `Model ${input.model} has no active price`);
  }
  const estimate = estimateRequestTokens(input.body);
  const reserveCost = calculateCostMicros(price, {
    prompt_tokens: estimate.prompt,
    completion_tokens: estimate.completion,
  });
  const subscription = getActiveSubscription(input.userId);
  const planModels = parseAllowedModels(subscription?.plan.allowed_models);
  const planEligible = Boolean(subscription && modelAllowed(planModels, input.model));
  const overageEnabled = subscription ? subscription.plan.overage_enabled : true;
  const usageId = uuid();
  let reservedPlan = 0;
  let reservedWallet = 0;

  db.transaction(() => {
    const wallet = db
      .prepare("SELECT * FROM wallet_accounts WHERE user_id = ?")
      .get(input.userId) as { balance_micros: number; reserved_micros: number } | undefined;
    if (!wallet) throw new BillingError(402, "wallet_missing", "User wallet is unavailable");

    if (planEligible && subscription) {
      const availablePlan = Math.max(
        0,
        subscription.remaining_credits_micros - subscription.reserved_micros,
      );
      reservedPlan = Math.min(reserveCost, availablePlan);
    }
    const remainder = reserveCost - reservedPlan;
    if (remainder > 0) {
      if (!overageEnabled) {
        throw new BillingError(402, "plan_quota_exhausted", "Plan quota is insufficient");
      }
      const availableWallet = wallet.balance_micros - wallet.reserved_micros;
      if (availableWallet < remainder) {
        throw new BillingError(402, "insufficient_balance", "Insufficient account balance");
      }
      reservedWallet = remainder;
    }

    if (subscription && reservedPlan > 0) {
      db.prepare("UPDATE subscriptions SET reserved_micros = reserved_micros + ?, updated_at = ? WHERE id = ?")
        .run(reservedPlan, nowIso(), subscription.id);
    }
    if (reservedWallet > 0) {
      db.prepare("UPDATE wallet_accounts SET reserved_micros = reserved_micros + ?, updated_at = ? WHERE user_id = ?")
        .run(reservedWallet, nowIso(), input.userId);
    }
    db.prepare(
      `INSERT INTO usage_records (
        id, request_id, user_id, api_key_id, model, status,
        input_price_micros, output_price_micros, cache_read_price_micros, cache_write_price_micros,
        reserved_plan_micros, reserved_wallet_micros, estimated_prompt_tokens,
        estimated_completion_tokens, subscription_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      usageId,
      input.requestId,
      input.userId,
      input.apiKeyId,
      input.model,
      price.input_price_micros,
      price.output_price_micros,
      price.cache_read_price_micros,
      price.cache_write_price_micros,
      reservedPlan,
      reservedWallet,
      estimate.prompt,
      estimate.completion,
      subscription?.id ?? null,
      nowIso(),
    );
  })();

  return {
    usageId,
    requestId: input.requestId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    model: input.model,
    price,
    estimatedPrompt: estimate.prompt,
    estimatedCompletion: estimate.completion,
    reservedPlan,
    reservedWallet,
    subscriptionId: subscription?.id ?? null,
    overageEnabled,
  };
}

export function settleUsage(
  reservation: BillingReservation,
  input: {
    statusCode: number;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    outputText?: string | null;
    reasoningText?: string | null;
    error?: string | null;
  },
) {
  const billable = input.statusCode >= 200 && input.statusCode < 400;
  const promptTokens = billable
    ? Math.max(0, input.promptTokens || reservation.estimatedPrompt)
    : 0;
  const estimatedOutput = Math.ceil(
    ((input.outputText?.length ?? 0) + (input.reasoningText?.length ?? 0)) / 4,
  );
  const completionTokens = billable
    ? Math.max(0, input.completionTokens || estimatedOutput)
    : 0;
  const cachedTokens = Math.max(0, Math.min(promptTokens, input.cachedTokens ?? 0));
  const cacheWriteTokens = Math.max(0, input.cacheWriteTokens ?? 0);
  const totalTokens = input.totalTokens || promptTokens + completionTokens;
  const cost = billable
    ? calculateCostMicros(reservation.price, {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cached_tokens: cachedTokens,
        cache_write_tokens: cacheWriteTokens,
      })
    : 0;
  let planCost = 0;
  let walletCost = 0;
  let uncoveredCost = 0;

  db.transaction(() => {
    const existing = db.prepare("SELECT status FROM usage_records WHERE id = ?").get(reservation.usageId) as
      | { status: string }
      | undefined;
    if (!existing || existing.status !== "pending") return;

    if (reservation.subscriptionId) {
      db.prepare(
        `UPDATE subscriptions SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE id = ?`,
      ).run(reservation.reservedPlan, nowIso(), reservation.subscriptionId);
      const subscription = db
        .prepare("SELECT remaining_credits_micros FROM subscriptions WHERE id = ?")
        .get(reservation.subscriptionId) as { remaining_credits_micros: number } | undefined;
      planCost = Math.min(cost, Math.max(0, subscription?.remaining_credits_micros ?? 0));
      if (planCost > 0) {
        db.prepare(
          "UPDATE subscriptions SET remaining_credits_micros = remaining_credits_micros - ?, updated_at = ? WHERE id = ?",
        ).run(planCost, nowIso(), reservation.subscriptionId);
      }
    }

    const remainder = cost - planCost;
    if (remainder > 0 && !reservation.overageEnabled) {
      uncoveredCost = remainder;
      walletCost = 0;
      db.prepare("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?").run(
        nowIso(),
        reservation.userId,
      );
    } else {
      walletCost = remainder;
    }
    db.prepare(
      `UPDATE wallet_accounts SET reserved_micros = MAX(0, reserved_micros - ?),
       balance_micros = balance_micros - ?, lifetime_spent_micros = lifetime_spent_micros + ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(reservation.reservedWallet, walletCost, walletCost, nowIso(), reservation.userId);

    if (walletCost > 0) {
      const wallet = db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(
        reservation.userId,
      ) as { balance_micros: number };
      db.prepare(
        `INSERT INTO wallet_ledger (id, user_id, type, amount_micros, balance_after_micros, usage_id, description, created_at)
         VALUES (?, ?, 'usage', ?, ?, ?, ?, ?)`,
      ).run(
        uuid(),
        reservation.userId,
        -walletCost,
        wallet.balance_micros,
        reservation.usageId,
        `${reservation.model} usage`,
        nowIso(),
      );
      if (wallet.balance_micros < 0) {
        db.prepare("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?").run(
          nowIso(),
          reservation.userId,
        );
      }
    }

    db.prepare(
      `UPDATE usage_records SET status = ?, status_code = ?, prompt_tokens = ?, completion_tokens = ?,
        cached_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, total_tokens = ?,
        cost_micros = ?, plan_cost_micros = ?, wallet_cost_micros = ?, completed_at = ?, error = ?
       WHERE id = ?`,
    ).run(
      billable ? "completed" : "failed",
      input.statusCode,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheWriteTokens,
      input.reasoningTokens ?? 0,
      totalTokens,
      cost,
      planCost,
      walletCost,
      nowIso(),
      [input.error, uncoveredCost > 0 ? `uncovered cost ${uncoveredCost} micros` : null]
        .filter(Boolean)
        .join("; ") || null,
      reservation.usageId,
    );
  })();

  return { usageId: reservation.usageId, costMicros: cost, planCostMicros: planCost, walletCostMicros: walletCost };
}

export function adjustWallet(userId: string, amountMicros: number, description: string) {
  let balance = 0;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO wallet_accounts (user_id, balance_micros, reserved_micros, lifetime_spent_micros, updated_at)
       VALUES (?, 0, 0, 0, ?)`,
    ).run(userId, nowIso());
    db.prepare("UPDATE wallet_accounts SET balance_micros = balance_micros + ?, updated_at = ? WHERE user_id = ?")
      .run(amountMicros, nowIso(), userId);
    balance = (db.prepare("SELECT balance_micros FROM wallet_accounts WHERE user_id = ?").get(userId) as {
      balance_micros: number;
    }).balance_micros;
    db.prepare(
      `INSERT INTO wallet_ledger (id, user_id, type, amount_micros, balance_after_micros, description, created_at)
       VALUES (?, ?, 'adjustment', ?, ?, ?, ?)`,
    ).run(uuid(), userId, amountMicros, balance, description, nowIso());
  })();
  return getWallet(userId);
}

export function getWallet(userId: string) {
  return db.prepare("SELECT * FROM wallet_accounts WHERE user_id = ?").get(userId) as
    | { user_id: string; balance_micros: number; reserved_micros: number; lifetime_spent_micros: number; updated_at: string }
    | undefined;
}

export function listWalletLedger(userId: string, limit = 200) {
  return db
    .prepare("SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit);
}

export function listUsageRecords(userId?: string, limit = 200) {
  return userId
    ? db.prepare("SELECT * FROM usage_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit)
    : db.prepare("SELECT * FROM usage_records ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function cleanupStaleReservations() {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const rows = db
    .prepare("SELECT * FROM usage_records WHERE status = 'pending' AND created_at < ?")
    .all(cutoff) as Array<{
      id: string;
      user_id: string;
      reserved_plan_micros: number;
      reserved_wallet_micros: number;
      subscription_id: string | null;
    }>;
  db.transaction(() => {
    for (const row of rows) {
      db.prepare(
        "UPDATE wallet_accounts SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE user_id = ?",
      ).run(row.reserved_wallet_micros, nowIso(), row.user_id);
      if (row.subscription_id) {
        db.prepare(
          `UPDATE subscriptions SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE id = ?`,
        ).run(row.reserved_plan_micros, nowIso(), row.subscription_id);
      }
      db.prepare(
        "UPDATE usage_records SET status = 'cancelled', completed_at = ?, error = 'stale reservation recovered' WHERE id = ?",
      ).run(nowIso(), row.id);
    }
  })();
  return rows.length;
}
