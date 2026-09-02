/**
 * PDF report generation — jsPDF + autotable.
 * Produces a formal compliance report with clause citations, suitable for
 * the "digital compliance reports in PDF" requirement of PS 26034.
 */
(function () {
  const NAVY = [10, 37, 64];
  const SAFFRON = [255, 111, 31];
  const GREEN = [15, 139, 76];
  const CRIMSON = [217, 45, 32];
  const MUTED = [107, 114, 128];
  const INK = [17, 24, 39];

  // Standard PDF fonts have no ₹ or Devanagari glyphs — sanitise to Latin-1,
  // but never silently delete Hindi text: mark it so the report stays honest.
  const pdfText = (s) =>
    String(s ?? "")
      .replace(/₹/g, "Rs.")
      .replace(/[•]/g, "-")
      .replace(/[—–]/g, "-")
      .replace(/[ऀ-ॿ][ऀ-ॿ\s.,:;()\/-]*/g, " [Devanagari text - see evidence photos] ")
      .replace(/[^\x00-\xFF]/g, "")
      .replace(/\s{2,}/g, " ");

  const STATUS_LABEL = {
    pass: "COMPLIANT",
    violation: "VIOLATION",
    missing: "MISSING",
    review: "REVIEW",
    na: "N/A",
  };
  const STATUS_COLOR = {
    pass: GREEN,
    violation: CRIMSON,
    missing: CRIMSON,
    review: SAFFRON,
    na: MUTED,
  };

  function verdictColor(verdict) {
    if (verdict === "COMPLIANT") return GREEN;
    if (verdict === "NON-COMPLIANT") return CRIMSON;
    return SAFFRON;
  }

  function exportPdf(record) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const M = 14;

    // ---- header band ----
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, W, 30, "F");
    doc.setFillColor(...SAFFRON);
    doc.rect(0, 30, W, 1.6, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("COMPLIANCE INSPECTION REPORT", M, 13);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("Legal Metrology (Packaged Commodities) Rules, 2011", M, 19.5);
    doc.setFontSize(8);
    doc.setTextColor(200, 210, 225);
    doc.text("Department of Consumer Affairs - Enforcement support tool (SIH 2026 - PS 26034)", M, 24.5);
    doc.setTextColor(255, 255, 255);
    doc.setFont("courier", "bold");
    doc.setFontSize(10);
    doc.text(pdfText(record.id), W - M, 13, { align: "right" });
    doc.setFont("courier", "normal");
    doc.setFontSize(8);
    doc.text(pdfText(new Date(record.ts).toLocaleString("en-IN")), W - M, 19.5, { align: "right" });

    let y = 40;

    // ---- meta + product ----
    const ext = record.extraction || {};
    const p = ext.product || {};
    const metaRows = [
      ["Report ID", record.id, "Scanned by", (record.role || "inspector").toUpperCase()],
      ["Scan date", new Date(record.ts).toLocaleString("en-IN"), "Extraction engine", record.mock ? "MOCK SAMPLE (no API key)" : record.model || "Gemini"],
      ["Brand", p.brand_name || "-", "Category", p.category || "-"],
      ["Commodity", p.product_description || "-", "Package type", p.package_type || "-"],
      ["Appears imported", p.appears_imported ? "Yes" : "No", "Barcodes", record.barcodes?.length ? record.barcodes.map((b) => b.value).join(", ") : "None detected"],
    ];
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      body: metaRows.map((r) => r.map(pdfText)),
      theme: "grid",
      styles: { fontSize: 8.2, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 30, textColor: MUTED },
        1: { cellWidth: 62 },
        2: { fontStyle: "bold", cellWidth: 32, textColor: MUTED },
        3: { cellWidth: "auto" },
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    // ---- verdict box ----
    const finalVerdict = record.override ? record.override.verdict : record.verdict.verdict;
    const vc = verdictColor(finalVerdict);
    doc.setFillColor(...vc);
    doc.rect(M, y, W - 2 * M, 16, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(pdfText(`VERDICT: ${finalVerdict}`), M + 5, y + 7);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.text(pdfText(record.verdict.summary), M + 5, y + 12.5);
    y += 20;

    if (record.override) {
      doc.setDrawColor(...SAFFRON);
      doc.setLineWidth(0.4);
      const note = doc.splitTextToSize(
        pdfText(`ADMIN OVERRIDE - Rules-engine verdict "${record.verdict.verdict}" overridden to "${record.override.verdict}" on ${new Date(record.override.ts).toLocaleString("en-IN")}. Reason: ${record.override.reason}`),
        W - 2 * M - 8
      );
      const h = note.length * 4 + 6;
      if (y + h > 270) { doc.addPage(); y = 20; }
      doc.rect(M, y, W - 2 * M, h);
      doc.setTextColor(...INK);
      doc.setFontSize(8.5);
      doc.text(note, M + 4, y + 5);
      y += h + 5;
    }

    // ---- findings table ----
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.text("RULE-BY-RULE FINDINGS", M, y + 3);
    y += 6;

    const body = record.results.map((r) => {
      const eff = r.resolution?.status ?? r.status;
      const findings = [...r.findings];
      if (r.resolution) {
        findings.push(`[Resolved as ${STATUS_LABEL[eff]} by ${(r.resolution.by || "inspector").toUpperCase()} on ${new Date(r.resolution.ts).toLocaleString("en-IN")}]`);
      }
      return [
        pdfText(r.clause),
        pdfText(r.title),
        pdfText(r.extracted || "- not found -"),
        (STATUS_LABEL[eff] || eff.toUpperCase()) + (r.resolution ? " *" : ""),
        pdfText(findings.join("\n")),
      ];
    });

    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: [["Clause", "Declaration", "Extracted from label (verbatim)", "Status", "Rules engine findings"]],
      body,
      theme: "grid",
      styles: { fontSize: 7.6, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK, valign: "top" },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontSize: 7.8, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 24, font: "courier", fontSize: 7 },
        1: { cellWidth: 28, fontStyle: "bold" },
        2: { cellWidth: 44, font: "courier", fontSize: 7 },
        3: { cellWidth: 20, fontStyle: "bold", halign: "center" },
        4: { cellWidth: "auto" },
      },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 3) {
          const r = record.results[data.row.index];
          const status = r ? (r.resolution?.status ?? r.status) : null;
          data.cell.styles.textColor = STATUS_COLOR[status] || INK;
        }
      },
    });
    y = doc.lastAutoTable.finalY + 4;
    if (record.results.some((r) => r.resolution)) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(...MUTED);
      doc.text("* status resolved by the inspecting officer; the engine's automated status and resolution details appear in the findings column.", M, y);
      y += 4;
    }
    y += 4;

    // ---- evidence thumbnails ----
    if (record.thumbs?.length) {
      if (y > 230) { doc.addPage(); y = 20; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...INK);
      doc.text("PHOTOGRAPHIC EVIDENCE", M, y);
      y += 4;
      let x = M;
      const th = 34, tw = 34;
      for (const thumb of record.thumbs.slice(0, 5)) {
        try {
          doc.addImage(thumb, "JPEG", x, y, tw, th, undefined, "FAST");
          doc.setDrawColor(...MUTED);
          doc.setLineWidth(0.2);
          doc.rect(x, y, tw, th);
        } catch { /* skip unreadable thumb */ }
        x += tw + 4;
      }
      y += th + 10;
    }

    // ---- signature block ----
    if (y > 250) { doc.addPage(); y = 30; }
    doc.setDrawColor(...INK);
    doc.setLineWidth(0.3);
    doc.line(M, y + 14, M + 60, y + 14);
    doc.line(W - M - 60, y + 14, W - M, y + 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text("Signature of Inspector", M, y + 19);
    doc.text("Date & place", W - M - 60, y + 19);

    // ---- footer on all pages ----
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      const H = doc.internal.pageSize.getHeight();
      doc.setFillColor(...NAVY);
      doc.rect(0, H - 8, W, 8, "F");
      doc.setTextColor(210, 218, 230);
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.text("Generated by LMPC Compliance Checker - deterministic rules engine with clause citations - SIH 2026", M, H - 3);
      doc.text(`Page ${i} / ${pages}`, W - M, H - 3, { align: "right" });
    }

    doc.save(`${record.id}.pdf`);
  }

  /**
   * DRAFT seizure memorandum & show-cause / compounding notice under the
   * Legal Metrology Act, 2009. Every statutory reference is a starting point
   * for the officer to verify against the current Act and Rules before service.
   */
  function exportSeizureNotice(record, formData) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 14;

    const ext = record.extraction || {};
    const p = ext.product || {};
    const mrp = ext.declarations?.mrp || {};
    const netQty = ext.declarations?.net_quantity || {};
    const violations = (record.results || []).filter((r) => {
      const eff = r.resolution?.status ?? r.status;
      return ["violation", "missing"].includes(eff);
    });

    const szRef = `SZ/LMPC/${new Date(record.ts).getFullYear()}/${record.id.replace("LMPC-", "")}`;
    const noticeDate = new Date(record.ts).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
    const officerName = formData?.officer || (record.role || "inspector").toUpperCase();
    const circle = formData?.circle || "Flying Squad / Central Enforcement Circle";

    // Penalty amount mapping
    const penaltyMap = {
      first: "Rs. 25,000/- (Rupees Twenty-Five Thousand only) under Section 36(1)",
      second: "Rs. 50,000/- (Rupees Fifty Thousand only) under Section 36(1)",
      subsequent: "Up to Rs. 1,00,000/- with imprisonment or prosecution before Judicial Magistrate under Section 36(1)",
      sticker: "As for a non-standard package under Section 36(1) (contravention of Rule 6(3), LMPC Rules) - up to Rs. 25,000/- for a first offence",
      short_weight: "Up to Rs. 10,000/- under Section 30",
    };
    const penaltyText = penaltyMap[formData?.offenceType] || penaltyMap.first;

    // ==========================================
    // PAGE 1: MEMORANDUM OF SEIZURE (FORM IV)
    // ==========================================

    // Header Band
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, W, 32, "F");
    doc.setFillColor(...SAFFRON);
    doc.rect(0, 32, W, 1.8, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("DEPARTMENT OF LEGAL METROLOGY", W / 2, 11, { align: "center" });
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text("Enforcement Wing - Government of India / State Legal Metrology Directorate", W / 2, 17, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(255, 220, 180);
    doc.text("MEMORANDUM OF SEIZURE & PANCHNAMA (DRAFT)", W / 2, 24, { align: "center" });
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.text("[Under Section 15 of the Legal Metrology Act, 2009 read with the LMPC Rules, 2011]", W / 2, 29, { align: "center" });

    let y = 39;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor(...CRIMSON);
    doc.text("DRAFT generated by LMPC Compliance Checker - statutory references, form numbers and penalty amounts must be verified by the officer before service.", M, y);
    y += 6;

    // Reference & Date Box
    doc.setFont("courier", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(`Seizure Ref: ${szRef}`, M, y);
    doc.text(`Date of Seizure: ${noticeDate}`, W - M, y, { align: "right" });
    y += 6;

    // Paragraph 1: Inspection & Premise statement
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    const introText = `Whereas, on this day of ${noticeDate}, the undersigned Legal Metrology Officer, in exercise of powers conferred under Section 15(1) of the Legal Metrology Act, 2009 read with the Legal Metrology (Packaged Commodities) Rules, 2011, entered and inspected the commercial/retail premises described hereunder and found non-standard packaged commodities manufactured, packed, distributed, or exposed for sale in contravention of the Act.`;
    const introLines = doc.splitTextToSize(introText, W - 2 * M);
    doc.text(introLines, M, y);
    y += introLines.length * 4.2 + 3;

    // Table 1: Premises & Person Present
    const premiseData = [
      ["Inspected Premises / Dealer", formData?.premises || "—"],
      ["Person in Charge Present", formData?.person || "—"],
      ["GSTIN / Reg. Number", formData?.gstin || "N/A"],
      ["Inspecting Officer & Circle", `${officerName} (${circle})`],
    ];
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      body: premiseData.map((r) => r.map(pdfText)),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 50, textColor: MUTED },
        1: { cellWidth: "auto" },
      },
    });
    y = doc.lastAutoTable.finalY + 5;

    // Table 2: Seized Inventory
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...NAVY);
    doc.text("1. INVENTORY OF SEIZED COMMODITIES (SECTION 15(1)(c))", M, y);
    y += 4;

    const inventoryData = [
      ["Brand Name / Commodity", p.brand_name ? `${p.brand_name} - ${p.product_description || ""}` : (p.product_description || "Packaged Commodity")],
      ["Declared Net Quantity & MRP", `${netQty.text || "—"} | ${mrp.text || "—"}`],
      ["Quantity Seized & Sealed", formData?.seizedQty || "As per field inventory"],
      ["Samples Drawn", formData?.sampleQty || "None"],
      ["Manufacturer / Packer", ext.declarations?.manufacturer?.text || ext.declarations?.packer?.text || "—"],
    ];
    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      body: inventoryData.map((r) => r.map(pdfText)),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 50, textColor: MUTED },
        1: { cellWidth: "auto" },
      },
    });
    y = doc.lastAutoTable.finalY + 5;

    // Panchnama Witness Statement
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.2);
    doc.setTextColor(...INK);
    const panchaText = `The seizure and sealing was executed in the immediate presence of the following two independent witnesses (Panchan). One copy of this seizure memorandum has been handed over to the person in charge, whose acknowledgement is recorded below.`;
    const panchaLines = doc.splitTextToSize(panchaText, W - 2 * M);
    doc.text(panchaLines, M, y);
    y += panchaLines.length * 4 + 4;

    // Witness & Signature Blocks
    const sigColW = (W - 2 * M) / 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.text("INDEPENDENT WITNESS 1 (PANCHAN):", M, y);
    doc.text("INDEPENDENT WITNESS 2 (PANCHAN):", M + sigColW, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(pdfText(formData?.witness1 || "Name, Address & Phone: _______________"), M, y);
    doc.text(pdfText(formData?.witness2 || "Name, Address & Phone: _______________"), M + sigColW, y);
    y += 12;

    doc.line(M, y, M + 50, y);
    doc.line(M + sigColW, y, M + sigColW + 50, y);
    y += 4;
    doc.text("Signature of Witness 1", M, y);
    doc.text("Signature of Witness 2", M + sigColW, y);
    y += 12;

    doc.line(M, y, M + 60, y);
    doc.line(W - M - 60, y, W - M, y);
    y += 4;
    doc.setFont("helvetica", "bold");
    doc.text("Signature / Seal of Inspecting Officer", M, y);
    doc.text("Signature / Thumb of Person in Charge", W - M - 60, y);

    // ==========================================
    // PAGE 2: SHOW CAUSE & COMPOUNDING NOTICE
    // ==========================================
    doc.addPage();

    // Top Header Page 2
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, W, 26, "F");
    doc.setFillColor(...SAFFRON);
    doc.rect(0, 26, W, 1.6, "F");

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("STATUTORY SHOW-CAUSE & COMPOUNDING NOTICE", W / 2, 11, { align: "center" });
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "normal");
    doc.text("[Under Section 48 & Section 36 of the Legal Metrology Act, 2009]", W / 2, 17, { align: "center" });
    doc.setFontSize(8);
    doc.setTextColor(255, 220, 180);
    doc.text(`Case Reference: ${szRef} · Response Window: ${formData?.noticePeriod || 15} Days`, W / 2, 22, { align: "center" });

    y = 35;

    // To block
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text("TO:", M, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.text(pdfText(formData?.premises || "The Proprietor / Manager"), M, y);
    y += 4;
    if (formData?.person) {
      doc.text(pdfText(`Attention: ${formData.person}`), M, y);
      y += 4;
    }
    y += 3;

    // Section 2: Statement of Allegations
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...NAVY);
    doc.text("2. STATEMENT OF ALLEGATIONS & STATUTORY BREACHES", M, y);
    y += 4;

    const breachRows = violations.length
      ? violations.map((r, idx) => [
          String(idx + 1),
          pdfText(r.clause),
          pdfText(r.title),
          pdfText(r.extracted || "- missing on label -"),
          pdfText(r.findings.join("; ")),
        ])
      : [["1", "General Review", "Non-Conformity", "—", "Inspection indicated potential non-conformity under LMPC Rules."]];

    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: [["#", "Clause / Rule", "Mandatory Requirement", "Extracted Verbatim", "Specific Statutory Finding"]],
      body: breachRows,
      theme: "grid",
      styles: { fontSize: 7.5, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK, valign: "top" },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontSize: 7.8, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 8, halign: "center" },
        1: { cellWidth: 26, font: "courier", fontSize: 7 },
        2: { cellWidth: 32, fontStyle: "bold" },
        3: { cellWidth: 38, font: "courier", fontSize: 7 },
        4: { cellWidth: "auto" },
      },
    });
    y = doc.lastAutoTable.finalY + 6;

    // Section 3: Statutory Liability & Compounding terms
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...NAVY);
    doc.text("3. STATUTORY PENALTY & PROPOSAL FOR COMPOUNDING (SEC. 48)", M, y);
    y += 4;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.2);
    doc.setTextColor(...INK);
    const noticeDays = formData?.noticePeriod || "15";
    const legalNoticeBody = `You are hereby notified that manufacturing, packing, distributing, or offering for sale non-standard packaged commodities is an offence punishable under Section 36(1) and/or Section 36(2) of the Legal Metrology Act, 2009 with statutory penalty:
- Statutory Penalty / Compounding Liability: ${penaltyText}.

In terms of Section 48 of the Act, you are hereby given an opportunity to compound the said offence(s) without proceeding to trial before the Competent Judicial Magistrate Court.

You are called upon to SHOW CAUSE within ${noticeDays} DAYS of receipt of this notice as to why legal prosecution under the Act should not be instituted against you, OR in the alternative, submit a written application for compounding of the offence along with deposit of the compounding amount.`;

    const legalLines = doc.splitTextToSize(legalNoticeBody, W - 2 * M);
    doc.text(legalLines, M, y);
    y += legalLines.length * 4.2 + 8;

    // Signature page 2
    if (y > 240) { doc.addPage(); y = 30; }
    doc.line(W - M - 70, y + 10, W - M, y + 10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.text(pdfText(officerName), W - M - 70, y + 15);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(pdfText(`Legal Metrology Officer - ${circle}`), W - M - 70, y + 19);
    doc.text(pdfText("Department of Legal Metrology, Enforcement Wing"), W - M - 70, y + 23);

    // ==========================================
    // PAGE 3: PHOTOGRAPHIC EVIDENCE ANNEXURE
    // ==========================================
    if (record.thumbs?.length) {
      doc.addPage();
      doc.setFillColor(...NAVY);
      doc.rect(0, 0, W, 22, "F");
      doc.setFillColor(...SAFFRON);
      doc.rect(0, 22, W, 1.4, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("ANNEXURE - PHOTOGRAPHIC EVIDENCE & LABELS", W / 2, 11, { align: "center" });
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "normal");
      doc.text(`Enclosure to Seizure Memorandum ${szRef}`, W / 2, 17, { align: "center" });

      y = 30;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(...INK);
      doc.text("SEIZED PACKAGE PHOTOGRAPHS (WITH STATUTORY DECLARATION COORDINATES):", M, y);
      y += 5;

      let x = M;
      const imgH = 50, imgW = 50;
      for (const thumb of record.thumbs.slice(0, 3)) {
        try {
          doc.addImage(thumb, "JPEG", x, y, imgW, imgH, undefined, "FAST");
          doc.setDrawColor(...MUTED);
          doc.rect(x, y, imgW, imgH);
        } catch { /* skip */ }
        x += imgW + 6;
      }
      y += imgH + 8;

      // Coordinate summary table
      const boxRows = violations.filter((r) => r.box_2d).map((r) => [
        pdfText(r.clause),
        pdfText(r.title),
        pdfText(r.extracted || "Missing"),
        pdfText(`Photo ${(r.image_index ?? 0) + 1} - Coordinates: [${r.box_2d.join(", ")}]`),
      ]);

      if (boxRows.length) {
        doc.autoTable({
          startY: y,
          margin: { left: M, right: M },
          head: [["Clause", "Breached Declaration", "Extracted Text", "Evidence Location (box_2d)"]],
          body: boxRows,
          theme: "grid",
          styles: { fontSize: 7.5, cellPadding: 2, lineColor: [216, 220, 227], lineWidth: 0.15, textColor: INK },
          headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontSize: 7.8, fontStyle: "bold" },
        });
      }
    }

    // Page numbers on all pages
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFillColor(...NAVY);
      doc.rect(0, H - 8, W, 8, "F");
      doc.setTextColor(210, 218, 230);
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.text(`Official Legal Enforcement Record - ${szRef}`, M, H - 3);
      doc.text(`Page ${i} of ${totalPages}`, W - M, H - 3, { align: "right" });
    }

    doc.save(`SEIZURE_NOTICE_${record.id}.pdf`);
  }

  window.LMPCExport = { exportPdf, exportSeizureNotice };
})();
