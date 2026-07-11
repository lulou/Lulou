import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { Match, Profile, Message } from "@shared/schema";

type LastMessage = { content: string; senderId: string; createdAt: Date | null };
type MatchWithProfile = Match & { profile: Profile; lastMessage: LastMessage | null };
type MsgsCache = { messages: Message[]; hasMore: boolean };
// MatchDetail has .messages array embedded — used by _MatchChat in matches.tsx
type MatchDetailLike = { messages: Message[]; [key: string]: any };

export function useRealtimeMessages(matchId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const broadcastChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pgChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Shared handler — called by both broadcast and postgres_changes.
  // Writes to TWO caches:
  //   1. ["/api/matches", matchId, "messages"] — used by messaging.tsx (full-page chat)
  //   2. ["/api/matches", matchId]             — used by _MatchChat in matches.tsx (inline)
  // Both caches must stay in sync so either UI surface shows messages instantly.
  const handleNewMessage = useCallback((row: any) => {
    if (!row || !matchId) return;

    const newMsg: Message = {
      id: row.id,
      matchId: row.match_id ?? row.matchId,
      senderId: row.sender_id ?? row.senderId,
      content: row.content,
      reaction: row.reaction ?? null,
      createdAt: row.created_at ?? row.createdAt,
      voiceTranscript: row.voice_transcript ?? row.voiceTranscript ?? null,
    };

    console.log("[CHAT_REALTIME] message received realtime", {
      matchId: matchId.slice(0, 8),
      msgId: String(newMsg.id).slice(0, 8),
      senderId: String(newMsg.senderId).slice(0, 8),
    });

    // Helper: dedup-aware append that also replaces matching temp messages.
    function appendMsg(msgs: Message[]): Message[] {
      if (msgs.some((m) => m.id === newMsg.id)) return msgs; // already present

      const tempIdx = msgs.findIndex(
        (m) =>
          typeof m.id === "string" &&
          m.id.startsWith("temp-") &&
          m.content === newMsg.content &&
          m.senderId === newMsg.senderId
      );
      if (tempIdx >= 0) {
        const updated = [...msgs];
        updated[tempIdx] = newMsg;
        return updated;
      }
      return [...msgs, newMsg];
    }

    // ── Cache 1: dedicated messages cache (["/api/matches", matchId, "messages"]) ──
    // Used by messaging.tsx (full-page dedicated chat route).
    queryClient.setQueryData<MsgsCache>(
      ["/api/matches", matchId, "messages"],
      (old) => {
        if (!old) {
          // Cache cold — schedule a refetch so we don't silently miss the message.
          queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId, "messages"] });
          return old;
        }
        const next = appendMsg(old.messages ?? []);
        if (next === old.messages) return old; // no change, skip re-render
        console.log("[CHAT_REALTIME] cache updated (messages key)", { count: next.length });
        return { ...old, messages: next };
      }
    );

    // ── Cache 2: MatchDetail cache (["/api/matches", matchId]) ──
    // Used by _MatchChat in matches.tsx (inline expandable chat on Connections page).
    // Without this update, the receiver's inline chat only refreshes every 30 seconds.
    queryClient.setQueryData<MatchDetailLike>(
      ["/api/matches", matchId],
      (old) => {
        if (!old) return old;
        const msgs = old.messages ?? [];
        const next = appendMsg(msgs);
        if (next === msgs) return old; // no change
        console.log("[CHAT_REALTIME] cache updated (detail key)", { count: next.length });
        return { ...old, messages: next };
      }
    );

    // ── Last-message preview in the matches list ──
    // Skip all internal protocol messages (__SCHEDULE__:, __SYS__:, __SYSTEM__:)
    // from the preview.  __VOICE__: and __PHONE__: are valid user-visible content.
    if (
      !newMsg.content.startsWith("__SCHEDULE__:") &&
      !newMsg.content.startsWith("__SYS__:") &&
      !newMsg.content.startsWith("__SYSTEM__:")
    ) {
      queryClient.setQueryData<MatchWithProfile[]>(["/api/matches"], (list) => {
        if (!list) return list;
        const idx = list.findIndex((m) => m.id === matchId);
        if (idx === -1) return list;
        const existing = list[idx];
        if (
          existing.lastMessage?.content === newMsg.content &&
          existing.lastMessage?.senderId === newMsg.senderId
        ) return list; // already current — skip re-render
        const updated = [...list];
        updated[idx] = {
          ...existing,
          lastMessage: {
            content: newMsg.content,
            senderId: newMsg.senderId,
            createdAt: newMsg.createdAt ? new Date(newMsg.createdAt as unknown as string) : null,
          },
        };
        return updated;
      });
    }
  }, [matchId, queryClient]);

  // ── Broadcast: send a message to the other participant instantly (~50ms) ──
  // Called from sendMessage.onSuccess in matches.tsx and messaging.tsx after the
  // API call succeeds.  The broadcast channel fires handleNewMessage on both sides
  // (self: true), which deduplicates safely via the temp-id replacement logic.
  const broadcastNewMessage = useCallback((msg: Message) => {
    const ch = broadcastChannelRef.current;
    if (!ch || !matchId) return;
    ch.send({
      type: "broadcast",
      event: "new-message",
      payload: {
        id: msg.id,
        match_id: msg.matchId,
        sender_id: msg.senderId,
        content: msg.content,
        reaction: msg.reaction ?? null,
        created_at: msg.createdAt,
      },
    }).catch((err: any) =>
      console.warn("[CHAT_REALTIME] broadcast send error", err?.message)
    );
    console.log("[CHAT_REALTIME] message sent broadcast", {
      matchId: matchId.slice(0, 8),
      msgId: String(msg.id).slice(0, 8),
    });
  }, [matchId]);

  // ── Broadcast: notify the other participant of a date-choice change ──
  const broadcastDateChoice = useCallback((userId: string, choice: 'plan' | 'keep' | null) => {
    const ch = broadcastChannelRef.current;
    if (!ch || !matchId) return;
    ch.send({
      type: "broadcast",
      event: "date-choice",
      payload: { userId, choice },
    }).catch((err: any) =>
      console.warn("[DATE_CHOICE] broadcast send error", err?.message)
    );
    console.log("[DATE_CHOICE] broadcast sent", { matchId: matchId.slice(0, 8), choice });
  }, [matchId]);

  useEffect(() => {
    if (!matchId || !enabled) return;

    // ── Channel 1: Supabase Broadcast — instant delivery ~50ms ──
    // self: true so the sender also receives the echo (dedup handles it).
    const broadcastChannel = supabase
      .channel(`chat:${matchId}`, { config: { broadcast: { self: true } } })
      .on("broadcast", { event: "new-message" }, ({ payload }) => {
        console.log("[CHAT_REALTIME] broadcast event received", { matchId: matchId.slice(0, 8) });
        handleNewMessage(payload);
      })
      .on("broadcast", { event: "date-choice" }, ({ payload }) => {
        // payload: { userId, choice }
        const { userId, choice } = payload as { userId: string; choice: 'plan' | 'keep' | null };
        console.log("[DATE_CHOICE] broadcast received", { matchId: matchId.slice(0, 8), choice });
        queryClient.setQueryData<MatchDetailLike>(["/api/matches", matchId], (old) => {
          if (!old) return old;
          const isUser1 = old.user1Id === userId;
          return isUser1
            ? { ...old, dateChoiceUser1: choice }
            : { ...old, dateChoiceUser2: choice };
        });
      })
      .subscribe((status) => {
        console.log("[CHAT_REALTIME] broadcast channel status", { matchId: matchId.slice(0, 8), status });
      });

    broadcastChannelRef.current = broadcastChannel;

    // ── Channel 2: postgres_changes — WAL fallback/reconciliation ~200-500ms ──
    // Catches any messages that bypass the broadcast path (e.g. server-inserted
    // system messages, or if the broadcast packet is dropped).
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
          console.log("[CHAT_REALTIME] postgres_changes event received", { matchId: matchId.slice(0, 8) });
          handleNewMessage(payload.new);
        }
      )
      .subscribe((status: string) => {
        console.log("[CHAT_REALTIME] postgres channel status", { matchId: matchId.slice(0, 8), status });
      });

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

  return { broadcastNewMessage, broadcastDateChoice };
}
