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
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w4(36, "data"); dv.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/**
 * Incoming ringtone — classic "ring ring, pause, ring ring, pause" pattern.
 *
 * Pattern:
 *   0.00 – 0.80 s  ring  #1  (800 ms)
 *   0.80 – 1.50 s  gap        (700 ms)
 *   1.50 – 2.30 s  ring  #2  (800 ms)
 *   2.30 – 4.50 s  silence   (2200 ms)
 *   Total loop: 4.5 s
 *
 * 440 Hz + 480 Hz (standard North American telephone tone) with 20 ms
 * fade-in/out on each ring burst to avoid clicks.
 */
function _generateRingtoneSrc(): string {
  const SR = 8000;
  const DUR = 4.5;
  const n = Math.floor(SR * DUR);
  const samples = new Float32Array(n);
  const FADE = 0.020; // 20 ms fade edges
  const RINGS: [number, number][] = [
    [0.00, 0.80],   // ring 1
    [1.50, 2.30],   // ring 2
  ];
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
    samples[i] = env * 0.70 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
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
    samples[i] = env * 0.60 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
  }
  return _makeWavUrl(samples);
}

// Lazy-initialised blob URLs — created once, reused forever.
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

let _ringtoneEl: HTMLAudioElement | null = null;
let _ringbackEl: HTMLAudioElement | null = null;
/**
 * True when an incoming ringtone attempted play() but was blocked by the
 * browser's autoplay policy. _unlockAudio() checks this flag and starts the
 * ring immediately in the capture phase of the first user gesture.
 */
let _ringtonePending = false;
let _ringbackPending = false;

interface VoiceElEntry { el: HTMLAudioElement | HTMLVideoElement; label: string; }
const _voiceElements: VoiceElEntry[] = [];

// ── Audio policy unlock ───────────────────────────────────────────────────────
//
// iOS Safari (and strict-mode Chrome) block audio.play() until the page has
// received at least one user gesture. The incoming-call overlay is mounted by
// a Supabase Realtime broadcast — there is no gesture in that call stack — so
// the first el.play() attempt inside startIncomingRingtone() fails silently.
//
// Fix: play a 1-sample silent WAV on the very first user interaction with the
// app. This lifts the browser's autoplay gate for the entire session, so any
// subsequent el.play() (including the incoming ringtone) works immediately.

let _audioUnlocked = false;
const _unlockCallbacks: Array<() => void> = [];

function _unlockAudio(): void {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  document.removeEventListener("touchstart", _unlockAudio, true);
  document.removeEventListener("click",      _unlockAudio, true);
  try {
    const el = new Audio(_makeWavUrl(new Float32Array(1)));
    el.volume = 0;
    el.play().then(() => { el.src = ""; }).catch(() => {});
    console.log("[RINGTONE_MOBILE] audio unlocked on first gesture");
  } catch { /* non-fatal */ }

  // Immediately start any ringtone/ringback that failed to autoplay.
  // Fires in CAPTURE phase — before any Answer/Decline React onClick handler.
  if (_ringtonePending && _ringtoneEl) {
    _ringtoneEl.play().then(() => {
      _ringtonePending = false;
      console.log("[RINGTONE_MOBILE] pending ringtone started after unlock");
    }).catch(() => { _ringtonePending = false; });
  }
  if (_ringbackPending && _ringbackEl) {
    _ringbackEl.play().then(() => {
      _ringbackPending = false;
    }).catch(() => { _ringbackPending = false; });
  }

  // Notify any React components that registered an unlock callback.
  for (const cb of _unlockCallbacks) {
    try { cb(); } catch { /* non-fatal */ }
  }
  _unlockCallbacks.length = 0;
}

if (typeof window !== "undefined") {
  document.addEventListener("touchstart", _unlockAudio, { capture: true, passive: true });
  document.addEventListener("click",      _unlockAudio, { capture: true, passive: true });
}

/** Returns true once the browser's autoplay gate has been lifted. */
export function isAudioUnlocked(): boolean {
  return _audioUnlocked;
}

/**
 * Programmatically trigger the audio unlock (call from a user-gesture handler).
 * Safe to call multiple times — idempotent.
 */
export function unlockAudioNow(): void {
  _unlockAudio();
}

/**
 * Register a callback that fires once when audio is unlocked.
 * If already unlocked, fires immediately (synchronously).
 */
export function onAudioUnlocked(cb: () => void): () => void {
  if (_audioUnlocked) {
    cb();
    return () => {};
  }
  _unlockCallbacks.push(cb);
  return () => {
    const i = _unlockCallbacks.indexOf(cb);
    if (i !== -1) _unlockCallbacks.splice(i, 1);
  };
}

// ── Public ring API ───────────────────────────────────────────────────────────

/**
 * Start the incoming ringtone on the RECEIVER's device.
 *
 * Uses HTMLAudioElement (WAV blob URL) — no AudioContext, no oscillators.
 * Pattern: "ring ring, pause, ring ring, pause" (4.5 s loop).
 *
 * On mobile where autoplay is blocked, the pending flag causes
 * _unlockAudio() to restart the ring on the next user gesture.
 * Vibration is also triggered immediately as a tactile fallback.
 */
