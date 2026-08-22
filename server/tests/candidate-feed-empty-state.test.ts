import { describe, expect, it } from "vitest";
import { classifyCandidateFeedEmptyReason } from "../candidate-feed";

describe("candidate feed distance empty reasons", () => {
  it("keeps a returning member's later nearby signup eligible", () => {
    // User A previously exhausted the feed. User B joins later and is now
    // eligible inside A's selected radius, so the feed is no longer empty.
    expect(classifyCandidateFeedEmptyReason({
      radiusActive: true,
      nearbyCount: 1,
      unrestrictedCount: 1,
    })).toBe("none");
  });

  it("reports distance only after that later signup moves outside the radius", () => {
    // The same User B is still otherwise eligible, but no longer nearby.
    expect(classifyCandidateFeedEmptyReason({
      radiusActive: true,
      nearbyCount: 0,
      unrestrictedCount: 1,
    })).toBe("distance");
  });

  it("keeps the generic empty state when no compatible candidate exists anywhere", () => {
    expect(classifyCandidateFeedEmptyReason({
      radiusActive: true,
      nearbyCount: 0,
      unrestrictedCount: 0,
    })).toBe("none");
  });

  it("does not suggest expanding distance when distance filtering is off", () => {
    expect(classifyCandidateFeedEmptyReason({
      radiusActive: false,
      nearbyCount: 0,
      unrestrictedCount: 4,
    })).toBe("none");
  });
});