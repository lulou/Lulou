import { useEffect } from "react";
import {
  startIncomingRingtone,
  stopIncomingRingtone,
  startOutgoingRingback,
  stopOutgoingRingback,
} from "@/lib/call-audio";

export type RingtoneType = "incoming" | "outgoing";

/**
 * Thin hook — delegates entirely to the call-audio.ts module-level state machine.
 *
 * The ring state machine lives in call-audio.ts so that:
 *   1. stopAllNonVoiceCallAudio() can kill it synchronously from any call site
 *      (incoming-call.tsx silenceRing, use-webrtc.ts before getUserMedia, etc.)
 *      WITHOUT waiting for a React effect cleanup cycle.
 *   2. The AudioContext statechange approach (not ctx.resume().then()) ensures
 *      ring() is never called from a Promise callback that resolves after cleanup.
 *   3. Outgoing ringback on the caller side stops the instant isRinging becomes
 *      false — the effect cleanup calls stopOutgoingRingback() synchronously
 *      before the new useWebRTC effect opens the microphone.
 */
/**
 * @param type       "incoming" (receiver) or "outgoing" (caller ringback).
 * @param enabled    One-way latch: true starts the ring, false keeps it silent.
 * @param sessionId  The match's callSessionId — forwarded to call-audio.ts so
 *                   the armed-session guard can block stale/cached triggers.
 */
export function useCallRingtone(type: RingtoneType, enabled: boolean, sessionId?: string | null) {
  useEffect(() => {
    if (!enabled) {
      if (type === "incoming") stopIncomingRingtone("ring_state_inactive");
      else stopOutgoingRingback("ring_state_inactive");
      return;
    }

    console.log("[RING_DEBUG] source", { type, enabled, sessionId: sessionId?.slice(0, 8) ?? "none" });

    if (type === "incoming") {
      // Ringtone only starts here — after App.tsx has verified incomingCall is a
      // live, non-stale, non-cancelled session for this user. It never starts on
      // startup/refresh without this verification gate being passed first.
      console.log("[CALL_FIX] verified incoming ringtone only", { type: "incoming" });
      console.log("[CALL_RINGTONE] verified incoming call, ringtone started");
      startIncomingRingtone(sessionId);
      // Retry while the authoritative session remains ringing. This covers a
      // genuine ring that arrives before startup verification finishes; the
      // module-level session latch prevents an already-playing loop restarting.
      const retry = window.setInterval(() => startIncomingRingtone(sessionId), 500);
      return () => window.clearInterval(retry);
    } else {
      console.log("[CALL_RINGTONE] verified outgoing call, ringback started");
      startOutgoingRingback(sessionId);
      const retry = window.setInterval(() => startOutgoingRingback(sessionId), 500);
      return () => window.clearInterval(retry);
    }
  }, [enabled, type, sessionId]);
}
