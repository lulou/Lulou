export type MeetAvailabilityState =
  | "none_submitted"
  | "self_only"
  | "other_only"
  | "both_match"
  | "both_mismatch";

export type MeetAvailabilityResolution = {
  state: MeetAvailabilityState;
  selfAvailability: string[];
  otherAvailability: string[];
  matchingAvailability: string[];
};

export type MeetAvailabilityAcceptDecision =
  | { ok: true; copiedAvailability: string }
  | { ok: false; reason: "already_responded" | "missing_other" | "stale_other" | "invalid_expected" };

export function normalizeMeetAvailabilitySlots(slots: unknown): string[] {
  if (!Array.isArray(slots)) return [];
  return [...new Set(
    slots
      .filter((slot): slot is string => typeof slot === "string")
      .map((slot) => slot.trim())
      .filter((slot) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(slot)),
  )].sort();
}

export function parseMeetAvailability(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return normalizeMeetAvailabilitySlots(JSON.parse(value));
  } catch {
    return [];
  }
}

export function canonicalizeMeetAvailability(slots: unknown): string | null {
  const normalized = normalizeMeetAvailabilitySlots(slots);
  return normalized.length > 0 && normalized.length <= 5
    ? JSON.stringify(normalized)
    : null;
}

export function resolveMeetAvailability(
  selfValue: string | null | undefined,
  otherValue: string | null | undefined,
): MeetAvailabilityResolution {
  const selfAvailability = parseMeetAvailability(selfValue);
  const otherAvailability = parseMeetAvailability(otherValue);
  const matchingAvailability = selfAvailability.filter((slot) =>
    otherAvailability.includes(slot),
  );

  let state: MeetAvailabilityState;
  if (selfAvailability.length === 0 && otherAvailability.length === 0) state = "none_submitted";
  else if (selfAvailability.length > 0 && otherAvailability.length === 0) state = "self_only";
  else if (selfAvailability.length === 0) state = "other_only";
  else if (matchingAvailability.length > 0) state = "both_match";
  else state = "both_mismatch";

  return { state, selfAvailability, otherAvailability, matchingAvailability };
}

export function decideMeetAvailabilityAcceptance(
  selfValue: string | null | undefined,
  otherValue: string | null | undefined,
  expectedOtherValue: string | null | undefined,
): MeetAvailabilityAcceptDecision {
  if (selfValue !== null && selfValue !== undefined) {
    return { ok: false, reason: "already_responded" };
  }
  if (!otherValue) return { ok: false, reason: "missing_other" };

  const canonicalExpected = canonicalizeMeetAvailability(parseMeetAvailability(expectedOtherValue));
  if (!canonicalExpected) return { ok: false, reason: "invalid_expected" };
  const canonicalOther = canonicalizeMeetAvailability(parseMeetAvailability(otherValue));
  if (canonicalOther !== canonicalExpected) return { ok: false, reason: "stale_other" };

  return { ok: true, copiedAvailability: otherValue };
}