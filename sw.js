/* Offline cache for LWH Offline Receiving. Bump VERSION with every deploy (must match APP_VERSION in app.js). */
const VERSION = '1.2.0';
const CACHE = 'lwh-receiving-' + VERSION;
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.json',
  'vendor/html5-qrcode.min.js', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lwh-receiving-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs only: cache first so the app opens with weak signal, refresh in the background.
// Posts to Apps Script and the weather API go straight to the network.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) return hit;
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503 });
    })
  );
});
