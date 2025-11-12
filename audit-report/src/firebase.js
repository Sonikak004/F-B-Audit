// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth"; // ✅ Add this import

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCM3G4XgOcgbk2ZLdioeZgxjLroibiHqBM",
  authDomain: "audit-report-11a41.firebaseapp.com",
  projectId: "audit-report-11a41",
  storageBucket: "audit-report-11a41.firebasestorage.app",
  messagingSenderId: "560790160902",
  appId: "1:560790160902:web:427bdf1325b3100d542587"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// ✅ Initialize Firestore
export const db = getFirestore(app);

// ✅ Initialize Authentication (for anonymous login)
export const auth = getAuth(app);
