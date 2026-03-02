import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

async function initProfile(accessToken: string) {
  try {
    await fetch("/api/auth/init", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    console.error("AUTH_INIT_ERROR", e);
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setIsLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      setIsLoading(false);

      if (event === "SIGNED_IN" && session?.access_token) {
        initProfile(session.access_token);
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
  };
}
