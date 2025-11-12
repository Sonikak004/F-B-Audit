// src/App.js
import React, { useEffect, useState } from "react";
import SelectPage from "./components/SelectPage";
import UnitAuditForm from "./components/AuditForm";
import StaffEvaluation from "./components/StaffEvaluation";
import RetrieveReports from "./components/RetrieveReports";

// firebase auth
import { auth } from "./firebase";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";

function App() {
  const [page, setPage] = useState("select");
  const [selection, setSelection] = useState({});
  const [authed, setAuthed] = useState(!!auth.currentUser);

  // Attempt silent anonymous sign-in once on mount.
  useEffect(() => {
    let mounted = true;

    const tryAnonSignIn = async () => {
      try {
        if (!auth.currentUser) {
          await signInAnonymously(auth);
          // signInAnonymously will trigger onAuthStateChanged below
          console.log("Anonymous sign-in requested");
        } else {
          console.log("Already signed in (uid):", auth.currentUser.uid);
        }
      } catch (err) {
        // Log but do not block UI — show in console for debugging.
        console.warn("Anonymous sign-in failed:", err);
      }
    };

    tryAnonSignIn();

    const unsub = onAuthStateChanged(auth, (user) => {
      if (!mounted) return;
      setAuthed(!!user);
      console.log("Auth state:", !!user, user?.uid);
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const handleSelection = (data) => {
    setSelection(data);
    setPage(data.type === "unit" ? "unit" : "staff");
  };

  const goBack = () => {
    setPage("select");
  };

  return (
    <div className="container py-3">
      {/* Optional: you can show authentication status for debugging */}
      {/* <div style={{ fontSize: 12, color: authed ? "green" : "orange" }}>
        {authed ? "Authenticated (anonymous)" : "Authenticating..."}
      </div> */}

      {page === "select" && (
        <SelectPage onSelect={handleSelection} onOpenRetrieve={() => setPage("retrieve")} />
      )}
      {page === "unit" && <UnitAuditForm selection={selection} goBack={goBack} />}
      {page === "staff" && <StaffEvaluation selection={selection} goBack={goBack} />}
      {page === "retrieve" && <RetrieveReports goBack={goBack} />}
    </div>
  );
}

export default App;
