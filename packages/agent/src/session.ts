import { unverifiedFigures, untracedInputs, type Figure } from "./verify.js";
import type { ToolDef } from "./tools.js";

/**
 * A multi-turn conversation with Claude over a tool set. Every assistant
 * message passes the number guard before it reaches the person: dollar
 * figures and percentages must trace to a tool result, or the message goes
 * back for repair.
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
    create(params: { model: string; max_tokens: number; system: string; tools: unknown[]; messages: unknown[] }): Promise<MessageResponse>;
  };
}

export interface ToolSet {
  defs: ToolDef[];
  execute(name: string, input: Record<string, unknown>): unknown;
  /** Tools that are sources of facts; their inputs aren't traced. */
  sourceTools?: Set<string>;
}

export interface AuditEvent {
  at: string;
  type: "user" | "tool_call" | "tool_result" | "answer" | "verification";
  name?: string;
  data: unknown;
}

export interface UntracedInput { tool: string; values: number[] }

export interface TurnResult {
  text: string;
  verified: boolean;
  unverified: Figure[];
  toolCalls: number;
}

export interface SessionOptions {
  client: MessagesClient;
  system: string;
  tools: ToolSet;
  model?: string;
  maxTurns?: number;
  maxRepairs?: number;
}

export const DEFAULT_MODEL = process.env.EMUNAH_MODEL ?? "claude-opus-5-5";

export class Session {
  readonly messages: { role: "user" | "assistant"; content: unknown }[] = [];
  readonly audit: AuditEvent[] = [];
  readonly toolOutputs: unknown[] = [];
  readonly untraced: UntracedInput[] = [];
  /** Numbers the person typed. Repair prompts are ours, so they don't count. */
  private readonly personNumbers: number[] = [];
  toolCalls = 0;

  constructor(private readonly opts: SessionOptions) {}

  private log(e: Omit<AuditEvent, "at">) {
    this.audit.push({ at: new Date().toISOString(), ...e });
  }

  async send(userText: string): Promise<TurnResult> {
    this.messages.push({ role: "user", content: userText });
    this.personNumbers.push(...extractNumbers(userText));
    this.log({ type: "user", data: userText });
    const maxTurns = this.opts.maxTurns ?? 30;
    let repairsLeft = this.opts.maxRepairs ?? 1;
    const callsAtStart = this.toolCalls;

    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await this.opts.client.messages.create({
        model: this.opts.model ?? DEFAULT_MODEL,
        max_tokens: 4096,
        system: this.opts.system,
        tools: this.opts.tools.defs,
        messages: this.messages,
      });
      this.messages.push({ role: "assistant", content: res.content });

      const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (uses.length > 0) {
        const results = uses.map((u) => {
          this.toolCalls++;
          this.log({ type: "tool_call", name: u.name, data: u.input });
          if (!this.opts.tools.sourceTools?.has(u.name)) {
            const values = untracedInputs(u.input, this.toolOutputs);
            if (values.length > 0) this.untraced.push({ tool: u.name, values });
          }
          let output: unknown;
          try { output = this.opts.tools.execute(u.name, u.input); }
          catch (err) { output = { error: err instanceof Error ? err.message : String(err) }; }
          this.toolOutputs.push(output);
          this.log({ type: "tool_result", name: u.name, data: output });
          return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(output) };
        });
        this.messages.push({ role: "user", content: results });
        continue;
      }

      const text = res.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      // The person's own words are a source too: Claude may repeat figures they gave.
      const unverified = unverifiedFigures(text, [...this.toolOutputs, this.personNumbers]);
      this.log({ type: "answer", data: text });
      this.log({ type: "verification", data: { unverified, untracedInputs: this.untraced } });

      if (unverified.length > 0 && repairsLeft > 0) {
        repairsLeft--;
        this.messages.push({
          role: "user",
          content: `These figures in your answer don't match any tool result: ${unverified.map((f) => f.text).join(", ")}. Get each one from a tool or remove it, then give the full answer again.`,
        });
        continue;
      }
      return { text, verified: unverified.length === 0, unverified, toolCalls: this.toolCalls - callsAtStart };
    }
    throw new Error(`No answer within ${maxTurns} turns`);
  }
}

/** Numbers a person typed, as figures the guard will accept back. */
function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|%)?/gi)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    const unit = m[2]?.toLowerCase();
    out.push(unit === "k" ? n * 1e3 : unit === "m" ? n * 1e6 : unit === "%" ? n / 100 : n);
  }
  return out;
}
