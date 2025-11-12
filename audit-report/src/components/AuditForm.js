// src/components/AuditForm.js
import React, { useState } from "react";
import { db } from "../firebase";
import { collection, addDoc, query, where, getDocs } from "firebase/firestore";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* ---------------- Utilities ---------------- */

// Format any date-like value to dd/mm/yyyy
const formatDateDDMMYYYY = (dateValue) => {
  if (!dateValue) return "";
  if (typeof dateValue === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateValue.trim())) {
    const parts = dateValue.trim().split("/");
    const day = String(parts[0]).padStart(2, "0");
    const month = String(parts[1]).padStart(2, "0");
    const year = parts[2];
    return `${day}/${month}/${year}`;
  }
  try {
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return String(dateValue);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return String(dateValue);
  }
};

const sanitize = (v) => {
  if (v === undefined || v === null) return "-";
  return String(v).replace(/[\u200B-\u200D\uFEFF]/g, "").trim() || "-";
};

const normalizeLabelForPDF = (label) =>
  label
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[–—]/g, "-")
    .replace(/°/g, " deg")
    .replace(/℃/g, "C")
    .replace(/°C/g, "C");

/* ---------------- Component ---------------- */

const AuditForm = ({ selection = {}, goBack }) => {
  // default selection fallback: ensure auditor spelled correctly
  const defaultSelection = {
    auditor: "Kumar Kannaiyan",
    ...selection,
  };

  const [formData, setFormData] = useState({
    kitchen: {},
    hygiene: {},
    foodSafety: {},
    observationsPreset: "-- Select --",
    observationsManual: "",
    maintenancePreset: "-- Select --",
    maintenanceManual: "",
    actionPreset: "-- Select --",
    actionManual: "",
  });

  const [errors, setErrors] = useState([]);
  const [touched, setTouched] = useState(false);

  /* ---------- Parameters ---------- */
  const kitchenParams = [
    "Overall kitchen cleanliness maintained",
    "Floors, walls, and ceilings clean and dry",
    "Cooking range and equipment properly cleaned",
    "Exhaust system functioning and cleaned",
    "Waste segregation & disposal followed",
  ];

  const hygieneParams = [
    "Staff wearing clean uniform, cap, gloves, mask",
    "Personal hygiene maintained (nails, hair, hand wash)",
    "Hand wash & sanitizer available and used",
  ];

  const foodSafetyParams = [
    "Bain Marie temperature maintained (>=60°C)",
    "Fridge temperature maintained (<=5°C)",
    "Freezer temperature maintained (<=-18°C)",
    "Raw and cooked food stored separately",
    "Expiry date & labelling followed",
  ];

  const observationsOptions = [
    "-- Select --",
    "No issues observed",
    "Minor cleanliness issues (surface/sweep)",
    "Food held outside safe temperature range",
    "Cross-contamination risk observed",
    "Staff hygiene non-compliant",
    "Equipment malfunction (e.g., oven/fridge)",
    "Pest activity or droppings noted",
    "Expired or damaged items found",
    "Insufficient labeling / traceability",
    "Other (manual)",
  ];

  const maintenanceOptions = [
    "-- Select --",
    "No maintenance required",
    "Immediate cleaning required",
    "Schedule deep-cleaning",
    "Repair or service equipment",
    "Replace expired/damaged stock",
    "Retrain staff on hygiene & PPE",
    "Improve waste segregation & disposal",
    "Adjust/monitor temperature controls",
    "Improve labeling & storage procedures",
    "Implement daily cleaning checklist",
    "Other (manual)",
  ];

  const actionPlanOptions = [
    "-- Select --",
    "Correct on spot & coach staff",
    "Repair within 24–48 hours",
    "Discard affected items and document",
    "Schedule vendor/service visit",
    "Staff re-training scheduled",
    "Implement new SOP/checklist",
    "Follow-up audit in 7 days",
    "Escalate to branch manager",
    "Document corrective action and monitor",
    "Other (manual)",
  ];

  /* ---------- Scoring (exact 100 total) ---------- */
  // Points: each checklist item = 6 pts (13 * 6 = 78), observations = 11, maintenance = 11 => total 100
  const POINTS_PER_CHECK = 6;
  const OBS_MAINT_PTS = 11;

  const getObservationScore = (preset, manual) => {
    const p = String(preset || "").toLowerCase();
    if (p === "no issues observed") return OBS_MAINT_PTS;
    if (p.includes("other")) {
      if (manual && manual.trim().toLowerCase().includes("no issue")) return OBS_MAINT_PTS;
      return -OBS_MAINT_PTS;
    }
    if (!preset || preset === "-- Select --") return 0;
    return -OBS_MAINT_PTS;
  };

  const getMaintenanceScore = (preset, manual) => {
    const p = String(preset || "").toLowerCase();
    if (p === "no maintenance required" || p === "no issues observed") return OBS_MAINT_PTS;
    if (p.includes("other")) {
      if (manual && manual.trim().toLowerCase().includes("no issue")) return OBS_MAINT_PTS;
      return -OBS_MAINT_PTS;
    }
    if (!preset || preset === "-- Select --") return 0;
    return -OBS_MAINT_PTS;
  };

  const computeScores = (
    kitchenObj,
    hygieneObj,
    foodObj,
    observationsPreset,
    observationsManual,
    maintenancePreset,
    maintenanceManual
  ) => {
    const allParams = [...kitchenParams, ...hygieneParams, ...foodSafetyParams];
    let checklistRaw = 0;
    allParams.forEach((label) => {
      const val = kitchenObj?.[label] ?? hygieneObj?.[label] ?? foodObj?.[label];
      if (String(val).toLowerCase() === "yes") checklistRaw += POINTS_PER_CHECK;
    });

    const obsScore = getObservationScore(observationsPreset, observationsManual);
    const maintScore = getMaintenanceScore(maintenancePreset, maintenanceManual);

    // raw score can be negative due to penalties; clamp final to 0..100
    const rawScore = checklistRaw + obsScore + maintScore;
    const finalScore = Math.max(0, Math.min(100, rawScore));

    return {
      checklistRaw,
      obsScore,
      maintScore,
      rawScore,
      scoreOutOf100: finalScore,
      maxChecklist: allParams.length * POINTS_PER_CHECK,
    };
  };

  /* ---------- Form handlers ---------- */
  const handleCheck = (section, key, value) =>
    setFormData((prev) => ({
      ...prev,
      [section]: { ...prev[section], [key]: value },
    }));

  const handleRemarkPreset = (which, value) =>
    setFormData((prev) => ({
      ...prev,
      [`${which}Preset`]: value,
      ...(String(value).toLowerCase().includes("other") ? {} : { [`${which}Manual`]: "" }),
    }));

  const handleRemarkManual = (which, value) =>
    setFormData((prev) => ({ ...prev, [`${which}Manual`]: value }));

  /* ---------- Validation ---------- */
  const validate = () => {
    const errs = [];

    // Header required (use default selection fallback)
    const aud = defaultSelection.auditor;
    const dateVal = defaultSelection.date;
    const branchVal = defaultSelection.branch;
    const cityVal = defaultSelection.city;
    if (!aud) errs.push("Auditor is required");
    if (!dateVal) errs.push("Date is required");
    if (!branchVal) errs.push("Branch is required");
    if (!cityVal) errs.push("City is required");

    // Checklist completeness
    const checkMissing = (paramsArray, sectionKey, title) => {
      const missing = paramsArray.filter((label) => !formData[sectionKey]?.[label]);
      if (missing.length > 0) {
        errs.push(`${title} - ${missing.length} unanswered`);
      }
    };
    checkMissing(kitchenParams, "kitchen", "Kitchen Cleanliness & Maintenance");
    checkMissing(hygieneParams, "hygiene", "Personal Hygiene");
    checkMissing(foodSafetyParams, "foodSafety", "Food Safety & Storage");

    // Remarks required (choose or manual)
    const remarkCheck = (label, preset, manual) => {
      if (!preset || preset === "-- Select --") {
        if (!manual || manual.trim() === "") {
          errs.push(`${label} is required (choose option or enter manually)`);
        }
      } else if (String(preset).toLowerCase().includes("other") && (!manual || manual.trim() === "")) {
        errs.push(`${label}: you chose "Other (manual)" but did not enter text`);
      }
    };

    remarkCheck("Observations", formData.observationsPreset, formData.observationsManual);
    remarkCheck("Maintenance / Suggestions", formData.maintenancePreset, formData.maintenanceManual);
    remarkCheck("Action Plan / Corrective Measures", formData.actionPreset, formData.actionManual);

    setErrors(errs);
    return errs.length === 0;
  };

  /* ---------- Submit to Firestore ---------- */
  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!validate()) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const getRemarkText = (preset, manual) =>
      String(preset).toLowerCase().includes("other")
        ? manual.trim() || "-"
        : preset === "-- Select --"
        ? "-"
        : preset;

    const scores = computeScores(
      formData.kitchen,
      formData.hygiene,
      formData.foodSafety,
      formData.observationsPreset,
      formData.observationsManual,
      formData.maintenancePreset,
      formData.maintenanceManual
    );

    // keep date in dd/mm/yyyy for the uniqueness key
    const dateDD = formatDateDDMMYYYY(defaultSelection.date);

    const payload = {
      kitchen: formData.kitchen,
      hygiene: formData.hygiene,
      foodSafety: formData.foodSafety,
      observations: getRemarkText(formData.observationsPreset, formData.observationsManual),
      maintenance: getRemarkText(formData.maintenancePreset, formData.maintenanceManual),
      actionPlan: getRemarkText(formData.actionPreset, formData.actionManual),
      date: dateDD,
      auditor: defaultSelection.auditor,
      branch: defaultSelection.branch,
      city: defaultSelection.city,
      scoreOutOf100: scores.scoreOutOf100,
      scoreBreakdown: {
        checklist: scores.checklistRaw ?? 0,
        observations: scores.obsScore ?? 0,
        maintenance: scores.maintScore ?? 0,
        totalBeforeClamp: scores.rawScore ?? 0,
        maxChecklist: scores.maxChecklist ?? 0,
      },
      timestamp: new Date(),
    };

    try {
      // 1) Query Firestore to see if an audit for this branch + date already exists
      const colRef = collection(db, "unitAudits");
      const q = query(colRef, where("branch", "==", payload.branch), where("date", "==", payload.date));
      const snap = await getDocs(q);

      if (!snap.empty) {
        // There is already at least one audit for this branch & date
        alert(`❌ A Unit Audit for branch "${payload.branch}" on ${payload.date} already exists. Only one audit per branch per day is allowed.`);
        return;
      }

      // 2) If not found, create the document
      await addDoc(colRef, payload);
      alert(`✅ Audit submitted successfully! Score: ${scores.scoreOutOf100} / 100`);
    } catch (err) {
      console.error("Error saving audit:", err);
      alert("❌ Error saving data: " + (err?.message || err));
    }
  };

  /* ---------- PDF generation ---------- */
  const downloadPDF = () => {
    setTouched(true);
    if (!validate()) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const scores = computeScores(
      formData.kitchen,
      formData.hygiene,
      formData.foodSafety,
      formData.observationsPreset,
      formData.observationsManual,
      formData.maintenancePreset,
      formData.maintenanceManual
    );

    const doc = new jsPDF("p", "mm", "a4");
    const baseFont = "helvetica";
    doc.setFont(baseFont);
    doc.setFontSize(14);
    const pageWidth = doc.internal.pageSize.getWidth();

    // --- New header layout requested ---
    // Title (center)
    doc.setFont(baseFont, "bold");
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – F&B UNIT AUDIT REPORT", pageWidth / 2, 18, { align: "center" });

    // "Audited by F&B Manager" and name centered below title
    doc.setFont(baseFont, "normal");
    doc.setFontSize(11);
    doc.text("Audited by F&B Manager", pageWidth / 2, 26, { align: "center" });

    const auditorName = sanitize(defaultSelection.auditor || "Kumar Kannaiyan");
    doc.setFont(baseFont, "bold");
    doc.setFontSize(12);
    doc.text(auditorName, pageWidth / 2, 33, { align: "center" });

    // Branch / City on left, Date and Score on right
    doc.setFont(baseFont, "normal");
    doc.setFontSize(10);
    const dText = formatDateDDMMYYYY(defaultSelection.date) || "-";
    doc.text(`Branch: ${sanitize(defaultSelection.branch)}`, 14, 42);
    doc.text(`City: ${sanitize(defaultSelection.city)}`, 14, 48);

    const scoreLine = `Score: ${scores.scoreOutOf100} / 100`;
    doc.text(`Date: ${dText}`, pageWidth - 14, 42, { align: "right" });
    doc.text(scoreLine, pageWidth - 14, 48, { align: "right" });

    // Build tables
    const kitchenRows = kitchenParams.map((lab) => [normalizeLabelForPDF(lab), sanitize(formData.kitchen?.[lab] ?? "-")]);
    const hygieneRows = hygieneParams.map((lab) => [normalizeLabelForPDF(lab), sanitize(formData.hygiene?.[lab] ?? "-")]);
    const foodRows = foodSafetyParams.map((lab) => [normalizeLabelForPDF(lab), sanitize(formData.foodSafety?.[lab] ?? "-")]);

    const addSection = (title, rows) => {
      autoTable(doc, {
        startY: doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : 56,
        head: [[title, "Status"]],
        body: rows,
        theme: "grid",
        styles: {
          font: baseFont,
          fontSize: 9,
          cellPadding: 2,
          overflow: "linebreak",
          valign: "middle",
        },
        headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: "bold" },
        columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40, halign: "center" } },
      });
    };

    addSection("1. Kitchen Cleanliness & Maintenance", kitchenRows);
    addSection("2. Personal Hygiene", hygieneRows);
    addSection("3. Food Safety & Storage", foodRows);

    // Remarks blocks
    let finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : 40;
    const safeSplitText = (text, maxWidth) => {
      try {
        return doc.splitTextToSize(text, maxWidth);
      } catch (err) {
        const approxChars = Math.floor(maxWidth / 3.5);
        return text.length > approxChars ? [text.slice(0, approxChars) + "…"] : [text];
      }
    };

    const getRemarkText = (preset, manual) =>
      String(preset).toLowerCase().includes("other")
        ? manual.trim() || "-"
        : preset === "-- Select --"
        ? "-"
        : preset;

    const addTextBlock = (label, presetKey, manualKey) => {
      doc.setFont(baseFont, "bold");
      doc.setFontSize(10);
      doc.text(label, 14, finalY);

      doc.setFont(baseFont, "normal");
      doc.setFontSize(9);
      const txt = getRemarkText(formData[presetKey], formData[manualKey]);
      const split = safeSplitText(sanitize(txt), 180);
      doc.text(split, 14, finalY + 6);
      finalY += split.length * 5 + 12;
    };

    addTextBlock("Observations:", "observationsPreset", "observationsManual");
    addTextBlock("Maintenance / Suggestions:", "maintenancePreset", "maintenanceManual");
    addTextBlock("Action Plan / Corrective Measures:", "actionPreset", "actionManual");

    // Footer: show "Audited by F&B Manager" and the auditor name centered (as requested)
    doc.setFont(baseFont, "normal");
    doc.setFontSize(9);
    const footerLines = ["Audited by F&B Manager", auditorName];
    // draw two-line centered footer
    const footerY = doc.internal.pageSize.getHeight() - 14;
    doc.text(footerLines, pageWidth / 2, footerY, { align: "center", maxWidth: pageWidth - 28 });

    // Save file with safe filename
    const safeBranch = (defaultSelection.branch || "Branch").replace(/\s+/g, "_");
    const safeDate = formatDateDDMMYYYY(defaultSelection.date).replace(/\s+/g, "_") || "date";
    doc.save(`${safeBranch}_Audit_${safeDate}.pdf`);
  };

  /* ---------- UI helpers ---------- */
  const yesNoButtons = (section, key) => (
    <div style={{ display: "flex", gap: 12 }}>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="radio"
          name={`${section}-${key}`}
          checked={formData[section]?.[key] === "Yes"}
          onChange={() => handleCheck(section, key, "Yes")}
        />
        <span style={{ marginLeft: 6 }}>Yes</span>
      </label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="radio"
          name={`${section}-${key}`}
          checked={formData[section]?.[key] === "No"}
          onChange={() => handleCheck(section, key, "No")}
        />
        <span style={{ marginLeft: 6 }}>No</span>
      </label>
    </div>
  );

  /* ---------- Live scores for UI ---------- */
  const liveScores = computeScores(
    formData.kitchen,
    formData.hygiene,
    formData.foodSafety,
    formData.observationsPreset,
    formData.observationsManual,
    formData.maintenancePreset,
    formData.maintenanceManual
  );

  /* ---------- Render ---------- */
  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 18 }}>
      <div style={{ border: "1px solid #e6e6e6", borderRadius: 8, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <button onClick={goBack} style={{ marginBottom: 6 }}>
            ← Back
          </button>
          <h3 style={{ margin: 0, color: "#1976d2" }}>Unit Audit</h3>
          <div style={{ width: 40 }} />
        </div>

        {/* Header grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Auditor</div>
            <div style={{ color: defaultSelection.auditor ? "#111" : "red", marginTop: 4 }}>{defaultSelection.auditor || "— missing —"}</div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Date</div>
            <div style={{ color: defaultSelection.date ? "#111" : "red", marginTop: 4 }}>{defaultSelection.date ? formatDateDDMMYYYY(defaultSelection.date) : "— missing —"}</div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Branch</div>
            <div style={{ color: defaultSelection.branch ? "#111" : "red", marginTop: 4 }}>{defaultSelection.branch || "— missing —"}</div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>City</div>
            <div style={{ color: defaultSelection.city ? "#111" : "red", marginTop: 4 }}>{defaultSelection.city || "— missing —"}</div>
          </div>
        </div>

        {/* Live score */}
        <div style={{ marginBottom: 12 }}>
          <strong>Score:</strong>{" "}
          <span style={{ fontSize: 16, color: "#2e7d32", fontWeight: 700 }}>{liveScores.scoreOutOf100} / 100</span>
          <div style={{ color: "#666", marginTop: 6 }}>
            Checklist: {liveScores.checklistRaw}/{liveScores.maxChecklist} • Observations: {liveScores.obsScore > 0 ? `+${liveScores.obsScore}` : liveScores.obsScore} • Maintenance: {liveScores.maintScore > 0 ? `+${liveScores.maintScore}` : liveScores.maintScore}
          </div>
        </div>

        {/* Error box */}
        {touched && errors.length > 0 && (
          <div style={{ background: "#fff4f4", border: "1px solid #ffd3d3", padding: 10, borderRadius: 6, marginBottom: 12 }}>
            <strong style={{ color: "#b30000" }}>Please fix the following:</strong>
            <ul style={{ marginTop: 8 }}>
              {errors.map((err, i) => (
                <li key={i} style={{ color: "#b30000" }}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Checklist sections */}
          <section style={{ marginTop: 8 }}>
            <h4 style={{ marginBottom: 8 }}>1. Kitchen Cleanliness & Maintenance</h4>
            {kitchenParams.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #f0f0f0", padding: 10, borderRadius: 6, marginBottom: 8 }}>
                <div style={{ flex: 1, marginRight: 12 }}>{p}</div>
                {yesNoButtons("kitchen", p)}
              </div>
            ))}
          </section>

          <section style={{ marginTop: 8 }}>
            <h4 style={{ marginBottom: 8 }}>2. Personal Hygiene</h4>
            {hygieneParams.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #f0f0f0", padding: 10, borderRadius: 6, marginBottom: 8 }}>
                <div style={{ flex: 1, marginRight: 12 }}>{p}</div>
                {yesNoButtons("hygiene", p)}
              </div>
            ))}
          </section>

          <section style={{ marginTop: 8 }}>
            <h4 style={{ marginBottom: 8 }}>3. Food Safety & Storage</h4>
            {foodSafetyParams.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #f0f0f0", padding: 10, borderRadius: 6, marginBottom: 8 }}>
                <div style={{ flex: 1, marginRight: 12 }}>{p}</div>
                {yesNoButtons("foodSafety", p)}
              </div>
            ))}
          </section>

          {/* Remarks */}
          <section style={{ marginTop: 12 }}>
            <h4>Remarks</h4>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 700 }}>Observations</label>
              <select value={formData.observationsPreset} onChange={(e) => handleRemarkPreset("observations", e.target.value)} style={{ padding: 8, width: "100%", marginTop: 6 }}>
                {observationsOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {String(formData.observationsPreset).toLowerCase().includes("other") && (
                <textarea rows={2} placeholder="Enter observations..." value={formData.observationsManual} onChange={(e) => handleRemarkManual("observations", e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }} />
              )}
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 700 }}>Maintenance / Suggestions</label>
              <select value={formData.maintenancePreset} onChange={(e) => handleRemarkPreset("maintenance", e.target.value)} style={{ padding: 8, width: "100%", marginTop: 6 }}>
                {maintenanceOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {String(formData.maintenancePreset).toLowerCase().includes("other") && (
                <textarea rows={2} placeholder="Enter maintenance / suggestions..." value={formData.maintenanceManual} onChange={(e) => handleRemarkManual("maintenance", e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }} />
              )}
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontWeight: 700 }}>Action Plan / Corrective Measures</label>
              <select value={formData.actionPreset} onChange={(e) => handleRemarkPreset("action", e.target.value)} style={{ padding: 8, width: "100%", marginTop: 6 }}>
                {actionPlanOptions.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {String(formData.actionPreset).toLowerCase().includes("other") && (
                <textarea rows={2} placeholder="Enter action plan..." value={formData.actionManual} onChange={(e) => handleRemarkManual("action", e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }} />
              )}
            </div>
          </section>

          {/* Buttons */}
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <button type="submit" style={{ padding: 10, background: "#2e7d32", color: "#fff", borderRadius: 6, border: "none" }}>
              ✅ Submit Report
            </button>
            <button type="button" onClick={downloadPDF} style={{ padding: 10, background: "#1976d2", color: "#fff", borderRadius: 6, border: "none" }}>
              📄 Download as PDF
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AuditForm;
