import { afterEach, describe, expect, it, vi } from "vitest";

let topicCounter = 0;
const activeSpies: Array<{ mockRestore: () => void }> = [];

// The actual installed Realtime SDK requires a WebSocket constructor at client
// creation time. This stub is never instantiated: test subscriptions are
// intercepted below, so the test exercises SDK channel identity without I/O.
vi.stubGlobal("WebSocket", class TestWebSocket {});

const { supabase, supabasePublicRealtime } = await import("./supabase");
const {
  createRealtimeCompatibilityPair,
  onCompatibilityBroadcast,
  removeCompatibilityPair,
  sendCompatibilityBroadcast,
  subscribeCompatibilityPair,
} = await import("./realtime-compat");

afterEach(() => {
  for (const spy of activeSpies.splice(0)) spy.mockRestore();
});

describe("Realtime SDK channel identity and compatibility leases", () => {
  it("uses distinct private/public SDK channels and shares a same-topic join until the final lease", () => {
    const topic = `sdk-compat-no-network-${++topicCounter}`;
    const first = createRealtimeCompatibilityPair(topic);
    const privateChannel = supabase.getChannels().find((channel) => channel.subTopic === topic)!;
    const publicChannel = supabasePublicRealtime.getChannels().find((channel) => channel.subTopic === topic)!;

    expect(privateChannel).not.toBe(publicChannel);
    expect(first.privateChannel).not.toBe(privateChannel);
    expect(privateChannel.params.config.private).toBe(true);
    expect(publicChannel.params.config.private).toBe(false);
    expect(supabase.getChannels()).toContain(privateChannel);
    expect(supabasePublicRealtime.getChannels()).toContain(publicChannel);

    const privateSubscribe = vi.spyOn(privateChannel, "subscribe").mockImplementation(((callback?: (status: any) => void) => {
      privateChannel.state = "joined";
      callback?.("SUBSCRIBED");
      return privateChannel;
    }) as any);
    const publicSubscribe = vi.spyOn(publicChannel, "subscribe").mockImplementation(((callback?: (status: any) => void) => {
      publicChannel.state = "joined";
      callback?.("SUBSCRIBED");
      return publicChannel;
    }) as any);
    const privateRemove = vi.spyOn(supabase, "removeChannel").mockResolvedValue("ok" as any);
    const publicRemove = vi.spyOn(supabasePublicRealtime, "removeChannel").mockResolvedValue("ok" as any);
    activeSpies.push(privateSubscribe, publicSubscribe, privateRemove, publicRemove);

    subscribeCompatibilityPair(first);
    const second = createRealtimeCompatibilityPair(topic);
    expect(second.privateChannel).not.toBe(first.privateChannel);
    expect(supabase.getChannels().filter((channel) => channel.subTopic === topic)).toEqual([privateChannel]);
    expect(supabasePublicRealtime.getChannels().filter((channel) => channel.subTopic === topic)).toEqual([publicChannel]);

    const latePrivateStatus = vi.fn();
    const latePublicStatus = vi.fn();
    subscribeCompatibilityPair(second, latePrivateStatus, latePublicStatus);
    expect(privateSubscribe).toHaveBeenCalledOnce();
    expect(publicSubscribe).toHaveBeenCalledOnce();
    expect(latePrivateStatus).toHaveBeenCalledWith("SUBSCRIBED");
    expect(latePublicStatus).toHaveBeenCalledWith("SUBSCRIBED");

    removeCompatibilityPair(first);
    expect(privateRemove).not.toHaveBeenCalled();
    expect(publicRemove).not.toHaveBeenCalled();

    removeCompatibilityPair(second);
    expect(privateRemove).toHaveBeenCalledOnce();
    expect(publicRemove).toHaveBeenCalledOnce();
  });

  it("waits for deferred SDK teardown before reacquiring, then delivers queued work on fresh channels", async () => {
    const topic = `sdk-compat-deferred-remove-${++topicCounter}`;
    const first = createRealtimeCompatibilityPair(topic);
    const oldPrivate = supabase.getChannels().find((channel) => channel.subTopic === topic)!;
    const oldPublic = supabasePublicRealtime.getChannels().find((channel) => channel.subTopic === topic)!;
    const privateOldSubscribe = vi.spyOn(oldPrivate, "subscribe").mockImplementation(((callback?: (status: any) => void) => {
      oldPrivate.state = "joined";
      callback?.("SUBSCRIBED");
      return oldPrivate;
    }) as any);
    const publicOldSubscribe = vi.spyOn(oldPublic, "subscribe").mockImplementation(((callback?: (status: any) => void) => {
      oldPublic.state = "joined";
      callback?.("SUBSCRIBED");
      return oldPublic;
    }) as any);
    const oldPrivateUnsubscribe = vi.spyOn(oldPrivate, "unsubscribe").mockResolvedValue("ok" as any);
    const oldPublicUnsubscribe = vi.spyOn(oldPublic, "unsubscribe").mockResolvedValue("ok" as any);
    activeSpies.push(privateOldSubscribe, publicOldSubscribe, oldPrivateUnsubscribe, oldPublicUnsubscribe);

    const realPrivateRemove = supabase.removeChannel.bind(supabase);
    const realPublicRemove = supabasePublicRealtime.removeChannel.bind(supabasePublicRealtime);
    const finishPrivateRemoval: Array<() => Promise<void>> = [];
    const finishPublicRemoval: Array<() => Promise<void>> = [];
    const privateRemove = vi.spyOn(supabase, "removeChannel").mockImplementation(((channel: any) =>
      new Promise<void>((resolve, reject) => {
        finishPrivateRemoval.push(async () => {
          try {
            channel.state = "closed";
            channel.channelAdapter.getChannel().trigger("phx_close");
            resolve(await realPrivateRemove(channel) as any);
          } catch (error) { reject(error); }
        });
      })) as any);
    const publicRemove = vi.spyOn(supabasePublicRealtime, "removeChannel").mockImplementation(((channel: any) =>
      new Promise<void>((resolve, reject) => {
        finishPublicRemoval.push(async () => {
          try {
            channel.state = "closed";
            channel.channelAdapter.getChannel().trigger("phx_close");
            resolve(await realPublicRemove(channel) as any);
          } catch (error) { reject(error); }
        });
      })) as any);
    activeSpies.push(privateRemove, publicRemove);

    subscribeCompatibilityPair(first);
    removeCompatibilityPair(first);
    expect(privateRemove).toHaveBeenCalledWith(oldPrivate);
    expect(publicRemove).toHaveBeenCalledWith(oldPublic);

    const second = createRealtimeCompatibilityPair(topic);
    const received = vi.fn();
    onCompatibilityBroadcast(second, "after-teardown", received);
    const privateStatus = vi.fn();
    const publicStatus = vi.fn();
    subscribeCompatibilityPair(second, privateStatus, publicStatus);
    const queuedSend = sendCompatibilityBroadcast(second, "during-teardown", { id: "queued" });

    expect(supabase.getChannels().filter((channel) => channel.subTopic === topic)).toEqual([oldPrivate]);
    expect(supabasePublicRealtime.getChannels().filter((channel) => channel.subTopic === topic)).toEqual([oldPublic]);
    expect(finishPrivateRemoval).toHaveLength(1);
    expect(finishPublicRemoval).toHaveLength(1);

    const privateCreated = supabase.channel.bind(supabase);
    const publicCreated = supabasePublicRealtime.channel.bind(supabasePublicRealtime);
    const freshPrivateChannels: any[] = [];
    const freshPublicChannels: any[] = [];
    const installNoNetworkChannel = (channel: any, list: any[]) => {
      const subscribe = vi.spyOn(channel, "subscribe").mockImplementation(((callback?: (status: any) => void) => {
        channel.state = "joined";
        callback?.("SUBSCRIBED");
        return channel;
      }) as any);
      const send = vi.spyOn(channel, "send").mockResolvedValue("ok" as any);
      const unsubscribe = vi.spyOn(channel, "unsubscribe").mockResolvedValue("ok" as any);
      activeSpies.push(subscribe, send, unsubscribe);
      list.push(channel);
    };
    const privateFactory = vi.spyOn(supabase, "channel").mockImplementation(((name: string, options: any) => {
      const channel = privateCreated(name, options);
      if (name === topic && channel !== oldPrivate) installNoNetworkChannel(channel, freshPrivateChannels);
      return channel;
    }) as any);
    const publicFactory = vi.spyOn(supabasePublicRealtime, "channel").mockImplementation(((name: string, options: any) => {
      const channel = publicCreated(name, options);
      if (name === topic && channel !== oldPublic) installNoNetworkChannel(channel, freshPublicChannels);
      return channel;
    }) as any);
    activeSpies.push(privateFactory, publicFactory);

    const finishInitialPrivateRemoval = finishPrivateRemoval.shift()!;
    const finishInitialPublicRemoval = finishPublicRemoval.shift()!;
    await Promise.all([finishInitialPrivateRemoval(), finishInitialPublicRemoval()]);
    await Promise.resolve();
    await Promise.resolve();

    expect(freshPrivateChannels).toHaveLength(1);
    expect(freshPublicChannels).toHaveLength(1);
    expect(freshPrivateChannels[0]).not.toBe(oldPrivate);
    expect(freshPublicChannels[0]).not.toBe(oldPublic);
    expect(privateStatus).toHaveBeenCalledWith("SUBSCRIBED", undefined);
    expect(publicStatus).toHaveBeenCalledWith("SUBSCRIBED", undefined);
    await expect(queuedSend).resolves.toBe("ok");
    expect(freshPublicChannels[0].send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "during-teardown",
      payload: { id: "queued", __lulouPrivateClient: true },
    });

    const emit = (channel: any, event: string, payload: unknown) => {
      const binding = channel.bindings.broadcast.find((item: any) => item.filter.event === event);
      binding.callback(payload);
    };
    emit(freshPrivateChannels[0], "after-teardown", { payload: { source: "private" } });
    emit(freshPublicChannels[0], "after-teardown", { payload: { source: "public" } });
    expect(received).toHaveBeenCalledTimes(2);

    removeCompatibilityPair(second);
    await Promise.all([finishPrivateRemoval.shift()?.(), finishPublicRemoval.shift()?.()]);
  });
});