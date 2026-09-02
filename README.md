# LMPC Compliance Checker

**SIH 2026 · Problem Statement 26034** — Software system to check compliance of packaged commodities under the **Legal Metrology (Packaged Commodities) Rules, 2011** by scanning product images and labels.

**Live prototype:** https://lmpc-compliance-checker.ananke-862.workers.dev (access code `SIH2026`)

An inspector photographs a packaged commodity; the system reads the label, validates every declaration against the 2011 Rules, and produces a clause-cited compliance report the officer can accept, resolve item-by-item, or override.

## How it works — three layers

1. **Extract** — Gemini vision reads the label verbatim into a strict JSON schema (brand, MRP, net quantity, dates, manufacturer, consumer care…). The AI never judges compliance.
2. **Validate** — a **deterministic rules engine** ([public/js/rules.js](public/js/rules.js)) checks the extraction against the law: ~16 clause-mapped checks (Rule 6(1)(a)–(f), 6(2), 6(3), 6(7), 6(8), 6(11), Rules 11–13 SI units, Rule 9, Rule 24 wholesale, Rule 26(a) exemptions), severity-weighted verdicts. Same label → same verdict, every time.
3. **Review** — the inspector resolves needs-review items (pass/fail per clause), admins can override the verdict with a logged reason. Reports export as PDF with clause citations, evidence photos and signature blocks.

Inspections, verdicts, override logs and evidence photos live in **D1 + R2**, so the repository and dashboard are shared across devices rather than trapped in one browser.

Also on board: three-layer barcode pipeline (zxing-wasm multi-pass decode → native BarcodeDetector → Gemini OCR of printed digits, GTIN checksum + GS1 "890" prefix check, Open Food Facts cross-match with label-vs-database quantity comparison), enforcement dashboard, scan history, Inspector/Admin roles, phone camera capture.

## Stack

Cloudflare Workers (backend + static assets) · **D1** (`lmpc-db` — inspection repository) · **R2** (`lmpc-evidence` — 512px evidence photos) · Gemini API (`gemini-3.5-flash-lite`, structured outputs, multi-key rotation) · vanilla JS frontend (Microsoft Metro design language) · zxing-wasm · jsPDF.

## Develop

```bash
npm install
# put Gemini key(s) in .dev.vars:  GEMINI_API_KEY1="..."  (up to GEMINI_API_KEY3)
npx wrangler d1 migrations apply lmpc-db --local   # create the local inspection tables
npm run dev        # http://localhost:8787
```

## Deploy

First time on a fresh Cloudflare account, create the two stores and put their ids in `wrangler.jsonc`:

```bash
npx wrangler r2 bucket create lmpc-evidence
npx wrangler d1 create lmpc-db
```

Then, for every deploy:

```bash
npx wrangler d1 migrations apply lmpc-db --remote
npx wrangler deploy
npx wrangler secret put GEMINI_API_KEY1   # repeat for KEY2/KEY3
```

## Repository layout

| Path | What |
|---|---|
| [src/worker.js](src/worker.js) | Worker: `/api/scan` (Gemini extraction), `/api/inspections` + `/api/stats` (D1), `/api/images` (R2), `/api/barcode/:gtin` (Open Food Facts), static assets |
| [public/js/rules.js](public/js/rules.js) | Deterministic rules engine + verdict computation |
| [public/js/app.js](public/js/app.js) | App logic: upload, barcode pipeline, results, resolutions, history, dashboard |
| [public/js/export.js](public/js/export.js) | Clause-cited PDF report generation |
| [info.txt](info.txt) | Legal brief: the clause-by-clause requirements the engine encodes |
| [samples/](samples/) | Test label images |
| [migrations/](migrations/) | D1 schema (`inspections`, `violations`) |
| [TODO.md](TODO.md) | Roadmap (font-size calibration, editable export, real auth…) |
