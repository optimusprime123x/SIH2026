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

  window.LMPCExport = { exportPdf };
})();
