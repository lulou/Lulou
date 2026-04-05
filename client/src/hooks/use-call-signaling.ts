import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { markCallSessionCancelled, isCallSessionCancelled } from "@/lib/cancelled-calls";

type CallSignalEvent =
  | { type: "call:ring"; matchId: string; callerId: string; callerName: string; callSessionId?: string }
  | { type: "call:answered"; matchId: string; userId: string; callSessionId?: string }
  | { type: "call:declined"; matchId: string; userId: string }
  | { type: "call:cancelled"; matchId: string; userId: string }
  | { type: "call:ended"; matchId: string; userId: string };

function getChannelName(matchId: string) {
  return `call-signal:${matchId}`;
}

const subscribedChannels = new Map<string, ReturnType<typeof supabase.channel>>();

let callEndedCallback: ((matchId: string, callSessionId?: string | null) => void) | null = null;
const recentlyProcessed = new Set<string>();

export function setCallEndedHandler(handler: ((matchId: string, callSessionId?: string | null) => void) | null) {
  callEndedCallback = handler;
}

export function clearDedupeForMatch(matchId: string) {
  for (const key of recentlyProcessed) {
    if (key.startsWith(`${matchId}:`)) {
      recentlyProcessed.delete(key);
    }
  }
}

function processEndSignal(matchId: string, reason: string, callSessionId?: string | null) {
  const key = `${matchId}:${reason}`;
  if (recentlyProcessed.has(key)) return;
  recentlyProcessed.add(key);
  setTimeout(() => recentlyProcessed.delete(key), 10000);
  console.log("[CALL_SESSION] CONNECTION_REMOVED", { matchId, callSessionId, reason: `signal_${reason}`, source: "realtime" });
  callEndedCallback?.(matchId, callSessionId);
}

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
        supabase.removeChannel(ch);
        subscribedChannels.delete(id);
      }
    }

    for (const matchId of matchIds) {
      if (subscribedChannels.has(matchId)) continue;

      const channel = supabase.channel(getChannelName(matchId), {
        config: { broadcast: { self: false } },
      });

      channel.on("broadcast", { event: "call-signal" }, ({ payload }) => {
        if (!payload) return;
        const senderId = payload.userId || payload.callerId;
        if (senderId === userId) return;
        const event = payload as CallSignalEvent;

        let isEndSignal = false;

        if (event.type === "call:ring") {
          const ring = event as any;
          const ringSessionId = ring.callSessionId ?? null;
          // Skip stale ring signals for sessions that were already cancelled
          if (isCallSessionCancelled(matchId, ringSessionId)) {
            console.log("[CALL_SIGNAL] STALE_RING_BLOCKED", { matchId, callSessionId: ringSessionId, reason: "session_already_cancelled" });
          } else {
            console.log("[CALL_SIGNAL] RECEIVER_ASSIGNED", { matchId, callerId: ring.callerId, receiverId: userId });
            // Immediately update the list cache so incoming call UI shows without waiting for a refetch
            queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
              if (!old || !Array.isArray(old)) return old;
              return old.map((m: any) => m.id === matchId ? {
                ...m,
                callStartedAt: m.callStartedAt || new Date().toISOString(),
                callInitiatorId: m.callInitiatorId || ring.callerId,
                callSessionId: m.callSessionId || ring.callSessionId,
                callAnswered: false,
                callCompleted: false,
              } : m);
            });
          }
        } else if (event.type === "call:answered") {
          console.log("[CALL_SIGNAL] CALL_ANSWERED", { matchId, answeredBy: senderId });
          // Immediately flip callAnswered so the caller transitions from ringing to in-call
          const answeredPatch = { callAnswered: true };
          queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
            if (!old || !Array.isArray(old)) return old;
            return old.map((m: any) => m.id === matchId ? { ...m, ...answeredPatch } : m);
          });
          queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old) => {
            if (!old || Array.isArray(old)) return old;
            return { ...old, ...answeredPatch };
          });
        } else if (event.type === "call:declined") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_DECLINED", { matchId, declinedBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          processEndSignal(matchId, "declined", sid);
          isEndSignal = true;
        } else if (event.type === "call:cancelled") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_CANCELLED", { matchId, cancelledBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          processEndSignal(matchId, "cancelled", sid);
          isEndSignal = true;
        } else if (event.type === "call:ended") {
          const sid = (event as any).callSessionId ?? null;
          console.log("[CALL_SIGNAL] CALL_ENDED", { matchId, endedBy: senderId, callSessionId: sid });
          markCallSessionCancelled(matchId, sid);
          processEndSignal(matchId, "ended", sid);
          isEndSignal = true;
        }

        if (isEndSignal) {
          console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", {
            matchId,
            signal: event.type,
            note: "end signal received — queries NOT invalidated, chat history intact",
          });
        } else {
          queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
          queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
        }
      });

      channel.subscribe();
      subscribedChannels.set(matchId, channel);
    }

    return () => {
      for (const [, ch] of subscribedChannels.entries()) {
        supabase.removeChannel(ch);
      }
      subscribedChannels.clear();
      prevKeyRef.current = "";
    };
  }, [matchIds.join(","), userId]);
}

export function broadcastCallSignal(matchId: string, event: CallSignalEvent) {
  const existing = subscribedChannels.get(matchId);
  if (existing) {
    existing.send({
      type: "broadcast",
      event: "call-signal",
      payload: event,
    });
    return;
  }

  const channelName = getChannelName(matchId);
  const tempChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  const timeout = setTimeout(() => {
    supabase.removeChannel(tempChannel);
  }, 5000);

  tempChannel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      clearTimeout(timeout);
      tempChannel.send({
        type: "broadcast",
        event: "call-signal",
        payload: event,
      });
      setTimeout(() => supabase.removeChannel(tempChannel), 2000);
    }
  });
}
