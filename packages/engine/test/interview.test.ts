import { describe, expect, it } from "vitest";
import { checkClaim, interviewQuestions, runAdvisorRoi, type AdvisorRoiInput, type Txn } from "../src/advisorRoi/index.js";

const series = (start: string, values: number[]) => {
  const d0 = Date.parse(`${start}T00:00:00Z`);
  return { dates: values.map((_, i) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10)), adj: values };
};
const tx = (date: string, action: string, symbol: string, quantity: number, amount: number, extra: Partial<Txn> = {}): Txn =>
  ({ date, action, symbol, description: "", quantity, price: null, fees: 0, amount, ...extra });

// Day 2 is a switch (sold a winner for a loser, -150K vs not trading).
// Day 4 is a sale with nothing bought, followed by a 50K wire out on day 6.
const input = (txns: Txn[] = [
  tx("2026-01-02", "Sell", "WIN", 1000, 100_000), tx("2026-01-02", "Buy", "LOSE", 1000, -100_000),
  tx("2026-01-04", "Sell", "LOSE", 500, 50_000), tx("2026-01-06", "Wire Sent", "", 0, -50_000),
]): AdvisorRoiInput => ({
  transactions: txns,
  snapshots: [{ date: "2026-01-01", accountValue: 100_000, positions: { WIN: 1000 } }],
  prices: {
    WIN: series("2026-01-01", [100, 100, 100, 100, 100, 200, 200, 200, 200, 200]),
    LOSE: series("2026-01-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 50]),
    IDX: series("2026-01-01", [100, 100, 100, 100, 100, 110, 110, 110, 110, 110]),
  },
  benchmark: { symbol: "IDX" },
  horizons: [],
});

describe("interview questions", () => {
  it("asks about proposed fixes, the biggest scored days, and the benchmark", () => {
    const i = input();
    const qs = interviewQuestions(i, runAdvisorRoi(i), { renames: { OLD: "NEW" }, preHistory: [] });
    expect(qs.map((q) => q.id)).toEqual(["rename:OLD", "day:2026-01-02", "benchmark"]);
    expect(qs[1]!.stakes).toBeCloseTo(-150_000, 6);
  });
  it("stops asking about a day once it's answered", () => {
    const i = { ...input(), overrides: [{ date: "2026-01-02", tradeClass: "advisor" as const, note: "" }] };
    expect(interviewQuestions(i, runAdvisorRoi(i), { renames: {}, preHistory: [] }).some((q) => q.id.startsWith("day:"))).toBe(false);
  });
});

describe("claim checks", () => {
  const i = input();
  const r = runAdvisorRoi(i);
  it("contradicts a cash-raise claim on a day the proceeds were reinvested, and points to the day that raised cash", () => {
    const c = checkClaim(i, r, "2026-01-02", "cash_raise");
    expect(c.consistent).toBe(false);
    expect(c.evidence.cashActuallyRaisedOn).toEqual([{ date: "2026-01-04", cashRaised: 50_000, sold: ["LOSE"] }]);
  });
  it("supports a cash-raise claim when sales exceeded buys", () => {
    expect(checkClaim(i, r, "2026-01-04", "cash_raise").consistent).toBe(true);
  });
  it("can't tell who directed a trade", () => {
    expect(checkClaim(i, r, "2026-01-02", "client_directed").consistent).toBeNull();
  });
  it("confirms an error when the custodian cancelled trades", () => {
    const j = input([...input().transactions, tx("2026-01-08", "Cancel Sell", "LOSE", 500, -50_000, { asOf: "2026-01-04" })]);
    expect(checkClaim(j, runAdvisorRoi(j), "2026-01-04", "error").consistent).toBe(true);
  });
  it("rejects a claim about a day with no trades", () => {
    expect(checkClaim(i, r, "2026-01-03", "cash_raise").consistent).toBe(false);
  });
});
