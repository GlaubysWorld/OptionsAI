/**
 * Golden tests. Each fixture case says: run this calculation with these inputs,
 * the source document reported these outputs. The engine must reproduce them.
 *
 * When the source document is internally inconsistent, the case carries an
 * `exportDiscrepancy`: the engine must NOT match with the stated inputs, and
 * MUST match once the override is applied. That proves exactly which input
 * the original analysis really used.
 *
 * Detection cases assert the engine raises a specific finding on its own.
 *
 * fixtures/household.example.json is synthetic and committed.
 * fixtures/*.local.json holds real household data and is gitignored.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCalc, type CalcOutput } from "../src/index.js";

interface Tolerance {
  abs?: number;
  rel?: number;
}

interface GoldenCase {
  id: string;
  title: string;
  calc: string;
  input: Record<string, unknown>;
  expect?: Record<string, number | boolean | string>;
  tolerance?: Tolerance;
  exportDiscrepancy?: { override: Record<string, unknown>; note: string };
  expectFinding?: string;
  expectNoFinding?: string;
  skip?: string;
}

interface Fixture {
  household: string;
  cases: GoldenCase[];
}

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const files = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))
  : [];

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

function within(actual: unknown, expected: number | boolean | string, tol: Tolerance): boolean {
  if (typeof expected !== "number") return actual === expected;
  if (typeof actual !== "number") return false;
  const diff = Math.abs(actual - expected);
  const absOk = tol.abs !== undefined ? diff <= tol.abs : false;
  const relOk = tol.rel !== undefined ? diff <= Math.abs(expected) * tol.rel : false;
  return absOk || relOk || diff < 1e-9;
}

function allMatch(out: CalcOutput, expectMap: Record<string, number | boolean | string>, tol: Tolerance) {
  return Object.entries(expectMap).map(([path, expected]) => ({
    path,
    expected,
    actual: get(out, path),
    ok: within(get(out, path), expected, tol),
  }));
}

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;
  describe(`golden: ${fixture.household} (${file})`, () => {
    for (const c of fixture.cases) {
      const run = c.skip ? it.skip : it;
      run(`${c.id} ${c.title}`, () => {
        const tol = c.tolerance ?? { rel: 0.02 };
        const out = runCalc(c.calc, c.input);

        if (c.expectFinding) {
          expect(out.findings.map((f) => f.code)).toContain(c.expectFinding);
        }
        if (c.expectNoFinding) {
          expect(out.findings.map((f) => f.code)).not.toContain(c.expectNoFinding);
        }
        if (!c.expect) return;

        if (c.exportDiscrepancy) {
          const stated = allMatch(out, c.expect, tol);
          expect(stated.some((r) => !r.ok), `stated inputs unexpectedly reproduce the reported result`).toBe(true);
          const corrected = allMatch(runCalc(c.calc, deepMerge(c.input, c.exportDiscrepancy.override)), c.expect, tol);
          expect(corrected.filter((r) => !r.ok)).toEqual([]);
        } else {
          expect(allMatch(out, c.expect, tol).filter((r) => !r.ok)).toEqual([]);
        }
      });
    }
  });
}
