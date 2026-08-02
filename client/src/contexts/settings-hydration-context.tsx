/**
 * SettingsHydrationProvider
 *
 * Fires GET /api/settings for any authenticated user the moment the session is
 * ready — not only when the Settings page is open.  This prevents the brief
 * English / miles flash that occurred before the first server response arrived
 * when a user started on any page other than Settings.
 *
 * React Query deduplicates this call with any other useQuery(["/api/settings",
 * userId]) call (e.g. the one in settings.tsx), so there is never a duplicate
 * network request.
 *
 * Exposed via useSettingsHydration():
 *   settingsHydrated — true once the server row has loaded (or if no user is
 *                       authenticated).  Components that render language-sensitive
 *                       text can gate on this flag to avoid an incorrect-language
 *                       flash.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLanguageContext } from "@/contexts/language-context";
import { useUnitsContext } from "@/contexts/units-context";
import type { UserSettings } from "@shared/schema";

// ── Context ───────────────────────────────────────────────────────────────────

interface SettingsHydrationContextValue {
  /** True once the server settings have been loaded for the current user,
   *  or immediately when there is no authenticated user. */
  settingsHydrated: boolean;
}

const SettingsHydrationContext = createContext<SettingsHydrationContextValue>({
  settingsHydrated: false,
});

export function useSettingsHydration(): SettingsHydrationContextValue {
  return useContext(SettingsHydrationContext);
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function SettingsHydrationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { setLanguage, language } = useLanguageContext();
  const [units, setUnits] = useUnitsContext();

  // Fire GET /api/settings for every authenticated user — not just those who
  // visit the Settings page.  Same query key as settings.tsx so React Query
  // deduplicates the request and shares the cached result.
  const { data: serverSettings, isSuccess } = useQuery<UserSettings>({
    queryKey:  ["/api/settings", user?.id],
    staleTime: 30_000,
    enabled:   !!user,
  });

  // Hydrate language and units contexts from the server row.
  // Keyed on serverSettings.userId so it re-runs when the authenticated
  // account changes (the query key already changed, triggering a fresh fetch).
  useEffect(() => {
    if (!serverSettings) return;
    if (serverSettings.preferredLanguage && serverSettings.preferredLanguage !== language) {
      setLanguage(serverSettings.preferredLanguage);
    }
    if (serverSettings.preferredUnits && serverSettings.preferredUnits !== units) {
      setUnits(serverSettings.preferredUnits as "miles" | "km");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSettings?.userId]);

  // Reset contexts to defaults when the user logs out so that Account A's
  // language/units do not briefly flash on Account B's login screen.
  useEffect(() => {
    if (user) return;
    setLanguage("English");
    setUnits("miles");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // settingsHydrated: true once the server row has arrived, or immediately when
  // no user is authenticated (public pages can render without waiting).
  const settingsHydrated = !user || isSuccess;

  return (
    <SettingsHydrationContext.Provider value={{ settingsHydrated }}>
      {children}
    </SettingsHydrationContext.Provider>
  );
}
