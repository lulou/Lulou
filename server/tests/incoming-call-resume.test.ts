import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncomingCallAuthority, type IncomingCallCandidate } from "../../client/src/lib/incoming-call-authority";
import { canVerifyIncomingAgainstCachedMatch, projectVerifiedIncomingMatch } from "../../client/src/lib/incoming-call-app-helpers";

describe("incoming authority renewal and authentication recovery", () => {
  let authority: IncomingCallAuthority;
  const candidate: IncomingCallCandidate = { matchId: "match", callSessionId: "session", callerId: "caller", calleeId: "callee" };
  const live = (ageMs = 0) => ({ ...candidate, valid: true, status: "ringing", ageMs });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    authority = new IncomingCallAuthority();
    authority.setIdentity("callee", "auth-one");
  });
  afterEach(() => { authority.setIdentity(null); vi.useRealTimers(); });

  it("keeps one ownership object and deadline across verified rerings", async () => {
    const first = await authority.verify(candidate, async () => live());
    const deadline = first!.expiresAt;
    vi.advanceTimersByTime(1_000);
    const second = await authority.verify(candidate, async () => live(1_000));
    expect(second).toBe(first);
    expect(second!.expiresAt).toBe(deadline);
  });

  it("a wrong-caller prompt cannot cancel a legitimately verified session", async () => {
    const first = await authority.verify(candidate, async () => live());
    const verifier = vi.fn(async () => live());
    expect(await authority.verify({ ...candidate, callerId: "wrong" }, verifier)).toBeNull();
    expect(verifier).not.toHaveBeenCalled();
    expect(authority.get(candidate.callSessionId)).toBe(first);
  });

  it("retires an answered grant without emitting an expiry termination later", async () => {
    const reasons: string[] = [];
    authority.subscribe((_sid, reason) => reasons.push(reason));
    await authority.verify(candidate, async () => live());
    await authority.verify(candidate, async () => ({ valid: false, reason: "already_answered" }));
    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(reasons).toContain("answered");
    vi.advanceTimersByTime(100_000);
    expect(reasons).not.toContain("expired");
    expect(authority.getRecoveryCandidates()).toEqual([]);
  });

  it("requires a fresh verification after same-account authentication reset", async () => {
    const first = await authority.verify(candidate, async () => live());
    authority.invalidate("login_time_changed");
    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(authority.getRecoveryCandidates()).toEqual([candidate]);
    const second = await authority.verify(candidate, async () => live());
    expect(second!.generation).not.toBe(first!.generation);
    expect(authority.get(candidate.callSessionId)).toBe(second);
  });

  it("retains a pagehide candidate but cannot reuse its old grant on pageshow", async () => {
    await authority.verify(candidate, async () => live());
    authority.setForeground(false);
    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(authority.getRecoveryCandidates()).toEqual([candidate]);
    authority.setForeground(true);
    expect(authority.get(candidate.callSessionId)).toBeNull();
    await authority.verify(candidate, async () => live());
    expect(authority.get(candidate.callSessionId)).not.toBeNull();
  });

  it("does not recover expired or another account's candidate", async () => {
    await authority.verify(candidate, async () => live(89_000));
    authority.setForeground(false);
    vi.advanceTimersByTime(2_000);
    expect(authority.getRecoveryCandidates()).toEqual([]);
    authority.setIdentity("other", "auth-two");
    expect(authority.getRecoveryCandidates()).toEqual([]);
    expect(await authority.verify(candidate, async () => live())).toBeNull();
  });

  it("notifies generation changes when only an in-flight request exists", async () => {
    const reasons: string[] = [];
    authority.subscribe((_sid, reason) => reasons.push(reason));
    let resolve!: (value: ReturnType<typeof live>) => void;
    const pending = authority.verify(candidate, () => new Promise(resolveRequest => { resolve = resolveRequest; }));
    authority.invalidate("armed_sessions_cleared");
    resolve(live());
    expect(await pending).toBeNull();
    expect(reasons).toContain("generation_changed");
    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(authority.getRecoveryCandidates()).toEqual([candidate]);
    const recovered = await authority.verify(candidate, async () => live());
    expect(authority.get(candidate.callSessionId)).toBe(recovered);
  });

  it("reverifies a retained first ring against an existing unpatched match after auth reset", async () => {
    const match = { id: "match", user1Id: "caller", user2Id: "callee", callSessionId: null, callInitiatorId: null, callAnswered: false, callCompleted: false };
    let resolve!: (value: ReturnType<typeof live>) => void;
    const pending = authority.verify(candidate, () => new Promise(resolveRequest => { resolve = resolveRequest; }));
    authority.invalidate("login_time_changed");
    resolve(live());
    expect(await pending).toBeNull();
    expect(canVerifyIncomingAgainstCachedMatch(match, candidate, false)).toBe(false);
    const retained = authority.getRecoveryCandidates().some(saved => saved.callSessionId === candidate.callSessionId);
    expect(canVerifyIncomingAgainstCachedMatch(match, candidate, retained)).toBe(true);
    expect(authority.get(candidate.callSessionId)).toBeNull();
    const verifier = vi.fn(async () => live());
    const grant = await authority.verify(candidate, verifier);
    expect(verifier).toHaveBeenCalledOnce();
    const projected = projectVerifiedIncomingMatch(match, grant!);
    expect(projected).toMatchObject({ callSessionId: "session", callInitiatorId: "caller", callAnswered: false });
    expect(projectVerifiedIncomingMatch({ ...match, callSessionId: "replacement" }, grant!)).toBeNull();
    expect(projectVerifiedIncomingMatch({ ...match, callAnswered: true }, grant!)).toBeNull();
    expect(canVerifyIncomingAgainstCachedMatch({ ...match, user2Id: "wrong" }, candidate, true)).toBe(false);
  });
});