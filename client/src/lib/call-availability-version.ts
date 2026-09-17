const latestAvailabilityVersionByMatch = new Map<string, number>();

export function acceptAvailabilityVersion(matchId: string, version: unknown): boolean {
  if (typeof version !== "number" || !Number.isFinite(version)) return false;
  const latest = latestAvailabilityVersionByMatch.get(matchId) ?? 0;
  if (version < latest) return false;
  latestAvailabilityVersionByMatch.set(matchId, version);
  return true;
}