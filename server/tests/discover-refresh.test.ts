import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { discoverQueryOptions } from "../../client/src/lib/discover-query-options";

type Candidate = { userId: string };

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > 1_000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Discover candidate refresh policy", () => {
  it("refetches a previously empty Discover result when the page is opened again", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let serverCandidates: Candidate[] = [];
    let requestCount = 0;
    const options = {
      ...discoverQueryOptions,
      queryFn: async (): Promise<Candidate[]> => {
        requestCount += 1;
        return serverCandidates;
      },
    };

    const firstVisit = new QueryObserver<Candidate[]>(queryClient, options);
    const stopFirstVisit = firstVisit.subscribe(() => undefined);
    await waitFor(() => firstVisit.getCurrentResult().isSuccess, "first Discover request did not resolve");
    expect(firstVisit.getCurrentResult().data).toEqual([]);
    stopFirstVisit();

    // A compatible user completes onboarding after the previous empty response.
    serverCandidates = [{ userId: "new-compatible-profile" }];

    const reopenedDiscover = new QueryObserver<Candidate[]>(queryClient, options);
    const stopReopenedDiscover = reopenedDiscover.subscribe(() => undefined);
    await waitFor(
      () => reopenedDiscover.getCurrentResult().data?.[0]?.userId === "new-compatible-profile",
      "reopened Discover did not fetch the current candidate set",
    );

    expect(requestCount).toBeGreaterThanOrEqual(2);
    stopReopenedDiscover();
  });

  it("keeps the feed stale and refreshes once on app foreground", () => {
    expect(discoverQueryOptions.staleTime).toBe(0);
    expect(discoverQueryOptions.refetchOnMount).toBe("always");
    expect(discoverQueryOptions.refetchOnWindowFocus).toBe(true);
  });
});