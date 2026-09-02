/**
 * LMPC Compliance Checker — Cloudflare Worker backend.
 * Serves static assets (via the assets binding) and exposes:
 *   POST   /api/scan                 — forwards package images to Gemini, returns structured label extraction
 *   GET    /api/health               — reports whether a Gemini key is configured
 *   GET    /api/barcode/:gtin        — Open Food Facts product lookup
 *   GET    /api/inspections[?q=]     — repository list (D1)        POST /api/inspections — save (images → R2)
 *   GET/PUT/DELETE /api/inspections/:id, DELETE /api/inspections   — read / update / delete / clear
 *   GET    /api/stats                — dashboard aggregates (D1)
 *   GET    /api/images/:id/:n.jpg    — evidence photo (R2, 512px)
 *
 * The worker only EXTRACTS label data. Compliance is decided by the
 * deterministic rules engine on the client (public/js/rules.js).
 */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const API_REVISION = "2026-05-20";
const APP_PASSWORD = "SIH2026"; 
/** A declaration field: verbatim text + found flag + bounding box & image index. */
const decl = (extra = {}) => ({
  type: "object",
  properties: {
    found: { type: "boolean", description: "True only if this declaration is actually visible on the label." },
    text: { type: ["string", "null"], description: "The verbatim text as printed on the label, or null." },
    box_2d: {
      type: ["array", "null"],
      items: { type: "integer" },
      description: "Bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000 on the image where this declaration is found, or null if not found.",
    },
    image_index: {
      type: ["integer", "null"],
      description: "0-based index of the input image where this declaration is visible (0 for first photo, 1 for second, etc.), or null if not found.",
    },
    ...extra,
  },
  required: ["found", "text", "box_2d", "image_index", ...Object.keys(extra)],
});

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    product: {
      type: "object",
      properties: {
        brand_name: { type: ["string", "null"], description: "Brand/trade name as printed." },
        product_description: { type: ["string", "null"], description: "Short description of what the product is." },
        category: { type: "string", enum: ["food", "cosmetic", "electronic", "textile", "household", "other"] },
        appears_imported: { type: "boolean", description: "True if the label suggests an imported product (importer details, 'Made in <foreign country>', foreign language, etc.)." },
        package_type: { type: "string", enum: ["retail", "wholesale", "unknown"] },
      },
      required: ["brand_name", "product_description", "category", "appears_imported", "package_type"],
    },
    declarations: {
      type: "object",
      properties: {
        manufacturer: decl({
          has_complete_address: { type: "boolean", description: "True if a full postal address (building/street, city, state, PIN code) is printed, not just a city name." },
          role: { type: "string", enum: ["manufactured_by", "marketed_by", "packed_by", "unknown"], description: "What the block actually says: 'Mfd./Manufactured by' vs only 'Marketed by'." },
        }),
        packer: decl(),
        importer: decl(),
        country_of_origin: decl(),
        generic_name: decl({
          is_brand_only: { type: "boolean", description: "True if only a brand name appears with NO common/generic name of the commodity." },
        }),
        net_quantity: decl({
          value: { type: ["number", "null"], description: "Numeric quantity, e.g. 500 for '500 gms'." },
          unit: { type: ["string", "null"], description: "The unit EXACTLY as printed, e.g. 'gms', 'Kg', 'ml', 'N'." },
          qualifying_words: { type: ["string", "null"], description: "Any qualifying words printed near the quantity like 'about', 'approx', 'minimum', else null." },
        }),
        mrp: decl({
          value: { type: ["number", "null"], description: "Numeric MRP value." },
          currency: { type: ["string", "null"], description: "Currency symbol/word EXACTLY as printed: '₹', 'Rs.', 'INR', '$', etc." },
          tax_inclusive_text: { type: ["string", "null"], description: "The verbatim phrase indicating taxes included, e.g. 'inclusive of all taxes', 'incl. of all taxes', else null." },
        }),
        mfg_date: decl({
          date_kind: { type: "string", enum: ["manufacture", "packing", "import", "unknown"], description: "Whether the date is labelled Mfd/Mfg (manufacture), Pkd (packing) or import." },
        }),
        best_before: decl(),
        consumer_care: decl({
          has_phone: { type: "boolean" },
          has_email: { type: "boolean" },
          has_address: { type: "boolean" },
        }),
        unit_sale_price: decl(),
        dimensions: decl(),
        veg_nonveg_mark: {
          type: "object",
          properties: {
            found: { type: "boolean", description: "True if a vegetarian (green) or non-vegetarian (red/brown) dot mark is visible." },
            mark: { type: "string", enum: ["green", "red_brown", "none"] },
            box_2d: {
              type: ["array", "null"],
              items: { type: "integer" },
              description: "Bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000 of the veg/non-veg dot mark, or null.",
            },
            image_index: {
              type: ["integer", "null"],
              description: "0-based index of the image where the mark is visible, or null.",
            },
          },
          required: ["found", "mark", "box_2d", "image_index"],
        },
        gm_declaration: decl(),
        sticker_over_declaration: {
          type: "object",
          properties: {
            present: { type: "boolean", description: "True if a sticker appears pasted over or altering any mandatory declaration." },
            covers_mrp: { type: "boolean", description: "True if a sticker covers or obscures the original printed MRP." },
            box_2d: {
              type: ["array", "null"],
              items: { type: "integer" },
              description: "Bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000 of the sticker if present, or null.",
            },
            image_index: {
              type: ["integer", "null"],
              description: "0-based index of the image where the sticker is visible, or null.",
            },
          },
          required: ["present", "covers_mrp", "box_2d", "image_index"],
        },
      },
      required: [
        "manufacturer", "packer", "importer", "country_of_origin", "generic_name",
        "net_quantity", "mrp", "mfg_date", "best_before", "consumer_care",
        "unit_sale_price", "dimensions", "veg_nonveg_mark", "gm_declaration", "sticker_over_declaration",
      ],
    },
    languages_detected: { type: "array", items: { type: "string" }, description: "Languages of the label text, e.g. ['English','Hindi']." },
    barcode_visible: { type: "boolean" },
    barcode_digits: { type: ["string", "null"], description: "The human-readable digits printed beneath the barcode, verbatim without spaces (e.g. '8901491103800'), or null if none/unreadable." },
    barcode_box_2d: {
      type: ["array", "null"],
      items: { type: "integer" },
      description: "Bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000 of the barcode, or null if not visible.",
    },
    barcode_image_index: {
      type: ["integer", "null"],
      description: "0-based index of the image where the barcode is visible, or null.",
    },
    label_legibility: { type: "string", enum: ["good", "partial", "poor"], description: "How readable the photographed label is." },
    notes: { type: ["string", "null"], description: "Anything unusual an inspector should know (stickers over declarations, damaged label, etc.)." },
  },
  required: [
    "product", "declarations", "languages_detected",
    "barcode_visible", "barcode_digits", "barcode_box_2d", "barcode_image_index",
    "label_legibility", "notes",
  ],
};

