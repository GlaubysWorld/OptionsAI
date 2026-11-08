import type { Finding } from "../findings.js";
import type { Snapshot } from "./types.js";

/**
 * Schwab brokerage statement (text lines per page) -> structured facts.
 * Handles the pre-2023 layout ("Investment Detail", SYMBOL: lines) and the
 * current layout ("Positions - Equities" rows led by the ticker).
 * Deterministic: every number comes from the page, and the parser checks its
 * own work (positions plus cash must add up to the account value).
 */
export interface ParsedStatement {
  periodEnd: string;
  accountValue: number;
  /** Cash and sweep balance, when the statement states it. */
  cash: number | null;
  /** Value at the prior year-end, read from the statement's YTD column, if it has one. */
  yearStartValue: number | null;
  /** Securities transferred in (+) or out (-) during the period, at value. */
  securitiesTransferred: number;
  positions: Record<string, { quantity: number; marketValue: number }>;
  findings: Finding[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const money = (s: string) => {
  const neg = /^\(.*\)$/.test(s.trim()) || s.trim().startsWith("-");
  const v = Number(s.replace(/[()$,\s-]/g, ""));
  return neg ? -v : v;
};
/** Old layout: quantity, price (5 dp; lot rows use 4 dp, which keeps them out), market value. */
const ROW = /([\d,]+\.\d{4})\s+([\d,]+\.\d{5})\s+([\d,]+\.\d{2})/;
/** Current layout: prices of $1,000+ print with 4 dp. */
const NEW_ROW = /([\d,]+\.\d{4})\s+([\d,]+\.\d{4,5})\s+([\d,]+\.\d{2})/;

export function parseSchwabStatement(pages: string[][]): ParsedStatement {
  const lines = pages.flat();
  const text = lines.join("\n");
  const findings: Finding[] = [];

  const p = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})/);
  if (!p) throw new Error("Not a Schwab statement: no statement period found");
  const periodEnd = `${p[4]}-${String(MONTHS.indexOf(p[1]!) + 1).padStart(2, "0")}-${p[3]!.padStart(2, "0")}`;

  const ev = text.match(/Ending (?:Account )?Value(?: on [\d/]+)?\s+\$\s?([\d,]+\.\d{2})/);
  if (!ev) throw new Error(`No ending account value found (${periodEnd})`);
  const accountValue = money(ev[1]!);

  // Year-start value only where the summary table has a YTD column.
  let yearStartValue: number | null = null;
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(?:Beginning (?:Account )?Value|Starting Value)\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})/);
    if (!m || yearStartValue !== null) return;
    const header = lines.slice(Math.max(0, i - 3), i).join(" ");
    if (/\bYTD\b|Year to Date/.test(header)) yearStartValue = money(m[2]!);
  });

  const tr = text.match(/Transfer of Securities\s*(?:\(In\/Out\))?\s+(\(?-?[\d,]+\.\d{2}\)?)/);
  const securitiesTransferred = tr ? money(tr[1]!) : 0;

  const positions: ParsedStatement["positions"] = {};
  const put = (sym: string, q: string, v: string) => {
    const prev = positions[sym];
    positions[sym] = { quantity: (prev?.quantity ?? 0) + money(q), marketValue: (prev?.marketValue ?? 0) + money(v) };
  };
  const newLayout = lines.some((l) => /^\s*Positions - (Equities|Mutual Funds|Exchange Traded)/.test(l));
  if (newLayout) {
    let inSection = false;
    for (const l of lines) {
      const sec = l.match(/^\s*Positions - (.+)/);
      if (sec) { inSection = !/Summary/.test(sec[1]!); continue; }
      if (/^\s*(Transactions|Investment Detail|Pending|Realized Gain|Account Activity|Bank Sweep|Cash Transactions)/.test(l)) inSection = false;
      if (!inSection) continue;
      const m = l.match(/^\s*([A-Z][A-Z0-9.]{0,9})\s+\S/);
      const r = l.match(NEW_ROW);
      if (m && r && !["Symbol", "Total"].includes(m[1]!)) put(m[1]!, r[1]!, r[3]!);
    }
  } else {
    let inSection = false;
    let pending: { q: string; v: string } | null = null;
    for (const l of lines) {
      if (/^\s*Investment Detail/.test(l)) { inSection = true; continue; }
      if (/^\s*(Realized Gain|Transaction Detail|Bank Sweep Activity|Trades Pending|Pending Corporate|Endnotes)/.test(l)) inSection = false;
      if (!inSection) continue;
      const r = l.match(ROW);
      if (r) pending = { q: r[1]!, v: r[3]! };
      const s = l.match(/SYMBOL:\s*([A-Z0-9.]+)/);
      if (s && pending) { put(s[1]!, pending.q, pending.v); pending = null; }
    }
  }

  // Self-check: positions plus cash must equal the account value.
  const held = Object.values(positions).reduce((s, x) => s + x.marketValue, 0);
  const cm = text.match(/^\s*Cash and (?:Cash Investments|Bank Sweep)\s+\$?\s?([\d,]+\.\d{2})/m);
  const cash = cm ? money(cm[1]!) : null;
  const gap = accountValue - held - (cash ?? 0);
  const ok = cash !== null ? Math.abs(gap) <= Math.max(5, accountValue * 0.0005) : gap >= -1 && gap <= accountValue * 0.05;
  if (Object.keys(positions).length === 0 || !ok) {
    findings.push({
      code: "RECONCILIATION_MISMATCH",
      severity: "block",
      message: `Positions read from the ${periodEnd} statement add up to $${Math.round(held).toLocaleString("en-US")} against an account value of $${Math.round(accountValue).toLocaleString("en-US")}. The statement wasn't read completely.`,
      details: { periodEnd, held, cash, accountValue },
    });
  }
  return { periodEnd, accountValue, cash, yearStartValue, securitiesTransferred, positions, findings };
}

/** Statements -> snapshots for the check, adding value-only year-start points the YTD columns reveal. */
export function snapshotsFromStatements(statements: ParsedStatement[], cashSymbols: string[] = []): Snapshot[] {
  const cash = new Set(cashSymbols);
  const out = new Map<string, Snapshot>();
  for (const s of statements) {
    out.set(s.periodEnd, {
      date: s.periodEnd,
      accountValue: s.accountValue,
      positions: Object.fromEntries(Object.entries(s.positions).filter(([k]) => !cash.has(k)).map(([k, v]) => [k, v.quantity])),
    });
  }
  for (const s of statements) {
    if (s.yearStartValue === null) continue;
    const date = `${Number(s.periodEnd.slice(0, 4)) - 1}-12-31`;
    if (!out.has(date)) out.set(date, { date, accountValue: s.yearStartValue });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
