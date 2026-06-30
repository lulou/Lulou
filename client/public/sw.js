/**
 * Lulou Service Worker
 * Handles: push notifications, notification clicks, install/activate lifecycle.
 * Served at /sw.js — scope covers the entire PWA origin.
 */

const ICON  = "/icon-192.png";
const BADGE = "/favicon-32.png";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

// ── Push event ────────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    console.warn("[SW] push: failed to parse JSON payload");
    return;
  }

  const {
    title  = "Lulou",
    body   = "",
    icon   = ICON,
    badge  = BADGE,
    data: notifData = {},
    requireInteraction = false,
  } = data;

  const options = {
    body,
    icon,
    badge,
    data: notifData,
    vibrate: [150, 80, 150],
    requireInteraction,
    // Use a tag to group/replace notifications of the same type
    tag:      notifData.tag  || notifData.type || "lulou",
    renotify: true,
    silent:   false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus an existing Lulou window if one is open, then navigate it
        for (const client of windowClients) {
          try {
            const clientOrigin = new URL(client.url).origin;
            if (clientOrigin === self.location.origin) {
              client.focus();
              return client.navigate(url);
            }
          } catch { /* ignore malformed URLs */ }
        }
        // No existing window — open a new one
        return clients.openWindow(url);
      })
  );
});

// ── Badge management ──────────────────────────────────────────────────────────
// Listens for SET_BADGE / CLEAR_BADGE messages from the main thread.

self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "SET_BADGE" && "setAppBadge" in navigator) {
    navigator.setAppBadge(event.data.count ?? 0).catch(() => {});
  }
  if (event.data.type === "CLEAR_BADGE" && "clearAppBadge" in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
