const CACHE_NAME = 'focus-read-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', event => {
  // Ne pas mettre en cache les appels API (Firebase / Gemini)
  if (event.request.url.includes('firebasedatabase.app') || event.request.url.includes('googleapis.com')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
