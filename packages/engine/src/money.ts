/** Core time-value-of-money helpers. Rates are decimals (0.07 = 7%). */

export function futureValue(presentValue: number, rate: number, years: number): number {
  return presentValue * Math.pow(1 + rate, years);
}

/** Future value of a level payment made at the end of each year. */
export function futureValueOfAnnuity(payment: number, rate: number, years: number): number {
  if (rate === 0) return payment * years;
  return payment * ((Math.pow(1 + rate, years) - 1) / rate);
}

/** Convert a nominal amount `years` from now into today's dollars. */
export function toRealDollars(nominal: number, inflation: number, years: number): number {
  return nominal / Math.pow(1 + inflation, years);
}

/** Years to recover an upfront cost from a level annual saving. */
export function paybackYears(upfrontCost: number, annualSaving: number): number {
  if (annualSaving <= 0) return Number.POSITIVE_INFINITY;
  return upfrontCost / annualSaving;
}
