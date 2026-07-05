/*
 * awaykit service worker (v0.6) — Web Push wake-ups.
 *
 * Runs even when the awaykit page is closed. It receives a push (payload
 * encrypted end-to-end to this device per RFC 8291 — the push service can't read
 * it), shows a notification, and on tap focuses an open tab or opens the app so
 * the waiting approval card is right there.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || "awaykit";
  const options = {
    body: data.body || "Your agent needs you.",
    tag: data.tag || "awaykit",       // collapse repeats for the same prompt
    renotify: true,                    // but still buzz on an update
    requireInteraction: true,          // an approval shouldn't silently vanish
    vibrate: [80, 40, 80],
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if ("focus" in c) { try { return await c.focus(); } catch { /* fall through */ } }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// The browser may rotate the push subscription. Ask any open tab to re-register
// it over the encrypted channel; if none is open, the app re-subscribes on next
// launch (and the daemon prunes the dead one on first failed send).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) c.postMessage({ type: "awaykit-resubscribe" });
  })());
});
