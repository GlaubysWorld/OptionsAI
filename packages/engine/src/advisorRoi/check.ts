import type { Finding } from "../findings.js";
import { reconcileHoldings, type ReconciliationResult } from "./replay.js";
import { accountReturns, type ReturnsResult } from "./returns.js";
import { scoreTrades, type TradeDay, type TradesResult } from "./trades.js";
import type { AdvisorRoiInput } from "./types.js";

export interface AdvisorRoiResult {
  reconciliation: ReconciliationResult;
  returns: ReturnsResult;
  trades: TradesResult;
  /** The verdict in dollars. Null where a blocking finding makes a figure untrustworthy. */
  verdict: {
    feesPaid: number;
    dollarsVsBenchmarkNetOfFees: number | null;
    dollarsVsBenchmarkBeforeFees: number | null;
    decisionValue: { advisor: number; transition: number; total: number } | null;
    /** Decision value per dollar of fees. Below 0 means the trading itself lost money. */
    decisionValuePerFeeDollar: number | null;
    best: TradeDay[];
    worst: TradeDay[];
  };
  findings: Finding[];
}

/**
 * The Advisor ROI check. Reconcile first: if holdings don't tie to the
 * statements, trade scores are withheld and the verdict says so.
 */
export function runAdvisorRoi(input: AdvisorRoiInput): AdvisorRoiResult {
  const reconciliation = reconcileHoldings(input);
  const returns = accountReturns(input);
  const trades = scoreTrades(input);
  const findings = [...reconciliation.findings, ...returns.findings, ...trades.findings];
  const blocked = reconciliation.findings.some((f) => f.severity === "block");

  const sw = (c: string) => trades.summary.find((s) => s.tradeClass === c)?.byHorizon.latest?.switchValue ?? 0;
  const advisor = sw("advisor"), transition = sw("transition");
  const fees = returns.total.fees;
  const vsNet = returns.total.dollarsVsBenchmark;
  const scored = trades.days.filter((d) => (d.tradeClass === "advisor" || d.tradeClass === "transition") && d.scores.latest);
  const byValue = [...scored].sort((a, b) => a.scores.latest!.switchValue - b.scores.latest!.switchValue);

  return {
    reconciliation,
    returns,
    trades,
    verdict: {
      feesPaid: fees,
      dollarsVsBenchmarkNetOfFees: vsNet,
      dollarsVsBenchmarkBeforeFees: vsNet === null ? null : vsNet + fees,
      decisionValue: blocked ? null : { advisor, transition, total: advisor + transition },
      decisionValuePerFeeDollar: blocked || fees === 0 ? null : (advisor + transition) / fees,
      best: blocked ? [] : byValue.slice(-5).reverse(),
      worst: blocked ? [] : byValue.slice(0, 5),
    },
    findings,
  };
}
