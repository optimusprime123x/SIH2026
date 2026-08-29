# LMPC Compliance Checker — TODO

## Blocked on D1/R2 storage (do these after the database lands)

- [ ] **D1 database** — move scan repository out of localStorage: tables for users, products, inspections (extraction JSON, results, verdict, override log), violations. Multi-device history + real role-based auth (worker-issued session token instead of the shared `SIH2026` password and self-asserted admin role).
- [ ] **R2 evidence storage** — upload the full-resolution photos per inspection (localStorage only holds 320px thumbs today); reports should link the originals.
- [ ] **History search + filter** — PS requires "search and retrieval facility": search box (brand / report ID / barcode) + verdict filter chips over the repository. Trivial over localStorage but better done once against D1 queries.
- [ ] **Editable export** — PS requires "PDF **and editable formats**": CSV export of all scans + per-report .doc (styled HTML saved as `.doc` opens in Word) or real docx.

## Features (independent of storage)

- [ ] **Declaration overlay map** — ask Gemini for `box_2d` per declaration (docs.md object-detection section), draw labeled boxes over the photo in the results panel. Wow-factor + stepping stone to font-size measurement.
- [ ] **Font-size calibration (the special feature)** — ₹10 coin (27 mm) / standard card in frame → px-per-mm scale → measure declaration letter heights against the Rule 7(2) table (needs the bounding boxes above).
- [x] **Better barcode detection** — DONE: vendored zxing-wasm (multi-pass: full 1x → 2x → tiled 4x crops), native BarcodeDetector as fallback, plus Gemini OCR of the printed digits (checksum-validated) as a third layer.
- [x] **Barcode → product details matching** — DONE: worker `/api/barcode/:gtin` queries Open Food Facts (edge-cached 24h); results card shows DB match + quantity cross-check vs label; invalid/absent/unmatched GTIN → review chip. FUTURE: fallback sources for non-food (BarcodeNest / EcomSource free tiers), GS1 India DataKart for authoritative 890-prefix data.
- [ ] **E-commerce listing mode** — Rule 6(10): paste a product-listing URL, check the listing's declared MRP/net qty/manufacturer/country-of-origin. Amazon/Flipkart bot-block a Worker fetch; likely needs the inspector to paste the listing text/screenshot instead of scraping.
- [ ] **Retry cap server-side** — the 1-retry limit is client-state only; enforce per-session on the worker once real auth exists.

## Polish backlog (from the review pass, deliberately skipped for v1)

- [ ] Replace native `confirm()`/`alert()` dialogs with Metro-styled modals.
- [ ] Register Noto Sans Devanagari in jsPDF (addFileToVFS) so Hindi text renders in PDFs instead of the `[Devanagari text — see evidence photos]` marker.
- [ ] PWA manifest + offline shell so inspectors can install it on phones.
