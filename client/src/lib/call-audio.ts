/**
 * call-audio.ts — EMERGENCY SILENT MODE
 *
 * ALL custom call sounds (ringtone, ringback, oscillators, AudioContext) have
 * been DISABLED. The only audio during a call is the remote WebRTC MediaStream
 * attached to the single <audio> element in active-call.tsx.
 *
 * [CALL_AUDIO_EMERGENCY] all custom call sounds disabled
 *
 * ── WHAT IS GONE ──────────────────────────────────────────────────────────────
 *   × Web Audio API / AudioContext
 *   × Oscillator nodes (440 Hz + 480 Hz sine waves)
 *   × Incoming ringtone pattern
 *   × Outgoing ringback tone
 *   × _micActive flag (no AudioContext to guard)
 *   × _onUserGesture listeners
 *   × All new Audio() calls (none existed, confirmed)
 *
 * ── WHAT REMAINS ──────────────────────────────────────────────────────────────
 *   ✓ Voice element registry — tracks the single remote <audio> element so
 *     stopAllCallSounds() can detach srcObject on call end.
 *   ✓ stopAllCallSounds(reason) — detaches remote stream, pauses element.
 *   ✓ Backward-compat aliases so existing callers compile without changes.
 *
 * ── AUDIO SOURCES DURING A CONNECTED CALL ────────────────────────────────────
 *   SOURCE 1 — <audio ref={remoteAudioRef}> in active-call.tsx
 *              srcObject = remoteStream, muted=false, volume=1.
 *              This is the ONLY audio source. Started via .play() after
 *              srcObject is set (isConnected guard).
 *
 *   SOURCE 2 — <video ref={remoteVideoRef}> in active-call.tsx  (video calls)
 *              muted=true — audio is handled exclusively by SOURCE 1.
 *
 *   SOURCE 3 — <video ref={localVideoRef}> in active-call.tsx  (video calls)
 *              muted=true — local mic NEVER played back locally.
 */

console.log("[CALL_AUDIO_EMERGENCY] all custom call sounds disabled — AudioContext, oscillators, ringtone, ringback all removed");

// ── Voice element registry ─────────────────────────────────────────────────────

interface VoiceElEntry {
  el: HTMLAudioElement | HTMLVideoElement;
  label: string;
}

const _voiceElements: VoiceElEntry[] = [];

export function registerVoiceAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
): void {
  const dupIdx = _voiceElements.findIndex(e => e.label === label);
  if (dupIdx !== -1) {
    if (_voiceElements[dupIdx].el !== el) {
      _voiceElements.splice(dupIdx, 1);
    } else {
      return;
    }
  }
  _voiceElements.push({ el, label });
  console.log(`[CALL_AUDIO_EMERGENCY] remote voice attached — label=${label}, muted=${(el as HTMLAudioElement).muted}, volume=${(el as HTMLAudioElement).volume}`);
}

export function unregisterVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement): void {
  const idx = _voiceElements.findIndex(e => e.el === el);
  if (idx !== -1) _voiceElements.splice(idx, 1);
}

// ── Ringtone stubs — ALL NO-OPS ───────────────────────────────────────────────
// These are called from use-call-ringtone.ts and incoming-call.tsx.
// They do nothing. No AudioContext is created. No sound plays.

export function startIncomingRingtone(): void {
  console.log("[CALL_AUDIO_EMERGENCY] startIncomingRingtone() called — SUPPRESSED (silent mode)");
}

export function stopIncomingRingtone(reason: string): void {
  console.log(`[CALL_AUDIO_EMERGENCY] stopIncomingRingtone(${reason}) — no-op`);
}

export function startOutgoingRingback(): void {
  console.log("[CALL_AUDIO_EMERGENCY] startOutgoingRingback() called — SUPPRESSED (silent mode)");
}

export function stopOutgoingRingback(reason: string): void {
  console.log(`[CALL_AUDIO_EMERGENCY] stopOutgoingRingback(${reason}) — no-op`);
}

// ── stopAllNonVoiceCallAudio — stub ───────────────────────────────────────────
// Previously closed the AudioContext and set _micActive=true.
// Now a no-op since there is no AudioContext to close.

export function stopAllNonVoiceCallAudio(reason: string): void {
  console.log(`[CALL_AUDIO_EMERGENCY] stopAllNonVoiceCallAudio(${reason}) — no AudioContext to close (silent mode)`);
}

// ── stopAllCallSounds — detaches remote voice elements ────────────────────────

export function stopAllCallSounds(reason: string): void {
  for (const { el, label } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
    console.log(`[CALL_AUDIO_EMERGENCY] voice element detached on call end: label=${label}, reason=${reason}`);
  }
  _voiceElements.length = 0;
  console.log(`[CALL_AUDIO_EMERGENCY] all call audio stopped: ${reason}`);
}

// ── Backward-compat aliases ───────────────────────────────────────────────────

export const cleanupCallAudio = stopAllCallSounds;
export const registerCallAudioElement = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };
