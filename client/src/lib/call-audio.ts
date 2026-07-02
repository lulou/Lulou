/**
 * call-audio.ts — Ringtone + call audio controller.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AUDIO SEPARATION RULES
 *
 *  ringtoneEl  — WAV blob, loop=true. RECEIVER only, during ringing.
 *                Stopped before getUserMedia. Never during a live call.
 *
 *  ringbackEl  — WAV blob, loop=true. CALLER only, waiting for answer.
 *                Stopped before getUserMedia. Never during a live call.
 *
 *  remoteVoice — HTMLAudioElement with srcObject = remote MediaStream.
 *                Only audible source during a connected call.
 *
 *  LOCAL MIC   — RTCPeerConnection.addTrack() ONLY.
 *                NEVER attached to any HTMLAudioElement.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHY SINGLETON ELEMENTS (not `new Audio()` per call)
 *
 *  iOS Safari enforces autoplay PER ELEMENT, not per session.
 *  Creating `new Audio()` inside startIncomingRingtone() produces a
 *  brand-new element that has never been user-activated — play() is
 *  blocked even if the user has previously tapped other things.
 *
 *  Fix: create ONE element for each tone at module load time.
 *  On the first user gesture, call play() on these same elements
 *  (pre-warm). iOS marks them as "user-activated" synchronously
 *  (before the Promise resolves). Future play() calls on the SAME
 *  elements succeed from any context — React effects, Supabase
 *  Realtime callbacks, anywhere.
 *
 * WHY HTMLAudioElement INSTEAD OF Web Audio API
 *
 *  Web Audio API + iOS AVAudioSession caused two bugs:
 *
 *  BUG 1 — No ringtone:
 *    AudioContext always starts SUSPENDED on iOS. resume() requires a
 *    gesture in the same call stack. The incoming overlay mounts from
 *    a Supabase Realtime effect (no gesture). By the time the user
 *    taps Answer, silenceRing() has killed the ring state — context
 *    never resumes.
 *
 *  BUG 2 — Screeching during connected call:
 *    getUserMedia() switches iOS AVAudioSession to PlayAndRecord.
 *    This RESTARTS any live AudioContext — re-emitting buffered tone
 *    samples through the speaker. The open mic captures those 440/480 Hz
 *    tones and transmits them to the remote peer as screeching.
 *
 *  HTMLAudioElement: stopping = .pause() + .currentTime = 0. Instant,
 *  synchronous, no AVAudioSession restart risk.
 */

import { isArmedSession, clearAllArmedSessions } from "@/lib/live-call-sessions";
import { isStartupSweepComplete, resetStartupSweep } from "@/lib/startup-sweep";
import { STARTUP_SILENCE_UNTIL } from "@/lib/app-load-time";

// Internal alias — keeps internal code private while using the shared set.
const _isSessionArmed = isArmedSession;

// ── WAV generation ─────────────────────────────────────────────────────────

function _makeWavUrl(samples: Float32Array): string {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w4 = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  const SR = 8000;
  w4(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true);
  w4(8, "WAVE"); w4(12, "fmt ");
  dv.setUint32(16, 16, true);  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);   dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w4(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/**
 * Incoming ringtone — "ring ring, pause, ring ring, pause" pattern.
 *
 * Timing:
 *   0.00 – 0.80 s   ring 1   (800 ms)
 *   0.80 – 1.50 s   gap      (700 ms)
 *   1.50 – 2.30 s   ring 2   (800 ms)
 *   2.30 – 4.50 s   silence  (2200 ms)
 *   Total: 4.5 s loop
 *
 * 440 Hz + 480 Hz (North American telephone cadence).
 * 20 ms fade-in/out on each burst to avoid clicks.
 */
function _buildRingtoneSamples(): Float32Array {
  const SR = 8000, DUR = 4.5;
  const n = Math.floor(SR * DUR);
  const s = new Float32Array(n);
  const FADE = 0.02;
  const RINGS: [number, number][] = [[0.00, 0.80], [1.50, 2.30]];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = t % DUR;
    let env = 0;
    for (const [a, b] of RINGS) {
      if (mod >= a && mod < b) { env = Math.min((mod - a) / FADE, 1, (b - mod) / FADE); break; }
    }
    s[i] = env * 0.70 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
  }
  return s;
}

/**
 * Outgoing ringback — US cadence 2 s ring · 4 s silence = 6 s loop.
 */
