import {
  checkClaim, interviewQuestions, runAdvisorRoi,
  type AdvisorRoiInput, type AdvisorRoiResult, type ClaimCheck, type PreHistoryLeg, type ProposedFixes, type TradeClass,
} from "../../../engine/src/advisorRoi/index.js";
import type { ToolDef } from "../tools.js";
import type { ToolSet } from "../session.js";

/**
 * Tools for the Advisor ROI conversation. The engine owns every number and
 * every rule; these tools let Claude read results, ask the engine's
 * questions, test the client's answers, and record what the client confirms.
 */
export interface Answers {
  benchmark?: AdvisorRoiInput["benchmark"];
  symbolMap?: Record<string, string>;
  preHistory?: PreHistoryLeg[];
  transitionWindows?: AdvisorRoiInput["transitionWindows"];
  overrides?: AdvisorRoiInput["overrides"];
}

export interface CheckState {
  /** Input as loaded, before any proposed fix is applied. */
  base: AdvisorRoiInput;
  proposed: ProposedFixes;
  answers: Answers;
  input: AdvisorRoiInput;
  result: AdvisorRoiResult;
  claims: Map<string, ClaimCheck>;
  rejected: Set<string>;
}

/** Apply confirmed answers to the base input and rerun the check. */
export function applyAnswers(base: AdvisorRoiInput, proposed: ProposedFixes, answers: Answers): Omit<CheckState, "claims" | "rejected"> {
  const input: AdvisorRoiInput = {
    ...base,
    symbolMap: { ...(base.symbolMap ?? {}), ...(answers.symbolMap ?? {}) },
    preHistory: [...(base.preHistory ?? []), ...(answers.preHistory ?? []).filter((p) => !(base.preHistory ?? []).some((b) => b.date === p.date && b.symbol === p.symbol))],
    overrides: answers.overrides ?? base.overrides ?? [],
    transitionWindows: answers.transitionWindows ?? base.transitionWindows ?? [],
    benchmark: answers.benchmark ?? base.benchmark,
  };
  return { base, proposed, answers, input, result: runAdvisorRoi(input) };
}

export function newCheckState(base: AdvisorRoiInput, proposed: ProposedFixes, answers: Answers = {}): CheckState {
  return { ...applyAnswers(base, proposed, answers), claims: new Map(), rejected: new Set() };
}

const r0 = (n: number | null | undefined) => (n == null ? null : Math.round(n));
const pct = (n: number | null | undefined) => (n == null ? null : Math.round(n * 10000) / 10000);

function summary(s: CheckState) {
  const r = s.result;
  return {
    reconciled: r.reconciliation.findings.length === 0,
    periods: r.returns.periods.map((p) => ({ period: p.label, accountReturn: pct(p.netReturn), benchmarkReturn: pct(p.benchmarkReturn), dollarsVsBenchmark: r0(p.dollarsVsBenchmark), fees: r0(p.fees) })),
    total: { accountReturn: pct(r.returns.total.netReturn), benchmarkReturn: pct(r.returns.total.benchmarkReturn), benchmark: s.input.benchmark.symbol },
    verdict: {
      feesPaid: r0(r.verdict.feesPaid),
      dollarsVsBenchmarkAfterFees: r0(r.verdict.dollarsVsBenchmarkNetOfFees),
      dollarsVsBenchmarkBeforeFees: r0(r.verdict.dollarsVsBenchmarkBeforeFees),
      advisorDecisionsVsNotTrading: r0(r.verdict.decisionValue?.advisor),
      transitionVsNotTrading: r0(r.verdict.decisionValue?.transition),
      decisionValuePerFeeDollar: r.verdict.decisionValuePerFeeDollar == null ? null : Math.round(r.verdict.decisionValuePerFeeDollar * 100) / 100,
    },
    tradeSummary: r.trades.summary.map((t) => ({
      class: t.tradeClass, days: t.days, cashRaised: r0(t.cashRaised),
      byHorizon: Object.fromEntries(Object.entries(t.byHorizon).map(([h, v]) => [h, { switchValue: r0(v.switchValue), buysVsBenchmark: r0(v.buysVsBenchmark), newCashVsBenchmark: r0(v.newCashVsBenchmark) }])),
    })),
    best: r.verdict.best.map(day),
    worst: r.verdict.worst.map(day),
    excludedErrors: r0(r.trades.excludedErrors.reduce((a, x) => a + x.amount, 0)),
    findings: r.findings.map((f) => ({ severity: f.severity, message: f.message })),
  };
}

