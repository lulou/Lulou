import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const channels: any[] = [];
  const makeClient = () => {
    const clientChannels: any[] = [];
    return {
      channel: vi.fn((topic: string, options: any) => {
        const channel = {
          topic,
          subTopic: topic,
          params: options,
          state: "closed",
          on: vi.fn(function (this: any, _type: string, _filter: any, callback: (message: any) => void) {
            this.listeners ??= new Map();
            this.listeners.set(_filter.event, callback);
            return this;
          }),
          subscribe: vi.fn(function (this: any, callback?: (status: string) => void) {
            this.state = "joined";
            callback?.("SUBSCRIBED");
            return this;
          }),
          send: vi.fn().mockResolvedValue("ok"),
        };
        channels.push(channel);
        clientChannels.push(channel);
        return channel;
      }),
      getChannels: vi.fn(() => clientChannels),
      removeChannel: vi.fn(async (channel: any) => {
        const index = clientChannels.indexOf(channel);
        if (index >= 0) clientChannels.splice(index, 1);
        return "ok";
      }),
    };
  };
  return { channels, supabase: makeClient(), publicSupabase: makeClient() };
});

const callSignalingSource = readFileSync("client/src/hooks/use-call-signaling.ts", "utf8");
const webRtcSource = readFileSync("client/src/hooks/use-webrtc.ts", "utf8");
const realtimeMessagesSource = readFileSync("client/src/hooks/use-realtime-messages.ts", "utf8");
const typingSource = readFileSync("client/src/hooks/use-typing-indicator.ts", "utf8");

vi.mock("./supabase", () => ({
  supabase: mocks.supabase,
  supabasePublicRealtime: mocks.publicSupabase,
}));

import {
  BRIDGE_DUAL_PUBLIC_MARKER,
  PRIVATE_CLIENT_PUBLIC_MARKER,
  createRealtimeCompatibilityPair as createRawPair,
  onCompatibilityBroadcast,
  removeCompatibilityPair,
  sendCompatibilityBroadcast,
  subscribeCompatibilityPair,
  type RealtimeCompatibilityPair,
} from "./realtime-compat";

let activePairs: RealtimeCompatibilityPair[] = [];
const createRealtimeCompatibilityPair = (...args: Parameters<typeof createRawPair>) => {
  const pair = createRawPair(...args);
  activePairs.push(pair);
  return pair;
};

