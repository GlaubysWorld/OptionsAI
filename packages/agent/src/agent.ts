import { TOOL_DEFS, executeTool } from "./tools.js";
import { Session, type AuditEvent, type MessagesClient, type UntracedInput } from "./session.js";
import type { Figure } from "./verify.js";
import type { Household } from "./household.js";

export { DEFAULT_MODEL } from "./session.js";
export type { ContentBlock, MessageResponse, MessagesClient, AuditEvent, UntracedInput } from "./session.js";

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

/** One-shot journey over the household tools. */
export async function runJourney(opts: RunOptions): Promise<JourneyResult> {
  const session = new Session({
    client: opts.client,
    system: opts.system,
    tools: { defs: TOOL_DEFS, execute: (n, i) => executeTool(opts.household, n, i), sourceTools: new Set(["ledger_keys", "ledger_get"]) },
    ...(opts.model ? { model: opts.model } : {}),
    maxTurns: opts.maxTurns ?? 25,
    ...(opts.maxRepairs !== undefined ? { maxRepairs: opts.maxRepairs } : {}),
  });
  const r = await session.send(opts.question);
  return {
    answer: r.text,
    verified: r.verified,
    unverified: r.unverified,
    untracedInputs: session.untraced,
    toolCalls: session.toolCalls,
    audit: session.audit.filter((a) => a.type !== "user"),
  };
}
