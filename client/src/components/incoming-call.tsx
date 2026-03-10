import { useState, useRef, useCallback, useEffect } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useAuth } from "@/hooks/use-auth";
import type { Profile, Match } from "@shared/schema";

type IncomingCallProps = {
  match: Match & { profile: Profile };
  isFaceCall: boolean;
  onDismiss: () => void;
};

type MatchWithProfile = Match & { profile: Profile };

const DRAG_THRESHOLD = 120;

function SlideToAnswer({
  onAnswerComplete,
  disabled,
  isFaceCall,
}: {
  onAnswerComplete: () => void;
  disabled: boolean;
  isFaceCall: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentOffset = useRef(0);
  const isDragging = useRef(false);
  const completedRef = useRef(false);
  const [dragProgress, setDragProgress] = useState(0);

  const handleEnd = useCallback(() => {
    if (!isDragging.current || !knobRef.current) return;
    isDragging.current = false;
    if (Math.abs(currentOffset.current) >= DRAG_THRESHOLD && !completedRef.current) {
      completedRef.current = true;
      console.log("[CALL_UI] CALL_ACCEPTED", { source: "drag_complete" });
      onAnswerComplete();
    } else {
      knobRef.current.style.transition = "transform 0.3s cubic-bezier(0.25,1,0.5,1)";
      knobRef.current.style.transform = "translateY(0px)";
      setDragProgress(0);
    }
  }, [onAnswerComplete]);

  const handleMove = useCallback((clientY: number) => {
    if (!isDragging.current || !knobRef.current) return;
    const dy = startY.current - clientY;
    const clamped = Math.max(0, Math.min(dy, DRAG_THRESHOLD + 10));
    currentOffset.current = clamped;
    knobRef.current.style.transform = `translateY(-${clamped}px)`;
    setDragProgress(Math.min(1, clamped / DRAG_THRESHOLD));
  }, []);

  const handleStart = useCallback((clientY: number) => {
    if (disabled || completedRef.current) return;
    isDragging.current = true;
    startY.current = clientY;
    currentOffset.current = 0;
    console.log("[CALL_UI] CALL_ACCEPT_DRAG_STARTED");
    if (knobRef.current) {
      knobRef.current.style.transition = "none";
    }
  }, [disabled]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDragging.current) handleMove(e.clientY);
    };
    const onMouseUp = () => {
      if (isDragging.current) handleEnd();
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [handleMove, handleEnd]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="text-xs text-white/40 tracking-wider uppercase"
        style={{
          opacity: 1 - dragProgress,
          transition: isDragging.current ? "none" : "opacity 0.3s",
        }}
      >
        ↑ Drag up to answer
      </div>

      <div
        ref={trackRef}
        className="relative flex items-end justify-center"
        style={{
          width: 80,
          height: DRAG_THRESHOLD + 80,
        }}
      >
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-[40px] w-[2px] rounded-full"
          style={{
            height: DRAG_THRESHOLD,
            background: `linear-gradient(to top, rgba(34,197,94,0.4), rgba(34,197,94,0.05))`,
          }}
        />

        <div
          ref={knobRef}
          className="relative z-10 flex items-center justify-center rounded-full cursor-grab active:cursor-grabbing select-none"
          style={{
            width: 72,
            height: 72,
            background: dragProgress > 0.8
              ? "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)"
              : "linear-gradient(135deg, #22c55e 0%, #4ade80 100%)",
            boxShadow: `0 4px 24px rgba(34,197,94,${0.3 + dragProgress * 0.4})`,
            touchAction: "none",
          }}
          onTouchStart={(e) => handleStart(e.touches[0].clientY)}
          onTouchMove={(e) => handleMove(e.touches[0].clientY)}
          onTouchEnd={handleEnd}
          onMouseDown={(e) => { handleStart(e.clientY); e.preventDefault(); }}
          data-testid="drag-answer-call"
        >
          {isFaceCall ? (
            <Video className="w-8 h-8 text-white" />
          ) : (
            <Phone className="w-8 h-8 text-white" />
          )}
        </div>
      </div>
    </div>
  );
}

