import { describe, expect, it } from "vitest";
import {
  modifiedDietz, parseCsv, parsePriceCsv, parseSchwabTransactions, reconcileHoldings, runAdvisorRoi, scoreTrades, type Snapshot,
  type AdvisorRoiInput, type PriceTable, type Txn,
} from "../src/advisorRoi/index.js";

// Expected values are worked by hand.

const series = (start: string, values: number[]) => {
  const d0 = Date.parse(`${start}T00:00:00Z`);
  return { dates: values.map((_, i) => new Date(d0 + i * 86_400_000).toISOString().slice(0, 10)), adj: values };
};
const tx = (date: string, action: string, symbol: string, quantity: number, amount: number, extra: Partial<Txn> = {}): Txn =>
  ({ date, action, symbol, description: "", quantity, price: null, fees: 0, amount, ...extra });

describe("Schwab adapter", () => {
  it("parses quoted CSV with embedded commas", () => {
    expect(parseCsv('a,b\n"1,000","x ""y"""\n')).toEqual([["a", "b"], ["1,000", 'x "y"']]);
  });
  it("normalizes dates, as-of corrections, money and order", () => {
    const csv = [
      '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
      '"04/06/2026 as of 04/02/2026","Cancel Sell","TJX","TJX COS","307","","","-$49375.92"',
      '"04/02/2026","Sell","TJX","TJX COS","307","$160.83","$0.40","$49375.92"',
    ].join("\n");
    const t = parseSchwabTransactions(csv);
    expect(t[0]).toMatchObject({ date: "2026-04-02", action: "Sell", quantity: 307, price: 160.83, fees: 0.4, amount: 49375.92 });
    expect(t[1]).toMatchObject({ date: "2026-04-06", asOf: "2026-04-02", amount: -49375.92 });
  });
  it("parses a price file", () => {
    const p = parsePriceCsv("date,symbol,close,adjclose\n2026-01-02,X,10,9.5\n2026-01-01,X,10,9\n");
    expect(p.X).toEqual({ dates: ["2026-01-01", "2026-01-02"], adj: [9, 9.5], close: [10, 10] });
  });
});

describe("Modified Dietz", () => {
  it("removes flows and weights them by time in the account", () => {
    // 100 -> 160 over 10 days with +50 deposited on day 5: gain 10 over capital 100 + 50*5/10 = 125
    const r = modifiedDietz(100, 160, "2026-01-01", "2026-01-11", [{ date: "2026-01-06", amount: 50, label: "in" }], [], false);
    expect(r.ret).toBeCloseTo(10 / 125, 12);
  });
  it("adds fees back for the gross return", () => {
    // 100 -> 105 with a 1 fee paid at the end: net 5%, gross 6%
    const fee = [{ date: "2026-01-11", amount: 1, label: "fee" }];
    expect(modifiedDietz(100, 105, "2026-01-01", "2026-01-11", [], fee, false).ret).toBeCloseTo(0.05, 12);
    expect(modifiedDietz(100, 105, "2026-01-01", "2026-01-11", [], fee, true).ret).toBeCloseTo(0.06, 12);
  });
});

const prices: PriceTable = {
  WIN: series("2026-01-01", [100, 100, 100, 100, 100, 200, 200, 200, 200, 200]),
  LOSE: series("2026-01-01", [100, 100, 100, 100, 100, 100, 100, 100, 100, 50]),
  IDX: series("2026-01-01", [100, 100, 100, 100, 100, 110, 110, 110, 110, 110]),
};
const base = (txns: Txn[], extra: Partial<AdvisorRoiInput> = {}): AdvisorRoiInput => ({
  transactions: txns,
  snapshots: [{ date: "2026-01-01", accountValue: 1000, positions: { WIN: 10 } }],
  prices,
  benchmark: { symbol: "IDX" },
  horizons: [],
  ...extra,
});

