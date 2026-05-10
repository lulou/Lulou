/**
 * call-audio.ts — Phone-call audio controller.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * STRICT AUDIO SEPARATION — three sources, three rules:
 *
 *   1. ringtoneAudio  — HTMLAudioElement with WAV blob URL, loop=true.
 *                       Plays ONLY on the RECEIVER's device during ringing.
 *                       STOPPED (paused + reset) before getUserMedia is called.
 *                       Never played during a connected call.
 *
 *   2. ringbackAudio  — HTMLAudioElement with WAV blob URL, loop=true.
 *                       Plays ONLY on the CALLER's device while waiting.
 *                       STOPPED before getUserMedia is called.
 *                       Never played during a connected call.
 *
 *   3. remoteVoiceAudio — HTMLAudioElement with srcObject = remote MediaStream.
 *                       The ONLY audible source during a connected call.
 *                       Registered via registerVoiceAudioElement().
 *                       Detached and cleared on call end.
 *
 *   LOCAL MIC STREAM — goes into RTCPeerConnection.addTrack() ONLY.
 *                       NEVER attached to any HTMLAudioElement.
 *                       NEVER audible locally. No feedback. No self-monitoring.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY new Audio() INSTEAD OF Web Audio API OSCILLATORS:
 *
 *   Web Audio API + iOS AVAudioSession interaction caused two bugs:
 *
 *   BUG 1 — No ringtone:
 *     new AudioContext() always starts SUSPENDED on iOS. resume() is async
 *     and requires a user gesture in the same call stack. The incoming overlay
 *     mounts in a React effect (not a gesture). By the time the user taps
 *     Answer (first gesture), silenceRing() kills the ring state before the
 *     context can resume. Ring never plays.
 *
 *   BUG 2 — Beeping/screeching during connected call:
 *     getUserMedia({audio}) switches iOS AVAudioSession to PlayAndRecord.
 *     This RESTARTS any live AudioContext — even one whose oscillators were
 *     stopped or whose context was "closed" (close() is async; 80ms wasn't
 *     always enough). The restarted context re-emits its sample buffer through
 *     the speaker. The open mic captures those 440/480 Hz tones and transmits
 *     them to the remote peer.
 *
 *   SOLUTION: HTMLAudioElement.play() with a WAV blob URL.
 *     - No AudioContext. No oscillators. No AVAudioSession restart risk.
 *     - Stopping = .pause() + .currentTime = 0. Instant and synchronous.
 *     - A paused <audio> element cannot be restarted by AVAudioSession changes.
 *     - Autoplay retry on first gesture handles iOS autoplay policy.
 */

// ── WAV generation ────────────────────────────────────────────────────────────

/**
 * Generate a PCM WAV blob URL with the given sample data.
 * 8kHz mono 16-bit PCM.
 */
function _makeWavUrl(samples: Float32Array): string {
  const numSamples = samples.length;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const dv = new DataView(buf);
  const w4 = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  const SR = 8000;
  w4(0, "RIFF"); dv.setUint32(4, 36 + numSamples * 2, true);
  w4(8, "WAVE"); w4(12, "fmt ");
  dv.setUint32(16, 16, true);       // PCM subchunk size
  dv.setUint16(20, 1, true);        // PCM format
  dv.setUint16(22, 1, true);        // mono
  dv.setUint32(24, SR, true);       // sample rate
  dv.setUint32(28, SR * 2, true);   // byte rate
  dv.setUint16(32, 2, true);        // block align
  dv.setUint16(34, 16, true);       // bits per sample
  w4(36, "data"); dv.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/**
 * Incoming ringtone: North American double-ring pattern.
 * 0.0–0.4 s ring · 0.15 s gap · 0.55–0.95 s ring · 2.05 s silence = 3 s loop.
 * 440 Hz + 480 Hz sine waves with 12 ms fade-in/out to avoid clicks.
 */
function _generateRingtoneSrc(): string {
  const SR = 8000;
  const DUR = 3.0;
  const n = Math.floor(SR * DUR);
  const samples = new Float32Array(n);
  const FADE = 0.012;
  const RINGS: [number, number][] = [[0.0, 0.4], [0.55, 0.95]];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = t % DUR;
    let env = 0;
    for (const [s, e] of RINGS) {
      if (mod >= s && mod < e) {
        env = Math.min((mod - s) / FADE, 1, (e - mod) / FADE);
        break;
      }
    }
    samples[i] = env * 0.22 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
  }
  return _makeWavUrl(samples);
}

