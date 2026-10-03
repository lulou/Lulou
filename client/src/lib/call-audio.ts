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
 *  Reuse these elements across calls. The caller ringback can be pre-warmed
 *  on a gesture; the incoming ringtone is never played as a generic warm-up
 *  and may only be retried while its exact verified authority grant is live.
 *
 * WHY HTMLAudioElement INSTEAD OF Web Audio API
 *
 *  Web Audio API + iOS AVAudioSession caused two bugs:
 *
 *  BUG 1 — No ringtone:
 *    AudioContext always starts SUSPENDED on iOS. resume() requires a
 *    gesture in the same call stack. Incoming playback therefore uses a
 *    singleton HTMLAudioElement and is retried from an authorized gesture.
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

import { isArmedSession } from "./live-call-sessions";
import { isStartupSweepComplete } from "./startup-sweep";
import { STARTUP_SILENCE_UNTIL } from "./app-load-time";
import { incomingCallAuthority, type IncomingCallGrant } from "./incoming-call-authority";

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
// Incoming playback is authority-gated; caller ringback may use a silent warm-up.

let _ringtoneEl: HTMLAudioElement | null = null;
let _ringbackEl: HTMLAudioElement | null = null;
let _ringtoneActive  = false;  // ring is supposed to be playing right now
let _ringbackActive  = false;
let _ringtoneSessionId: string | null = null;
let _ringbackSessionId: string | null = null;
let _ringbackWarm    = false;
let _ringtoneGrant: IncomingCallGrant | null = null;
let _ringtoneAttempt = 0;
let _ringbackAttempt = 0;
let _ringtonePlayPending = false;
let _ringbackPlayPending = false;

function _hasIncomingAuthority(sessionId: string, grant: IncomingCallGrant): boolean {
  return incomingCallAuthority.get(sessionId) === grant;
}

function _ownsIncomingAttempt(sessionId: string, grant: IncomingCallGrant, attempt: number): boolean {
  return _ringtoneActive
    && _ringtoneSessionId === sessionId
    && _ringtoneGrant === grant
    && _ringtoneAttempt === attempt;
}

