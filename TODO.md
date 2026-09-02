# LMPC Compliance Checker — TODO

## Storage

- [x] **D1 database** — DONE: `lmpc-db` holds `inspections` + `violations`; worker exposes `/api/inspections` (list/save/read/update/delete) and `/api/stats` (SQL-aggregated dashboard). Scans saved on one device appear on every device. Legacy localStorage records are imported automatically on first login.
- [x] **R2 evidence storage** — DONE: `lmpc-evidence` stores each photo at 512px as `inspections/{id}/{n}.jpg`, served through `/api/images/...`; deleting an inspection removes its objects. (512px is deliberate — full-resolution phone photos would blow through the free tier, and 512px is what the overlay and PDFs need.)
- [x] **History search** — DONE: debounced search box over brand / product / report ID / barcode, matched in SQL.
- [ ] **Verdict filter chips** on history (search is done; filtering by verdict is not).
- [ ] **Real role-based auth** — worker-issued session token per user instead of the shared `SIH2026` password and the self-asserted admin role. D1 `users` table.
- [ ] **Editable export** — PS requires "PDF **and editable formats**": CSV export of all scans + per-report .doc (styled HTML saved as `.doc` opens in Word) or real docx.

## Features (independent of storage)

- [x] **Declaration overlay map** — DONE (PR #1 + cleanup commit): Gemini returns `box_2d` + `image_index` per declaration; SVG evidence overlay with photo tabs, violation filter, locate buttons and hover tooltips in both the live pane and history detail. Stepping stone to font-size measurement.
- [x] **Letter-height check (Rule 7(2)–(3))** — DONE, without any calibration object: Gemini returns an (unrendered) tight box around the net-quantity / MRP / date digits plus a box around the package face; `glyph-height ÷ √(panel-area)` is scale-free and Table-I pins the required ratio to ~0.8–2.5%, so the photo alone gives a pass/fail band; entering the panel's W×H (or height × circumference for cans) on the card makes it exact in mm. Lenient by design: 15% allowance, borderline = likely compliant, no conviction from angled photos. FUTURE: extend glyph boxes to best-before and consumer-care text (Rule 7(5) makes those mandatory-size too).
- [x] **Better barcode detection** — DONE: vendored zxing-wasm (multi-pass: full 1x → 2x → tiled 4x crops), native BarcodeDetector as fallback, plus Gemini OCR of the printed digits (checksum-validated) as a third layer.
- [x] **Barcode → product details matching** — DONE: worker `/api/barcode/:gtin` queries Open Food Facts (edge-cached 24h); results card shows DB match + quantity cross-check vs label; invalid/absent/unmatched GTIN → review chip. FUTURE: fallback sources for non-food (BarcodeNest / EcomSource free tiers), GS1 India DataKart for authoritative 890-prefix data.
- [ ] **E-commerce listing mode** — Rule 6(10): paste a product-listing URL, check the listing's declared MRP/net qty/manufacturer/country-of-origin. Amazon/Flipkart bot-block a Worker fetch; likely needs the inspector to paste the listing text/screenshot instead of scraping.

## Polish backlog (from the review pass, deliberately skipped for v1)

- [x] Replace native `confirm()`/`alert()` dialogs with Metro-styled modals — DONE (`askConfirm` / `showNotice` in app.js).
- [ ] Register Noto Sans Devanagari in jsPDF (addFileToVFS) so Hindi text renders in PDFs instead of the `[Devanagari text — see evidence photos]` marker.
- [ ] PWA manifest + offline shell so inspectors can install it on phones.
