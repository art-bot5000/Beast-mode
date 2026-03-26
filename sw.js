// Beast Mode // Service Worker
// Cache-first for the app shell, network-first for OAuth/API calls

const CACHE_NAME = 'beast-mode-v4'
const CACHE_URLS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Rajdhani:wght@400;500;600;700&display=swap',
]

// ── Install: pre-cache the app shell ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache what we can — ignore failures (e.g. Google Fonts CSP)
      return Promise.allSettled(CACHE_URLS.map(url => cache.add(url).catch(() => {})))
    })
  )
  self.skipWaiting()
})

// ── Activate: clear old caches ────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// ── Fetch: cache-first for app files, passthrough for APIs ────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // Always pass OAuth / Drive / Dropbox API calls to network
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
    return  // default network fetch
  }

  // Cache-first for everything else (app shell, fonts, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached
      return fetch(e.request).then(response => {
        // Cache valid GET responses for the app's own origin
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
