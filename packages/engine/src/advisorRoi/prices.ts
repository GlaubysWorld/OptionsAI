import type { PriceTable } from "./types.js";

/** Minimum history for a series to count as priced (guards against stubs). */
const MIN_POINTS = 5;

/** Adjusted close on or before `date`, or null if unknown. */
export function adjustedPrice(table: PriceTable, symbol: string, date: string): number | null {
  const s = table[symbol];
  if (!s || s.dates.length < MIN_POINTS) return null;
  let lo = 0, hi = s.dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid]! <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : s.adj[found]!;
}

/** Total return (dividends and splits included) from one date to another. */
export function adjustedReturn(table: PriceTable, symbol: string, from: string, to: string): number | null {
  const a = adjustedPrice(table, symbol, from);
  const b = adjustedPrice(table, symbol, to);
  return a === null || b === null ? null : b / a - 1;
}

export function latestPriceDate(table: PriceTable): string {
  return Object.values(table).reduce((m, s) => (s.dates.length && s.dates[s.dates.length - 1]! > m ? s.dates[s.dates.length - 1]! : m), "");
}

/** Unadjusted close on or before `date` (to value shares that day), or null. */
export function closePrice(table: PriceTable, symbol: string, date: string): number | null {
  const s = table[symbol];
  if (!s?.close || s.dates.length < MIN_POINTS) return null;
  let lo = 0, hi = s.dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid]! <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const v = found < 0 ? null : s.close[found]!;
  return v !== null && Number.isFinite(v) ? v : null;
}
