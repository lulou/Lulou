import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDedupeForMatch,
  setCallEndedHandler,
  setCallRingHandler,
  useCallSignaling,
} from "../../client/src/hooks/use-call-signaling";
import {
  incomingCallAuthority,
  type IncomingCallCandidate,
  type IncomingCallVerification,
} from "../../client/src/lib/incoming-call-authority";

const MATCH_ID = "match-hook";
const CALLER_ID = "caller-hook";
const CALLEE_ID = "callee-hook";
const SESSION_ID = "session-hook";
let testSessionId = SESSION_ID;
let testCounter = 0;

const harness = vi.hoisted(() => ({
  effect: null as null | (() => void | (() => void)),
  ref: { current: "" as string },
  pairs: [] as any[],
  cache: new Map<string, any>(),
  cancelled: new Set<string>(),
  startupCancelled: new Set<string>(),
  backendRow: null as any,
  verifyIncomingCall: vi.fn(),
  apiRequest: vi.fn(),
  armCallSession: vi.fn(),
  disarmCallSession: vi.fn(),
  markSessionAsVideo: vi.fn(),
  isPushArmedSession: vi.fn(() => false),
  getLoginTime: vi.fn(() => 0),
  startupSweepComplete: vi.fn(() => true),
  stopIncomingRingtoneForSession: vi.fn(),
  stopCallSoundsForSession: vi.fn(),
  markCallSessionCancelled: vi.fn((matchId: string, sessionId: string) => {
    harness.cancelled.add(`${matchId}:${sessionId}`);
  }),
  markStartupCancelledSession: vi.fn((matchId: string, sessionId: string) => {
    harness.startupCancelled.add(`${matchId}:${sessionId}`);
  }),
  isCallSessionCancelled: vi.fn((matchId: string, sessionId: string) =>
    harness.cancelled.has(`${matchId}:${sessionId}`)),
  isStartupCancelledOnly: vi.fn((matchId: string, sessionId: string) =>
    harness.startupCancelled.has(`${matchId}:${sessionId}`)
      && !harness.cancelled.has(`${matchId}:${sessionId}`)),
  clearStartupCancelledSession: vi.fn((matchId: string, sessionId: string) => {
    harness.startupCancelled.delete(`${matchId}:${sessionId}`);
  }),
  markSessionEndedForMatch: vi.fn(),
  callEndedHandler: vi.fn(),
  callRingHandler: vi.fn(),
  setCallEndedHandler: null as null | ((handler: ((matchId: string, sessionId?: string | null) => void) | null) => void),
  setCallRingHandler: null as null | ((handler: ((active: boolean) => void) | null) => void),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    harness.effect = effect;
  },
  useRef: (initial: string) => {
    if (harness.ref.current === "") harness.ref.current = initial;
    return harness.ref;
  },
}));

vi.mock("@/lib/queryClient", () => {
  const keyFor = (key: unknown[]) => JSON.stringify(key);
  const matchesPrefix = (stored: unknown[], prefix: unknown[]) =>
    prefix.every((part, index) => stored[index] === part);
  return {
    apiRequest: harness.apiRequest,
    queryClient: {
      getQueryData: (key: unknown[]) => harness.cache.get(keyFor(key)),
      getQueryState: (key: unknown[]) => ({ data: harness.cache.get(keyFor(key)) }),
      setQueryData: vi.fn((key: unknown[], updater: any) => {
        const cacheKey = keyFor(key);
        const previous = harness.cache.get(cacheKey);
        harness.cache.set(cacheKey, typeof updater === "function" ? updater(previous) : updater);
      }),
      setQueriesData: vi.fn(({ queryKey }: { queryKey: unknown[] }, updater: any) => {
        for (const [key, previous] of harness.cache.entries()) {
          if (matchesPrefix(JSON.parse(key), queryKey)) {
            harness.cache.set(key, updater(previous));
          }
        }
      }),
      invalidateQueries: vi.fn(),
      cancelQueries: vi.fn(),
    },
  };
});

vi.mock("@/lib/cancelled-calls", () => ({
  markCallSessionCancelled: harness.markCallSessionCancelled,
  markStartupCancelledSession: harness.markStartupCancelledSession,
  isCallSessionCancelled: harness.isCallSessionCancelled,
  isStartupCancelledOnly: harness.isStartupCancelledOnly,
  clearStartupCancelledSession: harness.clearStartupCancelledSession,
  markSessionEndedForMatch: harness.markSessionEndedForMatch,
}));

vi.mock("@/lib/live-call-sessions", () => ({
  armCallSession: harness.armCallSession,
  disarmCallSession: harness.disarmCallSession,
  markSessionAsVideo: harness.markSessionAsVideo,
  isPushArmedSession: harness.isPushArmedSession,
  getLoginTime: harness.getLoginTime,
}));

