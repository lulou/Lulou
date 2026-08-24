import { describe, expect, it } from "vitest";
import {
  DISCOVER_CONTENT_ROOT_STYLE,
  getDiscoverScrollRange,
} from "../../client/src/lib/discover-scroll-layout";

describe("Discover first-render scroll lifecycle", () => {
  it("expands the existing shell scroll range when an async profile replaces the skeleton", () => {
    const scrollOwnerClientHeight = 700;
    const headerHeight = 64;

    const loadingSkeleton = getDiscoverScrollRange({
      scrollOwnerClientHeight,
      headerHeight,
      contentHeight: 380,
    });
    expect(loadingSkeleton.maxScrollTop).toBe(0);

    const loadedProfile = getDiscoverScrollRange({
      scrollOwnerClientHeight,
      headerHeight,
      contentHeight: 2_200,
    });

    expect(DISCOVER_CONTENT_ROOT_STYLE.flex).toBe("0 0 auto");
    expect(loadedProfile.rootHeight).toBe(2_200);
    expect(loadedProfile.scrollHeight).toBe(2_264);
    expect(loadedProfile.maxScrollTop).toBe(1_564);
  });
});