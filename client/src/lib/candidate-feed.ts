export type CandidateFeedEmptyReason = "distance" | "none";

/**
 * Candidate endpoints remain array responses for compatibility. The query
 * client adds these non-enumerable fields from privacy-safe response headers.
 */
export type CandidateFeed<T> = T[] & {
  emptyReason?: CandidateFeedEmptyReason;
  radiusMiles?: number;
};