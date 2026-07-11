// Minimal service worker: just enough for PWA installability, which is what
// unlocks true fullscreen (no address bar) once the game is added to the
// home screen. Deliberately NO caching — the map GLBs are tens of MB and the
// game is online-only anyway; the normal HTTP cache handles static files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