export function startIncomingRingtone(): void {
  try {
    stopIncomingRingtone("restart");
    if (typeof window === "undefined") return;
    const src = _getRingtoneSrc();
    if (!src) { console.warn("[RINGTONE] ringtone src unavailable — skipping"); return; }
    const el = new Audio(src);
    el.loop = true;
    el.volume = 1.0;
    _ringtoneEl = el;
    _ringtonePending = true;

    console.log("[RINGTONE] phone pattern start — ring ring, pause, ring ring, pause (4.5s loop)");

    el.play().then(() => {
      _ringtonePending = false;
      console.log("[RINGTONE_MOBILE] audio unlocked — ringtone playing immediately");
    }).catch(() => {
      console.warn("[RINGTONE_MOBILE] autoplay blocked — ringtone pending until first gesture");

      // Vibration fallback — works on Android without any audio unlock.
      // Pattern: ring(400ms) pause(200ms) ring(400ms) pause(1000ms) x repeat
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate([400, 200, 400, 1000, 400, 200, 400]);
          console.log("[RINGTONE_MOBILE] vibration fallback triggered");
        }
      } catch { /* non-fatal */ }

      const DELAYS_MS = [120, 400];
      let attempt = 0;
      const isActive = () => _ringtoneEl === el;
      const tryNext = () => {
        if (!isActive()) { _ringtonePending = false; return; }
        if (attempt >= DELAYS_MS.length) {
          // Last resort — gesture-based retry (fires BEFORE Answer/Decline via capture)
          const retry = () => {
            if (!isActive()) { _ringtonePending = false; return; }
            el.play().then(() => { _ringtonePending = false; }).catch(() => {});
          };
          document.addEventListener("click",      retry, { once: true, passive: true });
          document.addEventListener("touchstart", retry, { once: true, passive: true });
          return;
        }
        const delay = DELAYS_MS[attempt++];
        setTimeout(() => {
          if (!isActive()) { _ringtonePending = false; return; }
          el.play().then(() => { _ringtonePending = false; }).catch(tryNext);
        }, delay);
      };
      tryNext();
    });
  } catch (e) {
    _ringtonePending = false;
    console.warn("[RINGTONE] startIncomingRingtone error (non-fatal):", e);
  }
}

/**
 * Stop the incoming ringtone immediately and synchronously.
 * Safe to call multiple times (idempotent).
 */
export function stopIncomingRingtone(reason: string): void {
  _ringtonePending = false;
  if (!_ringtoneEl) return;
  _ringtoneEl.pause();
  _ringtoneEl.currentTime = 0;
  _ringtoneEl = null;
  if (reason !== "restart") {
    console.log(`[RINGTONE] stop: ${reason}`);
  }
}

/**
 * Start the outgoing ringback on the CALLER's device.
 */
export function startOutgoingRingback(): void {
  try {
    stopOutgoingRingback("restart");
    if (typeof window === "undefined") return;
    const src = _getRingbackSrc();
    if (!src) { console.warn("[RINGTONE] ringback src unavailable — skipping"); return; }
    const el = new Audio(src);
    el.loop = true;
    el.volume = 0.85;
    _ringbackEl = el;
    _ringbackPending = true;
    el.play().then(() => { _ringbackPending = false; }).catch(() => {
      const DELAYS_MS = [120, 400];
      let attempt = 0;
      const isActive = () => _ringbackEl === el;
      const tryNext = () => {
        if (!isActive()) { _ringbackPending = false; return; }
        if (attempt >= DELAYS_MS.length) {
          const retry = () => {
            if (!isActive()) { _ringbackPending = false; return; }
            el.play().then(() => { _ringbackPending = false; }).catch(() => {});
          };
          document.addEventListener("click",      retry, { once: true, passive: true });
          document.addEventListener("touchstart", retry, { once: true, passive: true });
          return;
        }
        const delay = DELAYS_MS[attempt++];
        setTimeout(() => {
          if (!isActive()) { _ringbackPending = false; return; }
          el.play().then(() => { _ringbackPending = false; }).catch(tryNext);
        }, delay);
      };
      tryNext();
    });
  } catch (e) {
    _ringbackPending = false;
    console.warn("[RINGTONE] startOutgoingRingback error (non-fatal):", e);
  }
}

/**
 * Stop the outgoing ringback immediately.
 */
export function stopOutgoingRingback(reason: string): void {
  _ringbackPending = false;
  if (!_ringbackEl) return;
  _ringbackEl.pause();
  _ringbackEl.currentTime = 0;
  _ringbackEl = null;
  if (reason !== "restart") {
    console.log(`[RINGTONE] stop: ${reason}`);
  }
}

/**
 * Stop ALL non-voice call audio (ringtone + ringback).
 * Called before getUserMedia() opens the microphone.
 */
export function stopAllNonVoiceCallAudio(reason: string): void {
  const hadRing = !!_ringtoneEl;
  const hadBack = !!_ringbackEl;
  if (hadRing || hadBack) {
    console.log(`[RINGTONE] stop: ${reason} | ring=${hadRing} ringback=${hadBack}`);
  }
  stopIncomingRingtone(reason);
  stopOutgoingRingback(reason);
}

// ── Voice audio element registry ──────────────────────────────────────────────

export function registerVoiceAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
): void {
  const dup = _voiceElements.findIndex(e => e.label === label);
  if (dup !== -1) {
    if (_voiceElements[dup].el === el) return;
    _voiceElements.splice(dup, 1);
  }
  _voiceElements.push({ el, label });
}

export function unregisterVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement): void {
  const i = _voiceElements.findIndex(e => e.el === el);
  if (i !== -1) _voiceElements.splice(i, 1);
}

/**
 * Stop ALL call audio: ringtones + voice elements.
 */
export function stopAllCallSounds(reason: string): void {
  stopAllNonVoiceCallAudio(reason);
  for (const { el } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
  }
  _voiceElements.length = 0;
}

// ── Backward-compat aliases ───────────────────────────────────────────────────

export const cleanupCallAudio           = stopAllCallSounds;
export const registerCallAudioElement   = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };

// ── Page leave cleanup ────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  window.addEventListener("pagehide",     () => stopAllCallSounds("pagehide"));
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}
