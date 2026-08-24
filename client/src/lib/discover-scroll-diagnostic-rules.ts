export const DISCOVER_SCROLL_CHECKPOINTS = [
  "discover_mount",
  "discover_profile_loaded",
  "first_touch_start",
  "first_vertical_move",
  "scroll_attempt",
  "scroll_stuck_detected",
  "image_loaded_plus_500ms",
  "image_loaded_plus_1500ms",
] as const;

export type DiscoverScrollCheckpoint = (typeof DISCOVER_SCROLL_CHECKPOINTS)[number];

const SCROLL_TOLERANCE_PX = 4;

export function isDiscoverScrollStuck({
  verticalSwipe,
  startScrollTop,
  currentScrollTop,
  scrollHeight,
  clientHeight,
  contentBelowViewport,
}: {
  verticalSwipe: boolean;
  startScrollTop: number;
  currentScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  contentBelowViewport: boolean;
}): boolean {
  const atScrollLimit = scrollHeight - clientHeight <= currentScrollTop + SCROLL_TOLERANCE_PX;
  const didNotAdvance = currentScrollTop <= startScrollTop + SCROLL_TOLERANCE_PX;
  return verticalSwipe && didNotAdvance && contentBelowViewport && atScrollLimit;
}