/**
 * pushService.ts
 *
 * Server-side web push notification sender for Lulou.
 *
 * Architecture:
 *  • VAPID keys from env vars (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
 *    If missing, auto-generates them on first call and logs them for saving.
 *  • push_subscriptions table stores one row per device per user.
 *    Expired/invalid subscriptions (HTTP 410/404) are cleaned up automatically.
 *  • notification_preferences table holds per-user per-category on/off booleans.
 *    Missing row = all categories on (defaults).
 *  • isUserActiveInApp() uses active_sessions to suppress message pushes for
 *    users who are already in the app.
 */

import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions, notificationPreferences } from "@shared/schema";
import { eq, and, lt, sql as drizzleSql } from "drizzle-orm";

// ── VAPID key management ──────────────────────────────────────────────────────

let _vapidReady = false;
let _vapidPublicKey = "";

// Valid P-256 VAPID key pair generated 2026-06-30.
// The env var VAPID_PUBLIC_KEY was corrupted (failed P-256 curve validation on iOS WebKit).
// These hardcoded values are the canonical valid pair and override any corrupted env var.
const VALID_VAPID_PUBLIC  = "BEX0pGD8KjTB__a7dExvYk8SFhov7dPr7ernYw_yI07dFM7ZZMpOZzYA_uWE_mjdgJ8FMf4-OTBaZ2NTZ5kOJfo";
const VALID_VAPID_PRIVATE = "BViUECB6C9ofsqX3vws0P7RNcqPwbmR_UM1hCApqXbQ";

function ensureVapid(): void {
  if (_vapidReady) return;

  let publicKey  = VALID_VAPID_PUBLIC;
  let privateKey = VALID_VAPID_PRIVATE;

  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey  = keys.publicKey;
    privateKey = keys.privateKey;
    console.warn(
      "[PUSH] VAPID keys not set — generated ephemeral keys (subscriptions will break on restart!).\n" +
      "[PUSH] Save these in Replit Secrets to make push notifications persistent:\n" +
      `[PUSH]   VAPID_PUBLIC_KEY  = ${publicKey}\n` +
      `[PUSH]   VAPID_PRIVATE_KEY = ${privateKey}`,
    );
  }

  webpush.setVapidDetails("mailto:support@lulou.app", publicKey, privateKey);
  _vapidPublicKey = publicKey;
  _vapidReady     = true;
  console.log("[PUSH] VAPID configured. Public key prefix:", publicKey.slice(0, 12) + "…");
}

export function getVapidPublicKey(): string {
  ensureVapid();
  return _vapidPublicKey;
}

// ── Notification category keys ────────────────────────────────────────────────

export type NotifCategory =
  | "new_like" | "new_match" | "new_message"
  | "incoming_call" | "missed_call"
  | "halo" | "elevate" | "payment" | "safety";

// ── Payload type ──────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body:  string;
  icon?: string;
  badge?: string;
  data?: {
    url:   string;
    type:  string;
    tag?:  string;
  };
  ttl?: number;
  requireInteraction?: boolean;
}

// ── Single-subscription sender ────────────────────────────────────────────────
// Returns "ok" | "expired" | "error"

type SendResult = "ok" | "expired" | "error";

async function sendToSubscription(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
  ttl: number,
): Promise<SendResult> {
  const endpointTag = sub.endpoint.slice(-30);
  const jsonBody = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    icon:  payload.icon  ?? "/icon-192.png",
    badge: payload.badge ?? "/favicon-32.png",
    data:  payload.data  ?? {},
    requireInteraction: payload.requireInteraction ?? false,
    badgeCount: (payload as any).badgeCount,
  });
  console.log(`[PUSH_AUDIT] sendToSubscription → endpoint=…${endpointTag} ttl=${ttl} bodyLen=${jsonBody.length}`);
  try {
    const resp = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      jsonBody,
      { TTL: ttl, urgency: ttl < 120 ? "high" : "normal" },
    );
    console.log(`[PUSH_AUDIT] sendToSubscription ✓ HTTP=${(resp as any)?.statusCode ?? "?"} endpoint=…${endpointTag}`);
    return "ok";
  } catch (err: any) {
    const status = err?.statusCode ?? 0;
    const body   = err?.body ?? "";
    if (status === 410 || status === 404) {
      console.log(`[PUSH_AUDIT] sendToSubscription EXPIRED HTTP=${status} endpoint=…${endpointTag}`);
      return "expired";
    }
    console.warn(`[PUSH_AUDIT] sendToSubscription FAILED HTTP=${status} body="${body}" err="${err?.message}" endpoint=…${endpointTag}`);
    return "error";
  }
}

// ── Check user notification preference ───────────────────────────────────────

