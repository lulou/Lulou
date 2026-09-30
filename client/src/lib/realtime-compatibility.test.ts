import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRealtimeCapabilityHeaders,
  getRealtimeCompatibilityEvidence,
  notePrivateSessionJoined,
  setPrivateSessionChannel,
} from "./realtime-compatibility";
import type { RealtimeChannel } from "@supabase/supabase-js";

describe("private Realtime build evidence", () => {
  beforeEach(() => {
    vi.stubGlobal("__COMMIT_HASH__", "abc1234");
    setPrivateSessionChannel(null);
  });

  it("does not attest a cached build or an unjoined/public channel", () => {
    const channel = { state: "joining", params: { config: { private: true } } } as RealtimeChannel;
    setPrivateSessionChannel(channel);
    expect(getRealtimeCapabilityHeaders()).toEqual({});
    expect(getRealtimeCompatibilityEvidence().privateSessionJoined).toBe(false);

    (channel as any).state = "joined";
    (channel as any).params.config.private = false;
    expect(getRealtimeCapabilityHeaders()).toEqual({});
  });

  it("attests only the executing bundle with a live private join", () => {
    const channel = { state: "joined", params: { config: { private: true } } } as RealtimeChannel;
    setPrivateSessionChannel(channel);
    notePrivateSessionJoined(channel);
    expect(getRealtimeCapabilityHeaders()).toEqual({
      "X-Lulou-Realtime-Capability": "private-v1",
      "X-Lulou-Bundle-Commit": "abc1234",
    });
    expect(getRealtimeCompatibilityEvidence().lastPrivateJoinAt).toEqual(expect.any(Number));

    (channel as any).state = "errored";
    expect(getRealtimeCapabilityHeaders()).toEqual({});
    setPrivateSessionChannel(null);
    expect(getRealtimeCompatibilityEvidence().privateSessionJoined).toBe(false);
  });
});