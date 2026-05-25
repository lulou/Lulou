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
    // Clear the bypass flag so the next login starts from scratch.
    sessionStorage.removeItem("lulou-bypass");
    // Clear the cached token immediately so no in-flight request can sneak
    // through with the old credentials after sign-out is initiated.
    setCachedToken(null);
    // signOut() clears the Supabase session and fires onAuthStateChange(SIGNED_OUT).
    // That handler detects the userId change (A → null), clears the React Query
    // cache, sets user = null — which causes AppContent to re-render the Landing
    // page immediately without a browser reload.
    //
    // IMPORTANT: replaceState is called AFTER signOut(), not before.
    // Previously it was called first which caused wouter to navigate to "/" and
    // switch the active tab to Discover BEFORE the sign-out completed, making
    // the first click appear to do nothing (the profile tab disappeared, the
    // Discover tab appeared, and the user clicked Sign Out a second time).
    await supabase.auth.signOut();
    // Clean up URL to "/" only after sign-out is complete so the browser bar
    // shows a clean root path. At this point user is null and AppContent is
    // rendering Landing — the replaceState is cosmetic only.
    window.history.replaceState(null, "", "/");
    console.log("[AUTH_LOGOUT] sign out complete");
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