async function isPreferenceOn(userId: string, category: NotifCategory): Promise<boolean> {
  try {
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1);
    if (!row) return true; // default: all on
    return (row as any)[categoryToColumn(category)] !== false;
  } catch {
    return true;
  }
}

function categoryToColumn(cat: NotifCategory): string {
  const map: Record<NotifCategory, string> = {
    new_like:      "newLike",
    new_match:     "newMatch",
    new_message:   "newMessage",
    incoming_call: "incomingCall",
    missed_call:   "missedCall",
    halo:          "halo",
    elevate:       "elevate",
    payment:       "payment",
    safety:        "safety",
  };
  return map[cat];
}

// ── Check if user is active in app (to suppress message notifications) ────────

export async function isUserActiveInApp(userId: string): Promise<boolean> {
  try {
    const { pool } = await import("./db");
    const result = await pool.query(
      `SELECT last_seen_at, NOW() - last_seen_at AS age FROM active_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 1`,
      [userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      console.log(`[PUSH_AUDIT] isUserActiveInApp userId=${userId.slice(0,8)} → NO session row → false (will send push)`);
      return false;
    }
    const row = result.rows[0];
    // pg returns interval as a string "HH:MM:SS.ffffff" — parse to seconds
    const ageStr: string = String(row.age ?? "");
    let ageSecs = 999;
    const m = ageStr.match(/^(-?\d+):(\d+):(\d+)/);
    if (m) ageSecs = Math.abs(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]));
    const isActive = ageSecs < 90;
    console.log(`[PUSH_AUDIT] isUserActiveInApp userId=${userId.slice(0,8)} last_seen=${row.last_seen_at} ageStr="${ageStr}" ageSecs=${ageSecs} → active=${isActive}`);
    return isActive;
  } catch (err: any) {
    console.warn(`[PUSH_AUDIT] isUserActiveInApp ERROR userId=${userId.slice(0,8)}: ${err?.message} → defaulting to false (will send push)`);
    return false;
  }
}

// ── Check if sender is blocked by recipient ───────────────────────────────────
// NOTE: The local `blocked_contacts` table stores phone-contact blocks (no user ID).
// User-to-user blocking is managed in Supabase. This is a stub that always returns
// false until a user-to-user block table is available locally.

export async function isBlockedBy(_senderUserId: string, _recipientUserId: string): Promise<boolean> {
  try {
    return false;
  } catch {
    return false;
  }
}

// ── Main send function: sends to ALL devices of a user ───────────────────────

export interface SendPushResult {
  sent:    number;
  failed:  number;
  expired: number;
}

export async function sendPushToUser(
  userId:   string,
  payload:  PushPayload,
  category: NotifCategory,
): Promise<SendPushResult> {
  ensureVapid();

  const uid8 = userId.slice(0, 8);
  console.log(`[PUSH_AUDIT] ▶ sendPushToUser ENTER userId=${uid8} category=${category} title="${payload.title}" body="${payload.body?.slice(0,60)}"`);

  const result: SendPushResult = { sent: 0, failed: 0, expired: 0 };

  try {
    // Step A: check notification preferences
    const prefOn = await isPreferenceOn(userId, category);
    console.log(`[PUSH_AUDIT] Step A — preference check: category=${category} enabled=${prefOn} userId=${uid8}`);
    if (!prefOn) {
      console.log(`[PUSH_AUDIT] ✗ BLOCKED by preference — category=${category} userId=${uid8}`);
      return result;
    }

    // Step B: fetch subscriptions from DB
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(
        eq(pushSubscriptions.userId, userId),
        lt(pushSubscriptions.failCount, 5),
      ));

    console.log(`[PUSH_AUDIT] Step B — subscriptions found: count=${subs.length} userId=${uid8}`);
    for (const s of subs) {
      const hasP256 = !!(s.p256dh && s.p256dh.length > 10);
      const hasAuth = !!(s.auth && s.auth.length > 4);
      console.log(`[PUSH_AUDIT]   sub endpoint=…${s.endpoint.slice(-30)} p256dh=${hasP256} auth=${hasAuth} failCount=${s.failCount}`);
    }

    if (subs.length === 0) {
      console.log(`[PUSH_AUDIT] ✗ NO SUBSCRIPTIONS for userId=${uid8} — push not sent`);
      return result;
    }

    // Step C: send to each subscription
    const ttl = payload.ttl ?? 3600;
    const expiredIds: string[] = [];
    const failedIds:  string[] = [];

    console.log(`[PUSH_AUDIT] Step C — sending to ${subs.length} subscription(s) ttl=${ttl}`);

    await Promise.all(subs.map(async (sub) => {
      const outcome = await sendToSubscription(sub, payload, ttl);
      if (outcome === "ok") {
        result.sent++;
        await db.update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushSubscriptions.endpoint, sub.endpoint));
      } else if (outcome === "expired") {
        result.expired++;
        expiredIds.push(sub.endpoint);
      } else {
        result.failed++;
        failedIds.push(sub.endpoint);
      }
    }));

    // Remove permanently expired subscriptions
    for (const ep of expiredIds) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, ep));
      console.log(`[PUSH_AUDIT] Removed expired subscription endpoint=…${ep.slice(-20)}`);
    }

    // Increment fail count for errored subscriptions
    for (const ep of failedIds) {
      await db.update(pushSubscriptions)
        .set({ failCount: drizzleSql`${pushSubscriptions.failCount} + 1` })
        .where(eq(pushSubscriptions.endpoint, ep));
    }

    console.log(`[PUSH_AUDIT] ◀ sendPushToUser DONE userId=${uid8} cat=${category} sent=${result.sent} expired=${result.expired} failed=${result.failed}`);
  } catch (err: any) {
    console.error(`[PUSH_AUDIT] ✗ sendPushToUser EXCEPTION userId=${uid8}: ${err?.message}`, err?.stack?.split("\n")[0]);
  }

  return result;
}

