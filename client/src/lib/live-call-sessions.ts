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

// Sessions armed specifically because the user opened the app by tapping a push
// notification for an incoming call.  These sessions bypass the APP_LOAD_TIME
// guard in the incomingCall memo (the call started before the app was open so
// callStartedAt < APP_LOAD_TIME by definition, yet the call is genuinely live).
const _pushArmedSessionIds = new Set<string>();

// Paid call sessions — started via credits, bypass stage gates
const _paidCallSessionIds = new Set<string>();
// Video call sessions — paid video credit or face call
const _videoCallSessionIds = new Set<string>();

export function setOnArmChange(cb: ArmChangeCallback | null): void {
  _onArmChange = cb;
}

function notifyArmChange(): void {
  try { _onArmChange?.(); } catch { /* non-fatal */ }
}

export function markSessionAsPaid(sessionId: string | null | undefined, isVideo: boolean): void {
  if (!sessionId) return;
  _paidCallSessionIds.add(sessionId);
  if (isVideo) _videoCallSessionIds.add(sessionId);
  console.log("[LIVE_CALL] session marked paid", { sessionId: sessionId.slice(0, 8), isVideo });
}

export function markSessionAsVideo(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  _videoCallSessionIds.add(sessionId);
  console.log("[LIVE_CALL] session marked video", { sessionId: sessionId.slice(0, 8) });
}

export function isPaidCallSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return _paidCallSessionIds.has(sessionId);
}

export function isVideoCallSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return _videoCallSessionIds.has(sessionId);
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

/**
 * Arm a session that was confirmed live by the user tapping a push notification
 * for an incoming call.  This bypasses the APP_LOAD_TIME guard in the
 * incomingCall memo because the call started before the app was open
 * (callStartedAt < APP_LOAD_TIME by definition) yet is genuinely active.
 */
export function armSessionFromPush(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  _pushArmedSessionIds.add(sessionId);
  console.log("[CALL_RING] session armed via push notification", { sessionId: sessionId.slice(0, 8) });
  armCallSession(sessionId); // also arms in the standard set + notifies React
}

/**
 * Returns true only if this session was armed by a push notification tap.
 * Used by the incomingCall memo and the pre-load ring guard to bypass the
 * APP_LOAD_TIME check for sessions that are provably live.
 */
export function isPushArmedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return _pushArmedSessionIds.has(sessionId);
}

export function clearAllArmedSessions(): void {
  if (_armedSessionIds.size === 0 && _paidCallSessionIds.size === 0 && _videoCallSessionIds.size === 0 && _pushArmedSessionIds.size === 0) return;
  _armedSessionIds.clear();
  _paidCallSessionIds.clear();
  _videoCallSessionIds.clear();
  _pushArmedSessionIds.clear();
  console.log("[LIVE_CALL] all sessions disarmed (logout/reset)");
  notifyArmChange();
}

/**
 * Returns true if ANY session is currently armed (useful as a quick pre-flight
 * check before starting audio, without needing a specific session ID).
 */
export function hasAnyArmedSession(): boolean {
  return _armedSessionIds.size > 0;
}
