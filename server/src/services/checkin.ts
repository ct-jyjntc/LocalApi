import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db, getSetting, setSetting } from "../db";
import { nowIso } from "../utils/time";
import { creditCheckinWallet, getPublicWallet, getWallet } from "./billing";

/** Store points as integer cents (2 decimal places). 1.23 points => 123. */
export const POINTS_SCALE = 100;

export class CheckinError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toCents(value: unknown, fallback = 0): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * POINTS_SCALE);
}

function fromCents(cents: number): number {
  return Math.round(Number(cents) || 0) / POINTS_SCALE;
}

function formatPoints(cents: number): string {
  return fromCents(cents).toFixed(2);
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** One-time: old integer points become x.00 by scaling * 100. */
export function migratePointsScaleIfNeeded() {
  if (getSetting("points_scale_v2") === "1") return;
  try {
    db.transaction(() => {
      db.exec(`
        UPDATE points_accounts
        SET balance = balance * ${POINTS_SCALE},
            lifetime_earned = lifetime_earned * ${POINTS_SCALE},
            lifetime_spent = lifetime_spent * ${POINTS_SCALE};
        UPDATE points_ledger
        SET amount = amount * ${POINTS_SCALE},
            balance_after = balance_after * ${POINTS_SCALE};
        UPDATE checkin_records
        SET points = points * ${POINTS_SCALE};
      `);
      // If settings were whole numbers like "1"/"10", keep them as display decimals.
      const minRaw = getSetting("checkin_points_min");
      const maxRaw = getSetting("checkin_points_max");
      if (minRaw != null && minRaw !== "" && !minRaw.includes(".")) {
        setSetting("checkin_points_min", Number(minRaw).toFixed(2));
      }
      if (maxRaw != null && maxRaw !== "" && !maxRaw.includes(".")) {
        setSetting("checkin_points_max", Number(maxRaw).toFixed(2));
      }
      setSetting("points_scale_v2", "1");
    })();
  } catch (error) {
    // L12: only mark the migration complete when the tables truly do not
    // exist yet (brand-new empty boot). Any other failure must leave the
    // flag unset so a later boot retries — otherwise balances stay at the
    // old scale forever (permanent 100× shrinkage).
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) {
      setSetting("points_scale_v2", "1");
      return;
    }
    console.error("[checkin] points scale migration failed; will retry on next boot:", error);
  }
}

export function getCheckinSettings() {
  migratePointsScaleIfNeeded();
  const enabled = (getSetting("checkin_enabled") ?? "true") === "true";
  let min = clampNumber(getSetting("checkin_points_min"), 1, 0, 1_000_000);
  let max = clampNumber(getSetting("checkin_points_max"), 10, 0, 1_000_000);
  // Snap to 2 decimal places.
  min = fromCents(toCents(min));
  max = fromCents(toCents(max));
  if (max < min) [min, max] = [max, min];
  const exchangeMicros = Math.max(
    0,
    Math.min(1_000_000_000_000, Math.round(Number(getSetting("points_exchange_micros") ?? 10_000) || 0)),
  );
  // 0 = unlimited hold cap.
  const balanceCap = fromCents(
    toCents(clampNumber(getSetting("points_balance_cap"), 0, 0, 1_000_000_000)),
  );
  return {
    enabled,
    points_min: min,
    points_max: max,
    points_min_cents: toCents(min),
    points_max_cents: toCents(max),
    /**
     * Max held points-equivalent: unexchanged points + unspent check-in wallet credits
     * (converted back to points). 0 means no limit.
     */
    balance_cap: balanceCap,
    balance_cap_cents: toCents(balanceCap),
    /** Balance credits granted per 1 point (display units). */
    exchange_rate: exchangeMicros / 1_000_000,
    exchange_micros: exchangeMicros,
  };
}

export function updateCheckinSettings(input: {
  enabled?: boolean;
  points_min?: number;
  points_max?: number;
  balance_cap?: number;
  exchange_rate?: number;
}) {
  migratePointsScaleIfNeeded();
  if (input.enabled !== undefined) {
    setSetting("checkin_enabled", input.enabled ? "true" : "false");
  }
  if (input.points_min !== undefined) {
    const min = fromCents(toCents(clampNumber(input.points_min, 1, 0, 1_000_000)));
    setSetting("checkin_points_min", min.toFixed(2));
  }
  if (input.points_max !== undefined) {
    const max = fromCents(toCents(clampNumber(input.points_max, 10, 0, 1_000_000)));
    setSetting("checkin_points_max", max.toFixed(2));
  }
  if (input.balance_cap !== undefined) {
    const cap = fromCents(toCents(clampNumber(input.balance_cap, 0, 0, 1_000_000_000)));
    setSetting("points_balance_cap", cap.toFixed(2));
  }
  if (input.exchange_rate !== undefined) {
    const rate = Number(input.exchange_rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new CheckinError(400, "invalid_exchange_rate", "Exchange rate must be a non-negative number");
    }
    setSetting("points_exchange_micros", String(Math.round(rate * 1_000_000)));
  }

  const current = getCheckinSettings();
  if (current.points_max < current.points_min) {
    setSetting("checkin_points_min", current.points_max.toFixed(2));
    setSetting("checkin_points_max", current.points_min.toFixed(2));
  }
  return getCheckinSettings();
}

