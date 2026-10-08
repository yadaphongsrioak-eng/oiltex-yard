/* OIL-TEX Yard — offline cache. Bump VERSION when you upload new files. */
const VERSION = "oiltex-yard-v1";
const FILES = ["./", "index.html", "app.js", "ocr.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "vendor/jsQR.js", "vendor/qrcode.js", "vendor/tesseract.min.js", "vendor/worker.min.js", "vendor/fonts/bai-jamjuree-latin-600-normal.woff2", "vendor/fonts/bai-jamjuree-latin-700-normal.woff2", "vendor/fonts/bai-jamjuree-thai-600-normal.woff2", "vendor/fonts/bai-jamjuree-thai-700-normal.woff2", "vendor/fonts/ibm-plex-sans-thai-latin-400-normal.woff2", "vendor/fonts/ibm-plex-sans-thai-latin-600-normal.woff2", "vendor/fonts/ibm-plex-sans-thai-thai-400-normal.woff2", "vendor/fonts/ibm-plex-sans-thai-thai-600-normal.woff2", "vendor/lang/eng.traineddata.gz", "vendor/lang/tha.traineddata.gz", "vendor/core/tesseract-core-lstm.js", "vendor/core/tesseract-core-lstm.wasm.js", "vendor/core/tesseract-core-simd-lstm.js", "vendor/core/tesseract-core-simd-lstm.wasm.js"];
const APP = ["./", "index.html", "app.js", "ocr.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const path = url.pathname.replace(/^.*\//, "") || "./";
  if (APP.includes(path) || url.pathname.endsWith("/")) {
    // app files: network first so updates show up, cache when offline
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, {ignoreSearch: true})));
  } else {
    // OCR engine, language data, fonts: cache first
    e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(r => r || fetch(e.request)));
  }
});
