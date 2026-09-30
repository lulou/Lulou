import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getRealtimeCapabilityHeaders,
  getRealtimeCompatibilityEvidence,
  notePrivateSessionStatus,
  setPrivateSessionChannel,
} from "./realtime-compatibility";
import { PrivateRealtimeDiagnosticCard } from "../components/private-realtime-diagnostic";
import type { RealtimeChannel } from "@supabase/supabase-js";

describe("private Realtime build evidence", () => {
  const userId = "a1b2c3d4-1111-2222-3333-444455556666";
  const makeChannel = (state = "joining", isPrivate = true) => ({
    topic: `realtime:private-session:${userId}`,
    state,
    params: { config: { private: isPrivate } },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }) as unknown as RealtimeChannel;
  const renderCard = (connected = true, id = userId) =>
    renderToStaticMarkup(createElement(PrivateRealtimeDiagnosticCard, {
      evidence: getRealtimeCompatibilityEvidence(id),
      websocketConnected: connected,
    }));

  beforeEach(() => {
    vi.stubGlobal("__COMMIT_HASH__", "abc1234");
    setPrivateSessionChannel(null);
  });

  it("never displays JOINED before the real subscription callback reports SUBSCRIBED", () => {
    const channel = makeChannel();
    setPrivateSessionChannel(channel, true);
    expect(getRealtimeCapabilityHeaders()).toEqual({});
    expect(getRealtimeCompatibilityEvidence().privateSessionJoined).toBe(false);
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");

    // Even a misleading mutable channel.state cannot establish a subscription.
    (channel as any).state = "joined";
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
    notePrivateSessionStatus(channel, "SUBSCRIBED");
    expect(renderCard()).toContain("PRIVATE REALTIME: JOINED");
    expect(renderCard()).toContain("abc1234");
    expect(renderCard()).not.toContain(userId);
  });

  it("does not attest a public, wrong-user, errored, or disconnected channel", () => {
    const channel = makeChannel("joined");
    setPrivateSessionChannel(channel, true);
    notePrivateSessionStatus(channel, "SUBSCRIBED");
    expect(renderCard(false)).toContain("PRIVATE REALTIME: NOT JOINED");
    expect(renderCard(true, "other-user-id")).toContain("PRIVATE REALTIME: NOT JOINED");

    (channel as any).params.config.private = false;
    expect(getRealtimeCapabilityHeaders()).toEqual({});
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
    (channel as any).params.config.private = true;
    notePrivateSessionStatus(channel, "CHANNEL_ERROR");
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
    expect(getRealtimeCompatibilityEvidence().privateSessionStatus).toBe("CHANNEL_ERROR");
    notePrivateSessionStatus(channel, "TIMED_OUT");
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
  });

  it("attests only the executing bundle with the existing private subscription", () => {
    const channel = makeChannel("joined");
    setPrivateSessionChannel(channel, true);
    notePrivateSessionStatus(channel, "SUBSCRIBED");
    expect(getRealtimeCapabilityHeaders()).toEqual({
      "X-Lulou-Realtime-Capability": "private-v1",
      "X-Lulou-Bundle-Commit": "abc1234",
    });
    expect(getRealtimeCompatibilityEvidence().lastPrivateJoinAt).toEqual(expect.any(Number));

    (channel as any).state = "errored";
    expect(getRealtimeCapabilityHeaders()).toEqual({});
    setPrivateSessionChannel(null);
    expect(getRealtimeCompatibilityEvidence().privateSessionJoined).toBe(false);
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
  });

  it("updates on teardown/reconnect and ignores stale callbacks without adding a channel", () => {
    const old = makeChannel("joined");
    setPrivateSessionChannel(old, true);
    notePrivateSessionStatus(old, "SUBSCRIBED");
    expect(renderCard()).toContain("PRIVATE REALTIME: JOINED");
    setPrivateSessionChannel(null);
    expect(getRealtimeCompatibilityEvidence(userId).privateSessionStatus).toBe("CLOSED");
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");

    const next = makeChannel("joining");
    setPrivateSessionChannel(next, true);
    notePrivateSessionStatus(old, "SUBSCRIBED");
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
    (next as any).state = "joined";
    notePrivateSessionStatus(next, "SUBSCRIBED");
    expect(renderCard()).toContain("PRIVATE REALTIME: JOINED");
    expect((old as any).subscribe).not.toHaveBeenCalled();
    expect((next as any).subscribe).not.toHaveBeenCalled();
    expect((old as any).unsubscribe).not.toHaveBeenCalled();
    expect((next as any).unsubscribe).not.toHaveBeenCalled();
  });

  it("tracks the last real status change time without treating an unauthed channel as joined", () => {
    const channel = makeChannel("joined");
    let time = 1000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => time);
    setPrivateSessionChannel(channel);
    time = 2000;
    notePrivateSessionStatus(channel, "SUBSCRIBED");
    expect(getRealtimeCompatibilityEvidence(userId).lastPrivateStatusChangeAt).toBe(2000);
    expect(renderCard()).toContain("PRIVATE REALTIME: NOT JOINED");
    time = 3000;
    notePrivateSessionStatus(channel, "CLOSED");
    expect(getRealtimeCompatibilityEvidence(userId).lastPrivateStatusChangeAt).toBe(3000);
    now.mockRestore();
  });
});