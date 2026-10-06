// F.A.S.P.A.S service worker — NETWORK-FIRST.
// Online  -> always fetch the newest file, then refresh the offline copy.
// Offline / slow network -> serve the saved copy.
// Bump nothing when you edit pages: changes go live on the next open.
const CACHE = 'faspas-cache';
const TIMEOUT_MS = 4000;

const CORE = [
  './', 'index.html', 'manifest.json', 'jamb-date.json', 'auth-guard.js', 'firebase-config.js', 'faspas-lock.js', 'faspas-bank.js',
  'physics.html', 'chemistry.html', 'biology.html', 'english.html',
  'math.html', 'fullcbt.html', 'revise.html', 'history.html', 'login.html', 'premium.html',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'
];

// Firebase's own scripts come from Google's servers. Keep a copy so login and the premium
// check still load when the phone has no data.
const FIREBASE_URLS = [
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js'
];
const isFirebaseScript = url => url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(CORE.map(u =>
        fetch(new Request(u, { cache: 'reload' }))
          .then(r => { if (r.ok) return c.put(u, r); })
          .catch(() => {})
      )).then(() => Promise.all(FIREBASE_URLS.map(u =>
        fetch(u, { mode: 'cors' })
          .then(r => { if (r.ok) return c.put(u, r); })
          .catch(() => {})
      )))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const fallback = () =>
      caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'));

    const timer = setTimeout(() => {
      fallback().then(hit => { if (hit && !settled) { settled = true; resolve(hit); } });
    }, TIMEOUT_MS);

    fetch(new Request(req, { cache: 'no-cache' }))
      .then(res => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        if (!settled) { settled = true; resolve(res); }
      })
      .catch(() => {
        clearTimeout(timer);
        if (!settled) fallback().then(hit => { settled = true; resolve(hit || Response.error()); });
      });
  });
}

function cacheFirstFirebase(req) {
  return caches.match(req.url, { ignoreVary: true }).then(hit => {
    if (hit) return hit;
    return fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req.url, copy));
      }
      return res;
    });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isFirebaseScript(url)) { e.respondWith(cacheFirstFirebase(req)); return; }
  if (url.origin !== location.origin) return; // analytics, fonts: leave alone
  e.respondWith(networkFirst(req));
});