describe("trade scoring", () => {
  it("scores a switch: sold a winner to buy a loser", () => {
    // Day 2: sell 1000 of WIN (+100% after), buy 1000 of LOSE (-50% after): switch = 1000 * (-0.5 - 1.0)
    const r = scoreTrades(base([tx("2026-01-02", "Sell", "WIN", 10, 1000), tx("2026-01-02", "Buy", "LOSE", 10, -1000)]));
    const s = r.days[0]!.scores.latest!;
    expect(s.switchValue).toBeCloseTo(-1500, 9);
    expect(s.buysVsBenchmark).toBeCloseTo(1000 * (-0.5 - 0.1), 9);
    expect(r.days[0]!.cashRaised).toBe(0);
  });
  it("only scores the matched part; net selling is cash raised, net buying is new cash vs the index", () => {
    const raise = scoreTrades(base([tx("2026-01-02", "Sell", "WIN", 30, 3000), tx("2026-01-02", "Buy", "LOSE", 10, -1000)]));
    expect(raise.days[0]!.cashRaised).toBe(2000);
    expect(raise.days[0]!.scores.latest!.switchValue).toBeCloseTo(-1500, 9);
    const deploy = scoreTrades(base([tx("2026-01-02", "Buy", "WIN", 10, -1000)]));
    expect(deploy.days[0]!.scores.latest!.newCashVsBenchmark).toBeCloseTo(1000 * (1.0 - 0.1), 9);
  });
  it("excludes sells the custodian cancelled", () => {
    const r = scoreTrades(base([
      tx("2026-01-02", "Sell", "WIN", 10, 1000),
      tx("2026-01-05", "Cancel Sell", "WIN", 10, -1000, { asOf: "2026-01-02" }),
    ]));
    expect(r.excludedErrors).toEqual([{ date: "2026-01-02", symbol: "WIN", amount: 1000 }]);
    expect(r.days).toHaveLength(0);
  });
  it("applies transition windows and client overrides", () => {
    const r = scoreTrades(base([tx("2026-01-02", "Sell", "WIN", 1, 100), tx("2026-01-03", "Sell", "WIN", 1, 100)], {
      transitionWindows: [{ from: "2026-01-01", to: "2026-01-02", label: "prior manager" }],
      overrides: [{ date: "2026-01-03", tradeClass: "client_directed", note: "client asked" }],
    }));
    expect(r.days.map((d) => d.tradeClass)).toEqual(["transition", "client_directed"]);
  });
  it("reports unpriced legs instead of guessing", () => {
    const r = scoreTrades(base([tx("2026-01-02", "Sell", "GONE", 1, 100), tx("2026-01-02", "Buy", "WIN", 1, -100)]));
    expect(r.findings[0]?.code).toBe("UNPRICED");
    expect(r.days[0]!.scores.latest!.switchValue).toBe(0);
  });
  it("skips horizons that haven't happened yet", () => {
    const r = scoreTrades(base([tx("2026-01-02", "Buy", "WIN", 1, -100)], { horizons: [3, 30] }));
    expect(r.days[0]!.scores["3d"]).not.toBeNull();
    expect(r.days[0]!.scores["30d"]).toBeNull();
  });
});

describe("reconciliation", () => {
  const snaps: Snapshot[] = [
    { date: "2026-01-01", accountValue: 1000, positions: { WIN: 10, OLD: 5 } },
    { date: "2026-01-10", accountValue: 1000, positions: { WIN: 12, NEW: 5 } },
  ];
  it("ties out after buys, sells and renames", () => {
    const r = reconcileHoldings(base([tx("2026-01-03", "Buy", "WIN", 2, -200)], { snapshots: snaps, symbolMap: { OLD: "NEW" } }));
    expect(r.findings).toHaveLength(0);
  });
  it("blocks when holdings don't match, and the verdict withholds trade scores", () => {
    const input = base([], { snapshots: snaps, symbolMap: { OLD: "NEW" } });
    const r = runAdvisorRoi(input);
    expect(r.findings.find((f) => f.code === "RECONCILIATION_MISMATCH")?.severity).toBe("block");
    expect(r.verdict.decisionValue).toBeNull();
    expect(r.verdict.worst).toEqual([]);
  });
  it("skips value-only snapshots", () => {
    const r = reconcileHoldings(base([tx("2026-01-03", "Buy", "WIN", 2, -200)], {
      snapshots: [...snaps, { date: "2026-01-05", accountValue: 1000 }], symbolMap: { OLD: "NEW" },
    }));
    expect(r.checked.map((c) => c.date)).toEqual(["2026-01-10"]);
  });
});

describe("verdict", () => {
  it("puts decision value next to fees", () => {
    const r = runAdvisorRoi(base([
      tx("2026-01-02", "Sell", "WIN", 10, 1000), tx("2026-01-02", "Buy", "LOSE", 10, -1000),
      tx("2026-01-03", "Advisor Fee", "", 0, -50),
    ], { snapshots: [{ date: "2026-01-01", accountValue: 1000, positions: { WIN: 10 } }, { date: "2026-01-10", accountValue: 450 }] }));
    expect(r.verdict.feesPaid).toBe(50);
    expect(r.verdict.decisionValue?.advisor).toBeCloseTo(-1500, 9);
    expect(r.verdict.decisionValuePerFeeDollar).toBeCloseTo(-30, 9);
  });
});
