import { runCalc } from "../../engine/src/index.js";
import { ledgerIndex, type Household } from "./household.js";

/**
 * Tools Claude can call. Every number Claude is allowed to say comes back
 * through one of these. Names are snake_case for the API; each maps to an
 * engine calculation or a ledger read.
 */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const num = { type: "number" };
const taxRate = {
  type: "object",
  description: "A tax rate with its kind. Marginal for deductions, exercises and sales; effective for whole-spend gross-ups.",
  properties: { rate: num, kind: { type: "string", enum: ["marginal", "effective"] }, label: { type: "string" } },
  required: ["rate", "kind"],
};
const home = {
  type: "object",
  properties: { value: num, appreciation: num, saleCostRate: num, debtAtExit: num },
  required: ["value", "appreciation", "saleCostRate", "debtAtExit"],
};
const scenario = {
  type: "object",
  properties: {
    name: { type: "string" },
    preDecisionNetWorth: { ...num, description: "Net worth before the decision. Must be the same for every scenario." },
    home,
    extraAnnualDraw: num,
    otherEndValue: num,
  },
  required: ["name", "preDecisionNetWorth"],
};
const projection: ToolDef["input_schema"] = {
  type: "object",
  properties: {
    startBalance: num,
    startAge: num,
    endAge: num,
    nominalReturn: num,
    inflation: num,
    firstYearDraw: num,
    drawGrowth: num,
    drawStartAge: num,
  },
  required: ["startBalance", "startAge", "endAge", "nominalReturn", "inflation", "firstYearDraw"],
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "ledger_keys",
    description: "List the facts on file for this household (keys and labels, no values). Call this first.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ledger_get",
    description:
      "Get the current value of one fact with its source, date and any findings (conflicts, staleness). The only way to get a household number.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "add_up",
    description:
      "Add and subtract labeled amounts (e.g. home value minus debt = equity). Use this for any arithmetic instead of doing it yourself.",
    input_schema: {
      type: "object",
      properties: {
        terms: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, value: num, sign: { type: "string", enum: ["+", "-"] } },
            required: ["label", "value", "sign"],
          },
        },
      },
      required: ["terms"],
    },
  },
  {
    name: "cash_flow_gap",
    description: "Annual spend minus net take-home.",
    input_schema: { type: "object", properties: { annualSpend: num, netTakeHome: num }, required: ["annualSpend", "netTakeHome"] },
  },
  {
    name: "retirement_target",
    description: "Portfolio needed: gross spend divided by draw rate. Pass grossSpend if known, else netSpend plus an effective tax rate.",
    input_schema: { type: "object", properties: { netSpend: num, grossSpend: num, drawRate: num, taxOnWithdrawals: taxRate }, required: ["netSpend", "drawRate"] },
  },
  {
    name: "compare_scenarios",
    description:
      "Compare two scenarios over the same years: home net at exit minus future value of extra draws. Refuses if the scenarios don't start from the same net worth.",
    input_schema: {
      type: "object",
      properties: { a: scenario, b: scenario, years: num, portfolioReturn: num },
      required: ["a", "b", "years", "portfolioReturn"],
    },
  },
  {
    name: "hold_period_check",
    description: "Check the assumed hold period matches the planned exit age.",
    input_schema: { type: "object", properties: { assumedHoldYears: num, ageAtPurchase: num, plannedExitAge: num }, required: ["assumedHoldYears", "ageAtPurchase", "plannedExitAge"] },
  },
  {
    name: "monthly_carry",
    description: "Monthly housing cost on interest-only debt plus property tax and insurance.",
    input_schema: { type: "object", properties: { debt: num, rate: num, annualPropertyTax: num, monthlyInsurance: num, monthlyOther: num }, required: ["debt", "rate", "annualPropertyTax", "monthlyInsurance"] },
  },
  {
    name: "check_rate_formula",
    description: "Check a stated floating rate equals index plus spread.",
    input_schema: { type: "object", properties: { statedRate: num, index: num, spread: num, label: { type: "string" } }, required: ["statedRate", "index", "spread"] },
  },
  {
    name: "compare_borrowing",
    description: "Floating non-deductible loan vs mortgage with the interest deduction capped by debt size.",
    input_schema: {
      type: "object",
      properties: {
        floating: { type: "object", properties: { index: num, spread: num }, required: ["index", "spread"] },
        mortgage: { type: "object", properties: { rate: num, balance: num, marginalTax: taxRate, deductibleDebtCap: num, itemizes: { type: "boolean" } }, required: ["rate", "balance", "marginalTax"] },
      },
      required: ["floating", "mortgage"],
    },
  },
  {
    name: "keep_invested_hurdle",
    description: "Return needed on equity left invested to beat paying down debt with it.",
    input_schema: { type: "object", properties: { annualCarry: num, equity: num }, required: ["annualCarry", "equity"] },
  },
  {
    name: "comp_check",
    description: "Price per above-grade square foot against a comp range.",
    input_schema: { type: "object", properties: { price: num, aboveGradeSqft: num, comps: { type: "array", items: num } }, required: ["price", "aboveGradeSqft", "comps"] },
  },
  {
    name: "project",
    description: "Year-by-year portfolio projection with a growing draw. Returns end balance nominal and real, and depletion age.",
    input_schema: projection,
  },
  {
    name: "sensitivity",
    description: "Rank which input (spend, return, inflation, start balance) moves the outcome most.",
    input_schema: { type: "object", properties: { base: projection }, required: ["base"] },
  },
  {
    name: "cost_of_a_dollar",
    description: "What a spend today is worth at a target date if invested instead.",
    input_schema: {
      type: "object",
      properties: { amount: num, recurring: { type: "string", enum: ["once", "yearly", "monthly"] }, years: num, nominalReturn: num, inflation: num },
      required: ["amount", "recurring", "years", "nominalReturn", "inflation"],
    },
  },
];

const CALC_FOR_TOOL: Record<string, string> = {
  cash_flow_gap: "cashFlowGap",
  retirement_target: "retirementTarget",
  compare_scenarios: "compareScenarios",
  hold_period_check: "holdPeriodCheck",
  monthly_carry: "monthlyCarry",
  check_rate_formula: "checkRateFormula",
  compare_borrowing: "compareBorrowing",
  keep_invested_hurdle: "keepInvestedHurdle",
  comp_check: "compCheck",
  project: "project",
  sensitivity: "sensitivity",
  cost_of_a_dollar: "costOfADollar",
};

/** Execute a tool call. Errors come back as data so Claude can explain them. */
export function executeTool(household: Household, name: string, input: Record<string, unknown>): unknown {
  try {
    if (name === "ledger_keys") return { keys: ledgerIndex(household) };
    if (name === "ledger_get") {
      return household.ledger.resolve(String(input.key), { today: household.file.asOf });
    }
    if (name === "add_up") {
      const terms = (input.terms as { label: string; value: number; sign: "+" | "-" }[]) ?? [];
      const total = terms.reduce((s, t) => s + (t.sign === "-" ? -t.value : t.value), 0);
      return { total, terms, findings: [] };
    }
    const calc = CALC_FOR_TOOL[name];
    if (!calc) return { error: `Unknown tool ${name}` };
    const out = runCalc(calc, input) as Record<string, unknown>;
    // Projection rows are long; Claude needs the summary, not every year.
    if (calc === "project") delete out.rows;
    return out;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