/**
 * Outgoing ringback: US cadence 2 s ring · 4 s silence = 6 s loop.
 * 440 Hz + 480 Hz, slightly quieter than incoming.
 */
function _generateRingbackSrc(): string {
  const SR = 8000;
  const DUR = 6.0;
  const n = Math.floor(SR * DUR);
  const samples = new Float32Array(n);
  const FADE = 0.02;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = t % DUR;
    let env = 0;
    if (mod < 2.0) env = Math.min(mod / FADE, 1, (2.0 - mod) / FADE);
    samples[i] = env * 0.18 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
  }
  return _makeWavUrl(samples);
}

// Lazy-initialised blob URLs — created once, reused forever.
// Wrapped in try-catch: if URL.createObjectURL is blocked (e.g. strict CSP),
// we return "" so new Audio("") plays silently rather than crashing the component.
let _ringtoneSrc: string | null = null;
let _ringbackSrc: string | null = null;
const _getRingtoneSrc = (): string => {
  if (_ringtoneSrc === null) {
    try { _ringtoneSrc = _generateRingtoneSrc(); } catch { _ringtoneSrc = ""; }
  }
  return _ringtoneSrc;
};
const _getRingbackSrc = (): string => {
  if (_ringbackSrc === null) {
    try { _ringbackSrc = _generateRingbackSrc(); } catch { _ringbackSrc = ""; }
  }
  return _ringbackSrc;
};

// ── Module state ───────────────────────────────────────────────────────────────

/** The active ringtone element (receiver). null when not ringing. */
let _ringtoneEl: HTMLAudioElement | null = null;
/** The active ringback element (caller). null when not ringing. */
let _ringbackEl: HTMLAudioElement | null = null;

interface VoiceElEntry { el: HTMLAudioElement | HTMLVideoElement; label: string; }
const _voiceElements: VoiceElEntry[] = [];

// ── Play helper ───────────────────────────────────────────────────────────────

/**
 * Start playing `el`. If the browser blocks autoplay (iOS policy), retry
 * on the next user gesture. The `isStillActive` guard ensures we never
 * resume an element that was already stopped.
 */
function _playWithRetry(el: HTMLAudioElement, label: string, isStillActive: () => boolean): void {
  el.play().catch(() => {
    console.warn(`[PHONE_AUDIO] autoplay blocked for ${label} — will retry on first gesture`);
    const retry = () => {
      if (!isStillActive()) return; // element was stopped before gesture fired
      el.play().catch(() => {});
    };
    document.addEventListener("click",      retry, { once: true, passive: true });
    document.addEventListener("touchstart", retry, { once: true, passive: true });
  });
}

// ── Public ring API ────────────────────────────────────────────────────────────

/**
 * Start the incoming ringtone on the RECEIVER's device.
 *
 * Uses HTMLAudioElement (WAV blob URL) — no AudioContext, no oscillators.
 * Stops immediately when stopIncomingRingtone() or stopAllNonVoiceCallAudio()
 * is called, well before getUserMedia() opens the microphone.
 */
export function startIncomingRingtone(): void {
  try {
    stopIncomingRingtone("restart"); // clear any previous ring
    if (typeof window === "undefined") return;
    const src = _getRingtoneSrc();
    if (!src) { console.warn("[PHONE_AUDIO] ringtone src unavailable — skipping"); return; }
    const el = new Audio(src);
    el.loop = true;
    el.volume = 1.0;
    _ringtoneEl = el;
    console.log("[PHONE_AUDIO] incoming ringtone started");
    _playWithRetry(el, "incoming ringtone", () => _ringtoneEl === el);
  } catch (e) {
    console.warn("[PHONE_AUDIO] startIncomingRingtone error (non-fatal):", e);
  }
}

/**
 * Stop the incoming ringtone immediately and synchronously.
 * Safe to call multiple times (idempotent).
 */
