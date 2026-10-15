import { describe, expect, it } from "vitest";
import * as e from "../src/index.js";

// Expected values here are worked by hand, not produced by the engine.

describe("money", () => {
  it("future value of an annuity", () => {
    expect(e.futureValueOfAnnuity(1000, 0.1, 2)).toBeCloseTo(2100, 6);
    expect(e.futureValueOfAnnuity(1000, 0, 3)).toBe(3000);
  });
  it("real dollars", () => {
    expect(e.toRealDollars(1210, 0.1, 2)).toBeCloseTo(1000, 6);
  });
  it("payback is infinite with no saving", () => {
    expect(e.paybackYears(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("cash flow and retirement target", () => {
  it("gap", () => {
    expect(e.cashFlowGap(100, 60).gap).toBe(40);
  });
  it("grosses up with an effective rate", () => {
    const r = e.retirementTarget({ netSpend: 75, drawRate: 0.04, taxOnWithdrawals: { rate: 0.25, kind: "effective" } });
    expect(r.grossSpend).toBeCloseTo(100, 6);
    expect(r.portfolioNeeded).toBeCloseTo(2500, 6);
    expect(r.findings).toHaveLength(0);
  });
  it("warns when a marginal rate is used for a gross-up", () => {
    const r = e.retirementTarget({ netSpend: 75, drawRate: 0.04, taxOnWithdrawals: { rate: 0.25, kind: "marginal" } });
    expect(r.findings[0]?.code).toBe("WRONG_TAX_RATE_KIND");
  });
});

describe("projection", () => {
  it("draws at year end after growth", () => {
    const r = e.project({ startBalance: 1000, startAge: 50, endAge: 52, nominalReturn: 0.1, inflation: 0, firstYearDraw: 100 });
    expect(r.rows[0]?.endBalance).toBeCloseTo(1000, 6);
    expect(r.endBalance).toBeCloseTo(1000, 6);
  });
  it("grows the draw", () => {
    const r = e.project({ startBalance: 1000, startAge: 50, endAge: 52, nominalReturn: 0, inflation: 0.1, firstYearDraw: 100 });
    expect(r.rows[1]?.draw).toBeCloseTo(110, 6);
    expect(r.endBalance).toBeCloseTo(790, 6);
  });
  it("reports depletion age", () => {
    const r = e.project({ startBalance: 100, startAge: 60, endAge: 65, nominalReturn: 0, inflation: 0, firstYearDraw: 60 });
    expect(r.depletedAtAge).toBe(62);
  });
  it("adds contributions in range", () => {
    const r = e.project({
      startBalance: 0, startAge: 40, endAge: 43, nominalReturn: 0, inflation: 0, firstYearDraw: 0,
      contributions: [{ fromAge: 41, toAge: 42, amount: 10 }],
    });
    expect(r.endBalance).toBe(20);
  });
});

describe("pension", () => {
  it("implied yield and breakeven", () => {
    const r = e.lumpVsAnnuity(1_000_000, 50_000);
    expect(r.impliedYield).toBeCloseTo(0.05, 9);
    expect(r.breakevenYears).toBeCloseTo(20, 9);
    expect(r.lumpFavoredAtReturn(0.07)).toBe(true);
  });
});

describe("housing", () => {
  it("home net at exit", () => {
    expect(e.homeNetAtExit({ value: 100, appreciation: 0, saleCostRate: 0.06, debtAtExit: 50 }, 5)).toBeCloseTo(44, 9);
  });
  it("sale net proceeds", () => {
    expect(e.saleNetProceeds({ price: 1000, commissionRate: 0.05, transferTax: 10, closingCosts: 5, loanPayoffs: 400 })).toBe(535);
  });
  it("monthly carry", () => {
    const c = e.monthlyCarry({ debt: 1_200_000, rate: 0.05, annualPropertyTax: 12_000, monthlyInsurance: 500 });
    expect(c.total).toBeCloseTo(6500, 6);
  });
  it("comp check", () => {
    const c = e.compCheck(1_000_000, 2_500, [380, 420]);
    expect(c.perSqft).toBe(400);
    expect(c.withinRange).toBe(true);
  });
  it("hold period mismatch (A2)", () => {
    expect(e.holdPeriodCheck({ assumedHoldYears: 10, ageAtPurchase: 40, plannedExitAge: 47 })[0]?.code).toBe("HOLD_PERIOD_MISMATCH");
    expect(e.holdPeriodCheck({ assumedHoldYears: 7, ageAtPurchase: 40, plannedExitAge: 47 })).toHaveLength(0);
  });
});

describe("decision comparator (A1)", () => {
  const buy: e.Scenario = {
    name: "buy",
    preDecisionNetWorth: 500,
    home: { value: 1000, appreciation: 0, saleCostRate: 0.1, debtAtExit: 600 },
    extraAnnualDraw: 10,
  };
  it("blocks when one side is missing starting assets", () => {
    const r = e.compareScenarios({ a: buy, b: { name: "stay", preDecisionNetWorth: 0 }, years: 2, portfolioReturn: 0, tolerance: 1 });
    expect(r.delta).toBeNull();
    expect(r.findings[0]?.code).toBe("ASYMMETRIC_SCENARIOS");
  });
  it("computes when both sides start equal", () => {
    const stay: e.Scenario = {
      name: "stay",
      preDecisionNetWorth: 500,
      home: { value: 800, appreciation: 0, saleCostRate: 0.1, debtAtExit: 300 },
    };
    const r = e.compareScenarios({ a: buy, b: stay, years: 2, portfolioReturn: 0, tolerance: 1 });
    // buy: 1000*0.9 - 600 - 20 = 280 ; stay: 800*0.9 - 300 = 420
    expect(r.delta).toBeCloseTo(-140, 9);
    expect(r.findings).toHaveLength(0);
  });
});

describe("rates (A4, A5)", () => {
  it("flags a rate that doesn't match its formula", () => {
    expect(e.checkRateFormula({ statedRate: 0.0415, index: 0.0365, spread: 0.0115 })[0]?.code).toBe("RATE_FORMULA_MISMATCH");
    expect(e.checkRateFormula({ statedRate: 0.048, index: 0.0365, spread: 0.0115 })).toHaveLength(0);
  });
  it("caps the mortgage deduction and needs a marginal rate", () => {
    const r = e.afterTaxMortgageRate({ rate: 0.06, balance: 1_500_000, marginalTax: { rate: 0.4, kind: "marginal" } });
    expect(r.deductibleShare).toBeCloseTo(0.5, 9);
    expect(r.afterTaxRate).toBeCloseTo(0.048, 9);
    expect(r.findings).toHaveLength(0);
    const bad = e.afterTaxMortgageRate({ rate: 0.06, balance: 1_500_000, marginalTax: { rate: 0.29, kind: "effective" } });
    expect(bad.findings[0]?.code).toBe("WRONG_TAX_RATE_KIND");
  });
});

describe("lever checks", () => {
  it("keep-invested hurdle", () => {
    expect(e.keepInvestedHurdle(78, 750)).toBeCloseTo(0.104, 9);
  });
  it("option exercise payback", () => {
    const r = e.optionExercisePayback({ shares: 1000, strike: 20, marketPrice: 30, marginalTax: { rate: 0.4, kind: "marginal" }, debtRate: 0.05 });
    expect(r.taxCost).toBe(4000);
    expect(r.annualInterestSaved).toBeCloseTo(300, 9);
    expect(r.paybackYears).toBeCloseTo(13.333, 3);
  });
  it("sell to pay down", () => {
    const r = e.sellToPayDown({ saleAmount: 100_000, costBasis: 40_000, capitalGainsTax: { rate: 0.25, kind: "marginal" }, debtRate: 0.05 });
    expect(r.taxCost).toBe(15_000);
    expect(r.netPaydown).toBe(85_000);
  });
});

describe("cost of a dollar and plan limits", () => {
  it("one-time spend", () => {
    const r = e.costOfADollar({ amount: 1000, recurring: "once", years: 2, nominalReturn: 0.1, inflation: 0.1 });
    expect(r.nominal).toBeCloseTo(1210, 6);
    expect(r.real).toBeCloseTo(1000, 6);
  });
  it("monthly spend", () => {
    const r = e.costOfADollar({ amount: 100, recurring: "monthly", years: 1, nominalReturn: 0, inflation: 0 });
    expect(r.nominal).toBe(1200);
  });
  it("mega backdoor room", () => {
    const r = e.megaBackdoorRoom({ limits: e.PLAN_LIMITS_2026, employeeDeferral: 24_500, employerContributions: 10_000 });
    expect(r.room).toBe(37_500);
  });
});

describe("stress and sensitivity", () => {
  const base: e.ProjectionInput = { startBalance: 1000, startAge: 60, endAge: 70, nominalReturn: 0.05, inflation: 0.02, firstYearDraw: 60 };
  it("grid flags breaking cells", () => {
    const cells = e.stressGrid(base, [0, 0.05], [60, 200]);
    expect(cells).toHaveLength(4);
    expect(cells.find((c) => c.nominalReturn === 0 && c.firstYearDraw === 200)?.breaks).toBe(true);
  });
  it("ranks inputs by impact, largest first", () => {
    const rows = e.sensitivity(base);
    expect(rows).toHaveLength(4);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.impact).toBeGreaterThanOrEqual(rows[i]!.impact);
  });
});

describe("ledger (A3)", () => {
  const entries: e.LedgerEntry[] = [
    { key: "debt.pal", value: 1_700_000, sourceType: "document", sourceRef: "doc:closing", asOf: "2026-06-15" },
    { key: "debt.pal", value: 1_600_000, sourceType: "stated", sourceRef: "chat", asOf: "2026-06-15" },
  ];
  it("prefers the stronger source on the same date and flags the disagreement", () => {
    const r = new e.Ledger(entries).resolve("debt.pal", { today: "2026-06-20" });
    expect(r.value).toBe(1_700_000);
    expect(r.findings[0]?.code).toBe("CONFLICTING_VALUES");
    expect(r.findings[0]?.severity).toBe("warn");
  });
  it("blocks when an equal or stronger source disagrees", () => {
    const r = new e.Ledger([
      { key: "k", value: 1, sourceType: "document", sourceRef: "a", asOf: "2026-01-01" },
      { key: "k", value: 2, sourceType: "document", sourceRef: "b", asOf: "2026-01-02" },
    ]).resolve("k", { today: "2026-01-03" });
    expect(r.value).toBe(2);
    expect(r.findings[0]?.severity).toBe("block");
  });
  it("flags stale and missing values", () => {
    expect(new e.Ledger(entries).resolve("debt.pal", { today: "2026-12-31" }).findings.some((f) => f.code === "STALE_VALUE")).toBe(true);
    expect(new e.Ledger().resolve("nope").findings[0]?.code).toBe("MISSING_VALUE");
  });
  it("ignores older values outside the window", () => {
    const r = new e.Ledger([
      { key: "k", value: 1, sourceType: "document", sourceRef: "a", asOf: "2026-01-01" },
      { key: "k", value: 2, sourceType: "document", sourceRef: "b", asOf: "2026-06-01" },
    ]).resolve("k", { today: "2026-06-02" });
    expect(r.findings).toHaveLength(0);
  });
});

describe("registry", () => {
  it("runs by name and rejects unknown calcs", () => {
    expect(e.runCalc("cashFlowGap", { annualSpend: 10, netTakeHome: 4 }).gap).toBe(6);
    expect(() => e.runCalc("nope", {})).toThrow();
  });
});
