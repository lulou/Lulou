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
    const interval = setInterval(() => setElapsed(e => e + 1), 1000);
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
    console.log("[CALL_UI] CALL_STAGE_ENTERED", {
      matchId,
      callSessionId,
      role: isCaller ? "caller" : "receiver",
      userId,
      isRinging,
    });
  }, [matchId, callSessionId]);

  const finishCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;

    const isCancelRinging = isRinging && isCaller;
    const endpoint = isCancelRinging
      ? `/api/matches/${matchId}/call/cancel`
      : `/api/matches/${matchId}/call/complete`;
    const signalType = isCancelRinging ? "call:cancelled" : "call:ended";

    if (!isCancelRinging) {
      console.log("[CALL_UI] CALL_HUNG_UP", {
        matchId,
        callSessionId,
        userId,
        isCaller,
        source: "fullscreen_overlay",
      });
    } else {
      console.log("[CALL_UI] CALL_CANCELLED", {
        matchId,
        callSessionId,
        userId,
        role: "caller",
        source: "fullscreen_overlay",
      });
    }
    console.log("[CALL_SESSION] CALL_STAGE_EXITED", { matchId, callSessionId, reason: isCancelRinging ? "caller_cancelled" : "user_hangup" });

    onCallEnd();

    broadcastCallSignal(matchId, {
      type: signalType as any,
      matchId,
      userId,
      callSessionId,
    } as any);

    apiRequest("POST", endpoint).catch(e => {
      console.error("[ActiveCall] API error:", e.message);
    }).finally(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
    });
  }, [matchId, callSessionId, userId, isCaller, isRinging, onCallEnd, queryClient]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center"
      style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)" }}
      data-testid="overlay-voice-call"
    >
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          {isRinging ? (
            <div className="absolute inset-0 rounded-full bg-white/10 animate-ping" style={{ animationDuration: "2s" }} />
          ) : (
            <div className="absolute -inset-2 rounded-full border-2 border-green-400/40" />
          )}
          <Avatar className="w-32 h-32 border-4 border-white/30">
            <AvatarImage src={callerPhoto} alt={callerName} />
            <AvatarFallback className="text-3xl bg-white/20 text-white">{callerName[0]}</AvatarFallback>
          </Avatar>
        </div>

        <h2 className="text-white text-2xl font-semibold" data-testid="text-call-name">
          {callerName}
        </h2>

        {isRinging ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
            <span className="text-white/60 text-sm">
              {isCaller ? "Ringing…" : "Connecting…"}
            </span>
          </div>
        ) : (
          <CallTimer />
        )}
      </div>

      <div className="absolute bottom-16 left-0 right-0 flex justify-center gap-8">
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
          onClick={finishCall}
          data-testid="button-end-call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
      </div>
      {isRinging && isCaller && (
        <p className="absolute bottom-8 text-white/30 text-xs">Tap to cancel</p>
      )}
    </div>
  );
}
