import { futureValue } from "./money.js";
import type { Finding } from "./findings.js";

export interface HomeAtExit {
  value: number; // today's price or value
  appreciation: number;
  saleCostRate: number; // commissions, transfer tax, closing as a share of price
  debtAtExit: number; // loans secured by or attributable to the home at sale
}

/** Net cash from selling a home after `years`. */
export function homeNetAtExit(home: HomeAtExit, years: number): number {
  const futurePrice = futureValue(home.value, home.appreciation, years);
  return futurePrice * (1 - home.saleCostRate) - home.debtAtExit;
}

export interface SaleProceedsInput {
  price: number;
  commissionRate: number;
  transferTax?: number;
  closingCosts?: number;
  prorations?: number; // positive = cost to seller
  loanPayoffs: number;
}

/** Calc 11: net proceeds from a home sale. */
export function saleNetProceeds(input: SaleProceedsInput): number {
  return (
    input.price -
    input.price * input.commissionRate -
    (input.transferTax ?? 0) -
    (input.closingCosts ?? 0) -
    (input.prorations ?? 0) -
    input.loanPayoffs
  );
}

export interface CarryInput {
  debt: number;
  rate: number;
  annualPropertyTax: number;
  monthlyInsurance: number;
  monthlyOther?: number;
}

export interface MonthlyCarry {
  interest: number;
  propertyTax: number;
  insurance: number;
  other: number;
  total: number;
}

/** Calc 12: monthly housing carry on interest-only debt. */
export function monthlyCarry(input: CarryInput): MonthlyCarry {
  const interest = (input.debt * input.rate) / 12;
  const propertyTax = input.annualPropertyTax / 12;
  const other = input.monthlyOther ?? 0;
  return {
    interest,
    propertyTax,
    insurance: input.monthlyInsurance,
    other,
    total: interest + propertyTax + input.monthlyInsurance + other,
  };
}

/** Calc 7: price per above-grade square foot, and where it sits against comps. */
export function compCheck(price: number, aboveGradeSqft: number, comps: number[]) {
  const perSqft = price / aboveGradeSqft;
  const low = Math.min(...comps);
  const high = Math.max(...comps);
  return { perSqft, low, high, withinRange: perSqft >= low && perSqft <= high };
}

/** Calc 8: all-in price per square foot including renovation. */
export function allInPerSqft(price: number, renovation: number, aboveGradeSqft: number): number {
  return (price + renovation) / aboveGradeSqft;
}

/**
 * A2: the hold period assumed in a model must match the plan's exit date.
 * Example failure: model assumed a 10-year hold but retirement and the move
 * moved earlier, so the real hold is closer to 7 years.
 */
export function holdPeriodCheck(input: {
  assumedHoldYears: number;
  ageAtPurchase: number;
  plannedExitAge: number;
}): Finding[] {
  const implied = input.plannedExitAge - input.ageAtPurchase;
  if (Math.abs(implied - input.assumedHoldYears) < 0.5) return [];
  return [
    {
      code: "HOLD_PERIOD_MISMATCH",
      severity: "warn",
      message: `The model assumes a ${input.assumedHoldYears}-year hold, but the plan exits at ${input.plannedExitAge}, which implies about ${implied} years. Appreciation and carry are mis-sized.`,
      details: { ...input, impliedHoldYears: implied },
    },
  ];
}
