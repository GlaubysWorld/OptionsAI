import type { Finding } from "../findings.js";
import { closePrice } from "./prices.js";
import { reconcileHoldings } from "./replay.js";
import { parsePriceCsv, parseSchwabTransactions } from "./schwab.js";
import { snapshotsFromStatements, type ParsedStatement } from "./schwabStatement.js";
import type { AdvisorRoiInput, ExternalFlow, PreHistoryLeg, Snapshot, Txn } from "./types.js";


/**
 * Value securities moved in or out of the account. Statements give the value
 * for their month; the transactions give the day. Transfers in months without
 * a statement are valued at that day's close and flagged as approximate.
 */
export function securitiesTransferFlows(
  transactions: Txn[], statements: ParsedStatement[], prices: AdvisorRoiInput["prices"], symbolMap: Record<string, string> = {},
): { flows: ExternalFlow[]; findings: Finding[] } {
  const flows: ExternalFlow[] = [];
  const findings: Finding[] = [];
  const transfers = transactions.filter((t) => t.action === "Security Transfer" && t.quantity !== 0);
  const covered = new Set<string>();
  for (const s of statements) {
    if (s.securitiesTransferred === 0) continue;
    const month = s.periodEnd.slice(0, 7);
    const sameSign = transfers.filter((t) => t.date.startsWith(month) && Math.sign(t.quantity) === Math.sign(s.securitiesTransferred));
    for (const t of transfers.filter((x) => x.date.startsWith(month))) covered.add(`${t.date}|${t.symbol}`);
    const date = sameSign[0]?.date ?? s.periodEnd;
    flows.push({ date, amount: s.securitiesTransferred, label: `Securities transferred ${s.securitiesTransferred > 0 ? "in" : "out"} (${month} statement)` });
  }
  for (const t of transfers) {
    if (covered.has(`${t.date}|${t.symbol}`)) continue;
    const sym = symbolMap[t.symbol] ?? t.symbol;
    const px = closePrice(prices, sym, t.date);
    if (px === null) {
      findings.push({ code: "MISSING_VALUE", severity: "warn", message: `${Math.abs(t.quantity)} ${sym} shares moved ${t.quantity > 0 ? "in" : "out"} on ${t.date} with no statement or price to value them. Left out of the flows.` });
      continue;
    }
    flows.push({ date: t.date, amount: t.quantity * px, label: `${Math.abs(t.quantity)} ${sym} shares transferred ${t.quantity > 0 ? "in" : "out"}, valued at that day's close`, approximate: true });
  }
  return { flows: flows.sort((a, b) => (a.date < b.date ? -1 : 1)), findings };
}

export interface ProposedFixes {
  /** Old symbol or CUSIP -> the symbol the statements use. */
  renames: Record<string, string>;
  /** Positions that changed before the transaction file starts. */
  preHistory: PreHistoryLeg[];
}

/**
 * When holdings don't reconcile, propose the two common causes for the client
 * (or Claude) to confirm: a ticker rename, and trades made before the export
 * begins. Nothing is applied automatically.
 */
export function proposeFixes(input: AdvisorRoiInput): ProposedFixes {
  const renames: Record<string, string> = {};
  const preHistory: PreHistoryLeg[] = [];
  const firstSnap = [...input.snapshots].filter((s) => s.positions).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const firstTrade: Record<string, string> = {};
  for (const t of input.transactions) if ((t.action === "Buy" || t.action === "Sell") && !firstTrade[t.symbol]) firstTrade[t.symbol] = t.date;

  // Renames: two symbols off by the same share count in opposite directions at
  // one statement, where one of them isn't on the statement at all. That one is
  // the old name (a renamed ticker, or a CUSIP the custodian used for a reorg).
  for (const c of reconcileHoldings(input).checked) {
    const delta = c.mismatches.map((m) => ({ ...m, d: m.rebuilt - m.statement }));
    for (const a of delta) {
      if (a.statement !== 0 || renames[a.symbol] || a.symbol in (input.symbolMap ?? {})) continue;
      const b = delta.find((x) => x.symbol !== a.symbol && Math.abs(x.d + a.d) < 0.01 && x.statement !== 0);
      if (b) renames[a.symbol] = b.symbol;
    }
  }
  // Trades before the export: after renames, a position still differs at the
  // first check and the symbol never trades in the file before then.
  const rec = reconcileHoldings({ ...input, symbolMap: { ...(input.symbolMap ?? {}), ...renames } });
  const first = rec.checked[0];
  if (first && firstSnap) {
    for (const m of first.mismatches) {
      if (renames[m.symbol] || Object.values(renames).includes(m.symbol)) continue;
      if (firstTrade[m.symbol] && firstTrade[m.symbol]! <= first.date) continue;
      const qty = Math.abs(m.statement - m.rebuilt);
      const px = closePrice(input.prices, m.symbol, firstSnap.date);
      preHistory.push({
        date: firstSnap.date,
        side: m.statement > m.rebuilt ? "buy" : "sell",
        symbol: m.symbol,
        quantity: qty,
        amount: px === null ? 0 : qty * px,
        approximate: true,
      });
    }
  }
  return { renames, preHistory };
}

export interface BuildOptions {
  transactionsCsv: string;
  statements: ParsedStatement[];
  pricesCsv: string;
  benchmark: AdvisorRoiInput["benchmark"];
  cashSymbols?: string[];
  symbolMap?: Record<string, string>;
  transitionWindows?: AdvisorRoiInput["transitionWindows"];
  overrides?: AdvisorRoiInput["overrides"];
  preHistory?: PreHistoryLeg[];
}

/** Raw client files -> a ready-to-run check input, plus anything that needs a human. */
export function buildAdvisorRoiInput(o: BuildOptions): { input: AdvisorRoiInput; findings: Finding[] } {
  const transactions = parseSchwabTransactions(o.transactionsCsv);
  const prices = parsePriceCsv(o.pricesCsv);
  const cashSymbols = o.cashSymbols ?? ["SNVXX", "SWVXX", "SWGXX", "SNOXX"];
  const all = snapshotsFromStatements(o.statements, cashSymbols);
  const firstWithPositions = all.find((s) => s.positions)?.date ?? "";
  // A year-start value from before the first full statement has no flows to go with it.
  const snapshots: Snapshot[] = all.filter((s) => s.positions || s.date >= firstWithPositions);
  const { flows, findings } = securitiesTransferFlows(transactions, o.statements, prices, o.symbolMap);
  return {
    input: {
      transactions,
      snapshots,
      externalFlows: flows,
      prices,
      benchmark: o.benchmark,
      cashSymbols,
      symbolMap: o.symbolMap ?? {},
      transitionWindows: o.transitionWindows ?? [],
      overrides: o.overrides ?? [],
      preHistory: o.preHistory ?? [],
    },
    findings: [...o.statements.flatMap((s) => s.findings), ...findings],
  };
}

