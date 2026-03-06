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

export type WebRTCState = "idle" | "requesting-media" | "connecting" | "connected" | "failed" | "closed";

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
  onRemoteHangupRef.current = onRemoteHangup;

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

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

  const sendSignal = useCallback((msg: Omit<SignalMessage, "from">) => {
    const channel = channelRef.current;
    if (!channel) return;
    channel.send({
      type: "broadcast",
      event: "signal",
      payload: { ...msg, from: userId },
    });
  }, [userId]);

  const addPendingCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !hasSetRemoteDescRef.current) return;
    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const c of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) {
        console.warn("Failed to add ICE candidate:", e);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || !matchId || !userId) return;

    cleanedUpRef.current = false;
    hasSetRemoteDescRef.current = false;
    pendingCandidatesRef.current = [];

    const handleSignal = async (msg: SignalMessage) => {
      if (msg.from === userId) return;
      const pc = pcRef.current;
      if (!pc) return;

      try {
        if (msg.type === "webrtc:offer" && !isCaller) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
          hasSetRemoteDescRef.current = true;
          const candidates = pendingCandidatesRef.current;
          pendingCandidatesRef.current = [];
          for (const c of candidates) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const channel = channelRef.current;
          if (channel) {
            channel.send({
              type: "broadcast",
              event: "signal",
              payload: { type: "webrtc:answer", sdp: answer.sdp!, from: userId },
            });
          }
        } else if (msg.type === "webrtc:answer" && isCaller) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
          hasSetRemoteDescRef.current = true;
          const candidates = pendingCandidatesRef.current;
          pendingCandidatesRef.current = [];
          for (const c of candidates) {
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

      let stream: MediaStream;
      try {
        const constraints: MediaStreamConstraints = {
          audio: true,
          video: isVideo ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err: any) {
        console.error("getUserMedia error:", err);
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          setPermissionDenied(true);
        }
        setConnectionState("failed");
        return;
      }

      if (cleanedUpRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      const remote = new MediaStream();
      setRemoteStream(remote);

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          remote.addTrack(track);
        });
        setRemoteStream(new MediaStream(remote.getTracks()));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const channel = channelRef.current;
          if (channel) {
            channel.send({
              type: "broadcast",
              event: "signal",
              payload: { type: "webrtc:ice", candidate: event.candidate.toJSON(), from: userId },
            });
          }
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "connected" || state === "completed") {
          setConnectionState("connected");
        } else if (state === "failed" || state === "disconnected") {
          setConnectionState("failed");
        } else if (state === "closed") {
          setConnectionState("closed");
        }
      };

      setConnectionState("connecting");

      const channelName = `call:${matchId}`;
      const channel = supabase.channel(channelName);
      channelRef.current = channel;

      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if (payload && payload.from !== userId) {
          handleSignal(payload as SignalMessage);
        }
      });

      const status = await channel.subscribe();

      if (status !== "SUBSCRIBED") {
        console.error("Failed to subscribe to signaling channel:", status);
        let retries = 0;
        const retryInterval = setInterval(async () => {
          retries++;
          if (retries > 5 || cleanedUpRef.current) {
            clearInterval(retryInterval);
            if (!cleanedUpRef.current) setConnectionState("failed");
            return;
          }
          const s = await channel.subscribe();
          if (s === "SUBSCRIBED") {
            clearInterval(retryInterval);
            if (isCaller && !cleanedUpRef.current) {
              try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                channel.send({
                  type: "broadcast",
                  event: "signal",
                  payload: { type: "webrtc:offer", sdp: offer.sdp!, from: userId },
                });
              } catch (e) {
                console.error("Failed to create offer:", e);
                setConnectionState("failed");
              }
            }
          }
        }, 2000);
        return;
      }

      if (isCaller) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          channel.send({
            type: "broadcast",
            event: "signal",
            payload: { type: "webrtc:offer", sdp: offer.sdp!, from: userId },
          });
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
