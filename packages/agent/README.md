# @emunah/agent

Claude runs a decision journey by calling the engine. Claude explains; the engine calculates.

## How it stays honest
- **Numbers live in the ledger.** A household file has words in `context` and every figure in `ledger` with source and date. Context with numbers is rejected.
- **Claude has to fetch.** The only way to get a household number is `ledger_get`. The only way to compute is a tool, including `add_up` for simple sums.
- **Findings pass straight through.** Conflicts, stale values, asymmetric comparisons and wrong tax-rate kinds come back with the result and the prompt makes Claude say them in plain words.
- **Number guard.** Every `$` figure and `%` in the final answer must trace to a tool result. If not, the answer goes back once for repair; if it still fails, the run is marked unverified.
- **Input tracing.** Calculation inputs that didn't come from the ledger or an earlier result are logged.
- **Audit trail.** Every tool call, result, answer and verification is recorded for the run.

## Run the house journey
```
export ANTHROPIC_API_KEY=...
npm install
npm run journey -- households/house.local.json
```
Add `--plaid-user <uuid>` to pull synced holdings from Supabase into the ledger as connected values (needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`).

Output goes to `runs/` (memo and audit JSON). `runs/` and `households/*.local.json` are gitignored.

Model defaults to `claude-opus-5-5`; override with `EMUNAH_MODEL`.

## Tests
`npm test` runs the loop against a scripted fake client, so no API key is needed. `test/backtest.test.ts` replays the real house decision through the tools when `households/house.local.json` is present.
