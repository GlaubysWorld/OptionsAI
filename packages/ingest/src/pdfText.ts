/**
 * PDF -> lines of text, preserving reading order and column gaps well enough
 * for table parsing. Pure JS (pdfjs), so it runs anywhere Node runs.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface Item { str: string; x: number; y: number; w: number; size: number }

export async function pdfToLines(data: Uint8Array): Promise<string[][]> {
  const doc = await getDocument({ data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: string[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      const [a, b, c] = it.transform as number[];
      if (Math.abs(b!) > 0.01 || Math.abs(c!) > 0.01) continue; // rotated text (side barcodes, watermarks)
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, size: Math.abs(a!) || 8 });
    }
    // Group into rows by baseline, tolerant of small offsets.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Item[][] = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r[0]!.y - it.y) <= 2);
      if (row) row.push(it); else rows.push([it]);
    }
    rows.sort((a, b) => b[0]!.y - a[0]!.y);
    pages.push(
      rows.map((r) => {
        r.sort((a, b) => a.x - b.x);
        let line = "", end = 0;
        for (const it of r) {
          // Glyphs set one by one sit edge to edge; a gap wider than a quarter
          // of the font size is a word break, and wide gaps become columns.
          const gapPt = it.x - end;
          const spaces = line === "" ? 0 : gapPt < it.size * 0.25 ? 0 : Math.max(1, Math.round(gapPt / (it.size * 0.5)));
          line += " ".repeat(spaces) + it.str;
          end = it.x + it.w;
        }
        return line.trimEnd();
      }),
    );
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}
