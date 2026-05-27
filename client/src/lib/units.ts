import { useState } from "react";

export type UnitSystem = "miles" | "km";

const STORAGE_KEY = "settings_units";

export function useUnits(): [UnitSystem, (u: UnitSystem) => void] {
  const [units, setUnitsState] = useState<UnitSystem>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as UnitSystem) || "miles";
    } catch {
      return "miles";
    }
  });

  const setUnits = (u: UnitSystem) => {
    setUnitsState(u);
    try { localStorage.setItem(STORAGE_KEY, u); } catch {}
  };

  return [units, setUnits];
}

export function getUnits(): UnitSystem {
  try {
    return (localStorage.getItem(STORAGE_KEY) as UnitSystem) || "miles";
  } catch {
    return "miles";
  }
}

export function miToKm(miles: number): number {
  return Math.round(miles * 1.60934);
}

export function formatDistance(miles: number, units: UnitSystem): string {
  if (units === "km") return `${miToKm(miles)} km`;
  return `${miles} mi`;
}
