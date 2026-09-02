/**
 * Deterministic rules engine — Legal Metrology (Packaged Commodities) Rules, 2011.
 * Input : the Gemini extraction JSON (see src/worker.js schema).
 * Output: an ordered list of check results with exact clause citations.
 *
 * This layer is pure and deterministic: same extraction, same verdict, every time.
 */

const STATUS = {
  PASS: "pass",           // declaration present and conforms
  VIOLATION: "violation", // statutory violation with clause citation
  MISSING: "missing",     // mandatory declaration absent
  REVIEW: "review",       // inspector judgement / calibration needed
  NA: "na",               // rule not applicable to this product
};

// --- Net quantity unit vocabulary (Rule 13 — SI units) -----------------------

// Correct SI symbols accepted as-is.
const STANDARD_UNITS = new Set([
  "g", "kg", "mg", "ml", "l", "cl", "cm", "m", "mm", "n", "u", "pc", "pcs", "piece", "pieces", "pair", "pairs", "sheet", "sheets", "tablet", "tablets", "capsule", "capsules", "sachet", "sachets",
]);

// Informal / plural / abbreviated Indian-market variants of metric units → what should be printed.
const NON_STANDARD_UNITS = {
  "gms": "g", "gm": "g", "grm": "g", "grms": "g", "gs": "g",
  "kgs": "kg", "kg's": "kg", "kgs.": "kg", "kilo": "kg", "kilos": "kg",
  "ltr": "l", "ltrs": "l", "lt": "l", "lts": "l", "litr": "l",
  "mls": "ml", "ml's": "ml", "mltr": "ml",
  "mtr": "m", "mtrs": "m", "cms": "cm", "mms": "mm",
  "nos": "N", "nos.": "N", "no.": "N",
};

// Spelled-out metric words — Rule 13 requires the standard symbol.
const SPELLED_OUT_UNITS = {
  "gram": "g", "grams": "g", "kilogram": "kg", "kilograms": "kg",
  "millilitre": "ml", "millilitres": "ml", "milliliter": "ml", "milliliters": "ml",
  "litre": "l", "litres": "l", "liter": "l", "liters": "l",
  "metre": "m", "metres": "m", "meter": "m", "meters": "m",
  "centimetre": "cm", "centimetres": "cm", "centimeter": "cm", "centimeters": "cm",
};

// Non-metric units are outright violations of the SI requirement.
const IMPERIAL_UNITS = ["oz", "fl oz", "floz", "lb", "lbs", "pound", "pounds", "gallon", "gallons", "qt", "quart", "pint", "inch", "inches", "in.", "ft", "feet", "yard", "yards", "cc"];

// Matched with word boundaries to avoid false hits inside other words
// ("Vitamin." must not match "min.", "Est. 1975" is not a quantity qualifier).
const QUALIFIER_WORDS = ["about", "approx", "approximately", "around", "nearly", "minimum", "min.", "not less than"];
const hasQualifier = (text) =>
  QUALIFIER_WORDS.find((w) => new RegExp("\\b" + w.replace(/\./g, "\\.").replace(/\s+/g, "\\s+") + "(?![a-z])").test(text));

// One tolerant pattern instead of a literal list: matches "inclusive of all taxes",
// "incl. of all taxes", "(Incl.of all taxes)", "Inc. of taxes", "including all taxes"…
const TAX_INCLUSIVE_RE = /\binc(?:l[a-z]*)?\.?\s*(?:of\s*)?(?:all\s*)?tax/;

const INDIAN_CURRENCY = ["₹", "rs", "rs.", "inr", "rupees", "rupee", "रु", "रू", "₨"];
const FOREIGN_CURRENCY = ["$", "usd", "€", "eur", "£", "gbp", "¥", "aed", "cny", "jpy"];

const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// -----------------------------------------------------------------------------

const norm = (s) => (s ?? "").toString().trim().toLowerCase();

function check(id, group, clause, title, requirement, box_2d = null, image_index = null) {
  return {
    id, group, clause, title, requirement,
    extracted: null,       // verbatim label text shown to the inspector
    status: STATUS.REVIEW,
    severity: null,        // 'critical' | 'major' | 'minor'
    findings: [],          // human sentences describing what the rules matched
    box_2d,
    image_index,
  };
}

function parseMonthYear(text) {
  const t = norm(text);
  // month word DIRECTLY next to its year: "May 2026", "SEP.2025", "dec, 2027"
  // (single anchored match so "Marketed by" can never read as "mar").
  const word = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*((?:19|20)\d{2})\b/);
  if (word) {
    return { month: MONTH_WORDS.indexOf(word[1]) + 1, year: parseInt(word[2], 10), twoDigitYear: false };
  }
  // year-first: "2026/05", "2026-05"
  const yearFirst = t.match(/\b(20\d{2})[\/\-.](\d{1,2})\b/);
  if (yearFirst) {
    const month = parseInt(yearFirst[2], 10);
    if (month >= 1 && month <= 12) return { month, year: parseInt(yearFirst[1], 10), twoDigitYear: false };
  }
  // numeric month + 4/2-digit year: 05/2026, 5-26, 05.2026, 13/05/2026
  const numeric = t.match(/(\d{1,2})[\/\-.](?:(\d{1,2})[\/\-.])?(\d{2,4})/);
  if (numeric) {
    const parts = [numeric[1], numeric[2], numeric[3]].filter(Boolean);
    const year = parts[parts.length - 1];
    let month = parseInt(parts.length === 3 ? parts[1] : parts[0], 10);
    if (parts.length === 3 && month > 12) month = parseInt(parts[0], 10); // dd/mm/yyyy vs mm/dd
    const fullYear = year.length === 2 ? 2000 + parseInt(year, 10) : parseInt(year, 10);
    if (month >= 1 && month <= 12 && fullYear >= 2000 && fullYear <= 2100) {
      return { month, year: fullYear, twoDigitYear: year.length === 2 };
    }
  }
  return null;
}