function _buildRingbackSamples(): Float32Array {
  const SR = 8000, DUR = 6.0;
  const n = Math.floor(SR * DUR);
  const s = new Float32Array(n);
  const FADE = 0.02;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = t % DUR;
    const env = mod < 2.0 ? Math.min(mod / FADE, 1, (2.0 - mod) / FADE) : 0;
    s[i] = env * 0.60 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
  }
  return s;
}

// Blob URLs created once and reused.
let _ringtoneSrc: string | null = null;
let _ringbackSrc: string | null = null;
function _getRingtoneSrc(): string {
  if (!_ringtoneSrc) { try { _ringtoneSrc = _makeWavUrl(_buildRingtoneSamples()); } catch { _ringtoneSrc = ""; } }
  return _ringtoneSrc;
}
function _getRingbackSrc(): string {
  if (!_ringbackSrc) { try { _ringbackSrc = _makeWavUrl(_buildRingbackSamples()); } catch { _ringbackSrc = ""; } }
  return _ringbackSrc;
}

// ── Singleton audio elements ───────────────────────────────────────────────
//
// ONE element per tone. Created at module load, reused for every call.
// Pre-warming on the first user gesture authorises the element on iOS Safari.

let _ringtoneEl: HTMLAudioElement | null = null;
let _ringbackEl: HTMLAudioElement | null = null;
let _ringtoneActive  = false;  // ring is supposed to be playing right now
let _ringbackActive  = false;
let _ringtoneWarm    = false;  // element has been user-activated on iOS
let _ringbackWarm    = false;

function _ensureRingtoneEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!_ringtoneEl) {
    const src = _getRingtoneSrc();
    if (!src) return null;
    _ringtoneEl = new Audio(src);
    _ringtoneEl.loop   = true;
    _ringtoneEl.volume = 1.0;
  }
  return _ringtoneEl;
}

function _ensureRingbackEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!_ringbackEl) {
    const src = _getRingbackSrc();
    if (!src) return null;
    _ringbackEl = new Audio(src);
    _ringbackEl.loop   = true;
    _ringbackEl.volume = 0.85;
  }
  return _ringbackEl;
}

/**
 * Pre-warm the singleton elements inside a user gesture call stack.
 *
 * On iOS Safari, calling play() within a gesture synchronously marks the
 * element as "user-activated" — before the Promise resolves. Even if
 * pause() is called immediately (causing AbortError on the Promise), the
 * activation sticks. Future play() calls on the same element succeed from
 * any context (React effects, Supabase callbacks, etc.).
 */
function _warmElements(): void {
  // ── Hard startup suppression ─────────────────────────────────────────────
  // Belt-and-suspenders for the 5-second silence window.  Even if
  // _ringtoneActive / _ringbackActive are somehow true (e.g. because a stale
  // rering slipped through all upstream guards), the warm-up path must not
  // play audio during the suppression window.  Treat both flags as false.
  const inSilenceWindow = Date.now() < STARTUP_SILENCE_UNTIL;
  const ringtoneAllowed  = _ringtoneActive  && !inSilenceWindow;
  const ringbackAllowed  = _ringbackActive  && !inSilenceWindow;
  if (inSilenceWindow && (_ringtoneActive || _ringbackActive)) {
    console.log("[CALL_AUDIO_GUARD] warmup suppressed — inside 5 s startup silence window", {
      msRemaining: STARTUP_SILENCE_UNTIL - Date.now(),
    });
  }

  // ── Ringtone ──
  const rt = _ensureRingtoneEl();
  if (rt && !_ringtoneWarm) {
    _ringtoneWarm = true; // mark synchronously — activation happens on play() call, not Promise resolve

    // Use muted=true (not just volume=0) for the warm-up when no ring is pending.
    // iOS Safari can still emit a brief audio burst from the pre-decoded buffer
    // before the async .then() fires, even at volume=0.  muted=true is a DOM-level
    // gate that the audio pipeline cannot bypass — guaranteed silence during warm-up.
    const wasMuted = rt.muted;
    if (!ringtoneAllowed) rt.muted = true;

    rt.play().then(() => {
      // If no incoming call is pending (or suppressed), silence immediately.
      if (!ringtoneAllowed) {
        rt.pause();
        rt.currentTime = 0;
        rt.muted = wasMuted;
        console.log("[CALL_RINGTONE] blocked because no verified incoming call");
      } else {
        rt.muted = wasMuted; // ensure audible for the real ring
        // Ring was waiting for unlock — it's now playing.
        console.log("[CALL_RINGTONE] incoming ringtone started (post-unlock)");
      }
    }).catch(() => {
      rt.muted = wasMuted;
      // AbortError from immediate pause is expected and harmless — element is still warm.
      if (ringtoneAllowed) {
        // Ring was waiting — try once more (should succeed now that element is warm).
        rt.currentTime = 0;
        rt.play().catch(() => {});
      }
    });
  }

  // ── Ringback ──
  const rb = _ensureRingbackEl();
  if (rb && !_ringbackWarm) {
    _ringbackWarm = true;

    // Same muted=true guard for ringback — prevents the "transition beep" that
    // occurs when Answer is the user's first gesture and _doUnlock fires mid-call.
    const wasMuted = rb.muted;
    if (!ringbackAllowed) rb.muted = true;

    rb.play().then(() => {
      if (!ringbackAllowed) {
        rb.pause();
        rb.currentTime = 0;
        rb.muted = wasMuted;
        console.log("[FINAL_CALL_FIX] stale ringtone blocked");
      } else {
        rb.muted = wasMuted;
      }
    }).catch(() => {
      rb.muted = wasMuted;
      if (ringbackAllowed) { rb.currentTime = 0; rb.play().catch(() => {}); }
    });
  }
}

