/* DGP Conductor · service worker: cachea el shell de la app para trabajar sin señal */
const CACHE = 'dgp-conductor-v1';
const SHELL = ['conductor.html', 'js/config.js', 'js/seed.js', 'js/db.js', 'js/geo.js', 'js/conductor.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; }).catch(() => caches.match('conductor.html')))); return; }
  if (/fonts\.g|cdn\.jsdelivr|cdnjs/.test(u.host)) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; }))); }
});
