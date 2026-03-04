import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { initProfileOnLogin } from "@/lib/profile-upsert";
import type { User } from "@supabase/supabase-js";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profileInitError, setProfileInitError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      setIsLoading(false);

      if (event === "SIGNED_IN" && session?.user) {
        setProfileInitError(null);
        initProfileOnLogin().catch(err => {
          console.error("PROFILE_INIT_ERROR", err);
          setProfileInitError(err?.message || "Could not initialize profile");
        });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    window.location.href = "/";
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout,
    isLoggingOut: false,
    profileInitError,
  };
}
