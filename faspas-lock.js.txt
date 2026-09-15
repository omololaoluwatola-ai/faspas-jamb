// F.A.S.P.A.S — Monetization lock logic
// Import as a module: import { checkPracticeAccess, recordPracticeQuestionUsed,
//   checkFullCbtAccess, renderLockScreen } from './faspas-lock.js';
//
// Model (confirmed):
//   - 10 free practice questions PER SUBJECT, LIFETIME (not daily) — Physics, Chemistry,
//     Biology, English, Mathematics each get their own separate 10-question allowance.
//   - Full CBT Mode is 100% premium-only — zero free questions, ever.
//   - Premium = plan:"premium" AND premiumUntil > now, checked both ways so an expired
//     subscription correctly falls back to free-tier limits without needing a cron job.

import { auth } from './firebase-config.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const db = getFirestore();
const FREE_LIMIT_PER_SUBJECT = 10;
const FETCH_TIMEOUT_MS = 6000;

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), ms))
  ]);
}

async function getUserDoc(uid){
  const ref = doc(db, 'users', uid);
  const snap = await withTimeout(getDoc(ref), FETCH_TIMEOUT_MS);
  if(!snap.exists()){
    // First time this account has been seen by the lock system — create their free-plan doc.
    const fresh = { plan: 'free', premiumUntil: null, createdAt: serverTimestamp() };
    await setDoc(ref, fresh);
    return fresh;
  }
  return snap.data();
}

async function getUsageDoc(uid){
  const ref = doc(db, 'usage', uid);
  const snap = await withTimeout(getDoc(ref), FETCH_TIMEOUT_MS);
  return snap.exists() ? snap.data() : {};
}

function isPremiumActive(userData){
  if(!userData || userData.plan !== 'premium') return false;
  if(!userData.premiumUntil) return false;
  const until = userData.premiumUntil.toMillis ? userData.premiumUntil.toMillis() : new Date(userData.premiumUntil).getTime();
  return until > Date.now();
}

/**
 * Call before starting Topics/Years practice for a given subject.
 * subjectKey: 'physics' | 'chemistry' | 'biology' | 'english' | 'mathematics'
 * Returns { blocked, reason, remaining, isPremium }
 */
export async function checkPracticeAccess(subjectKey){
  const user = auth.currentUser;
  if(!user){
    return { blocked: true, reason: 'not-signed-in', remaining: 0, isPremium: false };
  }
  try{
    const userData = await getUserDoc(user.uid);
    const premium = isPremiumActive(userData);
    if(premium){
      return { blocked: false, reason: null, remaining: Infinity, isPremium: true };
    }
    const usage = await getUsageDoc(user.uid);
    const used = usage[subjectKey] || 0;
    const remaining = Math.max(0, FREE_LIMIT_PER_SUBJECT - used);
    if(remaining <= 0){
      return { blocked: true, reason: 'free-limit-reached', remaining: 0, isPremium: false };
    }
    return { blocked: false, reason: null, remaining, isPremium: false };
  }catch(e){
    console.warn('checkPracticeAccess failed, failing OPEN (network issue, not a real limit):', e);
    // Fail open on network/timeout issues — never lock a paying-eligible user out due to
    // a flaky connection. Worst case here is a few extra free questions get through.
    return { blocked: false, reason: null, remaining: FREE_LIMIT_PER_SUBJECT, isPremium: false };
  }
}

/**
 * Call once per question actually answered in Topics/Years practice mode.
 * Silently does nothing for premium users (no need to track what's unlimited).
 */
export async function recordPracticeQuestionUsed(subjectKey){
  const user = auth.currentUser;
  if(!user) return;
  try{
    const userData = await getUserDoc(user.uid);
    if(isPremiumActive(userData)) return; // premium = unlimited, don't bother tracking
    const ref = doc(db, 'usage', user.uid);
    await withTimeout(
      setDoc(ref, { [subjectKey]: increment(1) }, { merge: true }),
      FETCH_TIMEOUT_MS
    );
  }catch(e){
    console.warn('recordPracticeQuestionUsed failed (non-fatal):', e);
  }
}

/**
 * Call before starting Full CBT Mode. Zero free access — premium only, full stop.
 * Returns { blocked, reason, isPremium }
 */
export async function checkFullCbtAccess(){
  const user = auth.currentUser;
  if(!user){
    return { blocked: true, reason: 'not-signed-in', isPremium: false };
  }
  try{
    const userData = await getUserDoc(user.uid);
    const premium = isPremiumActive(userData);
    return { blocked: !premium, reason: premium ? null : 'premium-required', isPremium: premium };
  }catch(e){
    console.warn('checkFullCbtAccess failed:', e);
    // Full CBT fails CLOSED on error — unlike practice mode, this is the paid flagship
    // feature, so an unverifiable connection should not accidentally grant free access to it.
    return { blocked: true, reason: 'connection-error', isPremium: false };
  }
}

/**
 * Renders a themed lock/upsell screen into the given container element.
 * reason: 'not-signed-in' | 'free-limit-reached' | 'premium-required' | 'connection-error'
 */
export function renderLockScreen(container, reason){
  const copy = {
    'not-signed-in': {
      title: '🔒 Sign in required',
      body: 'You need to be signed in to practice on F.A.S.P.A.S.',
      cta: 'Go to Sign In', href: 'login.html'
    },
    'free-limit-reached': {
      title: '🎯 Free limit reached',
      body: `You've used your 10 free questions for this subject. Upgrade to Premium for unlimited practice across every subject, plus full access to Full CBT Mode.`,
      cta: 'Upgrade to Premium — ₦3,000/3 months', href: 'premium.html'
    },
    'premium-required': {
      title: '🔒 Full CBT Mode is Premium-only',
      body: 'Full CBT Mode simulates the real JAMB exam and is available exclusively to Premium subscribers.',
      cta: 'Upgrade to Premium — ₦3,000/3 months', href: 'premium.html'
    },
    'connection-error': {
      title: '⚠️ Connection issue',
      body: 'Could not verify your access right now. Please check your connection and try again.',
      cta: 'Try Again', href: null
    }
  };
  const c = copy[reason] || copy['connection-error'];
  container.innerHTML = `
    <div style="text-align:center; padding:40px 20px;">
      <div style="font-size:1.3rem; font-family:'Orbitron',sans-serif; font-weight:700; color:#6fc6ff; margin-bottom:12px;">${c.title}</div>
      <p style="color:#7d92ba; font-size:0.92rem; line-height:1.6; max-width:340px; margin:0 auto 22px;">${c.body}</p>
      ${c.href
        ? `<a href="${c.href}" style="display:inline-block; background:linear-gradient(90deg,#0a4fc4,#2f8fff); color:#03101f; font-family:'Orbitron',sans-serif; font-weight:700; padding:14px 24px; border-radius:12px; text-decoration:none; font-size:0.92rem;">${c.cta}</a>`
        : `<button onclick="location.reload()" style="background:linear-gradient(90deg,#0a4fc4,#2f8fff); color:#03101f; font-family:'Orbitron',sans-serif; font-weight:700; padding:14px 24px; border-radius:12px; border:none; font-size:0.92rem; cursor:pointer;">${c.cta}</button>`
      }
    </div>
  `;
}
