const CACHE_NAME = 'coinpilot-shell-v300';
// The shell has no build step: every module is fetched network-first so a new
// deploy is picked up immediately, with the cache as the offline fallback.
const NETWORK_FIRST_SHELL_PATHS = new Set([
  '/',
  '/index.html',
  '/auth-client.js',
  '/manifest.webmanifest'
]);
const NETWORK_FIRST_PREFIXES = ['/app/'];
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/auth-client.js',
  '/app/main.js',
  '/app/ui/tokens.css',
  '/app/ui/base.css',
  '/app/ui/components.css',
  '/app/ui/components.js',
  '/app/ui/charts.js',
  '/app/ui/icons.js',
  '/app/ui/patterns.js',
  '/app/core/api.js',
  '/app/core/authPolicy.js',
  '/app/core/dom.js',
  '/app/core/format.js',
  '/app/core/mutations.js',
  '/app/core/realtime.js',
  '/app/core/registry.js',
  '/app/core/resourceCatalog.js',
  '/app/core/resources.js',
  '/app/core/router.js',
  '/app/core/session.js',
  '/app/core/store.js',
  '/app/domain/horizons.js',
  '/app/domain/portfolio.js',
  '/app/domain/readiness.js',
  '/app/domain/records.js',
  '/app/domain/stocks.js',
  '/app/domain/text.js',
  '/app/domain/trading.js',
  '/app/features/home/index.js',
  '/app/features/coins/index.js',
  '/app/features/stocks/index.js',
  '/app/features/portfolios/index.js',
  '/app/features/activity/index.js',
  '/app/features/settings/index.js',
  '/app/features/more/index.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// A waiting worker only activates when the user presses "업데이트".
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isNetworkFirst(pathname) {
  return NETWORK_FIRST_SHELL_PATHS.has(pathname) || NETWORK_FIRST_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Third-party requests keep their own response type; never answer them with the HTML shell.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    // Trading/account state must never be served from an old shell cache.
    return;
  }

  if (isNetworkFirst(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then(cached => cached || (request.mode === 'navigate' ? caches.match('/') : undefined))
          .then(cached => cached || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => (request.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});
