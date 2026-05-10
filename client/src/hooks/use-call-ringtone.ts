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
      console.log("[CALL_AUDIO_FIX] ringtone started — incoming ring oscillators starting");
      startIncomingRingtone();
      return () => stopIncomingRingtone("effect_cleanup");
    } else {
      console.log("[CALL_AUDIO_FIX] ringtone started — outgoing ringback oscillators starting");
      startOutgoingRingback();
      return () => stopOutgoingRingback("effect_cleanup");
    }
  }, [enabled, type]);
}
