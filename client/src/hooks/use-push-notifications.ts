/**
 * use-push-notifications.ts
 *
 * React hook that manages web push notification subscriptions and preferences.
 *
 * Usage:
 *   const push = usePushNotifications();
 *   push.subscribe(onStep)    — request permission + subscribe device
 *   push.unsubscribe()        — remove subscription from server + browser
 *   push.preferences          — { newLike, newMatch, … }
 *   push.updatePreference()   — toggle a single category
 *   push.isSubscribed         — boolean
 *   push.permission           — "default" | "granted" | "denied"
 *   push.isIosSafari          — true if iOS Safari (push NOT supported)
 *   push.isIosPwa             — true if iOS Home Screen PWA (push supported)
 *   push.debugStep            — current step label shown in UI while loading
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { apiRequest, API_BASE } from "@/lib/queryClient";

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotifCategory =
  | "newLike" | "newMatch" | "newMessage"
  | "incomingCall" | "missedCall"
  | "halo" | "elevate" | "payment" | "safety";

export const NOTIF_CATEGORIES: { key: NotifCategory; label: string; description: string }[] = [
  { key: "newMatch",     label: "Matches",          description: "When you get a new match" },
  { key: "newLike",      label: "Likes",             description: "When someone likes your profile" },
  { key: "newMessage",   label: "Messages",          description: "New messages from your matches" },
  { key: "incomingCall", label: "Incoming calls",    description: "When a match calls you" },
  { key: "missedCall",   label: "Missed calls",      description: "Calls you missed" },
  { key: "halo",         label: "Halos & boosts",    description: "Halo purchases and Elevate status" },
  { key: "payment",      label: "Payments",          description: "Purchase confirmations and refunds" },
  { key: "safety",       label: "Safety alerts",     description: "Important account notifications" },
];

export type NotifPreferences = Record<NotifCategory, boolean>;

const DEFAULT_PREFS: NotifPreferences = {
  newLike:      true,
  newMatch:     true,
  newMessage:   true,
  incomingCall: true,
  missedCall:   true,
  halo:         true,
  elevate:      true,
  payment:      true,
  safety:       true,
};

// ── iOS detection helpers ─────────────────────────────────────────────────────

function detectIos(): { isIos: boolean; isIosPwa: boolean; isIosSafari: boolean } {
  if (typeof window === "undefined") return { isIos: false, isIosPwa: false, isIosSafari: false };
  const ua  = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // navigator.standalone is true when launched from Home Screen on iOS
  const isIosPwa = isIos && !!(navigator as any).standalone;
  const isIosSafari = isIos && !isIosPwa;
  return { isIos, isIosPwa, isIosSafari };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePushNotifications() {
  const { isIos, isIosPwa, isIosSafari } = detectIos();

  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [isSubscribed,       setIsSubscribed]       = useState(false);
  const [preferences,        setPreferences]        = useState<NotifPreferences>(DEFAULT_PREFS);
  const [isLoading,          setIsLoading]          = useState(false);
  const [error,              setError]              = useState<string | null>(null);
  const [debugStep,          setDebugStep]          = useState<string>("");
  const [swReg,              setSwReg]              = useState<ServiceWorkerRegistration | null>(null);
  // Account-level preference: true=user wants notifications, false=user disabled, null=never set.
  // Loaded from /api/settings on mount so the toggle doesn't flicker off on refresh.
  // undefined = not yet loaded; false = loaded, disabled; true = loaded, enabled.
  // Never null — loading state is represented by undefined so that the stale-
  // subscription cleanup (which gates on accountPreference === false) does not
  // fire prematurely on mount before the server row has been read.
  const [accountPreference,  setAccountPreference]  = useState<boolean | undefined>(undefined);
  const vapidKeyRef = useRef<string | null>(null);

  // needsReconnect: account says "on" but this device has no active subscription
  const needsReconnect = accountPreference === true && !isSubscribed;

  // isSupported: PushManager requires iOS 16.4+ installed PWA, or any modern desktop/Android Chrome
  const isSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // ── Diagnostics logged once on mount ──────────────────────────────────────
  useEffect(() => {
    console.log("[PUSH] Environment check:", {
      isIos,
      isIosPwa,
      isIosSafari,
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager:   "PushManager" in window,
      hasNotification:  "Notification" in window,
      isSupported,
      permission: typeof Notification !== "undefined" ? Notification.permission : "N/A",
      ua: navigator.userAgent,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clean up stale subscription when account preference is explicitly off ─────
  // If the user disabled notifications (accountPreference === false) but a browser
  // subscription still lingers (e.g. from a previous enable on this device), remove
  // it so the toggle doesn't appear enabled due to a stale subscription.
  useEffect(() => {
    if (!isSupported || accountPreference !== false) return;
    (async () => {
      try {
        const sw = await navigator.serviceWorker.ready.catch(() => null);
        if (!sw) return;
        const existing = await sw.pushManager.getSubscription();
        if (existing) {
          await apiRequest("DELETE", "/api/push/subscribe", { endpoint: existing.endpoint }).catch(() => {});
          await existing.unsubscribe();
          setIsSubscribed(false);
          console.log("[PUSH] Cleaned up stale subscription (account preference is off)");
        }
      } catch (e: any) {
        console.warn("[PUSH] Could not clean up stale subscription:", e?.message);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountPreference, isSupported]);

  // ── Register Service Worker ────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupported) {
      console.log("[PUSH] SW registration skipped — push not supported in this environment");
      return;
    }
    console.log("[PUSH] Registering service worker…");
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        setSwReg(reg);
        console.log("[PUSH] SW registered OK — scope:", reg.scope, "| state:", reg.active?.state ?? "no active worker yet");

        // ── One-shot recovery reload for stale SW ────────────────────────────
        // If the active worker is an old version (< 3.5) that has the broken
        // fetch handler, trigger an update check.  When the new worker becomes
        // active (controllerchange fires), reload ONCE so the page runs under
        // the fixed service worker.
        //
        // Guard: sessionStorage flag prevents a reload loop in the unlikely
        // event that controllerchange fires more than once (e.g. rapid deploys).
        const RELOAD_GUARD = "lulou_sw_reload_3.5";
        const alreadyReloaded = (() => { try { return sessionStorage.getItem(RELOAD_GUARD) === "1"; } catch { return false; } })();

        if (!alreadyReloaded) {
          // Ask the active SW for its version via MessageChannel
          const askVersion = () => {
            const active = reg.active;
            if (!active) return;
            const mc = new MessageChannel();
            mc.port1.onmessage = (e) => {
              const ver: string = e.data?.version ?? "";
              console.log("[PUSH] Active SW version:", ver);
              if (ver && ver < "3.5") {
                // Old (broken) worker — trigger update
                console.warn("[PUSH] Stale SW detected (v" + ver + ") — requesting update to v3.5");
                reg.update().catch(() => {});
              }
            };
            active.postMessage({ type: "GET_VERSION" }, [mc.port2]);
          };

          if (reg.active) {
            askVersion();
          } else {
            // Worker installing — wait for it to activate
            reg.addEventListener("updatefound", () => {
              reg.installing?.addEventListener("statechange", () => {
                if (reg.active) askVersion();
              });
            });
          }

          // Reload once when a new worker takes control
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            console.log("[PUSH] SW controllerchange — reloading once for v3.5");
            try { sessionStorage.setItem(RELOAD_GUARD, "1"); } catch {}
            window.location.reload();
          });
        }
      })
      .catch((err) => {
        console.warn("[PUSH] SW registration FAILED:", err?.name, err?.message);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  // ── Fetch VAPID public key once ────────────────────────────────────────────
  const getVapidKey = useCallback(async (): Promise<string | null> => {
    if (vapidKeyRef.current) {
      console.log("[PUSH] VAPID key (cached):", vapidKeyRef.current.slice(0, 12) + "…");
      return vapidKeyRef.current;
    }
    try {
      console.log("[PUSH] Fetching VAPID key from", API_BASE + "/api/push/vapid-key");
      const res = await fetch(API_BASE + "/api/push/vapid-key");
      console.log("[PUSH] VAPID key response status:", res.status);
      if (!res.ok) {
        console.error("[PUSH] VAPID key fetch failed — HTTP", res.status);
        return null;
      }
      const { publicKey } = await res.json();
      console.log("[PUSH] VAPID key received:", publicKey.slice(0, 12) + "…");
      vapidKeyRef.current = publicKey;
      return publicKey;
    } catch (e: any) {
      console.error("[PUSH] VAPID key fetch threw:", e?.message);
      return null;
    }
  }, []);

  // ── Load subscription state + account preference + category prefs on mount ───
  // Also silently re-registers any existing browser subscription under the
  // currently authenticated user. This corrects stale userId→endpoint mappings
  // that can arise when the same device is used with multiple accounts.
  // The server's POST /api/push/subscribe uses DELETE+INSERT so the endpoint
  // is always re-owned by the authenticated user making the request.
  useEffect(() => {
    if (!isSupported || !swReg) return;
    (async () => {
      try {
        // Load account-level preference from user_settings (independent of device state)
        try {
          const settingsRes = await apiRequest("GET", "/api/settings");
          const settingsData = await settingsRes.json();
          const acctPref = settingsData?.pushAccountEnabled;
          setAccountPreference(typeof acctPref === "boolean" ? acctPref : undefined);
          console.log("[PUSH_SUBSCRIPTION] account preference loaded:", acctPref);
        } catch (settingsErr: any) {
          console.log("[PUSH_SUBSCRIPTION] account preference fetch skipped (not auth'd?):", settingsErr?.message);
        }

        const existing = await swReg.pushManager.getSubscription();
        console.log("[PUSH_SUBSCRIPTION] Existing subscription on mount:", existing ? "YES" : "none", "| Notification.permission:", Notification.permission, "| SW state:", swReg.active?.state ?? "none");
        setIsSubscribed(!!existing);
        if (existing) {
          // Re-register under the current authenticated user (silent — fixes stale mappings)
          try {
            await apiRequest("POST", "/api/push/subscribe", {
              endpoint:  existing.endpoint,
              p256dh:    arrayBufferToBase64(existing.getKey("p256dh")),
              auth:      arrayBufferToBase64(existing.getKey("auth")),
              userAgent: navigator.userAgent.slice(0, 200),
            });
            console.log("[PUSH_SUBSCRIPTION] subscription persisted: auto-reregistered under current user ✓");
          } catch (reregErr: any) {
            // 401 means not authenticated yet — harmless, subscription stays in browser
            console.log("[PUSH_SUBSCRIPTION] auto-reregister skipped (not authenticated or server error):", reregErr?.message);
          }
          const res = await apiRequest("GET", "/api/push/preferences");
          const data = await res.json();
          setPreferences({ ...DEFAULT_PREFS, ...data });
        }
      } catch (e: any) {
        console.warn("[PUSH_SUBSCRIPTION] getSubscription on mount failed:", e?.message);
      }
    })();
  }, [isSupported, swReg]);

  // ── Subscribe ──────────────────────────────────────────────────────────────
  const subscribe = useCallback(async (
    onStep?: (step: string) => void,
  ): Promise<boolean> => {
    const step = (msg: string) => {
      console.log("[PUSH]", msg);
      setDebugStep(msg);
      onStep?.(msg);
    };

    step("Toggle tapped");

    if (!isSupported) {
      const reason = isIosSafari
        ? "Push only works in the installed app. Add Lulou to your Home Screen first."
        : "Push notifications are not supported on this browser.";
      step("FAIL — not supported: " + reason);
      setError(reason);
      setIsLoading(false);
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Step 1 — resolve service worker registration
      step("Step 1/5 — Resolving service worker…");
      let reg = swReg;
      if (!reg) {
        step("Step 1/5 — swReg null, waiting for navigator.serviceWorker.ready…");
        try {
          reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("SW ready timed out after 8 s")), 8000)
            ),
          ]) as ServiceWorkerRegistration;
          setSwReg(reg);
          step("Step 1/5 — SW ready: " + reg.scope);
        } catch (e: any) {
          step("FAIL — SW ready timeout: " + e?.message);
          setError("Service worker did not start. Reload the app and try again.");
          return false;
        }
      } else {
        step("Step 1/5 — SW already registered: " + reg.scope);
      }

      // Step 2 — request notification permission
      step("Step 2/5 — Requesting notification permission…");
      console.log("[PUSH] Current Notification.permission before request:", Notification.permission);
      let perm: NotificationPermission;
      try {
        perm = await Notification.requestPermission();
      } catch (e: any) {
        step("FAIL — requestPermission threw: " + e?.name + " " + e?.message);
        setError("Permission request failed: " + (e?.message ?? "unknown error"));
        return false;
      }
      setPermission(perm);
      step("Step 2/5 — Permission result: " + perm);

      if (perm !== "granted") {
        const msg = perm === "denied"
          ? "Notifications are blocked. Go to iPhone Settings → Notifications → Lulou and turn on Allow Notifications."
          : "Notification permission was not granted (result: " + perm + ").";
        setError(msg);
        return false;
      }

      // Step 3 — fetch VAPID key
      step("Step 3/5 — Fetching VAPID key…");
      const vapidKey = await getVapidKey();
      if (!vapidKey) {
        step("FAIL — VAPID key not received from server");
        setError("Could not fetch the notification key from the server. Check your connection.");
        return false;
      }
      const keyBytes = urlBase64ToUint8Array(vapidKey);
      step(
        `Step 3/5 — VAPID key OK: ${vapidKey.length} chars → ${keyBytes.length} bytes, ` +
        `first byte 0x${keyBytes[0]?.toString(16).padStart(2,"0")} ` +
        `(expect 65 bytes, 0x04)`
      );
      if (keyBytes.length !== 65 || keyBytes[0] !== 0x04) {
        step(`FAIL — decoded key invalid: length=${keyBytes.length} firstByte=0x${keyBytes[0]?.toString(16)}`);
        setError(`VAPID key decoded incorrectly: got ${keyBytes.length} bytes, first byte 0x${keyBytes[0]?.toString(16)}. Expected 65 bytes starting with 0x04.`);
        return false;
      }

      // Step 3b — clear any stale subscription before subscribing
      // An existing subscription registered with a different VAPID key causes
      // iOS to throw "applicationServerKey must contain a valid P-256 public key".
      step("Step 3b/5 — Checking for stale existing subscription…");
      try {
        const existingSub = await reg.pushManager.getSubscription();
        if (existingSub) {
          step("Step 3b/5 — Stale subscription found — clearing it before re-subscribing…");
          await existingSub.unsubscribe();
          step("Step 3b/5 — Stale subscription cleared ✓");
        } else {
          step("Step 3b/5 — No stale subscription found ✓");
        }
      } catch (e: any) {
        step("Step 3b/5 — WARNING: Could not clear stale subscription: " + e?.message);
        // Non-fatal — continue and let subscribe() handle it
      }

      // Step 4 — push subscription
      step("Step 4/5 — Calling PushManager.subscribe (userVisibleOnly=true)…");
      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly:      true,
          applicationServerKey: keyBytes,
        });
        step("Step 4/5 — PushManager.subscribe OK — endpoint prefix: " + sub.endpoint.slice(0, 40) + "…");
      } catch (e: any) {
        step("FAIL — PushManager.subscribe threw: " + e?.name + ": " + e?.message);
        if (e?.name === "NotAllowedError") {
          setError("Notifications blocked. Enable in iPhone Settings → Notifications → Lulou.");
        } else if (e?.name === "AbortError") {
          setError("Subscription was cancelled by the browser. Please try again.");
        } else {
          setError("Push subscribe failed: " + (e?.message ?? e?.name ?? "unknown error"));
        }
        return false;
      }

      // Step 5 — save to server
      step("Step 5/5 — Saving subscription to server…");
      try {
        await apiRequest("POST", "/api/push/subscribe", {
          endpoint:  sub.endpoint,
          p256dh:    arrayBufferToBase64(sub.getKey("p256dh")),
          auth:      arrayBufferToBase64(sub.getKey("auth")),
          userAgent: navigator.userAgent.slice(0, 200),
        });
        step("Step 5/5 — Subscription saved to server ✓");
      } catch (e: any) {
        step("FAIL — server save threw: " + e?.message);
        setError("Subscribed but failed to save to server: " + (e?.message ?? "network error"));
        return false;
      }

      // Set account-level preference to enabled (await — not fire-and-forget)
      setAccountPreference(true);
      try {
        await apiRequest("PATCH", "/api/settings", { pushAccountEnabled: true });
        console.log("[PUSH_SUBSCRIPTION] account preference set: enabled ✓");
      } catch (e: any) {
        console.error("[PUSH_SUBSCRIPTION] Failed to save account preference enabled:", e?.message);
        // Non-fatal: the preference will correct itself on next settings fetch.
      }

      setIsSubscribed(true);
      step("Done — push notifications enabled ✓");
      return true;

    } catch (err: any) {
      step("FAIL — unexpected error: " + err?.name + ": " + err?.message);
      setError("Unexpected error: " + (err?.message ?? "unknown") + " (" + (err?.name ?? "") + ")");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, isIosSafari, swReg, getVapidKey]);

  // ── Unsubscribe ────────────────────────────────────────────────────────────
  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!isSupported || !swReg) return;
    setIsLoading(true);
    try {
      const sub = await swReg.pushManager.getSubscription();
      if (sub) {
        await apiRequest("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setIsSubscribed(false);
      setAccountPreference(false);
      try {
        await apiRequest("PATCH", "/api/settings", { pushAccountEnabled: false });
        console.log("[PUSH_SUBSCRIPTION] unsubscribed: account preference set to disabled");
      } catch (e: any) {
        console.error("[PUSH_SUBSCRIPTION] Failed to save account preference disabled:", e?.message);
      }
    } catch (err: any) {
      console.error("[PUSH] Unsubscribe error:", err?.message);
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, swReg]);

  // ── Update a single preference ─────────────────────────────────────────────
  const updatePreference = useCallback(async (
    category: NotifCategory,
    value:    boolean,
  ): Promise<void> => {
    const next = { ...preferences, [category]: value };
    setPreferences(next);
    try {
      await apiRequest("PUT", "/api/push/preferences", { [category]: value });
    } catch (err: any) {
      console.error("[PUSH] updatePreference error:", err?.message);
      setPreferences(preferences);
    }
  }, [preferences]);

  // ── Badge helpers ──────────────────────────────────────────────────────────
  const setBadge = useCallback((count: number) => {
    const n = Math.max(0, Math.round(count));
    if (n > 0) {
      if ("setAppBadge" in navigator) (navigator as any).setAppBadge(n).catch(() => {});
      swReg?.active?.postMessage({ type: "SET_BADGE", count: n });
    } else {
      if ("clearAppBadge" in navigator) (navigator as any).clearAppBadge().catch(() => {});
      swReg?.active?.postMessage({ type: "CLEAR_BADGE" });
    }
  }, [swReg]);

  const clearBadge = useCallback(() => {
    if ("clearAppBadge" in navigator) (navigator as any).clearAppBadge().catch(() => {});
    swReg?.active?.postMessage({ type: "CLEAR_BADGE" });
  }, [swReg]);

  /**
   * Fetch the current server-side badge total and apply it to the app icon.
   * Call this on cold open so the badge reflects messages received while closed.
   */
  const syncBadgeFromServer = useCallback(async (): Promise<number> => {
    try {
      const res = await fetch(API_BASE + "/api/messages/unread-count", { credentials: "include" });
      if (!res.ok) return 0;
      const { total } = await res.json();
      const count = typeof total === "number" ? Math.max(0, total) : 0;
      setBadge(count);
      return count;
    } catch {
      return 0;
    }
  }, [setBadge]);

  return {
    isSupported,
    isIos,
    isIosPwa,
    isIosSafari,
    permission,
    isSubscribed,
    accountPreference,
    needsReconnect,
    preferences,
    isLoading,
    error,
    debugStep,
    subscribe,
    unsubscribe,
    updatePreference,
    setBadge,
    clearBadge,
    syncBadgeFromServer,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding  = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64   = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData  = window.atob(base64);
  const output   = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const uint8 = new Uint8Array(buffer);
  let binary  = "";
  for (let i = 0; i < uint8.byteLength; i++) binary += String.fromCharCode(uint8[i]);
  return window.btoa(binary);
}