vi.mock("@/lib/call-audio", () => ({
  stopIncomingRingtoneForSession: harness.stopIncomingRingtoneForSession,
  stopCallSoundsForSession: harness.stopCallSoundsForSession,
}));

vi.mock("@/lib/verify-incoming-call", () => ({
  verifyIncomingCall: harness.verifyIncomingCall,
}));
vi.mock("@/lib/incoming-call-authority", async () =>
  import("../../client/src/lib/incoming-call-authority"));
vi.mock("@/lib/call-signal-validation", async () =>
  import("../../client/src/lib/call-signal-validation"));

vi.mock("@/lib/app-load-time", () => ({ APP_LOAD_TIME: 0 }));
vi.mock("@/lib/startup-sweep", () => ({
  isStartupSweepComplete: harness.startupSweepComplete,
}));
vi.mock("@/lib/call-availability-version", () => ({
  acceptAvailabilityVersion: vi.fn(() => true),
}));
vi.mock("@/lib/call-availability-diagnostics", () => ({
  registerIncomingCallDiagnostic: vi.fn(),
  reportCallAvailabilityDiagnostic: vi.fn(),
}));
vi.mock("@/lib/call-session-id", () => ({
  getCallSessionTimestamp: vi.fn(() => null),
}));
vi.mock("@/lib/realtime-compat", () => ({
  createRealtimeCompatibilityPair: vi.fn((name: string) => {
    const pair = { name, handler: null as null | ((message: { payload: any }) => Promise<void>), removed: false };
    harness.pairs.push(pair);
    return pair;
  }),
  onCompatibilityBroadcast: vi.fn((pair: any, _event: string, handler: (message: { payload: any }) => Promise<void>) => {
    pair.handler = handler;
  }),
  removeCompatibilityPair: vi.fn((pair: any) => {
    pair.removed = true;
  }),
  sendCompatibilityBroadcast: vi.fn(async () => "ok"),
  subscribeCompatibilityPair: vi.fn(),
}));

import {
  canApplyAnsweredSignal,
} from "../../client/src/lib/call-signal-validation";

function candidate(sessionId = testSessionId): IncomingCallCandidate {
  return {
    matchId: MATCH_ID,
    callSessionId: sessionId,
    callerId: CALLER_ID,
    calleeId: CALLEE_ID,
  };
}

function verification(overrides: Partial<IncomingCallVerification> = {}): IncomingCallVerification {
  return {
    valid: true,
    status: "ringing",
    ...candidate(),
    ageMs: 0,
    ...overrides,
  };
}

function callRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    user1Id: CALLER_ID,
    user2Id: CALLEE_ID,
    callSessionId: testSessionId,
    callInitiatorId: CALLER_ID,
    callAnswered: false,
    callCompleted: false,
    callStartedAt: "2025-06-01T12:00:00.000Z",
    ...overrides,
  };
}

function cacheKey(key: unknown[]) {
  return JSON.stringify(key);
}

function setCachedCall(row: any) {
  harness.cache.set(cacheKey(["/api/matches"]), [row]);
  harness.cache.set(cacheKey(["/api/matches", MATCH_ID]), row);
}

function getCachedListRow() {
  return harness.cache.get(cacheKey(["/api/matches"]))?.[0];
}

function mount(userId = CALLEE_ID) {
  harness.effect = null;
  harness.ref.current = "";
  useCallSignaling([MATCH_ID], userId);
  if (!harness.effect) throw new Error("useCallSignaling did not register an effect");
  const cleanup = harness.effect();
  if (typeof cleanup === "function") return cleanup;
  return () => {};
}

async function emit(payload: Record<string, unknown>) {
  const pair = harness.pairs[harness.pairs.length - 1];
  if (!pair?.handler) throw new Error("No call-signal compatibility handler is installed");
  return pair.handler({ payload });
}

