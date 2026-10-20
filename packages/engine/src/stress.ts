import { project, type ProjectionInput } from "./projection.js";

export interface StressCell {
  nominalReturn: number;
  firstYearDraw: number;
  endBalanceReal: number;
  depletedAtAge: number | null;
  breaks: boolean;
}

/** Calc 14: return x spend grid. A cell "breaks" if the money runs out or ends below the floor. */
export function stressGrid(
  base: ProjectionInput,
  returns: number[],
  draws: number[],
  floorReal = 0,
): StressCell[] {
  const cells: StressCell[] = [];
  for (const r of returns) {
    for (const d of draws) {
      const res = project({ ...base, nominalReturn: r, firstYearDraw: d });
      cells.push({
        nominalReturn: r,
        firstYearDraw: d,
        endBalanceReal: res.endBalanceReal,
        depletedAtAge: res.depletedAtAge,
        breaks: res.depletedAtAge !== null || res.endBalanceReal < floorReal,
      });
    }
  }
  return cells;
}

export type SensitivityInput = "spend" | "return" | "inflation" | "startBalance";

export interface SensitivityRow {
  input: SensitivityInput;
  /** Absolute change in real end balance for a 10% adverse move in this input. */
  impact: number;
}

/**
 * Which input moves the outcome most? Each input is moved 10% in the adverse
 * direction and the drop in real end balance is ranked. In the house decision,
 * spend came out about 3x more powerful than returns.
 */
export function sensitivity(base: ProjectionInput, bump = 0.1): SensitivityRow[] {
  const baseline = project(base).endBalanceReal;
  const variants: Record<SensitivityInput, ProjectionInput> = {
    spend: { ...base, firstYearDraw: base.firstYearDraw * (1 + bump) },
    return: { ...base, nominalReturn: base.nominalReturn * (1 - bump) },
    inflation: { ...base, inflation: base.inflation * (1 + bump) },
    startBalance: { ...base, startBalance: base.startBalance * (1 - bump) },
  };
  return (Object.keys(variants) as SensitivityInput[])
    .map((k) => ({ input: k, impact: Math.abs(baseline - project(variants[k]).endBalanceReal) }))
    .sort((x, y) => y.impact - x.impact);
}
