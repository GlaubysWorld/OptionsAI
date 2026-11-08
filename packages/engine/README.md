# @emunah/engine

Deterministic household finance math. Claude orchestrates and explains; this package calculates. No number shown to a user should come from anywhere else.

## Rules
- Pure functions, no I/O, no network.
- Every calculation returns `findings`. A `block` finding means the result must not be shown as fact.
- Tax rates always carry a kind (`marginal` or `effective`).
- Scenario comparisons must start from the same pre-decision net worth.
- Real household data lives only in `fixtures/*.local.json`, which is gitignored. Never commit it.

## Run
```
npm install
npm test
npm run typecheck
```

## Calling it
`runCalc(name, input)` is the single entry point and the surface Claude will call as tools. See `src/registry.ts` for the list.

## Golden tests
`test/golden.test.ts` runs every JSON file in `fixtures/`. A case either reproduces a reported result, proves a discrepancy in the source (`exportDiscrepancy`), or asserts the engine raises a finding on its own (`expectFinding`). `household.example.json` shows the format with synthetic numbers.

## Detection checks
| Code | Catches |
| --- | --- |
| A1 `ASYMMETRIC_SCENARIOS` | Comparing scenarios that don't start from the same net worth |
| A2 `HOLD_PERIOD_MISMATCH` | Model hold period that no longer matches the plan's exit date |
| A3 `CONFLICTING_VALUES` | Same fact with different values across sources |
| A4 `RATE_FORMULA_MISMATCH` | A stated rate that doesn't match index + spread |
| A5 `WRONG_TAX_RATE_KIND` | Effective rate used where marginal applies, or the reverse |

## Config to verify yearly
- `PLAN_LIMITS_2026` in `src/retirementAccounts.ts`
- Mortgage interest deduction debt cap (default $750K) in `src/rates.ts`

## Advisor ROI check
Did the advisor's decisions earn the fee? `src/advisorRoi/`, run with `runAdvisorRoi(input)` or `runCalc("advisorRoi", input)`.

1. **Reconcile.** Rebuild share counts from the first statement plus every transaction and check them against each later statement. Any mismatch blocks the trade scores.
2. **Account returns.** Modified Dietz between statement values, net and gross of fees, grouped by calendar year, against a benchmark (published period returns or the benchmark ETF's prices). Withdrawals never count against the advisor. Includes the dollar gap, not just percentages.
3. **Trade decisions.** For every trade day: the matched part of buys and sells is a switch (bought vs sold), net buying is new cash (vs the benchmark), net selling raised cash (the client's call, not scored). Measured to the latest price and at 91, 182 and 365 days.
4. **Fairness.** Cancelled trades are excluded as errors. Transition windows (holdings inherited from a prior manager) are scored separately. Client-confirmed trades (`overrides`) are excluded.
5. **Verdict.** Fees paid, dollars vs benchmark before and after fees, decision value, and decision value per fee dollar.

Inputs: Schwab transactions CSV (`parseSchwabTransactions`), a prices CSV (`parsePriceCsv`), statement snapshots, and flows the CSV can't value (securities transfers).

Run on a folder: `npm run advisor-roi -- fixtures/<name>.local`. Real accounts go in `fixtures/*.local/`, which is gitignored; `test/advisorRoi.golden.test.ts` replays every such folder against its expected results.