function resetHarness() {
  testSessionId = `${SESSION_ID}-${++testCounter}`;
  harness.effect = null;
  harness.ref.current = "";
  harness.pairs = [];
  harness.cache.clear();
  harness.cancelled.clear();
  harness.startupCancelled.clear();
  harness.backendRow = null;
  harness.verifyIncomingCall.mockReset();
  harness.verifyIncomingCall.mockResolvedValue(verification());
  harness.apiRequest.mockReset();
  harness.apiRequest.mockImplementation(async () => ({
    json: async () => harness.backendRow,
  }));
  for (const spy of [
    harness.armCallSession,
    harness.disarmCallSession,
    harness.markSessionAsVideo,
    harness.stopIncomingRingtoneForSession,
    harness.stopCallSoundsForSession,
    harness.markCallSessionCancelled,
    harness.markStartupCancelledSession,
    harness.clearStartupCancelledSession,
    harness.markSessionEndedForMatch,
    harness.callEndedHandler,
    harness.callRingHandler,
  ]) spy.mockClear();
  harness.isCallSessionCancelled.mockClear();
  harness.isStartupCancelledOnly.mockClear();
  harness.startupSweepComplete.mockReturnValue(true);
  setCallEndedHandler(harness.callEndedHandler);
  setCallRingHandler(harness.callRingHandler);
  clearDedupeForMatch(MATCH_ID);
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
  resetHarness();
  incomingCallAuthority.invalidate("test_isolation");
  incomingCallAuthority.setForeground(true);
  incomingCallAuthority.setIdentity(CALLEE_ID, "hook-auth-session");
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  incomingCallAuthority.invalidate("test_cleanup");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("incoming call signaling authority", () => {
  it("sends a genuine incoming ring through backend verification before arming", async () => {
    cleanup = mount();
    setCachedCall(callRow());

    await emit({ type: "call:ring", ...candidate(), callerName: "Caller" });

    expect(harness.verifyIncomingCall).toHaveBeenCalledWith(candidate());
    expect(harness.armCallSession).toHaveBeenCalledWith(testSessionId);
    expect(incomingCallAuthority.get(testSessionId, candidate())).not.toBeNull();
  });

  it("routes an accepted legacy compatibility ring through the same verifier", async () => {
    cleanup = mount();

    // The compatibility adapter delivers accepted public legacy events to the
    // same handler as private broadcasts; no legacy path gets a separate grant.
    await emit({ type: "call:ring", ...candidate(), callerName: "Legacy caller" });

    expect(harness.verifyIncomingCall).toHaveBeenCalledTimes(1);
    expect(harness.verifyIncomingCall).toHaveBeenCalledWith(candidate());
    expect(harness.armCallSession).toHaveBeenCalledWith(testSessionId);
  });

  it("coalesces duplicate private/legacy prompts into one verification and one authority record", async () => {
    cleanup = mount();
    let finish!: (result: IncomingCallVerification) => void;
    harness.verifyIncomingCall.mockImplementation(() => new Promise(resolve => {
      finish = resolve;
    }));
    const ring = { type: "call:ring", ...candidate(), callerName: "Caller" };

    const privatePrompt = emit(ring);
    const acceptedLegacyPrompt = emit(ring);
    expect(harness.verifyIncomingCall).toHaveBeenCalledTimes(1);
    finish(verification());
    await Promise.all([privatePrompt, acceptedLegacyPrompt]);

    expect(incomingCallAuthority.snapshot()).toHaveLength(1);
    expect(incomingCallAuthority.snapshot()[0].callSessionId).toBe(testSessionId);
  });

  it("does not arm when verification reports a different caller, recipient, match, or session", async () => {
    cleanup = mount();
    const badResults = [
      verification({ callerId: "other-caller" }),
      verification({ calleeId: "other-recipient" }),
      verification({ matchId: "other-match" }),
      verification({ callSessionId: "other-session" }),
    ];

    for (const result of badResults) {
      harness.verifyIncomingCall.mockResolvedValueOnce(result);
      await emit({ type: "call:ring", ...candidate(), callerName: "Caller" });
    }

    expect(harness.armCallSession).not.toHaveBeenCalled();
    expect(incomingCallAuthority.snapshot()).toEqual([]);
  });

  it("cannot arm a verification result after its subscription is disposed", async () => {
    cleanup = mount();
    let finish!: (result: IncomingCallVerification) => void;
    harness.verifyIncomingCall.mockImplementation(() => new Promise(resolve => {
      finish = resolve;
    }));

    const pendingRing = emit({ type: "call:ring", ...candidate(), callerName: "Caller" });
    cleanup();
    cleanup = null;
    finish(verification());
    await pendingRing;

    expect(harness.armCallSession).not.toHaveBeenCalled();
    expect(incomingCallAuthority.get(testSessionId)).toBeNull();
  });

  it("cannot re-arm a session terminated while verification is in flight", async () => {
    cleanup = mount();
    setCachedCall(callRow());
    let finish!: (result: IncomingCallVerification) => void;
    harness.verifyIncomingCall.mockImplementation(() => new Promise(resolve => {
      finish = resolve;
    }));

    const pendingRing = emit({ type: "call:ring", ...candidate(), callerName: "Caller" });
    await emit({ type: "call:ended", matchId: MATCH_ID, callSessionId: testSessionId, userId: CALLER_ID });
    finish(verification());
    await pendingRing;

    expect(harness.armCallSession).not.toHaveBeenCalled();
    expect(incomingCallAuthority.get(testSessionId)).toBeNull();
  });

  it("arms only the newest replacement session when an older verification resolves late", async () => {
    cleanup = mount();
    const replacementSession = "session-hook-replacement";
    let finishOld!: (result: IncomingCallVerification) => void;
    let finishNew!: (result: IncomingCallVerification) => void;
    harness.verifyIncomingCall.mockImplementation((value: IncomingCallCandidate) => new Promise(resolve => {
      if (value.callSessionId === testSessionId) finishOld = resolve;
      else finishNew = resolve;
    }));

    const oldRing = emit({ type: "call:ring", ...candidate(), callerName: "Caller" });
    const newRing = emit({ type: "call:ring", ...candidate(replacementSession), callerName: "Caller" });
    finishOld(verification());
    await oldRing;
    finishNew(verification({ callSessionId: replacementSession }));
    await newRing;

    expect(harness.armCallSession).toHaveBeenCalledTimes(1);
    expect(harness.armCallSession).toHaveBeenCalledWith(replacementSession);
    expect(incomingCallAuthority.get(testSessionId)).toBeNull();
    expect(incomingCallAuthority.get(replacementSession)).not.toBeNull();
  });

  it("keeps a verified incoming grant valid when subscription navigation cleans up", async () => {
    cleanup = mount();
    await emit({ type: "call:ring", ...candidate(), callerName: "Caller" });

    cleanup();
    cleanup = null;

    expect(incomingCallAuthority.get(testSessionId, candidate())).not.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["wrong-session", "another-session"],
  ])("ignores a %s call:answered event without changing the current call", async (_case, sessionId) => {
    cleanup = mount(CALLER_ID);
    const current = callRow({ callSessionId: testSessionId, callAnswered: false });
    setCachedCall(current);
    harness.backendRow = callRow({ callSessionId: testSessionId, callAnswered: true });

    await emit({
      type: "call:answered",
      matchId: MATCH_ID,
      userId: CALLEE_ID,
      ...(sessionId === undefined ? {} : { callSessionId: sessionId }),
    });

    expect(harness.armCallSession).not.toHaveBeenCalled();
    expect(getCachedListRow().callAnswered).toBe(false);
  });

  it("uses the backend's exact current answered row before applying call:answered", async () => {
    cleanup = mount(CALLER_ID);
    setCachedCall(callRow({ callAnswered: false }));
    harness.backendRow = callRow({ callAnswered: true });

    await emit({
      type: "call:answered",
      matchId: MATCH_ID,
      userId: CALLEE_ID,
      callSessionId: testSessionId,
    });

    expect(harness.apiRequest).toHaveBeenCalledWith(
      "GET",
      `/api/matches/${encodeURIComponent(MATCH_ID)}`,
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.armCallSession).toHaveBeenCalledWith(testSessionId);
    expect(getCachedListRow().callAnswered).toBe(true);
  });

  it("rejects call:answered when the backend's current row has another session", async () => {
    cleanup = mount(CALLER_ID);
    setCachedCall(callRow({ callAnswered: false }));
    harness.backendRow = callRow({ callSessionId: "backend-current-session", callAnswered: true });

    await emit({
      type: "call:answered",
      matchId: MATCH_ID,
      userId: CALLEE_ID,
      callSessionId: testSessionId,
    });

    expect(harness.apiRequest).toHaveBeenCalled();
    expect(harness.armCallSession).not.toHaveBeenCalled();
    expect(getCachedListRow().callAnswered).toBe(false);
  });

  it("deduplicates repeated terminal notifications for one call session", async () => {
    cleanup = mount();
    setCachedCall(callRow());

    const ended = {
      type: "call:ended",
      matchId: MATCH_ID,
      callSessionId: testSessionId,
      userId: CALLER_ID,
    };
    await emit(ended);
    await emit(ended);

    expect(harness.callEndedHandler).toHaveBeenCalledTimes(1);
    expect(getCachedListRow().callSessionId).toBeNull();
  });

  it("validates answered events against exact match, session, participants, and live backend state", () => {
    const row = callRow({ callAnswered: true });
    const event = { matchId: MATCH_ID, callSessionId: testSessionId, userId: CALLEE_ID };

    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, event, row)).toBe(true);
    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, { ...event, callSessionId: "stale" }, row)).toBe(false);
    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, { ...event, matchId: "other" }, row)).toBe(false);
    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, { ...event, userId: "stranger" }, row)).toBe(false);
    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, { ...event, callSessionId: undefined }, row)).toBe(false);
    expect(canApplyAnsweredSignal(MATCH_ID, CALLER_ID, event, { ...row, callCompleted: true })).toBe(false);
  });
});