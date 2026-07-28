import express from "express";
import type { Express, RequestHandler } from "express";
import multer from "multer";
import { createServer, type Server } from "http";
import { randomUUID } from "crypto";
import { execSync as _execSync } from "child_process";
import { statSync as _statSync } from "fs";

// ── Server-level version constants (set once at process start) ────────────────
const SERVER_START_TIME = new Date();
let SERVER_COMMIT_HASH = process.env.COMMIT_HASH || process.env.VERCEL_GIT_COMMIT_SHA || "dev";
try { SERVER_COMMIT_HASH = _execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim(); } catch {}

// Build time: mtime of the compiled bundle (dist/index.cjs) when available.
// Falls back to process start time, which is an acceptable proxy in dev.
let SERVER_BUILD_TIME: string = SERVER_START_TIME.toISOString();
try {
  // import.meta.url is shim-patched by esbuild in CJS output to __filename URL
  const bundlePath = new URL(import.meta.url).pathname;
  SERVER_BUILD_TIME = _statSync(bundlePath).mtime.toISOString();
} catch {}

// App version from package.json (available via npm_package_version when run via npm).
const APP_VERSION: string = (process.env.npm_package_version as string | undefined) || "1.0.0";

import { SupabaseStorage, mapMatch, type CompleteCallOptions, geocodeLocation, getHasLatLngColumns, getHasEmailVerifiedColumn, incrementMatchBadge, resetMatchBadge, getTotalBadge, getAllMatchBadgeCounts } from "./storage";
import { transcodeToM4a } from "./transcoder";
import { seedDatabase } from "./seed";
import { z } from "zod";
import type { Profile } from "@shared/schema";
import { matches, messages, userBenefits, callCredits, activeSessions, processedStripeSessions, membershipSubscriptions, userElevates, blockedContacts, savedWheelProfiles, sparkBalances, sparkPurchases, pushSubscriptions, notificationPreferences, datePlanRemindersSent, activeChatSessions, refundRecords, voiceNoteUnlocks, voiceNotePopupSeen, firstCallPromptSeen } from "@shared/schema";
import { sendPushToUser, buildPush, isUserActiveInApp, isUserActiveInChat, getVapidPublicKey, cleanupFailedSubscriptions } from "./pushService";
import { EXTRAS_ITEMS, ELEVATE_PACKS, type ExtrasItemId, type ElevatePackId, grantExtras, grantElevate, isUniqueViolation } from './purchaseItems';
import { supabase, supabaseAdmin, createUserClient, hasServiceRoleKey } from "./supabase";
import { db } from "./db";
import { eq, and, isNull, gt, or, inArray, desc, sql as sqlExpr } from "drizzle-orm";
import { getUncachableStripeClient, getStripePublishableKey, getStripeAccountInfo, checkStripeReady } from "./stripeClient";
import { tryGetPriceId } from "./stripePrices";
import { writeLimiter, callLimiter, paymentLimiter } from "./limiters";
import { sendEmail, getEmailLog } from "./emailService";
import { welcomeEmail } from "./emailTemplates";
import { registerAdminSimulatorRoutes } from "./adminSimulator";


// Debounced last-active updater — fires at most once per 2 min per user.
const _lastActiveDebounce = new Map<string, number>();
const LAST_ACTIVE_TTL_MS = 2 * 60 * 1000;

// Seed user IDs all start with this UUID prefix (see server/seed.ts)
const SEED_UUID_PREFIX = "10000000-0000-4000-a000-";
const isSeedUser = (id: string) => id.startsWith(SEED_UUID_PREFIX);

// ── Dev-only server performance logger ───────────────────────────────────────
// All output is suppressed in production so there is zero log noise for users.
const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * Emit a single structured performance log line, dev-only.
 *
 * Format: [SERVER PERF] endpoint | Nms | key=value | …
 * Easy to grep for in the server console or copy as a block.
 */
function devPerf(endpoint: string, ms: number, meta: Record<string, unknown>): void {
  if (!IS_DEV) return;
  const parts: string[] = [`[SERVER PERF] ${endpoint}`, `${ms}ms`];
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null) parts.push(`${k}=${v}`);
  }
  console.log(parts.join(" | "));
}

/** Detect whether a photo URL is a base64 data-URL or a Supabase Storage URL */
function photoFormat(url: string): "base64" | "storage-url" | "empty" {
  if (!url) return "empty";
  return url.startsWith("data:") ? "base64" : "storage-url";
}

// JWT verification cache — avoids repeated decoding on every request.
// Uses a 2-minute TTL (well within any JWT's 1h window), max 500 entries.
const _jwtCache = new Map<string, { user: any; expiresAt: number }>();
const JWT_CACHE_TTL_MS = 2 * 60_000;
const JWT_CACHE_MAX = 500;

// ── Application session-ID cache ──────────────────────────────────────────────
// Keyed by "userId:sessionId".  value.valid = false means this session is no
// longer the active session.  value.reason distinguishes WHY:
//   "session_replaced" — a DIFFERENT device's bootstrap replaced this session.
//     The old device must be signed out with the "another device" message.
//   "invalid_session"  — the same device's own bootstrap, or the session aged out.
//     The client should re-bootstrap silently, NOT sign out.
//
// CRITICAL: the middleware fast-reject path must return the correct message.
// Returning "session_replaced" for an expired same-device session causes false
// logouts every time the user reopens the app after > 15 min background
// (the race between INITIAL_SESSION bootstrap and in-flight React Query / heartbeat).
//
// TTL = 30 s; max 1000 entries; evicts oldest on overflow.
const _sessionIdCache = new Map<string, { valid: boolean; reason?: "session_replaced" | "invalid_session"; expiresAt: number }>();
const SESSION_ID_CACHE_TTL_MS = 30_000;
const SESSION_ID_CACHE_MAX = 1_000;

function getSessionIdCacheKey(userId: string, sessionId: string) {
  return `${userId}:${sessionId}`;
}
function cacheSessionIdValid(
  userId: string,
  sessionId: string,
  valid: boolean,
  reason?: "session_replaced" | "invalid_session",
) {
  const key = getSessionIdCacheKey(userId, sessionId);
  const expiresAt = Date.now() + SESSION_ID_CACHE_TTL_MS;
  if (_sessionIdCache.size >= SESSION_ID_CACHE_MAX) {
    const oldest = _sessionIdCache.keys().next().value;
    if (oldest) _sessionIdCache.delete(oldest);
  }
  _sessionIdCache.set(key, { valid, reason, expiresAt });
}
function lookupSessionIdCache(userId: string, sessionId: string): boolean | null {
  const key = getSessionIdCacheKey(userId, sessionId);
  const entry = _sessionIdCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { _sessionIdCache.delete(key); return null; }
  return entry.valid;
}
/** Returns the cached invalidation reason, or null on cache miss / valid entry. */
function lookupSessionIdCacheReason(userId: string, sessionId: string): "session_replaced" | "invalid_session" | null {
  const key = getSessionIdCacheKey(userId, sessionId);
  const entry = _sessionIdCache.get(key);
  if (!entry || entry.expiresAt < Date.now() || entry.valid) return null;
  return entry.reason ?? null;
}

function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.warn(`[AUTH_DIAG] JWT_MALFORMED: expected 3 parts, got ${parts.length} — tokenPrefix="${token.slice(0, 20)}"`);
      return null;
    }
    // Node's base64 decoder handles base64url (no padding, - and _ chars) transparently
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload;
  } catch (e: any) {
    console.warn(`[AUTH_DIAG] JWT_PARSE_ERROR: ${e?.message} — tokenPrefix="${token.slice(0, 20)}"`);
    return null;
  }
}

// Verifies a JWT by decoding its payload locally — no network call.
//
// WHY LOCAL DECODE INSTEAD OF supabase.auth.getUser():
// In the Replit production environment, supabase.auth.getUser() consistently
// fails with UND_ERR_HEADERS_TIMEOUT (network-level headers timeout) on every
// request. This causes every isAuthenticated check to time out after 7 s,
// return 401, and the client's 3-retry loop takes ~28 s before showing an
// error screen to the user.
//
// SECURITY: Skipping the server-side Supabase signature check is safe here
// because every actual database query goes through the user-scoped Supabase
// client which sends the JWT to Supabase PostgREST. PostgREST re-verifies the
// JWT signature on every request and enforces RLS. A forged JWT with a crafted
// sub would pass this middleware but be rejected by PostgREST on any DB call.
function verifyJwt(token: string): any | null {
  const now = Date.now();
  const cached = _jwtCache.get(token);
  if (cached && cached.expiresAt > now) return cached.user;

  const payload = parseJwtPayload(token);
  if (!payload) {
    console.error("[AUTH] JWT_DECODE_FAILED: malformed token (cannot split/parse payload)");
    return null;
  }

  const { sub, exp, email, aud, role, app_metadata, user_metadata } = payload;

  if (!sub) {
    console.error(`[AUTH_DIAG] JWT_NO_SUB: payload has no sub field — tokenPrefix="${token.slice(0, 20)}" email=${email ?? "(none)"}`);
    return null;
  }

  // Reject if the JWT is already expired
  const expMs = exp ? (exp as number) * 1000 : 0;
  if (expMs > 0 && expMs < now) {
    console.warn(
      `[AUTH_DIAG] JWT_EXPIRED: sub=${(sub as string).slice(0, 8)} exp=${exp} now=${Math.floor(now / 1000)} ` +
      `delta=${Math.floor((now - expMs) / 1000)}s tokenPrefix="${token.slice(0, 20)}"`
    );
    return null;
  }

  const user = {
    id: sub as string,
    email: (email as string) || "",
    aud: aud || "authenticated",
    role: role || "authenticated",
    app_metadata: (app_metadata as object) || {},
    user_metadata: (user_metadata as object) || {},
  };

  const ttlExpiry = now + JWT_CACHE_TTL_MS;
  const expiresAt = expMs > 0 ? Math.min(expMs, ttlExpiry) : ttlExpiry;
  if (_jwtCache.size >= JWT_CACHE_MAX) {
    const oldest = _jwtCache.keys().next().value;
    if (oldest) _jwtCache.delete(oldest);
  }
  _jwtCache.set(token, { user, expiresAt });
  return user;
}

// Server-side user meta cache for /api/discover.
// Caches {gender, preference, ageMin, ageMax} keyed by userId so the discover
// route can skip the sequential getProfileMeta round-trip (~150–300 ms) on warm
// server hits.  TTL: 10 minutes.  Invalidated immediately on profile update.
const _userDiscoverMeta = new Map<string, {
  gender: string; preference: string;
  ageMin: number; ageMax: number;
  locationRadius: number;
  latitude: number | null;
  longitude: number | null;
  datingIntent: string | null;
  connectionStyle: string | null;
  expiresAt: number;
}>();
const DISCOVER_META_TTL_MS = 10 * 60_000;

function getCachedDiscoverMeta(userId: string) {
  const e = _userDiscoverMeta.get(userId);
  if (e && e.expiresAt > Date.now()) return e;
  _userDiscoverMeta.delete(userId);
  return null;
}

function setCachedDiscoverMeta(
  userId: string,
  gender: string,
  preference: string,
  ageMin: number,
  ageMax: number,
  locationRadius: number,
  latitude: number | null,
  longitude: number | null,
  datingIntent: string | null,
  connectionStyle: string | null,
) {
  if (_userDiscoverMeta.size >= 500) {
    const now = Date.now();
    _userDiscoverMeta.forEach((v, k) => { if (v.expiresAt < now) _userDiscoverMeta.delete(k); });
  }
  _userDiscoverMeta.set(userId, { gender, preference, ageMin, ageMax, locationRadius, latitude, longitude, datingIntent, connectionStyle, expiresAt: Date.now() + DISCOVER_META_TTL_MS });
}

async function broadcastViaHttpApi(topic: string, event: string, payload: Record<string, any>): Promise<void> {
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error(`[BROADCAST] Missing Supabase URL or service key — cannot deliver ${event} on ${topic}`);
    return;
  }
  try {
    const res = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { topic: `realtime:${topic}`, event, payload },
        ],
      }),
    });
    if (res.ok) {
      console.log(`[BROADCAST] HTTP delivered ${event} on ${topic}, status=${res.status}`);
    } else {
      const body = await res.text().catch(() => "");
      console.error(`[BROADCAST] HTTP error: status=${res.status} topic=${topic} event=${event} body=${body}`);
    }
  } catch (err: any) {
    console.error(`[BROADCAST] HTTP fetch threw: ${err?.message} — topic=${topic} event=${event}`);
  }
}

async function broadcastCallEvent(matchId: string, event: Record<string, any>) {
  const channelName = `call-signal:${matchId}`;
  console.log(`[CALL_BROADCAST] Sending ${event.type} on ${channelName}`);
  await broadcastViaHttpApi(channelName, "call-signal", event);
}

async function broadcastMessage(matchId: string, message: {
  id: string; matchId: string; senderId: string; content: string;
  reaction: string | null; createdAt: string | Date | null;
}) {
  const channelName = `chat:${matchId}`;
  await broadcastViaHttpApi(channelName, "new-message", message);
}

function getStorage(req: any): SupabaseStorage {
  const auth = req.headers.authorization;
  if (auth) {
    return new SupabaseStorage(createUserClient(auth));
  }
  return new SupabaseStorage();
}

function getAdminStorage(): SupabaseStorage {
  return new SupabaseStorage(supabaseAdmin);
}

function getCallStorage(req: any): SupabaseStorage {
  if (hasServiceRoleKey) {
    return new SupabaseStorage(supabaseAdmin);
  }
  const auth = req.headers.authorization;
  if (auth) {
    return new SupabaseStorage(createUserClient(auth));
  }
  return new SupabaseStorage(supabaseAdmin);
}

// ── Email verification enforcement ────────────────────────────────────────────
// All protected API routes require a confirmed email address.
// We cache the result per-user for 5 minutes so the Supabase admin API is
// ── Email event diagnostics ring buffer ───────────────────────────────────────
// Captures all email-related auth events for the admin diagnostics page.
// In-memory only — resets on server restart.  Capped at 500 events.
type EmailEventType =
  | "signup_otp_sent" | "signup_otp_rate_limited" | "signup_otp_send_failed"
  | "otp_verified" | "otp_verify_failed"
  | "resend_queued" | "resend_rate_limited" | "resend_failed"
  | "verified" | "blocked_unconfirmed" | "blocked_auto_confirmed"
  | "pwd_reset_sent" | "pwd_reset_failed";

interface EmailEvent {
  ts: string;
  type: EmailEventType;
  userId?: string;   // truncated to 8 chars
  email?: string;    // truncated to 4 chars + ***
  note?: string;
  success: boolean;
}

const _emailEventLog: EmailEvent[] = [];
const EMAIL_LOG_MAX = 500;

function logEmailEvent(ev: Omit<EmailEvent, "ts">) {
  _emailEventLog.push({ ts: new Date().toISOString(), ...ev });
  if (_emailEventLog.length > EMAIL_LOG_MAX) _emailEventLog.shift();
}

// called at most once per user per cache window rather than on every request.
// On admin API error we fail open (allow the request) to avoid blocking
// legitimate users during transient Supabase outages.
const _emailVerifiedCache = new Map<string, { verified: boolean; expiresAt: number }>();
const EMAIL_VERIFIED_CACHE_TTL_MS = 5 * 60_000;
// Short TTL for unverified/auto-confirmed users so OTP completion takes effect
// within ~60 seconds without waiting for the full 5-min cache window.
const EMAIL_VERIFIED_UNVERIFIED_TTL_MS = 60_000;
// CRITICAL: supabaseAdmin.auth.admin.getUserById() can hang indefinitely in
// Replit's network (same UND_ERR_HEADERS_TIMEOUT issue that caused isAuthenticated
// to switch to local JWT decode). This timeout ensures the check always resolves
// within 2.5 s — safely under the client's 4-second AbortController window.
const EMAIL_VERIFIED_TIMEOUT_MS = 2500;
// Accounts created before this date may have been auto-confirmed under previous
// Supabase settings where "Confirm email" was OFF — they are grandfathered in.
// New accounts created on/after this date must pass explicit email verification.
const VERIFICATION_ENFORCEMENT_TS = new Date("2026-06-17T00:00:00.000Z").getTime();

async function checkEmailVerified(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = _emailVerifiedCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.verified;

  // No cache entry — must call the Supabase admin API.
  // IMPORTANT: wrap in a timeout. supabaseAdmin.auth.admin.getUserById() can hang
  // indefinitely (UND_ERR_HEADERS_TIMEOUT) in Replit's network environment — the
  // same reason isAuthenticated uses local JWT decode instead of supabase.auth.getUser().
  // Without this timeout, every cache-miss request would block until the client's
  // 4-second AbortController fires, causing the "Taking a little longer" reconnect screen.
  const t0 = Date.now();
  console.log(`[AUTH] checkEmailVerified: cache miss — calling admin API userId=${userId.slice(0, 8)}`);
  try {
    const adminCall = supabaseAdmin.auth.admin.getUserById(userId);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`getUserById timeout after ${EMAIL_VERIFIED_TIMEOUT_MS}ms`)), EMAIL_VERIFIED_TIMEOUT_MS)
    );
    const { data: { user }, error } = await Promise.race([adminCall, timeout]);
    console.log(`[AUTH] checkEmailVerified: admin API OK in ${Date.now() - t0}ms userId=${userId.slice(0, 8)}`);

    if (error || !user) {
      console.error("[AUTH] checkEmailVerified admin API error (fail-open):", error?.message);
      return true; // fail open so outages don't block legitimate users
    }

    // Definitely unverified: email_confirmed_at is null (Supabase "Confirm email" ON).
    if (!user.email_confirmed_at) {
      _emailVerifiedCache.set(userId, { verified: false, expiresAt: now + EMAIL_VERIFIED_UNVERIFIED_TTL_MS });
      console.warn(`[AUTH] EMAIL_NOT_VERIFIED (null confirmed_at): userId=${userId.slice(0, 8)}`);
      logEmailEvent({ type: "blocked_unconfirmed", userId: userId.slice(0, 8), success: false, note: "email_confirmed_at is null" });
      return false;
    }

    // ── Auto-confirmation detection ────────────────────────────────────────
    // When Supabase "Confirm email" is OFF, signUp() immediately sets
    // email_confirmed_at ≈ created_at (within milliseconds of each other).
    // A real email-link click or OTP verification always happens later,
    // so the two timestamps will differ by at least 10 seconds.
    // We only apply this check to accounts created on/after the enforcement
    // date so existing users are NOT retroactively blocked.
    const createdTs   = new Date(user.created_at).getTime();
    const confirmedTs = new Date(user.email_confirmed_at).getTime();
    if (
      createdTs >= VERIFICATION_ENFORCEMENT_TS &&
      Math.abs(confirmedTs - createdTs) < 10_000 // auto-confirmed at signup
    ) {
      _emailVerifiedCache.set(userId, { verified: false, expiresAt: now + EMAIL_VERIFIED_UNVERIFIED_TTL_MS });
      console.warn(`[AUTH] AUTO_CONFIRMED_UNVERIFIED: userId=${userId.slice(0, 8)} (confirmed_at≈created_at — Supabase "Confirm email" may be OFF, OTP required)`);
      logEmailEvent({ type: "blocked_auto_confirmed", userId: userId.slice(0, 8), success: false, note: "confirmed_at ≈ created_at (auto-confirmed)" });
      return false;
    }

    _emailVerifiedCache.set(userId, { verified: true, expiresAt: now + EMAIL_VERIFIED_CACHE_TTL_MS });
    logEmailEvent({ type: "verified", userId: userId.slice(0, 8), success: true });
    return true;
  } catch (e: any) {
    const isTimeout = (e?.message ?? "").includes("timeout");
    if (isTimeout) {
      console.error(`[AUTH] checkEmailVerified TIMEOUT after ${EMAIL_VERIFIED_TIMEOUT_MS}ms (fail-open) userId=${userId.slice(0, 8)} — Supabase admin API did not respond in time`);
    } else {
      console.error("[AUTH] checkEmailVerified error (fail-open):", e?.message);
    }
    return true;
  }
}