function ensurePointsAccount(userId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO points_accounts (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
     VALUES (?, 0, 0, 0, ?)`,
  ).run(userId, nowIso());
}

export function getPointsAccount(userId: string) {
  migratePointsScaleIfNeeded();
  ensurePointsAccount(userId);
  const row = db.prepare("SELECT * FROM points_accounts WHERE user_id = ?").get(userId) as {
    user_id: string;
    balance: number;
    lifetime_earned: number;
    lifetime_spent: number;
    updated_at: string;
  };
  return {
    ...row,
    balance_cents: row.balance,
    balance: fromCents(row.balance),
    lifetime_earned: fromCents(row.lifetime_earned),
    lifetime_spent: fromCents(row.lifetime_spent),
  };
}

export function listPointsLedger(userId: string, limit = 100) {
  migratePointsScaleIfNeeded();
  const rows = db
    .prepare("SELECT * FROM points_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, Math.max(1, Math.min(500, limit))) as Array<{
    id: string;
    user_id: string;
    type: string;
    amount: number;
    balance_after: number;
    description: string;
    reference_type: string | null;
    reference_id: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    ...row,
    amount: fromCents(row.amount),
    balance_after: fromCents(row.balance_after),
  }));
}

export function listCheckins(userId: string, limit = 30) {
  migratePointsScaleIfNeeded();
  const rows = db
    .prepare("SELECT * FROM checkin_records WHERE user_id = ? ORDER BY checkin_date DESC LIMIT ?")
    .all(userId, Math.max(1, Math.min(365, limit))) as Array<{
    id: string;
    user_id: string;
    checkin_date: string;
    points: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    ...row,
    points: fromCents(row.points),
  }));
}

/**
 * Inclusive [min, max] at 0.01 resolution using crypto.randomInt (CSPRNG, unbiased).
 * Example: min=1.00 max=10.00 → random among 1.00, 1.01, ..., 10.00
 */
function randomPointsCents(minCents: number, maxCents: number) {
  const lo = Math.min(minCents, maxCents);
  const hi = Math.max(minCents, maxCents);
  if (hi <= lo) return lo;
  return crypto.randomInt(lo, hi + 1);
}

/**
 * Held points-equivalent for the anti-hoard cap:
 * unexchanged points + unspent wallet credits that came from point exchange
 * (converted back to points using the current exchange rate).
 * Users only see a single wallet balance; the check-in pool is hidden.
 */
export function getHeldPointsCents(userId: string, settings = getCheckinSettings()) {
  const account = getPointsAccount(userId);
  const wallet = getWallet(userId);
  const checkinWalletMicros = Math.max(0, Number(wallet?.checkin_balance_micros || 0));
  let fromWalletCents = 0;
  if (settings.exchange_micros > 0 && checkinWalletMicros > 0) {
    fromWalletCents = Math.floor((checkinWalletMicros * POINTS_SCALE) / settings.exchange_micros);
  }
  return {
    points_cents: account.balance_cents,
    from_wallet_cents: fromWalletCents,
    held_cents: account.balance_cents + fromWalletCents,
    checkin_balance_micros: checkinWalletMicros,
  };
}

const CAP_REACHED_MESSAGE =
  "积分以及积分兑换成余额的持有已达上限，请将积分兑换成余额并使用掉后再进行签到";

export function getCheckinStatus(userId: string) {
  const settings = getCheckinSettings();
  const account = getPointsAccount(userId);
  const held = getHeldPointsCents(userId, settings);
  const today = todayKey();
  const todayRecord = db
    .prepare("SELECT * FROM checkin_records WHERE user_id = ? AND checkin_date = ?")
    .get(userId, today) as
    | { id: string; user_id: string; checkin_date: string; points: number; created_at: string }
    | undefined;

  const atCap = settings.balance_cap_cents > 0 && held.held_cents >= settings.balance_cap_cents;
  return {
    settings: {
      enabled: settings.enabled,
      points_min: settings.points_min,
      points_max: settings.points_max,
      balance_cap: settings.balance_cap,
      exchange_rate: settings.exchange_rate,
    },
    points: {
      balance: account.balance,
      lifetime_earned: account.lifetime_earned,
      lifetime_spent: account.lifetime_spent,
      held: fromCents(held.held_cents),
      held_from_wallet: fromCents(held.from_wallet_cents),
    },
    today,
    checked_in_today: Boolean(todayRecord),
    today_points: todayRecord ? fromCents(todayRecord.points) : null,
    at_balance_cap: atCap,
    can_checkin: settings.enabled && !todayRecord && !atCap,
    recent_checkins: listCheckins(userId, 14),
    recent_ledger: listPointsLedger(userId, 20),
    // Users only see a single total balance (check-in pool is hidden).
    wallet: getPublicWallet(userId),
  };
}

export function performCheckin(userId: string) {
  const settings = getCheckinSettings();
  if (!settings.enabled) {
    throw new CheckinError(403, "checkin_disabled", "Check-in is currently disabled");
  }
  if (settings.points_max_cents <= 0 && settings.points_min_cents <= 0) {
    throw new CheckinError(503, "checkin_misconfigured", "Check-in points range is not configured");
  }
  // L14: min=max=0 (or a range that always yields 0) would burn the day's
  // check-in for nothing. Reject before inserting the record.
  if (settings.points_max_cents <= 0) {
    throw new CheckinError(503, "checkin_misconfigured", "Check-in points range must award more than zero");
  }

  const today = todayKey();
  let account = getPointsAccount(userId);
  let held = getHeldPointsCents(userId, settings);
  if (settings.balance_cap_cents > 0 && held.held_cents >= settings.balance_cap_cents) {
    throw new CheckinError(403, "points_cap_reached", CAP_REACHED_MESSAGE);
  }

  let pointsCents = randomPointsCents(settings.points_min_cents, settings.points_max_cents);
  // Room is against the combined hold (points + unspent check-in wallet credits).
  if (settings.balance_cap_cents > 0) {
    const room = settings.balance_cap_cents - held.held_cents;
    if (room <= 0) {
      throw new CheckinError(403, "points_cap_reached", CAP_REACHED_MESSAGE);
    }
    pointsCents = Math.min(pointsCents, room);
  }
  let record:
    | { id: string; user_id: string; checkin_date: string; points: number; created_at: string }
    | undefined;

  db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM checkin_records WHERE user_id = ? AND checkin_date = ?")
      .get(userId, today) as { id: string } | undefined;
    if (existing) {
      throw new CheckinError(409, "already_checked_in", "You have already checked in today");
    }

    ensurePointsAccount(userId);
    held = getHeldPointsCents(userId, settings);
    if (settings.balance_cap_cents > 0 && held.held_cents >= settings.balance_cap_cents) {
      throw new CheckinError(403, "points_cap_reached", CAP_REACHED_MESSAGE);
    }
    if (settings.balance_cap_cents > 0) {
      pointsCents = Math.min(pointsCents, settings.balance_cap_cents - held.held_cents);
      if (pointsCents <= 0) {
        throw new CheckinError(403, "points_cap_reached", CAP_REACHED_MESSAGE);
      }
    }

    const checkinId = uuid();
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO checkin_records (id, user_id, checkin_date, points, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(checkinId, userId, today, pointsCents, createdAt);

    db.prepare(
      `UPDATE points_accounts
       SET balance = balance + ?, lifetime_earned = lifetime_earned + ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(pointsCents, pointsCents, createdAt, userId);

    account = getPointsAccount(userId);
    db.prepare(
      `INSERT INTO points_ledger
        (id, user_id, type, amount, balance_after, description, reference_type, reference_id, created_at)
       VALUES (?, ?, 'checkin', ?, ?, ?, 'checkin', ?, ?)`,
    ).run(
      uuid(),
      userId,
      pointsCents,
      account.balance_cents,
      `Daily check-in ${today} (+${formatPoints(pointsCents)})`,
      checkinId,
      createdAt,
    );

    record = {
      id: checkinId,
      user_id: userId,
      checkin_date: today,
      points: fromCents(pointsCents),
      created_at: createdAt,
    };
  })();

  return {
    record,
    points: {
      balance: account.balance,
      lifetime_earned: account.lifetime_earned,
      lifetime_spent: account.lifetime_spent,
    },
    status: getCheckinStatus(userId),
  };
}

