import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { initProfileOnLogin } from "@/lib/profile-upsert";
import type { User } from "@supabase/supabase-js";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [profileInitError, setProfileInitError] = useState<string | null>(null);

  const ensureProfile = useCallback(async (accessToken: string) => {
    setProfileReady(false);
    setProfileInitError(null);
    try {
      await initProfileOnLogin(accessToken);
    } catch (err: any) {
      const msg = err?.message || "Unknown profile initialization error";
      console.error("PROFILE_INIT_ERROR", msg, err);
      setProfileInitError(msg);
    } finally {
      setProfileReady(true);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    // Use onAuthStateChange as the single source of truth.
    // INITIAL_SESSION fires immediately on mount with the stored session (if any).
    // SIGNED_IN fires after signup or signin.
    // SIGNED_OUT fires after logout or session expiry.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;

      const u = session?.user ?? null;
      console.log("[AUTH] AUTH_STATE_CHANGE", { event, userId: u?.id || null });
      setUser(u);

      if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && u && session?.access_token) {
        // Both initial load (with persisted session) and fresh sign-in go through ensureProfile
        ensureProfile(session.access_token).then(() => {
          if (mounted) setIsLoading(false);
        });
      } else if (event === "TOKEN_REFRESHED" && u && session?.access_token) {
        // Token refresh — keep user logged in, no need to re-init profile
        if (mounted) {
          setProfileReady(true);
          setIsLoading(false);
        }
      } else {
        // No session (SIGNED_OUT, INITIAL_SESSION with no stored session, etc.)
        if (mounted) {
          setProfileReady(true);
          setIsLoading(false);
        }
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [ensureProfile]);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfileReady(false);
    window.location.href = "/";
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut: false,
    profileInitError,
    profileReady,
  };
}
