import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { setCachedToken } from "@/lib/queryClient";
import type { User } from "@supabase/supabase-js";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      const u = session?.user ?? null;
      console.log("[AUTH] AUTH_STATE_CHANGE", { event, userId: u?.id || null });
      setUser(u);

      if (session?.access_token) {
        // Populate the module-level token cache so subsequent API requests
        // don't need to call getSession() on every fetch
        setCachedToken(session.access_token, (session as any).expires_at ?? 0);
      } else {
        setCachedToken(null);
      }

      // Mark ready immediately — no need for an extra server round-trip
      if (mounted) {
        setProfileReady(true);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const logout = useCallback(async () => {
    setCachedToken(null);
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
    profileInitError: null,
    profileReady,
  };
}
