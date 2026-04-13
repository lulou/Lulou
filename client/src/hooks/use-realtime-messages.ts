import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Match, Profile, Message } from "@shared/schema";

type MatchDetail = Match & { profile: Profile; messages: Message[] };
type LastMessage = { content: string; senderId: string; createdAt: Date | null };
type MatchWithProfile = Match & { profile: Profile; lastMessage: LastMessage | null };

export function useRealtimeMessages(matchId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!matchId || !enabled) return;

    const channelName = `messages:${matchId}`;
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
          if (!row) return;

          const newMsg: Message = {
            id: row.id,
            matchId: row.match_id,
            senderId: row.sender_id,
            content: row.content,
            reaction: row.reaction ?? null,
            createdAt: row.created_at,
          };

          // 1. Update the open chat detail — append or replace temp optimistic message
          queryClient.setQueryData<MatchDetail>(
            ["/api/matches", matchId],
            (old) => {
              if (!old) {
                queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
                return old;
              }
              const exists = old.messages?.some((m) => m.id === newMsg.id);
              if (exists) return old;
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
              return {
                ...old,
                messages: [...(old.messages || []), newMsg],
              };
            }
          );

          // 2. Update last-message preview in the matches list (skip internal schedule messages)
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
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [matchId, enabled, queryClient]);
}
