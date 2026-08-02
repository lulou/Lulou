import { createContext, useContext, useState, type ReactNode } from "react";

// NOTE: No localStorage read on init and no server PATCH from this context.
// Persistence is the responsibility of the settings page, which uses an
// optimistic mutation with rollback.  Unscoped localStorage is not used
// because it would leak Account A's unit preference into Account B's session.

export type UnitSystem = "miles" | "km";

interface UnitsContextValue {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
}

const UnitsContext = createContext<UnitsContextValue>({
  units: "miles",
  setUnits: () => {},
});

export function UnitsProvider({ children }: { children: ReactNode }) {
  // Default to miles until the authenticated user's settings load from the server.
  // Not initialised from localStorage to prevent one account's units appearing
  // for a different account on the same device.
  const [units, setUnitsState] = useState<UnitSystem>("miles");

  /** Update units in-memory.
   *  Persistence (PATCH /api/settings) is the caller's responsibility so that
   *  it can do optimistic rollback on failure. */
  const setUnits = (u: UnitSystem) => {
    setUnitsState(u);
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
