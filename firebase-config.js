// F.A.S.P.A.S — Firebase config & init
// SDK 10.13.0 (matches indigene-hub standard)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { initializeAuth, browserLocalPersistence, browserPopupRedirectResolver } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDiI89t_JVDtXtpSy4Ht9w8smDDuSMwfQg",
  authDomain: "faspas-jamb.firebaseapp.com",
  projectId: "faspas-jamb",
  storageBucket: "faspas-jamb.firebasestorage.app",
  messagingSenderId: "967370913897",
  appId: "1:967370913897:web:c82c7dfee01054dec34af8"
};

const app = initializeApp(firebaseConfig);
// Persistence is declared at creation (synchronous localStorage) so the session is saved
// before any redirect and restored before any page checks it. No race.
export const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
