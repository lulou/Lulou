import { describe, expect, it } from "vitest";
import {
  DISCOVER_CONTENT_ROOT_STYLE,
  getDiscoverScrollRange,
} from "../../client/src/lib/discover-scroll-layout";
import { getAppLayoutScrollPolicy } from "../../client/src/lib/app-layout-scroll-policy";

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

  it("keeps the physical iPhone root-route profile inside the scroll owner", () => {
    // Production iPhone evidence: the root route rendered a 1,777 px Discover
    // profile inside a 641 px main element. The former AppLayout route check
    // treated "/" as a non-scroll tab even though PersistentTabs renders
    // Discover there, clipping all 1,136 px of available scroll range.
    const physicalIphone = {
      route: "/",
      scrollTop: 0,
      scrollHeight: 1_777,
      clientHeight: 641,
    };
    const scrollRange = physicalIphone.scrollHeight - physicalIphone.clientHeight;
    const policy = getAppLayoutScrollPolicy(physicalIphone.route);
    const canContinueVerticalSwipe =
      policy.usesHeaderScrollOwner && scrollRange > physicalIphone.scrollTop;

    expect(scrollRange).toBe(1_136);
    expect(policy.usesHeaderScrollOwner).toBe(true);
    expect(canContinueVerticalSwipe).toBe(true);
  });
});