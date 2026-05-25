/**
 * Tracks call session IDs "armed" by live events in this browser session.
 *
 * ONLY sessions in this set may trigger ringtone, ringback, or overlay mounts.
 * Polled/cached DB data alone — even with callStartedAt > APP_LOAD_TIME — can
 * NEVER arm a session. This is the definitive guard preventing stale DB rows
 * from triggering audio or overlays when the user opens Connections/Matches.
 *
 * Sessions are armed by:
 *   - RECEIVER: Realtime call:ring broadcast received      (use-call-signaling.ts)
 *   - CALLER:   startCall() mutation success               (matches.tsx onSuccess)
 *   - CALLER:   rering useEffect in CallDetectors          (App.tsx — post-refresh resume)
 *   - BOTH:     Realtime call:answered signal              (belt-and-suspenders)
 *
 * Sessions are disarmed by:
 *   - markCallEnded in CallDetectors (hang-up, end signal, overlay crash)
 *   - clearAllArmedSessions on logout / CallDetectors unmount
 *
 * The setOnArmChange callback mirrors the cancelled-calls.ts pattern:
 * CallDetectors registers it to increment a React tick counter so the three
 * call-detection memos re-run immediately when a session is armed or disarmed.
 */

type ArmChangeCallback = () => void;
let _onArmChange: ArmChangeCallback | null = null;

const _armedSessionIds = new Set<string>();

export function setOnArmChange(cb: ArmChangeCallback | null): void {
  _onArmChange = cb;
}

function notifyArmChange(): void {
  try { _onArmChange?.(); } catch { /* non-fatal */ }
}

export function armCallSession(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const isNew = !_armedSessionIds.has(sessionId);
  _armedSessionIds.add(sessionId);
  if (isNew) {
    console.log("[LIVE_CALL] session armed", { sessionId: sessionId.slice(0, 8) });
    notifyArmChange();
  }
}

export function disarmCallSession(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  if (_armedSessionIds.has(sessionId)) {
    _armedSessionIds.delete(sessionId);
    console.log("[LIVE_CALL] session disarmed", { sessionId: sessionId.slice(0, 8) });
    notifyArmChange();
  }
}

/**
 * Returns true only if the given session was armed by a live event this session.
 * DB-polled/cached data that was never confirmed by a Realtime signal or user
 * action will always return false, preventing ghost overlays and audio.
 */
export function isArmedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return _armedSessionIds.has(sessionId);
}

export function clearAllArmedSessions(): void {
  if (_armedSessionIds.size === 0) return;
  _armedSessionIds.clear();
  console.log("[LIVE_CALL] all sessions disarmed (logout/reset)");
  notifyArmChange();
}
