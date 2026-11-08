/**
 * Golden test: the engine must reproduce an independent prototype run on a
 * real account. Data lives in fixtures/<name>.local/ (gitignored):
 *   transactions.csv  custodian export
 *   prices.csv        date,symbol,close,adjclose
 *   check.json        { input: <AdvisorRoiInput minus transactions/prices>, expected }
 * Skipped when no such folder exists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePriceCsv, parseSchwabTransactions, runAdvisorRoi } from "../src/advisorRoi/index.js";

const dir = join(import.meta.dirname, "..", "fixtures");
const runs = existsSync(dir) ? readdirSync(dir).filter((d) => d.endsWith(".local") && existsSync(join(dir, d, "check.json"))) : [];
const close = (a: number, b: number, abs: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(abs);

for (const name of runs) {
  const base = join(dir, name);
  const fx = JSON.parse(readFileSync(join(base, "check.json"), "utf8"));
  const input = {
    ...fx.input,
    transactions: parseSchwabTransactions(readFileSync(join(base, "transactions.csv"), "utf8")),
    prices: parsePriceCsv(readFileSync(join(base, "prices.csv"), "utf8")),
  };
  const e = fx.expected;
  const r = runAdvisorRoi(input);

  describe(`advisor ROI golden: ${fx.household}`, () => {
    it("rebuilt holdings tie to every statement", () => {
      expect(r.reconciliation.checked.flatMap((c) => c.mismatches)).toHaveLength(e.reconcileMismatches);
      expect(r.reconciliation.checked.length).toBeGreaterThan(0);
    });

    it("reproduces interval returns net and gross of fees", () => {
      r.returns.intervals.forEach((iv, i) => {
        close(iv.netReturn, e.intervalsNet[i], 0.00006);
        close(iv.grossReturn, e.intervalsGross[i], 0.00006);
      });
    });

    it("reproduces the total and the dollar gap to the benchmark", () => {
      close(r.returns.total.netReturn, e.totalNet, 0.0001);
      close(r.returns.total.grossReturn, e.totalGross, 0.0001);
      close(r.returns.total.dollarsVsBenchmark!, e.dollarsVsBenchmark, 1);
      close(r.returns.total.fees, e.fees, 1);
    });

    it("excludes cancelled sells as errors", () => {
      close(r.trades.excludedErrors.reduce((s, x) => s + x.amount, 0), e.excludedErrorSells, 1);
    });

    it("reproduces trade scores by class and horizon", () => {
      for (const cls of ["advisor", "transition"] as const) {
        const got = r.trades.summary.find((s) => s.tradeClass === cls)!;
        for (const [h, vals] of Object.entries(e[cls] as Record<string, Record<string, number>>)) {
          for (const [k, v] of Object.entries(vals)) close((got.byHorizon[h] as Record<string, number>)[k]!, v, 1);
        }
      }
    });

    it("reports unpriced securities and approximate inputs", () => {
      const unpriced = r.findings.find((f) => f.code === "UNPRICED");
      expect((unpriced?.details as { symbols: string[] }).symbols).toEqual(e.unpriced);
      expect(r.findings.some((f) => f.code === "APPROXIMATE_INPUT")).toBe(true);
    });

    it("ranks the best and worst decisions", () => {
      expect(r.verdict.worst[0]?.date).toBe(e.worstDay);
      expect(r.verdict.best[0]?.date).toBe(e.bestDay);
    });
  });
}
