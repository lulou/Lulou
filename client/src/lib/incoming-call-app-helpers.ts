import type { IncomingCallCandidate } from "./incoming-call-authority";
import type { IncomingCallGrant } from "./incoming-call-authority";
import { CALL_STALE_RINGING_MS } from "../../../shared/call-lifecycle";

export type IncomingMatchCandidate = {
  id: string;
  callSessionId?: string | null;
  callInitiatorId?: string | null;
  user1Id?: string | null;
  user2Id?: string | null;
  callAnswered?: boolean | null;
  callCompleted?: boolean | null;
  callStartedAt?: string | Date | null;
};

/** A retained prompt may verify before the first ring has patched cached fields. */
export function canVerifyIncomingAgainstCachedMatch(
  match: IncomingMatchCandidate,
  candidate: IncomingCallCandidate,
  retained: boolean,
): boolean {
  if (match.id !== candidate.matchId || candidate.callerId === candidate.calleeId
    || ![match.user1Id, match.user2Id].includes(candidate.calleeId)
    || ![match.user1Id, match.user2Id].includes(candidate.callerId)
    || match.callAnswered === true || match.callCompleted === true) return false;
  if (match.callSessionId && match.callSessionId !== candidate.callSessionId) return false;
  if (match.callInitiatorId && match.callInitiatorId !== candidate.callerId) return false;
  return retained || (match.callSessionId === candidate.callSessionId && match.callInitiatorId === candidate.callerId);
}

/** Populate missing cached ringing fields only from an exact verified grant. */
export function projectVerifiedIncomingMatch<T extends IncomingMatchCandidate>(
  match: T,
  grant: IncomingCallGrant,
): T | null {
  if (!canVerifyIncomingAgainstCachedMatch(match, grant, true)) return null;
  return {
    ...match,
    callSessionId: grant.callSessionId,
    callInitiatorId: grant.callerId,
    callStartedAt: match.callStartedAt ?? new Date(grant.expiresAt - CALL_STALE_RINGING_MS).toISOString(),
    callAnswered: false,
    callCompleted: false,
  };
}

/** Build an incoming candidate with the signed-in user as the callee. */
export function makeIncomingCandidate(
  match: IncomingMatchCandidate | null | undefined,
  currentUserId: string,
): IncomingCallCandidate | null {
  if (!match?.id || !match.callSessionId || !match.callInitiatorId
    || match.callAnswered || match.callCompleted) return null;
  const callerId = match.user1Id === currentUserId ? match.user2Id
    : match.user2Id === currentUserId ? match.user1Id : null;
  if (!callerId || callerId !== match.callInitiatorId || callerId === currentUserId) return null;
  return {
    matchId: match.id,
    callSessionId: match.callSessionId,
    callerId,
    calleeId: currentUserId,
  };
}

/** Return a recovery candidate only when all four identity fields match exactly. */
export function findRetainedIncomingCandidate(
  candidate: IncomingCallCandidate | null,
  recoveryCandidates: IncomingCallCandidate[],
): IncomingCallCandidate | null {
  if (!candidate) return null;
  return recoveryCandidates.find(retained =>
    retained.matchId === candidate.matchId
      && retained.callSessionId === candidate.callSessionId
      && retained.callerId === candidate.callerId
      && retained.calleeId === candidate.calleeId,
  ) ?? null;
}

export function canVerifyCancelledIncomingCandidate(
  isCancelled: boolean,
  isStartupCancelledOnly: boolean,
): boolean {
  return !isCancelled || isStartupCancelledOnly;
}

export function hasExactIncomingAuthority(
  candidate: IncomingCallCandidate,
  getGrant: (sessionId: string, expected: IncomingCallCandidate) => unknown,
): boolean {
  const grant = getGrant(candidate.callSessionId, candidate);
  return grant !== null && grant !== undefined;
}

export function clearStartupCancellationAfterGrant(
  candidate: IncomingCallCandidate,
  grant: unknown,
  clearStartupCancellation: (matchId: string, sessionId: string) => void,
): boolean {
  if (!grant) return false;
  clearStartupCancellation(candidate.matchId, candidate.callSessionId);
  return true;
}

/** The answer tombstone must be synchronous and precede the local active-call bridge. */
export function commitIncomingAnswer<T extends { id: string; callSessionId?: string | null }>(
  match: T,
  terminal: (matchId: string, sessionId: string, reason: string) => void,
  bridgeToActiveCall: (match: T) => void,
): void {
  if (!match.callSessionId) return;
  terminal(match.id, match.callSessionId, "answered");
  bridgeToActiveCall(match);
}

export function resetStartupAfterBfcache(
  startupDoneRef: { current: boolean },
  setStartupVerified: (verified: boolean) => void,
  resetStartupSweep: () => void,
): void {
  startupDoneRef.current = false;
  setStartupVerified(false);
  resetStartupSweep();
}

/** Run recovery only once per authority generation (verified notifications do not advance it). */
export function reverifyOnAuthorityGenerationChange(
  lastGenerationRef: { current: number },
  generation: number,
  candidates: IncomingCallCandidate[],
  reverify: (candidate: IncomingCallCandidate, generation: number) => void,
): boolean {
  if (lastGenerationRef.current === generation) return false;
  lastGenerationRef.current = generation;
  for (const candidate of candidates) reverify(candidate, generation);
  return true;
}

export function revalidateAfterFreshStartupScan(
  startupDoneRef: { current: boolean },
  requiresFreshScanRef: { current: boolean },
  candidatesRef: { current: IncomingCallCandidate[] },
  revalidate: (candidates: IncomingCallCandidate[]) => void,
): boolean {
  if (!startupDoneRef.current || !requiresFreshScanRef.current) return false;
  requiresFreshScanRef.current = false;
  revalidate(candidatesRef.current);
  return true;
}

export function mergeIncomingCandidates(
  ...lists: IncomingCallCandidate[][]
): IncomingCallCandidate[] {
  return [...new Map(
    lists.flat().map(candidate => [`${candidate.matchId}:${candidate.callSessionId}`, candidate] as const),
  ).values()];
}