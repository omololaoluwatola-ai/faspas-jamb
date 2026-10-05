// F.A.S.P.A.S — Cloudflare Worker
// Handles the two things a plain website cannot do safely on its own:
//   POST /api/start-payment    opens a Paystack payment (hosted page, so copy/paste works)
//   POST /api/verify-payment   verifies a Paystack payment, then unlocks premium
//   POST /api/admin/*          lets YOU (admin emails only) grant/revoke premium by email
// Everything else is served as normal static files from the repo.
//
// Secrets (set in Cloudflare: Settings > Variables and Secrets, type "Secret"):
//   PAYSTACK_SECRET_KEY        Paystack secret key (sk_live_...)
//   FIREBASE_SERVICE_ACCOUNT   the full service-account JSON from Firebase
//   ADMIN_EMAILS               your admin email(s), comma separated
// Plain variable (already in wrangler.jsonc): FIREBASE_PROJECT_ID

const FIREBASE_API_KEY = 'AIzaSyDiI89t_JVDtXtpSy4Ht9w8smDDuSMwfQg'; // public web key, same as firebase-config.js
const PRICE_KOBO = 300000;      // N3,000 — must match premium.html
const SUBSCRIPTION_DAYS = 90;   // "3 months"
const MAX_GRANT_DAYS = 3650;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('Unhandled error:', e && e.stack || e);
      return json({ error: 'Server error. Please try again.' }, 500);
    }
  }
};

async function route(request, env, url) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readJson(request);
  switch (url.pathname) {
    case '/api/start-payment':  return startPayment(request, env, url);
    case '/api/verify-payment': return verifyPayment(request, env, body);
    case '/api/admin/check':    return adminCheck(request, env);
    case '/api/admin/lookup':   return adminLookup(request, env, body);
    case '/api/admin/grant':    return adminGrant(request, env, body);
    default: throw new HttpError(404, 'Not found');
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 10000) throw new HttpError(413, 'Request too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// ---------- Auth: who is calling? ----------

async function authenticate(request) {
  const header = request.headers.get('Authorization') || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!idToken) throw new HttpError(401, 'Please sign in first.');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': new URL(request.url).origin + '/' },
    body: JSON.stringify({ idToken })
  });
  if (!res.ok) throw new HttpError(401, 'Your session expired. Please sign in again.');
  const data = await res.json();
  const u = data.users && data.users[0];
  if (!u || !u.localId) throw new HttpError(401, 'Please sign in again.');
  return { uid: u.localId, email: (u.email || '').toLowerCase(), emailVerified: !!u.emailVerified };
}

async function requireAdmin(request, env) {
  const user = await authenticate(request);
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // Must be a verified email (Google sign-in is always verified), so nobody can
  // register an unverified account with your email address and become admin.
  if (!user.emailVerified || !admins.includes(user.email)) throw new HttpError(403, 'Not allowed.');
  return user;
}

// ---------- Google service-account access token ----------

let tokenCache = { token: null, exp: 0 };

function b64urlBytes(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlString(str) { return b64urlBytes(new TextEncoder().encode(str)); }

function pemToBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  let sa;
  try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing or is not valid JSON'); }
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64urlString(JSON.stringify(header)) + '.' + b64urlString(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + b64urlBytes(new Uint8Array(sig));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!res.ok) throw new Error('Could not get Google access token: ' + res.status);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

// ---------- Firestore REST helpers ----------

function fsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}
async function fsFetch(env, url, init = {}) {
  const token = await getAccessToken(env);
  return fetch(url, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}
async function fsGet(env, path) {
  const res = await fsFetch(env, `${fsBase(env)}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${path} failed: ${res.status}`);
  return res.json();
}
// Returns true if created, false if a document with that id already exists.
async function fsCreate(env, collection, id, fields) {
  const q = id ? `?documentId=${encodeURIComponent(id)}` : '';
  const res = await fsFetch(env, `${fsBase(env)}/${collection}${q}`, { method: 'POST', body: JSON.stringify({ fields }) });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`Firestore create ${collection} failed: ${res.status}`);
  return true;
}
async function fsPatch(env, path, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fsFetch(env, `${fsBase(env)}/${path}?${mask}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Firestore patch ${path} failed: ${res.status}`);
}
async function fsDelete(env, path) {
  await fsFetch(env, `${fsBase(env)}/${path}`, { method: 'DELETE' });
}

// ---------- Premium logic ----------

// Adds `days` on top of any remaining premium time (renewing early never wastes days).
async function extendPremium(env, uid, days) {
  const doc = await fsGet(env, `users/${uid}`);
  const cur = doc && doc.fields && doc.fields.premiumUntil && doc.fields.premiumUntil.timestampValue;
  const now = Date.now();
  const curMs = cur ? Date.parse(cur) : 0;
  const base = curMs > now ? curMs : now;
  const until = new Date(base + days * 86400000).toISOString();
  await fsPatch(env, `users/${uid}`, {
    plan: { stringValue: 'premium' },
    premiumUntil: { timestampValue: until }
  });
  return until;
}

async function revokePremium(env, uid) {
  await fsPatch(env, `users/${uid}`, {
    plan: { stringValue: 'free' },
    premiumUntil: { nullValue: null }
  });
}

