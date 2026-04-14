import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// STUN servers for direct peer discovery + TURN relays for restricted networks
// TURN relays (openrelay.metered.ca) allow calls to work through symmetric NAT
// and firewalls that block direct UDP — covers most mobile networks.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  // Free open TURN relays — allow traversal of symmetric NAT and strict firewalls
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type SignalMessage =
  | { type: "webrtc:offer"; sdp: string; from: string }
  | { type: "webrtc:answer"; sdp: string; from: string }
  | { type: "webrtc:ice"; candidate: RTCIceCandidateInit; from: string }
  | { type: "webrtc:hangup"; from: string }
  | { type: "webrtc:ready"; from: string };

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
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyReceivedRef = useRef(false);
  const readyRetryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  onRemoteHangupRef.current = onRemoteHangup;

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;

    if (readyRetryIntervalRef.current) {
      clearInterval(readyRetryIntervalRef.current);
      readyRetryIntervalRef.current = null;
    }
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
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
    readyReceivedRef.current = false;
    if (readyRetryIntervalRef.current) {
      clearInterval(readyRetryIntervalRef.current);
      readyRetryIntervalRef.current = null;
    }

    const broadcastOnChannel = (msg: Omit<SignalMessage, "from">) => {
      const channel = channelRef.current;
      if (!channel) return;
      channel.send({
        type: "broadcast",
        event: "signal",
        payload: { ...msg, from: userId },
      });
    };

    const sendOffer = async () => {
      const pc = pcRef.current;
      if (!pc || cleanedUpRef.current) return;
      if (pc.signalingState !== "stable") return;
      try {
        console.log("[WebRTC] Creating and sending offer");
        hasSetRemoteDescRef.current = false;
        pendingCandidatesRef.current = [];
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        broadcastOnChannel({ type: "webrtc:offer", sdp: offer.sdp! });
        console.log("[WebRTC] Offer sent");
      } catch (e) {
        console.error("[WebRTC] Failed to create offer:", e);
        setConnectionState("failed");
      }
    };

    const handleSignal = async (msg: SignalMessage) => {
      if (msg.from === userId) return;

      if (msg.type === "webrtc:hangup") {
        console.log("[WebRTC] CALL_END_RECEIVED - remote hangup from:", msg.from.slice(0, 8));
        cleanup();
        onRemoteHangupRef.current?.();
        return;
      }

      if (cleanedUpRef.current) {
        console.log("[WebRTC] Signal ignored (already cleaned up):", msg.type);
        return;
      }
      console.log("[WebRTC] Signal received:", msg.type, "from:", msg.from.slice(0, 8));

      try {
        if (msg.type === "webrtc:ready") {
          console.log("[WebRTC] Remote peer ready, isCaller:", isCaller, "pcExists:", !!pcRef.current);
          readyReceivedRef.current = true;
          if (isCaller && pcRef.current) {
            await sendOffer();
          }
          return;
        }

        const pc = pcRef.current;
        if (!pc) return;

        if (msg.type === "webrtc:offer" && !isCaller) {
          if (pc.signalingState !== "stable") {
            console.warn("Ignoring offer in state:", pc.signalingState);
            return;
          }
          // Stop the ready-retry interval — the caller received our webrtc:ready
          if (readyRetryIntervalRef.current) {
            clearInterval(readyRetryIntervalRef.current);
            readyRetryIntervalRef.current = null;
          }
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
          if (pc.signalingState !== "have-local-offer") {
            console.warn("Ignoring answer in state:", pc.signalingState);
            return;
          }
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
        }
      } catch (e) {
        console.error("Signal handling error:", e);
        setConnectionState("failed");
      }
    };

    const init = async () => {
      console.log("[WebRTC] Initializing:", { matchId, isCaller, isVideo });
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

      const [mediaResult, channelResult] = await Promise.allSettled([
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

      if (channelResult.status === "rejected" || channelResult.value !== "SUBSCRIBED") {
        let subscribed = false;
        for (let i = 0; i < 5 && !cleanedUpRef.current; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const s = await channel.subscribe();
            if (s === "SUBSCRIBED") { subscribed = true; break; }
          } catch {}
        }
        if (!subscribed && !cleanedUpRef.current) {
          console.error("Channel subscription failed after retries");
          cleanup();
          setConnectionState("failed");
          return;
        }
      }

      if (cleanedUpRef.current) return;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      const remote = new MediaStream();
      setRemoteStream(remote);

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => {
          if (!remote.getTrackById(track.id)) {
            remote.addTrack(track);
          }
        });
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
        console.log("[WebRTC] ICE connection state:", state, {
          matchId,
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
        });
        if (state === "connected" || state === "completed") {
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          setConnectionState("connected");
        } else if (state === "disconnected") {
          setConnectionState("reconnecting");
          if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = setTimeout(() => {
            if (!cleanedUpRef.current && pcRef.current?.iceConnectionState === "disconnected") {
              console.error("[WebRTC] ICE disconnect timeout — marking failed", { matchId });
              // Close the peer connection and channel immediately so re-delivered
              // WebRTC signals (webrtc:ready / webrtc:offer) can't restart the call
              // when the network recovers and Supabase channels reconnect.
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
              setConnectionState("failed");
            }
          }, 15000);
        } else if (state === "failed") {
          console.error("[WebRTC] ICE connection failed", {
            matchId,
            signalingState: pc.signalingState,
            connectionState: pc.connectionState,
          });
          // Close the peer connection and channel immediately — prevents
          // WebRTC signals re-delivered by Supabase on reconnect from
          // restarting the negotiation after a network drop.
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
          setConnectionState("failed");
        } else if (state === "closed") {
          setConnectionState("closed");
        }
      };

      setConnectionState("connecting");

      // 30-second hard timeout — if ICE hasn't connected by then, mark as failed
      connectionTimeoutRef.current = setTimeout(() => {
        if (cleanedUpRef.current) return;
        const iceState = pcRef.current?.iceConnectionState;
        if (iceState !== "connected" && iceState !== "completed") {
          console.error("[WebRTC] Connection timeout after 30s — marking failed", {
            matchId,
            iceState,
          });
          // Close peer connection and channel to prevent restart on network recovery
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
          setConnectionState("failed");
        }
      }, 30000);

      if (isCaller) {
        await sendOffer();
      } else {
        // Send webrtc:ready immediately, then retry every 2s until the caller
        // responds with an offer. This handles the race condition where the caller
        // subscribes to the signaling channel AFTER the receiver's first ready signal.
        const sendReady = () => {
          if (cleanedUpRef.current || hasSetRemoteDescRef.current) return;
          console.log("[WebRTC] Sending webrtc:ready (retry if offer not yet received)");
          broadcastOnChannel({ type: "webrtc:ready" });
        };
        sendReady();
        readyRetryIntervalRef.current = setInterval(sendReady, 2000);
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
    if (cleanedUpRef.current) {
      console.log("[WebRTC] hangup() called but already cleaned up - skipping");
      return;
    }
    cleanedUpRef.current = true;
    console.log("[WebRTC] CALL_END_REQUESTED - sending hangup signal");
    const channel = channelRef.current;
    if (channel) {
      channel.send({
        type: "broadcast",
        event: "signal",
        payload: { type: "webrtc:hangup", from: userId },
      });
      console.log("[WebRTC] CALL_END_SENT - webrtc:hangup broadcast");
    }
    if (readyRetryIntervalRef.current) {
      clearInterval(readyRetryIntervalRef.current);
      readyRetryIntervalRef.current = null;
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
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setConnectionState("closed");
    console.log("[WebRTC] CALL_STATE_CLEARED - streams and peer connection closed");
    setTimeout(() => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
        console.log("[WebRTC] CALL_LISTENER_REMOVED - signaling channel removed");
      }
      console.log("[WebRTC] CALL_SESSION_CLOSED - all resources released");
    }, 500);
  }, [userId]);

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
