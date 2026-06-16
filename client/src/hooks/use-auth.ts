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

  // Track the previous auth user ID so we can detect actual account changes
  // (as opposed to token-refresh events which keep the same user).
  const prevUserIdRef = useRef<string | null>(null);
  // Track the most recent auth event type and access token so session-management
  // effects can distinguish SIGNED_IN (new login) from INITIAL_SESSION (reload).
  const authEventRef  = useRef<string | null>(null);
  const authTokenRef  = useRef<string | null>(null);

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

      setUser(u);

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

      // Track event + token for session-management effects that run after this
      // callback completes (they need to distinguish SIGNED_IN from INITIAL_SESSION).
      authEventRef.current = event;
      authTokenRef.current = session?.access_token ?? null;

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

  // ── Session registration (SIGNED_IN) + initial server verification (INITIAL_SESSION)
  // Runs once per login or page reload (whenever user?.id becomes non-null).
  // SIGNED_IN  → client generates a UUID, pre-stores it, then tells the server.
  //              Server writes it to profiles.active_session_id and broadcasts
  //              session_replaced so other devices are kicked instantly.
  // INITIAL_SESSION → page was reloaded with an existing JWT.  We ask the server
  //              if our stored sessionId is still the active one.  If not, force
  //              logout — this is the source-of-truth check that defeats refresh bypass.
  useEffect(() => {
    if (!user?.id) return;
    const event = authEventRef.current;
    const token = authTokenRef.current;
    if (!token) return;

    if (event === "SIGNED_IN") {
      // Pre-store the sessionId BEFORE calling init so our own broadcast doesn't
      // trigger self-logout (broadcast arrives while fetch is still in-flight).
      const sessionId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      localStorage.setItem("lulou_session_id", sessionId);

      fetch(`${API_BASE}/api/auth/init`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});

    } else if (event === "INITIAL_SESSION") {
      // Page reload: verify our stored session ID still matches the server record.
      // Realtime may have been offline while another device logged in — this check
      // is the reliable fallback.
      const storedId = localStorage.getItem("lulou_session_id");
      if (storedId) {
        fetch(`${API_BASE}/api/auth/user`, {
          headers: { Authorization: `Bearer ${token}`, "X-Session-ID": storedId },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.sessionReplaced) {
              console.log("[AUTH] SESSION_REPLACED on page load — another device is now active");
              sessionStorage.setItem("lulou_forced_logout", "1");
              logout();
            }
          })
          .catch(() => {});
      }
    }
  }, [user?.id, logout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Single-session watcher ────────────────────────────────────────────────
  // Path 1 — Instant:      Realtime broadcast when another device logs in right now.
  // Path 2 — Tab-focus:    Server check when the user switches back to a stale tab.
  // Together these cover all cases without relying on any single mechanism.
  useEffect(() => {
    if (!user?.id) return;

    // Path 1: Realtime broadcast — catches the "device is online when replaced" case
    const ch = supabase.channel(`user-session:${user.id}`);
    ch.on("broadcast", { event: "session_replaced" }, ({ payload }) => {
      const currentSessionId = localStorage.getItem("lulou_session_id");
      // Ignore our own broadcast: client pre-stores sessionId before calling init,
      // so by the time the broadcast arrives this comparison is always equal on
      // the logging-in device.
      if (!payload?.sessionId || payload.sessionId === currentSessionId) return;
      console.log("[AUTH] FORCED_LOGOUT — account signed in on another device (broadcast)");
      sessionStorage.setItem("lulou_forced_logout", "1");
      logout();
    }).subscribe();

    // Path 2: Visibility change — catches the "tab was left open" case where
    // Realtime was not connected or the broadcast was missed.
    const checkSessionActive = async () => {
      const sid = localStorage.getItem("lulou_session_id");
      if (!sid) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const r = await fetch(`${API_BASE}/api/auth/user`, {
          headers: { Authorization: `Bearer ${session.access_token}`, "X-Session-ID": sid },
        });
        if (!r.ok) return;
        const data = await r.json();
        if (data?.sessionReplaced) {
          console.log("[AUTH] SESSION_REPLACED on tab focus — another device is now active");
          sessionStorage.setItem("lulou_forced_logout", "1");
          logout();
        }
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkSessionActive();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      supabase.removeChannel(ch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user?.id, logout]);

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut,
    profileInitError: null,
    profileReady,
    clearingCache,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("[useAuth] must be used inside <AuthProvider>");
  return ctx;
}
