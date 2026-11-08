/**
 * Run the Advisor ROI check on a client folder (see src/advisorRoiFolder.ts):
 *   npm run advisor-roi -- <folder> [--accept-proposed]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAdvisorRoi } from "../../engine/src/advisorRoi/index.js";
import { loadAdvisorRoiFolder } from "../src/advisorRoiFolder.js";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) { console.error("Usage: npm run advisor-roi -- <folder> [--accept-proposed]"); process.exit(1); }
const loaded = await loadAdvisorRoiFolder(dir, { acceptProposed: process.argv.includes("--accept-proposed") });
console.log(`Read ${loaded.statements.length} statements: ${loaded.statements.map((s) => s.periodEnd).join(", ")}`);
const p = loaded.proposed;
if (Object.keys(p.renames).length || p.preHistory.length) {
  console.log("\nThe data suggests fixes nobody has confirmed (add to answers.json, or rerun with --accept-proposed):");
  for (const [a, b] of Object.entries(p.renames)) console.log(`  ${a} is the old name for ${b}`);
  for (const l of p.preHistory) console.log(`  ${l.side} ${l.quantity} ${l.symbol} before the transaction file starts (~$${Math.round(l.amount).toLocaleString("en-US")})`);
}
const r = runAdvisorRoi(loaded.input);
writeFileSync(join(dir, "result.json"), JSON.stringify({ ...r, statements: loaded.statements.map(({ positions, ...s }) => s) }, null, 1));
const usd = (n: number | null | undefined) => (n == null ? "withheld" : `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
console.log("");
for (const x of r.returns.periods) console.log(`${x.label}  account ${pct(x.netReturn)}  benchmark ${pct(x.benchmarkReturn)}  ${usd(x.dollarsVsBenchmark)}`);
const v = r.verdict;
console.log(`\nFees paid                         ${usd(v.feesPaid).slice(1)}`);
console.log(`Vs benchmark, after fees          ${usd(v.dollarsVsBenchmarkNetOfFees)}`);
console.log(`Vs benchmark, before fees         ${usd(v.dollarsVsBenchmarkBeforeFees)}`);
console.log(`Advisor decisions vs not trading  ${usd(v.decisionValue?.advisor)}`);
console.log(`Transition vs not trading         ${usd(v.decisionValue?.transition)}`);
console.log(`\nFindings:`);
for (const f of [...loaded.findings, ...r.findings]) console.log(`  [${f.severity}] ${f.message}`);
console.log(`\nFull result: ${join(dir, "result.json")}`);
