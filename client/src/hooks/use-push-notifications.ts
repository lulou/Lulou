/**
 * use-push-notifications.ts
 *
 * React hook that manages web push notification subscriptions and preferences.
 *
 * Usage:
 *   const push = usePushNotifications();
 *   push.subscribe()         — request permission + subscribe device
 *   push.unsubscribe()       — remove subscription from server + browser
 *   push.preferences         — { newLike, newMatch, … }
 *   push.updatePreference()  — toggle a single category
 *   push.isSubscribed        — boolean
 *   push.permission          — "default" | "granted" | "denied"
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

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [isSubscribed,   setIsSubscribed]   = useState(false);
  const [preferences,    setPreferences]    = useState<NotifPreferences>(DEFAULT_PREFS);
  const [isLoading,      setIsLoading]      = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [swReg,          setSwReg]          = useState<ServiceWorkerRegistration | null>(null);
  const vapidKeyRef = useRef<string | null>(null);

  const isSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // ── Register Service Worker ────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupported) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        setSwReg(reg);
        console.log("[PUSH] SW registered scope:", reg.scope);
      })
      .catch((err) => {
        console.warn("[PUSH] SW registration failed:", err?.message);
      });
  }, [isSupported]);

  // ── Fetch VAPID public key once ────────────────────────────────────────────
  const getVapidKey = useCallback(async (): Promise<string | null> => {
    if (vapidKeyRef.current) return vapidKeyRef.current;
    try {
      const res = await fetch(API_BASE + "/api/push/vapid-key");
      if (!res.ok) return null;
      const { publicKey } = await res.json();
      vapidKeyRef.current = publicKey;
      return publicKey;
    } catch {
      return null;
    }
  }, []);

  // ── Load subscription state + preferences on mount ─────────────────────────
  useEffect(() => {
    if (!isSupported || !swReg) return;
    (async () => {
      try {
        const existing = await swReg.pushManager.getSubscription();
        setIsSubscribed(!!existing);
        if (existing) {
          const res = await apiRequest("GET", "/api/push/preferences");
          const data = await res.json();
          setPreferences({ ...DEFAULT_PREFS, ...data });
        }
      } catch { /* ignore */ }
    })();
  }, [isSupported, swReg]);

  // ── Subscribe ──────────────────────────────────────────────────────────────
  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported || !swReg) {
      setError("Push notifications are not supported on this device.");
      return false;
    }
    setIsLoading(true);
    setError(null);
    try {
      // Request permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError(perm === "denied"
          ? "Notifications are blocked. Enable them in your browser settings."
          : "Permission not granted."
        );
        return false;
      }

      const vapidKey = await getVapidKey();
      if (!vapidKey) { setError("Could not fetch notification key."); return false; }

      const sub = await swReg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      await apiRequest("POST", "/api/push/subscribe", {
        endpoint: sub.endpoint,
        p256dh:   arrayBufferToBase64(sub.getKey("p256dh")),
        auth:     arrayBufferToBase64(sub.getKey("auth")),
        userAgent: navigator.userAgent.slice(0, 200),
      });

      setIsSubscribed(true);
      console.log("[PUSH] Subscribed to push notifications");
      return true;
    } catch (err: any) {
      console.error("[PUSH] Subscribe error:", err?.message);
      setError("Failed to enable notifications. Please try again.");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, swReg, getVapidKey]);

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
      setPreferences(preferences); // revert
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
    permission,
    isSubscribed,
    preferences,
    isLoading,
    error,
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
