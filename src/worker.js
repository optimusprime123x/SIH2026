/**
 * LMPC Compliance Checker — Cloudflare Worker backend.
 * Serves static assets (via the assets binding) and exposes:
 *   POST /api/scan   — forwards package images to Gemini, returns structured label extraction
 *   GET  /api/health — reports whether a Gemini key is configured
 *
 * The worker only EXTRACTS label data. Compliance is decided by the
 * deterministic rules engine on the client (public/js/rules.js).
 */

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const API_REVISION = "2026-05-20";
const APP_PASSWORD = "SIH2026"; // prototype-only shared password

/** A declaration field: verbatim text + found flag. */
const decl = (extra = {}) => ({
  type: "object",
  properties: {
    found: { type: "boolean", description: "True only if this declaration is actually visible on the label." },
    text: { type: ["string", "null"], description: "The verbatim text as printed on the label, or null." },
    ...extra,
  },
  required: ["found", "text", ...Object.keys(extra)],
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
            found: { type: "boolean" },
            mark: { type: "string", enum: ["green", "red_brown", "none"] },
          },
          required: ["found", "mark"],
        },
        gm_declaration: decl(),
        sticker_over_declaration: {
          type: "object",
          properties: {
            present: { type: "boolean", description: "True if a sticker appears pasted over or altering any mandatory declaration." },
            covers_mrp: { type: "boolean", description: "True if a sticker covers or obscures the original printed MRP." },
          },
          required: ["present", "covers_mrp"],
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
    label_legibility: { type: "string", enum: ["good", "partial", "poor"], description: "How readable the photographed label is." },
    notes: { type: ["string", "null"], description: "Anything unusual an inspector should know (stickers over declarations, damaged label, etc.)." },
  },
  required: ["product", "declarations", "languages_detected", "barcode_visible", "barcode_digits", "label_legibility", "notes"],
};

const EXTRACTION_PROMPT = `You are the extraction layer of a Legal Metrology (Packaged Commodities) Rules, 2011 inspection tool used by Indian enforcement officers.

You will receive 1–5 photographs of the SAME packaged commodity (different sides/angles). Read every piece of printed text on the package and fill the JSON schema.

STRICT RULES:
- You only READ and TRANSCRIBE. You never judge legality or compliance — a separate deterministic rules engine does that.
- Copy text VERBATIM, preserving spelling, casing and units exactly as printed (if the pack says "500 gms", report unit "gms", not "g").
- Mark found=true only when the declaration is genuinely visible in the images. Never invent or autocomplete missing details.
- If text is partially unreadable, transcribe what is readable and mention the problem in notes.
- The manufacturer declaration is the "Manufactured by / Mfd. by / Marketed by" block; record in its "role" field which wording is actually used ("marketed_by" if only Marketed by appears). The packer is "Packed by"; the importer is "Imported by".
- consumer_care is the customer-complaints contact block (name/address/phone/email).
- unit_sale_price is a per-unit price like "₹0.85/g" if printed.
- mfg_date is the month/year (or full date) declaration; record in "date_kind" whether it is labelled as manufacture (Mfd/Mfg), packing (Pkd) or import. best_before is a "best before / use by / expiry" declaration.
- gm_declaration: any "GM" genetically-modified marking. sticker_over_declaration: whether any sticker is pasted over/altering mandatory declarations, and whether it covers the printed MRP.
- barcode_digits: if a barcode is visible, transcribe the digits printed beneath it exactly (no spaces).`;

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
    manufacturer: { found: true, text: "Mfd. by: HillFresh Beverages Pvt. Ltd., Plot 12, MIDC Phase II, Pune, Maharashtra - 411057", has_complete_address: true, role: "manufactured_by" },
    packer: { found: false, text: null },
    importer: { found: false, text: null },
    country_of_origin: { found: false, text: null },
    generic_name: { found: true, text: "Instant Coffee Powder", is_brand_only: false },
    net_quantity: { found: true, text: "Net Wt. 100 gms", value: 100, unit: "gms", qualifying_words: null },
    mrp: { found: true, text: "MRP Rs. 245.00", value: 245, currency: "Rs.", tax_inclusive_text: null },
    mfg_date: { found: true, text: "Pkd. 05/2026", date_kind: "packing" },
    best_before: { found: true, text: "Best before 18 months from packaging" },
    consumer_care: { found: true, text: "For complaints: care@hillfresh.in", has_phone: false, has_email: true, has_address: false },
    unit_sale_price: { found: false, text: null },
    dimensions: { found: false, text: null },
    veg_nonveg_mark: { found: true, mark: "green" },
    gm_declaration: { found: false, text: null },
    sticker_over_declaration: { present: false, covers_mrp: false },
  },
  languages_detected: ["English"],
  barcode_visible: true,
  barcode_digits: "8901234567895",
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