export default function IncomingCallOverlay({ match, isFaceCall, onDismiss }: IncomingCallProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const actedRef = useRef(false);

  useEffect(() => {
    console.log("[CALL_UI] INCOMING_CALL_SHOWN", {
      matchId: match.id,
      callerId: match.callInitiatorId,
      receiverId: user?.id,
      callerName: match.profile.firstName,
      callSessionId: match.callSessionId,
    });
  }, [match.id]);

  const { data: freshMatches } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    refetchInterval: 5000,
  });

  const stillRinging = freshMatches?.some(m =>
    m.id === match.id &&
    m.callStartedAt &&
    !m.callAnswered &&
    !m.callCompleted
  );

  useEffect(() => {
    if (freshMatches && !stillRinging && !actedRef.current) {
      console.log("[CALL_UI] CALL_STATE_CLEARED", {
        matchId: match.id,
        reason: "call_no_longer_ringing",
      });
      onDismiss();
    }
  }, [stillRinging, freshMatches, onDismiss]);

  const answerCall = useMutation({
    mutationFn: async () => {
      actedRef.current = true;
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, role: "receiver" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/answer`, {});
      return await res.json();
    },
    onSuccess: () => {
      console.log("[CALL_UI] CALL_ACCEPTED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user!.id,
      });
      broadcastCallSignal(match.id, {
        type: "call:answered",
        matchId: match.id,
        userId: user!.id,
      } as any);
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      onDismiss();
    },
    onError: (error: Error) => {
      actedRef.current = false;
      console.error("[CALL_UI] CALL_ANSWER_FAILED", { matchId: match.id, error: error.message });
      toast({ title: "Couldn't connect", description: error.message, variant: "destructive" });
    },
  });

  const declineCall = useMutation({
    mutationFn: async () => {
      actedRef.current = true;
      console.log("[CALL_UI] CALL_DECLINED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user?.id,
        role: "receiver",
      });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return await res.json();
    },
    onSuccess: () => {
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      console.log("[CALL_UI] CALL_STATE_CLEARED", {
        matchId: match.id,
        reason: "declined_by_receiver",
      });
      toast({ title: "Call declined" });
      onDismiss();
    },
    onError: (error: Error) => {
      actedRef.current = false;
      console.error("[CALL_UI] CALL_DECLINE_FAILED", { matchId: match.id, error: error.message });
      toast({ title: "Decline failed", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const photo = match.profile.photos?.[0];
  const isPending = answerCall.isPending || declineCall.isPending;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-between"
      style={{
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
      }}
      data-testid="incoming-call-overlay"
    >
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div
          className="absolute rounded-full"
          style={{
            width: 300,
            height: 300,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: "radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%)",
            animation: "incomingPulse1 2s ease-in-out infinite",
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            width: 500,
            height: 500,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: "radial-gradient(circle, rgba(255,255,255,0.015) 0%, transparent 70%)",
            animation: "incomingPulse2 2s ease-in-out infinite 0.5s",
          }}
        />
      </div>

      <div className="flex flex-col items-center pt-20 z-10" data-testid="incoming-call-info">
        <div className="relative mb-6">
          <div
            className="absolute rounded-full"
            style={{
              width: 140,
              height: 140,
              top: -10,
              left: -10,
              border: "2px solid rgba(255,255,255,0.15)",
              animation: "ringPulse 1.5s ease-out infinite",
            }}
          />
          <Avatar className="w-[120px] h-[120px] ring-4 ring-white/20">
            {photo ? (
              <AvatarImage src={photo} alt={match.profile.firstName} />
            ) : null}
            <AvatarFallback className="bg-white/10 text-white text-4xl font-serif">
              {match.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          <div
            className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: isFaceCall ? "#6366f1" : "#22c55e" }}
          >
            {isFaceCall ? (
              <Video className="w-5 h-5 text-white" />
            ) : (
              <Phone className="w-5 h-5 text-white" />
            )}
          </div>
        </div>

        <h2
          className="text-white font-serif text-3xl font-bold mb-1"
          data-testid="text-incoming-caller-name"
        >
          {match.profile.firstName}
        </h2>
        <p className="text-white/60 text-sm mb-1">
          {match.profile.age && `${match.profile.age}`}
          {match.profile.location && ` · ${match.profile.location}`}
        </p>
        <p className="text-white/40 text-xs tracking-wider uppercase mt-2">
          {isFaceCall ? "Incoming face call" : "Incoming call"}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite" }} />
          <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite 0.2s" }} />
          <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite 0.4s" }} />
        </div>
      </div>

      <div className="flex flex-col items-center pb-12 z-10 gap-10" data-testid="incoming-call-actions">
        <SlideToAnswer
          onAnswerComplete={() => answerCall.mutate()}
          disabled={isPending}
          isFaceCall={isFaceCall}
        />

        <button
          className="w-16 h-16 rounded-full flex items-center justify-center active:scale-95 transition-transform"
          style={{
            background: "linear-gradient(135deg, #dc2626 0%, #ef4444 100%)",
            boxShadow: "0 4px 20px rgba(239,68,68,0.4)",
          }}
          onClick={() => {
            if (!isPending) declineCall.mutate();
          }}
          disabled={isPending}
          data-testid="button-decline-call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
        <span className="text-white/40 text-xs -mt-8">Decline</span>
      </div>

      <style>{`
        @keyframes incomingPulse1 {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50% { transform: translate(-50%, -50%) scale(1.15); opacity: 0.5; }
        }
        @keyframes incomingPulse2 {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          50% { transform: translate(-50%, -50%) scale(1.1); opacity: 0.3; }
        }
        @keyframes ringPulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        @keyframes dotBounce {
          0%, 100% { transform: translateY(0); opacity: 0.3; }
          50% { transform: translateY(-4px); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
