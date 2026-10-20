import type { Finding } from "./findings.js";

/**
 * A tax rate always carries its kind. Blended numbers without a kind are the
 * source of quiet errors (A5): marginal applies to the next dollar (deductions,
 * exercises, sales), effective applies to total spend gross-ups.
 */
export type TaxRateKind = "marginal" | "effective";

export interface TaxRate {
  rate: number;
  kind: TaxRateKind;
  label?: string;
}

export function requireKind(
  taxRate: TaxRate,
  expected: TaxRateKind,
  purpose: string,
): Finding[] {
  if (taxRate.kind === expected) return [];
  return [
    {
      code: "WRONG_TAX_RATE_KIND",
      severity: "warn",
      message: `${purpose} needs a ${expected} tax rate but was given an ${taxRate.kind} rate (${(
        taxRate.rate * 100
      ).toFixed(1)}%). The result is likely understated or overstated.`,
      details: { purpose, expected, received: taxRate.kind, rate: taxRate.rate },
    },
  ];
}
