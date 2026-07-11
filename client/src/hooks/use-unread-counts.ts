import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

type UnreadState = Record<string, number>;

/**
 * Track unread message counts across all matches using Supabase Realtime.
 *
 * ## Channel strategy (broadcast-only)
 * Previously this hook opened TWO channels per match:
 *   - `unread-pg:${matchId}`  — postgres_changes (WAL)
 *   - `chat:${matchId}`       — broadcast
 *
 * For a user with 8 connections that created 16 WebSocket connections to
 * Supabase Realtime.  Each channel carries a 30-second heartbeat timer,
 * so the iPhone CPU was being woken ~16 times per 30-second window just
 * for this hook — before counting call-signaling channels.
 *
 * Fix: broadcast-only.  The server already sends a broadcast payload to
 * `chat:${matchId}` on every message insert (~50 ms latency).
 * postgres_changes is a fallback (~300 ms) that adds no user-visible
 * benefit here.  Removing it halves the channel count: 2N → N.
 *
 * ## Tab gating (`enabled` param)
 * Pass `isActive` from TabActiveContext.  When the Connections tab is
 * hidden (display:none via PersistentTabs) the effect cleans up all
 * channels immediately.  They are rebuilt when the tab becomes visible.
 * Net result: 0 unread channels while user is on any other tab.
 */
export function useUnreadCounts(
  matchIds: string[],
  userId: string | null,
  activeMatchId: string | null,
  onNewBackgroundMessage?: (matchId: string) => void,
  enabled = true,
) {
  const [unreadCounts, setUnreadCounts] = useState<UnreadState>({});
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

  // Restore badge counts from the server on mount (persists across app restarts).
  // The server increments user_match_badge_counts on every push; reading it back
  // here seeds the in-memory state so the badge is correct immediately on open.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const res = await fetch("/api/messages/badge-counts", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const serverCounts: Record<string, number> = await res.json();
        setUnreadCounts(prev => {
          const merged: Record<string, number> = { ...serverCounts };
          // In-memory wins if higher (real-time messages received this session)
          for (const [id, n] of Object.entries(prev)) {
            merged[id] = Math.max(merged[id] ?? 0, n);
          }
          return merged;
        });
      } catch { /* non-fatal — live realtime updates still work */ }
    })();
  }, [userId]);

  const markRead = useCallback((matchId: string) => {
    setUnreadCounts(prev => {
      if (!prev[matchId]) return prev;
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
  }, []);

  const handleIncomingMessage = useCallback((matchId: string, senderId: string, msgId?: string) => {
    if (senderId === userId) return;

    // Deduplicate — in theory broadcast fires once, but guard against retries
    if (msgId) {
      if (seenMsgIdsRef.current.has(msgId)) return;
      seenMsgIdsRef.current.add(msgId);
      // Keep the seen-set bounded to avoid memory leak in long sessions
      if (seenMsgIdsRef.current.size > 500) {
        const first = seenMsgIdsRef.current.values().next().value;
        if (first) seenMsgIdsRef.current.delete(first);
      }
    }

    if (activeMatchIdRef.current === matchId) return;

    setUnreadCounts(prev => ({ ...prev, [matchId]: (prev[matchId] || 0) + 1 }));
    onNewBackgroundMessageRef.current?.(matchId);
  }, [userId]);

  useEffect(() => {
    const bcChannels = bcChannelsRef.current;

    if (!enabled || !userId || matchIds.length === 0) {
      // Tear down all channels when the owning tab becomes hidden or user logs out.
      // This is the key performance gate: 0 open WebSocket channels while the
      // Connections tab is not in the foreground.
      for (const [, ch] of bcChannels) supabase.removeChannel(ch);
      bcChannels.clear();
      return;
    }

    const activeIds = new Set(matchIds);

    // Remove channels for matches that left the list
    for (const [mid, ch] of bcChannels) {
      if (!activeIds.has(mid)) {
        supabase.removeChannel(ch);
        bcChannels.delete(mid);
      }
    }

    // Open one broadcast channel per match (server pushes on every insert)
    for (const matchId of matchIds) {
      if (bcChannels.has(matchId)) continue;
      const ch = supabase
        .channel(`chat:${matchId}`)
        .on("broadcast", { event: "new-message" }, ({ payload }) => {
          if (!payload) return;
          const senderId = payload.senderId ?? payload.sender_id;
          const msgId = payload.id;
          handleIncomingMessage(matchId, senderId, msgId);
        })
        .subscribe();
      bcChannels.set(matchId, ch);
    }

    return () => {
      for (const [, ch] of bcChannels) supabase.removeChannel(ch);
      bcChannels.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIds.join(","), userId, enabled, handleIncomingMessage]);

  return { unreadCounts, markRead };
}
