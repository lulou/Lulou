import { describe, expect, it, vi } from "vitest";
import {
  canVerifyCancelledIncomingCandidate,
  clearStartupCancellationAfterGrant,
  commitIncomingAnswer,
  findRetainedIncomingCandidate,
  hasExactIncomingAuthority,
  makeIncomingCandidate,
  mergeIncomingCandidates,
  revalidateAfterFreshStartupScan,
  resetStartupAfterBfcache,
  reverifyOnAuthorityGenerationChange,
} from "../../client/src/lib/incoming-call-app-helpers";
import type { IncomingCallCandidate } from "../../client/src/lib/incoming-call-authority";

const match = {
  id: "match-1",
  callSessionId: "session-1",
  callInitiatorId: "caller",
  user1Id: "caller",
  user2Id: "callee",
};

const candidate: IncomingCallCandidate = {
  matchId: "match-1",
  callSessionId: "session-1",
  callerId: "caller",
  calleeId: "callee",
};

describe("incoming call App lifecycle helpers", () => {
  it("builds push/resume candidates with the signed-in recipient as callee", () => {
    expect(makeIncomingCandidate(match, "callee")).toEqual(candidate);
    expect(makeIncomingCandidate(match, "caller")).toBeNull();
    expect(makeIncomingCandidate({ ...match, user2Id: "someone-else" }, "callee")).toBeNull();
    expect(makeIncomingCandidate({ ...match, callAnswered: true }, "callee")).toBeNull();
  });

  it("preserves only the exact retained authority candidate during a fresh startup scan", () => {
    expect(findRetainedIncomingCandidate(makeIncomingCandidate(match, "callee"), [candidate]))
      .toEqual(candidate);
    expect(findRetainedIncomingCandidate(makeIncomingCandidate(match, "callee"), [
      { ...candidate, matchId: "other-match" },
    ])).toBeNull();
    expect(findRetainedIncomingCandidate(makeIncomingCandidate(match, "callee"), [
      { ...candidate, callSessionId: "other-session" },
    ])).toBeNull();
    expect(findRetainedIncomingCandidate(makeIncomingCandidate(match, "callee"), [
      { ...candidate, callerId: "other-caller" },
    ])).toBeNull();
    expect(findRetainedIncomingCandidate(makeIncomingCandidate(match, "callee"), [
      { ...candidate, calleeId: "other-callee" },
    ])).toBeNull();
  });

  it("allows verification through startup-only cancellation, but never through terminal/user cancellation", () => {
    expect(canVerifyCancelledIncomingCandidate(true, true)).toBe(true);
    expect(canVerifyCancelledIncomingCandidate(true, false)).toBe(false);
    expect(canVerifyCancelledIncomingCandidate(false, false)).toBe(true);
    const clear = vi.fn();
    expect(clearStartupCancellationAfterGrant(candidate, null, clear)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    if (canVerifyCancelledIncomingCandidate(true, false)) {
      clearStartupCancellationAfterGrant(candidate, {}, clear);
    }
    expect(clear).not.toHaveBeenCalled();
    if (canVerifyCancelledIncomingCandidate(true, true)) {
      clearStartupCancellationAfterGrant(candidate, {}, clear);
    }
    expect(clear).toHaveBeenCalledWith(candidate.matchId, candidate.callSessionId);
  });

  it("does not authorize incoming rendering without an exact current grant", () => {
    const getGrant = vi.fn().mockReturnValue(null);
    expect(hasExactIncomingAuthority(candidate, getGrant)).toBe(false);
    expect(getGrant).toHaveBeenCalledWith(candidate.callSessionId, candidate);
    getGrant.mockReturnValue({ ...candidate, generation: 5 });
    expect(hasExactIncomingAuthority(candidate, getGrant)).toBe(true);
  });

  it("tombstones a locally answered incoming session before bridging to the active call", () => {
    const order: string[] = [];
    commitIncomingAnswer(
      match,
      (matchId, sessionId, reason) => order.push(`terminal:${matchId}:${sessionId}:${reason}`),
      () => order.push("active-call-bridge"),
    );
    expect(order).toEqual([
      "terminal:match-1:session-1:answered",
      "active-call-bridge",
    ]);
  });

  it("does not bridge an incoming answer without an exact session to tombstone", () => {
    const terminal = vi.fn();
    const bridge = vi.fn();
    commitIncomingAnswer({ ...match, callSessionId: null }, terminal, bridge);
    expect(terminal).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("reopens startup verification on bfcache and restores ringing only after the fresh scan", () => {
    const startupDoneRef = { current: true };
    const startupVerified: boolean[] = [];
    const resetStartupSweep = vi.fn();
    resetStartupAfterBfcache(startupDoneRef, verified => startupVerified.push(verified), resetStartupSweep);

    expect(startupDoneRef.current).toBe(false);
    expect(startupVerified).toEqual([false]);
    expect(resetStartupSweep).toHaveBeenCalledOnce();

    const requiresFreshScanRef = { current: true };
    const candidatesRef = { current: [candidate] };
    const revalidate = vi.fn();
    expect(revalidateAfterFreshStartupScan(startupDoneRef, requiresFreshScanRef, candidatesRef, revalidate)).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
    startupDoneRef.current = true; // startup scan's first fresh network response completed
    expect(revalidateAfterFreshStartupScan(startupDoneRef, requiresFreshScanRef, candidatesRef, revalidate)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith([candidate]);
    expect(revalidateAfterFreshStartupScan(startupDoneRef, requiresFreshScanRef, candidatesRef, revalidate)).toBe(false);
  });

  it("reverifies recovered authority once per generation, not on verified notifications", () => {
    const lastGenerationRef = { current: 4 };
    const reverify = vi.fn();
    expect(reverifyOnAuthorityGenerationChange(lastGenerationRef, 4, [candidate], reverify)).toBe(false);
    expect(reverify).not.toHaveBeenCalled();
    expect(reverifyOnAuthorityGenerationChange(lastGenerationRef, 5, [candidate], reverify)).toBe(true);
    expect(reverify).toHaveBeenCalledOnce();
    expect(reverify).toHaveBeenCalledWith(candidate, 5);
    expect(reverifyOnAuthorityGenerationChange(lastGenerationRef, 5, [candidate], reverify)).toBe(false);
    expect(reverify).toHaveBeenCalledOnce();
  });

  it("deduplicates retained and freshly snapshotted candidates by match/session", () => {
    expect(mergeIncomingCandidates([candidate], [candidate, { ...candidate, callSessionId: "session-2" }]))
      .toEqual([candidate, { ...candidate, callSessionId: "session-2" }]);
  });
});