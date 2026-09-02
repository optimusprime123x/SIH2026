/**
 * LMPC Compliance Checker — main frontend logic.
 * Login → image upload (≤5) + barcode detection → Gemini extraction (via worker)
 * → deterministic rules engine → inspector review (accept / override / export).
 * Persistence: localStorage (prototype); D1/R2 planned.
 */
(function () {
  "use strict";

  const PASSWORD = "SIH2026";
  const MAX_IMAGES = 5;
  const MAX_ATTEMPTS = 2; // first scan + one retry
  const LS_SCANS = "lmpc_scans";
  const LS_THEME = "lmpc_theme";
  const SS_SESSION = "lmpc_session";

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  // Storage can throw (blocked cookies, private mode) — never let that kill the app.
  const safeGet = (store, key) => { try { return window[store].getItem(key); } catch { return null; } };
  const safeSet = (store, key, val) => { try { window[store].setItem(key, val); return true; } catch { return false; } };
  const safeRemove = (store, key) => { try { window[store].removeItem(key); } catch {} };

  const state = {
    role: null,
    images: [],      // { apiData(base64), thumb(dataURL), barcodes: [{format,value}] }
    attempts: 0,
    scanning: false,
    current: null,   // active scan record
    detailId: null,  // record open in history detail modal
    detailRecord: null, // that record, fetched from the repository
  };

  // ============================== theme ==============================

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    safeSet("localStorage", LS_THEME, theme);
  }
  applyTheme(safeGet("localStorage", LS_THEME) || "dark");
  $("#theme-toggle").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
  );

  // ============================== auth ==============================

  let loginRole = "inspector";
  $("#role-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    loginRole = btn.dataset.role;
    $("#role-seg").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("#login-pass").value !== PASSWORD) {
      $("#login-error").hidden = false;
      $("#login-pass").select();
      return;
    }
    safeSet("sessionStorage", SS_SESSION, JSON.stringify({ role: loginRole }));
    enterApp(loginRole);
  });

  $("#logout-btn").addEventListener("click", () => {
    safeRemove("sessionStorage", SS_SESSION);
    location.reload();
  });

  function enterApp(role) {
    state.role = role;
    $("#view-login").hidden = true;
    $("#app-shell").hidden = false;
    $("#role-chip").textContent = role.toUpperCase();
    migrateLocalScans().finally(renderHistory);
  }

  const existing = safeGet("sessionStorage", SS_SESSION);
  if (existing) {
    try { enterApp(JSON.parse(existing).role || "inspector"); } catch { safeRemove("sessionStorage", SS_SESSION); }
  }

  // ============================== nav ==============================

  $("#main-nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".pivot-item");
    if (!btn) return;
    $("#main-nav").querySelectorAll(".pivot-item").forEach((b) => b.classList.toggle("active", b === btn));
    $("#view-scan").hidden = btn.dataset.view !== "scan";
    $("#view-history").hidden = btn.dataset.view !== "history";
    $("#view-dashboard").hidden = btn.dataset.view !== "dashboard";
    if (btn.dataset.view === "history") renderHistory();
    if (btn.dataset.view === "dashboard") renderDashboard();
  });

  // ============================== upload ==============================

  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  fileInput.addEventListener("change", () => { addFiles([...fileInput.files]); fileInput.value = ""; });

  // Direct camera capture on phones (falls back to a file picker on desktop).
  const cameraInput = $("#camera-input");
  $("#camera-btn").addEventListener("click", () => cameraInput.click());
  cameraInput.addEventListener("change", () => { addFiles([...cameraInput.files]); cameraInput.value = ""; });

  ["dragover", "dragenter"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
  );
  dropzone.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));

  // A drop that misses the dropzone must not navigate away and destroy the session.
  ["dragover", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => e.preventDefault())
  );

  async function addFiles(files) {
    const skipped = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) { skipped.push(`${file.name} (not an image)`); continue; }
      if (state.images.length >= MAX_IMAGES) { skipped.push(`${file.name} (over the ${MAX_IMAGES}-image limit)`); continue; }
      try {
        const processed = await processImage(file);
        state.images.push(processed);
      } catch (err) {
        skipped.push(`${file.name} (could not be read — HEIC? use JPEG/PNG)`);
      }
    }
    const warn = $("#upload-warn");
    warn.hidden = !skipped.length;
    warn.textContent = skipped.length ? `Skipped: ${skipped.join(", ")}` : "";
    renderThumbs();
    updateScanButton();
  }

  /** Single decode: one 1600px canvas feeds the API image and one 512px copy
   *  that serves as thumbnail, evidence overlay and the R2-stored photo
   *  (canvas drawImage applies EXIF orientation). Barcode decoding is deferred
   *  to scan time — it is heavy and would jank the upload UI. */
  function processImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const big = drawScaled(img, 1600);
        const thumb = drawScaled(big, 512).toDataURL("image/jpeg", 0.8);
        URL.revokeObjectURL(url);
        // width/height let the rules engine turn Gemini's 0–1000 boxes back into pixels
        resolve({ apiData: big.toDataURL("image/jpeg", 0.87).split(",")[1], thumb, width: big.width, height: big.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    });
  }

  function drawScaled(source, maxEdge) {
    const w = source.naturalWidth ?? source.width;
    const h = source.naturalHeight ?? source.height;
    const ratio = Math.min(1, maxEdge / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // ---- barcode detection: zxing-wasm (all browsers), native API as fallback ----
  let zxingReady = null;
  function getZXing() {
    if (!zxingReady) {
      zxingReady = (async () => {
        if (!window.ZXingWASM) throw new Error("zxing not loaded");
        // Serve the wasm from our own vendor dir instead of the default CDN.
        window.ZXingWASM.prepareZXingModule({
          overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? "/vendor/zxing_reader.wasm" : prefix + path) },
        });
        // Warm up so the first scan isn't slow.
        await window.ZXingWASM.readBarcodes(new ImageData(2, 2), {});
        return window.ZXingWASM;
      })().catch((err) => {
        console.warn("zxing-wasm unavailable, falling back to BarcodeDetector:", err.message);
        if (!nativeDetector) $("#barcode-support-note").hidden = false;
        return null;
      });
    }
    return zxingReady;
  }

  let nativeDetector = null;
  if ("BarcodeDetector" in window) {
    try { nativeDetector = new window.BarcodeDetector(); } catch { nativeDetector = null; }
  }

  const PRODUCT_FORMATS = ["EAN-13", "EAN-8", "UPC-A", "UPC-E"];
  // zxing requests formats as "EAN-13" but reports them as "EAN13"; the native
  // BarcodeDetector uses "ean_13". Normalise before comparing.
  const isProductFormat = (f) => ["EAN13", "EAN8", "UPCA", "UPCE"].includes(String(f).replace(/[^a-z0-9]/gi, "").toUpperCase());

  async function zxingDecodePass(zx, source, sx, sy, sw, sh, scale, formats) {
    // Bound the working canvas so tile upscaling can't exhaust memory.
    const effScale = Math.min(scale, 2600 / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * effScale);
    c.height = Math.round(sh * effScale);
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const results = await zx.readBarcodes(g.getImageData(0, 0, c.width, c.height), {
      tryHarder: true, formats, maxNumberOfSymbols: 4,
    });
    return results.filter((b) => b.isValid && b.text).map((b) => ({ format: b.format, value: b.text }));
  }

  /** Multi-pass decode: product barcodes on packs are often a small region of a
   *  large photo, so escalate — full 1x → full 2x → 3×3 overlapping tiles @4x. */
  async function detectBarcodes(canvas) {
    try {
      const zx = await getZXing();
      if (zx) {
        const found = new Map();
        const W = canvas.width, H = canvas.height;
        const addAll = (hits) => hits.forEach((h) => found.set(h.value, h));
        const hasProductCode = () => [...found.values()].some((h) => isProductFormat(h.format));

        // Pass 1: full frame, all formats (also picks up QR / DataMatrix).
        addAll(await zxingDecodePass(zx, canvas, 0, 0, W, H, 1, [...PRODUCT_FORMATS, "Code128", "QRCode", "DataMatrix"]));
        // Pass 2: full frame at 2x — recovers thin-bar EANs.
        if (!hasProductCode()) {
          addAll(await zxingDecodePass(zx, canvas, 0, 0, W, H, 2, PRODUCT_FORMATS));
        }
        // Pass 3: 3×3 overlapping tiles at 4x — small barcode regions.
        if (!hasProductCode()) {
          const sw = W * 0.45, sh = H * 0.45;
          outer: for (let ty = 0; ty < 3; ty++) {
            for (let tx = 0; tx < 3; tx++) {
              addAll(await zxingDecodePass(zx, canvas, tx * ((W - sw) / 2), ty * ((H - sh) / 2), sw, sh, 4, PRODUCT_FORMATS));
              if (hasProductCode()) break outer;
            }
          }
        }
        if (found.size) return [...found.values()];
      }
    } catch (err) {
      console.warn("zxing decode failed:", err.message);
    }
    // Fallback: native BarcodeDetector (Chromium only).
    if (nativeDetector) {
      try {
        const bitmap = await createImageBitmap(canvas);
        const found = await nativeDetector.detect(bitmap);
        bitmap.close();
        return found.map((b) => ({ format: b.format, value: b.rawValue }));
      } catch { /* fall through */ }
    }
    return [];
  }

  /** GTIN check-digit validation (EAN-8 / UPC-A / EAN-13). */
  function isValidGtin(code) {
    if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
    const digits = code.split("").map(Number);
    const checkDigit = digits.pop();
    const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === checkDigit;
  }

  function renderThumbs() {
    const grid = $("#thumb-grid");
    grid.innerHTML = state.images
      .map(
        (img, i) => `
        <div class="thumb">
          <img src="${img.thumb}" alt="evidence ${i + 1}" />
          <span class="thumb-idx">${i + 1}</span>
          <button class="thumb-x" data-i="${i}" title="Remove">✕</button>
        </div>`
      )
      .join("");
  }

  $("#thumb-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".thumb-x");
    if (!btn) return;
    if (state.scanning) return; // evidence must not change while it is being analysed
    state.images.splice(Number(btn.dataset.i), 1);
    renderThumbs();
    updateScanButton();
  });

  function updateScanButton() {
    const btn = $("#scan-btn");
    btn.disabled = !state.images.length || state.scanning;
    btn.textContent = state.scanning ? "SCANNING…" : `SCAN NOW ▸ (${state.images.length}/${MAX_IMAGES})`;
    if (!state.images.length) btn.textContent = "SCAN NOW ▸";
  }

  // ============================== scanning ==============================

  const LOADING_MSGS = [
    "reading label…",
    "decoding barcodes…",
    "transcribing declarations…",
    "locating mrp & net quantity…",
    "checking rule 6 declarations…",
    "validating units (rule 13)…",
  ];
  let loadingTimer = null;

  $("#scan-btn").addEventListener("click", async () => {
    if (state.current && !state.current.saved) {
      const ok = await askConfirm({
        label: "unsaved result", title: "start a fresh scan?",
        message: "The current result has not been saved to the repository and will be discarded.",
        confirmText: "DISCARD & RESCAN", danger: true,
      });
      if (!ok) return;
    }
    startScan(false);
  });

  async function startScan(isRetry) {
    if (state.scanning || !state.images.length) return;
    if (isRetry && state.attempts >= MAX_ATTEMPTS) return;
    if (!isRetry) state.attempts = 0;

    state.scanning = true;
    state.attempts += 1;
    updateScanButton();
    showLoading();

    // Snapshot the evidence BEFORE the request so the saved record always
    // matches exactly what was analysed.
    const evidence = {
      payload: state.images.map((img) => ({ data: img.apiData, mimeType: "image/jpeg" })),
      thumbs: state.images.map((img) => img.thumb),
      dims: state.images.map((img) => ({ w: img.width, h: img.height })),
      barcodes: [],
    };

    try {
      // Barcode decoding is heavy, so it runs here — concurrently with the
      // Gemini request, whose network time dwarfs it.
      const [j, detected] = await Promise.all([
        fetch("/api/scan", {
          method: "POST",
          headers: { "content-type": "application/json", "x-lmpc-auth": PASSWORD },
          body: JSON.stringify({ images: evidence.payload }),
        }).then((res) => res.json().then((body) => ({ body, status: res.status }))),
        detectBarcodesForPayload(evidence.payload),
      ]).then(([r, d]) => {
        if (!r.body.ok) throw new Error(r.body.error || `Scan failed (${r.status}).`);
        return [r.body, d];
      });
      evidence.barcodes = detected;

      // Gemini also reads the digits printed under the barcode — a robust OCR
      // fallback when the bars themselves are too small/blurry to decode.
      const ocrDigits = (j.extraction?.barcode_digits ?? "").replace(/\D/g, "");
      if (ocrDigits && isValidGtin(ocrDigits) && !evidence.barcodes.some((b) => b.value === ocrDigits)) {
        evidence.barcodes.push({ format: "OCR (printed digits)", value: ocrDigits });
      }

      // Pixel dimensions of what Gemini saw, persisted with the extraction so the
      // letter-height ratio can be re-evaluated later (e.g. from history).
      j.extraction.image_dims = evidence.dims;
      const results = window.LMPCRules.runRulesEngine(j.extraction);
      results.push(await buildBarcodeCard(evidence.barcodes, j.extraction));
      const verdict = window.LMPCRules.computeVerdict(results);
      state.current = {
        id: makeId(),
        ts: new Date().toISOString(),
        role: state.role,
        model: j.model,
        mock: Boolean(j.mock),
        extraction: j.extraction,
        results,
        verdict,
        override: null,
        barcodes: evidence.barcodes,
        thumbs: evidence.thumbs,
        // full-res copies for the evidence overlay — in-memory only, stripped before saving
        fullImages: evidence.payload.map((p) => `data:${p.mimeType};base64,${p.data}`),
        saved: false,
      };
      renderResults();
    } catch (err) {
      renderScanError(err.message);
    } finally {
      state.scanning = false;
      updateScanButton();
    }
  }

  /** Decode barcodes across all scan images (dedup by value). Each payload
   *  JPEG is decoded back to a canvas; ~100ms per image plus decode passes. */
  async function detectBarcodesForPayload(payload) {
    const seen = new Map();
    for (const img of payload) {
      try {
        const image = await new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = () => reject(new Error("decode failed"));
          i.src = `data:${img.mimeType};base64,${img.data}`;
        });
        for (const b of await detectBarcodes(drawScaled(image, 1600))) seen.set(b.value, b);
      } catch { /* skip unreadable image */ }
    }
    return [...seen.values()];
  }

  /** Barcode → product-database cross-check card, appended to the rule results.
   *  Valid GTIN → Open Food Facts details; invalid / absent / unmatched → review
   *  chip (manual: it never blocks a COMPLIANT verdict — barcodes are permitted,
   *  not mandatory, under Rule 6(4A)). */
  async function buildBarcodeCard(barcodes, extraction) {
    const card = {
      id: "barcode", group: "Product identity — barcode", clause: "Rule 6(4A)",
      title: "Barcode / product database match",
      requirement: "Barcodes/GTINs are permitted in addition to the mandatory declarations; a decoded GTIN is cross-checked against a product database.",
      extracted: null, status: "review", severity: null, manual: true, findings: [],
      box_2d: extraction?.barcode_box_2d || null,
      image_index: extraction?.barcode_image_index ?? null,
    };
    const gtin = barcodes.find((b) => isProductFormat(b.format) || (String(b.format).startsWith("OCR") && isValidGtin(b.value)));
    if (!gtin) {
      card.findings.push("No product barcode (EAN/UPC) could be detected or read in any of the images — verify product identity manually.");
      return card;
    }
    card.extracted = `${gtin.value} (${gtin.format})`;
    if (!isValidGtin(gtin.value)) {
      card.findings.push(`Decoded digits "${gtin.value}" fail the GTIN check-digit test — possible misprint or misread barcode; verify on the physical pack.`);
      return card;
    }
    if (gtin.value.length === 13 && gtin.value.startsWith("890")) {
      card.findings.push("GS1 prefix 890 — GTIN registered through GS1 India.");
    }
    try {
      const res = await fetch(`/api/barcode/${gtin.value}`, { headers: { "x-lmpc-auth": PASSWORD } });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "lookup error");
      if (!j.found) {
        card.findings.push(`Checksum-valid GTIN, but no record found in ${j.source} — product identity could not be independently confirmed.`);
        return card;
      }
      const p = j.product;
      card.status = "pass";
      card.manual = false;
      card.findings.push(`Database match (${j.source}): "${p.name || "unnamed"}" — brand ${p.brands || "?"}, quantity ${p.quantity || "?"}${p.countries ? ", sold in " + p.countries : ""}.`);
      // Cross-check the database quantity against the label declaration.
      const label = extraction?.declarations?.net_quantity;
      const dbMatch = (p.quantity || "").toLowerCase().replace(/\s/g, "").match(/^([\d.]+)(kg|g|ml|l)\b/);
      if (dbMatch && typeof label?.value === "number" && label.unit) {
        const toBase = { g: 1, gm: 1, gms: 1, kg: 1000, kgs: 1000, ml: 1, l: 1000, ltr: 1000, litre: 1000 };
        const labelBase = label.value * (toBase[String(label.unit).toLowerCase().replace(/\.$/, "")] ?? NaN);
        const dbBase = parseFloat(dbMatch[1]) * toBase[dbMatch[2]];
        if (Number.isFinite(labelBase) && Number.isFinite(dbBase)) {
          if (Math.abs(labelBase - dbBase) < 0.001) {
            card.findings.push(`Quantity cross-check: label "${label.text}" matches the database record (${p.quantity}).`);
          } else {
            card.status = "review";
            card.manual = true;
            card.findings.push(`Quantity mismatch: label declares ${label.value} ${label.unit} but the database records ${p.quantity} for this GTIN — verify the pack variant.`);
          }
        }
      }
    } catch (err) {
      card.findings.push(`Product-database lookup failed (${err.message}) — retry later or verify manually.`);
    }
    return card;
  }

  function makeId() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `LMPC-${ymd}-${rand}`;
  }

  function showLoading() {
    $("#results-empty").hidden = true;
    $("#results-content").hidden = true;
    $("#results-loading").hidden = false;
    let i = 0;
    $("#loading-msg").textContent = LOADING_MSGS[0];
    clearInterval(loadingTimer);
    loadingTimer = setInterval(() => {
      i = (i + 1) % LOADING_MSGS.length;
      $("#loading-msg").textContent = LOADING_MSGS[i];
    }, 1700);
  }

  function hideLoading() {
    clearInterval(loadingTimer);
    $("#results-loading").hidden = true;
  }

  function renderScanError(message) {
    hideLoading();
    $("#results-empty").hidden = true;
    const el = $("#results-content");
    el.hidden = false;
    const errorBanner = `<div class="mock-banner">SCAN FAILED — ${esc(message)}</div>`;
    if (state.current) {
      // A failed retry must not destroy the previous good result.
      renderResults();
      el.insertAdjacentHTML("afterbegin", errorBanner);
      return;
    }
    const retryLeft = MAX_ATTEMPTS - state.attempts;
    el.innerHTML = `
      ${errorBanner}
      <div class="results-toolbar">
        ${retryLeft > 0 ? `<button class="btn btn-navy" id="retry-btn">RETRY (${retryLeft} LEFT)</button>` : `<button class="btn btn-ghost" disabled>RETRY (0 LEFT)</button>`}
        <button class="btn btn-ghost" id="clear-btn">CLEAR</button>
      </div>`;
    bindToolbar();
  }

  // ============================== results rendering ==============================

  const STATUS_WORD = { pass: "COMPLIANT", violation: "VIOLATION", missing: "MISSING", review: "REVIEW", na: "N/A" };

  const LABEL_TITLES = {
    "manufacturer": "Manufacturer",
    "origin": "Country of Origin",
    "generic-name": "Generic Name",
    "net-quantity": "Net Qty",
    "mfg-date": "Mfg Date",
    "best-before": "Best Before",
    "mrp": "MRP",
    "consumer-care": "Consumer Care",
    "unit-sale-price": "USP",
    "dimensions": "Dimensions",
    "veg-mark": "Veg Mark",
    "sticker": "Sticker",
    "gm": "GM Food",
    "barcode": "Barcode",
  };

  const evidenceState = {
    activeImgIdx: 0,
    filter: "all",
    hideBoxes: false,
  };

  function verdictClass(v) {
    return v === "COMPLIANT" ? "v-compliant" : v === "NON-COMPLIANT" ? "v-noncompliant" : "v-review";
  }

  /** One rule card. Interactive mode adds pass/fail resolution buttons on
   *  non-manual REVIEW items. */
  function buildRuleCardHtml(r, interactive) {
    const eff = r.resolution?.status ?? r.status;
    const sevClass = r.severity ? ` sev-${r.severity}` : "";
    const hasBox = Boolean(r.box_2d && r.box_2d.length === 4);
    const boxBadge = hasBox
      ? `<button type="button" class="locate-btn" data-check="${esc(r.id)}" data-img="${r.image_index ?? 0}" title="Highlight on label photo">📍 PHOTO ${(r.image_index ?? 0) + 1}</button>`
      : "";

    let resolveHtml = "";
    if (r.resolution) {
      resolveHtml = `
        <div class="resolve-row resolved">
          <span class="resolved-note">RESOLVED AS ${eff === "pass" ? "COMPLIANT" : "VIOLATION"} BY ${esc((r.resolution.by || "").toUpperCase())} · ${esc(new Date(r.resolution.ts).toLocaleString("en-IN"))}</span>
          ${interactive ? `<button class="btn resolve-undo" data-check="${esc(r.id)}">UNDO</button>` : ""}
        </div>`;
    } else if (interactive && r.status === "review" && !r.manual) {
      resolveHtml = `
        <div class="resolve-row">
          <span class="resolve-label">INSPECTOR RESOLUTION</span>
          <button class="btn resolve-btn resolve-pass" data-check="${esc(r.id)}" data-status="pass">MARK COMPLIANT</button>
          <button class="btn resolve-btn resolve-fail" data-check="${esc(r.id)}" data-status="violation">MARK VIOLATION</button>
        </div>`;
    }

    let mathBoxHtml = "";
    if (r.id === "unit-sale-price" && r.math) {
      const m = r.math;
      mathBoxHtml = `
        <div class="rule-math-box">
          <div class="rm-item"><small>Statutory Base</small><span>1 ${esc(m.expectedBaseUnit)}</span></div>
          <div class="rm-item"><small>Formula</small><span>${esc(m.formula)}</span></div>
          <div class="rm-item"><small>Calculated USP</small><span class="rm-val">₹${m.expectedPrice.toFixed(2)} / ${esc(m.expectedBaseUnit)}</span></div>
          <div class="rm-item"><small>Rule 6(11)</small><span>${m.isExempt ? "Exempt (MRP = USP)" : "Mandatory"}</span></div>
        </div>`;
    }

    // Rule 7 letter-height: measured ratios / exact mm, plus the panel-size entry
    // that turns the band verdict into an exact one (no calibration object needed).
    let heightBoxHtml = "";
    if (r.id === "font-size" && r.measure) {
      const m = r.measure;
      const rows = m.measured.map((x) => {
        const val = x.hMm != null
          ? `${x.hMm.toFixed(1)} mm <em class="muted">/ ${x.needMm.toFixed(1)} min</em>`
          : `${(x.ratio * 100).toFixed(2)}% <em class="muted">of √panel</em>`;
        const cls = x.ok === true ? "rm-ok" : x.ok === false ? "rm-bad" : "";
        return `<div class="rm-item"><small>${esc(x.label)}</small><span class="${cls}">${val}</span></div>`;
      }).join("");
      const basis = m.areaCm2
        ? `${m.panelCm.w} × ${m.panelCm.h} cm → ${Math.round(m.areaCm2)} cm² · Table-I row ${m.row}`
        : `${Math.round(m.areaRange[0])}–${Math.round(m.areaRange[1])} cm² plausible for this pack`;
      const isCyl = m.shape === "cylinder";
      heightBoxHtml = `
        <div class="rule-math-box">${rows}<div class="rm-item"><small>${m.areaCm2 ? "Panel (measured)" : "Panel area"}</small><span>${esc(basis)}</span></div></div>
        ${interactive ? `
        <div class="resolve-row panel-dims">
          <span class="resolve-label">${isCyl ? "PANEL HEIGHT × CIRCUMFERENCE (CM)" : "PANEL WIDTH × HEIGHT (CM)"}</span>
          <input class="metro-input dims-input" data-dim="w" type="number" min="0.1" step="0.1" inputmode="decimal" placeholder="${isCyl ? "height" : "width"}" value="${m.panelCm?.w ?? ""}" />
          <span class="muted">×</span>
          <input class="metro-input dims-input" data-dim="h" type="number" min="0.1" step="0.1" inputmode="decimal" placeholder="${isCyl ? "circumference" : "height"}" value="${m.panelCm?.h ?? ""}" />
          <button type="button" class="btn dims-apply">MEASURE</button>
          ${m.panelCm ? `<button type="button" class="btn resolve-undo dims-clear">CLEAR</button>` : ""}
        </div>` : ""}`;
    }

    return `
      <article class="rule-card s-${eff}${sevClass}" data-check="${esc(r.id)}" data-img="${r.image_index ?? 0}">
        <div class="rule-head">
          <span class="clause-chip">${esc(r.clause)}</span>
          <span class="rule-title">${esc(r.title)}</span>
          ${boxBadge}
          <span class="status-word s-${eff}">${STATUS_WORD[eff]}${r.resolution ? " ✓" : ""}</span>
        </div>
        <p class="rule-req">${esc(r.requirement)}</p>
        <div class="rule-extract">
          <span class="x-label">AI EXTRACTED (VERBATIM)</span>
          <span class="x-text ${r.extracted ? "" : "none"}">${r.extracted ? esc(r.extracted) : "— not found on label —"}</span>
        </div>
        ${mathBoxHtml}${heightBoxHtml}
        <ul class="rule-findings">
          ${r.findings.map((f) => `<li>${esc(f)}</li>`).join("")}
        </ul>
        ${resolveHtml}
      </article>`;
  }

  /** Visual Evidence Map with SVG Bounding Boxes */
  function buildEvidenceMapHtml(rec) {
    if (!rec?.thumbs?.length) return "";

    const activeIdx = Math.min(evidenceState.activeImgIdx, rec.thumbs.length - 1);
    // Live scans keep the full-resolution images in memory; saved records only have 320px thumbs.
    const activeThumb = rec.fullImages?.[activeIdx] ?? rec.thumbs[activeIdx];

    const itemsOnPhoto = (rec.results || []).filter(
      (r) => r.box_2d && r.box_2d.length === 4 && (r.image_index ?? 0) === activeIdx
    );

    const totalBoxes = (rec.results || []).filter((r) => r.box_2d && r.box_2d.length === 4).length;
    if (!totalBoxes) return "";

    const filteredBoxes = itemsOnPhoto.filter((r) => {
      const eff = r.resolution?.status ?? r.status;
      if (evidenceState.filter === "violation") return ["violation", "missing"].includes(eff);
      if (evidenceState.filter === "pass") return eff === "pass";
      if (evidenceState.filter === "review") return eff === "review";
      return true;
    });

    const boxesSvg = filteredBoxes
      .map((r) => {
        const [ymin, xmin, ymax, xmax] = r.box_2d;
        const w = Math.max(14, xmax - xmin);
        const h = Math.max(14, ymax - ymin);
        const eff = r.resolution?.status ?? r.status;
        const label = LABEL_TITLES[r.id] || r.clause || r.title;
        const tagW = Math.max(48, label.length * 7.5 + 14);
        const tagY = ymin >= 24 ? ymin - 22 : ymin + 3;
        return `
          <g class="evidence-box-group s-${eff}" data-check="${esc(r.id)}" data-title="${esc(r.title)}" data-clause="${esc(r.clause)}" data-extracted="${esc(r.extracted || '')}" data-status="${STATUS_WORD[eff] || eff.toUpperCase()}" tabindex="0">
            <rect class="box-rect" x="${xmin}" y="${ymin}" width="${w}" height="${h}" rx="6" ry="6" />
            <g class="box-tag" transform="translate(${xmin}, ${tagY})">
              <rect class="box-tag-bg" width="${tagW}" height="20" rx="3" ry="3" />
              <text class="box-tag-text" x="6" y="14">${esc(label)}</text>
            </g>
          </g>`;
      })
      .join("");

    const tabsHtml = rec.thumbs.length > 1
      ? `<div class="evidence-tabs" id="ev-tabs">
          ${rec.thumbs
            .map((_, idx) => {
              const count = rec.results.filter((r) => r.box_2d && (r.image_index ?? 0) === idx).length;
              return `<button type="button" class="evidence-tab ${idx === activeIdx ? "active" : ""}" data-idx="${idx}">PHOTO ${idx + 1} (${count})</button>`;
            })
            .join("")}
        </div>`
      : `<span class="metro-label" style="margin:0;">evidence photo 1</span>`;

    const chipsHtml = itemsOnPhoto.length
      ? itemsOnPhoto
          .map((r) => {
            const eff = r.resolution?.status ?? r.status;
            const label = LABEL_TITLES[r.id] || r.title;
            return `<button type="button" class="ev-chip s-${eff}" data-check="${esc(r.id)}"><span class="chip-dot"></span>${esc(label)}</button>`;
          })
          .join("")
      : `<span class="tiny-note" style="margin:0;">No declarations located on this image.</span>`;

    return `
      <section class="evidence-map-tile tile" id="evidence-map-tile">
        <div class="evidence-map-head">
          <div class="evidence-map-title">
            <p class="metro-label" style="margin-bottom:2px;">visual evidence overlay</p>
            <h3>Declaration Locator (box_2d)</h3>
          </div>
          <div class="evidence-controls">
            ${tabsHtml}
            <button type="button" class="box-filter-btn ${evidenceState.filter === "all" ? "active" : ""}" data-filter="all">ALL</button>
            <button type="button" class="box-filter-btn ${evidenceState.filter === "violation" ? "active" : ""}" data-filter="violation">VIOLATIONS</button>
            <button type="button" class="toggle-overlay-btn" id="ev-toggle-boxes">${evidenceState.hideBoxes ? "SHOW BOXES" : "HIDE BOXES"}</button>
          </div>
        </div>

        <div class="evidence-viewport">
          <div class="evidence-stage" id="ev-stage" data-idx="${activeIdx}">
            <img class="evidence-img" id="ev-img" src="${activeThumb}" alt="Evidence photo ${activeIdx + 1}" />
            <svg class="evidence-svg ${evidenceState.hideBoxes ? "boxes-hidden" : ""}" id="ev-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">
              ${boxesSvg}
            </svg>
            <div class="evidence-tooltip-popup" id="ev-tooltip" hidden></div>
          </div>
        </div>

        <div class="evidence-footer">
          <div class="evidence-chips" id="ev-chips">${chipsHtml}</div>
          <small class="muted" style="font-family:var(--font-mono);font-size:10.5px;">Click any box to inspect legal clause</small>
        </div>
      </section>`;
  }

  /** `rerender` re-draws whichever surface hosts the map (live pane or history modal). */
  function bindEvidenceMap(container, rec, rerender) {
    if (!container || !rec) return;

    // Photo Tab switching
    container.querySelectorAll(".evidence-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        evidenceState.activeImgIdx = Number(btn.dataset.idx);
        rerender();
      });
    });

    // Filter switching
    container.querySelectorAll(".box-filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        evidenceState.filter = btn.dataset.filter;
        rerender();
      });
    });

    // Toggle boxes on/off
    container.querySelector("#ev-toggle-boxes")?.addEventListener("click", () => {
      evidenceState.hideBoxes = !evidenceState.hideBoxes;
      const svg = container.querySelector("#ev-svg");
      if (svg) svg.classList.toggle("boxes-hidden", evidenceState.hideBoxes);
      const btn = container.querySelector("#ev-toggle-boxes");
      if (btn) btn.textContent = evidenceState.hideBoxes ? "SHOW BOXES" : "HIDE BOXES";
    });

    // Tooltip & Box hover / click interaction
    const tooltip = container.querySelector("#ev-tooltip");
    container.querySelectorAll(".evidence-box-group").forEach((group) => {
      const checkId = group.dataset.check;
      const clause = group.dataset.clause;
      const title = group.dataset.title;
      const status = group.dataset.status;
      const extracted = group.dataset.extracted;

      group.addEventListener("mouseenter", () => {
        if (tooltip) {
          tooltip.hidden = false;
          tooltip.innerHTML = `
            <div class="tip-clause">${esc(clause)} · ${esc(status)}</div>
            <div class="tip-title"><b>${esc(title)}</b></div>
            ${extracted ? `<div class="tip-extract">${esc(extracted)}</div>` : ""}`;
        }
        document.querySelectorAll(`.rule-card[data-check="${checkId}"]`).forEach((c) => c.classList.add("highlighted-card"));
      });

      group.addEventListener("mouseleave", () => {
        if (tooltip) tooltip.hidden = true;
        document.querySelectorAll(`.rule-card[data-check="${checkId}"]`).forEach((c) => c.classList.remove("highlighted-card"));
      });

      group.addEventListener("click", () => {
        const card = document.querySelector(`.rule-card[data-check="${checkId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.add("pulse-highlight");
          setTimeout(() => card.classList.remove("pulse-highlight"), 1500);
        }
      });
    });

    // Chip click in footer
    container.querySelectorAll(".ev-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const checkId = chip.dataset.check;
        const box = container.querySelector(`.evidence-box-group[data-check="${checkId}"]`);
        if (box) {
          box.classList.add("active-box");
          setTimeout(() => box.classList.remove("active-box"), 1600);
        }
        const card = document.querySelector(`.rule-card[data-check="${checkId}"]`);
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.classList.add("pulse-highlight");
          setTimeout(() => card.classList.remove("pulse-highlight"), 1500);
        }
      });
    });

    // Rule card locate-btn and card hover
    container.querySelectorAll(".locate-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const checkId = btn.dataset.check;
        const targetImg = Number(btn.dataset.img || 0);
        if (evidenceState.activeImgIdx !== targetImg) {
          evidenceState.activeImgIdx = targetImg;
          rerender();
          setTimeout(() => highlightBox(checkId), 100);
        } else {
          highlightBox(checkId);
        }
      });
    });

    function highlightBox(checkId) {
      const tile = container.querySelector("#evidence-map-tile");
      if (tile) tile.scrollIntoView({ behavior: "smooth", block: "start" });
      const box = container.querySelector(`.evidence-box-group[data-check="${checkId}"]`);
      if (box) {
        box.classList.add("active-box");
        setTimeout(() => box.classList.remove("active-box"), 2000);
      }
    }
  }

  /** Shared HTML builder used by the live results pane (interactive: review
   *  items get pass/fail resolution buttons; the barcode card is rendered in
   *  its own left-column tile instead) and the history detail modal. */
  function buildResultsBody(rec, interactive = false) {
    const finalVerdict = rec.override ? rec.override.verdict : rec.verdict.verdict;
    const c = rec.verdict.counts;
    const p = rec.extraction?.product ?? {};

    let html = "";
    if (rec.mock) {
      html += `<div class="mock-banner">MOCK EXTRACTION — no Gemini key configured; showing a built-in sample label so the pipeline can be demoed.</div>`;
    }
    html += `
      <div class="verdict-banner ${verdictClass(finalVerdict)}">
        <div>
          <div class="verdict-word">${esc(finalVerdict.toLowerCase())}</div>
          <div class="verdict-meta">${esc(rec.verdict.summary)} · ${esc(rec.id)}</div>
        </div>
        <div class="verdict-counts">
          <span><b>${c.pass}</b>pass</span>
          <span><b>${c.violation + c.missing}</b>violations</span>
          <span><b>${c.review}</b>review</span>
        </div>
      </div>`;

    if (rec.override) {
      html += `
        <div class="override-note">
          <b>ADMIN OVERRIDE</b> — rules-engine verdict "${esc(rec.verdict.verdict)}" overridden to
          "${esc(rec.override.verdict)}" · ${esc(new Date(rec.override.ts).toLocaleString("en-IN"))}<br />
          Reason: ${esc(rec.override.reason)}
        </div>`;
    }

    html += `
      <div class="product-strip">
        <div class="ps-item"><small>Brand</small><span>${esc(p.brand_name ?? "—")}</span></div>
        <div class="ps-item"><small>Commodity</small><span>${esc(p.product_description ?? "—")}</span></div>
        <div class="ps-item"><small>Category</small><span>${esc(p.category ?? "—")}</span></div>
        <div class="ps-item"><small>Imported</small><span>${p.appears_imported ? "yes" : "no"}</span></div>
        <div class="ps-item"><small>Barcode</small><span>${rec.barcodes?.length ? esc(rec.barcodes.map((b) => b.value).join(", ")) : "none"}</span></div>
        <div class="ps-item"><small>Engine</small><span>${esc(rec.mock ? "mock" : rec.model)}</span></div>
      </div>`;

    // Evidence Map Overlay with box_2d
    html += buildEvidenceMapHtml(rec);

    // group cards (live pane: the barcode card lives in its own left tile)
    const groups = [];
    const listed = interactive ? rec.results.filter((r) => r.id !== "barcode") : rec.results;
    for (const r of listed) {
      let g = groups.find((x) => x.name === r.group);
      if (!g) { g = { name: r.group, items: [] }; groups.push(g); }
      g.items.push(r);
    }
    for (const g of groups) {
      html += `<div class="rule-group-head">${esc(g.name)}</div>`;
      for (const r of g.items) {
        html += buildRuleCardHtml(r, interactive);
      }
    }

    if (rec.extraction?.notes) {
      html += `<p class="tiny-note">Extraction notes: ${esc(rec.extraction.notes)}</p>`;
    }
    return html;
  }

  function renderResults() {
    hideLoading();
    $("#results-empty").hidden = true;
    const el = $("#results-content");
    el.hidden = false;

    const rec = state.current;
    const retryLeft = MAX_ATTEMPTS - state.attempts;
    const hasViolations = Boolean(rec?.verdict?.counts?.violation || rec?.verdict?.counts?.missing || rec?.verdict?.verdict === "NON-COMPLIANT");
    const toolbar = `
      <div class="results-toolbar">
        <button class="btn btn-navy" id="retry-btn" ${retryLeft <= 0 || rec.saved ? "disabled" : ""}>RETRY (${Math.max(retryLeft, 0)} LEFT)</button>
        <button class="btn btn-green" id="save-btn" ${rec.saved || rec.saving ? "disabled" : ""}>${rec.saved ? "SAVED ✓" : rec.saving ? "SAVING…" : "ACCEPT VERDICT & SAVE"}</button>
        ${hasViolations ? `<button class="btn btn-saffron" id="seizure-btn">SEIZURE MEMO ⚖️</button>` : ""}
        ${state.role === "admin" ? `<button class="btn btn-ghost" id="override-btn">OVERRIDE VERDICT</button>` : ""}
        <button class="btn btn-ghost" id="export-btn">EXPORT PDF ↧</button>
        <button class="btn btn-ghost" id="clear-btn">CLEAR</button>
        ${rec.saved ? `<span class="saved-flag">IN REPOSITORY</span>` : ""}
      </div>`;

    el.innerHTML = toolbar + buildResultsBody(rec, true);
    renderIdentityPane(rec);
    bindToolbar();
    bindEvidenceMap(el, rec, renderResults);
  }

  // Inspector resolution of review items — delegated because the results pane
  // is re-rendered wholesale on every change.
  $("#results-content").addEventListener("click", (e) => {
    const btn = e.target.closest(".resolve-btn, .resolve-undo");
    if (!btn || !state.current) return;
    const r = state.current.results.find((x) => x.id === btn.dataset.check);
    if (!r) return;
    if (btn.classList.contains("resolve-undo")) {
      r.resolution = null;
    } else {
      r.resolution = { status: btn.dataset.status, by: state.role, ts: new Date().toISOString() };
    }
    state.current.verdict = window.LMPCRules.computeVerdict(state.current.results);
    if (state.current.saved) updateStoredScan(state.current);
    renderResults();
  });

  /** Barcode / product-identity tile: left column on desktop, between the
   *  upload tile and the results pane in the mobile stack. */
  function renderIdentityPane(rec) {
    const pane = $("#identity-pane");
    const card = rec?.results.find((r) => r.id === "barcode");
    if (!card) {
      pane.hidden = true;
      pane.innerHTML = "";
      return;
    }
    pane.hidden = false;
    pane.innerHTML =
      `<p class="metro-label">product identity</p><h2 class="pane-title">barcode match</h2>` +
      buildRuleCardHtml(card, false);
  }

  // Panel-size entry on the letter-height card: re-evaluates Rule 7 exactly.
  $("#results-content").addEventListener("click", (e) => {
    const apply = e.target.closest(".dims-apply");
    const clear = e.target.closest(".dims-clear");
    if ((!apply && !clear) || !state.current) return;
    let panelCm = null;
    if (apply) {
      const row = apply.closest(".panel-dims");
      const w = parseFloat(row.querySelector('[data-dim="w"]').value);
      const h = parseFloat(row.querySelector('[data-dim="h"]').value);
      if (!(w > 0 && h > 0)) { showNotice("panel size", "Enter both panel dimensions in centimetres."); return; }
      panelCm = { w, h };
    }
    const rec = state.current;
    const idx = rec.results.findIndex((r) => r.id === "font-size");
    const card = window.LMPCRules.assessLetterHeight(rec.extraction, panelCm);
    if (idx >= 0) rec.results[idx] = card; else rec.results.push(card);
    rec.verdict = window.LMPCRules.computeVerdict(rec.results);
    if (rec.saved) updateStoredScan(rec);
    renderResults();
  });

  function bindToolbar() {
    $("#retry-btn")?.addEventListener("click", () => startScan(true));
    $("#clear-btn")?.addEventListener("click", clearScan);
    $("#save-btn")?.addEventListener("click", saveScan);
    $("#override-btn")?.addEventListener("click", openOverride);
    $("#seizure-btn")?.addEventListener("click", () => openSeizureModal(state.current));
    $("#export-btn")?.addEventListener("click", () => {
      if (state.current) exportRecordPdf(state.current);
    });
  }

  async function clearScan() {
    if (state.current && !state.current.saved) {
      const ok = await askConfirm({
        label: "unsaved result", title: "discard this scan?",
        message: "The images and results will be cleared without saving to the repository.",
        confirmText: "DISCARD", danger: true,
      });
      if (!ok) return;
    }
    state.images = [];
    state.current = null;
    state.attempts = 0;
    renderThumbs();
    updateScanButton();
    renderIdentityPane(null);
    $("#results-content").hidden = true;
    $("#results-content").innerHTML = "";
    $("#results-empty").hidden = false;
  }

  // ============================== persistence (D1 + R2 through the worker API) ==============================

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", "x-lmpc-auth": PASSWORD, ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || !body.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  const fetchInspection = async (id) => (await api(`/api/inspections/${encodeURIComponent(id)}`)).inspection;

  /** PDF generation is async (evidence photos may be R2 URLs) — surface failures. */
  function exportRecordPdf(rec) {
    Promise.resolve(window.LMPCExport.exportPdf(rec)).catch((err) => showNotice("export failed", err.message));
  }

  async function saveScan() {
    const rec = state.current;
    if (!rec || rec.saved || rec.saving) return;
    rec.saving = true;
    renderResults();
    try {
      // 512px images travel as data URLs; the worker stores them in R2 and returns their URLs.
      const { saved, saving, fullImages, thumbs, ...meta } = rec;
      const body = await api("/api/inspections", { method: "POST", body: JSON.stringify({ ...meta, images: thumbs }) });
      rec.thumbs = body.thumbs;
      rec.saved = true;
    } catch (err) {
      showNotice("could not save", `The inspection was not stored in the repository: ${err.message}`);
    } finally {
      rec.saving = false;
      renderResults();
    }
  }

  /** Push override / resolution changes on an already-saved record. */
  async function updateStoredScan(rec) {
    try {
      await api(`/api/inspections/${encodeURIComponent(rec.id)}`, {
        method: "PUT",
        body: JSON.stringify({ override: rec.override, results: rec.results, verdict: rec.verdict }),
      });
    } catch (err) {
      showNotice("could not update", `The change was not stored in the repository: ${err.message}`);
    }
  }

  /** One-time import of inspections saved by the localStorage-era prototype. */
  async function migrateLocalScans() {
    let legacy = [];
    try { legacy = JSON.parse(safeGet("localStorage", LS_SCANS)) || []; } catch { legacy = []; }
    if (!legacy.length) return;
    let imported = 0;
    for (const rec of legacy) {
      try {
        const { thumbs, fullImages, saved, ...meta } = rec;
        await api("/api/inspections", { method: "POST", body: JSON.stringify({ ...meta, images: thumbs || [] }) });
        imported += 1;
      } catch (err) {
        if (/UNIQUE/i.test(err.message)) imported += 1; // already there from an earlier attempt
        else console.warn("Could not import", rec.id, err.message);
      }
    }
    if (imported === legacy.length) safeRemove("localStorage", LS_SCANS);
    showNotice("repository upgraded", `${imported} of ${legacy.length} locally stored inspection${legacy.length > 1 ? "s" : ""} moved into the database.`);
  }

  // ============================== override (admin) ==============================

  let overrideVerdict = null;
  let overrideTarget = null; // 'current' | record id from history

  function openOverride(targetId) {
    overrideVerdict = null;
    overrideTarget = typeof targetId === "string" ? targetId : "current";
    $("#override-seg").querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
    $("#override-reason").value = "";
    $("#override-error").hidden = true;
    $("#override-modal").hidden = false;
  }

  $("#override-seg").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    overrideVerdict = btn.dataset.verdict;
    $("#override-seg").querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });

  $("#override-cancel").addEventListener("click", () => { $("#override-modal").hidden = true; });

  $("#override-apply").addEventListener("click", () => {
    const reason = $("#override-reason").value.trim();
    if (!overrideVerdict || !reason) {
      $("#override-error").hidden = false;
      return;
    }
    const override = { verdict: overrideVerdict, reason, by: state.role, ts: new Date().toISOString() };

    if (overrideTarget === "current" && state.current) {
      state.current.override = override;
      if (state.current.saved) updateStoredScan(state.current);
      renderResults();
    } else {
      const id = overrideTarget;
      $("#override-modal").hidden = true;
      (async () => {
        try {
          await api(`/api/inspections/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ override }) });
          if (state.detailRecord?.id === id) state.detailRecord.override = override;
          renderHistory();
          // keep the live scan pane in sync if it shows the same record
          if (state.current?.id === id) { state.current.override = override; renderResults(); }
          if (state.detailId === id) openDetail(id);
        } catch (err) {
          showNotice("could not override", err.message);
        }
      })();
      return;
    }
    $("#override-modal").hidden = true;
  });

  // ============================== history ==============================

  async function renderHistory() {
    const q = $("#history-search")?.value.trim() ?? "";
    let rows;
    try {
      rows = (await api(`/api/inspections${q ? `?q=${encodeURIComponent(q)}` : ""}`)).inspections;
    } catch (err) {
      $("#history-empty").hidden = true;
      $("#history-list").innerHTML = `<div class="mock-banner">Could not load the repository — ${esc(err.message)}</div>`;
      return;
    }
    $("#history-empty").hidden = rows.length > 0;
    $("#history-list").innerHTML = rows
      .map((s) => `
        <div class="history-row" data-id="${esc(s.id)}" role="button" tabindex="0" aria-label="Open inspection ${esc(s.id)}">
          <div class="hr-edge ${verdictClass(s.finalVerdict)}"></div>
          ${s.thumb ? `<img class="hr-thumb" src="${esc(s.thumb)}" alt="" loading="lazy" />` : `<div class="hr-thumb"></div>`}
          <div class="hr-main">
            <div class="hr-title">${esc(s.brand || s.product || "Unnamed product")}</div>
            <div class="hr-sub">${esc(s.id)} · ${esc(new Date(s.ts).toLocaleString("en-IN"))} · ${esc((s.role || "").toUpperCase())}${s.overridden ? " · OVERRIDDEN" : ""}${s.mock ? " · MOCK" : ""}</div>
          </div>
          <span class="hr-verdict ${verdictClass(s.finalVerdict)}">${esc(s.finalVerdict)}</span>
          <button class="icon-btn hr-export" data-id="${esc(s.id)}" title="Export PDF">↧</button>
        </div>`)
      .join("");
  }

  let searchTimer = null;
  $("#history-search")?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHistory, 250);
  });

  $("#history-list").addEventListener("click", async (e) => {
    const exportBtn = e.target.closest(".hr-export");
    if (exportBtn) {
      try { exportRecordPdf(await fetchInspection(exportBtn.dataset.id)); } catch (err) { showNotice("export failed", err.message); }
      return;
    }
    const row = e.target.closest(".history-row");
    if (row) openDetail(row.dataset.id);
  });

  $("#history-list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".history-row");
    if (row) { e.preventDefault(); openDetail(row.dataset.id); }
  });

  $("#history-clear-btn").addEventListener("click", async () => {
    const ok = await askConfirm({
      label: "repository", title: "delete all inspections?",
      message: "Every saved inspection and its evidence photos will be permanently removed from the database. This cannot be undone.",
      confirmText: "DELETE ALL", danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/inspections", { method: "DELETE" });
      renderHistory();
      // the live scan is no longer in the repository — allow saving it again
      if (state.current?.saved) { state.current.saved = false; renderResults(); }
    } catch (err) {
      showNotice("could not delete", err.message);
    }
  });

  // ============================== dashboard ==============================

  async function renderDashboard() {
    let stats;
    try {
      stats = (await api("/api/stats")).stats;
    } catch (err) {
      showNotice("dashboard unavailable", err.message);
      return;
    }
    $("#dash-empty").hidden = stats.total > 0;
    $("#dash-content").hidden = !stats.total;
    if (!stats.total) return;

    const verdictCounts = Object.fromEntries(stats.byVerdict.map((r) => [r.verdict, r.count]));
    const rate = Math.round((stats.compliant / stats.total) * 100);

    $("#stat-row").innerHTML = [
      { label: "inspections", value: stats.total, cls: "" },
      { label: "compliance rate", value: `${rate}%`, cls: rate >= 50 ? "stat-green" : "stat-crimson" },
      { label: "violations found", value: stats.violations, cls: stats.violations ? "stat-crimson" : "stat-green" },
      { label: "admin overrides", value: stats.overrides, cls: stats.overrides ? "stat-saffron" : "" },
    ].map((t) => `
      <div class="tile stat-tile ${t.cls}">
        <span class="stat-value">${esc(String(t.value))}</span>
        <span class="stat-label">${esc(t.label)}</span>
      </div>`).join("");

    // verdict split bar + legend
    const order = ["COMPLIANT", "MINOR NON-CONFORMITY", "NEEDS REVIEW", "NON-COMPLIANT"];
    const present = order.filter((v) => verdictCounts[v]).concat(Object.keys(verdictCounts).filter((v) => !order.includes(v)));
    $("#verdict-bar").innerHTML = present.map((v) =>
      `<span class="vb-seg ${verdictClass(v)}" style="flex-grow:${verdictCounts[v]}" title="${esc(v)}: ${verdictCounts[v]}"></span>`).join("");
    $("#verdict-legend").innerHTML = present.map((v) => `
      <span class="vl-item"><span class="vl-dot ${verdictClass(v)}"></span>${esc(v.toLowerCase())} <b>${verdictCounts[v]}</b></span>`).join("");

    // top violated clauses (SQL-aggregated by the worker)
    const ranked = stats.topClauses;
    const max = ranked[0]?.count ?? 1;
    $("#clause-ranks").innerHTML = ranked.length
      ? ranked.map((e) => `
        <div class="clause-rank">
          <div class="cr-head">
            <span class="clause-chip">${esc(e.clause)}</span>
            <span class="cr-title">${esc(e.title ?? "")}</span>
            <span class="cr-count">${e.count}</span>
          </div>
          <div class="cr-bar"><span style="width:${Math.round((e.count / max) * 100)}%"></span></div>
        </div>`).join("")
      : `<p class="muted">No violations recorded — every saved inspection is compliant.</p>`;
  }

  async function openDetail(id) {
    let rec;
    try {
      rec = state.detailRecord?.id === id ? state.detailRecord : await fetchInspection(id);
    } catch (err) {
      showNotice("could not open", err.message);
      return;
    }
    state.detailId = id;
    state.detailRecord = rec;
    $("#detail-title").textContent = rec.id;
    $("#detail-title").style.textTransform = "none";
    // Records scanned before bounding boxes existed have no evidence map — show the plain photo strip instead.
    const hasBoxes = (rec.results || []).some((r) => r.box_2d && r.box_2d.length === 4);
    const photoStrip = !hasBoxes && rec.thumbs?.length
      ? `<div class="detail-images">${rec.thumbs.map((t) => `<img src="${t}" alt="evidence" />`).join("")}</div>`
      : "";
    $("#detail-body").innerHTML = photoStrip + buildResultsBody(rec, false);
    bindEvidenceMap($("#detail-body"), rec, () => openDetail(id));

    const hasViolations = Boolean(rec?.verdict?.counts?.violation || rec?.verdict?.counts?.missing || rec?.verdict?.verdict === "NON-COMPLIANT");
    const szBtn = $("#detail-seizure-btn");
    if (szBtn) szBtn.hidden = !hasViolations;
    const ovBtn = $("#detail-override-btn");
    if (ovBtn) ovBtn.hidden = (state.role !== "admin");

    $("#detail-modal").hidden = false;
  }

  function closeDetail() {
    $("#detail-modal").hidden = true;
    state.detailId = null;
    state.detailRecord = null;
  }

  $("#detail-seizure-btn")?.addEventListener("click", () => {
    if (state.detailRecord) openSeizureModal(state.detailRecord);
  });
  $("#detail-override-btn")?.addEventListener("click", () => {
    if (state.detailId) openOverride(state.detailId);
  });

  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-export").addEventListener("click", () => {
    if (state.detailRecord) exportRecordPdf(state.detailRecord);
  });
  $("#detail-delete").addEventListener("click", async () => {
    if (!state.detailId) return;
    const deletedId = state.detailId;
    const ok = await askConfirm({
      label: "repository", title: "delete this inspection?",
      message: `${deletedId} and its evidence photos will be permanently removed from the database.`,
      confirmText: "DELETE", danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/inspections/${encodeURIComponent(deletedId)}`, { method: "DELETE" });
    } catch (err) {
      showNotice("could not delete", err.message);
      return;
    }
    closeDetail();
    renderHistory();
    if (state.current?.id === deletedId) { state.current.saved = false; renderResults(); }
  });

  // ============================== seizure notice modal ==============================

  let seizureTargetRecord = null;

  function openSeizureModal(rec) {
    if (!rec) return;
    seizureTargetRecord = rec;
    const ext = rec.extraction || {};
    const p = ext.product || {};
    const d = ext.declarations || {};

    // A legal instrument must never carry invented parties: every identity
    // field starts empty and is typed by the officer (placeholders guide format).
    $("#sz-premises").value = "";
    $("#sz-person").value = "";
    $("#sz-gstin").value = "";
    $("#sz-seized-qty").value = "";
    $("#sz-sample-qty").value = "";
    $("#sz-offence-type").value = d.sticker_over_declaration?.present ? "sticker" : "first";
    $("#sz-notice-period").value = "15";
    $("#sz-witness1").value = "";
    $("#sz-witness2").value = "";
    $("#sz-officer").value = "";
    $("#sz-circle").value = "";

    $("#seizure-error").hidden = true;
    $("#seizure-modal").hidden = false;
  }

  $("#seizure-close")?.addEventListener("click", () => { $("#seizure-modal").hidden = true; seizureTargetRecord = null; });
  $("#seizure-cancel")?.addEventListener("click", () => { $("#seizure-modal").hidden = true; seizureTargetRecord = null; });

  $("#seizure-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!seizureTargetRecord) return;

    const premises = $("#sz-premises").value.trim();
    const person = $("#sz-person").value.trim();
    const seizedQtyRaw = $("#sz-seized-qty").value.trim();
    const sampleQtyRaw = $("#sz-sample-qty").value.trim();
    const witness1 = $("#sz-witness1").value.trim();
    const witness2 = $("#sz-witness2").value.trim();
    const officer = $("#sz-officer").value.trim();
    const circle = $("#sz-circle").value.trim();

    if (!premises || !person || !seizedQtyRaw || isNaN(Number(seizedQtyRaw)) || Number(seizedQtyRaw) <= 0 || !witness1 || !witness2 || !officer || !circle) {
      $("#seizure-error").hidden = false;
      return;
    }

    const formData = {
      premises,
      person,
      gstin: $("#sz-gstin").value.trim(),
      seizedQty: `${seizedQtyRaw} package(s) seized and sealed`,
      sampleQty: sampleQtyRaw && Number(sampleQtyRaw) > 0 ? `${sampleQtyRaw} package(s) drawn as samples` : "Nil (No samples drawn)",
      offenceType: $("#sz-offence-type").value,
      noticePeriod: $("#sz-notice-period").value,
      witness1,
      witness2,
      officer,
      circle,
    };

    Promise.resolve(window.LMPCExport.exportSeizureNotice(seizureTargetRecord, formData))
      .catch((err) => showNotice("export failed", err.message));
    $("#seizure-modal").hidden = true;
  });

  // ============================== confirm / notice dialog ==============================
  // Metro-styled replacement for native confirm()/alert(). Resolves true/false.

  let confirmResolve = null;

  function closeConfirm(result) {
    $("#confirm-modal").hidden = true;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }

  function askConfirm({ label = "confirm", title, message, confirmText = "CONFIRM", cancelText = "CANCEL", danger = false }) {
    return new Promise((resolve) => {
      if (confirmResolve) confirmResolve(false); // a dialog was already open — dismiss it
      confirmResolve = resolve;
      $("#confirm-label").textContent = label;
      $("#confirm-title").textContent = title;
      $("#confirm-message").textContent = message;
      const ok = $("#confirm-ok");
      ok.textContent = confirmText;
      ok.className = `btn ${danger ? "btn-crimson" : "btn-accent"}`;
      const cancel = $("#confirm-cancel");
      cancel.hidden = cancelText === null;
      cancel.textContent = cancelText ?? "";
      $("#confirm-modal").hidden = false;
      ok.focus();
    });
  }

  /** One-button variant for errors and information. */
  function showNotice(title, message) {
    return askConfirm({ label: "notice", title, message, confirmText: "OK", cancelText: null });
  }

  $("#confirm-ok").addEventListener("click", () => closeConfirm(true));
  $("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
  $("#confirm-modal").addEventListener("click", (e) => { if (e.target.id === "confirm-modal") closeConfirm(false); });

  // close modals on scrim click or Escape
  for (const id of ["override-modal", "detail-modal", "seizure-modal"]) {
    $("#" + id).addEventListener("click", (e) => {
      if (e.target.id === id) {
        $("#" + id).hidden = true;
        if (id === "detail-modal") { state.detailId = null; state.detailRecord = null; }
        if (id === "seizure-modal") seizureTargetRecord = null;
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#confirm-modal").hidden) closeConfirm(false);
    else if (!$("#seizure-modal").hidden) { $("#seizure-modal").hidden = true; seizureTargetRecord = null; }
    else if (!$("#override-modal").hidden) $("#override-modal").hidden = true;
    else if (!$("#detail-modal").hidden) closeDetail();
  });
})();
