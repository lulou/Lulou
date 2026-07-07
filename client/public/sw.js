/**
 * Lulou Service Worker v2.2
 * Handles: push notifications, notification clicks, install/activate lifecycle,
 * badge management.
 * Served at /sw.js — scope covers the entire PWA origin.
 *
 * IMPORTANT: increment SW_VERSION on every deploy so browsers re-download this
 * file even when the URL doesn't change (iOS Safari is especially aggressive
 * about caching service workers).
 */

const SW_VERSION = "2.2";
const ICON  = "/icon-192.png";
const BADGE = "/favicon-32.png";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  console.log("[SW] installed version=" + SW_VERSION);
  // Activate immediately — don't wait for old tabs to close.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  console.log("[SW] activated version=" + SW_VERSION + " — claiming clients");
  event.waitUntil(clients.claim());
});

// ── Badge helper (works in both SW and Window context) ────────────────────────

function setBadgeCount(count) {
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
// CRITICAL: the handler MUST always call showNotification before returning.
// On iOS Safari, if the push event handler exits without calling
// showNotification, the OS shows its own generic "Lulou — Notification"
// placeholder instead.  Every code path below ends with event.waitUntil().

self.addEventListener("push", (event) => {
  console.log("[SW] push received version=" + SW_VERSION, event.data ? "has data" : "NO DATA");

  // Parse the payload — fall back to safe defaults on any failure so we
  // always end up calling showNotification regardless of payload quality.
  let title            = "Incoming call";
  let body             = "Tap to open Lulou";
  let icon             = ICON;
  let badge            = BADGE;
  let notifData        = {};
  let requireInteract  = false;
  let badgeCount;

  if (event.data) {
    try {
      const raw = event.data.json();
      // Log the full payload so we can verify what the server sent.
      console.log("[SW] push payload:", JSON.stringify(raw).slice(0, 300));

      if (raw.title)              title           = raw.title;
      if (raw.body)               body            = raw.body;
      if (raw.icon)               icon            = raw.icon;
      if (raw.badge)              badge           = raw.badge;
      if (raw.data)               notifData       = raw.data;
      if (raw.requireInteraction) requireInteract = raw.requireInteraction;
      if (typeof raw.badgeCount === "number") badgeCount = raw.badgeCount;
    } catch (err) {
      // JSON parse failure — keep defaults but log so we can investigate.
      console.warn("[SW] push: failed to parse JSON payload —", err && err.message);
    }
  } else {
    // No payload data (can happen if VAPID encryption mismatches the
    // subscription key, or the push was sent without a body).
    console.warn("[SW] push: event.data is null — showing fallback notification");
  }

  console.log(
    "[SW] showNotification",
    "version=" + SW_VERSION,
    "title=\"" + title + "\"",
    "type=" + (notifData.type || "?"),
    "url=" + (notifData.url || "?"),
    "callSessionId=" + (notifData.callSessionId || "?"),
  );

  if (typeof badgeCount === "number") {
    setBadgeCount(badgeCount);
  } else {
    setBadgeCount(1);
  }

  const options = {
    body,
    icon,
    badge,
    data:               notifData,
    vibrate:            [150, 80, 150],
    requireInteraction: requireInteract,
    tag:                notifData.tag || notifData.type || "lulou",
    renotify:           true,
    silent:             false,
  };

  // Always wrapped in event.waitUntil — never exits without a notification.
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";
  console.log("[SW] notificationclick version=" + SW_VERSION, "url=\"" + url + "\"");

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
// Listens for SET_BADGE / CLEAR_BADGE / SKIP_WAITING messages from the main thread.

self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "SET_BADGE") {
    setBadgeCount(event.data.count ?? 0);
  }
  if (event.data.type === "CLEAR_BADGE") {
    clearBadgeCount();
  }
  if (event.data.type === "SKIP_WAITING") {
    console.log("[SW] SKIP_WAITING received — activating immediately");
    self.skipWaiting();
  }
});
