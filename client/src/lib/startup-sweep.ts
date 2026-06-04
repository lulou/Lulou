/**
 * Tracks whether the startup staleness sweep in CallDetectors has completed
 * its first /api/matches pass.
 *
 * Before the sweep completes, the call:ring handler in use-call-signaling.ts
 * must NOT arm any call session. A rering that arrives before the first
 * /api/matches response could be for a pre-load stale call (callStartedAt <
 * APP_LOAD_TIME) — we cannot tell from the Realtime payload alone because the
 * rering message does not carry callStartedAt.
 *
 * After the sweep completes:
 *   - Pre-load stale calls are in cancelledSessions (blocked).
 *   - Genuine new calls (callStartedAt >= APP_LOAD_TIME) are safe to arm.
 *   - The rering interval is 2 s, so delaying the first ring by one rering
 *     cycle is imperceptible and safe.
 *
 * Lifecycle:
 *   - resetStartupSweep()       — called on CallDetectors mount and unmount.
 *   - markStartupSweepComplete() — called inside the startup sweep useEffect
 *                                  once startupDoneRef is set to true.
 */

let _swept = false;

export function markStartupSweepComplete(): void {
  if (_swept) return;
  _swept = true;
  console.log("[CALL_BOOT] startup sweep complete — rerings now permitted");
}

export function resetStartupSweep(): void {
  _swept = false;
}

export function isStartupSweepComplete(): boolean {
  return _swept;
}
