/**
 * Backtest of the real house decision through the tool layer, with no model in
 * the loop: the calls a correct journey would make, and what each must surface.
 * Runs only when households/house.local.json exists (gitignored, real data).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHousehold } from "../src/household.js";
import { executeTool } from "../src/tools.js";

const path = join(import.meta.dirname, "..", "households", "house.local.json");
const suite = existsSync(path) ? describe : describe.skip;

type R = { value: number; findings: { code: string; severity: string }[] };

suite("house decision backtest (local data)", () => {
  const h = existsSync(path) ? loadHousehold(path) : (null as never);
  const get = (key: string) => executeTool(h, "ledger_get", { key }) as R;
  const v = (key: string) => get(key).value;

  it("surfaces the conflicting PAL balance instead of picking one silently", () => {
    const pal = get("debt.pal.balance_after_purchase");
    expect(pal.findings.map((f) => f.code)).toContain("CONFLICTING_VALUES");
  });

  it("flags spend as stale on the decision date", () => {
    expect(get("spend.annual").findings.map((f) => f.code)).toContain("STALE_VALUE");
  });

  it("flags the PAL rate quoted off the wrong spread", () => {
    const out = executeTool(h, "check_rate_formula", {
      statedRate: v("debt.pal.rate_quoted"),
      index: v("debt.pal.index_sofr"),
      spread: v("debt.pal.spread"),
      label: "PAL",
    }) as { findings: { code: string }[] };
    expect(out.findings.map((f) => f.code)).toContain("RATE_FORMULA_MISMATCH");
  });

  it("flags the effective tax rate used for the mortgage deduction, and still finds the PAL cheaper", () => {
    const out = executeTool(h, "compare_borrowing", {
      floating: { index: v("debt.pal.index_sofr"), spread: v("debt.pal.spread") },
      mortgage: {
        rate: v("mortgage.jumbo_io_rate"),
        balance: v("debt.pal.balance_after_purchase"),
        marginalTax: { rate: v("tax.combined_rate_effective"), kind: "effective" },
      },
    }) as { cheaper: string; findings: { code: string }[] };
    expect(out.cheaper).toBe("floating");
    expect(out.findings.map((f) => f.code)).toContain("WRONG_TAX_RATE_KIND");
  });

  it("refuses the original buy vs no-buy comparison, then runs the fixed one", () => {
    const equity = (executeTool(h, "add_up", {
      terms: [
        { label: "Prestwick value", value: v("home.current.value"), sign: "+" },
        { label: "Prestwick payoff", value: v("home.current.debt"), sign: "-" },
      ],
    }) as { total: number }).total;
    const years = v("plan.exit_age") - v("plan.age_now");
    const buy = {
      name: "buy Keystone",
      preDecisionNetWorth: equity,
      home: {
        value: v("home.target.price"),
        appreciation: v("assumptions.home_appreciation"),
        saleCostRate: v("assumptions.sale_cost_rate"),
        debtAtExit: v("debt.pal.balance_after_purchase"),
      },
      extraAnnualDraw: v("portfolio.extra_annual_draw_if_buy"),
    };
    const original = executeTool(h, "compare_scenarios", {
      a: buy,
      b: { name: "no-buy as originally modeled", preDecisionNetWorth: 0 },
      years,
      portfolioReturn: v("assumptions.portfolio_return"),
    }) as { delta: number | null; findings: { code: string }[] };
    expect(original.delta).toBeNull();
    expect(original.findings.map((f) => f.code)).toContain("ASYMMETRIC_SCENARIOS");

    const fixed = executeTool(h, "compare_scenarios", {
      a: buy,
      b: {
        name: "stay in Prestwick",
        preDecisionNetWorth: equity,
        home: {
          value: v("home.current.value"),
          appreciation: v("assumptions.home_appreciation"),
          saleCostRate: v("assumptions.sale_cost_rate"),
          debtAtExit: v("home.current.debt"),
        },
      },
      years,
      portfolioReturn: v("assumptions.portfolio_return"),
    }) as { delta: number | null; findings: unknown[] };
    expect(fixed.findings).toHaveLength(0);
    expect(fixed.delta).not.toBeNull();
    expect(fixed.delta!).toBeLessThan(0);
  });

  it("checks the price against comps", () => {
    const out = executeTool(h, "comp_check", {
      price: v("home.target.price"),
      aboveGradeSqft: v("home.target.above_grade_sqft"),
      comps: [v("comps.per_sqft_low"), v("comps.per_sqft_high")],
    }) as { withinRange: boolean };
    expect(out.withinRange).toBe(true);
  });
});
