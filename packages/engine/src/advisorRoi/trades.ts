import type { Finding } from "../findings.js";
import { addDays } from "./dates.js";
import { adjustedReturn, latestPriceDate } from "./prices.js";
import type { AdvisorRoiInput, TradeClass } from "./types.js";

export interface Leg { symbol: string; amount: number }

export interface HorizonScore {
  horizon: string;
  /** Value of the swap vs not trading: matched amount x (buy return - sell return). */
  switchValue: number;
  /** Were the buys better than the benchmark, on the matched amount. */
  buysVsBenchmark: number;
  /** New cash put to work (net buys) vs the benchmark. */
  newCashVsBenchmark: number;
  buyReturn: number | null;
  sellReturn: number | null;
  benchmarkReturn: number | null;
}

export interface TradeDay {
  date: string;
  tradeClass: TradeClass;
  note?: string;
  buys: Leg[];
  sells: Leg[];
  buyTotal: number;
  sellTotal: number;
  /** Net selling that raised cash. The decision to raise cash is the client's; not scored. */
  cashRaised: number;
  scores: Record<string, HorizonScore | null>;
}

export interface TradeSummary {
  tradeClass: TradeClass;
  days: number;
  buys: number;
  sells: number;
  cashRaised: number;
  byHorizon: Record<string, { switchValue: number; buysVsBenchmark: number; newCashVsBenchmark: number }>;
}

export interface TradesResult {
  priceDate: string;
  days: TradeDay[];
  summary: TradeSummary[];
  excludedErrors: { date: string; symbol: string; amount: number }[];
  findings: Finding[];
}

/** Weighted average return of legs; legs without prices are skipped and reported. */
function legReturn(input: AdvisorRoiInput, legs: Leg[], from: string, to: string, unpriced: Set<string>) {
  let tot = 0, w = 0;
  for (const l of legs) {
    const r = adjustedReturn(input.prices, l.symbol, from, to);
    if (r === null) { unpriced.add(l.symbol); continue; }
    tot += l.amount * r; w += l.amount;
  }
  return w > 0 ? tot / w : null;
}

/**
 * Score every day the account traded. For each day: the matched part of buys
 * and sells is a switch (what was bought vs what was sold); net buying is new
 * cash (judged against the benchmark); net selling raised cash (not judged).
 */
export function scoreTrades(input: AdvisorRoiInput): TradesResult {
  const map = input.symbolMap ?? {};
  const cash = new Set(input.cashSymbols ?? []);
  const norm = (s: string) => map[s] ?? s;
  const priceDate = latestPriceDate(input.prices);
  const horizons = input.horizons ?? [91, 182, 365];
  const unpriced = new Set<string>();
  const findings: Finding[] = [];

  // Sells later cancelled by the custodian are errors, not decisions.
  const cancels = input.transactions.filter((t) => t.action === "Cancel Sell");
  const excludedErrors: TradesResult["excludedErrors"] = [];
  const isCancelled = (t: { date: string; symbol: string; amount: number }) =>
    cancels.some((c) => (c.asOf ?? c.date) === t.date && c.symbol === t.symbol && Math.abs(Math.abs(c.amount) - Math.abs(t.amount)) < 0.01);

  const days = new Map<string, { buys: Leg[]; sells: Leg[] }>();
  const day = (d: string) => days.get(d) ?? (days.set(d, { buys: [], sells: [] }), days.get(d)!);
  for (const t of input.transactions) {
    if (t.action !== "Buy" && t.action !== "Sell") continue;
    const s = norm(t.symbol);
    if (cash.has(s)) continue;
    if (t.action === "Sell" && isCancelled(t)) { excludedErrors.push({ date: t.date, symbol: s, amount: Math.abs(t.amount) }); continue; }
    (t.action === "Buy" ? day(t.date).buys : day(t.date).sells).push({ symbol: s, amount: Math.abs(t.amount) });
  }
  for (const p of input.preHistory ?? []) {
    (p.side === "buy" ? day(p.date).buys : day(p.date).sells).push({ symbol: norm(p.symbol), amount: p.amount });
    if (p.approximate) findings.push({ code: "APPROXIMATE_INPUT", severity: "warn", message: `${p.side} of ${p.symbol} on ${p.date} predates the transaction file; amount estimated.` });
  }

  const override = new Map((input.overrides ?? []).map((o) => [o.date, o]));
  const inTransition = (d: string) => (input.transitionWindows ?? []).find((w) => d >= w.from && d <= w.to);

  const out: TradeDay[] = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, { buys, sells }]) => {
      const o = override.get(date);
      const tw = inTransition(date);
      const tradeClass: TradeClass = o?.tradeClass ?? (tw ? "transition" : "advisor");
      const B = buys.reduce((s, l) => s + l.amount, 0);
      const S = sells.reduce((s, l) => s + l.amount, 0);
      const m = Math.min(B, S);
      const scores: Record<string, HorizonScore | null> = {};
      const targets: [string, string | null][] = [["latest", priceDate], ...horizons.map((h): [string, string | null] => {
        const end = addDays(date, h);
        return [`${h}d`, end > priceDate ? null : end];
      })];
      for (const [name, end] of targets) {
        if (end === null) { scores[name] = null; continue; }
        const rb = legReturn(input, buys, date, end, unpriced);
        const rs = legReturn(input, sells, date, end, unpriced);
        const rm = adjustedReturn(input.prices, input.benchmark.symbol, date, end);
        scores[name] = {
          horizon: name,
          switchValue: rb !== null && rs !== null && m > 0 ? m * (rb - rs) : 0,
          buysVsBenchmark: rb !== null && rm !== null && m > 0 ? m * (rb - rm) : 0,
          newCashVsBenchmark: B > S && rb !== null && rm !== null ? (B - S) * (rb - rm) : 0,
          buyReturn: rb, sellReturn: rs, benchmarkReturn: rm,
        };
      }
      return { date, tradeClass, ...(o ? { note: o.note } : tw ? { note: tw.label } : {}), buys, sells, buyTotal: B, sellTotal: S, cashRaised: Math.max(0, S - B), scores };
    });

  if (unpriced.size) {
    findings.push({
      code: "UNPRICED", severity: "warn",
      message: `No usable prices for ${[...unpriced].sort().join(", ")}; those legs are left out of the trade scores.`,
      details: { symbols: [...unpriced].sort() },
    });
  }

  const classes: TradeClass[] = ["advisor", "transition", "client_directed", "error"];
  const summary = classes
    .map((c) => {
      const ds = out.filter((d) => d.tradeClass === c);
      const byHorizon: TradeSummary["byHorizon"] = {};
      for (const h of ["latest", ...horizons.map((x) => `${x}d`)]) {
        const sc = ds.map((d) => d.scores[h]).filter((s): s is HorizonScore => !!s);
        byHorizon[h] = {
          switchValue: sc.reduce((s, x) => s + x.switchValue, 0),
          buysVsBenchmark: sc.reduce((s, x) => s + x.buysVsBenchmark, 0),
          newCashVsBenchmark: sc.reduce((s, x) => s + x.newCashVsBenchmark, 0),
        };
      }
      return { tradeClass: c, days: ds.length, buys: ds.reduce((s, d) => s + d.buyTotal, 0), sells: ds.reduce((s, d) => s + d.sellTotal, 0), cashRaised: ds.reduce((s, d) => s + d.cashRaised, 0), byHorizon };
    })
    .filter((s) => s.days > 0);

  return { priceDate, days: out, summary, excludedErrors, findings };
}