const EXTRACTION_PROMPT = `You are the extraction layer of a Legal Metrology (Packaged Commodities) Rules, 2011 inspection tool used by Indian enforcement officers.

You will receive 1–5 photographs of the SAME packaged commodity (different sides/angles). Read every piece of printed text on the package and fill the JSON schema.

STRICT RULES:
- You only READ, LOCATE, and TRANSCRIBE. You never judge legality or compliance — a separate deterministic rules engine does that.
- Copy text VERBATIM, preserving spelling, casing and units exactly as printed (if the pack says "500 gms", report unit "gms", not "g").
- Mark found=true only when the declaration is genuinely visible in the images. Never invent or autocomplete missing details.
- For every declaration with found=true, provide:
  * box_2d: [ymin, xmin, ymax, xmax] coordinates normalized to 0-1000 tightly surrounding the declaration on the image.
  * image_index: the 0-based index of the input image where that declaration is visible (0 for the 1st photo, 1 for the 2nd photo, etc.).
- If a declaration is not found (found=false), set box_2d=null and image_index=null.
- If text is partially unreadable, transcribe what is readable and mention the problem in notes.
- The manufacturer declaration is the "Manufactured by / Mfd. by / Marketed by" block; record in its "role" field which wording is actually used ("marketed_by" if only Marketed by appears). The packer is "Packed by"; the importer is "Imported by".
- consumer_care is the customer-complaints contact block (name/address/phone/email).
- unit_sale_price is a per-unit price like "₹0.85/g" if printed.
- mfg_date is the month/year (or full date) declaration; record in "date_kind" whether it is labelled as manufacture (Mfd/Mfg), packing (Pkd) or import. best_before is a "best before / use by / expiry" declaration.
- gm_declaration: any "GM" genetically-modified marking. sticker_over_declaration: whether any sticker is pasted over/altering mandatory declarations, and whether it covers the printed MRP.
- barcode_digits: if a barcode is visible, transcribe the digits printed beneath it exactly (no spaces) and provide barcode_box_2d & barcode_image_index.`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Pull the model's text output out of an interactions API response.
 *  REST envelope: { steps: [{type:"thought"...}, {type:"model_output", content:[{type:"text", text}]}] } */
