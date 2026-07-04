/* Service worker — uygulama kabuğu + pdf.js CDN dosyaları precache edilir,
   fontlar ilk kullanımda cache'lenir; sonrasında her şey çevrimdışı çalışır. */
"use strict";

const CACHE_NAME = "kutuphane-v3";

const PRECACHE = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/db.js",
  "./js/reader.js",
  "./js/backup.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Inter:wght@400;500;600&display=swap",
];

// runtime'da cache'lenmesine izin verilen dış kaynaklar (font dosyaları vb.)
const RUNTIME_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdnjs.cloudflare.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE.map((url) =>
            cache.add(new Request(url, { cache: "reload" })).catch((err) => {
              console.warn("Precache başarısız:", url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !RUNTIME_HOSTS.includes(url.hostname)) return;

  if (sameOrigin) {
    // kendi dosyalarımız: network-first — güncellemeler hemen gelsin,
    // çevrimdışıyken cache'e düşülsün
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req, { ignoreSearch: req.mode === "navigate" })
            .then((cached) => {
              if (cached) return cached;
              if (req.mode === "navigate") return caches.match("./index.html");
              return Response.error();
            })
        )
    );
    return;
  }

  // CDN dosyaları sürümlü/değişmez: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
