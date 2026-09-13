// F.A.S.P.A.S service worker — minimal, real (not a no-op placeholder).
// Caches the app shell so the site works offline after first visit, and
// satisfies the "active service worker" requirement for PWA installability.

const CACHE_NAME = 'faspas-shell-v1';
const SHELL_FILES = [
  'index.html',
  'physics.html',
  'chemistry.html',
  'biology.html',
  'english.html',
  'math.html',
  'fullcbt.html',
  'history.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for jamb-date.json (so date updates aren't stuck behind the cache),
// cache-first for everything else in the app shell.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith('jamb-date.json')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