// ── Audio policy unlock ────────────────────────────────────────────────────
//
// iOS requires play() to be called in a gesture context to authorise the
// element. We listen for the first touchstart/click in CAPTURE phase (before
// any React onClick handler can silence the ring) and warm both elements.
//
// IMPORTANT: listeners are NOT registered at module load time. They are only
// registered when the user is authenticated (CallDetectors mount calls
// registerCallAudioUnlock). This prevents the warm-up play() from firing on
// the Landing page, which could produce an OS-level audio artifact or — if
// _ringtoneActive is somehow true from a stale/crashed session — a full
// audible ringtone for a logged-out user.

let _audioUnlocked = false;
let _unlockListenersRegistered = false;
const _unlockCallbacks: Array<() => void> = [];

function _doUnlock(): void {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  document.removeEventListener("touchstart", _doUnlock, true);
  document.removeEventListener("click",      _doUnlock, true);
  _unlockListenersRegistered = false;

  // Warm the singleton ring elements — this is the critical iOS fix.
  _warmElements();

  console.log("[CALL_RINGTONE] audio unlocked");

  for (const cb of _unlockCallbacks) { try { cb(); } catch { /* non-fatal */ } }
  _unlockCallbacks.length = 0;
}

/**
 * Register the audio-unlock gesture listeners.
 * Must be called from CallDetectors (authenticated context only).
 * Calling before auth resolves would let the warm-up play() fire on the
 * Landing page, which can produce a brief audible tone on some systems.
 */
export function registerCallAudioUnlock(): void {
  if (_audioUnlocked || _unlockListenersRegistered) return;
  if (typeof window === "undefined") return;
  _unlockListenersRegistered = true;
  document.addEventListener("touchstart", _doUnlock, { capture: true, passive: true });
  document.addEventListener("click",      _doUnlock, { capture: true, passive: true });
  console.log("[CALL_AUDIO_GUARD] audio unlock listeners registered (user authenticated)");
}

/**
 * Unregister the audio-unlock listeners.
 * Called from CallDetectors cleanup (user logged out or component unmounted).
 */
export function unregisterCallAudioUnlock(): void {
  if (!_unlockListenersRegistered) return;
  if (typeof window === "undefined") return;
  _unlockListenersRegistered = false;
  document.removeEventListener("touchstart", _doUnlock, true);
  document.removeEventListener("click",      _doUnlock, true);
  // Reset the unlocked flag so the next login session gets a fresh warm-up.
  _audioUnlocked = false;
  console.log("[CALL_AUDIO_GUARD] audio unlock listeners unregistered (user logged out)");
}

/** Whether the browser's autoplay gate has been lifted by a user gesture. */
export function isAudioUnlocked(): boolean { return _audioUnlocked; }

/** Trigger the audio unlock programmatically from a gesture handler. */
export function unlockAudioNow(): void { _doUnlock(); }

/**
 * Register a callback that fires once when audio is unlocked.
 * Fires immediately (synchronously) if already unlocked.
 * Returns an unsubscribe function.
 */
export function onAudioUnlocked(cb: () => void): () => void {
  if (_audioUnlocked) { cb(); return () => {}; }
  _unlockCallbacks.push(cb);
  return () => {
    const i = _unlockCallbacks.indexOf(cb);
    if (i !== -1) _unlockCallbacks.splice(i, 1);
  };
}

// ── Public ringtone API ────────────────────────────────────────────────────

