import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { cleanupCallAudio } from "@/lib/call-audio";
import { callDebug } from "@/lib/call-debug";

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
  // Human-readable explanation of why the call failed — shown in the UI.
  const [failureReason, setFailureReason] = useState<string>("");

  // Counts ICE candidates gathered by type.  Used in failure messages so the
  // developer can tell at a glance whether the failure was "no TURN relay" vs
  // "no candidates at all" vs "ICE negotiation timed out without answer".
  const candidateCountsRef = useRef({ host: 0, srflx: 0, relay: 0 });

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
  // Guards the one-shot 3-second mute test that runs when the call first
  // reaches ICE "connected". Reset to false at the start of each new call.
  const screechTestDoneRef = useRef(false);
  const screechTestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (screechTestTimerRef.current) {
      clearTimeout(screechTestTimerRef.current);
      screechTestTimerRef.current = null;
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
    screechTestDoneRef.current = false;
    candidateCountsRef.current = { host: 0, srflx: 0, relay: 0 };
    setFailureReason("");
    if (readyRetryIntervalRef.current) {
      clearInterval(readyRetryIntervalRef.current);
      readyRetryIntervalRef.current = null;
    }

    callDebug.reset({
      callId: matchId,
      myUserId: userId,
      isCaller,
      isVideo,
      startedAt: new Date().toISOString().slice(11, 23),
    });
    callDebug.event("effect: webrtc enabled, init starting");

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
        callDebug.event("offer: createOffer start");
        hasSetRemoteDescRef.current = false;
        pendingCandidatesRef.current = [];
        const offer = await pc.createOffer();
        console.log("[WebRTC] SEND_OFFER_CREATED: offer type:", offer.type, "sdp length:", offer.sdp?.length);
        callDebug.update({ offerCreated: true });
        callDebug.event(`offer: created (sdp ${offer.sdp?.length ?? 0}b)`);
        console.log("[WebRTC] SEND_OFFER_SLD: calling setLocalDescription");
        await pc.setLocalDescription(offer);
        console.log("[WebRTC] SEND_OFFER_SLD_DONE: signalingState after setLocalDescription:", pc.signalingState);
        broadcastOnChannel({ type: "webrtc:offer", sdp: offer.sdp! });
        console.log("[CALL_CONNECT] offer set", { matchId, sdpLength: offer.sdp?.length, signalingState: pc.signalingState });
        callDebug.update({ offerSent: true });
        callDebug.event("offer: broadcast sent on channel");
        console.log("[WebRTC] SEND_OFFER_BROADCAST: webrtc:offer sent on channel");
      } catch (e: any) {
        console.error("[WebRTC] FAILURE_TRIGGER: send_offer_exception —", e?.name ?? "", e?.message ?? e);
        callDebug.event(`offer: FAILED ${e?.name ?? ""} ${e?.message ?? ""}`);
        setConnectionState("failed");
      } finally {
        isNegotiatingRef.current = false;
      }
    };

    const handleSignal = async (msg: SignalMessage) => {
      if (msg.from === userId) {
        console.warn("[SIGNAL_AUDIT] ignored own signalling message", { type: msg.type, from: msg.from.slice(0, 8), matchId });
        console.warn("[SCREECH_FIX] ignored own signalling", {
          type: msg.type,
          source: "handleSignal guard (should not reach here if self:false works)",
          matchId,
        });
        return;
      }

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
          readyReceivedRef.current = true;
          callDebug.update({ readyReceived: true });
          callDebug.event("signal: webrtc:ready received from callee");
          console.log("[WebRTC] READY_RECEIVED: isCaller=", isCaller, "pcExists=", !!pcRef.current,
            "iceState=", pcRef.current?.iceConnectionState ?? "no-pc",
            "signalingState=", pcRef.current?.signalingState ?? "no-pc");

          if (isCaller && pcRef.current) {
            const pc = pcRef.current;
            const iceState = pc.iceConnectionState;

            // Skip if ICE already established — duplicate webrtc:ready from the
            // receiver's 2-second retry must not re-negotiate a live call.
            if (iceState === "connected" || iceState === "completed") {
              console.warn("[WebRTC] READY_SIGNAL_IGNORED: ICE already", iceState, "— call is live, skipping");
              return;
            }

            // ── DEADLOCK FIX ────────────────────────────────────────────────
            // Supabase Realtime broadcasts are ephemeral (no persistence).
            // If the caller sent the first offer before the receiver's channel
            // subscription was SUBSCRIBED, the receiver missed it.
            // signalingState will be "have-local-offer" and sendOffer() silently
            // returns (it guards against non-"stable" state), so the call sits
            // waiting until the 60-second timeout fires.
            //
            // Fix: when webrtc:ready arrives and we have a pending (unanswered)
            // offer, roll back the local description to "stable" so we can
            // create and broadcast a fresh offer that the receiver can actually
            // receive now that they are subscribed.
            if (pc.signalingState === "have-local-offer") {
              console.log("[WebRTC] READY_SIGNAL_ROLLBACK: receiver missed first offer — rolling back to resend");
              try {
                await pc.setLocalDescription({ type: "rollback" });
                isNegotiatingRef.current = false;
                callDebug.update({ rollbackCount: callDebug.get().rollbackCount + 1 });
                callDebug.event("signal: rollback done — will resend fresh offer");
                console.log("[WebRTC] READY_SIGNAL_ROLLBACK_DONE: signalingState=", pc.signalingState);
              } catch (rollbackErr: any) {
                // setLocalDescription({type:"rollback"}) is not supported on all
                // older browsers (pre-2020 Safari / iOS < 15).  If it throws,
                // we can't resend right now — the receiver's 2-second retry will
                // give us another chance.
                console.warn("[WebRTC] READY_SIGNAL_ROLLBACK_FAILED — receiver will retry in 2 s:",
                  rollbackErr?.message ?? rollbackErr);
                return;
              }
            }

            console.log("[WebRTC] READY_SIGNAL_SENDOFFER: iceState=", iceState,
              "signalingState=", pc.signalingState, "— sending offer");
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
          console.log("[CALL_ANSWER] remote_offer_received", { matchId, signalingState: pc.signalingState, ts: new Date().toISOString() });
          callDebug.event("signal: offer received → setRemoteDesc");
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
          console.log("[WebRTC] OFFER — after setRemoteDescription, signalingState:", pc.signalingState);
          console.log("[CALL_ANSWER] remote_offer_set_ok", { matchId, signalingState: pc.signalingState });
          callDebug.update({ offerReceived: true });
          callDebug.event("signal: offer setRemoteDesc done");
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          if (queued.length > 0) {
            console.log("[WebRTC] OFFER — draining", queued.length, "queued ICE candidates");
            console.log("[CALL_ANSWER] draining_queued_candidates", { matchId, count: queued.length });
          }
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
          console.log("[WebRTC] OFFER — before createAnswer");
          const answer = await pc.createAnswer();
          console.log("[WebRTC] OFFER — after createAnswer, before setLocalDescription");
          console.log("[CALL_ANSWER] answer_created", { matchId, sdpType: answer.type });
          await pc.setLocalDescription(answer);
          console.log("[WebRTC] OFFER — after setLocalDescription, signalingState:", pc.signalingState, "— sending answer");
          console.log("[CALL_ANSWER] answer_sent_to_caller", { matchId, signalingState: pc.signalingState, ts: new Date().toISOString() });
          broadcastOnChannel({ type: "webrtc:answer", sdp: answer.sdp! });
          console.log("[CALL_CONNECT] answer sent", { matchId, sdpLength: answer.sdp?.length, signalingState: pc.signalingState });
          callDebug.update({ answerSent: true });
          callDebug.event("signal: answer sent to caller");
        } else if (msg.type === "webrtc:answer" && isCaller) {
          if (pc.signalingState !== "have-local-offer") {
            console.warn("Ignoring answer in state:", pc.signalingState);
            return;
          }
          console.log("[WebRTC] ANSWER received — before setRemoteDescription, signalingState:", pc.signalingState);
          callDebug.event("signal: answer received → setRemoteDesc");
          await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
          console.log("[WebRTC] ANSWER — after setRemoteDescription, signalingState:", pc.signalingState);
          callDebug.update({ answerReceived: true });
          callDebug.event("signal: answer setRemoteDesc done");
          hasSetRemoteDescRef.current = true;
          const queued = pendingCandidatesRef.current.splice(0);
          if (queued.length > 0) {
            console.log("[WebRTC] ANSWER — draining", queued.length, "queued ICE candidates");
          }
          for (const c of queued) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
        } else if (msg.type === "webrtc:ice") {
          callDebug.update({ iceReceived: callDebug.get().iceReceived + 1 });
          callDebug.event(`signal: ICE rcvd → ${hasSetRemoteDescRef.current ? "add" : "queue"}`);
          if (hasSetRemoteDescRef.current) {
            if (msg.candidate && pc) {
              console.log("[CALL_CONNECT] ice candidate received", { type: (msg.candidate as any).type, protocol: (msg.candidate as any).protocol });
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
          callDebug.update({ channelStatus: "timeout", channelError: "20s timeout waiting for SUBSCRIBED" });
          callDebug.event("channel: SUBSCRIBE TIMEOUT (20s)");
          console.error("[WebRTC] CHANNEL_SUBSCRIBE_FAILED: timed out after 20 s waiting for SUBSCRIBED status");
          reject(new Error("CHANNEL_SUBSCRIBE_TIMEOUT"));
        }, timeoutMs);
        ch.subscribe((status: string, err?: Error) => {
          console.log("[WebRTC] CHANNEL_STATUS_CHANGED:", status, err ? `err=${err.message}` : "");
          callDebug.event(`channel: status=${status}${err ? " err=" + err.message : ""}`);
          if (status === "SUBSCRIBED") {
            callDebug.update({ channelStatus: "subscribed" });
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            callDebug.update({
              channelStatus: status === "TIMED_OUT" ? "timeout" : "error",
              channelError: err?.message ?? status,
            });
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
      console.log("[CALL_TIMING] WEBRTC_INIT_START", { matchId, isCaller, isVideo, ts: new Date().toISOString() });
      console.log("[WebRTC] Initializing:", { matchId, isCaller, isVideo });
      console.log("[CALL_ANSWER] WEBRTC_INIT_START", {
        matchId, isCaller, isVideo,
        cleanedUpAtStart: cleanedUpRef.current,
        ts: new Date().toISOString(),
      });

      // ── Critical: stop ALL ringtone audio BEFORE opening the mic ──────────
      // cleanupCallAudio() pauses and clears the ringtone/ringback HTMLAudioElements
      // before getUserMedia() is called. This ensures a completely silent audio
      // environment when the mic opens. The 80 ms pause gives the OS time to
      // complete its audio session category switch before capture begins.
      cleanupCallAudio("webrtc_init_before_getUserMedia");
      console.log("[PHONE_AUDIO] non-call sound removed: before getUserMedia");
      callDebug.event("init: audio cleanup done");
      console.log("[CALL_ANSWER] audio_cleanup_done — pausing 80ms for AVAudioSession handshake");
      await new Promise<void>(r => setTimeout(r, 80));
      // ── Early-abort check ─────────────────────────────────────────────────
      // cleanedUpRef becomes true if:
      //   (a) The component unmounted during the 80ms (activeCall went null)
      //   (b) hangup() was called during the 80ms
      //   (c) isCaller/isVideo/enabled props changed → effect cleanup fired
      // If this fires it means the call died before getUserMedia even ran.
      if (cleanedUpRef.current) {
        console.error("[CALL_ANSWER] EARLY_ABORT: cleanedUpRef=true after 80ms pause — init aborting", {
          matchId, isCaller,
          reason: "component unmounted or hangup() called during 80ms audio-settle window",
          ts: new Date().toISOString(),
        });
        return;
      }
      console.log("[CALL_ANSWER] 80ms_pause_passed", { matchId, isCaller, cleanedUp: false });

      setConnectionState("requesting-media");
      setPermissionDenied(false);

      const channelName = `call:${matchId}`;
      // self:false ensures Supabase does not echo our own broadcast back to us.
      // The payload.from !== userId filter in handleSignal is the belt-and-suspenders
      // layer, but relying on that alone means own messages traverse the network
      // round-trip before being dropped — self:false avoids that entirely.
      const channel = supabase.channel(channelName, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = channel;
      callDebug.update({ channelStatus: "subscribing" });
      callDebug.event(`init: channel created (${channelName})`);

      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        if (!payload) return;
        if (payload.from === userId) {
          // Belt-and-suspenders: self:false should prevent this, but log if it
          // somehow fires so we can catch Supabase config regressions.
          console.warn("[CALL_SIGNAL] ignored own signalling message", {
            type: payload.type,
            from: String(payload.from).slice(0, 8),
            matchId,
          });
          console.warn("[SIGNAL_AUDIT] ignored own signalling message — self-broadcast leaked through", {
            type: payload.type,
            from: String(payload.from).slice(0, 8),
            matchId,
          });
          return;
        }
        handleSignal(payload as SignalMessage);
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
          // Tier 3 — echoCancellation only (drop noiseSuppression for older Safari)
          {
            audio: { echoCancellation: true },
            video: isVideo ? { facingMode: "user" } : false,
          },
          ];

        let lastErr: unknown;
        for (let i = 0; i < tiers.length; i++) {
          const constraints = tiers[i];
          try {
            callDebug.event(`media: tier ${i + 1} start`);
            console.log("[WebRTC] MEDIA_ACQUIRE_START tier", i + 1, ":", JSON.stringify(constraints));
            const stream = await getUserMediaWithTimeout(constraints);
            callDebug.update({ mediaStatus: "ok", mediaTier: i + 1 });
            callDebug.event(`media: ok (tier ${i + 1})`);
            const constraintSummary = i === 0
              ? "echoCancellation+noiseSuppression+autoGainControl"
              : i === 1 ? "echoCancellation+noiseSuppression"
              : i === 2 ? "echoCancellation"
              : "browser-default (no explicit echo constraints)";
            if (i > 0) {
              console.warn("[WebRTC] MEDIA_CONSTRAINT_FALLBACK: succeeded on tier", i + 1,
                "— echo cancellation may be reduced:", constraintSummary);
            }
            // Log echo-cancellation status at the confirmed tier.
            // echoCancellation is present in all three tiers — AEC is always on.
            // Tier 3 (echoCancellation only) is the minimum: noiseSuppression and
            // autoGainControl are omitted because some older Safari rejects them,
            // but echoCancellation must always be requested to prevent feedback.
            console.log("[FEEDBACK_FIX] echo cancellation enabled — tier", i + 1, ":", constraintSummary, { matchId, isCaller });
            console.log("[STREAM_AUDIT] local stream id", {
              streamId: stream.id,
              tracks: stream.getTracks().map(t => ({ kind: t.kind, id: t.id.slice(0, 12) })),
              tier: i + 1,
              matchId,
              isCaller,
            });
            // [SCREECH_FIX] — easy-filter log for the self-audio investigation.
            // echoCancellation value comes from getSettings() so it reflects what the
            // browser actually applied, not just what was requested.
            const audioSettings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
            console.log("[SCREECH_FIX] local stream id", {
              id: stream.id.slice(0, 16),
              audioTrackIds: stream.getAudioTracks().map(t => t.id.slice(0, 12)),
              echoCancellation: (audioSettings as any).echoCancellation ?? "not-reported",
              noiseSuppression: (audioSettings as any).noiseSuppression ?? "not-reported",
              tier: i + 1,
              matchId,
            });
            return stream;
          } catch (err: any) {
            lastErr = err;
            const isConstraintError = err?.name === "OverconstrainedError" ||
              err?.name === "NotSupportedError" ||
              err?.name === "TypeError";
            if (!isConstraintError || i === tiers.length - 1) {
              callDebug.update({ mediaStatus: "error", mediaError: `${err?.name ?? ""}:${err?.message ?? ""}` });
              callDebug.event(`media: FAILED ${err?.name ?? "unknown"}`);
              // Non-constraint error (permission denied, no device, timeout) or
              // exhausted all tiers — rethrow so the caller handles it properly.
              throw err;
            }
            callDebug.event(`media: tier ${i + 1} constraint err (${err?.name}) — trying next`);
            console.warn("[WebRTC] MEDIA_CONSTRAINT_FALLBACK: tier", i + 1, "failed (", err?.name, ") — trying simpler constraints");
          }
        }
        throw lastErr;
      };

      console.log("[WebRTC] CHANNEL_SUBSCRIBE_START: subscribing to signaling channel:", channelName);
      console.log("[CALL_ANSWER] getUserMedia_and_channel_start", { matchId, isCaller, channelName, ts: new Date().toISOString() });

      const [mediaResult, channelResult] = await Promise.allSettled([
        getUserMediaWithFallback(),
        subscribeChannel(channel),
      ]);

      console.log("[CALL_ANSWER] getUserMedia_and_channel_settled", {
        matchId, isCaller,
        mediaStatus: mediaResult.status,
        channelStatus: channelResult.status,
        cleanedUp: cleanedUpRef.current,
        ts: new Date().toISOString(),
      });

      if (cleanedUpRef.current) {
        console.error("[CALL_ANSWER] EARLY_ABORT_POST_MEDIA: cleanedUpRef=true after media+channel settled — aborting", {
          matchId, isCaller,
          mediaStatus: mediaResult.status,
          channelStatus: channelResult.status,
          reason: "component unmounted or hangup() called while getUserMedia was running",
        });
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
        console.error("[CALL_ANSWER] FAILURE_REASON: getUserMedia rejected", {
          matchId, isCaller,
          name: err?.name ?? "(no name)",
          message: err?.message ?? "(no message)",
          constraint: (err as any)?.constraint ?? "(none)",
        });
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

      console.log("[CALL_CONNECT] local media acquired", { matchId, isCaller, tracks: mediaResult.value.getTracks().map(t => t.kind), ts: new Date().toISOString() });
      console.log("[CALL_TIMING] MEDIA_ACQUIRED", { matchId, isCaller, ts: new Date().toISOString() });
      console.log("[WebRTC] MEDIA_ACQUIRE_SUCCESS: stream tracks:", mediaResult.value.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
      console.log("[CALL_DEBUG] MEDIA_OK: mic/camera acquired", { matchId, isCaller, tracks: mediaResult.value.getTracks().map(t => t.kind) });
      console.log("[CALL_ANSWER] local_media_acquired", {
        matchId, isCaller,
        tracks: mediaResult.value.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })),
        ts: new Date().toISOString(),
      });
      callDebug.event("init: media acquired ✓");

      if (channelResult.status === "rejected") {
        const err = channelResult.reason;
        console.error("[WebRTC] CHANNEL_SUBSCRIBE_FAILED: signaling channel never reached SUBSCRIBED —", err?.message ?? "(no message)");
        console.error("[WebRTC] FAILURE_TRIGGER: setting connectionState=failed from channel subscribe step");
        console.error("[CALL_ANSWER] FAILURE_REASON: signaling channel failed to subscribe", {
          matchId, isCaller,
          error: err?.message ?? "(no message)",
          channelName,
        });
        callDebug.update({ outcome: "failed", failureReason: `channel failed: ${err?.message ?? "unknown"}` });
        callDebug.event(`init: CHANNEL FAILED — ${err?.message ?? "unknown"}`);
        cleanup();
        setConnectionState("failed");
        return;
      }

      console.log("[WebRTC] CHANNEL_SUBSCRIBE_SUCCESS: signaling channel is ready");
      console.log("[CALL_DEBUG] CHANNEL_OK: signaling channel subscribed", { matchId, isCaller });
      callDebug.event("init: channel subscribed ✓");

      const stream = mediaResult.value;
      localStreamRef.current = stream;
      setLocalStream(stream);

      console.log("[STREAM_AUDIT] local stream id", {
        streamId: stream.id,
        tracks: stream.getTracks().map(t => ({ kind: t.kind, id: t.id.slice(0, 12), enabled: t.enabled, readyState: t.readyState })),
        matchId,
        isCaller,
      });

      if (cleanedUpRef.current) return;

      console.log("[WebRTC] PC_CREATE_START: creating RTCPeerConnection with", ICE_SERVERS.length, "ICE server(s)");
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      callDebug.event(`init: PC created (${ICE_SERVERS.length} ICE server(s))`);

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
      callDebug.event(`init: local tracks (${stream.getTracks().map(t => t.kind).join(",")})`);

      pc.ontrack = (event) => {
        // Snapshot local track IDs at event time so we can detect self-monitoring.
        const localTrackIds = new Set(localStreamRef.current?.getTracks().map(t => t.id) ?? []);

        console.log("[CALL_TIMING] REMOTE_TRACK_RECEIVED", { matchId, isCaller, trackKind: event.track.kind, ts: new Date().toISOString() });
        console.log("[STREAM_AUDIT] remote stream from pc.ontrack id", {
          streamId: event.streams[0]?.id ?? "no-stream",
          trackKind: event.track.kind,
          trackId: event.track.id.slice(0, 12),
          streamCount: event.streams.length,
          isLocalTrack: localTrackIds.has(event.track.id),
          matchId,
          isCaller,
        });
        console.log("[SCREECH_FIX] remote pc.ontrack stream id", {
          streamId: event.streams[0]?.id?.slice(0, 16) ?? "no-stream",
          trackKind: event.track.kind,
          trackId: event.track.id.slice(0, 12),
          isLocalTrack: localTrackIds.has(event.track.id),
          localTrackCount: localTrackIds.size,
          matchId,
        });

        // Guard A: never add our own local track to the remote stream.
        // If this fires it means WebRTC looped our track back (self-call scenario
        // or a browser bug). Block it and log loudly so it appears in console.
        if (localTrackIds.has(event.track.id)) {
          console.error("[CALL_AUDIO] local mic playback blocked", {
            trackId: event.track.id.slice(0, 12),
            trackKind: event.track.kind,
            reason: "pc.ontrack guard A — own local track arrived in remote event",
            matchId,
          });
          console.error("[STREAM_AUDIT] BLOCKED local stream playback — pc.ontrack received own local track, preventing self-monitoring", {
            trackId: event.track.id.slice(0, 12),
            trackKind: event.track.kind,
            matchId,
            isCaller,
          });
          return;
        }

        console.log("[CALL_AUDIO] remote stream from pc.ontrack only", {
          trackKind: event.track.kind,
          trackId: event.track.id.slice(0, 12),
          matchId,
        });

        // Add tracks from the remote stream bundle (standard path).
        // Also check each individual track against local IDs.
        const tracksAdded: string[] = [];
        event.streams[0]?.getTracks().forEach((track) => {
          if (localTrackIds.has(track.id)) {
            console.error("[CALL_AUDIO] local mic playback blocked", {
              trackId: track.id.slice(0, 12),
              trackKind: track.kind,
              reason: "pc.ontrack guard A — local track found in remote stream bundle",
              matchId,
            });
            console.error("[STREAM_AUDIT] BLOCKED local stream playback — local track found inside remote stream bundle, skipping", {
              trackId: track.id.slice(0, 12),
              trackKind: track.kind,
              matchId,
            });
            return;
          }
          if (!remote.getTrackById(track.id)) {
            remote.addTrack(track);
            tracksAdded.push(track.kind);
          }
        });

        // Fallback path: if event.streams[0] is undefined or empty (non-standard
        // Chrome/Firefox behaviour when addTrack is called without a stream arg),
        // add event.track directly. This prevents silent "no remote audio" failures.
        if ((!event.streams[0] || event.streams[0].getTracks().length === 0) &&
            !remote.getTrackById(event.track.id)) {
          remote.addTrack(event.track);
          tracksAdded.push(`${event.track.kind}(fallback)`);
          console.log("[STREAM_AUDIT] remote track added via fallback path (no streams array)", {
            trackKind: event.track.kind,
            trackId: event.track.id.slice(0, 12),
            matchId,
          });
        }

        console.log("[WebRTC] Remote track received:", {
          trackKind: event.track.kind,
          trackEnabled: event.track.enabled,
          trackReadyState: event.track.readyState,
          streams: event.streams.length,
          tracksAdded,
        });
        setRemoteStream(new MediaStream(remote.getTracks()));
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const ctype = event.candidate.type ?? "unknown";
          if (ctype === "host") candidateCountsRef.current.host++;
          else if (ctype === "srflx") candidateCountsRef.current.srflx++;
          else if (ctype === "relay") candidateCountsRef.current.relay++;
          const totalsNow = candidateCountsRef.current;
          callDebug.update({
            iceSent: totalsNow.host + totalsNow.srflx + totalsNow.relay,
            iceTypes: { ...totalsNow },
            iceHasTurn: totalsNow.relay > 0,
          });
          callDebug.event(`ice: sent ${ctype} (H:${totalsNow.host} S:${totalsNow.srflx} R:${totalsNow.relay})`);
          console.log("[WebRTC] ICE_CANDIDATE_GENERATED:", {
            type: ctype,
            protocol: event.candidate.protocol,
            address: event.candidate.address,
            port: event.candidate.port,
            totals: { ...candidateCountsRef.current },
          });
          broadcastOnChannel({ type: "webrtc:ice", candidate: event.candidate.toJSON() });
          console.log("[CALL_CONNECT] ice candidate sent", { type: ctype, protocol: event.candidate.protocol });
        } else {
          const totals = candidateCountsRef.current;
          const hasTurn = totals.relay > 0;
          callDebug.update({ iceHasTurn: hasTurn });
          callDebug.event(`ice: gathering done H:${totals.host} S:${totals.srflx} R:${totals.relay} TURN:${hasTurn}`);
          console.log("[WebRTC] ICE_GATHERING_COMPLETE:", {
            host: totals.host,
            srflx: totals.srflx,
            relay: totals.relay,
            hasTurn,
            note: !hasTurn ? "NO TURN relay — calls may fail on symmetric NAT / restricted networks" : "TURN relay available",
          });
        }
      };

      pc.onicegatheringstatechange = () => {
        console.log("[WebRTC] iceGatheringState:", pc.iceGatheringState);
      };

      pc.onsignalingstatechange = () => {
        const s = pc.signalingState;
        callDebug.update({ signalingStates: [...callDebug.get().signalingStates, s] });
        callDebug.event(`signaling: → ${s}`);
        console.log("[WebRTC] signalingState:", s);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        callDebug.update({ pcStates: [...callDebug.get().pcStates, s] });
        callDebug.event(`pc: → ${s}`);
        console.log("[CALL_TIMING] PC_STATE_CHANGE", { matchId, isCaller, state: s, ts: new Date().toISOString() });
        console.log("[WebRTC] connectionState:", s, {
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
        });
      };

      pc.oniceconnectionstatechange = () => {
        if (cleanedUpRef.current) return;
        const state = pc.iceConnectionState;
        const totalsNow = candidateCountsRef.current;
        callDebug.update({ iceStates: [...callDebug.get().iceStates, state] });
        callDebug.event(`ice: state → ${state}`);
        console.log("[CALL_TIMING] ICE_STATE_CHANGE", { matchId, isCaller, state, ts: new Date().toISOString() });
        console.log("[WebRTC] ICE connection state:", state, {
          matchId,
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
        });
        console.log("[CALL_ANSWER] peer_connection_state", {
          matchId, isCaller,
          iceState: state,
          signalingState: pc.signalingState,
          pcConnectionState: pc.connectionState,
          candidatesSent: { host: totalsNow.host, srflx: totalsNow.srflx, relay: totalsNow.relay },
          hasTurn: totalsNow.relay > 0,
          ts: new Date().toISOString(),
        });
        if (state === "connected" || state === "completed") {
          console.log("[CALL_CONNECT] connected", { matchId, isCaller, iceState: state, ts: new Date().toISOString() });
          callDebug.update({ outcome: "connected", connectedAt: new Date().toISOString().slice(11, 23) });
          callDebug.event("ice: CONNECTED ✓");
          console.log("[CALL_DEBUG] ICE_CONNECTED: peer-to-peer path established", {
            matchId, isCaller, state,
            candidates: { ...candidateCountsRef.current },
          });
          if (disconnectTimerRef.current) {
            clearTimeout(disconnectTimerRef.current);
            disconnectTimerRef.current = null;
          }
          if (connectionTimeoutRef.current) {
            clearTimeout(connectionTimeoutRef.current);
            connectionTimeoutRef.current = null;
          }
          setConnectionState("connected");

          // ── [FEEDBACK_FIX] Re-enforce AEC constraints at connect ────────────
          // Re-apply the full echo/noise/gain constraints now that ICE is up.
          // Browsers (especially iOS Safari) can silently drop preferred
          // constraints during negotiation; re-applying here maximises the
          // chance AEC is active for the conversation.
          // NOTE: do NOT mute/unmute tracks here — on iOS, toggling
          // track.enabled triggers an audio-session reconfiguration that causes
          // pops and can disrupt the audio routing for the rest of the call.
          const audioTrack = localStreamRef.current?.getAudioTracks()[0];
          if (audioTrack) {
            audioTrack.applyConstraints({
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }).then(() => {
              const settings = audioTrack.getSettings() as any;
              console.log("[FEEDBACK_FIX] AEC constraints confirmed at connect", {
                matchId,
                isCaller,
                echoCancellation: settings.echoCancellation ?? "not-reported",
                noiseSuppression: settings.noiseSuppression ?? "not-reported",
                autoGainControl: settings.autoGainControl ?? "not-reported",
              });
            }).catch(err => {
              console.warn("[FEEDBACK_FIX] AEC re-apply failed at connect", {
                matchId,
                isCaller,
                error: err?.message ?? String(err),
              });
            });
          }
        } else if (state === "disconnected") {
          callDebug.event("ice: disconnected — 20s timer started");
          setConnectionState("reconnecting");
          if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = setTimeout(() => {
            if (!cleanedUpRef.current && pcRef.current?.iceConnectionState === "disconnected") {
              const reason = "ice_disconnected_20s — network dropped and did not recover";
              console.error("[WebRTC] FAILURE_TRIGGER:", reason, { matchId });
              callDebug.update({ outcome: "failed", failureReason: reason });
              callDebug.event("ice: DISCONNECT TIMEOUT (20s) — failed");
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
              setFailureReason(reason);
              setConnectionState("failed");
            }
          }, 20000);
        } else if (state === "failed") {
          const totals = candidateCountsRef.current;
          const reason = totals.relay > 0
            ? `ice_failed — TURN available but ICE still failed (host=${totals.host} srflx=${totals.srflx} relay=${totals.relay})`
            : totals.srflx > 0
            ? `ice_failed — STUN-only, symmetric NAT likely blocked (host=${totals.host} srflx=${totals.srflx} relay=0). Add TURN.`
            : `ice_failed — no SRFLX/relay candidates gathered (host=${totals.host}). Firewall or device issue.`;
          console.error("[CALL_CONNECT] failed reason", { matchId, isCaller, reason, candidates: { ...totals }, signalingState: pc.signalingState, hasRemoteDesc: hasSetRemoteDescRef.current });
          callDebug.update({ outcome: "failed", failureReason: reason });
          callDebug.event(`ice: FAILED — ${reason.slice(0, 80)}`);
          console.error("[CALL_DEBUG] ICE_FAILED:", reason, { matchId, isCaller, candidates: { ...totals } });
          console.error("[WebRTC] FAILURE_TRIGGER:", reason, {
            matchId,
            signalingState: pc.signalingState,
            connectionState: pc.connectionState,
            iceGatheringState: pc.iceGatheringState,
          });
          console.error("[CALL_ANSWER] FAILURE_REASON: ICE failed", {
            matchId, isCaller,
            reason,
            candidates: { ...totals },
            signalingState: pc.signalingState,
            hasSetRemoteDesc: hasSetRemoteDescRef.current,
            note: totals.relay === 0
              ? "NO TURN relay — add VITE_TURN_URL/VITE_TURN_USERNAME/VITE_TURN_CREDENTIAL to fix on real networks"
              : "TURN was configured but ICE still failed",
            ts: new Date().toISOString(),
          });
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
          setFailureReason(reason);
          setConnectionState("failed");
        } else if (state === "closed") {
          setConnectionState("closed");
        }
      };

      setConnectionState("connecting");

      // 60-second hard timeout — gives ICE enough time to gather and test
      // candidates even on slow mobile networks or when STUN takes multiple
      // round-trips.  30 s was too short for real-world conditions.
      connectionTimeoutRef.current = setTimeout(() => {
        if (cleanedUpRef.current) return;
        const iceState = pcRef.current?.iceConnectionState;
        const sigState = pcRef.current?.signalingState;
        if (iceState !== "connected" && iceState !== "completed") {
          const totals = candidateCountsRef.current;
          const reason =
            sigState === "have-local-offer"
              ? `timeout_60s — offer was sent but no answer received (receiver may have missed it). Candidates: host=${totals.host} srflx=${totals.srflx} relay=${totals.relay}`
              : sigState === "stable" && !hasSetRemoteDescRef.current
              ? `timeout_60s — no offer/answer exchange at all (signaling channel issue?). Candidates: host=${totals.host} srflx=${totals.srflx} relay=${totals.relay}`
              : `timeout_60s — ICE never connected (iceState=${iceState}). Candidates: host=${totals.host} srflx=${totals.srflx} relay=${totals.relay}`;
          console.error("[CALL_CONNECT] failed reason", { matchId, reason, iceState, sigState, candidates: { ...totals }, hasRemoteDesc: hasSetRemoteDescRef.current });
          console.error("[WebRTC] FAILURE_TRIGGER:", reason, {
            matchId, iceState, sigState,
            connectionState: pcRef.current?.connectionState,
            hasTurn: totals.relay > 0,
          });
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
          callDebug.update({ outcome: "failed", failureReason: reason });
          callDebug.event(`timeout: 60s EXPIRED — ${reason.slice(0, 80)}`);
          setFailureReason(reason);
          setConnectionState("failed");
        }
      }, 60000);

      callDebug.event(`init: ${isCaller ? "caller — calling sendOffer" : "callee — sending webrtc:ready"}`);
      if (isCaller) {
        await sendOffer();
      } else {
        // Send webrtc:ready immediately, then retry every 2s until the caller
        // responds with an offer. This handles the race condition where the caller
        // subscribes to the signaling channel AFTER the receiver's first ready signal.
        const sendReady = () => {
          if (cleanedUpRef.current || hasSetRemoteDescRef.current) return;
          const count = callDebug.get().readySent + 1;
          callDebug.update({ readySent: count });
          callDebug.event(`ready: sent #${count}`);
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
    callDebug.update({ outcome: "ended" });
    callDebug.event("hangup: user ended call");
    console.log("[CALL_DEBUG] HANGUP: tearing down WebRTC session", { matchId });
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
    failureReason,
    permissionDenied,
    isMuted,
    isCameraOff,
    toggleMute,
    toggleCamera,
    hangup,
  };
}
