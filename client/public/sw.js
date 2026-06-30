/**
 * Lulou Service Worker
 * Handles: push notifications, notification clicks, install/activate lifecycle,
 * badge management.
 * Served at /sw.js — scope covers the entire PWA origin.
 */

const ICON  = "/icon-192.png";
const BADGE = "/favicon-32.png";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener("install", () => {
  console.log("[SW] installed");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[SW] activated — claiming clients");
  event.waitUntil(clients.claim());
});

// ── Badge helper (works in both SW and Window context) ────────────────────────

function setBadgeCount(count) {
  // ServiceWorkerGlobalScope exposes setAppBadge directly on `self`
  if ("setAppBadge" in self) {
    self.setAppBadge(count).catch(() => {});
  } else if (typeof navigator !== "undefined" && "setAppBadge" in navigator) {
    navigator.setAppBadge(count).catch(() => {});
  }
}

function clearBadgeCount() {
  if ("clearAppBadge" in self) {
    self.clearAppBadge().catch(() => {});
  } else if (typeof navigator !== "undefined" && "clearAppBadge" in navigator) {
    navigator.clearAppBadge().catch(() => {});
  }
}

// ── Push event ────────────────────────────────────────────────────────────────

self.addEventListener("push", (event) => {
  console.log("[SW] push received", event.data ? "has data" : "no data");
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
    badgeCount,
  } = data;

  console.log(`[SW] push: title="${title}" type="${notifData.type || "?"}" badgeCount=${badgeCount}`);

  const options = {
    body,
    icon,
    badge,
    data: notifData,
    vibrate: [150, 80, 150],
    requireInteraction,
    tag:      notifData.tag  || notifData.type || "lulou",
    renotify: true,
    silent:   false,
  };

  // Update badge with the count from the push payload when provided
  if (typeof badgeCount === "number") {
    setBadgeCount(badgeCount);
  } else {
    // Fallback: set a generic "has unread" badge
    setBadgeCount(1);
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";
  console.log(`[SW] notificationclick url="${url}"`);

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          try {
            const clientOrigin = new URL(client.url).origin;
            if (clientOrigin === self.location.origin) {
              client.focus();
              return client.navigate(url);
            }
          } catch { /* ignore malformed URLs */ }
        }
        return clients.openWindow(url);
      })
  );
});

// ── Badge management ──────────────────────────────────────────────────────────
// Listens for SET_BADGE / CLEAR_BADGE messages from the main thread.

self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "SET_BADGE") {
    setBadgeCount(event.data.count ?? 0);
  }
  if (event.data.type === "CLEAR_BADGE") {
    clearBadgeCount();
  }
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
