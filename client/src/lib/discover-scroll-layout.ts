import type { CSSProperties } from "react";

/**
 * Discover is rendered inside AppLayout's scrolling flex column. Its profile
 * root must size itself to the complete, asynchronously-loaded profile rather
 * than retain a viewport-sized flex allocation from the loading skeleton.
 */
export const DISCOVER_CONTENT_ROOT_STYLE = {
  flex: "0 0 auto",
  width: "100%",
} satisfies CSSProperties;

export function getDiscoverScrollRange({
  scrollOwnerClientHeight,
  headerHeight,
  contentHeight,
}: {
  scrollOwnerClientHeight: number;
  headerHeight: number;
  contentHeight: number;
}): {
  rootHeight: number;
  scrollHeight: number;
  maxScrollTop: number;
} {
  const rootHeight = Math.max(0, contentHeight);
  const scrollHeight = headerHeight + rootHeight;

  return {
    rootHeight,
    scrollHeight,
    maxScrollTop: Math.max(0, scrollHeight - scrollOwnerClientHeight),
  };
}