import { useState, useEffect, useRef, useCallback } from "react";
import { useLanguageContext } from "@/contexts/language-context";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { useWebRTC } from "@/hooks/use-webrtc";
import { useCallRingtone } from "@/hooks/use-call-ringtone";
import {
  cleanupCallAudio,
  stopAllNonVoiceCallAudio,
  registerCallAudioElement,
  unregisterCallAudioElement,
} from "@/lib/call-audio";
import { callDebug } from "@/lib/call-debug";
import { markSelfCancelled } from "@/lib/cancelled-calls";
import { CallDebugPanel } from "@/components/call-debug-panel";
import {
  configureVoiceChat,
  setSpeaker,
  deactivateAudioSession,
} from "@/lib/audio-session";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { PhoneOff, Mic, MicOff, Volume2, Camera, CameraOff, Loader2, WifiOff, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Duration in seconds for each call stage (guided/free progression).
// stage 0 = first voice call (10 min), stage 1 = second voice call (15 min),
// stage 3 = face call (10 min). All others default to 10 min.
const CALL_DURATIONS_SEC: Record<number, number> = { 0: 10 * 60, 1: 15 * 60, 3: 10 * 60 };
function getStageDuration(callStage: number): number {
  return CALL_DURATIONS_SEC[callStage] ?? 10 * 60;
}
// Paid credit call durations: paid phone = 15 min (900s), paid video = 10 min (600s).
function getPaidDuration(isVideo: boolean): number {
  return isVideo ? 10 * 60 : 15 * 60;
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
  isPaidCall?: boolean;
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
    <div className="flex flex-col items-center gap-2.5">
      <button
        className="w-[60px] h-[60px] rounded-full flex items-center justify-center active:scale-90 transition-all disabled:opacity-40"
        style={{
          background: active ? "hsl(350 45% 52% / 0.3)" : "hsl(0 0% 100% / 0.1)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: `1.5px solid ${active ? "hsl(350 45% 65% / 0.45)" : "hsl(0 0% 100% / 0.14)"}`,
          boxShadow: "0 2px 18px hsl(0 0% 0% / 0.22)",
        }}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      >
        {icon}
      </button>
      <span className="text-white/45 text-[11px] tracking-wide">{label}</span>
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
  isPaidCall = false,
  onCallEnd,
}: ActiveCallProps) {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  // Live refs so async .then() callbacks can fire toasts after the overlay unmounts
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;
  const queryClient = useQueryClient();
  const endedRef = useRef(false);
  // Speaker defaults to OFF for ALL call types (audio and video).
  //
  // WHY NOT `useState(isVideo)` for video calls:
  //   On iPhone Safari (plain web — NOT Capacitor), configureVoiceChat() and
  //   setSpeaker() are no-ops.  The ONLY audio routing control is el.volume.
  //   The iPhone speaker is physically millimetres from the open mic.  At
  //   volume=1.0 the mic picks up the speaker output; without hardware AEC
  //   (which requires the native AVAudioSession voiceChat mode, only available
  //   via Capacitor) the software AEC cannot suppress the feedback loop.
  //   Result: acoustic feedback builds into screeching and ringing tones.
  //   At volume=0.25 the signal is weak enough for the software AEC to handle.
  //
  //   Users who want loudspeaker on an audio call can tap the speaker button.
  //   Video calls have no speaker button — they stay at 0.25 (earpiece-safe)
  //   on iOS and at 1.0 via setSinkId("default") on desktop Chrome/Android
  //   where hardware echo cancellation works properly.
  const [speakerOn, setSpeakerOn] = useState(false);
  // Ref so the connectionState effect can read the current speaker toggle without
  // adding speakerOn to its deps array (which would re-run the whole effect on every toggle).
  const speakerOnRef = useRef(false);
  useEffect(() => { speakerOnRef.current = speakerOn; }, [speakerOn]);
  const [timerExpiredMsg, setTimerExpiredMsg] = useState("");
  // Track exactly when WebRTC first reached "connected" so we can measure live duration
  const connectedAtRef = useRef<number | null>(null);
  // Track when the physical WebRTC connection LEFT "connected" state.
  // spec: connectedDuration = callDisconnectedAt - callConnectedAt
  // Using Date.now() in finishCall would inflate the duration by any time spent
  // staring at the "Connection failed" screen before pressing End Call.
  const disconnectedAtRef = useRef<number | null>(null);

  // Update call debug log with session ID and partner context as soon as they are known.
  useEffect(() => {
    callDebug.update({ sessionId: callSessionId });
  }, [callSessionId]);

  // ─────────────────────────────────────────────────────────────────────────────
  // IMPORTANT: useWebRTC and derived booleans (isConnected, warning, etc.) MUST
  // be declared BEFORE any useCallback/useEffect that references them in deps
  // arrays. Accessing a `const` in a deps array before its declaration in the
  // same function scope is a Temporal Dead Zone (TDZ) ReferenceError at runtime,
  // crashing the component and — because CallDetectors has no ErrorBoundary —
  // the entire app. The previous ordering (video controls section before useWebRTC)
  // was the root cause of the "both screens go white on call accept" crash.
  // ─────────────────────────────────────────────────────────────────────────────

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
    failureReason,
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

  // Derived booleans from connectionState — must be here (after useWebRTC) so
  // they are in scope for every useCallback/useEffect deps array that follows.
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "requesting-media";
  const isReconnecting = connectionState === "reconnecting";
  const isFailed = connectionState === "failed";

  // Countdown timer — starts when WebRTC connects, counts down to 0 then auto-ends.
  // Paid credit calls use fixed durations (phone = 15 min, video = 10 min).
  const stageDuration = isPaidCall ? getPaidDuration(isVideo) : getStageDuration(callStage);
  const { display: countdownDisplay, remaining, warning } = useCountdownTimer(isConnected, stageDuration);

  const stageLabel = callStage === 0 ? t("first_call_stage_label") : callStage === 1 ? t("second_call_stage_label") : t("face_call_stage_label_audio");

  // Outgoing ringback tone: play only while the caller is waiting for an answer.
  // Stops automatically when isRinging becomes false (answered) or on unmount.
  // Pass callSessionId so the armed-session guard verifies this is a live call.
  useCallRingtone("outgoing", isRinging && isCaller, callSessionId);

  // ── Video call: FaceTime-like auto-hide controls ──────────────────────────
  // Controls start visible, then auto-hide after 3 s of inactivity.
  // Any tap on the overlay resets the timer and shows controls again.
  const [showControls, setShowControls] = useState(true);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startHideTimer = useCallback(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000);
  }, []);

  const showAndResetTimer = useCallback(() => {
    if (!isVideo || !isConnected) return;
    setShowControls(true);
    startHideTimer();
  }, [isVideo, isConnected, startHideTimer]);

  // Begin auto-hide as soon as a video call connects
  useEffect(() => {
    if (!isVideo || !isConnected) return;
    startHideTimer();
    return () => { if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current); };
  }, [isVideo, isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force-show controls on any countdown warning so user sees time running out
  useEffect(() => {
    if (!isVideo || !isConnected) return;
    if (warning !== "none") {
      setShowControls(true);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    }
  }, [warning, isVideo, isConnected]);

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  // On unmount: detach the remote stream from the audio/video elements and
  // run a final cleanupCallAudio() to stop any ringtone that somehow survived.
  // Without this, audio elements linger decoding for a few frames after the
  // React tree removes the component, which can bleed into the next call's
  // mic capture.
  useEffect(() => {
    // ── [CALL_ANSWER] Mount log — fires once when ActiveCallOverlay mounts ──
    // If you see EARLY_UNMOUNT immediately after this, it means the parent
    // (App.tsx CallDetectors) removed activeCall within one render cycle,
    // which would set cleanedUpRef=true and abort WebRTC init.
    console.log("[CALL_ANSWER] ACTIVE_CALL_OVERLAY_MOUNTED", {
      matchId,
      callSessionId,
      isCaller,
      isRinging,
      webrtcEnabled,
      isVideo,
      ts: new Date().toISOString(),
    });

    return () => {
      // ── [CALL_ANSWER] Unmount log — if this fires during WebRTC init it's the race ──
      console.log("[CALL_ANSWER] ACTIVE_CALL_OVERLAY_UNMOUNTED", {
        matchId,
        callSessionId,
        isCaller,
        endedRefAtUnmount: endedRef.current,
        ts: new Date().toISOString(),
        note: "If this fires during 80ms pause or getUserMedia, cleanedUpRef becomes true and WebRTC init aborts",
      });

      // Final safety net — stops any outstanding ringtone AudioContext and
      // detaches elements that were registered with call-audio.ts.
      cleanupCallAudio("active_call_unmount");
      // Native iOS: deactivate AVAudioSession so the system restores its
      // default audio session for other apps. No-op on plain web.
      deactivateAudioSession();

      // Direct element cleanup as a belt-and-suspenders fallback.
      if (remoteAudioRef.current) {
        unregisterCallAudioElement(remoteAudioRef.current);
        remoteAudioRef.current.pause();
        remoteAudioRef.current.srcObject = null;
        console.log("[CALL_UI] AUDIO_ELEMENT_DETACHED on unmount", { matchId });
      }
      if (remoteVideoRef.current) {
        unregisterCallAudioElement(remoteVideoRef.current);
        remoteVideoRef.current.pause();
        remoteVideoRef.current.srcObject = null;
      }
      if (localVideoRef.current) {
        localVideoRef.current.pause();
        localVideoRef.current.srcObject = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route audio to speaker or earpiece when the toggle changes.
  //
  // Desktop / Android (setSinkId supported):
  //   Always setSinkId("default") — routes output through Chrome's audio pipeline
  //   so the software AEC reference signal matches the actual speaker output.
  //   Without this, AEC can diverge from the real output route causing echo/screech.
  //
  // iOS / Safari (setSinkId NOT supported — the previous code returned early here,
  // doing nothing, so audio always played at full volume through the loudspeaker):
  //   iOS web apps use the "media playback" AudioSession category. The earpiece
  //   route is only accessible via native AVAudioSession — web apps cannot reach
  //   it. Instead we approximate the two modes with volume:
  //   speaker OFF (default) → volume 0.25 — safe low level; reduces acoustic
  //     echo bleed into the open mic so hardware AEC can suppress the remainder.
  //   speaker ON            → volume 1.0  — full loudspeaker volume.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    const el = remoteAudioRef.current as any;
    if (!el) return;

    if (!isIOS && typeof el.setSinkId === "function") {
      // Desktop / Android Chrome — ALWAYS call setSinkId("default") regardless of
      // speakerOn state. This is not a speaker-vs-earpiece routing call; it is an
      // AEC reference path registration.
      //
      // Chrome's software AEC needs to know which output device the remote voice
      // is playing through so it can sample that device's signal as the echo
      // reference when cancelling it from the mic input. Without setSinkId, the AEC
      // reference path may diverge from the actual output route (e.g. Bluetooth
      // headset, external speaker) causing the echo/screech feedback loop.
      //
      // setSinkId("") (empty / "comms device") was tried as an earpiece-routing
      // trick but it breaks the AEC reference path on Chrome → echo returns.
      // setSinkId("default") is the correct value: it routes to the system default
      // multimedia playback device AND correctly seeds Chrome's AEC pipeline.
      //
      // Web / PWA limitation: earpiece routing is NOT achievable via setSinkId on
      // Chrome or any web browser. The speaker button is a loudness toggle for iOS
      // (volume 0.25 vs 1.0) — on desktop/Android the button is intentionally a
      // no-op for routing since we cannot safely change the AEC reference device.
      el.setSinkId("default").catch(() => {});
      el.volume = 1.0;
      console.log("[CALL_AUDIO] setSinkId(default) — AEC reference path set", { speakerOn, volume: 1.0, matchId });
      console.log("[CALL_FIX] laptop speaker default", { method: "setSinkId(default)-always", speakerOn, volume: 1.0, matchId });
    } else if (isIOS) {
      // iOS only: web cannot reach the AVAudioSession earpiece route.
      // We approximate the two modes with volume:
      //   speaker OFF (default) → 0.25 — safe low level, reduces acoustic
      //     echo bleed into the open mic. AEC suppresses the remainder.
      //   speaker ON            → 1.0  — full loudspeaker volume.
      // isConnected is in deps so this re-runs after WebRTC connects — iOS
      // audio session switches on getUserMedia, which can silently reset
      // el.volume to 1.0 after this effect's initial run on mount.
      const vol = speakerOn ? 1.0 : 0.25;
      el.volume = vol;
      // Native Capacitor path: route audio via AVAudioSession
      // overrideOutputAudioPort(.speaker/.none). No-op on plain web.
      setSpeaker(speakerOn);
      if (speakerOn) {
        console.log("[CALL_AUDIO] iphone speaker mode active", { volume: vol, matchId });
      } else {
        console.log("[CALL_AUDIO] iphone normal mode active", { volume: vol, matchId });
      }
      console.log("[CALL_FIX] iphone earpiece/default low volume", { volume: vol, speakerOn, isConnected, matchId });
      console.log("[CALL_CONTROLS] remote audio volume set", { volume: vol, matchId });
    } else {
      // Non-iOS device that lacks setSinkId (desktop Firefox, desktop Safari).
      // These are always in speaker/desktop mode — use full volume.
      el.volume = 1.0;
      console.log("[CALL_AUDIO] laptop earpiece/default mode active", { method: "no-setSinkId-non-ios", volume: 1.0, matchId });
      console.log("[CALL_FIX] laptop speaker default", { volume: 1.0, speakerOn, matchId, reason: "no_setSinkId_non_ios" });
      console.log("[CALL_CONTROLS] remote audio volume set", { volume: 1.0, matchId });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakerOn, matchId, isConnected]);

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

  // ── Native iOS: early AVAudioSession configure — BEFORE getUserMedia() ────────
  //
  // WHY HERE and not in the connectionState==="connected" branch below:
  //
  //   iOS hardware AEC (Acoustic Echo Cancellation) only engages when AVAudioSession
  //   is in .voiceChat mode BEFORE getUserMedia() opens the microphone.  If the
  //   session is configured after the mic is already open (as happens at "connected",
  //   which fires after ICE negotiation completes), the AEC reference path is set up
  //   with the wrong audio category and the hardware suppressor never activates.
  //   Result without this fix: the open mic captures the remote voice playing from
  //   the iPhone speaker, the remote peer hears their own voice looped back, the
  //   gain builds, and both parties hear screeching/beeping without headphones.
  //
  //   webrtcEnabled = !isRinging, which transitions to true the moment the call is
  //   answered — BEFORE useWebRTC() calls getUserMedia().  Configuring the session
  //   here gives iOS time to route the audio hardware (earpiece + AEC) before any
  //   microphone audio is captured.
  //
  //   The second configure() call below (on "connected") is kept as a safety net
  //   in case iOS resets the session during ICE setup, and it also syncs the
  //   speaker toggle state (speakerOnRef) after the session is active.
  //
  // Web / Android: configureVoiceChat() is a no-op (getPlugin() returns null),
  // so this effect is harmless on non-iOS platforms.
  useEffect(() => {
    if (!webrtcEnabled) return;
    configureVoiceChat();
    console.log("[NATIVE_AUDIO] early configureVoiceChat — before getUserMedia", { matchId, isVideo });
    console.log("[CALL_AUDIO] speaker default off", { speakerOn: false, matchId, note: "call answered — speaker starts in earpiece/quiet mode" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtcEnabled]);

  useEffect(() => {
    if (!webrtcEnabled) return;
    console.log("[WebRTC] CONNECTION_STATE_CHANGED", { matchId, connectionState, isCaller, isVideo });
    console.log("[CALL_DEBUG] STATE", { matchId, connectionState, isCaller, isVideo, ts: new Date().toISOString().slice(11, 23) });
    if (connectionState === "connected") {
      // Native iOS: safety-net configure on "connected".
      // The early configure (above) fires before getUserMedia() for proper AEC
      // setup.  This second call re-applies .voiceChat in case iOS reset the
      // session during ICE negotiation, and re-syncs the speaker toggle state
      // (speakerOnRef) so overrideOutputAudioPort matches the current button.
      // No-op on web — safe to call unconditionally.
      configureVoiceChat().then(() => {
        setSpeaker(speakerOnRef.current);
        console.log("[NATIVE_AUDIO] post-connect configure + speaker sync", {
          speakerOn: speakerOnRef.current,
          matchId,
        });
      });
      // Definitive cutover from ringing → voice-only mode.
      // stopAllNonVoiceCallAudio stops ONLY ringtone/ringback — it does NOT
      // pause the registered remote-voice element, which is important on
      // reconnection when the element may already be attached and playing.
      stopAllNonVoiceCallAudio("connected");
      console.log("[CALL_AUDIO_ONLY] non-voice sounds stopped on connect", { matchId, isCaller, phase: "connectionState_connected" });
      console.log("[CALL_FIX] non-voice audio stopped before connect", { matchId, isCaller, phase: "connectionState_connected" });
      console.log("[FINAL_CALL_FIX] connect beep stopped", { matchId, isCaller });
      console.log("[PHONE_AUDIO] connected call audio = remote voice only", { matchId, isCaller });
      console.log("[CALL_AUDIO] connected: remote voice only, non-voice sounds stopped", { matchId, isCaller });

      // ── Full audio element audit ───────────────────────────────────────────
      // Scans every <audio> and <video> on the page. Any unmuted element with
      // srcObject set to the LOCAL stream is a bug (mic feedback). Any element
      // that is neither the registered remoteAudio nor a muted video is a bug.
      const allMediaEls = Array.from(document.querySelectorAll("audio, video"));
      console.log(`[CALL_AUDIO_AUDIT] audio element count on page: ${allMediaEls.length}`);

      allMediaEls.forEach((el, i) => {
        const a = el as HTMLAudioElement | HTMLVideoElement;
        const srcObjStream = a.srcObject instanceof MediaStream ? a.srcObject : null;
        const trackKinds = srcObjStream
          ? srcObjStream.getTracks().map(t => `${t.kind}(${t.readyState})`).join(",")
          : "none";
        const isLocalStream = srcObjStream !== null && srcObjStream === localStream;
        const isRemoteStream = srcObjStream !== null && srcObjStream === remoteStream;
        console.log(
          `[CALL_AUDIO_AUDIT] audio element found [${i}]`,
          `tag=${el.tagName.toLowerCase()}`,
          `id="${el.id || "(none)"}"`,
          `muted=${a.muted}`,
          `paused=${a.paused}`,
          `loop=${a.loop}`,
          `volume=${a.volume}`,
          `src="${(a as HTMLAudioElement).src || "(none)"}"`,
          `srcObject=${srcObjStream ? "yes" : "no"}`,
          `tracks=${trackKinds}`,
          `isLocalStream=${isLocalStream}`,
          `isRemoteStream=${isRemoteStream}`,
        );
        if (isLocalStream && !a.muted) {
          console.error(`[CALL_AUDIO_AUDIT] BUG: local mic stream attached to UNMUTED element [${i}] — mic feedback!`);
        }
      });

      const remoteAttachedCount = allMediaEls.filter(el => (el as any).srcObject === remoteStream).length;
      const localUnmutedCount = allMediaEls.filter(el => {
        const a = el as HTMLAudioElement | HTMLVideoElement;
        return a.srcObject === localStream && !a.muted;
      }).length;
      if (remoteAttachedCount === 1) {
        console.log("[CALL_AUDIO_ONLY] one remote audio element", { matchId, isCaller, count: remoteAttachedCount });
        console.log("[CALL_AUDIO] confirmed single remote audio element", { matchId, isCaller });
      } else {
        console.warn(`[CALL_AUDIO_ONLY] unexpected remote audio element count: ${remoteAttachedCount}`, { matchId });
        console.warn(`[CALL_AUDIO] unexpected remote audio element count: ${remoteAttachedCount}`, { matchId });
      }
      console.log(`[CALL_AUDIO_AUDIT] remote stream attached count: ${remoteAttachedCount}`);
      console.log(`[CALL_AUDIO_AUDIT] local stream unmuted: ${localUnmutedCount > 0 ? `YES (${localUnmutedCount}) — BUG!` : "NO (correct)"}`);
      console.log(`[CALL_AUDIO_AUDIT] local stream id: ${localStream?.id ?? "none"} tracks: ${localStream?.getTracks().map(t => t.kind).join(",") ?? "none"}`);
      console.log(`[CALL_AUDIO_AUDIT] remote stream id: ${remoteStream?.id ?? "none"} tracks: ${remoteStream?.getTracks().map(t => t.kind).join(",") ?? "none"}`);

      // [SELF_AUDIO_FIX] Final confirmation log — emitted once per connected call.
      // Summarises every audio/video element on the page so any regression is
      // immediately visible in the console without having to decode raw audit lines.
      const selfMonitorBug = localUnmutedCount > 0;
      const remoteCountOk  = remoteAttachedCount === 1;
      if (!selfMonitorBug) {
        console.log("[FINAL_AUDIO_FIX] local mic not audible", { matchId, localUnmutedCount, verdict: "clean — no mic feedback path" });
      } else {
        console.error("[FINAL_AUDIO_FIX] local mic not audible — BUG DETECTED: mic attached to unmuted element", { matchId, localUnmutedCount });
      }
      console.log("[SELF_AUDIO_FIX] srcObject audit complete", {
        matchId,
        isCaller,
        selfMonitoringBug: selfMonitorBug,
        remoteAudioElementCount: remoteAttachedCount,
        localStreamUnmutedCount: localUnmutedCount,
        verdict: selfMonitorBug
          ? "BUG — local mic attached to unmuted element"
          : remoteCountOk
            ? "OK — exactly one remote audio source, local mic not playing locally"
            : `WARN — unexpected remote element count (${remoteAttachedCount})`,
      });

      // Record the first moment we were live — used to compute connectedDurationMs in finishCall
      if (connectedAtRef.current === null) {
        connectedAtRef.current = Date.now();
        console.log("[CALL_UI] CALL_STATE:connected", { matchId, callSessionId, isCaller, timestamp: connectedAtRef.current });
        console.log("[CALL_DEBUG] CONNECTED: WebRTC ICE established — call is live", { matchId, isCaller });
        console.log("[CALL_PROGRESSION] call_connected", { matchId, callSessionId, connectedAt: new Date(connectedAtRef.current).toISOString() });
      }
      // If the connection recovers after a drop, clear disconnectedAt so we don't
      // accidentally cap the duration at the moment of the earlier brief interruption.
      disconnectedAtRef.current = null;
    } else if (connectionState === "failed") {
      console.error("[CALL_UI] CALL_STATE:failed", { matchId, callSessionId, isCaller, hadConnection: connectedAtRef.current !== null });
      console.error("[CALL_DEBUG] FAILED: call never established or was lost", { matchId, isCaller, failureReason });
      // Stamp the physical disconnection time now — not when the user presses End Call.
      if (connectedAtRef.current !== null && disconnectedAtRef.current === null) {
        disconnectedAtRef.current = Date.now();
        console.log("[CALL_PROGRESSION] call_physically_disconnected", { matchId, connectionState: "failed", disconnectedAt: new Date(disconnectedAtRef.current).toISOString(), connectedDurationSoFar: disconnectedAtRef.current - connectedAtRef.current });
      }
    } else if (connectionState === "reconnecting") {
      console.warn("[CALL_UI] CALL_STATE:reconnecting", { matchId, callSessionId, connectedDurationSoFar: connectedAtRef.current ? Date.now() - connectedAtRef.current : 0 });
      console.warn("[CALL_DEBUG] RECONNECTING: peer connection temporarily lost", { matchId });
      // Stamp disconnection time for the reconnecting gap — cleared if connection recovers.
      if (connectedAtRef.current !== null && disconnectedAtRef.current === null) {
        disconnectedAtRef.current = Date.now();
        console.log("[CALL_PROGRESSION] call_physically_disconnected", { matchId, connectionState: "reconnecting", disconnectedAt: new Date(disconnectedAtRef.current).toISOString(), connectedDurationSoFar: disconnectedAtRef.current - connectedAtRef.current });
      }
    }
  }, [connectionState, webrtcEnabled]);

  // ── Auto-end when countdown reaches 0 ────────────────────────────────────────
  // Only fire when we're actively connected (not ringing/connecting) and the
  // call hasn't already been ended by some other path (endedRef guard).
  useEffect(() => {
    if (remaining === 0 && isConnected && !endedRef.current) {
      const completeMsg = callStage === 0
        ? t("timer_first_completed")
        : callStage === 1
        ? t("timer_second_completed")
        : t("timer_completed");
      setTimerExpiredMsg(completeMsg);
      console.log("[CALL_UI] TIMER_EXPIRED — auto-ending call", { matchId, callSessionId, callStage, stageDuration });
      // Brief delay so the user sees "Time's up" before the overlay closes
      const tid = setTimeout(() => {
        finishCallRef.current?.("timer_expired");
      }, 2500);
      return () => clearTimeout(tid);
    }
  }, [remaining, isConnected, callStage, matchId, callSessionId, stageDuration]);

  // Auto-end call when connection fails — prevents restart loop on network recovery.
  // The "Connection failed" screen is shown for 10s so the failure reason is readable,
  // then finishCall cleans up server state, broadcasts call:ended to the peer,
  // and calls onCallEnd() so the overlay is dismissed and the call cannot re-trigger.
  useEffect(() => {
    if (!isFailed || !webrtcEnabled) return;
    // failureReason is now provided directly by useWebRTC — no log scraping needed.
    console.log("[CALL_UI] AUTO_END_SCHEDULED", { matchId, callSessionId, delayMs: 10000, failureReason });
    const tid2 = setTimeout(() => {
      if (!endedRef.current) {
        console.log("[CALL_UI] AUTO_END_EXECUTING connection_failed", { matchId, callSessionId });
        finishCallRef.current?.("connection_failed");
      }
    }, 10000);
    return () => clearTimeout(tid2);
  }, [isFailed, webrtcEnabled, matchId, callSessionId]);

  // ── Remote stream → audio + video ────────────────────────────────────────
  // Audio comes ONLY from the hidden <audio> element (see JSX below).
  // The remote <video> element is explicitly muted so the same audio is
  // never played twice (double-audio would cause a chorus/echo effect and
  // confuse echo-cancellation in the peer's microphone path).
  //
  // IMPORTANT: isConnected guards the attachment. useWebRTC sets remoteStream
  // at PC creation time (before ICE connects) so that ontrack events have a
  // MediaStream to add tracks into. Without the isConnected guard, the audio
  // element would receive srcObject before any audio data is flowing, causing
  // the browser to start decoding an empty stream. When isConnected later
  // becomes true, the effect re-runs (isConnected is in the deps array) and
  // the already-populated remoteStream is attached at the correct moment.
  //
  // Guard: compare track-ID sets before re-assigning srcObject so rapid
  // ontrack events (which create a new MediaStream wrapper each time) don't
  // cause unnecessary flicker or audio interruption.
  useEffect(() => {
    if (!remoteStream || !isConnected) return;
    console.log("[CALL_DEBUG] REMOTE_STREAM_EFFECT: remoteStream ready + isConnected=true — attaching audio", {
      matchId,
      audioTracks: remoteStream.getAudioTracks().length,
      videoTracks: remoteStream.getVideoTracks().length,
    });

    // ── Audio element (always present; handles voice for both call types) ──
    if (remoteAudioRef.current) {
      const el = remoteAudioRef.current;

      // ── HARD SAFETY: full DOM audio sweep ────────────────────────────────
      // Before attaching, stop EVERY <audio> element on the page that has a
      // MediaStream srcObject, except our intended remote element.  This catches:
      //   • Duplicate remote-stream elements (same or different object reference)
      //   • Any element that somehow got localStream attached (mic feedback)
      //   • Stale elements from a previous call that the cleanup missed
      // Note: the singleton ringtone/ringback elements are created with `new
      // Audio()` and NOT appended to the DOM, so querySelectorAll("audio") does
      // NOT find them — this sweep cannot accidentally stop the ring elements.
      const allAudioEls = Array.from(document.querySelectorAll("audio")) as HTMLAudioElement[];
      allAudioEls.forEach((a) => {
        if (a === el) return; // skip our target element
        const srcStream = a.srcObject instanceof MediaStream ? a.srcObject : null;
        if (srcStream !== null) {
          const reason = srcStream === remoteStream ? "duplicate_remote_stream"
            : (localStream && srcStream === localStream) ? "local_mic_leak"
            : "unknown_stream_leak";
          console.warn(`[CALL_AUDIO_SAFETY] stopping stale <audio> element with MediaStream attached`, { matchId, reason, paused: a.paused });
          a.pause();
          a.srcObject = null;
        }
      });
      console.log("[CALL_AUDIO_SAFETY] DOM sweep complete", {
        matchId,
        totalAudioEls: allAudioEls.length,
        stoppedCount: allAudioEls.filter(a => a !== el && a.srcObject === null && !a.paused).length,
      });

      const existing = el.srcObject as MediaStream | null;
      const existingIds = existing?.getTracks().map(t => t.id).sort().join(",") ?? "";
      const incomingIds = remoteStream.getTracks().map(t => t.id).sort().join(",");

      // Guard D: stream-level local-mic block
      if (localStream && remoteStream.id === localStream.id) {
        console.error("[CALL_AUDIO_ONLY] local mic blocked", {
          reason: "guard D — remoteStream.id === localStream.id, refusing to attach to audio element",
          streamId: remoteStream.id.slice(0, 16),
          matchId,
        });
        console.error("[STREAM_AUDIT] BLOCKED local stream playback — remoteStream.id === localStream.id, not attaching to audio element!", {
          streamId: remoteStream.id,
          matchId,
        });
        return; // hard block — do not proceed to srcObject assignment
      }

      // Guard E: per-track crosscheck — verify NO individual audio track appears
      // in both the local and remote streams.  A stream-ID mismatch (guard D)
      // does not guarantee the tracks themselves are distinct; this check is the
      // definitive firewall against any mic-routing bug that would cause the
      // local microphone signal to be played back as remote audio.
      if (localStream) {
        const localAudioIds = new Set(localStream.getAudioTracks().map(t => t.id));
        const overlapping = remoteStream.getAudioTracks().filter(t => localAudioIds.has(t.id));
        if (overlapping.length > 0) {
          console.error("[STREAM_AUDIT] BLOCKED guard E — remote audio track IDs overlap with local audio track IDs — refusing attachment", {
            overlappingTrackIds: overlapping.map(t => t.id.slice(0, 12)),
            matchId,
          });
          return; // hard block
        }
        console.log("[STREAM_AUDIT] guard E passed — no track-ID overlap between local and remote streams", {
          localAudioTracks: localStream.getAudioTracks().length,
          remoteAudioTracks: remoteStream.getAudioTracks().length,
          matchId,
        });
      }

      console.log("[STREAM_AUDIT] audio element srcObject id", {
        matchId,
        remoteStreamId: remoteStream.id,
        localStreamId: localStream?.id ?? "none",
        isSameAsLocal: false,
        audioTracks: remoteStream.getAudioTracks().length,
        verdict: "OK — guards D + E passed",
      });

      if (existingIds !== incomingIds) {
        // Guards D + E already verified above — safe to proceed with attachment.
        console.log("[STREAM_AUDIT] attaching remote stream to audio element", {
          streamId: remoteStream.id.slice(0, 16),
          audioTracks: remoteStream.getAudioTracks().length,
          videoTracks: remoteStream.getVideoTracks().length,
          matchId,
        });
        // Stop ringtone/ringback synchronously before attaching remote audio.
        // Belt-and-suspenders on top of the connectionState effect stop.
        stopAllNonVoiceCallAudio("transition_before_remote_audio");
        console.log("[CALL_FIX] non-voice audio stopped before connect", { matchId, phase: "before_srcObject" });
        // Set playsInline as a DOM property (belt-and-suspenders for iOS Safari —
        // JSX playsInline sets the HTML attribute but iOS may not honour it
        // unless the DOM property is also set explicitly before play()).
        (el as any).playsInline = true;
        // MUTED GUARD: mute the element BEFORE setting srcObject so that the
        // autoPlay attribute cannot produce a brief audio burst at the wrong
        // volume during the srcObject switch.  Un-mute only after volume is set.
        el.muted = true;
        el.srcObject = remoteStream;
        // Re-apply volume immediately after srcObject set — iOS audio session
        // switches when getUserMedia opens the mic, which can silently reset
        // el.volume to 1.0 after the speaker effect's initial run on mount.
        if (isIOS) {
          const vol = speakerOn ? 1.0 : 0.25;
          el.volume = vol;
          console.log("[CALL_FIX] iphone earpiece/default low volume applied", { volume: vol, speakerOn, matchId, phase: "srcObject_set" });
        } else if (typeof (el as any).setSinkId !== "function") {
          el.volume = 1.0;
          console.log("[CALL_FIX] laptop speaker default applied", { volume: 1.0, matchId, phase: "srcObject_set" });
        }
        el.muted = false; // un-mute only after srcObject + volume are fully set
        console.log("[CALL_AUDIO] remote stream attached to audio element", {
          matchId,
          audioTracks: remoteStream.getAudioTracks().length,
          videoTracks: remoteStream.getVideoTracks().length,
          streamId: remoteStream.id.slice(0, 16),
          volume: el.volume,
          muted: el.muted,
        });
        // Register with call-audio so cleanupCallAudio() can detach this element.
        registerCallAudioElement(el, `remote-audio:${matchId}`);
        // [SELF_AUDIO_FIX] This is the ONLY audible element during a connected call.
        // localStream is NEVER attached here — it goes to pc.addTrack() only.
        console.log("[SCREECH_FIX] remote-only audio confirmed", {
          streamId: remoteStream.id.slice(0, 16),
          audioTracks: remoteStream.getAudioTracks().length,
          elementMuted: el.muted,
          localStreamAttachedHere: false,
          matchId,
        });
        console.log("[SELF_AUDIO_FIX] remote stream is only audible stream", {
          matchId,
          audioTracks: remoteStream.getAudioTracks().length,
          videoTracks: remoteStream.getVideoTracks().length,
          elementMuted: el.muted,
          localStreamAttachedHere: false,
        });
        console.log("[CALL_AUDIO_AUDIT] SOURCE 2 attached: remote voice <audio> UNMUTED — remote WebRTC voice stream, sole audio source during call");
        console.log("[FINAL_AUDIO_FIX] single remote stream attached", {
          matchId,
          audioTracks: remoteStream.getAudioTracks().length,
          elementMuted: el.muted,
          srcObjectSet: !!el.srcObject,
        });
        // Guard: only play if srcObject was actually set (the localStream-blocked
        // path above skips srcObject assignment; calling play() there would replay
        // any previously-attached stale audio and cause phantom beeping).
        if (el.srcObject) {
          // Final stop immediately before play — catches any tone that could have
          // started in the ~30 lines between the pre-srcObject stop and here.
          stopAllNonVoiceCallAudio("final_before_remote_play");
          console.log("[CALL_FIX] non-voice audio stopped before connect", { matchId, phase: "before_play" });
          console.log("[CALL_AUDIO] remote audio attached", {
            matchId,
            audioTracks: remoteStream.getAudioTracks().length,
            videoTracks: remoteStream.getVideoTracks().length,
            volume: el.volume,
            muted: el.muted,
            trackIds: incomingIds,
          });
          el.play().then(() => {
            console.log("[CALL_AUDIO] remote audio play success", {
              matchId,
              volume: el.volume,
              muted: el.muted,
              readyState: el.readyState,
            });
          }).catch((err: unknown) => {
            const msg = (err as Error)?.message ?? String(err);
            console.error("[CALL_AUDIO] remote audio play FAILED — retrying in 200 ms", { matchId, error: msg });
            // Retry once: some browsers reject play() from a non-gesture context
            // on the first attempt but succeed 200 ms later after the audio pipeline
            // has fully initialised for the new srcObject.
            setTimeout(() => {
              if (el.srcObject) {
                el.play().then(() => {
                  console.log("[CALL_AUDIO] remote audio play success (retry)", { matchId, volume: el.volume });
                }).catch((e2: unknown) => {
                  console.error("[CALL_AUDIO] remote audio play FAILED on retry", { matchId, error: (e2 as Error)?.message ?? String(e2) });
                });
              }
            }, 200);
          });
          console.log("[FINAL_AUDIO_FIX] connected call audio clean", {
            matchId,
            audioTracks: remoteStream.getAudioTracks().length,
            elementMuted: el.muted,
            volume: el.volume,
          });
          console.log("[WebRTC] REMOTE_AUDIO_ATTACHED", {
            matchId,
            audioTracks: remoteStream.getAudioTracks().length,
            videoTracks: remoteStream.getVideoTracks().length,
            trackIds: incomingIds,
          });
        }
      } else {
        console.log("[CALL_FEEDBACK_FIX] single remote audio active — track set unchanged, not re-attaching", { matchId });
        console.log("[WebRTC] REMOTE_AUDIO_SKIP: track set unchanged, not re-attaching", { matchId });
      }
    }

    // ── Video element (video calls only; audio-track-free stream) ──
    // SELF-MONITORING FIX: only the VIDEO tracks from remoteStream are attached
    // to the remote video element. The audio track is handled exclusively by
    // the hidden remoteAudioRef element (SOURCE 2, above). Stripping audio at
    // the stream level means the video element cannot produce any audio even if
    // the `muted` DOM property somehow fails — which is the belt-and-suspenders
    // fix for the doubled-remote-audio / chorus bug.
    if (isVideo && remoteVideoRef.current) {
      const videoEl = remoteVideoRef.current;
      const existing = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
      const existingVideoIds = existing?.getVideoTracks().map(t => t.id).sort().join(",") ?? "";
      const incomingVideoIds = remoteStream.getVideoTracks().map(t => t.id).sort().join(",");
      if (existingVideoIds !== incomingVideoIds) {
        // Create a VIDEO-ONLY copy of the remote stream — no audio tracks.
        // Even if muted=false glitches, there is nothing to play.
        const remoteVideoOnly = new MediaStream(remoteStream.getVideoTracks());
        // Belt-and-suspenders: also set the DOM muted property.
        videoEl.muted = true;
        videoEl.srcObject = remoteVideoOnly;
        registerCallAudioElement(videoEl, `remote-video:${matchId}`);
        console.log("[SELF_AUDIO_FIX] remote stream is only audible stream — remote video el has video tracks only, audio in remoteAudioRef only", {
          matchId,
          remoteVideoTracksAttached: remoteVideoOnly.getVideoTracks().length,
          remoteAudioTracksAttached: remoteVideoOnly.getAudioTracks().length,
          videoElMuted: videoEl.muted,
        });
        console.log("[CALL_AUDIO_AUDIT] SOURCE 3 attached: remote video <video> VIDEO-ONLY — audio is SOURCE 2 exclusively");
        videoEl.play().catch(() => {});
        console.log("[WebRTC] REMOTE_MAIN_VIDEO_ATTACHED video-only", {
          matchId,
          videoTracks: remoteStream.getVideoTracks().length,
        });
      } else {
        console.log("[WebRTC] REMOTE_MAIN_VIDEO_SKIP: video track set unchanged", { matchId });
      }
    } else if (isVideo) {
      console.log("[WebRTC] REMOTE_MAIN_VIDEO_PENDING: element not yet mounted", { matchId, isConnected });
    }
  }, [remoteStream, isVideo, matchId, isConnected]);

  // ── Local stream → self-view pip ─────────────────────────────────────────
  // SELF-MONITORING FIX: only the VIDEO tracks from localStream are attached
  // to the self-view element — the audio (mic) track is deliberately excluded.
  // This is a physical-level block: even if the `muted` DOM property or JSX
  // attribute somehow fails (known React / browser bug), there is no audio
  // track in the stream so the mic can never play back locally.
  //
  // The full localStream (audio + video) is still sent to the remote peer
  // via pc.addTrack() in use-webrtc.ts — none of that is affected here.
  useEffect(() => {
    if (!localStream || !isVideo || !localVideoRef.current) return;
    const videoEl = localVideoRef.current;

    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length === 0) {
      console.log("[SELF_AUDIO_FIX] no video track in localStream — skipping self-view attachment", { matchId });
      return;
    }

    // Guard: skip if the same video track set is already attached
    const existingStream = videoEl.srcObject instanceof MediaStream ? videoEl.srcObject : null;
    const existingVideoIds = existingStream?.getVideoTracks().map(t => t.id).sort().join(",") ?? "";
    const newVideoIds = videoTracks.map(t => t.id).sort().join(",");
    if (existingVideoIds === newVideoIds) {
      console.log("[SELF_AUDIO_FIX] self-view video tracks unchanged — skip", { matchId });
      return;
    }

    // Create a VIDEO-ONLY stream — mic audio track deliberately omitted.
    // This is the primary self-monitoring fix: no audio track = no possible
    // mic feedback regardless of muted/unmuted state on the element.
    const videoOnlyStream = new MediaStream(videoTracks);

    // Belt-and-suspenders: also set the DOM `muted` property explicitly.
    // JSX `muted` sets the HTML *attribute* but React does not reliably sync
    // that to the DOM *property* on re-renders in all versions.
    videoEl.muted = true;
    videoEl.srcObject = videoOnlyStream;
    videoEl.play().catch(() => {});

    console.log("[SELF_AUDIO_FIX] local mic stream blocked from audio playback", {
      matchId,
      micTracksInFullStream: localStream.getAudioTracks().length,
      micTracksAttachedToVideoEl: 0,
      videoTracks: videoTracks.length,
      videoElMuted: videoEl.muted,
    });
    console.log("[WebRTC] LOCAL_SELF_VIEW_ATTACHED video-only", {
      matchId,
      videoTracks: videoTracks.length,
      isConnected,
    });
  }, [localStream, isVideo, matchId, isConnected]);

  const finishCall = useCallback((reason: string = "user_hangup") => {
    if (endedRef.current) return;
    endedRef.current = true;

    // Stop ALL audio immediately — ringtone AudioContexts and remote-stream
    // elements — so nothing plays or gets captured by the mic after hangup.
    cleanupCallAudio(`finish_call_${reason}`);

    const isCancelRinging = isRinging && isCaller;
    const endpoint = isCancelRinging
      ? `/api/matches/${matchId}/call/cancel`
      : `/api/matches/${matchId}/call/complete`;
    const signalType = isCancelRinging ? "call:cancelled" : "call:ended";

    // Compute how long WebRTC was actually live.
    // spec: connectedDuration = callDisconnectedAt - callConnectedAt
    // disconnectedAtRef is stamped the instant WebRTC leaves "connected" state.
    // Falling back to Date.now() only when the connection is still live at hang-up.
    const effectiveEnd = disconnectedAtRef.current ?? Date.now();
    const connectedDurationMs = connectedAtRef.current ? effectiveEnd - connectedAtRef.current : 0;
    const connected = connectedDurationMs > 0;
    // Must match server MIN_VALID_CALL_MS (server/storage.ts) — 20 seconds
    const MIN_VALID_CALL_MS = 20_000;
    const callWillCount = !isCancelRinging && connected && connectedDurationMs >= MIN_VALID_CALL_MS;

    // Map reason to a clean call-state label for server-side logging.
    // "timer_expired" = call ran to full duration = counts as completed.
    const callState = reason === "connection_failed" ? "failed"
      : reason === "remote_hangup" ? "ended"
      : reason === "permission_denied" ? "failed"
      : reason === "caller_cancelled" ? "cancelled"
      : reason === "timer_expired" ? "ended"
      : "ended";

    // Read current stage from cache before any mutation so we can log the
    // before/after transition and build the optimistic patch.
    const cachedMatch = queryClient.getQueryData<any>(["/api/matches", matchId]);
    const stageBeforeCall = cachedMatch?.callStage ?? 0;
    const connectedAt = connectedAtRef.current ? new Date(connectedAtRef.current).toISOString() : null;
    const endedAt = new Date().toISOString();

    console.log("[CALL_PROGRESSION] call_ending", {
      matchId,
      callSessionId,
      callType: isVideo ? "video" : "phone",
      connectedAt,
      endedAt,
      connectedDurationMs,
      MIN_VALID_CALL_MS,
      stageBeforeCall,
      callWillCount,
      callState,
      reason,
    });
    console.log("[CALL_UI] CALL_STATE:ended", {
      matchId, callSessionId, userId, reason, callState, endpoint,
      connected, connectedDurationMs, webrtcConnectionState: connectionState,
    });
    console.log("[CALL_SESSION] CALL_STAGE_EXITED", { matchId, callSessionId, reason, connected, connectedDurationMs });

    // ── Optimistic stage advance ───────────────────────────────────────────
    // Applied BEFORE onCallEnd() so the chat screen immediately shows the
    // correct stage and message quota without a stale-data flash.
    // Root cause of "15 left" bug: the cache was stale between onCallEnd() and
    // the server response, defaulting callStage to 0 and showing 15 messages.
    // The server response (below) always overwrites this with authoritative data.
    if (callWillCount) {
      const stageAfterOptimistic = stageBeforeCall + 1;
      const optimisticPatch = {
        callStage: stageAfterOptimistic,
        messageCount1: 0,
        messageCount2: 0,
        callStartedAt: null,
        callInitiatorId: null,
        callAnswered: false,
        callCompleted: false,
        callSessionId: null,
      };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((m: any) => m.id === matchId ? { ...m, ...optimisticPatch } : m);
      });
      queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old: any) => {
        if (!old) return old;
        return { ...old, ...optimisticPatch };
      });
      console.log("[CALL_PROGRESSION] optimistic_stage_advance", {
        matchId,
        from: stageBeforeCall,
        to: stageAfterOptimistic,
        note: "provisional — server response is authoritative",
      });
    }

    // Hang up WebRTC before UI teardown
    if (webrtcEnabled) {
      hangup();
    }

    onCallEnd();

    // If the caller is cancelling a still-ringing call (before it was answered),
    // record this in the self-cancelled Set so matches.tsx can distinguish
    // "I cancelled my own call" from "the recipient declined" and suppress
    // the false "{name} declined" toast on the caller's side.
    if (isCancelRinging) {
      markSelfCancelled(matchId, callSessionId);
    }

    // ── IMPORTANT: broadcastCallSignal is sent INSIDE .then(), not here ──
    // Previously this broadcast fired BEFORE the POST, meaning the callee received
    // call:ended, immediately invalidateQueries, and refetched the match BEFORE
    // the DB was updated — getting callStage:0 and showing "15 left".
    // By moving the broadcast to after the HTTP response the callee's refetch
    // always lands after call_stage is committed to the DB.

    // Only /call/complete receives connection quality data; /call/cancel gets no body
    const body = isCancelRinging ? undefined : { connected, connectedDurationMs, callState, callType: isVideo ? "video" : "phone" };

    apiRequest("POST", endpoint, body)
      .then(async (res) => {
        if (!res.ok) {
          // Broadcast in error paths so the callee's overlay still dismisses.
          broadcastCallSignal(matchId, { type: signalType as any, matchId, userId, callSessionId } as any);
          return;
        }
        const data = await res.json().catch(() => null);

        // Broadcast NOW — DB is committed, callee's refetch will return correct stage
        broadcastCallSignal(matchId, { type: signalType as any, matchId, userId, callSessionId } as any);

        if (!data) return;

        // Authoritative patch — overrides the optimistic patch above
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
        queryClient.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old: any) => {
          if (!old) return old;
          return { ...old, ...patch };
        });

        // Stage-1 message allowance is 12; stage-2+ is 25; stage-0 is 15
        const msgAllowance = data.callStage === 1 ? 12 : data.callStage === 0 ? 15 : 25;
        console.log("[CALL_PROGRESSION] server_response_applied", {
          matchId,
          callCounted: data.callCounted,
          stageBeforeCall,
          stageAfterCall: data.callStage,
          messageAllowanceAfterTransition: msgAllowance,
          messageCount1: data.messageCount1,
          messageCount2: data.messageCount2,
          connectedDurationMs,
        });
        console.log("[CALL_UI] CALL_API_SUCCESS", {
          matchId, endpoint, reason, callState,
          newStage: data.callStage, callCounted: data.callCounted,
          connected, connectedDurationMs,
        });

        // UI must clearly distinguish three states (spec):
        //   1. Call completed — 12 messages unlocked
        //   2. Call did not last long enough — try again
        //   3. Call required (shown by the chat screen CTA, not here)
        // Only show a toast when the user was actually in a call (not a cancelled ring).
        if (!isCancelRinging) {
          if (data.callCounted && data.callStage === 1) {
            // State 1: qualifying call completed → Stage 2 unlocked
            toastRef.current({
              title: tRef.current("first_call_completed_title"),
              description: tRef.current("first_call_completed_desc"),
            });
          } else if (!data.callCounted && connected) {
            // State 2: call answered and connected but below MIN_VALID_CALL_MS
            toastRef.current({
              title: tRef.current("call_ended_title"),
              description: tRef.current("call_not_counted_desc"),
            });
          }
        }
      })
      .catch((e) => {
        // Overlay is already dismissed — don't show an error toast for user-initiated ends.
        console.error("[CALL_UI] CALL_API_ERROR", { matchId, endpoint, reason, callState, connected, connectedDurationMs, error: e.message });
        console.log("[CALL_PROGRESSION] api_error_cache_invalidated", { matchId, endpoint, error: e.message });
        // Force a cache refresh so the match card reflects the true DB state
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
        queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
        // Still broadcast so the callee's overlay dismisses even on network failure
        broadcastCallSignal(matchId, { type: signalType as any, matchId, userId, callSessionId } as any);
      });
  }, [matchId, callSessionId, userId, isCaller, isRinging, onCallEnd, queryClient, hangup, webrtcEnabled, connectionState]);

  // Keep finishCallRef pointing to latest finishCall
  finishCallRef.current = finishCall;

  // Safety net: if the component unmounts without finishCall having been called
  // (e.g. React parent crash, forced navigation, error boundary), call /complete so the
  // server state is cleaned up and neither user is left stuck in "in progress".
  // Also invalidates the matches cache so the other peer's 5s poll picks up the
  // cleared state quickly instead of waiting up to 30s.
  useEffect(() => {
    return () => {
      if (!endedRef.current) {
        endedRef.current = true;
        console.warn("[CALL_UI] UNMOUNT_SAFETY_NET triggered — calling /complete to prevent stuck state", { matchId, callSessionId });
        apiRequest("POST", `/api/matches/${matchId}/call/complete`, { connected: false, connectedDurationMs: 0, callState: "failed" })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
            queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
          })
          .catch((e) => {
            console.error("[CALL_UI] UNMOUNT_SAFETY_NET /complete failed", { matchId, error: e.message });
            queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
          });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // Show clear failed-connection screen
  if (isFailed && webrtcEnabled) {
    return (
      <div
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8"
        style={{ background: "linear-gradient(160deg, hsl(350 45% 18%) 0%, hsl(350 40% 10%) 60%, hsl(350 30% 6%) 100%)" }}
        data-testid="overlay-call-failed"
      >
        <WifiOff className="w-14 h-14 text-red-400" />
        <div className="text-center space-y-2">
          <p className="text-white text-xl font-semibold">{t("connection_failed_title")}</p>
          <p className="text-white/50 text-sm leading-relaxed">
            {t("connection_failed_desc")}
          </p>
          <p className="text-green-400 text-xs font-mono mt-1" data-testid="text-failure-reason">
            {t("failure_reason_label")}{failureReason || t("detecting_label")}
          </p>
        </div>
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
          onClick={() => finishCall("connection_failed")}
          data-testid="button-end-call-failed"
          aria-label={t("call_end_label")}
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
        <span className="text-white/30 text-xs">{t("tap_to_end_auto")}</span>
        <CallDebugPanel />
      </div>
    );
  }

  // Show clear permission-denied screen
  if (permissionDenied && webrtcEnabled) {
    return (
      <div
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8"
        style={{ background: "linear-gradient(160deg, hsl(350 45% 18%) 0%, hsl(350 40% 10%) 60%, hsl(350 30% 6%) 100%)" }}
        data-testid="overlay-permission-denied"
      >
        <AlertTriangle className="w-14 h-14 text-amber-400" />
        <div className="text-center space-y-2">
          <p className="text-white text-xl font-semibold">
            {isVideo ? t("mic_camera_needed") : t("mic_needed")}
          </p>
          <p className="text-white/50 text-sm leading-relaxed">
            {isVideo
              ? t("allow_mic_camera")
              : t("allow_mic")}
          </p>
          <p className="text-white/35 text-xs mt-1">
            {t("open_settings_hint")}
          </p>
        </div>
        <button
          className="w-16 h-16 rounded-full flex items-center justify-center bg-red-600 active:scale-95 transition-all shadow-lg"
          onClick={() => finishCall("permission_denied")}
          data-testid="button-end-call-permission"
          aria-label={t("call_end_label")}
        >
          <PhoneOff className="w-7 h-7 text-white" />
        </button>
        <span className="text-white/30 text-xs">{t("tap_to_end")}</span>
        <CallDebugPanel />
      </div>
    );
  }

  const statusLabel = (() => {
    if (isRinging) return isCaller ? t("ringing_label") : t("connecting_label");
    if (connectionState === "requesting-media") return isVideo ? t("starting_camera") : t("starting_mic");
    if (connectionState === "connecting") return t("connecting_label");
    if (connectionState === "reconnecting") return t("reconnecting_label");
    if (isConnected) return remaining === 0 ? "00:00" : countdownDisplay;
    return t("connected_label");
  })();

  // Warning color for the countdown — escalates as time runs out
  const timerColor = warning === "ten_sec" ? "text-red-400"
    : warning === "one_min" ? "text-red-400"
    : warning === "two_min" ? "text-amber-400"
    : "text-white/80";

  const showSpinner = isRinging || isConnecting || isReconnecting;

  // Derived visibility flags for video auto-hide
  const videoControlsVisible = !isVideo || !isConnected || showControls;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col overflow-hidden"
      data-testid="overlay-voice-call"
      onClick={showAndResetTimer}
    >
      {/* Background — blurred photo or Lulou rose gradient */}
      {callerPhoto && !isVideo ? (
        <>
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${callerPhoto})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "blur(30px) brightness(0.3) saturate(1.3)",
              transform: "scale(1.1)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(180deg, hsl(350 45% 10% / 0.5) 0%, hsl(350 45% 6% / 0.9) 100%)" }}
          />
        </>
      ) : !isVideo ? (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(160deg, hsl(350 45% 18%) 0%, hsl(350 40% 10%) 60%, hsl(350 30% 6%) 100%)" }}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(160deg, #0f1117 0%, #0a0a0f 100%)" }}
        />
      )}

      {/* Remote audio — always present so voice comes through even in video mode.
          autoPlay is required for iOS Safari: without it, el.play() called from a
          React effect (non-gesture context) is silently rejected by the browser,
          meaning no audio plays and the volume/speaker controls have no effect.
          The explicit el.play() in the remote-stream effect still runs (belt-and-
          suspenders for browsers that need a gesture to start); autoPlay ensures
          iOS pre-authorises the element in the WebRTC PlayAndRecord audio session. */}
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
          className="absolute bottom-36 end-4 w-28 h-40 rounded-xl object-cover border-2 border-white/30 shadow-xl z-10"
          style={{ transform: "scaleX(-1)" }}
          data-testid="video-local"
        />
      )}

      {/* Main content — fades with controls on video calls.
          paddingBottom reserves space for the absolute controls dock so content
          never scrolls behind the End Call button on tall-content screens. */}
      <div
        className="flex-1 flex flex-col items-center justify-center gap-5 relative z-10 px-6"
        style={{
          paddingBottom: 200,
          ...(isVideo && isConnected ? {
            opacity: videoControlsVisible ? 1 : 0,
            transition: "opacity 0.35s ease",
            pointerEvents: videoControlsVisible ? "auto" : "none",
          } : {}),
        }}
      >
        {/* Avatar — hidden when remote video is visible */}
        {(!isVideo || !isConnected) && (
          <div className="relative flex items-center justify-center">
            {/* Ambient glow rings */}
            {!isConnected && (
              <>
                <div
                  className="absolute rounded-full animate-ping"
                  style={{ inset: -22, background: "hsl(350 45% 52% / 0.1)", animationDuration: "2s" }}
                />
                <div
                  className="absolute rounded-full animate-ping"
                  style={{ inset: -8, background: "hsl(350 45% 52% / 0.15)", animationDuration: "2.5s", animationDelay: "0.3s" }}
                />
              </>
            )}
            {isConnected && (
              <div
                className="absolute rounded-full"
                style={{
                  inset: -6,
                  border: "2px solid hsl(145 60% 45% / 0.5)",
                  boxShadow: "0 0 24px hsl(145 60% 40% / 0.25)",
                }}
              />
            )}
            <Avatar
              className="border-[3px] shadow-2xl"
              style={{
                width: 152,
                height: 152,
                borderColor: isConnected ? "hsl(145 60% 45% / 0.5)" : "hsl(350 45% 52% / 0.4)",
              }}
            >
              <AvatarImage src={callerPhoto} alt={callerName} />
              <AvatarFallback
                className="font-serif text-5xl"
                style={{ background: "hsl(350 45% 25%)", color: "hsl(350 45% 85%)" }}
              >
                {callerName[0]}
              </AvatarFallback>
            </Avatar>
          </div>
        )}

        {/* Stage label above name */}
        {isConnected && !isRinging && (
          <p className="text-white/35 text-[10px] tracking-[0.25em] uppercase font-medium -mb-2" data-testid="text-call-stage-label">
            {stageLabel}
          </p>
        )}

        <h2 className="text-white font-serif text-3xl font-bold drop-shadow-xl tracking-tight" data-testid="text-call-name">
          {callerName}
        </h2>

        {/* Timer-expired full-call notice */}
        {timerExpiredMsg ? (
          <div className="text-center space-y-1.5 mt-1" data-testid="text-timer-expired">
            <p className="text-white text-2xl font-serif font-bold">{timerExpiredMsg}</p>
            <p className="text-white/45 text-sm">{t("ending_call_label")}</p>
          </div>
        ) : (
          <>
            {/* Countdown / status line */}
            <div className="flex flex-col items-center gap-1 mt-1" data-testid="text-call-status">
              {showSpinner && (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-white/50 animate-spin" />
                  <span className="text-white/45 text-sm" data-testid="text-call-timer">{statusLabel}</span>
                </div>
              )}
              {!showSpinner && (
                <span
                  className={`font-mono tabular-nums tracking-tight ${isConnected ? `${timerColor} text-6xl font-bold` : "text-white/45 text-sm"}`}
                  style={isConnected ? { textShadow: "0 0 32px currentColor, 0 2px 16px hsl(0 0% 0% / 0.4)" } : undefined}
                  data-testid="text-call-timer"
                >
                  {statusLabel}
                </span>
              )}

              {/* Time-remaining hint */}
              {isConnected && remaining > 0 && !showSpinner && (
                <p className={`text-xs ${warning !== "none" ? timerColor : "text-white/35"}`} data-testid="text-call-remaining">
                  {warning === "ten_sec"
                    ? t("ten_sec_remaining")
                    : warning === "one_min"
                    ? t("less_than_minute")
                    : warning === "two_min"
                    ? t("two_min_remaining")
                    : t("n_min_remaining").replace("{n}", String(Math.ceil(remaining / 60)))}
                </p>
              )}
            </div>

            {/* Warning banners */}
            {isConnected && warning === "two_min" && remaining > 60 && !timerExpiredMsg && (
              <div
                className="flex items-center gap-2 rounded-full px-4 py-1.5"
                style={{ background: "hsl(38 90% 50% / 0.15)", border: "1px solid hsl(38 90% 50% / 0.3)" }}
                data-testid="banner-two-min-warning"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-amber-300 text-xs">{t("two_min_remaining")}</span>
              </div>
            )}
            {isConnected && warning === "one_min" && remaining > 10 && !timerExpiredMsg && (
              <div
                className="flex items-center gap-2 rounded-full px-4 py-1.5"
                style={{ background: "hsl(0 75% 50% / 0.15)", border: "1px solid hsl(0 75% 50% / 0.3)" }}
                data-testid="banner-one-min-warning"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                <span className="text-red-300 text-xs">{t("less_than_minute")}</span>
              </div>
            )}
            {isConnected && warning === "ten_sec" && !timerExpiredMsg && (
              <div
                className="flex items-center gap-2 rounded-full px-4 py-1.5 animate-pulse"
                style={{ background: "hsl(0 75% 50% / 0.2)", border: "1px solid hsl(0 75% 50% / 0.45)" }}
                data-testid="banner-ten-sec-warning"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-red-300" />
                <span className="text-red-200 text-xs font-medium">{t("ten_sec_remaining")}</span>
              </div>
            )}
          </>
        )}

        {/* Weak-connection banner */}
        {isReconnecting && (
          <div
            className="flex items-center gap-2 rounded-full px-4 py-1.5 mt-1"
            style={{ background: "hsl(38 90% 50% / 0.15)", border: "1px solid hsl(38 90% 50% / 0.3)" }}
          >
            <WifiOff className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-300 text-xs">{t("weak_connection_label")}</span>
          </div>
        )}

      </div>

      {/* Controls dock — position:absolute pins it to the bottom of the fixed
          call overlay regardless of how tall the flex-1 content grows.
          Root cause of End Call disappearing: the flex layout let overflow:hidden
          clip the controls when warning banners + avatar + timer exceeded the
          viewport height. Absolute positioning bypasses that entirely.
          Safe-area padding protects against the iPhone home indicator and the
          Safari browser toolbar. */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          paddingTop: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
        }}
      >
        {/* Mute / Speaker / Camera — hidden while ringing; auto-hides on connected video */}
        {!isRinging && (
          <div
            className="flex justify-center gap-10"
            style={isVideo && isConnected ? {
              opacity: videoControlsVisible ? 1 : 0,
              transition: "opacity 0.35s ease",
              pointerEvents: videoControlsVisible ? "auto" : "none",
            } : undefined}
          >
            <ControlButton
              onClick={toggleMute}
              label={isMuted ? t("call_unmute") : t("call_mute")}
              active={isMuted}
              disabled={!localStream}
              icon={isMuted
                ? <MicOff className="w-6 h-6 text-white" />
                : <Mic className="w-6 h-6 text-white" />}
            />

            {/* Speaker toggle — audio calls only.
                On iOS Safari / installed PWA: web cannot force earpiece routing;
                setSpeaker() calls the Capacitor native AVAudioSession bridge when
                available (installed app) or is a no-op on plain Safari.
                The volume-based approximation (0.25 vs 1.0) is the best achievable
                from a web context without a native Capacitor / React Native wrapper. */}
            {!isVideo && (
              <ControlButton
                onClick={() => setSpeakerOn(s => {
                  const next = !s;
                  console.log("[CALL_AUDIO] speaker toggled", { speakerOn: next, matchId });
                  return next;
                })}
                label={speakerOn ? t("call_speaker_on_label") : t("call_speaker")}
                active={speakerOn}
                testId="button-toggle-speaker"
                icon={<Volume2 className={`w-6 h-6 ${speakerOn ? "text-white" : "text-white/60"}`} />}
              />
            )}

            {isVideo && (
              <ControlButton
                onClick={toggleCamera}
                label={isCameraOff ? t("call_camera_show") : t("call_camera_hide")}
                active={isCameraOff}
                disabled={connectionState === "requesting-media"}
                icon={isCameraOff
                  ? <CameraOff className="w-6 h-6 text-white" />
                  : <Camera className="w-6 h-6 text-white" />}
              />
            )}
          </div>
        )}

        {/* End / Cancel — ALWAYS visible; not subject to video auto-hide.
            Minimum 56px ensures usable touch target per spec. */}
        <div className="flex flex-col items-center gap-2.5">
          <button
            className="w-[76px] h-[76px] rounded-full flex items-center justify-center active:scale-90 transition-all"
            style={{
              background: "linear-gradient(145deg, hsl(0 70% 44%), hsl(0 65% 34%))",
              boxShadow: "0 6px 32px hsl(0 65% 38% / 0.55), inset 0 1px 0 hsl(0 0% 100% / 0.12)",
              border: "1.5px solid hsl(0 65% 58% / 0.3)",
              minWidth: 56, minHeight: 56,
            }}
            onClick={() => finishCall(isRinging && isCaller ? "caller_cancelled" : "user_hangup")}
            data-testid="button-end-call"
            aria-label={isRinging && isCaller ? t("cancel_call_btn") : t("call_end_label")}
          >
            <PhoneOff className="w-8 h-8 text-white" />
          </button>
          <span className="text-white/30 text-[11px] tracking-wide">
            {isRinging && isCaller ? t("cancel") : t("call_end_label")}
          </span>
        </div>
      </div>

      <CallDebugPanel />
    </div>
  );
}