/**
 * Start the incoming ringtone (RECEIVER only).
 *
 * Pass `sessionId` from the match so the guard can confirm it was armed by a
 * live Realtime call:ring event.  If the session is not armed (stale DB row,
 * cache hit, or route-change refetch), the ring is blocked before any audio
 * is produced — eliminating the "random ring on navigation" bug.
 *
 * Uses the singleton element. If it has been pre-warmed (any prior gesture),
 * play() succeeds immediately from a React effect. If not yet warmed (cold
 * mobile session with no prior gesture), play() is blocked — the ring starts
 * automatically when _doUnlock fires on the next touch. Vibration is triggered
 * as an immediate tactile fallback on Android.
 */
export function startIncomingRingtone(sessionId?: string | null): void {
  try {
    if (typeof window === "undefined") return;
    // Safety guard: if the audio unlock listeners were never registered, the user
    // is not authenticated. Block the ringtone and log for diagnostics.
    if (!_unlockListenersRegistered && !_audioUnlocked) {
      console.log("[CALL_AUDIO_GUARD] blocked call audio because user is logged out");
      return;
    }

    // ── Hard startup silence window ──────────────────────────────────────
    // No ringtone may play for the first 5 seconds after module load.
    // This is the outermost firewall: it catches every race condition
    // (cached /api/matches, optimistic patches, early rerings) regardless
    // of whether the startup sweep has completed or the session is armed.
    // Any genuine incoming call that starts during this window will still
    // be ringing via Realtime rerings — the next rering after STARTUP_SILENCE_UNTIL
    // will pass this guard and start audio normally.
    if (Date.now() < STARTUP_SILENCE_UNTIL) {
      console.log("[CALL_AUDIO_GUARD] incoming ring suppressed — inside 5 s startup silence window", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        msRemaining: STARTUP_SILENCE_UNTIL - Date.now(),
      });
      return;
    }

    // ── Startup-sweep guard ──────────────────────────────────────────────
    // The startup sweep must complete before any ringtone plays. This is the
    // definitive firewall: even if a session is somehow armed before the sweep
    // runs (timing race on bfcache restore or rapid Realtime reconnect), no
    // audio can play until the first /api/matches pass has classified all
    // pre-load call state as stale.
    if (!isStartupSweepComplete()) {
      console.log("[RING_DEBUG] STARTUP_AUDIO_BLOCKED incoming ring — sweep not complete", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        source: "startIncomingRingtone",
      });
      return;
    }

    // ── Armed-session guard ──────────────────────────────────────────────
    // Only sessions confirmed by a live Realtime call:ring event may play
    // audio. Stale DB rows (refetch, cache hits, route-change polls) are
    // blocked here — they can reach incomingCall memo if the session was
    // previously armed but the end signal was lost, so this is the final
    // firewall preventing ghost rings on navigation.
    //
    // NOTE: null/undefined sessionId is also blocked — a missing session ID
    // means the call state came from stale/partial data, not a live signal.
    if (!sessionId || !_isSessionArmed(sessionId)) {
      console.log("[RING_DEBUG] blocked stale trigger — session not armed", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        source: "startIncomingRingtone",
      });
      return;
    }
    console.log("[RING_DEBUG] verified live call trigger", {
      sessionId: sessionId.slice(0, 8),
      source: "startIncomingRingtone",
    });

    const el = _ensureRingtoneEl();
    if (!el) { console.warn("[CALL_RINGTONE] ringtone element unavailable"); return; }

    // If already playing for some reason, stop before restarting.
    if (_ringtoneActive) {
      el.pause();
      el.currentTime = 0;
    }

    _ringtoneActive = true;
    el.currentTime  = 0;

    console.log("[CALL_RINGTONE] incoming ringtone started");

    el.play().catch(() => {
      // Blocked by autoplay policy (cold session, no prior gesture).
      console.log("[CALL_RINGTONE] ringtone blocked by autoplay — waiting for first gesture");

      // Vibration fallback — works on Android without audio unlock.
      try {
        if (navigator.vibrate) {
          navigator.vibrate([400, 200, 400, 1500, 400, 200, 400]);
        }
      } catch { /* non-fatal */ }
      // _ringtoneActive remains true. When _doUnlock fires on the next touch,
      // _warmElements() calls play() on this element and it starts ringing.
    });
  } catch (e) {
    _ringtoneActive = false;
    console.warn("[CALL_RINGTONE] startIncomingRingtone error:", e);
  }
}

/**
 * Stop the incoming ringtone immediately.
 * Pauses and resets the element but does NOT destroy it — singleton stays warm.
 */
export function stopIncomingRingtone(reason: string): void {
  _ringtoneActive = false;
  const el = _ringtoneEl;
  if (!el) return;
  el.pause();
  el.currentTime = 0;
  console.log(`[CALL_RINGTONE] stopped: ${reason}`);
}

