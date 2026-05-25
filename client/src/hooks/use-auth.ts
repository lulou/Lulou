import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { setCachedToken, queryClient } from "@/lib/queryClient";
import { writeDebug } from "@/lib/debug-store";
import type { User } from "@supabase/supabase-js";

export function useAuth() {
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
      // Mirror into debug overlay so it's visible on-screen.
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
      //
      // clearingCache is set to true BEFORE the setTimeout so AppContent's
      // profile-exists-check query is disabled during the gap.  Without this
      // guard, the query starts fetching on the same render that sets the user,
      // then queryClient.clear() destroys it mid-flight and resets isLoading:true,
      // causing the spinner to restart from zero (the "endless spinner" bug).
      if (prevUserId !== newUserId) {
        console.log("[AUTH] USER_CHANGED: blocking profile query while cache clears", {
          from: prevUserId ? prevUserId.slice(0, 8) + "…" : "none",
          to:   newUserId  ? newUserId.slice(0, 8)  + "…" : "none",
        });
        // Two-tick defer — avoids calling setState or queryClient.clear()
        // synchronously inside onAuthStateChange while React is mid-render
        // (which causes "Should have a queue" errors).
        //
        // Tick 1: setClearingCache(true) disables the profile-exists-check query
        //         so no fetch can start before the cache is cleared.
        // Tick 2: After React has committed the disabled state, queryClient.clear()
        //         is safe (no in-flight query to interrupt), then setClearingCache(false)
        //         re-enables the query and a fresh, clean fetch begins.
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
        // Populate the module-level token cache so subsequent API requests
        // don't need to call getSession() on every fetch.
        setCachedToken(session.access_token, (session as any).expires_at ?? 0);
        console.log("[AUTH] SESSION_RECEIVED", {
          event,
          userId: newUserId,
          expiresAt: (session as any).expires_at,
        });
      } else {
        setCachedToken(null);
      }

      // Mark auth ready immediately — no extra server round-trip needed here.
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
    console.log("[AUTH_LOGOUT] sign out clicked");

    // ── Optimistic logout — update all local state BEFORE awaiting the network ──
    //
    // Root cause of the "two clicks required" bug:
    //   The previous approach called `await supabase.auth.signOut()` first, which
    //   fires onAuthStateChange(SIGNED_OUT) and queues setUser(null) with React's
    //   scheduler. However React had not yet COMMITTED that update when the very
    //   next line (`window.history.replaceState(null, "", "/")`) ran. Wouter
    //   immediately processed the location change to "/" and re-rendered the
    //   authenticated app at the Discover route — the Sign Out button reappeared
    //   in the header, making it look like nothing happened. Second click worked
    //   because by then React had committed user=null.
    //
    // Fix: clear every piece of local auth state synchronously BEFORE the await,
    //   so the first click immediately shows the Landing page. supabase.signOut()
    //   then completes in the background for server-side session revocation only.

    sessionStorage.removeItem("lulou-bypass");
    // Kill the token cache so no in-flight request sneaks through with old creds.
    setCachedToken(null);
    // Immediately set user to null — AppContent re-renders to Landing on this tick.
    setUser(null);
    // Clear the query cache synchronously so no stale data is visible if the
    // user logs in again in the same tab.
    queryClient.clear();
    console.log("[AUTH_LOGOUT] local state cleared");

    // Navigate to root immediately. user is already null so AppContent is
    // rendering Landing — replaceState is cosmetic (clean URL bar).
    window.history.replaceState(null, "", "/");
    console.log("[AUTH_LOGOUT] redirected to login");

    // Revoke the Supabase session server-side. This also fires
    // onAuthStateChange(SIGNED_OUT) which will call setUser(null) again
    // (idempotent) and schedule another queryClient.clear() (no-op on an already-
    // cleared cache). Errors here are non-fatal — the user is already on Landing.
    try {
      await supabase.auth.signOut();
      console.log("[AUTH_LOGOUT] supabase signOut complete");
    } catch (err) {
      console.error("[AUTH_LOGOUT] supabase signOut error (non-fatal, user already logged out)", err);
    }

    loggingOutRef.current = false;
    setIsLoggingOut(false);
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut,
    profileInitError: null,
    profileReady,
    clearingCache,
  };
}