function extractOutputText(body) {
  if (typeof body?.output_text === "string" && body.output_text.length) return body.output_text;
  const parts = [];
  for (const step of body?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const item of step.content ?? []) {
      if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
  }
  if (parts.length) return parts.join("");
  // Defensive fallback for other envelope variants.
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") {
      if (typeof node.text === "string" && node.type !== "thought") parts.push(node.text);
      for (const key of ["output", "outputs", "content", "items", "parts"]) walk(node[key]);
    }
  };
  walk(body);
  return parts.join("");
}

const MOCK_EXTRACTION = {
  product: {
    brand_name: "HillFresh",
    product_description: "Instant coffee powder glass jar",
    category: "food",
    appears_imported: false,
    package_type: "retail",
  },
  declarations: {
    manufacturer: { found: true, text: "Mfd. by: HillFresh Beverages Pvt. Ltd., Plot 12, MIDC Phase II, Pune, Maharashtra - 411057", has_complete_address: true, role: "manufactured_by", box_2d: [620, 150, 780, 850], image_index: 0 },
    packer: { found: false, text: null, box_2d: null, image_index: null },
    importer: { found: false, text: null, box_2d: null, image_index: null },
    country_of_origin: { found: false, text: null, box_2d: null, image_index: null },
    generic_name: { found: true, text: "Instant Coffee Powder", is_brand_only: false, box_2d: [280, 200, 360, 800], image_index: 0 },
    net_quantity: { found: true, text: "Net Wt. 100 gms", value: 100, unit: "gms", qualifying_words: null, box_2d: [480, 250, 540, 750], image_index: 0 },
    mrp: { found: true, text: "MRP Rs. 245.00", value: 245, currency: "Rs.", tax_inclusive_text: null, box_2d: [550, 250, 610, 750], image_index: 0 },
    mfg_date: { found: true, text: "Pkd. 05/2026", date_kind: "packing", box_2d: [410, 250, 470, 750], image_index: 0 },
    best_before: { found: true, text: "Best before 18 months from packaging", box_2d: [440, 150, 490, 850], image_index: 0 },
    consumer_care: { found: true, text: "For complaints: care@hillfresh.in", has_phone: false, has_email: true, has_address: false, box_2d: [790, 150, 850, 850], image_index: 0 },
    unit_sale_price: { found: false, text: null, box_2d: null, image_index: null },
    dimensions: { found: false, text: null, box_2d: null, image_index: null },
    veg_nonveg_mark: { found: true, mark: "green", box_2d: [200, 800, 260, 870], image_index: 0 },
    gm_declaration: { found: false, text: null, box_2d: null, image_index: null },
    sticker_over_declaration: { present: false, covers_mrp: false, box_2d: null, image_index: null },
  },
  languages_detected: ["English"],
  barcode_visible: true,
  barcode_digits: "8901234567895",
  barcode_box_2d: [820, 650, 950, 920],
  barcode_image_index: 0,
  label_legibility: "good",
  notes: "MOCK DATA — no GEMINI_API_KEY configured in .dev.vars, so this is a built-in sample label used to demo the pipeline.",
};

