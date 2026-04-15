import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

declare global {
  interface Window {
    webrtcLogs: string[];
  }
}

if (typeof window !== "undefined" && !(window as any).__webrtcPatched) {
  (window as any).__webrtcPatched = true;
  if (!window.webrtcLogs) window.webrtcLogs = [];
  const _pushLog = (...args: any[]) => {
    const msg = args
      .map(a => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
      .join(" ");
    const ts = new Date().toISOString().slice(11, 23);
    window.webrtcLogs.push(`${ts} ${msg}`);
    if (window.webrtcLogs.length > 300) window.webrtcLogs.splice(0, window.webrtcLogs.length - 300);
  };
  const _intercept = (orig: (...a: any[]) => void) =>
    (...args: any[]) => {
      orig(...args);
      if (typeof args[0] === "string" && args[0].includes("[WebRTC]")) _pushLog(...args);
    };
  console.log = _intercept(console.log.bind(console));
  console.error = _intercept(console.error.bind(console));
  console.warn = _intercept(console.warn.bind(console));
}

const _turnUrl = import.meta.env.VITE_TURN_URL;
const _turnUsername = import.meta.env.VITE_TURN_USERNAME;
const _turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  ...(_turnUrl && _turnUsername && _turnCredential
    ? [{ urls: _turnUrl, username: _turnUsername, credential: _turnCredential }]
    : []),
];

