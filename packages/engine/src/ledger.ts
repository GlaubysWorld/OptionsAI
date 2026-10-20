import type { Finding } from "./findings.js";

/**
 * The household ledger. One fact, one key. Every value carries where it came
 * from and when. No number lives only in a chat.
 */
export type SourceType = "connected" | "document" | "stated" | "estimated";

const SOURCE_PRIORITY: Record<SourceType, number> = {
  connected: 4,
  document: 3,
  stated: 2,
  estimated: 1,
};

export interface LedgerEntry {
  key: string;
  value: number;
  sourceType: SourceType;
  sourceRef: string; // e.g. "plaid:item/123", "doc:closing-statement.pdf", "chat:2026-08-05"
  asOf: string; // ISO date
}

export interface ResolveOptions {
  /** Treat as "today" for staleness checks. ISO date. Defaults to now. */
  today?: string;
  /** Warn when the chosen value is older than this. Default 90 days. */
  maxAgeDays?: number;
  /** Entries within this many days of the chosen one are expected to agree. Default 45. */
  conflictWindowDays?: number;
  /** Relative tolerance for "agree". Default 1%. */
  tolerance?: number;
}

export interface Resolved {
  key: string;
  value: number | null;
  entry: LedgerEntry | null;
  findings: Finding[];
}

const DAY_MS = 86_400_000;
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

export class Ledger {
  private readonly entries: LedgerEntry[];

  constructor(entries: LedgerEntry[] = []) {
    this.entries = [...entries];
  }

  add(entry: LedgerEntry): void {
    this.entries.push(entry);
  }

  history(key: string): LedgerEntry[] {
    return this.entries
      .filter((e) => e.key === key)
      .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
  }

  /**
   * Pick the current value: most recent, ties broken by source strength.
   * A3: flags other recent entries that disagree, so drift gets surfaced
   * instead of silently picking one.
   */
  resolve(key: string, opts: ResolveOptions = {}): Resolved {
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    const maxAge = opts.maxAgeDays ?? 90;
    const window = opts.conflictWindowDays ?? 45;
    const tol = opts.tolerance ?? 0.01;
    const findings: Finding[] = [];

    const all = this.history(key).sort(
      (a, b) =>
        Date.parse(b.asOf) - Date.parse(a.asOf) ||
        SOURCE_PRIORITY[b.sourceType] - SOURCE_PRIORITY[a.sourceType],
    );
    const chosen = all[0];
    if (!chosen) {
      return {
        key,
        value: null,
        entry: null,
        findings: [{ code: "MISSING_VALUE", severity: "block", message: `No value on file for ${key}.` }],
      };
    }

    const disagreeing = all
      .slice(1)
      .filter((e) => days(e.asOf, chosen.asOf) <= window)
      .filter((e) => Math.abs(e.value - chosen.value) > Math.abs(chosen.value) * tol);
    if (disagreeing.length > 0) {
      const strongerOrEqual = disagreeing.some(
        (e) => SOURCE_PRIORITY[e.sourceType] >= SOURCE_PRIORITY[chosen.sourceType],
      );
      findings.push({
        code: "CONFLICTING_VALUES",
        severity: strongerOrEqual ? "block" : "warn",
        message: `${key} has ${disagreeing.length + 1} different values within ${window} days. Using ${chosen.value.toLocaleString(
          "en-US",
        )} from ${chosen.sourceRef} (${chosen.asOf}). Confirm which is right.`,
        details: { chosen, disagreeing },
      });
    }

    const age = days(today, chosen.asOf);
    if (age > maxAge) {
      findings.push({
        code: "STALE_VALUE",
        severity: "warn",
        message: `${key} was last updated ${Math.round(age)} days ago (${chosen.asOf}).`,
        details: { asOf: chosen.asOf, ageDays: Math.round(age) },
      });
    }

    return { key, value: chosen.value, entry: chosen, findings };
  }
}
