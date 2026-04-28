import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

type UnreadState = Record<string, number>;

export function useUnreadCounts(
  matchIds: string[],
  userId: string | null,
  activeMatchId: string | null,
  onNewBackgroundMessage?: (matchId: string) => void
) {
  const [unreadCounts, setUnreadCounts] = useState<UnreadState>({});
  const pgChannelsRef = useRef<Map<string, ReturnType<typeof supabase.channel>>>(new Map());
  const bcChannelsRef = useRef<Map<string, ReturnType<typeof supabase.channel>>>(new Map());
  const activeMatchIdRef = useRef(activeMatchId);
  const onNewBackgroundMessageRef = useRef(onNewBackgroundMessage);
  const seenMsgIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    activeMatchIdRef.current = activeMatchId;
  }, [activeMatchId]);

  useEffect(() => {
    onNewBackgroundMessageRef.current = onNewBackgroundMessage;
  }, [onNewBackgroundMessage]);

  const markRead = useCallback((matchId: string) => {
    setUnreadCounts(prev => {
      if (!prev[matchId]) return prev;
      console.log("[CHAT] MESSAGE_MARKED_READ", { matchId, clearedCount: prev[matchId] });
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
  }, []);

  const handleIncomingMessage = useCallback((matchId: string, senderId: string, msgId?: string) => {
    if (senderId === userId) return;

    // Deduplicate — broadcast and postgres_changes may both fire for the same message
    if (msgId) {
      if (seenMsgIdsRef.current.has(msgId)) return;
      seenMsgIdsRef.current.add(msgId);
      // Keep the seen-set bounded
      if (seenMsgIdsRef.current.size > 500) {
        const first = seenMsgIdsRef.current.values().next().value;
        if (first) seenMsgIdsRef.current.delete(first);
      }
    }

    if (activeMatchIdRef.current === matchId) {
      console.log("[CHAT] MESSAGE_RECEIVED_IN_ACTIVE_THREAD", { matchId, senderId });
      return;
    }

    console.log("[CHAT] MESSAGE_RECEIVED_IN_BACKGROUND_THREAD", { matchId, senderId });
    setUnreadCounts(prev => {
      const newCount = (prev[matchId] || 0) + 1;
      console.log("[CHAT] UNREAD_COUNT_UPDATED", { matchId, count: newCount });
      return { ...prev, [matchId]: newCount };
    });

    onNewBackgroundMessageRef.current?.(matchId);
  }, [userId]);

  useEffect(() => {
    if (!userId || matchIds.length === 0) return;

    const pgChannels = pgChannelsRef.current;
    const bcChannels = bcChannelsRef.current;
    const activeIds = new Set(matchIds);

    // Remove channels for matches no longer in the list
    for (const [mid, ch] of pgChannels) {
      if (!activeIds.has(mid)) {
        supabase.removeChannel(ch);
        pgChannels.delete(mid);
      }
    }
    for (const [mid, ch] of bcChannels) {
      if (!activeIds.has(mid)) {
        supabase.removeChannel(ch);
        bcChannels.delete(mid);
      }
    }

    for (const matchId of matchIds) {
      // ── Channel A: postgres_changes (WAL-based, now enabled on Supabase) ──
      if (!pgChannels.has(matchId)) {
        const ch = supabase
          .channel(`unread-pg:${matchId}`)
          .on(
            "postgres_changes" as any,
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `match_id=eq.${matchId}`,
            },
            (payload: any) => {
              const row = payload.new;
              if (!row) return;
              console.log("[REALTIME_UNREAD] PG_INSERT", { matchId, id: row.id, senderId: row.sender_id });
              handleIncomingMessage(matchId, row.sender_id, row.id);
            }
          )
          .subscribe((status) => {
            console.log("[REALTIME_UNREAD] PG_STATUS", { matchId, status });
          });
        pgChannels.set(matchId, ch);
      }

      // ── Channel B: broadcast (server pushes to chat:matchId on every insert) ──
      // Must use the same channel name the server broadcasts to.
      if (!bcChannels.has(matchId)) {
        const ch = supabase
          .channel(`chat:${matchId}`)
          .on("broadcast", { event: "new-message" }, ({ payload }) => {
            if (!payload) return;
            const senderId = payload.senderId ?? payload.sender_id;
            const msgId = payload.id;
            console.log("[REALTIME_UNREAD] BC_INSERT", { matchId, id: msgId, senderId });
            handleIncomingMessage(matchId, senderId, msgId);
          })
          .subscribe((status) => {
            console.log("[REALTIME_UNREAD] BC_STATUS", { matchId, status });
          });
        bcChannels.set(matchId, ch);
      }
    }

    return () => {
      for (const [, ch] of pgChannels) supabase.removeChannel(ch);
      for (const [, ch] of bcChannels) supabase.removeChannel(ch);
      pgChannels.clear();
      bcChannels.clear();
    };
  }, [matchIds.join(","), userId, handleIncomingMessage]);

  return { unreadCounts, markRead };
}
