/**
 * A client folder -> a ready check. The folder holds what a client can download:
 *   transactions.csv      Schwab "Transactions" export
 *   statements/*.pdf      Schwab monthly statements (first month, year-ends, latest)
 *   prices.csv            date,symbol,close,adjclose
 *   answers.json          optional: what the client confirmed (overrides, transitions, renames, preHistory, benchmark)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAdvisorRoiInput, parseSchwabStatement, proposeFixes,
  type AdvisorRoiInput, type ParsedStatement, type ProposedFixes,
} from "../../engine/src/advisorRoi/index.js";
import type { Finding } from "../../engine/src/findings.js";
import { pdfToLines } from "./pdfText.js";

export interface Answers {
  benchmark?: AdvisorRoiInput["benchmark"];
  symbolMap?: Record<string, string>;
  preHistory?: AdvisorRoiInput["preHistory"];
  transitionWindows?: AdvisorRoiInput["transitionWindows"];
  overrides?: AdvisorRoiInput["overrides"];
}

export interface LoadedFolder {
  statements: ParsedStatement[];
  input: AdvisorRoiInput;
  findings: Finding[];
  /** Fixes the data suggests and nobody has confirmed yet. */
  proposed: ProposedFixes;
}

export async function readStatements(dir: string): Promise<ParsedStatement[]> {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const out: ParsedStatement[] = [];
  for (const f of files) out.push(parseSchwabStatement(await pdfToLines(new Uint8Array(readFileSync(join(dir, f))))));
  return out.sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
}

export async function loadAdvisorRoiFolder(dir: string, opts: { acceptProposed?: boolean } = {}): Promise<LoadedFolder> {
  const answers: Answers = existsSync(join(dir, "answers.json")) ? JSON.parse(readFileSync(join(dir, "answers.json"), "utf8")) : {};
  const statements = await readStatements(join(dir, "statements"));
  const built = buildAdvisorRoiInput({
    transactionsCsv: readFileSync(join(dir, "transactions.csv"), "utf8"),
    pricesCsv: readFileSync(join(dir, "prices.csv"), "utf8"),
    statements,
    benchmark: answers.benchmark ?? { symbol: "ACWI" },
    ...(answers.symbolMap ? { symbolMap: answers.symbolMap } : {}),
    ...(answers.preHistory ? { preHistory: answers.preHistory } : {}),
    ...(answers.transitionWindows ? { transitionWindows: answers.transitionWindows } : {}),
    ...(answers.overrides ? { overrides: answers.overrides } : {}),
  });
  let input = built.input;
  const proposed = proposeFixes(input);
  const confirmedPre = new Set((input.preHistory ?? []).map((p) => `${p.date}|${p.symbol}`));
  const open: ProposedFixes = {
    renames: Object.fromEntries(Object.entries(proposed.renames).filter(([k]) => !(k in (input.symbolMap ?? {})))),
    preHistory: proposed.preHistory.filter((p) => !confirmedPre.has(`${p.date}|${p.symbol}`)),
  };
  if (opts.acceptProposed) {
    input = {
      ...input,
      symbolMap: { ...(input.symbolMap ?? {}), ...open.renames },
      preHistory: [...(input.preHistory ?? []), ...open.preHistory],
    };
  }
  return { statements, input, findings: built.findings, proposed: opts.acceptProposed ? { renames: {}, preHistory: [] } : open };
}
