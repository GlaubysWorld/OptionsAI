import { describe, expect, it } from "vitest";
import {
  parseSchwabStatement, proposeFixes, securitiesTransferFlows, snapshotsFromStatements,
  type AdvisorRoiInput, type Txn,
} from "../src/advisorRoi/index.js";

// Synthetic statements that mirror the two Schwab layouts.

const newLayout = [[
  "Account Number   Statement Period",
  "8890-2024      October 1-31, 2026",
  "This Statement                 YTD",
  "Beginning Account Value                        $1,050.00      $900.00",
  "Transfer of Securities                      (14.00)        (14.00)",
  "Ending Account Value                          $1,000.00      $1,000.00",
  "Cash and Cash Investments           100.00     10%",
  "Positions - Summary",
  "Symbol   Description   Quantity   Price($)   Market Value($)",
  "Positions - Equities",
  "Symbol   Description                         Quantity        Price($)    Market Value($)",
  "AAA      ALPHA CORP                          2.0000      150.00000          300.00         100.00",
  "BIG      PRICEY INC                          0.5000    1,000.0000          500.00         400.00",
  "Total Equities                                                 $800.00",
  "Positions - Exchange Traded Funds",
  "ETF      SOME FUND                           1.0000      100.00000          100.00          90.00",
  "Transactions - Summary",
  "AAA      ALPHA CORP                          9.0000      150.00000          999.00",
]];

const oldLayout = [[
  "Statement Period",
  "October 1-31, 2022",
  "Change in Account Value                 This Period          Year to Date Account Value [in Thousands]",
  "Starting Value                                   $ 1,100.00          $ 1,200.00",
  "Transfer of Securities (In/Out)                               0.00                    0.00",
  "Ending Value on 10/31/2022                       $ 1,000.00          $ 1,000.00",
  "Cash and Bank Sweep                               $ 100.00                    10%",
  "Investment Detail - Equities",
  "ALPHA CORP (M)                                      9.0000           100.00000                   900.00          90%",
  "SYMBOL: AAA                                         9.0000            80.0000                   720.00     01/01/20",
  "Realized Gain or (Loss)",
]];

describe("Schwab statement parser", () => {
  it("reads the current layout, including 4-dp prices over $1,000", () => {
    const s = parseSchwabStatement(newLayout);
    expect(s).toMatchObject({ periodEnd: "2026-10-31", accountValue: 1000, cash: 100, yearStartValue: 900, securitiesTransferred: -14 });
    expect(s.positions).toEqual({
      AAA: { quantity: 2, marketValue: 300 },
      BIG: { quantity: 0.5, marketValue: 500 },
      ETF: { quantity: 1, marketValue: 100 },
    });
    expect(s.findings).toEqual([]);
  });

  it("reads the older layout, ignoring lot rows", () => {
    const s = parseSchwabStatement(oldLayout);
    expect(s).toMatchObject({ periodEnd: "2022-10-31", accountValue: 1000, yearStartValue: 1200, securitiesTransferred: 0 });
    expect(s.positions).toEqual({ AAA: { quantity: 9, marketValue: 900 } });
    expect(s.findings).toEqual([]);
  });

  it("ignores beginning values without a YTD column", () => {
    const pages = [["October 1-31, 2023", "This Statement   Previous Statement   Change", "Beginning Value  $2.00  $1.00  $1.00", "Ending Value  $2.00  $1.00", "Cash and Cash Investments  2.00  100%"]];
    expect(parseSchwabStatement(pages).yearStartValue).toBeNull();
  });

  it("blocks when positions plus cash don't add up to the account value", () => {
    const missingRow = [newLayout[0]!.filter((l) => !l.startsWith("BIG"))];
    const s = parseSchwabStatement(missingRow);
    expect(s.findings[0]).toMatchObject({ code: "RECONCILIATION_MISMATCH", severity: "block" });
  });

  it("adds value-only year-start snapshots", () => {
    const snaps = snapshotsFromStatements([parseSchwabStatement(newLayout)]);
    expect(snaps.map((s) => [s.date, s.accountValue, !!s.positions])).toEqual([["2025-12-31", 900, false], ["2026-10-31", 1000, true]]);
  });
});

const tx = (date: string, action: string, symbol: string, quantity: number, amount = 0): Txn =>
  ({ date, action, symbol, description: "", quantity, price: null, fees: 0, amount });
const prices = { AAA: { dates: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"], adj: [9, 9, 9, 9, 9], close: [10, 10, 10, 10, 10] } };

describe("transfer valuation", () => {
  it("dates statement transfers from the transactions and values the rest at the close", () => {
    const st = { ...parseSchwabStatement(newLayout), periodEnd: "2026-01-31", securitiesTransferred: 500 };
    const { flows } = securitiesTransferFlows(
      [tx("2026-01-14", "Security Transfer", "BIG", 1), tx("2026-02-03", "Security Transfer", "AAA", -3)], [st], prices,
    );
    expect(flows).toEqual([
      { date: "2026-01-14", amount: 500, label: "Securities transferred in (2026-01 statement)" },
      { date: "2026-02-03", amount: -30, label: "3 AAA shares transferred out, valued at that day's close", approximate: true },
    ]);
  });
});

describe("proposed fixes", () => {
  const base: AdvisorRoiInput = {
    transactions: [tx("2026-01-03", "Mandatory Reorg Exc", "123456789", -5), tx("2026-01-03", "Mandatory Reorg Exc", "AAA", 5)],
    snapshots: [
      { date: "2026-01-01", accountValue: 0, positions: { OLD: 5, GONE: 2 } },
      { date: "2026-01-02", accountValue: 0, positions: { NEW: 5, KEPT: 1 } },
      { date: "2026-01-05", accountValue: 0, positions: { NEW: 5, AAA: 5, KEPT: 1 } },
    ],
    prices,
    benchmark: { symbol: "AAA" },
  };
  it("finds a renamed ticker and trades made before the export starts", () => {
    const p = proposeFixes({ ...base, transactions: [] });
    expect(p.renames).toEqual({ OLD: "NEW" });
    expect(p.preHistory.map((l) => [l.side, l.symbol, l.quantity])).toEqual([["buy", "KEPT", 1], ["sell", "GONE", 2]]);
  });
  it("maps a CUSIP used for a reorg to the ticker on the statement", () => {
    const p = proposeFixes({
      ...base,
      transactions: [tx("2026-01-03", "Mandatory Reorg Exc", "123456789", -5)],
      snapshots: [
        { date: "2026-01-01", accountValue: 0, positions: { AAA: 5 } },
        { date: "2026-01-05", accountValue: 0, positions: { AAA: 5 } },
      ],
    });
    expect(p.renames).toEqual({});
    const q = proposeFixes({
      ...base,
      transactions: [tx("2026-01-03", "Mandatory Reorg Exc", "123456789", -5), tx("2026-01-03", "Mandatory Reorg Exc", "AAA", 5)],
      snapshots: [
        { date: "2026-01-01", accountValue: 0, positions: { AAA: 5 } },
        { date: "2026-01-05", accountValue: 0, positions: { AAA: 5 } },
      ],
    });
    expect(q.renames).toEqual({ "123456789": "AAA" });
  });
});
