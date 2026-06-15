// Beast Mode // Service Worker
// v4.1 — message-based update flow

const CACHE_NAME = 'beast-mode-v6.17'
const CACHE_URLS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;500;600;700&display=swap',
]

// ── Install: pre-cache the app shell ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(CACHE_URLS.map(url => cache.add(url).catch(() => {})))
    })
  )
  // Do NOT call skipWaiting() here — wait for the user to confirm update
})

// ── Message: page triggers update when user clicks "Update Now" ────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// ── Activate: clear old caches, then notify all clients to reload ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all open tabs the new version is live — they should reload
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_ACTIVATED' }))
        })
      })
  )
})

// ── Fetch: cache-first for app files, passthrough for APIs ────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  const passthrough = [
    'accounts.google.com',
    'googleapis.com',
    'api.dropboxapi.com',
    'content.dropboxapi.com',
    'dropbox.com',
    'inat.org',
    'inaturalist.org',
    'wikimedia.org',
  ]
  if (passthrough.some(h => url.hostname.includes(h))) {
    return
  }

  // Never cache API traffic. The background-queue endpoints (/api/jobs) are
  // polled and MUST return live data — a cached snapshot would freeze the queue
  // UI. All /api/* calls go straight to the network, bypassing the cache.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    return
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached
      return fetch(e.request).then(response => {
        if (
          e.request.method === 'GET' &&
          response.status === 200 &&
          (url.origin === self.location.origin || url.hostname.includes('fonts.g'))
        ) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone))
        }
        return response
      }).catch(() => cached || new Response('Offline', { status: 503 }))
    })
  )
})
