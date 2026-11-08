import type { Finding } from "../findings.js";
import type { AdvisorRoiInput, Snapshot } from "./types.js";

/** Actions that change share counts, and how the quantity is applied. */
const SIGNED: Record<string, 1 | -1> = { Buy: 1, "Reinvest Shares": 1, Sell: -1, "Cancel Sell": 1, "Cancel Buy": -1 };
const AS_IS = new Set([
  "Security Transfer", "Journal", "Journaled Shares", "Stock Split", "Reverse Split",
  "Spin-off", "Stock Merger", "Mandatory Reorg Exc", "Transfer",
]);

export interface ReconciliationResult {
  checked: { date: string; positions: number; mismatches: { symbol: string; rebuilt: number; statement: number }[] }[];
  findings: Finding[];
}

/**
 * Rebuild share counts from the first statement plus every transaction, and
 * check them against each later statement. If this doesn't tie out, nothing
 * downstream can be trusted, so mismatches block.
 */
export function reconcileHoldings(input: AdvisorRoiInput): ReconciliationResult {
  const map = input.symbolMap ?? {};
  const cash = new Set(input.cashSymbols ?? []);
  const norm = (s: string) => map[s] ?? s;
  const snaps = [...input.snapshots].filter((s) => s.positions).sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = snaps[0];
  if (!first) return { checked: [], findings: [{ code: "MISSING_VALUE", severity: "block", message: "No statement snapshot to start from." }] };

  const hold = new Map<string, number>();
  const add = (s: string, q: number) => hold.set(s, (hold.get(s) ?? 0) + q);
  for (const [s, q] of Object.entries(first.positions ?? {})) add(norm(s), q);
  for (const leg of input.preHistory ?? []) {
    if (leg.date > first.date) continue;
    add(norm(leg.symbol), leg.side === "buy" ? leg.quantity : -leg.quantity);
  }

  const events = input.transactions.filter((t) => t.date > first.date);
  const checked: ReconciliationResult["checked"] = [];
  const compare = (snap: Snapshot) => {
    const st = new Map<string, number>();
    for (const [s, q] of Object.entries(snap.positions ?? {})) st.set(norm(s), (st.get(norm(s)) ?? 0) + q);
    const syms = new Set([...st.keys(), ...[...hold.entries()].filter(([, q]) => Math.abs(q) > 1e-6).map(([s]) => s)]);
    const mismatches = [...syms]
      .filter((s) => !cash.has(s))
      .map((s) => ({ symbol: s, rebuilt: Math.round((hold.get(s) ?? 0) * 1e4) / 1e4, statement: st.get(s) ?? 0 }))
      .filter((m) => Math.abs(m.rebuilt - m.statement) > 0.01);
    checked.push({ date: snap.date, positions: st.size, mismatches });
  };

  let si = 1;
  for (const t of events) {
    while (si < snaps.length && t.date > snaps[si]!.date) compare(snaps[si++]!);
    const s = norm(t.symbol);
    if (!s || cash.has(s)) continue;
    if (t.action in SIGNED) add(s, SIGNED[t.action]! * Math.abs(t.quantity));
    else if (AS_IS.has(t.action)) add(s, t.quantity);
  }
  while (si < snaps.length) compare(snaps[si++]!);

  const findings: Finding[] = checked
    .filter((c) => c.mismatches.length > 0)
    .map((c) => ({
      code: "RECONCILIATION_MISMATCH" as const,
      severity: "block" as const,
      message: `Rebuilt holdings don't match the ${c.date} statement for ${c.mismatches.length} position(s): ${c.mismatches.map((m) => m.symbol).join(", ")}.`,
      details: { date: c.date, mismatches: c.mismatches },
    }));
  return { checked, findings };
}
