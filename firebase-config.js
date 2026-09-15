// F.A.S.P.A.S — Firebase config & init
// SDK 10.13.0 (matches indigene-hub standard)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

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
