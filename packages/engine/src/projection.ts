import { toRealDollars } from "./money.js";

export interface Contribution {
  fromAge: number; // inclusive
  toAge: number; // inclusive
  amount: number; // nominal per year, added at end of year
}

export interface ProjectionInput {
  startBalance: number;
  startAge: number;
  endAge: number;
  nominalReturn: number;
  inflation: number;
  /** Draw in the first projected year, nominal. */
  firstYearDraw: number;
  /** Annual growth of the draw. Defaults to inflation. */
  drawGrowth?: number;
  /** Age the draw starts. Defaults to startAge. */
  drawStartAge?: number;
  contributions?: Contribution[];
}

export interface ProjectionRow {
  age: number;
  startBalance: number;
  growth: number;
  draw: number;
  contribution: number;
  endBalance: number;
  endBalanceReal: number; // in start-year dollars
}

export interface ProjectionResult {
  rows: ProjectionRow[];
  endBalance: number;
  endBalanceReal: number;
  /** First age at which the balance went to zero or below, if any. */
  depletedAtAge: number | null;
}

/**
 * Calc 3 and the base of calc 14. Year by year:
 * end = start * (1 + r) - draw + contributions. Draw grows each year.
 * This matches the method in the house-decision export.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const drawGrowth = input.drawGrowth ?? input.inflation;
  const drawStartAge = input.drawStartAge ?? input.startAge;
  const rows: ProjectionRow[] = [];
  let balance = input.startBalance;
  let depletedAtAge: number | null = null;

  for (let age = input.startAge; age < input.endAge; age++) {
    const yearIndex = age - input.startAge;
    const drawYears = age - drawStartAge;
    const draw = drawYears >= 0 ? input.firstYearDraw * Math.pow(1 + drawGrowth, drawYears) : 0;
    const contribution = (input.contributions ?? [])
      .filter((c) => age >= c.fromAge && age <= c.toAge)
      .reduce((sum, c) => sum + c.amount, 0);
    const startBalance = balance;
    const growth = startBalance * input.nominalReturn;
    balance = startBalance + growth - draw + contribution;
    if (balance <= 0 && depletedAtAge === null) depletedAtAge = age + 1;
    rows.push({
      age: age + 1,
      startBalance,
      growth,
      draw,
      contribution,
      endBalance: balance,
      endBalanceReal: toRealDollars(balance, input.inflation, yearIndex + 1),
    });
  }

  const last = rows[rows.length - 1];
  return {
    rows,
    endBalance: last ? last.endBalance : input.startBalance,
    endBalanceReal: last ? last.endBalanceReal : input.startBalance,
    depletedAtAge,
  };
}
