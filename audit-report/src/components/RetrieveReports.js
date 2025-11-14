// src/components/RetrieveReports.js
import React, { useState, useMemo } from "react";
import { db } from "../firebase";
import { collection, query, where, orderBy, getDocs } from "firebase/firestore";
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
    "Manyata",
    "Kochi",
    "Coimbatore",
  ];

  const [branch, setBranch] = useState("");
  const [reportType, setReportType] = useState("unit");
  const [dateFromISO, setDateFromISO] = useState("");
  const [dateToISO, setDateToISO] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // filtered documents (each eval or audit)
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
          const ta = (a.timestamp && a.timestamp.seconds) || (a.createdAt && a.createdAt.seconds) || 0;
          const tb = (b.timestamp && b.timestamp.seconds) || (b.createdAt && b.createdAt.seconds) || 0;
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

    // For both unit and staff we need at least one date input (from or to) to filter range.
    if (!dateFromISO && !dateToISO) {
      setMessage("Please pick a date range (From / To). Use same date twice for single-day queries.");
      return;
    }

    setLoading(true);
    try {
      if (reportType === "unit") {
        // Fetch all unitAudits for branch ordered by timestamp then filter client-side by date (dd/mm/yyyy)
        const col = collection(db, "unitAudits");
        const q = query(col, where("branch", "==", branch), orderBy("timestamp", "desc"));
        const snap = await getDocs(q);
        let docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        // filter by date field (dd/mm/yyyy)
        docs = docs.filter((r) => {
          const rDate = r.date ?? r.selection?.date ?? "";
          return withinRange(rDate, dateFromISO, dateToISO);
        });

        docs = dedupeById(docs);
        setResults(docs);
        setMessage(docs.length ? `${docs.length} unit audit(s) found in selected range.` : "No unit audits found in that range.");
      } else {
        // Staff evaluations: fetch by selection.branch then filter by selection.date range
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

      // respect the currently selected date range if any
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

  // === Unit PDF generator: header adjusted per your request ===
  const downloadUnitPDF = (rec) => {
    const doc = new jsPDF("p", "mm", "a4");
    const baseFont = "helvetica";
    const w = doc.internal.pageSize.getWidth();
    let y = 18;

    // Title: only UNIT AUDIT REPORT
    doc.setFont(baseFont, "bold");
    doc.setFontSize(14);
    doc.text("Sukino Healthcare - UNIT AUDIT REPORT", w / 2, y, { align: "center" });
    y += 8;

    // Audited by: F&B Manager Kumar Kannaiyan (fixed text)
    doc.setFont(baseFont, "normal");
    doc.setFontSize(11);
    doc.text("Audited by: F&B Manager - Kumar Kannaiyan", 14, y);
    y += 8;

    // Branch / City / Date / Score
    doc.setFontSize(10);
    doc.text(`Branch: ${sanitize(rec.branch || rec.selection?.branch)}`, 14, y);
    doc.text(`City: ${sanitize(rec.city || rec.selection?.city)}`, 14, y + 6);
    const dateText = `Date: ${sanitize(rec.date ?? rec.selection?.date ?? isoToDDMMYYYY(dateFromISO || dateToISO || ""))}`;
    doc.text(dateText, w - 14, y, { align: "right" });
    const score = rec.scoreOutOf100 ?? rec.score?.scoreOutOf100 ?? rec.score?.score ?? rec.scoreBreakdown?.scoreOutOf100 ?? null;
    const scoreText = score !== null ? `Score: ${score} / 100` : "Score: -";
    doc.text(scoreText, w - 14, y + 6, { align: "right" });
    y += 12;

    // Helper to convert map/object fields to rows
    const objToRows = (obj) => {
      if (!obj || typeof obj !== "object") return [];
      return Object.entries(obj).map(([k, v]) => [String(k), String(v ?? "-")]);
    };

    try {
      if (rec.kitchen && Object.keys(rec.kitchen).length) {
        autoTable(doc, {
          startY: y,
          head: [["Kitchen", "Status"]],
          body: objToRows(rec.kitchen),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 50 } },
        });
        y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      }

      if (rec.hygiene && Object.keys(rec.hygiene).length) {
        autoTable(doc, {
          startY: y,
          head: [["Hygiene", "Status"]],
          body: objToRows(rec.hygiene),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 50 } },
        });
        y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      }

      if (rec.foodSafety && Object.keys(rec.foodSafety).length) {
        autoTable(doc, {
          startY: y,
          head: [["Food Safety", "Status"]],
          body: objToRows(rec.foodSafety),
          theme: "grid",
          styles: { font: baseFont, fontSize: 9 },
          headStyles: { fillColor: [41, 128, 185], textColor: 255 },
          columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 50 } },
        });
        y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      }
    } catch (err) {
      console.warn("autotable error in unit PDF:", err);
    }

    // Observations / Maintenance / Action plan
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
    const footer = `Audit report as on ${sanitize(rec.date ?? rec.selection?.date ?? isoToDDMMYYYY(dateFromISO || dateToISO || ""))} – ${sanitize(rec.branch || rec.selection?.branch || "-")}`;
    doc.text(footer, w / 2, doc.internal.pageSize.getHeight() - 10, { align: "center" });

    const safeBranch = (rec.branch || rec.selection?.branch || "Branch").replace(/\s+/g, "_");
    const safeDate = (sanitize(rec.date ?? rec.selection?.date ?? isoToDDMMYYYY(dateFromISO || dateToISO || "")) || "date").replace(/\s+/g, "_");
    doc.save(`${safeBranch}_Audit_${safeDate}.pdf`);
  };

  // Employee PDF (unchanged)
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

    // Employees table (compact)
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

  /* ===== styles (embedded so copy-paste is easiest) ===== */
  const styles = `
    .rr-container { max-width: 1100px; margin: 0 auto; padding: 18px; }
    .rr-card { border: 1px solid #e6e6e6; border-radius: 8px; padding: 12px; margin-bottom: 12px; box-sizing: border-box; background: #fff; }
    .controls-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; box-sizing: border-box; }
    .controls-grid > div { min-width: 0; overflow: hidden; } /* avoids children overflowing */
    .controls-grid select, .controls-grid input { width: 100%; box-sizing: border-box; min-height: 38px; padding: 8px; }
    input[type="date"] { width: 100%; box-sizing: border-box; padding-right: 12px; min-width: 0; }
    input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; padding: 0 6px; }
    .controls-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .quick-buttons { display: flex; gap: 8px; margin-top: 8px; flex-wrap: nowrap; align-items: center; overflow: visible; }
    .quick-buttons .quick-btn { padding: 8px 10px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; font-size: 13px; }
    .quick-btn-this { background: #1976d2; color: #fff; border-color: #1976d2; }
    .quick-btn-last { background: #f0ad4e; color: #fff; border-color: #f0ad4e; }
    .quick-btn-clear { background: #fff; color: #333; border: 1px solid #d0d7de; }
    .btn { padding: 10px 14px; border-radius: 6px; border: 1px solid #d0d7de; background: #fff; cursor: pointer; }
    .btn-primary { background: #1976d2; color: #fff; border-color: #1976d2; }
    .btn-sm { padding: 6px 8px; font-size: 13px; border-radius: 6px; background: #fff; border: 1px solid #ddd; cursor: pointer; }
    .rr-table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid #eee; border-radius: 8px; padding: 8px; }
    .rr-table { width: 100%; border-collapse: collapse; min-width: 540px; }
    .rr-table th, .rr-table td { border: 1px solid #f3f4f6; padding: 8px; text-align: left; vertical-align: middle; }
    .link-like { color: #1976d2; cursor: pointer; text-decoration: underline; display: inline-block; }
    .employee-panel { border: 1px solid #e6e6e6; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #fff; }
    @media (max-width: 900px) {
      .controls-grid { grid-template-columns: repeat(2, 1fr); }
      .rr-table { min-width: 640px; }
    }
    @media (max-width: 720px) {
      .controls-grid { grid-template-columns: 1fr; }
      .controls-actions { flex-direction: column; }
      .rr-table { min-width: 520px; font-size: 14px; }
      .btn { width: 100%; box-sizing: border-box; }
      /* MAKE QUICK BUTTONS VERTICAL on small screens */
      .quick-buttons { flex-direction: column; gap: 6px; align-items: stretch; }
      .quick-buttons .quick-btn { width: 100%; display: inline-block; box-sizing: border-box; white-space: normal; text-align: center; }
    }
  `;

  return (
    <div className="rr-container">
      <style>{styles}</style>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <button onClick={goBack} style={{ padding: "6px 10px" }}>← Back</button>
        <h3 style={{ margin: 0, color: "#1976d2" }}>Retrieve Reports</h3>
        <div style={{ width: 40 }} />
      </div>

      <div className="rr-card">
        <div className="controls-grid">
          <div>
            <label style={{ fontWeight: 700 }}>Branch</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} style={{ marginTop: 6 }}>
              <option value="">-- Select Branch --</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <label style={{ fontWeight: 700 }}>Report Type</label>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)} style={{ marginTop: 6 }}>
              <option value="unit">Unit Audit</option>
              <option value="staff">Staff Evaluations</option>
            </select>
          </div>

          <div>
            <label style={{ fontWeight: 700 }}>Date range</label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                type="date"
                value={dateFromISO}
                onChange={(e) => setDateFromISO(e.target.value)}
                aria-label="Date from"
                style={{ minWidth: 0 }}
              />
              <input
                type="date"
                value={dateToISO}
                onChange={(e) => setDateToISO(e.target.value)}
                aria-label="Date to"
                style={{ minWidth: 0 }}
              />
            </div>

            <div className="quick-buttons" role="group" aria-label="Quick date presets">
              <button
                type="button"
                className="quick-btn quick-btn-this"
                onClick={() => {
                  const now = new Date();
                  setPresetMonth(now.getFullYear(), now.getMonth());
                }}
              >
                This month
              </button>

              <button
                type="button"
                className="quick-btn quick-btn-last"
                onClick={() => {
                  const now = new Date();
                  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                  setPresetMonth(prev.getFullYear(), prev.getMonth());
                }}
              >
                Last month
              </button>

              <button
                type="button"
                className="quick-btn quick-btn-clear"
                onClick={() => { setDateFromISO(""); setDateToISO(""); }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        <div className="controls-actions">
          <button onClick={runQuery} className="btn btn-primary" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>

          <button onClick={() => {
            setBranch(""); setDateFromISO(""); setDateToISO(""); setReportType("unit");
            setResults([]); setMessage(""); setLastError(null); setSelectedEmployee(null); setEmployeeHistory([]); setEmployeeAverages({}); setViewMode("list");
          }} className="btn">
            Reset
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
        <div className="employee-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={handleBackFromEmployee} className="btn">← Back</button>
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
                <table className="rr-table">
                  <thead>
                    <tr>
                      <th style={{ padding: 6, textAlign: "left" }}>#</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Date</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Score</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Grade</th>
                      <th style={{ padding: 6, textAlign: "left" }}>Branch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeHistory.map((rec, i) => {
                      const score = rec.scoreOutOf100 ?? rec.totalMarks ?? null;
                      const numericScore = score !== null && !Number.isNaN(Number(score)) ? Number(score) : null;
                      return (
                        <tr key={rec.id || i}>
                          <td style={{ padding: 6 }}>{i + 1}</td>
                          <td style={{ padding: 6 }}>{sanitize(rec.selection?.date ?? rec.date ?? "-")}</td>
                          <td style={{ padding: 6 }}>{numericScore !== null ? `${numericScore} / 100` : "-"}</td>
                          <td style={{ padding: 6 }}>{rec.grade || "-"}</td>
                          <td style={{ padding: 6 }}>{sanitize(rec.selection?.branch ?? rec.branch)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => downloadEmployeePDF(selectedEmployee)} className="btn btn-primary">📄 Download person PDF</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Main results table */}
      <div className="rr-table-wrapper">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div>
            <strong>{results.length} result(s)</strong>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {reportType === "staff" && results.length > 0 && (
              <button onClick={() => downloadSummaryPDF()} className="btn btn-primary">📄 Download summary PDF</button>
            )}
          </div>
        </div>

        <table className="rr-table" role="table" aria-label="Results table">
          <thead>
            <tr>
              <th style={{ padding: 8 }}>#</th>
              {reportType === "unit" ? (
                <>
                  <th style={{ padding: 8 }}>Date</th>
                  <th style={{ padding: 8 }}>Branch</th>
                  <th style={{ padding: 8 }}>City</th>
                  <th style={{ padding: 8 }}>Score</th>
                  <th style={{ padding: 8 }}>Actions</th>
                </>
              ) : (
                <>
                  <th style={{ padding: 8 }}>Staff Name</th>
                  <th style={{ padding: 8 }}>Branch</th>
                  <th style={{ padding: 8 }}>City</th>
                  <th style={{ padding: 8, textAlign: "center" }}>Evaluations</th>
                  <th style={{ padding: 8 }}>Avg</th>
                  <th style={{ padding: 8 }}>Actions</th>
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
                  <td style={{ padding: 8 }}>{i + 1}</td>
                  <td style={{ padding: 8 }}>{sanitize(r.date ?? r.selection?.date ?? "-")}</td>
                  <td style={{ padding: 8 }}>{sanitize(r.branch)}</td>
                  <td style={{ padding: 8 }}>{sanitize(r.city)}</td>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 12, background: badgeColor }} aria-hidden />
                      <span>{scoreText}</span>
                    </div>
                  </td>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => downloadUnitPDF(r)} className="btn">PDF</button>
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
                  <td style={{ padding: 8 }}>{idx + 1}</td>
                  <td style={{ padding: 8 }}>
                    <div>
                      <span
                        className="link-like"
                        onClick={() => fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName })}
                        role="link"
                        aria-label={`Open ${emp.staffName} history`}
                      >
                        {sanitize(emp.staffName)}
                      </span>
                      <div style={{ fontSize: 12, color: "#666" }}>{emp.empCode || "-"}</div>
                    </div>
                  </td>
                  <td style={{ padding: 8 }}>{sanitize(emp.branch)}</td>
                  <td style={{ padding: 8 }}>{sanitize(emp.city)}</td>
                  <td style={{ padding: 8, textAlign: "center" }}>{emp.count}</td>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 12, background: badgeColor }} aria-hidden />
                      <span>{avgText}</span>
                    </div>
                  </td>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button onClick={() => fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName })} className="btn">Open</button>
                      <button onClick={() => { setSelectedEmployee(emp); fetchEmployeeHistory({ empCode: emp.empCode, staffName: emp.staffName, openDetail: false }); downloadEmployeePDF(emp); }} className="btn">PDF</button>
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