function _playAuthorizedIncoming(sessionId: string, grant: IncomingCallGrant): void {
  if (!_ringtoneActive || _ringtoneSessionId !== sessionId || _ringtoneGrant !== grant) return;
  if (!_hasIncomingAuthority(sessionId, grant)) {
    stopIncomingRingtoneForSession(sessionId, "incoming_authority_expired");
    return;
  }
  const el = _ensureRingtoneEl();
  if (!el || _ringtonePlayPending || !el.paused) return;

  const attempt = _ringtoneAttempt;
  _ringtonePlayPending = true;
  el.muted = false;
  try {
    el.play().then(() => {
      if (!_ownsIncomingAttempt(sessionId, grant, attempt)) {
        // A late play() resolution must not revive a stopped singleton. Never
        // pause a newer call that has since taken ownership of this element.
        if (!_ringtoneActive && _ringtoneSessionId === null) {
          el.pause();
          el.currentTime = 0;
        }
        return;
      }
      _ringtonePlayPending = false;
      if (!_hasIncomingAuthority(sessionId, grant)) {
        stopIncomingRingtoneForSession(sessionId, "authority_revoked_during_play");
      }
    }).catch(() => {
      if (!_ownsIncomingAttempt(sessionId, grant, attempt)) return;
      _ringtonePlayPending = false;
      if (!_hasIncomingAuthority(sessionId, grant)) {
        stopIncomingRingtoneForSession(sessionId, "authority_revoked_during_play");
        return;
      }
      // Vibration is a tactile fallback only for the currently authorized ring.
      try {
        if (navigator.vibrate) navigator.vibrate([400, 200, 400, 1500, 400, 200, 400]);
      } catch { /* non-fatal */ }
    });
  } catch {
    if (_ownsIncomingAttempt(sessionId, grant, attempt)) _ringtonePlayPending = false;
  }
}

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
  const inSilenceWindow = Date.now() < STARTUP_SILENCE_UNTIL;
  if (inSilenceWindow && (_ringtoneActive || _ringbackActive)) {
    console.log("[CALL_AUDIO_GUARD] warmup suppressed — inside 5 s startup silence window", {
      msRemaining: STARTUP_SILENCE_UNTIL - Date.now(),
    });
  }

  // An incoming tone is never played merely to warm the singleton. A user
  // gesture may retry it only for the exact, still-live verified grant.
  const incomingSessionId = _ringtoneSessionId;
  const incomingGrant = incomingSessionId ? incomingCallAuthority.get(incomingSessionId) : null;
  if (!inSilenceWindow && isStartupSweepComplete() && incomingSessionId
    && incomingGrant && _ringtoneGrant === incomingGrant) {
    _playAuthorizedIncoming(incomingSessionId, incomingGrant);
  }

  // Ringback remains caller-side and armed-session owned. Its warm-up callbacks
  // carry both the exact session ID and an attempt generation so a delayed
  // gesture Promise cannot unmute or retry a replacement call.
  const rb = _ensureRingbackEl();
  if (rb && !_ringbackWarm) {
    _ringbackWarm = true;
    const sessionId = _ringbackSessionId;
    if (_ringbackActive && sessionId) {
      _playOwnedRingback(sessionId);
      return;
    }
    const attempt = _ringbackAttempt;
    const wasMuted = rb.muted;
    rb.muted = true;

    rb.play().then(() => {
      if (_ringbackAttempt !== attempt || _ringbackSessionId !== sessionId || _ringbackActive) return;
      rb.pause();
      rb.currentTime = 0;
      rb.muted = wasMuted;
    }).catch(() => {
      if (_ringbackAttempt !== attempt || _ringbackSessionId !== sessionId || _ringbackActive) return;
      rb.muted = wasMuted;
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

  // Warm caller-side audio and retry an incoming sound only while its exact
  // verified session grant remains current.
  _warmElements();

  console.log("[CALL_RINGTONE] audio unlocked");

  for (const cb of _unlockCallbacks) { try { cb(); } catch { /* non-fatal */ } }
  _unlockCallbacks.length = 0;
}

/**
 * Register the audio-unlock gesture listeners.
 * Must be called from CallDetectors (authenticated context only). Incoming
 * playback remains independently gated by the current verified call grant.
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
 * Pass `sessionId` from the match so the audio controller can require the
 * current backend-verified incoming authority grant for this exact session.
 * Armed state or cached UI data alone can never authorize this sound.
 *
 * Uses the singleton element. A rejected autoplay attempt may be retried only
 * by the hook timer or a user gesture while the same authority grant remains
 * live. Vibration is triggered as a tactile fallback on Android.
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

    // Armed-session state only records transport/UI history. Incoming audio is
    // authorized exclusively by the current backend-verified grant.
    if (!sessionId) return;
    const grant = incomingCallAuthority.get(sessionId);
    if (!grant) {
      stopIncomingRingtoneForSession(sessionId, "incoming_authority_missing");
      console.log("[CALL_AUDIO_GUARD] blocked incoming ring without live verified authority", {
        sessionId: sessionId.slice(0, 8),
      });
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

    console.log("[RING_DEBUG] verified live call trigger", {
      sessionId: sessionId.slice(0, 8),
      source: "startIncomingRingtone",
    });

    const el = _ensureRingtoneEl();
    if (!el) { console.warn("[CALL_RINGTONE] ringtone element unavailable"); return; }

    if (_ringtoneActive && _ringtoneSessionId === sessionId && _ringtoneGrant === grant) {
      _playAuthorizedIncoming(sessionId, grant);
      return;
    }
    if (_ringtoneActive && _ringtoneSessionId && _ringtoneSessionId !== sessionId
      && _ringtoneGrant && _hasIncomingAuthority(_ringtoneSessionId, _ringtoneGrant)) {
      console.log("[CALL_AUDIO_GUARD] retained ringtone owned by another verified session");
      return;
    }
    // A replacement session takes ownership of the singleton.
    if (_ringtoneActive) stopIncomingRingtone("replaced_by_new_incoming_session");

    _ringtoneActive = true;
    _ringtoneSessionId = sessionId;
    _ringtoneGrant = grant;
    _ringtoneAttempt++;
    _ringtonePlayPending = false;
    el.currentTime  = 0;

    console.log("[CALL_RINGTONE] incoming ringtone started");
    console.log("[CALL_RING] ringtone started");
    console.log("[CALL_STARTUP] startup_ringtone_started", {
      callSessionId: sessionId,
      startup_ringtone_started: true,
    });

    _playAuthorizedIncoming(sessionId, grant);
  } catch (e) {
    if (sessionId && _ringtoneSessionId === sessionId) stopIncomingRingtoneForSession(sessionId, "incoming_start_error");
    console.warn("[CALL_RINGTONE] startIncomingRingtone error:", e);
  }
}

/**
 * Stop the incoming ringtone immediately.
 * Pauses and resets the element but does NOT destroy it — singleton stays warm.
 */
export function stopIncomingRingtone(reason: string): void {
  _ringtoneAttempt++;
  _ringtonePlayPending = false;
  _ringtoneActive = false;
  _ringtoneSessionId = null;
  _ringtoneGrant = null;
  const el = _ringtoneEl;
  if (!el) return;
  el.pause();
  el.currentTime = 0;
  console.log(`[CALL_RINGTONE] stopped: ${reason}`);
  console.log(`[CALL_RING] ringtone stopped: ${reason}`);
}

/** Stop only when the named session still owns the incoming ringtone. */
export function stopIncomingRingtoneForSession(sessionId: string | null | undefined, reason: string): void {
  if (!sessionId || _ringtoneSessionId !== sessionId) return;
  stopIncomingRingtone(reason);
}

/** Stop only call tones currently owned by this exact session ID. */
export function stopCallSoundsForSession(sessionId: string | null | undefined, reason: string): void {
  if (!sessionId) return;
  stopIncomingRingtoneForSession(sessionId, reason);
  stopOutgoingRingbackForSession(sessionId, reason);
}

// Revocation is independent of React state, so a terminal/expiry/identity/
// background notification synchronously silences the exact matching owner.
incomingCallAuthority.subscribe((sessionId, reason) => {
  if (reason !== "verified") stopCallSoundsForSession(sessionId, `incoming_authority_${reason}`);
});

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
      if (sessionId) stopOutgoingRingbackForSession(sessionId, "outgoing_session_not_armed");
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

    if (_ringbackActive && _ringbackSessionId === sessionId) {
      if (el.paused && !_ringbackPlayPending) _playOwnedRingback(sessionId);
      return;
    }
    if (_ringbackActive && _ringbackSessionId && _ringbackSessionId !== sessionId
      && _isSessionArmed(_ringbackSessionId)) {
      console.log("[CALL_AUDIO_GUARD] retained ringback owned by another armed session");
      return;
    }
    if (_ringbackActive) stopOutgoingRingback("replaced_by_new_outgoing_session");

    _ringbackActive = true;
    _ringbackSessionId = sessionId;
    _ringbackAttempt++;
    _ringbackPlayPending = false;
    el.currentTime  = 0;
    el.muted = false;
    _playOwnedRingback(sessionId);
  } catch (e) {
    if (sessionId && _ringbackSessionId === sessionId) stopOutgoingRingbackForSession(sessionId, "outgoing_start_error");
    console.warn("[CALL_RINGTONE] startOutgoingRingback error:", e);
  }
}

