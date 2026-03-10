import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

type UnreadState = Record<string, number>;

export function useUnreadCounts(
  matchIds: string[],
  userId: string | null,
  activeMatchId: string | null
) {
  const [unreadCounts, setUnreadCounts] = useState<UnreadState>({});
  const channelsRef = useRef<Map<string, ReturnType<typeof supabase.channel>>>(new Map());
  const activeMatchIdRef = useRef(activeMatchId);

  useEffect(() => {
    activeMatchIdRef.current = activeMatchId;
  }, [activeMatchId]);

  const markRead = useCallback((matchId: string) => {
    setUnreadCounts(prev => {
      if (!prev[matchId]) return prev;
      console.log("[CHAT] MESSAGE_MARKED_READ", { matchId, clearedCount: prev[matchId] });
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!userId || matchIds.length === 0) return;

    const currentChannels = channelsRef.current;
    const activeIds = new Set(matchIds);

    for (const [mid, ch] of currentChannels) {
      if (!activeIds.has(mid)) {
        supabase.removeChannel(ch);
        currentChannels.delete(mid);
      }
    }

    for (const matchId of matchIds) {
      if (currentChannels.has(matchId)) continue;

      const channelName = `unread-msg:${matchId}`;
      const channel = supabase
        .channel(channelName)
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
            if (!row || row.sender_id === userId) return;

            if (activeMatchIdRef.current === matchId) {
              console.log("[CHAT] MESSAGE_RECEIVED_IN_ACTIVE_THREAD", { matchId, senderId: row.sender_id });
              return;
            }

            console.log("[CHAT] MESSAGE_RECEIVED_IN_BACKGROUND_THREAD", { matchId, senderId: row.sender_id });
            setUnreadCounts(prev => {
              const newCount = (prev[matchId] || 0) + 1;
              console.log("[CHAT] UNREAD_COUNT_UPDATED", { matchId, count: newCount });
              return { ...prev, [matchId]: newCount };
            });
          }
        )
        .subscribe();

      currentChannels.set(matchId, channel);
    }

    return () => {
      for (const [, ch] of currentChannels) {
        supabase.removeChannel(ch);
      }
      currentChannels.clear();
    };
  }, [matchIds.join(","), userId]);

  return { unreadCounts, markRead };
}
