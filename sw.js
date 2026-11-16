const VERSION = "AudioCron-v0.4";
const SHELL_CACHE = VERSION + "-shell";
const COVER_CACHE = VERSION + "-covers";

const SHELL_ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "js/app.js",
  "js/db.js",
  "js/api.js",
  "js/csv.js",
  "js/ui.js",
  "js/stats.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  if (url.origin === self.location.origin) {
    if (e.request.mode === "navigate") {
      e.respondWith(
        fetch(e.request)
          .then(res => {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put("index.html", copy));
            return res;
          })
          .catch(() => caches.match("index.html"))
      );
      return;
    }
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchUpdate = fetch(e.request).then(res => {
          if (res.ok) {
            caches.open(SHELL_CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        }).catch(() => cached);
        return cached || fetchUpdate;
      })
    );
    return;
  }

  if (url.hostname.endsWith("covers.openlibrary.org") ||
      url.hostname === "books.google.com" ||
      url.hostname === "covers.google.com") {
    e.respondWith(
      caches.open(COVER_CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) {
          fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
          }).catch(() => {});
          return cached;
        }
        try {
          const res = await fetch(e.request);
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return new Response("", { status: 503 });
        }
      })
    );
    return;
  }
});
