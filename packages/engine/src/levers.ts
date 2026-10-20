import { paybackYears } from "./money.js";
import { requireKind, type TaxRate } from "./tax.js";

/**
 * The "lever check": before selling, exercising, or paying down debt to relieve
 * cash pressure, compute what it really costs. In the house decision every lever
 * pulled for short-term comfort failed this check.
 */

/** Calc 9: return needed on equity left invested to cover the carry it could have retired. */
export function keepInvestedHurdle(annualCarry: number, equity: number): number {
  return annualCarry / equity;
}

/**
 * Calc 13: exercise options and use net proceeds to pay down debt.
 * Upfront cost = tax on the spread at the marginal rate.
 * Annual saving = interest avoided on the net proceeds.
 */
export function optionExercisePayback(input: {
  shares: number;
  strike: number;
  marketPrice: number;
  marginalTax: TaxRate;
  debtRate: number;
}) {
  const findings = requireKind(input.marginalTax, "marginal", "Option exercise tax");
  const spreadValue = Math.max(0, input.marketPrice - input.strike) * input.shares;
  const taxCost = spreadValue * input.marginalTax.rate;
  const netProceeds = spreadValue - taxCost;
  const annualInterestSaved = netProceeds * input.debtRate;
  return {
    spreadValue,
    taxCost,
    netProceeds,
    annualInterestSaved,
    paybackYears: paybackYears(taxCost, annualInterestSaved),
    findings,
  };
}

/** Sell appreciated holdings to pay down debt: capital gains cost vs interest saved. */
export function sellToPayDown(input: {
  saleAmount: number;
  costBasis: number;
  capitalGainsTax: TaxRate;
  debtRate: number;
}) {
  const findings = requireKind(input.capitalGainsTax, "marginal", "Capital gains on a sale");
  const gain = Math.max(0, input.saleAmount - input.costBasis);
  const taxCost = gain * input.capitalGainsTax.rate;
  const netPaydown = input.saleAmount - taxCost;
  const annualInterestSaved = netPaydown * input.debtRate;
  return {
    gain,
    taxCost,
    netPaydown,
    annualInterestSaved,
    paybackYears: paybackYears(taxCost, annualInterestSaved),
    findings,
  };
}
