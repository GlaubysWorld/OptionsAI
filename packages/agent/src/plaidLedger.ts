import type { HouseholdEntry } from "./household.js";

/**
 * Turns synced Plaid accounts and holdings (the Supabase `accounts` and
 * `holdings` tables) into connected ledger entries. Connected beats stated, so
 * live balances win over anything typed into a chat for the same key.
 */
export interface AccountRowLike {
  id: string;
  institution_name: string;
  account_name: string;
  account_type: string;
  synced_at: string | null;
  is_active?: boolean;
}

export interface HoldingRowLike {
  account_id: string;
  current_value: number | null;
  cost_basis: number | null;
  last_price_at: string | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function holdingsToLedger(
  accounts: AccountRowLike[],
  holdings: HoldingRowLike[],
  fallbackAsOf: string,
): HouseholdEntry[] {
  const entries: HouseholdEntry[] = [];
  let total = 0;
  let latest = "";

  for (const a of accounts.filter((x) => x.is_active !== false)) {
    const rows = holdings.filter((h) => h.account_id === a.id);
    if (rows.length === 0) continue;
    const value = rows.reduce((s, h) => s + (h.current_value ?? 0), 0);
    const basis = rows.every((h) => h.cost_basis !== null)
      ? rows.reduce((s, h) => s + (h.cost_basis ?? 0), 0)
      : null;
    const asOf = (a.synced_at ?? rows.map((h) => h.last_price_at).filter(Boolean).sort().pop() ?? fallbackAsOf).slice(0, 10);
    const base = `account.${slug(a.institution_name)}.${slug(a.account_name)}`;
    const ref = `plaid:account/${a.id}`;
    entries.push({ key: `${base}.value`, value, sourceType: "connected", sourceRef: ref, asOf, label: `${a.institution_name} ${a.account_name} market value` });
    if (basis !== null) {
      entries.push({ key: `${base}.cost_basis`, value: basis, sourceType: "connected", sourceRef: ref, asOf, label: `${a.institution_name} ${a.account_name} cost basis` });
    }
    total += value;
    if (asOf > latest) latest = asOf;
  }

  if (entries.length > 0) {
    entries.push({
      key: "portfolio.connected_total",
      value: total,
      sourceType: "connected",
      sourceRef: "plaid:all-accounts",
      asOf: latest || fallbackAsOf,
      label: "Total market value across connected accounts",
    });
  }
  return entries;
}
