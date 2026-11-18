const CACHE_NAME = 'focus-read-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './app.js',
  './manifest.json'
];

// Installation et prise de contrôle immédiate
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// Nettoyage automatique de 'focus-read-v1' et des futurs anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Réseau d'abord (pour voir chaque git push), Cache en secours (hors ligne)
self.addEventListener('fetch', event => {
  // Ne pas mettre en cache les appels API (Firebase / Gemini)
  if (event.request.url.includes('firebasedatabase.app') || event.request.url.includes('googleapis.com')) {
    return;
  }

  // Ignorer les ressources externes (ex: JSZip CDN)
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
