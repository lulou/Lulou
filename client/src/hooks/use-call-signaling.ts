import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

type CallSignalEvent =
  | { type: "call:ring"; matchId: string; callerId: string; callerName: string }
  | { type: "call:answered"; matchId: string; userId: string }
  | { type: "call:declined"; matchId: string; userId: string }
  | { type: "call:cancelled"; matchId: string; userId: string }
  | { type: "call:completed"; matchId: string; userId: string };

const LOG_PREFIX = "[CallSignaling]";

function getChannelName(matchId: string) {
  return `call-signal:${matchId}`;
}

const subscribedChannels = new Map<string, ReturnType<typeof supabase.channel>>();

export function useCallSignaling(matchIds: string[], userId: string) {
  const prevKeyRef = useRef("");

  useEffect(() => {
    const key = [...matchIds].sort().join(",") + "|" + userId;
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;

    if (!userId || matchIds.length === 0) return;

    const currentIds = new Set(matchIds);

    for (const [id, ch] of subscribedChannels.entries()) {
      if (!currentIds.has(id)) {
        console.log(LOG_PREFIX, `Unsubscribing from ${getChannelName(id)}`);
        supabase.removeChannel(ch);
        subscribedChannels.delete(id);
      }
    }

    for (const matchId of matchIds) {
      if (subscribedChannels.has(matchId)) continue;

      const channelName = getChannelName(matchId);
      console.log(LOG_PREFIX, `Subscribing to ${channelName}`);

      const channel = supabase.channel(channelName, {
        config: { broadcast: { self: false } },
      });

      channel.on("broadcast", { event: "call-signal" }, ({ payload }) => {
        if (!payload) return;
        const senderId = payload.userId || payload.callerId;
        if (senderId === userId) return;
        const event = payload as CallSignalEvent;
        console.log(LOG_PREFIX, `Received:`, event.type, `matchId=${matchId}`, `from=${senderId}`);

        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
        queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
      });

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log(LOG_PREFIX, `Channel ${channelName} ready`);
        }
      });

      subscribedChannels.set(matchId, channel);
    }

    return () => {
      for (const [id, ch] of subscribedChannels.entries()) {
        console.log(LOG_PREFIX, `Cleanup: removing ${getChannelName(id)}`);
        supabase.removeChannel(ch);
      }
      subscribedChannels.clear();
      prevKeyRef.current = "";
    };
  }, [matchIds.join(","), userId]);
}

export function broadcastCallSignal(matchId: string, event: CallSignalEvent) {
  console.log(LOG_PREFIX, `Broadcasting:`, event.type, `matchId=${matchId}`);

  const existing = subscribedChannels.get(matchId);
  if (existing) {
    existing.send({
      type: "broadcast",
      event: "call-signal",
      payload: event,
    });
    console.log(LOG_PREFIX, `Sent via subscribed channel`);
    return;
  }

  console.log(LOG_PREFIX, `No subscribed channel found, creating one-shot sender`);
  const channelName = getChannelName(matchId);
  const tempChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  tempChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      tempChannel.send({
        type: "broadcast",
        event: "call-signal",
        payload: event,
      });
      console.log(LOG_PREFIX, `Sent via one-shot channel`);
      setTimeout(() => {
        supabase.removeChannel(tempChannel);
      }, 3000);
    }
  });
}