export function stopIncomingRingtone(reason: string): void {
  if (!_ringtoneEl) return;
  _ringtoneEl.pause();
  _ringtoneEl.currentTime = 0;
  _ringtoneEl = null;
  if (reason !== "restart") {
    console.log("[PHONE_AUDIO] incoming ringtone stopped on answer");
    console.log(`[CALL_RINGTONE] stopped: ${reason}`);
  }
}

/**
 * Start the outgoing ringback on the CALLER's device.
 * Plays while waiting for the receiver to answer.
 */
export function startOutgoingRingback(): void {
  try {
    stopOutgoingRingback("restart");
    if (typeof window === "undefined") return;
    const src = _getRingbackSrc();
    if (!src) { console.warn("[PHONE_AUDIO] ringback src unavailable — skipping"); return; }
    const el = new Audio(src);
    el.loop = true;
    el.volume = 0.85;
    _ringbackEl = el;
    console.log("[PHONE_AUDIO] outgoing ringback started");
    _playWithRetry(el, "outgoing ringback", () => _ringbackEl === el);
  } catch (e) {
    console.warn("[PHONE_AUDIO] startOutgoingRingback error (non-fatal):", e);
  }
}

/**
 * Stop the outgoing ringback immediately.
 */
export function stopOutgoingRingback(reason: string): void {
  if (!_ringbackEl) return;
  _ringbackEl.pause();
  _ringbackEl.currentTime = 0;
  _ringbackEl = null;
  if (reason !== "restart") {
    console.log(`[PHONE_AUDIO] outgoing ringback stopped: ${reason}`);
    console.log(`[CALL_RINGTONE] stopped: ${reason}`);
  }
}

/**
 * Stop ALL non-voice call audio (ringtone + ringback).
 *
 * Called by use-webrtc.ts before getUserMedia() and by incoming-call.tsx
 * silenceRing(). After this call there are NO audio elements playing —
 * getUserMedia() sees a completely silent audio environment.
 *
 * NOTE: Because we use HTMLAudioElement (not AudioContext), there is no
 * risk that iOS AVAudioSession will "restart" any audio when switching to
 * PlayAndRecord mode. Paused <audio> elements are inert.
 */
export function stopAllNonVoiceCallAudio(reason: string): void {
  const hadRing = !!_ringtoneEl;
  const hadBack = !!_ringbackEl;
  if (hadRing || hadBack) {
    console.log(`[PHONE_AUDIO] non-call sound removed: ${reason} | ring=${hadRing} ringback=${hadBack}`);
  }
  stopIncomingRingtone(reason);
  stopOutgoingRingback(reason);
}

// ── Voice audio element registry ───────────────────────────────────────────────

/**
 * Register the remote voice <audio> element so stopAllCallSounds() can
 * detach it when the call ends.
 */
export function registerVoiceAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
): void {
  const dup = _voiceElements.findIndex(e => e.label === label);
  if (dup !== -1) {
    if (_voiceElements[dup].el === el) return; // already registered, no-op
    _voiceElements.splice(dup, 1);
  }
  _voiceElements.push({ el, label });
  console.log(`[PHONE_AUDIO] remote voice attached: ${label}`);
}

export function unregisterVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement): void {
  const i = _voiceElements.findIndex(e => e.el === el);
  if (i !== -1) _voiceElements.splice(i, 1);
}

/**
 * Stop ALL call audio: ringtones + voice elements.
 * Called on call end, component unmount, and page leave.
 */
export function stopAllCallSounds(reason: string): void {
  stopAllNonVoiceCallAudio(reason);
  for (const { el } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
  }
  _voiceElements.length = 0;
  console.log(`[PHONE_AUDIO] connected call audio = remote voice only: all non-voice audio stopped (${reason})`);
}

// ── Backward-compat aliases (all existing callers work unchanged) ──────────────

export const cleanupCallAudio          = stopAllCallSounds;
export const registerCallAudioElement  = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

// Legacy type export — keeps any old imports compiling
export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };

// ── Page leave cleanup ────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  window.addEventListener("pagehide",     () => stopAllCallSounds("pagehide"));
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}
