import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { getTranslation, RTL_LANGS, LANGUAGE_NAME_TO_CODE, type TranslationKey } from "@/lib/i18n";

// NOTE: No localStorage read on init and no server PATCH from this context.
// Persistence is the responsibility of the settings page, which uses an
// optimistic mutation with rollback.  Unscoped localStorage is not used
// because it would leak Account A's language preference into Account B's session.
//
// Hydration from the server (GET /api/settings) is handled by
// SettingsHydrationProvider in contexts/settings-hydration-context.tsx, which
// fires for every authenticated user — not only those who visit Settings.

interface LanguageContextValue {
  language: string;
  setLanguage: (lang: string) => void;
  t: (key: TranslationKey) => string;
  isRTL: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: "English",
  setLanguage: () => {},
  t: (key) => key,
  isRTL: false,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Default to English until the authenticated user's settings load from the server.
  // Not initialised from localStorage to prevent one account's language appearing
  // for a different account on the same device.
  const [language, setLanguageState] = useState<string>("English");

  /** Update language in-memory.
   *  Persistence (PATCH /api/settings) is the caller's responsibility so that
   *  it can do optimistic rollback on failure. */
  const setLanguage = (lang: string) => {
    setLanguageState(lang);
  };

  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
  const isRTL = RTL_LANGS.has(langCode);

  useEffect(() => {
    document.documentElement.setAttribute("lang", langCode);
    document.documentElement.setAttribute("dir", isRTL ? "rtl" : "ltr");
  }, [langCode, isRTL]);

  const t = (key: TranslationKey) => getTranslation(key, language);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, isRTL }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguageContext() {
  return useContext(LanguageContext);
}
