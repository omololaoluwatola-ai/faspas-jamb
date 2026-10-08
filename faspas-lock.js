// F.A.S.P.A.S — Monetization lock logic
//
// Model:
//   FREE    = a fixed FREE PREVIEW of 10 sample questions per subject. It is always the SAME 10
//             questions for a subject (so it is the same 10 every day), picked from across the
//             syllabus. Nothing is counted or stored, there is no daily reset to manage.
//   PREMIUM = plan:"premium" AND premiumUntil > now. Full question bank (Topics + Years) in every
//             subject, plus Full CBT Mode. Full CBT Mode is premium-only, zero free access.
//
// HOW THE PREVIEW IS APPLIED:
//   The subject pages (physics/chemistry/biology/english/math.html) already import this file and
//   call checkPracticeAccess() when the student taps START. For a FREE student this file swaps in
//   the 10-question preview, so those pages do not need any edits, and replacing a subject page
//   with fresh content never removes the lock.
//
// TESTING SWITCH:
//   Set LOCK_ENFORCEMENT_ENABLED to false to give every signed-in student full access
//   (useful for testing). It is ON for launch.
const LOCK_ENFORCEMENT_ENABLED = false;

import { auth } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const db = getFirestore();
const FREE_PREVIEW_COUNT = 10;
const FETCH_TIMEOUT_MS = 6000;

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), ms))
  ]);
}

function isPremiumActive(userData){
  if(!userData || userData.plan !== 'premium') return false;
  if(!userData.premiumUntil) return false;
  const until = userData.premiumUntil.toMillis ? userData.premiumUntil.toMillis() : new Date(userData.premiumUntil).getTime();
  return until > Date.now();
}

async function getUserDoc(uid){
  const ref = doc(db, 'users', uid);
  const snap = await withTimeout(getDoc(ref), FETCH_TIMEOUT_MS);
  if(!snap.exists()){
    // First time this account has been seen by the lock system: create their free-plan doc.
    const fresh = { plan: 'free', premiumUntil: null, createdAt: serverTimestamp() };
    try{ await withTimeout(setDoc(ref, fresh), FETCH_TIMEOUT_MS); }catch(e){ console.warn('could not create user doc (non-fatal):', e); }
    return fresh;
  }
  return snap.data();
}

