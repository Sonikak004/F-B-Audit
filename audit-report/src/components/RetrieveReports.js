// src/components/RetrieveReports.js
import React, { useState, useMemo } from "react";
import { db } from "../firebase";
import { collection, query, where, orderBy, getDocs, limit } from "firebase/firestore";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/* ===== utils ===== */

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

const formatTodayDDMMYYYY = () => {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
};

const parseDDMMYYYYtoDate = (ddmmyy) => {
  if (!ddmmyy) return null;
  const parts = String(ddmmyy).split("/");
  if (parts.length !== 3) {
    const d = new Date(ddmmyy);
    return isNaN(d.getTime()) ? null : d;
  }
  const [dStr, mStr, yStr] = parts;
  const day = Number(dStr);
  const month = Number(mStr) - 1;
  const year = Number(yStr);
  const dt = new Date(year, month, day);
  return isNaN(dt.getTime()) ? null : dt;
};

const isoToLocalDate = (iso) => {
  if (!iso) return null;
  const parts = String(iso).split("-");
  if (parts.length === 3) {
    const [yStr, mStr, dStr] = parts;
    const y = Number(yStr);
    const m = Number(mStr) - 1;
    const d = Number(dStr);
    const dt = new Date(y, m, d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

const sanitize = (v) => (v === undefined || v === null ? "-" : String(v));

const avgScoreToLabel = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  const s = Number(n);
  if (s >= 90) return "Excellent";
  if (s >= 75) return "Good";
  if (s >= 60) return "Average";
  return "Poor";
};

const scoreBadgeColor = (score) => {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "#999";
  const s = Number(score);
  if (s >= 90) return "#2e7d32";
  if (s >= 75) return "#f0ad4e";
  return "#d9534f";
};

const withinRange = (dateDD, fromISO, toISO) => {
  const d = parseDDMMYYYYtoDate(dateDD);
  if (!d) return false;
  if (!fromISO && !toISO) return true;
  const from = fromISO ? isoToLocalDate(fromISO) : null;
  const to = toISO ? isoToLocalDate(toISO) : null;
  if (from) from.setHours(0, 0, 0, 0);
  if (to) to.setHours(23, 59, 59, 999);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
};

const dedupeById = (arr) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const id = item.id ?? JSON.stringify(item);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(item);
    }
  }
  return out;
};

const collectParameterNames = (docs) => {
  const set = new Set();
  docs.forEach((d) => {
    const r = d.ratings || {};
    Object.keys(r).forEach((k) => {
      if (k.endsWith("_remarks")) return;
      set.add(k);
    });
  });
  return Array.from(set);
};

const computeParameterStats = (docs) => {
  const params = collectParameterNames(docs);
  const ratings = ["Excellent", "Good", "Average", "Poor"];
  const stats = {};
  params.forEach((p) => {
    stats[p] = { Excellent: 0, Good: 0, Average: 0, Poor: 0, total: 0 };
  });
  docs.forEach((d) => {
    const r = d.ratings || {};
    params.forEach((p) => {
      const v = r[p];
      if (v && ratings.includes(v)) {
        stats[p][v] = (stats[p][v] || 0) + 1;
        stats[p].total = (stats[p].total || 0) + 1;
      }
    });
  });
  return { params, stats };
};