async function handleScan(request, env) {
  if (request.headers.get("x-lmpc-auth") !== APP_PASSWORD) {
    return json({ ok: false, error: "Not authorised." }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const images = Array.isArray(payload?.images) ? payload.images.slice(0, 5) : [];
  if (!images.length) return json({ ok: false, error: "At least one image is required." }, 400);
  let totalBytes = 0;
  for (const img of images) {
    if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") {
      return json({ ok: false, error: "Each image needs base64 `data` and a `mimeType`." }, 400);
    }
    totalBytes += img.data.length * 0.75;
  }
  // Gemini's inline-request ceiling is 20MB; leave headroom for prompt + schema.
  if (totalBytes > 15 * 1024 * 1024) {
    return json({ ok: false, error: "Images too large (over ~15MB total). Use smaller photos." }, 413);
  }

  // Accept GEMINI_API_KEY plus numbered fallbacks (GEMINI_API_KEY1..3). A random
  // key starts each scan (spreads free-tier quota); quota errors rotate to the next.
  // GEMINI_API_KEY4 is deliberately excluded — its project's credits are depleted.
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY1, env.GEMINI_API_KEY2, env.GEMINI_API_KEY3].filter(Boolean);
  if (keys.length > 1) {
    const start = Math.floor(Math.random() * keys.length);
    keys.push(...keys.splice(0, start));
  }
  if (!keys.length) {
    // No key configured — return a clearly-flagged sample so the UI stays demoable.
    return json({ ok: true, mock: true, model: "mock", extraction: MOCK_EXTRACTION });
  }

  const body = {
    model: GEMINI_MODEL,
    input: [
      { type: "text", text: EXTRACTION_PROMPT },
      ...images.map((img) => ({ type: "image", data: img.data, mime_type: img.mimeType })),
    ],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: EXTRACTION_SCHEMA,
    },
  };

  let upstream = null;
  let raw = "";
  let lastError = "";
  for (let i = 0; i < keys.length; i++) {
    try {
      upstream = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
          "x-goog-api-key": keys[i],
          "content-type": "application/json",
          "Api-Revision": API_REVISION,
        },
        body: JSON.stringify(body),
      });
      raw = await upstream.text();
    } catch (err) {
      // Transient network failure — try the next key rather than giving up.
      lastError = `Could not reach Gemini API: ${err.message}`;
      upstream = null;
      continue;
    }
    if (upstream.ok) break;
    let detail = raw;
    try { detail = JSON.parse(raw)?.error?.message ?? raw; } catch {}
    lastError = `Gemini API error (${upstream.status}): ${detail}`;
    // Quota / auth problems: rotate to the next configured key. Anything else: stop.
    if (![429, 403, 401].includes(upstream.status)) break;
  }
  if (!upstream || !upstream.ok) {
    return json({ ok: false, error: lastError || "Gemini API request failed." }, 502);
  }

  let parsedResponse;
  try { parsedResponse = JSON.parse(raw); } catch {
    return json({ ok: false, error: "Gemini returned a non-JSON response envelope." }, 502);
  }

  // Tolerate markdown-fenced JSON, then hard-validate the shape: a malformed
  // extraction must never silently become a legal verdict downstream.
  const outputText = extractOutputText(parsedResponse)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let extraction;
  try { extraction = JSON.parse(outputText); } catch {
    return json({ ok: false, error: "Gemini output was not valid JSON. Try re-scanning.", raw: outputText.slice(0, 2000) }, 502);
  }

  const d = extraction?.declarations;
  const requiredDecls = ["manufacturer", "generic_name", "net_quantity", "mrp", "mfg_date", "consumer_care"];
  const shapeOk =
    extraction && typeof extraction === "object" &&
    extraction.product && typeof extraction.product === "object" &&
    d && typeof d === "object" &&
    requiredDecls.every((k) => d[k] && typeof d[k] === "object");
  if (!shapeOk) {
    return json({ ok: false, error: "Gemini returned an incomplete extraction. Try re-scanning." }, 502);
  }

  return json({ ok: true, mock: false, model: GEMINI_MODEL, extraction });
}

