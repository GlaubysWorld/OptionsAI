import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runJourney, type MessageResponse, type MessagesClient } from "../src/agent.js";
import { executeTool, TOOL_DEFS } from "../src/tools.js";
import { fromFile, loadHousehold, ledgerIndex } from "../src/household.js";
import { houseJourneyPrompt } from "../src/prompts.js";
import { extractFigures, unverifiedFigures, untracedInputs } from "../src/verify.js";
import { holdingsToLedger } from "../src/plaidLedger.js";

const example = loadHousehold(join(import.meta.dirname, "..", "households", "house.example.json"));

/** A scripted stand-in for the Messages API. */
function scripted(responses: MessageResponse[]) {
  const calls: { messages: unknown[] }[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push({ messages: structuredClone(params.messages) });
        const next = responses.shift();
        if (!next) throw new Error("script ran out");
        return next;
      },
    },
  };
  return { client, calls };
}

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const text = (t: string): MessageResponse => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const uses = (...blocks: ReturnType<typeof tool>[]): MessageResponse => ({ content: blocks, stop_reason: "tool_use" });

describe("tool definitions", () => {
  it("every tool has a unique name and an object schema", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_DEFS) expect(t.input_schema.type).toBe("object");
  });

  it("every non-ledger tool runs against the engine", () => {
    const sample: Record<string, Record<string, unknown>> = {
      add_up: { terms: [{ label: "a", value: 5, sign: "+" }, { label: "b", value: 2, sign: "-" }] },
      cash_flow_gap: { annualSpend: 10, netTakeHome: 4 },
      retirement_target: { netSpend: 75, grossSpend: 100, drawRate: 0.04 },
      compare_scenarios: { a: { name: "a", preDecisionNetWorth: 1 }, b: { name: "b", preDecisionNetWorth: 1 }, years: 1, portfolioReturn: 0 },
      hold_period_check: { assumedHoldYears: 10, ageAtPurchase: 40, plannedExitAge: 50 },
      monthly_carry: { debt: 1200, rate: 0.1, annualPropertyTax: 120, monthlyInsurance: 1 },
      check_rate_formula: { statedRate: 0.05, index: 0.03, spread: 0.02 },
      compare_borrowing: { floating: { index: 0.03, spread: 0.01 }, mortgage: { rate: 0.06, balance: 1e6, marginalTax: { rate: 0.3, kind: "marginal" } } },
      keep_invested_hurdle: { annualCarry: 1, equity: 10 },
      comp_check: { price: 100, aboveGradeSqft: 1, comps: [90, 110] },
      project: { startBalance: 100, startAge: 50, endAge: 52, nominalReturn: 0, inflation: 0, firstYearDraw: 1 },
      sensitivity: { base: { startBalance: 100, startAge: 50, endAge: 52, nominalReturn: 0.05, inflation: 0.02, firstYearDraw: 1 } },
      cost_of_a_dollar: { amount: 1, recurring: "once", years: 1, nominalReturn: 0, inflation: 0 },
    };
    for (const t of TOOL_DEFS.filter((d) => !d.name.startsWith("ledger_"))) {
      const out = executeTool(example, t.name, sample[t.name]!) as Record<string, unknown>;
      expect(out.error, t.name).toBeUndefined();
      expect(Array.isArray(out.findings), t.name).toBe(true);
    }
    expect((executeTool(example, "add_up", sample.add_up!) as { total: number }).total).toBe(3);
  });

  it("projection output drops the per-year rows", () => {
    const out = executeTool(example, "project", { startBalance: 100, startAge: 50, endAge: 60, nominalReturn: 0, inflation: 0, firstYearDraw: 1 }) as Record<string, unknown>;
    expect(out.rows).toBeUndefined();
    expect(out.endBalance).toBe(90);
  });
});

describe("household", () => {
  it("indexes keys without exposing values", () => {
    const idx = ledgerIndex(example);
    expect(idx.find((k) => k.key === "home.target.price")).toEqual({ key: "home.target.price", label: "Target home price", sources: 1 });
    expect(JSON.stringify(idx)).not.toContain("1400000");
  });
  it("rejects numbers in the context", () => {
    expect(() => fromFile({ ...example.file, context: { ...example.file.context, goals: ["Retire with $5M"] } })).toThrow(/words only/);
  });
  it("resolves ledger values as of the journey date", () => {
    const r = executeTool(example, "ledger_get", { key: "spend.annual" }) as { value: number; findings: unknown[] };
    expect(r.value).toBe(240000);
    expect(r.findings).toHaveLength(0);
  });
  it("prompt carries words, not ledger numbers", () => {
    const p = houseJourneyPrompt(example);
    expect(p).toContain("Retire early");
    expect(p).not.toContain("1400000");
    expect(p).not.toContain("240000");
  });
});