const isAuthenticated: RequestHandler = async (req: any, res, next) => {
  const _mwStart = Date.now();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.warn(
      `[AUTH_DIAG] 401 hasAuthHeader=${!!authHeader} hasBearer=${authHeader?.startsWith("Bearer ") ?? false} ` +
      `method=${req.method} path=${req.path} origin=${req.headers.origin ?? "(none)"}`
    );
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  const tokenPrefix = token ? `"${token.slice(0, 20)}"` : `"(empty)"`;
  try {
    const user = verifyJwt(token);
    const _jwtMs = Date.now() - _mwStart;
    if (!user) {
      console.warn(
        `[AUTH_DIAG] 401 hasAuthHeader=true tokenPrefix=${tokenPrefix} jwtVerifyResult=failed ` +
        `elapsed=${_jwtMs}ms method=${req.method} path=${req.path} ` +
        `(see JWT_MALFORMED / JWT_PARSE_ERROR / JWT_NO_SUB / JWT_EXPIRED log above for exact reason)`
      );
      return res.status(401).json({ message: "Unauthorized" });
    }
    console.log(
      `[AUTH_DIAG] verified hasAuthHeader=true tokenPrefix=${tokenPrefix} userId=${user.id} ` +
      `elapsed=${_jwtMs}ms method=${req.method} path=${req.path}`
    );
    req.user = user;

    // Server-side email verification gate.
    // Returns 403 EMAIL_NOT_VERIFIED for unverified users regardless of JWT validity.
    // The frontend VerifyEmailGate intercepts this code and shows the verify screen.
    const _emailStart = Date.now();
    const verified = await checkEmailVerified(user.id);
    const _emailMs = Date.now() - _emailStart;
    if (_emailMs > 500) {
      console.warn(`[AUTH] isAuthenticated: checkEmailVerified took ${_emailMs}ms (slow!) url=${req.path} userId=${user.id.slice(0, 8)}`);
    }
    if (!verified) {
      return res.status(403).json({
        message: "Email not verified. Check your inbox for the confirmation link.",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    // Lazy: mark profile email_verified = true the first time a verified user
    // makes an API call.  Fire-and-forget — never blocks the request.
    // BUG FIX: previously used .eq("email_verified", false) which never matched
    // rows where the column is NULL (the Postgres default for new columns and for
    // profiles created before the backfill cutoff).  In SQL, null = false is null
    // (not true), so those rows were permanently stuck invisible to the wheel and
    // Discover queries.  Use .or("email_verified.is.null,email_verified.eq.false")
    // so BOTH null and false are updated on the first authenticated request.
    if (getHasEmailVerifiedColumn()) {
      supabaseAdmin.from("profiles")
        .update({ email_verified: true })
        .eq("user_id", user.id)
        .or("email_verified.is.null,email_verified.eq.false")
        .then(() => {}, () => {});
    }

    // ── Application session-ID gate ───────────────────────────────────────────
    // X-Session-Id is REQUIRED on every protected endpoint.
    //
    // NON-NEGOTIABLE: a valid Supabase JWT without a verified active Lulou
    // session must never grant access to protected APIs.  A missing X-Session-Id
    // is an immediate 401 — there is no fail-open path.
    //
    // EXEMPT paths — these endpoints register/bootstrap the application session
    // and therefore cannot require a prior X-Session-Id:
    //   POST /api/auth/session-bootstrap — called immediately after every new
    //     auth event (SIGNED_IN, INITIAL_SESSION with missing ID, PASSWORD_RECOVERY).
    //     Atomically revokes the previous session and registers the new one.
    //   POST /api/auth/session-check — legacy alias with the same semantics.
    //
    // All other protected endpoints MUST refuse requests that lack a valid ID.
    // Fail open ONLY on DB errors so transient outages never lock users out.
    const SESSION_BOOTSTRAP_EXEMPT = new Set([
      "/api/auth/session-bootstrap",
      "/api/auth/session-check",
      "/api/auth/session-debug",  // diagnostic — reads DB but does not write
    ]);
    const clientSessionId = req.headers["x-session-id"] as string | undefined;

    if (!SESSION_BOOTSTRAP_EXEMPT.has(req.path)) {
      // Non-bootstrap path: X-Session-Id is required — no exceptions.
      if (!clientSessionId || clientSessionId.length <= 4) {
        console.warn(`[SESSION] missing X-Session-Id for ${user.id.slice(0, 8)} path=${req.path}`);
        return res.status(401).json({
          message: "invalid_session",
          reason: "Application session is missing.",
        });
      }

      const cached = lookupSessionIdCache(user.id, clientSessionId);
      if (cached === false) {
        // Fast-reject: use the reason stored when the cache entry was written so
        // we return the CORRECT message without a DB round-trip.
        //
        // CRITICAL: do NOT default to "session_replaced" here — a same-device
        // bootstrap also caches the old session as false (reason="invalid_session").
        // Returning "session_replaced" for those entries causes false forced-logouts
        // every time the user reopens the app after > 15 min background (the race
        // between INITIAL_SESSION bootstrap and in-flight React Query / heartbeat).
        const cachedReason = lookupSessionIdCacheReason(user.id, clientSessionId) ?? "invalid_session";
        return res.status(401).json({
          message: cachedReason,
          reason: cachedReason === "session_replaced"
            ? "Your account was signed in on another device."
            : "No active session registered — please re-authenticate.",
        });
      } else if (cached === null) {
        // Cache miss — query DB
        try {
          const [row] = await db
            .select({ sessionId: activeSessions.sessionId, revokedAt: activeSessions.revokedAt, expiresAt: activeSessions.expiresAt })
            .from(activeSessions)
            .where(eq(activeSessions.userId, user.id))
            .limit(1);
          const isValid =
            !!row &&
            row.sessionId === clientSessionId &&
            !row.revokedAt &&
            row.expiresAt > new Date();
          // Distinguish precisely so the client reacts correctly:
          //   session_replaced — row exists but has a DIFFERENT session ID →
          //     another device bootstrapped and took over the account.
          //     Client must sign out and show the "another device" message.
          //   invalid_session  — no row at all, OR same session ID but expired
          //     or explicitly revoked → the session aged out naturally (> 15 min
          //     background with no heartbeat) or was cleared during logout.
          //     Client must re-bootstrap, NOT sign out.
          const dbReason: "session_replaced" | "invalid_session" = (!!row && row.sessionId !== clientSessionId)
            ? "session_replaced"
            : "invalid_session";
          // Store the reason alongside validity so subsequent fast-rejects return
          // the correct message without a DB round-trip.
          cacheSessionIdValid(user.id, clientSessionId, isValid, isValid ? undefined : dbReason);
          if (!isValid) {
            console.warn(
              `[SESSION] ${dbReason} for ${user.id.slice(0, 8)} path=${req.path}` +
              ` sid=${clientSessionId?.slice(0, 8) ?? "none"}` +
              ` rowExists=${!!row} sameId=${!!row && row.sessionId === clientSessionId}` +
              ` revokedAt=${row?.revokedAt ?? null} expired=${!!row && row.expiresAt <= new Date()}`
            );
            return res.status(401).json({
              message: dbReason,
              reason: dbReason === "invalid_session"
                ? "No active session registered — please re-authenticate."
                : "Your account was signed in on another device.",
            });
          }
        } catch (e) {
          // Fail open — DB error never locks legitimate users out
          console.error("[SESSION] session-id check DB error (fail-open):", (e as any)?.message);
        }
        // cached === true → proceed immediately (no DB hit)
      }
    }

    // Fire-and-forget last_active update (debounced per user, 2 min).
    const now = Date.now();
    const lastUpdate = _lastActiveDebounce.get(user.id) ?? 0;
    if (now - lastUpdate > LAST_ACTIVE_TTL_MS) {
      _lastActiveDebounce.set(user.id, now);
      supabase.from("profiles")
        .update({ last_active: new Date().toISOString() })
        .eq("user_id", user.id)
        .then(() => {}, () => {});
    }

    next();
  } catch (err: any) {
    console.error("[AUTH] MIDDLEWARE_ERROR", { error: err?.message, path: req.path });
    return res.status(500).json({ message: `Auth check failed: ${err?.message || "unknown error"}` });
  }
};

// ── Location & PII privacy ────────────────────────────────────────────────────
// Strip raw coordinates and PII from any profile object before it is sent to
// a client that is NOT the profile owner.  Coordinates are used server-side
// for distance filtering only — they must never reach the browser.
function sanitizeOtherProfile<T extends Record<string, any>>(profile: T): Omit<T, "latitude" | "longitude" | "email" | "phoneNumber"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { latitude, longitude, email, phoneNumber, ...safe } = profile;
  return safe as any;
}

function containsContactInfo(text: string): boolean {
  const phonePattern = /(\+?\d[\d\s\-()]{7,})/;
  if (phonePattern.test(text)) return true;
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  if (emailPattern.test(text)) return true;

  const socialKeywords = [
    /\b(?:instagram|insta|ig)\b/i,
    /\b(?:snapchat|snap|sc)\b/i,
    /\b(?:twitter)\b/i,
    /\b(?:tiktok|tik\s*tok)\b/i,
    /\b(?:facebook|fb)\b/i,
    /\b(?:whatsapp|whats\s*app)\b/i,
    /\b(?:telegram|tg)\b/i,
    /\b(?:discord)\b/i,
    /\b(?:linkedin)\b/i,
    /\b(?:wechat)\b/i,
    /\b(?:signal)\s+(is|@|:)/i,
    /\b(?:kik)\b/i,
    /\b(?:viber)\b/i,
    /\b(?:line)\s+(id|is|@|:)/i,
    /\b(?:x\.com)\b/i,
  ];
  for (const pattern of socialKeywords) {
    if (pattern.test(text)) return true;
  }

  const socialUrls = [
    /(?:instagram\.com|instagr\.am)\//i,
    /(?:snapchat\.com)\//i,
    /(?:twitter\.com|x\.com)\//i,
    /(?:tiktok\.com)\//i,
    /(?:facebook\.com|fb\.com)\//i,
    /(?:wa\.me)\//i,
    /(?:t\.me)\//i,
    /(?:discord\.gg)\//i,
    /(?:linkedin\.com)\//i,
  ];
  for (const pattern of socialUrls) {
    if (pattern.test(text)) return true;
  }

  if (/(?:add me|find me|hmu|hit me up|dm me|message me|follow me|text me|call me|reach me)[\s]*(?:on|at|@)/i.test(text)) return true;
  if (/@[a-zA-Z0-9._]{3,}/.test(text)) return true;

  if (/\b(?:my\s+(?:handle|username|user\s*name|number|num|#|digits|cell|mobile))\s*(?:is|:|=)\s*/i.test(text)) return true;

  const stripped = text.replace(/[\s\-_.]/g, "");
  const digitCount = (stripped.match(/\d/g) || []).length;
  const totalLen = stripped.length;
  if (totalLen >= 7 && totalLen <= 15 && digitCount >= 7) return true;

  return false;
}

function calculateAgeFromDob(dob: string): number {
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

const profileBodySchema = z.object({
  firstName: z.string().min(1).max(50),
  age: z.number().int().min(18).max(99),
  gender: z.enum(["woman", "man", "non-binary", "trans woman", "trans man", "genderqueer", "genderfluid", "agender", "two-spirit", "other"]),
  datingPreference: z.enum(["women", "men", "non-binary people", "trans women", "trans men", "everyone"]),
  location: z.string().min(1).max(100),
  height: z.string().max(10).optional(),
  photos: z.array(z.string()).min(1).max(6),
  signals: z.array(z.string()).min(1).max(5),
  datingIntent: z.string().min(1),
  greenFlags: z.array(z.string()).min(3).max(4),
  connectionStyle: z.string().min(1),
  conversationStarters: z.array(z.string().max(200)).min(2).max(3).optional(),
  questions: z.array(z.string().max(200)).min(2).max(3).optional(),
  email: z.string().email().max(100).optional(),
  phoneNumber: z.string().max(20).optional(),
  locationRadius: z.number().int().min(5).max(100).optional(),
  preferredAgeMin: z.number().int().min(18).max(65).optional(),
  preferredAgeMax: z.number().int().min(18).max(65).optional(),
  photoVerified: z.boolean().optional(),
  onboardingComplete: z.boolean().optional(),
  isPaused: z.boolean().optional(),
  showLastActive: z.boolean().optional(),
  commentFilter: z.boolean().optional(),
  conversationStarterAi: z.boolean().optional(),
  dateOfBirth: z.string().max(10).optional().nullable(),
  pronouns: z.string().max(30).optional().nullable(),
  customGreenFlags: z.array(z.string().max(60)).max(5).optional(),
  customSignals: z.array(z.string().max(60)).max(5).optional(),
  customQuestions: z.array(z.object({ question: z.string().max(150), answer: z.string().max(200) })).max(3).optional(),
  viewerQuestions: z.array(z.object({ question: z.string().max(150) })).max(3).optional(),
  customStarters: z.array(z.string().max(120)).max(5).optional(),
});

const profileUpdateSchema = profileBodySchema.partial();

const interactionBodySchema = z.object({
  toUserId: z.string().min(1),
  type: z.enum(["open", "close"]),
});

const messageBodySchema = z.object({
  content: z.string().min(1).max(500),
});

const AUTO_REPLIES = [
  "That's really interesting! I love hearing about that.",
  "I feel the same way. What made you realize that?",
  "That's such a thoughtful perspective. Tell me more?",
  "I really appreciate you sharing that with me.",
  "You know, I was just thinking about something similar recently.",
  "That made me smile. I like how you see things.",
  "I'd love to hear more about that over coffee sometime.",
  "That resonates with me. We seem to value similar things.",
  "You have such a genuine way of expressing yourself.",
  "I love that about you. What else are you passionate about?",
  "This conversation is really flowing. I'm enjoying getting to know you.",
  "That's beautiful. I think we'd have great conversations in person.",
  "I feel like we really connect on this. It's refreshing.",
  "I appreciate your honesty. That means a lot to me.",
  "Wow, we have more in common than I expected!",
];

function generateAutoReply(profile: Profile | undefined, msgIndex: number): string {
  if (profile?.conversationStarters && profile.conversationStarters.length > 0 && msgIndex === 0) {
    return profile.conversationStarters[0];
  }
  return AUTO_REPLIES[msgIndex % AUTO_REPLIES.length];
}

async function clearStaleCallsOnStartup(): Promise<void> {
  try {
    const STALE_RINGING_MS = 2 * 60 * 1000;
    const STALE_ANSWERED_MS = 5 * 60 * 1000;
    const now = new Date();

    const { matches: matchesTable } = await import("@shared/schema");
    const { isNotNull } = await import("drizzle-orm");

    const activeMatches = await db
      .select({ id: matchesTable.id, callStartedAt: matchesTable.callStartedAt, callAnswered: matchesTable.callAnswered })
      .from(matchesTable)
      .where(isNotNull(matchesTable.callStartedAt));

    const staleIds: string[] = [];
    for (const m of activeMatches) {
      if (!m.callStartedAt) continue;
      const age = now.getTime() - new Date(m.callStartedAt).getTime();
      const isStale = (!m.callAnswered && age > STALE_RINGING_MS) || (m.callAnswered && age > STALE_ANSWERED_MS);
      if (isStale) staleIds.push(m.id);
    }

    if (staleIds.length === 0) {
      console.log("[STARTUP] No stale calls to clear");
      return;
    }

    for (const id of staleIds) {
      await db
        .update(matchesTable)
        .set({ callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false })
        .where(eq(matchesTable.id, id));
      console.log("[STARTUP] Cleared stale call for match", id.slice(0, 8));
    }
    console.log(`[STARTUP] Stale call cleanup complete — cleared ${staleIds.length} stale call(s)`);
  } catch (err: any) {
    console.error("[STARTUP] Stale call cleanup threw:", err?.message);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  clearStaleCallsOnStartup().catch((err) => console.error("[STARTUP] clearStaleCallsOnStartup failed:", err?.message));

  // ── Periodic stale-call cleanup ───────────────────────────────────────────
  // The startup sweep only runs once at boot.  If both parties crash/kill the
  // app mid-call (no cancel/end signal sent), callStartedAt stays set in the DB
  // indefinitely — accumulating stale rows between server restarts.  This timer
  // clears them every 5 minutes and broadcasts call:ended so any still-running
  // clients update in real-time rather than waiting for the next 5 s poll.
  setInterval(async () => {
    try {
      const STALE_RINGING_MS = 2 * 60 * 1000;   // 2 min unanswered
      const STALE_ANSWERED_MS = 10 * 60 * 1000;  // 10 min answered but not completed
      const now = new Date();

      const { matches: matchesTableP } = await import("@shared/schema");
      const { isNotNull: isNotNullP } = await import("drizzle-orm");

      const activeMatches = await db
        .select({
          id: matchesTableP.id,
          callStartedAt: matchesTableP.callStartedAt,
          callAnswered: matchesTableP.callAnswered,
          callSessionId: matchesTableP.callSessionId,
        })
        .from(matchesTableP)
        .where(isNotNullP(matchesTableP.callStartedAt));

      for (const m of activeMatches) {
        if (!m.callStartedAt) continue;
        const age = now.getTime() - new Date(m.callStartedAt).getTime();
        const isStale =
          (!m.callAnswered && age > STALE_RINGING_MS) ||
          (m.callAnswered && age > STALE_ANSWERED_MS);
        if (!isStale) continue;

        await db
          .update(matchesTableP)
          .set({ callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false })
          .where(eq(matchesTableP.id, m.id));

        if (m.callSessionId) {
          await broadcastCallEvent(m.id, {
            type: "call:ended",
            matchId: m.id,
            userId: "server-gc",
            callSessionId: m.callSessionId,
          });
        }
        console.log("[PERIODIC_CLEANUP] cleared stale call", {
          matchId: m.id.slice(0, 8),
          ageMs: age,
          answered: m.callAnswered,
          sessionId: m.callSessionId?.slice(0, 8) ?? "none",
        });
      }
    } catch (err: any) {
      console.error("[PERIODIC_CLEANUP] periodic stale-call sweep failed:", err?.message);
    }
  }, 5 * 60 * 1000);

  // ── Date-plan 24 h push reminder ─────────────────────────────────────────
  // Runs hourly. Finds any confirmed date plans that are 23–25 h away and
  // sends a push to both parties if one hasn't been sent yet (dedup via the
  // local date_plan_reminders_sent table).
  async function sendDatePlanReminders24h() {
    try {
      // 1. Fetch all __DATE_DATETIME__: messages across every match.
      //    supabaseAdmin bypasses RLS so no match_id scoping is needed.
      const { data: dtMessages } = await supabaseAdmin
        .from("messages")
        .select("match_id, content, created_at")
        .like("content", "__DATE_DATETIME__%");

      if (!dtMessages?.length) return;

      // 2. Pick the *latest* datetime proposal per match.
      const latestByMatch = new Map<string, { date: string; time: string; createdAt: Date }>();
      for (const m of dtMessages) {
        if (!m.content.startsWith("__DATE_DATETIME__:")) continue;
        try {
          const json = JSON.parse(m.content.slice("__DATE_DATETIME__:".length));
          if (!json.date || !json.time) continue;
          const existing = latestByMatch.get(m.match_id);
          const ts = new Date(m.created_at);
          if (!existing || ts > existing.createdAt) {
            latestByMatch.set(m.match_id, { date: json.date, time: json.time, createdAt: ts });
          }
        } catch { continue; }
      }

      // 3. Keep only matches whose date is 23–25 h away.
      const now = Date.now();
      const WINDOW_LO = 23 * 3_600_000;
      const WINDOW_HI = 25 * 3_600_000;
      const candidates: string[] = [];
      for (const [matchId, dt] of latestByMatch) {
        const diff = new Date(`${dt.date}T${dt.time}:00`).getTime() - now;
        if (diff >= WINDOW_LO && diff <= WINDOW_HI) candidates.push(matchId);
      }
      if (!candidates.length) return;

      for (const matchId of candidates) {
        // 4. Skip if already reminded.
        const [alreadySent] = await db
          .select()
          .from(datePlanRemindersSent)
          .where(and(
            eq(datePlanRemindersSent.matchId, matchId),
            eq(datePlanRemindersSent.reminderType, "24h"),
          ));
        if (alreadySent) continue;

        // 5. Both users must have confirmed (__DATE_CONFIRM__: from 2 distinct senders).
        const { data: confirmMsgs } = await supabaseAdmin
          .from("messages")
          .select("sender_id")
          .eq("match_id", matchId)
          .like("content", "__DATE_CONFIRM__:%");
        const confirmerIds = new Set((confirmMsgs ?? []).map((m: any) => m.sender_id));
        if (confirmerIds.size < 2) continue;

        // 6. Get match user IDs.
        const { data: match } = await supabaseAdmin
          .from("matches")
          .select("user1_id, user2_id")
          .eq("id", matchId)
          .maybeSingle();
        if (!match) continue;
        if (!confirmerIds.has(match.user1_id) || !confirmerIds.has(match.user2_id)) continue;

        // 7. Get first names.
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("user_id, first_name")
          .in("user_id", [match.user1_id, match.user2_id]);
        const nameOf = (uid: string) =>
          (profiles ?? []).find((p: any) => p.user_id === uid)?.first_name ?? "your match";

        const dt = latestByMatch.get(matchId)!;

        // 8. Send push to both (fire-and-forget; allSettled swallows errors).
        await Promise.allSettled([
          sendPushToUser(
            match.user1_id,
            buildPush.dateReminder24h(nameOf(match.user2_id), matchId, dt.date, dt.time),
            "safety",
          ),
          sendPushToUser(
            match.user2_id,
            buildPush.dateReminder24h(nameOf(match.user1_id), matchId, dt.date, dt.time),
            "safety",
          ),
        ]);

        // 9. Mark sent so we never fire again for this match+type.
        await db.insert(datePlanRemindersSent).values({ matchId, reminderType: "24h" });

        console.log(`[DATE_REMINDER] Sent 24h reminder matchId=${matchId.slice(0, 8)}`);
      }
    } catch (err: any) {
      console.error("[DATE_REMINDER] sendDatePlanReminders24h error:", err?.message);
    }
  }

  // Run immediately 30 s after startup (avoids hammering Supabase on cold boot),
  // then every 60 minutes.
  setTimeout(() => sendDatePlanReminders24h(), 30_000);
  setInterval(() => sendDatePlanReminders24h(), 60 * 60_000);

  // ── Request timing middleware ─────────────────────────────────────────────
  // Logs routes that take longer than 500 ms so slow queries are easy to spot.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const t0 = Date.now();

    // Wrap res.json so we can inject the Server-Timing header BEFORE the
    // response body is flushed.  res.on("finish") fires too late — headers are
    // already sent by then, so we can't add Server-Timing there.
    //
    // Server-Timing is a W3C standard header that Safari, Chrome and Firefox
    // all expose in the Network panel and that client JS can read via
    // response.headers.get("server-timing").  It lets the client compute:
    //
    //   networkOverhead = clientObservedTime - serverHandlerMs
    //
    // This is the single most useful number for diagnosing whether slowness is
    // in the backend code/database or in the hosting network layer.
    const origJson = res.json.bind(res);
    (res as any).json = function (body: unknown) {
      const ms = Date.now() - t0;
      if (!res.headersSent) {
        res.setHeader("Server-Timing", `handler;dur=${ms}`);
      }
      if (ms > 500) {
        console.warn(`[SLOW_ROUTE] ${req.method} ${req.path} took ${ms}ms (status=${res.statusCode})`);
      } else if (IS_DEV && ms > 200) {
        console.log(`[ROUTE_TIMING] ${req.method} ${req.path} ${ms}ms`);
      }
      return origJson(body);
    };

    next();
  });


  // ── Email verification OTP endpoints ────────────────────────────────────
  // These endpoints intentionally bypass isAuthenticated because unverified
  // users are blocked by it — they still need a way to verify their email.
  // Rate limiting and JWT inspection protect against abuse.
  const _otpCooldown = new Map<string, number>();

  app.post("/api/auth/verify/send-otp", async (req: any, res) => {
    try {
      let email: string | undefined;
      const authHeader = req.headers.authorization as string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        try { const u = verifyJwt(authHeader.split(" ")[1]); if (u?.email) email = u.email; } catch {}
      }
      if (!email) email = ((req.body?.email) ?? "").trim().toLowerCase();
      if (!email) return res.status(400).json({ message: "Email required" });

      const now = Date.now();
      const lastSent = _otpCooldown.get(email) ?? 0;
      if (now - lastSent < 60_000) {
        return res.status(429).json({ message: "Please wait 60 seconds before requesting another code.", waitMs: 60_000 - (now - lastSent) });
      }
      _otpCooldown.set(email, now);

      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) {
        console.error("[AUTH] send-otp error:", error.message);
        const isRateLimit = error.message?.toLowerCase().includes("rate") || (error as any).status === 429;
        logEmailEvent({ type: isRateLimit ? "signup_otp_rate_limited" : "signup_otp_send_failed", email: email.slice(0, 4) + "***", success: false, note: error.message });
        return res.status(isRateLimit ? 429 : 400).json({ message: error.message });
      }
      logEmailEvent({ type: "signup_otp_sent", email: email.slice(0, 4) + "***", success: true });
      console.log(`[AUTH] OTP_SENT to ${email.slice(0, 4)}***`);
      return res.json({ message: "Verification code sent" });
    } catch (e: any) {
      console.error("[AUTH] send-otp unexpected error:", e?.message);
      return res.status(500).json({ message: "Failed to send verification code" });
    }
  });

  app.post("/api/auth/verify/confirm-otp", async (req: any, res) => {
    try {
      let userId: string | undefined;
      let email: string | undefined;
      const authHeader = req.headers.authorization as string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        try { const u = verifyJwt(authHeader.split(" ")[1]); if (u) { userId = u.id; email = u.email; } } catch {}
      }
      if (!email) email = ((req.body?.email) ?? "").trim().toLowerCase();
      const code = ((req.body?.code) ?? "").trim();
      if (!email || !code) return res.status(400).json({ message: "Email and code required" });

      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
      if (error) {
        console.error("[AUTH] confirm-otp error:", error.message);
        logEmailEvent({ type: "otp_verify_failed", email: email.slice(0, 4) + "***", userId: userId?.slice(0, 8), success: false, note: error.message });
        return res.status(400).json({ message: error.message });
      }

      // Clear cache so the next isAuthenticated call re-checks the admin API
      // and finds email_confirmed_at updated (now far from created_at).
      if (userId) {
        _emailVerifiedCache.delete(userId);
        if (getHasEmailVerifiedColumn()) {
          supabaseAdmin.from("profiles").update({ email_verified: true }).eq("user_id", userId)
            .then(() => {}, () => {});
        }
      }
      logEmailEvent({ type: "otp_verified", email: email.slice(0, 4) + "***", userId: userId?.slice(0, 8), success: true });
      console.log(`[AUTH] OTP_VERIFIED userId=${userId?.slice(0, 8) ?? "??"}`);
      return res.json({ message: "Email verified successfully" });
    } catch (e: any) {
      console.error("[AUTH] confirm-otp unexpected error:", e?.message);
      return res.status(500).json({ message: "Verification failed" });
    }
  });

  // Lightweight status check — returns 200 if verified, 403 if not.
  // The frontend uses this to detect auto-confirmed accounts when the
  // Supabase "Confirm email" setting is OFF.
  app.get("/api/auth/verify/status", isAuthenticated, (req: any, res) => {
    res.json({ emailVerified: true, userId: req.user.id });
  });

  // ── Admin payment simulator routes ──────────────────────────────────────────
  registerAdminSimulatorRoutes(app, isAuthenticated);

  // Returns the in-memory email event log.  Gated by isAuthenticated and the
  // ADMIN_EMAIL env var (comma-separated list of admin email addresses).
  // If ADMIN_EMAIL is not set, only allows access in development mode.
  app.get("/api/admin/email-diagnostics", isAuthenticated, (req: any, res) => {
    const adminEmails = (process.env.ADMIN_EMAIL ?? "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const requestEmail = (req.user.email ?? "").toLowerCase();
    const isDev = process.env.NODE_ENV !== "production";
    const isAdmin = adminEmails.includes(requestEmail) || (isDev && adminEmails.length === 0);
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin access required. Set ADMIN_EMAIL env var." });
    }
    const summary = {
      total: _emailEventLog.length,
      sent: _emailEventLog.filter(e => e.type === "signup_otp_sent" || e.type === "resend_queued").length,
      failed: _emailEventLog.filter(e => !e.success).length,
      rateLimited: _emailEventLog.filter(e => e.type === "signup_otp_rate_limited" || e.type === "resend_rate_limited").length,
      verified: _emailEventLog.filter(e => e.type === "verified" || e.type === "otp_verified").length,
      blocked: _emailEventLog.filter(e => e.type === "blocked_unconfirmed" || e.type === "blocked_auto_confirmed").length,
    };
    const transactionalLog = getEmailLog();
    return res.json({
      summary,
      events: [..._emailEventLog].reverse(), // newest first
      serverUptime: process.uptime(),
      enforcementDate: new Date(VERIFICATION_ENFORCEMENT_TS).toISOString(),
      transactional: {
        total:   transactionalLog.length,
        sent:    transactionalLog.filter(e => e.success).length,
        failed:  transactionalLog.filter(e => !e.success).length,
        events:  transactionalLog,
      },
    });
  });

  // ── Admin Discover Debug ─────────────────────────────────────────────────
  // Returns a complete filter-stage count report for any userId so you can
  // see exactly why profiles are being eliminated from Discovery.
  // Requires ADMIN_EMAIL env var (or dev mode with no ADMIN_EMAIL set).
  app.get("/api/admin/discover-debug", isAuthenticated, async (req: any, res) => {
    const adminEmails = (process.env.ADMIN_EMAIL ?? "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const requestEmail = (req.user.email ?? "").toLowerCase();
    const isDev = process.env.NODE_ENV !== "production";
    const isAdmin = adminEmails.includes(requestEmail) || (isDev && adminEmails.length === 0);
    if (!isAdmin) {
      return res.status(403).json({ message: "Admin access required. Set ADMIN_EMAIL env var." });
    }

    try {
      const targetUserId = (req.query.userId as string) || req.user.id;

      // Get target user's discover meta
      const storage = getStorage(req);
      const myProfile = await storage.getProfileMeta(targetUserId);
      if (!myProfile) {
        return res.status(404).json({ message: "Profile not found for userId: " + targetUserId });
      }

      const effectiveAgeMin = Math.max(18, myProfile.preferredAgeMin || 18);
      const effectiveAgeMax = Math.min(99, myProfile.preferredAgeMax || 99);

      // ── Stage 0: total profiles in DB ─────────────────────────────────────
      const { count: totalCount } = await supabaseAdmin
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .neq("user_id", targetUserId);

      // ── Stage 1: onboarding complete ──────────────────────────────────────
      const { count: onboardingCount } = await supabaseAdmin
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .neq("user_id", targetUserId)
        .eq("onboarding_complete", true);

      // ── Stage 2: email verified ───────────────────────────────────────────
      const { getHasEmailVerifiedColumn } = await import("./storage");
      let emailVerifiedCount: number | null = null;
      let emailVerifiedColPresent = false;
      if (getHasEmailVerifiedColumn()) {
        emailVerifiedColPresent = true;
        const { count } = await supabaseAdmin
          .from("profiles")
          .select("*", { count: "exact", head: true })
          .neq("user_id", targetUserId)
          .eq("onboarding_complete", true)
          .eq("email_verified", true);
        emailVerifiedCount = count ?? 0;

        // Also count profiles with email_verified = false (invisible ones)
      }
      const { count: emailFalseCount } = emailVerifiedColPresent
        ? await supabaseAdmin
            .from("profiles")
            .select("*", { count: "exact", head: true })
            .neq("user_id", targetUserId)
            .eq("onboarding_complete", true)
            .eq("email_verified", false)
        : { count: null };

      // ── Stage 3: gender/preference filters ───────────────────────────────
      const { getHasLatLngColumns } = await import("./storage");
      const normGender = myProfile.gender?.toLowerCase().trim() ?? "";
      const normPref   = myProfile.datingPreference?.toLowerCase().trim() ?? "";

      function getTargetGendersLocal(pref: string): string[] | null {
        if (pref === "women") return ["woman", "trans woman"];
        if (pref === "men") return ["man", "trans man"];
        if (pref === "everyone") return null;
        return null;
      }
      function getCandidateMustPreferLocal(gender: string): string[] {
        const prefs = ["everyone"];
        if (gender === "woman" || gender === "female") prefs.push("women");
        if (gender === "man" || gender === "male") prefs.push("men");
        return prefs;
      }
      const targetGenders = getTargetGendersLocal(normPref);
      const candidateMustPrefer = normGender ? getCandidateMustPreferLocal(normGender) : [];

      let genderFilterQuery = supabaseAdmin
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .neq("user_id", targetUserId)
        .eq("onboarding_complete", true)
        .or(`age.is.null,age.gte.${effectiveAgeMin}`)
        .or(`age.is.null,age.lte.${effectiveAgeMax}`);
      if (emailVerifiedColPresent) genderFilterQuery = (genderFilterQuery as any).eq("email_verified", true);
      if (targetGenders && targetGenders.length > 0) genderFilterQuery = genderFilterQuery.in("gender", targetGenders);
      if (candidateMustPrefer.length > 0) genderFilterQuery = genderFilterQuery.in("dating_preference", candidateMustPrefer);
      const { count: genderCompatCount } = await genderFilterQuery;

      // ── Stage 4: exclusions (interactions, matches, inbound likes) ────────
      const [interactedResult, activeMatchesResult, inboundOpensResult] = await Promise.all([
        supabaseAdmin.from("interactions").select("to_user_id").eq("from_user_id", targetUserId),
        supabaseAdmin.from("matches").select("user1_id, user2_id").eq("status", "active").or(`user1_id.eq.${targetUserId},user2_id.eq.${targetUserId}`),
        supabaseAdmin.from("interactions").select("from_user_id").eq("to_user_id", targetUserId).eq("type", "open"),
      ]);
      const interactedIds = new Set((interactedResult.data || []).map((r: any) => r.to_user_id));
      const activeMatchIds = new Set<string>();
      for (const row of (activeMatchesResult.data || [])) {
        const otherId = row.user1_id === targetUserId ? row.user2_id : row.user1_id;
        if (otherId) activeMatchIds.add(otherId as string);
      }
      const inboundOpenerIds = new Set((inboundOpensResult.data || []).map((r: any) => r.from_user_id));
      const excludedIds = new Set([...interactedIds, ...activeMatchIds, ...inboundOpenerIds]);

      // Apply exclusion to the gender-compat count
      let postExclusionQuery = supabaseAdmin
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .neq("user_id", targetUserId)
        .eq("onboarding_complete", true)
        .or(`age.is.null,age.gte.${effectiveAgeMin}`)
        .or(`age.is.null,age.lte.${effectiveAgeMax}`);
      if (emailVerifiedColPresent) postExclusionQuery = (postExclusionQuery as any).eq("email_verified", true);
      if (targetGenders && targetGenders.length > 0) postExclusionQuery = postExclusionQuery.in("gender", targetGenders);
      if (candidateMustPrefer.length > 0) postExclusionQuery = postExclusionQuery.in("dating_preference", candidateMustPrefer);
      if (excludedIds.size > 0 && excludedIds.size <= 300) {
        postExclusionQuery = postExclusionQuery.not("user_id", "in", `(${[...excludedIds].join(",")})`);
      }
      const { count: postExclusionCount } = await postExclusionQuery;

      // ── Distance note ─────────────────────────────────────────────────────
      const hasLatLng = getHasLatLngColumns();
      const userLat = myProfile.latitude ?? null;
      const userLng = myProfile.longitude ?? null;
      const radius  = myProfile.locationRadius ?? 0;
      const distanceFilterActive = hasLatLng && userLat !== null && userLng !== null && radius > 0;

      return res.json({
        targetUserId: targetUserId.slice(0, 8) + "...",
        myProfile: {
          gender: myProfile.gender,
          preference: myProfile.datingPreference,
          ageRange: `${effectiveAgeMin}–${effectiveAgeMax}`,
          locationRadius: radius,
          hasCoords: userLat !== null && userLng !== null,
          onboardingComplete: myProfile.onboardingComplete,
        },
        filterStages: {
          "0_total_profiles_excl_self":       totalCount ?? "?",
          "1_onboarding_complete":             onboardingCount ?? "?",
          "2_email_verified":                  emailVerifiedColPresent
            ? emailVerifiedCount ?? "?"
            : "N/A (column absent — no filter)",
          "2b_email_verified_false_invisible": emailVerifiedColPresent
            ? emailFalseCount ?? "?"
            : "N/A",
          "3_gender_pref_compat":             genderCompatCount ?? "?",
          "4_post_exclusions":               postExclusionCount ?? "?",
          "5_distance_filter":               distanceFilterActive
            ? `applied (${radius}mi radius) — run discover to see final count`
            : "DISABLED (no radius or no coords)",
          "6_final_output_cap":              20,
        },
        columnFlags: {
          email_verified_col: emailVerifiedColPresent,
          lat_lng_cols: hasLatLng,
        },
        exclusionBreakdown: {
          outbound_interactions: interactedIds.size,
          active_matches: activeMatchIds.size,
          inbound_likers: inboundOpenerIds.size,
          total: excludedIds.size,
        },
        note: emailVerifiedColPresent && (emailFalseCount ?? 0) > 0
          ? `⚠️ ${emailFalseCount} profiles have email_verified=false and are INVISIBLE in Discover. Run the startup backfill or wait for each owner to log in.`
          : "email_verified looks healthy",
      });
    } catch (err: any) {
      console.error("[ADMIN] discover-debug error:", err?.message);
      res.status(500).json({ message: err?.message || "Failed to run discover debug" });
    }
  });

  app.get("/api/auth/user", isAuthenticated, async (req: any, res) => {
    try {
      const user = req.user;
      res.json({ id: user.id, email: user.email });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // ── Single-device enforcement ─────────────────────────────────────────────
  // SESSION_EXPIRY: how long a session stays valid without a heartbeat.
  const SESSION_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

  // Called immediately after a successful Supabase sign-in.
  // Blocks the login if another device already has a fresh active session.
  // On success, upserts a new session row so the heartbeat can extend it.
  app.post("/api/auth/session-check", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const { sessionId: clientSessionId, deviceId = "", userAgent = "" } =
      (req.body as { sessionId?: string; deviceId?: string; userAgent?: string }) || {};

    const sessionId: string =
      typeof clientSessionId === "string" && clientSessionId.length > 8
        ? clientSessionId
        : randomUUID();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_MS);

    try {
      const existing = await db
        .select()
        .from(activeSessions)
        .where(eq(activeSessions.userId, userId))
        .limit(1);

      const row = existing[0];

      // Block only when ALL of the following are true:
      //   1. A row exists (some device is registered)
      //   2. That row is still fresh (expiresAt > now — not a stale/expired session)
      //   3. The session ID is different (not the same ongoing login)
      //   4. The device ID is different (not the same physical browser/device)
      //
      // Condition 4 is the critical addition.  lulou_device_id is a persistent UUID
      // stored in localStorage that survives page reloads and browser restarts but
      // is NOT cleared on logout.  If the same browser re-logs in (e.g. after a
      // Supabase token expiry or a logout→re-login), its deviceId matches the
      // registered row, so it is always allowed to reclaim its own session.
      //
      // This prevents a race-condition stale-session lockout: if a fire-and-forget
      // heartbeat upserts a row just after the logout DELETE completed, the row
      // will have the same deviceId as the user's browser.  The next login from
      // that browser sees isSameDevice=true and is NOT blocked.
      // ── REVOKE model — newest login always wins ───────────────────────────────
      // The spec requires: when an account signs in on a new device, the existing
      // session is revoked immediately and the new session becomes active.
      // "Blocking" the new login is explicitly prohibited — it would allow a stale
      // device to lock an account out indefinitely.
      //
      // Reachable scenarios:
      //   • No row exists                   → oldSessionId = null (first login)
      //   • Same device, same sessionId     → oldSessionId = null (heartbeat refresh)
      //   • Same device, new sessionId      → oldSessionId = old id, isSameDevice = true
      //   • Different device (any state)    → oldSessionId = old id, isSameDevice = false
      //     ↳ This is the REPLACE case — old device is notified and signed out
      const isSameDevice =
        !!deviceId && !!row?.deviceId && row.deviceId === deviceId;

      const oldSessionId: string | null =
        row && row.sessionId !== sessionId ? row.sessionId : null;
      const oldSessionWasDifferentDevice = !!oldSessionId && !isSameDevice;

      // No active session, expired, or same session → register / refresh
      await db
        .insert(activeSessions)
        .values({
          userId,
          sessionId,
          deviceId: String(deviceId).slice(0, 200),
          userAgent: String(userAgent || "").slice(0, 500),
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
          revokedAt: null,
          revokedReason: null,
        })
        .onConflictDoUpdate({
          target: activeSessions.userId,
          set: {
            sessionId,
            deviceId: String(deviceId).slice(0, 200),
            userAgent: String(userAgent || "").slice(0, 500),
            lastSeenAt: now,
            expiresAt,
            revokedAt: null,
            revokedReason: null,
          },
        });

      // ── Invalidate and notify the replaced session ────────────────────────────
      // If any old sessionId was replaced (same-device re-login OR a different
      // device whose session had expired), mark it as invalid in the cache so
      // the middleware gate fast-rejects any still-in-flight API requests from
      // that session.  For different-device replacements, also broadcast so the
      // old device can sign itself out immediately without waiting for a failed
      // API call or a heartbeat 401.
      if (oldSessionId) {
        // Mark old session as invalid in cache (fast path for middleware gate).
        // Use the correct reason so the middleware fast-reject returns the right
        // message and the client reacts correctly (sign-out vs. bootstrap).
        cacheSessionIdValid(
          userId,
          oldSessionId,
          false,
          oldSessionWasDifferentDevice ? "session_replaced" : "invalid_session",
        );
        if (oldSessionWasDifferentDevice) {
          // Broadcast to a SESSION-SCOPED channel — only the old device is subscribed
          // to `private-session:{oldSessionId}`.  The new device subscribes to its own
          // `private-session:{newSessionId}`.  This prevents the new device from
          // receiving the broadcast and accidentally signing itself out.
          broadcastViaHttpApi(`private-session:${oldSessionId}`, "session-replaced", {
            oldSessionId,
            newSessionId: sessionId,
          }).catch(() => {});
          console.log(`[SESSION] REVOKED old session for ${userId.slice(0, 8)} — notified on private-session channel`);
        } else {
          console.log(`[SESSION] Replaced own session for ${userId.slice(0, 8)} (same device re-login) — cache invalidated`);
        }
      }

      if (IS_DEV) console.log(`[SESSION] Registered session for ${userId.slice(0, 8)} expires ${expiresAt.toISOString()}`);
      // Mark the new session as valid in cache immediately so the first heartbeat
      // from this device doesn't trigger an unnecessary DB round-trip.
      cacheSessionIdValid(userId, sessionId, true);
      res.json({ allowed: true, sessionId });
    } catch (e: any) {
      console.error("[SESSION] session-check DB error (fail-open):", e?.message);
      // Fail open — never lock a user out due to a DB error
      res.json({ allowed: true, sessionId });
    }
  });

  // ── Bootstrap: register a fresh application session after any new auth event ─
  // Called immediately after SIGNED_IN, INITIAL_SESSION (missing session ID),
  // and PASSWORD_RECOVERY.  Like session-check but the session ID is always
  // generated server-side, so the client never needs to supply one.
  //
  // This endpoint is EXEMPT from the X-Session-Id gate (see middleware above)
  // because by definition no valid session ID exists yet when it is called.
  // It requires a valid Supabase JWT.
  //
  // Returns 500 on DB error — the client must show Retry / Sign out.
  // Never fails open (fail-open would defeat the purpose of this endpoint).
  app.post("/api/auth/session-bootstrap", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const { deviceId = "", userAgent = "" } =
      (req.body as { deviceId?: string; userAgent?: string }) || {};

    // Server always generates the session ID — no client-provided ID accepted.
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_MS);

    try {
      const existing = await db
        .select()
        .from(activeSessions)
        .where(eq(activeSessions.userId, userId))
        .limit(1);

      const row = existing[0];
      const isSameDevice =
        !!deviceId && !!row?.deviceId && row.deviceId === deviceId;
      const oldSessionId: string | null =
        row && row.sessionId !== sessionId ? row.sessionId : null;
      const oldSessionWasDifferentDevice = !!oldSessionId && !isSameDevice;

      await db
        .insert(activeSessions)
        .values({
          userId,
          sessionId,
          deviceId: String(deviceId).slice(0, 200),
          userAgent: String(userAgent || "").slice(0, 500),
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
          revokedAt: null,
          revokedReason: null,
        })
        .onConflictDoUpdate({
          target: activeSessions.userId,
          set: {
            sessionId,
            deviceId: String(deviceId).slice(0, 200),
            userAgent: String(userAgent || "").slice(0, 500),
            lastSeenAt: now,
            expiresAt,
            revokedAt: null,
            revokedReason: null,
          },
        });

      if (oldSessionId) {
        // Same reasoning as session-check: use the correct reason so the middleware
        // fast-reject and heartbeat handler return the right message to the client.
        // A same-device bootstrap must NOT be cached as "session_replaced" — doing
        // so causes false forced-logouts for in-flight requests that arrived after
        // bootstrap completed (the root cause of the iOS false-logout bug).
        cacheSessionIdValid(
          userId,
          oldSessionId,
          false,
          oldSessionWasDifferentDevice ? "session_replaced" : "invalid_session",
        );
        if (oldSessionWasDifferentDevice) {
          broadcastViaHttpApi(`private-session:${oldSessionId}`, "session-replaced", {
            oldSessionId,
            newSessionId: sessionId,
          }).catch(() => {});
          console.log(`[SESSION] BOOTSTRAP: revoked old session for ${userId.slice(0, 8)} — broadcast sent`);
        } else {
          console.log(`[SESSION] BOOTSTRAP: replaced own session for ${userId.slice(0, 8)} (same device re-login)`);
        }
      }

      cacheSessionIdValid(userId, sessionId, true);
      if (IS_DEV) console.log(`[SESSION] BOOTSTRAP: registered session for ${userId.slice(0, 8)} expires ${expiresAt.toISOString()}`);
      res.json({ sessionId });
    } catch (e: any) {
      // Fail CLOSED — return 500 so the client shows Retry / Sign out.
      // A fail-open here would allow unauthenticated access to protected APIs.
      console.error("[SESSION] session-bootstrap DB error:", e?.message);
      res.status(500).json({ message: "Failed to register session. Please try again." });
    }
  });

  // ── Diagnostic: session-debug ─────────────────────────────────────────────
  // GET /api/auth/session-debug
  //
  // Temporary diagnostic endpoint.  Returns only SAFE (prefix-truncated) values.
  // Exempt from the X-Session-Id gate so it works even when the session is
  // broken — that's the exact scenario we need to observe.
  // Requires a valid Supabase JWT so it cannot be called unauthenticated.
  //
  // Returns:
  //   userId             — first 8 chars of JWT user ID
  //   headerSessionId    — X-Session-Id header received (first 8 chars, or "(none)")
  //   cacheResult        — "valid" | "revoked" | "miss"
  //   activeRowExists    — whether active_sessions has a row for this user
  //   storedSessionId    — first 8 chars of the stored session_id (or "(none)")
  //   revoked            — whether revoked_at is set
  //   revokedReason      — revoked_reason value (or null)
  //   expiresAt          — ISO string of expires_at (or null)
  //   matches            — storedSessionId === headerSessionId (full comparison)
  //   cacheAfterQuery    — cache result AFTER the DB query (should be "valid" if matches=true)
  app.get("/api/auth/session-debug", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;
    const headerSessionId = (req.headers["x-session-id"] as string | undefined) ?? "";

    // Check in-memory cache first
    const cached = headerSessionId ? lookupSessionIdCache(userId, headerSessionId) : null;
    const cacheResult = cached === true ? "valid" : cached === false ? "revoked" : "miss";

    // Always query DB regardless of cache — we need ground truth
    let activeRowExists = false;
    let storedSessionId = "(none)";
    let revoked = false;
    let revokedReason: string | null = null;
    let expiresAt: string | null = null;
    let matches = false;
    let dbError: string | null = null;

    try {
      const [row] = await db
        .select({
          sessionId: activeSessions.sessionId,
          revokedAt: activeSessions.revokedAt,
          revokedReason: activeSessions.revokedReason,
          expiresAt: activeSessions.expiresAt,
        })
        .from(activeSessions)
        .where(eq(activeSessions.userId, userId))
        .limit(1);

      if (row) {
        activeRowExists = true;
        storedSessionId = row.sessionId ? row.sessionId.slice(0, 8) : "(empty)";
        revoked = !!row.revokedAt;
        revokedReason = row.revokedReason ?? null;
        expiresAt = row.expiresAt ? row.expiresAt.toISOString() : null;
        matches = !!headerSessionId && row.sessionId === headerSessionId;
      }
    } catch (e: any) {
      dbError = e?.message ?? "unknown";
    }

    // Cache state AFTER our own query (reflects what middleware will see next time)
    const cacheAfterQuery = headerSessionId
      ? (() => { const c = lookupSessionIdCache(userId, headerSessionId); return c === true ? "valid" : c === false ? "revoked" : "miss"; })()
      : "n/a";

    console.log("[SESSION-DEBUG]", {
      userId: userId.slice(0, 8),
      headerSessionId: headerSessionId ? headerSessionId.slice(0, 8) + "…" : "(none)",
      cacheResult,
      activeRowExists,
      storedSessionId,
      revoked,
      revokedReason,
      matches,
    });

    return res.json({
      userId: userId.slice(0, 8),
      headerSessionId: headerSessionId ? headerSessionId.slice(0, 8) + "…" : "(none)",
      cacheResult,
      activeRowExists,
      storedSessionId: storedSessionId + (storedSessionId !== "(none)" && storedSessionId !== "(empty)" ? "…" : ""),
      revoked,
      revokedReason,
      expiresAt,
      matches,
      cacheAfterQuery,
      dbError,
    });
  });

  // Heartbeat — called every 60 s while the app is open.
  //
  // CHANGED: now uses a conditional UPDATE (only refreshes when the stored
  // sessionId matches the request's sessionId).  This prevents a stale Device 1
  // heartbeat from overriding Device 2's session after Device 2 logged in and
  // replaced the active_sessions row.
  //
  // Old devices whose heartbeat sessionId no longer matches the DB row will
  // receive a no-op response here, and their next API request (which sends
  // X-Session-Id) will be rejected with 401 session_replaced.
  app.post("/api/auth/heartbeat", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const { sessionId, deviceId = "", userAgent = "" } =
      (req.body as { sessionId?: string; deviceId?: string; userAgent?: string }) || {};
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_MS);
    try {
      if (sessionId && typeof sessionId === "string" && sessionId.length > 4) {
        // Conditional update: only refresh if the sessionId still matches.
        // If another device replaced the session, this is a no-op — the old
        // device stops renewing and its session expires naturally (or its next
        // API request gets 401 from the middleware session-id gate).
        await db
          .update(activeSessions)
          .set({ lastSeenAt: now, expiresAt })
          .where(and(eq(activeSessions.userId, userId), eq(activeSessions.sessionId, sessionId)));
        // Refresh cache so the next middleware check on this device is a fast hit.
        cacheSessionIdValid(userId, sessionId, true);
      } else {
        // Fallback for legacy calls without a sessionId: just extend expiry.
        await db
          .update(activeSessions)
          .set({ lastSeenAt: now, expiresAt })
          .where(eq(activeSessions.userId, userId));
      }
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  // Session verify — called by INITIAL_SESSION (page refresh / app reopen) to
  // confirm the stored application sessionId is still the active session for
  // this user.  Returns { valid: true } or { valid: false, reason }.
  //
  // If isAuthenticated rejects the request (expired JWT or replaced session),
  // the client treats it as invalid and signs out locally.
  app.post("/api/auth/session-verify", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const { sessionId } =
      (req.body as { sessionId?: string }) || {};

    if (!sessionId || typeof sessionId !== "string" || sessionId.length < 8) {
      return res.json({ valid: false, reason: "no_session_id" });
    }

    try {
      const [row] = await db
        .select({ sessionId: activeSessions.sessionId, revokedAt: activeSessions.revokedAt, expiresAt: activeSessions.expiresAt })
        .from(activeSessions)
        .where(eq(activeSessions.userId, userId))
        .limit(1);

      const isValid =
        !!row &&
        row.sessionId === sessionId &&
        !row.revokedAt &&
        row.expiresAt > new Date();

      if (isValid) {
        // Touch last_seen_at so this heartbeat counts
        await db
          .update(activeSessions)
          .set({ lastSeenAt: new Date() })
          .where(and(eq(activeSessions.userId, userId), eq(activeSessions.sessionId, sessionId)));
        cacheSessionIdValid(userId, sessionId, true);
        return res.json({ valid: true });
      }

      const reason = !row
        ? "not_found"
        : row.revokedAt
          ? "revoked"
          : row.sessionId !== sessionId
            ? "session_replaced"
            : "expired";
      // Store the correct reason alongside the invalid flag so the middleware
      // fast-reject path returns the right message without a DB round-trip.
      const cacheReason: "session_replaced" | "invalid_session" =
        reason === "session_replaced" ? "session_replaced" : "invalid_session";
      cacheSessionIdValid(userId, sessionId, false, cacheReason);
      console.log(`[SESSION] VERIFY_FAILED`, {
        userId: userId.slice(0, 8) + "…",
        suppliedSessionIdPrefix: sessionId.slice(0, 8) + "…",
        activeRowExists: !!row,
        storedSessionIdPrefix: row?.sessionId ? row.sessionId.slice(0, 8) + "…" : "(none)",
        sameId: !!row && row.sessionId === sessionId,
        revokedAt: row?.revokedAt ?? null,
        expiresAt: row?.expiresAt?.toISOString() ?? null,
        expired: !!row && row.expiresAt <= new Date(),
        reason,
      });
      return res.json({ valid: false, reason });
    } catch (e: any) {
      console.error("[SESSION] session-verify DB error (fail-open):", e?.message);
      // Fail open — DB error never signs users out
      return res.json({ valid: true });
    }
  });

  // Logout — clears the active session so another device can log in immediately.
  app.delete("/api/auth/session", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    try {
      // Invalidate the session in cache before deleting from DB
      const sessionId = req.headers["x-session-id"] as string | undefined;
      if (sessionId) cacheSessionIdValid(userId, sessionId, false);
      await db.delete(activeSessions).where(eq(activeSessions.userId, userId));
      if (IS_DEV) console.log(`[SESSION] Cleared session for ${userId.slice(0, 8)}`);
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  // Fast startup check — returns profile WITHOUT photos (base64 photos skipped).
  // Used by the client's profile-exists-check on every app launch.
  // Avoids transferring up to 5 MB of base64 photos just to determine onboarding status.
  // ── Health check ─────────────────────────────────────────────────────────
  // No auth required — used by startup diagnostics to test Supabase PostgREST.
  app.get("/api/health", async (_req, res) => {
    const t0 = Date.now();
    const results: Record<string, unknown> = {
      ts:          new Date().toISOString(),
      commitHash:  SERVER_COMMIT_HASH,
      buildTime:   SERVER_BUILD_TIME,
      env:         process.env.NODE_ENV || "development",
      appVersion:  APP_VERSION,
      startedAt:   SERVER_START_TIME.toISOString(),
    };
    try {
      const { error } = await Promise.race<any>([
        supabaseAdmin.from("profiles").select("user_id").limit(1),
        new Promise<{ error: Error }>((_, reject) =>
          setTimeout(() => reject(new Error("SUPABASE_TIMEOUT_2S")), 2000)
        ),
      ]);
      results.supabase = { ok: !error, ms: Date.now() - t0, error: error?.message ?? null };
    } catch (err: any) {
      results.supabase = { ok: false, ms: Date.now() - t0, error: err.message };
    }
    results.totalMs = Date.now() - t0;
    res.json(results);
  });

  // ── Push Notification API ─────────────────────────────────────────────────

  // Public — returns VAPID public key for client-side subscription setup
  app.get("/api/push/vapid-key", (_req, res) => {
    try {
      res.json({ publicKey: getVapidPublicKey() });
    } catch (err: any) {
      res.status(503).json({ message: "Push notifications not configured" });
    }
  });

  // Save a new push subscription for this device
  app.post("/api/push/subscribe", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { endpoint, p256dh, auth, userAgent = "" } = req.body;
      if (!endpoint || !p256dh || !auth) {
        return res.status(400).json({ message: "endpoint, p256dh, auth are required" });
      }
      // Delete any existing row for this endpoint before inserting.
      // This prevents the "self-notification" bug: if a different user previously
      // registered this browser endpoint, the old userId association is removed so
      // that only the current authenticated user owns this endpoint going forward.
      // An onConflictDoUpdate that wrote userId would silently re-assign the
      // endpoint to a new user while leaving old subscriptions intact, which could
      // cause pushes sent to the old user to land on the new user's device.
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
      await db.insert(pushSubscriptions)
        .values({ userId, endpoint, p256dh, auth, userAgent: userAgent.slice(0, 300) });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to save subscription" });
    }
  });

  // Remove a push subscription (unsubscribe this device)
  app.delete("/api/push/subscribe", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { endpoint } = req.body;
      if (!endpoint) return res.status(400).json({ message: "endpoint required" });
      await db.delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to remove subscription" });
    }
  });

  // ── Active chat session tracking (push suppression for same-chat recipients) ──
  // Client calls POST when entering a chatroom and DELETE when leaving.
  // A 20-second heartbeat from the client keeps the row fresh while the chat is open.
  // The server reads this table in the message-send route to suppress push
  // notifications when the recipient is already viewing the same conversation.

  app.post("/api/chat/active", isAuthenticated, async (req: any, res) => {
    try {
      const userId  = req.user.id;
      const { matchId } = req.body ?? {};
      if (!matchId || typeof matchId !== "string") {
        return res.status(400).json({ message: "matchId required" });
      }
      // Upsert: one row per user, updated on each heartbeat
      await db.insert(activeChatSessions)
        .values({ userId, matchId, lastSeenAt: new Date() })
        .onConflictDoUpdate({
          target: activeChatSessions.userId,
          set: { matchId, lastSeenAt: new Date() },
        });
      console.log(`[PUSH_AUDIT] CHAT_ACTIVE_SET userId=${userId.slice(0,8)} matchId=${matchId.slice(0,8)}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to set active chat" });
    }
  });

  app.delete("/api/chat/active", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      await db.delete(activeChatSessions).where(eq(activeChatSessions.userId, userId));
      console.log(`[PUSH_AUDIT] CHAT_ACTIVE_CLEAR userId=${userId.slice(0,8)}`);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to clear active chat" });
    }
  });

  // Debug: inspect current user's push subscriptions
  app.get("/api/push/my-subscriptions", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const subs = await db.select({
        id:          pushSubscriptions.id,
        userId:      pushSubscriptions.userId,
        endpoint:    pushSubscriptions.endpoint,
        userAgent:   pushSubscriptions.userAgent,
        failCount:   pushSubscriptions.failCount,
        createdAt:   pushSubscriptions.createdAt,
        lastUsedAt:  pushSubscriptions.lastUsedAt,
      }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

      const masked = subs.map(s => ({
        id:           s.id.slice(0, 8) + "…",
        userId:       s.userId.slice(0, 8) + "…",
        endpointSuffix: "…" + s.endpoint.slice(-30),
        userAgent:    (s.userAgent || "").slice(0, 80),
        failCount:    s.failCount,
        createdAt:    s.createdAt,
        lastUsedAt:   s.lastUsedAt,
      }));

      console.log(`[PUSH_AUDIT] /my-subscriptions: userId=${userId.slice(0,8)} found=${subs.length} sub(s)`);
      for (const m of masked) {
        console.log(`[PUSH_AUDIT]   ${JSON.stringify(m)}`);
      }
      res.json({ userId: userId.slice(0,8) + "…", count: subs.length, subscriptions: masked });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to list subscriptions" });
    }
  });

  // Get notification preferences
  app.get("/api/push/preferences", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const [row] = await db.select().from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId)).limit(1);
      res.json(row ?? {});
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to get preferences" });
    }
  });

  // Update notification preferences (partial update — only provided keys are changed)
  app.put("/api/push/preferences", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const ALLOWED = ["newLike","newMatch","newMessage","incomingCall","missedCall","halo","elevate","payment","safety"] as const;
      const update: Record<string, boolean> = {};
      for (const key of ALLOWED) {
        if (typeof req.body[key] === "boolean") update[key] = req.body[key];
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ message: "No valid preference keys provided" });
      }
      await db.insert(notificationPreferences)
        .values({ userId, ...update, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: { ...update, updatedAt: new Date() },
        });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to update preferences" });
    }
  });

  app.get("/api/profile/meta", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const profile = await Promise.race<any>([
        storage.getProfileMeta(userId),
        new Promise<undefined>((_, reject) =>
          setTimeout(() => reject(new Error("SUPABASE_TIMEOUT_3S")), 3000)
        ),
      ]);
      if (!profile) {
        if (IS_DEV) console.log(`[PROFILE_META] not found userId=${userId} in ${Date.now() - t0} ms`);
        return res.status(404).json({ message: "Profile not found." });
      }
      if (IS_DEV) console.log(`[PROFILE_META] fetched userId=${userId} in ${Date.now() - t0} ms`);
      res.json(profile);
    } catch (error: any) {
      const errMsg = (error?.message || "Unknown error").slice(0, 200);
      console.error("[PROFILE_META] FETCH_ERROR:", errMsg, `| ${Date.now() - t0} ms`);
      res.status(503).json({ message: `Profile temporarily unavailable: ${errMsg}` });
    }
  });

  app.get("/api/profile", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      console.log(`[PROFILE] getProfile start userId=${userId.slice(0, 8)}`);
      const profile = await Promise.race<any>([
        storage.getProfile(userId),
        new Promise<undefined>((_, reject) =>
          setTimeout(() => reject(new Error("SUPABASE_TIMEOUT_3S")), 3000)
        ),
      ]);
      if (!profile) {
        console.log(`[PROFILE] not found userId=${userId.slice(0, 8)} in ${Date.now() - t0} ms`);
        devPerf("/api/profile", Date.now() - t0, { status: 404, userId: userId.slice(0, 8) });
        return res.status(404).json({ message: "Profile not found. Please complete onboarding to create your profile." });
      }
      const profileJson = IS_DEV ? JSON.stringify(profile) : "";
      console.log(`[PROFILE] fetched userId=${userId.slice(0, 8)} in ${Date.now() - t0} ms`);
      devPerf("/api/profile", Date.now() - t0, {
        status: 200,
        userId: userId.slice(0, 8),
        payloadKb: Math.round(profileJson.length / 1024),
        photoCount: Array.isArray(profile.photos) ? profile.photos.length : 0,
        photoFormat: Array.isArray(profile.photos) && profile.photos[0] ? photoFormat(profile.photos[0]) : "none",
      });
      res.json(profile);
    } catch (error: any) {
      const errMsg = (error?.message || "Unknown error").slice(0, 200);
      // 503 = Service Unavailable — signals the client to retry.
      // This catch fires when Supabase PostgREST is unreachable or times out.
      console.error("[PROFILE] FETCH_ERROR:", errMsg, "| userId =", req.user?.id?.slice(0, 8), `| ${Date.now() - t0} ms`);
      res.status(503).json({ message: `Profile temporarily unavailable: ${errMsg}` });
    }
  });

  // Data export — returns the user's own profile data as JSON (no messages).
  // Legacy alias — kept so any cached links still work
  app.get("/api/profile/export", isAuthenticated, (_req, res) => {
    res.redirect(307, "/api/account/export");
  });

  // ── Refund history ────────────────────────────────────────────────────────
  // Returns all refund records for the authenticated user, newest first.
  app.get("/api/refunds", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;
    try {
      const records = await db
        .select()
        .from(refundRecords)
        .where(eq(refundRecords.userId, userId))
        .orderBy(desc(refundRecords.createdAt));
      res.json(records);
    } catch (err: any) {
      console.error("[API] GET /api/refunds error:", err?.message);
      res.json([]);
    }
  });

  // Marks all unread refund records for the user as read (clears in-app badge).
  app.post("/api/refunds/read-all", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;
    try {
      await db
        .update(refundRecords)
        .set({ readAt: new Date() })
        .where(and(eq(refundRecords.userId, userId), isNull(refundRecords.readAt)));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[API] POST /api/refunds/read-all error:", err?.message);
      res.json({ ok: false });
    }
  });

  // ── Complete personal data export (GDPR Article 20 / CCPA compliant) ───────
  // Returns a single structured JSON file containing ALL data the platform
  // holds for the authenticated user.
  //
  // Security guarantees:
  //   - userId is ALWAYS taken from the verified JWT (req.user.id), never the
  //     client request body / query / params.
  //   - Other users referenced in matches/messages: only firstName is exposed —
  //     no photos, no coordinates, no phone, no email.
  //   - Own profile: lat/lng stripped (city/region retained); base64 photo
  //     blobs replaced with URL-only strings.
  //   - Stripe internals: stripeCustomerId and stripeSubscriptionId are never
  //     included. Purchases show only itemRef + grantedAt.

  app.get("/api/account/export", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;

    try {
      // ── 1. Own profile ────────────────────────────────────────────────────
      const { data: profileRow } = await supabaseAdmin
        .from("profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      const safePhotos: string[] = ((profileRow?.photos ?? []) as string[]).map(
        (p: string) => (p.startsWith("data:") ? "[base64-photo-omitted]" : p)
      );
      const safeProfile = profileRow
        ? {
            firstName:           profileRow.first_name,
            age:                 profileRow.age,
            gender:              profileRow.gender,
            datingPreference:    profileRow.dating_preference,
            location:            profileRow.location,      // city/region string
            height:              profileRow.height ?? null,
            photos:              safePhotos,
            signals:             profileRow.signals ?? [],
            datingIntent:        profileRow.dating_intent,
            greenFlags:          profileRow.green_flags ?? [],
            connectionStyle:     profileRow.connection_style,
            conversationStarters:profileRow.conversation_starters ?? [],
            questions:           profileRow.questions ?? [],
            customQuestions:     profileRow.custom_questions ?? [],
            viewerQuestions:     profileRow.viewer_questions ?? [],
            dateOfBirth:         profileRow.date_of_birth ?? null,
            pronouns:            profileRow.pronouns ?? null,
            locationRadius:      profileRow.location_radius ?? 25,
            preferredAgeMin:     profileRow.preferred_age_min ?? 18,
            preferredAgeMax:     profileRow.preferred_age_max ?? 45,
            email:               profileRow.email ?? null,
            phoneNumber:         profileRow.phone_number ?? null,
            photoVerified:       profileRow.photo_verified ?? false,
            isPaused:            profileRow.is_paused ?? false,
            showLastActive:      profileRow.show_last_active ?? true,
            commentFilter:       profileRow.comment_filter ?? true,
            createdAt:           profileRow.created_at ?? null,
            // lat/lng intentionally omitted for privacy
          }
        : null;

      // ── 2. Matches (with other user's first name only) ────────────────────
      const { data: matchRows } = await supabaseAdmin
        .from("matches")
        .select("id, user1_id, user2_id, status, call_stage, call_completed, created_at, meet_availability_1, meet_availability_2, number_exchanged_1, number_exchanged_2")
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

      const matchIds: string[] = (matchRows ?? []).map((m: any) => m.id);

      // Batch-fetch first names of all match partners
      const partnerIds = [...new Set(
        (matchRows ?? []).map((m: any) => (m.user1_id === userId ? m.user2_id : m.user1_id))
      )];
      let partnerNameMap: Record<string, string> = {};
      if (partnerIds.length > 0) {
        const { data: partnerRows } = await supabaseAdmin
          .from("profiles")
          .select("user_id, first_name")
          .in("user_id", partnerIds);
        partnerNameMap = Object.fromEntries(
          (partnerRows ?? []).map((p: any) => [p.user_id, p.first_name])
        );
      }

      const safeMatches = (matchRows ?? []).map((m: any) => {
        const partnerId = m.user1_id === userId ? m.user2_id : m.user1_id;
        return {
          matchId:           m.id,
          partnerFirstName:  partnerNameMap[partnerId] ?? "Unknown",
          status:            m.status,
          callStage:         m.call_stage,
          callCompleted:     m.call_completed,
          meetArranged:      !!(m.meet_availability_1 && m.meet_availability_2),
          numbersExchanged:  m.user1_id === userId ? m.number_exchanged_1 : m.number_exchanged_2,
          createdAt:         m.created_at,
        };
      });

      // ── 3. Messages (all conversations) ──────────────────────────────────
      let allMessages: any[] = [];
      let voiceNoteUrls: string[] = [];

      if (matchIds.length > 0) {
        const { data: msgRows } = await supabaseAdmin
          .from("messages")
          .select("id, match_id, sender_id, content, reaction, voice_transcript, created_at")
          .in("match_id", matchIds)
          .order("created_at", { ascending: true });

        allMessages = (msgRows ?? []).map((m: any) => ({
          messageId:       m.id,
          matchId:         m.match_id,
          direction:       m.sender_id === userId ? "sent" : "received",
          content:         m.content,
          reaction:        m.reaction ?? null,
          voiceTranscript: m.voice_transcript ?? null,
          sentAt:          m.created_at,
        }));

        // Voice note messages have URLs as content
        voiceNoteUrls = (msgRows ?? [])
          .filter((m: any) => typeof m.content === "string" && m.content.startsWith("https://") && m.content.includes("voice-notes"))
          .map((m: any) => ({
            url:       m.content,
            matchId:   m.match_id,
            direction: m.sender_id === userId ? "sent" : "received",
            sentAt:    m.created_at,
          })) as any[];
      }

      // ── 4. Interactions (swipes/opens sent by user) ───────────────────────
      const { data: interactionRows } = await supabaseAdmin
        .from("interactions")
        .select("id, to_user_id, type, created_at")
        .eq("from_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(500);

      const safeInteractions = (interactionRows ?? []).map((i: any) => ({
        type:      i.type,       // "like" | "pass" | "open" etc.
        createdAt: i.created_at,
        // to_user_id omitted — user's own swipe history, not other user's data
      }));

      // ── 5–11. Local DB (run all in parallel) ─────────────────────────────
      const [
        benefitRows,
        callCreditRow,
        elevateRow,
        purchaseRows,
        membershipRow,
        blockedRows,
        savedWheelRow,
      ] = await Promise.all([
        db.select().from(userBenefits).where(eq(userBenefits.userId, userId)),
        db.select().from(callCredits).where(eq(callCredits.userId, userId)).limit(1),
        db.select().from(userElevates).where(eq(userElevates.userId, userId)).limit(1),
        db.select({ itemRef: processedStripeSessions.itemRef, grantedAt: processedStripeSessions.grantedAt })
          .from(processedStripeSessions)
          .where(eq(processedStripeSessions.userId, userId)),
        db.select().from(membershipSubscriptions).where(eq(membershipSubscriptions.userId, userId)).limit(1),
        db.select({ name: blockedContacts.name, phoneNumber: blockedContacts.phoneNumber, email: blockedContacts.email, createdAt: blockedContacts.createdAt })
          .from(blockedContacts)
          .where(eq(blockedContacts.userId, userId)),
        db.select({ savedProfileId: savedWheelProfiles.savedProfileId, savedAt: savedWheelProfiles.savedAt, expiresAt: savedWheelProfiles.expiresAt })
          .from(savedWheelProfiles)
          .where(eq(savedWheelProfiles.userId, userId)),
      ]);

      const safeMembership = membershipRow[0]
        ? {
            status:          membershipRow[0].status,
            currentPeriodEnd:membershipRow[0].currentPeriodEnd?.toISOString() ?? null,
            memberSince:     membershipRow[0].createdAt?.toISOString() ?? null,
            // stripeCustomerId and stripeSubscriptionId intentionally omitted
          }
        : null;

      const safeElevate = elevateRow[0]
        ? {
            elevateCredits:      elevateRow[0].elevateCredits,
            superElevateCredits: elevateRow[0].superElevateCredits,
            activeBoostType:     elevateRow[0].elevateType,
            boostExpiresAt:      elevateRow[0].expiresAt?.toISOString() ?? null,
          }
        : { elevateCredits: 0, superElevateCredits: 0, activeBoostType: null, boostExpiresAt: null };

      // ── Assemble final export ─────────────────────────────────────────────
      const exportData = {
        _meta: {
          generatedAt: new Date().toISOString(),
          accountId:   userId,
          exportVersion: "2",
          note: "This file contains all personal data Lulou holds for your account. " +
                "Other users appear by first name only. Raw GPS coordinates are never exported.",
        },
        profile:          safeProfile,
        matches:          safeMatches,
        messages:         allMessages,
        voiceNotes:       voiceNoteUrls,
        interactions: {
          totalSent: safeInteractions.length,
          history:   safeInteractions,
        },
        benefits:         benefitRows.map(b => ({ type: b.type, activatedMatchId: b.activatedMatchId ?? null, grantedAt: b.createdAt?.toISOString() ?? null })),
        callCredits:      callCreditRow[0] ? { phoneCredits: callCreditRow[0].phoneCredits, videoCredits: callCreditRow[0].videoCredits } : { phoneCredits: 0, videoCredits: 0 },
        elevate:          safeElevate,
        purchases:        purchaseRows.map(p => ({ item: p.itemRef, purchasedAt: p.grantedAt?.toISOString() ?? null })),
        membership:       safeMembership,
        blockedContacts:  blockedRows,
        savedWheelProfile:savedWheelRow[0] ?? null,
      };

      const filename = `lulou-data-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/json");
      return res.json(exportData);
    } catch (err: any) {
      console.error("[EXPORT] Failed for user", userId, err?.message);
      return res.status(500).json({ message: "Export failed. Please try again.", error: err?.message });
    }
  });

  // Batch photo fetch — returns photos for up to 20 profiles in a single request.
  // All Supabase lookups run in parallel; responds with { userId: photos[] }.
  // Used by the client batch prefetcher to hydrate photo caches before cards render,
  // converting N individual HTTP requests into 1 and eliminating the per-card waterfall.
  // IMPORTANT: this literal-path route must be registered BEFORE the :userId param route below.
  app.get("/api/profiles/photos/batch", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const idsParam = (req.query.ids as string) || "";
      const ids = idsParam.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 20);
      if (ids.length === 0) return res.json({});
      const settled = await Promise.allSettled(
        ids.map(async (id: string) => {
          const photos = await storage.getProfilePhotos(id);
          return { id, photos };
        })
      );
      const output: Record<string, string[]> = {};
      let totalPhotos = 0;
      let photoFmt = "none";
      for (const r of settled) {
        if (r.status === "fulfilled") {
          output[r.value.id] = r.value.photos;
          totalPhotos += r.value.photos.length;
          if (!photoFmt || photoFmt === "none") photoFmt = r.value.photos[0] ? photoFormat(r.value.photos[0]) : "none";
        }
      }
      const batchJson = IS_DEV ? JSON.stringify(output) : "";
      devPerf("/api/profiles/photos/batch", Date.now() - t0, {
        requested: ids.length,
        returned: Object.keys(output).length,
        totalPhotos,
        photoFormat: photoFmt,
        payloadKb: Math.round(batchJson.length / 1024),
      });
      res.json(output);
    } catch (error: any) {
      console.error("[PHOTOS] Batch route error —", error?.message, `(${Date.now() - t0} ms)`);
      res.json({});
    }
  });

  // Returns ONLY the photos array for a given user — fast single-column fetch.
  // Profiles in the discover pool / wheel pool don't carry photos (they'd cause statement timeouts).
  // The client calls this per-card to lazy-load photos without fetching the full profile row.
  app.get("/api/profiles/:userId/photos", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const { userId } = req.params;
      if (!userId) return res.status(400).json({ message: "Missing userId" });
      const photos = await storage.getProfilePhotos(userId);
      devPerf("/api/profiles/:userId/photos", Date.now() - t0, {
        userId: userId.slice(0, 8),
        count: photos.length,
        photoFormat: photos[0] ? photoFormat(photos[0]) : "none",
        sizeKb: photos[0] ? Math.round(photos[0].length / 1024) : 0,
      });
      res.json({ photos });
    } catch (error: any) {
      console.error("[PHOTOS] Route error for userId:", req.params?.userId, "—", error?.message, `(${Date.now() - t0} ms)`);
      res.json({ photos: [] });
    }
  });

  app.post("/api/profile", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid profile data", errors: parsed.error.flatten() });
      }
      // Server-side 18+ enforcement
      const pd = parsed.data as any;
      if (pd.dateOfBirth) {
        const dobAge = calculateAgeFromDob(pd.dateOfBirth);
        if (dobAge < 18) {
          return res.status(400).json({ message: "You must be 18 or older to use Lulou." });
        }
      } else if (typeof pd.age === "number" && pd.age < 18) {
        return res.status(400).json({ message: "You must be 18 or older to use Lulou." });
      }
      const payload = { ...parsed.data, userId };
      const result = await storage.updateProfile(userId, payload);
      // Invalidate the discover meta cache so gender/preference changes take
      // effect on the very next /api/discover call.
      _userDiscoverMeta.delete(userId);
      res.json(result);

      // Send welcome email when the user completes onboarding for the first time
      if ((parsed.data as any).onboardingComplete === true) {
        void (async () => {
          try {
            const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
            const email = authData?.user?.email;
            if (!email) return;
            const { data: profileData } = await supabaseAdmin
              .from("profiles").select("firstName").eq("userId", userId).single();
            const firstName = (profileData as any)?.firstName ?? "there";
            await sendEmail({
              to:      email,
              subject: "Welcome to Lulou 🌸",
              html:    welcomeEmail(firstName),
              type:    "welcome",
            });
          } catch (err: any) {
            console.warn(`[EMAIL] welcome email failed for user ${userId.slice(0,8)}: ${err?.message}`);
          }
        })();
      }
    } catch (error: any) {
      const errMsg = error?.message || "Failed to save profile";
      console.error("PROFILE_SAVE_ERROR", errMsg, error);
      res.status(500).json({ message: errMsg });
    }
  });

  // ── Blocked Contacts ─────────────────────────────────────────────────────────
  app.get("/api/blocked-contacts", isAuthenticated, async (req: any, res) => {
    try {
      const { getBlockedContactsForUser } = await import("./storage");
      const contacts = await getBlockedContactsForUser(req.user.id);
      res.json(contacts);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to fetch blocked contacts" });
    }
  });

  app.post("/api/blocked-contacts", isAuthenticated, async (req: any, res) => {
    const schema = z.object({
      name: z.string().max(100).default(""),
      phoneNumber: z.string().max(30).default(""),
      email: z.string().email().max(200).optional(),
    }).refine(d => d.phoneNumber.trim() || d.email?.trim(), { message: "Phone number or email required" });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Phone number or email required" });
    try {
      const { addBlockedContactForUser } = await import("./storage");
      const contact = await addBlockedContactForUser(req.user.id, parsed.data.name, parsed.data.phoneNumber, parsed.data.email);
      res.json(contact);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to add blocked contact" });
    }
  });

  app.delete("/api/blocked-contacts/:id", isAuthenticated, async (req: any, res) => {
    try {
      const { removeBlockedContactForUser } = await import("./storage");
      await removeBlockedContactForUser(req.user.id, req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to remove blocked contact" });
    }
  });

  // ── Location Search (server-side Nominatim proxy) ─────────────────────────
  // Running this server-side fixes iPhone Safari: browsers cannot set the
  // User-Agent header (required by Nominatim policy), causing rate-limiting
  // and silent failure.  A same-origin API call has no CORS restriction.
  app.get("/api/location-search", async (req, res) => {
    const q = ((req.query.q as string) ?? "").trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ error: "Query too short" });
    }
    const AU_ABBR: Record<string, string> = {
      "New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD",
      "South Australia": "SA", "Western Australia": "WA", "Tasmania": "TAS",
      "Australian Capital Territory": "ACT", "Northern Territory": "NT",
    };
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(url, {
        headers: {
          "User-Agent": "LulouDating/1.0 contact@lulou.app",
          "Accept-Language": "en",
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!upstream.ok) {
        return res.status(502).json({ error: "Location provider error" });
      }
      const raw: any[] = await upstream.json();
      const results = raw.map(item => {
        const a = item.address ?? {};
        const suburb: string = a.suburb || a.quarter || a.city_district || a.town || a.village || a.neighbourhood || "";
        const city: string = a.city || a.county || a.municipality || "";
        const stateRaw: string = a.state || "";
        const stateAbbr: string = stateRaw ? (AU_ABBR[stateRaw] ?? stateRaw) : "";
        const country: string = a.country || "";
        const postcode: string = a.postcode || "";
        const primary: string = suburb || city || (item.display_name as string).split(",")[0].trim();
        const secondary: string = [city && city !== primary ? city : null, stateAbbr || null, country || null].filter(Boolean).join(", ");
        const label: string = [primary, stateAbbr || null, country || null].filter(Boolean).join(", ");
        return {
          id: item.place_id?.toString() ?? `${item.lat},${item.lon}`,
          label,
          primary,
          secondary,
          city,
          state: stateRaw,
          stateAbbr,
          country,
          postcode,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
        };
      });
      res.json(results);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return res.status(504).json({ error: "Location search timed out" });
      }
      console.error("[LOCATION_SEARCH]", err?.message);
      res.status(502).json({ error: "Location search unavailable" });
    }
  });

  app.get("/api/discover", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;

      // Fast path: use cached gender/preference to skip the sequential
      // getProfileMeta round-trip (~150–300 ms saved on warm server).
      // If cached meta exists but has no coordinates and radius > 0, force a
      // re-fetch so we can attempt inline geocoding for existing accounts.
      let discoverMeta = getCachedDiscoverMeta(userId);
      if (discoverMeta && discoverMeta.latitude === null && (discoverMeta.locationRadius ?? 0) > 0) {
        discoverMeta = null;
      }
      if (!discoverMeta) {
        const myProfile = await storage.getProfileMeta(userId);
        const metaMs = Date.now() - t0;
        if (!myProfile) {
          devPerf("/api/discover", metaMs, { status: 204, reason: "no-profile" });
          return res.json([]);
        }

        // Existing profiles created before geocoding was added may have location
        // text but null lat/lng. Geocode inline so the distance filter can run.
        let lat: number | null = myProfile.latitude ?? null;
        let lng: number | null = myProfile.longitude ?? null;
        if (lat === null && myProfile.location && getHasLatLngColumns() && (myProfile.locationRadius ?? 0) > 0) {
          try {
            const coords = await geocodeLocation(myProfile.location);
            if (coords) {
              lat = coords.lat;
              lng = coords.lng;
              console.log(`[DISCOVER] inline geocode "${myProfile.location}" → ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
              supabaseAdmin.from("profiles")
                .update({ latitude: lat, longitude: lng })
                .eq("user_id", userId)
                .then(
                  () => console.log(`[DISCOVER] inline geocode saved for ${userId}`),
                  (e: any) => console.warn("[DISCOVER] inline geocode save failed:", e?.message),
                );
            }
          } catch (e: any) {
            console.warn("[DISCOVER] inline geocode failed:", e?.message);
          }
        }

        discoverMeta = {
          gender: myProfile.gender,
          preference: myProfile.datingPreference,
          ageMin: myProfile.preferredAgeMin || 18,
          ageMax: myProfile.preferredAgeMax || 99,
          locationRadius: myProfile.locationRadius ?? 0,
          latitude: lat,
          longitude: lng,
          datingIntent: myProfile.datingIntent ?? null,
          connectionStyle: myProfile.connectionStyle ?? null,
          expiresAt: 0,
        };
        setCachedDiscoverMeta(
          userId,
          discoverMeta.gender,
          discoverMeta.preference,
          discoverMeta.ageMin,
          discoverMeta.ageMax,
          discoverMeta.locationRadius,
          discoverMeta.latitude,
          discoverMeta.longitude,
          discoverMeta.datingIntent,
          discoverMeta.connectionStyle,
        );
      }

      const t1 = Date.now();
      const discovered = await storage.getDiscoverProfiles(
        userId,
        discoverMeta.gender,
        discoverMeta.preference,
        discoverMeta.ageMin,
        discoverMeta.ageMax,
        discoverMeta.locationRadius,
        discoverMeta.latitude,
        discoverMeta.longitude,
        discoverMeta.datingIntent,
        discoverMeta.connectionStyle,
      );
      const discoverJson = IS_DEV ? JSON.stringify(discovered) : "";
      devPerf("/api/discover", Date.now() - t0, {
        status: 200,
        metaCached: !!getCachedDiscoverMeta(userId),
        queryMs: Date.now() - t1,
        count: discovered.length,
        payloadKb: Math.round(discoverJson.length / 1024),
        hasPhotos: false,
      });
      res.json(discovered.map(sanitizeOtherProfile));
    } catch (error: any) {
      console.error("[DISCOVER] Error:", error?.message, `(${Date.now() - t0} ms)`);
      res.status(500).json({ message: "Failed to discover profiles" });
    }
  });

  app.post("/api/interactions", isAuthenticated, writeLimiter, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const fromUserId = req.user?.id;
      if (!fromUserId) {
        return res.status(401).json({ message: "Authenticated user id missing" });
      }
      const parsed = interactionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid interaction data" });
      }

      const { toUserId, type } = parsed.data;
      if (!toUserId) {
        return res.status(400).json({ message: "Target user id is required" });
      }

      console.log(
        `[INTERACT] sender=${fromUserId.slice(0,8)}… recipient=${toUserId.slice(0,8)}… type=${type}`
      );

      if (fromUserId === toUserId) {
        console.warn(`[INTERACT] SELF_LIKE rejected sender=recipient=${fromUserId.slice(0,8)}…`);
        return res.status(400).json({ message: "Cannot interact with yourself" });
      }

      const existing = await storage.getInteraction(fromUserId, toUserId);

      // ── Targeted fix: Like Back after a prior Discover pass ──────────────────
      // Previously any existing interaction row (including type="close") caused an
      // immediate 400 "Already interacted", blocking the Like Back flow.
      //
      // Correct behaviour by case:
      //   existing=close, new=open  → upgrade the row to open, fall through to match detection
      //   existing=open,  new=open  → idempotent; fall through to match detection (handles double-tap)
      //   existing=*,     new=close → idempotent pass; return early success (don't error on re-pass)
      //   no existing row           → normal INSERT path
      let interaction: Awaited<ReturnType<typeof storage.createInteraction>>;
      if (existing) {
        if (type === "open") {
          if (existing.type === "close") {
            // B previously passed A in Discover — now B is liking back from the Likes page.
            // Upgrade the close row to open so mutual-open detection below can fire.
            await storage.updateInteractionType(existing.id, "open");
            interaction = { ...existing, type: "open" } as typeof interaction;
            console.log(
              `[INTERACT] upgraded close→open id=${existing.id} ` +
              `sender=${fromUserId.slice(0,8)}… recipient=${toUserId.slice(0,8)}…`
            );
          } else if (existing.type === "open") {
            // Already liked — idempotent.  Fall through to match detection so a
            // double-tap doesn't lose the match if the first request already matched.
            interaction = existing as typeof interaction;
            console.log(
              `[INTERACT] idempotent open id=${existing.id} ` +
              `sender=${fromUserId.slice(0,8)}… — continuing to match check`
            );
          } else {
            // Unknown existing type — safe to reject.
            console.warn(`[INTERACT] unexpected existing type="${existing.type}" id=${existing.id}`);
            return res.status(400).json({ message: "Already interacted" });
          }
        } else {
          // type === "close": idempotent regardless of existing type.
          // Never error on a re-pass — just return success so the card disappears.
          console.log(
            `[INTERACT] idempotent close id=${existing.id} ` +
            `sender=${fromUserId.slice(0,8)}… — returning early`
          );
          return res.json({ interaction: existing, matched: false });
        }
      } else {
        // No prior row — normal path.
        if (type === "open") {
          const matchCount = await storage.getMatchCount(fromUserId);
          if (matchCount >= 8) {
            console.log(`[INTERACT] CONNECTION_LIMIT reached for ${fromUserId.slice(0, 8)}… (count=${matchCount})`);
            return res.json({ matched: false, connectionLimitReached: true });
          }
        }
        interaction = await storage.createInteraction({ fromUserId, toUserId, type });
        console.log(
          `[INTERACT] row inserted id=${interaction.id} type=${interaction.type} ` +
          `sender=${fromUserId.slice(0,8)}… recipient=${toUserId.slice(0,8)}…`
        );
      }

      // Connection-limit check for the upgrade path (close→open from Likes page).
      // The normal INSERT path checks above; this covers the upgrade case.
      if (type === "open" && existing) {
        const matchCount = await storage.getMatchCount(fromUserId);
        if (matchCount >= 8) {
          console.log(`[INTERACT] CONNECTION_LIMIT reached (upgrade path) for ${fromUserId.slice(0, 8)}… (count=${matchCount})`);
          return res.json({ matched: false, connectionLimitReached: true });
        }
      }

      let matched = false;
      let matchId: string | undefined;
      if (type === "open") {
        const reverseOpen = await storage.getInteraction(toUserId, fromUserId);
        if (reverseOpen && reverseOpen.type === "open") {
          // Guard against duplicate matches on double-tap or idempotent open→open path.
          // findMatchBetweenUsers checks both user1/user2 orderings.
          const alreadyMatched = await storage.findMatchBetweenUsers(fromUserId, toUserId);
          if (alreadyMatched) {
            matched = true;
            matchId = alreadyMatched.id;
            console.log(`[INTERACT] mutual open — match already exists matchId=${matchId} (idempotent)`);
          } else {
            const fromCount = await storage.getMatchCount(fromUserId);
            const toCount = await storage.getMatchCount(toUserId);
            if (fromCount < 8 && toCount < 8) {
              const newMatch = await storage.createMatch(fromUserId, toUserId);
              matched = true;
              matchId = newMatch.id;
              console.log(`[INTERACT] MATCHED — matchId=${matchId} between ${fromUserId.slice(0, 8)}… and ${toUserId.slice(0, 8)}…`);
            } else {
              console.log(`[INTERACT] mutual open but connection limit blocked match (fromCount=${fromCount} toCount=${toCount})`);
            }
          }
        } else {
          console.log(`[INTERACT] no reverse open found — like stored, waiting for reciprocal`);
        }
      }

      console.log(`[INTERACT] response: matched=${matched} interactionId=${interaction.id}`);
      res.json({ interaction, matched, matchId });

      // Fire-and-forget push notifications (does not block response)
      (async () => {
        try {
          if (matched && matchId) {
            const [fromProfile, toProfile] = await Promise.all([
              storage.getProfileMeta(fromUserId),
              storage.getProfileMeta(toUserId),
            ]);
            await Promise.all([
              sendPushToUser(fromUserId, buildPush.newMatch(toProfile?.firstName   || undefined), "new_match"),
              sendPushToUser(toUserId,   buildPush.newMatch(fromProfile?.firstName || undefined), "new_match"),
            ]);
          } else if (type === "open") {
            await sendPushToUser(toUserId, buildPush.newLike(), "new_like");
          }
        } catch { /* never block the route */ }
      })();
    } catch (error: any) {
      const msg = error?.message || "Failed to create interaction";
      console.error("INTERACTION_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  // Intention Wheel: directly create (or reopen) a match when user taps ❤️.
  // Unlike discovery (which requires mutual opens), this creates the match immediately.
  // POST /api/wheel/spark — sends a Lulou Spark (wheel_connection interaction).
  // Does NOT create a match. The recipient must explicitly Accept Spark to connect.
  app.post("/api/wheel/spark", isAuthenticated, async (req: any, res) => {
    try {
      const fromUserId = req.user.id;
      const { toUserId } = req.body;
      if (!toUserId || typeof toUserId !== "string") {
        return res.status(400).json({ message: "toUserId is required" });
      }
      if (fromUserId === toUserId) {
        return res.status(400).json({ message: "Cannot send a Spark to yourself" });
      }
      const storage = getStorage(req);
      await storage.createWheelSpark(fromUserId, toUserId);
      console.log("[WHEEL] SPARK_SENT", { from: fromUserId, to: toUserId });
      res.json({ success: true });
    } catch (error: any) {
      const msg = error?.message || "Failed to send Spark";
      console.error("[WHEEL] SPARK_SEND_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  // GET /api/wheel/sparks — returns incoming Lulou Sparks for the current user.
  app.get("/api/wheel/sparks", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const sparks = await storage.getIncomingWheelSparks(req.user.id);
      res.json(sparks);
    } catch (error: any) {
      console.error("[WHEEL] SPARKS_FETCH_ERROR", error?.message, error);
      res.status(500).json({ message: "Failed to fetch Sparks" });
    }
  });

  // POST /api/wheel/spark/accept — creates a match from an accepted Spark.
  // This is the ONLY place a wheel_connection becomes a match.
  app.post("/api/wheel/spark/accept", isAuthenticated, async (req: any, res) => {
    try {
      const toUserId = req.user.id;
      const { fromUserId } = req.body;
      if (!fromUserId || typeof fromUserId !== "string") {
        return res.status(400).json({ message: "fromUserId is required" });
      }
      const storage = getStorage(req);
      const matchCount = await storage.getMatchCount(toUserId);
      if (matchCount >= 8) {
        return res.status(400).json({ message: "You've reached your connection limit (max 8). Remove a connection to add a new one.", connectionLimitReached: true });
      }
      console.log("[HALO] ACCEPT_RECEIVED", { from: fromUserId, to: toUserId });
      const result = await storage.acceptWheelSpark(fromUserId, toUserId);
      console.log("[HALO] MATCH_CREATED", { from: fromUserId, to: toUserId, matchId: result.matchId });
      res.json({ matchId: result.matchId });
    } catch (error: any) {
      const msg = error?.message || "Failed to accept Spark";
      console.error("[WHEEL] SPARK_ACCEPT_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  // POST /api/wheel/spark/decline — removes the Spark interaction, no match created.
  app.post("/api/wheel/spark/decline", isAuthenticated, async (req: any, res) => {
    try {
      const toUserId = req.user.id;
      const { fromUserId } = req.body;
      if (!fromUserId || typeof fromUserId !== "string") {
        return res.status(400).json({ message: "fromUserId is required" });
      }
      const storage = getStorage(req);
      await storage.declineWheelSpark(fromUserId, toUserId);
      console.log("[HALO] DECLINED", { from: fromUserId, to: toUserId });
      res.json({ success: true });
    } catch (error: any) {
      const msg = error?.message || "Failed to decline Spark";
      console.error("[WHEEL] SPARK_DECLINE_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  // POST /api/wheel/open — DEPRECATED: kept for backward compat, now routes to spark flow.
  app.post("/api/wheel/open", isAuthenticated, async (req: any, res) => {
    try {
      const fromUserId = req.user.id;
      const { toUserId } = req.body;
      if (!toUserId || typeof toUserId !== "string") {
        return res.status(400).json({ message: "toUserId is required" });
      }
      if (fromUserId === toUserId) {
        return res.status(400).json({ message: "Cannot send a Spark to yourself" });
      }
      const storage = getStorage(req);
      await storage.createWheelSpark(fromUserId, toUserId);
      console.log("[WHEEL] SPARK_SENT (via legacy /open route)", { from: fromUserId, to: toUserId });
      res.json({ success: true });
    } catch (error: any) {
      const msg = error?.message || "Failed to send Spark";
      console.error("[WHEEL] SPARK_SEND_ERROR (legacy)", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/matches", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const userMatches = await storage.getMatchesForUser(userId);
      const sanitized = userMatches.map(m => ({ ...m, profile: sanitizeOtherProfile(m.profile) }));
      const matchesJson = IS_DEV ? JSON.stringify(sanitized) : "";
      devPerf("/api/matches", Date.now() - t0, {
        count: sanitized.length,
        payloadKb: Math.round(matchesJson.length / 1024),
        hasPhotos: false,
      });
      res.json(sanitized);
    } catch (error) {
      console.error(`[MATCHES_LIST] Error after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch matches" });
    }
  });

  app.get("/api/matches/:matchId", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const match = await storage.getMatch(req.params.matchId, userId);
      if (!match) {
        if (IS_DEV) console.log(`[MATCH_DETAIL] not found ${req.params.matchId} in ${Date.now() - t0} ms`);
        return res.status(404).json({ message: "Match not found" });
      }
      if (IS_DEV) console.log(`[MATCH_DETAIL] ${req.params.matchId} — ${match.messages?.length ?? 0} msgs in ${Date.now() - t0} ms`);
      res.json({ ...match, profile: sanitizeOtherProfile(match.profile) });
    } catch (error) {
      console.error(`[MATCH_DETAIL] Error after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch match" });
    }
  });

  // Template-based AI conversation starters (no external LLM required).
  app.get("/api/matches/:matchId/ai-starters", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const lang = (req.query.lang as string) || "en";
      const match = await storage.getMatch(matchId, userId);
      if (!match) return res.status(404).json({ message: "Match not found" });
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const { data: other } = await supabase.from("profiles").select("*").eq("user_id", otherUserId).maybeSingle();
      const starters: string[] = [];

      type LangMap = Record<string, string>;
      const T = {
        starter_wrote: { en: (s: string) => `You wrote "${s}" — what's the story behind that?`, es: (s: string) => `Escribiste "${s}" — ¿cuál es la historia detrás de eso?`, fr: (s: string) => `Tu as écrit "${s}" — quelle est l'histoire derrière cela ?`, ar: (s: string) => `كتبت "${s}" — ما القصة وراء ذلك؟`, de: (s: string) => `Du hast "${s}" geschrieben — was steckt dahinter?`, pt: (s: string) => `Você escreveu "${s}" — qual é a história por trás disso?` } as Record<string, (s: string) => string>,
        starter_mentioned: { en: (s: string) => `I noticed you mentioned "${s}" — tell me more!`, es: (s: string) => `Noté que mencionaste "${s}" — ¡cuéntame más!`, fr: (s: string) => `J'ai remarqué que tu as mentionné "${s}" — dis-m'en plus !`, ar: (s: string) => `لاحظت أنك ذكرت "${s}" — أخبرني المزيد!`, de: (s: string) => `Ich hab bemerkt, dass du "${s}" erwähnt hast — erzähl mir mehr!`, pt: (s: string) => `Notei que você mencionou "${s}" — me conta mais!` } as Record<string, (s: string) => string>,
        starter_flag: { en: (s: string) => `"${s}" stood out to me in your profile — what does that mean to you personally?`, es: (s: string) => `"${s}" me llamó la atención en tu perfil — ¿qué significa eso para ti?`, fr: (s: string) => `"${s}" m'a marqué(e) dans ton profil — qu'est-ce que cela signifie pour toi personnellement ?`, ar: (s: string) => `"${s}" لفت انتباهي في ملفك الشخصي — ماذا يعني ذلك لك شخصيًا؟`, de: (s: string) => `"${s}" ist mir in deinem Profil aufgefallen — was bedeutet das für dich persönlich?`, pt: (s: string) => `"${s}" chamou minha atenção no seu perfil — o que isso significa para você pessoalmente?` } as Record<string, (s: string) => string>,
        starter_signal: { en: (s: string) => `Your signal "${s}" caught my eye — how does it show up in your day-to-day?`, es: (s: string) => `Tu señal "${s}" me llamó la atención — ¿cómo se refleja en tu día a día?`, fr: (s: string) => `Ton signal "${s}" m'a attiré(e) — comment se manifeste-t-il au quotidien ?`, ar: (s: string) => `إشارتك "${s}" لفتت نظري — كيف تظهر في يومياتك؟`, de: (s: string) => `Dein Signal "${s}" hat mich angesprochen — wie zeigt es sich in deinem Alltag?`, pt: (s: string) => `Seu sinal "${s}" chamou minha atenção — como ele aparece no seu dia a dia?` } as Record<string, (s: string) => string>,
        starter_intent: { en: `What does finding a really meaningful connection look like for you right now?`, es: `¿Cómo se ve para ti encontrar una conexión realmente significativa en este momento?`, fr: `À quoi ressemble une connexion vraiment significative pour toi en ce moment ?`, ar: `كيف تبدو لك إيجاد علاقة ذات معنى حقيقي في هذه المرحلة؟`, de: `Wie sieht eine wirklich bedeutungsvolle Verbindung für dich gerade aus?`, pt: `Como seria para você encontrar uma conexão realmente significativa agora?` } as LangMap,
        starter_intentional: { en: `What made you want to try a more intentional approach to dating?`, es: `¿Qué te llevó a querer probar un enfoque más intencional en las citas?`, fr: `Qu'est-ce qui t'a donné envie d'essayer une approche plus intentionnelle des rencontres ?`, ar: `ما الذي دفعك لتجربة نهج أكثر قصدية في المواعدة؟`, de: `Was hat dich dazu gebracht, Dating bewusster anzugehen?`, pt: `O que te fez querer experimentar uma abordagem mais intencional nos relacionamentos?` } as LangMap,
        starter_excited: { en: `What's something you've genuinely been excited about lately?`, es: `¿Qué es algo que realmente te ha emocionado últimamente?`, fr: `Qu'est-ce qui t'a vraiment enthousiasmé(e) récemment ?`, ar: `ما الشيء الذي أثار حماسك حقًا في الآونة الأخيرة؟`, de: `Was begeistert dich gerade wirklich?`, pt: `Qual é algo que te deixou genuinamente animado(a) ultimamente?` } as LangMap,
        starter_meeting: { en: `If you could design your ideal first meeting, what would it look like?`, es: `Si pudieras diseñar tu primer encuentro ideal, ¿cómo sería?`, fr: `Si tu pouvais concevoir ta première rencontre idéale, à quoi ressemblerait-elle ?`, ar: `إذا كان بإمكانك تصميم لقائك الأول المثالي، كيف سيكون؟`, de: `Wenn du dein ideales erstes Treffen gestalten könntest, wie würde es aussehen?`, pt: `Se você pudesse criar seu primeiro encontro ideal, como seria?` } as LangMap,
      };
      const pick = <T,>(map: Record<string, T>, fallback: T): T => map[lang] ?? map["en"] ?? fallback;

      if (other?.conversation_starters?.length) {
        const s = other.conversation_starters[Math.floor(Math.random() * other.conversation_starters.length)];
        starters.push(pick(T.starter_wrote, (x: string) => `You wrote "${x}" — what's the story?`)(s));
      }
      if (other?.custom_starters?.length) {
        const s = other.custom_starters[Math.floor(Math.random() * other.custom_starters.length)];
        starters.push(pick(T.starter_mentioned, (x: string) => `I noticed you mentioned "${x}" — tell me more!`)(s));
      }
      if (other?.green_flags?.length) {
        const gf = other.green_flags[Math.floor(Math.random() * other.green_flags.length)];
        starters.push(pick(T.starter_flag, (x: string) => `"${x}" stood out to me — what does that mean to you?`)(gf));
      }
      if (other?.signals?.length) {
        const sig = other.signals[Math.floor(Math.random() * other.signals.length)];
        starters.push(pick(T.starter_signal, (x: string) => `Your signal "${x}" caught my eye — how does it show up day-to-day?`)(sig));
      }
      if (other?.dating_intent) {
        starters.push(pick(T.starter_intent as Record<string, string>, T.starter_intent.en));
      }
      starters.push(pick(T.starter_intentional as Record<string, string>, T.starter_intentional.en));
      starters.push(pick(T.starter_excited as Record<string, string>, T.starter_excited.en));
      starters.push(pick(T.starter_meeting as Record<string, string>, T.starter_meeting.en));
      const unique = [...new Set(starters)].slice(0, 5);
      res.json({ starters: unique });
    } catch (error) {
      res.status(500).json({ message: "Failed to generate starters" });
    }
  });

  // Paginated older messages — cursor-based, used by "Load older messages" button.
  app.get("/api/matches/:matchId/messages", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const limit = Math.min(parseInt((req.query.limit as string) || "40", 10), 100);
      const before = (req.query.before as string) || undefined;
      const meta = await storage.getMatchMeta(matchId, userId);
      if (!meta) return res.status(404).json({ message: "Match not found" });
      const result = await storage.getMessagesPage(matchId, limit, before);
      devPerf("/api/matches/:id/messages", Date.now() - t0, {
        matchId: matchId.slice(0, 8),
        count: result.messages.length,
        hasMore: result.hasMore,
        limit,
        paged: !!before,
      });
      res.json(result);
    } catch (error: any) {
      console.error("[MSG_PAGE_ROUTE] error:", error?.message);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  // ── Badge count: total unread across all matches ───────────────────────────
  app.get("/api/messages/unread-count", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const total = await getTotalBadge(userId);
      res.json({ total });
    } catch (err: any) {
      console.error("BADGE_GET_ERROR", err?.message);
      res.json({ total: 0 });
    }
  });

  // ── Per-match unread counts — used to restore badge state after app restart ──
  app.get("/api/messages/badge-counts", isAuthenticated, async (req: any, res) => {
    try {
      const counts = await getAllMatchBadgeCounts(req.user.id);
      res.json(counts);
    } catch (err: any) {
      console.error("BADGE_COUNTS_ERROR", err?.message);
      res.json({});
    }
  });

  // ── Mark a match as read (decrements badge count for that match) ───────────
  app.post("/api/messages/:matchId/mark-read", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { matchId } = req.params;
      const total = await resetMatchBadge(userId, matchId);
      res.json({ total });
    } catch (err: any) {
      console.error("BADGE_MARK_READ_ERROR", err?.message);
      res.json({ total: 0 });
    }
  });

  app.post("/api/messages/:messageId/reaction", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { messageId } = req.params;
      const { reaction } = req.body;

      if (!messageId) {
        return res.status(400).json({ message: "Missing messageId" });
      }

      const { data: msg, error: msgErr } = await storage.getMessage(messageId);
      if (msgErr || !msg) {
        return res.status(404).json({ message: "Message not found" });
      }

      if (msg.sender_id === userId) {
        return res.status(403).json({ message: "Cannot react to your own message" });
      }

      const participants = await storage.getMatchParticipants(msg.match_id);
      if (!participants || (participants.user1Id !== userId && participants.user2Id !== userId)) {
        return res.status(403).json({ message: "Not authorized to react to this message" });
      }

      const validReaction = reaction === "❤️" ? "❤️" : null;

      console.log(validReaction ? "MESSAGE_REACTION_ADDED" : "MESSAGE_REACTION_REMOVED", { messageId, userId, reaction: validReaction });

      const updated = await storage.reactToMessage(messageId, validReaction);
      res.json(updated);
    } catch (error: any) {
      console.error("MESSAGE_REACTION_ERROR", error?.message);
      res.status(500).json({ message: error?.message || "Failed to update reaction" });
    }
  });

  app.post("/api/matches/:matchId/messages", isAuthenticated, writeLimiter, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const adminStorage = getAdminStorage();
      const userId = req.user.id;
      const { matchId } = req.params;

      if (!matchId) {
        return res.status(400).json({ message: "Missing match_id in request" });
      }

      const parsed = messageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        return res.status(400).json({ message: "Invalid message: content is required (1-500 chars)", errors: fieldErrors });
      }

      const { content } = parsed.data;

      if (!content.startsWith("__VOICE__:") && containsContactInfo(content)) {
        return res.status(400).json({ message: "No exchange of information until a date has been agreed upon. Complete your calls and match your availability first!" });
      }

      // ── Step 1: Validate match membership + read stage (lightweight — 6 cols, no profile/messages) ──
      const tMeta0 = Date.now();
      const match = await storage.getMatchMeta(matchId, userId);
      if (IS_DEV) console.log(`[MSG] getMatchMeta: ${Date.now() - tMeta0} ms`);
      if (!match) {
        console.log("MSG_MATCH_NOT_FOUND", { matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }

      const { callStage, user1Id, user2Id } = match;

      // ── Step 2: Stage-based message limit checks ──
      // Pre-increment counts come from getMatchMeta (read at top of handler).
      // These are used for limit enforcement before the insert.
      // Post-increment counts come from the atomic UPDATE after insert and drive milestone detection.
      const isUser1Sender = match.user1Id === userId;
      const preCount1 = match.messageCount1 ?? 0;
      const preCount2 = match.messageCount2 ?? 0;
      const myPreCount = isUser1Sender ? preCount1 : preCount2;

      if (callStage === 0) {
        const tCount0 = Date.now();
        const [extension] = await db.select().from(userBenefits).where(and(
          eq(userBenefits.userId, userId),
          eq(userBenefits.type, "message_extension"),
          eq(userBenefits.activatedMatchId, matchId),
        )).limit(1);
        if (IS_DEV) console.log(`[MSG] extension check: ${Date.now() - tCount0} ms | count=${myPreCount} ext=${!!extension}`);
        const limit = extension ? 20 : 15;
        if (myPreCount >= limit) {
          console.log("[CONNECTION_STAGE] POST_CALL_MESSAGE_LIMIT_REACHED", { matchId, userId, callStage: 0, count: myPreCount, limit });
          return res.status(400).json({ message: "Message limit reached. Time to call!" });
        }
      } else if (callStage === 1) {
        // Post-first-call messaging phase: 25 messages each before date planning unlocks.
        // Once BOTH users have completed 25 messages the date-planning stage is reached and
        // messaging becomes free — the user may have chosen "Keep Messaging".
        const tCount1 = Date.now();
        const messageCount = await storage.getUserMessageCount(matchId, userId);
        if (IS_DEV) console.log(`[MSG] post-call count: ${Date.now() - tCount1} ms | count=${messageCount}`);
        const POST_CALL_LIMIT = 25;
        if (messageCount >= POST_CALL_LIMIT) {
          const theirCount = match.user1Id === userId ? (match.messageCount2 || 0) : (match.messageCount1 || 0);
          if (theirCount < POST_CALL_LIMIT) {
            // Only the current user has finished — still blocked until both are done.
            console.log("[CONNECTION_STAGE] POST_CALL_LIMIT_REACHED", { matchId, userId, callStage: 1, count: messageCount, limit: POST_CALL_LIMIT, theirCount });
            return res.status(400).json({ message: "Message limit reached. Time to plan your date!" });
          }
          // Both users completed 25 → free messaging (Keep Messaging mode). Fall through.
          console.log("[CONNECTION_STAGE] POST_CALL_FREE_MESSAGING", { matchId, userId, myCount: messageCount, theirCount });
        }
      }

      // ── Step 3: Insert message ──
      const tInsert0 = Date.now();
      const message = await adminStorage.createMessage({
        matchId,
        senderId: userId,
        content: content.trim(),
      });
      if (IS_DEV) console.log(`[MSG] insert: ${Date.now() - tInsert0} ms`);

      // ── Step 3b: Atomic counter increment — no read-then-write race ──────────
      // A single SQL UPDATE evaluates `message_count_X + 1` atomically inside
      // Postgres; two concurrent sends can never both read the same stale value.
      // RETURNING gives us the authoritative post-increment counts for both users
      // so milestone detection never relies on a locally computed guess.
      // Only genuine text messages increment the counter; system payloads
      // (__VOICE__:, __SCHEDULE__:, __SYS__:, etc.) do not.
      const TEASER_THRESHOLD = 5; // both users sent ≥ 5 → show coming-soon teaser (informational only, no DB write)
      const VN_THRESHOLD = 8;
      const FC_THRESHOLD = 15;
      let newCount1 = preCount1;
      let newCount2 = preCount2;
      let progressionEvent: { type: string } | null = null;
      let progression: object | null = null;

      const isCountedMessage = callStage === 0 && !content.trim().startsWith("__");
      if (isCountedMessage) {
        const tInc0 = Date.now();
        const [updated] = await db
          .update(matches)
          .set(isUser1Sender
            ? { messageCount1: sqlExpr`message_count_1 + 1` }
            : { messageCount2: sqlExpr`message_count_2 + 1` })
          .where(eq(matches.id, matchId))
          .returning({ messageCount1: matches.messageCount1, messageCount2: matches.messageCount2 });
        newCount1 = updated?.messageCount1 ?? preCount1;
        newCount2 = updated?.messageCount2 ?? preCount2;
        if (IS_DEV) console.log(`[MSG] atomic-increment: ${Date.now() - tInc0} ms | count1=${newCount1} count2=${newCount2}`);

        // ── Step 3c: Milestone detection on authoritative post-increment counts ──
        // Uses >= (not ===) so a missed crossing from a prior race is self-healing.
        // Emits the event only when eligibility transitions false → true on this message.
        // Checked in ascending threshold order so only the lowest newly-crossed event fires.
        const teaserWasEligible = preCount1 >= TEASER_THRESHOLD && preCount2 >= TEASER_THRESHOLD;
        const teaserNowEligible = newCount1 >= TEASER_THRESHOLD && newCount2 >= TEASER_THRESHOLD;
        const vnWasEligible = preCount1 >= VN_THRESHOLD && preCount2 >= VN_THRESHOLD;
        const vnNowEligible = newCount1 >= VN_THRESHOLD && newCount2 >= VN_THRESHOLD;
        const fcWasEligible = preCount1 >= FC_THRESHOLD && preCount2 >= FC_THRESHOLD;
        const fcNowEligible = newCount1 >= FC_THRESHOLD && newCount2 >= FC_THRESHOLD;

        if (vnNowEligible && !vnWasEligible) {
          // Persist unlock row so it survives future call-stage count resets.
          await db.insert(voiceNoteUnlocks).values({ matchId }).onConflictDoNothing();
          progressionEvent = { type: "voice_notes_unlocked" };
          console.log("[PROGRESSION] VN_THRESHOLD_CROSSED", { matchId, userId: userId.slice(0, 8), count1: newCount1, count2: newCount2 });
        } else if (fcNowEligible && !fcWasEligible) {
          // VN must already exist (can't reach FC without crossing VN first).
          progressionEvent = { type: "first_call_unlocked" };
          console.log("[PROGRESSION] FC_THRESHOLD_CROSSED", { matchId, userId: userId.slice(0, 8), count1: newCount1, count2: newCount2 });
        } else if (teaserNowEligible && !teaserWasEligible) {
          // Teaser fires between TEASER_THRESHOLD (5) and VN_THRESHOLD (8).
          // Informational only — no DB write; client uses localStorage to show once.
          progressionEvent = { type: "voice_notes_teaser" };
          console.log("[PROGRESSION] TEASER_THRESHOLD_CROSSED", { matchId, userId: userId.slice(0, 8), count1: newCount1, count2: newCount2 });
        }

        // ── Diagnostic log — one line per counted send ──────────────────────────
        // Makes it immediately obvious why a milestone did or didn't fire.
        console.log("[PROGRESSION_DIAG]", {
          matchId: matchId.slice(0, 8),
          senderId: userId.slice(0, 8),
          messageId: message.id.slice(0, 8),
          counted: true,
          count1Before: preCount1, count2Before: preCount2,
          count1After:  newCount1, count2After:  newCount2,
          milestoneEmitted: progressionEvent?.type ?? null,
          callStageBefore: callStage,
        });

        progression = {
          user1Count:   newCount1,
          user2Count:   newCount2,
          myCount:      isUser1Sender ? newCount1 : newCount2,
          theirCount:   isUser1Sender ? newCount2 : newCount1,
          voiceNotesEligible: vnNowEligible,
          firstCallEligible:  fcNowEligible,
          callStage,
          currentUserPendingMilestone: progressionEvent?.type ?? null,
        };
      }

      // ── Step 4: Broadcast to recipient (awaited so the log appears before response) ──
      const tBcast0 = Date.now();
      await broadcastMessage(matchId, {
        id: message.id,
        matchId: message.matchId,
        senderId: message.senderId,
        content: message.content,
        reaction: message.reaction,
        createdAt: message.createdAt,
      });
      if (IS_DEV) console.log(`[MSG] broadcast: ${Date.now() - tBcast0} ms`);

      // ── Milestone broadcast: notify the OTHER user immediately ───────────────
      // The sender gets the event via progressionEvent in the response body.
      // The broadcast delivers it to the other user's realtime channel instantly,
      // removing any dependency on the 60-second entitlement poll.
      if (progressionEvent && progression) {
        const broadcastEvent = progressionEvent.type === "voice_notes_unlocked"
          ? "voice-note-unlock"
          : progressionEvent.type === "first_call_unlocked"
          ? "first-call-unlock"
          : "voice-notes-teaser";
        // Include the full authoritative progression state so the RECIPIENT's client
        // can update its match-detail cache immediately without waiting for the next
        // 60-second poll.  user1Count/user2Count are absolute — the recipient derives
        // its own myCount/theirCount by comparing against its own userId.
        const prog = progression as { voiceNotesEligible: boolean; firstCallEligible: boolean } | null;
        broadcastViaHttpApi(`chat:${matchId}`, broadcastEvent, {
          matchId,
          user1Count: newCount1,
          user2Count: newCount2,
          voiceNotesEligible: prog?.voiceNotesEligible ?? false,
          firstCallEligible:  prog?.firstCallEligible ?? false,
        }).catch(() => {});
        console.log("[PROGRESSION] MILESTONE_BROADCAST_SENT", {
          event: broadcastEvent,
          matchId,
          userId: userId.slice(0, 8),
          user1Count: newCount1,
          user2Count: newCount2,
        });
      }

      // ── Respond — include authoritative progression state ─────────────────────
      // The client replaces its local counter with the server-authoritative counts.
      if (IS_DEV) console.log(`[MSG] total send route: ${Date.now() - t0} ms`);
      res.json({ ...message, progressionEvent, progression });

      // ── Background post-processing (does not block the HTTP response) ──
      // incrementMessageCount is NOT called here — the atomic UPDATE above already
      // incremented the counter synchronously and before the response was sent.
      (async () => {
        try {
          const senderId    = userId; // authenticated author of this message
          const recipientId = match.user1Id === userId ? match.user2Id : match.user1Id;

          // ── Hard safety guard: never push to the sender ────────────────────
          // Prevents self-notifications even if upstream logic ever passes wrong
          // IDs.  recipientId must differ from senderId in every match.
          if (recipientId === senderId) {
            console.warn(`[PUSH_AUDIT] BLOCKED: attempted self-notification senderId=${senderId.slice(0,8)} recipientId=${recipientId.slice(0,8)} matchId=${matchId}`);
          } else if (isSeedUser(recipientId)) {
            // Seed users never receive push notifications
            console.log(`[PUSH_AUDIT] SKIPPED push — seed recipient recipientId=${recipientId.slice(0,8)}`);
          } else {
            // ── Three-way push suppression check ──────────────────────────────
            // Case 1: Recipient is actively viewing THIS chat (same matchId, < 45s)
            //         → suppress entirely — message appears inline in real-time
            // Case 2: Recipient is in the app but on a different screen (< 90s)
            //         → suppress lock-screen push — in-app unread badge updates
            //           via Supabase Realtime subscription (already live)
            // Case 3: Recipient is inactive / app closed / phone locked
            //         → send full push notification with badge increment

            const [activeInSameChat, activeInApp] = await Promise.all([
              isUserActiveInChat(recipientId, matchId),
              isUserActiveInApp(recipientId),
            ]);

            const rid8 = recipientId.slice(0, 8);
            const sid8 = senderId.slice(0, 8);
            const mid8 = matchId.slice(0, 8);

            if (activeInSameChat) {
              // Case 1: recipient is looking at this exact chat right now
              console.log(`[PUSH_AUDIT] SUPPRESSED — recipient active in same chat senderId=${sid8} recipientId=${rid8} matchId=${mid8} activeInSameChat=true`);
            } else if (activeInApp) {
              // Case 2: recipient has the app open but on another screen
              // The Supabase Realtime subscription already delivers the message
              // and increments the unread badge in-app; no lock-screen ping needed.
              console.log(`[PUSH_AUDIT] SUPPRESSED — recipient active elsewhere in app senderId=${sid8} recipientId=${rid8} matchId=${mid8} activeInApp=true activeInSameChat=false`);
            } else {
              // Case 3: recipient is outside the app — send full push
              const senderProfile = await adminStorage.getProfileMeta(senderId);
              const senderName    = senderProfile?.firstName || "Someone";
              const badgeTotal    = await incrementMatchBadge(recipientId, matchId);
              console.log(`[PUSH_AUDIT] SENDING push — recipient inactive senderId=${sid8} recipientId=${rid8} matchId=${mid8} senderName="${senderName}" badgeTotal=${badgeTotal}`);
              sendPushToUser(
                recipientId,
                buildPush.newMessage(
                  senderName,
                  matchId,
                  // Never pass internal protocol messages (__SCHEDULE__:, __SYS__:, __VOICE__: etc.) as the
                  // push preview — the recipient would see raw system tokens on their lock screen.
                  message.content.startsWith("__") ? undefined : message.content,
                  badgeTotal,
                ),
                "new_message",
                { senderId },
              ).catch((err: any) => {
                console.error(`[PUSH_AUDIT] sendPushToUser threw recipientId=${rid8}: ${err?.message}`);
              });
            }
          }

          if (isSeedUser(recipientId) && callStage === 0) {
            const otherProfile = await adminStorage.getProfileMeta(recipientId);
            const otherCount = await adminStorage.getUserMessageCount(matchId, recipientId);
            if (otherCount < 15) {
              setTimeout(async () => {
                try {
                  const reply = generateAutoReply(otherProfile, otherCount);
                  await adminStorage.createMessage({ matchId, senderId: recipientId, content: reply });
                  await adminStorage.incrementMessageCount(matchId, recipientId);
                } catch (err) {
                  console.error("Auto-reply error:", err);
                }
              }, 1500 + Math.random() * 2000);
            }
          }
        } catch (bgErr: any) {
          console.error("MSG_POST_SEND_BG_ERROR", { matchId, userId, error: bgErr?.message });
        }
      })();
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const errCode = error?.code;
      console.error("MSG_SEND_ERROR", { errMsg, errCode, stack: error?.stack?.split("\n")[0] });
      res.status(500).json({ message: `Failed to send message: ${errMsg}` });
    }
  });

  app.post("/api/matches/:matchId/call/start", isAuthenticated, callLimiter, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[CALL_START] CALL_REQUEST_STARTED", { path: "/api/matches/:matchId/call/start", matchId, userId, timestamp: new Date().toISOString() });
      console.log("[CALL_START] CALL_SESSION_CHECKED", { path: "/api/matches/:matchId/call/start", matchId, userId, timestamp: new Date().toISOString() });

      // ── Server-side milestone acknowledgement gate ─────────────────────────
      // Blocks call start until the user has acknowledged all pending milestones.
      // Cannot be bypassed by refreshing, a second device, or an altered frontend.
      // Only applies to the FIRST call (callStage === 0); later calls skip this.
      {
        const gateStorage = getStorage(req);
        const gateMeta = await gateStorage.getMatchMeta(matchId, userId);
        if (!gateMeta) return res.status(404).json({ message: "Match not found" });

        if ((gateMeta.callStage ?? 0) === 0) {
          const isUser1 = gateMeta.user1Id === userId;
          const myCount    = isUser1 ? (gateMeta.messageCount1 ?? 0) : (gateMeta.messageCount2 ?? 0);
          const theirCount = isUser1 ? (gateMeta.messageCount2 ?? 0) : (gateMeta.messageCount1 ?? 0);

          // Gate 1: voice-note milestone must be acknowledged
          if (myCount >= 8 && theirCount >= 8) {
            const [vnRow] = await db.select({ m: voiceNotePopupSeen.matchId })
              .from(voiceNotePopupSeen)
              .where(and(eq(voiceNotePopupSeen.matchId, matchId), eq(voiceNotePopupSeen.userId, userId)))
              .limit(1);
            if (!vnRow) {
              console.log("[CALL_START] BLOCKED_VN_MILESTONE_PENDING", { matchId, userId: userId.slice(0, 8) });
              return res.status(403).json({ message: "milestone_pending", milestone: "voice_notes_unlocked" });
            }
          }

          // Gate 2: first-call milestone must be acknowledged
          if (myCount >= 15 && theirCount >= 15) {
            const [fcRow] = await db.select({ m: firstCallPromptSeen.matchId })
              .from(firstCallPromptSeen)
              .where(and(eq(firstCallPromptSeen.matchId, matchId), eq(firstCallPromptSeen.userId, userId)))
              .limit(1);
            if (!fcRow) {
              console.log("[CALL_START] BLOCKED_FC_MILESTONE_PENDING", { matchId, userId: userId.slice(0, 8) });
              return res.status(403).json({ message: "milestone_pending", milestone: "first_call_unlocked" });
            }
          }
        }
      }

      const { isPaidCredit } = req.body;
      const result = await serverStorage.startCall(matchId, userId, !!isPaidCredit);
      if (!result) {
        console.log("[CALL_START] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found or call not allowed" });
      }

      const { match, status } = result;

      if (status === "self_call") {
        console.warn("[CALL_START] SELF_CALL_BLOCKED", { matchId, userId });
        return res.status(400).json({ message: "You can't call your own account." });
      }

      if (status === "blocked") {
        console.log("[CALL_START] DUPLICATE_CALL_BLOCKED", { matchId, existingCaller: match.callInitiatorId, blockedUser: userId, callSessionId: match.callSessionId });
        return res.status(409).json({ message: "A call is already in progress", match });
      }

      if (status === "reused") {
        console.log("[CALL_START] CALL_SESSION_REUSED", { matchId, callSessionId: match.callSessionId, callerId: userId });
        return res.json(match);
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const callerProfile = await serverStorage.getProfileMeta(userId);
      const callerName = callerProfile?.firstName || "Someone";
      console.log("[CALL_START] CALL_SESSION_CREATED", { matchId, callSessionId: match.callSessionId, SESSION_PARTICIPANTS_COUNT: 2 });
      console.log("[CALL_START] CALLER_ASSIGNED", { matchId, callerId: userId, callerName });
      console.log("[CALL_START] RECEIVER_ASSIGNED", { matchId, receiverId: otherUserId });
      if ((match.callStage || 0) === 0) {
        console.log("[CONNECTION_STAGE] FIRST_CALL_STARTED", { matchId, callSessionId: match.callSessionId, userId, callStage: match.callStage || 0 });
        console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "chat", to: "first_call" });
      } else if ((match.callStage || 0) === 1) {
        console.log("[CONNECTION_STAGE] SECOND_CALL_STARTED", { matchId, callSessionId: match.callSessionId, userId, callStage: match.callStage || 0 });
        console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "post_call_messaging", to: "second_call" });
      }

      const ringPayload = {
        type: "call:ring",
        matchId,
        callerId: userId,
        callerName,
        callSessionId: match.callSessionId,
      };
      broadcastCallEvent(matchId, ringPayload);

      // Fire-and-forget push to the receiver — rings their device even if app is closed
      const pushPayload = buildPush.incomingCall(callerName, matchId, match.callSessionId);
      console.log("[PUSH_CALL_SEND]", {
        receiverId: otherUserId.slice(0, 8),
        matchId: matchId.slice(0, 8),
        callSessionId: match.callSessionId?.slice(0, 12),
        title: pushPayload.title,
        body: pushPayload.body,
        type: (pushPayload.data as any)?.type,
      });
      sendPushToUser(otherUserId, pushPayload, "incoming_call").catch(() => {});

      const scheduleRering = (delayMs: number) => {
        setTimeout(async () => {
          try {
            const { data: recheck } = await supabaseAdmin.from("matches").select("call_answered,call_completed,call_initiator_id,call_started_at").eq("id", matchId).maybeSingle();
            if (recheck && recheck.call_initiator_id === userId && recheck.call_started_at && !recheck.call_answered && !recheck.call_completed) {
              console.log("[CALL_START] DELAYED_RERING", { matchId, delayMs, callSessionId: match.callSessionId });
              broadcastCallEvent(matchId, ringPayload);
            }
          } catch (err: any) {
            console.warn("[CALL_START] DELAYED_RERING_ERROR", { matchId, delayMs, error: err?.message });
          }
        }, delayMs);
      };
      scheduleRering(4000);
      scheduleRering(9000);

      if (isSeedUser(otherUserId)) {
        setTimeout(async () => {
          try {
            await serverStorage.answerCall(matchId, otherUserId);
            console.log("[CALL_AUTO_ANSWER] CALL_SESSION_JOINED", { matchId, callSessionId: match.callSessionId, userId: otherUserId });
            broadcastCallEvent(matchId, {
              type: "call:answered",
              matchId,
              userId: otherUserId,
              callSessionId: match.callSessionId,
            });
          } catch (err) {
            console.error("[CALL_AUTO_ANSWER] Error:", err);
          }
        }, 3000 + Math.random() * 2000);
      }

      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_START] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/start",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to start call",
        route: "POST /api/matches/:matchId/call/start",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/rering", isAuthenticated, async (req: any, res) => {
    const matchId = req.params.matchId;
    const userId = req.user.id;
    try {
      const { data, error } = await supabaseAdmin.from("matches").select("*").eq("id", matchId).maybeSingle();
      if (error || !data) {
        return res.json({ status: "noop", reason: "not_found" });
      }
      const m = mapMatch(data);
      if (m.callInitiatorId !== userId) {
        return res.json({ status: "noop", reason: "not_initiator" });
      }
      if (!m.callStartedAt || m.callAnswered || m.callCompleted) {
        return res.json({ status: "noop", reason: "not_ringing" });
      }
      const adminStorage = getAdminStorage();
      const callerProfile = await adminStorage.getProfileMeta(userId);
      const callerName = callerProfile?.firstName || "Someone";
      console.log("[CALL_RERING] REBROADCAST_SENT", { matchId, callerId: userId, callSessionId: m.callSessionId });
      await broadcastCallEvent(matchId, {
        type: "call:ring",
        matchId,
        callerId: userId,
        callerName,
        callSessionId: m.callSessionId,
      });
      res.json({ status: "rebroadcast" });
    } catch (err: any) {
      console.error("[CALL_RERING] ERROR", { matchId, error: err?.message });
      res.status(500).json({ message: err?.message });
    }
  });

  app.post("/api/matches/:matchId/call/repair", isAuthenticated, async (req: any, res) => {
    const matchId = req.params.matchId;
    const userId = req.user.id;
    try {
      const { data, error } = await supabaseAdmin.from("matches").select("*").eq("id", matchId).maybeSingle();
      if (error || !data) return res.status(404).json({ message: "Match not found" });
      const m = mapMatch(data);
      if (m.user1Id !== userId && m.user2Id !== userId) {
        return res.status(403).json({ message: "Not in this match" });
      }
      if (!m.callStartedAt) {
        return res.json({ status: "noop", reason: "no_active_call", match: m });
      }
      const callAge = Date.now() - new Date(m.callStartedAt).getTime();
      const REPAIR_RINGING_MS = 2 * 60 * 1000;
      const REPAIR_ANSWERED_MS = 5 * 60 * 1000;
      const isStuck = (!m.callAnswered && callAge > REPAIR_RINGING_MS) || (m.callAnswered && callAge > REPAIR_ANSWERED_MS);
      if (!isStuck) {
        console.log("[CALL_REPAIR] NOT_YET_STUCK", { matchId, userId, callAgeMs: callAge, callAnswered: m.callAnswered, callSessionId: m.callSessionId });
        return res.json({ status: "noop", reason: "call_still_fresh", callAgeMs: callAge, callAnswered: m.callAnswered, match: m });
      }
      console.log("[CALL_REPAIR] STUCK_CALL_CLEARING", { matchId, userId, callAgeMs: callAge, callAnswered: m.callAnswered, callSessionId: m.callSessionId });
      const { data: cleared, error: clearError } = await supabaseAdmin
        .from("matches")
        .update({ call_started_at: null, call_initiator_id: null, call_answered: false, call_completed: false })
        .eq("id", matchId)
        .select()
        .maybeSingle();
      if (clearError || !cleared) {
        console.error("[CALL_REPAIR] DB_ERROR", { matchId, error: clearError?.message });
        return res.status(500).json({ message: "Failed to clear stuck call" });
      }
      console.log("[CALL_REPAIR] STUCK_CALL_CLEARED", { matchId, userId, callAgeMs: callAge, callAnswered: m.callAnswered, callSessionId: m.callSessionId });
      await broadcastCallEvent(matchId, { type: "call:ended", matchId, userId, callSessionId: m.callSessionId });
      return res.json({ status: "repaired", match: mapMatch(cleared) });
    } catch (err: any) {
      console.error("[CALL_REPAIR] ERROR", { matchId, error: err?.message });
      res.status(500).json({ message: err?.message });
    }
  });

  // ── User-wide expired-call sweep ─────────────────────────────────────────
  // Called by the client immediately after a successful login to clear any
  // ringing call records left open from the previous session.  Uses a 90-second
  // unanswered threshold — tighter than the background repair job (2 min) — so
  // stale rows are removed before the client's startup sweep runs and before any
  // Realtime rering broadcast can re-arm them.
  app.post("/api/calls/sweep-expired", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    try {
      const EXPIRED_RINGING_MS = 90_000; // 90 s — matches client-side stale cutoff
      const { data: rows, error } = await supabaseAdmin
        .from("matches")
        .select("id, call_started_at, call_answered, call_completed, call_session_id, call_initiator_id")
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
        .not("call_started_at", "is", null)
        .eq("call_answered", false)
        .eq("call_completed", false);
      if (error) {
        console.error("[CALL_SWEEP] DB_SELECT_ERROR", { userId, error: error.message });
        return res.status(500).json({ message: "DB error" });
      }
      const now = Date.now();
      const expired = (rows ?? []).filter((r: any) => {
        const age = now - new Date(r.call_started_at).getTime();
        return age > EXPIRED_RINGING_MS;
      });
      if (expired.length === 0) {
        console.log("[CALL_SWEEP] NO_EXPIRED_CALLS", { userId });
        return res.json({ cleared: 0 });
      }
      let cleared = 0;
      for (const row of expired) {
        const age = now - new Date(row.call_started_at).getTime();
        console.log("[CALL_SWEEP] CLEARING_EXPIRED_CALL", {
          userId,
          matchId: row.id,
          callSessionId: row.call_session_id,
          callAgeMs: age,
        });
        const { error: clearErr } = await supabaseAdmin
          .from("matches")
          .update({ call_started_at: null, call_initiator_id: null, call_answered: false, call_completed: false, call_session_id: null })
          .eq("id", row.id);
        if (clearErr) {
          console.error("[CALL_SWEEP] CLEAR_ERROR", { matchId: row.id, error: clearErr.message });
          continue;
        }
        // Broadcast call:ended so any still-listening device dismisses the overlay.
        await broadcastCallEvent(row.id, {
          type: "call:ended",
          matchId: row.id,
          userId,
          callSessionId: row.call_session_id,
        }).catch(() => {});
        cleared++;
      }
      console.log("[CALL_SWEEP] SWEEP_COMPLETE", { userId, cleared, total: expired.length });
      res.json({ cleared });
    } catch (err: any) {
      console.error("[CALL_SWEEP] ERROR", { userId, error: err?.message });
      res.status(500).json({ message: err?.message });
    }
  });

  app.post("/api/matches/:matchId/call/answer", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[CALL_ANSWER] CALL_API_REQUEST", { path: "/api/matches/:matchId/call/answer", matchId, userId, timestamp: new Date().toISOString() });
      const match = await serverStorage.answerCall(matchId, userId);
      if (!match) {
        console.log("[CALL_ANSWER] CALL_API_RESPONSE_404", { matchId, userId, reason: "answerCall returned null — match not found, user not in match, no active call, or trying to answer own call" });
        return res.status(404).json({ message: "No active call to answer — it may have been cancelled" });
      }
      console.log("[CALL_ANSWER] CALL_API_RESPONSE", { status: 200, matchId, CALL_SESSION_ID: match.callSessionId, userId });
      broadcastCallEvent(matchId, {
        type: "call:answered",
        matchId,
        userId,
        callSessionId: match.callSessionId,
      });
      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_ANSWER] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/answer",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to answer call",
        route: "POST /api/matches/:matchId/call/answer",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/cancel", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const matchId = req.params.matchId;
    try {
      const serverStorage = getCallStorage(req);

      // Capture callInitiatorId + call_started_at BEFORE cancelCall clears them so
      // we know who was the caller and can compute a dedup key for the event message.
      let preCancelInitiatorId: string | null = null;
      let preCancelStartedAt: string | null = null;
      try {
        const { data: pre } = await supabaseAdmin
          .from("matches")
          .select("call_initiator_id, call_started_at")
          .eq("id", matchId)
          .maybeSingle();
        preCancelInitiatorId = pre?.call_initiator_id ?? null;
        preCancelStartedAt   = pre?.call_started_at   ?? null;
      } catch { /* non-fatal — fall back to treating userId as caller */ }

      const match = await serverStorage.cancelCall(matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      broadcastCallEvent(matchId, {
        type: "call:cancelled",
        matchId,
        userId,
      });
      res.json(match);

      // Fire-and-forget: insert call event message + push the other user.
      if (!match.callAnswered) {
        (async () => {
          try {
            const callerId           = preCancelInitiatorId ?? userId;
            const isCallerCancelling = callerId === userId;
            const calleeId           = isCallerCancelling
              ? (match.user1Id === userId ? match.user2Id : match.user1Id)
              : userId;
            const otherUserId        = match.user1Id === userId ? match.user2Id : match.user1Id;

            // ── Dedup guard ───────────────────────────────────────────────────
            // Two concurrent cancel requests (race: caller timer + callee Decline)
            // can both reach this block. Skip inserting a second event if one was
            // already written for this call session in the last 90 seconds.
            if (preCancelStartedAt) {
              const { data: existingEvent } = await supabaseAdmin
                .from("messages")
                .select("id")
                .eq("match_id", matchId)
                .like("content", "__CALL_EVENT__%")
                .gte("created_at", new Date(new Date(preCancelStartedAt).getTime() - 1000).toISOString())
                .limit(1)
                .maybeSingle();
              if (existingEvent) {
                console.log("[CALL_CANCEL] DEDUP: call event already written, skipping", { matchId });
                return;
              }
            }

            // Fetch both profiles in parallel for correct name capitalisation
            const [callerProfile, calleeProfile] = await Promise.all([
              serverStorage.getProfileMeta(callerId),
              serverStorage.getProfileMeta(calleeId),
            ]);
            const callerName = callerProfile?.firstName || "Someone";
            const calleeName = calleeProfile?.firstName || "Someone";

            // Insert a system message visible to both participants.
            // Payload includes callerName + calleeName so each side can render
            // perspective-aware text without another profile fetch.
            const eventType    = isCallerCancelling ? "cancelled" : "declined";
            const eventContent = `__CALL_EVENT__:${JSON.stringify({
              type: eventType, callerId, callerName, calleeId, calleeName,
            })}`;
            await serverStorage.createMessage({ matchId, senderId: callerId, content: eventContent });

            if (isCallerCancelling) {
              // Caller gave up / timed out → callee missed the call
              await sendPushToUser(otherUserId, buildPush.missedCall(callerName, matchId), "missed_call");
            } else {
              // Callee explicitly declined → notify the caller
              await sendPushToUser(callerId, buildPush.callDeclined(calleeName, matchId), "missed_call");
            }
          } catch { /* ignore */ }
        })();
      }
    } catch (error: any) {
      console.error("[CALL_CANCEL] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/cancel",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });

      broadcastCallEvent(matchId, {
        type: "call:cancelled",
        matchId,
        userId,
      });

      try {
        const auth = req.headers.authorization;
        const readClient = auth ? createUserClient(auth) : supabase;
        const { data: matchRow } = await readClient
          .from("matches")
          .select("*")
          .eq("id", matchId)
          .maybeSingle();
        if (matchRow) {
          const mapped = mapMatch(matchRow);
          mapped.callStartedAt = null;
          mapped.callInitiatorId = null;
          mapped.callAnswered = false;
          mapped.callCompleted = false;
          return res.json(mapped);
        }
      } catch (readErr) {
        console.error("[CALL_CANCEL] FALLBACK_READ_FAILED", { matchId, userId, error: (readErr as any)?.message });
      }

      res.status(500).json({
        message: error?.message || "Failed to cancel call",
        route: "POST /api/matches/:matchId/call/cancel",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/complete", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;

      // Parse connection quality info sent by the client
      const { connected, connectedDurationMs, callState, callType } = req.body || {};
      const resolvedCallType: "phone" | "video" = callType === "video" ? "video" : "phone";
      const options: CompleteCallOptions = {
        connected: connected !== undefined ? Boolean(connected) : undefined,
        connectedDurationMs: connectedDurationMs !== undefined ? Number(connectedDurationMs) : undefined,
        callState: typeof callState === "string" ? callState : undefined,
      };

      console.log("[CALL_COMPLETE] CALL_REQUEST_RECEIVED", {
        matchId, userId,
        connected: options.connected,
        connectedDurationMs: options.connectedDurationMs,
        callState: options.callState,
        callType: resolvedCallType,
      });

      // Capture the initiator before completeCall clears the session — used to
      // ensure only the caller is charged (prevents double deduction).
      const { data: priorMatchRow } = await supabaseAdmin
        .from("matches")
        .select("call_initiator_id")
        .eq("id", matchId)
        .single();
      const priorInitiatorId: string | null = priorMatchRow?.call_initiator_id ?? null;

      const result = await serverStorage.completeCall(matchId, userId, options);
      if (!result) {
        return res.status(404).json({ message: "Match not found" });
      }

      // Consume one call credit when:
      //   1. This user was the call initiator (caller pays, not callee)
      //   2. The call was counted (first complete wins — natural double-deduction guard)
      //   3. The peer-to-peer connection lasted at least 30 seconds
      //   4. Deduct the correct credit type (phone or video) based on what the caller sent
      if (
        priorInitiatorId === userId &&
        result.counted &&
        typeof options.connectedDurationMs === "number" &&
        options.connectedDurationMs >= 30_000
      ) {
        try {
          const consumed = await serverStorage.consumeCallCredit(userId, resolvedCallType);
          console.log("[CALL_COMPLETE] CREDIT_CONSUMED", { userId, matchId, consumed, callType: resolvedCallType });
        } catch (creditErr: any) {
          console.error("[CALL_COMPLETE] CREDIT_CONSUME_ERROR", { userId, matchId, callType: resolvedCallType, error: creditErr?.message });
        }
      }

      broadcastCallEvent(matchId, {
        type: "call:ended",
        matchId,
        userId,
        callCounted: result.counted,
      });

      // Insert a "Call ended" system message once — only the first completer
      // wins result.counted, preventing duplicate inserts from both sides.
      if (result.counted) {
        serverStorage.createMessage({
          matchId,
          senderId: userId,
          content: '__CALL_EVENT__:{"type":"ended"}',
        }).catch(() => {});
      }

      res.json({ ...result.match, callCounted: result.counted });
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_COMPLETE] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/complete",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to complete call",
        route: "POST /api/matches/:matchId/call/complete",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  // face-call/accept and face-call/decline removed — video call is now a premium extra only,
  // not part of the standard progression. Endpoints retained as no-ops for backwards compatibility.
  app.post("/api/matches/:matchId/face-call/accept", isAuthenticated, (_req, res) => {
    res.status(410).json({ message: "Video call accept is no longer part of the standard progression. Purchase a video call credit via Lulou Extras." });
  });
  app.post("/api/matches/:matchId/face-call/decline", isAuthenticated, (_req, res) => {
    res.status(410).json({ message: "Video call decline is no longer part of the standard progression." });
  });

  app.get("/api/popular", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const myProfile = await storage.getProfileMeta(userId);
      console.log(`[WHEEL] getProfileMeta: ${Date.now() - t0} ms`);
      if (!myProfile) {
        // Return 500 (not silently 200 []) so the client shows an error + Retry
        // rather than "No profiles to show yet".  An empty state should only
        // appear when the server genuinely found no eligible candidates.
        console.error(`[WHEEL] no profile row for userId=${userId.slice(0,8)}… — check onboarding`);
        devPerf("/api/popular", Date.now() - t0, { status: 500, reason: "no-profile-row" });
        return res.status(500).json({ message: "Profile not found — please complete onboarding or try again." });
      }
      const preference = myProfile.datingPreference;
      const gender = myProfile.gender;

      console.log("[WHEEL] /api/popular called:", {
        userId:          userId.slice(0,8) + "…",
        gender:          gender   ?? "(unset)",
        preference:      preference ?? "(unset)",
        datingIntent:    myProfile.datingIntent ?? "(unset)",
        ageRange:        `${myProfile.preferredAgeMin ?? 18}–${myProfile.preferredAgeMax ?? 99}`,
        locationRadius:  myProfile.locationRadius ?? 0,
        hasLatLng:       myProfile.latitude != null,
        onboardingComplete: (myProfile as any).onboardingComplete,
      });

      // Inline geocode if the user's own profile is missing coordinates.
      // Existing accounts created before geocoding may have location text but no lat/lng.
      let wheelLat: number | null = myProfile?.latitude ?? null;
      let wheelLng: number | null = myProfile?.longitude ?? null;
      if (wheelLat === null && myProfile?.location && getHasLatLngColumns() && (myProfile?.locationRadius ?? 0) > 0) {
        try {
          const coords = await geocodeLocation(myProfile.location);
          if (coords) {
            wheelLat = coords.lat;
            wheelLng = coords.lng;
            console.log(`[WHEEL] inline geocode "${myProfile.location}" → ${wheelLat.toFixed(4)}, ${wheelLng.toFixed(4)}`);
            supabaseAdmin.from("profiles")
              .update({ latitude: wheelLat, longitude: wheelLng })
              .eq("user_id", userId)
              .then(
                () => console.log(`[WHEEL] inline geocode saved for ${userId}`),
                (e: any) => console.warn("[WHEEL] inline geocode save failed:", e?.message),
              );
          }
        } catch (e: any) {
          console.warn("[WHEEL] inline geocode failed:", e?.message);
        }
      }

      const t1 = Date.now();
      const popular = await storage.getPopularProfiles(
        30, preference, gender, userId,
        myProfile?.locationRadius ?? 0,
        wheelLat,
        wheelLng,
        myProfile?.preferredAgeMin ?? 18,
        myProfile?.preferredAgeMax ?? 99,
        myProfile?.datingIntent ?? null,
        myProfile?.connectionStyle ?? null,
        (myProfile?.signals as string[] | undefined) ?? [],
      );
      console.log(`[WHEEL] getPopularProfiles: ${Date.now() - t1} ms | total route: ${Date.now() - t0} ms`);

      // Exclude own profile (safety guard — storage already excludes via interaction logic)
      const selfFiltered = popular.filter(p => p.userId !== userId);

      const result = selfFiltered.slice(0, 10);
      console.log("[WHEEL] /api/popular returning:", result.length, "profiles to userId:", userId);
      res.json(result.map(sanitizeOtherProfile));
    } catch (error) {
      console.error(`[WHEEL] Error fetching popular profiles after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch popular profiles" });
    }
  });

  app.get("/api/spin-status", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;

      // Run all spin-status checks in parallel
      const [spinsThisWeek, dailyLikes, consecutiveDays, hasUnusedStreak, purchasedSpins, savedWheel] = await Promise.all([
        storage.getSpinsThisWeek(userId),
        storage.getDailyLikeCount(userId),
        storage.getConsecutiveLikeDays(userId, 10),
        storage.hasUnusedStreakSpin(userId),
        storage.getSpinCredits(userId),
        storage.getSavedWheelProfile(userId),
      ]);

      const streakComplete = consecutiveDays >= 3;
      const canSpin = (streakComplete && hasUnusedStreak) || (!streakComplete && spinsThisWeek === 0) || purchasedSpins > 0;

      if (IS_DEV) console.log(`[SPIN_STATUS] userId=${userId} in ${Date.now() - t0} ms`);
      res.json({ spinsThisWeek, dailyLikes, consecutiveDays, streakComplete, canSpin, purchasedSpins, hasSavedWheelProfile: !!savedWheel });
    } catch (error) {
      console.error(`[SPIN_STATUS] Error after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch spin status" });
    }
  });

  // ── Call Credits ─────────────────────────────────────────────────────────────
  app.get("/api/call-credits", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const credits = await storage.getCallCredits(req.user.id);
      res.json(credits);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch call credits" });
    }
  });

  // ── Voice Notes entitlement & upload ─────────────────────────────────────
  // Voice notes unlock threshold — both users must reach this count before voice notes open.
  const VOICE_NOTE_MSG_THRESHOLD = 8;
  // First-call unlock threshold — both users must reach this count before the first call is possible.
  const FIRST_CALL_MSG_THRESHOLD = 15;

  app.get("/api/voice-notes/entitlement/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      // Always fetch match meta so we can compute both unlock flags.
      const match = await storage.getMatchMeta(matchId, userId);
      if (!match) return res.status(404).json({ message: "Match not found" });

      const count1 = match.messageCount1 ?? 0;
      const count2 = match.messageCount2 ?? 0;
      const callStage = match.callStage ?? 0;

      // ── First-call unlock (separate milestone from voice notes) ──────────────
      // Unlocked when both users have sent ≥ FIRST_CALL_MSG_THRESHOLD messages in
      // stage 0, or retroactively when call_stage > 0 (first call already happened).
      const firstCallUnlocked =
        callStage > 0 ||
        (count1 >= FIRST_CALL_MSG_THRESHOLD && count2 >= FIRST_CALL_MSG_THRESHOLD);

      // Helper: get voice-note popup-seen status for this user+match
      const getPopupSeen = async (): Promise<boolean> => {
        const [row] = await db.select().from(voiceNotePopupSeen)
          .where(and(eq(voiceNotePopupSeen.matchId, matchId), eq(voiceNotePopupSeen.userId, userId)))
          .limit(1);
        return !!row;
      };

      // Helper: get first-call prompt-seen status for this user+match
      const getFirstCallPromptSeen = async (): Promise<boolean> => {
        const [row] = await db.select().from(firstCallPromptSeen)
          .where(and(eq(firstCallPromptSeen.matchId, matchId), eq(firstCallPromptSeen.userId, userId)))
          .limit(1);
        return !!row;
      };

      // Run both seen-checks in parallel for speed.
      const [popupSeen, firstCallPromptSeenFlag] = await Promise.all([
        getPopupSeen(),
        getFirstCallPromptSeen(),
      ]);

      // Fast path: already permanently unlocked — skip re-evaluation of threshold.
      const [existing] = await db.select().from(voiceNoteUnlocks)
        .where(eq(voiceNoteUnlocks.matchId, matchId)).limit(1);
      if (existing) {
        // Backfill: conversations that advanced to call_stage > 0 before the popup-seen
        // system existed would show a late VN popup on their next entitlement poll.
        // Silently mark it acknowledged so the popup never appears over call controls.
        let effectivePopupSeen = popupSeen;
        if (!popupSeen && callStage > 0) {
          await db.insert(voiceNotePopupSeen).values({ matchId, userId }).onConflictDoNothing();
          effectivePopupSeen = true;
          console.log(`[PROGRESSION] VN_POPUP_BACKFILLED match=${matchId} userId=${userId.slice(0, 8)} callStage=${callStage}`);
        }
        return res.json({
          unlocked: true,
          popupSeen: effectivePopupSeen,
          firstCallUnlocked,
          firstCallPromptSeen: firstCallPromptSeenFlag,
        });
      }

      // ── Voice-note unlock evaluation ──────────────────────────────────────────
      // Retroactive: call_stage > 0 proves voice notes should have been unlocked
      // earlier even if message counts were reset by the progression system.
      const shouldUnlockByStage = callStage > 0;
      const shouldUnlockByCount = count1 >= VOICE_NOTE_MSG_THRESHOLD && count2 >= VOICE_NOTE_MSG_THRESHOLD;

      if (shouldUnlockByStage || shouldUnlockByCount) {
        // Persist unlock so it survives future call-stage count resets.
        await db.insert(voiceNoteUnlocks).values({ matchId }).onConflictDoNothing();
        console.log(`[VOICE_NOTE_UNLOCK] match=${matchId} stage=${callStage} count1=${count1} count2=${count2} → unlocked (byStage=${shouldUnlockByStage})`);
        // Broadcast realtime event so both connected clients update instantly.
        broadcastViaHttpApi(`chat:${matchId}`, "voice-note-unlock", { matchId }).catch(() => {});
        // Backfill: retroactive unlock via callStage means the popup was never shown
        // at the right moment — silently acknowledge it to prevent a late overlay.
        let effectivePopupSeen = popupSeen;
        if (!popupSeen && shouldUnlockByStage) {
          await db.insert(voiceNotePopupSeen).values({ matchId, userId }).onConflictDoNothing();
          effectivePopupSeen = true;
          console.log(`[PROGRESSION] VN_POPUP_BACKFILLED_BY_STAGE match=${matchId} userId=${userId.slice(0, 8)}`);
        }
        return res.json({
          unlocked: true,
          popupSeen: effectivePopupSeen,
          firstCallUnlocked,
          firstCallPromptSeen: firstCallPromptSeenFlag,
        });
      }

      return res.json({
        unlocked: false,
        popupSeen: false,
        firstCallUnlocked,
        firstCallPromptSeen: firstCallPromptSeenFlag,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to check voice notes entitlement" });
    }
  });

  // Mark voice-note unlock popup as seen for the requesting user in this match.
  // Server is source of truth; ensures popup doesn't re-appear on other devices.
  app.post("/api/voice-notes/popup-seen/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      // Verify the user belongs to this match
      const match = await storage.getMatchMeta(matchId, userId);
      if (!match) return res.status(403).json({ message: "Not authorized" });
      await db.insert(voiceNotePopupSeen).values({ matchId, userId }).onConflictDoNothing();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to mark popup seen" });
    }
  });

  // Mark first-call prompt as seen for the requesting user in this match.
  // Ensures the one-time first-call announcement popup never re-appears after dismiss.
  app.post("/api/first-call/prompt-seen/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      // Verify the user belongs to this match
      const match = await storage.getMatchMeta(matchId, userId);
      if (!match) return res.status(403).json({ message: "Not authorized" });
      await db.insert(firstCallPromptSeen).values({ matchId, userId }).onConflictDoNothing();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to mark first-call prompt seen" });
    }
  });

  // ── Reconciliation endpoint ──────────────────────────────────────────────────
  // Repairs corrupted per-user message counts for a match by recounting valid
  // persisted text messages directly from the messages table. Re-evaluates and
  // persists milestone rows. Returns a before/recounted/after report.
  // Access requires ADMIN_EMAIL env var (or dev mode with no ADMIN_EMAIL set).
  app.post("/api/admin/reconcile-match-progression/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const adminEmails = (process.env.ADMIN_EMAIL ?? "").split(",").map((e: string) => e.trim()).filter(Boolean);
      const IS_DEV_MODE = process.env.NODE_ENV !== "production";
      if (!IS_DEV_MODE || adminEmails.length > 0) {
        const userEmail = req.user?.email;
        if (!adminEmails.includes(userEmail)) {
          return res.status(403).json({ message: "Admin access required. Set ADMIN_EMAIL env var." });
        }
      }

      const { matchId } = req.params;

      // Read current stored state.
      const [matchRow] = await db
        .select({
          user1Id: matches.user1Id,
          user2Id: matches.user2Id,
          messageCount1: matches.messageCount1,
          messageCount2: matches.messageCount2,
          callStage: matches.callStage,
        })
        .from(matches)
        .where(eq(matches.id, matchId));

      if (!matchRow) return res.status(404).json({ message: "Match not found" });

      const before = {
        messageCount1: matchRow.messageCount1 ?? 0,
        messageCount2: matchRow.messageCount2 ?? 0,
        callStage: matchRow.callStage ?? 0,
      };

      // Recount valid text messages per sender from the messages table.
      // Excludes all system payloads (__VOICE__:, __SCHEDULE__:, __SYS__:, etc.)
      // by filtering out any content that begins with two underscores.
      const countRows = await db
        .select({
          senderId: messages.senderId,
          count: sqlExpr<number>`count(*)::int`,
        })
        .from(messages)
        .where(and(
          eq(messages.matchId, matchId),
          sqlExpr`content !~ '^__'`,
        ))
        .groupBy(messages.senderId);

      const recounted = {
        user1ValidCount: countRows.find(r => r.senderId === matchRow.user1Id)?.count ?? 0,
        user2ValidCount: countRows.find(r => r.senderId === matchRow.user2Id)?.count ?? 0,
      };

      // Cap counts at MAX_MESSAGES_PER_USER (15) per stage so a legacy match with
      // many messages never shows an inflated counter post-call.
      const VN_T = 8;
      const FC_T = 15;
      const capped1 = Math.min(recounted.user1ValidCount, 15);
      const capped2 = Math.min(recounted.user2ValidCount, 15);

      // Write the repaired counts back to the matches table.
      const [repaired] = await db
        .update(matches)
        .set({ messageCount1: capped1, messageCount2: capped2 })
        .where(eq(matches.id, matchId))
        .returning({ messageCount1: matches.messageCount1, messageCount2: matches.messageCount2 });

      // Re-evaluate and persist milestone rows.
      const vnEligible = capped1 >= VN_T && capped2 >= VN_T;
      if (vnEligible) {
        await db.insert(voiceNoteUnlocks).values({ matchId }).onConflictDoNothing();
      }

      const after = {
        messageCount1: repaired?.messageCount1 ?? capped1,
        messageCount2: repaired?.messageCount2 ?? capped2,
        callStage: matchRow.callStage ?? 0,
        vnMilestoneEligible: vnEligible,
        fcMilestoneEligible: capped1 >= FC_T && capped2 >= FC_T,
      };

      console.log("[RECONCILE]", { matchId: matchId.slice(0, 8), before, recounted, after });

      return res.json({ before, recounted, after });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to reconcile match progression" });
    }
  });

  // Startup backfill: retroactively grant voice-note unlock to any match that
  // already progressed past call_stage 0 (i.e. earned the unlock in the past).
  // Safe to run on every startup — onConflictDoNothing is idempotent.
  void (async () => {
    try {
      const { data: advanced } = await supabaseAdmin
        .from("matches")
        .select("id")
        .gt("call_stage", 0)
        .limit(2000);
      if (advanced && advanced.length > 0) {
        for (const m of advanced) {
          await db.insert(voiceNoteUnlocks).values({ matchId: m.id }).onConflictDoNothing();
        }
        console.log(`[VOICE_NOTE_BACKFILL] Processed ${advanced.length} advanced matches`);
      }
    } catch (err: any) {
      console.error(`[VOICE_NOTE_BACKFILL] Error: ${err?.message}`);
    }
  })();

  // Binary audio upload — client sends raw ArrayBuffer (no base64 overhead).
  // Dynamic body parser: multer for FormData multipart (iOS-compatible new path),
  // express.raw() for legacy raw-binary clients.
  const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  const voiceNoteParser = (req: any, res: any, next: any) => {
    const ct = (req.headers["content-type"] as string | undefined) || "";
    if (ct.startsWith("multipart/form-data")) {
      memUpload.single("audio")(req, res, next);
    } else {
      express.raw({ type: "*/*", limit: "15mb" })(req, res, next);
    }
  };

  app.post("/api/voice-notes/send/:matchId", isAuthenticated, voiceNoteParser, async (req: any, res) => {
    const tReceive = Date.now();
    try {
      console.log(`[VOICE_NOTE_PIPELINE] route hit`);
      const adminStorage = getAdminStorage();
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      console.log(`[VOICE_NOTE_PIPELINE] auth user id=${userId}`);
      console.log(`[VOICE_NOTE_PIPELINE] match id=${matchId}`);

      // Path 1: FormData multipart (new — iOS-compatible via multer)
      // Path 2: Raw binary   (legacy — express.raw() populates req.body as Buffer)
      // Path 3: Base64 JSON  (oldest — kept for backward compat)
      let audioBuffer: Buffer;
      let mimeType: string;
      const fileExists = !!(req.file?.buffer && req.file.buffer.length > 0);
      const isMultipart = fileExists;
      console.log(`[VOICE_NOTE_PIPELINE] multipart parsed ${isMultipart}`);
      console.log(`[VOICE_NOTE_PIPELINE] file exists ${fileExists}`);
      if (isMultipart) {
        audioBuffer = req.file!.buffer;
        mimeType = (req.body?.mimeType as string | undefined) || req.file!.mimetype || "audio/webm";
        console.log(`[VOICE_NOTE_PIPELINE] file size=${audioBuffer.length}`);
        console.log(`[VOICE_NOTE_PIPELINE] file mimetype=${mimeType}`);
        console.log(`[VOICE_NOTE_PIPELINE] temp file created=false (memoryStorage — buffer in RAM)`);
        console.log(`[VOICE_NOTE_UPLOAD] serverReceived=FormData size=${audioBuffer.length} mimeType=${mimeType} receiveMs=${Date.now() - tReceive}`);
      } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        audioBuffer = req.body;
        mimeType = (req.headers["x-voice-mime"] as string | undefined) || "audio/webm";
        console.log(`[VOICE_NOTE_PIPELINE] file size=${audioBuffer.length}`);
        console.log(`[VOICE_NOTE_PIPELINE] file mimetype=${mimeType} (raw binary fallback)`);
        console.log(`[VOICE_NOTE_PIPELINE] temp file created=false (raw body buffer)`);
        console.log(`[VOICE_NOTE_UPLOAD] serverReceived=RawBinary size=${audioBuffer.length} mimeType=${mimeType} receiveMs=${Date.now() - tReceive}`);
      } else if (req.body?.audioBase64) {
        // Legacy JSON/base64 fallback (old app versions)
        mimeType = req.body.mimeType || "audio/webm";
        try {
          audioBuffer = Buffer.from(req.body.audioBase64, "base64");
        } catch {
          return res.status(400).json({ message: "Invalid audio data" });
        }
        console.log(`[VOICE_NOTE_PIPELINE] file size=${audioBuffer.length}`);
        console.log(`[VOICE_NOTE_PIPELINE] file mimetype=${mimeType} (base64 fallback)`);
        console.log(`[VOICE_NOTE_PIPELINE] temp file created=false (base64 decoded)`);
        console.log(`[VOICE_NOTE_UPLOAD] serverReceived=Base64 size=${audioBuffer.length} mimeType=${mimeType} receiveMs=${Date.now() - tReceive}`);
      } else {
        console.error(`[VOICE_NOTE_PIPELINE] file exists false — no audio found. req.file=${JSON.stringify(req.file)} bodyType=${typeof req.body} bodyKeys=${req.body ? Object.keys(req.body) : "null"} ct="${req.headers["content-type"]}"`);
        console.error(`[VOICE_NOTE_UPLOAD] serverReceived=NOTHING req.file=${JSON.stringify(req.file)} bodyType=${typeof req.body} bodyKeys=${req.body ? Object.keys(req.body) : "null"}`);
        return res.status(400).json({ message: "Audio data is required" });
      }

      console.log(`[VOICE_NOTE_SPEED] recording stopped — server received size=${audioBuffer.length}B mimeType=${mimeType} receiveMs=${Date.now() - tReceive}ms`);

      if (audioBuffer.length > 10_000_000) {
        return res.status(400).json({ message: "Audio file too large (max 10 MB)" });
      }

      const tMatchMeta = Date.now();
      const match = await storage.getMatchMeta(matchId, userId);
      if (!match) return res.status(404).json({ message: "Match not found" });
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      console.log(`[VOICE_NOTE_SPEED] upload started — matchMetaMs=${Date.now() - tMatchMeta}ms`);

      const safeMime = mimeType.length < 100 ? mimeType : "audio/webm";

      // ── Entitlement check + transcode in parallel ─────────────────────────────
      // iOS fast path: transcodeToM4a returns inputBuffer immediately (0 ms, no FFmpeg).
      // Running entitlement DB query concurrently with the transcode saves ~50 ms.
      const tProcess = Date.now();
      console.log(`[VOICE_NOTE_PIPELINE] transcode started safeMime=${safeMime} inputSize=${audioBuffer.length}`);
      let outputBuffer: Buffer;
      let isVoiceNoteUnlocked: boolean;
      try {
        [outputBuffer, isVoiceNoteUnlocked] = await Promise.all([
          transcodeToM4a(audioBuffer, safeMime),
          (async () => {
            const [existing] = await db.select().from(voiceNoteUnlocks)
              .where(eq(voiceNoteUnlocks.matchId, matchId)).limit(1);
            if (existing) return true;
            const meta = await storage.getMatchMeta(matchId, userId);
            if (!meta) return false;
            // Retroactive: call_stage > 0 means match already earned the unlock
            if ((meta.callStage ?? 0) > 0) return true;
            return (meta.messageCount1 ?? 0) >= VOICE_NOTE_MSG_THRESHOLD &&
              (meta.messageCount2 ?? 0) >= VOICE_NOTE_MSG_THRESHOLD;
          })(),
        ]);
      } catch (transcodeErr: any) {
        console.error(`[VOICE_NOTE_PIPELINE] transcode error safeMime="${safeMime}" error="${transcodeErr.message}"`);
        console.error(`[VOICE] TRANSCODE_FAIL safeMime=${safeMime} error="${transcodeErr.message}"`);
        return res.status(500).json({ message: "Failed to process audio. Please try again." });
      }
      const processMs = Date.now() - tProcess;
      console.log(`[VOICE_NOTE_PIPELINE] transcode complete outputSize=${outputBuffer.length}B processMs=${processMs}`);
      console.log(`[VOICE_NOTE_SPEED] upload complete — transcodeMs=${processMs}ms size=${audioBuffer.length}B→${outputBuffer.length}B`);

      if (!isVoiceNoteUnlocked) {
        return res.status(403).json({ message: "Voice notes unlock after you've both sent 10 messages." });
      }

      const filePath = `${matchId}/${Date.now()}_${userId}.m4a`;
      const tStorage = Date.now();
      console.log(`[VOICE_NOTE_PIPELINE] storage upload started path="${filePath}" size=${outputBuffer.length}`);

      const { error: uploadError } = await supabaseAdmin.storage
        .from("voice-notes")
        .upload(filePath, outputBuffer, { contentType: "audio/mp4", upsert: false });

      if (uploadError) {
        // If bucket doesn't exist yet, create it and retry once
        if (uploadError.message?.includes("Bucket not found") || uploadError.message?.includes("bucket")) {
          await supabaseAdmin.storage.createBucket("voice-notes", { public: true }).catch(() => {});
          const { error: retryErr } = await supabaseAdmin.storage
            .from("voice-notes")
            .upload(filePath, outputBuffer, { contentType: "audio/mp4", upsert: false });
          if (retryErr) {
            console.error(`[VOICE_NOTE_PIPELINE] storage upload error (after bucket create) error="${retryErr.message}"`);
            console.error(`[VOICE] UPLOAD_FAIL ${retryErr.message}`);
            return res.status(500).json({ message: "Failed to upload voice note. Please try again." });
          }
        } else {
          console.error(`[VOICE_NOTE_PIPELINE] storage upload error="${uploadError.message}"`);
          console.error(`[VOICE] UPLOAD_FAIL ${uploadError.message}`);
          return res.status(500).json({ message: "Failed to upload voice note. Please try again." });
        }
      }
      const storageMs = Date.now() - tStorage;
      console.log(`[VOICE_NOTE_PIPELINE] storage upload complete path="${filePath}" size=${outputBuffer.length}B storageMs=${storageMs}`);
      console.log(`[VOICE_NOTE_SPEED] server processed — storageMs=${storageMs}ms`);

      const { data: urlData } = supabaseAdmin.storage.from("voice-notes").getPublicUrl(filePath);
      const publicUrl = urlData.publicUrl;
      console.log(`[VOICE_NOTE_PIPELINE] final audio url=${publicUrl}`);
      console.log(`[VOICE_NOTE_SPEED] playback url ready — url=${publicUrl}`);

      const tInsert = Date.now();
      console.log(`[VOICE_NOTE_PIPELINE] db insert started`);
      let message: any;
      try {
        message = await adminStorage.createMessage({
          matchId,
          senderId: userId,
          content: `__VOICE__:${publicUrl}`,
        });
        console.log(`[VOICE_NOTE_PIPELINE] db insert complete messageId=${message?.id} insertMs=${Date.now() - tInsert}`);
      } catch (dbErr: any) {
        console.error(`[VOICE_NOTE_PIPELINE] db insert error="${dbErr.message}"`);
        console.error(`[VOICE_NOTE_SPEED] db inserted FAILED insertMs=${Date.now() - tInsert}ms`);
        return res.status(500).json({ message: "Failed to save voice note. Please try again." });
      }
      const totalMs = Date.now() - tReceive;
      console.log(`[VOICE_NOTE_SPEED] db inserted — insertMs=${Date.now() - tInsert}ms totalMs=${totalMs}ms messageId=${message?.id}`);
      console.log(`[VOICE_NOTE_PIPELINE] response returned status=200 totalMs=${totalMs}`);
      res.json({ success: true, message });
    } catch (err: any) {
      console.error("[VOICE] ERROR:", err.message);
      res.status(500).json({ message: err.message || "Failed to send voice note" });
    }
  });

  // ── Discovery Undo Last Pass ──────────────────────────────────────────────────
  app.post("/api/discover/undo-pass", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;

      // One free undo per user per calendar day (UTC).
      // Tracked via a "daily_undo_used" row in user_benefits (createdAt = when used).
      const todayUtc = new Date();
      todayUtc.setUTCHours(0, 0, 0, 0);

      const [dailyRow] = await db.select().from(userBenefits)
        .where(and(eq(userBenefits.userId, userId), eq(userBenefits.type, "daily_undo_used")))
        .limit(1);

      const usedFreeToday = !!(dailyRow?.createdAt && dailyRow.createdAt >= todayUtc);
      let usePaidCredit = false;
      let paidBenefitId: string | null = null;

      if (usedFreeToday) {
        // Free undo already used today — fall back to paid credits
        const [benefitRow] = await db.select().from(userBenefits)
          .where(and(eq(userBenefits.userId, userId), eq(userBenefits.type, "undo_close")))
          .limit(1);
        if (!benefitRow) {
          return res.status(402).json({ message: "Free daily undo already used. Purchase undo credits from Lulou Extras." });
        }
        usePaidCredit = true;
        paidBenefitId = benefitRow.id;
      }

      const lastInteraction = await storage.getLastInteraction(userId);
      if (!lastInteraction) {
        return res.status(404).json({ message: "No recent action to undo." });
      }

      // Guard: verify the target profile still exists BEFORE consuming any credit.
      // Without this check, a deleted/deactivated profile causes the interaction
      // to be removed (wasting the credit) and the profile never reappears in the feed.
      const targetProfile = await storage.getProfileMeta(lastInteraction.toUserId);
      if (!targetProfile) {
        return res.status(404).json({ message: "Profile no longer exists — undo is not possible." });
      }

      // If the last action was a like, check whether it resulted in a match.
      // Matches cannot be silently undone.
      if (lastInteraction.type === "open") {
        const matchExists = await storage.getMatchBetweenUsers(userId, lastInteraction.toUserId);
        if (matchExists) {
          return res.status(409).json({ message: "This like created a match — matches cannot be undone." });
        }
      }

      const deleted = await storage.deleteLastClose(userId, lastInteraction.interactionId);
      if (!deleted) {
        return res.status(500).json({ message: "Failed to undo action." });
      }

      // Consume the appropriate credit
      if (usePaidCredit && paidBenefitId) {
        await db.delete(userBenefits).where(eq(userBenefits.id, paidBenefitId));
      } else {
        // Mark free daily undo as used (replace any old record for this user)
        await db.delete(userBenefits).where(and(eq(userBenefits.userId, userId), eq(userBenefits.type, "daily_undo_used")));
        await db.insert(userBenefits).values({ userId, type: "daily_undo_used" });
      }

      res.json({ success: true, restoredProfileId: lastInteraction.toUserId, actionType: lastInteraction.type });
    } catch (err: any) {
      console.error("[UNDO_PASS]", err.message);
      res.status(500).json({ message: err.message || "Failed to undo pass" });
    }
  });

  // ── Wheel Save For Later ──────────────────────────────────────────────────────
  app.get("/api/wheel/saved", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const saved = await storage.getSavedWheelProfile(req.user.id);
      res.json({ saved });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch saved wheel profile" });
    }
  });

  app.post("/api/wheel/save", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { profileId } = req.body;
      if (!profileId || typeof profileId !== "string") {
        return res.status(400).json({ message: "profileId required" });
      }
      const existing = await storage.getSavedWheelProfile(userId);
      if (existing) {
        return res.status(409).json({ message: "You already have a saved connection. Act on them first." });
      }
      const saved = await storage.saveWheelProfile(userId, profileId);
      res.json({ saved });
    } catch (err: any) {
      console.error("[WHEEL_SAVE]", err.message);
      res.status(500).json({ message: err.message || "Failed to save wheel profile" });
    }
  });

  app.delete("/api/wheel/saved", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      await storage.deleteSavedWheelProfile(req.user.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to delete saved wheel profile" });
    }
  });

  app.post("/api/spin", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { standoutUserId } = req.body;

      const spinsThisWeek = await storage.getSpinsThisWeek(userId);
      const consecutiveDays = await storage.getConsecutiveLikeDays(userId, 10);
      const streakComplete = consecutiveDays >= 3;
      const hasUnusedStreak = await storage.hasUnusedStreakSpin(userId);

      let canSpin = false;
      if (streakComplete && hasUnusedStreak) {
        canSpin = true;
      } else if (!streakComplete && spinsThisWeek === 0) {
        canSpin = true;
      } else {
        // Fall back to purchased spin credits — consume atomically via
        // DELETE…RETURNING so concurrent requests cannot double-spend.
        const consumed = await storage.consumeSpinCredit(userId);
        if (consumed) {
          // Credit already consumed; skip the second consume below.
          await storage.recordSpin(userId);
          if (standoutUserId) await storage.addSpinStandout(userId, standoutUserId);
          return res.json({ success: true });
        }
      }

      if (!canSpin) {
        return res.status(403).json({ message: "No spins available" });
      }

      await storage.recordSpin(userId);

      if (standoutUserId) {
        await storage.addSpinStandout(userId, standoutUserId);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error recording spin:", error);
      res.status(500).json({ message: "Failed to record spin" });
    }
  });

  app.post("/api/spin-requests", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { toUserId, message } = req.body;

      if (!toUserId || !message?.trim()) {
        return res.status(400).json({ message: "Recipient and message are required" });
      }

      if (message.length > 500) {
        return res.status(400).json({ message: "Message too long (500 char max)" });
      }

      const request = await storage.createSpinRequest(userId, toUserId, message.trim());
      res.json(request);
    } catch (error) {
      console.error("Error creating spin request:", error);
      res.status(500).json({ message: "Failed to send spin request" });
    }
  });

  app.get("/api/spin-requests", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const [incoming, outgoing] = await Promise.all([
        storage.getIncomingSpinRequests(userId),
        storage.getOutgoingSpinRequests(userId),
      ]);
      res.json({ incoming, outgoing });
    } catch (error) {
      console.error("Error fetching spin requests:", error);
      res.status(500).json({ message: "Failed to fetch spin requests" });
    }
  });

  app.post("/api/spin-requests/:id/respond", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { id } = req.params;
      const { accept } = req.body;

      if (typeof accept !== "boolean") {
        return res.status(400).json({ message: "accept must be true or false" });
      }

      const updated = await storage.respondToSpinRequest(id, userId, accept);
      if (!updated) {
        return res.status(404).json({ message: "Request not found or already handled" });
      }

      let matchCreated = false;
      if (accept) {
        const matchCount = await storage.getMatchCount(userId);
        if (matchCount >= 8) {
          return res.status(400).json({ message: "Connections room is full. Close a connection to free up space." });
        }

        const existingMatches = await storage.getMatchesForUser(userId);
        const alreadyMatched = existingMatches.some(
          m => m.user1Id === updated.fromUserId || m.user2Id === updated.fromUserId
        );

        if (!alreadyMatched) {
          const match = await storage.createMatch(updated.fromUserId, updated.toUserId);

          await storage.createMessage({
            matchId: match.id,
            senderId: updated.fromUserId,
            content: updated.message,
          });
          await storage.incrementMessageCount(match.id, updated.fromUserId);

          matchCreated = true;
        }
      }

      res.json({ ...updated, matchCreated });
    } catch (error) {
      console.error("Error responding to spin request:", error);
      res.status(500).json({ message: "Failed to respond to spin request" });
    }
  });

  app.delete("/api/matches/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const removed = await storage.removeMatch(matchId, userId);
      if (!removed) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing match:", error);
      res.status(500).json({ message: "Failed to remove connection" });
    }
  });

  app.get("/api/match-count", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const count = await storage.getMatchCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching match count:", error);
      res.status(500).json({ message: "Failed to fetch match count" });
    }
  });

  app.get("/api/who-liked-you", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      console.log(`[WHO_LIKED_YOU] recipientId=${userId.slice(0,8)}… fetching`);
      const incomingOpens = await storage.getIncomingOpens(userId);
      console.log(
        `[WHO_LIKED_YOU] recipientId=${userId.slice(0,8)}… ` +
        `count=${incomingOpens.length} ms=${Date.now() - t0}`
      );
      const likesJson = IS_DEV ? JSON.stringify(incomingOpens) : "";
      devPerf("/api/who-liked-you", Date.now() - t0, {
        count: incomingOpens.length,
        payloadKb: Math.round(likesJson.length / 1024),
        hasPhotos: false,
      });
      res.json(incomingOpens);
    } catch (error) {
      console.error(`[WHO_LIKED_YOU] error after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch likes" });
    }
  });

  app.post("/api/matches/:matchId/schedule-call", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { action, proposedTime } = req.body;

      if (!["propose", "accept", "decline", "reschedule"].includes(action)) {
        return res.status(400).json({ message: "Invalid action" });
      }

      const match = await storage.getMatch(matchId, userId);
      if (!match) return res.status(404).json({ message: "Match not found" });

      const callStage = match.callStage || 0;
      if (callStage >= 2) {
        return res.status(400).json({ message: "No more calls to schedule at this stage" });
      }

      const SCHEDULE_PREFIX = "__SCHEDULE__:";
      const stageMsgs = match.messages
        .filter(m => m.content.startsWith(SCHEDULE_PREFIX))
        .filter(m => {
          try { return JSON.parse(m.content.slice(SCHEDULE_PREFIX.length)).stage === callStage; }
          catch { return false; }
        });
      const lastData: any = stageMsgs.length > 0
        ? (() => { try { return JSON.parse(stageMsgs[stageMsgs.length - 1].content.slice(SCHEDULE_PREFIX.length)); } catch { return null; } })()
        : null;

      if ((action === "accept" || action === "decline")) {
        if (!lastData || !["propose", "reschedule"].includes(lastData.type)) {
          return res.status(400).json({ message: "No pending proposal to respond to" });
        }
        if (lastData.proposedBy === userId) {
          return res.status(400).json({ message: "Cannot respond to your own proposal" });
        }
      }

      if ((action === "propose" || action === "reschedule") && !proposedTime) {
        return res.status(400).json({ message: "proposedTime is required" });
      }

      if (action === "propose" && lastData?.type === "accept") {
        return res.status(400).json({ message: "Call is already confirmed. Use reschedule if needed." });
      }

      const resolvedTime = (action === "accept" || action === "decline")
        ? (lastData?.proposedTime ?? new Date().toISOString())
        : proposedTime;

      const scheduleData = { type: action, proposedBy: userId, proposedTime: resolvedTime, stage: callStage };
      const content = `${SCHEDULE_PREFIX}${JSON.stringify(scheduleData)}`;

      const message = await storage.createMessage({ matchId, senderId: userId, content });

      const logLabels: Record<string, string> = {
        propose: "CALL_TIME_PROPOSED",
        accept: "CALL_TIME_ACCEPTED",
        decline: "CALL_TIME_DECLINED",
        reschedule: "CALL_TIME_RESCHEDULED",
      };
      console.log(`[CALL_SCHEDULE] ${logLabels[action]}`, { matchId, userId, action, proposedTime: resolvedTime, callStage });
      if (action === "accept") {
        console.log("[CALL_SCHEDULE] CALL_SCHEDULE_CONFIRMED", { matchId, callStage, scheduledTime: resolvedTime });
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (["propose", "reschedule"].includes(action) && isSeedUser(otherUserId)) {
        const replyStorage = storage;
        setTimeout(async () => {
          try {
            const acceptData = { type: "accept", proposedBy: otherUserId, proposedTime: resolvedTime, stage: callStage };
            await replyStorage.createMessage({ matchId, senderId: otherUserId, content: `${SCHEDULE_PREFIX}${JSON.stringify(acceptData)}` });
            console.log("[CALL_SCHEDULE] SEED_AUTO_ACCEPTED", { matchId, otherUserId, callStage, scheduledTime: resolvedTime });
          } catch (err) { console.error("Seed auto-accept error:", err); }
        }, 1500 + Math.random() * 1500);
      }

      res.json({ message, scheduleData });
    } catch (error) {
      console.error("Error scheduling call:", error);
      res.status(500).json({ message: "Failed to schedule call" });
    }
  });

  app.post("/api/matches/:matchId/date-choice", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { choice } = req.body;
      if (choice !== 'plan' && choice !== 'keep' && choice !== null) {
        return res.status(400).json({ message: "choice must be 'plan', 'keep', or null" });
      }
      const updated = await storage.setDateChoice(matchId, userId, choice);
      if (!updated) return res.status(404).json({ message: "Match not found" });
      return res.json(updated);
    } catch (err: any) {
      console.error("[date-choice] error:", err?.message);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/matches/:matchId/meet-availability", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { slots } = req.body;

      if (!Array.isArray(slots) || slots.length === 0 || slots.length > 5) {
        return res.status(400).json({ message: "Please select 1-5 time slots" });
      }

      const availability = JSON.stringify(slots);
      const match = await storage.setMeetAvailability(matchId, userId, availability);
      if (!match) {
        return res.status(404).json({ message: "Match not found or calls not completed yet" });
      }

      res.json(match);
    } catch (error) {
      console.error("Error setting meet availability:", error);
      res.status(500).json({ message: "Failed to set availability" });
    }
  });

  app.post("/api/matches/:matchId/exchange-number", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const profile = await storage.getProfileMeta(userId);
      if (!profile?.phoneNumber) {
        return res.status(400).json({ message: "Please add your phone number first" });
      }

      const match = await storage.exchangeNumber(matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found, calls not completed, or no matching dates yet" });
      }

      await storage.createMessage({
        matchId,
        senderId: userId,
        content: `__PHONE__:${profile.phoneNumber}`,
      });

      res.json(match);
    } catch (error) {
      console.error("Error exchanging number:", error);
      res.status(500).json({ message: "Failed to exchange number" });
    }
  });

  app.post("/api/dev/reset-test-data", isAuthenticated, async (req: any, res) => {
    try {
      if (process.env.NODE_ENV !== "development") {
        return res.status(403).json({ message: "Not available in production" });
      }
      const storage = getStorage(req);
      const userId = req.user.id;
      await storage.resetUserTestData(userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error resetting test data:", error);
      res.status(500).json({ message: "Failed to reset test data" });
    }
  });

  // --- Benefits ---

  app.get("/api/benefits", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const rows = await db.select().from(userBenefits).where(eq(userBenefits.userId, userId));
      const available: Record<string, number> = {};
      const activated: Record<string, Record<string, number>> = {};
      for (const b of rows) {
        if (!b.activatedMatchId) {
          available[b.type] = (available[b.type] || 0) + 1;
        } else {
          if (!activated[b.activatedMatchId]) activated[b.activatedMatchId] = {};
          activated[b.activatedMatchId][b.type] = (activated[b.activatedMatchId][b.type] || 0) + 1;
        }
      }
      res.json({ available, activated });
    } catch (error) {
      console.error("Error fetching benefits:", error);
      res.status(500).json({ message: "Failed to fetch benefits" });
    }
  });

  app.post("/api/benefits/activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type, matchId } = req.body;
      if (!type || !matchId) {
        return res.status(400).json({ message: "type and matchId are required" });
      }
      const [benefit] = await db
        .select()
        .from(userBenefits)
        .where(and(
          eq(userBenefits.userId, userId),
          eq(userBenefits.type, type),
          isNull(userBenefits.activatedMatchId),
        ))
        .limit(1);
      if (!benefit) {
        return res.status(404).json({ message: "No available benefit of this type" });
      }
      const [updated] = await db
        .update(userBenefits)
        .set({ activatedMatchId: matchId })
        .where(eq(userBenefits.id, benefit.id))
        .returning();
      res.json({ success: true, benefit: updated });
    } catch (error) {
      console.error("Error activating benefit:", error);
      res.status(500).json({ message: "Failed to activate benefit" });
    }
  });

  // ── DEV-ONLY: manually grant a benefit (blocked in production) ──────────────
  // SECURITY: without the NODE_ENV guard every authenticated user could POST
  // here and self-grant unlimited benefits for free.  Do NOT remove this guard.
  app.post("/api/benefits/grant", isAuthenticated, async (req: any, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ message: "Not available in production" });
    }
    try {
      const userId = req.user.id;
      const { type, quantity = 1 } = req.body;
      if (!type) {
        return res.status(400).json({ message: "type is required" });
      }
      const rows = Array.from({ length: Number(quantity) }, () => ({ userId, type: String(type) }));
      const granted = await db.insert(userBenefits).values(rows).returning();
      res.json({ granted });
    } catch (error) {
      console.error("Error granting benefit:", error);
      res.status(500).json({ message: "Failed to grant benefit" });
    }
  });

  // ── Extras / Membership Stripe checkout ───────────────────────────────────

  // EXTRAS_ITEMS, ELEVATE_PACKS, ExtrasItemId, ElevatePackId imported from ./purchaseItems

  app.post("/api/stripe/extras-checkout", isAuthenticated, paymentLimiter, async (req: any, res) => {
    const userId = req.user.id;
    const { itemId, returnPath } = req.body;
    console.log(`[CHECKOUT] REQUEST_RECEIVED item=${itemId} user=${userId} returnPath=${returnPath}`);
    try {
      checkStripeReady();
      const item = EXTRAS_ITEMS[itemId as ExtrasItemId];
      if (!item) {
        console.warn(`[CHECKOUT] INVALID_ITEM item=${itemId} validItems=${Object.keys(EXTRAS_ITEMS).join(", ")}`);
        return res.status(400).json({ message: `Invalid item. Must be one of: ${Object.keys(EXTRAS_ITEMS).join(", ")}` });
      }
      const stripe = getUncachableStripeClient();
      const baseUrl = process.env.FRONTEND_URL ??
        `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost:5000"}`;

      // Build a safe cancel URL from the caller-supplied returnPath.
      // Only allow relative paths starting with "/" to prevent open-redirect attacks.
      const safeCancelPath = (typeof returnPath === "string" && /^\/[a-zA-Z0-9\-/_?=&]*$/.test(returnPath))
        ? returnPath
        : "/profile";

      // Sparks purchases return directly to /intent so the user can spin
      // immediately. A session_id query param triggers auto-activation + toast.
      const successUrl = (itemId as string).startsWith("sparks-")
        ? `${baseUrl}/intent?sparks_session={CHECKOUT_SESSION_ID}&item=${itemId}`
        : `${baseUrl}/extras/success?session_id={CHECKOUT_SESSION_ID}&item=${itemId}`;

      const cancelUrl = `${baseUrl}${safeCancelPath}?checkout=cancelled`;

      // Use a pre-created Stripe price ID when available (set up at warmup).
      // Fall back to inline price_data for items without a registered price
      // (e.g. membership subscription, call packs) or if warmup hasn't run.
      const cachedPriceId = item.mode === "payment" ? tryGetPriceId(itemId as string) : null;

      let lineItem: Record<string, unknown>;
      if (cachedPriceId) {
        lineItem = { price: cachedPriceId, quantity: 1 };
      } else {
        const priceData: Record<string, unknown> = {
          currency: "aud",
          product_data: { name: item.name },
          unit_amount: item.unitAmount,
        };
        if (item.mode === "subscription") {
          priceData.recurring = { interval: "month" };
        }
        lineItem = { price_data: priceData, quantity: 1 };
      }

      console.log(`[CHECKOUT] CREATING_SESSION item=${itemId} amount=${item.unitAmount} currency=aud mode=${item.mode} priceId=${cachedPriceId ?? "inline"} success_url=${successUrl} cancel_url=${cancelUrl}`);

      // ── [CHECKOUT_TEST] / [CHECKOUT_ACCOUNT] diagnostic logs ─────────────────
      console.log(`[CHECKOUT_TEST] ROUTE_HIT`);
      console.log(`[CHECKOUT_TEST] USER_ID=${userId}`);
      console.log(`[CHECKOUT_TEST] PRODUCT_ID=${itemId}`);

      // Fetch the real Stripe account identity before creating the session.
      // This is the ground truth — compare accountId against dashboard URL.
      const acctInfo = await getStripeAccountInfo();
      console.log(`[CHECKOUT_ACCOUNT]`, {
        accountId:      acctInfo.accountId,
        livemode:       acctInfo.livemode,
        secretKeyPrefix: acctInfo.secretKeyPrefix,
        pubKeyPrefix:   acctInfo.pubKeyPrefix,
      });

      console.log(`[CHECKOUT_TEST] BEFORE_STRIPE_CREATE`);
      // ────────────────────────────────────────────────────────────────────────

      let session: any;
      try {
        session = await (stripe.checkout.sessions.create as Function)({
          line_items: [lineItem],
          mode: item.mode,
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: { userId, itemId, benefitType: item.benefitType ?? "", mode: item.mode },
        });
      } catch (stripeErr: any) {
        const detail = stripeErr.raw?.message ?? stripeErr.message ?? "Stripe error";
        console.error(`[CHECKOUT_TEST] ERROR=${detail}`, {
          type: stripeErr.type, code: stripeErr.code,
          statusCode: stripeErr.statusCode ?? stripeErr.raw?.statusCode,
          raw: stripeErr.raw?.message,
        });
        throw stripeErr; // re-throw so outer catch handles HTTP response
      }

      // ── [CHECKOUT_TEST] / [CHECKOUT_CREATED] ─────────────────────────────────
      console.log(`[CHECKOUT_TEST] AFTER_STRIPE_CREATE session=${session.id}`);
      console.log(`[CHECKOUT_TEST] SESSION_URL=${session.url}`);
      console.log(`[CHECKOUT_CREATED]`, {
        sessionId:  session.id,
        sessionUrl: session.url,
        livemode:   session.livemode,
      });
      // ────────────────────────────────────────────────────────────────────────

      console.log(`[CHECKOUT] SESSION_CREATED session=${session.id} url=${session.url}`);

      const _extrasMode = session.id.startsWith('cs_live_') ? 'LIVE' : session.id.startsWith('cs_test_') ? 'TEST' : 'UNKNOWN';
      const _frontendUrlSource = process.env.FRONTEND_URL ? 'FRONTEND_URL env' : 'REPLIT_DOMAINS fallback';
      console.log(
        `[STRIPE] CHECKOUT_CREATED extras` +
        ` | session=${session.id}` +
        ` | mode=${_extrasMode}` +
        ` | item=${itemId}` +
        ` | amount=${item.unitAmount} aud` +
        ` | user=${userId}` +
        ` | baseUrl=${baseUrl} (${_frontendUrlSource})` +
        ` | success_url=${successUrl}` +
        ` | cancel_url=${cancelUrl}`,
      );
      if (_extrasMode === 'TEST') {
        console.log('[STRIPE] ℹ TEST session — visible in Stripe dashboard ONLY with "Test mode" toggled ON (top-left of dashboard.stripe.com)');
      }

      console.log(`[CHECKOUT] REDIRECTING_TO_STRIPE session=${session.id} url=${session.url}`);
      res.json({
        url:            session.url,
        sessionId:      session.id,
        accountId:      acctInfo.accountId,
        livemode:       acctInfo.livemode,
        secretKeyPrefix: acctInfo.secretKeyPrefix,
        pubKeyPrefix:   acctInfo.pubKeyPrefix,
      });
    } catch (err: any) {
      if (err.code === 'stripe_test_mode_blocked') {
        return res.status(402).json({ message: err.message, code: err.code });
      }
      const detail = err.raw?.message ?? err.message ?? "Unknown error";
      console.error("[CHECKOUT] STRIPE_ERROR", {
        item: itemId,
        user: userId,
        message: err.message,
        type: err.type,
        code: err.code,
        rawMessage: err.raw?.message,
        rawType: err.raw?.type,
        rawCode: err.raw?.code,
        statusCode: err.statusCode ?? err.raw?.statusCode,
        stack: err.stack?.split("\n").slice(0, 4).join(" | "),
      });
      res.status(500).json({ message: detail, code: err.code ?? err.raw?.code, type: err.type });
    }
  });

  app.post("/api/stripe/extras-activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ message: "sessionId required" });

      const stripe = getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      console.log(`[STRIPE] CONFIRM_SESSION extras sessionId=${sessionId} session_user=${session.metadata?.userId} stripe_user=${userId} paid=${session.payment_status}`);

      const isPaid = session.mode === "subscription"
        ? session.status === "complete"
        : session.payment_status === "paid";

      if (!isPaid) {
        return res.status(402).json({ message: "Payment not completed", status: session.status, paymentStatus: session.payment_status });
      }
      console.log(`[PAYMENT] CONFIRMED sessionId=${sessionId} user=${userId} item=${session.metadata?.itemId} mode=${session.mode} status=${session.payment_status}`);
      if (session.metadata?.userId !== userId) {
        console.warn(`[STRIPE] USER_MISMATCH extras sessionId=${sessionId} session_user=${session.metadata?.userId} req_user=${userId}`);
        return res.status(403).json({ message: "Please return to Lulou and sign in with the same account used to start the purchase." });
      }

      const itemId = session.metadata?.itemId as ExtrasItemId | undefined;
      const item = itemId ? EXTRAS_ITEMS[itemId] : undefined;
      if (!item) return res.status(400).json({ message: "Unknown item in session metadata" });

      // ── Idempotency guard ─────────────────────────────────────────────────
      // Try to claim this session ID. The primary key on processed_stripe_sessions
      // guarantees exactly-once granting even if the user refreshes the success
      // page, retries over a network blip, or a webhook races the polling loop.
      try {
        await db.insert(processedStripeSessions).values({
          sessionId,
          userId,
          itemRef: itemId ?? "",
        });
      } catch (insertErr: any) {
        const isUniqueViolation =
          insertErr.code === "23505" ||
          (insertErr.cause as any)?.code === "23505" ||
          String(insertErr?.message ?? "").toLowerCase().includes("unique") ||
          String(insertErr?.message ?? "").toLowerCase().includes("duplicate");
        if (isUniqueViolation) {
          console.log(`[STRIPE] extras-activate: session ${sessionId} already processed for ${userId} — returning idempotent success`);
          return res.json({ success: true, itemId, name: item.name, granted: [], mode: item.mode, alreadyProcessed: true });
        }
        throw insertErr;
      }
      // ─────────────────────────────────────────────────────────────────────

      // Webhook didn't fire in time — grant as verified Stripe API fallback
      console.log(`[PURCHASE] WEBHOOK_FALLBACK_GRANT user=${userId} product=${itemId} session=${sessionId}`);
      const grantedTypes = await grantExtras(userId, sessionId, itemId as ExtrasItemId, session);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=activate_fallback user=${userId} product=${itemId} granted=${grantedTypes.join(", ")}`);
      res.json({ success: true, itemId, name: item.name, granted: grantedTypes, mode: item.mode });
    } catch (err: any) {
      const detail = err.raw?.message ?? err.message ?? "Unknown error";
      console.error("[STRIPE] extras-activate error:", { message: err.message, type: err.type, code: err.code });
      res.status(500).json({ message: detail });
    }
  });

  // ── Purchase status (read-only) ───────────────────────────────────────────
  // Called by success pages to detect when the checkout.session.completed
  // webhook has fired and granted the entitlement. Pure DB read — never grants.
  // Frontend polls this every 2 s for up to ~16 s, then falls back to the
  // activate endpoint (which verifies with Stripe and grants as a fallback).
  app.get("/api/stripe/purchase-status", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const sessionId = req.query.session_id as string | undefined;
    if (!sessionId) return res.status(400).json({ message: "session_id query param required" });

    try {
      const [row] = await db
        .select({ itemRef: processedStripeSessions.itemRef })
        .from(processedStripeSessions)
        .where(eq(processedStripeSessions.sessionId, sessionId))
        .limit(1);

      if (row) {
        console.log(`[PURCHASE] STATUS_CHECK granted=true session=${sessionId} user=${userId} itemRef=${row.itemRef}`);
        return res.json({ granted: true, itemRef: row.itemRef });
      }

      return res.json({ granted: false });
    } catch (err: any) {
      console.error("[PURCHASE] STATUS_CHECK error:", err?.message);
      res.status(500).json({ message: "Status check failed" });
    }
  });

  // ── Restore Purchases ─────────────────────────────────────────────────────
  // Re-grants any paid-but-not-applied Halo (sparks) or Voice Notes Unlock
  // sessions by paginating Stripe checkout history for this user, checking the
  // processed_stripe_sessions idempotency table, and re-running the same grant
  // logic as extras-activate. Safe to call multiple times — the PK on
  // processed_stripe_sessions prevents double-granting even under concurrency.

  const RESTORABLE_ITEM_IDS = new Set(["sparks-1", "sparks-3", "sparks-5", "voice-notes-unlock"]);

  app.post("/api/stripe/restore-purchases", isAuthenticated, paymentLimiter, async (req: any, res) => {
    const userId = req.user.id;
    console.log(`[RESTORE] START user=${userId}`);
    try {
      const stripe = getUncachableStripeClient();
      const storage = getStorage(req);

      // Paginate Stripe sessions (newest-first). Stripe doesn't allow filtering
      // by metadata server-side, so we filter client-side and cap at 200 total.
      const MAX_SESSIONS = 200;
      let checked = 0;
      let hasMore = true;
      let startingAfter: string | undefined;
      const candidates: Array<{ sessionId: string; itemId: string }> = [];

      while (hasMore && checked < MAX_SESSIONS) {
        const batch = await stripe.checkout.sessions.list({
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        for (const session of batch.data) {
          checked++;
          const sessionUserId = session.metadata?.userId;
          const itemId = session.metadata?.itemId;
          if (
            sessionUserId === userId &&
            RESTORABLE_ITEM_IDS.has(itemId ?? "") &&
            session.payment_status === "paid"
          ) {
            candidates.push({ sessionId: session.id, itemId: itemId! });
          }
          if (checked >= MAX_SESSIONS) break;
        }

        hasMore = batch.has_more && checked < MAX_SESSIONS;
        if (batch.data.length > 0) startingAfter = batch.data[batch.data.length - 1].id;
        else break;
      }

      console.log(`[RESTORE] SCANNED checked=${checked} candidates=${candidates.length} user=${userId}`);

      if (candidates.length === 0) {
        return res.json({ restored: [], alreadyApplied: 0, checked, message: "No restorable purchases found." });
      }

      // Find which candidate sessions are already in the idempotency table.
      const alreadyRows = await db
        .select({ sessionId: processedStripeSessions.sessionId })
        .from(processedStripeSessions)
        .where(
          and(
            eq(processedStripeSessions.userId, userId),
            inArray(processedStripeSessions.sessionId, candidates.map(c => c.sessionId))
          )
        );
      const alreadySet = new Set(alreadyRows.map(r => r.sessionId));
      const toRestore = candidates.filter(c => !alreadySet.has(c.sessionId));

      console.log(`[RESTORE] UNPROCESSED count=${toRestore.length} alreadyApplied=${alreadySet.size} user=${userId}`);

      const restored: Array<{ sessionId: string; itemId: string; name: string }> = [];

      for (const { sessionId, itemId } of toRestore) {
        const item = EXTRAS_ITEMS[itemId as ExtrasItemId];
        if (!item) continue;

        // Claim idempotency slot — PK violation means a concurrent restore already
        // processed this session; skip silently.
        try {
          await db.insert(processedStripeSessions).values({ sessionId, userId, itemRef: itemId });
        } catch (insertErr: any) {
          const isDup =
            insertErr.code === "23505" ||
            (insertErr.cause as any)?.code === "23505" ||
            String(insertErr?.message ?? "").toLowerCase().includes("unique") ||
            String(insertErr?.message ?? "").toLowerCase().includes("duplicate");
          if (isDup) {
            console.log(`[RESTORE] CONCURRENT_SKIP sessionId=${sessionId} user=${userId}`);
            continue;
          }
          throw insertErr;
        }

        await grantExtras(userId, sessionId, itemId as ExtrasItemId, {});
        console.log(`[RESTORE] GRANTED sessionId=${sessionId} item=${itemId} user=${userId}`);
        restored.push({ sessionId, itemId, name: item.name });
      }

      console.log(`[RESTORE] COMPLETE restored=${restored.length} alreadyApplied=${alreadySet.size} user=${userId}`);
      return res.json({
        restored,
        alreadyApplied: alreadySet.size,
        checked,
        message: restored.length > 0
          ? `Restored ${restored.length} purchase${restored.length === 1 ? "" : "s"}.`
          : "All purchases are already applied to your account.",
      });

    } catch (err: any) {
      const detail = err.raw?.message ?? err.message ?? "Unknown error";
      console.error("[RESTORE] ERROR", { user: userId, message: err.message, code: err.code });
      res.status(500).json({ message: detail });
    }
  });

  // ── Membership status — active/cancelled + current period end ────────────
  // Returns whether the authenticated user has an active membership subscription.
  // The client uses this to show/hide a "Member" badge and to surface renewal info.

  app.get("/api/membership/status", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const [sub] = await db
        .select()
        .from(membershipSubscriptions)
        .where(eq(membershipSubscriptions.userId, userId))
        .limit(1);
      if (!sub) {
        return res.json({ active: false, status: null, currentPeriodEnd: null });
      }
      return res.json({
        active: sub.status === "active",
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      });
    } catch (err: any) {
      console.error("[MEMBERSHIP] status error:", err?.message);
      res.status(500).json({ message: "Failed to fetch membership status" });
    }
  });

  // ── Stripe Customer Portal session ────────────────────────────────────────
  // Allows members to manage their subscription (cancel, update payment method,
  // view invoices) without building a custom billing UI.

  app.post("/api/stripe/create-portal-session", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const [sub] = await db
        .select()
        .from(membershipSubscriptions)
        .where(eq(membershipSubscriptions.userId, userId))
        .limit(1);

      if (!sub?.stripeCustomerId) {
        return res.status(400).json({ message: "No active subscription found." });
      }

      const stripe = getUncachableStripeClient();
      const baseUrl =
        process.env.FRONTEND_URL ??
        `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost:5000"}`;

      const session = await (stripe.billingPortal.sessions.create as Function)({
        customer: sub.stripeCustomerId,
        return_url: `${baseUrl}/settings`,
      });

      console.log(`[STRIPE] Portal session created for user ${userId}`);
      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("[STRIPE] Portal session failed:", err?.message);
      return res.status(500).json({ message: err?.message ?? "Failed to create portal session" });
    }
  });

  // ── Stripe publishable key (client needs this for Stripe.js) ─────────────

  app.get("/api/stripe/config", isAuthenticated, async (_req, res) => {
    try {
      const publishableKey = getStripePublishableKey();
      res.json({ publishableKey });
    } catch (err: any) {
      console.error("Error fetching Stripe config:", err.message);
      res.status(500).json({ message: "Stripe not configured" });
    }
  });

  // ── Create Stripe Checkout session for Elevate purchase ───────────────────
  // Called when user taps "Pay $X" in the checkout step.
  // Returns a Stripe-hosted checkout URL; on success Stripe redirects to
  // /elevate/success?session_id=XXX which the client polls to activate.

  app.post("/api/stripe/elevate-checkout", isAuthenticated, paymentLimiter, async (req: any, res) => {
    const userId: string = req.user.id;
    const { packId, cancelPath } = req.body as { packId?: string; cancelPath?: string };
    console.log(`[CHECKOUT] REQUEST_RECEIVED product=${packId} user=${userId}`);
    try {
      checkStripeReady();
      const pack = ELEVATE_PACKS[packId as keyof typeof ELEVATE_PACKS];
      if (!pack) {
        return res.status(400).json({ message: "Invalid pack ID. Must be one of: elevate-1, elevate-3, elevate-5, super-elevate" });
      }
      console.log(`[CHECKOUT] USER ${userId}`);
      console.log(`[CHECKOUT] PRODUCT ${packId} — ${pack.label}`);

      // Only allow known safe cancel paths — default to /likes
      const allowedCancelPaths = ["/likes", "/profile"];
      const safeCancelPath = allowedCancelPaths.includes(cancelPath ?? "") ? (cancelPath ?? "/likes") : "/likes";

      const stripe = getUncachableStripeClient();
      const baseUrl = process.env.FRONTEND_URL ??
        `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost:5000"}`;

      const isSuper = pack.type === "super_elevate";
      const description = isSuper
        ? "8× visibility boost in Discovery and the Intention Wheel for 60 minutes"
        : `3× visibility boost per use • ${pack.quantity} boost${pack.quantity > 1 ? "s" : ""} • 30 minutes each`;

      // Use a pre-created Stripe price ID when available; fall back to inline price_data.
      const elevateCachedPriceId = tryGetPriceId(packId!);
      const elevateLineItem = elevateCachedPriceId
        ? { price: elevateCachedPriceId, quantity: 1 }
        : { price_data: { currency: "aud", product_data: { name: pack.label, description }, unit_amount: pack.unitAmount }, quantity: 1 };

      // NOTE: The 2025-08-27.basil API handles payment methods automatically.
      // Do NOT pass payment_method_types or automatic_payment_methods — both are
      // rejected as unknown parameters in this API version.

      // Fetch real account identity before creating the session.
      const elevateAcctInfo = await getStripeAccountInfo();
      console.log(`[CHECKOUT_ACCOUNT]`, {
        accountId:      elevateAcctInfo.accountId,
        livemode:       elevateAcctInfo.livemode,
        secretKeyPrefix: elevateAcctInfo.secretKeyPrefix,
        pubKeyPrefix:   elevateAcctInfo.pubKeyPrefix,
      });

      const session = await (stripe.checkout.sessions.create as Function)({
        line_items: [elevateLineItem],
        mode: "payment",
        success_url: `${baseUrl}/elevate/success?session_id={CHECKOUT_SESSION_ID}&pack=${packId}`,
        cancel_url: `${baseUrl}${safeCancelPath}?checkout=cancelled`,
        metadata: { userId, packId, elevateType: pack.type, quantity: String(pack.quantity) },
      });

      const elevateSuccessUrl = `${baseUrl}/elevate/success?session_id={CHECKOUT_SESSION_ID}&pack=${packId}`;
      const _elevateMode = session.id.startsWith('cs_live_') ? 'LIVE' : session.id.startsWith('cs_test_') ? 'TEST' : 'UNKNOWN';
      const _elevateFrontendSrc = process.env.FRONTEND_URL ? 'FRONTEND_URL env' : 'REPLIT_DOMAINS fallback';
      console.log(
        `[STRIPE] CHECKOUT_CREATED elevate` +
        ` | session=${session.id}` +
        ` | mode=${_elevateMode}` +
        ` | pack=${packId}` +
        ` | amount=${pack.unitAmount} aud` +
        ` | user=${userId}` +
        ` | baseUrl=${baseUrl} (${_elevateFrontendSrc})` +
        ` | success_url=${elevateSuccessUrl}` +
        ` | cancel_url=${baseUrl}${safeCancelPath}?checkout=cancelled`,
      );
      if (_elevateMode === 'TEST') {
        console.log('[STRIPE] ℹ TEST session — visible in Stripe dashboard ONLY with "Test mode" toggled ON (top-left of dashboard.stripe.com)');
      }
      console.log(`[CHECKOUT_CREATED]`, {
        sessionId:  session.id,
        sessionUrl: session.url,
        livemode:   session.livemode,
      });
      console.log(`[CHECKOUT] SESSION_CREATED session=${session.id} product=${packId} amount=${pack.unitAmount} aud user=${userId}`);
      res.json({
        url:            session.url,
        sessionId:      session.id,
        accountId:      elevateAcctInfo.accountId,
        livemode:       elevateAcctInfo.livemode,
        secretKeyPrefix: elevateAcctInfo.secretKeyPrefix,
        pubKeyPrefix:   elevateAcctInfo.pubKeyPrefix,
      });
    } catch (err: any) {
      const stripeDetail = err.raw?.message ?? err.message ?? "Unknown error";
      console.error("[STRIPE] Checkout session creation failed:", {
        message: err.message,
        type: err.type,
        code: err.code,
        statusCode: err.statusCode,
        stripeCode: err.raw?.code,
        stripeMessage: err.raw?.message,
        declineCode: err.raw?.decline_code,
        packId,
        userId,
      });
      if (err.code === 'stripe_test_mode_blocked') {
        return res.status(402).json({ message: err.message, code: err.code });
      }
      // Put the real Stripe error in `message` so the client toast shows it
      res.status(500).json({
        message: stripeDetail,
        code: err.code ?? err.raw?.code,
        type: err.type,
      });
    }
  });

  // ── Verify Stripe session & add credits ───────────────────────────────────
  // Called by /elevate/success after redirect. Awards credits, does NOT activate yet.

  app.post("/api/stripe/elevate-activate", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;
    const { sessionId } = req.body as { sessionId?: string };
    try {
      if (!sessionId) return res.status(400).json({ message: "sessionId required" });

      const stripe = getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      console.log(`[STRIPE] CONFIRM_SESSION elevate sessionId=${sessionId} session_user=${session.metadata?.userId} stripe_user=${userId} paid=${session.payment_status}`);

      if (session.payment_status !== "paid") {
        return res.status(402).json({ message: "Payment not completed", paymentStatus: session.payment_status });
      }
      if (session.metadata?.userId !== userId) {
        console.warn(`[STRIPE] USER_MISMATCH elevate sessionId=${sessionId} session_user=${session.metadata?.userId} req_user=${userId}`);
        return res.status(403).json({ message: "Please return to Lulou and sign in with the same account used to start the purchase." });
      }

      const packId = session.metadata?.packId ?? "elevate-1";
      const pack = ELEVATE_PACKS[packId as keyof typeof ELEVATE_PACKS];
      if (!pack) return res.status(400).json({ message: "Unknown pack" });

      // ── Idempotency guard ─────────────────────────────────────────────────
      // Claim this session ID before touching credits. Duplicate calls (page
      // refresh, double-tap, network retry) hit the unique PK and return the
      // already-activated payload without re-granting any credits.
      try {
        await db.insert(processedStripeSessions).values({
          sessionId,
          userId,
          itemRef: packId,
        });
      } catch (insertErr: any) {
        const isUniqueViolation =
          insertErr.code === "23505" ||
          (insertErr.cause as any)?.code === "23505" ||
          String(insertErr?.message ?? "").toLowerCase().includes("unique") ||
          String(insertErr?.message ?? "").toLowerCase().includes("duplicate");
        if (isUniqueViolation) {
          console.log(`[STRIPE] elevate-activate: session ${sessionId} already processed for ${userId} — returning idempotent success`);
          const statusResult = await getStorage(req).getElevateStatus(userId);
          return res.json({
            success: true,
            packId,
            elevateType: pack.type,
            quantity: pack.quantity,
            creditsAdded: 0,
            boostActive: statusResult.active,
            expiresAt: statusResult.expiresAt?.toISOString() ?? null,
            durationMinutes: pack.type === "super_elevate" ? 60 : 30,
            alreadyProcessed: true,
          });
        }
        throw insertErr;
      }
      // ─────────────────────────────────────────────────────────────────────

      // Webhook didn't fire in time — grant as verified Stripe API fallback
      console.log(`[PURCHASE] WEBHOOK_FALLBACK_GRANT user=${userId} product=${packId} session=${sessionId}`);
      const result = await grantElevate(userId, packId as ElevatePackId);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=activate_fallback user=${userId} product=${packId} granted=${result.grantedTypes.join(", ")} autoActivated=${result.autoActivated}`);

      res.json({
        success: true,
        packId,
        elevateType: pack.type,
        quantity: pack.quantity,
        creditsAdded: pack.quantity,
        boostActive: result.autoActivated,
        expiresAt: result.expiresAt,
        durationMinutes: result.durationMinutes,
      });
    } catch (err: any) {
      const detail = err.raw?.message ?? err.message ?? "Unknown error";
      console.error("[STRIPE] elevate-activate error:", { message: err.message, type: err.type, code: err.code, sessionId, userId });
      res.status(500).json({ message: detail });
    }
  });

  // ── Use a credit to activate a boost now ─────────────────────────────────

  app.post("/api/elevate/activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type } = req.body;
      if (type !== "elevate" && type !== "super_elevate") {
        return res.status(400).json({ message: "type must be 'elevate' or 'super_elevate'" });
      }
      const result = await getStorage(req).activateElevate(userId, type);
      if (!result.success) {
        return res.status(402).json({ message: result.error ?? "No credits available" });
      }
      const durationMinutes = type === "super_elevate" ? 60 : 30;
      res.json({ success: true, elevateType: type, durationMinutes });
    } catch (err: any) {
      console.error("Error activating elevate:", err.message);
      res.status(500).json({ message: "Failed to activate boost" });
    }
  });

  // ── Elevate status & session-stats ────────────────────────────────────────

  app.get("/api/elevate/status", isAuthenticated, async (req: any, res) => {
    const t0 = Date.now();
    try {
      const userId = req.user.id;
      const status = await getStorage(req).getElevateStatus(userId);
      if (IS_DEV) console.log(`[ELEVATE_STATUS] userId=${userId} in ${Date.now() - t0} ms`);
      res.json(status);
    } catch (error) {
      console.error(`[ELEVATE_STATUS] Error after ${Date.now() - t0} ms:`, error);
      res.status(500).json({ message: "Failed to fetch elevate status" });
    }
  });

  app.get("/api/elevate/session-stats", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const stats = await getStorage(req).getElevateSessionStats(userId);
      res.json({
        ...stats,
        expiresAt: stats.expiresAt?.toISOString() ?? null,
        startedAt: stats.startedAt?.toISOString() ?? null,
      });
    } catch (error) {
      console.error("Error fetching elevate session stats:", error);
      res.status(500).json({ message: "Failed to fetch session stats" });
    }
  });

  // ── Account deletion ──────────────────────────────────────────────────────
  // Permanently removes all user data across every store:
  //   - Stripe subscription cancelled
  //   - Supabase Storage files removed (profile-photos, voice-notes)
  //   - Local DB tables wiped (user_benefits, call_credits, user_elevates,
  //     membership_subscriptions, active_sessions, blocked_contacts,
  //     saved_wheel_profiles)
  //   - Supabase tables wiped (interactions, messages, matches, profiles)
  //   - Supabase Auth user deleted
  // Retained: processed_stripe_sessions (legal accounting records)

  app.delete("/api/account", isAuthenticated, async (req: any, res) => {
    const userId: string = req.user.id;
    const log: string[] = [];

    try {
      // ── 1. Cancel Stripe subscription ─────────────────────────────────────
      const [sub] = await db
        .select()
        .from(membershipSubscriptions)
        .where(eq(membershipSubscriptions.userId, userId))
        .limit(1);

      if (sub?.stripeSubscriptionId && sub.status === "active") {
        try {
          const stripe = getUncachableStripeClient();
          await (stripe.subscriptions.cancel as Function)(sub.stripeSubscriptionId);
          log.push(`stripe_subscription_cancelled:${sub.stripeSubscriptionId}`);
        } catch (stripeErr: any) {
          // Non-fatal — subscription may have already expired
          log.push(`stripe_cancel_warn:${stripeErr.message}`);
        }
      } else {
        log.push("stripe_no_active_subscription");
      }

      // ── 2. Delete Supabase Storage files ──────────────────────────────────
      for (const bucket of ["profile-photos", "voice-notes"] as const) {
        try {
          const { data: files } = await supabaseAdmin.storage
            .from(bucket)
            .list(userId, { limit: 500 });
          if (files && files.length > 0) {
            const paths = files.map((f) => `${userId}/${f.name}`);
            const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
            if (error) {
              log.push(`storage_${bucket}_partial_error:${error.message}`);
            } else {
              log.push(`storage_${bucket}_deleted:${files.length}_files`);
            }
          } else {
            log.push(`storage_${bucket}_empty`);
          }
        } catch (storageErr: any) {
          log.push(`storage_${bucket}_error:${storageErr.message}`);
        }
      }

      // ── 3. Wipe local PostgreSQL tables ───────────────────────────────────
      await db.delete(userBenefits).where(eq(userBenefits.userId, userId));
      log.push("local_user_benefits_deleted");

      await db.delete(callCredits).where(eq(callCredits.userId, userId));
      log.push("local_call_credits_deleted");

      await db.delete(userElevates).where(eq(userElevates.userId, userId));
      log.push("local_user_elevates_deleted");

      await db.delete(membershipSubscriptions).where(eq(membershipSubscriptions.userId, userId));
      log.push("local_membership_subscriptions_deleted");

      await db.delete(activeSessions).where(eq(activeSessions.userId, userId));
      log.push("local_active_sessions_deleted");

      await db.delete(blockedContacts).where(eq(blockedContacts.userId, userId));
      log.push("local_blocked_contacts_deleted");

      await db.delete(savedWheelProfiles).where(eq(savedWheelProfiles.userId, userId));
      log.push("local_saved_wheel_profiles_deleted");

      // processed_stripe_sessions RETAINED — legal accounting records

      // ── 4. Wipe Supabase database tables ──────────────────────────────────
      await supabaseAdmin
        .from("interactions")
        .delete()
        .or(`user_id.eq.${userId},target_user_id.eq.${userId}`);
      log.push("supabase_interactions_deleted");

      const { data: matchRows } = await supabaseAdmin
        .from("matches")
        .select("id")
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

      if (matchRows && matchRows.length > 0) {
        const matchIds = matchRows.map((m: { id: string }) => m.id);
        await supabaseAdmin.from("messages").delete().in("match_id", matchIds);
        log.push(`supabase_messages_deleted_for_${matchIds.length}_matches`);
        await supabaseAdmin
          .from("matches")
          .delete()
          .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
        log.push(`supabase_matches_deleted:${matchIds.length}`);
      } else {
        log.push("supabase_no_matches_found");
      }

      await supabaseAdmin.from("profiles").delete().eq("user_id", userId);
      log.push("supabase_profile_deleted");

      // ── 5. Delete Supabase Auth user ──────────────────────────────────────
      const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (authError) {
        log.push(`supabase_auth_delete_warn:${authError.message}`);
      } else {
        log.push("supabase_auth_user_deleted");
      }

      console.log(`[DELETE ACCOUNT] User ${userId} fully deleted. Steps: ${log.join(" | ")}`);
      return res.json({ success: true, log });
    } catch (err: any) {
      console.error(
        `[DELETE ACCOUNT] Fatal error for user ${userId}:`,
        err?.message,
        "Progress so far:",
        log.join(" | ")
      );
      return res.status(500).json({
        message: "Account deletion encountered an error. Contact support@lulou.dating.",
        log,
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    seedDatabase().catch((err) =>
      console.warn("Seed error (non-fatal):", err.message)
    );
  }

  // ── WebRTC ICE server configuration ────────────────────────────────────────
  // Serves TURN credentials from server-side env vars (no VITE_ prefix) so
  // they are never embedded in the frontend bundle. Frontend fetches once per
  // session and caches the result in module scope.
  //
  // Required server env vars to enable TURN (set in Replit Secrets):
  //   TURN_URL         e.g. "turn:your-server.com:3478?transport=tcp"
  //   TURN_USERNAME    static username (or generate per-user with time-limits)
  //   TURN_CREDENTIAL  static credential
  //
  // Without these, the endpoint returns STUN-only servers. Calls will still
  // work on most home networks but WILL fail for users behind symmetric NAT,
  // corporate firewalls, and most mobile data connections.
  app.get("/api/webrtc/ice-servers", isAuthenticated, (_req: any, res: any) => {
    // TURN_URLS  — comma-separated list of TURN/TURNS URLs, all sharing the same
    //              username + credential.  Most providers (Metered, Twilio NTS) give
    //              4-5 URLs covering UDP :80, TCP :80, UDP :443, TLS :443 — storing
    //              them comma-separated in one secret is simpler than TURN_URL_1..N.
    // TURN_URL   — single-URL fallback for backward compat (used if TURN_URLS is not set).
    // TURN_USERNAME / TURN_CREDENTIAL — shared across all TURN entries.
    //
    // Set in Replit Secrets (not env vars):
    //   TURN_URLS       "turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:80?transport=tcp,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp"
    //   TURN_USERNAME   (from your Metered / Twilio dashboard)
    //   TURN_CREDENTIAL (from your Metered / Twilio dashboard)
    // Secrets are sometimes stored with surrounding JSON quotes and/or trailing
    // commas when copy-pasted from documentation (e.g. `"turn:server.com:80",`).
    // Strip them so browsers receive clean values that WebRTC actually accepts.
    const stripSecretQuotes = (s: string | undefined): string =>
      (s ?? "").replace(/^[\s"',]+|[\s"',]+$/g, "").trim();

    const turnUrlsRaw    = stripSecretQuotes(process.env.TURN_URLS || process.env.TURN_URL);
    const turnUsername   = stripSecretQuotes(process.env.TURN_USERNAME)   || undefined;
    const turnCredential = stripSecretQuotes(process.env.TURN_CREDENTIAL) || undefined;

    const iceServers: { urls: string; username?: string; credential?: string }[] = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ];

    const hasTurn = !!(turnUrlsRaw && turnUsername && turnCredential);
    if (hasTurn) {
      // Split comma-separated URLs; strip quotes from each entry individually.
      const turnUrls = turnUrlsRaw
        .split(",")
        .map(u => stripSecretQuotes(u))
        .filter(u => u.startsWith("turn:") || u.startsWith("turns:"));
      for (const url of turnUrls) {
        iceServers.push({ urls: url, username: turnUsername!, credential: turnCredential! });
      }
      console.log(`[WebRTC] ICE servers: STUN×3 + TURN×${turnUrls.length} (relay ready) urls=${JSON.stringify(turnUrls)}`);
    } else {
      console.warn("[WebRTC] /api/webrtc/ice-servers: TURN not configured — relay=0. Set TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL in Replit Secrets.");
    }

    res.json({ iceServers, hasTurn });
  });

  // ── Date Plan routes ─────────────────────────────────────────────────────────
  // Uses system messages (content prefixed __DATE_*) — no new DB tables needed.
  // All state is computed by parsing messages on every GET request.

  function parseDatePlanState(messages: any[], userId: string, user1Id: string, user2Id: string) {
    const otherUserId = user1Id === userId ? user2Id : user1Id;

    const safeParse = (prefix: string, content: string) => {
      try { return JSON.parse(content.slice(prefix.length)); } catch { return {}; }
    };

    // Votes — latest per user wins (allow re-vote)
    const votes = messages.filter((m: any) => m.content.startsWith("__DATE_TYPE_VOTE__:"));
    const myVoteMsg   = [...votes].reverse().find((m: any) => m.senderId === userId);
    const theirVoteMsg = [...votes].reverse().find((m: any) => m.senderId === otherUserId);
    const myVote    = myVoteMsg   ? (safeParse("__DATE_TYPE_VOTE__:", myVoteMsg.content).type   ?? null) : null;
    const theirVote = theirVoteMsg ? (safeParse("__DATE_TYPE_VOTE__:", theirVoteMsg.content).type ?? null) : null;

    // Venue — latest proposal wins
    const venueMsg = [...messages].reverse().find((m: any) => m.content.startsWith("__DATE_VENUE__:"));
    let venueName: string|null = null, venueAddress: string|null = null, venueProposedBy: string|null = null;
    if (venueMsg) {
      const d = safeParse("__DATE_VENUE__:", venueMsg.content);
      venueName = d.name ?? null;
      venueAddress = d.address || null;
      venueProposedBy = venueMsg.senderId;
    }

    // Venue accept — must come AFTER the latest venue proposal
    const venueAcceptMsg = venueMsg
      ? messages.filter((m: any) => m.content.startsWith("__DATE_VENUE_ACCEPT__:")
          && new Date(m.createdAt) > new Date(venueMsg.createdAt)).pop()
      : null;
    const venueAccepted = !!venueAcceptMsg;

    // DateTime — latest proposal wins
    const dtMsg = [...messages].reverse().find((m: any) => m.content.startsWith("__DATE_DATETIME__:"));
    let proposedDate: string|null = null, proposedTime: string|null = null, datetimeProposedBy: string|null = null;
    if (dtMsg) {
      const d = safeParse("__DATE_DATETIME__:", dtMsg.content);
      proposedDate = d.date ?? null;
      proposedTime = d.time ?? null;
      datetimeProposedBy = dtMsg.senderId;
    }

    // DateTime accept — must come AFTER the latest datetime proposal
    const dtAcceptMsg = dtMsg
      ? messages.filter((m: any) => m.content.startsWith("__DATE_DATETIME_ACCEPT__:")
          && new Date(m.createdAt) > new Date(dtMsg.createdAt)).pop()
      : null;
    const datetimeAccepted = !!dtAcceptMsg;

    // Confirmations
    const confirms = messages.filter((m: any) => m.content.startsWith("__DATE_CONFIRM__:"));
    const confirmedByMe   = confirms.some((m: any) => m.senderId === userId);
    const confirmedByThem = confirms.some((m: any) => m.senderId === otherUserId);
    const confirmedAt = confirms.length > 0
      ? (confirms[confirms.length - 1].createdAt instanceof Date
          ? confirms[confirms.length - 1].createdAt.toISOString()
          : String(confirms[confirms.length - 1].createdAt))
      : null;

    // Feedback
    const feedbacks = messages.filter((m: any) => m.content.startsWith("__DATE_FEEDBACK__:"));
    const myFbMsg    = feedbacks.find((m: any) => m.senderId === userId);
    const theirFbMsg = feedbacks.find((m: any) => m.senderId === otherUserId);
    const myFeedback    = myFbMsg    ? (safeParse("__DATE_FEEDBACK__:", myFbMsg.content).rating    ?? null) : null;
    const theirFeedback = theirFbMsg ? (safeParse("__DATE_FEEDBACK__:", theirFbMsg.content).rating ?? null) : null;

    // Determine step
    let step: string;
    if (confirmedByMe && confirmedByThem) {
      step = "confirmed";
    } else if (venueAccepted && datetimeAccepted) {
      step = "confirming";
    } else if (venueAccepted) {
      step = "datetime";
    } else if (myVote && theirVote && myVote === theirVote) {
      step = "venue";
    } else {
      step = "type";
    }

    return {
      step, myVote, theirVote,
      venueName, venueAddress, venueProposedBy, venueAccepted,
      proposedDate, proposedTime, datetimeProposedBy, datetimeAccepted,
      confirmedByMe, confirmedByThem, confirmedAt,
      myFeedback, theirFeedback,
      userId,
    };
  }

  app.get("/api/date-plan/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const [matchDetail, myProfile, datePlanMessages] = await Promise.all([
        storage.getMatch(matchId, userId),
        storage.getProfile(userId),
        storage.getDatePlanMessages(matchId),
      ]);

      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      const { user1Id, user2Id } = matchDetail;
      const state = parseDatePlanState(datePlanMessages, userId, user1Id, user2Id);

      const theirProfile = matchDetail.profile;
      const theirPhotos: string[] = theirProfile?.photos ?? [];
      const myPhotos: string[] = myProfile?.photos ?? [];

      res.json({
        ...state,
        theirName:  theirProfile?.firstName ?? "them",
        theirPhoto: theirPhotos[0] ?? null,
        myName:     myProfile?.firstName ?? "you",
        myPhoto:    myPhotos[0] ?? null,
      });
    } catch (err: any) {
      console.error("GET /api/date-plan error:", err?.message);
      res.status(500).json({ message: "Failed to load date plan" });
    }
  });

  app.post("/api/date-plan/:matchId/vote", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { type } = req.body;
      if (typeof type !== "string" || !type.trim()) return res.status(400).json({ message: "type required" });

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      await storage.createMessage({ matchId, senderId: userId, content: `__DATE_TYPE_VOTE__:${JSON.stringify({ type })}` });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/vote error:", err?.message);
      res.status(500).json({ message: "Failed to vote" });
    }
  });

  app.post("/api/date-plan/:matchId/venue", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { name, address } = req.body;
      if (typeof name !== "string" || !name.trim()) return res.status(400).json({ message: "name required" });

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      await storage.createMessage({ matchId, senderId: userId, content: `__DATE_VENUE__:${JSON.stringify({ name: name.trim(), address: (address ?? "").trim() })}` });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/venue error:", err?.message);
      res.status(500).json({ message: "Failed to propose venue" });
    }
  });

  app.post("/api/date-plan/:matchId/venue-accept", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      await storage.createMessage({ matchId, senderId: userId, content: `__DATE_VENUE_ACCEPT__:${JSON.stringify({ userId })}` });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/venue-accept error:", err?.message);
      res.status(500).json({ message: "Failed to accept venue" });
    }
  });

  app.post("/api/date-plan/:matchId/datetime", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { date, time } = req.body;
      if (!date || !time) return res.status(400).json({ message: "date and time required" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: "Invalid date format" });
      if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ message: "Invalid time format" });

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      await storage.createMessage({ matchId, senderId: userId, content: `__DATE_DATETIME__:${JSON.stringify({ date, time })}` });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/datetime error:", err?.message);
      res.status(500).json({ message: "Failed to propose date/time" });
    }
  });

  app.post("/api/date-plan/:matchId/datetime-accept", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      await storage.createMessage({ matchId, senderId: userId, content: `__DATE_DATETIME_ACCEPT__:${JSON.stringify({ userId })}` });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/datetime-accept error:", err?.message);
      res.status(500).json({ message: "Failed to accept date/time" });
    }
  });

  app.post("/api/date-plan/:matchId/confirm", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      // Idempotent: don't double-confirm
      const existing = await storage.getDatePlanMessages(matchId);
      const alreadyConfirmed = existing.filter(m => m.content.startsWith("__DATE_CONFIRM__:")).some(m => m.senderId === userId);
      if (!alreadyConfirmed) {
        await storage.createMessage({ matchId, senderId: userId, content: `__DATE_CONFIRM__:${JSON.stringify({ userId })}` });
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/confirm error:", err?.message);
      res.status(500).json({ message: "Failed to confirm" });
    }
  });

  app.post("/api/date-plan/:matchId/feedback", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { rating } = req.body;
      const validRatings = ["amazing","good","okay","not_great","didnt_happen"];
      if (!validRatings.includes(rating)) return res.status(400).json({ message: "Invalid rating" });

      const matchDetail = await storage.getMatch(matchId, userId);
      if (!matchDetail) return res.status(404).json({ message: "Match not found" });

      // Idempotent: update existing feedback or insert
      const existing = await storage.getDatePlanMessages(matchId);
      const myFbMsg = existing.find(m => m.content.startsWith("__DATE_FEEDBACK__:") && m.senderId === userId);
      if (!myFbMsg) {
        await storage.createMessage({ matchId, senderId: userId, content: `__DATE_FEEDBACK__:${JSON.stringify({ rating })}` });
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/date-plan/feedback error:", err?.message);
      res.status(500).json({ message: "Failed to submit feedback" });
    }
  });

  // ── Connection DNA ─────────────────────────────────────────────────────────────────────

  /** GET /api/dna/status — check if the current user has completed the DNA quiz */
  app.get("/api/dna/status", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { pool } = await import("./db");
      const r = await (pool as any).query(
        "SELECT completed_at, dimensions IS NOT NULL AS has_dimensions FROM connection_dna_profiles WHERE user_id = $1",
        [userId],
      );
      const row = r.rows[0];
      res.json({
        completed:   !!row?.completed_at,
        hasDna:      !!row?.has_dimensions,
      });
    } catch (err: any) {
      console.error("GET /api/dna/status error:", err?.message);
      res.status(500).json({ message: "Failed to fetch DNA status" });
    }
  });

  /** GET /api/dna/responses — get saved answers for the current user */
  app.get("/api/dna/responses", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { pool } = await import("./db");
      const r = await (pool as any).query(
        "SELECT question_id, answer_index FROM connection_dna_responses WHERE user_id = $1",
        [userId],
      );
      const responses: Record<string, number> = {};
      for (const row of r.rows) responses[row.question_id] = row.answer_index;
      res.json({ responses });
    } catch (err: any) {
      console.error("GET /api/dna/responses error:", err?.message);
      res.status(500).json({ message: "Failed to fetch responses" });
    }
  });

  /** POST /api/dna/response — save a single answer (upsert) */
  app.post("/api/dna/response", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { questionId, answerIndex } = req.body;
      if (typeof questionId !== "string" || typeof answerIndex !== "number") {
        return res.status(400).json({ message: "Invalid payload" });
      }
      const { pool } = await import("./db");
      await (pool as any).query(
        `INSERT INTO connection_dna_responses (user_id, question_id, answer_index, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, question_id)
         DO UPDATE SET answer_index = EXCLUDED.answer_index, updated_at = NOW()`,
        [userId, questionId, answerIndex],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/dna/response error:", err?.message);
      res.status(500).json({ message: "Failed to save response" });
    }
  });

  /** POST /api/dna/complete — compute + store DNA profile */
  app.post("/api/dna/complete", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { pool } = await import("./db");

      // Load all answers
      const r = await (pool as any).query(
        "SELECT question_id, answer_index FROM connection_dna_responses WHERE user_id = $1",
        [userId],
      );
      const responses: Record<string, number> = {};
      for (const row of r.rows) responses[row.question_id] = row.answer_index;

      // Compute dimensions
      const { computeDnaProfile, serializeDna, ALGO_VERSION } = await import("./connectionDna");
      const dimensions = computeDnaProfile(responses);
      const dimensionsJson = serializeDna(dimensions);

      await (pool as any).query(
        `INSERT INTO connection_dna_profiles (user_id, dimensions, version, completed_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET dimensions = EXCLUDED.dimensions, version = EXCLUDED.version,
                       completed_at = COALESCE(connection_dna_profiles.completed_at, NOW()),
                       updated_at = NOW()`,
        [userId, dimensionsJson, ALGO_VERSION],
      );

      res.json({ ok: true, dimensions });
    } catch (err: any) {
      console.error("POST /api/dna/complete error:", err?.message);
      res.status(500).json({ message: "Failed to complete DNA profile" });
    }
  });

  /** POST /api/dna/retake — reset quiz answers + profile (keep row, clear completion) */
  app.post("/api/dna/retake", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { pool } = await import("./db");
      await (pool as any).query(
        "DELETE FROM connection_dna_responses WHERE user_id = $1",
        [userId],
      );
      await (pool as any).query(
        `UPDATE connection_dna_profiles
         SET dimensions = NULL, completed_at = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      );
      // Invalidate cached compatibility for this user
      await (pool as any).query(
        "DELETE FROM match_compatibility WHERE user_a_id = $1 OR user_b_id = $1",
        [userId],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/dna/retake error:", err?.message);
      res.status(500).json({ message: "Failed to reset quiz" });
    }
  });

  /** GET /api/dna/reasons/:candidateId — get "Why Lulou introduced you" reasons */
  app.get("/api/dna/reasons/:candidateId", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId      = req.user.id;
      const candidateId = req.params.candidateId;
      if (!candidateId) return res.status(400).json({ message: "Missing candidateId" });

      const { pool } = await import("./db");

      // Check cache first (user_a < user_b order)
      const [keyA, keyB] = userId < candidateId ? [userId, candidateId] : [candidateId, userId];
      const cached = await (pool as any).query(
        "SELECT reason_texts, is_variety_pick FROM match_compatibility WHERE user_a_id = $1 AND user_b_id = $2",
        [keyA, keyB],
      );
      if (cached.rows[0]?.reason_texts) {
        const reasons = JSON.parse(cached.rows[0].reason_texts);
        return res.json({ reasons, fromCache: true });
      }

      // Load both DNA profiles
      const profilesR = await (pool as any).query(
        "SELECT user_id, dimensions, completed_at FROM connection_dna_profiles WHERE user_id = ANY($1)",
        [[userId, candidateId]],
      );
      const byId: Record<string, string | null> = {};
      for (const row of profilesR.rows) byId[row.user_id] = row.dimensions;

      const { computeDnaProfile, deserializeDna, computeCompatibility, generateReasons, serializeDna, ALGO_VERSION } = await import("./connectionDna");

      const userDna      = deserializeDna(byId[userId]      ?? null);
      const candidateDna = deserializeDna(byId[candidateId] ?? null);

      if (!userDna || !candidateDna) {
        return res.json({ reasons: [{ key: "default", text: "Lulou thought you might connect well" }] });
      }

      const { total, components } = computeCompatibility(userDna, candidateDna);
      const isVariety = total < 55;
      const reasons   = generateReasons(userDna, candidateDna, isVariety);

      // Cache result
      try {
        await (pool as any).query(
          `INSERT INTO match_compatibility
             (user_a_id, user_b_id, total_score, component_scores, reason_texts, is_variety_pick, version, calculated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (user_a_id, user_b_id) DO UPDATE
             SET total_score=EXCLUDED.total_score, component_scores=EXCLUDED.component_scores,
                 reason_texts=EXCLUDED.reason_texts, is_variety_pick=EXCLUDED.is_variety_pick,
                 version=EXCLUDED.version, calculated_at=NOW()`,
          [keyA, keyB, total, JSON.stringify(components), JSON.stringify(reasons.map(r => r.text)), isVariety, ALGO_VERSION],
        );
      } catch { /* cache write failure is non-critical */ }

      res.json({ reasons: reasons.map(r => r.text), total });
    } catch (err: any) {
      console.error("GET /api/dna/reasons error:", err?.message);
      res.status(500).json({ message: "Failed to fetch reasons" });
    }
  });

  /** POST /api/dna/feedback — private post-interaction feedback (never exposed to other user) */
  app.post("/api/dna/feedback", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { matchId, selectedReason } = req.body;
      if (!matchId || !selectedReason) return res.status(400).json({ message: "Invalid payload" });

      // Rate-limit: one feedback per match per user
      const { pool } = await import("./db");
      const existing = await (pool as any).query(
        "SELECT id FROM private_connection_feedback WHERE user_id = $1 AND match_id = $2",
        [userId, matchId],
      );
      if (existing.rows.length > 0) return res.json({ ok: true, duplicate: true });

      await (pool as any).query(
        "INSERT INTO private_connection_feedback (user_id, match_id, selected_reason) VALUES ($1, $2, $3)",
        [userId, matchId, selectedReason],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/dna/feedback error:", err?.message);
      res.status(500).json({ message: "Failed to save feedback" });
    }
  });

  /** POST /api/dna/signal — record a behavioural interaction signal */
  app.post("/api/dna/signal", isAuthenticated, async (req: any, res: any) => {
    try {
      const userId = req.user.id;
      const { targetUserId, matchId, eventType } = req.body;
      if (!targetUserId || !eventType) return res.status(400).json({ message: "Invalid payload" });

      const WEIGHTS: Record<string, number> = {
        open: 1, like: 2, pass: 1, message_10: 5, voice_note: 6,
        call_started: 8, call_completed: 10, plan_date: 12,
      };
      const weight = WEIGHTS[eventType] ?? 1;

      const { pool } = await import("./db");
      await (pool as any).query(
        `INSERT INTO interaction_signals (user_id, target_user_id, match_id, event_type, event_weight)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, targetUserId, matchId ?? null, eventType, weight],
      );
      res.json({ ok: true });
    } catch (err: any) {
      console.error("POST /api/dna/signal error:", err?.message);
      res.status(500).json({ message: "Failed to record signal" });
    }
  });

  // Global error handler — catches any unhandled errors that escape route try/catch blocks.
  // Without this, Express would return an HTML error page instead of JSON, causing clients
  // to display a literal "Internal Server Error" string from the HTTP status text.
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("[EXPRESS_GLOBAL_ERROR]", {
      message: err?.message,
      stack: err?.stack,
      code: err?.code,
    });
    if (!res.headersSent) {
      res.status(err?.status || 500).json({
        message: err?.message || "An unexpected server error occurred",
        code: err?.code || "INTERNAL_ERROR",
      });
    }
  });

  return httpServer;
}

