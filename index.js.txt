// F.A.S.P.A.S — Cloud Function: verifyPayment
//
// This file does NOT go into your GitHub repo / Vercel deploy — it only ever runs on
// Firebase's servers, deployed separately via the Firebase CLI. It's inert (does nothing)
// until you actually deploy it, so it's safe to keep sitting here in the meantime.
//
// ---------------------------------------------------------------------------------------
// ONE-TIME SETUP (do this once, from a computer with Node.js installed):
//
// 1. Install the Firebase CLI:            npm install -g firebase-tools
// 2. Log in:                              firebase login
// 3. In an empty folder, initialize:      firebase init functions
//    - choose your existing "faspas-jamb" project
//    - choose JavaScript
//    - say NO to ESLint (keeps things simple)
//    - say NO to installing dependencies now (we'll do it manually below)
// 4. Replace the generated functions/index.js with THIS file's contents.
// 5. Inside the functions/ folder, install what this file needs:
//      npm install firebase-admin firebase-functions
// 6. Set your Paystack SECRET key (never the public one) as a Firebase secret —
//    this keeps it out of your code entirely:
//      firebase functions:secrets:set PAYSTACK_SECRET_KEY
//    (it will prompt you to paste the secret key — paste it and hit enter)
// 7. Deploy just this function:
//      firebase deploy --only functions
//
// That's it — from then on, premium.html's "Subscribe Now" button will actually work,
// because it calls this function by name ('verifyPayment') to confirm real payment
// before unlocking anything.
// ---------------------------------------------------------------------------------------

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');

const EXPECTED_AMOUNT_KOBO = 300000; // ₦3,000 — matches premium.html's amount exactly
const SUBSCRIPTION_DAYS = 90; // "3 months" — kept as a fixed day count for predictability

exports.verifyPayment = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in to verify a payment.');
  }

  const reference = request.data?.reference;
  if (!reference || typeof reference !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing payment reference.');
  }

  // --- Replay protection: has this exact reference already been used to grant premium? ---
  const paymentRef = db.collection('payments').doc(reference);
  const paymentSnap = await paymentRef.get();
  if (paymentSnap.exists) {
    throw new HttpsError('already-exists', 'This payment reference has already been processed.');
  }

  // --- Verify with Paystack directly (server-to-server — the client's word means nothing) ---
  const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}` }
  });
  const verifyJson = await verifyRes.json();

  if (!verifyJson.status || verifyJson.data?.status !== 'success') {
    throw new HttpsError('failed-precondition', 'Payment was not successful according to Paystack.');
  }
  if (verifyJson.data.amount !== EXPECTED_AMOUNT_KOBO) {
    // Guards against someone crafting a fake reference for a smaller, unrelated payment.
    throw new HttpsError('failed-precondition', 'Payment amount does not match the expected subscription price.');
  }

  // --- Extend premium: stack on top of remaining time if renewing early, otherwise start fresh from now ---
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};

  const now = Date.now();
  const currentUntil = userData.premiumUntil ? userData.premiumUntil.toMillis() : 0;
  const baseTime = currentUntil > now ? currentUntil : now; // stack if still active, else start from now
  const newUntil = new Date(baseTime + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000);

  // --- Commit both writes atomically: mark this reference used, and upgrade the user ---
  const batch = db.batch();
  batch.set(paymentRef, {
    uid,
    amount: verifyJson.data.amount,
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(userRef, {
    plan: 'premium',
    premiumUntil: admin.firestore.Timestamp.fromDate(newUntil),
  }, { merge: true });
  await batch.commit();

  return { success: true, premiumUntil: newUntil.toISOString() };
});
