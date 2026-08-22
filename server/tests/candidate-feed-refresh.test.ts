import { describe, expect, it } from "vitest";
import { discoverQueryOptions } from "../../client/src/lib/discover-query-options";
import { liveCandidateQueryOptions } from "../../client/src/lib/live-candidate-query-options";
import { canRefreshCandidateFeed } from "../../client/src/hooks/use-candidate-feed-refresh";
import { canApplyWheelCandidateUpdate, resolveWheelDismissal } from "../../client/src/lib/wheel-presentation-guard";

describe("live candidate feed policy", () => {
  it("refreshes only an active, idle feed and coalesces foreground events", () => {
    expect(canRefreshCandidateFeed(true, true, 0, 1_500)).toBe(true);
    expect(canRefreshCandidateFeed(false, true, 0, 1_500)).toBe(false);
    expect(canRefreshCandidateFeed(true, false, 0, 1_500)).toBe(false);
    expect(canRefreshCandidateFeed(true, true, 1_000, 2_000)).toBe(false);
  });

  it("does not replace Wheel candidates when a late query resolves during a presentation", () => {
    expect(canApplyWheelCandidateUpdate(true)).toBe(false);
    expect(canApplyWheelCandidateUpdate(false)).toBe(true);
  });

  it("releases the presentation only after its persisted result is deleted", () => {
    expect(resolveWheelDismissal(true)).toEqual({
      releasePresentation: true,
      reopenResult: false,
    });
    expect(resolveWheelDismissal(false)).toEqual({
      releasePresentation: false,
      reopenResult: true,
    });
  });

  it("requires the guarded lifecycle hook instead of unguarded focus/reconnect refetches", () => {
    expect(discoverQueryOptions.staleTime).toBe(0);
    expect(liveCandidateQueryOptions.refetchOnMount).toBe("always");
    expect(liveCandidateQueryOptions.refetchOnWindowFocus).toBe(false);
    expect(liveCandidateQueryOptions.refetchOnReconnect).toBe(false);
  });
});