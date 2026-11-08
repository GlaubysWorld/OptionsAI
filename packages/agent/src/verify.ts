/**
 * The number guard. Every dollar figure and percentage in Claude's answer must
 * trace to a number that came back from a tool (ledger read or calculation).
 * Anything else is a number Claude made up, and gets sent back for repair.
 */

export interface Figure {
  text: string;
  value: number;
  kind: "dollar" | "percent";
}

const DOLLAR = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\b/gi;
const PERCENT = /(\d+(?:\.\d+)?)\s?%/g;

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

export function extractFigures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(DOLLAR)) {
    const base = Number(m[1]!.replace(/,/g, ""));
    const scale = m[2] ? SCALE[m[2].toLowerCase()] ?? 1 : 1;
    out.push({ text: m[0].trim(), value: base * scale, kind: "dollar" });
  }
  for (const m of text.matchAll(PERCENT)) {
    out.push({ text: m[0], value: Number(m[1]) / 100, kind: "percent" });
  }
  return out;
}

/** Every finite number anywhere in a JSON value. */
export function collectNumbers(value: unknown, into: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, into));
  return into;
}

/**
 * A figure is traced if some tool number matches it after the rounding a
 * person would apply when writing it ($1.04M, 10.4%, $9.6K). Signs are ignored
 * so "$600K behind" matches a delta of -606,074.
 */
function traced(f: Figure, sources: number[]): boolean {
  const decimals = (f.text.match(/\.(\d+)/)?.[1]?.length ?? 0);
  return sources.some((raw) => {
    const s = Math.abs(raw);
    if (f.kind === "percent") {
      // Allow the displayed precision plus half a step, and a 1% relative slack.
      const step = Math.pow(10, -decimals) / 100;
      return Math.abs(s - f.value) <= Math.max(step / 2 + 1e-12, f.value * 0.01);
    }
    const scaleWord = /(k|m|b|thousand|million|billion)\s*$/i.test(f.text);
    const unit = scaleWord ? f.value / Number(f.text.replace(/[^0-9.]/g, "")) : 1;
    const step = unit * Math.pow(10, -decimals);
    return Math.abs(s - f.value) <= Math.max(step / 2, f.value * 0.015);
  });
}

/**
 * Numbers Claude passed INTO a calculation that didn't come from an earlier
 * tool result. Small whole numbers (ages, years, counts up to 120) are exempt.
 * These don't block the answer but are logged: a calculation on an invented
 * input is an invented result.
 */
export function untracedInputs(input: unknown, priorOutputs: unknown[]): number[] {
  const prior = collectNumbers(priorOutputs);
  return collectNumbers(input).filter(
    (n) =>
      !(Number.isInteger(n) && Math.abs(n) <= 120) &&
      !prior.some((p) => Math.abs(p - n) <= Math.max(1e-9, Math.abs(n) * 1e-6)),
  );
}

export function unverifiedFigures(text: string, toolOutputs: unknown[]): Figure[] {
  const sources = collectNumbers(toolOutputs);
  return extractFigures(text).filter((f) => !traced(f, sources));
}
