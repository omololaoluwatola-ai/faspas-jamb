// F.A.S.P.A.S — Firebase config & init
// SDK 10.13.0 (matches indigene-hub standard)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDiI89t_JVDtXtpSy4Ht9w8smDDuSMwfQg",
  authDomain: "faspas-jamb.firebaseapp.com",
  projectId: "faspas-jamb",
  storageBucket: "faspas-jamb.firebasestorage.app",
  messagingSenderId: "967370913897",
  appId: "1:967370913897:web:c82c7dfee01054dec34af8"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// localStorage persistence is SYNCHRONOUS (unlike the default IndexedDB persistence),
// so the session is guaranteed to be saved before we ever navigate to another page.
// This is what stops a freshly signed-up/signed-in user from getting bounced back
// to login.html by auth-guard.js on the very next page load.
setPersistence(auth, browserLocalPersistence);
