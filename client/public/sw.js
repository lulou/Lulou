/**
 * Lulou Service Worker v2.4
 * Handles: push notifications, notification clicks, install/activate lifecycle,
 * badge management.
 * Served at /sw.js — scope covers the entire PWA origin.
 *
 * IMPORTANT: increment SW_VERSION on every deploy so browsers re-download this
 * file even when the URL doesn't change (iOS Safari is especially aggressive
 * about caching service workers).
 */

const SW_VERSION = "2.5";
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
//
// ROOT CAUSE OF iOS "Lulou — Notification" FALLBACK:
//
//   iOS WebKit shows its own generic placeholder when the push event handler
//   exits WITHOUT calling showNotification.  Two failure modes:
//
//   (A) Code BEFORE event.waitUntil() throws synchronously.
//       event.waitUntil is never called; the browser has no pending Promise;
//       iOS shows the fallback.
//
//   (B) setBadgeCount() throws synchronously.
//       self.setAppBadge() is only partially supported on iOS and can throw
//       instead of returning a rejected Promise.  The .catch(() => {}) inside
//       setBadgeCount only catches Promise rejections — not synchronous throws.
//       If setBadgeCount was called before event.waitUntil, the entire handler
//       crashed before showNotification was ever reached.
//
// FIX: call event.waitUntil() as the VERY FIRST statement — synchronously —
// passing it an async IIFE.  The browser receives the pending Promise
// immediately (mode A eliminated).  All subsequent logic — including
// setBadgeCount — runs inside the async function, so any synchronous throw
// is caught by the Promise machinery (mode B eliminated).

