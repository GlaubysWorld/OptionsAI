import type { TaxRate } from "./tax.js";
import { requireKind } from "./tax.js";
import type { Finding } from "./findings.js";

export interface CashFlowGap {
  annualSpend: number;
  netTakeHome: number;
  gap: number; // positive = spend exceeds take-home and must be funded elsewhere
  coverageRatio: number; // take-home / spend
}

/** Calc 1: annual spend minus net take-home. */
export function cashFlowGap(annualSpend: number, netTakeHome: number): CashFlowGap {
  return {
    annualSpend,
    netTakeHome,
    gap: annualSpend - netTakeHome,
    coverageRatio: annualSpend === 0 ? Number.POSITIVE_INFINITY : netTakeHome / annualSpend,
  };
}

export interface RetirementTarget {
  netSpend: number;
  grossSpend: number;
  drawRate: number;
  portfolioNeeded: number;
  findings: Finding[];
}

/**
 * Calc 2: spend grossed up for tax, divided by a sustainable draw rate.
 * Gross-up uses an EFFECTIVE rate because it applies to the whole withdrawal.
 * Pass grossSpend directly when it is already known.
 */
export function retirementTarget(input: {
  netSpend: number;
  drawRate: number;
  taxOnWithdrawals?: TaxRate;
  grossSpend?: number;
}): RetirementTarget {
  const findings: Finding[] = [];
  let grossSpend = input.grossSpend;
  if (grossSpend === undefined) {
    const tax = input.taxOnWithdrawals ?? { rate: 0, kind: "effective" as const };
    findings.push(...requireKind(tax, "effective", "Grossing up retirement spend"));
    grossSpend = input.netSpend / (1 - tax.rate);
  }
  return {
    netSpend: input.netSpend,
    grossSpend,
    drawRate: input.drawRate,
    portfolioNeeded: grossSpend / input.drawRate,
    findings,
  };
}
