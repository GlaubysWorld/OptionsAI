/**
 * Run a journey against a household file.
 *
 *   ANTHROPIC_API_KEY=... npm run journey -- households/house.local.json
 *   ANTHROPIC_API_KEY=... npm run journey -- households/house.local.json --plaid-user <uuid>
 *
 * --plaid-user pulls synced holdings from Supabase (needs SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY) and adds them to the ledger as connected values.
 * Writes the memo and full audit trail to runs/ (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { fromFile, loadHousehold, type Household } from "./household.js";
import { holdingsToLedger } from "./plaidLedger.js";
import { houseJourneyPrompt } from "./prompts.js";
import { runJourney, DEFAULT_MODEL, type MessagesClient } from "./agent.js";

async function withPlaid(h: Household, userId: string): Promise<Household> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("--plaid-user needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const [{ data: accounts, error: e1 }, { data: holdings, error: e2 }] = await Promise.all([
    db.from("accounts").select("id,institution_name,account_name,account_type,synced_at,is_active").eq("user_id", userId),
    db.from("holdings").select("account_id,current_value,cost_basis,last_price_at").eq("user_id", userId),
  ]);
  if (e1 || e2) throw new Error(`Supabase read failed: ${(e1 ?? e2)!.message}`);
  const connected = holdingsToLedger(accounts ?? [], holdings ?? [], h.file.asOf);
  return fromFile({ ...h.file, ledger: [...h.file.ledger, ...connected] });
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) throw new Error("Usage: npm run journey -- <household.json> [--plaid-user <uuid>]");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY");

  let household = loadHousehold(path);
  const plaidIdx = args.indexOf("--plaid-user");
  const plaidUser = plaidIdx >= 0 ? args[plaidIdx + 1] : undefined;
  if (plaidUser) household = await withPlaid(household, plaidUser);

  const question =
    "Walk us through this decision. Can we afford it, how should we pay for it, and what does it do to our retirement?";
  const result = await runJourney({
    client: new Anthropic() as unknown as MessagesClient,
    household,
    system: houseJourneyPrompt(household),
    question,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("runs", { recursive: true });
  const memoPath = join("runs", `${stamp}-memo.md`);
  const auditPath = join("runs", `${stamp}-audit.json`);
  writeFileSync(memoPath, result.answer + "\n");
  writeFileSync(auditPath, JSON.stringify({ model: DEFAULT_MODEL, household: household.file.household, ...result }, null, 2));

  console.log(result.answer);
  console.log("\n---");
  console.log(`Tool calls: ${result.toolCalls}`);
  console.log(result.verified ? "Every figure traced to a tool result." : `UNVERIFIED figures: ${result.unverified.map((f) => f.text).join(", ")}`);
  if (result.untracedInputs.length) {
    console.log(`Calc inputs not from the ledger: ${JSON.stringify(result.untracedInputs)}`);
  }
  console.log(`Memo: ${memoPath}\nAudit: ${auditPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
