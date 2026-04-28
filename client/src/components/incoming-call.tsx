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
import { useCallRingtone } from "@/hooks/use-call-ringtone";

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
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
        return old.map(m => m.id === match.id ? { ...m, callAnswered: true } : m);
      });
      onDismiss();
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_ANSWER_FAILED", { matchId: match.id, error: error.message });
      markCallSessionCancelled(match.id, match.callSessionId);
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
        return old.map(m =>
          m.id === match.id
            ? { ...m, callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null }
            : m
        );
      });
      toast({ title: "Couldn't connect", description: error.message, variant: "destructive" });
      onDismiss();
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
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
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
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      console.error("[CALL_UI] CALL_DECLINE_FAILED", { matchId: match.id, error: error.message, isAuth });
      if (isAuth) {
        actedRef.current = false;
        toast({ title: "Session expired", description: "Please refresh and try again.", variant: "destructive" });
        return;
      }
      markCallSessionCancelled(match.id, match.callSessionId);
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
        callSessionId: match.callSessionId,
      } as any);
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
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

  useCallRingtone("incoming", !isPending);

  const photo = match.profile.photos?.[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden"
      data-testid="incoming-call-overlay"
    >
      {/* Blurred photo background or gradient fallback */}
      {photo ? (
        <>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${photo})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "blur(28px) brightness(0.35) saturate(1.4)",
              transform: "scale(1.1)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(180deg, hsl(350 45% 12% / 0.55) 0%, hsl(350 45% 8% / 0.85) 100%)" }}
          />
        </>
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(160deg, hsl(350 45% 18%) 0%, hsl(350 40% 10%) 60%, hsl(350 30% 6%) 100%)" }}
        />
      )}

      {/* Ambient glow rings */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <div
          className="absolute rounded-full border border-primary/20 animate-ping"
          style={{ width: 280, height: 280, animationDuration: "2.4s" }}
        />
        <div
          className="absolute rounded-full border border-primary/10 animate-ping"
          style={{ width: 380, height: 380, animationDuration: "3.2s", animationDelay: "0.4s" }}
        />
        <div
          className="absolute rounded-full border border-white/5 animate-ping"
          style={{ width: 480, height: 480, animationDuration: "4s", animationDelay: "0.8s" }}
        />
      </div>

      {/* Top label */}
      <div className="relative z-10 flex flex-col items-center pt-16 pb-4">
        <p className="text-white/35 text-[10px] tracking-[0.3em] uppercase font-medium">
          {isFaceCall ? "Incoming face call" : "Incoming call"}
        </p>
      </div>

      {/* Centre — caller info */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-5">
        {/* Avatar with ring pulse */}
        <div className="relative flex items-center justify-center">
          {/* Outer glow ring */}
          <div
            className="absolute rounded-full"
            style={{
              inset: -18,
              background: "radial-gradient(circle, hsl(350 45% 52% / 0.18) 0%, transparent 70%)",
              animation: "incomingGlow 2s ease-in-out infinite",
            }}
          />
          {/* Ring pulse */}
          <div
            className="absolute rounded-full border-2 border-primary/40"
            style={{ inset: -8, animation: "incomingRing 1.6s ease-out infinite" }}
          />
          <Avatar className="w-[148px] h-[148px] border-[3px] shadow-2xl" style={{ borderColor: "hsl(350 45% 52% / 0.5)" }}>
            {photo ? <AvatarImage src={photo} alt={match.profile.firstName} /> : null}
            <AvatarFallback className="text-5xl font-serif" style={{ background: "hsl(350 45% 25%)", color: "hsl(350 45% 85%)" }}>
              {match.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          {/* Call type badge */}
          <div
            className="absolute -bottom-2 -right-2 w-10 h-10 rounded-full flex items-center justify-center shadow-lg border-2 border-white/10"
            style={{ background: isFaceCall ? "hsl(250 60% 50%)" : "hsl(350 45% 52%)" }}
          >
            {isFaceCall ? (
              <Video className="w-4.5 h-4.5 text-white" style={{ width: 18, height: 18 }} />
            ) : (
              <Phone className="w-4.5 h-4.5 text-white" style={{ width: 18, height: 18 }} />
            )}
          </div>
        </div>

        {/* Name */}
        <div className="text-center space-y-1">
          <h2 className="text-white font-serif text-4xl font-bold tracking-tight drop-shadow-lg" data-testid="text-incoming-caller-name">
            {match.profile.firstName}
          </h2>
          {(match.profile.age || match.profile.location) && (
            <p className="text-white/45 text-sm">
              {[match.profile.age, match.profile.location].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {/* Animated waveform dots */}
        <div className="flex items-end gap-1.5 h-6">
          {[0, 0.15, 0.3, 0.15, 0].map((delay, i) => (
            <div
              key={i}
              className="w-1 rounded-full"
              style={{
                background: "hsl(350 45% 65%)",
                animation: `waveDot 1.1s ease-in-out ${delay}s infinite`,
                height: i === 2 ? 20 : i === 1 || i === 3 ? 14 : 8,
              }}
            />
          ))}
        </div>
      </div>

      {/* Bottom — action buttons */}
      <div className="relative z-10 flex flex-col items-center gap-10 pb-20">
        <div className="flex items-center justify-center gap-20" data-testid="incoming-call-actions">
          {/* Decline */}
          <div className="flex flex-col items-center gap-3">
            <button
              className="w-[72px] h-[72px] rounded-full flex items-center justify-center active:scale-90 transition-transform disabled:opacity-50"
              style={{
                background: "hsl(0 60% 25% / 0.6)",
                backdropFilter: "blur(12px)",
                border: "1.5px solid hsl(0 60% 50% / 0.4)",
                boxShadow: "0 6px 28px hsl(0 60% 40% / 0.35), inset 0 1px 0 hsl(0 0% 100% / 0.08)",
              }}
              onClick={() => { if (!isPending) declineCall.mutate(); }}
              disabled={isPending}
              data-testid="button-decline-call"
            >
              <PhoneOff className="w-7 h-7 text-red-300" />
            </button>
            <span className="text-white/40 text-xs tracking-wide">
              {declineCall.isPending ? "Declining…" : "Decline"}
            </span>
          </div>

          {/* Answer */}
          <div className="flex flex-col items-center gap-3">
            <button
              className="w-[88px] h-[88px] rounded-full flex items-center justify-center active:scale-90 transition-transform disabled:opacity-50"
              style={{
                background: "linear-gradient(145deg, hsl(145 60% 38%), hsl(145 60% 28%))",
                boxShadow: "0 6px 32px hsl(145 60% 35% / 0.55), inset 0 1px 0 hsl(0 0% 100% / 0.15)",
                border: "1.5px solid hsl(145 60% 55% / 0.3)",
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
            <span className="text-white/50 text-xs tracking-wide">
              {answerCall.isPending ? "Connecting…" : "Answer"}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes incomingRing {
          0% { transform: scale(1); opacity: 0.7; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        @keyframes incomingGlow {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.08); }
        }
        @keyframes waveDot {
          0%, 100% { transform: scaleY(0.5); opacity: 0.35; }
          50% { transform: scaleY(1); opacity: 0.85; }
        }
      `}</style>
    </div>
  );
}