function day(d: AdvisorRoiResult["trades"]["days"][number]) {
  return {
    date: d.date, class: d.tradeClass, note: d.note,
    sold: d.sells.map((x) => ({ symbol: x.symbol, amount: r0(x.amount) })),
    bought: d.buys.map((x) => ({ symbol: x.symbol, amount: r0(x.amount) })),
    cashRaised: r0(d.cashRaised),
    scores: Object.fromEntries(Object.entries(d.scores).map(([h, s]) => [h, s && { switchValue: r0(s.switchValue), buyReturn: pct(s.buyReturn), sellReturn: pct(s.sellReturn), benchmarkReturn: pct(s.benchmarkReturn) }])),
  };
}

const str = { type: "string" };
export const ADVISOR_ROI_TOOLS: ToolDef[] = [
  { name: "verdict_summary", description: "The current result of the Advisor ROI check: returns vs benchmark by period, fees, decision value, best and worst trade days, findings. Rerun automatically after every recorded answer.", input_schema: { type: "object", properties: {} } },
  { name: "interview_questions", description: "Questions the engine still needs the client to answer, most important first, with the facts behind each and the dollars at stake.", input_schema: { type: "object", properties: {} } },
  { name: "trade_day", description: "Everything about one trade day: what was sold and bought, amounts, returns at each horizon, class.", input_schema: { type: "object", properties: { date: str }, required: ["date"] } },
  {
    name: "check_claim",
    description: "Test what the client says about a trade day against the transactions before recording it. claim: cash_raise (sold to raise money), client_directed (the client's instruction), error (a mistake the advisor fixed).",
    input_schema: { type: "object", properties: { date: str, claim: { type: "string", enum: ["cash_raise", "client_directed", "error"] } }, required: ["date", "claim"] },
  },
  {
    name: "record_answer",
    description:
      "Record the client's answer to one interview question and rerun the check. For a trade day, tradeClass is advisor (advisor's decision, stays scored), client_directed or error (both excluded). Excluding a day requires check_claim first; if the data contradicted the claim and the client still insists after hearing the evidence, set againstEvidence true.",
    input_schema: {
      type: "object",
      properties: {
        questionId: str,
        decision: { type: "string", enum: ["confirm", "reject"] },
        tradeClass: { type: "string", enum: ["advisor", "client_directed", "error"] },
        note: str,
        againstEvidence: { type: "boolean" },
        benchmarkSymbol: str,
      },
      required: ["questionId", "decision", "note"],
    },
  },
  {
    name: "add_up",
    description: "Add and subtract labeled amounts. Use this for any arithmetic instead of doing it yourself.",
    input_schema: { type: "object", properties: { terms: { type: "array", items: { type: "object", properties: { label: str, value: { type: "number" }, sign: { type: "string", enum: ["+", "-"] } }, required: ["label", "value", "sign"] } } }, required: ["terms"] },
  },
];

