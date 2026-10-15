export interface LumpVsAnnuity {
  impliedYield: number; // annual annuity / lump sum
  breakevenYears: number; // years of annuity payments to equal the lump sum, undiscounted
  /** True when a portfolio expected to earn more than the implied yield favors the lump sum. */
  lumpFavoredAtReturn: (expectedReturn: number) => boolean;
}

/** Calc 4: pension lump sum vs annuity via implied yield. */
export function lumpVsAnnuity(lumpSum: number, annualAnnuity: number): LumpVsAnnuity {
  const impliedYield = annualAnnuity / lumpSum;
  return {
    impliedYield,
    breakevenYears: lumpSum / annualAnnuity,
    lumpFavoredAtReturn: (expectedReturn: number) => expectedReturn > impliedYield,
  };
}
