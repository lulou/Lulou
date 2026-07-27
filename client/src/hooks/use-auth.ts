import { useState, useEffect, useCallback, useRef, createContext, useContext, createElement } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { setCachedToken, queryClient, API_BASE } from "@/lib/queryClient";
import { stopAllCallSounds } from "@/lib/call-audio";
import { clearAllArmedSessions, setLoginTime } from "@/lib/live-call-sessions";
import { writeDebug } from "@/lib/debug-store";
import type { User } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// AuthContext
//
// WHY a Context instead of per-component useState:
//
//   useAuth() was previously a hook that created SEPARATE React state for every
//   component that called it.  AppContent, AppLayout, and ProfilePage each had
//   their own `user` state.  When logout() called setUser(null) inside
//   AppLayout's instance, AppContent's instance still held user=validUser and
//   kept rendering the authenticated app.  AppContent only updated after
//   supabase.auth.signOut() resolved and onAuthStateChange(SIGNED_OUT) fired —
//   so the first click appeared to do nothing (the "two clicks" bug).
//
//   With a shared AuthContext, there is exactly ONE user state.  setUser(null)
//   from logout() propagates immediately to all consumers (AppContent, AppLayout,
//   ProfilePage) in the same React render batch.  First click → Landing page.
// ─────────────────────────────────────────────────────────────────────────────