/** Admin/user adjustment. Positive adds points, negative deducts (floored at 0). */
export function adjustPoints(userId: string, points: number, description: string) {
  migratePointsScaleIfNeeded();
  const deltaCents = toCents(points);
  if (!Number.isFinite(deltaCents) || deltaCents === 0) {
    throw new CheckinError(400, "invalid_points", "Points adjustment must be a non-zero number with up to 2 decimals");
  }
  const note = String(description || "").trim() || "Admin points adjustment";
  let account = getPointsAccount(userId);

  db.transaction(() => {
    ensurePointsAccount(userId);
    const current = db.prepare("SELECT balance FROM points_accounts WHERE user_id = ?").get(userId) as {
      balance: number;
    };
    const nextBalance = Math.max(0, current.balance + deltaCents);
    const applied = nextBalance - current.balance;
    if (applied === 0 && deltaCents < 0) {
      throw new CheckinError(400, "insufficient_points", "Points balance is already zero");
    }
    const now = nowIso();
    const earned = applied > 0 ? applied : 0;
    const spent = applied < 0 ? -applied : 0;
    db.prepare(
      `UPDATE points_accounts
       SET balance = ?,
           lifetime_earned = lifetime_earned + ?,
           lifetime_spent = lifetime_spent + ?,
           updated_at = ?
       WHERE user_id = ?`,
    ).run(nextBalance, earned, spent, now, userId);
    account = getPointsAccount(userId);
    db.prepare(
      `INSERT INTO points_ledger
        (id, user_id, type, amount, balance_after, description, reference_type, reference_id, created_at)
       VALUES (?, ?, 'adjustment', ?, ?, ?, 'admin_adjustment', ?, ?)`,
    ).run(uuid(), userId, applied, account.balance_cents, note, uuid(), now);
  })();

  return {
    points: {
      balance: account.balance,
      lifetime_earned: account.lifetime_earned,
      lifetime_spent: account.lifetime_spent,
    },
  };
}

