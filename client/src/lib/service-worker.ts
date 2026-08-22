/**
 * Each frontend bundle registers a commit-qualified worker URL. The query string
 * does not affect worker scope, but it makes a newly delivered app shell request
 * the current worker immediately instead of waiting for Safari's update cadence.
 */
export const SERVICE_WORKER_URL = `/sw.js?v=${encodeURIComponent(__COMMIT_HASH__)}`;

export const SERVICE_WORKER_OPTIONS = {
  scope: "/",
  updateViaCache: "none" as const,
};

let reloadBlocked = false;
let reloadRequested = false;

function flushWorkerReload(): void {
  if (!reloadRequested || reloadBlocked || typeof window === "undefined") return;
  const guardKey = "sw_reload_done";
  reloadRequested = false;
  try {
    if (sessionStorage.getItem(guardKey)) {
      console.log("[SW] controllerchange — reload already done this session, skipping");
      return;
    }
    sessionStorage.setItem(guardKey, "1");
  } catch {
    // Storage can be unavailable in private browsing; a one-off reload remains
    // safer than leaving a client on a mismatched worker and app bundle.
  }
  console.log("[SW] controllerchange — reloading for new worker");
  window.location.reload();
}

/** Request a reload after a new worker takes control, unless a fragile flow is active. */
export function requestServiceWorkerReload(): void {
  reloadRequested = true;
  flushWorkerReload();
}

/**
 * The Wheel sets this while spinning or showing a result. An update can activate
 * in the background, but the page reload waits until the member closes the
 * result, preserving the in-progress presentation and persisted outcome.
 */
export function setServiceWorkerReloadBlocked(blocked: boolean): void {
  reloadBlocked = blocked;
  if (!blocked) flushWorkerReload();
}