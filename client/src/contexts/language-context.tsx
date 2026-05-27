import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { getTranslation, RTL_LANGS, LANGUAGE_NAME_TO_CODE, type TranslationKey } from "@/lib/i18n";

const STORAGE_KEY = "settings_language";

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
  const [language, setLanguageState] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) || "English"; } catch { return "English"; }
  });

  const setLanguage = (lang: string) => {
    setLanguageState(lang);
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  };

  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
  const isRTL = RTL_LANGS.has(langCode);

  // Apply RTL and lang attribute to <html> whenever language changes
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
