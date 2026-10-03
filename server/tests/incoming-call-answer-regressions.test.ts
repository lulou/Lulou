import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

const harness = vi.hoisted(() => ({
  generation: 4,
  user: { id: "callee" } as { id: string } | null,
  sessionId: "auth-session-1",
  grant: null as any,
  armed: true,
  cancelled: false,
  listeners: new Set<(sessionId: string, reason: string) => void>(),
  mutations: [] as any[],
  apiRequest: vi.fn(),
  broadcast: vi.fn(),
  sendReady: vi.fn(),
  cleanupCallAudio: vi.fn(),
  markCancelled: vi.fn(),
  setQueriesData: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => [initial, vi.fn()],
  };
});
vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));
vi.mock("@/components/ui/avatar", () => ({ Avatar: () => null, AvatarImage: () => null, AvatarFallback: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => {
    harness.mutations.push(options);
    return { isPending: false, mutate: vi.fn() };
  },
  useQueryClient: () => ({
    setQueriesData: harness.setQueriesData,
    invalidateQueries: harness.invalidateQueries,
  }),
}));
vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: harness.user }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/hooks/use-call-signaling", () => ({ broadcastCallSignal: harness.broadcast }));
vi.mock("@/hooks/use-webrtc", () => ({
  calleePresubscribe: vi.fn(() => vi.fn()),
  calleePresubSendReady: harness.sendReady,
}));
vi.mock("@/hooks/use-call-ringtone", () => ({ useCallRingtone: vi.fn() }));
vi.mock("@/lib/call-audio", () => ({
  cleanupCallAudio: harness.cleanupCallAudio,
  isAudioUnlocked: () => true,
  onAudioUnlocked: vi.fn(() => vi.fn()),
  unlockAudioNow: vi.fn(),
}));
vi.mock("@/lib/cancelled-calls", () => ({
  isCallSessionCancelled: () => harness.cancelled,
  markCallSessionCancelled: harness.markCancelled,
}));
vi.mock("@/lib/live-call-sessions", () => ({ isArmedSession: () => harness.armed }));
vi.mock("@/lib/incoming-call-authority", () => ({
  incomingCallAuthority: {
    getGeneration: () => harness.generation,
    get: (sessionId: string, expected?: Record<string, unknown>) => {
      const grant = harness.grant;
      if (!grant || grant.callSessionId !== sessionId) return null;
      if (expected && Object.entries(expected).some(([key, value]) => grant[key] !== value)) return null;
      return grant;
    },
    subscribe: (listener: (sessionId: string, reason: string) => void) => {
      harness.listeners.add(listener);
      return () => harness.listeners.delete(listener);
    },
  },
}));
vi.mock("@/lib/call-availability-diagnostics", () => ({
  getIncomingCallDiagnosticId: () => "diagnostic-id",
  reportAnswerDiagnostic: vi.fn(),
  reportCallUiPaint: vi.fn(),
  reportIncomingCallMounted: vi.fn(),
}));

import IncomingCallOverlay from "../../client/src/components/incoming-call";

const candidate = {
  matchId: "match-1",
  callSessionId: "call-session-1",
  callerId: "caller",
  calleeId: "callee",
};

function answeredMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: candidate.matchId,
    callSessionId: candidate.callSessionId,
    callInitiatorId: candidate.callerId,
    callStartedAt: "2026-01-01T00:00:00.000Z",
    callCompleted: false,
    callAnswered: true,
    user1Id: candidate.callerId,
    user2Id: candidate.calleeId,
    ...overrides,
  };
}

function incomingMatch() {
  return {
    ...answeredMatch({ callAnswered: false }),
    profile: { firstName: "Caller", photos: [] },
  };
}

function response(data = answeredMatch()) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(data) };
}

function renderIncoming() {
  harness.mutations.length = 0;
  const onDismiss = vi.fn();
  const onAnswer = vi.fn();
  IncomingCallOverlay({
    match: incomingMatch() as any,
    isFaceCall: false,
    onDismiss,
    onAnswer,
  });
  return { answerOptions: harness.mutations[0], onDismiss, onAnswer };
}

function runRevocation(sessionId = candidate.callSessionId, reason = "answered") {
  for (const listener of [...harness.listeners]) listener(sessionId, reason);
}