type AuthContextType = {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
  isLoggingOut: boolean;
  profileInitError: null;
  profileReady: boolean;
  clearingCache: boolean;
  // Password recovery — true when the user arrives via a password-reset link.
  // The PASSWORD_RECOVERY auth event fires after detectSessionInUrl:true reads
  // the #access_token=...&type=recovery hash.  A PasswordRecoveryGate is shown
  // until the user sets a new password and we call clearPasswordRecovery().
  passwordRecovery: boolean;
  clearPasswordRecovery: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  // When true, the query cache is being cleared after an account change.
  // AppContent must not start the profile-exists-check query until this is false,
  // otherwise queryClient.clear() fires mid-flight and resets the in-progress
  // fetch back to isLoading:true — the root cause of the "endless spinner" bug.
  const [clearingCache, setClearingCache] = useState(false);

  // Track the previous auth user ID so we can detect actual account changes
  // (as opposed to token-refresh events which keep the same user).
  const prevUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      const u = session?.user ?? null;
      const newUserId = u?.id ?? null;
      const prevUserId = prevUserIdRef.current;

      console.log("[AUTH] AUTH_STATE_CHANGE", {
        event,
        userId: newUserId,
        prevUserId,
        userChanged: prevUserId !== newUserId,
      });
      writeDebug({ authEvent: event, currentSessionUserId: newUserId });

      // When the authenticated user changes (different account, or sign-out),
      // clear the entire query cache so the new user never sees stale data from
      // the previous user.  Token-refresh events keep the same userId and do NOT
      // clear the cache — only genuine account changes do.
      //
      // IMPORTANT: deferred via setTimeout(0) so the clear runs after the
      // current Supabase auth callback and the React render it triggers have
      // finished committing.  Calling queryClient.clear() synchronously inside
      // onAuthStateChange can fire while React is mid-render (updating hook
      // queues), which produces a "Should have a queue" React error.
      if (prevUserId !== newUserId) {
        console.log("[AUTH] USER_CHANGED: blocking profile query while cache clears", {
          from: prevUserId ? prevUserId.slice(0, 8) + "…" : "none",
          to:   newUserId  ? newUserId.slice(0, 8)  + "…" : "none",
        });
        setTimeout(() => {
          if (mounted) setClearingCache(true);
          setTimeout(() => {
            queryClient.clear();
            console.log("[AUTH] CACHE_CLEARED: profile query can now start");
            if (mounted) setClearingCache(false);
          }, 0);
        }, 0);
      }
      prevUserIdRef.current = newUserId;

      if (session?.access_token) {
        setCachedToken(session.access_token, (session as any).expires_at ?? 0);
        console.log("[AUTH] SESSION_RECEIVED", {
          event,
          userId: newUserId,
          expiresAt: (session as any).expires_at,
        });
      } else {
        setCachedToken(null);
      }

      // ── Single-device gate ──────────────────────────────────────────────────
      // Two separate paths depending on whether this is a NEW login or an
      // EXISTING session being restored.
      //
      // SIGNED_IN (new login):
      //   Check the server BEFORE entering the app.  setUser(u) is only called
      //   after the server confirms no other device has an active session.
      //   While the check is in-flight, user === null → Landing stays visible.
      //   WHY here and not in landing.tsx: signInWithPassword fires this callback
      //   BEFORE its own Promise resolves, so anything placed after the `await`
      //   in landing.tsx is already too late to stop app entry.
      //
      // INITIAL_SESSION / TOKEN_REFRESHED (existing session, page refresh/reopen):
      //   Enter the app immediately (no blocking — the user is already authenticated).
      //   BUT register this device in active_sessions as a background fire-and-forget.
      //   This is the critical fix for the root cause: devices that were logged in
      //   before session-enforcement was added never had a row in active_sessions.
      //   Without registration here, active_sessions is always empty → every new
      //   login attempt from a second device finds no row → returns "allowed" → both
      //   devices end up logged in simultaneously.
      if (event === "SIGNED_IN" && u && session?.access_token) {
        const token = session.access_token;

        // ── Hard-reset call state on every sign-in ────────────────────────────
        // Runs synchronously before any async work so that:
        //  1. Any ringtone left over from the previous session (or a stale armed
        //     session that survived logout) is silenced immediately.
        //  2. clearAllArmedSessions wipes module-level state so the incomingCall
        //     memo and rering guards see a clean slate for this login.
        //  3. APP_LOAD_TIME is frozen at page-load and never updates between
        //     logins; clearing armed sessions here ensures calls from the
        //     previous session can never sneak past isArmedSession() after
        //     re-login in the same tab.
        stopAllCallSounds("[AUTH] SIGNED_IN audio/armed-session reset");
        clearAllArmedSessions();

        // ── Pending-verification guard (SIGNED_IN) ────────────────────────────
        // If a signup was started for email B while Account A was logged in, we
        // store "lulou_pending_verification_email" = B in sessionStorage.  When
        // the user returns to the app mid-verification, Supabase may fire SIGNED_IN
        // with Account A's freshly-refreshed token.  Block it so the verification
        // screen stays intact.  When B's own email link fires SIGNED_IN with B's
        // confirmed session, clear the flag and let normal flow continue.
        {
          const pendingEmail = sessionStorage.getItem("lulou_pending_verification_email");
          if (pendingEmail) {
            if (u.email === pendingEmail) {
              // This is the verified email we've been waiting for — clear both guards.
              console.log("[VERIFY] VERIFIED_EMAIL_MATCHED — clearing pending verification flag", {
                email: pendingEmail.slice(0, 4) + "***",
                userId: u.id.slice(0, 8) + "…",
              });
              sessionStorage.removeItem("lulou_pending_verification_email");
              sessionStorage.removeItem("lulou_rate_limit_pending");
              // Fall through to normal SIGNED_IN path below.
            } else {
              // Different account trying to slip in while verification/rate-limit is pending.
              const isRateLimit = !!sessionStorage.getItem("lulou_rate_limit_pending");
              if (isRateLimit) {
                console.warn("[VERIFY] OLD_SESSION_BLOCKED_DURING_RATE_LIMIT — SIGNED_IN with non-pending email while rate-limit cooldown is active", {
                  sessionEmail: (u.email ?? "").slice(0, 4) + "***",
                  pendingEmail: pendingEmail.slice(0, 4) + "***",
                });
              } else {
                console.warn("[VERIFY] SESSION_EMAIL_MISMATCH_BLOCKED — SIGNED_IN with non-pending email, blocking session restore", {
                  sessionEmail: (u.email ?? "").slice(0, 4) + "***",
                  pendingEmail: pendingEmail.slice(0, 4) + "***",
                });
              }
              supabase.auth.signOut({ scope: "local" }).catch(() => {});
              if (mounted) {
                setUser(null);
                setProfileReady(true);
                setIsLoading(false);
              }
              return;
            }
          }
        }

        // ── Skip single-device gate on Stripe return ──────────────────────────
        // When the user is redirected back from Stripe Checkout, the browser
        // fires a full page navigation to /extras/success or /elevate/success.
        // Some browsers (especially mobile) fire SIGNED_IN instead of
        // INITIAL_SESSION on that reload.  The single-device gate would then
        // race the purchase activation and could sign the user out if it found
        // a stale session row from just before they left for Stripe.
        // All checkout initiators set this flag before redirecting to Stripe.
        const isStripeReturn = sessionStorage.getItem("lulou_stripe_checkout") === "1";
        if (isStripeReturn) {
          sessionStorage.removeItem("lulou_stripe_checkout");
          console.log("[AUTH] STRIPE_RETURN_BYPASS — skipping single-device gate, treating as session restore", {
            userId: newUserId,
            route: window.location.pathname,
          });
          setCachedToken(token, (session as any).expires_at ?? 0);
          setUser(u);
          setProfileReady(true);
          setIsLoading(false);
          return;
        }

        // ── Re-enter loading state BEFORE the async IIFE ─────────────────────
        // INITIAL_SESSION(null) already set isLoading:false and user:null.
        // Without this, navigating from /auth/callback to / while the session-
        // check is in-flight shows Landing (user:null + isLoading:false).
        // Setting isLoading:true here ensures AppContent shows the auth spinner
        // during the check instead of the Landing page.
        setIsLoading(true);
        console.log("[AUTH] SIGNED_IN_RECEIVED — session check starting, isLoading→true", {
          userId: newUserId,
          hasToken: !!token,
          route: window.location.pathname,
        });

        (async () => {
          const sessionId =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

          let deviceId = localStorage.getItem("lulou_device_id") ?? "";
          if (!deviceId) {
            deviceId =
              typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `${Date.now()}-d`;
            localStorage.setItem("lulou_device_id", deviceId);
          }

          // REVOKE model: session-check always allows new logins.
          // The server revokes the old session atomically and broadcasts to the
          // old device via a session-scoped channel.  We never block here.
          let grantedSessionId = sessionId;

          try {
            console.log("[AUTH] SESSION_CHECK_START", { sessionId: sessionId.slice(0, 8) + "…", deviceId: deviceId.slice(0, 8) + "…" });
            const r = await fetch(`${API_BASE}/api/auth/session-check`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                sessionId,
                deviceId,
                userAgent: navigator.userAgent,
              }),
            });
            if (r.ok) {
              const d = await r.json();
              grantedSessionId = d.sessionId ?? sessionId;
              console.log("[AUTH] SESSION_CHECK_OK", { grantedSessionId: grantedSessionId.slice(0, 8) + "…" });
            } else {
              console.warn("[AUTH] SESSION_CHECK_NON_OK — fail-open", { status: r.status });
            }
          } catch (e) {
            // Fail open — a transient network error never locks users out
            console.warn("[AUTH] SESSION_CHECK_FAILED (fail-open)", { error: String(e) });
          }

          if (!mounted) return;

          localStorage.setItem("lulou_session_id", grantedSessionId);
          // Record the precise moment this login was accepted so that
          // use-call-signaling.ts can reject rering broadcasts for calls
          // that started before this login (previous session's stale calls).
          setLoginTime(Date.now());
          // Fire-and-forget: ask the server to clear any ringing call records
          // older than 90 s that belong to this user.  This prevents stale
          // DB rows from triggering rering broadcasts that would otherwise
          // pass the APP_LOAD_TIME guard (same page load, different login).
          fetch(`${API_BASE}/api/calls/sweep-expired`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }).then(async (r) => {
            const j = await r.json().catch(() => ({}));
            console.log("[AUTH] LOGIN_CALL_SWEEP", { cleared: j.cleared ?? 0, userId: newUserId?.slice(0, 8) });
          }).catch((e) => {
            console.warn("[AUTH] LOGIN_CALL_SWEEP_FAILED (non-fatal)", { error: String(e) });
          });
          setUser(u);
          setProfileReady(true);
          setIsLoading(false);
          console.log("[AUTH] AUTH_READY — user set, isLoading→false", { event, userId: newUserId });
        })();

        // Return WITHOUT calling setUser or setIsLoading.
        // The async IIFE above will do both after the check completes.
        return;
      }

      // PASSWORD_RECOVERY fires when the user clicks a password-reset link and
      // detectSessionInUrl:true reads the #access_token=...&type=recovery hash.
      // Set the passwordRecovery flag so the app renders a PasswordRecoveryGate
      // instead of the normal UI while the user sets their new password.
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
        console.log("[AUTH] PASSWORD_RECOVERY_SESSION — showing password recovery gate");
      }

      // All other events (INITIAL_SESSION, TOKEN_REFRESHED, SIGNED_OUT, etc.)
      // proceed with the normal synchronous path.
      //
      // NOTE: We deliberately do NOT fire a heartbeat here for INITIAL_SESSION /
      // TOKEN_REFRESHED.  A fire-and-forget fetch can outlive the logout flow
      // (which is also async) and re-upsert a row into active_sessions AFTER the
      // logout DELETE has removed it.  That stale row then blocks the next login.
      //
      // Session registration for already-logged-in devices is handled by the
      // periodic heartbeat useEffect below, which fires immediately on first mount
      // (< 1 s after setUser(u)), and every 60 s thereafter while the user is
      // signed in.  Its lifecycle is tied to the user state, so it automatically
      // stops when the user logs out — no race condition is possible.

      // ── Pending-verification guard (INITIAL_SESSION / TOKEN_REFRESHED) ───────
      // After signup for email B, the old Account A session may still be cached
      // in Supabase's localStorage (signOut({ scope:"local" }) was called before
      // signUp but there is a race window on slow networks / page restores).
      // If sessionStorage says we're waiting for B to verify, drop any restored
      // session that isn't for B to prevent the "silently logged into old account"
      // bug.
      if (event === "INITIAL_SESSION" && u) {
        const pendingEmail = sessionStorage.getItem("lulou_pending_verification_email");
        if (pendingEmail && u.email !== pendingEmail) {
          const isRateLimit = !!sessionStorage.getItem("lulou_rate_limit_pending");
          if (isRateLimit) {
            console.warn("[VERIFY] OLD_SESSION_BLOCKED_DURING_RATE_LIMIT — INITIAL_SESSION with non-pending email while rate-limit cooldown is active", {
              sessionEmail: (u.email ?? "").slice(0, 4) + "***",
              pendingEmail: pendingEmail.slice(0, 4) + "***",
              userId: u.id.slice(0, 8) + "…",
            });
          } else {
            console.warn("[VERIFY] OLD_SESSION_BLOCKED — INITIAL_SESSION with non-pending email while verification is pending", {
              sessionEmail: (u.email ?? "").slice(0, 4) + "***",
              pendingEmail: pendingEmail.slice(0, 4) + "***",
              userId: u.id.slice(0, 8) + "…",
            });
          }
          supabase.auth.signOut({ scope: "local" }).catch(() => {});
          if (mounted) {
            setUser(null);
            setProfileReady(true);
            setIsLoading(false);
          }
          return;
        }
      }

      // ── INITIAL_SESSION: verify application session against active_sessions ──
      // Root cause of "Forgot password → refresh → Account A appears":
      //   1. Browser had Account A's Supabase token cached in localStorage.
      //   2. User clicked "Forgot password" — local session was NOT cleared.
      //   3. On refresh, INITIAL_SESSION fired with Account A's token.
      //   4. No server check was performed → app opened silently as Account A.
      //
      // Fix: INITIAL_SESSION now verifies the stored lulou_session_id against
      // the server's active_sessions record before entering the app.  If the
      // session has been replaced (another device logged in) or the session-id
      // is absent, the user is signed out locally and the login page is shown.
      //
      // Fail-open: network / 5xx errors never sign the user out (same policy as
      // the existing SIGNED_IN session-check path).
      if (event === "INITIAL_SESSION" && u && session?.access_token) {
        const token = session.access_token;
        setIsLoading(true);
        console.log("[AUTH] INITIAL_SESSION_VERIFY_START", { userId: newUserId?.slice(0, 8) });

        (async () => {
          const storedSessionId = localStorage.getItem("lulou_session_id") ?? "";
          let verified = false;

          try {
            if (storedSessionId) {
              // Verify against active_sessions — fast path
              const r = await fetch(`${API_BASE}/api/auth/session-verify`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  // Send the session-id in both the header (for middleware) and body (for endpoint)
                  "X-Session-Id": storedSessionId,
                },
                body: JSON.stringify({ sessionId: storedSessionId }),
              });
              if (r.ok) {
                const d = await r.json();
                verified = d.valid === true;
                if (!verified) {
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_REJECTED", { reason: d.reason, userId: newUserId?.slice(0, 8) });
                } else {
                  console.log("[AUTH] INITIAL_SESSION_VERIFIED — entering app", { userId: newUserId?.slice(0, 8) });
                }
              } else if (r.status === 401) {
                // Middleware rejected: session replaced or expired
                const body = await r.json().catch(() => ({}));
                verified = false;
                console.warn("[AUTH] INITIAL_SESSION_VERIFY_401", { message: body?.message, userId: newUserId?.slice(0, 8) });
              } else {
                // 5xx / unexpected — fail open so an outage doesn't sign everyone out
                verified = true;
                console.warn("[AUTH] INITIAL_SESSION_VERIFY_FAIL_OPEN (non-2xx, non-401)", { status: r.status });
              }
            } else {
              // No application session ID — register this device via session-check.
              // Handles devices that were already logged in before this enforcement
              // code was deployed (they never received a lulou_session_id).
              const newSessionId =
                typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                  ? crypto.randomUUID()
                  : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const deviceId = localStorage.getItem("lulou_device_id") ?? "";
              const r = await fetch(`${API_BASE}/api/auth/session-check`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ sessionId: newSessionId, deviceId, userAgent: navigator.userAgent }),
              });
              if (r.ok) {
                const d = await r.json();
                // REVOKE model: session-check always grants the new session.
                // d.blocked is never returned; session is always allowed.
                localStorage.setItem("lulou_session_id", d.sessionId ?? newSessionId);
                verified = true;
                console.log("[AUTH] INITIAL_SESSION_REGISTERED — new session_id assigned", { userId: newUserId?.slice(0, 8) });
              } else {
                // Fail open on server errors
                verified = true;
                console.warn("[AUTH] INITIAL_SESSION_REGISTER_FAIL_OPEN", { status: r.status });
              }
            }
          } catch (e) {
            // Network error — fail open
            verified = true;
            console.warn("[AUTH] INITIAL_SESSION_VERIFY_NETWORK_ERROR (fail-open)", { error: String(e) });
          }

          if (!mounted) return;

          if (verified) {
            setUser(u);
            setProfileReady(true);
            setIsLoading(false);
          } else {
            // Session replaced or blocked — clear local state and return to login
            supabase.auth.signOut({ scope: "local" }).catch(() => {});
            localStorage.removeItem("lulou_session_id");
            setCachedToken(null);
            // Flag for landing.tsx to show "signed out because account on another device" toast
            sessionStorage.setItem("lulou_forced_logout", "session_replaced");
            setTimeout(() => {
              if (mounted) setClearingCache(true);
              setTimeout(() => { queryClient.clear(); if (mounted) setClearingCache(false); }, 0);
            }, 0);
            setUser(null);
            setProfileReady(true);
            setIsLoading(false);
            console.log("[AUTH] INITIAL_SESSION_REJECTED — showing login page", { userId: newUserId?.slice(0, 8) });
          }
        })();

        return; // async IIFE handles setUser / setIsLoading
      }

      setUser(u);

      if (mounted) {
        setProfileReady(true);
        setIsLoading(false);
        console.log("[AUTH] AUTH_READY", { event, userId: newUserId });
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);


  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // Ref guard prevents a second call from starting if the user double-taps
  // while the first signOut() is already in flight.
  const loggingOutRef = useRef(false);

  const logout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    setIsLoggingOut(true);
    console.log("[LOGOUT_FIX] first click received");

    // ── Hard guards: stop audio + clear call arming state FIRST ──────────────
    // Must run before any React state update so call audio is silenced on the
    // same synchronous tick as the click.  stopAllCallSounds resets the module-
    // level _ringtoneActive/_ringbackActive flags and pauses any live elements.
    // clearAllArmedSessions wipes the live-call-sessions arming Set so no
    // subsequent re-render can re-mount an overlay or restart audio.
    stopAllCallSounds("[LOGOUT_FIX] audio stopped on logout");
    clearAllArmedSessions();

    sessionStorage.removeItem("lulou-bypass");
    // Kill the token cache so no in-flight request sneaks through with old creds.
    setCachedToken(null);

    // Clear the active_sessions row so another device can log in immediately
    // rather than having to wait for the 15-minute heartbeat expiry.
    // MUST be awaited — a fire-and-forget DELETE can lose a race against any
    // in-flight heartbeat POST, which would re-create the row after the DELETE
    // and leave a stale session that blocks the next login attempt.
    try {
      const { data: { session: _s } } = await supabase.auth.getSession();
      if (_s?.access_token) {
        await fetch(`${API_BASE}/api/auth/session`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${_s.access_token}` },
        });

        // Remove push subscription before signing out so this device stops
        // receiving notifications for this account after logout.
        // Must happen while the session is still valid (before signOut).
        try {
          if ("serviceWorker" in navigator && "PushManager" in window) {
            const sw = await navigator.serviceWorker.ready.catch(() => null);
            const sub = sw ? await sw.pushManager.getSubscription().catch(() => null) : null;
            if (sub) {
              await fetch(`${API_BASE}/api/push/subscribe`, {
                method: "DELETE",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${_s.access_token}`,
                },
                body: JSON.stringify({ endpoint: sub.endpoint }),
              }).catch(() => {});
              await sub.unsubscribe().catch(() => {});
              console.log("[AUTH_LOGOUT] Push subscription removed from server and browser ✓");
            }
          }
        } catch (pushErr: any) {
          console.warn("[AUTH_LOGOUT] Push cleanup failed (non-fatal):", pushErr?.message);
        }
      }
    } catch {}
    localStorage.removeItem("lulou_session_id");

    // ── KEY FIX: setUser(null) in the SHARED AuthContext ─────────────────────
    // With the old per-component-hook approach, setUser(null) only updated the
    // hook instance that called logout().  AppContent's own instance remained
    // user=validUser until onAuthStateChange fired, so the authenticated app
    // stayed visible — the "two clicks" root cause.
    //
    // Now there is exactly ONE user state (AuthContext).  This single setUser(null)
    // propagates to ALL consumers (AppContent, AppLayout, ProfilePage) in the
    // same React render batch.  AppContent renders <Landing /> on first click.
    setUser(null);

    // Clear the query cache synchronously — no stale data visible if the user
    // logs in again in the same tab.
    queryClient.clear();
    console.log("[LOGOUT_FIX] local state cleared immediately");

    // Navigate to root immediately.  user is already null so AppContent is
    // rendering Landing — replaceState is cosmetic (clean URL bar).
    window.history.replaceState(null, "", "/");
    console.log("[LOGOUT_FIX] redirected immediately");

    // Revoke the Supabase session server-side. This also fires
    // onAuthStateChange(SIGNED_OUT) which calls setUser(null) again (idempotent)
    // and schedules another queryClient.clear() (no-op on an already-cleared
    // cache). Errors here are non-fatal — the user is already on Landing.
    try {
      await supabase.auth.signOut();
      console.log("[AUTH_LOGOUT] supabase signOut complete");
    } catch (err) {
      console.error("[AUTH_LOGOUT] supabase signOut error (non-fatal, user already logged out locally)", err);
    }

    loggingOutRef.current = false;
    setIsLoggingOut(false);
  }, []);

  // ── Session heartbeat ─────────────────────────────────────────────────────
  // Keeps the active_sessions row alive while the app is open.
  // The server expires sessions after 15 minutes of no heartbeat, which
  // unblocks logins from a new device once the old one is inactive.
  // Fires every 60 seconds + on every tab-focus so closing/backgrounding the
  // browser lets the session expire naturally without manual logout.
  useEffect(() => {
    if (!user?.id) return;

    const sendHeartbeat = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const sessionId = localStorage.getItem("lulou_session_id") ?? "";
        const deviceId  = localStorage.getItem("lulou_device_id")  ?? "";
        const r = await fetch(`${API_BASE}/api/auth/heartbeat`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            // X-Session-Id lets the middleware reject this heartbeat if our session
            // was replaced (another device logged in), triggering a forced logout.
            ...(sessionId ? { "X-Session-Id": sessionId } : {}),
          },
          body: JSON.stringify({ sessionId, deviceId, userAgent: navigator.userAgent }),
        });
        if (r.status === 401) {
          const body = await r.json().catch(() => ({}));
          if (body?.message === "session_replaced") {
            console.warn("[AUTH] HEARTBEAT_SESSION_REPLACED — dispatching forced-logout event");
            window.dispatchEvent(new CustomEvent("lulou:session-replaced"));
          }
        }
      } catch {}
    };

    // Fire immediately on mount so the session is refreshed right away.
    sendHeartbeat();

    // Continue every 60 seconds while the tab is alive.
    const interval = setInterval(sendHeartbeat, 60_000);

    // Also fire whenever the user returns to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") sendHeartbeat();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user?.id]);

  // ── Realtime session-replaced channel (SESSION-SCOPED) ───────────────────
  // Subscribe to `private-session:{mySessionId}` — a channel that is unique to
  // THIS device's application session.  When the server replaces this session
  // (new login from a different device), it broadcasts ONLY to this channel,
  // ensuring the NEW device (which subscribes to its own session channel) is
  // never accidentally signed out by receiving the broadcast.
  //
  // Falls back to the 401 session_replaced path (middleware gate or heartbeat)
  // if the broadcast is missed while the device is offline.
  useEffect(() => {
    if (!user?.id) return;

    const mySessionId = localStorage.getItem("lulou_session_id") ?? "";
    if (!mySessionId) return; // no session ID yet — heartbeat 401 covers this

    const channelName = `private-session:${mySessionId}`;
    const channel = supabase
      .channel(channelName)
      .on("broadcast", { event: "session-replaced" }, (msg) => {
        const payload = msg.payload ?? {};
        // Defense-in-depth: only act if this broadcast is for our session ID.
        // (The session-scoped channel already ensures this, but belt-and-braces.)
        if (payload.newSessionId && payload.newSessionId === mySessionId) {
          // We ARE the new device — server sent to wrong channel; ignore.
          console.warn("[AUTH] IGNORED session-replaced broadcast (we are the new device)", { payload });
          return;
        }
        console.log("[AUTH] SESSION_REPLACED_BROADCAST received on session channel", { sessionId: mySessionId.slice(0, 8) + "…", payload });
        window.dispatchEvent(new CustomEvent("lulou:session-replaced"));
      })
      .subscribe((status) => {
        console.log(`[AUTH] SESSION_CHANNEL_STATUS ${channelName} → ${status}`);
      });

    return () => {
      supabase.removeChannel(channel).catch(() => {});
    };
  }, [user?.id]);

  // ── Forced-logout event handler ───────────────────────────────────────────
  // Fires when either:
  //   a) The realtime session-replaced broadcast is received (above), or
  //   b) An API response returns 401 session_replaced (queryClient.ts interception),
  //      or the heartbeat returns 401 session_replaced.
  //
  // Performs a full local sign-out without involving the server (the server's
  // session row is now owned by the new device).
  useEffect(() => {
    let mounted = true;

    const handleSessionReplaced = () => {
      if (!mounted) return;
      console.log("[AUTH] SESSION_REPLACED_FORCED_LOGOUT — clearing state and returning to login page");
      // 1. Stop all call audio and clear call arming state immediately.
      stopAllCallSounds("[AUTH] SESSION_REPLACED forced logout");
      clearAllArmedSessions();
      // 2. Kill the token cache so no in-flight request slips through.
      setCachedToken(null);
      // 3. Clear application session key so INITIAL_SESSION won't try to verify it.
      localStorage.removeItem("lulou_session_id");
      // 4. Set the flag that landing.tsx reads to show the "signed out on another device" toast.
      sessionStorage.setItem("lulou_forced_logout", "session_replaced");
      // 5. Clear query cache FIRST — before setUser(null) — so Account B can never
      //    see Account A's cached data, even briefly during the React render caused
      //    by setUser(null).  Clearing after setUser(null) leaves a window where a
      //    rapid Account B login could see stale Account A data.
      queryClient.clear();
      // 6. Clear React user state (triggers re-render to Landing).
      setUser(null);
      // 7. Navigate to root (cosmetic — user is already null so Landing renders).
      window.history.replaceState(null, "", "/");
      // 8. Revoke the local Supabase session so INITIAL_SESSION doesn't fire again on refresh.
      supabase.auth.signOut({ scope: "local" }).catch(() => {});
    };

    window.addEventListener("lulou:session-replaced", handleSessionReplaced);
    return () => {
      mounted = false;
      window.removeEventListener("lulou:session-replaced", handleSessionReplaced);
    };
  }, []);

  const clearPasswordRecovery = useCallback(() => {
    setPasswordRecovery(false);
  }, []);

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut,
    profileInitError: null,
    profileReady,
    clearingCache,
    passwordRecovery,
    clearPasswordRecovery,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("[useAuth] must be used inside <AuthProvider>");
  return ctx;
}
