# @emunah/ingest

Turns the files a client can download into engine inputs.

- `pdfToLines(pdf)`: PDF to text lines (pdfjs, pure JS), keeping column gaps for table parsing and dropping rotated side text.
- `loadAdvisorRoiFolder(dir)`: a client folder to a ready Advisor ROI check:
  - `transactions.csv` (Schwab Transactions export)
  - `statements/*.pdf` (Schwab statements: the month before the export starts, each year-end, the latest)
  - `prices.csv` (date,symbol,close,adjclose)
  - `answers.json` (optional: what the client confirmed)

Statements are read deterministically and each one checks itself (positions plus cash must equal the account value). Fixes the data suggests (renamed tickers, CUSIPs used in reorgs, trades before the export starts) are proposed, never applied silently, unless `--accept-proposed` is passed.

```
npm run advisor-roi -- clients/<name> [--accept-proposed]
```

`clients/` is gitignored. Any `clients/<name>/expected.json` turns that folder into an end-to-end test.
