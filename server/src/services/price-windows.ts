import type { PriceWindow } from "../db";

export const PRICE_WINDOW_TZ = "Asia/Shanghai";
export const MAX_PRICE_WINDOWS = 16;

const CLOCK = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function normalizeClock(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute === 0) return "24:00";
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function clockToMinutes(value: string): number | null {
  const clock = normalizeClock(value);
  if (!clock || !CLOCK.test(clock)) return null;
  if (clock === "24:00") return 1440;
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = [...new Set(value.map((item) => Number(item)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  days.sort((a, b) => a - b);
  return days;
}

function nonNegInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

export function parsePriceWindow(raw: unknown): PriceWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const start = normalizeClock(String(row.start ?? ""));
  const end = normalizeClock(String(row.end ?? ""));
  if (!start || !end) return null;
  const startMin = clockToMinutes(start);
  const endMin = clockToMinutes(end);
  if (startMin == null || endMin == null || startMin === endMin) return null;
  const input = nonNegInt(row.input_price_micros);
  const output = nonNegInt(row.output_price_micros);
  const cacheRead = nonNegInt(row.cache_read_price_micros ?? 0);
  const cacheWrite = nonNegInt(row.cache_write_price_micros ?? 0);
  if (input == null || output == null || cacheRead == null || cacheWrite == null) return null;
  return {
    start,
    end,
    days: normalizeDays(row.days),
    input_price_micros: input,
    output_price_micros: output,
    cache_read_price_micros: cacheRead,
    cache_write_price_micros: cacheWrite,
  };
}

export function parsePriceWindows(raw: unknown): PriceWindow[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const windows: PriceWindow[] = [];
  for (const item of value) {
    const parsed = parsePriceWindow(item);
    if (parsed) windows.push(parsed);
    if (windows.length >= MAX_PRICE_WINDOWS) break;
  }
  return windows;
}

export function serializePriceWindows(windows: PriceWindow[]): string {
  return JSON.stringify(parsePriceWindows(windows));
}

export function minutesInWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export function shanghaiClock(at: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PRICE_WINDOW_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const day = WEEKDAY_SHORT.indexOf(weekday);
  return {
    day: day >= 0 ? day : 0,
    minutes: hour * 60 + minute,
  };
}

export function findActiveWindowIndex(windows: PriceWindow[], at = new Date()): number | null {
  if (!windows.length) return null;
  const clock = shanghaiClock(at);
  const index = windows.findIndex((window) => {
    if (window.days.length > 0 && !window.days.includes(clock.day)) return false;
    const startMin = clockToMinutes(window.start);
    const endMin = clockToMinutes(window.end);
    if (startMin == null || endMin == null) return false;
    return minutesInWindow(clock.minutes, startMin, endMin);
  });
  return index >= 0 ? index : null;
}

type Priced = {
  input_price_micros: number;
  output_price_micros: number;
  cache_read_price_micros: number;
  cache_write_price_micros: number;
  windows?: PriceWindow[];
};

export function applyPriceWindows<T extends Priced>(price: T, at = new Date()): T & { active_window_index: number | null } {
  const windows = price.windows ?? [];
  const index = findActiveWindowIndex(windows, at);
  if (index == null) return { ...price, active_window_index: null };
  const hit = windows[index];
  return {
    ...price,
    input_price_micros: hit.input_price_micros,
    output_price_micros: hit.output_price_micros,
    cache_read_price_micros: hit.cache_read_price_micros,
    cache_write_price_micros: hit.cache_write_price_micros,
    active_window_index: index,
  };
}
