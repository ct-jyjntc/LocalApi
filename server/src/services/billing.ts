import { v4 as uuid } from "uuid";
import { db, ModelPrice, ModelPriceView, type PriceWindow } from "../db";
import { nowIso } from "../utils/time";
import { maintainActiveSubscription } from "./plans";
import { applyPriceWindows, parsePriceWindows, serializePriceWindows } from "./price-windows";

function toModelPriceView(row: ModelPrice): ModelPriceView {
  let effort: string[] = [];
  try {
    const parsed = JSON.parse(row.reasoning_effort);
    if (Array.isArray(parsed)) effort = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // malformed stored value — fall back to the empty list
  }
  const { price_windows: rawWindows, prompt_preset_ids: rawPresetIds, ...rest } = row;
  let presetIds: string[] = [];
  try {
    const parsed = JSON.parse(rawPresetIds);
    if (Array.isArray(parsed)) presetIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // malformed stored value — fall back to the empty list
  }
  return {
    ...rest,
    windows: parsePriceWindows(rawWindows),
    prompt_preset_ids: presetIds,
    reasoning_enabled: row.reasoning_enabled === 1,
    reasoning_effort: effort,
    image_input: row.image_input === 1,
    enabled: row.enabled === 1,
  };
}

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
  return (db.prepare("SELECT * FROM model_prices ORDER BY model").all() as ModelPrice[]).map(toModelPriceView);
}

export function getModelPrice(model: string): ModelPriceView | null {
  const row = db.prepare("SELECT * FROM model_prices WHERE model = ?").get(model) as ModelPrice | undefined;
  return row ? toModelPriceView(row) : null;
}

export function upsertModelPrice(input: {
  model: string;
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros?: number;
  cache_write_price_micros?: number;
  reasoning_enabled?: boolean;
  reasoning_effort?: string[];
  image_input?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  enabled?: boolean;
  windows?: PriceWindow[];
  prompt_preset_ids?: string[];
}) {
  const now = nowIso();
  const existing = getModelPrice(input.model.trim());
  const windowsJson = serializePriceWindows(input.windows ?? existing?.windows ?? []);
  db.prepare(
    `INSERT INTO model_prices (
      model, input_price_micros, output_price_micros, cache_read_price_micros,
      cache_write_price_micros, reasoning_enabled, reasoning_effort,
      image_input, context_window, max_output_tokens,
      enabled, price_windows, prompt_preset_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model) DO UPDATE SET
      input_price_micros = excluded.input_price_micros,
      output_price_micros = excluded.output_price_micros,
      cache_read_price_micros = excluded.cache_read_price_micros,
      cache_write_price_micros = excluded.cache_write_price_micros,
      reasoning_enabled = excluded.reasoning_enabled,
      reasoning_effort = excluded.reasoning_effort,
      image_input = excluded.image_input,
      context_window = excluded.context_window,
      max_output_tokens = excluded.max_output_tokens,
      enabled = excluded.enabled,
      price_windows = excluded.price_windows,
      prompt_preset_ids = excluded.prompt_preset_ids,
      updated_at = excluded.updated_at`,
  ).run(
    input.model.trim(),
    input.input_price_micros,
    input.output_price_micros,
    input.cache_read_price_micros ?? 0,
    input.cache_write_price_micros ?? 0,
    input.reasoning_enabled === false ? 0 : 1,
    JSON.stringify(input.reasoning_effort ?? []),
    input.image_input === false ? 0 : 1,
    input.context_window ?? 0,
    input.max_output_tokens ?? 0,
    input.enabled === false ? 0 : 1,
    windowsJson,
    JSON.stringify(input.prompt_preset_ids ?? existing?.prompt_preset_ids ?? []),
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

const NON_PROMPT_FIELDS = new Set([
  "model",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "maxOutputTokens",
  "temperature",
  "top_p",
  "top_k",
  "n",
  "seed",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "user",
]);

function estimateTokenizableChars(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateTokenizableChars(item, depth + 1) + 4, 0);
  }
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value as Record<string, unknown>).reduce((total, [key, item]) => {
    if (depth === 0 && NON_PROMPT_FIELDS.has(key)) return total;
    return total + key.length + estimateTokenizableChars(item, depth + 1) + 4;
  }, 0);
}

/**
 * Cap for the completion-token reservation. Clients may request
 * max_tokens up to 1,000,000; reserving the full amount would make every
 * such request fail with 429 (TPM window) or 402 (wallet hold) even though
 * the actual generation is usually far smaller. SettleUsage charges the
 * real token count afterwards; any leftover uncovered cost is recorded on
 * the usage row. The next request already fails with 402 if the wallet or
 * plan cannot cover the new hold, so we do not auto-suspend the account.
 */