function _playOwnedRingback(sessionId: string): void {
  const el = _ensureRingbackEl();
  if (!el || !_ringbackActive || _ringbackSessionId !== sessionId || !_isSessionArmed(sessionId)
    || _ringbackPlayPending || !el.paused) return;
  const attempt = _ringbackAttempt;
  _ringbackPlayPending = true;
  el.muted = false;
  try {
    el.play().then(() => {
      if (_ringbackAttempt !== attempt || _ringbackSessionId !== sessionId || !_ringbackActive) {
        if (!_ringbackActive && _ringbackSessionId === null) {
          el.pause();
          el.currentTime = 0;
        }
        return;
      }
      _ringbackPlayPending = false;
      if (!_isSessionArmed(sessionId)) stopOutgoingRingbackForSession(sessionId, "outgoing_session_disarmed");
    }).catch(() => {
      if (_ringbackAttempt !== attempt || _ringbackSessionId !== sessionId) return;
      _ringbackPlayPending = false;
      if (!_isSessionArmed(sessionId)) stopOutgoingRingbackForSession(sessionId, "outgoing_session_disarmed");
    });
  } catch {
    if (_ringbackAttempt === attempt) _ringbackPlayPending = false;
  }
}

/**
 * Stop the outgoing ringback immediately.
 */
export function stopOutgoingRingback(reason: string): void {
  _ringbackAttempt++;
  _ringbackPlayPending = false;
  _ringbackActive = false;
  _ringbackSessionId = null;
  const el = _ringbackEl;
  if (!el) return;
  el.pause();
  el.currentTime = 0;
  if (reason !== "restart") {
    console.log(`[CALL_RINGTONE] stopped: ${reason}`);
  }
}

export function stopOutgoingRingbackForSession(sessionId: string | null | undefined, reason: string): void {
  if (!sessionId || _ringbackSessionId !== sessionId) return;
  stopOutgoingRingback(reason);
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

export interface CallAudioAuditSnapshot {
  ringtoneActive: boolean;
  ringtonePaused: boolean | null;
  ringbackActive: boolean;
  ringbackPaused: boolean | null;
  registeredVoiceElements: number;
  activeVoiceElements: number;
  voiceElementLabels: string[];
}

/**
 * Read-only state for production call diagnostics. This does not start, stop,
 * route, or otherwise mutate audio.
 */
export function getCallAudioAuditSnapshot(): CallAudioAuditSnapshot {
  return {
    ringtoneActive: _ringtoneActive,
    ringtonePaused: _ringtoneEl?.paused ?? null,
    ringbackActive: _ringbackActive,
    ringbackPaused: _ringbackEl?.paused ?? null,
    registeredVoiceElements: _voiceElements.length,
    activeVoiceElements: _voiceElements.filter(({ el }) => !el.paused && !el.muted).length,
    voiceElementLabels: _voiceElements.map(({ label }) => label),
  };
}

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
    // Incoming grants are invalid while hidden and require a fresh verification
    // on restore. Preserve generic connected/caller state: a pagehide event is
    // not an authoritative call termination.
    incomingCallAuthority.setForeground(false);
    console.log("[CALL_AUDIO_GUARD] pagehide — incoming authority suspended");
  });
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}
