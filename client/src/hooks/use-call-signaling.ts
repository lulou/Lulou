import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";

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

let callEndedCallback: ((matchId: string) => void) | null = null;
const recentlyProcessed = new Set<string>();

const pendingCallState = new Map<string, { callerId: string; callerName: string; callSessionId: string; expiresAt: number }>();
const PENDING_CALL_TTL = 20000;

export function getPendingCallState(matchId: string) {
  const state = pendingCallState.get(matchId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    pendingCallState.delete(matchId);
    return null;
  }
  return state;
}

export function clearPendingCallState(matchId: string) {
  pendingCallState.delete(matchId);
}

export function reconcilePendingWithServer(matchId: string, serverCallStartedAt: any, serverCallInitiatorId: string | null) {
  const pending = pendingCallState.get(matchId);
  if (!pending) return;
  if (!serverCallStartedAt || !serverCallInitiatorId) {
    pendingCallState.delete(matchId);
    return;
  }
  if (serverCallInitiatorId !== pending.callerId) {
    pendingCallState.delete(matchId);
  }
}

export function setCallEndedHandler(handler: ((matchId: string) => void) | null) {
  callEndedCallback = handler;
}

export function clearDedupeForMatch(matchId: string) {
  for (const key of recentlyProcessed) {
    if (key.startsWith(`${matchId}:`)) {
      recentlyProcessed.delete(key);
    }
  }
}

function processEndSignal(matchId: string, reason: string) {
  const key = `${matchId}:${reason}`;
  if (recentlyProcessed.has(key)) return;
  recentlyProcessed.add(key);
  setTimeout(() => recentlyProcessed.delete(key), 10000);
  clearPendingCallState(matchId);
  callEndedCallback?.(matchId);
}

function applyCallStateToCache(matchId: string, callerId: string, callSessionId: string) {
  const updateMatches = (old: any[] | undefined) => {
    if (!old) return old;
    return old.map((m: any) => {
      if (m.id !== matchId) return m;
      if (m.callStartedAt && m.callInitiatorId && m.callInitiatorId === callerId) return m;
      return {
        ...m,
        callStartedAt: new Date().toISOString(),
        callInitiatorId: callerId,
        callSessionId,
        callAnswered: false,
        callCompleted: false,
      };
    });
  };
  queryClient.setQueryData(["/api/matches"], updateMatches);
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

        if (event.type === "call:ring") {
          const ringEvent = event as Extract<CallSignalEvent, { type: "call:ring" }>;
          if (!ringEvent.callSessionId) {
            console.log("[CALL_SIGNAL] RING_IGNORED (no callSessionId)", { matchId });
            queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
            queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
            return;
          }
          const sessionId = ringEvent.callSessionId;
          console.log("[CALL_SIGNAL] RECEIVER_ASSIGNED", { matchId, callerId: ringEvent.callerId, receiverId: userId, callSessionId: sessionId });
          pendingCallState.set(matchId, {
            callerId: ringEvent.callerId,
            callerName: ringEvent.callerName,
            callSessionId: sessionId,
            expiresAt: Date.now() + PENDING_CALL_TTL,
          });
          applyCallStateToCache(matchId, ringEvent.callerId, sessionId);
        } else if (event.type === "call:answered") {
          console.log("[CALL_SIGNAL] CALL_ANSWERED", { matchId, answeredBy: senderId });
          clearPendingCallState(matchId);
        } else if (event.type === "call:declined") {
          console.log("[CALL_SIGNAL] CALL_DECLINED", { matchId, declinedBy: senderId });
          processEndSignal(matchId, "declined");
        } else if (event.type === "call:cancelled") {
          console.log("[CALL_SIGNAL] CALL_CANCELLED", { matchId, cancelledBy: senderId });
          processEndSignal(matchId, "cancelled");
        } else if (event.type === "call:ended") {
          console.log("[CALL_SIGNAL] CALL_ENDED", { matchId, endedBy: senderId });
          processEndSignal(matchId, "ended");
        }

        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
        queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
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