function waitForUser(){
  if(auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise(resolve => {
    let done = false;
    let unsub = null;
    const finish = (u) => {
      if(done) return;
      done = true;
      try{ if(unsub) unsub(); }catch(e){}
      resolve(u || auth.currentUser || null);
    };
    unsub = onAuthStateChanged(auth, u => { if(u) finish(u); });
    setTimeout(() => finish(null), 5000);
  });
}

/* ---- Offline support ----
   Every successful plan check saves the student's premium expiry date on this phone.
   If the phone is offline (data off) or Firestore is unreachable, a student whose saved
   premium has not expired yet stays premium. The expiry date itself is still enforced. */
const PLAN_CACHE_PREFIX = 'faspas_plan_';

function premiumUntilMs(userData){
  if(!userData || userData.plan !== 'premium' || !userData.premiumUntil) return 0;
  const u = userData.premiumUntil;
  const ms = u.toMillis ? u.toMillis() : new Date(u).getTime();
  return isNaN(ms) ? 0 : ms;
}
function readPlanCache(uid){
  try{
    const raw = localStorage.getItem(PLAN_CACHE_PREFIX + uid);
    if(!raw) return null;
    const c = JSON.parse(raw);
    return (c && typeof c === 'object') ? c : null;
  }catch(e){ return null; }
}
function writePlanCache(uid, untilMs){
  try{ localStorage.setItem(PLAN_CACHE_PREFIX + uid, JSON.stringify({ until: untilMs || 0, at: Date.now() })); }catch(e){}
}

// Returns { isPremium, failed }. failed=true means the live check could not be completed.
async function getPlanInfo(user){
  try{
    const userData = await getUserDoc(user.uid);
    const until = premiumUntilMs(userData);
    writePlanCache(user.uid, until);
    return { isPremium: until > Date.now(), failed: false };
  }catch(e){
    console.warn('live plan check failed, using saved plan if any:', e);
    const c = readPlanCache(user.uid);
    if(c && c.until > Date.now()) return { isPremium: true, failed: true };
    return { isPremium: false, failed: true };
  }
}

// Returns { signedIn, isPremium }. Never grants access by accident.
async function getPlanForCurrentUser(){
  const user = await waitForUser();
  if(!user) return { signedIn: false, isPremium: false };
  const info = await getPlanInfo(user);
  return { signedIn: true, isPremium: info.isPremium };
}

/* ------------------------- Free preview: pick the fixed 10 ------------------------- */

function fnv1a(str){
  let h = 0x811c9dc5;
  for(let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Stable pick: ranks questions by a hash of their own text, so the same 10 come back every time
// (and every day), no matter how the bank is ordered. Spreads across different topics first.
function pickFreeSample(bank){
  const usable = (bank || []).filter(q =>
    q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length >= 2 &&
    typeof q.correct === 'number' && !(q.needsImage && !q.diagramSrc)
  );
  const ranked = usable
    .map(q => ({ q, h: fnv1a(q.q + '|' + (q.year || '') + '|' + (q.topic || '')) }))
    .sort((a, b) => a.h - b.h);
  const out = [];
  const seenTopics = new Set();
  for(const r of ranked){
    if(out.length >= FREE_PREVIEW_COUNT) break;
    const t = r.q.topic || '';
    if(seenTopics.has(t)) continue;
    seenTopics.add(t);
    out.push(r.q);
  }
  for(const r of ranked){
    if(out.length >= FREE_PREVIEW_COUNT) break;
    if(!out.includes(r.q)) out.push(r.q);
  }
  return out;
}

let hooksInstalled = false;

// Swaps the subject page's "start practice" functions for the 10-question preview.
// Returns false if the page doesn't have the functions we expect (then free users stay blocked).
function installPreviewHooks(){
  if(hooksInstalled) return true;
  try{
    if(typeof startTopicsMode !== 'function' || typeof startYearsMode !== 'function' ||
       typeof fisherYates !== 'function' || typeof shuffleOptions !== 'function' ||
       typeof renderPracticeQuestion !== 'function' || typeof showExamScreen !== 'function' ||
       typeof recordHistory !== 'function' || typeof showResultsScreen !== 'function'){
      return false;
    }

    const startPreview = (subjectName, bank) => {
      const sample = pickFreeSample(bank || window.SUBJECT_BANK);
      if(sample.length === 0){ alert('No preview questions are available for this subject yet.'); return; }
      const pool = fisherYates(sample).map(shuffleOptions);
      state = {
        mode: 'topics', subject: subjectName, pool, idx: 0, answers: [], score: 0,
        perQuestionSeconds: TIMER_SECONDS_PRACTICE, timerEnabled: true,
        autosaveKey: `faspas_autosave_${subjectName}_preview`,
        isPreview: true
      };
      if(typeof restoreAutosaveIfAny === 'function') restoreAutosaveIfAny();
      showExamScreen();
      renderPracticeQuestion();
    };
    window.startTopicsMode = (subjectName, bank) => startPreview(subjectName, bank);
    window.startYearsMode = (subjectName, bank) => startPreview(subjectName, bank);

    const origRecordHistory = window.recordHistory;
    window.recordHistory = function(entry){
      try{
        if(state && state.isPreview && entry && typeof entry.modeLabel === 'string'){
          entry = Object.assign({}, entry, { modeLabel: entry.modeLabel.replace(/—\s*(Topics|Years) Practice/, '— Free Preview') });
        }
      }catch(e){}
      return origRecordHistory.call(this, entry);
    };

    const origShowResults = window.showResultsScreen;
    window.showResultsScreen = function(){
      const r = origShowResults.apply(this, arguments);
      try{ if(state && state.isPreview) addResultsUpsell(); }catch(e){ console.warn(e); }
      return r;
    };

    hooksInstalled = true;
    return true;
  }catch(e){
    console.warn('installPreviewHooks failed:', e);
    return false;
  }
}

function addResultsUpsell(){
  const box = document.getElementById('screen-results');
  if(!box || document.getElementById('previewUpsell')) return;
  const d = document.createElement('div');
  d.id = 'previewUpsell';
  d.style.cssText = 'margin-top:16px;padding:14px;border:1px solid var(--line-bright,#2f4d8f);border-radius:12px;text-align:center;background:rgba(47,143,255,0.08);';
  d.innerHTML = '<div style="font-family:Orbitron,sans-serif;font-weight:700;font-size:0.85rem;margin-bottom:6px;">That was your free preview</div>' +
    '<div style="color:var(--muted,#7d92ba);font-size:0.82rem;line-height:1.5;margin-bottom:10px;">Premium unlocks every topic and every year in this subject, plus Full CBT Mode.</div>' +
    '<a href="premium.html" style="display:inline-block;padding:10px 18px;border-radius:10px;background:linear-gradient(90deg,#0a4fc4,#2f8fff);color:#03101f;font-family:Orbitron,sans-serif;font-weight:700;font-size:0.8rem;text-decoration:none;">See Premium</a>';
  const anchor = document.getElementById('subjectBreakdown');
  if(anchor && anchor.parentNode === box) anchor.insertAdjacentElement('afterend', d);
  else box.appendChild(d);
}

// Makes the "Choose Your Mode" screen honest for free students: no topic/year pickers they
// can't use, just a clear "Free preview" start.
function applyPickScreenForFree(){
  const pick = document.getElementById('screen-pick');
  if(!pick || !document.getElementById('topicSelect') || pick.dataset.previewApplied) return;
  pick.dataset.previewApplied = '1';
  ['.mode-grid', '#topicSelect', '#yearSelect', '#timerToggleRow'].forEach(sel => {
    const el = pick.querySelector(sel);
    if(el) el.style.display = 'none';
  });
  const h2 = pick.querySelector('h2');
  if(h2) h2.textContent = 'Free Preview';
  const info = document.createElement('div');
  info.style.cssText = 'margin:6px 0 16px;padding:14px;border:1px solid var(--line-bright,#2f4d8f);border-radius:12px;background:rgba(47,143,255,0.08);font-size:0.86rem;line-height:1.6;';
  info.innerHTML = '<b>10 sample questions</b> from this subject, the same 10 every day.' +
    '<br>Unlock the full question bank, Full CBT Mode and more with Premium. ' +
    '<a href="premium.html" style="color:var(--flame-2,#6fc6ff);font-weight:700;">See Premium →</a>';
  const startBtn = document.getElementById('startBtn');
  if(startBtn){
    startBtn.textContent = 'START FREE PREVIEW';
    startBtn.insertAdjacentElement('beforebegin', info);
  } else {
    pick.appendChild(info);
  }
}

// On subject pages, set the screen up for free students as soon as we know the plan.
(async function initSubjectPage(){
  if(!LOCK_ENFORCEMENT_ENABLED) return;
  try{
    if(document.readyState === 'loading'){
      await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    if(!document.getElementById('topicSelect')) return; // not a practice page (home, Full CBT, etc.)
    const plan = await getPlanForCurrentUser();
    if(!plan.signedIn || plan.isPremium) return;
    if(installPreviewHooks()) applyPickScreenForFree();
  }catch(e){ console.warn('initSubjectPage failed:', e); }
})();

/* ------------------------------ Public API ------------------------------ */

/**
 * Call before starting practice for a subject.
 * subjectKey: 'physics' | 'chemistry' | 'biology' | 'english' | 'mathematics'
 * Returns { blocked, reason, isPremium, freePreview }
 *   freePreview = true  -> the student gets the fixed 10-question preview (already switched on here)
 */
export async function checkPracticeAccess(subjectKey){
  const user = auth.currentUser || await waitForUser();
  if(!user){
    return { blocked: true, reason: 'not-signed-in', isPremium: false, freePreview: false };
  }
  if(!LOCK_ENFORCEMENT_ENABLED){
    return { blocked: false, reason: null, isPremium: false, freePreview: false };
  }
  const plan = await getPlanForCurrentUser();
  if(plan.isPremium){
    return { blocked: false, reason: null, isPremium: true, freePreview: false };
  }
  if(!installPreviewHooks()){
    // Could not switch the preview on for this page: stay locked rather than give free access.
    return { blocked: true, reason: 'preview-unavailable', isPremium: false, freePreview: false };
  }
  return { blocked: false, reason: null, isPremium: false, freePreview: true };
}

/** Kept so existing pages that call it don't break. The free preview needs no usage counting. */
export async function recordPracticeQuestionUsed(subjectKey){ /* intentionally does nothing */ }

/**
 * Call before starting Full CBT Mode. Zero free access: premium only.
 * Returns { blocked, reason, isPremium }
 */
export async function checkFullCbtAccess(){
  const user = auth.currentUser || await waitForUser();
  if(!user){
    return { blocked: true, reason: 'not-signed-in', isPremium: false };
  }
  if(!LOCK_ENFORCEMENT_ENABLED){
    return { blocked: false, reason: null, isPremium: false };
  }
  const info = await getPlanInfo(user);
  if(info.isPremium) return { blocked: false, reason: null, isPremium: true };
  // Full CBT fails CLOSED when we cannot check and have no saved premium: it is the paid flagship feature.
  return { blocked: true, reason: info.failed ? 'connection-error' : 'premium-required', isPremium: false };
}

/**
 * Renders a themed lock/upsell screen into the given container element.
 * reason: 'not-signed-in' | 'premium-required' | 'preview-unavailable' | 'connection-error'
 */
export function renderLockScreen(container, reason){
  const copy = {
    'not-signed-in': {
      title: '🔒 Sign in required',
      body: 'You need to be signed in to practice on F.A.S.P.A.S.',
      cta: 'Go to Sign In', href: 'login.html'
    },
    'premium-required': {
      title: '🔒 Full CBT Mode is Premium-only',
      body: 'Full CBT Mode simulates the real JAMB exam: 180 questions in 2 hours. It is available exclusively to Premium subscribers.',
      cta: 'See Premium — ₦3,000 / 3 months', href: 'premium.html'
    },
    'preview-unavailable': {
      title: '🔒 Premium needed here',
      body: 'The free preview could not be started on this page. Upgrade to Premium for full access to every topic and every year.',
      cta: 'See Premium — ₦3,000 / 3 months', href: 'premium.html'
    },
    'connection-error': {
      title: '⚠️ Connection issue',
      body: 'Could not verify your access right now. Please check your connection and try again.',
      cta: 'Try Again', href: null
    }
  };
  // 'free-limit-reached' was used by the old daily-counter model; treat it like premium-required.
  const c = copy[reason] || (reason === 'free-limit-reached' ? copy['premium-required'] : copy['connection-error']);
  container.innerHTML = `
    <div class="lock-screen">
      <div class="lock-title">${c.title}</div>
      <div class="lock-body">${c.body}</div>
      ${c.href
        ? `<a class="lock-cta" href="${c.href}">${c.cta}</a>`
        : `<button class="lock-cta" onclick="location.reload()">${c.cta}</button>`}
    </div>
  `;
}
