/**
 * Advisor ROI check: did the advisor's decisions earn the fee?
 * All inputs are the client's own records. Dates are ISO (YYYY-MM-DD).
 */

/** One custodian transaction, normalized. Amount is signed cash: + into the account, - out. */
export interface Txn {
  date: string;
  /** For corrections booked later ("04/06/2026 as of 04/02/2026"), the effective date. */
  asOf?: string;
  action: string;
  symbol: string;
  description: string;
  quantity: number;
  price: number | null;
  fees: number;
  amount: number;
}

/**
 * A statement snapshot: total account value and share counts by symbol.
 * Positions may be omitted when only the value is known (e.g. a year-start
 * value read off a later statement); such snapshots are not reconciled.
 */
export interface Snapshot {
  date: string;
  accountValue: number;
  positions?: Record<string, number>;
}

/** A flow the transaction file can't value (e.g. securities transferred in), taken from a statement. */
export interface ExternalFlow {
  date: string;
  amount: number;
  label: string;
  approximate?: boolean;
}

/** A trade leg that happened before the transaction file starts, found by reconciling to a statement. */
export interface PreHistoryLeg {
  date: string;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  amount: number;
  approximate?: boolean;
}

export type TradeClass = "advisor" | "transition" | "client_directed" | "error";

/** A classification the client confirmed in the context interview. */
export interface TradeOverride {
  date: string;
  tradeClass: TradeClass;
  note: string;
}

export interface TransitionWindow {
  from: string;
  to: string;
  label: string;
}

/** Daily adjusted closes by symbol, sorted by date. */
export interface PriceSeries {
  dates: string[];
  adj: number[];
}
export type PriceTable = Record<string, PriceSeries>;

export interface BenchmarkSpec {
  /** Symbol in the price table used for trade-level comparisons (e.g. ACWI). */
  symbol: string;
  /** Published period returns by group label, overriding returns computed from prices. */
  periodReturns?: Record<string, number>;
}

export interface AdvisorRoiInput {
  transactions: Txn[];
  snapshots: Snapshot[];
  externalFlows?: ExternalFlow[];
  preHistory?: PreHistoryLeg[];
  prices: PriceTable;
  benchmark: BenchmarkSpec;
  /** Old ticker or CUSIP -> current ticker. */
  symbolMap?: Record<string, string>;
  transitionWindows?: TransitionWindow[];
  overrides?: TradeOverride[];
  /** Symbols that are cash sweeps, never trades. */
  cashSymbols?: string[];
  /** Horizons in days for trade scoring, besides "to latest price". Default 91, 182, 365. */
  horizons?: number[];
}
