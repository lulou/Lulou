export type CandidateFeedEmptyReason = "distance" | "none";

/**
 * Classify a successful empty candidate response without exposing candidate
 * details. The unrestricted count is computed server-side using the same
 * eligibility rules, with only the distance constraint removed.
 */
export function classifyCandidateFeedEmptyReason(options: {
  radiusActive: boolean;
  nearbyCount: number;
  unrestrictedCount: number;
}): CandidateFeedEmptyReason {
  if (
    options.radiusActive &&
    options.nearbyCount === 0 &&
    options.unrestrictedCount > 0
  ) {
    return "distance";
  }
  return "none";
}