export function advisorRoiToolSet(state: CheckState, onAnswers?: (a: Answers) => void): ToolSet {
  const rerun = () => {
    const next = applyAnswers(state.base, state.proposed, state.answers);
    state.input = next.input; state.result = next.result;
    onAnswers?.(state.answers);
  };
  const open = () => interviewQuestions(state.input, state.result, {
    renames: Object.fromEntries(Object.entries(state.proposed.renames).filter(([k]) => !(k in (state.answers.symbolMap ?? {})) && !state.rejected.has(`rename:${k}`))),
    preHistory: state.proposed.preHistory.filter((p) => !(state.answers.preHistory ?? []).some((a) => a.date === p.date && a.symbol === p.symbol) && !state.rejected.has(`pre:${p.date}:${p.symbol}`)),
  }).filter((q) => !state.rejected.has(q.id) && !(q.id === "benchmark" && state.answers.benchmark));

  return {
    defs: ADVISOR_ROI_TOOLS,
    sourceTools: new Set(["verdict_summary", "interview_questions", "trade_day", "check_claim", "record_answer"]),
    execute(name, input) {
      switch (name) {
        case "verdict_summary": return summary(state);
        case "interview_questions": {
          const qs = open();
          return { remaining: qs.length, questions: qs.map((q) => ({ ...q, stakes: r0(q.stakes) })) };
        }
        case "trade_day": {
          const d = state.result.trades.days.find((x) => x.date === input.date);
          return d ? day(d) : { error: `No trades on ${String(input.date)}` };
        }
        case "check_claim": {
          const c = checkClaim(state.input, state.result, String(input.date), input.claim as "cash_raise");
          state.claims.set(`${c.date}|${c.claim}`, c);
          return c;
        }
        case "record_answer": return record(state, input, rerun, () => open().length);
        case "add_up": {
          const terms = (input.terms as { label: string; value: number; sign: string }[]) ?? [];
          return { total: terms.reduce((s, t) => s + (t.sign === "-" ? -t.value : t.value), 0) };
        }
        default: return { error: `Unknown tool ${name}` };
      }
    },
  };
}

function record(state: CheckState, input: Record<string, unknown>, rerun: () => void, remaining: () => number) {
  const id = String(input.questionId);
  const decision = input.decision as "confirm" | "reject";
  const note = String(input.note ?? "");
  const a = state.answers;

  if (id.startsWith("rename:")) {
    const from = id.slice(7);
    const to = state.proposed.renames[from];
    if (!to) return { error: `No proposed rename for ${from}` };
    if (decision === "reject") { state.rejected.add(id); return { recorded: id, decision }; }
    a.symbolMap = { ...(a.symbolMap ?? {}), [from]: to };
  } else if (id.startsWith("pre:")) {
    const [, date, symbol] = id.split(":");
    const leg = state.proposed.preHistory.find((p) => p.date === date && p.symbol === symbol);
    if (!leg) return { error: `No proposed trade ${id}` };
    if (decision === "reject") { state.rejected.add(id); return { recorded: id, decision }; }
    a.preHistory = [...(a.preHistory ?? []), leg];
  } else if (id.startsWith("day:")) {
    const date = id.slice(4);
    const tradeClass = (input.tradeClass as TradeClass | undefined) ?? (decision === "confirm" ? "advisor" : undefined);
    if (!tradeClass) return { error: "tradeClass is required for a trade day" };
    let finalNote = note;
    if (tradeClass !== "advisor") {
      const claimKind = tradeClass === "error" ? "error" : "client_directed";
      const checks = [...state.claims.values()].filter((c) => c.date === date);
      if (!checks.length) return { error: `Run check_claim for ${date} before excluding it from the score.` };
      const contradicted = checks.some((c) => c.consistent === false);
      if (contradicted && input.againstEvidence !== true) {
        return { error: "The data contradicted the client's account of this day. Show them the evidence; record it as excluded only if they still insist (againstEvidence true)." };
      }
      if (contradicted) finalNote = `[Client asserted against the data] ${note}`;
      else if (!checks.some((c) => c.claim === claimKind)) finalNote = `${note} (not verifiable from the transactions)`;
    }
    a.overrides = [...(a.overrides ?? []).filter((o) => o.date !== date), { date, tradeClass, note: finalNote }];
  } else if (id === "benchmark") {
    const sym = String(input.benchmarkSymbol ?? "");
    if (!sym) return { error: "benchmarkSymbol is required" };
    if (!state.input.prices[sym]) return { error: `No prices for ${sym}; pick a benchmark with a price history.` };
    a.benchmark = { symbol: sym };
  } else return { error: `Unknown question ${id}` };

  const before = state.result.verdict;
  rerun();
  const after = state.result.verdict;
  return {
    recorded: id, decision,
    verdictBefore: { afterFees: r0(before.dollarsVsBenchmarkNetOfFees), advisorDecisions: r0(before.decisionValue?.advisor) },
    verdictAfter: { afterFees: r0(after.dollarsVsBenchmarkNetOfFees), advisorDecisions: r0(after.decisionValue?.advisor) },
    remainingQuestions: remaining(),
  };
}
