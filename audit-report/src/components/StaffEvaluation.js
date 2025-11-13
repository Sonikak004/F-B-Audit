// src/components/StaffEvaluation.js
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  getDocs,
} from "firebase/firestore";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ---- Utility: format dd/mm/yyyy ----
const ensureDDMMYYYY = (input) => {
  if (input === undefined || input === null) return "";
  const s = String(input || "").trim();
  let parts = null;
  if (s.includes("/")) parts = s.split("/");
  else if (s.includes("-")) parts = s.split("-");
  if (parts && parts.length === 3) {
    const [p1, p2, p3] = parts;
    if (p1.length <= 2 && p2.length <= 2 && p3.length === 4)
      return `${p1.padStart(2, "0")}/${p2.padStart(2, "0")}/${p3}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return s;
};

// rating -> numeric mapping (tweak if needed)
const RATING_VALUE = {
  Excellent: 100,
  Good: 80,
  Average: 60,
  Poor: 40,
};

// grade thresholds from numeric score
const scoreToGrade = (n) => {
  if (n >= 90) return "A";
  if (n >= 75) return "B";
  if (n >= 60) return "C";
  return "D";
};

export default function StaffEvaluation({ selection = {}, goBack }) {
  const params = [
    "Attendance / Punctuality",
    "Work Discipline",
    "Food Taste / Quality",
    "Hygiene & Grooming",
    "Teamwork / Attitude",
  ];

  const ratingOptions = ["Excellent", "Good", "Average", "Poor"];

  const [form, setForm] = useState({
    staffName: "",
    empCode: "",
    designation: "",
    // totalMarks and grade are computed/display-only (not user inputs any more)
    totalMarks: "",
    grade: "",
  });

  const [ratings, setRatings] = useState({});
  const [errors, setErrors] = useState([]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  // autocomplete state
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] = useState(null); // { staffName, empCode, designation, lastDoc? }

  // For debounce of typing
  const [searchTerm, setSearchTerm] = useState("");

  // Lookup latest staff doc (used for autofill & showing previous record)
  const fetchLatestStaff = async ({ byName, byEmpCode }) => {
    setLookingUp(true);
    try {
      const col = collection(db, "staffEvaluations");
      let q = null;
      if (byEmpCode) {
        q = query(col, where("empCode", "==", byEmpCode), orderBy("createdAt", "desc"), limit(1));
      } else if (byName) {
        q = query(col, where("staffName", "==", byName), orderBy("createdAt", "desc"), limit(1));
      } else {
        setLookingUp(false);
        return null;
      }
      const snap = await getDocs(q);
      if (!snap.empty) {
        const doc = snap.docs[0].data();
        return doc;
      }
    } catch (err) {
      console.error("fetchLatestStaff error:", err);
    } finally {
      setLookingUp(false);
    }
    return null;
  };

  // Case-insensitive client-side suggestions: fetch recent docs then filter
  const searchStaffNames = async (prefix) => {
    if (!prefix || prefix.trim().length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    setLookingUp(true);
    try {
      const col = collection(db, "staffEvaluations");
      const q = query(col, orderBy("createdAt", "desc"), limit(200));
      const snap = await getDocs(q);

      const prefixLower = prefix.trim().toLowerCase();
      const unique = [];
      const seen = new Set();

      snap.docs.forEach((d) => {
        const data = d.data();
        const name = (data.staffName || "").trim();
        if (!name) return;
        const nameLower = name.toLowerCase();
        // prefix match (case-insensitive). Using startsWith so it's not substring noise.
        if (nameLower.startsWith(prefixLower)) {
          const code = (data.empCode || "").trim();
          const key = `${nameLower}::${code}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push({
              staffName: name,
              empCode: code,
              designation: data.designation || "",
              lastDoc: data, // keep last doc to show previous marks if needed
            });
          }
        }
      });

      setSuggestions(unique);
      setShowSuggestions(unique.length > 0);
    } catch (err) {
      console.error("searchStaffNames error:", err);
      setSuggestions([]);
      setShowSuggestions(false);
    } finally {
      setLookingUp(false);
    }
  };

  // Debounce searchTerm changes
  useEffect(() => {
    if (!searchTerm || searchTerm.trim().length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const t = setTimeout(() => {
      searchStaffNames(searchTerm);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  // handlers
  const handleRating = (param, value) =>
    setRatings((r) => ({ ...r, [param]: value }));

  const handleRemark = (param, text) =>
    setRatings((r) => ({ ...r, [`${param}_remarks`]: text }));

  // When user types in staffName input
  const handleStaffNameChange = (v) => {
    setForm((f) => ({ ...f, staffName: v }));
    setSearchTerm(v);
    // reset any selected suggestion if user edits after selecting
    if (selectedSuggestion) {
      setSelectedSuggestion(null);
    }
  };

  // When user picks a suggestion
  const pickSuggestion = (sugg) => {
    setSelectedSuggestion(sugg);
    setForm((f) => ({
      ...f,
      staffName: sugg.staffName,
      empCode: sugg.empCode,
      designation: sugg.designation,
    }));
    setSuggestions([]);
    setShowSuggestions(false);
  };

  // Reset selection to allow manual editing
  const resetSelection = () => {
    setSelectedSuggestion(null);
    // keep staffName text but make empCode/designation editable
    setForm((f) => ({ ...f, empCode: "", designation: "" }));
  };

  // compute staff score from ratings (average of numeric values)
  const computeStaffScore = (ratingsObj) => {
    const keys = params;
    const vals = [];
    keys.forEach((k) => {
      const r = ratingsObj?.[k];
      if (r && RATING_VALUE[r] !== undefined) vals.push(RATING_VALUE[r]);
    });
    if (vals.length === 0) return null;
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    return Math.round(avg);
  };

  const computedScore = useMemo(() => computeStaffScore(ratings), [ratings]);
  const computedGrade = useMemo(() => (computedScore !== null ? scoreToGrade(computedScore) : ""), [computedScore]);

  // When computedScore changes, reflect it visually in the bottom area (not as inputs)
  useEffect(() => {
    if (computedScore !== null) {
      setForm((f) => ({ ...f, totalMarks: String(computedScore), grade: computedGrade }));
    } else {
      setForm((f) => ({ ...f, totalMarks: "", grade: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedScore, computedGrade]);

  // Validation
  const validate = () => {
    const errs = [];
    if (!form.staffName.trim()) errs.push("Staff Name is required");
    if (!form.empCode.trim()) errs.push("Emp Code is required");
    const missing = params.filter((p) => !ratings[p]);
    if (missing.length) errs.push(`Please rate: ${missing.join(", ")}`);
    setErrors(errs);
    return errs.length === 0;
  };

  // Prevent duplicate staff evaluation for same empCode and same date
  const checkDuplicateForDate = async (empCode, dateDD) => {
    try {
      const col = collection(db, "staffEvaluations");
      const q = query(col, where("empCode", "==", empCode), where("selection.date", "==", dateDD), limit(1));
      const snap = await getDocs(q);
      return !snap.empty;
    } catch (err) {
      console.error("checkDuplicateForDate error:", err);
      // If there's an error, return false to avoid blocking; but you may want to handle differently.
      return false;
    }
  };

  // Submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!validate()) return;

    // require date in selection (SelectPage ensures date set) but double-check
    const dateDD = ensureDDMMYYYY(selection.date);
    if (!dateDD) {
      alert("Date missing from selection - please re-select branch/date.");
      return;
    }

    // check duplicates
    const empCode = form.empCode.trim();
    const duplicate = await checkDuplicateForDate(empCode, dateDD);
    if (duplicate) {
      alert(`❌ An evaluation for Emp Code "${empCode}" already exists for ${dateDD}. Only one evaluation per staff per day is allowed.`);
      return;
    }

    setSaving(true);
    try {
      const finalScore = computedScore ?? 0;
      const finalGrade = form.grade || scoreToGrade(finalScore);

      const payload = {
        staffName: form.staffName,
        empCode: form.empCode,
        designation: form.designation,
        totalMarks: String(finalScore),
        grade: finalGrade,
        ratings,
        selection: {
          branch: selection.branch ?? "",
          city: selection.city ?? "",
          auditor: selection.auditor ?? "",
          date: ensureDDMMYYYY(selection.date),
        },
        scoreOutOf100: finalScore,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, "staffEvaluations"), payload);
      alert("✅ Staff Evaluation submitted!");
      // reset ratings only (keep staff details so user can do next staff)
      setRatings({});
      setTouched(false);
      setErrors([]);
      setSelectedSuggestion(null);
      setSuggestions([]);
      setShowSuggestions(false);
      setForm({
        staffName: "",
        empCode: "",
        designation: "",
        totalMarks: "",
        grade: "",
      });
    } catch (err) {
      console.error("save error", err);
      alert("❌ Error saving: " + (err?.message || String(err)));
    } finally {
      setSaving(false);
    }
  };

  // PDF generation
  const downloadPDF = () => {
    setTouched(true);
    if (!validate()) return;

    const doc = new jsPDF("p", "mm", "a4");
    const font = "helvetica";
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFont(font);
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – STAFF EVALUATION REPORT", pageWidth / 2, 15, {
      align: "center",
    });

    // header "Audited by F&B Manager" above name
    doc.setFontSize(11);
    doc.text("Audited by F&B Manager", pageWidth / 2, 22, { align: "center" });
    doc.setFontSize(12);
    doc.setFont(undefined, "bold");
    doc.text(selection.auditor || "Kumar Kannaiyan", pageWidth / 2, 28, { align: "center" });
    doc.setFont(undefined, "normal");

    doc.setFontSize(10);
    const leftX = 14;
    const rightMargin = 14;
    const dateText = `Date: ${ensureDDMMYYYY(selection.date) || "-"}`;

    doc.text(`Branch: ${selection.branch || "-"}`, leftX, 36);
    doc.text(`City: ${selection.city || "-"}`, leftX, 41);
    doc.text(dateText, pageWidth - rightMargin - doc.getTextWidth(dateText), 36);

    // Staff Details
    doc.text(`Staff Name: ${form.staffName || "-"}`, 14, 50);
    doc.text(`Emp Code: ${form.empCode || "-"}`, 14, 55);
    doc.text(`Designation: ${form.designation || "-"}`, 14, 60);

    // Total Marks & Grade displayed at bottom of evaluation section in PDF header area
    const tm = form.totalMarks || (computedScore !== null ? String(computedScore) : "-");
    const gr = form.grade || (computedScore !== null ? scoreToGrade(computedScore) : "-");
    doc.text(`Total Marks: ${tm}`, pageWidth - 80, 55);
    doc.text(`Grade: ${gr}`, pageWidth - 80, 60);

    // Ratings Table
    const rows = params.map((p) => [
      p,
      ratings[p] || "-",
      ratings[`${p}_remarks`] || "-",
    ]);
    autoTable(doc, {
      startY: 70,
      head: [["Parameter", "Rating", "Remarks"]],
      body: rows,
      theme: "grid",
      styles: { font, fontSize: 9, cellPadding: 2 },
      headStyles: {
        fillColor: [41, 128, 185],
        textColor: 255,
        fontStyle: "bold",
      },
      columnStyles: {
        0: { cellWidth: 80 },
        1: { cellWidth: 30, halign: "center" },
        2: { cellWidth: 70 },
      },
    });

    // Footer
    doc.setFontSize(9);
    const footer = `Staff Evaluation Report – ${selection.branch || "-"} (${ensureDDMMYYYY(
      selection.date
    ) || "-"}) by ${selection.auditor || "-"}`;
    doc.text(footer, pageWidth / 2, doc.internal.pageSize.getHeight() - 10, {
      align: "center",
    });

    const safeBranch = (selection.branch || "Branch").replace(/\s+/g, "_");
    const safeDate = (ensureDDMMYYYY(selection.date) || "date").replace(/\s+/g, "_");
    doc.save(`${safeBranch}_StaffEvaluation_${safeDate}.pdf`);
  };

  // UI styles
  const styles = `
    .se-card { border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px; max-width: 980px; margin: 0 auto; background: #fff; }
    /* header grid: left(back) - center(title) - right(spacer) */
    .se-header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin-bottom: 12px; }
    .se-header-left { display:flex; align-items:center; gap:8px; }
    .se-header-center { text-align: center; }
    .se-title { margin: 0; color: #1976d2; font-size: 18px; line-height: 1.05; font-weight: 700; }
    .se-subtitle { margin-top: 4px; font-size: 13px; color: #444; font-weight: 500; }
    .se-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 12px; align-items: center; }
    .se-label { font-size: 12px; color: #333; font-weight: 700; }
    .se-value { margin-top: 4px; color: #111; }
    .se-input { width: 100%; padding: 8px; margin-top: 6px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
    .se-table-wrap { overflow-x: auto; margin-bottom: 12px; }
    table.se-table { width: 100%; border-collapse: collapse; min-width: 640px; }
    table.se-table th, table.se-table td { border: 1px solid #eee; padding: 8px; text-align: left; }
    .se-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .se-button { padding: 8px 10px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; }
    .se-btn-primary { background: #1976d2; color: #fff; }
    .se-btn-ghost { background: #fff; color: #333; border: 1px solid #ddd; }
    .lookup-btn { padding: 6px 8px; border-radius: 6px; border: 1px solid #ddd; background: #f8f9fa; cursor: pointer; margin-left: 8px; font-size: 13px; }
    .suggestions { border: 1px solid #ddd; background: #fff; position: absolute; z-index: 50; width: 100%; max-height: 200px; overflow-y: auto; border-radius: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.06); }
    .suggestion-item { padding: 8px; cursor: pointer; border-bottom: 1px solid #f0f0f0; }
    .suggestion-item:hover { background: #f3f7ff; }
    .bottom-stats { display:flex; gap:12px; align-items:center; margin-top:8px; flex-wrap:wrap; }
    .last-record { color:#666; font-size:13px; }
    @media (max-width: 720px) {
      .se-grid { grid-template-columns: 1fr; }
      .se-header { grid-template-columns: auto 1fr auto; gap: 8px; }
      .se-title { font-size: 16px; }
      .se-subtitle { font-size: 12px; }
      .se-button { padding: 6px 8px; font-size: 13px; }
      .lookup-btn { font-size: 12px; padding: 6px 6px; }
      table.se-table { min-width: 560px; }
    }
  `;

  // Handler for suggestion selection via click
  const handleSuggestionClick = async (s) => {
    pickSuggestion(s);
    // fetch latest doc (if not already present)
    if (!s.lastDoc) {
      const last = await fetchLatestStaff({ byEmpCode: s.empCode });
      if (last) {
        s.lastDoc = last;
      }
    }
  };

  return (
    <div style={{ padding: 18 }}>
      <style>{styles}</style>

      <div className="se-card">
        <div className="se-header" role="banner" aria-label="page header">
          <div className="se-header-left">
            <button onClick={goBack} className="se-button se-btn-ghost" aria-label="Go back">
              ← Back
            </button>
          </div>

          <div className="se-header-center" aria-hidden={false}>
            <h3 className="se-title">Staff Performance Evaluation</h3>
          </div>

          <div style={{ width: 40 }} aria-hidden />
        </div>

        {/* Header grid */}
        <div className="se-grid">
          <div>
            <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Audited by - F&B Manager</div>
            <div className="se-value">{selection.auditor || "— missing —"}</div>
          </div>
          <div>
            <div className="se-label">Date</div>
            <div className="se-value">
              {selection.date ? ensureDDMMYYYY(selection.date) : "— missing —"}
            </div>
          </div>
          <div>
            <div className="se-label">Branch</div>
            <div className="se-value">{selection.branch || "— missing —"}</div>
          </div>
          <div>
            <div className="se-label">City</div>
            <div className="se-value">{selection.city || "— missing —"}</div>
          </div>
        </div>

        {/* Errors */}
        {touched && errors.length > 0 && (
          <div
            style={{
              background: "#fff4f4",
              padding: 10,
              borderRadius: 6,
              marginBottom: 12,
              border: "1px solid #ffd3d3",
            }}
          >
            <strong style={{ color: "#b30000" }}>
              Please fix the following:
            </strong>
            <ul style={{ marginTop: 8 }}>
              {errors.map((e, i) => (
                <li key={i} style={{ color: "#b30000" }}>
                  {e}
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="off">
          {/* Staff details */}
          <div className="se-grid" style={{ marginBottom: 12, position: "relative" }}>
            <div style={{ position: "relative" }}>
              <label className="se-label">Staff Name</label>
              <div style={{ display: "flex", alignItems: "center", position: "relative" }}>
                <input
                  className="se-input"
                  value={form.staffName}
                  onChange={(e) => handleStaffNameChange(e.target.value)}
                  placeholder="Enter staff name"
                  aria-label="Staff name"
                />
                <button
                  type="button"
                  className="lookup-btn"
                  onClick={() => searchStaffNames(form.staffName)}
                  disabled={lookingUp}
                  title="Search recent staff names"
                >
                  {lookingUp ? "Looking up…" : "Lookup"}
                </button>
              </div>

              {showSuggestions && suggestions.length > 0 && (
                <div className="suggestions" role="listbox" aria-label="staff suggestions">
                  {suggestions.map((s, idx) => (
                    <div
                      key={`${s.staffName}-${s.empCode}-${idx}`}
                      className="suggestion-item"
                      onMouseDown={(ev) => {
                        // onMouseDown to avoid losing focus before click
                        ev.preventDefault();
                        handleSuggestionClick(s);
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{s.staffName}</div>
                      <div style={{ fontSize: 13, color: "#666" }}>{s.empCode} {s.designation ? `• ${s.designation}` : ""}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="se-label">Emp Code</label>
              <div style={{ display: "flex", alignItems: "center" }}>
                <input
                  className="se-input"
                  value={form.empCode}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, empCode: e.target.value }));
                    if (selectedSuggestion) setSelectedSuggestion(null);
                  }}
                  onBlur={async () => {
                    if (form.empCode && form.empCode.trim().length >= 2 && !selectedSuggestion) {
                      // attempt autofill by empCode
                      const last = await fetchLatestStaff({ byEmpCode: form.empCode.trim() });
                      if (last) {
                        setSelectedSuggestion({
                          staffName: last.staffName,
                          empCode: last.empCode,
                          designation: last.designation,
                          lastDoc: last,
                        });
                        setForm((f) => ({ ...f, staffName: last.staffName, designation: last.designation }));
                      }
                    }
                  }}
                  placeholder="Employee code"
                  disabled={!!selectedSuggestion}
                  aria-label="Employee code"
                />
                {selectedSuggestion ? (
                  <button type="button" className="lookup-btn" onClick={resetSelection} aria-label="Reset selected employee">
                    Reset
                  </button>
                ) : null}
              </div>
            </div>

            <div>
              <label className="se-label">Designation</label>
              <input
                className="se-input"
                value={form.designation}
                onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))}
                placeholder="Designation"
                disabled={!!selectedSuggestion}
                aria-label="Designation"
              />
            </div>

            {/* spacing cell */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <div style={{ width: "100%" }} />
            </div>
          </div>

          {/* Ratings */}
          <div className="se-table-wrap">
            <table className="se-table" role="table" aria-label="ratings">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {ratingOptions.map((o) => (
                    <th key={o} style={{ textAlign: "center" }}>{o}</th>
                  ))}
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p}>
                    <td>{p}</td>
                    {ratingOptions.map((opt) => (
                      <td key={opt} style={{ textAlign: "center" }}>
                        <input
                          type="radio"
                          name={p}
                          checked={ratings[p] === opt}
                          onChange={() => handleRating(p, opt)}
                          aria-label={`${p} ${opt}`}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        type="text"
                        value={ratings[`${p}_remarks`] || ""}
                        onChange={(e) => handleRemark(p, e.target.value)}
                        placeholder="Optional remark"
                        className="se-input"
                        aria-label={`${p} remarks`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Total Marks & Grade (display only, below evaluation) */}
          <div className="bottom-stats">
            <div>
              <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Computed Total Marks</div>
              <div style={{ marginTop: 4, fontWeight: 700, color: "#2e7d32" }}>{computedScore !== null ? `${computedScore} / 100` : "-"}</div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Computed Grade</div>
              <div style={{ marginTop: 4, fontWeight: 700 }}>{computedGrade || "-"}</div>
            </div>

            {selectedSuggestion?.lastDoc && (
              <div style={{ marginLeft: "auto" }}>
                <div style={{ fontSize: 12, color: "#333", fontWeight: 700 }}>Last recorded (if any)</div>
                <div className="last-record">
                  Marks: {selectedSuggestion.lastDoc.totalMarks || "-"} • Grade: {selectedSuggestion.lastDoc.grade || "-"}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="se-actions">
            <button
              type="submit"
              className="se-button se-btn-primary"
              disabled={saving}
            >
              {saving ? "Saving..." : "Submit Evaluation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