export function exchangePoints(userId: string, points: number) {
  const amountCents = toCents(points);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new CheckinError(400, "invalid_points", "Points must be a positive number with up to 2 decimals");
  }

  const settings = getCheckinSettings();
  if (settings.exchange_micros <= 0) {
    throw new CheckinError(503, "exchange_disabled", "Points exchange is not configured");
  }

  // L13: amountCents * exchange_micros can overflow Number.MAX_SAFE_INTEGER
  // under extreme configs. Use BigInt and reject oversized results.
  const creditMicrosBig =
    (BigInt(amountCents) * BigInt(settings.exchange_micros)) / BigInt(POINTS_SCALE);
  if (creditMicrosBig <= 0n) {
    throw new CheckinError(400, "exchange_too_small", "Exchange amount is too small for the current rate");
  }
  if (creditMicrosBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CheckinError(400, "exchange_too_large", "Exchange amount exceeds the supported range");
  }
  const creditMicros = Number(creditMicrosBig);

  let account = getPointsAccount(userId);
  let wallet = getWallet(userId);
  const displayPoints = fromCents(amountCents);

  db.transaction(() => {
    ensurePointsAccount(userId);
    const current = db.prepare("SELECT balance FROM points_accounts WHERE user_id = ?").get(userId) as {
      balance: number;
    };
    if (current.balance < amountCents) {
      throw new CheckinError(400, "insufficient_points", "Not enough points");
    }

    const now = nowIso();
    const exchangeId = uuid();
    db.prepare(
      `UPDATE points_accounts
       SET balance = balance - ?, lifetime_spent = lifetime_spent + ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(amountCents, amountCents, now, userId);
    account = getPointsAccount(userId);

    db.prepare(
      `INSERT INTO points_ledger
        (id, user_id, type, amount, balance_after, description, reference_type, reference_id, created_at)
       VALUES (?, ?, 'exchange', ?, ?, ?, 'points_exchange', ?, ?)`,
    ).run(
      uuid(),
      userId,
      -amountCents,
      account.balance_cents,
      `Exchange ${formatPoints(amountCents)} points to balance`,
      exchangeId,
      now,
    );

    // Credits go into the hidden check-in pool (still part of total balance_micros).
    // Held points-equivalent is unchanged by exchange alone; spending the balance frees the cap.
    wallet = creditCheckinWallet(userId, creditMicros, now) ?? getWallet(userId);
    const balanceAfter = wallet?.balance_micros ?? 0;
    db.prepare(
      `INSERT INTO wallet_ledger (id, user_id, type, amount_micros, balance_after_micros, description, reference_type, reference_id, created_at)
       VALUES (?, ?, 'points_exchange', ?, ?, ?, 'points_exchange', ?, ?)`,
    ).run(
      uuid(),
      userId,
      creditMicros,
      balanceAfter,
      `Points exchange: ${formatPoints(amountCents)} points`,
      exchangeId,
      now,
    );
  })();

  return {
    points_spent: displayPoints,
    balance_credited_micros: creditMicros,
    points: {
      balance: account.balance,
      lifetime_earned: account.lifetime_earned,
      lifetime_spent: account.lifetime_spent,
    },
    wallet: getPublicWallet(userId),
    status: getCheckinStatus(userId),
  };
}
