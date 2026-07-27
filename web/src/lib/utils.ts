import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatMs(n: number): string {
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function formatCredits(micros: number | null | undefined): string {
  const value = Number(micros || 0) / 1_000_000;
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * Plain decimal string for number inputs.
 * Do NOT use locale grouping (e.g. 1,000.00) — type="number" rejects it and shows blank.
 */
export function formatCreditsInput(micros: number | null | undefined): string {
  const value = Number(micros || 0) / 1_000_000;
  if (!Number.isFinite(value)) return "0";
  // Trim trailing zeros but keep a stable editable form value.
  const fixed = value.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed || "0";
}

/** Compact credit display for dense UI; hover can still show formatCredits(). */
export function formatCreditsDisplay(micros: number | null | undefined): string {
  const value = Number(micros || 0) / 1_000_000;
  const abs = Math.abs(value);
  if (abs === 0) return "0.00";
  if (abs < 0.01) {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }
  if (abs < 1) {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function creditsToMicros(value: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
  }
  // Accept pasted locale strings like "1,000.50" or "1.000,50".
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  let normalized = raw.replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    // Decide decimal separator by the last occurring symbol.
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (normalized.includes(",")) {
    // Either thousands or decimal comma — treat single trailing group as decimal.
    const parts = normalized.split(",");
    normalized =
      parts.length === 2 && parts[1].length <= 6
        ? `${parts[0].replace(/\./g, "")}.${parts[1]}`
        : normalized.replace(/,/g, "");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 1_000_000) : 0;
}
