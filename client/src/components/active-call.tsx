import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useWebRTC } from "@/hooks/use-webrtc";
import { useCallRingtone } from "@/hooks/use-call-ringtone";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { PhoneOff, Mic, MicOff, Volume2, VolumeX, Camera, CameraOff, Loader2, WifiOff, AlertTriangle } from "lucide-react";

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

function useElapsedTimer(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const interval = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(interval);
  }, [running]);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function ControlButton({
  onClick,
  label,
  active,
  icon,
  disabled = false,
}: {
  onClick: () => void;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        className={`w-14 h-14 rounded-full flex items-center justify-center active:scale-95 transition-all shadow-md disabled:opacity-40 ${active ? "bg-white/35" : "bg-white/10"}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
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
  onCallEnd,
}: ActiveCallProps) {
  const queryClient = useQueryClient();
  const endedRef = useRef(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [failureReason, setFailureReason] = useState<string>("");
  // Track exactly when WebRTC first reached "connected" so we can measure live duration
  const connectedAtRef = useRef<number | null>(null);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

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
  const timerLabel = useElapsedTimer(isConnected);

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

  // Attach remote stream to audio element (voice calls) and video element.
  // Guard: only reassign srcObject when the track set actually changes so the
  // audio element is not interrupted mid-playback every time ontrack fires and
  // creates a new MediaStream wrapper around the same underlying tracks.
  useEffect(() => {
    if (!remoteStream) return;

    if (remoteAudioRef.current) {
      const el = remoteAudioRef.current;
      const existing = el.srcObject as MediaStream | null;
      const existingIds = existing?.getTracks().map(t => t.id).sort().join(",") ?? "";
      const incomingIds = remoteStream.getTracks().map(t => t.id).sort().join(",");
      if (existingIds !== incomingIds) {
        el.srcObject = remoteStream;
        console.log("[WebRTC] REMOTE_AUDIO_ATTACHED", {
          matchId,
          audioTracks: remoteStream.getAudioTracks().length,
          videoTracks: remoteStream.getVideoTracks().length,
          trackIds: incomingIds,
        });
      } else {
        console.log("[WebRTC] REMOTE_AUDIO_SKIP: track set unchanged, not re-attaching");
      }
    }

    if (isVideo && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
      console.log("[WebRTC] REMOTE_VIDEO_ATTACHED", { matchId });
    }
  }, [remoteStream, isVideo, matchId]);

  // Attach local stream to local video (mirrored preview for video calls).
  // Local stream is NEVER attached to an audio element — only to the muted
  // video pip — so there is no local mic playback / self-monitoring path.
  useEffect(() => {
    if (!localStream || !isVideo || !localVideoRef.current) return;
    localVideoRef.current.srcObject = localStream;
    console.log("[WebRTC] LOCAL_VIDEO_ATTACHED", {
      matchId,
      audioTracks: localStream.getAudioTracks().length,
      videoTracks: localStream.getVideoTracks().length,
    });
  }, [localStream, isVideo, matchId]);

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

    // Map reason to a clean call-state label for server-side logging
    const callState = reason === "connection_failed" ? "failed"
      : reason === "remote_hangup" ? "ended"
      : reason === "permission_denied" ? "failed"
      : reason === "caller_cancelled" ? "cancelled"
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
    if (isConnected) return timerLabel;
    return "Connected";
  })();

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

      {/* Full-screen remote video (video calls only, once connected) */}
      {isVideo && isConnected && remoteStream && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
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

        {/* Status line */}
        <div className="flex items-center gap-2" data-testid="text-call-status">
          {showSpinner && <Loader2 className="w-4 h-4 text-white/60 animate-spin" />}
          <span
            className={`font-mono tabular-nums ${isConnected ? "text-white/80 text-xl" : "text-white/55 text-sm"}`}
            data-testid="text-call-timer"
          >
            {statusLabel}
          </span>
        </div>

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
              label={speakerOn ? "Speaker" : "Earpiece"}
              active={speakerOn}
              icon={speakerOn
                ? <Volume2 className="w-6 h-6 text-white" />
                : <VolumeX className="w-6 h-6 text-white" />}
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
