import { useRef, useEffect } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useAuth } from "@/hooks/use-auth";
import type { Profile, Match } from "@shared/schema";
import { markCallSessionCancelled } from "@/lib/cancelled-calls";

type MatchWithProfile = Match & { profile: Profile };

type IncomingCallProps = {
  match: MatchWithProfile;
  isFaceCall: boolean;
  onDismiss: () => void;
};

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
  }, [match.id, match.callSessionId]);

  // Lock body scroll while overlay is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const answerCall = useMutation({
    mutationFn: async () => {
      actedRef.current = true;
      console.log("[CALL_UI] CALL_ANSWERED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user?.id,
        role: "receiver",
        source: "incoming_overlay",
      });
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, role: "receiver" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/answer`, {});
      return await res.json();
    },
    onSuccess: () => {
      broadcastCallSignal(match.id, {
        type: "call:answered",
        matchId: match.id,
        userId: user!.id,
        callSessionId: match.callSessionId,
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
        source: "incoming_overlay",
      });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return await res.json();
    },
    onSuccess: () => {
      markCallSessionCancelled(match.id, match.callSessionId);
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
        callSessionId: match.callSessionId,
      } as any);
      // Optimistically clear call fields in cache
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old) return old;
        return old.map(m =>
          m.id === match.id
            ? { ...m, callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null }
            : m
        );
      });
      console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        reason: "receiver_declined",
      });
      toast({ title: "Call declined" });
      onDismiss();
    },
    onError: (error: Error) => {
      // Even on error: mark cancelled, broadcast, optimistic clear, dismiss
      console.error("[CALL_UI] CALL_DECLINE_FAILED", { matchId: match.id, error: error.message });
      markCallSessionCancelled(match.id, match.callSessionId);
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
        callSessionId: match.callSessionId,
      } as any);
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old) return old;
        return old.map(m =>
          m.id === match.id
            ? { ...m, callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null }
            : m
        );
      });
      toast({ title: "Call declined" });
      onDismiss();
    },
  });

  const isPending = answerCall.isPending || declineCall.isPending;
  const photo = match.profile.photos?.[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-between pb-16 pt-20"
      style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)" }}
      data-testid="incoming-call-overlay"
    >
      {/* Ambient pulse rings */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <div className="absolute w-72 h-72 rounded-full border border-white/10 animate-ping" style={{ animationDuration: "2s" }} />
        <div className="absolute w-96 h-96 rounded-full border border-white/5 animate-ping" style={{ animationDuration: "3s" }} />
      </div>

      {/* Caller info */}
      <div className="flex flex-col items-center z-10" data-testid="incoming-call-info">
        <div className="relative mb-5">
          <div
            className="absolute rounded-full border-2 border-white/20"
            style={{ inset: -12, animation: "ringPulse 1.8s ease-out infinite" }}
          />
          <Avatar className="w-[110px] h-[110px] ring-4 ring-white/20">
            {photo ? <AvatarImage src={photo} alt={match.profile.firstName} /> : null}
            <AvatarFallback className="bg-white/10 text-white text-4xl font-serif">
              {match.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          <div
            className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: isFaceCall ? "#6366f1" : "#22c55e" }}
          >
            {isFaceCall ? (
              <Video className="w-4 h-4 text-white" />
            ) : (
              <Phone className="w-4 h-4 text-white" />
            )}
          </div>
        </div>

        <h2 className="text-white font-serif text-3xl font-bold mb-1" data-testid="text-incoming-caller-name">
          {match.profile.firstName}
        </h2>
        <p className="text-white/50 text-sm">
          {[match.profile.age, match.profile.location].filter(Boolean).join(" · ")}
        </p>
        <p className="text-white/35 text-xs tracking-widest uppercase mt-3">
          {isFaceCall ? "Incoming face call" : "Incoming call"}
        </p>

        {/* Animated dots */}
        <div className="mt-4 flex items-center gap-2">
          {[0, 0.2, 0.4].map((delay, i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-white/30"
              style={{ animation: `dotBounce 1.2s ease-in-out ${delay}s infinite` }}
            />
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="z-10 flex flex-col items-center gap-6" data-testid="incoming-call-actions">
        {/* Answer */}
        <div className="flex flex-col items-center gap-2">
          <button
            className="w-20 h-20 rounded-full flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)",
              boxShadow: "0 4px 24px rgba(34,197,94,0.45)",
            }}
            onClick={() => { if (!isPending) answerCall.mutate(); }}
            disabled={isPending}
            data-testid="button-answer-call"
          >
            {isFaceCall ? (
              <Video className="w-9 h-9 text-white" />
            ) : (
              <Phone className="w-9 h-9 text-white" />
            )}
          </button>
          <span className="text-white/45 text-xs">
            {answerCall.isPending ? "Connecting…" : "Answer"}
          </span>
        </div>

        {/* Decline */}
        <div className="flex flex-col items-center gap-2">
          <button
            className="w-16 h-16 rounded-full flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #dc2626 0%, #ef4444 100%)",
              boxShadow: "0 4px 20px rgba(239,68,68,0.4)",
            }}
            onClick={() => { if (!isPending) declineCall.mutate(); }}
            disabled={isPending}
            data-testid="button-decline-call"
          >
            <PhoneOff className="w-7 h-7 text-white" />
          </button>
          <span className="text-white/45 text-xs">
            {declineCall.isPending ? "Declining…" : "Decline"}
          </span>
        </div>
      </div>

      <style>{`
        @keyframes ringPulse {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        @keyframes dotBounce {
          0%, 100% { transform: translateY(0); opacity: 0.3; }
          50% { transform: translateY(-5px); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
