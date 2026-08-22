/**
 * Candidate lists are live eligibility feeds. They must be stale immediately so
 * the guarded candidate lifecycle hook can request current candidates.
 *
 * We intentionally do not let React Query refetch these automatically on
 * focus/reconnect: persistent, hidden tabs stay subscribed, and an automatic
 * Wheel refetch could replace cards during a spin or reveal.
 */
export const liveCandidateQueryOptions = {
  staleTime: 0,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};