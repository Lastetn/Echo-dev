const CACHE_VERSION = 'echodev-v3'; // à incrémenter à chaque modif des assets
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './collab.js',
  './workspace.js',
  './push.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('echodev-') && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

// ===== NOTIFICATIONS PUSH =====
// Toujours afficher une notif à chaque push : Safari (iPhone) révoque la permission sinon.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title = data.title || 'Echo dev';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.tag || 'echodev',   // remplace la notif précédente du même tag
      renotify: true,
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// Pages : réseau d'abord, cache en secours (hors ligne)
async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match('./index.html')) || Response.error();
  }
}

// Assets : réponse immédiate depuis le cache, mise à jour en arrière-plan
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const update = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  event.waitUntil(update);
  return cached || (await update) || Response.error();
}