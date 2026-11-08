import { describe, expect, it } from "vitest";
import type { AdvisorRoiInput, Txn } from "../../engine/src/advisorRoi/index.js";
import { Session, type MessageResponse, type MessagesClient } from "../src/session.js";
import { ADVISOR_ROI_TOOLS, advisorRoiToolSet, newCheckState, type Answers } from "../src/advisorRoi/tools.js";
import { advisorRoiPrompt } from "../src/advisorRoi/prompt.js";

const series = (start: string, values: number[]) => {
  const d0 = Date.parse(`${start}T00:00:00Z`);
  return { dates: values.map((_, i) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10)), adj: values };
};
const tx = (date: string, action: string, symbol: string, quantity: number, amount: number): Txn =>
  ({ date, action, symbol, description: "", quantity, price: null, fees: 0, amount });
const input = (): AdvisorRoiInput => ({
  transactions: [
    tx("2026-01-02", "Sell", "WIN", 1000, 100_000), tx("2026-01-02", "Buy", "LOSE", 1000, -100_000),
    tx("2026-01-04", "Sell", "LOSE", 500, 50_000), tx("2026-01-06", "Wire Sent", "", 0, -50_000),
  ],
  snapshots: [{ date: "2026-01-01", accountValue: 100_000, positions: { WIN: 1000 } }],
  prices: {
    WIN: series("2026-01-01", [100, 100, 100, 100, 100, 200, 200, 200, 200, 200]),
    LOSE: series("2026-01-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 50]),
    IDX: series("2026-01-01", [100, 100, 100, 100, 100, 110, 110, 110, 110, 110]),
  },
  benchmark: { symbol: "IDX" },
  horizons: [],
});

function scripted(responses: MessageResponse[]) {
  const client: MessagesClient = { messages: { async create() { const n = responses.shift(); if (!n) throw new Error("script ran out"); return n; } } };
  return client;
}
let n = 0;
const use = (name: string, input: Record<string, unknown>): MessageResponse => ({ content: [{ type: "tool_use", id: `t${n++}`, name, input }], stop_reason: "tool_use" });
const say = (t: string): MessageResponse => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const lastResult = (s: Session) => s.toolOutputs[s.toolOutputs.length - 1] as Record<string, unknown>;

describe("Advisor ROI tools", () => {
  it("has unique tool names and object schemas", () => {
    const names = ADVISOR_ROI_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(advisorRoiPrompt({ advisorName: "Acme" })).toContain("Five questions to put to Acme");
  });

  it("won't exclude a day until the claim is checked, and won't accept a contradicted claim without the client insisting", async () => {
    const saved: Answers[] = [];
    const state = newCheckState(input(), { renames: {}, preHistory: [] });
    const session = new Session({
      client: scripted([
        use("record_answer", { questionId: "day:2026-01-02", decision: "reject", tradeClass: "client_directed", note: "Sold to pay taxes" }),
        use("check_claim", { date: "2026-01-02", claim: "cash_raise" }),
        use("record_answer", { questionId: "day:2026-01-02", decision: "reject", tradeClass: "client_directed", note: "Sold to pay taxes" }),
        say("The proceeds were reinvested the same day. Do you still want it treated as your instruction?"),
        use("record_answer", { questionId: "day:2026-01-02", decision: "reject", tradeClass: "client_directed", note: "Sold to pay taxes", againstEvidence: true }),
        say("Recorded."),
      ]),
      system: "test",
      tools: advisorRoiToolSet(state, (a) => saved.push(structuredClone(a))),
    });

    await session.send("That was me raising cash for taxes.");
    expect((session.toolOutputs[0] as { error: string }).error).toMatch(/check_claim/);
    expect((session.toolOutputs[1] as { consistent: boolean }).consistent).toBe(false);
    expect((session.toolOutputs[2] as { error: string }).error).toMatch(/contradicted/);
    expect(state.answers.overrides).toBeUndefined();
    expect(saved).toHaveLength(0);

    await session.send("Yes, treat it as mine.");
    const r = lastResult(session) as { verdictBefore: { advisorDecisions: number }; verdictAfter: { advisorDecisions: number } };
    expect(r.verdictBefore.advisorDecisions).toBe(-150_000);
    expect(r.verdictAfter.advisorDecisions).toBe(0);
    expect(state.answers.overrides).toEqual([{ date: "2026-01-02", tradeClass: "client_directed", note: "[Client asserted against the data] Sold to pay taxes" }]);
    expect(saved).toHaveLength(1);
  });

  it("records a confirmed advisor day and a rename, and drops them from the open questions", async () => {
    const state = newCheckState(input(), { renames: { OLD: "WIN" }, preHistory: [] });
    const session = new Session({
      client: scripted([
        use("interview_questions", {}),
        use("record_answer", { questionId: "rename:OLD", decision: "confirm", note: "Ticker change" }),
        use("record_answer", { questionId: "day:2026-01-02", decision: "confirm", note: "Advisor's call" }),
        use("interview_questions", {}),
        say("Done."),
      ]),
      system: "test",
      tools: advisorRoiToolSet(state),
    });
    await session.send("Go");
    expect((session.toolOutputs[0] as { remaining: number }).remaining).toBe(3);
    expect(state.answers.symbolMap).toEqual({ OLD: "WIN" });
    expect(state.answers.overrides?.[0]).toMatchObject({ date: "2026-01-02", tradeClass: "advisor" });
    expect((session.toolOutputs[3] as { questions: { id: string }[] }).questions.map((q) => q.id)).toEqual(["benchmark"]);
  });

  it("sends back a verdict with a figure no tool produced", async () => {
    const state = newCheckState(input(), { renames: {}, preHistory: [] });
    const session = new Session({
      client: scripted([use("verdict_summary", {}), say("Your advisor cost you $999,999."), say("Your advisor cost you $999,999.")]),
      system: "test",
      tools: advisorRoiToolSet(state),
    });
    const r = await session.send("Result?");
    expect(r.verified).toBe(false);
    expect(r.unverified.map((f) => f.text)).toContain("$999,999");
  });
});
