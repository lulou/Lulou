import { useRef, useEffect, useState } from "react";
import { Phone, PhoneOff, Video, Bell } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useAuth } from "@/hooks/use-auth";
import type { Profile, Match } from "@shared/schema";
import { isCallSessionCancelled, markCallSessionCancelled } from "@/lib/cancelled-calls";
import { isArmedSession } from "@/lib/live-call-sessions";
import { useCallRingtone } from "@/hooks/use-call-ringtone";
import { cleanupCallAudio, isAudioUnlocked, onAudioUnlocked, unlockAudioNow } from "@/lib/call-audio";
import { calleePresubscribe, calleePresubSendReady } from "@/hooks/use-webrtc";
import { reportCallUiPaint, reportIncomingCallMounted } from "@/lib/call-availability-diagnostics";

type MatchWithProfile = Match & { profile: Profile };

type IncomingCallProps = {
  match: MatchWithProfile;
  isFaceCall: boolean;
  onDismiss: () => void;
  /** Called with the authoritative answered match so App can mount the live call immediately. */
  onAnswer?: (match: MatchWithProfile) => void;
};

export default function IncomingCallOverlay({ match, isFaceCall, onDismiss, onAnswer }: IncomingCallProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Role detection (debug) ─────────────────────────────────────────────────
  // IncomingCallOverlay should ONLY mount when the current user is the receiver.
  // App.tsx incomingCall filter already enforces callInitiatorId !== userId, so
  // isCaller should always be false here.  The debug bar below makes this
  // visible on-screen so role bugs are immediately obvious.
  const isCaller = match.callInitiatorId === user?.id;
  const isReceiver = !isCaller;
  const actedRef = useRef(false);

  useEffect(() => {
    if (match.callSessionId) reportIncomingCallMounted(match.callSessionId);
  }, [match.callSessionId]);

  useEffect(() => {
    if (!match.callSessionId) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const overlay = overlayRef.current;
        const rect = overlay?.getBoundingClientRect();
        const style = overlay ? getComputedStyle(overlay) : null;
        const centerElement = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        reportCallUiPaint(match.callSessionId!, "receiver", {
          attached: !!overlay?.isConnected,
          viewportSized: !!rect
            && rect.width >= window.innerWidth * 0.9
            && rect.height >= window.innerHeight * 0.9,
          centerOwned: !!overlay && !!centerElement && overlay.contains(centerElement),
          visible: !!style
            && style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0,
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [match.callSessionId]);

  // Slide-to-answer gesture refs — all imperative, zero React re-renders per pixel
  const sliderRef            = useRef<HTMLDivElement>(null); // outer track container
  const thumbRef             = useRef<HTMLDivElement>(null); // draggable green circle
  const trackFillRef         = useRef<HTMLDivElement>(null); // fill overlay
  const sliderActiveRef      = useRef(false);
  const sliderStartXRef      = useRef(0);
  const sliderCurrentXRef    = useRef(0);
  const sliderAnsweredRef    = useRef(false);               // one-way latch: prevent duplicate answer
  const sliderPointerIdRef   = useRef<number | null>(null);
  const sliderRafRef         = useRef(0);
  // Updated every render so the gesture effect always calls the freshest answerCall.mutate
  const answerLiveRef        = useRef<() => void>(() => {});

  // ── Pre-subscribe the WebRTC signalling channel (callee only) ───────────────
  // Subscribe call:${matchId} immediately when this overlay mounts so the channel
  // is SUBSCRIBED (or nearly there) by the time the callee taps Answer.
  // calleePresubSendReady() will send webrtc:ready on that already-live channel
  // the moment the answer API succeeds — no extra round-trip needed.
  // Returns a cleanup fn that removes the channel if the callee dismisses
  // without answering (decline / swipe away).
  useEffect(() => {
    if (!isReceiver || !user?.id || !match.callSessionId) return;
    console.log("[CALLEE_FIX] callee screen mounted — pre-subscribing signalling channel", {
      matchId: match.id,
      callSessionId: match.callSessionId,
    });
    const cleanup = calleePresubscribe(match.id, match.callSessionId, user.id);
    return cleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id, match.callSessionId]);

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
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/answer`, {
        callSessionId: match.callSessionId,
      });
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
      const data = await res.json();
      if (
        data?.callSessionId !== match.callSessionId ||
        !data?.callStartedAt ||
        data?.callCompleted === true ||
        !isArmedSession(match.callSessionId) ||
        isCallSessionCancelled(match.id, match.callSessionId)
      ) {
        console.error("[CALL_ANSWER] answer response no longer represents a live session", {
          matchId: match.id,
          expectedSessionId: match.callSessionId,
          responseSessionId: data?.callSessionId,
        });
        throw new Error("This call is no longer available");
      }
      return data;
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
      const answeredMatch: MatchWithProfile = {
        ...match,
        ...data,
        profile: match.profile,
        callAnswered: true,
      };
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
        return old.map(m => m.id === match.id ? { ...m, ...answeredMatch } : m);
      });
      queryClient.setQueriesData<MatchWithProfile>({ queryKey: ["/api/matches", match.id] }, old => {
        if (!old || Array.isArray(old)) return old;
        return { ...old, ...answeredMatch };
      });
      // Immediately send webrtc:ready on the pre-subscribed signalling channel.
      // The channel was subscribed when this overlay mounted (calleePresubscribe),
      // so the signal goes out without waiting for useWebRTC to mount and subscribe
      // — eliminating the main source of "Channel: idle / Ready sent: 0" delays.
      if (answeredMatch.callSessionId) {
        calleePresubSendReady(match.id, answeredMatch.callSessionId, user!.id);
      }
      // Notify App.tsx that the receiver has answered on this device so
      // matchForIncoming transitions to null and ActiveCallOverlay can mount.
      onAnswer?.(answeredMatch);
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
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {
        callSessionId: match.callSessionId,
      });
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
      const cleared = { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null };
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
        return old.map(m => m.id === match.id ? { ...m, ...cleared } : m);
      });
      queryClient.setQueriesData<any>({ queryKey: ["/api/matches", match.id] }, (old: any) => {
        if (!old || Array.isArray(old)) return old;
        return { ...old, ...cleared };
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id], exact: true });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
      console.log("[CALL_SESSION] DECLINE_CACHE_REFRESHED", {
        matchId: match.id,
        callSessionId: match.callSessionId,
        note: "detail + list patched immediately; both re-fetched to confirm server state",
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
      const cleared = { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null };
      queryClient.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, old => {
        if (!old || !Array.isArray(old)) return old;
        return old.map(m => m.id === match.id ? { ...m, ...cleared } : m);
      });
      queryClient.setQueriesData<any>({ queryKey: ["/api/matches", match.id] }, (old: any) => {
        if (!old || Array.isArray(old)) return old;
        return { ...old, ...cleared };
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id], exact: true });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
      toast({ title: "Call declined" });
      onDismiss();
    },
  });

  const isPending = answerCall.isPending || declineCall.isPending;

  // ringEnabled is a one-way latch — see comment above silenceRing() for why
  // we never use `!isPending` here.
  // Pass callSessionId so the armed-session guard in call-audio.ts can verify
  // this is a live ring before producing any audio.
  useCallRingtone("incoming", ringEnabled, match.callSessionId);

  // Refresh the live ref every render — gesture effect reads this, never the stale closure
  answerLiveRef.current = () => answerCall.mutate();

   // ── Slide-to-answer gesture ───────────────────────────────────────────────
   // Attached once on mount. All visual updates go directly to DOM via RAF —
   // no React state updates per pixel. Pointer events cover touch, mouse and
   // trackpad; the touch fallback keeps older iOS WebViews reliable.
  useEffect(() => {
    const thumb  = thumbRef.current;
    const slider = sliderRef.current;
    const fill   = trackFillRef.current;
    if (!thumb || !slider || !fill) return;

    const releasePointer = () => {
      const pointerId = sliderPointerIdRef.current;
      if (pointerId !== null && thumb.hasPointerCapture?.(pointerId)) {
        thumb.releasePointerCapture(pointerId);
      }
      sliderPointerIdRef.current = null;
    };

    const snapBack = () => {
      cancelAnimationFrame(sliderRafRef.current);
      sliderActiveRef.current   = false;
      sliderCurrentXRef.current = 0;
      releasePointer();
      thumb.style.transition = "transform 0.32s cubic-bezier(0.22,1,0.36,1)";
      fill.style.transition  = "width 0.32s cubic-bezier(0.22,1,0.36,1)";
      thumb.style.transform  = "translate3d(0, 0, 0)";
      fill.style.width       = "0%";
    };

    const doAnswer = () => {
      if (sliderAnsweredRef.current) return; // one-way latch
      sliderAnsweredRef.current = true;
      sliderActiveRef.current   = false;
      cancelAnimationFrame(sliderRafRef.current);
      const maxDx = Math.max(1, slider.offsetWidth - thumb.offsetWidth - 8);
      thumb.style.transition = "transform 0.15s ease-out";
      fill.style.transition  = "width 0.15s ease-out";
      thumb.style.transform  = `translate3d(${maxDx}px, 0, 0)`;
      fill.style.width       = "100%";
      answerLiveRef.current();
    };

     const begin = (clientX: number) => {
      if (sliderAnsweredRef.current) return;
      cancelAnimationFrame(sliderRafRef.current);
      thumb.style.transition = "none";
      fill.style.transition  = "none";
      sliderActiveRef.current   = true;
      sliderCurrentXRef.current = 0;
       sliderStartXRef.current   = clientX;
    };

     const move = (clientX: number) => {
      if (!sliderActiveRef.current || sliderAnsweredRef.current) return;
       const dx    = Math.max(0, clientX - sliderStartXRef.current);
      const maxDx = Math.max(1, slider.offsetWidth - thumb.offsetWidth - 8);
      const clamped = Math.min(dx, maxDx);
      sliderCurrentXRef.current = clamped;
      cancelAnimationFrame(sliderRafRef.current);
      sliderRafRef.current = requestAnimationFrame(() => {
        thumb.style.transform = `translate3d(${clamped}px, 0, 0)`;
        fill.style.width      = `${(clamped / maxDx) * 100}%`;
      });
    };

     const end = () => {
      if (!sliderActiveRef.current) return;
      const maxDx = Math.max(1, slider.offsetWidth - thumb.offsetWidth - 8);
      if (!sliderAnsweredRef.current && sliderCurrentXRef.current >= maxDx * 0.8) {
        doAnswer();
      } else {
        snapBack();
      }
    };

     const onPointerDown = (ev: PointerEvent) => {
       if (ev.pointerType === "mouse" && ev.button !== 0) return;
       ev.preventDefault();
       sliderPointerIdRef.current = ev.pointerId;
       thumb.setPointerCapture?.(ev.pointerId);
       begin(ev.clientX);
     };
     const onPointerMove = (ev: PointerEvent) => {
       if (!sliderActiveRef.current) return;
       ev.preventDefault();
       move(ev.clientX);
     };
     const onPointerUp = (ev: PointerEvent) => {
       if (sliderPointerIdRef.current === ev.pointerId) {
         thumb.releasePointerCapture?.(ev.pointerId);
         sliderPointerIdRef.current = null;
       }
       end();
     };
     const onTouchStart = (ev: TouchEvent) => {
       ev.preventDefault();
       begin(ev.touches[0].clientX);
     };
     const onTouchMove = (ev: TouchEvent) => {
       ev.preventDefault();
       move(ev.touches[0].clientX);
     };
     const onTouchEnd = () => end();

     // Pointer events are the single path in modern browsers. Registering
     // touch listeners only as a fallback avoids a double gesture on iOS.
     const supportsPointer = typeof window !== "undefined" && "PointerEvent" in window;
     if (supportsPointer) {
       thumb.addEventListener("pointerdown", onPointerDown);
       thumb.addEventListener("pointermove", onPointerMove);
       thumb.addEventListener("pointerup", onPointerUp);
      thumb.addEventListener("pointercancel", snapBack);
     } else {
       thumb.addEventListener("touchstart", onTouchStart, { passive: false });
       thumb.addEventListener("touchmove", onTouchMove, { passive: false });
       thumb.addEventListener("touchend", onTouchEnd);
       thumb.addEventListener("touchcancel", snapBack);
     }
    return () => {
      cancelAnimationFrame(sliderRafRef.current);
       releasePointer();
       if (supportsPointer) {
         thumb.removeEventListener("pointerdown", onPointerDown);
         thumb.removeEventListener("pointermove", onPointerMove);
         thumb.removeEventListener("pointerup", onPointerUp);
          thumb.removeEventListener("pointercancel", snapBack);
       } else {
         thumb.removeEventListener("touchstart", onTouchStart);
         thumb.removeEventListener("touchmove", onTouchMove);
         thumb.removeEventListener("touchend", onTouchEnd);
         thumb.removeEventListener("touchcancel", snapBack);
       }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const photo = match.profile.photos?.[0];

  return (
    <div
      ref={overlayRef}
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

      {/* Bottom action bar — slide-to-answer track + decline button.
          z-[99990]: above all overlays. position:fixed is viewport-relative on
          all iOS versions. bottom uses calc(env()+px) — supported since iOS 11.2. */}
      <div
        className="fixed left-0 right-0 z-[99990] flex flex-col items-center gap-5 px-8"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 32px)" }}
        data-testid="callee-button-bar"
      >
        {/* ── Slide-to-answer track ──
            The single horizontal control keeps the answer action deliberate:
            the thumb has a generous target, while the quiet track makes the
            direction and completion threshold obvious at a glance. */}
        <div
          ref={sliderRef}
          style={{
            position: "relative", width: "100%", maxWidth: 336,
            height: 72, borderRadius: 36,
            background: "linear-gradient(105deg, rgba(255,255,255,0.14), rgba(255,255,255,0.055))",
            border: "1px solid rgba(255,255,255,0.24)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 18px 42px rgba(0,0,0,0.18)",
            overflow: "hidden", userSelect: "none", touchAction: "pan-y",
          }}
          aria-label={isFaceCall ? "Slide to answer face call" : "Slide to answer audio call"}
          role="presentation"
        >
          {/* Track fill — grows as the thumb moves right */}
          <div
            ref={trackFillRef}
            style={{
              position: "absolute", top: 0, left: 0, bottom: 0, width: "0%",
               background: "linear-gradient(90deg, hsl(142 58% 38% / 0.32), hsl(142 66% 52% / 0.7))",
              borderRadius: 32, pointerEvents: "none",
            }}
          />
          {/* "slide to answer" label — centred, offset right of thumb */}
          <span style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
             paddingLeft: 76, paddingRight: 16,
             color: "rgba(255,255,255,0.58)", fontSize: 12,
             fontWeight: 600, letterSpacing: "0.13em", pointerEvents: "none",
            userSelect: "none", whiteSpace: "nowrap",
          }}>
             SLIDE TO ANSWER
          </span>
          {/* Draggable thumb — touch-action:none so iOS delivers all touches here */}
          <div
            ref={thumbRef}
            style={{
               position: "absolute", left: 5, top: 5,
               width: 62, height: 62, borderRadius: "50%",
               background: "linear-gradient(145deg, hsl(142 70% 51%), hsl(142 65% 34%))",
               border: "2px solid hsl(142 72% 72%)",
               boxShadow: "0 5px 22px hsl(142 70% 24% / 0.7), inset 0 1px 0 hsl(0 0% 100% / 0.28)",
              display: "flex", alignItems: "center", justifyContent: "center",
               touchAction: "none", cursor: "grab", zIndex: 1,
            }}
          >
            {isFaceCall
              ? <Video style={{ width: 22, height: 22, color: "white", flexShrink: 0 }} />
              : <Phone style={{ width: 22, height: 22, color: "white", flexShrink: 0 }} />}
          </div>
           {/* Keyboard and assistive-technology answer path. The visual thumb
               owns pointer gestures; this remains a real, focusable button. */}
          <button
             className="sr-only"
            aria-label={isFaceCall ? "Answer face call" : "Answer audio call"}
            tabIndex={0}
             onClick={() => answerLiveRef.current()}
            data-testid="button-answer-call"
          />
        </div>

        {/* ── Decline button ── */}
        <div className="flex flex-col items-center gap-2.5" data-testid="incoming-call-actions">
          <button
            className="w-[68px] h-[68px] rounded-full flex items-center justify-center active:scale-90 transition-transform"
            style={{
              background: "hsl(0 60% 30%)",
              border: "2px solid hsl(0 60% 55%)",
              boxShadow: "0 6px 28px hsl(0 60% 40% / 0.5), inset 0 1px 0 hsl(0 0% 100% / 0.08)",
            }}
            onClick={() => { silenceRing(); declineCall.mutate(); }}
            data-testid="button-decline-call"
          >
            <PhoneOff className="w-7 h-7 text-white" />
          </button>
          <span className="text-white/60 text-xs tracking-wide">
            {declineCall.isPending ? "Declining…" : "Decline"}
          </span>
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
