const cancelledCallSessions = new Set<string>();

export function markCallSessionCancelled(matchId: string, callSessionId?: string | null) {
  cancelledCallSessions.add(matchId);
  if (callSessionId) cancelledCallSessions.add(callSessionId);
  console.log("[CALL_SESSION] CALL_SESSION_MARKED_CANCELLED", { matchId, callSessionId, setSize: cancelledCallSessions.size });
}

export function isCallSessionCancelled(matchId: string, callSessionId?: string | null): boolean {
  if (cancelledCallSessions.has(matchId)) return true;
  if (callSessionId && cancelledCallSessions.has(callSessionId)) return true;
  return false;
}

export function clearCancelledSession(key: string) {
  cancelledCallSessions.delete(key);
}

export function getCancelledSessions(): Set<string> {
  return cancelledCallSessions;
}
