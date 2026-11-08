import { TOOL_DEFS, executeTool } from "./tools.js";
import { unverifiedFigures, untracedInputs, type Figure } from "./verify.js";
import type { Household } from "./household.js";

/**
 * Minimal shapes of the Messages API this loop needs. The real Anthropic
 * client satisfies them; tests pass a scripted fake.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

export interface MessageResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

export interface MessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown[];
      messages: unknown[];
    }): Promise<MessageResponse>;
  };
}

export interface AuditEvent {
  at: string;
  type: "tool_call" | "tool_result" | "answer" | "verification";
  name?: string;
  data: unknown;
}

export interface UntracedInput {
  tool: string;
  values: number[];
}

export interface JourneyResult {
  answer: string;
  /** True when every figure in the answer traces to a tool result. */
  verified: boolean;
  unverified: Figure[];
  /** Calculation inputs that didn't come from the ledger or an earlier result. */
  untracedInputs: UntracedInput[];
  toolCalls: number;
  audit: AuditEvent[];
}

export interface RunOptions {
  client: MessagesClient;
  household: Household;
  system: string;
  question: string;
  model?: string;
  maxTurns?: number;
  /** Repair rounds when the answer has untraceable numbers. Default 1. */
  maxRepairs?: number;
}

export const DEFAULT_MODEL = process.env.EMUNAH_MODEL ?? "claude-opus-5-5";

const LEDGER_TOOLS = new Set(["ledger_keys", "ledger_get"]);

export async function runJourney(opts: RunOptions): Promise<JourneyResult> {
  const audit: AuditEvent[] = [];
  const toolOutputs: unknown[] = [];
  const untraced: UntracedInput[] = [];
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: opts.question },
  ];
  const maxTurns = opts.maxTurns ?? 25;
  let repairsLeft = opts.maxRepairs ?? 1;
  let toolCalls = 0;
  const log = (e: Omit<AuditEvent, "at">) => audit.push({ at: new Date().toISOString(), ...e });

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await opts.client.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 4096,
      system: opts.system,
      tools: TOOL_DEFS,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    const uses = res.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (uses.length > 0) {
      const results = uses.map((u) => {
        toolCalls++;
        log({ type: "tool_call", name: u.name, data: u.input });
        if (!LEDGER_TOOLS.has(u.name)) {
          const values = untracedInputs(u.input, toolOutputs);
          if (values.length > 0) untraced.push({ tool: u.name, values });
        }
        const output = executeTool(opts.household, u.name, u.input);
        toolOutputs.push(output);
        log({ type: "tool_result", name: u.name, data: output });
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(output) };
      });
      messages.push({ role: "user", content: results });
      continue;
    }

    const answer = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const unverified = unverifiedFigures(answer, toolOutputs);
    log({ type: "answer", data: answer });
    log({ type: "verification", data: { unverified, untracedInputs: untraced } });

    if (unverified.length > 0 && repairsLeft > 0) {
      repairsLeft--;
      messages.push({
        role: "user",
        content: `These figures in your answer don't match any tool result: ${unverified
          .map((f) => f.text)
          .join(", ")}. Get each one from a tool or remove it, then give the full answer again.`,
      });
      continue;
    }
    return {
      answer,
      verified: unverified.length === 0,
      unverified,
      untracedInputs: untraced,
      toolCalls,
      audit,
    };
  }
  throw new Error(`Journey did not finish within ${maxTurns} turns`);
}
