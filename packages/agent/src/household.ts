import { readFileSync } from "node:fs";
import { Ledger, type LedgerEntry } from "../../engine/src/index.js";

/**
 * A household file. Every number lives in the ledger with its source and date.
 * `context` carries words only (goals, the decision, who's involved) so Claude
 * can't pick up a figure from anywhere but the ledger or a calculation.
 */
export interface HouseholdEntry extends LedgerEntry {
  label?: string;
}

export interface HouseholdFile {
  household: string;
  /** The date the journey is run "as of". Backtests set this to the decision date. */
  asOf: string;
  context: {
    decision: string;
    goals: string[];
    people: string[];
    notes?: string[];
  };
  ledger: HouseholdEntry[];
}

export interface Household {
  file: HouseholdFile;
  ledger: Ledger;
}

export function loadHousehold(path: string): Household {
  const file = JSON.parse(readFileSync(path, "utf8")) as HouseholdFile;
  return fromFile(file);
}

export function fromFile(file: HouseholdFile): Household {
  const containsNumber = [file.context.decision, ...file.context.goals, ...(file.context.notes ?? [])].find((s) =>
    /\$\s?\d|\d+(\.\d+)?\s?%|\d{4,}/.test(s.replace(/\b(19|20)\d{2}\b/g, "")),
  );
  if (containsNumber) {
    throw new Error(
      `Household context must be words only; put numbers in the ledger. Found: "${containsNumber}"`,
    );
  }
  return { file, ledger: new Ledger(file.ledger) };
}

/** Keys and labels Claude can ask for. Values are deliberately not included. */
export function ledgerIndex(h: Household): { key: string; label: string; sources: number }[] {
  const byKey = new Map<string, { label: string; sources: number }>();
  for (const e of h.file.ledger) {
    const cur = byKey.get(e.key);
    byKey.set(e.key, { label: cur?.label ?? e.label ?? e.key, sources: (cur?.sources ?? 0) + 1 });
  }
  return [...byKey.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.key.localeCompare(b.key));
}
