/**
 * Findings are how the engine tells Claude (and the user) that something is off.
 * The engine never silently "fixes" an input. It calculates what it can and
 * returns findings that must be surfaced in plain language.
 *
 * severity "block": the result is not trustworthy and must not be shown as fact.
 * severity "warn": the result stands but carries a caveat that must be shown.
 */
export type FindingCode =
  | "ASYMMETRIC_SCENARIOS" // A1
  | "HOLD_PERIOD_MISMATCH" // A2
  | "CONFLICTING_VALUES" // A3
  | "RATE_FORMULA_MISMATCH" // A4
  | "WRONG_TAX_RATE_KIND" // A5
  | "STALE_VALUE"
  | "MISSING_VALUE";

export type Severity = "block" | "warn";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export const hasBlocking = (findings: Finding[]): boolean =>
  findings.some((f) => f.severity === "block");
