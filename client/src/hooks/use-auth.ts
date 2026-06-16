import { useState, useEffect, useCallback, useRef, createContext, useContext, createElement } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { setCachedToken, queryClient, API_BASE } from "@/lib/queryClient";
import { stopAllCallSounds } from "@/lib/call-audio";
import { clearAllArmedSessions } from "@/lib/live-call-sessions";
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
  // Single-device enforcement — true when login was blocked because the account
  // is already active on another device.  Cleared by clearDeviceBlocked().
  deviceBlocked: boolean;
  clearDeviceBlocked: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  // When true, the query cache is being cleared after an account change.
  // AppContent must not start the profile-exists-check query until this is false,
  // otherwise queryClient.clear() fires mid-flight and resets the in-progress
  // fetch back to isLoading:true — the root cause of the "endless spinner" bug.
  const [clearingCache, setClearingCache] = useState(false);
  // Set to true when a login attempt was blocked because another device already
  // has an active session.  Stays true until clearDeviceBlocked() is called.
  const [deviceBlocked, setDeviceBlocked] = useState(false);

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
      // WHY the check lives HERE and not in landing.tsx:
      //
      //   supabase.auth.signInWithPassword() fires onAuthStateChange(SIGNED_IN)
      //   BEFORE its own Promise resolves.  Any code placed after the `await`
      //   in landing.tsx runs AFTER this callback has already run — far too late
      //   to stop the user entering the app (setUser would have been called).
      //
      // Solution: for SIGNED_IN events we do NOT call setUser(u) synchronously.
      // Instead, an async IIFE calls the server to check whether this device is
      // allowed.  setUser(u) is only called if the server says "allowed".
      // While the check is in-flight, user === null → Landing stays visible.
      if (event === "SIGNED_IN" && u && session?.access_token) {
        const token = session.access_token;

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

          let isBlocked = false;
          let grantedSessionId = sessionId;

          try {
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
              if (d.blocked) {
                isBlocked = true;
              } else {
                grantedSessionId = d.sessionId ?? sessionId;
              }
            }
          } catch {
            // Fail open — a transient network error never locks users out
          }

          if (!mounted) return;

          if (isBlocked) {
            console.log("[AUTH] DEVICE_BLOCKED — account already active on another device");
            // Revoke the freshly-created Supabase session so it can't be used silently.
            supabase.auth.signOut().catch(() => {});
            setDeviceBlocked(true);
            setProfileReady(true);
            setIsLoading(false);
            // user stays null — Landing remains visible with the blocked banner
          } else {
            localStorage.setItem("lulou_session_id", grantedSessionId);
            setUser(u);
            setProfileReady(true);
            setIsLoading(false);
            console.log("[AUTH] AUTH_READY", { event, userId: newUserId });
          }
        })();

        // Return WITHOUT calling setUser or setIsLoading.
        // The async IIFE above will do both after the check completes.
        return;
      }

      // All other events (INITIAL_SESSION, TOKEN_REFRESHED, SIGNED_OUT, etc.)
      // proceed with the normal synchronous path.
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

  const clearDeviceBlocked = useCallback(() => {
    setDeviceBlocked(false);
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
    try {
      const { data: { session: _s } } = await supabase.auth.getSession();
      if (_s?.access_token) {
        fetch(`${API_BASE}/api/auth/session`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${_s.access_token}` },
        }).catch(() => {});
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
        await fetch(`${API_BASE}/api/auth/heartbeat`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
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

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut,
    profileInitError: null,
    profileReady,
    clearingCache,
    deviceBlocked,
    clearDeviceBlocked,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("[useAuth] must be used inside <AuthProvider>");
  return ctx;
}
