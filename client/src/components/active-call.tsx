import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useWebRTC } from "@/hooks/use-webrtc";
import { useCallRingtone } from "@/hooks/use-call-ringtone";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { PhoneOff, Mic, MicOff, Volume2, VolumeX, Camera, CameraOff, Loader2, WifiOff, AlertTriangle } from "lucide-react";

// Duration in seconds for each call stage.
// stage 0 = first voice call (10 min), stage 1 = second voice call (15 min),
// stage 3 = face call (10 min). All others default to 10 min.
const CALL_DURATIONS_SEC: Record<number, number> = { 0: 10 * 60, 1: 15 * 60, 3: 10 * 60 };
function getStageDuration(callStage: number): number {
  return CALL_DURATIONS_SEC[callStage] ?? 10 * 60;
}

type WarningLevel = "none" | "two_min" | "one_min" | "ten_sec";
interface CountdownState { display: string; remaining: number; warning: WarningLevel }

function useCountdownTimer(running: boolean, totalSeconds: number): CountdownState {
  const [remaining, setRemaining] = useState(totalSeconds);

  // Reset to full duration whenever the call type changes or the call starts
  useEffect(() => { setRemaining(totalSeconds); }, [totalSeconds]);

  useEffect(() => {
    if (!running || remaining <= 0) return;
    const interval = setInterval(() => {
      setRemaining(r => (r <= 1 ? 0 : r - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [running, remaining <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const display = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const warning: WarningLevel =
    remaining <= 10 ? "ten_sec" :
    remaining <= 60 ? "one_min" :
    remaining <= 120 ? "two_min" : "none";

  return { display, remaining, warning };
}

interface ActiveCallProps {
  matchId: string;
  callSessionId: string;
  userId: string;
  isCaller: boolean;
  isVideo: boolean;
  isRinging: boolean;
  callerName: string;
  callerPhoto?: string;
  callStage: number;
  onCallEnd: () => void;
}

function ControlButton({
  onClick,
  label,
  active,
  icon,
  disabled = false,
  testId,
}: {
  onClick: () => void;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        className={`w-14 h-14 rounded-full flex items-center justify-center active:scale-95 transition-all shadow-md disabled:opacity-40 ${active ? "bg-white/35" : "bg-white/10"}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      >
        {icon}
      </button>
      <span className="text-white/50 text-xs">{label}</span>
    </div>
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
  callStage,
  onCallEnd,
}: ActiveCallProps) {
  const queryClient = useQueryClient();
  const endedRef = useRef(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [failureReason, setFailureReason] = useState<string>("");
  const [timerExpiredMsg, setTimerExpiredMsg] = useState("");
  // Track exactly when WebRTC first reached "connected" so we can measure live duration
  const connectedAtRef = useRef<number | null>(null);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // Route audio to speaker or earpiece when the toggle changes.
  // setSinkId is supported in Chrome/Edge/Android; silently ignored on iOS Safari.
  useEffect(() => {
    const el = remoteAudioRef.current as any;
    if (!el || typeof el.setSinkId !== "function") return;
    if (speakerOn) {
      // Route to the default loudspeaker output
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const speaker = devices.find(d => d.kind === "audiooutput" && /speaker|loudspeaker|headphone/i.test(d.label));
        el.setSinkId(speaker?.deviceId || "default").catch(() => {});
      }).catch(() => { el.setSinkId("default").catch(() => {}); });
    } else {
      // Route to earpiece / communications device (empty string = system default = earpiece on mobile)
      el.setSinkId("").catch(() => {});
    }
  }, [speakerOn]);

  // WebRTC only starts when call is answered (not while ringing/waiting)
  const webrtcEnabled = !isRinging;

  // Stable remote-hangup ref so finishCall (defined below) can be called
  // from useWebRTC without circular dep issues. Updated after finishCall is defined.
  const finishCallRef = useRef<((reason: string) => void) | null>(null);
  const stableRemoteHangup = useCallback(() => {
    console.log("[CALL_UI] REMOTE_HANGUP_RECEIVED — ending call");
    finishCallRef.current?.("remote_hangup");
  }, []);

  const {
    localStream,
    remoteStream,
    connectionState,
    permissionDenied,
    isMuted,
    isCameraOff,
    toggleMute,
    toggleCamera,
    hangup,
  } = useWebRTC({
    matchId,
    userId,
    isCaller,
    isVideo,
    enabled: webrtcEnabled,
    onRemoteHangup: stableRemoteHangup,
  });

  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "requesting-media";
  const isReconnecting = connectionState === "reconnecting";
  const isFailed = connectionState === "failed";

  // Countdown timer — starts when WebRTC connects, counts down to 0 then auto-ends.
  const stageDuration = getStageDuration(callStage);
  const { display: countdownDisplay, remaining, warning } = useCountdownTimer(isConnected, stageDuration);

  const stageLabel = callStage === 0 ? "First call" : callStage === 1 ? "Second call" : "Face call";

  // Outgoing ringback tone: play only while the caller is waiting for an answer.
  // Stops automatically when isRinging becomes false (answered) or on unmount.
  useCallRingtone("outgoing", isRinging && isCaller);

  // Log overlay entry and WebRTC state changes
  useEffect(() => {
    console.log("[CALL_UI] OVERLAY_MOUNTED", {
      matchId,
      callSessionId,
      role: isCaller ? "caller" : "receiver",
      isRinging,
      webrtcEnabled,
      isVideo,
    });
  }, [matchId, callSessionId]);

  useEffect(() => {
    if (!webrtcEnabled) return;
    console.log("[WebRTC] CONNECTION_STATE_CHANGED", { matchId, connectionState, isCaller, isVideo });
    if (connectionState === "connected") {
      // Record the first moment we were live — used to compute connectedDurationMs in finishCall
      if (connectedAtRef.current === null) {
        connectedAtRef.current = Date.now();
        console.log("[CALL_UI] CALL_STATE:connected", { matchId, callSessionId, isCaller, timestamp: connectedAtRef.current });
      }
    } else if (connectionState === "failed") {
      console.error("[CALL_UI] CALL_STATE:failed", { matchId, callSessionId, isCaller, hadConnection: connectedAtRef.current !== null });
    } else if (connectionState === "reconnecting") {
      console.warn("[CALL_UI] CALL_STATE:reconnecting", { matchId, callSessionId, connectedDurationSoFar: connectedAtRef.current ? Date.now() - connectedAtRef.current : 0 });
    }
  }, [connectionState, webrtcEnabled]);

  // ── Auto-end when countdown reaches 0 ────────────────────────────────────────
  // Only fire when we're actively connected (not ringing/connecting) and the
  // call hasn't already been ended by some other path (endedRef guard).
  useEffect(() => {
    if (remaining === 0 && isConnected && !endedRef.current) {
      const completeMsg = callStage === 0
        ? "First call time completed"
        : callStage === 1
        ? "Second call time completed"
        : "Call time completed";
      setTimerExpiredMsg(completeMsg);
      console.log("[CALL_UI] TIMER_EXPIRED — auto-ending call", { matchId, callSessionId, callStage, stageDuration });
      // Brief delay so the user sees "Time's up" before the overlay closes
      const t = setTimeout(() => {
        finishCallRef.current?.("timer_expired");
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [remaining, isConnected, callStage, matchId, callSessionId, stageDuration]);

  // Auto-end call when connection fails — prevents restart loop on network recovery.
  // The "Connection failed" screen is shown for 10s so the failure reason is readable,
  // then finishCall cleans up server state, broadcasts call:ended to the peer,
  // and calls onCallEnd() so the overlay is dismissed and the call cannot re-trigger.
  useEffect(() => {
    if (!isFailed || !webrtcEnabled) return;
    // Extract the exact FAILURE_TRIGGER label from the on-screen log array
    const logs: string[] = (window as any).webrtcLogs ?? [];
    const triggerLine = [...logs].reverse().find(l => l.includes("FAILURE_TRIGGER"));
    if (triggerLine) {
      const match = triggerLine.match(/FAILURE_TRIGGER:\s*([^\s{(]+)/);
      setFailureReason(match ? match[1] : "unknown");
    } else {
      setFailureReason("unknown");
    }
    console.log("[CALL_UI] AUTO_END_SCHEDULED", { matchId, callSessionId, delayMs: 10000 });
    const t = setTimeout(() => {
      if (!endedRef.current) {
        console.log("[CALL_UI] AUTO_END_EXECUTING connection_failed", { matchId, callSessionId });
        finishCallRef.current?.("connection_failed");
      }
    }, 10000);
    return () => clearTimeout(t);
  }, [isFailed, webrtcEnabled, matchId, callSessionId]);

  // ── Remote stream → audio + video ────────────────────────────────────────
  // Audio comes ONLY from the hidden <audio> element (see JSX below).
  // The remote <video> element is explicitly muted so the same audio is
  // never played twice (double-audio would cause a chorus/echo effect and
  // confuse echo-cancellation in the peer's microphone path).
  //
  // isConnected is in deps so this re-runs when the <video> element mounts.
  // The <video> is conditionally rendered on (isVideo && isConnected && remoteStream),
  // so without isConnected in deps the effect would fire while the element is
  // still absent, find a null ref, and never re-fire when the element appears.
  //
  // Guard: compare track-ID sets before re-assigning srcObject so rapid
  // ontrack events (which create a new MediaStream wrapper each time) don't
  // cause unnecessary flicker or audio interruption.
  useEffect(() => {
    if (!remoteStream) return;

    // ── Audio element (always present; handles voice for both call types) ──
    if (remoteAudioRef.current) {
      const el = remoteAudioRef.current;
      const existing = el.srcObject as MediaStream | null;
      const existingIds = existing?.getTracks().map(t => t.id).sort().join(",") ?? "";
      const incomingIds = remoteStream.getTracks().map(t => t.id).sort().join(",");
      if (existingIds !== incomingIds) {
        el.srcObject = remoteStream;
        // Explicit .play() handles iOS Safari where autoPlay alone can be blocked
        // after srcObject assignment even when the audio context is already unlocked.
        el.play().catch(() => {});
        console.log("[WebRTC] REMOTE_AUDIO_ATTACHED", {
          matchId,
          audioTracks: remoteStream.getAudioTracks().length,
          videoTracks: remoteStream.getVideoTracks().length,
          trackIds: incomingIds,
        });
      } else {
        console.log("[WebRTC] REMOTE_AUDIO_SKIP: track set unchanged, not re-attaching", { matchId });
      }
    }

    // ── Video element (video calls only; muted — audio handled above) ──
    if (isVideo && remoteVideoRef.current) {
      const videoEl = remoteVideoRef.current;
      const existing = videoEl.srcObject as MediaStream | null;
      const existingIds = existing?.getTracks().map(t => t.id).sort().join(",") ?? "";
      const incomingIds = remoteStream.getTracks().map(t => t.id).sort().join(",");
      if (existingIds !== incomingIds) {
        videoEl.srcObject = remoteStream;
        videoEl.play().catch(() => {});
        console.log("[WebRTC] REMOTE_MAIN_VIDEO_ATTACHED", {
          matchId,
          videoTracks: remoteStream.getVideoTracks().length,
          audioTracks: remoteStream.getAudioTracks().length,
        });
      } else {
        console.log("[WebRTC] REMOTE_MAIN_VIDEO_SKIP: track set unchanged, not re-attaching", { matchId });
      }
    } else if (isVideo) {
      // Element not mounted yet — will be re-triggered when isConnected becomes true
      console.log("[WebRTC] REMOTE_MAIN_VIDEO_PENDING: element not yet mounted", { matchId, isConnected });
    }
  }, [remoteStream, isVideo, matchId, isConnected]);

  // ── Local stream → self-view pip ─────────────────────────────────────────
  // The local stream is NEVER routed to an audio element — only to this muted
  // video pip.  This is the only element that shows the user their own camera,
  // and it must be muted to prevent microphone feedback / self-monitoring.
  //
  // isConnected is in deps for the same reason as above (element is conditionally
  // rendered behind isConnected).  A reference-equality guard prevents redundant
  // srcObject reassignment when the component re-renders without a stream change.
  useEffect(() => {
    if (!localStream || !isVideo || !localVideoRef.current) return;
    const videoEl = localVideoRef.current;
    // Guard: skip if the exact same stream object is already attached
    if (videoEl.srcObject === localStream) {
      console.log("[WebRTC] LOCAL_SELF_VIEW_SKIP: same stream already attached", { matchId });
      return;
    }
    console.log("[WebRTC] LOCAL_AUDIO_PLAYBACK_BLOCKED: local mic is muted in self-view, no self-monitoring", { matchId });
    videoEl.srcObject = localStream;
    videoEl.play().catch(() => {});
    console.log("[WebRTC] LOCAL_SELF_VIEW_ATTACHED", {
      matchId,
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length,
      isConnected,
    });
  }, [localStream, isVideo, matchId, isConnected]);

  // Poll window.webrtcLogs every 500ms and show last 20 lines in the debug panel.
  // Only update state when the log count changes to avoid constant re-renders.
  const debugLogLenRef = useRef(0);
  useEffect(() => {
    const iv = setInterval(() => {
      const all = (window as any).webrtcLogs as string[] | undefined;
      if (all && all.length !== debugLogLenRef.current) {
        debugLogLenRef.current = all.length;
        setDebugLogs(all.slice(-20));
      }
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const finishCall = useCallback((reason: string = "user_hangup") => {
    if (endedRef.current) return;
    endedRef.current = true;

    const isCancelRinging = isRinging && isCaller;
    const endpoint = isCancelRinging
      ? `/api/matches/${matchId}/call/cancel`
      : `/api/matches/${matchId}/call/complete`;
    const signalType = isCancelRinging ? "call:cancelled" : "call:ended";

    // Compute how long WebRTC was actually live
    const connectedDurationMs = connectedAtRef.current ? Date.now() - connectedAtRef.current : 0;
    const connected = connectedDurationMs > 0;

    // Map reason to a clean call-state label for server-side logging.
    // "timer_expired" = call ran to full duration = counts as completed.
    const callState = reason === "connection_failed" ? "failed"
      : reason === "remote_hangup" ? "ended"
      : reason === "permission_denied" ? "failed"
      : reason === "caller_cancelled" ? "cancelled"
      : reason === "timer_expired" ? "ended"
      : "ended";

    console.log("[CALL_UI] CALL_STATE:ended", {
      matchId,
      callSessionId,
      userId,
      reason,
      callState,
      endpoint,
      connected,
      connectedDurationMs,
      webrtcConnectionState: connectionState,
    });
    console.log("[CALL_SESSION] CALL_STAGE_EXITED", { matchId, callSessionId, reason, connected, connectedDurationMs });

    // Hang up WebRTC before UI teardown
    if (webrtcEnabled) {
      hangup();
    }

    onCallEnd();

    broadcastCallSignal(matchId, {
      type: signalType as any,
      matchId,
      userId,
      callSessionId,
    } as any);

    // Only /call/complete receives connection quality data; /call/cancel gets no body
    const body = isCancelRinging ? undefined : { connected, connectedDurationMs, callState };

    apiRequest("POST", endpoint, body)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!data) return;
        const patch = {
          callStartedAt: data.callStartedAt ?? null,
          callInitiatorId: data.callInitiatorId ?? null,
          callAnswered: data.callAnswered ?? false,
          callCompleted: data.callCompleted ?? false,
          callSessionId: data.callSessionId ?? null,
          callStage: data.callStage,
          messageCount1: data.messageCount1,
          messageCount2: data.messageCount2,
        };
        queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((m: any) => m.id === matchId ? { ...m, ...patch } : m);
        });
        queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old) => {
          if (!old) return old;
          return { ...old, ...patch };
        });
        console.log("[CALL_UI] CALL_API_SUCCESS", {
          matchId, endpoint, reason, callState,
          newStage: data.callStage, callCounted: data.callCounted,
          connected, connectedDurationMs,
        });
      })
      .catch((e) => {
        // Overlay is already dismissed — don't show an error toast for user-initiated ends.
        // Log with full context so we can diagnose any server-side issues.
        console.error("[CALL_UI] CALL_API_ERROR", { matchId, endpoint, reason, callState, connected, connectedDurationMs, error: e.message });
        // Force a cache refresh so the match card reflects the true DB state
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
        queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
      });
  }, [matchId, callSessionId, userId, isCaller, isRinging, onCallEnd, queryClient, hangup, webrtcEnabled, connectionState]);

  // Keep finishCallRef pointing to latest finishCall
  finishCallRef.current = finishCall;

  // Show clear failed-connection screen
  if (isFailed && webrtcEnabled) {
    return (
      <div
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8"
        style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)" }}
        data-testid="overlay-call-failed"
      >
        <WifiOff className="w-14 h-14 text-red-400" />
        <div className="text-center space-y-2">
          <p className="text-white text-xl font-semibold">Connection failed</p>
          <p className="text-white/50 text-sm leading-relaxed">
            The call couldn't connect. This usually happens on mobile data or restricted Wi-Fi.
            Try moving to a better connection and starting a new call.
          </p>
          <p className="text-green-400 text-xs font-mono mt-1" data-testid="text-failure-reason">
            Failure reason: {failureReason || "detecting…"}
          </p>
        </div>
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
          onClick={() => finishCall("connection_failed")}
          data-testid="button-end-call-failed"
          aria-label="End call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
        <span className="text-white/30 text-xs">Tap to end (auto-closes in 10s)</span>
      </div>
    );
  }

  // Show clear permission-denied screen
  if (permissionDenied && webrtcEnabled) {
    return (
      <div
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8"
        style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)" }}
        data-testid="overlay-permission-denied"
      >
        <AlertTriangle className="w-14 h-14 text-amber-400" />
        <div className="text-center space-y-2">
          <p className="text-white text-xl font-semibold">
            {isVideo ? "Microphone & camera needed" : "Microphone access needed"}
          </p>
          <p className="text-white/50 text-sm leading-relaxed">
            {isVideo
              ? "Allow Lulou to use your microphone and camera to connect this call."
              : "Allow Lulou to use your microphone to connect this call."}
          </p>
          <p className="text-white/35 text-xs mt-1">
            Open your browser or device settings, allow access, then start the call again.
          </p>
        </div>
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
          onClick={() => finishCall("permission_denied")}
          data-testid="button-end-call-permission"
          aria-label="End call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
        <span className="text-white/30 text-xs">Tap to end call</span>
      </div>
    );
  }

  const statusLabel = (() => {
    if (isRinging) return isCaller ? "Ringing…" : "Connecting…";
    if (connectionState === "requesting-media") return isVideo ? "Starting camera…" : "Starting microphone…";
    if (connectionState === "connecting") return "Connecting…";
    if (connectionState === "reconnecting") return "Reconnecting…";
    if (isConnected) return remaining === 0 ? "00:00" : countdownDisplay;
    return "Connected";
  })();

  // Warning color for the countdown — escalates as time runs out
  const timerColor = warning === "ten_sec" ? "text-red-400"
    : warning === "one_min" ? "text-red-400"
    : warning === "two_min" ? "text-amber-400"
    : "text-white/80";

  const showSpinner = isRinging || isConnecting || isReconnecting;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)" }}
      data-testid="overlay-voice-call"
    >
      {/* Remote audio — always present so voice comes through even in video mode */}
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        style={{ display: "none" }}
        data-testid="audio-remote"
      />

      {/* Full-screen remote video (video calls only, once connected).
          muted=true: audio is handled exclusively by the hidden <audio> element
          above. Muting here prevents the remote voice from playing twice
          (once from this <video> and once from <audio>), which would cause a
          chorus/doubling effect and confuse the local echo-cancellation path. */}
      {isVideo && isConnected && remoteStream && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
          data-testid="video-remote"
        />
      )}

      {/* Local video pip (video calls, mirrored) */}
      {isVideo && isConnected && localStream && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-36 right-4 w-28 h-40 rounded-xl object-cover border-2 border-white/30 shadow-xl z-10"
          style={{ transform: "scaleX(-1)" }}
          data-testid="video-local"
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center gap-5 relative z-10 px-6">
        {/* Avatar — hidden when remote video is visible */}
        {(!isVideo || !isConnected) && (
          <div className="relative">
            <div
              className={`absolute inset-0 rounded-full ${isConnected ? "border-2 border-green-400/40 -inset-2" : "bg-white/10 animate-ping"}`}
              style={!isConnected ? { animationDuration: "2s" } : undefined}
            />
            <Avatar className="w-32 h-32 border-4 border-white/30">
              <AvatarImage src={callerPhoto} alt={callerName} />
              <AvatarFallback className="text-3xl bg-white/20 text-white">{callerName[0]}</AvatarFallback>
            </Avatar>
          </div>
        )}

        <h2 className="text-white text-2xl font-semibold drop-shadow-lg" data-testid="text-call-name">
          {callerName}
        </h2>

        {/* Timer-expired full-call notice */}
        {timerExpiredMsg ? (
          <div className="text-center space-y-1" data-testid="text-timer-expired">
            <p className="text-white text-xl font-semibold">{timerExpiredMsg}</p>
            <p className="text-white/50 text-sm">Ending call…</p>
          </div>
        ) : (
          <>
            {/* Stage label — shown only while connected */}
            {isConnected && !isRinging && (
              <p className="text-white/40 text-xs tracking-wide uppercase" data-testid="text-call-stage-label">
                {stageLabel}
              </p>
            )}

            {/* Countdown / status line */}
            <div className="flex items-center gap-2" data-testid="text-call-status">
              {showSpinner && <Loader2 className="w-4 h-4 text-white/60 animate-spin" />}
              <span
                className={`font-mono tabular-nums ${isConnected ? `${timerColor} text-4xl font-bold` : "text-white/55 text-sm"}`}
                data-testid="text-call-timer"
              >
                {statusLabel}
              </span>
            </div>

            {/* Time-remaining label while connected */}
            {isConnected && remaining > 0 && (
              <p className={`text-xs ${warning !== "none" ? timerColor : "text-white/40"}`} data-testid="text-call-remaining">
                {warning === "ten_sec"
                  ? "10 seconds remaining!"
                  : warning === "one_min"
                  ? "Less than a minute remaining"
                  : warning === "two_min"
                  ? "2 minutes remaining"
                  : `${Math.ceil(remaining / 60)} min remaining`}
              </p>
            )}
          </>
        )}

        {/* Warning banners */}
        {isConnected && warning === "two_min" && remaining > 60 && !timerExpiredMsg && (
          <div className="flex items-center gap-2 bg-amber-500/20 border border-amber-400/30 rounded-full px-4 py-1.5" data-testid="banner-two-min-warning">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-300 text-xs">2 minutes remaining</span>
          </div>
        )}
        {isConnected && warning === "one_min" && remaining > 10 && !timerExpiredMsg && (
          <div className="flex items-center gap-2 bg-red-500/20 border border-red-400/30 rounded-full px-4 py-1.5" data-testid="banner-one-min-warning">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span className="text-red-300 text-xs">Less than a minute remaining</span>
          </div>
        )}
        {isConnected && warning === "ten_sec" && !timerExpiredMsg && (
          <div className="flex items-center gap-2 bg-red-600/30 border border-red-500/50 rounded-full px-4 py-1.5 animate-pulse" data-testid="banner-ten-sec-warning">
            <AlertTriangle className="w-3.5 h-3.5 text-red-300" />
            <span className="text-red-200 text-xs font-medium">10 seconds remaining!</span>
          </div>
        )}

        {/* Weak-connection banner */}
        {isReconnecting && (
          <div className="flex items-center gap-2 bg-amber-500/20 border border-amber-400/30 rounded-full px-4 py-1.5 mt-1">
            <WifiOff className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-300 text-xs">Weak connection — reconnecting</span>
          </div>
        )}
      </div>

      {/* Controls + end button */}
      <div className="relative z-10 pb-12">
        {/* Mute / Speaker / Camera — only after the call is answered */}
        {!isRinging && (
          <div className="flex justify-center gap-8 mb-8">
            <ControlButton
              onClick={toggleMute}
              label={isMuted ? "Unmute" : "Mute"}
              active={isMuted}
              disabled={connectionState === "requesting-media"}
              icon={isMuted
                ? <MicOff className="w-6 h-6 text-white" />
                : <Mic className="w-6 h-6 text-white" />}
            />

            <ControlButton
              onClick={() => setSpeakerOn(s => !s)}
              label={speakerOn ? "Speaker On" : "Speaker"}
              active={speakerOn}
              testId="button-toggle-speaker"
              icon={speakerOn
                ? <Volume2 className="w-6 h-6 text-white" />
                : <Volume2 className="w-6 h-6 text-white opacity-50" />}
            />

            {isVideo && (
              <ControlButton
                onClick={toggleCamera}
                label={isCameraOff ? "Camera on" : "Hide cam"}
                active={isCameraOff}
                disabled={connectionState === "requesting-media"}
                icon={isCameraOff
                  ? <CameraOff className="w-6 h-6 text-white" />
                  : <Camera className="w-6 h-6 text-white" />}
              />
            )}
          </div>
        )}

        {/* End / Cancel button */}
        <div className="flex flex-col items-center gap-2">
          <button
            className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
            onClick={() => finishCall(isRinging && isCaller ? "caller_cancelled" : "user_hangup")}
            data-testid="button-end-call"
            aria-label={isRinging && isCaller ? "Cancel call" : "End call"}
          >
            <PhoneOff className="w-7 h-7 text-white" />
          </button>
          <span className="text-white/30 text-xs">
            {isRinging && isCaller ? "Cancel" : "End call"}
          </span>
        </div>
      </div>

      {/* WebRTC debug panel — live on-screen log viewer */}
      {debugLogs.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            maxHeight: "35vh",
            overflowY: "auto",
            background: "rgba(0,0,0,0.82)",
            color: "#00ff00",
            fontSize: "11px",
            fontFamily: "monospace",
            zIndex: 9000,
            padding: "4px 6px",
            boxSizing: "border-box",
            lineHeight: "1.4",
            // Never intercept pointer events — call controls must remain tappable.
            pointerEvents: "none",
          }}
          data-testid="webrtc-debug-panel"
        >
          {debugLogs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
