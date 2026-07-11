/**
 * Lulou Service Worker v2.9
 * Handles: push notifications, notification clicks, install/activate lifecycle,
 * badge management, version reporting, safe update activation.
 * Served at /sw.js — scope covers the entire PWA origin.
 *
 * IMPORTANT: increment SW_VERSION on every deploy so browsers re-download this
 * file even when the URL doesn't change (iOS Safari is especially aggressive
 * about caching service workers).
 */

const SW_VERSION = "2.9";
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

// ── Message handler ───────────────────────────────────────────────────────────
//
// GET_VERSION  → reply with the active SW_VERSION string via MessageChannel.
//               Used by Settings → About to show the running SW version.
//
// SKIP_WAITING → activate this waiting worker immediately.
//               Safe: does NOT clear caches, push subscriptions, or auth.
//               The app page listens for "controllerchange" then reloads once.
//
self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "GET_VERSION") {
    event.ports[0]?.postMessage({ type: "VERSION", version: SW_VERSION });
  }
  if (event.data.type === "SKIP_WAITING") {
    console.log("[SW] SKIP_WAITING received — activating v" + SW_VERSION);
    self.skipWaiting();
  }
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
    console.log("[SW_PUSH_RECEIVED] version=" + SW_VERSION + " hasData=" + (!!event.data));

    // ── Parse payload ────────────────────────────────────────────────────────
    let title           = "Incoming call";
    let body            = "Tap to answer";
    let icon            = ICON;
    let badge           = BADGE;
    let notifData       = {};
    let requireInteract = false;
    let badgeCount;

    if (event.data) {
      try {
        const raw = event.data.json();
        if (raw.title)              title           = raw.title;
        if (raw.body)               body            = raw.body;
        if (raw.icon)               icon            = raw.icon;
        if (raw.badge)              badge           = raw.badge;
        if (raw.data)               notifData       = raw.data;
        if (raw.requireInteraction) requireInteract = raw.requireInteraction;
        if (typeof raw.badgeCount === "number") badgeCount = raw.badgeCount;
      } catch (err) {
        console.warn("[SW_PUSH_FAILED] JSON parse failed —", err && err.message);
      }
    } else {
      console.warn("[SW_PUSH_FAILED] event.data is null — VAPID mismatch or push sent without body");
    }

    console.log(
      "[SW_PUSH_PARSED] swv=" + SW_VERSION,
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
      setBadgeCount(typeof badgeCount === "number" ? badgeCount : 1);
    } catch (badgeErr) {
      console.warn("[SW_PUSH_FAILED] setBadgeCount threw (non-fatal) —", badgeErr && badgeErr.message);
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

    // Safe cross-platform options: only properties iOS WebKit accepts.
    // No badge (unsupported on iOS), no vibrate/requireInteraction/renotify/silent.
    // Keep body, icon, data (needed for click handler), tag.
    const safeOptions = {
      body,
      icon,
      data: notifData,
      tag,
    };

    // Three-tier fallback to guarantee a notification is ALWAYS shown.
    // Each tier is wrapped in its own try-catch so a throw never propagates
    // out of the IIFE — which would cause event.waitUntil to reject and iOS
    // to display its own generic "Lulou — Notification" placeholder.
    //   Tier 1 — full options  (Chrome / Android)
    //   Tier 2 — safe options  (iOS WebKit)
    //   Tier 3 — title + body only (absolute last resort)
    try {
      await self.registration.showNotification(title, options);
      console.log("[SW_PUSH_SHOWN] tier=full title=\"" + title + "\"");
    } catch (err1) {
      console.warn("[SW_PUSH_FAILED] tier=full —", err1 && err1.message);
      try {
        await self.registration.showNotification(title, safeOptions);
        console.log("[SW_PUSH_SHOWN] tier=safe title=\"" + title + "\"");
      } catch (err2) {
        console.warn("[SW_PUSH_FAILED] tier=safe —", err2 && err2.message);
        try {
          await self.registration.showNotification(title, { body, tag });
          console.log("[SW_PUSH_SHOWN] tier=minimal title=\"" + title + "\"");
        } catch (err3) {
          // Final catch — if even the minimal call fails, log and let
          // the IIFE resolve cleanly. iOS may show its own placeholder,
          // but the handler exits without throwing.
          console.warn("[SW_PUSH_FAILED] tier=minimal (all tiers failed) —", err3 && err3.message);
        }
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
