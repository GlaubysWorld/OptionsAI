import type { Finding } from "./findings.js";
import { requireKind, type TaxRate } from "./tax.js";

/** A floating rate such as SOFR + spread. */
export function floatingRate(index: number, spread: number): number {
  return index + spread;
}

/**
 * A4: a stated rate must match its formula. Example failure: a PAL quoted as
 * SOFR + 0.15% when the agreement says SOFR + 1.15%.
 */
export function checkRateFormula(input: {
  statedRate: number;
  index: number;
  spread: number;
  label?: string;
  tolerance?: number; // default 5 bps
}): Finding[] {
  const tolerance = input.tolerance ?? 0.0005;
  const formulaRate = floatingRate(input.index, input.spread);
  if (Math.abs(formulaRate - input.statedRate) <= tolerance) return [];
  return [
    {
      code: "RATE_FORMULA_MISMATCH",
      severity: "block",
      message: `${input.label ?? "Rate"} is stated as ${(input.statedRate * 100).toFixed(2)}% but index ${(
        input.index * 100
      ).toFixed(2)}% + spread ${(input.spread * 100).toFixed(2)}% = ${(formulaRate * 100).toFixed(
        2,
      )}%. Confirm the spread in the loan agreement before using either number.`,
      details: { ...input, formulaRate },
    },
  ];
}

export interface AfterTaxMortgageInput {
  rate: number;
  balance: number;
  marginalTax: TaxRate;
  /** Acquisition debt cap for the federal deduction. $750K under current law; verify yearly. */
  deductibleDebtCap?: number;
  itemizes?: boolean;
}

/**
 * After-tax mortgage rate with the deduction limited to the debt cap.
 * Only the capped share of interest is deductible, at the MARGINAL rate.
 */
export function afterTaxMortgageRate(input: AfterTaxMortgageInput) {
  const findings = requireKind(input.marginalTax, "marginal", "Mortgage interest deduction");
  const cap = input.deductibleDebtCap ?? 750_000;
  const deductibleShare = input.itemizes === false ? 0 : Math.min(1, cap / input.balance);
  const afterTax = input.rate * (1 - input.marginalTax.rate * deductibleShare);
  return { afterTaxRate: afterTax, deductibleShare, findings };
}

/** Calc 10: compare a non-deductible floating loan with a partly deductible mortgage. */
export function compareBorrowing(input: {
  floating: { index: number; spread: number; deductible?: false };
  mortgage: AfterTaxMortgageInput;
}) {
  const floatingRateValue = floatingRate(input.floating.index, input.floating.spread);
  const mortgage = afterTaxMortgageRate(input.mortgage);
  return {
    floatingRate: floatingRateValue,
    mortgageAfterTaxRate: mortgage.afterTaxRate,
    deductibleShare: mortgage.deductibleShare,
    cheaper: floatingRateValue <= mortgage.afterTaxRate ? ("floating" as const) : ("mortgage" as const),
    findings: mortgage.findings,
  };
}