// ============================== inspection repository (D1 + R2) ==============================

const effectiveStatus = (r) => r?.resolution?.status ?? r?.status;
const imageKey = (id, n) => `inspections/${id}/${n}.jpg`;
const imageUrl = (id, n) => `/api/images/${id}/${n}.jpg`;
const ID_RE = /^[A-Z0-9-]{6,40}$/;

/** D1 row → the record shape the frontend renders. Images are R2 URLs. */
function rowToRecord(row) {
  return {
    id: row.id, ts: row.ts, role: row.role, model: row.model, mock: Boolean(row.mock),
    extraction: JSON.parse(row.extraction_json),
    results: JSON.parse(row.results_json),
    verdict: row.verdict_json ? JSON.parse(row.verdict_json) : { verdict: row.verdict, summary: row.summary, counts: {} },
    override: row.override_json ? JSON.parse(row.override_json) : null,
    barcodes: row.barcodes_json ? JSON.parse(row.barcodes_json) : [],
    thumbs: Array.from({ length: row.image_count ?? 0 }, (_, n) => imageUrl(row.id, n)),
  };
}

/** Rewrite the per-clause violation rows (effective statuses, incl. inspector resolutions). */
async function writeViolations(env, id, results) {
  const stmts = [env.DB.prepare("DELETE FROM violations WHERE inspection_id = ?").bind(id)];
  for (const r of results || []) {
    const status = effectiveStatus(r);
    if (status !== "violation" && status !== "missing") continue;
    stmts.push(
      env.DB.prepare("INSERT INTO violations (inspection_id, check_id, clause, title, status, severity) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, r.id, r.clause, r.title ?? null, status, r.severity ?? null)
    );
  }
  await env.DB.batch(stmts);
}

async function deleteImages(env, id, count) {
  const keys = Array.from({ length: count ?? 0 }, (_, n) => imageKey(id, n));
  if (keys.length) await env.EVIDENCE.delete(keys);
}

async function handleInspections(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "inspections", id?]
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;
  const method = request.method;
  const LIST_COLS = "id, ts, role, mock, brand, product, final_verdict, (override_json IS NOT NULL) AS overridden, image_count";

  if (!id && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const like = `%${q}%`;
    const stmt = q
      ? env.DB.prepare(`SELECT ${LIST_COLS} FROM inspections WHERE id LIKE ? OR brand LIKE ? OR product LIKE ? OR gtin LIKE ? ORDER BY ts DESC LIMIT 200`).bind(like, like, like, like)
      : env.DB.prepare(`SELECT ${LIST_COLS} FROM inspections ORDER BY ts DESC LIMIT 200`);
    const { results } = await stmt.all();
    return json({
      ok: true,
      inspections: results.map((r) => ({
        id: r.id, ts: r.ts, role: r.role, mock: Boolean(r.mock), brand: r.brand, product: r.product,
        finalVerdict: r.final_verdict, overridden: Boolean(r.overridden),
        thumb: r.image_count > 0 ? imageUrl(r.id, 0) : null,
      })),
    });
  }

  if (!id && method === "POST") {
    const rec = await request.json();
    if (!rec?.id || !rec.extraction || !Array.isArray(rec.results) || !rec.verdict?.verdict) {
      return json({ ok: false, error: "Incomplete record." }, 400);
    }
    if (!ID_RE.test(rec.id)) return json({ ok: false, error: "Bad record id." }, 400);
    const images = Array.isArray(rec.images) ? rec.images.slice(0, 5) : [];
    for (let n = 0; n < images.length; n++) {
      const b64 = String(images[n]).replace(/^data:image\/\w+;base64,/, "");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await env.EVIDENCE.put(imageKey(rec.id, n), bytes, { httpMetadata: { contentType: "image/jpeg" } });
    }
    const p = rec.extraction.product || {};
    const gtin = (rec.barcodes || []).map((b) => String(b?.value ?? "")).find((v) => /^\d{8,14}$/.test(v)) ?? null;
    const finalVerdict = rec.override?.verdict ?? rec.verdict.verdict;
    await env.DB.prepare(
      `INSERT INTO inspections (id, ts, role, model, mock, brand, product, category, gtin, verdict, final_verdict, summary,
         override_json, extraction_json, results_json, verdict_json, barcodes_json, image_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      rec.id, rec.ts || new Date().toISOString(), rec.role ?? null, rec.model ?? null, rec.mock ? 1 : 0,
      p.brand_name ?? null, p.product_description ?? null, p.category ?? null, gtin,
      rec.verdict.verdict, finalVerdict, rec.verdict.summary ?? null,
      rec.override ? JSON.stringify(rec.override) : null,
      JSON.stringify(rec.extraction), JSON.stringify(rec.results), JSON.stringify(rec.verdict),
      JSON.stringify(rec.barcodes || []), images.length
    ).run();
    await writeViolations(env, rec.id, rec.results);
    return json({ ok: true, id: rec.id, thumbs: images.map((_, n) => imageUrl(rec.id, n)) });
  }

  if (!id && method === "DELETE") {
    const { results } = await env.DB.prepare("SELECT id, image_count FROM inspections").all();
    for (const r of results) await deleteImages(env, r.id, r.image_count);
    await env.DB.batch([env.DB.prepare("DELETE FROM violations"), env.DB.prepare("DELETE FROM inspections")]);
    return json({ ok: true, deleted: results.length });
  }

  if (!id) return json({ ok: false, error: "Method not allowed." }, 405);
  if (!ID_RE.test(id)) return json({ ok: false, error: "Bad record id." }, 400);

  const row = await env.DB.prepare("SELECT * FROM inspections WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "Inspection not found." }, 404);

  if (method === "GET") return json({ ok: true, inspection: rowToRecord(row) });

  if (method === "PUT") {
    const patch = await request.json();
    const results = Array.isArray(patch.results) ? patch.results : JSON.parse(row.results_json);
    const verdict = patch.verdict?.verdict
      ? patch.verdict
      : (row.verdict_json ? JSON.parse(row.verdict_json) : { verdict: row.verdict, summary: row.summary, counts: {} });
    const override = patch.override === undefined
      ? (row.override_json ? JSON.parse(row.override_json) : null)
      : patch.override;
    await env.DB.prepare(
      `UPDATE inspections SET results_json = ?, verdict_json = ?, verdict = ?, summary = ?, override_json = ?, final_verdict = ?,
         updated_at = datetime('now') WHERE id = ?`
    ).bind(
      JSON.stringify(results), JSON.stringify(verdict), verdict.verdict, verdict.summary ?? null,
      override ? JSON.stringify(override) : null, override?.verdict ?? verdict.verdict, id
    ).run();
    await writeViolations(env, id, results);
    return json({ ok: true });
  }

  if (method === "DELETE") {
    await deleteImages(env, id, row.image_count);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM violations WHERE inspection_id = ?").bind(id),
      env.DB.prepare("DELETE FROM inspections WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Method not allowed." }, 405);
}

async function handleStats(env) {
  const [totals, byVerdict, topClauses] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(final_verdict = 'COMPLIANT') AS compliant, SUM(override_json IS NOT NULL) AS overrides,
         (SELECT COUNT(*) FROM violations) AS violations FROM inspections`
    ).first(),
    env.DB.prepare("SELECT final_verdict AS verdict, COUNT(*) AS count FROM inspections GROUP BY final_verdict").all(),
    env.DB.prepare("SELECT clause, MIN(title) AS title, COUNT(*) AS count FROM violations GROUP BY clause ORDER BY count DESC LIMIT 6").all(),
  ]);
  return json({
    ok: true,
    stats: {
      total: totals?.total ?? 0, compliant: totals?.compliant ?? 0,
      overrides: totals?.overrides ?? 0, violations: totals?.violations ?? 0,
      byVerdict: byVerdict.results, topClauses: topClauses.results,
    },
  });
}

