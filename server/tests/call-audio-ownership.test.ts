import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AudioBehavior = (audio: FakeAudio) => Promise<void>;

class FakeAudio {
  static instances: FakeAudio[] = [];
  static behavior: AudioBehavior = () => Promise.resolve();

  loop = false;
  volume = 1;
  muted = false;
  paused = true;
  currentTime = 0;
  playCalls = 0;
  src: string;

  constructor(src = "") {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    return FakeAudio.behavior(this);
  }

  pause(): void {
    this.paused = true;
  }
}

const documentListeners = new Map<string, EventListener>();
const windowListeners = new Map<string, EventListener>();
let audio: typeof import("../../client/src/lib/call-audio");
let authority: typeof import("../../client/src/lib/incoming-call-authority");
let liveSessions: typeof import("../../client/src/lib/live-call-sessions");

function installFakeBrowser(): void {
  FakeAudio.instances = [];
  FakeAudio.behavior = () => Promise.resolve();
  documentListeners.clear();
  windowListeners.clear();
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: EventListener) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
  } as unknown as Document);
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: EventListener) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
  } as unknown as Window);
}

async function verifyIncoming(sessionId: string, matchId = `match-${sessionId}`): Promise<void> {
  const result = await authority.incomingCallAuthority.verify({
    matchId,
    callSessionId: sessionId,
    callerId: "caller",
    calleeId: "callee",
  }, async candidate => ({
    valid: true,
    status: "ringing",
    matchId: candidate.matchId,
    callSessionId: candidate.callSessionId,
    callerId: candidate.callerId,
    calleeId: candidate.calleeId,
    ageMs: 0,
  }));
  expect(result).not.toBeNull();
}

function ringtoneElement(): FakeAudio {
  const element = FakeAudio.instances.find(item => item.volume === 1);
  if (!element) throw new Error("Expected an incoming ringtone Audio element");
  return element;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  installFakeBrowser();
  authority = await import("../../client/src/lib/incoming-call-authority");
  audio = await import("../../client/src/lib/call-audio");
  liveSessions = await import("../../client/src/lib/live-call-sessions");
  const startupSweep = await import("../../client/src/lib/startup-sweep");
  startupSweep.markStartupSweepComplete();
  vi.advanceTimersByTime(5_001);
  authority.incomingCallAuthority.setIdentity("callee", "auth-generation-1");
  audio.registerCallAudioUnlock();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.resetModules();
});

describe("session-owned call audio", () => {
  it("does not let an armed session ring without a verified incoming grant", () => {
    liveSessions.armCallSession("unverified");

    audio.startIncomingRingtone("unverified");

    expect(audio.getCallAudioAuditSnapshot().ringtoneActive).toBe(false);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("revokes the exact incoming sound without depending on UI ring state", async () => {
    await verifyIncoming("terminal-session");
    audio.startIncomingRingtone("terminal-session");
    const ringtone = ringtoneElement();
    expect(ringtone.paused).toBe(false);

    authority.incomingCallAuthority.terminal("match-terminal-session", "terminal-session", "declined");

    expect(ringtone.paused).toBe(true);
    expect(audio.getCallAudioAuditSnapshot().ringtoneActive).toBe(false);
  });

  it("does not unmute or retry after a grant expires while play() is unresolved", async () => {
    await verifyIncoming("warm-race");
    let resolvePlay!: () => void;
    FakeAudio.behavior = element => element.volume === 1
      ? new Promise<void>(resolve => { resolvePlay = resolve; })
      : Promise.resolve();

    audio.startIncomingRingtone("warm-race");
    const ringtone = ringtoneElement();
    expect(ringtone.playCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(ringtone.paused).toBe(true);
    resolvePlay();
    await flushPromises();

    expect(ringtone.paused).toBe(true);
    expect(ringtone.playCalls).toBe(1);
    expect(audio.getCallAudioAuditSnapshot().ringtoneActive).toBe(false);

    ringtone.muted = true;
    documentListeners.get("touchstart")?.(new Event("touchstart"));
    await flushPromises();
    expect(ringtone.paused).toBe(true);
    expect(ringtone.muted).toBe(true);
    expect(ringtone.playCalls).toBe(1);
  });

  it("rejects a candidate for another callee and never starts that caller's incoming tone", async () => {
    const grant = await authority.incomingCallAuthority.verify({
      matchId: "wrong-recipient-match",
      callSessionId: "wrong-recipient",
      callerId: "caller",
      calleeId: "someone-else",
    }, async candidate => ({
      valid: true,
      status: "ringing",
      matchId: candidate.matchId,
      callSessionId: candidate.callSessionId,
      callerId: candidate.callerId,
      calleeId: candidate.calleeId,
      ageMs: 0,
    }));

    expect(grant).toBeNull();
    audio.startIncomingRingtone("wrong-recipient");
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("revoking one session never pauses a different call's owned ringback", async () => {
    await verifyIncoming("callee-session");
    liveSessions.armCallSession("caller-session");
    audio.startIncomingRingtone("callee-session");
    audio.startOutgoingRingback("caller-session");
    audio.startIncomingRingtone("caller-session");
    audio.startOutgoingRingback("callee-session");
    const ringtone = ringtoneElement();
    const ringback = FakeAudio.instances.find(item => item.volume === 0.85)!;
    expect(FakeAudio.instances).toHaveLength(2);
    expect(ringback.paused).toBe(false);
    expect(ringtone.paused).toBe(false);

    authority.incomingCallAuthority.terminal("match-callee-session", "callee-session", "declined");
    expect(ringtone.paused).toBe(true);
    expect(ringback.paused).toBe(false);
    audio.stopCallSoundsForSession("unrelated-session", "unrelated_terminal");

    expect(ringback.paused).toBe(false);
    expect(audio.getCallAudioAuditSnapshot().ringbackActive).toBe(true);
  });

  it("keeps one 500ms retry owner and defers teardown across an immediate remount", async () => {
    await verifyIncoming("hook-session");
    let playCount = 0;
    FakeAudio.behavior = element => {
      if (element.volume !== 1) return Promise.resolve();
      playCount++;
      if (playCount === 1) {
        element.paused = true;
        return Promise.reject(new Error("autoplay blocked"));
      }
      return Promise.resolve();
    };

    const effects: Array<() => void | (() => void)> = [];
    vi.doMock("react", () => ({
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    }));
    const hook = await import("../../client/src/hooks/use-call-ringtone");

    hook.useCallRingtone("incoming", true, "hook-session");
    hook.useCallRingtone("incoming", true, "hook-session");
    const cleanups = effects.map(effect => effect()).filter((cleanup): cleanup is () => void => !!cleanup);
    expect(playCount).toBe(1);
    const timerCountWithOneOwner = vi.getTimerCount();
    expect(timerCountWithOneOwner).toBe(2); // one authority expiry + one retry interval

    await vi.advanceTimersByTimeAsync(500);
    expect(playCount).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(playCount).toBe(2);

    cleanups.forEach(cleanup => cleanup());
    effects.length = 0;
    hook.useCallRingtone("incoming", true, "hook-session");
    const remountCleanup = effects[0]();
    vi.runAllTicks();
    await flushPromises();
    expect(ringtoneElement().paused).toBe(false);
    expect(vi.getTimerCount()).toBe(timerCountWithOneOwner);

    remountCleanup?.();
    vi.runAllTicks();
    await flushPromises();
    expect(ringtoneElement().paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1); // the verified grant's independent expiry remains
  });
});