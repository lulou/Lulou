import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IncomingCallAuthority,
  type IncomingCallCandidate,
  type IncomingCallVerification,
} from "../../client/src/lib/incoming-call-authority";
import { CALL_STALE_RINGING_MS } from "../../shared/call-lifecycle";

const candidate: IncomingCallCandidate = {
  matchId: "match-a",
  callSessionId: "session-a",
  callerId: "caller-a",
  calleeId: "callee-a",
};

function verified(overrides: Partial<IncomingCallVerification> = {}): IncomingCallVerification {
  return {
    valid: true,
    status: "ringing",
    matchId: candidate.matchId,
    callSessionId: candidate.callSessionId,
    callerId: candidate.callerId,
    calleeId: candidate.calleeId,
    ageMs: 1_000,
    ...overrides,
  };
}

describe("IncomingCallAuthority", () => {
  let authority: IncomingCallAuthority;
  const verifier = vi.fn(async () => verified());

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));
    authority = new IncomingCallAuthority();
    authority.setIdentity(candidate.calleeId, "auth-session-1");
    verifier.mockReset();
    verifier.mockResolvedValue(verified());
  });

  afterEach(() => {
    authority.invalidate("test_cleanup");
    vi.useRealTimers();
  });

  it("grants authority only for the exact, verified incoming callee/session", async () => {
    const grant = await authority.verify(candidate, verifier);

    expect(grant).toMatchObject(candidate);
    expect(authority.get(candidate.callSessionId, candidate)).toBe(grant);
    expect(authority.snapshot()).toEqual([grant]);
  });

  it.each([
    ["wrong caller", { callerId: "somebody-else" }],
    ["wrong recipient", { calleeId: "somebody-else" }],
    ["wrong match", { matchId: "some-match" }],
    ["wrong session", { callSessionId: "some-session" }],
    ["missing session", { callSessionId: "" }],
  ])("rejects a %s candidate or verification", async (_case, change) => {
    const suppliedCandidate = { ...candidate, ...change };
    const grant = await authority.verify(suppliedCandidate, verifier);

    expect(grant).toBeNull();
    expect(authority.snapshot()).toEqual([]);
  });

  it.each([
    ["wrong caller", { callerId: "somebody-else" }],
    ["wrong recipient", { calleeId: "somebody-else" }],
    ["wrong match", { matchId: "some-match" }],
    ["wrong session", { callSessionId: "some-session" }],
    ["missing session", { callSessionId: undefined }],
  ])("rejects verification with a %s", async (_case, change) => {
    verifier.mockResolvedValue(verified(change));

    expect(await authority.verify(candidate, verifier)).toBeNull();
    expect(authority.get(candidate.callSessionId)).toBeNull();
  });

  it.each([
    ["answered", { status: "answered" }],
    ["ended", { status: "ended" }],
    ["cancelled", { status: "cancelled" }],
    ["declined", { status: "declined" }],
    ["invalid", { valid: false }],
    ["future-dated", { ageMs: -1 }],
    ["expired", { ageMs: CALL_STALE_RINGING_MS }],
  ])("does not grant authority for a %s call", async (_case, change) => {
    verifier.mockResolvedValue(verified(change));

    expect(await authority.verify(candidate, verifier)).toBeNull();
    expect(authority.get(candidate.callSessionId)).toBeNull();
  });

  it("fails closed when verification is unavailable", async () => {
    verifier.mockResolvedValue(null as never);

    expect(await authority.verify(candidate, verifier)).toBeNull();
    expect(authority.snapshot()).toEqual([]);
  });

  it("expires a grant independently of match polling or another event", async () => {
    await authority.verify(candidate, verifier);
    expect(authority.get(candidate.callSessionId)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(CALL_STALE_RINGING_MS - 1_000);

    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(authority.snapshot()).toEqual([]);
  });

  it("revokes authority in the background and requires a fresh verification on foreground return", async () => {
    await authority.verify(candidate, verifier);
    authority.setForeground(false);

    expect(authority.get(candidate.callSessionId)).toBeNull();
    authority.setForeground(true);
    expect(authority.get(candidate.callSessionId)).toBeNull();

    verifier.mockClear();
    expect(await authority.verify(candidate, verifier)).not.toBeNull();
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("invalidates grants and pending work when the account or auth session changes", async () => {
    await authority.verify(candidate, verifier);
    authority.setIdentity(candidate.calleeId, "auth-session-2");
    expect(authority.get(candidate.callSessionId)).toBeNull();

    const delayed = vi.fn<Parameters<typeof verifier>, ReturnType<typeof verifier>>(
      () => new Promise(resolve => setTimeout(() => resolve(verified()), 20)),
    );
    const pending = authority.verify(candidate, delayed);
    authority.setIdentity("another-user", "auth-session-3");
    await vi.advanceTimersByTimeAsync(20);

    expect(await pending).toBeNull();
    expect(authority.snapshot()).toEqual([]);
  });

  it("invalidates work across an explicit auth-generation reset for the same account", async () => {
    let finishVerification!: (result: IncomingCallVerification) => void;
    const pending = authority.verify(candidate, () => new Promise(resolve => {
      finishVerification = resolve;
    }));

    authority.invalidate("same_account_auth_reset");
    finishVerification(verified());

    expect(await pending).toBeNull();
    expect(authority.get(candidate.callSessionId)).toBeNull();
  });

  it("does not arm a result after the verifier's current-subscription check turns false", async () => {
    let current = true;
    let finishVerification!: (result: IncomingCallVerification) => void;
    const pending = authority.verify(candidate, () => new Promise(resolve => {
      finishVerification = resolve;
    }), () => current);

    current = false;
    finishVerification(verified());

    expect(await pending).toBeNull();
    expect(authority.snapshot()).toEqual([]);
  });

  it("does not grant authority if the call becomes terminal during verification", async () => {
    let finishVerification!: (result: IncomingCallVerification) => void;
    const pending = authority.verify(candidate, () => new Promise(resolve => {
      finishVerification = resolve;
    }));

    authority.terminal(candidate.matchId, candidate.callSessionId, "ended");
    finishVerification(verified());

    expect(await pending).toBeNull();
    expect(authority.get(candidate.callSessionId)).toBeNull();
  });

  it("coalesces overlapping verification prompts for the same session", async () => {
    let finishVerification!: (result: IncomingCallVerification) => void;
    const delayedVerifier = vi.fn(() => new Promise<IncomingCallVerification>(resolve => {
      finishVerification = resolve;
    }));

    const first = authority.verify(candidate, delayedVerifier);
    const overlapping = authority.verify(candidate, delayedVerifier);
    expect(delayedVerifier).toHaveBeenCalledTimes(1);
    finishVerification(verified());

    const [firstGrant, overlappingGrant] = await Promise.all([first, overlapping]);
    expect(firstGrant).toBe(overlappingGrant);
    expect(authority.snapshot()).toEqual([firstGrant]);
  });

  it("allows only the replacement session for a match when verifications overlap", async () => {
    const replacement = { ...candidate, callSessionId: "session-b" };
    let finishFirst!: (result: IncomingCallVerification) => void;
    const first = authority.verify(candidate, () => new Promise(resolve => {
      finishFirst = resolve;
    }));
    const replacementGrantPromise = authority.verify(replacement, async () => verified({
      callSessionId: replacement.callSessionId,
    }));

    finishFirst(verified());
    expect(await first).toBeNull();
    const replacementGrant = await replacementGrantPromise;
    expect(replacementGrant?.callSessionId).toBe(replacement.callSessionId);
    expect(authority.get(candidate.callSessionId)).toBeNull();
    expect(authority.get(replacement.callSessionId)).toBe(replacementGrant);
  });

  it("preserves a verified call across ordinary navigation without invalidating authority", async () => {
    await authority.verify(candidate, verifier);

    // Navigation changes UI/subscriptions, not authenticated call authority.
    expect(authority.get(candidate.callSessionId, candidate)).not.toBeNull();
  });
});