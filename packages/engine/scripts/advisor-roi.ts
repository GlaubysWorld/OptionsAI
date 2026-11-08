/**
 * Run the Advisor ROI check on a folder:
 *   npm run advisor-roi -- fixtures/fisher.local
 * The folder holds transactions.csv (Schwab export), prices.csv and check.json
 * ({ input: snapshots, flows, overrides... }). Prints the verdict and writes
 * result.json into the same folder.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePriceCsv, parseSchwabTransactions, runAdvisorRoi } from "../src/advisorRoi/index.js";

const dir = process.argv[2];
if (!dir) { console.error("Usage: npm run advisor-roi -- <folder>"); process.exit(1); }
const fx = JSON.parse(readFileSync(join(dir, "check.json"), "utf8"));
const r = runAdvisorRoi({
  ...fx.input,
  transactions: parseSchwabTransactions(readFileSync(join(dir, "transactions.csv"), "utf8")),
  prices: parsePriceCsv(readFileSync(join(dir, "prices.csv"), "utf8")),
});
writeFileSync(join(dir, "result.json"), JSON.stringify(r, null, 1));

const usd = (n: number | null | undefined) => (n == null ? "n/a" : `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
console.log(`\n${fx.household ?? dir}\n`);
for (const p of r.returns.periods) console.log(`${p.label}  account ${pct(p.netReturn)}  benchmark ${pct(p.benchmarkReturn)}  ${usd(p.dollarsVsBenchmark)}`);
const v = r.verdict;
console.log(`\nFees paid:                       ${usd(v.feesPaid).replace("+", "")}`);
console.log(`Vs benchmark, after fees:        ${usd(v.dollarsVsBenchmarkNetOfFees)}`);
console.log(`Vs benchmark, before fees:       ${usd(v.dollarsVsBenchmarkBeforeFees)}`);
console.log(`Advisor decisions vs not trading: ${usd(v.decisionValue?.advisor)}`);
console.log(`Transition vs not trading:       ${usd(v.decisionValue?.transition)}`);
console.log(`Decision value per fee dollar:   ${v.decisionValuePerFeeDollar?.toFixed(2) ?? "n/a"}`);
console.log(`\nFindings:`);
for (const f of r.findings) console.log(`  [${f.severity}] ${f.message}`);
console.log(`\nFull result: ${join(dir, "result.json")}`);
