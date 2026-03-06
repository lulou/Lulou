import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { PhoneOff, Loader2 } from "lucide-react";

interface ActiveCallProps {
  matchId: string;
  callSessionId: string;
  userId: string;
  isCaller: boolean;
  isVideo: boolean;
  isRinging: boolean;
  callerName: string;
  callerPhoto?: string;
  onCallEnd: () => void;
}

function CallTimer() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span data-testid="text-call-timer" className="text-white/80 text-lg font-mono tabular-nums">
      {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
    </span>
  );
}

export function ActiveCallOverlay({
  matchId,
  callSessionId,
  userId,
  isCaller,
  isVideo,
  isRinging,
  callerName,
  callerPhoto,
  onCallEnd,
}: ActiveCallProps) {
  const queryClient = useQueryClient();
  const endedRef = useRef(false);

  useEffect(() => {
    console.log("[CALL_UI] OUTGOING_CALL_UI_SHOWN", {
      matchId,
      callSessionId,
      role: isCaller ? "CALLER" : "RECEIVER",
      userId,
      isRinging,
      SESSION_PARTICIPANTS_COUNT: 2,
    });
  }, [matchId, callSessionId]);

  const finishCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;

    const endpoint = isRinging
      ? `/api/matches/${matchId}/call/cancel`
      : `/api/matches/${matchId}/call/complete`;

    onCallEnd();

    broadcastCallSignal(matchId, {
      type: isRinging ? "call:cancelled" : "call:ended",
      matchId,
      userId,
    } as any);

    apiRequest("POST", endpoint).catch((e) => {
      console.error("[ActiveCall] API error:", e.message);
    }).finally(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
    });
  }, [matchId, callSessionId, userId, isRinging, onCallEnd, queryClient]);

  const statusLabel = isRinging ? "Ringing..." : "Connected";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-[hsl(350,45%,30%)] to-[hsl(350,45%,15%)]" data-testid="overlay-voice-call">
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          {!isRinging ? (
            <div className="absolute -inset-2 rounded-full border-2 border-green-400/40" />
          ) : (
            <div className="absolute inset-0 rounded-full bg-white/10 animate-ping" style={{ animationDuration: "2s" }} />
          )}
          <Avatar className="w-32 h-32 border-4 border-white/30">
            <AvatarImage src={callerPhoto} alt={callerName} />
            <AvatarFallback className="text-3xl bg-white/20 text-white">{callerName[0]}</AvatarFallback>
          </Avatar>
        </div>

        <h2 className="text-white text-2xl font-semibold" data-testid="text-call-name">{callerName}</h2>

        {isRinging ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
            <span className="text-white/60 text-sm">{statusLabel}</span>
          </div>
        ) : (
          <CallTimer />
        )}
      </div>

      <div className="absolute bottom-16 left-0 right-0 flex justify-center gap-8">
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all"
          onClick={finishCall}
          data-testid="button-end-call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
      </div>
    </div>
  );
}
