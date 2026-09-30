import { useState, useEffect, useRef, useCallback } from "react";
import {
  createRealtimeCompatibilityPair,
  onCompatibilityBroadcast,
  removeCompatibilityPair,
  sendCompatibilityBroadcast,
  subscribeCompatibilityPair,
  type RealtimeCompatibilityPair,
} from "@/lib/realtime-compat";

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
  const channelRef = useRef<RealtimeCompatibilityPair | null>(null);
  const isTypingRef = useRef(false);

  useEffect(() => {
    if (!enabled || !matchId || !userId) return;

    const channelName = `typing-${matchId}`;
    const channels = createRealtimeCompatibilityPair(channelName, { self: false });
    onCompatibilityBroadcast(channels, "typing", (payload: any) => {
        const senderId = payload?.payload?.userId;
        if (!senderId || senderId === userId) return;

        console.log("[CHAT] TYPING_EVENT_RECEIVED", { matchId, senderId });

        setIsOtherTyping(true);

        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => {
          setIsOtherTyping(false);
          console.log("[CHAT] USER_STOPPED_TYPING", { matchId, reason: "timeout" });
        }, TYPING_TIMEOUT_MS);
    });
    subscribeCompatibilityPair(channels);

    channelRef.current = channels;

    return () => {
      removeCompatibilityPair(channels);
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

    void sendCompatibilityBroadcast(channelRef.current, "typing", { userId })
      .catch((error: any) => console.warn("[CHAT] typing broadcast failed", error?.message));
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
