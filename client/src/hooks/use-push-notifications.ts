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
  const [isSubscribed,   setIsSubscribed]   = useState(false);
  const [preferences,    setPreferences]    = useState<NotifPreferences>(DEFAULT_PREFS);
  const [isLoading,      setIsLoading]      = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [debugStep,      setDebugStep]      = useState<string>("");
  const [swReg,          setSwReg]          = useState<ServiceWorkerRegistration | null>(null);
  const vapidKeyRef = useRef<string | null>(null);

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

  // ── Load subscription state + preferences on mount ─────────────────────────
  useEffect(() => {
    if (!isSupported || !swReg) return;
    (async () => {
      try {
        const existing = await swReg.pushManager.getSubscription();
        console.log("[PUSH] Existing subscription on mount:", existing ? "YES" : "none");
        setIsSubscribed(!!existing);
        if (existing) {
          const res = await apiRequest("GET", "/api/push/preferences");
          const data = await res.json();
          setPreferences({ ...DEFAULT_PREFS, ...data });
        }
      } catch (e: any) {
        console.warn("[PUSH] getSubscription on mount failed:", e?.message);
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
      console.log("[PUSH] Unsubscribed from push notifications");
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
    if (!swReg) return;
    swReg.active?.postMessage({ type: "SET_BADGE", count });
    if ("setAppBadge" in navigator) (navigator as any).setAppBadge(count).catch(() => {});
  }, [swReg]);

  const clearBadge = useCallback(() => {
    if (!swReg) return;
    swReg.active?.postMessage({ type: "CLEAR_BADGE" });
    if ("clearAppBadge" in navigator) (navigator as any).clearAppBadge().catch(() => {});
  }, [swReg]);

  return {
    isSupported,
    isIos,
    isIosPwa,
    isIosSafari,
    permission,
    isSubscribed,
    preferences,
    isLoading,
    error,
    debugStep,
    subscribe,
    unsubscribe,
    updatePreference,
    setBadge,
    clearBadge,
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
