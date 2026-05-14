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
export function useCallRingtone(type: RingtoneType, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    if (type === "incoming") {
      // Ringtone only starts here — after App.tsx has verified incomingCall is a
      // live, non-stale, non-cancelled session for this user. It never starts on
      // startup/refresh without this verification gate being passed first.
      console.log("[CALL_FIX] verified incoming ringtone only", { type: "incoming" });
      console.log("[CALL_RINGTONE] verified incoming call, ringtone started");
      startIncomingRingtone();
      return () => {
        console.log("[CALL_RINGTONE] stopped: effect_cleanup (incoming)");
        stopIncomingRingtone("effect_cleanup");
      };
    } else {
      console.log("[CALL_RINGTONE] verified outgoing call, ringback started");
      startOutgoingRingback();
      return () => {
        console.log("[CALL_RINGTONE] stopped: effect_cleanup (outgoing)");
        stopOutgoingRingback("effect_cleanup");
      };
    }
  }, [enabled, type]);
}
