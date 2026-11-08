import type { Finding } from "../findings.js";
import { daysBetween } from "./dates.js";
import { adjustedReturn } from "./prices.js";
import type { AdvisorRoiInput } from "./types.js";

/** Actions that move money in or out of the account (not investment results). */
const FLOW_ACTIONS = new Set(["MoneyLink Transfer", "MoneyLink Adj", "Wire Sent", "Wire Funds Adj", "Wire Received", "Funds Received", "Funds Paid"]);
const FEE_ACTIONS = new Set(["Advisor Fee"]);

export interface Flow { date: string; amount: number; label: string; approximate?: boolean }

export function externalFlows(input: AdvisorRoiInput): Flow[] {
  const fromTxns = input.transactions
    .filter((t) => FLOW_ACTIONS.has(t.action))
    .map((t) => ({ date: t.date, amount: t.amount, label: t.action }));
  return [...fromTxns, ...(input.externalFlows ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function advisorFees(input: AdvisorRoiInput): Flow[] {
  return input.transactions
    .filter((t) => FEE_ACTIONS.has(t.action))
    .map((t) => ({ date: t.date, amount: -t.amount, label: "Advisor fee" }));
}

export interface IntervalReturn {
  from: string;
  to: string;
  netReturn: number;
  grossReturn: number;
  netFlows: number;
  fees: number;
  investmentGain: number;
}

/**
 * Modified Dietz between two valuations: gain net of flows over capital
 * weighted by how long each flow was in the account. Withdrawals never count
 * against the advisor. Fees stay inside (net) or are added back (gross).
 */
export function modifiedDietz(
  v0: number, v1: number, from: string, to: string, flows: Flow[], fees: Flow[], gross: boolean,
): { ret: number; gain: number; netFlows: number; fees: number } {
  const T = daysBetween(from, to);
  const fl = flows.filter((f) => f.date > from && f.date <= to);
  const fe = fees.filter((f) => f.date > from && f.date <= to);
  const netFlows = fl.reduce((s, f) => s + f.amount, 0);
  const feeTotal = fe.reduce((s, f) => s + f.amount, 0);
  let gain = v1 - v0 - netFlows;
  let weighted = fl.reduce((s, f) => s + (f.amount * daysBetween(f.date, to)) / T, 0);
  if (gross) {
    gain += feeTotal;
    weighted += fe.reduce((s, f) => s + (f.amount * daysBetween(f.date, to)) / T, 0);
  }
  return { ret: gain / (v0 + weighted), gain: v1 - v0 - netFlows, netFlows, fees: feeTotal };
}

export interface PeriodResult {
  label: string;
  from: string;
  to: string;
  netReturn: number;
  grossReturn: number;
  benchmarkReturn: number | null;
  /** Net return minus benchmark, applied to time-weighted capital. */
  dollarsVsBenchmark: number | null;
  averageCapital: number;
  fees: number;
}

export interface ReturnsResult {
  intervals: IntervalReturn[];
  periods: PeriodResult[];
  total: { netReturn: number; grossReturn: number; benchmarkReturn: number | null; dollarsVsBenchmark: number | null; fees: number };
  findings: Finding[];
}

/** Group consecutive statement intervals by the calendar year they end in. */
export function accountReturns(input: AdvisorRoiInput): ReturnsResult {
  const snaps = [...input.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));
  const flows = externalFlows(input);
  const fees = advisorFees(input);
  const findings: Finding[] = [];
  for (const f of flows.filter((x) => x.approximate)) {
    findings.push({ code: "APPROXIMATE_INPUT", severity: "warn", message: `Estimated input: ${f.label} (${f.date}).`, details: { ...f } });
  }

  const intervals: IntervalReturn[] = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1]!, b = snaps[i]!;
    const net = modifiedDietz(a.accountValue, b.accountValue, a.date, b.date, flows, fees, false);
    const gross = modifiedDietz(a.accountValue, b.accountValue, a.date, b.date, flows, fees, true);
    intervals.push({ from: a.date, to: b.date, netReturn: net.ret, grossReturn: gross.ret, netFlows: net.netFlows, fees: net.fees, investmentGain: net.gain });
  }

  // Group intervals by the calendar year they end in. Labels are "from to to"
  // so published benchmark returns can be keyed exactly.
  const byYear = new Map<string, IntervalReturn[]>();
  for (const iv of intervals) byYear.set(iv.to.slice(0, 4), [...(byYear.get(iv.to.slice(0, 4)) ?? []), iv]);

  const valueAt = new Map(snaps.map((s) => [s.date, s.accountValue]));
  const periods: PeriodResult[] = [];
  let totN = 1, totG = 1, totB = 1, totUsd = 0, totFees = 0, bmMissing = false;
  for (const ivs of byYear.values()) {
    const from = ivs[0]!.from, to = ivs[ivs.length - 1]!.to;
    const label = `${from} to ${to}`;
    const net = ivs.reduce((p, iv) => p * (1 + iv.netReturn), 1) - 1;
    const gross = ivs.reduce((p, iv) => p * (1 + iv.grossReturn), 1) - 1;
    const T = daysBetween(from, to);
    const cap = valueAt.get(from)! + flows.filter((f) => f.date > from && f.date <= to).reduce((s, f) => s + (f.amount * daysBetween(f.date, to)) / T, 0);
    const published = input.benchmark.periodReturns?.[label];
    const bm = published ?? adjustedReturn(input.prices, input.benchmark.symbol, from, to);
    if (bm === null) bmMissing = true;
    const usd = bm === null ? null : (net - bm) * cap;
    const fee = ivs.reduce((s, iv) => s + iv.fees, 0);
    periods.push({ label, from, to, netReturn: net, grossReturn: gross, benchmarkReturn: bm, dollarsVsBenchmark: usd, averageCapital: cap, fees: fee });
    totN *= 1 + net; totG *= 1 + gross; if (bm !== null) totB *= 1 + bm; totUsd += usd ?? 0; totFees += fee;
  }
  if (bmMissing) findings.push({ code: "UNPRICED", severity: "warn", message: `No benchmark return for one or more periods.` });
  return {
    intervals,
    periods,
    total: { netReturn: totN - 1, grossReturn: totG - 1, benchmarkReturn: bmMissing ? null : totB - 1, dollarsVsBenchmark: bmMissing ? null : totUsd, fees: totFees },
    findings,
  };
}
