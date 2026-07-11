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

// ── Self-cancelled sessions ───────────────────────────────────────────────────
// Tracks sessions where the CURRENT USER was the one who cancelled the call
// (via the full-screen overlay end button, not via the inline chat cancel button
// in matches.tsx). Used to suppress the false "{name} declined" toast in the
// caller's inline chat when the caller ends their own ringing call from the overlay.
const selfCancelledByCurrentUser = new Set<string>();

export function markSelfCancelled(matchId: string, callSessionId?: string | null) {
  if (!callSessionId) return;
  selfCancelledByCurrentUser.add(sessionKey(matchId, callSessionId));
}

export function isSelfCancelled(matchId: string, callSessionId?: string | null): boolean {
  if (!callSessionId) return false;
  return selfCancelledByCurrentUser.has(sessionKey(matchId, callSessionId));
}

// ── Recently-ended session tracking ──────────────────────────────────────────
// Module-level Map (persists across component navigation).  When a call:cancelled
// or call:declined signal fires in use-call-signaling.ts, the session is recorded
// here keyed by matchId.  messaging.tsx reads this on mount so the "Start First
// Call" CTA card is suppressed even when the user navigates TO the chat AFTER the
// call ended (where the component-local lastSeenCallSessionIdRef would be null).

type EndedEntry = { sessionId: string; reason: string; at: number };
const recentlyEndedByMatch = new Map<string, EndedEntry>();
const RECENTLY_ENDED_TTL_MS = 3 * 60 * 1000; // suppress for 3 minutes

export function markSessionEndedForMatch(matchId: string, sessionId: string | null | undefined, reason: string) {
  if (!sessionId) return;
  recentlyEndedByMatch.set(matchId, { sessionId, reason, at: Date.now() });
  console.log("[CALL_DECLINE_FIX] markSessionEndedForMatch", {
    matchId: matchId.slice(0, 8),
    sessionId: sessionId.slice(0, 8),
    reason,
  });
}

export function getEndedSessionForMatch(matchId: string): EndedEntry | null {
  const entry = recentlyEndedByMatch.get(matchId);
  if (!entry) return null;
  if (Date.now() - entry.at > RECENTLY_ENDED_TTL_MS) {
    recentlyEndedByMatch.delete(matchId);
    return null;
  }
  return entry;
}

export function clearEndedSessionForMatch(matchId: string) {
  recentlyEndedByMatch.delete(matchId);
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