/* ===== component ===== */
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
  const [dateFromISO, setDateFromISO] = useState("");
  const [dateToISO, setDateToISO] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // filtered documents (each eval)
  const [message, setMessage] = useState("");
  const [lastError, setLastError] = useState(null);

  // employee detail state
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [employeeHistory, setEmployeeHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [employeeAverages, setEmployeeAverages] = useState({});

  // viewMode: 'list' or 'employee'
  const [viewMode, setViewMode] = useState("list");

  // Helper that builds aggregated employee rows from 'results' (one row per employee)
  const employeesAggregated = useMemo(() => {
    if (!results || results.length === 0) return [];
    const map = new Map();
    for (const r of results) {
      const code = r.empCode ? String(r.empCode).trim() : "";
      const name = r.staffName ? String(r.staffName).trim() : "";
      const key = (code || name).toLowerCase() || Math.random().toString(36).slice(2, 8);
      if (!map.has(key)) map.set(key, { empCode: code, staffName: name, recs: [] });
      map.get(key).recs.push(r);
    }
    const out = [];
    for (const val of map.values()) {
      const sorted = val.recs
        .slice()
        .sort((a, b) => {
          const ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
          const tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
          return tb - ta;
        });
      const latest = sorted[0] || val.recs[0];
      const numericScores = val.recs
        .map((d) => {
          const s = d.scoreOutOf100 ?? d.totalMarks ?? d.total ?? null;
          return s !== null && !Number.isNaN(Number(s)) ? Number(s) : null;
        })
        .filter((s) => s !== null);
      const avg = numericScores.length ? numericScores.reduce((a, b) => a + b, 0) / numericScores.length : null;
      out.push({
        empCode: val.empCode,
        staffName: val.staffName,
        count: val.recs.length,
        avg,
        label: avg !== null ? avgScoreToLabel(avg) : "-",
        branch: (latest.selection && latest.selection.branch) || latest.branch || "-",
        city: (latest.selection && latest.selection.city) || latest.city || "-",
      });
    }
    out.sort((a, b) => (a.staffName || "").localeCompare(b.staffName || ""));
    return out;
  }, [results]);

  // MAIN QUERY
  const runQuery = async () => {
    setResults([]);
    setMessage("");
    setLastError(null);
    setSelectedEmployee(null);
    setEmployeeHistory([]);
    setEmployeeAverages({});
    setViewMode("list");

    if (!branch) {
      setMessage("Please select a branch.");
      return;
    }
    if (reportType === "staff" && !dateFromISO && !dateToISO) {
      setMessage("Pick a date range (from / to) for staff reports (you can use single-day by selecting same date twice).");
      return;
    }

    setLoading(true);
    try {
      if (reportType === "unit") {
        const target = dateFromISO || dateToISO;
        if (!target) {
          setMessage("Please select a date for Unit Audit reports.");
          setLoading(false);
          return;
        }
        const dateDD = isoToDDMMYYYY(target);
        const col = collection(db, "unitAudits");
        const q = query(col, where("branch", "==", branch), where("date", "==", dateDD), orderBy("timestamp", "desc"));
        const snap = await getDocs(q);
        const docs = dedupeById(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setResults(docs);
        setMessage(docs.length ? `${docs.length} unit audit(s) found.` : "No unit audits found for that date.");
      } else {
        const col = collection(db, "staffEvaluations");
        const q = query(col, where("selection.branch", "==", branch), orderBy("createdAt", "desc"));
        const snap = await getDocs(q);
        let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        docs = docs.filter((r) => {
          const rDate = r.selection?.date ?? r.date ?? "";
          return withinRange(rDate, dateFromISO, dateToISO);
        });

        docs = dedupeById(docs);
        setResults(docs);
        setMessage(docs.length ? `${docs.length} staff evaluation(s) found in selected range.` : "No staff evaluations found in that range.");
      }
    } catch (err) {
      console.error("RetrieveReports.runQuery error:", err);
      setLastError(err);
      setMessage("Error fetching reports — see console for details: " + (err?.message || String(err)));
    } finally {
      setLoading(false);
    }
  };

  // FETCH EMPLOYEE HISTORY (deduped + range-respected)
  const fetchEmployeeHistory = async ({ empCode, staffName, openDetail = true }) => {
    setSelectedEmployee({ empCode, staffName });
    setLoadingHistory(true);
    setEmployeeHistory([]);
    setEmployeeAverages({});
    try {
      const col = collection(db, "staffEvaluations");
      let snap = null;
      if (empCode) {
        const q = query(col, where("empCode", "==", empCode), orderBy("createdAt", "desc"));
        snap = await getDocs(q);
      }
      if ((!snap || snap.empty) && staffName) {
        const q2 = query(col, where("staffName", "==", staffName), orderBy("createdAt", "desc"));
        snap = await getDocs(q2);
      }

      if (!snap || snap.empty) {
        setEmployeeHistory([]);
        setMessage("No historical evaluations found for this employee.");
        setEmployeeAverages({});
        setLoadingHistory(false);
        if (openDetail) setViewMode("employee");
        return;
      }

      let docs = dedupeById(snap.docs.map((d) => ({ id: d.id, ...d.data() })));

      if (dateFromISO || dateToISO) {
        docs = docs.filter((r) => {
          const rDate = r.selection?.date ?? r.date ?? "";
          return withinRange(rDate, dateFromISO, dateToISO);
        });
      }

      docs = dedupeById(docs);
      setEmployeeHistory(docs);

      const numericScores = docs
        .map((d) => {
          const s = d.scoreOutOf100 ?? d.totalMarks ?? d.score?.scoreOutOf100 ?? null;
          return s !== null && !Number.isNaN(Number(s)) ? Number(s) : null;
        })
        .filter((s) => s !== null);

      const avg = numericScores.length ? numericScores.reduce((a, b) => a + b, 0) / numericScores.length : null;

      setEmployeeAverages({
        avg,
        count: docs.length,
        label: avg !== null ? avgScoreToLabel(avg) : "-",
      });

      if (openDetail) setViewMode("employee");
    } catch (err) {
      console.error("fetchEmployeeHistory error", err);
      setLastError(err);
      setMessage("Error fetching employee history — see console.");
      if (openDetail) setViewMode("employee");
    } finally {
      setLoadingHistory(false);
    }
  };

  // Employee PDF
  const downloadEmployeePDF = (emp) => {
    const rows = employeeHistory || [];
    const doc = new jsPDF("p", "mm", "a4");
    const w = doc.internal.pageSize.getWidth();
    let y = 18;

    // Header: title + meta
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – STAFF EVALUATION (Employee Summary)", w / 2, y, { align: "center" });
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const auditorFromFirst = (rows[0] && (rows[0].selection?.auditor || rows[0].auditor)) || "Kumar Kannaiyan";
    doc.text(`Audited by: ${auditorFromFirst}`, 14, y);
    doc.text(`Report made: ${formatTodayDDMMYYYY()}`, w - 14, y, { align: "right" });
    y += 6;

    doc.text(`Employee: ${emp.staffName || "-"}`, 14, y);
    doc.text(`Emp Code: ${emp.empCode || "-"}`, w - 14, y, { align: "right" });
    y += 6;

    doc.text(`Branch: ${branch}`, 14, y);
    const rangeText = `${dateFromISO ? isoToDDMMYYYY(dateFromISO) : "—"} to ${dateToISO ? isoToDDMMYYYY(dateToISO) : "—"}`;
    doc.text(`Range: ${rangeText}`, w - 14, y, { align: "right" });
    y += 8;

    // average summary
    const avgObj = employeeAverages || {};
    const avgText = avgObj.avg !== null && avgObj.avg !== undefined ? `${Number(avgObj.avg).toFixed(1)} / 100` : "-";
    doc.setFont("helvetica", "bold");
    doc.text(`Average (range): ${avgText} • ${avgObj.label || "-"} • (${avgObj.count || 0} recs)`, 14, y);
    y += 8;

    // History table
    const tableBody = rows.map((r) => {
      const date = r.selection?.date ?? r.date ?? "-";
      const score = r.scoreOutOf100 ?? r.totalMarks ?? "-";
      const grade = r.grade ?? "-";
      const branchName = r.selection?.branch ?? r.branch ?? "-";
      const note = (r.ratings && Object.keys(r.ratings).length ? "Has ratings" : (r.observations || "-"));
      return [String(date), String(score), String(grade), String(branchName), String(note)];
    });

    autoTable(doc, {
      startY: y,
      head: [["Date", "Score", "Grade", "Branch", "Note"]],
      body: tableBody,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255 },
      columnStyles: { 0: { cellWidth: 28 }, 1: { cellWidth: 22, halign: "center" }, 2: { cellWidth: 16, halign: "center" }, 3: { cellWidth: 40 }, 4: { cellWidth: 70 } },
    });

    // Parameter breakdown for this employee (if ratings present)
    const pStartY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 8;
    const paramsStats = computeParameterStats(rows);
    if (paramsStats.params.length) {
      const pBody = paramsStats.params.map((p) => {
        const s = paramsStats.stats[p];
        return [
          p,
          String(s.Excellent || 0),
          String(s.Good || 0),
          String(s.Average || 0),
          String(s.Poor || 0),
          String(s.total || 0),
        ];
      });

      autoTable(doc, {
        startY: pStartY,
        head: [["Parameter", "Excellent", "Good", "Average", "Poor", "Total rated"]],
        body: pBody,
        theme: "grid",
        styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [41, 128, 185], textColor: 255 },
        columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 20, halign: "center" }, 2: { cellWidth: 20, halign: "center" }, 3: { cellWidth: 20, halign: "center" }, 4: { cellWidth: 20, halign: "center" }, 5: { cellWidth: 20, halign: "center" } },
      });
    }

    const safeName = (emp.staffName || "employee").replace(/\s+/g, "_");
    const safeRange = `${dateFromISO ? isoToDDMMYYYY(dateFromISO) : "from"}_${dateToISO ? isoToDDMMYYYY(dateToISO) : "to"}`;
    doc.save(`${safeName}_History_${safeRange}.pdf`);
  };

  // Summary PDF for all employees in the results (with parameter aggregation)
  const downloadSummaryPDF = () => {
    if (!results || results.length === 0) {
      alert("No evaluations to summarize. Run the search first.");
      return;
    }

    const employeesAgg = employeesAggregated;
    if (!employeesAgg.length) {
      alert("No employees found in results.");
      return;
    }

    const doc = new jsPDF("p", "mm", "a4");
    const w = doc.internal.pageSize.getWidth();
    let y = 18;

    // Header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("SUKINO HEALTH CARE – STAFF EVALUATION (Summary)", w / 2, y, { align: "center" });
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const auditorFromFirst = (results[0] && (results[0].selection?.auditor || results[0].auditor)) || "Kumar Kannaiyan";
    doc.text(`Audited by: ${auditorFromFirst}`, 14, y);
    doc.text(`Report made: ${formatTodayDDMMYYYY()}`, w - 14, y, { align: "right" });
    y += 6;

    doc.text(`Branch: ${branch}`, 14, y);
    const rangeText = `${dateFromISO ? isoToDDMMYYYY(dateFromISO) : "—"} to ${dateToISO ? isoToDDMMYYYY(dateToISO) : "—"}`;
    doc.text(`Range: ${rangeText}`, w - 14, y, { align: "right" });
    y += 8;

    // Employees table (no 'Recs' column; compact)
    const tableBody = employeesAgg.map((e) => {
      const avgText = e.avg !== null && e.avg !== undefined ? Number(e.avg).toFixed(1) : "-";
      return [e.staffName || "-", e.empCode || "-", avgText, e.label || "-", e.branch || "-", e.city || "-"];
    });

    autoTable(doc, {
      startY: y,
      head: [["Name", "Emp Code", "Avg Marks", "Avg Grade", "Branch", "City"]],
      body: tableBody,
      theme: "grid",
      styles: { font: "helvetica", fontSize: 10, cellPadding: 3 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255 },
      columnStyles: { 0: { cellWidth: 40 }, 1: { cellWidth: 28 }, 2: { cellWidth: 28, halign: "center" }, 3: { cellWidth: 28, halign: "center" }, 4: { cellWidth: 30 }, 5: { cellWidth: 30 } },
    });

    // Parameter aggregate across all results
    const pStart = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 8;
    const paramInfo = computeParameterStats(results);
    if (paramInfo.params.length) {
      const pBody = paramInfo.params.map((p) => {
        const s = paramInfo.stats[p];
        return [
          p,
          String(s.Excellent || 0),
          String(s.Good || 0),
          String(s.Average || 0),
          String(s.Poor || 0),
          String(s.total || 0),
        ];
      });

      autoTable(doc, {
        startY: pStart,
        head: [["Parameter", "Excellent", "Good", "Average", "Poor", "Total rated"]],
        body: pBody,
        theme: "grid",
        styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [41, 128, 185], textColor: 255 },
        columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 20, halign: "center" }, 2: { cellWidth: 20, halign: "center" }, 3: { cellWidth: 20, halign: "center" }, 4: { cellWidth: 20, halign: "center" }, 5: { cellWidth: 20, halign: "center" } },
      });
    }

    const safeRange = `${dateFromISO ? isoToDDMMYYYY(dateFromISO) : "from"}_${dateToISO ? isoToDDMMYYYY(dateToISO) : "to"}`;
    doc.save(`Staff_Summary_${branch.replace(/\s+/g, "_")}_${safeRange}.pdf`);
  };

  const downloadJSON = (items, name) => {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const setPresetMonth = (year, monthIndex) => {
    const from = new Date(year, monthIndex, 1);
    const to = new Date(year, monthIndex + 1, 0);
    const toISO = to.toISOString().slice(0, 10);
    const fromISO = from.toISOString().slice(0, 10);
    setDateFromISO(fromISO);
    setDateToISO(toISO);
  };

  const handleBackFromEmployee = () => {
    setViewMode("list");
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 18 }}>
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
            <label style={{ fontWeight: 700 }}>Date range</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input type="date" value={dateFromISO} onChange={(e) => setDateFromISO(e.target.value)} style={{ padding: 8, flex: 1 }} />
              <input type="date" value={dateToISO} onChange={(e) => setDateToISO(e.target.value)} style={{ padding: 8, flex: 1 }} />
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              <button type="button" onClick={() => { const now = new Date(); setPresetMonth(now.getFullYear(), now.getMonth()); }} className="btn btn-sm">This month</button>
              <button type="button" onClick={() => { const now = new Date(); const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1); setPresetMonth(prev.getFullYear(), prev.getMonth()); }} className="btn btn-sm">Last month</button>
              <button type="button" onClick={() => { setDateFromISO(""); setDateToISO(""); }} className="btn btn-sm">Clear</button>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={runQuery} className="btn btn-primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>

          <button onClick={() => { setBranch(""); setDateFromISO(""); setDateToISO(""); setReportType("unit"); setResults([]); setMessage(""); setLastError(null); setSelectedEmployee(null); setEmployeeHistory([]); setEmployeeAverages({}); setViewMode("list"); }} className="btn btn-outline-secondary" disabled={loading}>
            Reset
          </button>

          <button onClick={async () => { setMessage(""); setLastError(null); try { const col = collection(db, "unitAudits"); const q = query(col, orderBy("timestamp", "desc"), limit(1)); await getDocs(q); setMessage("Quick test OK — Firestore reachable."); } catch (err) { console.error(err); setLastError(err); setMessage("Quick test failed — see console."); } }} className="btn btn-outline-secondary" disabled={loading}>
            Quick test
          </button>
        </div>
      </div>

      {loading && <div style={{ marginBottom: 12 }}>Loading...</div>}
      {message && <div style={{ marginBottom: 8 }}>{message}</div>}
      {lastError && (
        <details style={{ background: "#fff3cd", padding: 8, borderRadius: 6, marginBottom: 12 }}>
          <summary style={{ fontWeight: 700 }}>Last error (expand)</summary>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{String(lastError?.message || lastError)}</pre>
        </details>
      )}

      {/* Employee detail page */}
      {viewMode === "employee" && selectedEmployee && (
        <div style={{ border: "1px solid #e6e6e6", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={handleBackFromEmployee} className="btn btn-ghost">← Back</button>
              <div>
                <strong style={{ fontSize: 16 }}>{selectedEmployee.staffName || "-"}</strong>
                <div style={{ color: "#666", fontSize: 13 }}>{selectedEmployee.empCode || "-"}</div>
              </div>
            </div>

            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, color: "#333", fontWeight: 700 }}>Average (range)</div>
              <div style={{ fontWeight: 700 }}>{employeeAverages.avg !== null && employeeAverages.avg !== undefined ? `${Number(employeeAverages.avg).toFixed(1)} / 100` : "-"}</div>
              <div style={{ color: "#666", fontSize: 13 }}>{employeeAverages.label || "-"} • ({employeeAverages.count || 0} recs)</div>
            </div>
          </div>

          {loadingHistory ? (
            <div>Loading history…</div>
          ) : employeeHistory.length === 0 ? (
            <div style={{ color: "#666" }}>No evaluations found for this employee in the selected range.</div>
          ) : (
            <>
              <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #f1f1f1", borderRadius: 6 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "left" }}>#</th>
                      <th style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "left" }}>Date</th>
                      <th style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "left" }}>Score</th>
                      <th style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "left" }}>Grade</th>
                      <th style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "left" }}>Branch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeHistory.map((rec, i) => {
                      const score = rec.scoreOutOf100 ?? rec.totalMarks ?? null;
                      const numericScore = score !== null && !Number.isNaN(Number(score)) ? Number(score) : null;
                      return (
                        <tr key={rec.id || i}>
                          <td style={{ padding: 6, borderBottom: "1px solid #f7f7f7" }}>{i + 1}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #f7f7f7" }}>{sanitize(rec.selection?.date ?? rec.date ?? "-")}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #f7f7f7" }}>{numericScore !== null ? `${numericScore} / 100` : "-"}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #f7f7f7" }}>{rec.grade || "-"}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #f7f7f7" }}>{sanitize(rec.selection?.branch ?? rec.branch)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button onClick={() => downloadEmployeePDF(selectedEmployee)} className="btn btn-primary">📄 Download person PDF</button>
                <button onClick={() => downloadJSON(employeeHistory, `${(selectedEmployee.staffName || "employee").replace(/\s+/g,"_")}_history`)} className="btn btn-outline-secondary">Download JSON</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Main results table */}
      <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 8, padding: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div>
            <strong>{results.length} result(s)</strong>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {reportType === "staff" && results.length > 0 && (
              <button onClick={() => downloadSummaryPDF()} className="btn btn-primary">📄 Download summary PDF</button>
            )}
            <button onClick={() => downloadJSON(results, `${branch}_${reportType}_${dateFromISO || dateToISO || "date"}`)} className="btn btn-outline-secondary">Download JSON</button>
          </div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #eee", padding: 8 }}>#</th>
              {reportType === "unit" ? (
                <>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Date</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Branch</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>City</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Score</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Actions</th>
                </>
              ) : (
                <>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Staff Name</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Branch</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>City</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Evaluations</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Avg</th>
                  <th style={{ border: "1px solid #eee", padding: 8 }}>Actions</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {reportType === "unit" && results.map((r, i) => {
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
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.selection?.date ?? r.date ?? "-")}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.selection?.branch ?? r.branch)}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(r.selection?.city ?? r.city)}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 12, background: badgeColor }} aria-hidden />
                      <span>{scoreText}</span>
                    </div>
                  </td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => alert("Unit PDF (existing)")} className="btn btn-sm btn-outline-primary">PDF</button>
                      <button onClick={() => downloadJSON([r], `record_${r.id || i}`)} className="btn btn-sm btn-outline-secondary">JSON</button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {reportType === "staff" && employeesAggregated.map((emp, idx) => {
              const avgText = emp.avg !== null && emp.avg !== undefined ? `${Number(emp.avg).toFixed(1)} / 100` : "-";
              const badgeColor = scoreBadgeColor(emp.avg);
              return (
                <tr key={`${emp.empCode || emp.staffName}-${idx}`}>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{idx + 1}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>
                    <span
                      style={{ color: "#1976d2", cursor: "pointer", textDecoration: "underline" }}
                      onClick={() => fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName })}
                    >
                      {sanitize(emp.staffName)}
                    </span>
                    <div style={{ fontSize: 12, color: "#666" }}>{emp.empCode || "-"}</div>
                  </td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(emp.branch)}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>{sanitize(emp.city)}</td>
                  <td style={{ border: "1px solid #eee", padding: 8, textAlign: "center" }}>{emp.count}</td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 12, background: badgeColor }} aria-hidden />
                      <span>{avgText}</span>
                    </div>
                  </td>
                  <td style={{ border: "1px solid #eee", padding: 8 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName })} className="btn btn-sm btn-outline-primary">Open</button>
                      <button onClick={() => { setSelectedEmployee(emp); fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName, openDetail: false }); downloadEmployeePDF(emp); }} className="btn btn-sm btn-outline-secondary">PDF</button>
                      <button onClick={() => {
                        const docs = results.filter((r) => {
                          const code = r.empCode ? String(r.empCode).trim() : "";
                          const name = r.staffName ? String(r.staffName).trim() : "";
                          if (emp.empCode) return code === emp.empCode;
                          return name === emp.staffName;
                        });
                        downloadJSON(docs, `${(emp.staffName || "employee").replace(/\s+/g,"_")}_range`);
                      }} className="btn btn-sm btn-outline-secondary">JSON</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
