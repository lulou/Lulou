import { useState, useEffect, useRef, useCallback } from "react";
import { useWebRTC, type WebRTCState } from "@/hooks/use-webrtc";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Loader2, WifiOff, ShieldAlert, RefreshCw } from "lucide-react";

interface ActiveCallProps {
  matchId: string;
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
  userId,
  isCaller,
  isVideo,
  isRinging,
  callerName,
  callerPhoto,
  onCallEnd,
}: ActiveCallProps) {
  const queryClient = useQueryClient();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const endedRef = useRef(false);

  const finishCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    console.log("[ActiveCall] Finishing call:", { matchId, isRinging });
    onCallEnd();
    const endpoint = isRinging
      ? `/api/matches/${matchId}/call/cancel`
      : `/api/matches/${matchId}/call/complete`;
    const signalType = isRinging ? "call:cancelled" : "call:completed";
    broadcastCallSignal(matchId, {
      type: signalType as any,
      matchId,
      userId,
    });
    apiRequest("POST", endpoint).catch((e) => {
      console.error("[ActiveCall] Failed to update server:", e);
    }).finally(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
    });
  }, [matchId, userId, isRinging, onCallEnd, queryClient]);

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
    enabled: true,
    onRemoteHangup: finishCall,
  });

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteStream) {
      if (isVideo && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    }
  }, [remoteStream, isVideo]);

  const handleEndCall = useCallback(() => {
    hangup();
    finishCall();
  }, [hangup, finishCall]);

  if (permissionDenied) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 to-black" data-testid="overlay-permission-denied">
        <ShieldAlert className="w-16 h-16 text-red-400 mb-6" />
        <h2 className="text-white text-xl font-semibold mb-3 text-center px-8">
          {isVideo ? "Camera & Microphone Access Required" : "Microphone Access Required"}
        </h2>
        <p className="text-white/60 text-center px-12 mb-8 text-sm leading-relaxed">
          {isVideo
            ? "To make video calls, please allow access to your camera and microphone in your browser settings."
            : "To make voice calls, please allow access to your microphone in your browser settings."}
        </p>
        <p className="text-white/40 text-center px-12 mb-8 text-xs">
          Check your browser's address bar for a blocked permission icon, or go to Settings &gt; Privacy &gt; Permissions.
        </p>
        <button
          className="px-6 py-3 rounded-full bg-red-600 text-white font-medium active:scale-95 transition-all"
          onClick={handleEndCall}
          data-testid="button-close-permission"
        >
          Close
        </button>
      </div>
    );
  }

  if (connectionState === "failed" && !isRinging) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 to-black" data-testid="overlay-connection-failed">
        <WifiOff className="w-16 h-16 text-orange-400 mb-6" />
        <h2 className="text-white text-xl font-semibold mb-3">Connection Failed</h2>
        <p className="text-white/60 text-center px-12 mb-8 text-sm">
          Unable to establish a connection. This may be due to network issues.
        </p>
        <button
          className="px-6 py-3 rounded-full bg-red-600 text-white font-medium active:scale-95 transition-all"
          onClick={handleEndCall}
          data-testid="button-close-failed"
        >
          End Call
        </button>
      </div>
    );
  }

  const statusLabel = isRinging
    ? "Ringing..."
    : connectionState === "connected"
    ? null
    : connectionState === "reconnecting"
    ? "Reconnecting..."
    : "Connecting...";

  if (isVideo) {
    return (
      <div className="fixed inset-0 z-[100] bg-black" data-testid="overlay-video-call">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          data-testid="video-remote"
        />
        <audio ref={remoteAudioRef} autoPlay data-testid="audio-remote" />

        {statusLabel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
            <Avatar className="w-24 h-24 mb-6 border-2 border-white/20">
              <AvatarImage src={callerPhoto} alt={callerName} />
              <AvatarFallback className="text-2xl bg-white/10 text-white">{callerName[0]}</AvatarFallback>
            </Avatar>
            <p className="text-white text-lg font-medium mb-2">{callerName}</p>
            <div className="flex items-center gap-2">
              {connectionState === "reconnecting" ? (
                <RefreshCw className="w-4 h-4 text-white/60 animate-spin" />
              ) : (
                <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
              )}
              <p className="text-white/60 text-sm">{statusLabel}</p>
            </div>
          </div>
        )}

        <div className="absolute top-4 right-4 w-28 h-40 rounded-xl overflow-hidden shadow-2xl border-2 border-white/30 z-20" data-testid="video-local-pip">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""}`}
          />
          {isCameraOff && (
            <div className="w-full h-full bg-gray-800 flex items-center justify-center">
              <VideoOff className="w-8 h-8 text-white/50" />
            </div>
          )}
        </div>

        {!statusLabel && (
          <div className="absolute top-6 left-0 right-0 flex justify-center z-20">
            <div className="bg-black/40 backdrop-blur-sm rounded-full px-4 py-2 flex items-center gap-3">
              <span className="text-white text-sm font-medium">{callerName}</span>
              <CallTimer />
            </div>
          </div>
        )}

        <div className="absolute bottom-12 left-0 right-0 flex justify-center gap-6 z-20">
          <button
            className={`w-14 h-14 rounded-full flex items-center justify-center ${isMuted ? "bg-red-500/80" : "bg-white/20"} active:scale-95 transition-all`}
            onClick={toggleMute}
            data-testid="button-toggle-mute"
          >
            {isMuted ? <MicOff className="w-6 h-6 text-white" /> : <Mic className="w-6 h-6 text-white" />}
          </button>
          <button
            className={`w-14 h-14 rounded-full flex items-center justify-center ${isCameraOff ? "bg-red-500/80" : "bg-white/20"} active:scale-95 transition-all`}
            onClick={toggleCamera}
            data-testid="button-toggle-camera"
          >
            {isCameraOff ? <VideoOff className="w-6 h-6 text-white" /> : <Video className="w-6 h-6 text-white" />}
          </button>
          <button
            className="w-14 h-14 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all"
            onClick={handleEndCall}
            data-testid="button-end-call"
          >
            <PhoneOff className="w-6 h-6 text-white" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-b from-[hsl(350,45%,30%)] to-[hsl(350,45%,15%)]" data-testid="overlay-voice-call">
      <audio ref={remoteAudioRef} autoPlay data-testid="audio-remote" />

      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          {connectionState === "connected" && !isRinging ? (
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

        {statusLabel ? (
          <div className="flex items-center gap-2">
            {connectionState === "reconnecting" ? (
              <RefreshCw className="w-4 h-4 text-orange-300/80 animate-spin" />
            ) : (
              <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
            )}
            <span className={connectionState === "reconnecting" ? "text-orange-300/80 text-sm" : "text-white/60 text-sm"}>
              {statusLabel}
            </span>
          </div>
        ) : (
          <CallTimer />
        )}
      </div>

      <div className="absolute bottom-16 left-0 right-0 flex justify-center gap-8">
        <button
          className={`w-16 h-16 rounded-full flex items-center justify-center ${isMuted ? "bg-red-500/80" : "bg-white/20"} active:scale-95 transition-all`}
          onClick={toggleMute}
          data-testid="button-toggle-mute"
        >
          {isMuted ? <MicOff className="w-7 h-7 text-white" /> : <Mic className="w-7 h-7 text-white" />}
        </button>
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all"
          onClick={handleEndCall}
          data-testid="button-end-call"
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
      </div>
    </div>
  );
}