if (!_turnUrl || !_turnUsername || !_turnCredential) {
  console.warn("TURN not configured - calls may fail on restricted networks");
}

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
  // Guards against concurrent offer creation. createOffer() is async and the
  // signalingState doesn't change to "have-local-offer" until setLocalDescription
  // completes — so a second sendOffer() can slip through the signalingState check
  // while the first createOffer() is still pending.
  const isNegotiatingRef = useRef(false);
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
    isNegotiatingRef.current = false;
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
      // Guard 1: signalingState must be stable before we can create a new offer.
      if (pc.signalingState !== "stable") {
        console.warn("[WebRTC] SEND_OFFER_SKIPPED: signalingState is", pc.signalingState, "(expected stable)");
        return;
      }
      // Guard 2: isNegotiatingRef prevents a second concurrent sendOffer() from
      // slipping past guard 1. createOffer() is async and signalingState stays
      // "stable" until setLocalDescription() resolves, so a webrtc:ready signal
      // arriving while createOffer() is in-flight would otherwise pass guard 1.
      if (isNegotiatingRef.current) {
        console.warn("[WebRTC] SEND_OFFER_SKIPPED: negotiation already in progress (isNegotiating=true)");
        return;
      }
      isNegotiatingRef.current = true;
      try {
        console.log("[WebRTC] SEND_OFFER_START: calling createOffer, signalingState:", pc.signalingState);
        hasSetRemoteDescRef.current = false;
        pendingCandidatesRef.current = [];
        const offer = await pc.createOffer();
        console.log("[WebRTC] SEND_OFFER_CREATED: offer type:", offer.type, "sdp length:", offer.sdp?.length);
        console.log("[WebRTC] SEND_OFFER_SLD: calling setLocalDescription");
        await pc.setLocalDescription(offer);
        console.log("[WebRTC] SEND_OFFER_SLD_DONE: signalingState after setLocalDescription:", pc.signalingState);
        broadcastOnChannel({ type: "webrtc:offer", sdp: offer.sdp! });
        console.log("[WebRTC] SEND_OFFER_BROADCAST: webrtc:offer sent on channel");
      } catch (e: any) {
        console.error("[WebRTC] FAILURE_TRIGGER: send_offer_exception —", e?.name ?? "", e?.message ?? e);
        setConnectionState("failed");
      } finally {
        isNegotiatingRef.current = false;
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
            // Skip if ICE is already connected — a duplicate webrtc:ready from the
            // receiver's 2-second retry interval must not trigger a second offer
            // after the first offer/answer cycle already completed successfully.
            const iceState = pcRef.current.iceConnectionState;
            if (iceState === "connected" || iceState === "completed") {
              console.warn("[WebRTC] READY_SIGNAL_IGNORED: ICE already", iceState, "— skipping redundant sendOffer");
              return;
            }
            // sendOffer() itself is guarded by isNegotiatingRef, but log here
            // so it's visible when the signal arrives mid-negotiation too.
            console.log("[WebRTC] READY_SIGNAL_SENDOFFER: iceState=", iceState, "triggering sendOffer from webrtc:ready");
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
          console.log("[WebRTC] OFFER received — before setRemoteDescription, signalingState:", pc.signalingState);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
          console.log("[WebRTC] OFFER — after setRemoteDescription, signalingState:", pc.signalingState);
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          if (queued.length > 0) {
            console.log("[WebRTC] OFFER — draining", queued.length, "queued ICE candidates");
          }
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
          console.log("[WebRTC] OFFER — before createAnswer");
          const answer = await pc.createAnswer();
          console.log("[WebRTC] OFFER — after createAnswer, before setLocalDescription");
          await pc.setLocalDescription(answer);
          console.log("[WebRTC] OFFER — after setLocalDescription, signalingState:", pc.signalingState, "— sending answer");
          broadcastOnChannel({ type: "webrtc:answer", sdp: answer.sdp! });
        } else if (msg.type === "webrtc:answer" && isCaller) {
          if (pc.signalingState !== "have-local-offer") {
            console.warn("Ignoring answer in state:", pc.signalingState);
            return;
          }
          console.log("[WebRTC] ANSWER received — before setRemoteDescription, signalingState:", pc.signalingState);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
          console.log("[WebRTC] ANSWER — after setRemoteDescription, signalingState:", pc.signalingState);
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          if (queued.length > 0) {
            console.log("[WebRTC] ANSWER — draining", queued.length, "queued ICE candidates");
          }
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
        } else if (msg.type === "webrtc:ice") {
          if (hasSetRemoteDescRef.current) {
            if (msg.candidate && pc) {
              console.log("[WebRTC] ICE candidate received — adding:", {
                type: (msg.candidate as any).type,
                protocol: (msg.candidate as any).protocol,
                candidateString: msg.candidate.candidate,
              });
              try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
            }
          } else {
            console.log("[WebRTC] ICE candidate received — queuing (no remote desc yet):", msg.candidate.candidate);
            pendingCandidatesRef.current.push(msg.candidate);
          }
        }
      } catch (e) {
        console.error("[WebRTC] FAILURE_TRIGGER: signal_handling_exception", e);
        setConnectionState("failed");
      }
    };

    // Wraps channel.subscribe() (callback-based in Supabase JS v2) into a
    // promise. subscribe() returns the channel object synchronously — the
    // "SUBSCRIBED" status is delivered asynchronously via callback, so awaiting
    // subscribe() directly always resolves to the channel object and can never
    // equal the string "SUBSCRIBED". This wrapper fixes that.
    const subscribeChannel = (ch: ReturnType<typeof supabase.channel>, timeoutMs = 20_000): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          console.error("[WebRTC] CHANNEL_SUBSCRIBE_FAILED: timed out after 20 s waiting for SUBSCRIBED status");
          reject(new Error("CHANNEL_SUBSCRIBE_TIMEOUT"));
        }, timeoutMs);
        ch.subscribe((status: string, err?: Error) => {
          console.log("[WebRTC] CHANNEL_STATUS_CHANGED:", status, err ? `err=${err.message}` : "");
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            clearTimeout(timer);
            console.error("[WebRTC] CHANNEL_SUBSCRIBE_FAILED: terminal status received:", status, err?.message ?? "");
            reject(err ?? new Error(`channel_${status}`));
          }
        });
      });

    // Wraps getUserMedia with a 20-second timeout so a hung permission dialog
    // produces a clear MEDIA_TIMEOUT log instead of hanging silently.
    const getUserMediaWithTimeout = (constraints: MediaStreamConstraints): Promise<MediaStream> => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: getUserMedia timed out after 20 s — device may be in use or permission dialog hung");
          reject(new DOMException("getUserMedia timed out after 20 s", "TimeoutError"));
        }, 20_000);

        navigator.mediaDevices.getUserMedia(constraints).then(
          (stream) => { clearTimeout(timer); resolve(stream); },
          (err)    => { clearTimeout(timer); reject(err); },
        );
      });
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

      // Attempt getUserMedia with the full echo/noise/gain constraints first.
      // If the browser rejects them (OverconstrainedError / NotSupportedError —
      // common on older iOS Safari), fall back through progressively simpler
      // constraint sets so the call still connects without echoCancellation
      // being a hard blocker.  A log is emitted at each fallback tier.
      const getUserMediaWithFallback = async (): Promise<MediaStream> => {
        const tiers: MediaStreamConstraints[] = [
          // Tier 1 — full quality (Chrome, Firefox, modern Safari)
          {
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: isVideo ? { facingMode: "user" } : false,
          },
          // Tier 2 — drop autoGainControl (unsupported on some older Safari)
          {
            audio: { echoCancellation: true, noiseSuppression: true },
            video: isVideo ? { facingMode: "user" } : false,
          },
          // Tier 3 — basic audio only (maximum compatibility)
          {
            audio: true,
            video: isVideo ? { facingMode: "user" } : false,
          },
        ];

        let lastErr: unknown;
        for (let i = 0; i < tiers.length; i++) {
          const constraints = tiers[i];
          try {
            console.log("[WebRTC] MEDIA_ACQUIRE_START tier", i + 1, ":", JSON.stringify(constraints));
            const stream = await getUserMediaWithTimeout(constraints);
            if (i > 0) {
              console.warn("[WebRTC] MEDIA_CONSTRAINT_FALLBACK: succeeded on tier", i + 1,
                "— echo cancellation may be reduced");
            }
            return stream;
          } catch (err: any) {
            lastErr = err;
            const isConstraintError = err?.name === "OverconstrainedError" ||
              err?.name === "NotSupportedError" ||
              err?.name === "TypeError";
            if (!isConstraintError || i === tiers.length - 1) {
              // Non-constraint error (permission denied, no device, timeout) or
              // exhausted all tiers — rethrow so the caller handles it properly.
              throw err;
            }
            console.warn("[WebRTC] MEDIA_CONSTRAINT_FALLBACK: tier", i + 1, "failed (", err?.name, ") — trying simpler constraints");
          }
        }
        throw lastErr;
      };

      console.log("[WebRTC] CHANNEL_SUBSCRIBE_START: subscribing to signaling channel:", channelName);

      const [mediaResult, channelResult] = await Promise.allSettled([
        getUserMediaWithFallback(),
        subscribeChannel(channel),
      ]);

      if (cleanedUpRef.current) {
        if (mediaResult.status === "fulfilled") {
          mediaResult.value.getTracks().forEach((t) => t.stop());
        }
        return;
      }

      if (mediaResult.status === "rejected") {
        const err = mediaResult.reason;
        // Log every property so the debug panel captures the exact failure.
        console.error(
          "[WebRTC] MEDIA_ACQUIRE_FAILED: getUserMedia rejected —",
          "name:", err?.name ?? "(no name)",
          "message:", err?.message ?? "(no message)",
          "constraint:", (err as any)?.constraint ?? "(none)",
        );
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: microphone/camera permission was denied by the user or OS");
          setPermissionDenied(true);
        } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: no microphone/camera device found on this device");
        } else if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: device is already in use by another application");
        } else if (err?.name === "OverconstrainedError") {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: constraints too strict — failed constraint:", (err as any)?.constraint);
        } else if (err?.name === "TimeoutError") {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: getUserMedia timed out — permission dialog may be hidden");
        } else {
          console.error("[WebRTC] MEDIA_ACQUIRE_FAILED: unexpected error type — full object:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
        }
        console.error("[WebRTC] FAILURE_TRIGGER: setting connectionState=failed from media acquisition step");
        cleanup();
        setConnectionState("failed");
        return;
      }

      console.log("[WebRTC] MEDIA_ACQUIRE_SUCCESS: stream tracks:", mediaResult.value.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));

      if (channelResult.status === "rejected") {
        const err = channelResult.reason;
        console.error("[WebRTC] CHANNEL_SUBSCRIBE_FAILED: signaling channel never reached SUBSCRIBED —", err?.message ?? "(no message)");
        console.error("[WebRTC] FAILURE_TRIGGER: setting connectionState=failed from channel subscribe step");
        cleanup();
        setConnectionState("failed");
        return;
      }

      console.log("[WebRTC] CHANNEL_SUBSCRIBE_SUCCESS: signaling channel is ready");

      const stream = mediaResult.value;
      localStreamRef.current = stream;
      setLocalStream(stream);

      if (cleanedUpRef.current) return;

      console.log("[WebRTC] PC_CREATE_START: creating RTCPeerConnection with", ICE_SERVERS.length, "ICE server(s)");
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      console.log("[WebRTC] PC_CREATE_DONE — initial states:", {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState,
        iceServers: ICE_SERVERS.map(s => s.urls),
      });

      const remote = new MediaStream();
      setRemoteStream(remote);

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
        console.log("[WebRTC] Local track added:", {
          kind: track.kind,
          enabled: track.enabled,
          readyState: track.readyState,
          id: track.id,
        });
      });

      pc.ontrack = (event) => {
        console.log("[WebRTC] Remote track received:", {
          trackKind: event.track.kind,
          trackEnabled: event.track.enabled,
          trackReadyState: event.track.readyState,
          streams: event.streams.length,
        });
        event.streams[0]?.getTracks().forEach((track) => {
          if (!remote.getTrackById(track.id)) {
            remote.addTrack(track);
          }
        });
        setRemoteStream(new MediaStream(remote.getTracks()));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("[WebRTC] ICE candidate generated:", {
            type: event.candidate.type,
            protocol: event.candidate.protocol,
            address: event.candidate.address,
            port: event.candidate.port,
            candidateString: event.candidate.candidate,
          });
          broadcastOnChannel({ type: "webrtc:ice", candidate: event.candidate.toJSON() });
        } else {
          console.log("[WebRTC] ICE gathering complete (null candidate)");
        }
      };

      pc.onicegatheringstatechange = () => {
        console.log("[WebRTC] iceGatheringState:", pc.iceGatheringState);
      };

      pc.onconnectionstatechange = () => {
        console.log("[WebRTC] connectionState:", pc.connectionState, {
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
        });
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
              console.error("[WebRTC] FAILURE_TRIGGER: ice_disconnect_timeout (15s) — iceConnectionState still disconnected", { matchId });
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
          console.error("[WebRTC] FAILURE_TRIGGER: iceConnectionState=failed", {
            matchId,
            signalingState: pc.signalingState,
            connectionState: pc.connectionState,
            iceGatheringState: pc.iceGatheringState,
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
          console.error("[WebRTC] FAILURE_TRIGGER: connection_timeout_30s — ICE never connected", {
            matchId,
            iceState,
            signalingState: pcRef.current?.signalingState,
            connectionState: pcRef.current?.connectionState,
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