describe("number guard", () => {
  it("extracts dollars and percents in the forms people write", () => {
    const f = extractFigures("About $1.04M, or $480K, at 4.8% and $9,600 a month.");
    expect(f.map((x) => x.value)).toEqual([1_040_000, 480_000, 9_600, 0.048]);
  });
  it("accepts rounded figures that trace to a tool number", () => {
    const outputs = [{ delta: -606_074.2 }, { rate: 0.048 }, { total: 9_553.33 }];
    expect(unverifiedFigures("Buying leaves you about $606K behind, the PAL is 4.8%, carry is $9,553 a month.", outputs)).toEqual([]);
    expect(unverifiedFigures("Roughly $0.6M behind.", outputs)).toEqual([]);
  });
  it("flags figures that don't trace", () => {
    const bad = unverifiedFigures("You'd save $250K and earn 9%.", [{ x: 100 }]);
    expect(bad.map((b) => b.text)).toEqual(["$250K", "9%"]);
  });
  it("flags calc inputs that weren't fetched first, exempting ages and years", () => {
    expect(untracedInputs({ years: 10, value: 2_375_000, rate: 0.02 }, [{ value: 2_375_000 }])).toEqual([0.02]);
  });
});

describe("journey loop", () => {
  it("runs tools, feeds results back, and verifies the answer", async () => {
    const { client, calls } = scripted([
      uses(tool("t1", "ledger_get", { key: "home.target.price" })),
      text("The house is $1.4M."),
    ]);
    const r = await runJourney({ client, household: example, system: "s", question: "q" });
    expect(r.verified).toBe(true);
    expect(r.toolCalls).toBe(1);
    const second = calls[1]!.messages as { role: string; content: unknown }[];
    const last = second[second.length - 1]!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("tool_result");
    expect(r.audit.map((a) => a.type)).toEqual(["tool_call", "tool_result", "answer", "verification"]);
  });

  it("sends an answer with made-up numbers back for one repair", async () => {
    const { client, calls } = scripted([
      uses(tool("t1", "ledger_get", { key: "home.target.price" })),
      text("The house is $1.4M and you'll make $300K on it."),
      text("The house is $1.4M."),
    ]);
    const r = await runJourney({ client, household: example, system: "s", question: "q" });
    expect(r.verified).toBe(true);
    const repairMsg = (calls[2]!.messages as { content: unknown }[]).at(-1)!.content as string;
    expect(repairMsg).toContain("$300K");
  });

  it("reports unverified figures if the repair doesn't fix them", async () => {
    const { client } = scripted([text("You'll make $300K."), text("Still $300K.")]);
    const r = await runJourney({ client, household: example, system: "s", question: "q" });
    expect(r.verified).toBe(false);
    expect(r.unverified[0]?.text).toBe("$300K");
  });

  it("passes the asymmetry block through to Claude", async () => {
    const { client, calls } = scripted([
      uses(
        tool("t1", "compare_scenarios", {
          a: { name: "buy", preDecisionNetWorth: 550000, home: { value: 1400000, appreciation: 0.02, saleCostRate: 0.06, debtAtExit: 900000 }, extraAnnualDraw: 25000 },
          b: { name: "stay", preDecisionNetWorth: 0 },
          years: 10,
          portfolioReturn: 0.07,
        }),
      ),
      text("I can't compare these yet: the stay option is missing your current home's equity."),
    ]);
    const r = await runJourney({ client, household: example, system: "s", question: "q" });
    const fed = JSON.stringify((calls[1]!.messages as { content: unknown }[]).at(-1)!.content);
    expect(fed).toContain("ASYMMETRIC_SCENARIOS");
    expect(fed).toContain('\\"delta\\":null');
    expect(r.untracedInputs[0]?.tool).toBe("compare_scenarios");
  });

  it("stops after the turn limit", async () => {
    const loop = Array.from({ length: 5 }, (_, i) => uses(tool(`t${i}`, "ledger_keys", {})));
    const { client } = scripted(loop);
    await expect(runJourney({ client, household: example, system: "s", question: "q", maxTurns: 3 })).rejects.toThrow(/turns/);
  });
});

describe("plaid to ledger", () => {
  it("turns synced holdings into connected entries with a total", () => {
    const entries = holdingsToLedger(
      [
        { id: "a1", institution_name: "Fidelity", account_name: "401(k)", account_type: "investment", synced_at: "2026-10-19T12:00:00Z" },
        { id: "a2", institution_name: "Schwab", account_name: "Brokerage", account_type: "investment", synced_at: "2026-10-18T12:00:00Z" },
        { id: "a3", institution_name: "Old", account_name: "Closed", account_type: "investment", synced_at: null, is_active: false },
      ],
      [
        { account_id: "a1", current_value: 100, cost_basis: 60, last_price_at: null },
        { account_id: "a1", current_value: 50, cost_basis: 40, last_price_at: null },
        { account_id: "a2", current_value: 200, cost_basis: null, last_price_at: null },
        { account_id: "a3", current_value: 999, cost_basis: 1, last_price_at: null },
      ],
      "2026-10-20",
    );
    const get = (k: string) => entries.find((e) => e.key === k);
    expect(get("account.fidelity.401_k.value")?.value).toBe(150);
    expect(get("account.fidelity.401_k.cost_basis")?.value).toBe(100);
    expect(get("account.schwab.brokerage.cost_basis")).toBeUndefined();
    expect(get("portfolio.connected_total")).toMatchObject({ value: 350, asOf: "2026-10-19", sourceType: "connected" });
    expect(entries.some((e) => e.sourceRef.includes("a3"))).toBe(false);
  });
});
