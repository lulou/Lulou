export function canApplyAnsweredSignal(
  matchId: string,
  userId: string,
  event: { matchId?: unknown; callSessionId?: unknown; userId?: unknown },
  row: any,
): boolean {
  if (!row || event.matchId !== matchId || typeof event.callSessionId !== "string" || !event.callSessionId) return false;
  if (row.id !== matchId || row.callSessionId !== event.callSessionId || row.callInitiatorId !== userId
    || row.callAnswered !== true || row.callCompleted === true || !row.callStartedAt) return false;
  if (row.user1Id !== userId && row.user2Id !== userId) return false;
  const calleeId = row.user1Id === userId ? row.user2Id : row.user1Id;
  return !!calleeId && calleeId !== userId && event.userId === calleeId;
}