// ---------- POST /api/start-payment ----------
// Creates the payment on Paystack's side and returns the address of Paystack's own
// payment page. The student is sent there (a normal full page, so the copy button for
// bank-transfer details works) and Paystack sends them back to premium.html afterwards.

async function startPayment(request, env, url) {
  const user = await authenticate(request);
  if (!user.email) throw new HttpError(400, 'Your account has no email address.');
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      amount: PRICE_KOBO,
      currency: 'NGN',
      channels: ['bank_transfer', 'card'],   // bank transfer and card only
      callback_url: url.origin + '/premium.html',
      metadata: { uid: user.uid }
    })
  });
  const pj = await res.json().catch(() => ({}));
  const d = pj && pj.data;
  if (!res.ok || !pj.status || !d || !d.authorization_url || !d.reference) {
    console.error('Paystack initialize failed:', res.status, JSON.stringify(pj).slice(0, 300));
    throw new HttpError(502, 'Could not start the payment. Please try again in a moment.');
  }
  return json({ authorization_url: d.authorization_url, reference: d.reference });
}

// ---------- POST /api/verify-payment ----------

async function verifyPayment(request, env, body) {
  const user = await authenticate(request);
  const reference = body.reference;
  if (typeof reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_\-.=]{3,99}$/.test(reference)) {
    throw new HttpError(400, 'Missing or invalid payment reference.');
  }

  // 1) Ask Paystack directly (server to server). The browser's word means nothing.
  const pres = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` }
  });
  const pj = await pres.json().catch(() => ({}));
  const d = pj && pj.data;
  if (!pres.ok || !pj.status || !d || d.status !== 'success') {
    throw new HttpError(400, 'Paystack has not confirmed this payment.');
  }
  if (d.amount !== PRICE_KOBO || d.currency !== 'NGN') {
    throw new HttpError(400, 'Payment amount does not match the subscription price.');
  }
  const meta = d.metadata;
  if (!meta || typeof meta !== 'object' || meta.uid !== user.uid) {
    // Stops someone claiming another person's paid reference.
    throw new HttpError(403, 'This payment belongs to a different account.');
  }

  // 2) Claim the reference so it can only ever be used once.
  const claimed = await fsCreate(env, 'payments', reference, {
    uid: { stringValue: user.uid },
    email: { stringValue: user.email },
    amount: { integerValue: String(d.amount) },
    applied: { booleanValue: false },
    verifiedAt: { timestampValue: new Date().toISOString() }
  });
  if (!claimed) {
    const existing = await fsGet(env, `payments/${reference}`);
    const f = existing && existing.fields;
    if (f && f.uid && f.uid.stringValue === user.uid && f.applied && f.applied.booleanValue === true) {
      return json({ success: true, alreadyApplied: true });
    }
    throw new HttpError(409, 'This payment is already being processed or was used. If you were charged and are not premium, contact support with reference ' + reference);
  }

  // 3) Grant premium. If it fails, release the claim so the student can retry.
  let until;
  try {
    until = await extendPremium(env, user.uid, SUBSCRIPTION_DAYS);
  } catch (e) {
    await fsDelete(env, `payments/${reference}`).catch(() => {});
    throw e;
  }
  await fsPatch(env, `payments/${reference}`, { applied: { booleanValue: true } }).catch(e => console.error('mark applied failed', e));
  return json({ success: true, premiumUntil: until });
}

// ---------- Admin ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function findUidByEmail(env, email) {
  const token = await getAccessToken(env);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: [email] })
  });
  if (!res.ok) throw new Error('Identity lookup failed: ' + res.status);
  const data = await res.json();
  const u = data.users && data.users[0];
  return u ? u.localId : null;
}

async function adminCheck(request, env) {
  const user = await requireAdmin(request, env);
  return json({ ok: true, email: user.email });
}

async function adminLookup(request, env, body) {
  await requireAdmin(request, env);
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
  const uid = await findUidByEmail(env, email);
  if (!uid) return json({ found: false });
  const doc = await fsGet(env, `users/${uid}`);
  const f = (doc && doc.fields) || {};
  const until = f.premiumUntil && f.premiumUntil.timestampValue || null;
  const active = !!(f.plan && f.plan.stringValue === 'premium' && until && Date.parse(until) > Date.now());
  return json({ found: true, premiumActive: active, premiumUntil: until });
}

async function adminGrant(request, env, body) {
  const admin = await requireAdmin(request, env);
  const email = String(body.email || '').trim().toLowerCase();
  const days = Number(body.days);
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
  if (!Number.isInteger(days) || days < 0 || days > MAX_GRANT_DAYS) {
    throw new HttpError(400, `Days must be a whole number from 0 to ${MAX_GRANT_DAYS}. Use 0 to remove premium.`);
  }
  const uid = await findUidByEmail(env, email);
  if (!uid) throw new HttpError(404, 'That email has not registered on F.A.S.P.A.S yet. Ask them to register first, then try again.');

  let premiumUntil = null;
  if (days === 0) await revokePremium(env, uid);
  else premiumUntil = await extendPremium(env, uid, days);

  await fsCreate(env, 'adminGrants', null, {
    email: { stringValue: email },
    days: { integerValue: String(days) },
    by: { stringValue: admin.email },
    at: { timestampValue: new Date().toISOString() }
  }).catch(e => console.error('audit log failed', e));

  return json({ ok: true, email, premiumUntil });
}
