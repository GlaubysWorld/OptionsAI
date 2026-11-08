/**
 * End to end from the files a client downloads: every clients/<name>/ folder
 * with an expected.json (gitignored, real data) must produce the same verdict
 * as its hand-checked run. Skipped when there are none.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdvisorRoi } from "../../engine/src/advisorRoi/index.js";
import { loadAdvisorRoiFolder } from "../src/advisorRoiFolder.js";

const root = join(import.meta.dirname, "..", "clients");
const clients = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, "expected.json"))) : [];

for (const name of clients) {
  const dir = join(root, name);
  const e = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));

  describe(`client folder: ${name}`, () => {
    it("reads every statement and proposes the renames and pre-history trades", async () => {
      const l = await loadAdvisorRoiFolder(dir);
      expect(l.statements).toHaveLength(e.statements);
      expect(l.findings.filter((f) => f.severity === "block")).toEqual([]);
      expect(l.proposed.renames).toEqual(e.renames);
      expect(l.proposed.preHistory.map((p) => p.symbol).sort()).toEqual(e.preHistory);
    }, 60_000);

    it("reconciles and reproduces the verdict once the proposals are accepted", async () => {
      const l = await loadAdvisorRoiFolder(dir, { acceptProposed: true });
      const r = runAdvisorRoi(l.input);
      expect(r.reconciliation.checked.flatMap((c) => c.mismatches)).toEqual([]);
      expect(Math.abs(r.verdict.dollarsVsBenchmarkNetOfFees! - e.dollarsVsBenchmark)).toBeLessThan(250);
      expect(Math.abs(r.verdict.feesPaid - e.fees)).toBeLessThan(1);
      expect(Math.abs(r.verdict.decisionValue!.advisor - e.advisorLatest)).toBeLessThan(250);
      expect(Math.abs(r.verdict.decisionValue!.transition - e.transitionLatest)).toBeLessThan(250);
    }, 60_000);
  });
}

if (clients.length === 0) {
  it.skip("no client folders on this machine", () => {});
}
