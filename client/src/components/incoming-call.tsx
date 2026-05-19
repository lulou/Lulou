import { useRef, useEffect, useState } from "react";
import { Phone, PhoneOff, Video, Bell } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useAuth } from "@/hooks/use-auth";
import type { Profile, Match } from "@shared/schema";
import { markCallSessionCancelled } from "@/lib/cancelled-calls";
import { useCallRingtone } from "@/hooks/use-call-ringtone";
import { cleanupCallAudio, isAudioUnlocked, onAudioUnlocked, unlockAudioNow } from "@/lib/call-audio";

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

  // ── Role detection (debug) ─────────────────────────────────────────────────
  // IncomingCallOverlay should ONLY mount when the current user is the receiver.
  // App.tsx incomingCall filter already enforces callInitiatorId !== userId, so
  // isCaller should always be false here.  The debug bar below makes this
  // visible on-screen so role bugs are immediately obvious.
  const isCaller = match.callInitiatorId === user?.id;
  const isReceiver = !isCaller;
  const actedRef = useRef(false);

  // ── Ringtone gate ──────────────────────────────────────────────────────────
  // IMPORTANT: must NOT use `!isPending` here.
  //
  // `isPending` is false → true (ring stops ✓) → false again when the mutation
  // resolves, but the component hasn't unmounted yet.  That one render cycle
  // where isPending drops back to false restarts the AudioContext oscillators
  // while the WebRTC microphone is already active — those 440/480 Hz tones get
  // captured by the mic and transmitted to the caller as "ringing noise".
  //
  // `ringEnabled` is a one-way latch: it flips to false the instant a button is
  // pressed and never goes back to true, so the ringtone stops exactly once and
  // stays stopped regardless of mutation state or re-renders.
  const [ringEnabled, setRingEnabled] = useState(true);
  // showRingBanner: true when audio is locked on mobile and user needs to tap to enable ringtone.
  // Starts as !isAudioUnlocked() — false on desktop (already unlocked), true on a cold mobile session.
  const [showRingBanner, setShowRingBanner] = useState(!isAudioUnlocked());

  // When audio unlocks (any gesture anywhere) hide the banner automatically.
  // onAudioUnlocked fires synchronously if already unlocked (cold→warm transition).
  useEffect(() => {
    const unsub = onAudioUnlocked(() => setShowRingBanner(false));
    return unsub;
  }, []);

  // Vibration — immediate tactile fallback; does not require audio unlock.
  // Works on Android; silently no-ops on iOS (navigator.vibrate not supported).
  useEffect(() => {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([400, 200, 400, 1500, 400, 200, 400]);
      }
    } catch { /* non-fatal */ }
  }, []);

  // Silence the ring immediately — called before any mutation fires.
  // cleanupCallAudio() is called SYNCHRONOUSLY here (before the state update
  // is batched) so the AudioContext oscillators are zeroed right now, not on
  // the next React render.  This prevents the mic (which opens in
  // ActiveCallOverlay a few frames later) from ever capturing the tone.
  const silenceRing = () => {
    if (!ringEnabled) return;
    cleanupCallAudio("incoming_ring_silenced");
    console.log("[CALL_RINGTONE] SILENCED by user action — will not restart", {
      matchId: match.id,
      callSessionId: match.callSessionId,
    });
    console.log("[CALL_DEBUG] RING_SILENCED: user pressed a call button", {
      matchId: match.id,
      callSessionId: match.callSessionId,
    });
    setRingEnabled(false);
  };

  useEffect(() => {
    console.log("[CALL_UI] INCOMING_CALL_SHOWN", {
      matchId: match.id,
      callerId: match.callInitiatorId,
      receiverId: user?.id,
      callerName: match.profile.firstName,
      callSessionId: match.callSessionId,
    });
    console.log("[CALL_RINGTONE] INCOMING_OVERLAY_MOUNTED: ringtone will start (ringEnabled=true)", {
      matchId: match.id,
      callSessionId: match.callSessionId,
    });
    console.log("[CALL_DEBUG] INCOMING_CALL: overlay mounted, ringtone starting immediately", {
      matchId: match.id,
      callerName: match.profile.firstName,
    });
  }, [match.id, match.callSessionId]);

  // Lock body scroll while overlay is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const answerCall = useMutation({
    mutationFn: async () => {
      // ── [CALL_ANSWER] green button clicked ────────────────────────────────
      console.log("[CALL_CONNECT] answer clicked", { matchId: match.id, callSessionId: match.callSessionId, ts: new Date().toISOString() });
      console.log("[CALL_ANSWER] GREEN_BUTTON_CLICKED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user?.id,
        role: "receiver",
        ringEnabled,
        actedAlready: actedRef.current,
        ts: new Date().toISOString(),
      });
      silenceRing();
      console.log("[CALL_ANSWER] ring_silenced", { matchId: match.id });
      if (actedRef.current) {
        console.error("[CALL_ANSWER] ALREADY_ACTED — duplicate button press, throwing", { matchId: match.id });
        throw new Error("already_acted");
      }
      actedRef.current = true;
      const acceptedAt = new Date().toISOString();
      console.log("[CALL_TIMING] ACCEPT_PRESSED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user?.id,
        ts: acceptedAt,
      });
      console.log("[CALL_UI] CALL_ANSWERED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        userId: user?.id,
        role: "receiver",
        source: "incoming_overlay",
      });
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, role: "receiver" });
      console.log("[CALL_ANSWER] calling_answer_api", { matchId: match.id, callSessionId: match.callSessionId, ts: new Date().toISOString() });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/answer`, {});
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
        console.error("[CALL_ANSWER] FAILURE_REASON: answer API failed", {
          matchId: match.id,
          status: res.status,
          body,
        });
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      console.log("[CALL_TIMING] ANSWER_API_OK", { matchId: match.id, callSessionId: match.callSessionId, ts: new Date().toISOString() });
      console.log("[CALL_ANSWER] answer_api_ok", { matchId: match.id, status: res.status, ts: new Date().toISOString() });
      return await res.json();
    },
    onSuccess: (data) => {
      console.log("[CALL_ANSWER] onSuccess_start — broadcasting call:answered and updating cache", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        responseData: data,
        ts: new Date().toISOString(),
      });
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
      console.log("[CALL_ANSWER] cache_updated_callAnswered_true — calling onDismiss", {
        matchId: match.id,
        ts: new Date().toISOString(),
      });
      onDismiss();
      console.log("[CALL_ANSWER] onDismiss_called — IncomingCallOverlay will unmount, ActiveCallOverlay should mount", {
        matchId: match.id,
        ts: new Date().toISOString(),
      });
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_ANSWER_FAILED", { matchId: match.id, error: error.message });
      console.error("[CALL_ANSWER] FAILURE_REASON: answer mutation error", { matchId: match.id, error: error.message });
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
      silenceRing();
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
        // Reset actedRef so the user can retry, but keep ringEnabled=false —
        // restarting the ringtone here while the mic may be active would cause
        // the oscillator tones to leak into the WebRTC audio path.
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

  // ringEnabled is a one-way latch — see comment above silenceRing() for why
  // we never use `!isPending` here.
  useCallRingtone("incoming", ringEnabled);

  const photo = match.profile.photos?.[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      data-testid="incoming-call-overlay"
    >
      {/* Blurred photo background or gradient fallback — isolated in their own
          overflow-hidden wrapper so transform:scale(1.1) cannot expand the
          outer flex container and push action buttons off-screen. */}
      <div className="absolute inset-0 overflow-hidden">
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
      </div>

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

      {/* ── DEBUG BAR (temporary) ── */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: "rgba(0,0,0,0.88)",
          color: "#fff",
          fontSize: 12,
          fontFamily: "monospace",
          padding: "8px 12px",
          textAlign: "center",
          lineHeight: 1.8,
          pointerEvents: "none",
        }}
      >
        <div>currentUserId: <b>{user?.id ?? "null"}</b></div>
        <div>callInitiatorId: <b>{match.callInitiatorId ?? "null"}</b></div>
        <div>
          isReceiver:{" "}
          <b style={{ color: isReceiver ? "#4ade80" : "#f87171", fontSize: 14 }}>
            {String(isReceiver)}
          </b>
          {isCaller && (
            <span style={{ color: "#f87171", marginLeft: 8 }}>
              ⚠ WRONG COMPONENT — caller should not see IncomingCallOverlay
            </span>
          )}
        </div>
      </div>
      {/* ── END DEBUG BAR ── */}

      {/* Top label */}
      <div className="relative z-10 flex flex-col items-center pt-16 pb-4">
        <p className="text-white/35 text-[10px] tracking-[0.3em] uppercase font-medium">
          {isFaceCall ? "Incoming face call" : "Incoming call"}
        </p>
      </div>

      {/* Centre — caller info.
          min-h-0 lets flex-1 shrink below content size.
          paddingBottom reserves space for the absolutely-positioned
          action buttons so the avatar/name never overlap them. */}
      <div className="relative z-10 flex-1 min-h-0 flex flex-col items-center justify-center gap-5"
           style={{ paddingBottom: 160 }}>
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

      {/* Mobile ring banner — shown only when audio is locked (cold mobile session) */}
      {showRingBanner && (
        <div className="relative z-10 flex justify-center px-6 pb-2">
          <button
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium"
            style={{
              background: "hsl(350 45% 52% / 0.25)",
              backdropFilter: "blur(12px)",
              border: "1px solid hsl(350 45% 65% / 0.4)",
              color: "hsl(350 30% 90%)",
            }}
            onClick={() => {
              unlockAudioNow();
              setShowRingBanner(false);
            }}
            data-testid="button-enable-ringtone"
          >
            <Bell className="w-4 h-4" />
            Tap to enable ringtone
          </button>
        </div>
      )}

      {/* Bottom — action buttons.
          position:fixed (not absolute) is always viewport-relative on every iOS
          version, even when document.body.style.overflow="hidden" is set.
          With absolute+fixed parent, iOS Safari resolves the offset against the
          document body (not the viewport), pushing buttons off-screen.
          fixed bypasses that bug entirely.
          z-[110] keeps buttons above the z-[100] overlay on all devices.
          bottom uses calc(env() + px) — supported since iOS 11.2, no max() needed. */}
      <div
        className="fixed left-0 right-0 z-[110] flex flex-col items-center"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 40px)" }}
      >
        <div className="flex items-center justify-center gap-20" data-testid="incoming-call-actions">

          {/* ── DECLINE button (red) ── */}
          <div className="flex flex-col items-center gap-3">
            <button
              className="w-[72px] h-[72px] rounded-full flex items-center justify-center active:scale-90 transition-transform"
              style={{
                background: "hsl(0 60% 30%)",
                border: "2px solid hsl(0 60% 55%)",
                boxShadow: "0 6px 28px hsl(0 60% 40% / 0.5), inset 0 1px 0 hsl(0 0% 100% / 0.08)",
              }}
              onClick={() => declineCall.mutate()}
              data-testid="button-decline-call"
            >
              <PhoneOff className="w-7 h-7 text-white" />
            </button>
            <span className="text-white/60 text-xs tracking-wide">
              {declineCall.isPending ? "Declining…" : "Decline"}
            </span>
          </div>

          {/* ── ANSWER button (green) — ALWAYS rendered, no conditions ── */}
          {/* isCaller is logged here; should always be false in IncomingCallOverlay */}
          {(() => {
            console.log("[CALL_UI] rendering incoming answer button", {
              matchId: match.id,
              callSessionId: match.callSessionId,
              isFaceCall,
              isCaller,
              isReceiver,
              initiatorId: match.callInitiatorId?.slice(0, 8),
              myId: user?.id?.slice(0, 8),
            });
            return null;
          })()}
          <div className="flex flex-col items-center gap-3">
            <button
              className="w-[92px] h-[92px] rounded-full flex items-center justify-center active:scale-90 transition-transform"
              style={{
                background: "linear-gradient(145deg, hsl(142 70% 45%), hsl(142 70% 32%))",
                border: "2.5px solid hsl(142 70% 62%)",
                boxShadow: "0 0 0 6px hsl(142 70% 45% / 0.18), 0 8px 36px hsl(142 70% 40% / 0.7), inset 0 1px 0 hsl(0 0% 100% / 0.2)",
              }}
              onClick={() => answerCall.mutate()}
              data-testid="button-answer-call"
            >
              {isFaceCall ? (
                <Video className="w-9 h-9 text-white" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))" }} />
              ) : (
                <Phone className="w-9 h-9 text-white" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))" }} />
              )}
            </button>
            <span className="text-white/70 text-xs tracking-wide">
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
