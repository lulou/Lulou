export type UnitSystem = "miles" | "km";

export { useUnitsContext as useUnits } from "@/contexts/units-context";

const STORAGE_KEY = "settings_units";

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
