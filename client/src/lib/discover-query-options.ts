/**
 * Discover is a live eligibility feed, not a permanent snapshot.  In
 * particular, an empty response must be fetched again when the user returns:
 * compatible profiles may have completed onboarding in the meantime.
 */
export const discoverQueryOptions = {
  queryKey: ["/api/discover"] as const,
  staleTime: 0,
  refetchOnMount: "always" as const,
  refetchOnWindowFocus: true,
};