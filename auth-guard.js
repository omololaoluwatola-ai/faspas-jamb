// F.A.S.P.A.S — Auth guard
// Import this as a module <script> in the <head> of EVERY protected page.
// It hides the page instantly, checks login state, and either reveals the
// page or redirects to login.html. No page content flashes before the check.

import { auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// Hide everything until we know the auth state
const guardStyle = document.createElement('style');
guardStyle.id = 'auth-guard-style';
guardStyle.textContent = 'html{visibility:hidden;}';
document.head.appendChild(guardStyle);

// Safety net: if Firebase takes too long (bad network), reveal anyway after 4s
const revealTimeout = setTimeout(reveal, 4000);

function reveal() {
  clearTimeout(revealTimeout);
  const s = document.getElementById('auth-guard-style');
  if (s) s.remove();
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    reveal();
  } else {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    sessionStorage.setItem('postLoginRedirect', currentPage);
    window.location.replace('login.html');
  }
});
