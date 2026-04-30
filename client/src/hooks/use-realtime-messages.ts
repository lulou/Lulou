import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Match, Profile, Message } from "@shared/schema";

type LastMessage = { content: string; senderId: string; createdAt: Date | null };
type MatchWithProfile = Match & { profile: Profile; lastMessage: LastMessage | null };
type MsgsCache = { messages: Message[]; hasMore: boolean };

export function useRealtimeMessages(matchId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const broadcastChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pgChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Shared handler — called by both broadcast and postgres_changes.
  // Writes to the dedicated messages cache (["/api/matches", matchId, "messages"])
  // which is the sole source of truth for the chat message list.
  const handleNewMessage = useCallback((row: any) => {
    if (!row || !matchId) return;

    const newMsg: Message = {
      id: row.id,
      matchId: row.match_id ?? row.matchId,
      senderId: row.sender_id ?? row.senderId,
      content: row.content,
      reaction: row.reaction ?? null,
      createdAt: row.created_at ?? row.createdAt,
    };

    // 1. Update the messages cache (fast path — renders immediately)
    queryClient.setQueryData<MsgsCache>(
      ["/api/matches", matchId, "messages"],
      (old) => {
        if (!old) {
          queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId, "messages"] });
          return old;
        }
        if (old.messages?.some((m) => m.id === newMsg.id)) return old;

        const tempIdx = old.messages?.findIndex(
          (m) =>
            typeof m.id === "string" &&
            m.id.startsWith("temp-") &&
            m.content === newMsg.content &&
            m.senderId === newMsg.senderId
        );
        if (tempIdx !== undefined && tempIdx >= 0) {
          const updated = [...old.messages];
          updated[tempIdx] = newMsg;
          return { ...old, messages: updated };
        }

        return { ...old, messages: [...(old.messages || []), newMsg] };
      }
    );

    // 2. Update last-message preview in the matches list
    if (!newMsg.content.startsWith("__SCHEDULE__")) {
      queryClient.setQueryData<MatchWithProfile[]>(["/api/matches"], (list) => {
        if (!list) return list;
        return list.map((m) =>
          m.id === matchId
            ? {
                ...m,
                lastMessage: {
                  content: newMsg.content,
                  senderId: newMsg.senderId,
                  createdAt: newMsg.createdAt ? new Date(newMsg.createdAt as string) : null,
                },
              }
            : m
        );
      });
    }
  }, [matchId, queryClient]);

  useEffect(() => {
    if (!matchId || !enabled) return;

    // ── Channel 1: Supabase Broadcast — instant delivery from server (~50ms) ──
    const broadcastChannel = supabase
      .channel(`chat:${matchId}`, { config: { broadcast: { self: true } } })
      .on("broadcast", { event: "new-message" }, ({ payload }) => {
        handleNewMessage(payload);
      })
      .subscribe();

    broadcastChannelRef.current = broadcastChannel;

    // ── Channel 2: postgres_changes — WAL-based fallback/reconciliation (~200-500ms) ──
    const pgChannel = supabase
      .channel(`messages:${matchId}`)
      .on(
        "postgres_changes" as any,
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `match_id=eq.${matchId}`,
        },
        (payload: any) => {
          handleNewMessage(payload.new);
        }
      )
      .subscribe();

    pgChannelRef.current = pgChannel;

    return () => {
      if (broadcastChannelRef.current) {
        supabase.removeChannel(broadcastChannelRef.current);
        broadcastChannelRef.current = null;
      }
      if (pgChannelRef.current) {
        supabase.removeChannel(pgChannelRef.current);
        pgChannelRef.current = null;
      }
    };
  }, [matchId, enabled, handleNewMessage]);
}