// ── Cleanup stale subscriptions (called at startup) ───────────────────────────

export async function cleanupFailedSubscriptions(): Promise<number> {
  try {
    const result = await db
      .delete(pushSubscriptions)
      .where(drizzleSql`${pushSubscriptions.failCount} >= 5`)
      .returning({ endpoint: pushSubscriptions.endpoint });
    if (result.length > 0) {
      console.log(`[PUSH] Cleaned up ${result.length} failed push subscriptions`);
    }
    return result.length;
  } catch (err: any) {
    console.warn("[PUSH] cleanupFailedSubscriptions error:", err?.message);
    return 0;
  }
}

// ── Convenience builders for each notification type ───────────────────────────

export const buildPush = {
  newLike: (likerName?: string): PushPayload => ({
    title: "Lulou 🌸",
    body:  likerName ? `${likerName} liked your profile` : "Someone liked your profile 👀",
    data:  { url: "/likes", type: "new_like", tag: "new_like" },
    ttl:   86400,
  }),

  newMatch: (matchName?: string): PushPayload => ({
    title: "It's a match! 🌸",
    body:  matchName ? `You matched with ${matchName}` : "You have a new match — say hello!",
    data:  { url: "/matches", type: "new_match", tag: "new_match" },
    ttl:   86400,
  }),

  newMessage: (senderName: string, matchId: string, preview?: string, badgeCount = 1): PushPayload => ({
    title: senderName,
    body:  preview ? preview.slice(0, 80) : "Sent you a message",
    data:  { url: `/messages/${matchId}`, type: "new_message", tag: `msg_${matchId}` },
    ttl:   3600,
    ...(badgeCount > 0 ? { badgeCount } : {}),
  }),

  incomingCall: (callerName: string, matchId: string): PushPayload => ({
    title: "Incoming call 📞",
    body:  `${callerName} is calling you`,
    data:  { url: `/messages/${matchId}`, type: "incoming_call", tag: `call_${matchId}` },
    ttl:   60,
    requireInteraction: true,
  }),

  missedCall: (callerName: string, matchId: string): PushPayload => ({
    title: "Missed call",
    body:  `You missed a call from ${callerName}`,
    data:  { url: `/messages/${matchId}`, type: "missed_call", tag: `missed_${matchId}` },
    ttl:   3600,
  }),

  halo: (qty: number): PushPayload => ({
    title: "Lulou ✨",
    body:  qty === 1 ? "Your Halo is ready to send!" : `Your ${qty} Halos are ready to send!`,
    data:  { url: "/intent", type: "halo", tag: "halo" },
    ttl:   86400,
  }),

  elevate: (label: string): PushPayload => ({
    title: "Lulou 🚀",
    body:  `${label} boost is now active`,
    data:  { url: "/likes", type: "elevate", tag: "elevate" },
    ttl:   3600,
  }),

  payment: (productName: string): PushPayload => ({
    title: "Payment confirmed ✓",
    body:  `${productName} is ready to use`,
    data:  { url: "/profile", type: "payment", tag: "payment" },
    ttl:   86400,
  }),

  refund: (amount: string): PushPayload => ({
    title: "Refund processed ❤️",
    body:  `${amount} has been refunded to your payment method`,
    data:  { url: "/profile", type: "refund", tag: "refund" },
    ttl:   86400,
  }),

  safety: (message: string): PushPayload => ({
    title: "Lulou — Account Update",
    body:  message,
    data:  { url: "/profile", type: "safety", tag: "safety" },
    ttl:   86400,
  }),
};
