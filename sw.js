/* ===========================================================================
   Service worker.

   Its only job is to keep the page itself openable without a signal. It
   caches the handful of files that make up the app and nothing else.

   It deliberately does NOT touch requests to the Sleeper API. Fantasy data
   goes stale in minutes, and a cached injury report is worse than no page
   at all. Sleeper requests are passed straight through to the network, and
   app.js does its own caching in localStorage with proper expiry times.
   =========================================================================== */

const CACHE = 'fantasy-manager-v3';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './draft.js',
  './trade.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

/* Store the app shell on first visit. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/* Throw away caches from older versions of the app. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* Only ever handle our own files being read. Everything else -- most
     importantly every Sleeper API call -- goes straight to the network. */
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  /* Network first, so a published update is picked up straight away.
     Fall back to the cached copy when there is no signal. */
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

/* ===========================================================================
   Push notifications

   The server only ever sends when something is actually wrong, so anything
   arriving here is worth showing.
   =========================================================================== */

self.addEventListener('push', (event) => {
  let data = { title: 'Fantasy Manager', body: 'Open the app to see what changed.' };
  try { if (event.data) data = event.data.json(); } catch (e) {}

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    /* One tag means a newer alert replaces the older one rather than
       stacking up a pile of notifications you have to clear. */
    tag: 'lineup',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        for (const w of windows) if ('focus' in w) return w.focus();
        if (self.clients.openWindow) return self.clients.openWindow('./');
      })
  );
});
