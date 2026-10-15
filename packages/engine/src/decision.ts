import { futureValueOfAnnuity } from "./money.js";
import { homeNetAtExit, type HomeAtExit } from "./housing.js";
import type { Finding } from "./findings.js";

export interface Scenario {
  name: string;
  /**
   * Household net worth BEFORE the decision, as this scenario sees it.
   * Every scenario in a comparison must start from the same place. This is
   * what catches A1: a no-buy side that forgets the current home's equity.
   */
  preDecisionNetWorth: number;
  /** Home held in this scenario and sold at the end of the period. */
  home?: HomeAtExit;
  /** Extra annual portfolio draw this scenario requires vs baseline, end of year. */
  extraAnnualDraw?: number;
  /** Any other end-of-period value specific to this scenario. */
  otherEndValue?: number;
}

export interface ScenarioEnd {
  name: string;
  homeNet: number;
  drawCost: number;
  otherEndValue: number;
  endValue: number;
}

export interface ComparisonInput {
  a: Scenario;
  b: Scenario;
  years: number;
  portfolioReturn: number;
  /** Allowed difference in pre-decision net worth before blocking. Default $10K. */
  tolerance?: number;
}

export interface ComparisonResult {
  a: ScenarioEnd;
  b: ScenarioEnd;
  /** a.endValue - b.endValue. Null when a blocking finding means it can't be trusted. */
  delta: number | null;
  /** The delta as computed, even when blocked, for debugging only. Never show to users. */
  unsafeDelta: number;
  findings: Finding[];
}

function scenarioEnd(s: Scenario, years: number, portfolioReturn: number): ScenarioEnd {
  const homeNet = s.home ? homeNetAtExit(s.home, years) : 0;
  const drawCost = s.extraAnnualDraw
    ? futureValueOfAnnuity(s.extraAnnualDraw, portfolioReturn, years)
    : 0;
  const otherEndValue = s.otherEndValue ?? 0;
  return { name: s.name, homeNet, drawCost, otherEndValue, endValue: homeNet - drawCost + otherEndValue };
}

/**
 * Calcs 5 and 6, generalized. Compares two scenarios over the same period.
 * End value = home net at exit - future value of extra draws + other.
 * Refuses (delta = null) when the scenarios don't start from the same net worth.
 */
export function compareScenarios(input: ComparisonInput): ComparisonResult {
  const tolerance = input.tolerance ?? 10_000;
  const findings: Finding[] = [];
  const gap = input.a.preDecisionNetWorth - input.b.preDecisionNetWorth;
  if (Math.abs(gap) > tolerance) {
    findings.push({
      code: "ASYMMETRIC_SCENARIOS",
      severity: "block",
      message: `"${input.a.name}" and "${input.b.name}" don't start from the same net worth (difference of $${Math.round(
        Math.abs(gap),
      ).toLocaleString("en-US")}). One side is missing an asset, usually the current home's equity. The comparison is not valid until both sides carry the same starting assets.`,
      details: {
        aPreDecision: input.a.preDecisionNetWorth,
        bPreDecision: input.b.preDecisionNetWorth,
        gap,
      },
    });
  }
  const a = scenarioEnd(input.a, input.years, input.portfolioReturn);
  const b = scenarioEnd(input.b, input.years, input.portfolioReturn);
  const unsafeDelta = a.endValue - b.endValue;
  const blocked = findings.some((f) => f.severity === "block");
  return { a, b, delta: blocked ? null : unsafeDelta, unsafeDelta, findings };
}
