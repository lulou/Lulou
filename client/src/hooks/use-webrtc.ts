import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

type SignalMessage =
  | { type: "webrtc:offer"; sdp: string; from: string }
  | { type: "webrtc:answer"; sdp: string; from: string }
  | { type: "webrtc:ice"; candidate: RTCIceCandidateInit; from: string }
  | { type: "webrtc:hangup"; from: string };

export type WebRTCState = "idle" | "requesting-media" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";

interface UseWebRTCOptions {
  matchId: string;
  userId: string;
  isCaller: boolean;
  isVideo: boolean;
  enabled: boolean;
  onRemoteHangup?: () => void;
}

export function useWebRTC({ matchId, userId, isCaller, isVideo, enabled, onRemoteHangup }: UseWebRTCOptions) {
  const [connectionState, setConnectionState] = useState<WebRTCState>("idle");
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const hasSetRemoteDescRef = useRef(false);
  const cleanedUpRef = useRef(false);
  const onRemoteHangupRef = useRef(onRemoteHangup);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onRemoteHangupRef.current = onRemoteHangup;

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setConnectionState("closed");
  }, []);

  useEffect(() => {
    if (!enabled || !matchId || !userId) return;

    cleanedUpRef.current = false;
    hasSetRemoteDescRef.current = false;
    pendingCandidatesRef.current = [];

    const broadcastOnChannel = (msg: Omit<SignalMessage, "from">) => {
      const channel = channelRef.current;
      if (!channel) return;
      channel.send({
        type: "broadcast",
        event: "signal",
        payload: { ...msg, from: userId },
      });
    };

    const handleSignal = async (msg: SignalMessage) => {
      if (msg.from === userId) return;
      const pc = pcRef.current;
      if (!pc) return;

      try {
        if (msg.type === "webrtc:offer" && !isCaller) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          broadcastOnChannel({ type: "webrtc:answer", sdp: answer.sdp! });
        } else if (msg.type === "webrtc:answer" && isCaller) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
        } else if (msg.type === "webrtc:ice") {
          if (hasSetRemoteDescRef.current) {
            try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
          } else {
            pendingCandidatesRef.current.push(msg.candidate);
          }
        } else if (msg.type === "webrtc:hangup") {
          cleanup();
          onRemoteHangupRef.current?.();
        }
      } catch (e) {
        console.error("Signal handling error:", e);
        setConnectionState("failed");
      }
    };

    const init = async () => {
      setConnectionState("requesting-media");
      setPermissionDenied(false);

      const channelName = `call:${matchId}`;
      const channel = supabase.channel(channelName);
      channelRef.current = channel;

      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if (payload && payload.from !== userId) {
          handleSignal(payload as SignalMessage);
        }
      });

      const [mediaResult, channelStatus] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({
          audio: true,
          video: isVideo ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
        }),
        channel.subscribe(),
      ]);

      if (cleanedUpRef.current) {
        if (mediaResult.status === "fulfilled") {
          mediaResult.value.getTracks().forEach((t) => t.stop());
        }
        return;
      }

      if (mediaResult.status === "rejected") {
        const err = mediaResult.reason;
        console.error("getUserMedia error:", err);
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          setPermissionDenied(true);
        }
        cleanup();
        setConnectionState("failed");
        return;
      }

      const stream = mediaResult.value;
      localStreamRef.current = stream;
      setLocalStream(stream);

      if (channelStatus.status === "rejected" || channelStatus.value !== "SUBSCRIBED") {
        console.warn("Signaling channel subscription issue, retrying...");
        let retries = 0;
        const retrySubscribe = async (): Promise<boolean> => {
          while (retries < 5 && !cleanedUpRef.current) {
            retries++;
            await new Promise(r => setTimeout(r, 1000));
            const s = await channel.subscribe();
            if (s === "SUBSCRIBED") return true;
          }
          return false;
        };
        const ok = await retrySubscribe();
        if (!ok && !cleanedUpRef.current) {
          cleanup();
          setConnectionState("failed");
          return;
        }
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      const remote = new MediaStream();
      setRemoteStream(remote);

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remote.addTrack(track));
        setRemoteStream(new MediaStream(remote.getTracks()));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          broadcastOnChannel({ type: "webrtc:ice", candidate: event.candidate.toJSON() });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (cleanedUpRef.current) return;
        const state = pc.iceConnectionState;
        if (state === "connected" || state === "completed") {
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          setConnectionState("connected");
        } else if (state === "disconnected") {
          setConnectionState("reconnecting");
          if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = setTimeout(() => {
            if (!cleanedUpRef.current && pcRef.current?.iceConnectionState === "disconnected") {
              setConnectionState("failed");
            }
          }, 15000);
        } else if (state === "failed") {
          setConnectionState("failed");
        } else if (state === "closed") {
          setConnectionState("closed");
        }
      };

      setConnectionState("connecting");

      if (isCaller) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          broadcastOnChannel({ type: "webrtc:offer", sdp: offer.sdp! });
        } catch (e) {
          console.error("Failed to create offer:", e);
          setConnectionState("failed");
        }
      }
    };

    init();

    return () => {
      cleanup();
    };
  }, [enabled, matchId, userId, isCaller, isVideo, cleanup]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!audioTrack.enabled);
    }
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsCameraOff(!videoTrack.enabled);
    }
  }, []);

  const hangup = useCallback(() => {
    const channel = channelRef.current;
    if (channel) {
      channel.send({
        type: "broadcast",
        event: "signal",
        payload: { type: "webrtc:hangup", from: userId },
      });
    }
    cleanup();
  }, [userId, cleanup]);

  return {
    localStream,
    remoteStream,
    connectionState,
    permissionDenied,
    isMuted,
    isCameraOff,
    toggleMute,
    toggleCamera,
    hangup,
  };
}
