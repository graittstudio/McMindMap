// McMindMap PWA service worker. Minimal: makes the app installable as a
// stand-alone window. No offline caching — the app always uses the live site,
// because mindmaps live on the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});   // default network behaviour
