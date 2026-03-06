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

const SWIPE_THRESHOLD = 100;

function SwipeButton({
  direction,
  icon: Icon,
  label,
  color,
  onSwipeComplete,
  disabled,
}: {
  direction: "right" | "left";
  icon: typeof Phone;
  label: string;
  color: string;
  onSwipeComplete: () => void;
  disabled?: boolean;
}) {
  const btnRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const isDragging = useRef(false);
  const completedRef = useRef(false);

  const handleEnd = useCallback(() => {
    if (!isDragging.current || !btnRef.current) return;
    isDragging.current = false;
    const dist = Math.abs(currentX.current);
    if (dist >= SWIPE_THRESHOLD && !completedRef.current) {
      completedRef.current = true;
      onSwipeComplete();
    }
    btnRef.current.style.transition = "transform 0.3s cubic-bezier(0.25,1,0.5,1)";
    btnRef.current.style.transform = "translateX(0px)";
  }, [onSwipeComplete]);

  const handleMove = useCallback((clientX: number) => {
    if (!isDragging.current || !btnRef.current) return;
    const dx = clientX - startX.current;
    const clamped = direction === "right"
      ? Math.max(0, Math.min(dx, SWIPE_THRESHOLD + 20))
      : Math.min(0, Math.max(dx, -(SWIPE_THRESHOLD + 20)));
    currentX.current = clamped;
    btnRef.current.style.transform = `translateX(${clamped}px)`;
  }, [direction]);

  const handleStart = useCallback((clientX: number) => {
    if (disabled) return;
    isDragging.current = true;
    completedRef.current = false;
    startX.current = clientX;
    currentX.current = 0;
    if (btnRef.current) {
      btnRef.current.style.transition = "none";
    }
  }, [disabled]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDragging.current) handleMove(e.clientX);
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
    <div
      className="relative flex items-center"
      style={{
        width: 200,
        height: 64,
        justifyContent: direction === "right" ? "flex-start" : "flex-end",
      }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `linear-gradient(${direction === "right" ? "to right" : "to left"}, ${color}15, transparent)`,
        }}
      />
      <div
        className="absolute text-xs font-medium tracking-wider uppercase"
        style={{
          color: `${color}`,
          opacity: 0.5,
          [direction === "right" ? "right" : "left"]: 20,
        }}
      >
        {direction === "right" ? "→" : "←"} {label}
      </div>
      <div
        ref={btnRef}
        className="relative z-10 flex items-center justify-center rounded-full cursor-grab active:cursor-grabbing"
        style={{
          width: 64,
          height: 64,
          background: color,
          boxShadow: `0 4px 20px ${color}50`,
          touchAction: "none",
        }}
        onTouchStart={(e) => handleStart(e.touches[0].clientX)}
        onTouchMove={(e) => handleMove(e.touches[0].clientX)}
        onTouchEnd={handleEnd}
        onMouseDown={(e) => { handleStart(e.clientX); e.preventDefault(); }}
        data-testid={`swipe-${direction === "right" ? "answer" : "decline"}`}
      >
        <Icon className="w-7 h-7 text-white" />
      </div>
    </div>
  );
}

export default function IncomingCallOverlay({ match, isFaceCall, onDismiss }: IncomingCallProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [answered, setAnswered] = useState(false);
  const actedRef = useRef(false);

  useEffect(() => {
    console.log("[IncomingCall] INCOMING_CALL_SHOWN", {
      matchId: match.id,
      callerName: match.profile.firstName,
      isFaceCall,
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
    if (freshMatches && !stillRinging && !answered && !actedRef.current) {
      console.log("[IncomingCall] Call no longer ringing, dismissing overlay");
      onDismiss();
    }
  }, [stillRinging, freshMatches, answered, onDismiss]);

  const answerCall = useMutation({
    mutationFn: async () => {
      const path = `/api/matches/${match.id}/call/answer`;
      console.log("[IncomingCall] CALL_API_REQUEST", { path, method: "POST", matchId: match.id });
      actedRef.current = true;
      const res = await apiRequest("POST", path, {});
      const data = await res.json();
      console.log("[IncomingCall] CALL_API_RESPONSE", { path, status: res.status, CALL_SESSION_ID: data.callSessionId });
      return data;
    },
    onSuccess: () => {
      console.log("[IncomingCall] CALL_SESSION_JOINED", { matchId: match.id, callSessionId: match.callSessionId });
      setAnswered(true);
      broadcastCallSignal(match.id, {
        type: "call:answered",
        matchId: match.id,
        userId: user!.id,
        callSessionId: match.callSessionId,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      onDismiss();
    },
    onError: () => {
      console.error("[IncomingCall] Failed to answer call");
      toast({ title: "Couldn't connect", description: "The call may have ended.", variant: "destructive" });
      onDismiss();
    },
  });

  const declineCall = useMutation({
    mutationFn: async () => {
      const path = `/api/matches/${match.id}/call/cancel`;
      console.log("[IncomingCall] CALL_API_REQUEST", { path, method: "POST", matchId: match.id });
      actedRef.current = true;
      const res = await apiRequest("POST", path, {});
      const data = await res.json();
      console.log("[IncomingCall] CALL_API_RESPONSE", { path, status: res.status });
      return data;
    },
    onSuccess: () => {
      console.log("[IncomingCall] CALL_END_REQUESTED - declining call");
      broadcastCallSignal(match.id, {
        type: "call:ended" as any,
        matchId: match.id,
        userId: user!.id,
      });
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
      });
      console.log("[IncomingCall] CALL_END_SENT", { matchId: match.id });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Call declined" });
      onDismiss();
    },
    onError: () => {
      console.error("[IncomingCall] Failed to decline call");
      onDismiss();
    },
  });

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const CallIcon = isFaceCall ? Video : Phone;
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
            <CallIcon className="w-5 h-5 text-white" />
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
          {answered ? "Connecting..." : isFaceCall ? "Incoming face call" : "Incoming call"}
        </p>

        {!answered && (
          <div className="mt-4 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite" }} />
            <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite 0.2s" }} />
            <div className="w-2 h-2 rounded-full bg-white/30" style={{ animation: "dotBounce 1.2s ease-in-out infinite 0.4s" }} />
          </div>
        )}
      </div>

      {!answered && (
        <div className="flex items-center justify-between w-full px-10 pb-16 z-10" data-testid="incoming-call-actions">
          <SwipeButton
            direction="left"
            icon={PhoneOff}
            label="Decline"
            color="#ef4444"
            onSwipeComplete={() => declineCall.mutate()}
            disabled={isPending}
          />
          <SwipeButton
            direction="right"
            icon={isFaceCall ? Video : Phone}
            label="Answer"
            color="#22c55e"
            onSwipeComplete={() => answerCall.mutate()}
            disabled={isPending}
          />
        </div>
      )}

      {answered && (
        <div className="pb-16 z-10">
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
            <Phone className="w-8 h-8 text-green-400" />
          </div>
        </div>
      )}

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
