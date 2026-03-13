// Keys are "matchId:callSessionId" — never just matchId, which would block future calls.
const cancelledSessions = new Set<string>();

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
}

export function isCallSessionCancelled(matchId: string, callSessionId?: string | null): boolean {
  if (!callSessionId) return false;
  return cancelledSessions.has(sessionKey(matchId, callSessionId));
}

export function clearCancelledSession(matchId: string, callSessionId?: string | null) {
  if (callSessionId) {
    cancelledSessions.delete(sessionKey(matchId, callSessionId));
    return;
  }
  // Clear all sessions for this match (used in post-cleanup sweep)
  for (const key of cancelledSessions) {
    if (key.startsWith(`${matchId}:`)) {
      cancelledSessions.delete(key);
    }
  }
}