/**
 * Start the outgoing ringback (CALLER only, while waiting for answer).
 *
 * Pass `sessionId` so the armed-session guard can confirm this is a live call
 * before any audio plays.  See startIncomingRingtone for the full rationale.
 */
export function startOutgoingRingback(sessionId?: string | null): void {
  try {
    if (typeof window === "undefined") return;
    // Safety guard: same auth check as startIncomingRingtone.
    if (!_unlockListenersRegistered && !_audioUnlocked) {
      console.log("[CALL_AUDIO_GUARD] blocked call audio because user is logged out");
      return;
    }

    // ── Hard startup silence window — same rule as startIncomingRingtone ──
    if (Date.now() < STARTUP_SILENCE_UNTIL) {
      console.log("[CALL_AUDIO_GUARD] outgoing ringback suppressed — inside 5 s startup silence window", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        msRemaining: STARTUP_SILENCE_UNTIL - Date.now(),
      });
      return;
    }

    // ── Startup-sweep guard — same rule as startIncomingRingtone ──────────
    if (!isStartupSweepComplete()) {
      console.log("[RING_DEBUG] STARTUP_AUDIO_BLOCKED outgoing ringback — sweep not complete", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        source: "startOutgoingRingback",
      });
      return;
    }

    // ── Armed-session guard ──────────────────────────────────────────────
    // null/undefined sessionId is blocked — same rule as startIncomingRingtone.
    if (!sessionId || !_isSessionArmed(sessionId)) {
      console.log("[RING_DEBUG] blocked stale trigger — session not armed", {
        sessionId: sessionId ? sessionId.slice(0, 8) : "null",
        source: "startOutgoingRingback",
      });
      return;
    }
    console.log("[RING_DEBUG] verified live call trigger", {
      sessionId: sessionId.slice(0, 8),
      source: "startOutgoingRingback",
    });

    const el = _ensureRingbackEl();
    if (!el) return;

    if (_ringbackActive) { el.pause(); el.currentTime = 0; }

    _ringbackActive = true;
    el.currentTime  = 0;

    el.play().catch(() => {
      // Will auto-start when _doUnlock fires (same mechanism as ringtone).
    });
  } catch (e) {
    _ringbackActive = false;
    console.warn("[CALL_RINGTONE] startOutgoingRingback error:", e);
  }
}

/**
 * Stop the outgoing ringback immediately.
 */
export function stopOutgoingRingback(reason: string): void {
  _ringbackActive = false;
  const el = _ringbackEl;
  if (!el) return;
  el.pause();
  el.currentTime = 0;
  if (reason !== "restart") {
    console.log(`[CALL_RINGTONE] stopped: ${reason}`);
  }
}

/**
 * Stop ALL non-voice call audio (ringtone + ringback).
 * Called before getUserMedia() opens the microphone.
 */
export function stopAllNonVoiceCallAudio(reason: string): void {
  const hadRing = _ringtoneActive;
  const hadBack = _ringbackActive;
  stopIncomingRingtone(reason);
  stopOutgoingRingback(reason);
  if (!hadRing && !hadBack) return;
  // Suppress the duplicate log from stopIncomingRingtone — already logged above.
}

// ── Voice element registry ─────────────────────────────────────────────────
// Tracks the remote voice <audio> element so stopAllCallSounds() can detach it.

interface VoiceElEntry { el: HTMLAudioElement | HTMLVideoElement; label: string; }
const _voiceElements: VoiceElEntry[] = [];

export function registerVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement, label: string): void {
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
 * Stop ALL call audio: ringtone + ringback + remote voice elements.
 */
export function stopAllCallSounds(reason: string): void {
  stopAllNonVoiceCallAudio(reason);
  for (const { el } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
  }
  _voiceElements.length = 0;
  console.log("[CALL_AUDIO] cleanup complete", { reason });
}

// ── Backward-compat aliases ────────────────────────────────────────────────

export const cleanupCallAudio           = stopAllCallSounds;
export const registerCallAudioElement   = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };

// ── Page leave cleanup ─────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    stopAllCallSounds("pagehide");
    // Clear armed sessions and reset startup sweep so that if the browser
    // restores the page from bfcache, no stale sessions can trigger audio
    // before the sweep re-runs. Belt-and-suspenders alongside the pageshow
    // handler in CallDetectors which does the same on bfcache restore.
    clearAllArmedSessions();
    resetStartupSweep();
    console.log("[CALL_AUDIO_GUARD] pagehide — armed sessions cleared, sweep reset");
  });
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}
