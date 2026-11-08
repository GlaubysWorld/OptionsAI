import type { PriceTable, Txn } from "./types.js";

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const usDate = (s: string): string => {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`Bad date: ${s}`);
  return `${m[3]}-${m[1]}-${m[2]}`;
};
const num = (s: string | undefined): number => {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  return t === "" ? 0 : Number(t);
};

/** Schwab "Transactions" export -> normalized transactions, oldest first. */
export function parseSchwabTransactions(csv: string): Txn[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Schwab CSV missing column "${name}"`);
    return i;
  };
  const c = { date: idx("Date"), action: idx("Action"), symbol: idx("Symbol"), desc: idx("Description"), qty: idx("Quantity"), price: idx("Price"), fees: idx("Fees & Comm"), amount: idx("Amount") };
  const out: Txn[] = rows.map((r) => {
    const rawDate = r[c.date] ?? "";
    const [booked, asOf] = rawDate.split(" as of ");
    const price = (r[c.price] ?? "").trim();
    return {
      date: usDate(booked!),
      ...(asOf ? { asOf: usDate(asOf) } : {}),
      action: (r[c.action] ?? "").trim(),
      symbol: (r[c.symbol] ?? "").trim(),
      description: (r[c.desc] ?? "").trim(),
      quantity: num(r[c.qty]),
      price: price === "" ? null : num(price),
      fees: num(r[c.fees]),
      amount: num(r[c.amount]),
    };
  });
  return out.reverse();
}

/** prices.csv (date,symbol,close,adjclose) -> price table. */
export function parsePriceCsv(csv: string): PriceTable {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return {};
  const di = header.indexOf("date"), si = header.indexOf("symbol"), ai = header.indexOf("adjclose");
  const tmp: Record<string, [string, number][]> = {};
  for (const r of rows) {
    const s = r[si]!, d = r[di]!, a = Number(r[ai]);
    if (!Number.isFinite(a)) continue;
    (tmp[s] ??= []).push([d, a]);
  }
  const table: PriceTable = {};
  for (const [s, pts] of Object.entries(tmp)) {
    pts.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    table[s] = { dates: pts.map((p) => p[0]), adj: pts.map((p) => p[1]) };
  }
  return table;
}
