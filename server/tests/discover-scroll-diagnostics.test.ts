import { describe, expect, it } from "vitest";
import {
  DISCOVER_SCROLL_CHECKPOINTS,
  isDiscoverScrollStuck,
} from "../../client/src/lib/discover-scroll-diagnostic-rules";

describe("Discover iPhone scroll diagnostics", () => {
  it("keeps the diagnostic checkpoint set bounded and explicit", () => {
    expect(DISCOVER_SCROLL_CHECKPOINTS).toEqual([
      "discover_mount",
      "discover_profile_loaded",
      "first_touch_start",
      "first_vertical_move",
      "scroll_attempt",
      "scroll_stuck_detected",
      "image_loaded_plus_500ms",
      "image_loaded_plus_1500ms",
    ]);
  });

  it("reports the physical failure shape without treating a normal scroll as stuck", () => {
    expect(isDiscoverScrollStuck({
      verticalSwipe: true,
      startScrollTop: 240,
      currentScrollTop: 240,
      scrollHeight: 900,
      clientHeight: 660,
      contentBelowViewport: true,
    })).toBe(true);

    expect(isDiscoverScrollStuck({
      verticalSwipe: true,
      startScrollTop: 240,
      currentScrollTop: 300,
      scrollHeight: 1_900,
      clientHeight: 660,
      contentBelowViewport: true,
    })).toBe(false);
  });
});