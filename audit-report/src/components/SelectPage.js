// src/components/SelectPage.js
import React, { useState } from "react";
import { db } from "../firebase";
import { collection, query, where, getDocs } from "firebase/firestore";

/**
 * SelectPage
 * - Props:
 *    onSelect: function(selection)  // called when selection is allowed
 *    onOpenRetrieve: optional callback to open retrieve page
 *
 * Behavior:
 *  - If user selects Type = "unit", the component checks Firestore to ensure
 *    no unit audit exists for the chosen branch on today's date (dd/mm/yyyy).
 *  - If such a document exists, we show an alert and prevent navigation.
 */

const centerCityMap = {
  "HSR Layout": "Bangalore",
  "Koramangala": "Bangalore",
  "Whitefield": "Bangalore",
  "Bannerghatta Road": "Bangalore",
  "Electronic City": "Bangalore",
  "Manyata": "Bangalore",
  "Kochi": "Kochi",
  "Coimbatore": "Coimbatore",
};

// format Date -> dd/mm/yyyy
const formatDateDDMMYYYY = (dateValue) => {
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

const SelectPage = ({ onSelect, onOpenRetrieve }) => {
  const [branch, setBranch] = useState("");
  const [type, setType] = useState("");

  // Today in dd/mm/yyyy
  const todayDD = formatDateDDMMYYYY(new Date());

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!branch || !type) return alert("Please select both Branch and Type.");

    // Build selection object
    const selection = {
      branch,
      city: centerCityMap[branch],
      auditor: "Kumar Kannaiyan", // consistent name
      date: todayDD,
      type,
    };

    // If it's a unit audit, check Firestore for an existing audit for same branch+date
    if (type === "unit") {
      try {
        const colRef = collection(db, "unitAudits");
        const q = query(colRef, where("branch", "==", branch), where("date", "==", todayDD));
        const snap = await getDocs(q);
        if (!snap.empty) {
          // Found an existing audit for this branch and date
          alert(
            `A Unit Audit for branch "${branch}" already exists for today (${todayDD}).\n\n` +
              "Only one Unit Audit per branch per day is allowed."
          );
          return;
        }
        // no existing doc — proceed
        onSelect(selection);
      } catch (err) {
        console.error("Error checking existing audit:", err);
        alert(
          "Could not verify existing audits due to a connection error.\n\n" +
            "If you are offline or your Firestore rules block reads, please try again or use Retrieve Reports.\n\n" +
            `Error: ${err?.message || err}`
        );
      }
    } else {
      // staff evaluation — no duplicate check required
      onSelect(selection);
    }
  };

  return (
    <div className="card shadow p-3">
      <h4 className="text-center mb-3">SUKINO HEALTH CARE</h4>

      <form onSubmit={handleSubmit}>
        <div className="mb-3">
          <label className="form-label">Select Branch</label>
          <select
            className="form-select"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">-- Select --</option>
            {Object.keys(centerCityMap).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="mb-3">
          <label className="form-label">Select Type</label>
          <select
            className="form-select"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">-- Select --</option>
            <option value="unit">Unit Audit</option>
            <option value="staff">Staff Evaluation</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary w-100" type="submit">
            Continue
          </button>
          {typeof onOpenRetrieve === "function" && (
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={onOpenRetrieve}
            >
              Retrieve Reports
            </button>
          )}
        </div>

        <div style={{ marginTop: 10, fontSize: 13, color: "#666" }}>
          <div>Audited by: <strong>Kumar Kannaiyan - F&B Manager</strong></div>
          <div>Date: <strong>{todayDD}</strong></div>
        </div>
      </form>
    </div>
  );
};

export default SelectPage;