/** Evidence photos are served straight from R2 (no auth — <img> tags cannot send headers). */
async function handleImage(env, url) {
  const m = url.pathname.match(/^\/api\/images\/([A-Z0-9-]+)\/(\d+)\.jpg$/);
  if (!m) return json({ ok: false, error: "Not found." }, 404);
  const obj = await env.EVIDENCE.get(imageKey(m[1], Number(m[2])));
  if (!obj) return json({ ok: false, error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API errors must always come back as JSON, never a platform HTML page.
    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/health") {
          const hasKey = Boolean(env.GEMINI_API_KEY || env.GEMINI_API_KEY1 || env.GEMINI_API_KEY2 || env.GEMINI_API_KEY3);
          return json({ ok: true, hasKey });
        }
        if (url.pathname === "/api/scan") {
          if (request.method !== "POST") return json({ ok: false, error: "POST only." }, 405);
          return await handleScan(request, env);
        }
        if (url.pathname.startsWith("/api/images/")) {
          return await handleImage(env, url);
        }
        if (url.pathname === "/api/inspections" || url.pathname.startsWith("/api/inspections/")) {
          if (request.headers.get("x-lmpc-auth") !== APP_PASSWORD) return json({ ok: false, error: "Not authorised." }, 401);
          return await handleInspections(request, env, url);
        }
        if (url.pathname === "/api/stats") {
          if (request.headers.get("x-lmpc-auth") !== APP_PASSWORD) return json({ ok: false, error: "Not authorised." }, 401);
          return await handleStats(env);
        }
        if (url.pathname.startsWith("/api/barcode/")) {
          if (request.headers.get("x-lmpc-auth") !== APP_PASSWORD) return json({ ok: false, error: "Not authorised." }, 401);
          const code = url.pathname.split("/").pop();
          if (!/^\d{8,14}$/.test(code)) return json({ ok: false, error: "Invalid barcode." }, 400);
          const upstream = await fetch(
            `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,quantity,countries`,
            {
              headers: { "user-agent": "LMPC-Compliance-Checker/0.1 (SIH 2026 prototype)" },
              cf: { cacheTtl: 86400, cacheEverything: true },
            }
          );
          const data = await upstream.json();
          if (data.status === 1 && data.product) {
            const p = data.product;
            return json({
              ok: true, found: true, source: "Open Food Facts",
              product: { name: p.product_name ?? null, brands: p.brands ?? null, quantity: p.quantity ?? null, countries: p.countries ?? null },
            });
          }
          return json({ ok: true, found: false, source: "Open Food Facts" });
        }
        return json({ ok: false, error: "Unknown endpoint." }, 404);
      } catch (err) {
        return json({ ok: false, error: `Server error: ${err.message}` }, 500);
      }
    }
    // Anything else falls through to static assets.
    return env.ASSETS.fetch(request);
  },
};