self.addEventListener("push", (event) => {
  // ── CALL event.waitUntil FIRST ────────────────────────────────────────────
  // This is the critical fix: event.waitUntil is called synchronously here
  // before any code that could throw.  The async IIFE handles all parsing,
  // badge-setting, and showNotification.  Any exception inside the IIFE is
  // caught by the Promise — it can never propagate out and kill the handler.
  event.waitUntil((async () => {
    console.log("[SW_PUSH] received version=" + SW_VERSION, event.data ? "has data" : "NO DATA");

    // ── Parse payload ────────────────────────────────────────────────────────
    let title           = "Incoming call";
    let body            = "Tap to open Lulou";
    let icon            = ICON;
    let badge           = BADGE;
    let notifData       = {};
    let requireInteract = false;
    let badgeCount;

    if (event.data) {
      try {
        const raw = event.data.json();
        // Log the full payload so we can verify title/body on the server side.
        console.log("[SW_PUSH] raw payload:", JSON.stringify(raw).slice(0, 300));
        if (raw.title)              title           = raw.title;
        if (raw.body)               body            = raw.body;
        if (raw.icon)               icon            = raw.icon;
        if (raw.badge)              badge           = raw.badge;
        if (raw.data)               notifData       = raw.data;
        if (raw.requireInteraction) requireInteract = raw.requireInteraction;
        if (typeof raw.badgeCount === "number") badgeCount = raw.badgeCount;

        // ── PROOF TEST ─────────────────────────────────────────────────────────
        // Hardcode title/body for incoming_call so we can verify on device that
        // the service worker IS controlling this push.
        // If iOS still shows "Lulou — Notification" even with these exact strings
        // it means the OS-level fallback is firing BEFORE showNotification runs
        // (SW not yet activated, or push delivered to a different registration).
        if (notifData.type === "incoming_call") {
          console.log("[SW_PUSH] PROOF_HARDCODE — incoming_call → overriding title/body");
          title = "Incoming call";
          body  = "Someone is calling you on Lulou";
        }
      } catch (err) {
        // JSON parse failure — keep defaults so we still show a notification.
        console.warn("[SW_PUSH] JSON parse failed —", err && err.message);
      }
    } else {
      // No payload at all (VAPID encryption mismatch or push sent without body).
      console.warn("[SW_PUSH] event.data is null — showing fallback notification");
    }

    console.log(
      "[SW_PUSH] parsed:",
      "title=\"" + title + "\"",
      "body=\"" + body.slice(0, 60) + "\"",
      "type=" + (notifData.type || "?"),
      "callSessionId=" + (notifData.callSessionId || "?"),
    );

    // ── Badge count ──────────────────────────────────────────────────────────
    // MUST be inside a try-catch.  On iOS, self.setAppBadge() can throw
    // SYNCHRONOUSLY (not as a rejected Promise) when the API is only partially
    // supported.  Without this guard, the throw propagates out of the async
    // function and showNotification is never reached — iOS shows the fallback.
    try {
      if (typeof badgeCount === "number") {
        setBadgeCount(badgeCount);
      } else {
        setBadgeCount(1);
      }
    } catch (badgeErr) {
      console.warn("[SW_PUSH] setBadgeCount threw (non-fatal) —", badgeErr && badgeErr.message);
    }

    const tag = notifData.tag || notifData.type || "lulou";

    // Full options — vibrate / requireInteraction / renotify / silent are
    // Android/Chrome-only.  iOS WebKit silently rejects them, causing
    // showNotification to reject (or silently fail) and the iOS fallback to
    // show.  We try full options first, then fall back to the safe subset.
    const options = {
      body,
      icon,
      badge,
      data:               notifData,
      tag,
      vibrate:            [150, 80, 150],
      requireInteraction: requireInteract,
      renotify:           true,
      silent:             false,
    };

    // Safe cross-platform options: only the subset that all platforms accept.
    const safeOptions = {
      body,
      icon,
      badge,
      data: notifData,
      tag,
    };

    console.log(
      "[SW_PUSH] showNotification —",
      "title=\"" + title + "\"",
      "safeOptions:", JSON.stringify(safeOptions).slice(0, 200),
    );

    // Three-tier fallback to guarantee a notification is ALWAYS shown:
    //   Tier 1 — full options  (Chrome / Android)
    //   Tier 2 — safe options  (iOS WebKit)
    //   Tier 3 — title only    (absolute last resort)
    try {
      await self.registration.showNotification(title, options);
      console.log("[SW_PUSH] showNotification OK (full options)");
    } catch (err1) {
      console.warn("[SW_PUSH] showNotification FAILED (full options) —", err1 && err1.message, "— retrying with safe options");
      try {
        await self.registration.showNotification(title, safeOptions);
        console.log("[SW_PUSH] showNotification OK (safe options)");
      } catch (err2) {
        console.warn("[SW_PUSH] showNotification FAILED (safe options) —", err2 && err2.message, "— final fallback: title only");
        await self.registration.showNotification(title);
      }
    }
  })());
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener("notificationclick", (event) => {
  console.log("[SW] notificationclick action=" + (event.action || "default") + " tag=" + (event.notification.tag || "none"));
  event.notification.close();
  clearBadgeCount();

  const data    = event.notification.data || {};
  const url     = data.url || "/";
  const origin  = self.location.origin;
  const target  = origin + url;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Focus an existing window if it's already on the target URL.
      for (const client of list) {
        if (client.url === target && "focus" in client) {
          return client.focus();
        }
      }
      // Focus any existing window and navigate it to the target.
      for (const client of list) {
        if ("focus" in client) {
          return client.focus().then(() => client.navigate && client.navigate(target));
        }
      }
      // No existing window — open a new one.
      return clients.openWindow(target);
    })
  );
});

// ── Push subscription change ──────────────────────────────────────────────────

self.addEventListener("pushsubscriptionchange", (event) => {
  console.log("[SW] pushsubscriptionchange — re-subscribing");
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: event.oldSubscription
        ? event.oldSubscription.options.applicationServerKey
        : null,
    }).then((newSub) => {
      return fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: newSub.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(newSub.getKey("p256dh")))),
            auth:   btoa(String.fromCharCode(...new Uint8Array(newSub.getKey("auth")))),
          },
        }),
      });
    }).catch((err) => {
      console.warn("[SW] pushsubscriptionchange re-subscribe failed —", err && err.message);
    })
  );
});
