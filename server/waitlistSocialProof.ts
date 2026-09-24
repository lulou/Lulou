export const WAITLIST_SOCIAL_PROOF_THRESHOLD = 250;

export function publicWaitlistCount(count: number | null) {
  if (count === null || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid waitlist count");
  }
  return count >= WAITLIST_SOCIAL_PROOF_THRESHOLD
    ? { visible: true as const, count }
    : { visible: false as const };
}