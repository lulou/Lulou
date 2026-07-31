import { useState, useEffect, useLayoutEffect, useCallback, useRef, createContext, useContext, createElement } from "react";
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
  // Session bootstrap failure — true when the application-level session could
  // not be registered after a new auth event (server error, network failure).
  // The app shows a Retry / Sign out screen while this is true.
  // Protected queries remain blocked until bootstrap succeeds.
  sessionBootstrapFailed: boolean;
  retrySessionBootstrap: () => Promise<void>;
  // True once INITIAL_SESSION verify/bootstrap (or SIGNED_IN/PASSWORD_RECOVERY
  // bootstrap) has completed successfully.  The prefetch effect and any
  // session-gated query should wait for this before firing to avoid sending
  // stale session IDs and triggering false invalid_session errors.
  isSessionReady: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

// ── Module-level bootstrap helper ─────────────────────────────────────────
// Calls POST /api/auth/session-bootstrap — exempt from the X-Session-Id gate.
// Returns the new sessionId on success, null on failure.
// Intentionally fail-CLOSED: null means "show retry screen", never "proceed anyway".
// caller is a short tag for diagnostics (e.g. "SIGNED_IN", "INITIAL_SESSION", "retry").
async function callSessionBootstrap(token: string, deviceId: string, caller = ""): Promise<string | null> {
  try {
    console.log("[AUTH] SESSION_BOOTSTRAP_START", { caller });
    // Write "pending" immediately so the panel shows something even if we never get a response.
    try { localStorage.setItem("lulou_diag_bootstrap_http", "pending"); } catch {}
    try { localStorage.setItem("lulou_diag_bootstrap_body", ""); } catch {}
    try { localStorage.setItem("lulou_diag_bootstrap_caller", caller); } catch {}
    // 10-second hard timeout so a hung server never leaves the user on an
    // endless spinner.  AbortError is caught by the outer try/catch which
    // writes "network-error" to the diag key and returns null (fail-closed).
    const _bsCtrl = new AbortController();
    const _bsTimeout = setTimeout(() => {
      console.warn("[AUTH] SESSION_BOOTSTRAP_TIMEOUT — aborting after 10 s", { caller });
      try { localStorage.setItem("lulou_diag_bootstrap_http", "timeout-10s"); } catch {}
      _bsCtrl.abort();
    }, 10_000);
    const r = await fetch(`${API_BASE}/api/auth/session-bootstrap`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, userAgent: navigator.userAgent }),
      signal: _bsCtrl.signal,
    });
    clearTimeout(_bsTimeout);
    // Always write the HTTP status — visible on the retry screen even if body read fails.
    try { localStorage.setItem("lulou_diag_bootstrap_http", String(r.status)); } catch {}
    if (r.ok) {
      const d = await r.json();
      const sid = typeof d.sessionId === "string" ? d.sessionId : null;
      try { localStorage.setItem("lulou_diag_bootstrap_body", sid ? `ok:${sid.slice(0, 8)}…` : "ok:no-session-id-in-response"); } catch {}
      console.log("[AUTH] SESSION_BOOTSTRAP_OK", { sessionId: (sid ?? "").slice(0, 8) + "…", caller });
      return sid;
    }
    // Non-2xx: read the body so we know whether it's a 401 (bad JWT), 500 (DB error), etc.
    let errBody = "";
    try { errBody = await r.text(); } catch {}
    try { localStorage.setItem("lulou_diag_bootstrap_body", errBody.slice(0, 120)); } catch {}
    console.warn("[AUTH] SESSION_BOOTSTRAP_FAILED", { status: r.status, body: errBody.slice(0, 120), caller });
    return null;
  } catch (e) {
    try { localStorage.setItem("lulou_diag_bootstrap_http", "network-error"); } catch {}
    try { localStorage.setItem("lulou_diag_bootstrap_body", String(e).slice(0, 120)); } catch {}
    console.warn("[AUTH] SESSION_BOOTSTRAP_NETWORK_ERROR", { error: String(e), caller });
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [sessionBootstrapFailed, setSessionBootstrapFailed] = useState(false);
  // True once the current auth event's verify/bootstrap has completed, meaning
  // the lulou_session_id in localStorage is fresh and protected queries may fire.
  const [isSessionReady, setIsSessionReady] = useState(false);
  // When true, the query cache is being cleared after an account change.
  // AppContent must not start the profile-exists-check query until this is false,
  // otherwise queryClient.clear() fires mid-flight and resets the in-progress
  // fetch back to isLoading:true — the root cause of the "endless spinner" bug.
  const [clearingCache, setClearingCache] = useState(false);

  // Track the previous auth user ID so we can detect actual account changes
  // (as opposed to token-refresh events which keep the same user).
  const prevUserIdRef = useRef<string | null>(null);

  // Guards against TOKEN_REFRESHED (or other concurrent auth events) calling
  // setUser / setIsLoading while a SIGNED_IN or INITIAL_SESSION async IIFE is
  // still in-flight registering the session.  Without this guard, TOKEN_REFRESHED
  // can call setIsLoading(false) BEFORE lulou_session_id is updated to the new
  // value, allowing queries to fire with the old (now-revoked) session ID and
  // receive 401 session_replaced → forced logout on the device that just signed in.
  const asyncAuthInProgressRef = useRef(false);

  // Prevents double-bootstrap when Supabase fires both INITIAL_SESSION and
  // SIGNED_IN for the same auth event (email-verification callback, PWA session
  // restore, etc.).  Set synchronously at the START of the INITIAL_SESSION async
  // block — before any await — so a concurrent SIGNED_IN callback (which runs
  // synchronously right after INITIAL_SESSION returns) sees the lock immediately
  // and bails out without calling callSessionBootstrap a second time.
  //
  // Without this guard the second bootstrap revokes the first session, leaving
  // in-flight queries with a stale session ID that the middleware rejects → 401.
  const bootstrapInProgressForUserRef = useRef<string | null>(null);

  // ── Auth-attempt generation counter ─────────────────────────────────────────
  // Incremented synchronously at the start of every SIGNED_IN / INITIAL_SESSION
  // async flow.  Each flow captures its own `myAttemptId` before the first await.
  // Failure paths compare their capture against the CURRENT counter before calling
  // setSessionBootstrapFailed(true) — if they differ, a newer attempt has already
  // started (or succeeded), so the stale failure is silently discarded.
  //
  // This prevents the observed bug:
  //   SIGNED_IN fires first → bootstrap fails → setSessionBootstrapFailed(true)
  //   INITIAL_SESSION fires next (lock released) → verify succeeds → clears failure
  //   ... but if SIGNED_IN's failure path RUNS AFTER INITIAL_SESSION's success it
  //   would re-set the flag.  The counter makes the SIGNED_IN failure stale.
  const authAttemptRef = useRef(0);

  // Ref mirror of isSessionReady so the stable event-handler closure (useEffect
  // with [] deps) can read the current value without a stale closure capture.
  // Updated by a sync useEffect below instead of manually at every setIsSessionReady
  // call site — React guarantees the effect runs before the next paint.
  const isSessionReadyRef = useRef(false);

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
          setSessionBootstrapFailed(false);
          setIsSessionReady(true);
          setUser(u);
          setProfileReady(true);
          setIsLoading(false);
          return;
        }

        // ── Dedup guard: INITIAL_SESSION may be bootstrapping this user already ─
        // Supabase fires both INITIAL_SESSION (restoring a cached session) and
        // SIGNED_IN in email-verification callbacks, auth/callback page loads, and
        // some PWA session-restore flows.  If INITIAL_SESSION already started its
        // bootstrap for this exact userId, skip this SIGNED_IN entirely — the
        // INITIAL_SESSION IIFE will call setUser(u) when it finishes.  Starting a
        // second bootstrap here would revoke the just-granted session and cause the
        // first protected query to receive 401 session_replaced.
        if (bootstrapInProgressForUserRef.current === newUserId) {
          console.log("[AUTH] SIGNED_IN_DEDUPED — INITIAL_SESSION bootstrap in-flight for same user", {
            userId: newUserId?.slice(0, 8),
          });
          try { localStorage.setItem("lulou_diag_bootstrap_status", "deduped-SIGNED_IN-skipped"); } catch {}
          return;
        }

        // ── Re-enter loading state BEFORE the async IIFE ─────────────────────
        // INITIAL_SESSION(null) already set isLoading:false and user:null.
        // Without this, navigating from /auth/callback to / while the session-
        // check is in-flight shows Landing (user:null + isLoading:false).
        // Setting isLoading:true here ensures AppContent shows the auth spinner
        // during the check instead of the Landing page.
        // Clear ALL diagnostic keys from previous auth events before this attempt
        // so the debug panel never mixes values from different runs.
        try {
          [
            "lulou_diag_run",
            "lulou_diag_verify_start", "lulou_diag_verify_sid_prefix",
            "lulou_diag_verify_result", "lulou_diag_verify_end",
            "lulou_diag_jwt_exp", "lulou_diag_jwt_sub",
            "lulou_diag_bootstrap_status", "lulou_diag_bootstrap_http",
            "lulou_diag_bootstrap_body", "lulou_diag_bootstrap_caller",
            "lulou_diag_failure_branch", "lulou_diag_ignored_stale_result",
          ].forEach(k => localStorage.removeItem(k));
        } catch {}
        setIsLoading(true);
        try { localStorage.setItem("lulou_diag_last_auth_event", `SIGNED_IN:${newUserId?.slice(0, 8) ?? "?"}`); } catch {}
        console.log("[AUTH] SIGNED_IN_RECEIVED — session check starting, isLoading→true", {
          userId: newUserId,
          hasToken: !!token,
          route: window.location.pathname,
        });

        // Block concurrent TOKEN_REFRESHED / other events from calling setUser
        // or setIsLoading(false) while session-check is still in-flight.
        asyncAuthInProgressRef.current = true;
        bootstrapInProgressForUserRef.current = newUserId ?? null;
        // Increment generation counter BEFORE the IIFE so a concurrent
        // INITIAL_SESSION can bump it higher.  If INITIAL_SESSION succeeds while
        // this SIGNED_IN bootstrap is still in-flight, our failure path will see
        // authAttemptRef.current > myAttemptId and discard the failure.
        authAttemptRef.current += 1;
        const myAttemptId = authAttemptRef.current;
        try { localStorage.setItem("lulou_diag_auth_attempt_id", String(myAttemptId)); } catch {}
        (async () => {
          // ── Atomic run record — all fields from THIS auth attempt only ────────
          // Written incrementally so the panel always shows the latest state even
          // if the IIFE exits early or throws.  The cleanup block above erased any
          // values from a previous auth event so nothing can leak across runs.
          const _rr: Record<string, unknown> = {
            event: "SIGNED_IN", authAttemptId: myAttemptId, jwtPresent: true,
            storedSessionIdBefore: "(reading…)", verifyCalled: false, verifyStatus: "N/A",
            bootstrapCalled: false, bootstrapStatus: "(not started)",
            returnedSessionIdPresent: false, storedSessionIdAfter: "(none)",
            finalState: "(in-flight)", branch: "(in-flight)", ignoredStaleResult: false,
          };
          const _wr = () => { try { localStorage.setItem("lulou_diag_run", JSON.stringify(_rr)); } catch {} };
          _wr();

          try {
            let deviceId = localStorage.getItem("lulou_device_id") ?? "";
            if (!deviceId) {
              deviceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID() : `${Date.now()}-d`;
              localStorage.setItem("lulou_device_id", deviceId);
            }

            // ── Verify-first ────────────────────────────────────────────────────
            // On iOS PWA page restores Supabase fires SIGNED_IN before
            // INITIAL_SESSION.  If a valid lulou_session_id is already stored,
            // verifying it is faster and safer than bootstrapping: bootstrap
            // creates a new session (revoking the existing one), and if it fails
            // transiently (cold-start, JWT timing, network error) the user is
            // blocked even though their existing session is perfectly valid.
            // Only bootstrap when: (a) no session ID stored, or (b) verify fails.
            const storedSessionId = localStorage.getItem("lulou_session_id") ?? "";
            _rr.storedSessionIdBefore = storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)";
            _wr();

            if (storedSessionId) {
              _rr.verifyCalled = true;
              _wr();
              try {
                // 8-second timeout — AbortError is caught by the outer catch
                // which writes "network-error" to the diag key and falls through
                // to bootstrap, so the user is never left on an endless spinner.
                const _siVCtrl = new AbortController();
                const _siVTimeout = setTimeout(() => {
                  console.warn("[AUTH] SIGNED_IN_VERIFY_TIMEOUT — aborting after 8 s");
                  _siVCtrl.abort();
                }, 8_000);
                const _vr = await fetch(`${API_BASE}/api/auth/session-verify`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "X-Session-Id": storedSessionId,
                  },
                  body: JSON.stringify({ sessionId: storedSessionId }),
                  signal: _siVCtrl.signal,
                });
                clearTimeout(_siVTimeout);
                const _vd = _vr.ok
                  ? await _vr.json().catch(() => ({ valid: false, reason: "parse-error" }))
                  : { valid: false, reason: `http-${_vr.status}` };
                _rr.verifyStatus = `${_vr.status}:${_vd.valid}:${_vd.reason ?? "none"}`;
                _wr();

                if (_vd.valid === true) {
                  // ── Verify succeeded — enter app without bootstrap ─────────
                  if (!mounted) return;
                  bootstrapInProgressForUserRef.current = null;
                  asyncAuthInProgressRef.current = false;
                  if (authAttemptRef.current !== myAttemptId) {
                    _rr.finalState = "stale-discarded"; _rr.ignoredStaleResult = true;
                    _rr.branch = "SIGNED_IN-verify-ok-stale"; _wr();
                    console.warn("[AUTH] SIGNED_IN_VERIFY_OK_STALE — discarded (newer attempt ran)", {
                      myAttemptId, current: authAttemptRef.current,
                    });
                    return;
                  }
                  _rr.bootstrapStatus = "N/A (verify succeeded)";
                  _rr.returnedSessionIdPresent = true;
                  _rr.storedSessionIdAfter = storedSessionId.slice(0, 8) + "…";
                  _rr.finalState = "ready"; _rr.branch = "SIGNED_IN-verify-ok"; _wr();
                  setLoginTime(Date.now());
                  fetch(`${API_BASE}/api/calls/sweep-expired`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "X-Session-Id": storedSessionId },
                  }).then(async (r) => {
                    const j = await r.json().catch(() => ({}));
                    console.log("[AUTH] LOGIN_CALL_SWEEP", { cleared: j.cleared ?? 0, userId: newUserId?.slice(0, 8) });
                  }).catch((e) => console.warn("[AUTH] LOGIN_CALL_SWEEP_FAILED", { error: String(e) }));
                  {
                    const _PK = [["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]];
                    for (const _k of _PK) {
                      if (queryClient.getQueryState(_k)?.status === "error") queryClient.resetQueries({ queryKey: _k });
                    }
                  }
                  setSessionBootstrapFailed(false);
                  setIsSessionReady(true);
                  setUser(u);
                  setProfileReady(true);
                  setIsLoading(false);
                  console.log("[AUTH] SIGNED_IN_VERIFY_OK — entering app without bootstrap", { userId: newUserId?.slice(0, 8) });
                  return;
                }
                // verify returned valid:false — fall through to bootstrap
                console.warn("[AUTH] SIGNED_IN_VERIFY_FAILED — will bootstrap", { reason: _vd.reason, userId: newUserId?.slice(0, 8) });
              } catch (_ve) {
                _rr.verifyStatus = `network-error:${String(_ve).slice(0, 60)}`;
                _wr();
                console.warn("[AUTH] SIGNED_IN_VERIFY_NETWORK_ERR — will bootstrap", { error: String(_ve) });
              }
            }

            // ── Bootstrap ───────────────────────────────────────────────────────
            // Runs when: (a) no stored session ID (new login or session cleared),
            //            (b) verify returned valid:false (session replaced/expired),
            //            (c) verify network error (fall-back to bootstrap).
            _rr.bootstrapCalled = true; _wr();
            const grantedSessionId = await callSessionBootstrap(token, deviceId, "SIGNED_IN");
            _rr.returnedSessionIdPresent = !!grantedSessionId;
            _rr.bootstrapStatus = grantedSessionId
              ? `ok:${grantedSessionId.slice(0, 8)}…`
              : `failed:http=${(() => { try { return localStorage.getItem("lulou_diag_bootstrap_http") ?? "?"; } catch { return "?"; } })()}`;
            _wr();

            if (!mounted) return;

            if (!grantedSessionId) {
              bootstrapInProgressForUserRef.current = null;
              asyncAuthInProgressRef.current = false;
              if (authAttemptRef.current !== myAttemptId) {
                _rr.finalState = "stale-discarded"; _rr.ignoredStaleResult = true;
                _rr.branch = "SIGNED_IN-bootstrap-failed-stale"; _wr();
                console.warn("[AUTH] SIGNED_IN_BOOTSTRAP_FAILED — STALE, ignored", {
                  myAttemptId, current: authAttemptRef.current, userId: newUserId?.slice(0, 8),
                });
                return;
              }
              _rr.storedSessionIdAfter = "(none)";
              _rr.finalState = "retry"; _rr.branch = "SIGNED_IN-bootstrap-failed"; _wr();
              setSessionBootstrapFailed(true);
              setIsLoading(false);
              console.warn("[AUTH] SIGNED_IN_BOOTSTRAP_FAILED — showing retry screen", { userId: newUserId?.slice(0, 8) });
              return;
            }

            // Bootstrap succeeded
            localStorage.removeItem("lulou_session_id");
            localStorage.setItem("lulou_session_id", grantedSessionId);
            _rr.storedSessionIdAfter = grantedSessionId.slice(0, 8) + "…";
            _rr.finalState = "ready"; _rr.branch = "SIGNED_IN-bootstrap-ok"; _wr();
            console.log("[AUTH] SESSION_STORED", { sessionIdPrefix: grantedSessionId.slice(0, 8) + "…", userId: newUserId?.slice(0, 8) });
            setLoginTime(Date.now());
            fetch(`${API_BASE}/api/calls/sweep-expired`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "X-Session-Id": grantedSessionId },
            }).then(async (r) => {
              const j = await r.json().catch(() => ({}));
              console.log("[AUTH] LOGIN_CALL_SWEEP", { cleared: j.cleared ?? 0, userId: newUserId?.slice(0, 8) });
            }).catch((e) => console.warn("[AUTH] LOGIN_CALL_SWEEP_FAILED (non-fatal)", { error: String(e) }));
            bootstrapInProgressForUserRef.current = null;
            asyncAuthInProgressRef.current = false;
            {
              const _PROTECTED_KEYS = [["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]];
              for (const _k of _PROTECTED_KEYS) {
                if (queryClient.getQueryState(_k)?.status === "error") {
                  queryClient.resetQueries({ queryKey: _k });
                }
              }
            }
            setSessionBootstrapFailed(false);
            setIsSessionReady(true);
            setUser(u);
            setProfileReady(true);
            setIsLoading(false);
            console.log("[AUTH] AUTH_READY — user set, isLoading→false", { event, userId: newUserId });
          } catch (_siErr) {
            // Catch-all: never leave the user on a blank/spinning screen
            bootstrapInProgressForUserRef.current = null;
            asyncAuthInProgressRef.current = false;
            _rr.finalState = "retry";
            _rr.branch = `SIGNED_IN-uncaught:${String(_siErr).slice(0, 60)}`;
            _wr();
            if (mounted && authAttemptRef.current === myAttemptId) {
              setSessionBootstrapFailed(true);
              setIsLoading(false);
            }
            console.warn("[AUTH] SIGNED_IN_IIFE_UNCAUGHT_ERROR", { error: String(_siErr) });
          }
        })();

        // Return WITHOUT calling setUser or setIsLoading.
        // The async IIFE above will do both after the check completes.
        return;
      }

      // PASSWORD_RECOVERY fires when the user clicks a password-reset link and
      // detectSessionInUrl:true reads the #access_token=...&type=recovery hash.
      // We must register the recovery session in active_sessions BEFORE calling
      // setUser(u), otherwise any stale lulou_session_id left in localStorage
      // would cause every API request to get 401 session_replaced — preventing
      // the user from completing their password reset.
      if (event === "PASSWORD_RECOVERY" && u && session?.access_token) {
        const token = session.access_token;
        asyncAuthInProgressRef.current = true;
        setIsLoading(true);
        try { localStorage.setItem("lulou_diag_last_auth_event", `PASSWORD_RECOVERY:${newUserId?.slice(0, 8) ?? "?"}`); } catch {}
        (async () => {
          // Always clear any stale ID — the recovery token represents a fresh
          // authentication and needs its own active_sessions row.
          localStorage.removeItem("lulou_session_id");
          let recoveryDeviceId = localStorage.getItem("lulou_device_id") ?? "";
          if (!recoveryDeviceId) {
            recoveryDeviceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID() : `${Date.now()}-d`;
            localStorage.setItem("lulou_device_id", recoveryDeviceId);
          }
          // Fail-CLOSED: if bootstrap fails show Retry / Sign out screen.
          // The user cannot proceed to password reset without a valid session.
          const recoverySessionId = await callSessionBootstrap(token, recoveryDeviceId);
          asyncAuthInProgressRef.current = false;
          if (!mounted) return;
          if (!recoverySessionId) {
            setSessionBootstrapFailed(true);
            setIsLoading(false);
            console.warn("[AUTH] PASSWORD_RECOVERY_BOOTSTRAP_FAILED — showing retry screen", { userId: newUserId?.slice(0, 8) });
            return;
          }
          localStorage.setItem("lulou_session_id", recoverySessionId);
          setSessionBootstrapFailed(false);
          setIsSessionReady(true);
          setPasswordRecovery(true);
          setUser(u);
          setProfileReady(true);
          setIsLoading(false);
          console.log("[AUTH] PASSWORD_RECOVERY_SESSION — showing password recovery gate");
        })();
        return;
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
        // Clear all diagnostic keys from previous auth events before this attempt.
        try {
          [
            "lulou_diag_run",
            "lulou_diag_verify_start", "lulou_diag_verify_sid_prefix",
            "lulou_diag_verify_result", "lulou_diag_verify_end",
            "lulou_diag_jwt_exp", "lulou_diag_jwt_sub",
            "lulou_diag_bootstrap_status", "lulou_diag_bootstrap_http",
            "lulou_diag_bootstrap_body", "lulou_diag_bootstrap_caller",
            "lulou_diag_failure_branch", "lulou_diag_ignored_stale_result",
          ].forEach(k => localStorage.removeItem(k));
        } catch {}
        setIsLoading(true);
        // Block protected queries while we re-verify the session ID.  Any
        // queries that fire with the old ID before this completes will get
        // invalid_session from the server; the stale-request guard in
        // getQueryFn suppresses the retry screen for those but we still want
        // to prevent the queries from firing if possible.
        setIsSessionReady(false);
        asyncAuthInProgressRef.current = true;
        try { localStorage.setItem("lulou_diag_last_auth_event", `INITIAL_SESSION:${newUserId?.slice(0, 8) ?? "?"}`); } catch {}
        // ── Reverse dedup: if SIGNED_IN already holds the lock for this user, skip ─
        // On iOS PWA page restores Supabase can fire SIGNED_IN before INITIAL_SESSION.
        // SIGNED_IN now does verify-first, so it handles the recovery correctly.
        // Starting a second verify/bootstrap here would risk double-bootstrap
        // (two session rows created, one immediately revoked) and the
        // setIsSessionReady(false) below would flicker the app even if SIGNED_IN
        // already succeeded.  Let SIGNED_IN own the flow when it started first.
        if (bootstrapInProgressForUserRef.current === newUserId) {
          asyncAuthInProgressRef.current = false;
          try { localStorage.setItem("lulou_diag_run", JSON.stringify({
            event: "INITIAL_SESSION", authAttemptId: -1,
            jwtPresent: true, storedSessionIdBefore: "(N/A)",
            verifyCalled: false, verifyStatus: "N/A",
            bootstrapCalled: false, bootstrapStatus: "N/A",
            returnedSessionIdPresent: false, storedSessionIdAfter: "(N/A)",
            finalState: "deduped", branch: "INITIAL_SESSION-deduped-SIGNED_IN-in-flight",
            ignoredStaleResult: false,
          })); } catch {}
          console.log("[AUTH] INITIAL_SESSION_DEDUPED — SIGNED_IN already in-flight for this user", { userId: newUserId?.slice(0, 8) });
          return;
        }
        // Set SYNCHRONOUSLY before the async IIFE so a concurrent SIGNED_IN
        // event for the same user (which fires synchronously right after this
        // handler returns) sees the lock and skips its own bootstrap call.
        bootstrapInProgressForUserRef.current = newUserId ?? null;
        // Increment BEFORE the IIFE — makes any already-running SIGNED_IN attempt
        // stale.  SIGNED_IN's failure path will see authAttemptRef.current > its
        // myAttemptId and discard the failure instead of showing the retry screen.
        authAttemptRef.current += 1;
        const myAttemptId = authAttemptRef.current;
        try { localStorage.setItem("lulou_diag_auth_attempt_id", String(myAttemptId)); } catch {}
        console.log("[AUTH] INITIAL_SESSION_VERIFY_START", { userId: newUserId?.slice(0, 8), attemptId: myAttemptId });

        (async () => {
          const storedSessionId = localStorage.getItem("lulou_session_id") ?? "";
          let verified = false;
          // Track the exact reason for a verification failure so we can show the
          // right message and distinguish a true device-replacement from an expired
          // or missing session.  Only "session_replaced" ever shows the "another
          // device" toast; everything else silently re-bootstraps or fails-open.
          let verifyFailReason = "";
          let bootstrapCalled = false;

          // ── Diagnostic snapshot ────────────────────────────────────────────
          try { localStorage.setItem("lulou_diag_verify_start", `${Date.now()}`); } catch {}
          try { localStorage.setItem("lulou_diag_verify_sid_prefix", storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)"); } catch {}
          console.log("[AUTH_DIAG] INITIAL_SESSION_VERIFY_SNAPSHOT", {
            storedSessionIdPrefix: storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)",
            userId: newUserId?.slice(0, 8),
          });
          // JWT expiry — needed to diagnose "bootstrap returns 401" for expired tokens.
          // atob with URL-safe base64 padding for Firefox and WebKit compatibility.
          try {
            const _tp = token.split(".");
            if (_tp.length === 3) {
              const _pl = JSON.parse(atob(_tp[1].replace(/-/g, "+").replace(/_/g, "/")));
              localStorage.setItem("lulou_diag_jwt_exp", _pl.exp ? new Date(_pl.exp * 1000).toISOString() : "no-exp");
              localStorage.setItem("lulou_diag_jwt_sub", (_pl.sub ?? "").slice(0, 8));
            }
          } catch {}

          try {
            let deviceId = localStorage.getItem("lulou_device_id") ?? "";
            if (!deviceId) {
              deviceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID() : `${Date.now()}-d`;
              localStorage.setItem("lulou_device_id", deviceId);
            }

            if (storedSessionId) {
              // Verify existing session against active_sessions — fast path.
              // 8-second timeout — AbortError is caught by the outer catch
              // (line ~945) which fails-open (verified=true) so the user is
              // never left on an endless spinner when the server is slow.
              const _isVCtrl = new AbortController();
              const _isVTimeout = setTimeout(() => {
                console.warn("[AUTH] INITIAL_SESSION_VERIFY_TIMEOUT — aborting after 8 s");
                _isVCtrl.abort();
              }, 8_000);
              const r = await fetch(`${API_BASE}/api/auth/session-verify`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  // Send session-id in both header (for middleware) and body (for endpoint)
                  "X-Session-Id": storedSessionId,
                },
                body: JSON.stringify({ sessionId: storedSessionId }),
                signal: _isVCtrl.signal,
              });
              clearTimeout(_isVTimeout);

              if (r.ok) {
                const d = await r.json();
                try { localStorage.setItem("lulou_diag_verify_result", `ok:${d.valid}:${d.reason ?? "none"}`); } catch {}
                console.log("[AUTH_DIAG] INITIAL_SESSION_VERIFY_RESPONSE", { status: r.status, valid: d.valid, reason: d.reason ?? null });

                if (d.valid === true) {
                  verified = true;
                  console.log("[AUTH] INITIAL_SESSION_VERIFIED — entering app", {
                    userId: newUserId?.slice(0, 8),
                    sessionIdPrefix: storedSessionId.slice(0, 8) + "…",
                  });
                } else if (
                  d.reason === "invalid_session" ||
                  d.reason === "expired"        ||
                  d.reason === "not_found"      ||
                  d.reason === "no_session_id"
                ) {
                  // Session aged out or missing — not replaced by another device.
                  // Bootstrap a new session rather than signing the user out.
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_EXPIRED_OR_MISSING — bootstrapping", {
                    reason: d.reason, userId: newUserId?.slice(0, 8),
                  });
                  bootstrapCalled = true;
                  localStorage.removeItem("lulou_session_id");
                  const newId = await callSessionBootstrap(token, deviceId, `INITIAL_SESSION-verify-${d.reason}`);
                  if (newId) {
                    localStorage.setItem("lulou_session_id", newId);
                    verified = true;
                    try { localStorage.setItem("lulou_diag_bootstrap_status", `ok-after-verify-${d.reason}:${newId.slice(0, 8)}…`); } catch {}
                  } else {
                    bootstrapInProgressForUserRef.current = null;
                    asyncAuthInProgressRef.current = false;
                    if (mounted) {
                      if (authAttemptRef.current !== myAttemptId) {
                        console.warn("[AUTH] INITIAL_SESSION_BOOTSTRAP_FAILED (STALE — ignored)", { myAttemptId, current: authAttemptRef.current });
                        try { localStorage.setItem("lulou_diag_ignored_stale_result", "true"); } catch {}
                        return;
                      }
                      try { localStorage.setItem("lulou_diag_failure_branch", `init-verify-${d.reason ?? "expired"}-bootstrap-fail`); } catch {}
                      try { localStorage.setItem("lulou_diag_run", JSON.stringify({
                        event: "INITIAL_SESSION", authAttemptId: myAttemptId, jwtPresent: true,
                        storedSessionIdBefore: storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)",
                        verifyCalled: true, verifyStatus: `ok:false:${d.reason ?? "expired"}`,
                        bootstrapCalled: true,
                        bootstrapStatus: `failed:http=${(() => { try { return localStorage.getItem("lulou_diag_bootstrap_http") ?? "?"; } catch { return "?"; } })()}`,
                        returnedSessionIdPresent: false, storedSessionIdAfter: "(none)",
                        finalState: "retry", branch: `init-verify-${d.reason ?? "expired"}-bootstrap-fail`,
                        ignoredStaleResult: false,
                      })); } catch {}
                      setSessionBootstrapFailed(true);
                      setIsLoading(false);
                    }
                    return;
                  }
                } else if (d.reason === "session_replaced" || d.reason === "revoked") {
                  // A different device explicitly bootstrapped a new session for this
                  // account (session_replaced), or the session was explicitly revoked.
                  // Only in these cases do we sign the user out with the "another
                  // device" toast.
                  verified = false;
                  verifyFailReason = d.reason;
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_REJECTED", {
                    reason: d.reason, userId: newUserId?.slice(0, 8),
                  });
                } else {
                  // Unknown reason from endpoint — treat as expired / fail-open so a
                  // future endpoint change never causes a spurious sign-out.
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_UNKNOWN_REASON — failing open", {
                    reason: d.reason, userId: newUserId?.slice(0, 8),
                  });
                  verified = true;
                }
              } else if (r.status === 401) {
                // Middleware rejected the request.
                const body = await r.json().catch(() => ({}));
                const msg401 = body?.message ?? "";
                try { localStorage.setItem("lulou_diag_verify_result", `401:${msg401}`); } catch {}
                console.log("[AUTH_DIAG] INITIAL_SESSION_VERIFY_401", { message: msg401, userId: newUserId?.slice(0, 8) });

                if (msg401 === "invalid_session") {
                  // No active session row, OR same session ID but expired/revoked —
                  // session aged out naturally.  Bootstrap rather than sign out.
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_401_INVALID — bootstrapping", {
                    userId: newUserId?.slice(0, 8),
                  });
                  bootstrapCalled = true;
                  localStorage.removeItem("lulou_session_id");
                  const newId = await callSessionBootstrap(token, deviceId, "INITIAL_SESSION-401-invalid");
                  if (newId) {
                    localStorage.setItem("lulou_session_id", newId);
                    verified = true;
                    try { localStorage.setItem("lulou_diag_bootstrap_status", `ok-after-401-invalid:${newId.slice(0, 8)}…`); } catch {}
                  } else {
                    bootstrapInProgressForUserRef.current = null;
                    asyncAuthInProgressRef.current = false;
                    if (mounted) {
                      if (authAttemptRef.current !== myAttemptId) {
                        console.warn("[AUTH] INITIAL_SESSION_401_BOOTSTRAP_FAILED (STALE — ignored)", { myAttemptId, current: authAttemptRef.current });
                        try { localStorage.setItem("lulou_diag_ignored_stale_result", "true"); } catch {}
                        return;
                      }
                      try { localStorage.setItem("lulou_diag_failure_branch", "init-401-invalid-bootstrap-fail"); } catch {}
                      try { localStorage.setItem("lulou_diag_run", JSON.stringify({
                        event: "INITIAL_SESSION", authAttemptId: myAttemptId, jwtPresent: true,
                        storedSessionIdBefore: storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)",
                        verifyCalled: true, verifyStatus: `401:false:${msg401}`,
                        bootstrapCalled: true,
                        bootstrapStatus: `failed:http=${(() => { try { return localStorage.getItem("lulou_diag_bootstrap_http") ?? "?"; } catch { return "?"; } })()}`,
                        returnedSessionIdPresent: false, storedSessionIdAfter: "(none)",
                        finalState: "retry", branch: "init-401-invalid-bootstrap-fail",
                        ignoredStaleResult: false,
                      })); } catch {}
                      setSessionBootstrapFailed(true);
                      setIsLoading(false);
                    }
                    return;
                  }
                } else if (msg401 === "session_replaced") {
                  // Middleware confirmed: a DIFFERENT session ID is now active for
                  // this account — another device genuinely replaced this session.
                  verified = false;
                  verifyFailReason = "session_replaced";
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_401_REPLACED — another device owns account", {
                    userId: newUserId?.slice(0, 8),
                  });
                } else {
                  // "Unauthorized" (expired JWT before TOKEN_REFRESHED), email not
                  // verified, or any other transient error.  Fail OPEN — do not sign
                  // the user out for a condition unrelated to session replacement.
                  // TOKEN_REFRESHED will arrive shortly and re-enter the app.
                  verified = true;
                  console.warn("[AUTH] INITIAL_SESSION_VERIFY_401_FAILOPEN — transient error, not session_replaced", {
                    message: msg401, userId: newUserId?.slice(0, 8),
                  });
                  try { localStorage.setItem("lulou_diag_verify_result", `401-failopen:${msg401}`); } catch {}
                }
              } else {
                // 5xx / unexpected — fail open so a DB outage doesn't sign everyone out
                verified = true;
                console.warn("[AUTH] INITIAL_SESSION_VERIFY_FAIL_OPEN (non-2xx, non-401)", {
                  status: r.status, userId: newUserId?.slice(0, 8),
                });
                try { localStorage.setItem("lulou_diag_verify_result", `failopen:${r.status}`); } catch {}
              }
            } else {
              // No stored session ID — must bootstrap.
              // Fail-CLOSED: if bootstrap fails show Retry / Sign out screen.
              console.warn("[AUTH] INITIAL_SESSION_NO_SESSION_ID — bootstrapping", { userId: newUserId?.slice(0, 8) });
              bootstrapCalled = true;
              const newId = await callSessionBootstrap(token, deviceId, "INITIAL_SESSION-no-sid");
              if (newId) {
                localStorage.removeItem("lulou_session_id");
                localStorage.setItem("lulou_session_id", newId);
                verified = true;
              } else {
                bootstrapInProgressForUserRef.current = null;
                asyncAuthInProgressRef.current = false;
                if (mounted) {
                  if (authAttemptRef.current !== myAttemptId) {
                    console.warn("[AUTH] INITIAL_SESSION_NO_SID_BOOTSTRAP_FAILED (STALE — ignored)", { myAttemptId, current: authAttemptRef.current });
                    try { localStorage.setItem("lulou_diag_ignored_stale_result", "true"); } catch {}
                    return;
                  }
                  try { localStorage.setItem("lulou_diag_failure_branch", "init-no-sid-bootstrap-fail"); } catch {}
                  try { localStorage.setItem("lulou_diag_run", JSON.stringify({
                    event: "INITIAL_SESSION", authAttemptId: myAttemptId, jwtPresent: true,
                    storedSessionIdBefore: "(none)",
                    verifyCalled: false, verifyStatus: "N/A (no session ID)",
                    bootstrapCalled: true,
                    bootstrapStatus: `failed:http=${(() => { try { return localStorage.getItem("lulou_diag_bootstrap_http") ?? "?"; } catch { return "?"; } })()}`,
                    returnedSessionIdPresent: false, storedSessionIdAfter: "(none)",
                    finalState: "retry", branch: "init-no-sid-bootstrap-fail",
                    ignoredStaleResult: false,
                  })); } catch {}
                  setSessionBootstrapFailed(true);
                  setIsLoading(false);
                }
                return;
              }
            }
          } catch (e) {
            // Network error — fail open
            verified = true;
            console.warn("[AUTH] INITIAL_SESSION_VERIFY_NETWORK_ERROR (fail-open)", {
              error: String(e), userId: newUserId?.slice(0, 8),
            });
            try { localStorage.setItem("lulou_diag_verify_result", `network-error-failopen`); } catch {}
          }

          if (!mounted) return;

          // ── Diagnostic summary ────────────────────────────────────────────
          try {
            localStorage.setItem("lulou_diag_verify_end", JSON.stringify({
              verified,
              verifyFailReason: verifyFailReason || null,
              bootstrapCalled,
              finalLogoutReason: verified ? null : (verifyFailReason || "unknown"),
            }));
            // Coherent atomic run record — one write with all fields from THIS run only.
            const _finalSid = localStorage.getItem("lulou_session_id") ?? "";
            localStorage.setItem("lulou_diag_run", JSON.stringify({
              event: "INITIAL_SESSION",
              authAttemptId: myAttemptId,
              jwtPresent: true,
              storedSessionIdBefore: storedSessionId ? storedSessionId.slice(0, 8) + "…" : "(none)",
              verifyCalled: !!storedSessionId,
              verifyStatus: (() => { try { return localStorage.getItem("lulou_diag_verify_result") ?? "N/A"; } catch { return "N/A"; } })(),
              bootstrapCalled,
              bootstrapStatus: (() => {
                try {
                  if (!bootstrapCalled) return "N/A";
                  const http = localStorage.getItem("lulou_diag_bootstrap_http");
                  if (http && http !== "pending") return `http=${http}`;
                  return localStorage.getItem("lulou_diag_bootstrap_status") ?? "N/A";
                } catch { return "N/A"; }
              })(),
              returnedSessionIdPresent: !!_finalSid,
              storedSessionIdAfter: _finalSid ? _finalSid.slice(0, 8) + "…" : "(none)",
              finalState: verified ? "ready" : (verifyFailReason ? "replaced" : "retry"),
              branch: verified
                ? (bootstrapCalled ? "INITIAL_SESSION-bootstrap-ok" : "INITIAL_SESSION-verify-ok")
                : (verifyFailReason === "session_replaced" || verifyFailReason === "revoked"
                    ? `INITIAL_SESSION-${verifyFailReason}`
                    : "INITIAL_SESSION-verify-fail"),
              ignoredStaleResult: false,
            }));
          } catch {}
          console.log("[AUTH_DIAG] INITIAL_SESSION_VERIFY_COMPLETE", {
            verified, verifyFailReason: verifyFailReason || null,
            bootstrapCalled,
            finalLogoutReason: verified ? null : (verifyFailReason || "unknown"),
          });

          bootstrapInProgressForUserRef.current = null;
          asyncAuthInProgressRef.current = false;
          if (verified) {
            // Mirror the same post-login guards used by the SIGNED_IN path:
            //  1. setLoginTime — updates the module-level boundary so that
            //     use-call-signaling.ts's login-time guard rejects rererings
            //     for any call that started before this session opened.
            //     Without this, _loginTime stays at APP_LOAD_TIME (module init)
            //     which is equivalent for fresh page loads but leaves a gap on
            //     bfcache-restored sessions where APP_LOAD_TIME is ancient.
            //  2. sweep-expired — asks the server to clear ringing call rows
            //     older than 90 s so subsequent /api/matches polls return clean
            //     data.  The startup sweep handles the client-side cache, but
            //     the DB row keeps coming back on every 5 s poll until the
            //     server clears it.
            setLoginTime(Date.now());
            const _initSessionId = localStorage.getItem("lulou_session_id") ?? "";
            if (_initSessionId) {
              fetch(`${API_BASE}/api/calls/sweep-expired`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "X-Session-Id": _initSessionId,
                },
              }).then(async (r) => {
                const j = await r.json().catch(() => ({}));
                console.log("[AUTH] INITIAL_SESSION_CALL_SWEEP", { cleared: j.cleared ?? 0, userId: newUserId?.slice(0, 8) });
              }).catch((e) => {
                console.warn("[AUTH] INITIAL_SESSION_CALL_SWEEP_FAILED (non-fatal)", { error: String(e) });
              });
            }
            // Reset any protected queries that may have errored during the verify/
            // bootstrap window with a stale session ID so they refetch cleanly.
            {
              const _PROTECTED_KEYS = [["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]];
              for (const _k of _PROTECTED_KEYS) {
                if (queryClient.getQueryState(_k)?.status === "error") {
                  queryClient.resetQueries({ queryKey: _k });
                }
              }
            }
            // ── CRITICAL FIX: clear any stale bootstrap failure flag ──────────
            // SIGNED_IN bootstrap may have failed BEFORE this INITIAL_SESSION
            // attempt ran, leaving sessionBootstrapFailed=true.  Since this
            // INITIAL_SESSION succeeded, that stale failure must be cleared so
            // the app can enter normally instead of staying on the retry screen.
            setSessionBootstrapFailed(false);
            try { localStorage.setItem("lulou_diag_ignored_stale_result", "false"); } catch {}
            // Clear any stale failure diagnostic from an earlier auth attempt.
            // Without this the debug panel shows the old "failed-SIGNED_IN" text
            // even though the current attempt succeeded.
            if (bootstrapCalled) {
              try { localStorage.setItem("lulou_diag_bootstrap_status", `ok-INITIAL_SESSION:${localStorage.getItem("lulou_session_id")?.slice(0, 8) ?? "?"}…`); } catch {}
            } else {
              try { localStorage.setItem("lulou_diag_bootstrap_status", `verified-no-bootstrap`); } catch {}
            }
            setIsSessionReady(true);
            setUser(u);
            setProfileReady(true);
            setIsLoading(false);
          } else {
            // Only reach here when the server explicitly confirmed that a DIFFERENT
            // session is now active for this account (another device logged in).
            // Do NOT reach here for expired sessions — those are handled above by
            // bootstrapping, not signing out.
            console.log("[AUTH] INITIAL_SESSION_REJECTED — showing login page", {
              userId: newUserId?.slice(0, 8), reason: verifyFailReason,
            });
            supabase.auth.signOut({ scope: "local" }).catch(() => {});
            localStorage.removeItem("lulou_session_id");
            setCachedToken(null);
            // Flag for landing.tsx to show "signed out because account on another device" toast.
            // Only set when the reason is genuinely session_replaced — not for expired/missing
            // sessions which are handled above by bootstrapping.
            if (verifyFailReason === "session_replaced") {
              sessionStorage.setItem("lulou_forced_logout", "session_replaced");
            }
            setTimeout(() => {
              if (mounted) setClearingCache(true);
              setTimeout(() => { queryClient.clear(); if (mounted) setClearingCache(false); }, 0);
            }, 0);
            setUser(null);
            setProfileReady(true);
            setIsLoading(false);
          }
        })();

        return; // async IIFE handles setUser / setIsLoading
      }

      // Guard: if a SIGNED_IN or INITIAL_SESSION async IIFE is in-flight, do not
      // let TOKEN_REFRESHED (or any other concurrent event) override isLoading or
      // call setUser before the session ID is registered.  The IIFE will handle
      // all state transitions when it completes.  SIGNED_OUT is always allowed
      // through so the user is never left in an authenticated limbo.
      if (asyncAuthInProgressRef.current && event !== "SIGNED_OUT") {
        return;
      }

      // Reset bootstrap failure state on sign-out so the landing page is clean.
      if (event === "SIGNED_OUT") {
        setSessionBootstrapFailed(false);
      }

      setUser(u);

      if (mounted) {
        // Mark the session as ready for all non-SIGNED_OUT events.
        // SIGNED_OUT goes through this path too (u === null), and we must
        // NOT set isSessionReady to true on sign-out — logout sets it false.
        if (event !== "SIGNED_OUT") {
          // Clear any stale bootstrap failure left by an earlier auth attempt
          // (e.g. a SIGNED_IN that failed before this TOKEN_REFRESHED arrived).
          setSessionBootstrapFailed(false);
          setIsSessionReady(true);
        }
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
    setIsSessionReady(false);
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
        // Include X-Session-Id so the middleware accepts this request and
        // actually deletes the active_sessions row.  Without it the new
        // middleware returns 401 and the row is never cleaned up, causing the
        // next bootstrap to find a stale row (harmless but noisy).
        const _deleteSessionId = localStorage.getItem("lulou_session_id") ?? "";
        await fetch(`${API_BASE}/api/auth/session`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${_s.access_token}`,
            ...(_deleteSessionId ? { "X-Session-Id": _deleteSessionId } : {}),
          },
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
            // Stale-request guard: if INITIAL_SESSION bootstrap ran while this
            // heartbeat was in-flight, the localStorage session ID will have
            // changed to the new value.  In that case do NOT dispatch the
            // forced-logout event — this is a false positive caused by the old
            // session being cached as "session_replaced" by the server (the race
            // between bootstrap completing and an in-flight heartbeat arriving).
            // Only genuine cross-device replacements leave currentSessionId
            // unchanged (no bootstrap happened on this device).
            const currentSessionId = localStorage.getItem("lulou_session_id") ?? "";
            if (!sessionId || sessionId === currentSessionId) {
              console.warn("[AUTH] HEARTBEAT_SESSION_REPLACED — dispatching forced-logout event", {
                sentPrefix: sessionId ? sessionId.slice(0, 8) + "…" : "(none)",
              });
              window.dispatchEvent(new CustomEvent("lulou:session-replaced"));
            } else {
              console.warn("[AUTH] HEARTBEAT_SESSION_REPLACED_STALE — ignoring (bootstrap completed during flight)", {
                sentPrefix: sessionId.slice(0, 8) + "…",
                currentPrefix: currentSessionId ? currentSessionId.slice(0, 8) + "…" : "(none)",
              });
            }
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

  // ── Session bootstrap retry ────────────────────────────────────────────────
  // Called by the "Retry" button on the session-verification-failed screen.
  //
  // Recovery strategy (in order):
  //   1. Concurrency guard — no-op if another auth operation is running.
  //   2. Get a fresh Supabase session (auto-refreshes JWT if needed).
  //   3. Verify-FIRST — if there is an existing lulou_session_id, call
  //      session-verify before touching it.  The failure screen may have
  //      appeared due to a race (stale SIGNED_IN failure, isSessionReadyRef not
  //      yet synced when lulou:session-bootstrap-needed fired) while the session
  //      ID itself is perfectly valid.  If verify returns valid:true, enter the
  //      app immediately without a new bootstrap.
  //   4. Bootstrap — only if no session ID exists, or verify returned false.
  //   5. Success path (verify OR bootstrap): clear failure flag, set isSessionReady,
  //      expose user, enter app.  Do NOT call Supabase signOut.
  const retrySessionBootstrap = useCallback(async () => {
    // 1. Concurrency guard
    if (asyncAuthInProgressRef.current) {
      console.warn("[AUTH] RETRY_SKIPPED — auth already in progress");
      return;
    }

    setSessionBootstrapFailed(false);
    setIsLoading(true);
    asyncAuthInProgressRef.current = true;

    // Clear stale retry diagnostics from any previous attempt.
    try {
      localStorage.removeItem("lulou_diag_retry_verify");
      localStorage.removeItem("lulou_diag_retry_outcome");
      localStorage.setItem("lulou_diag_retry_start", new Date().toISOString());
    } catch {}

    try {
      // 2. Fresh Supabase session (auto-refreshes JWT)
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token || !session?.user) {
        asyncAuthInProgressRef.current = false;
        setIsLoading(false);
        setUser(null);
        setProfileReady(true);
        try { localStorage.setItem("lulou_diag_retry_outcome", "no-supabase-session→landing"); } catch {}
        console.warn("[AUTH] RETRY_NO_SUPABASE_SESSION — clearing state, returning to landing");
        return;
      }
      const retryToken = session.access_token;
      try {
        const _ea = (session as any).expires_at;
        localStorage.setItem("lulou_diag_retry_jwt_exp", _ea ? new Date(_ea * 1000).toISOString() : "no-exp");
      } catch {}

      let deviceId = localStorage.getItem("lulou_device_id") ?? "";
      if (!deviceId) {
        deviceId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID() : `${Date.now()}-d`;
        localStorage.setItem("lulou_device_id", deviceId);
      }

      // 3. Verify-first
      const existingSessionId = localStorage.getItem("lulou_session_id") ?? "";
      if (existingSessionId) {
        try { localStorage.setItem("lulou_diag_retry_has_sid", existingSessionId.slice(0, 8) + "…"); } catch {}
        console.log("[AUTH] RETRY_VERIFY_ATTEMPT", { sessionIdPrefix: existingSessionId.slice(0, 8) + "…" });
        try {
          // 8-second timeout — AbortError is caught by the outer catch
          // which falls through to bootstrap (same recovery as a network error).
          const _rvCtrl = new AbortController();
          const _rvTimeout = setTimeout(() => {
            console.warn("[AUTH] RETRY_VERIFY_TIMEOUT — aborting after 8 s");
            _rvCtrl.abort();
          }, 8_000);
          const vr = await fetch(`${API_BASE}/api/auth/session-verify`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${retryToken}`,
              "Content-Type": "application/json",
              "X-Session-Id": existingSessionId,
            },
            body: JSON.stringify({ sessionId: existingSessionId }),
            signal: _rvCtrl.signal,
          });
          clearTimeout(_rvTimeout);
          const vd = vr.ok
            ? await vr.json().catch(() => ({ valid: false, reason: "parse-error" }))
            : { valid: false, reason: `http-${vr.status}` };
          try { localStorage.setItem("lulou_diag_retry_verify", `${vr.status}:${vd.valid}:${vd.reason ?? "none"}`); } catch {}

          if (vd.valid === true) {
            // Session ID is valid — enter the app immediately, no bootstrap needed.
            try { localStorage.setItem("lulou_diag_retry_outcome", "verify-ok:no-bootstrap-needed"); } catch {}
            console.log("[AUTH] RETRY_VERIFY_OK — session valid, entering app without bootstrap");
            asyncAuthInProgressRef.current = false;
            const _PK = [["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]];
            for (const _k of _PK) {
              if (queryClient.getQueryState(_k)?.status === "error") queryClient.resetQueries({ queryKey: _k });
            }
            setLoginTime(Date.now());
            setSessionBootstrapFailed(false);
            setIsSessionReady(true);
            setUser(session.user as User);
            setProfileReady(true);
            setIsLoading(false);
            return;
          }
          // verify returned valid:false — fall through to bootstrap
          console.warn("[AUTH] RETRY_VERIFY_FALSE — bootstrapping", { reason: vd.reason });
        } catch (verifyErr) {
          try { localStorage.setItem("lulou_diag_retry_verify", `network-error:${String(verifyErr).slice(0, 60)}`); } catch {}
          console.warn("[AUTH] RETRY_VERIFY_NETWORK_ERR — bootstrapping", { error: String(verifyErr) });
        }
      } else {
        try { localStorage.setItem("lulou_diag_retry_has_sid", "(none)"); } catch {}
        console.warn("[AUTH] RETRY_NO_EXISTING_SID — going straight to bootstrap");
      }

      // 4. Bootstrap (no session ID, or verify returned false)
      localStorage.removeItem("lulou_session_id");
      const sessionId = await callSessionBootstrap(retryToken, deviceId, "retry");
      asyncAuthInProgressRef.current = false;

      if (sessionId) {
        // 5. Bootstrap success
        localStorage.setItem("lulou_session_id", sessionId);
        try { localStorage.setItem("lulou_diag_retry_outcome", `bootstrap-ok:${sessionId.slice(0, 8)}…`); } catch {}
        const _PK = [["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]];
        for (const _k of _PK) { queryClient.resetQueries({ queryKey: _k }); }
        console.log("[AUTH] RETRY_BOOTSTRAP_OK — entering app");
        setLoginTime(Date.now());
        setSessionBootstrapFailed(false);
        setIsSessionReady(true);
        setUser(session.user as User);
        setProfileReady(true);
        setIsLoading(false);
      } else {
        try { localStorage.setItem("lulou_diag_retry_outcome", "bootstrap-failed"); } catch {}
        try { localStorage.setItem("lulou_diag_failure_branch", "retry-bootstrap-fail"); } catch {}
        setSessionBootstrapFailed(true);
        setIsLoading(false);
        console.warn("[AUTH] RETRY_BOOTSTRAP_FAILED — bootstrap returned null, showing retry screen again");
      }
    } catch (e) {
      asyncAuthInProgressRef.current = false;
      try { localStorage.setItem("lulou_diag_retry_outcome", `exception:${String(e).slice(0, 80)}`); } catch {}
      try { localStorage.setItem("lulou_diag_failure_branch", "retry-exception"); } catch {}
      setSessionBootstrapFailed(true);
      setIsLoading(false);
      console.warn("[AUTH] RETRY_BOOTSTRAP_ERROR", { error: String(e) });
    }
  }, []);

  // Use useLayoutEffect (not useEffect) so isSessionReadyRef.current is updated
  // synchronously after React's DOM commit — before the browser paint and before
  // macrotask callbacks (fetch responses) can fire.
  //
  // The race this closes: INITIAL_SESSION success calls setIsSessionReady(true).
  // With useEffect, any fetch callback that arrives between setState and the paint
  // reads stale isSessionReadyRef.current=false and can dispatch
  // lulou:session-bootstrap-needed → setSessionBootstrapFailed(true), showing the
  // retry screen even though the session just became valid.
  // useLayoutEffect runs synchronously after the commit, before any macrotask.
  useLayoutEffect(() => {
    isSessionReadyRef.current = isSessionReady;
  }, [isSessionReady]);

  // ── Session bootstrap needed event (from queryClient belt-and-suspenders) ──
  // Fires when a protected query unexpectedly returns 401 invalid_session.
  // Queries should never reach this state if the boot flow is working, but this
  // provides a fallback that shows the retry screen instead of a broken Discover.
  useEffect(() => {
    const handleBootstrapNeeded = () => {
      // Guard: if the session is already valid (e.g. an INITIAL_SESSION just
      // succeeded while this stale query was in-flight), do NOT override the
      // successful auth state with a failure screen.
      if (isSessionReadyRef.current) {
        console.warn("[AUTH] lulou:session-bootstrap-needed IGNORED — session is already ready (isSessionReady=true)");
        return;
      }
      console.warn("[AUTH] lulou:session-bootstrap-needed received — showing retry screen");
      setSessionBootstrapFailed(true);
    };
    window.addEventListener("lulou:session-bootstrap-needed", handleBootstrapNeeded);
    return () => window.removeEventListener("lulou:session-bootstrap-needed", handleBootstrapNeeded);
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
    sessionBootstrapFailed,
    retrySessionBootstrap,
    isSessionReady,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("[useAuth] must be used inside <AuthProvider>");
  return ctx;
}
