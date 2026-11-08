import { addDays } from "./dates.js";
import { externalFlows } from "./returns.js";
import type { AdvisorRoiResult } from "./check.js";
import type { ProposedFixes } from "./build.js";
import type { AdvisorRoiInput } from "./types.js";

/**
 * The context interview, deterministic half. The engine decides what to ask
 * and tests every answer against the data; Claude only conducts the
 * conversation. A client's answer never changes the score unless the data is
 * consistent with it, or the client confirms after seeing the evidence.
 */

export type QuestionKind = "confirm_rename" | "confirm_pre_history" | "who_decided" | "benchmark";

export interface Question {
  id: string;
  kind: QuestionKind;
  /** Why the answer matters: the dollars at stake in the score, where known. */
  stakes: number | null;
  /** What the question is about, for Claude to phrase. Facts only. */
  facts: Record<string, unknown>;
}

export function interviewQuestions(input: AdvisorRoiInput, result: AdvisorRoiResult, proposed: ProposedFixes, top = 5): Question[] {
  const qs: Question[] = [];
  for (const [from, to] of Object.entries(proposed.renames)) {
    qs.push({ id: `rename:${from}`, kind: "confirm_rename", stakes: null, facts: { oldSymbol: from, newSymbol: to } });
  }
  for (const l of proposed.preHistory) {
    qs.push({ id: `pre:${l.date}:${l.symbol}`, kind: "confirm_pre_history", stakes: l.amount, facts: { ...l } });
  }
  const answered = new Set((input.overrides ?? []).map((o) => o.date));
  const scored = result.trades.days.filter((d) => d.tradeClass === "advisor" && d.scores.latest && !answered.has(d.date));
  const byImpact = [...scored].sort((a, b) => Math.abs(b.scores.latest!.switchValue) - Math.abs(a.scores.latest!.switchValue)).slice(0, top);
  // Only days that move the score are worth the client's time. Pure selling
  // is already treated as the client's cash raise and isn't scored.
  for (const d of byImpact.filter((x) => x.scores.latest!.switchValue !== 0)) {
    qs.push({
      id: `day:${d.date}`,
      kind: "who_decided",
      stakes: d.scores.latest?.switchValue ?? 0,
      facts: {
        date: d.date,
        sold: d.sells.map((s) => ({ symbol: s.symbol, amount: Math.round(s.amount) })),
        bought: d.buys.map((b) => ({ symbol: b.symbol, amount: Math.round(b.amount) })),
        cashRaised: Math.round(d.cashRaised),
        valueVsNotTrading: Math.round(d.scores.latest?.switchValue ?? 0),
      },
    });
  }
  if (!input.benchmark.periodReturns) {
    qs.push({ id: "benchmark", kind: "benchmark", stakes: null, facts: { current: input.benchmark.symbol } });
  }
  return qs;
}

export type ClaimKind = "cash_raise" | "client_directed" | "error";

export interface ClaimCheck {
  date: string;
  claim: ClaimKind;
  /** true: the data supports it. false: the data contradicts it. null: the data can't tell. */
  consistent: boolean | null;
  explanation: string;
  evidence: Record<string, unknown>;
}

const WITHDRAWAL_MIN = 10_000;

/** Test what the client says about a trade day against the transactions. */
export function checkClaim(input: AdvisorRoiInput, result: AdvisorRoiResult, date: string, claim: ClaimKind): ClaimCheck {
  if (claim === "error") {
    const cancels = input.transactions.filter((t) => t.action.startsWith("Cancel") && (t.asOf ?? t.date) === date);
    if (cancels.length) return { date, claim, consistent: true, explanation: "The custodian cancelled trades from this day; they are already excluded.", evidence: { cancelled: cancels.map((c) => c.symbol) } };
  }
  const day = result.trades.days.find((d) => d.date === date);
  if (!day) {
    return { date, claim, consistent: false, explanation: "There were no trades on this date.", evidence: {} };
  }
  const base = { buyTotal: Math.round(day.buyTotal), sellTotal: Math.round(day.sellTotal), cashRaised: Math.round(day.cashRaised) };

  if (claim === "cash_raise") {
    const outflows = externalFlows(input).filter((f) => f.amount <= -WITHDRAWAL_MIN && f.date >= date && f.date <= addDays(date, 60));
    if (day.cashRaised > 0) {
      return {
        date, claim, consistent: true,
        explanation: "Sales exceeded purchases that day, so cash was raised. The raised cash is already left out of the score; only the matched part of buying and selling is scored.",
        evidence: { ...base, withdrawalsWithin60Days: outflows.map((f) => ({ date: f.date, amount: Math.round(f.amount) })) },
      };
    }
    // Where did the cash for those withdrawals actually come from?
    const raises = result.trades.days
      .filter((d) => d.cashRaised > 0 && outflows.some((f) => d.date <= f.date && d.date >= addDays(f.date, -45)))
      .map((d) => ({ date: d.date, cashRaised: Math.round(d.cashRaised), sold: [...new Set(d.sells.map((s) => s.symbol))] }));
    return {
      date, claim, consistent: false,
      explanation: "Purchases matched or exceeded sales that day, so no cash left the portfolio. The proceeds were reinvested the same day.",
      evidence: { ...base, withdrawalsWithin60Days: outflows.map((f) => ({ date: f.date, amount: Math.round(f.amount) })), cashActuallyRaisedOn: raises },
    };
  }

  if (claim === "error") {
    return { date, claim, consistent: null, explanation: "No cancellation is recorded for this day. An error may have been fixed another way; the advisor's confirmation would settle it.", evidence: base };
  }

  // client_directed: the transactions can't show who made the call.
  return {
    date, claim, consistent: null,
    explanation: day.buyTotal > 0 && day.sellTotal > 0
      ? "The data can't show who decided. Note that money was also reinvested the same day; if only the sale was the client's instruction, the advisor still chose what to buy."
      : "The data can't show who decided. A sell-only day is consistent with a client instruction.",
    evidence: base,
  };
}
