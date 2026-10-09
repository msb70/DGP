/* DGP Conductor · service worker: cachea el shell de la app para trabajar sin señal */
const CACHE = 'dgp-conductor-v5';
const SHELL = ['conductor.html', 'css/auth.css', 'vendor/supabase-2.117.3.min.js', 'js/config.js', 'js/auth.js', 'js/seed.js', 'js/db.js', 'js/geo.js', 'js/busy.js', 'js/conductor.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // misma app: red primero (siempre la versión publicada) y caché solo sin señal
  if (u.origin === location.origin) { e.respondWith(fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('conductor.html', { ignoreSearch: true })))); return; }
  if (/fonts\.g/.test(u.host)) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; }))); }
});