/**
 * Compute the legally expected statutory Unit Sale Price (USP) and base unit
 * under Rule 6(11) of the Legal Metrology (Packaged Commodities) Rules, 2011.
 */
function computeExpectedUSP(mrp, netQty) {
  if (!mrp || typeof mrp.value !== "number" || mrp.value <= 0) return null;
  if (!netQty || typeof netQty.value !== "number" || netQty.value <= 0 || !netQty.unit) return null;

  const price = mrp.value;
  const qty = netQty.value;
  const unitRaw = norm(netQty.unit).replace(/\.$/, "");
  const canonicalUnit = NON_STANDARD_UNITS[unitRaw] || SPELLED_OUT_UNITS[unitRaw] || unitRaw;

  // Mass / Weight
  if (["g", "kg", "mg"].includes(canonicalUnit)) {
    const totalGrams = canonicalUnit === "kg" ? qty * 1000 : canonicalUnit === "mg" ? qty / 1000 : qty;
    if (totalGrams >= 1000) {
      const kg = totalGrams / 1000;
      const isExempt = totalGrams === 1000;
      return {
        category: "mass",
        expectedBaseUnit: "kg",
        expectedPrice: Math.round((price / kg) * 100) / 100,
        rawPrice: price / kg,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${kg} kg`,
      };
    } else {
      const isExempt = totalGrams === 1;
      return {
        category: "mass",
        expectedBaseUnit: "g",
        expectedPrice: Math.round((price / totalGrams) * 100) / 100,
        rawPrice: price / totalGrams,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${totalGrams} g`,
      };
    }
  }

  // Volume / Liquid
  if (["ml", "l", "cl"].includes(canonicalUnit)) {
    const totalMl = canonicalUnit === "l" ? qty * 1000 : canonicalUnit === "cl" ? qty * 10 : qty;
    if (totalMl >= 1000) {
      const litres = totalMl / 1000;
      const isExempt = totalMl === 1000;
      return {
        category: "volume",
        expectedBaseUnit: "l",
        expectedPrice: Math.round((price / litres) * 100) / 100,
        rawPrice: price / litres,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${litres} L`,
      };
    } else {
      const isExempt = totalMl === 1;
      return {
        category: "volume",
        expectedBaseUnit: "ml",
        expectedPrice: Math.round((price / totalMl) * 100) / 100,
        rawPrice: price / totalMl,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${totalMl} ml`,
      };
    }
  }

  // Dimensions / Length
  if (["cm", "m", "mm"].includes(canonicalUnit)) {
    const totalCm = canonicalUnit === "m" ? qty * 100 : canonicalUnit === "mm" ? qty / 10 : qty;
    if (totalCm >= 100) {
      const metres = totalCm / 100;
      const isExempt = totalCm === 100;
      return {
        category: "length",
        expectedBaseUnit: "m",
        expectedPrice: Math.round((price / metres) * 100) / 100,
        rawPrice: price / metres,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${metres} m`,
      };
    } else {
      const isExempt = totalCm === 1;
      return {
        category: "length",
        expectedBaseUnit: "cm",
        expectedPrice: Math.round((price / totalCm) * 100) / 100,
        rawPrice: price / totalCm,
        isExempt,
        formula: `₹${price.toFixed(2)} ÷ ${totalCm} cm`,
      };
    }
  }

  // Count / Numbers (units, pieces, N, U)
  if (["n", "u", "pc", "pcs", "piece", "pieces", "pair", "pairs", "sheet", "sheets", "tablet", "tablets", "capsule", "capsules", "sachet", "sachets"].includes(canonicalUnit)) {
    const isExempt = qty === 1;
    return {
      category: "count",
      expectedBaseUnit: ["n", "u"].includes(canonicalUnit) ? canonicalUnit.toUpperCase() : "N",
      expectedPrice: Math.round((price / qty) * 100) / 100,
      rawPrice: price / qty,
      isExempt,
      formula: `₹${price.toFixed(2)} ÷ ${qty} N`,
    };
  }

  return null;
}

/**
 * Parse human-declared USP text from the label (e.g. "₹0.85/g", "Rs. 45 per 100g", "USP Rs 12.50/N").
 */
function parseDeclaredUSP(text) {
  if (!text || typeof text !== "string") return null;
  const t = norm(text).replace(/,/g, "");

  // Check for non-standard multiplier base: "100g", "100 ml", "50g", "dozen", etc.
  let multiplier = 1;
  let isIllegalMultiplier = false;
  const multiMatch = t.match(/(?:per|\/)\s*(\d+)\s*(g|gm|gms|gram|grams|kg|kgs|ml|mls|l|ltr|litre|cm|m|n|u|pc|piece|unit)\b/);
  if (multiMatch && parseInt(multiMatch[1], 10) > 1) {
    multiplier = parseInt(multiMatch[1], 10);
    isIllegalMultiplier = true;
  } else if (/\bdozen\b/.test(t)) {
    multiplier = 12;
    isIllegalMultiplier = true;
  }

  // Match the price: prefer the number attached to a currency marker so
  // "1 kg = ₹510" reads 510, not 1. Fall back to the first number.
  let price = null;
  const currencyMatch =
    t.match(/(?:₹|rs\.?|inr|rupees)\s*[:=-]?\s*(\d+(?:\.\d+)?)/) ||
    t.match(/(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|inr|rupees)\b/);
  if (currencyMatch) {
    price = parseFloat(currencyMatch[1]);
  } else {
    const priceMatch = t.match(/(?:usp|price|unit\s*sale\s*price|rate)\s*[:=-]?\s*(\d+(?:\.\d+)?)/) || t.match(/(\d+(?:\.\d+)?)/);
    if (priceMatch) price = parseFloat(priceMatch[1]);
  }

  // Match declared unit
  let declaredUnit = null;
  const unitMatch = t.match(/(?:per|\/)\s*(?:\d+\s*)?(kg|kgs|kilogram|g|gm|gms|gram|grams|mg|ml|mls|millilitre|l|lt|ltr|litre|cm|m|meter|n|u|pc|pcs|piece|pieces|unit|units|pair|sheet|tablet|capsule|sachet)\b/);
  if (unitMatch) {
    const rawU = unitMatch[1];
    declaredUnit = NON_STANDARD_UNITS[rawU] || SPELLED_OUT_UNITS[rawU] || rawU;
  }

  return {
    raw: text,
    price,
    multiplier,
    isIllegalMultiplier,
    declaredUnit,
  };
}

/** Main entry: extraction JSON -> array of check results. */
function runRulesEngine(extraction) {
  const d = extraction?.declarations ?? {};
  const product = extraction?.product ?? {};
  const results = [];

  const G1 = "Mandatory declarations — Rule 6";
  const G2 = "Quantity, units & price format — Rules 11–13";
  const G3 = "Placement, size & legibility — Rules 7–9";

  // "Imported" from evidence, not just the model's overall guess: an importer
  // block or a foreign "Made in …" is decisive on its own.
  const originText = norm(d.country_of_origin?.text);
  const isImported = Boolean(
    product.appears_imported ||
    d.importer?.found ||
    (originText && /made in (?!india)/.test(originText)) ||
    (originText && /\b(country of origin|origin)\b/.test(originText) && !originText.includes("india"))
  );

  // ---- Rule 6(1)(a) / Rule 10 — Manufacturer / packer / importer ------------
  {
    const c = check("manufacturer", G1, "Rule 6(1)(a), Rule 10", "Manufacturer / packer / importer",
      "Name and complete address of the manufacturer (and packer if different; importer for imports) must be declared.");
    const m = d.manufacturer ?? {};
    c.box_2d = m.box_2d || d.packer?.box_2d || d.importer?.box_2d || null;
    c.image_index = m.image_index ?? d.packer?.image_index ?? d.importer?.image_index ?? null;
    const parts = [m.found && m.text, d.packer?.found && `Packed by: ${d.packer.text}`, d.importer?.found && `Imported by: ${d.importer.text}`].filter(Boolean);
    c.extracted = parts.length ? parts.join("  •  ") : null;
    if (!m.found && !d.packer?.found && !d.importer?.found) {
      c.status = STATUS.MISSING; c.severity = "critical";
      c.findings.push("No manufacturer, packer or importer declaration found on the label — mandatory under Rule 6(1)(a).");
    } else {
      if (m.found && m.role === "marketed_by" && !d.packer?.found && !d.importer?.found) {
        c.status = STATUS.VIOLATION; c.severity = "major";
        c.findings.push('Only a "Marketed by" block appears — Rule 6(1)(a) requires the manufacturer (or packer/importer) to be named, not just the marketer.');
      } else if (m.found && m.has_complete_address === false) {
        c.status = STATUS.VIOLATION; c.severity = "major";
        c.findings.push("Name present but the address does not appear to be a complete postal address (Rule 6(1)(a) requires the complete address).");
      } else {
        c.status = STATUS.PASS;
        c.findings.push("Responsible-party name and address declared.");
      }
      if (isImported && !d.importer?.found) {
        c.status = STATUS.VIOLATION; c.severity = c.severity ?? "major";
        c.findings.push("Product appears imported but no importer name/address is declared (Rule 10(2)).");
      }
    }
    results.push(c);
  }

  // ---- Rule 6(1)(aa) — Country of origin ------------------------------------
  {
    const c = check("origin", G1, "Rule 6(1)(aa)", "Country of origin",
      "Imported packages must declare the country of origin, manufacture or assembly.");
    const o = d.country_of_origin ?? {};
    c.box_2d = o.box_2d || null;
    c.image_index = o.image_index ?? null;
    c.extracted = o.found ? o.text : null;
    if (!isImported) {
      c.status = o.found ? STATUS.PASS : STATUS.NA;
      c.findings.push(o.found ? "Country of origin declared (product appears domestic; declaration is optional)." : "Product appears domestically manufactured — declaration not required.");
    } else if (o.found) {
      c.status = STATUS.PASS;
      c.findings.push("Country of origin declared for imported product.");
    } else {
      c.status = STATUS.MISSING; c.severity = "major";
      c.findings.push("Product appears imported but no country of origin is declared — required by Rule 6(1)(aa).");
    }
    results.push(c);
  }

  // ---- Rule 6(1)(b) — Common / generic name ---------------------------------
  {
    const c = check("generic-name", G1, "Rule 6(1)(b)", "Common or generic name",
      "The commodity must be identified by its common or generic name; a brand name alone is not sufficient.");
    const g = d.generic_name ?? {};
    c.box_2d = g.box_2d || null;
    c.image_index = g.image_index ?? null;
    c.extracted = g.found ? g.text : null;
    if (g.found && !g.is_brand_only) {
      c.status = STATUS.PASS;
      c.findings.push("Generic name of the commodity declared.");
    } else if (g.found && g.is_brand_only) {
      c.status = STATUS.VIOLATION; c.severity = "major";
      c.findings.push("Only a brand name appears; the common/generic name of the commodity is required by Rule 6(1)(b).");
    } else {
      c.status = STATUS.MISSING; c.severity = "major";
      c.findings.push("No common or generic name found on the label.");
    }
    results.push(c);
  }

  // ---- Rule 6(1)(c) / Rules 11–13 — Net quantity ----------------------------
  {
    const c = check("net-quantity", G2, "Rule 6(1)(c), Rules 11–13", "Net quantity declaration",
      "Net quantity (excluding packaging) must be declared in standard SI units, with no qualifying words.");
    const q = d.net_quantity ?? {};
    c.box_2d = q.box_2d || null;
    c.image_index = q.image_index ?? null;
    c.extracted = q.found ? q.text : null;
    if (!q.found) {
      c.status = STATUS.MISSING; c.severity = "critical";
      c.findings.push("No net quantity declaration found — mandatory under Rule 6(1)(c).");
    } else {
      let violated = false;
      let needsReview = false;

      // Qualifying words — Rule 6(1)(c) read with Rule 11
      const qtext = norm(`${q.text ?? ""} ${q.qualifying_words ?? ""}`);
      const qualifier = hasQualifier(qtext);
      if (qualifier) {
        violated = true; c.severity = "major";
        c.findings.push(`Qualifying word "${qualifier}" used with the quantity — words like about/approx/minimum are prohibited (Rule 6(1)(c) read with Rule 11).`);
      }

      // Unit vocabulary — Rule 13(5)(i) requires SI symbols
      const unitRaw = norm(q.unit).replace(/\.$/, "");
      if (unitRaw) {
        if (NON_STANDARD_UNITS[unitRaw]) {
          violated = true; c.severity = c.severity ?? "major";
          c.findings.push(`Non-standard unit "${q.unit}" used — the SI symbol "${NON_STANDARD_UNITS[unitRaw]}" is required (Rule 13(5)).`);
        } else if (SPELLED_OUT_UNITS[unitRaw]) {
          violated = true; c.severity = c.severity ?? "minor";
          c.findings.push(`Unit written as the word "${q.unit}" — the standard symbol "${SPELLED_OUT_UNITS[unitRaw]}" should be used (Rule 13(5)).`);
        } else if (IMPERIAL_UNITS.includes(unitRaw)) {
          violated = true; c.severity = "major";
          c.findings.push(`Non-metric unit "${q.unit}" used — the International System of Units is mandatory (Rule 13).`);
        } else if (!STANDARD_UNITS.has(unitRaw)) {
          needsReview = true;
          c.findings.push(`Unit "${q.unit}" is not in the known vocabulary — verify it is a standard SI unit (Rule 13).`);
        }
      }

      // Magnitude vs unit — Rule 13(2): <1 kg in g, ≥1 kg in kg; same for volume
      const val = typeof q.value === "number" ? q.value : null;
      const canonical = NON_STANDARD_UNITS[unitRaw] || SPELLED_OUT_UNITS[unitRaw] || unitRaw;
      if (val !== null) {
        if (canonical === "g" && val >= 1000) {
          violated = true; c.severity = c.severity ?? "minor";
          c.findings.push(`Quantity of ${val} g should be expressed in kilograms — quantities of 1 kg or more use kg (Rule 13(2)).`);
        }
        if (canonical === "kg" && val < 1) {
          violated = true; c.severity = c.severity ?? "minor";
          c.findings.push(`Quantity below 1 kg should be expressed in grams (Rule 13(2)).`);
        }
        if (canonical === "ml" && val >= 1000) {
          violated = true; c.severity = c.severity ?? "minor";
          c.findings.push(`Quantity of ${val} ml should be expressed in litres (Rule 13(2)).`);
        }
        if (canonical === "l" && val < 1) {
          violated = true; c.severity = c.severity ?? "minor";
          c.findings.push(`Quantity below 1 litre should be expressed in millilitres (Rule 13(2)).`);
        }
      }

      if (violated) {
        c.status = STATUS.VIOLATION;
      } else if (needsReview) {
        c.status = STATUS.REVIEW;
      } else {
        c.status = STATUS.PASS;
        if (!c.findings.length) c.findings.push("Net quantity declared in a standard unit with no qualifying words.");
      }
    }
    results.push(c);
  }

  // ---- Rule 6(1)(d) — Month & year of manufacture ---------------------------
  {
    const c = check("mfg-date", G1, "Rule 6(1)(d)", "Month & year of manufacture",
      "The month and year of manufacture must be declared (general rule after the 2021 amendment).");
    const m = d.mfg_date ?? {};
    c.box_2d = m.box_2d || null;
    c.image_index = m.image_index ?? null;
    c.extracted = m.found ? m.text : null;
    if (!m.found) {
      c.status = STATUS.MISSING; c.severity = "critical";
      c.findings.push("No month/year of manufacture found — mandatory under Rule 6(1)(d).");
    } else {
      const parsed = parseMonthYear(m.text);
      if (!parsed) {
        c.status = STATUS.REVIEW;
        c.findings.push("A date declaration was found but the month/year could not be read in a standard format — verify manually.");
      } else {
        const now = new Date();
        const isFuture = parsed.year > now.getFullYear() || (parsed.year === now.getFullYear() && parsed.month > now.getMonth() + 1);
        if (isFuture) {
          c.status = STATUS.VIOLATION; c.severity = "major";
          c.findings.push(`Declared date (${String(parsed.month).padStart(2, "0")}/${parsed.year}) is in the future — misleading declaration.`);
        } else {
          c.status = STATUS.PASS;
          c.findings.push(`Month and year declared (${String(parsed.month).padStart(2, "0")}/${parsed.year}).`);
          if (parsed.twoDigitYear) c.findings.push("Year printed with two digits — acceptable but four digits recommended for clarity.");
        }
      }
      // The 2021 amendment requires the MANUFACTURE month/year; a packing-only
      // date is not automatically equivalent.
      if (m.date_kind === "packing" && c.status === STATUS.PASS) {
        c.status = STATUS.REVIEW;
        c.findings.push('Date is labelled as packing ("Pkd.") — Rule 6(1)(d) as amended in 2021 requires the month and year of MANUFACTURE. Verify whether a manufacture date appears elsewhere on the pack.');
      }
      // Sectoral overrides (info brief: food → FSS law, cosmetics → D&C Rules, seeds → Seeds Act)
      if (["food", "cosmetic"].includes(product.category)) {
        c.findings.push(`Note: for ${product.category} products the date declaration is also governed by ${product.category === "food" ? "the Food Safety & Standards regulations" : "the Drugs & Cosmetics Rules"}.`);
      }
    }
    results.push(c);
  }

  // ---- Rule 6(1)(da) — Best before / use by ---------------------------------
  {
    const c = check("best-before", G1, "Rule 6(1)(da)", "Best before / use by date",
      "Required where the commodity may become unfit for human consumption over time (food-type products).");
    const b = d.best_before ?? {};
    c.box_2d = b.box_2d || null;
    c.image_index = b.image_index ?? null;
    c.extracted = b.found ? b.text : null;
    if (b.found) {
      c.status = STATUS.PASS;
      c.findings.push("Best-before / use-by declaration present.");
    } else if (product.category === "food") {
      c.status = STATUS.REVIEW;
      c.findings.push("Food-type product with no visible best-before date. FSSAI labelling law may govern this date — verify under the applicable regime.");
    } else {
      c.status = STATUS.NA;
      c.findings.push("Product is not consumable — best-before declaration not applicable.");
    }
    results.push(c);
  }

  // ---- Rule 6(1)(e) — MRP ---------------------------------------------------
  {
    const c = check("mrp", G2, "Rule 6(1)(e)", "Maximum Retail Price",
      "MRP must be declared in Indian currency and clearly stated as inclusive of all taxes.");
    const m = d.mrp ?? {};
    c.box_2d = m.box_2d || null;
    c.image_index = m.image_index ?? null;
    c.extracted = m.found ? m.text : null;
    if (!m.found) {
      c.status = STATUS.MISSING; c.severity = "critical";
      c.findings.push("No MRP declaration found — mandatory under Rule 6(1)(e).");
    } else {
      let violated = false;
      let needsReview = false;
      const taxText = norm(`${m.tax_inclusive_text ?? ""} ${m.text ?? ""}`);
      if (!TAX_INCLUSIVE_RE.test(taxText)) {
        violated = true; c.severity = "critical";
        c.findings.push('MRP is not stated as "inclusive of all taxes" — required wording under Rule 6(1)(e).');
      }
      if (!/\bm\.?\s?r\.?\s?p\b|maximum retail price/.test(norm(m.text))) {
        violated = true; c.severity = c.severity ?? "minor";
        c.findings.push('Price is not identified as "MRP" / "Maximum Retail Price" — Rule 6(1)(e) requires the retail price to be clearly so identified.');
      }
      const cur = norm(m.currency);
      if (cur && FOREIGN_CURRENCY.some((f) => cur === f || cur.startsWith(f))) {
        violated = true; c.severity = "critical";
        c.findings.push(`MRP declared in foreign currency ("${m.currency}") — must be in Indian currency.`);
      } else if (cur && !INDIAN_CURRENCY.some((i) => cur === i || cur.startsWith(i))) {
        needsReview = true;
        c.findings.push(`Currency marking "${m.currency}" not recognised — verify it denotes Indian rupees.`);
      }
      if (m.value === null || m.value === undefined) {
        needsReview = true;
        c.findings.push("MRP numeric value could not be read — verify legibility.");
      }
      if (violated) c.status = STATUS.VIOLATION;
      else if (needsReview) c.status = STATUS.REVIEW;
      else {
        c.status = STATUS.PASS;
        c.findings.push("MRP declared in Indian currency, inclusive of all taxes.");
      }
    }
    results.push(c);
  }

  // ---- Rule 6(2) — Consumer care --------------------------------------------
  {
    const c = check("consumer-care", G1, "Rule 6(2)", "Consumer care details",
      "Name, address, telephone number and e-mail of the consumer-complaints contact must be declared.");
    const cc = d.consumer_care ?? {};
    c.box_2d = cc.box_2d || null;
    c.image_index = cc.image_index ?? null;
    c.extracted = cc.found ? cc.text : null;
    if (!cc.found) {
      c.status = STATUS.MISSING; c.severity = "major";
      c.findings.push("No consumer care / complaints contact found — mandatory under Rule 6(2).");
    } else {
      const missing = [];
      if (!cc.has_phone) missing.push("telephone number");
      if (!cc.has_email) missing.push("e-mail address");
      if (!cc.has_address) missing.push("postal address");
      if (missing.length) {
        c.status = STATUS.VIOLATION; c.severity = "major";
        c.findings.push(`Consumer care block is incomplete — missing ${missing.join(", ")} (Rule 6(2) requires name, address, phone and e-mail).`);
      } else {
        c.status = STATUS.PASS;
        c.findings.push("Complete consumer care contact declared.");
      }
    }
    results.push(c);
  }

  // ---- Rule 6(11) — Unit sale price ------------------------------------------
  {
    const c = check("unit-sale-price", G2, "Rule 6(11)", "Unit sale price (USP)",
      "Price per standard base unit (per g/kg/ml/l/cm/m/N) rounded to two decimals (mandatory for packages > 1g/ml/piece).");
    const u = d.unit_sale_price ?? {};
    const mrp = d.mrp ?? {};
    const netQty = d.net_quantity ?? {};

    c.box_2d = u.box_2d || null;
    c.image_index = u.image_index ?? null;
    c.extracted = u.found ? u.text : null;

    const expected = computeExpectedUSP(mrp, netQty);
    c.math = expected; // Attach math calculation details for UI and reports

    if (expected?.isExempt) {
      // Proviso to Rule 6(11): not mandatory when MRP equals unit price (e.g. exactly 1kg, 1L, 1 piece)
      c.status = STATUS.PASS;
      c.findings.push(`Net quantity is exactly 1 standard unit (${netQty.value} ${netQty.unit}) — exempt from separate USP declaration under Rule 6(11) proviso (MRP equals unit price).`);
      if (u.found) {
        c.findings.push(`Unit sale price is declared on the pack as "${u.text}".`);
      }
    } else if (!u.found) {
      c.status = STATUS.REVIEW;
      if (expected) {
        c.findings.push(`No Unit Sale Price visible on the label. Under Rule 6(11), the calculated statutory unit price is ₹${expected.expectedPrice.toFixed(2)} per ${expected.expectedBaseUnit} (${expected.formula}) — inspector to confirm if package qualifies for multi-pack/bulk exemption or if physical label bears USP.`);
      } else {
        c.findings.push("No unit sale price visible. Mandatory under Rule 6(11) for all multi-unit / variable-quantity packages — verify on physical pack.");
      }
    } else {
      // USP declared -> verify arithmetic accuracy and standard unit rules
      const parsed = parseDeclaredUSP(u.text);
      let violated = false;
      let needsReview = false;

      if (!parsed || parsed.price === null) {
        needsReview = true;
        c.findings.push(`Unit sale price text "${u.text}" could not be parsed into a numeric value — verify legibility.`);
      } else if (parsed.isIllegalMultiplier) {
        // e.g. "per 100g", "per 50ml", "per dozen"
        violated = true;
        c.severity = "major";
        c.findings.push(`Non-compliant base unit: USP is declared per ${parsed.multiplier}${parsed.declaredUnit || "units"} ("${u.text}"). Rule 6(11) strictly requires price per 1 ${expected?.expectedBaseUnit || "base unit"} (packages ${netQty.value <= 1000 ? "≤ 1kg/1L" : "> 1kg/1L"} must use per ${expected?.expectedBaseUnit || "unit"}).`);
      } else if (expected) {
        // Check unit match (e.g. per kg when pack is 500g, or per g when pack is 5kg)
        const decU = norm(parsed.declaredUnit);
        const expU = norm(expected.expectedBaseUnit);
        if (decU && decU !== expU && !(decU === "piece" && expU === "n")) {
          violated = true;
          c.severity = "major";
          c.findings.push(`Incorrect base unit: USP declared per "${parsed.declaredUnit}" ("${u.text}"). Rule 6(11) mandates declaration per "${expected.expectedBaseUnit}" for ${netQty.value} ${netQty.unit}.`);
        }

        // Arithmetic accuracy check
        const effectivePrice = parsed.price / parsed.multiplier;
        const diff = Math.abs(effectivePrice - expected.rawPrice);
        if (diff > 0.05) {
          violated = true;
          c.severity = "major";
          c.findings.push(`USP Math Discrepancy: Label declares "${u.text}" (effective ₹${effectivePrice.toFixed(2)}/${expU}), but the true computed unit price is ₹${expected.expectedPrice.toFixed(2)} per ${expected.expectedBaseUnit} (${expected.formula}) — misleading price declaration under Rule 6(11).`);
        } else {
          c.findings.push(`USP correctly calculated and declared: ₹${expected.expectedPrice.toFixed(2)} per ${expected.expectedBaseUnit} (${expected.formula}).`);
        }
      } else {
        c.findings.push(`Unit sale price declared as "${u.text}".`);
      }

      if (violated) {
        c.status = STATUS.VIOLATION;
      } else if (needsReview) {
        c.status = STATUS.REVIEW;
      } else {
        c.status = STATUS.PASS;
      }
    }
    results.push(c);
  }

  // ---- Rule 6(1)(f) / Rules 14–17 — Dimensions -------------------------------
  {
    const c = check("dimensions", G1, "Rule 6(1)(f), Rules 14–17", "Product dimensions",
      "Dimensions must be declared where size is relevant (textiles, foils, containers, size-priced goods).");
    const dim = d.dimensions ?? {};
    c.box_2d = dim.box_2d || null;
    c.image_index = dim.image_index ?? null;
    c.extracted = dim.found ? dim.text : null;
    if (dim.found) {
      c.status = STATUS.PASS;
      c.findings.push("Dimensions declared.");
    } else if (["textile", "household"].includes(product.category)) {
      c.status = STATUS.REVIEW;
      c.findings.push("Category suggests dimensions may be required (Rules 14–17) but none were found — inspector to confirm relevance.");
    } else {
      c.status = STATUS.NA;
      c.findings.push("Size does not appear relevant to this commodity.");
    }
    results.push(c);
  }

  // ---- Rule 6(8) — Veg / non-veg origin mark (cosmetics & toiletries) --------
  {
    const c = check("veg-mark", G1, "Rule 6(8)", "Vegetarian / non-vegetarian origin mark",
      "Cosmetics and toiletries must carry a green dot (vegetarian origin) or red/brown dot (non-vegetarian origin).");
    const v = d.veg_nonveg_mark ?? {};
    c.box_2d = v.box_2d || null;
    c.image_index = v.image_index ?? null;
    c.extracted = !v.found ? null
      : v.mark === "green" ? "Green dot (vegetarian origin)"
      : v.mark === "red_brown" ? "Red/brown dot (non-vegetarian origin)"
      : "Mark present but type unreadable";
    if (product.category === "cosmetic") {
      if (v.found && v.mark !== "none") {
        c.status = STATUS.PASS;
        c.findings.push("Origin mark present.");
      } else {
        c.status = STATUS.MISSING; c.severity = "minor";
        c.findings.push("Cosmetic/toiletry without a vegetarian / non-vegetarian origin dot — required by Rule 6(8).");
      }
    } else if (v.found && v.mark !== "none") {
      c.status = STATUS.PASS;
      c.findings.push("Origin mark present (FSSAI regime for food products).");
    } else {
      c.status = STATUS.NA;
      c.findings.push("Not a cosmetic/toiletry — Rule 6(8) mark not applicable.");
    }
    results.push(c);
  }

  // ---- Rule 9(4) — Language --------------------------------------------------
  {
    const c = check("language", G3, "Rule 9(4)", "Hindi or English declarations",
      "Declarations must be in Hindi (Devanagari) or English; additional languages are permitted.");
    const langs = (extraction?.languages_detected ?? []).map(norm);
    c.extracted = extraction?.languages_detected?.join(", ") || null;
    const hasHindiEnglish = langs.some((l) =>
      l.includes("english") || l.includes("hindi") || l.includes("devanagari") || l === "en" || l === "hi");
    if (hasHindiEnglish) {
      c.status = STATUS.PASS;
      c.findings.push("Declarations available in Hindi/English.");
    } else if (!langs.length) {
      c.status = STATUS.REVIEW;
      c.findings.push("Could not determine the label language — verify manually.");
    } else {
      // Photos may not cover every panel — flag for inspection, don't convict.
      c.status = STATUS.REVIEW;
      c.findings.push(`Only ${c.extracted} detected in the photographed panels — Rule 9(4) requires Hindi or English declarations. Confirm no Hindi/English panel exists before recording a violation.`);
    }
    results.push(c);
  }

  // ---- Rule 9(1) — Legibility ------------------------------------------------
  {
    const c = check("legibility", G3, "Rule 9(1)", "Legibility & prominence",
      "Declarations must be legible, prominent, unambiguous and in contrasting colour for MRP and net quantity.");
    const leg = extraction?.label_legibility;
    c.extracted = leg ? `Photographed label legibility: ${leg}` : null;
    if (leg === "good") {
      c.status = STATUS.PASS;
      c.findings.push("Label text read clearly from the photographs.");
    } else if (leg === "partial") {
      c.status = STATUS.REVIEW;
      c.findings.push("Parts of the label were hard to read — retake photos or inspect physically before concluding.");
    } else {
      c.status = STATUS.REVIEW;
      c.findings.push("Label legibility was poor in the photographs — physical inspection recommended.");
    }
    results.push(c);
  }

  // ---- Rule 6(3) — Stickers altering declarations ----------------------------
  {
    const c = check("sticker", G1, "Rule 6(3)", "Stickers over declarations",
      "No individual sticker may alter or obscure mandatory declarations; a reduced-MRP sticker must not cover the original MRP.");
    const s = d.sticker_over_declaration ?? {};
    c.box_2d = s.box_2d || null;
    c.image_index = s.image_index ?? null;
    if (s.present) {
      c.extracted = s.covers_mrp ? "Sticker covering the printed MRP" : "Sticker over mandatory declarations";
      c.status = STATUS.VIOLATION; c.severity = s.covers_mrp ? "critical" : "major";
      c.findings.push(s.covers_mrp
        ? "A sticker covers the original printed MRP — prohibited by Rule 6(3) (a reduced-MRP sticker must leave the original visible)."
        : "A sticker appears pasted over mandatory declarations — Rule 6(3) prohibits altering declarations by sticker.");
    } else {
      c.status = STATUS.PASS;
      c.findings.push("No sticker altering mandatory declarations detected in the photographs.");
    }
    results.push(c);
  }

  // ---- Rule 6(7) — "GM" for genetically modified food ------------------------
  {
    const c = check("gm", G1, "Rule 6(7)", "Genetically modified declaration",
      "Packages containing genetically modified food must bear the letters 'GM'.");
    const gm = d.gm_declaration ?? {};
    c.box_2d = gm.box_2d || null;
    c.image_index = gm.image_index ?? null;
    c.extracted = gm.found ? gm.text : null;
    if (gm.found) {
      c.status = STATUS.PASS;
      c.findings.push("'GM' declaration present.");
    } else if (product.category === "food") {
      c.status = STATUS.NA;
      c.findings.push("No GM marking found — required only if the food is genetically modified, which cannot be determined from the label alone.");
    } else {
      c.status = STATUS.NA;
      c.findings.push("Not a food product — Rule 6(7) not applicable.");
    }
    results.push(c);
  }

  // ---- Rule 7(2) — Minimum letter height -------------------------------------
  {
    const c = check("font-size", G3, "Rule 7(2)–(3)", "Minimum letter / numeral height",
      "Minimum heights (1–6 mm) apply based on principal display panel area; width ≥ ⅓ height.");
    c.extracted = null;
    c.status = STATUS.REVIEW;
    c.manual = true; // pending physical calibration — must not block a COMPLIANT verdict
    c.findings.push("Millimetre-accurate measurement needs physical scale calibration (₹10 coin / standard card feature — planned). Prototype gives no automated verdict on letter height.");
    results.push(c);
  }

  // ---- Rule 26(a) — small-package exemption ----------------------------------
  // Packages of 10 g / 10 ml or less are exempt from the declaration regime
  // (not applicable to pan masala from 1 Feb 2026).
  {
    const q = d.net_quantity ?? {};
    const unitRaw = norm(q.unit).replace(/\.$/, "");
    const canonical = NON_STANDARD_UNITS[unitRaw] || SPELLED_OUT_UNITS[unitRaw] || unitRaw;
    const isPanMasala = /pan\s*masala/.test(norm(`${d.generic_name?.text ?? ""} ${product.product_description ?? ""}`));
    const isExempt = typeof q.value === "number" && q.value <= 10 && ["g", "ml"].includes(canonical) && !isPanMasala;
    if (isExempt) {
      for (const r of results) {
        if (r.status === STATUS.VIOLATION || r.status === STATUS.MISSING || r.status === STATUS.REVIEW) {
          r.status = STATUS.NA; r.severity = null;
          r.findings.push("Not enforced: package is 10 g / 10 ml or less — exempt under Rule 26(a).");
        }
      }
      const c = check("exemption", G1, "Rule 26(a)", "Small-package exemption",
        "Packages containing 10 g / 10 ml or less are exempt from the declaration requirements (pan masala excluded from 1 Feb 2026).");
      c.extracted = q.text ?? null;
      c.status = STATUS.PASS;
      c.findings.push(`Net quantity ${q.value} ${canonical} — the package qualifies for the Rule 26(a) exemption, so the retail declaration checks above are recorded as not applicable.`);
      results.unshift(c);
    }
  }

  // ---- Rule 24 — wholesale packages ------------------------------------------
  // Wholesale packs are governed by Rule 24, not the retail Rule 6 regime.
  if (product.package_type === "wholesale") {
    const rule24Needs = new Set(["manufacturer", "generic-name", "net-quantity"]);
    for (const r of results) {
      if (rule24Needs.has(r.id) || r.id === "legibility" || r.id === "language") continue;
      if (r.status === STATUS.VIOLATION || r.status === STATUS.MISSING || r.status === STATUS.REVIEW) {
        r.status = STATUS.NA; r.severity = null;
        r.findings.push("Not enforced: wholesale package — Rule 24 requires only the responsible party, commodity identity and quantity/number of retail packs.");
      }
    }
    const c = check("wholesale", G1, "Rule 24", "Wholesale package regime",
      "A wholesale package must state the manufacturer/importer/packer, the identity of the commodity, and the number of retail packages or net quantity.");
    c.status = STATUS.REVIEW;
    c.findings.push("Package identified as WHOLESALE — verify the total retail-pack count or net quantity declaration; retail-only checks above are marked not applicable.");
    results.unshift(c);
  }

  return results;
}

/** A check's effective status: an inspector resolution (pass/violation chosen
 *  in the results pane) supersedes what the engine computed. */
const effectiveStatus = (r) => r.resolution?.status ?? r.status;

/** Overall verdict from the check list — weighted by severity, honouring
 *  inspector resolutions, and ignoring checks flagged `manual`
 *  (calibration-pending) so COMPLIANT stays reachable. */
function computeVerdict(results) {
  const violations = results.filter((r) => [STATUS.VIOLATION, STATUS.MISSING].includes(effectiveStatus(r)));
  const reviews = results.filter((r) => effectiveStatus(r) === STATUS.REVIEW && !r.manual);
  const manualNotes = results.filter((r) => effectiveStatus(r) === STATUS.REVIEW && r.manual);
  const resolved = results.filter((r) => r.resolution).length;
  const counts = tally(results);
  const resolvedNote = resolved ? ` ${resolved} item${resolved > 1 ? "s" : ""} resolved by inspector.` : "";

  if (violations.length) {
    const bySeverity = { critical: 0, major: 0, minor: 0 };
    for (const v of violations) bySeverity[v.severity ?? "major"] += 1;
    const mix = ["critical", "major", "minor"].filter((s) => bySeverity[s]).map((s) => `${bySeverity[s]} ${s}`).join(", ");
    const minorOnly = !bySeverity.critical && !bySeverity.major;
    return {
      verdict: minorOnly ? "MINOR NON-CONFORMITY" : "NON-COMPLIANT",
      summary: `${violations.length} violation${violations.length > 1 ? "s" : ""} (${mix})` +
        (reviews.length ? `, ${reviews.length} item${reviews.length > 1 ? "s" : ""} need review` : "") + "." + resolvedNote,
      counts,
    };
  }
  if (reviews.length) {
    return { verdict: "NEEDS REVIEW", summary: `No violations detected, but ${reviews.length} item${reviews.length > 1 ? "s" : ""} require inspector judgement.` + resolvedNote, counts };
  }
  return {
    verdict: "COMPLIANT",
    summary: "All applicable declarations conform to the checked rules." +
      (manualNotes.length ? " (Letter-height check pending physical calibration.)" : "") + resolvedNote,
    counts,
  };
}

function tally(results) {
  const counts = { pass: 0, violation: 0, missing: 0, review: 0, na: 0 };
  for (const r of results) counts[effectiveStatus(r)] = (counts[effectiveStatus(r)] ?? 0) + 1;
  return counts;
}

window.LMPCRules = {
  runRulesEngine,
  computeVerdict,
  effectiveStatus,
  computeExpectedUSP,
  parseDeclaredUSP,
  STATUS,
};
