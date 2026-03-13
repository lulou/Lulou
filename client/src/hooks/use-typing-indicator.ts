import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";

const TYPING_THROTTLE_MS = 2000;
const TYPING_TIMEOUT_MS = 3500;

export function useTypingIndicator(
  matchId: string,
  userId: string | null,
  enabled: boolean
) {
  const [isOtherTyping, setIsOtherTyping] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<number>(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!enabled || !matchId || !userId) return;

    const channelName = `typing-${matchId}`;
    const channel = supabase
      .channel(channelName, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "typing" }, (payload: any) => {
        const senderId = payload?.payload?.userId;
        if (!senderId || senderId === userId) return;

        console.log("[CHAT] TYPING_EVENT_RECEIVED", { matchId, senderId });

        setIsOtherTyping(true);

        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => {
          setIsOtherTyping(false);
          console.log("[CHAT] USER_STOPPED_TYPING", { matchId, reason: "timeout" });
        }, TYPING_TIMEOUT_MS);
      })
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setIsOtherTyping(false);
    };
  }, [matchId, userId, enabled]);

  const sendTyping = useCallback(() => {
    if (!channelRef.current || !userId) return;

    const now = Date.now();
    if (now - lastSentRef.current < TYPING_THROTTLE_MS) return;
    lastSentRef.current = now;

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      console.log("[CHAT] USER_STARTED_TYPING", { matchId, userId });
    }

    channelRef.current.send({
      type: "broadcast",
      event: "typing",
      payload: { userId },
    });
  }, [matchId, userId]);

  const stopTyping = useCallback(() => {
    if (isTypingRef.current) {
      isTypingRef.current = false;
      console.log("[CHAT] USER_STOPPED_TYPING", { matchId, userId, reason: "sent" });
    }
    lastSentRef.current = 0;
  }, [matchId, userId]);

  return { isOtherTyping, sendTyping, stopTyping };
}