describe("Realtime public/private compatibility", () => {
  beforeEach(() => {
    activePairs = [];
    mocks.channels.length = 0;
    mocks.supabase.getChannels().length = 0;
    mocks.publicSupabase.getChannels().length = 0;
    mocks.supabase.channel.mockClear();
    mocks.publicSupabase.channel.mockClear();
    mocks.supabase.removeChannel.mockClear();
    mocks.publicSupabase.removeChannel.mockClear();
  });

  afterEach(async () => {
    for (const pair of activePairs) removeCompatibilityPair(pair);
    activePairs = [];
    await Promise.resolve();
    await Promise.resolve();
  });

  it("creates same-topic private and public channels with the requested broadcast config", () => {
    const pair = createRealtimeCompatibilityPair("call:match-1:session-1", { self: false });

    expect(pair.privateChannel.topic).toBe(pair.publicChannel.topic);
    expect(pair.privateChannel.params.config).toEqual({ private: true, broadcast: { self: false } });
    expect(pair.publicChannel.params.config).toEqual({ private: false, broadcast: { self: false } });

    subscribeCompatibilityPair(pair);
    const privateChannel = mocks.channels.find((channel) => channel.topic === pair.privateChannel.topic && channel.params.config.private);
    const publicChannel = mocks.channels.find((channel) => channel.topic === pair.publicChannel.topic && !channel.params.config.private);
    expect(privateChannel.subscribe).toHaveBeenCalledOnce();
    expect(publicChannel.subscribe).toHaveBeenCalledOnce();
  });

  it("processes unmarked legacy public events and filters both dual-publish markers", () => {
    const pair = createRealtimeCompatibilityPair("typing-match-1");
    const received: any[] = [];
    onCompatibilityBroadcast(pair, "typing", (message) => received.push(message.payload));

    (pair.privateChannel as any).listeners.get("typing")({ payload: { userId: "private-user" } });
    (pair.publicChannel as any).listeners.get("typing")({ payload: { userId: "old-user" } });
    (pair.publicChannel as any).listeners.get("typing")({
      payload: { userId: "new-user", [PRIVATE_CLIENT_PUBLIC_MARKER]: true },
    });
    (pair.publicChannel as any).listeners.get("typing")({
      payload: { userId: "bridge", [BRIDGE_DUAL_PUBLIC_MARKER]: true },
    });

    expect(received).toEqual([{ userId: "private-user" }, { userId: "old-user" }]);
  });

  it("sends original payload privately and a marked compatibility copy publicly", async () => {
    const pair = createRealtimeCompatibilityPair("call:match-1:session-1", { self: false });
    pair.publicChannel.state = "joined";
    const offer = { type: "webrtc:offer", from: "user-1", callSessionId: "session-1", sdp: "offer-sdp" };

    await expect(sendCompatibilityBroadcast(pair, "signal", offer)).resolves.toBe("ok");
    await Promise.resolve();

    const privateChannel = mocks.channels.find((channel) => channel.topic === pair.privateChannel.topic && channel.params.config.private);
    const publicChannel = mocks.channels.find((channel) => channel.topic === pair.publicChannel.topic && !channel.params.config.private);
    expect(privateChannel.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "signal",
      payload: offer,
    });
    expect(publicChannel.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "signal",
      payload: { ...offer, [PRIVATE_CLIENT_PUBLIC_MARKER]: true },
    });
    expect(offer).not.toHaveProperty(PRIVATE_CLIENT_PUBLIC_MARKER);
  });

  it("queues a public compatibility copy until the public join is ready", async () => {
    const pair = createRealtimeCompatibilityPair("typing-match-1", { self: false });
    subscribeCompatibilityPair(pair);
    pair.publicChannel.state = "joining";

    await expect(sendCompatibilityBroadcast(pair, "typing", { userId: "user-1" })).resolves.toBe("ok");
    const publicChannel = mocks.channels.find((channel) => channel.topic === pair.publicChannel.topic && !channel.params.config.private);
    expect(publicChannel.send).not.toHaveBeenCalled();

    pair.publicChannel.state = "joined";
    (publicChannel.subscribe.mock.calls[0][0] as (status: string) => void)("SUBSCRIBED");
    await Promise.resolve();

    expect(publicChannel.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "typing",
      payload: { userId: "user-1", [PRIVATE_CLIENT_PUBLIC_MARKER]: true },
    });
  });

  it("keeps private sends authoritative when the optional public channel is unavailable", async () => {
    const pair = createRealtimeCompatibilityPair("call-signal:match-1");
    pair.publicChannel.state = "errored";
    const privateChannel = mocks.channels.find((channel) => channel.topic === pair.privateChannel.topic && channel.params.config.private);
    (privateChannel.send as ReturnType<typeof vi.fn>).mockResolvedValue("ok");

    await expect(sendCompatibilityBroadcast(pair, "call-signal", {
      type: "call:ring",
      callSessionId: "session-1",
    })).resolves.toBe("ok");

    const publicChannel = mocks.channels.find((channel) => channel.topic === pair.publicChannel.topic && !channel.params.config.private);
    expect(privateChannel.send).toHaveBeenCalledOnce();
    expect(publicChannel.send).not.toHaveBeenCalled();
  });

  it("removes both topic generations on cleanup", () => {
    const pair = createRealtimeCompatibilityPair("chat:match-1");
    removeCompatibilityPair(pair);

    expect(mocks.supabase.removeChannel).toHaveBeenCalledTimes(1);
    expect(mocks.publicSupabase.removeChannel).toHaveBeenCalledTimes(1);
    const privateChannel = mocks.channels.find((channel) => channel.topic === pair.privateChannel.topic && channel.params.config.private);
    const publicChannel = mocks.channels.find((channel) => channel.topic === pair.publicChannel.topic && !channel.params.config.private);
    expect(mocks.supabase.removeChannel).toHaveBeenCalledWith(privateChannel);
    expect(mocks.publicSupabase.removeChannel).toHaveBeenCalledWith(publicChannel);
  });

  it("shares same-topic channel leases, preserves chat self echoes, and releases only after the last consumer", () => {
    const first = createRealtimeCompatibilityPair("chat:shared-lease-test");
    const firstListener = vi.fn();
    const directFirstListener = vi.fn();
    onCompatibilityBroadcast(first, "new-message", firstListener);
    first.privateChannel.on("broadcast", { event: "lease-local" }, directFirstListener);
    const firstPrivateStatus = vi.fn();
    subscribeCompatibilityPair(first, firstPrivateStatus);

    const second = createRealtimeCompatibilityPair("chat:shared-lease-test", { self: true });
    const secondListener = vi.fn();
    const secondPrivateStatus = vi.fn();
    const secondPublicStatus = vi.fn();
    onCompatibilityBroadcast(second, "new-message", secondListener);
    subscribeCompatibilityPair(second, secondPrivateStatus, secondPublicStatus);

    expect(second.privateChannel.topic).toBe(first.privateChannel.topic);
    expect(second.publicChannel.topic).toBe(first.publicChannel.topic);
    expect(first.privateChannel.params.config.broadcast.self).toBe(true);
    const privateChannel = mocks.channels.find((channel) => channel.topic === first.privateChannel.topic && channel.params.config.private);
    const publicChannel = mocks.channels.find((channel) => channel.topic === first.publicChannel.topic && !channel.params.config.private);
    expect(privateChannel.subscribe).toHaveBeenCalledOnce();
    expect(publicChannel.subscribe).toHaveBeenCalledOnce();
    expect(secondPrivateStatus).toHaveBeenCalledWith("SUBSCRIBED");
    expect(secondPublicStatus).toHaveBeenCalledWith("SUBSCRIBED");

    privateChannel.listeners.get("new-message")({ payload: { messageId: "m1" } });
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();

    removeCompatibilityPair(first);
    expect(mocks.supabase.removeChannel).not.toHaveBeenCalled();
    expect(mocks.publicSupabase.removeChannel).not.toHaveBeenCalled();
    privateChannel.listeners.get("new-message")({ payload: { messageId: "m2" } });
    privateChannel.listeners.get("lease-local")({ payload: { source: "released-lease" } });
    expect(firstListener).toHaveBeenCalledOnce();
    expect(directFirstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledTimes(2);

    removeCompatibilityPair(second);
    expect(mocks.supabase.removeChannel).toHaveBeenCalledOnce();
    expect(mocks.publicSupabase.removeChannel).toHaveBeenCalledOnce();
  });

  it("keeps private and public channels distinct even for identical topics", () => {
    const pair = createRealtimeCompatibilityPair("call:transport-isolation-test");
    expect(pair.privateChannel.topic).toBe(pair.publicChannel.topic);
    expect(pair.privateChannel.params.config.private).toBe(true);
    expect(pair.publicChannel.params.config.private).toBe(false);
    expect(mocks.channels.filter((channel) => channel.topic === pair.privateChannel.topic)).toHaveLength(2);
    removeCompatibilityPair(pair);
  });

  it("routes every client-origin send in the affected hooks through the dual-send helper", () => {
    for (const source of [
      callSignalingSource,
      webRtcSource,
      realtimeMessagesSource,
      typingSource,
    ]) {
      expect(source).toContain("sendCompatibilityBroadcast");
      expect(source).not.toMatch(/\.\s*send\s*\(/);
    }
  });

  it("keeps every legacy-relevant handler on a private/public compatibility listener", () => {
    expect(callSignalingSource).toContain('onCompatibilityBroadcast(channels, "call-signal"');
    expect(webRtcSource).toContain('onCompatibilityBroadcast(pair, "signal"');
    expect(webRtcSource).toContain('onCompatibilityBroadcast(compatibilityPair, "signal"');
    expect(typingSource).toContain('onCompatibilityBroadcast(channels, "typing"');

    for (const event of [
      "new-message",
      "date-choice",
      "number-exchange",
      "voice-note-unlock",
      "voice-note-post-call-unlock",
      "first-call-unlock",
    ]) {
      expect(realtimeMessagesSource).toContain(`onCompatibilityBroadcast(broadcastChannels, "${event}"`);
    }
    expect(realtimeMessagesSource).toContain('privateChannel.on("broadcast", { event: "meet-availability" }');
    expect(realtimeMessagesSource).toContain('onCompatibilityPublicBroadcast(broadcastChannels, "meet-availability"');
  });
});