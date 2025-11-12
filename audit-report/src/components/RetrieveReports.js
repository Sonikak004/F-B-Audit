// src/components/RetrieveReports.js (updated: cleaner PDF header + score badge)
import React, { useState } from "react";
import { db } from "../firebase";
import { collection, query, where, orderBy, getDocs, limit } from "firebase/firestore";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* ===== utils ===== */

// Convert yyyy-mm-dd (input[type=date]) to dd/mm/yyyy
const isoToDDMMYYYY = (iso) => {
  if (!iso) return "";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(iso)) return iso;
  const parts = String(iso).split("-");
  if (parts.length === 3) {
    const [y, m, d] = parts;
    return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
  }
  const dt = new Date(iso);
  if (!isNaN(dt.getTime())) {
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const yyyy = dt.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  return iso;
};

const sanitize = (v) => (v === undefined || v === null ? "-" : String(v));

const scoreBadgeColor = (score) => {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "#999"; // gray
  const s = Number(score);
  if (s >= 90) return "#2e7d32"; // green
  if (s >= 75) return "#f0ad4e"; // yellow/orange
  return "#d9534f"; // red
};

export default function RetrieveReports({ goBack }) {
  const branches = [
    "HSR Layout",
    "Koramangala",
    "Whitefield",
    "Bannerghatta Road",
    "Electronic City",
    "Kochi",
    "Coimbatore",
  ];

  const [branch, setBranch] = useState("");
  const [reportType, setReportType] = useState("unit");
  const [dateISO, setDateISO] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [message, setMessage] = useState("");
  const [lastError, setLastError] = useState(null);

  // Robust query runner with debug logging
  const runQuery = async () => {
    setResults([]);
    setMessage("");
    setLastError(null);

    if (!branch) {
      setMessage("Please select a branch.");
      return;
    }
    if (!dateISO) {
      setMessage("Please select a date (required).");
      return;
    }

    const dateDD = isoToDDMMYYYY(dateISO);
    setLoading(true);
    try {
      if (reportType === "unit") {
        const col = collection(db, "unitAudits");
        const q = query(col, where("branch", "==", branch), where("date", "==", dateDD), orderBy("timestamp", "desc"));
        console.info("Running query (unit):", { branch, dateDD, q });
        const snap = await getDocs(q);
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setResults(docs);
        setMessage(docs.length ? `${docs.length} unit audit(s) found.` : "No unit audits found for that date.");
      } else {
        const col = collection(db, "staffEvaluations");
        const q = query(col, where("selection.branch", "==", branch), where("selection.date", "==", isoToDDMMYYYY(dateISO)), orderBy("createdAt", "desc"));
        console.info("Running query (staff):", { branch, dateDD, q });
        const snap = await getDocs(q);
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setResults(docs);
        setMessage(docs.length ? `${docs.length} staff evaluation(s) found.` : "No staff evaluations found for that date.");
      }
    } catch (err) {
      console.error("RetrieveReports.runQuery error:", err);
      setLastError(err);
      if (err?.message && err.message.includes("index")) {
        setMessage("Firestore index required for this query. Check the browser console — the error contains a link to create the index.");
      } else if (err?.code === "permission-denied") {
        setMessage("Permission denied: your Firestore rules block this read. Ensure the app is authenticated or rules allow reads for this collection.");
      } else {
        setMessage("Error fetching reports — see console for details: " + (err?.message || String(err)));
      }
    } finally {
      setLoading(false);
    }
  };

  // Quick diagnostic sample query to test connectivity/rules
  const runQuickTest = async () => {
    setMessage("");
    setLastError(null);
    setLoading(true);
    try {
      const col = collection(db, "unitAudits");
      const q = query(col, orderBy("timestamp", "desc"), limit(1));
      const snap = await getDocs(q);
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      console.info("Quick test docs:", docs);
      setMessage(docs.length ? "Quick test OK — Firestore reachable." : "Quick test OK — no unitAudits found.");
    } catch (err) {
      console.error("Quick test error:", err);
      setLastError(err);
      if (err?.code === "permission-denied") setMessage("Quick test failed: permission-denied (check Firestore rules/auth).");
      else setMessage("Quick test failed — see console for details.");
    } finally {
      setLoading(false);
    }
  };

  // Download helpers
  const downloadJSON = (items, name) => {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadUnitPDF = (rec) => {
    const doc = new jsPDF("p", "mm", "a4");
    const baseFont = "helvetica";
    const w = doc.internal.pageSize.getWidth();

    // Title
    doc.setFont(baseFont, "bold");
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – F&B UNIT AUDIT REPORT", w / 2, 18, { align: "center" });

    // Audited by F&B Manager + name (centered)
    doc.setFont(baseFont, "normal");
    doc.setFontSize(11);
    doc.text("Audited by F&B Manager", w / 2, 26, { align: "center" });

    const auditorName = sanitize(rec.auditor || rec.selection?.auditor || "Kumar Kannaiyan");
    doc.setFont(baseFont, "bold");
    doc.setFontSize(12);
    doc.text(auditorName, w / 2, 33, { align: "center" });

    // Branch / City on left, Date and Score on right
    doc.setFont(baseFont, "normal");
    doc.setFontSize(10);
    const d = sanitize(rec.date || rec.selection?.date || isoToDDMMYYYY(dateISO));
    doc.text(`Branch: ${sanitize(rec.branch || rec.selection?.branch || "-")}`, 14, 42);
    doc.text(`City: ${sanitize(rec.city || rec.selection?.city || "-")}`, 14, 48);

    const score = rec.scoreOutOf100 ?? rec.score?.scoreOutOf100 ?? rec.scoreBreakdown?.scoreOutOf100 ?? null;
    const scoreText = score !== null ? `Score: ${score} / 100` : "Score: -";
    doc.text(`Date: ${d}`, w - 14, 42, { align: "right" });
    doc.text(scoreText, w - 14, 48, { align: "right" });

    // Add the three tables (kitchen/hygiene/food) if present
    const objToRows = (obj) => Object.entries(obj || {}).map(([k, v]) => [String(k), String(v || "-")]);
    try {
      if (rec.kitchen) {
        autoTable(doc, {
          startY: doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 56,
          head: [["Kitchen", "Status"]],
          body: objToRows(rec.kitchen),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40 } },
        });
      }
      if (rec.hygiene) {
        autoTable(doc, {
          startY: doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 56,
          head: [["Hygiene", "Status"]],
          body: objToRows(rec.hygiene),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40 } },
        });
      }
      if (rec.foodSafety) {
        autoTable(doc, {
          startY: doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 56,
          head: [["Food Safety", "Status"]],
          body: objToRows(rec.foodSafety),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40 } },
        });
      }
    } catch (err) {
      console.warn("autotable error", err);
    }

    // Remarks
    let y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 10 : 56;
    const addBlock = (label, text) => {
      doc.setFont(baseFont, "bold");
      doc.setFontSize(10);
      doc.text(label, 14, y);
      doc.setFont(baseFont, "normal");
      doc.setFontSize(9);
      const split = doc.splitTextToSize(text || "-", 180);
      doc.text(split, 14, y + 6);
      y += split.length * 5 + 10;
    };
    addBlock("Observations:", rec.observations || rec.selection?.observations || "-");
    addBlock("Maintenance / Suggestions:", rec.maintenance || rec.selection?.maintenance || "-");
    addBlock("Action Plan / Corrective Measures:", rec.actionPlan || rec.selection?.actionPlan || rec.selection?.action || "-");

    // Footer
    doc.setFontSize(9);
    const footer = `Audit report as on ${d} – ${sanitize(rec.branch || rec.selection?.branch || "-")} (by ${auditorName})`;
    doc.text(footer, w / 2, doc.internal.pageSize.getHeight() - 10, { align: "center" });

    const safeBranch = (rec.branch || rec.selection?.branch || "Branch").replace(/\s+/g, "_");
    const safeDate = (d || "date").replace(/\s+/g, "_");
    doc.save(`${safeBranch}_Audit_${safeDate}.pdf`);
  };

  const downloadStaffPDF = (rec) => {
    const doc = new jsPDF("p", "mm", "a4");
    const baseFont = "helvetica";
    const w = doc.internal.pageSize.getWidth();
    doc.setFont(baseFont);
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – STAFF EVALUATION REPORT", w / 2, 15, { align: "center" });

    doc.setFontSize(10);
    const leftX = 14;
    const rightMargin = 14;
    const aud = sanitize(rec.selection?.auditor || "Kumar Kannaiyan");
    const d = sanitize(rec.selection?.date || isoToDDMMYYYY(dateISO));
    doc.text(`Auditor: ${aud}`, leftX, 25);
    const dateText = `Date: ${d}`;
    doc.text(dateText, w - rightMargin - doc.getTextWidth(dateText), 25);

    doc.text(`Branch: ${sanitize(rec.selection?.branch)}`, leftX, 30);
    doc.text(`City: ${sanitize(rec.selection?.city)}`, w - rightMargin - doc.getTextWidth(sanitize(rec.selection?.city)), 30);

    doc.text(`Staff Name: ${sanitize(rec.staffName)}`, 14, 38);
    doc.text(`Emp Code: ${sanitize(rec.empCode)}`, 14, 43);
    doc.text(`Designation: ${sanitize(rec.designation)}`, 14, 48);
    doc.text(`Total Marks: ${sanitize(rec.totalMarks)}`, w - 80, 43);
    doc.text(`Grade: ${sanitize(rec.grade)}`, w - 80, 48);

    const rows = [];
    const ratings = rec.ratings || {};
    const keys = Object.keys(ratings).filter((k) => !k.endsWith("_remarks"));
    keys.forEach((k) => {
      rows.push([k, sanitize(ratings[k]), sanitize(ratings[`${k}_remarks`])]);
    });

    autoTable(doc, { startY: 55, head: [["Parameter", "Rating", "Remarks"]], body: rows, theme: "grid", styles: { font: baseFont, fontSize: 9 }, columnStyles: { 0: { cellWidth: 80 }, 1: { cellWidth: 30, halign: "center" }, 2: { cellWidth: 70 } } });

    doc.setFontSize(9);
    const footer = `Staff Evaluation Report – ${sanitize(rec.selection?.branch)} (${d}) by ${aud}`;
    doc.text(footer, w / 2, doc.internal.pageSize.getHeight() - 10, { align: "center" });

    const safeBranch = (rec.selection?.branch || "Branch").replace(/\s+/g, "_");
    const safeDate = (d || "date").replace(/\s+/g, "_");
    doc.save(`${safeBranch}_StaffEval_${safeDate}_${sanitize(rec.empCode || "unknown")}.pdf`);
  };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button onClick={goBack} style={{ padding: "6px 10px" }}>← Back</button>
        <h3 style={{ margin: 0, color: "#1976d2" }}>Retrieve Reports</h3>
        <div style={{ width: 40 }} />
      </div>

      <div style={{ border: "1px solid #e6e6e6", borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontWeight: 700 }}>Branch</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }}>
              <option value="">-- Select Branch --</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <label style={{ fontWeight: 700 }}>Report Type</label>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }}>
              <option value="unit">Unit Audit</option>
              <option value="staff">Staff Evaluations</option>
            </select>
          </div>

          <div>
            <label style={{ fontWeight: 700 }}>Date (required)</label>
            <input type="date" value={dateISO} onChange={(e) => setDateISO(e.target.value)} style={{ width: "100%", padding: 8, marginTop: 6 }} />
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Pick the report date (required)</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={runQuery} className="btn btn-primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>

          <button onClick={() => { setBranch(""); setDateISO(""); setReportType("unit"); setResults([]); setMessage(""); setLastError(null); }} className="btn btn-outline-secondary" disabled={loading}>
            Reset
          </button>

          <button onClick={runQuickTest} className="btn btn-outline-secondary" disabled={loading}>
            Quick connection test
          </button>
        </div>
      </div>

      {loading && <div style={{ marginBottom: 12 }}>Loading... (if this persists, check browser console for errors)</div>}

      {message && <div style={{ marginBottom: 8 }}>{message}</div>}

      {lastError && (
        <details style={{ background: "#fff3cd", padding: 8, borderRadius: 6, marginBottom: 12 }}>
          <summary style={{ fontWeight: 700 }}>Last error (expand for details)</summary>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{String(lastError?.message || lastError)}</pre>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            Tip: if the error mentions an index, click the index link in the browser console or create a composite index in Firebase console for the fields used in the query.
          </div>
        </details>
      )}

      {results.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>{results.length} result(s)</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => downloadJSON(results, `${branch}_${reportType}_${isoToDDMMYYYY(dateISO)}`)} className="btn btn-outline-secondary">Download JSON</button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>#</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Date</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>{reportType === "unit" ? "Auditor" : "Staff Name"}</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Branch</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>City</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Score</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const score =
                    r.scoreOutOf100 ??
                    r.score?.scoreOutOf100 ??
                    r.score?.score ??
                    r.scoreBreakdown?.scoreOutOf100 ??
                    r.totalMarks ??
                    null;
                  const numericScore = score !== null && !Number.isNaN(Number(score)) ? Number(score) : null;
                  const badgeColor = scoreBadgeColor(numericScore);
                  const scoreText = numericScore !== null ? `${numericScore} / 100` : "-";

                  return (
                    <tr key={r.id || i}>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>{i + 1}</td>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.date ?? r.selection?.date ?? isoToDDMMYYYY(dateISO))}</td>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>{reportType === "unit" ? sanitize(r.auditor) : sanitize(r.staffName)}</td>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.branch ?? r.selection?.branch)}</td>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.city ?? r.selection?.city)}</td>
                      <td style={{ border: "1px solid #eee", padding: 8, verticalAlign: "middle" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 12, background: badgeColor, boxShadow: "0 0 0 2px rgba(0,0,0,0.03)" }} aria-hidden />
                          <span>{scoreText}</span>
                        </div>
                      </td>
                      <td style={{ border: "1px solid #eee", padding: 8 }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => (reportType === "unit" ? downloadUnitPDF(r) : downloadStaffPDF(r))} className="btn btn-sm btn-outline-primary">PDF</button>
                          <button onClick={() => downloadJSON([r], `record_${r.id || i}`)} className="btn btn-sm btn-outline-secondary">JSON</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && results.length === 0 && message && <div style={{ marginTop: 12, color: "#666" }}>{message}</div>}
    </div>
  );
}