export const RESERVATION_COMPLETION_CAP = 4096;

export function estimateRequestTokens(body: unknown, _requestBytes = 0) {
  const chars = estimateTokenizableChars(body);
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const requested = Number(
    record.max_tokens ?? record.max_completion_tokens ?? record.maxOutputTokens ?? 4096,
  );
  return {
    prompt: Math.max(1, Math.ceil(chars / 4)),
    completion: Number.isFinite(requested)
      ? Math.max(1, Math.min(RESERVATION_COMPLETION_CAP, Math.floor(requested)))
      : RESERVATION_COMPLETION_CAP,
  };
}

export type BillingReservation = {
  usageId: string;
  requestId: string;
  userId: string;
  apiKeyId: string;
  model: string;
  price: ModelPriceView;
  estimatedPrompt: number;
  estimatedCompletion: number;
  reservedPlan: number;
  reservedWallet: number;
  subscriptionId: string | null;
  overageEnabled: boolean;
  billingMode: "wallet" | "coding";
};

export function reserveUsage(input: {
  requestId: string;
  userId: string;
  apiKeyId: string;
  model: string;
  body: unknown;
  estimate?: { prompt: number; completion: number };
  billingMode?: "wallet" | "coding";
}): BillingReservation {
  const billingMode = input.billingMode ?? "wallet";
  const stored = getModelPrice(input.model);
  if (!stored || !stored.enabled) {
    throw new BillingError(402, "model_not_priced", `Model ${input.model} has no active price`);
  }
  const price = applyPriceWindows(stored);
  const estimate = input.estimate ?? estimateRequestTokens(input.body);
  const reserveCost = calculateCostMicros(price, {
    prompt_tokens: estimate.prompt,
    completion_tokens: estimate.completion,
  });
  const subscription = billingMode === "coding" ? maintainActiveSubscription(input.userId) : null;
  if (billingMode === "coding" && !subscription) {
    throw new BillingError(402, "coding_plan_required", "An active Coding Plan is required for /coding requests");
  }
  const planModels = parseAllowedModels(subscription?.plan.allowed_models);
  const planEligible = Boolean(subscription && modelAllowed(planModels, input.model));
  if (billingMode === "coding" && !planEligible) {
    throw new BillingError(403, "model_not_allowed", `Model ${input.model} is not included in the active Coding Plan`);
  }
  const overageEnabled = billingMode === "coding"
    ? Boolean(subscription?.plan.overage_enabled && subscription.overage_enabled)
    : true;
  const usageId = uuid();
  let reservedPlan = 0;
  let reservedWallet = 0;

  db.transaction(() => {
    const wallet = db
      .prepare("SELECT * FROM wallet_accounts WHERE user_id = ?")
      .get(input.userId) as { balance_micros: number; reserved_micros: number } | undefined;
    if (!wallet) throw new BillingError(402, "wallet_missing", "User wallet is unavailable");

    if (billingMode === "coding" && planEligible && subscription) {
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
        estimated_completion_tokens, subscription_id, billing_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      billingMode,
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
    billingMode,
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
    // Idempotency guard: completed/failed rows are never re-settled.
    // A row auto-cancelled by cleanupStaleReservations (or released by
    // releaseUserPendingReservations) while its request was still in flight
    // must still be settled when the request completed successfully —
    // otherwise any request running longer than the cleanup window (2 min)
    // is served for free. Its hold was already released by the cleanup, so
    // reserved amounts are NOT deducted a second time below.
    if (!existing) return;
    if (existing.status === "completed" || existing.status === "failed") return;
    if (existing.status === "cancelled" && !billable) return;
    const holdAlreadyReleased = existing.status === "cancelled";

    if (reservation.subscriptionId) {
      if (!holdAlreadyReleased) {
        db.prepare(
          `UPDATE subscriptions SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ? WHERE id = ?`,
        ).run(reservation.reservedPlan, nowIso(), reservation.subscriptionId);
      }
      const subscription = db
        .prepare("SELECT remaining_credits_micros, reserved_micros FROM subscriptions WHERE id = ?")
        .get(reservation.subscriptionId) as
        | { remaining_credits_micros: number; reserved_micros: number }
        | undefined;
      const availablePlan = Math.max(
        0,
        (subscription?.remaining_credits_micros ?? 0) - (subscription?.reserved_micros ?? 0),
      );
      planCost = Math.min(cost, availablePlan);
      if (planCost > 0) {
        db.prepare(
          "UPDATE subscriptions SET remaining_credits_micros = remaining_credits_micros - ?, updated_at = ? WHERE id = ?",
        ).run(planCost, nowIso(), reservation.subscriptionId);
      }
    }

    const remainder = cost - planCost;
    if (remainder > 0 && reservation.overageEnabled) {
      const wallet = db.prepare(
        "SELECT balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?",
      ).get(reservation.userId) as { balance_micros: number; reserved_micros: number } | undefined;
      // When the hold was already released (cancelled row), the current
      // reserved_micros belongs entirely to other in-flight requests.
      const otherReserved = holdAlreadyReleased
        ? (wallet?.reserved_micros ?? 0)
        : Math.max(0, (wallet?.reserved_micros ?? 0) - reservation.reservedWallet);
      const availableWallet = Math.max(0, (wallet?.balance_micros ?? 0) - otherReserved);
      walletCost = Math.min(remainder, availableWallet);
    }
    uncoveredCost = Math.max(0, remainder - walletCost);
    if (!holdAlreadyReleased) {
      db.prepare(
        `UPDATE wallet_accounts SET reserved_micros = MAX(0, reserved_micros - ?), updated_at = ?
         WHERE user_id = ?`,
      ).run(reservation.reservedWallet, nowIso(), reservation.userId);
    }
    if (walletCost > 0) {
      spendWalletMicros(reservation.userId, walletCost);
    }

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

export type WalletRow = {
  user_id: string;
  balance_micros: number;
  checkin_balance_micros: number;
  reserved_micros: number;
  lifetime_spent_micros: number;
  lifetime_topup_micros: number;
  updated_at: string;
};

export function ensureWalletAccount(userId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO wallet_accounts (
      user_id, balance_micros, checkin_balance_micros, reserved_micros,
      lifetime_spent_micros, lifetime_topup_micros, updated_at
     ) VALUES (?, 0, 0, 0, 0, 0, ?)`,
  ).run(userId, nowIso());
}

/**
 * Spend from total balance, reducing the hidden check-in pool first so spending
 * frees room under the points hold cap. Users only ever see balance_micros total.
 */
export function spendWalletMicros(userId: string, amountMicros: number, now = nowIso()) {
  const amount = Math.max(0, Math.trunc(amountMicros));
  if (amount <= 0) return getWallet(userId)!;
  ensureWalletAccount(userId);
  const wallet = db
    .prepare(
      "SELECT balance_micros, checkin_balance_micros, reserved_micros FROM wallet_accounts WHERE user_id = ?",
    )
    .get(userId) as {
    balance_micros: number;
    checkin_balance_micros: number;
    reserved_micros: number;
  };
  const available = wallet.balance_micros - wallet.reserved_micros;
  if (available < amount) {
    throw new BillingError(402, "insufficient_balance", "Insufficient account balance");
  }
  const fromCheckin = Math.min(amount, Math.max(0, wallet.checkin_balance_micros));
  db.prepare(
    `UPDATE wallet_accounts
     SET balance_micros = balance_micros - ?,
         checkin_balance_micros = MAX(0, checkin_balance_micros - ?),
         lifetime_spent_micros = lifetime_spent_micros + ?,
         updated_at = ?
     WHERE user_id = ?`,
  ).run(amount, fromCheckin, amount, now, userId);
  return getWallet(userId)!;
}

/** Credit wallet from check-in point exchange (counts toward hold cap until spent). */
export function creditCheckinWallet(userId: string, amountMicros: number, now = nowIso()) {
  const amount = Math.max(0, Math.trunc(amountMicros));
  if (amount <= 0) return getWallet(userId);
  ensureWalletAccount(userId);
  db.prepare(
    `UPDATE wallet_accounts
     SET balance_micros = balance_micros + ?,
         checkin_balance_micros = checkin_balance_micros + ?,
         updated_at = ?
     WHERE user_id = ?`,
  ).run(amount, amount, now, userId);
  return getWallet(userId)!;
}

export function adjustWallet(userId: string, amountMicros: number, description: string) {
  let balance = 0;
  db.transaction(() => {
    ensureWalletAccount(userId);
    if (amountMicros >= 0) {
      db.prepare("UPDATE wallet_accounts SET balance_micros = balance_micros + ?, updated_at = ? WHERE user_id = ?")
        .run(amountMicros, nowIso(), userId);
    } else {
      spendWalletMicros(userId, -amountMicros);
    }
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
  const row = db.prepare("SELECT * FROM wallet_accounts WHERE user_id = ?").get(userId) as
    | (WalletRow & { checkin_balance_micros?: number })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    checkin_balance_micros: Number(row.checkin_balance_micros || 0),
  } as WalletRow;
}

/** Public wallet view: single total balance, no check-in pool split. */
export function getPublicWallet(userId: string) {
  const wallet = getWallet(userId);
  if (!wallet) return null;
  return {
    user_id: wallet.user_id,
    balance_micros: wallet.balance_micros,
    reserved_micros: wallet.reserved_micros,
    lifetime_spent_micros: wallet.lifetime_spent_micros,
    lifetime_topup_micros: wallet.lifetime_topup_micros,
    updated_at: wallet.updated_at,
  };
}

export function listWalletLedger(userId: string, limit = 200) {
  return listWalletLedgerPage({ userId, limit, offset: 0 }).items;
}

export function listWalletLedgerPage(input: { userId: string; limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const total = (
    db.prepare("SELECT COUNT(*) AS c FROM wallet_ledger WHERE user_id = ?").get(input.userId) as {
      c: number;
    }
  ).c;
  const items = db
    .prepare(
      // L9: tie-break on id so equal timestamps don't reshuffle across pages.
      "SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(input.userId, limit, offset);
  return { items, total, limit, offset };
}

function floorTokenCost(tokens: number, priceMicros: number) {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(priceMicros) || priceMicros <= 0) return 0;
  return Number((BigInt(Math.floor(tokens)) * BigInt(Math.floor(priceMicros))) / PRICE_TOKEN_UNIT);
}

function addBillingBreakdown(row: Record<string, unknown>) {
  const promptTokens = Math.max(0, Number(row.prompt_tokens || 0));
  const cachedTokens = Math.max(0, Math.min(promptTokens, Number(row.cached_tokens || 0)));
  const ordinaryInputTokens = promptTokens - cachedTokens;
  const cacheWriteTokens = Math.max(0, Number(row.cache_write_tokens || 0));
  const completionTokens = Math.max(0, Number(row.completion_tokens || 0));
  const inputCost = floorTokenCost(ordinaryInputTokens, Number(row.input_price_micros || 0));
  const cacheReadCost = floorTokenCost(cachedTokens, Number(row.cache_read_price_micros || 0));
  const cacheWriteCost = floorTokenCost(cacheWriteTokens, Number(row.cache_write_price_micros || 0));
  const outputCost = floorTokenCost(completionTokens, Number(row.output_price_micros || 0));
  // The authoritative total is rounded once in calculateCostMicros. Put the
  // final sub-micro remainder on output so the visible components add up.
  const remainder = Math.max(0, Number(row.cost_micros || 0) - inputCost - cacheReadCost - cacheWriteCost - outputCost);
  return {
    ...row,
    ordinary_input_tokens: ordinaryInputTokens,
    cache_read_tokens: cachedTokens,
    input_cost_micros: inputCost,
    cache_read_cost_micros: cacheReadCost,
    cache_write_cost_micros: cacheWriteCost,
    output_cost_micros: outputCost + remainder,
  };
}

function mapUsageRow(row: Record<string, unknown>) {
  const mapped = addBillingBreakdown(row);
  const username = typeof row.username === "string" ? row.username : null;
  const displayName = typeof row.display_name === "string" ? row.display_name : null;
  return {
    ...mapped,
    username,
    display_name: displayName,
    user_label: displayName || username || null,
  };
}

export function listUsageRecords(userId?: string, limit = 200) {
  return listUsageRecordsPage({ userId, limit, offset: 0 }).items;
}

export function listUsageRecordsPage(input: {
  userId?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const total = input.userId
    ? (db.prepare("SELECT COUNT(*) AS c FROM usage_records WHERE user_id = ?").get(input.userId) as {
        c: number;
      }).c
    : (db.prepare("SELECT COUNT(*) AS c FROM usage_records").get() as { c: number }).c;
  const rows = input.userId
    ? db
        .prepare(
          `SELECT ur.*, u.username AS username, u.display_name AS display_name
           FROM usage_records ur
           LEFT JOIN users u ON u.id = ur.user_id
           WHERE ur.user_id = ?
           ORDER BY ur.created_at DESC, ur.id DESC LIMIT ? OFFSET ?`,
        )
        .all(input.userId, limit, offset)
    : db
        .prepare(
          `SELECT ur.*, u.username AS username, u.display_name AS display_name
           FROM usage_records ur
           LEFT JOIN users u ON u.id = ur.user_id
           ORDER BY ur.created_at DESC, ur.id DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset);
  return {
    items: (rows as Array<Record<string, unknown>>).map(mapUsageRow),
    total,
    limit,
    offset,
  };
}

export function getUsageTotals(userId: string) {
  return db.prepare(
    `SELECT COUNT(*) AS requests,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM usage_records WHERE user_id = ?`,
  ).get(userId) as {
    requests: number;
    cost_micros: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    total_tokens: number;
  };
}

function shanghaiDayKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function listDailyUsage(userId: string, days = 30) {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60_000).toISOString();
  const rows = db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS date,
      COUNT(*) AS requests,
      COALESCE(SUM(cost_micros), 0) AS cost_micros,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM usage_records
     WHERE user_id = ? AND created_at >= ?
     GROUP BY date ORDER BY date`,
  ).all(userId, cutoff) as Array<{
    date: string;
    requests: number;
    cost_micros: number;
    total_tokens: number;
  }>;
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const now = Date.now();
  return Array.from({ length: safeDays }, (_, index) => {
    const date = shanghaiDayKey(new Date(now - (safeDays - 1 - index) * 24 * 60 * 60_000));
    return byDate.get(date) ?? { date, requests: 0, cost_micros: 0, total_tokens: 0 };
  });
}

/**
 * Release pending billing holds older than maxAgeMs.
 * Client disconnects / hung upstream streams can leave reservations stuck.
 * Default recovery window is short so concurrency-adjacent credit holds free quickly.
 * Rows cancelled here are still settled (billed) by settleUsage when the owning
 * request completes successfully — cancellation only releases the hold, it never
 * forgives usage. Only rows whose request actually aborted stay uncharged.
 */
export function cleanupStaleReservations(maxAgeMs = 2 * 60_000) {
  const cutoff = new Date(Date.now() - Math.max(15_000, maxAgeMs)).toISOString();
  const rows = db
    .prepare("SELECT * FROM usage_records WHERE status = 'pending' AND created_at < ?")
    .all(cutoff) as Array<{
      id: string;
      user_id: string;
      reserved_plan_micros: number;
      reserved_wallet_micros: number;
      subscription_id: string | null;
    }>;
  if (rows.length === 0) return 0;
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
    // Reconcile any residual drift on touched subscriptions.
    const subscriptionIds = [
      ...new Set(rows.map((row) => row.subscription_id).filter((id): id is string => Boolean(id))),
    ];
    for (const subscriptionId of subscriptionIds) {
      const pending = db
        .prepare(
          `SELECT COALESCE(SUM(reserved_plan_micros), 0) AS total
           FROM usage_records WHERE subscription_id = ? AND status = 'pending'`,
        )
        .get(subscriptionId) as { total: number };
      db.prepare("UPDATE subscriptions SET reserved_micros = ?, updated_at = ? WHERE id = ?").run(
        Math.max(0, Number(pending.total) || 0),
        nowIso(),
        subscriptionId,
      );
    }
  })();
  return rows.length;
}

/** Force-release all pending holds for one user (used before plan upgrade/renew). */
export function releaseUserPendingReservations(userId: string, maxAgeMs = 2 * 60_000) {
  const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM usage_records
       WHERE user_id = ? AND status = 'pending' AND created_at < ?`,
    )
    .all(userId, cutoff) as Array<{
      id: string;
      user_id: string;
      reserved_plan_micros: number;
      reserved_wallet_micros: number;
      subscription_id: string | null;
    }>;
  if (rows.length === 0) {
    // Still reconcile subscription reserved to match remaining pending.
    db.prepare(
      `UPDATE subscriptions
       SET reserved_micros = COALESCE((
         SELECT SUM(reserved_plan_micros) FROM usage_records
         WHERE subscription_id = subscriptions.id AND status = 'pending'
       ), 0),
       updated_at = ?
       WHERE user_id = ? AND status = 'active'`,
    ).run(nowIso(), userId);
    return 0;
  }
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
        "UPDATE usage_records SET status = 'cancelled', completed_at = ?, error = 'released before plan change' WHERE id = ?",
      ).run(nowIso(), row.id);
    }
    db.prepare(
      `UPDATE subscriptions
       SET reserved_micros = COALESCE((
         SELECT SUM(reserved_plan_micros) FROM usage_records
         WHERE subscription_id = subscriptions.id AND status = 'pending'
       ), 0),
       updated_at = ?
       WHERE user_id = ? AND status = 'active'`,
    ).run(nowIso(), userId);
  })();
  return rows.length;
}
