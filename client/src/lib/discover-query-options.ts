import { liveCandidateQueryOptions } from "./live-candidate-query-options";

/**
 * Discover is a live eligibility feed, not a permanent snapshot. In particular,
 * an empty response must be fetched again when compatible profiles complete
 * onboarding while this persistent tab is hidden.
 */
export const discoverQueryOptions = {
  queryKey: ["/api/discover"] as const,
  ...liveCandidateQueryOptions,
};