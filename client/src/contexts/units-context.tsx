import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";

export type UnitSystem = "miles" | "km";

const STORAGE_KEY = "settings_units";

interface UnitsContextValue {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
}

const UnitsContext = createContext<UnitsContextValue>({
  units: "miles",
  setUnits: () => {},
});

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<UnitSystem>(() => {
    try { return (localStorage.getItem(STORAGE_KEY) as UnitSystem) || "miles"; } catch { return "miles"; }
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const saved = session?.user?.user_metadata?.preferredUnits as UnitSystem | undefined;
      if (saved === "miles" || saved === "km") {
        setUnitsState(saved);
        try { localStorage.setItem(STORAGE_KEY, saved); } catch {}
      }
    }).catch(() => {});

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const saved = session?.user?.user_metadata?.preferredUnits as UnitSystem | undefined;
      if (saved === "miles" || saved === "km") {
        setUnitsState(saved);
        try { localStorage.setItem(STORAGE_KEY, saved); } catch {}
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const setUnits = (u: UnitSystem) => {
    setUnitsState(u);
    try { localStorage.setItem(STORAGE_KEY, u); } catch {}
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        supabase.auth.updateUser({ data: { preferredUnits: u } }).catch(() => {});
      }
    }).catch(() => {});
  };

  return (
    <UnitsContext.Provider value={{ units, setUnits }}>
      {children}
    </UnitsContext.Provider>
  );
}

export function useUnitsContext(): [UnitSystem, (u: UnitSystem) => void] {
  const { units, setUnits } = useContext(UnitsContext);
  return [units, setUnits];
}
