/**
 * Talk through an Advisor ROI check in the terminal.
 *
 *   ANTHROPIC_API_KEY=... npm run advisor-roi-chat -- ../ingest/clients/<name> [--advisor "Fisher Investments"]
 *
 * Reads the client folder (transactions, statements, prices, answers.json),
 * runs the interview, saves every confirmed answer back to answers.json, and
 * writes the transcript and audit trail to <folder>/runs/. Type "done" to end.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { loadAdvisorRoiFolder } from "../../../ingest/src/advisorRoiFolder.js";
import { Session, type MessagesClient } from "../session.js";
import { advisorRoiToolSet, newCheckState, type Answers } from "./tools.js";
import { advisorRoiPrompt } from "./prompt.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) { console.error('Usage: npm run advisor-roi-chat -- <client folder> [--advisor "Name"]'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }
const ai = args.indexOf("--advisor");
const advisorName = ai >= 0 ? args[ai + 1] : undefined;

const loaded = await loadAdvisorRoiFolder(dir);
const fileAnswers: Answers = {
  ...(loaded.input.symbolMap && Object.keys(loaded.input.symbolMap).length ? { symbolMap: loaded.input.symbolMap } : {}),
  ...(loaded.input.preHistory?.length ? { preHistory: loaded.input.preHistory } : {}),
  ...(loaded.input.overrides?.length ? { overrides: loaded.input.overrides } : {}),
  ...(loaded.input.transitionWindows?.length ? { transitionWindows: loaded.input.transitionWindows } : {}),
  benchmark: loaded.input.benchmark,
};
const state = newCheckState(loaded.input, loaded.proposed, fileAnswers);
const save = (a: Answers) => writeFileSync(join(dir, "answers.json"), JSON.stringify(a, null, 1));

const session = new Session({
  client: new Anthropic() as unknown as MessagesClient,
  system: advisorRoiPrompt({ ...(advisorName ? { advisorName } : {}) }),
  tools: advisorRoiToolSet(state, save),
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
const transcript: string[] = [];
const persist = () => {
  writeFileSync(join(runDir, `${stamp}-transcript.md`), transcript.join("\n\n"));
  writeFileSync(join(runDir, `${stamp}-audit.json`), JSON.stringify({ audit: session.audit, untraced: session.untraced, answers: state.answers }, null, 1));
};

let said = "Let's start.";
for (;;) {
  const r = await session.send(said);
  transcript.push(`**You:** ${said}`, `**Claude:** ${r.text}`);
  console.log(`\n${r.text}\n`);
  if (!r.verified) console.log(`(Warning: these figures couldn't be traced to the data: ${r.unverified.map((f) => f.text).join(", ")})\n`);
  persist();
  said = (await rl.question("> ")).trim();
  if (said.toLowerCase() === "done") break;
}
rl.close();
persist();
console.log(`\nSaved answers to ${join(dir, "answers.json")} and the transcript to ${runDir}`);
