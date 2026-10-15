/**
 * IRS limits change yearly. Keep them as config, never hardcode in logic.
 * VERIFY against the IRS notice for the year before relying on these.
 */
export interface PlanLimits {
  year: number;
  employeeDeferral: number; // 402(g)
  annualAdditions: number; // 415(c), all sources
}

export const PLAN_LIMITS_2026: PlanLimits = {
  year: 2026,
  employeeDeferral: 24_500,
  annualAdditions: 72_000,
};

/** Calc 15: after-tax (mega backdoor Roth) room left under the 415(c) limit. */
export function megaBackdoorRoom(input: {
  limits: PlanLimits;
  employeeDeferral: number;
  employerContributions: number;
}) {
  const deferral = Math.min(input.employeeDeferral, input.limits.employeeDeferral);
  const room = Math.max(0, input.limits.annualAdditions - deferral - input.employerContributions);
  return { room, deferralUsed: deferral, limitsYear: input.limits.year };
}