describe("incoming call answer authority regressions", () => {
  beforeEach(() => {
  vi.stubGlobal("React", React);
    harness.generation = 4;
    harness.user = { id: candidate.calleeId };
    harness.sessionId = "auth-session-1";
    harness.grant = { ...candidate, generation: harness.generation, expiresAt: Date.now() + 60_000 };
    harness.armed = true;
    harness.cancelled = false;
    harness.listeners.clear();
    harness.mutations.length = 0;
    harness.apiRequest.mockReset().mockResolvedValue(response());
    harness.broadcast.mockClear();
    harness.sendReady.mockClear();
    harness.cleanupCallAudio.mockClear();
    harness.markCancelled.mockClear();
    harness.setQueriesData.mockClear();
    harness.invalidateQueries.mockClear();
    harness.toast.mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "lulou_session_id" ? harness.sessionId : null,
    });
    vi.stubGlobal("document", { body: { style: {} } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("answers normally while the exact verified grant remains live", async () => {
    const { answerOptions, onAnswer, onDismiss } = renderIncoming();
    const result = await answerOptions.mutationFn();

    expect(harness.apiRequest).toHaveBeenCalledWith(
      "POST",
      `/api/matches/${candidate.matchId}/call/answer`,
      { callSessionId: candidate.callSessionId, diagnosticId: "diagnostic-id" },
    );
    expect(result.status).toBe("accepted");
    answerOptions.onSuccess(result);

    expect(harness.broadcast).toHaveBeenCalledOnce();
    expect(harness.setQueriesData).toHaveBeenCalledTimes(2);
    expect(harness.sendReady).toHaveBeenCalledWith(candidate.matchId, candidate.callSessionId, candidate.calleeId);
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("silently ignores a response from an older auth generation after the same SID is re-armed", async () => {
    let resolveRequest!: (value: ReturnType<typeof response>) => void;
    harness.apiRequest.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    const { answerOptions, onAnswer, onDismiss } = renderIncoming();
    const pending = answerOptions.mutationFn();
    expect(harness.apiRequest).toHaveBeenCalledOnce();

    harness.generation++;
    harness.grant = { ...candidate, generation: harness.generation, expiresAt: Date.now() + 60_000 };
    resolveRequest(response());
    const result = await pending;
    answerOptions.onSuccess(result);

    expect(result.status).toBe("ignored");
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.setQueriesData).not.toHaveBeenCalled();
    expect(harness.sendReady).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(harness.markCancelled).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
    // The answer tap silences its old ring once; the stale response does not
    // perform any later cleanup against the re-armed session.
    expect(harness.cleanupCallAudio).toHaveBeenCalledTimes(1);
  });

  it("accepts the server answer when its exact grant was revoked as answered while pending", async () => {
    let resolveRequest!: (value: ReturnType<typeof response>) => void;
    harness.apiRequest.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    const { answerOptions, onAnswer, onDismiss } = renderIncoming();
    const pending = answerOptions.mutationFn();
    harness.grant = null;
    runRevocation(candidate.callSessionId, "answered");
    resolveRequest(response());
    const result = await pending;

    expect(result.status).toBe("accepted");
    answerOptions.onSuccess(result);
    expect(harness.broadcast).toHaveBeenCalledOnce();
    expect(harness.setQueriesData).toHaveBeenCalledTimes(2);
    expect(harness.sendReady).toHaveBeenCalledOnce();
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not POST without an exact grant for the intended caller and callee", async () => {
    harness.grant = { ...candidate, callerId: "different-caller", generation: harness.generation };
    const { answerOptions } = renderIncoming();

    const result = await answerOptions.mutationFn();

    expect(result.status).toBe("ignored");
    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.setQueriesData).not.toHaveBeenCalled();
  });

  it.each([
    ["match ID", { id: "different-match" }],
    ["session ID", { callSessionId: "different-session" }],
    ["caller", { callInitiatorId: "different-caller", user1Id: "different-caller" }],
    ["callee", { user2Id: "different-callee" }],
  ])("does not apply an answer response with a mismatched %s", async (_identity, overrides) => {
    harness.apiRequest.mockResolvedValue(response(answeredMatch(overrides)));
    const { answerOptions, onAnswer, onDismiss } = renderIncoming();

    const result = await answerOptions.mutationFn();
    answerOptions.onSuccess(result);

    expect(result.status).toBe("ignored");
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.setQueriesData).not.toHaveBeenCalled();
    expect(harness.sendReady).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("rejects mismatched answer identities and a changed authenticated session before success effects", async () => {
    harness.apiRequest.mockResolvedValue(response(answeredMatch({ user2Id: "different-callee" })));
    const first = renderIncoming();
    const mismatchResult = await first.answerOptions.mutationFn();
    first.answerOptions.onSuccess(mismatchResult);
    expect(mismatchResult.status).toBe("ignored");
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.setQueriesData).not.toHaveBeenCalled();

    harness.apiRequest.mockReset();
    let resolveRequest!: (value: ReturnType<typeof response>) => void;
    harness.apiRequest.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    const second = renderIncoming();
    const pending = second.answerOptions.mutationFn();
    harness.sessionId = "new-auth-session";
    resolveRequest(response());
    const changedSessionResult = await pending;
    second.answerOptions.onSuccess(changedSessionResult);

    expect(changedSessionResult.status).toBe("ignored");
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.setQueriesData).not.toHaveBeenCalled();
    expect(harness.sendReady).not.toHaveBeenCalled();
    expect(second.onAnswer).not.toHaveBeenCalled();
    expect(second.onDismiss).not.toHaveBeenCalled();
  });
});