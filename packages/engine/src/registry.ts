/**
 * One entry point per calculation, keyed by name. This is the surface Claude
 * will call as tools: name + JSON input in, JSON output with findings out.
 * The golden test runner uses the same surface, so what's tested is what's called.
 */
import { cashFlowGap, retirementTarget } from "./cashflow.js";
import { project, type ProjectionInput } from "./projection.js";
import { lumpVsAnnuity } from "./pension.js";
import { compareScenarios, type ComparisonInput } from "./decision.js";
import {
  allInPerSqft,
  compCheck,
  holdPeriodCheck,
  monthlyCarry,
  saleNetProceeds,
  type CarryInput,
  type SaleProceedsInput,
} from "./housing.js";
import { checkRateFormula, compareBorrowing } from "./rates.js";
import { keepInvestedHurdle, optionExercisePayback, sellToPayDown } from "./levers.js";
import { megaBackdoorRoom } from "./retirementAccounts.js";
import { costOfADollar } from "./costOfADollar.js";
import { stressGrid, sensitivity } from "./stress.js";
import { Ledger, type LedgerEntry, type ResolveOptions } from "./ledger.js";
import type { Finding } from "./findings.js";

export type CalcOutput = Record<string, unknown> & { findings: Finding[] };

type Fn = (input: any) => CalcOutput;

const withFindings = <T extends object>(o: T): CalcOutput =>
  ({ findings: [], ...o }) as unknown as CalcOutput;

export const CALCS: Record<string, Fn> = {
  cashFlowGap: (i: { annualSpend: number; netTakeHome: number }) =>
    withFindings(cashFlowGap(i.annualSpend, i.netTakeHome)),
  retirementTarget: (i: Parameters<typeof retirementTarget>[0]) => retirementTarget(i) as unknown as CalcOutput,
  project: (i: ProjectionInput) => {
    const r = project(i);
    return withFindings({ endBalance: r.endBalance, endBalanceReal: r.endBalanceReal, depletedAtAge: r.depletedAtAge, rows: r.rows });
  },
  lumpVsAnnuity: (i: { lumpSum: number; annualAnnuity: number }) => {
    const r = lumpVsAnnuity(i.lumpSum, i.annualAnnuity);
    return withFindings({ impliedYield: r.impliedYield, breakevenYears: r.breakevenYears });
  },
  compareScenarios: (i: ComparisonInput) => compareScenarios(i) as unknown as CalcOutput,
  compCheck: (i: { price: number; aboveGradeSqft: number; comps: number[] }) =>
    withFindings(compCheck(i.price, i.aboveGradeSqft, i.comps)),
  allInPerSqft: (i: { price: number; renovation: number; aboveGradeSqft: number }) =>
    withFindings({ value: allInPerSqft(i.price, i.renovation, i.aboveGradeSqft) }),
  keepInvestedHurdle: (i: { annualCarry: number; equity: number }) =>
    withFindings({ value: keepInvestedHurdle(i.annualCarry, i.equity) }),
  compareBorrowing: (i: Parameters<typeof compareBorrowing>[0]) => compareBorrowing(i) as unknown as CalcOutput,
  saleNetProceeds: (i: SaleProceedsInput) => withFindings({ value: saleNetProceeds(i) }),
  monthlyCarry: (i: CarryInput) => withFindings(monthlyCarry(i)),
  optionExercisePayback: (i: Parameters<typeof optionExercisePayback>[0]) =>
    optionExercisePayback(i) as unknown as CalcOutput,
  sellToPayDown: (i: Parameters<typeof sellToPayDown>[0]) => sellToPayDown(i) as unknown as CalcOutput,
  megaBackdoorRoom: (i: Parameters<typeof megaBackdoorRoom>[0]) => withFindings(megaBackdoorRoom(i)),
  costOfADollar: (i: Parameters<typeof costOfADollar>[0]) => withFindings(costOfADollar(i)),
  holdPeriodCheck: (i: Parameters<typeof holdPeriodCheck>[0]) => ({ findings: holdPeriodCheck(i) }),
  checkRateFormula: (i: Parameters<typeof checkRateFormula>[0]) => ({ findings: checkRateFormula(i) }),
  ledgerResolve: (i: { entries: LedgerEntry[]; key: string; opts?: ResolveOptions }) =>
    new Ledger(i.entries).resolve(i.key, i.opts) as unknown as CalcOutput,
  stressGrid: (i: { base: ProjectionInput; returns: number[]; draws: number[]; floorReal?: number }) => {
    const cells = stressGrid(i.base, i.returns, i.draws, i.floorReal);
    return withFindings({ cells, breakingCells: cells.filter((c) => c.breaks).length });
  },
  sensitivity: (i: { base: ProjectionInput; bump?: number }) => {
    const rows = sensitivity(i.base, i.bump);
    return withFindings({ rows, mostSensitive: rows[0]?.input ?? null });
  },
};

export function runCalc(name: string, input: unknown): CalcOutput {
  const fn = CALCS[name];
  if (!fn) throw new Error(`Unknown calculation: ${name}`);
  return fn(input);
}
