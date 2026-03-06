import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { initProfileOnLogin } from "@/lib/profile-upsert";
import type { User } from "@supabase/supabase-js";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileReady, setProfileReady] = useState(false);
  const [profileInitError, setProfileInitError] = useState<string | null>(null);

  const ensureProfile = useCallback(async () => {
    setProfileReady(false);
    setProfileInitError(null);
    try {
      await initProfileOnLogin();
    } catch (err: any) {
      const msg = err?.message || "Unknown profile initialization error";
      console.error("PROFILE_INIT_ERROR", msg, err);
      setProfileInitError(msg);
    } finally {
      setProfileReady(true);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        ensureProfile().then(() => setIsLoading(false));
      } else {
        setProfileReady(true);
        setIsLoading(false);
      }
    }).catch(err => {
      console.error("AUTH_SESSION_ERROR", err);
      setProfileReady(true);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null;
      setUser(u);

      if (event === "SIGNED_IN" && u) {
        ensureProfile().then(() => setIsLoading(false));
      } else {
        setProfileReady(true);
        setIsLoading(false);
      }
    });

    return () => subscription.unsubscribe();
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
