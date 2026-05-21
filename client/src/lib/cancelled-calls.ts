// Keys are "matchId:callSessionId" — never just matchId, which would block future calls.
const cancelledSessions = new Set<string>();

// Tracks sessions that were cancelled ONLY by the startup sweep (not by a user
// action like decline/end). These can be un-cancelled when a fresh rering arrives,
// which proves the call is still live. Sessions cancelled by user action are never
// in this set, so they can never be un-cancelled by a rering.
const startupOnlyKeys = new Set<string>();

// ── React notification bridge ─────────────────────────────────────────────────
// cancelledSessions is a plain module-level Set, which React cannot observe.
// Whenever the Set changes, we call this listener so App.tsx can increment a
// state counter and force the incomingCall/answeredCall/callerRingingCall memos
// to re-run.  Without this, clearStartupCancelledSession() on rering receipt
// would mutate the Set but the memos would NOT re-run (deps unchanged), leaving
// incomingCall = null even after the startup-cancelled block is lifted.
let _changeListener: (() => void) | null = null;

export function setOnCancelledSessionChange(fn: (() => void) | null) {
  _changeListener = fn;
}

function sessionKey(matchId: string, callSessionId: string) {
  return `${matchId}:${callSessionId}`;
}

export function markCallSessionCancelled(matchId: string, callSessionId?: string | null) {
  if (!callSessionId) return;
  const key = sessionKey(matchId, callSessionId);
  cancelledSessions.add(key);
  console.log("[CALL_SESSION] CALL_SESSION_MARKED_CANCELLED", {
    matchId,
    callSessionId,
    setSize: cancelledSessions.size,
  });
  _changeListener?.();
}

/**
 * Mark a session as cancelled by the startup sweep only.
 *
 * This adds it to cancelledSessions (so the overlay cannot mount from stale DB
 * data or from the 5-second refetch interval) but also records it in
 * startupOnlyKeys so that a live rering can lift the block via
 * clearStartupCancelledSession().
 *
 * Do NOT use this for user-action cancellations (decline/end/cancelled signals).
 * Those must use markCallSessionCancelled() which does NOT add to startupOnlyKeys,
 * making them permanent for the lifetime of the browser session.
 */
export function markStartupCancelledSession(matchId: string, callSessionId?: string | null) {
  if (!callSessionId) return;
  const key = sessionKey(matchId, callSessionId);
  cancelledSessions.add(key);
  startupOnlyKeys.add(key);
  console.log("[CALL_SESSION] STARTUP_SESSION_MARKED_CANCELLED", {
    matchId,
    callSessionId,
    setSize: cancelledSessions.size,
  });
  _changeListener?.();
}

/** True only if the session was cancelled exclusively by the startup sweep. */
export function isStartupCancelledOnly(matchId: string, callSessionId?: string | null): boolean {
  if (!callSessionId) return false;
  return startupOnlyKeys.has(sessionKey(matchId, callSessionId));
}

/**
 * Remove a startup-only cancellation so the session can ring again.
 * Called when a fresh rering arrives and proves the call is still live.
 * No-op if the session was cancelled by user action (not startup-only).
 */
export function clearStartupCancelledSession(matchId: string, callSessionId?: string | null) {
  if (!callSessionId) return;
  const key = sessionKey(matchId, callSessionId);
  if (!startupOnlyKeys.has(key)) return;
  startupOnlyKeys.delete(key);
  cancelledSessions.delete(key);
  console.log("[CALL_SESSION] STARTUP_CANCELLED_LIFTED_BY_RERING", {
    matchId,
    callSessionId,
  });
  _changeListener?.();
}

export function isCallSessionCancelled(matchId: string, callSessionId?: string | null): boolean {
  if (!callSessionId) return false;
  return cancelledSessions.has(sessionKey(matchId, callSessionId));
}

export function clearCancelledSession(matchId: string, callSessionId?: string | null) {
  if (callSessionId) {
    const key = sessionKey(matchId, callSessionId);
    cancelledSessions.delete(key);
    startupOnlyKeys.delete(key);
    _changeListener?.();
    return;
  }
  // Clear all sessions for this match (used in post-cleanup sweep)
  for (const key of cancelledSessions) {
    if (key.startsWith(`${matchId}:`)) {
      cancelledSessions.delete(key);
      startupOnlyKeys.delete(key);
    }
  }
  _changeListener?.();
}
