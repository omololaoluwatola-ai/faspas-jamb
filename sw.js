// F.A.S.P.A.S service worker — NETWORK-FIRST.
// Online  -> always fetch the newest file, then refresh the offline copy.
// Offline / slow network -> serve the saved copy.
// Bump nothing when you edit pages: changes go live on the next open.
const CACHE = 'faspas-cache';
const TIMEOUT_MS = 4000;

const CORE = [
  './', 'index.html', 'manifest.json', 'jamb-date.json', 'auth-guard.js',
  'physics.html', 'chemistry.html', 'biology.html', 'english.html',
  'math.html', 'fullcbt.html', 'history.html', 'login.html', 'premium.html',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(CORE.map(u =>
        fetch(new Request(u, { cache: 'reload' }))
          .then(r => { if (r.ok) return c.put(u, r); })
          .catch(() => {})
      ))
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

    fetch(new Request(req, { cache: 'no-store' }))
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

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Firebase, analytics, fonts: leave alone
  e.respondWith(networkFirst(req));
});
