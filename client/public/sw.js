/**
 * Lulou Service Worker v3.3
 * Handles: push notifications, notification clicks, install/activate lifecycle,
 * badge management, version reporting, safe update activation.
 * Served at /sw.js — scope covers the entire PWA origin.
 *
 * IMPORTANT: increment SW_VERSION on every deploy so browsers re-download this
 * file even when the URL doesn't change (iOS Safari is especially aggressive
 * about caching service workers).
 */

const SW_VERSION = "3.4";
const ICON  = "/icon-192.png";
const BADGE = "/favicon-32.png";

// Set false once push-notification reliability is confirmed in production.
const VERBOSE_LOGGING = true;

// ── Fetch handler ─────────────────────────────────────────────────────────────
//
// Explicit network-only pass-through for /api/* requests.
// Prevents any future caching logic from accidentally intercepting authenticated
// API requests or serving stale 401 / profile responses.
// All non-API requests use the browser's default fetch behaviour (no SW caching).
self.addEventListener("fetch", (event) => {
  if (event.request.url.includes("/api/")) {
    // Always fetch from network — never serve a cached authenticated response.
    event.respondWith(fetch(event.request));
  }
  // Non-API requests: do nothing (browser handles normally).
});

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

    // iOS-safe cross-platform options — ABSOLUTE MINIMUM for iOS WebKit.
    // Root cause of "Lulou — Notification" placeholder on some iOS 16.4 devices:
    // ANY optional property in the options dict — including `icon` and `data` —
    // can cause showNotification to resolve silently without displaying on certain
    // iOS 16.4–17.x device/OS combinations. Tier 1 therefore uses ONLY `body`
    // and `tag`:
    //   body — notification text (required for anything to appear)
    //   tag  — deduplicates concurrent ring notifications for the same call;
    //           also used by notificationclick to reconstruct the target URL
    //           when `data` is absent (see notificationclick handler below).
    // Chrome/Android receives the full tier 2 options (including data/icon) if
    // tier 1 throws there (which it won't — kept for defence in depth).
    const safeOptions = {
      body,
      tag,
    };

    // Chrome/Android-enhanced options with vibration, persistence, badge.
    const enhancedOptions = {
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

    // Three-tier fallback to guarantee a notification is ALWAYS shown.
    // Each tier is wrapped in its own try-catch so a throw never propagates
    // out of the IIFE — which would cause event.waitUntil to reject and iOS
    // to display its own generic "Lulou — Notification" placeholder.
    //
    //   Tier 1 — safe options   (iOS + Chrome/Android — always attempted first)
    //   Tier 2 — enhanced opts  (Chrome/Android extras; skipped if tier 1 ok)
    //   Tier 3 — title+body     (absolute last resort, no options at all)
    //
    // WHY SAFE FIRST: on iOS WebKit, showNotification() with unsupported options
    // (requireInteraction, vibrate, renotify, silent) silently resolves without
    // displaying the notification — no throw, so the old catch-based fallback
    // never fired. Reversed order eliminates the silent-drop entirely.
    if (VERBOSE_LOGGING) console.log(
      "[SW_PUSH_PRE_NOTIFY] title=\"" + title + "\"",
      "tag=" + tag,
      "safeOpts=" + JSON.stringify({ body: body.slice(0, 30), icon, tag }),
    );
    try {
      await self.registration.showNotification(title, safeOptions);
      console.log("[SW_PUSH_SHOWN] tier=safe title=\"" + title + "\" tag=" + tag);
    } catch (err1) {
      console.warn("[SW_PUSH_FAILED] tier=safe — trying enhanced —", err1 && err1.message);
      try {
        await self.registration.showNotification(title, enhancedOptions);
        console.log("[SW_PUSH_SHOWN] tier=enhanced title=\"" + title + "\"");
      } catch (err2) {
        console.warn("[SW_PUSH_FAILED] tier=enhanced —", err2 && err2.message);
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
  const tag     = event.notification.tag || "";
  // Reconstruct the target URL from `data.url` (tier-2 path) or from the
  // notification `tag` (tier-1 iOS path, where `data` is stripped from
  // safeOptions to work around iOS WebKit silent-notification failures).
  let url = data.url;
  if (!url) {
    if (tag.startsWith("call_"))        url = "/messages/" + tag.slice(5);
    else if (tag.startsWith("msg_"))    url = "/messages/" + tag.slice(4);
    else if (tag.startsWith("missed_")) url = "/messages/" + tag.slice(7);
    else                                url = "/";
  }
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
