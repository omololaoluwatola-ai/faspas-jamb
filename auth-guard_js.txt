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

let firstCheck = true;

onAuthStateChanged(auth, (user) => {
  if (user) {
    reveal();
    return;
  }

  if (firstCheck) {
    // Extra safety margin: on the very first check right after a page load, give
    // Firebase one more beat to finish restoring the session before we trust "no
    // user" and send someone away. Real logged-out visitors still redirect —
    // this only delays the decision by a fraction of a second either way.
    firstCheck = false;
    setTimeout(() => {
      if (auth.currentUser) {
        reveal();
      } else {
        redirectToLogin();
      }
    }, 300);
    return;
  }

  redirectToLogin();
});

function redirectToLogin() {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  sessionStorage.setItem('postLoginRedirect', currentPage);
  window.location.replace('login.html');
}
