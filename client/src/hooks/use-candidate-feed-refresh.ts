import { useCallback, useEffect, useRef } from "react";

type CandidateFeedRefreshOptions = {
  active: boolean;
  enabled?: boolean;
  feed: "discover" | "intention-wheel";
  refresh: () => Promise<unknown>;
};

const REFRESH_DEDUPE_MS = 1_500;

export function canRefreshCandidateFeed(
  active: boolean,
  enabled: boolean,
  lastRefreshAt: number,
  now: number,
): boolean {
  return active && enabled && now - lastRefreshAt >= REFRESH_DEDUPE_MS;
}

/**
 * PersistentTabs deliberately keeps every tab mounted. A live candidate feed
 * therefore cannot rely on a component remount to refresh when its tab opens.
 *
 * This hook owns the lifecycle edges React Query cannot infer from our
 * display:none tab implementation: returning to a persistent tab, foreground
 * resume, and restoring a page from the bfcache.
 */
export function useCandidateFeedRefresh({
  active,
  enabled = true,
  feed,
  refresh,
}: CandidateFeedRefreshOptions): void {
  const activeRef = useRef(active);
  const enabledRef = useRef(enabled);
  const refreshRef = useRef(refresh);
  const wasActiveOnMountRef = useRef(active);
  const hasEnteredActiveTabRef = useRef(false);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    activeRef.current = active;
    enabledRef.current = enabled;
    refreshRef.current = refresh;
  }, [active, enabled, refresh]);

  const requestRefresh = useCallback((source: "tab-entry" | "foreground" | "bfcache-restore") => {
    const now = Date.now();
    // Foreground can dispatch visibilitychange + pageshow together. Keep it to
    // one request, and never refresh the Wheel while its result is in motion.
    if (!canRefreshCandidateFeed(activeRef.current, enabledRef.current, lastRefreshAtRef.current, now)) return;
    lastRefreshAtRef.current = now;

    console.info("[CANDIDATE_FEED_REFRESH]", { feed, source });
    void refreshRef.current().catch((error) => {
      // React Query keeps its own error state; this log only makes an installed
      // device's lifecycle path observable in a developer console.
      console.warn("[CANDIDATE_FEED_REFRESH] failed", {
        feed,
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [feed]);

  useEffect(() => {
    if (!active || !enabled) return;

    // The initially visible tab already performs React Query's first request.
    // A tab that was mounted while hidden must make a fresh request on its first
    // visible entry, as must every later entry.
    const shouldRefresh = hasEnteredActiveTabRef.current || !wasActiveOnMountRef.current;
    hasEnteredActiveTabRef.current = true;
    if (shouldRefresh) requestRefresh("tab-entry");
  }, [active, enabled, requestRefresh]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRefresh("foreground");
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) requestRefresh("bfcache-restore");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [requestRefresh]);
}