/**
 * call-audio.ts — Single call audio controller.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * [CALL_AUDIO_AUDIT] EVERY sound source in the call system:
 *
 *   SOURCE 1 — Web Audio API oscillators (440 + 480 Hz sine waves)
 *              Incoming ringtone & outgoing ringback.
 *              Managed ENTIRELY in this file. No oscillator code anywhere else.
 *
 *   SOURCE 2 — <audio ref={remoteAudioRef} autoPlay playsInline> in active-call.tsx
 *              Remote WebRTC voice stream. UNMUTED. Set via srcObject = remoteStream.
 *              Only attached after isConnected = true. This is the ONLY unmuted
 *              audio element during a connected call.
 *
 *   SOURCE 3 — <video ref={remoteVideoRef} autoPlay playsInline muted> in active-call.tsx
 *              Remote WebRTC video. MUTED. Audio handled exclusively by SOURCE 2.
 *
 *   SOURCE 4 — <video ref={localVideoRef} autoPlay playsInline muted> in active-call.tsx
 *              Local camera self-view. MUTED. Mic audio is NEVER played back locally.
 *
 *   No new Audio(), no audio files, no notification sounds exist anywhere.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY INCOMING RINGTONE WAS NOT PLAYING ────────────────────────────────────
 *
 *   Previous code:
 *     const ctx = new AudioContext();       // ← always starts SUSPENDED
 *     ctx.resume()
 *       .then(() => { if (!state.dead) ring(); })  // ← only fires on gesture
 *       .catch(() => { if (!state.dead) ring(); }) // ← BUG: ring on failed resume
 *
 *   Three failure modes:
 *   (A) Context starts suspended. resume() promise is pending.
 *       Overlay mounts inside a useEffect (NOT a gesture handler).
 *       On iOS, the promise NEVER resolves without a user gesture in the
 *       same call stack. The ring never plays.
 *   (B) User taps Answer (first gesture). React's onClick fires first (React
 *       attaches events to the root container, window listeners come later in
 *       the bubble chain). onClick calls silenceRing() → stopAllCallSounds()
 *       → state.dead = true → _incomingState = null. THEN window _onUserGesture
 *       fires — but the ring was already killed. THEN resume() resolves as a
 *       microtask → .then sees state.dead=true → returns. Ring never plays.
 *   (C) The .catch() path called ring() on a SUSPENDED context. Oscillators
 *       were created and scheduled, but the context was still suspended, so they
 *       emitted nothing. When anything later caused the context to run (even the
 *       iOS AVAudioSession restart from getUserMedia), those scheduled oscillators
 *       began emitting — producing the "background noise during connected call".
 *
 *   Fix: shared persistent AudioContext created + resumed on the FIRST user gesture
 *   anywhere in the app (login tap, navigation, anything). By the time a call
 *   arrives, the context is ALREADY "running". ring() is called synchronously in
 *   startIncomingRingtone() — no Promise, no .then(), no timing race.
 *
 * ── WHY CONNECTED-CALL BACKGROUND NOISE PLAYED ───────────────────────────────
 *
 *   On iOS, getUserMedia({audio:true}) switches AVAudioSession to PlayAndRecord.
 *   This RESTARTS any live AudioContext — even one whose oscillators were stopped —
 *   causing it to briefly re-emit its internal sample buffer through the speaker.
 *   The mic (now open) captures those oscillator tones and transmits them to the
 *   remote peer. The caller hears ringing/beeping during the connected call.
 *
 *   Fix: stopAllNonVoiceCallAudio() (called by use-webrtc.ts before getUserMedia)
 *   now calls ctx.close() — not just ctx.suspend(). A CLOSED context cannot be
 *   restarted by iOS. The 80 ms pause in use-webrtc.ts ensures the close completes
 *   before getUserMedia switches the audio session.
 *
 * ── SHARED CONTEXT LIFECYCLE ──────────────────────────────────────────────────
 *
 *   Created  → first user gesture (_onUserGesture) → new AudioContext() + resume()
 *   Running  → ringtone oscillators play on the shared context
 *   Closed   → stopAllNonVoiceCallAudio() / stopAllCallSounds() → ctx.close() + null
 *   Recreated→ next user gesture (End Call tap, navigate, etc.) → _onUserGesture
 *
 *   This ensures _sharedCtx is null when getUserMedia is called — no context to restart.
 *
 * ── PUBLIC API ────────────────────────────────────────────────────────────────
 *
 *   startIncomingRingtone()          — receiver: start ring when overlay mounts
 *   stopIncomingRingtone(reason)     — stop incoming ring, log reason
 *   startOutgoingRingback()          — caller: ringback while waiting for answer
 *   stopOutgoingRingback(reason)     — stop outgoing ringback
 *   stopAllNonVoiceCallAudio(reason) — stop all rings + close shared ctx
 *   registerVoiceAudioElement(el, label) — track remote <audio> element
 *   unregisterVoiceAudioElement(el)      — untrack
 *   stopAllCallSounds(reason)        — stop rings + detach voice elements
 *
 *   Backward-compat aliases (all existing callers work unchanged):
 *     cleanupCallAudio          = stopAllCallSounds
 *     registerCallAudioElement  = registerVoiceAudioElement
 *     unregisterCallAudioElement= unregisterVoiceAudioElement
 */

// ── Internal types ─────────────────────────────────────────────────────────────

type OscNode = { osc: OscillatorNode; gain: GainNode };

interface RingState {
  type: "incoming" | "outgoing";
  /** AudioContext snapshot captured when the ring actually starts (ctx is running). */
  ctx: AudioContext | null;
  dead: boolean;
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
  activeNodes: OscNode[];
}

interface VoiceElEntry {
  el: HTMLAudioElement | HTMLVideoElement;
  label: string;
}

// ── Module state ───────────────────────────────────────────────────────────────

/**
 * Single shared AudioContext. Created on first user gesture, closed before
 * getUserMedia so iOS cannot restart it during AVAudioSession category switch.
 */
let _sharedCtx: AudioContext | null = null;

let _incomingRing: RingState | null = null;
let _outgoingRing: RingState | null = null;
const _voiceElements: VoiceElEntry[] = [];

// ── Shared context helpers ─────────────────────────────────────────────────────

function _createSharedCtx(): boolean {
  try {
    _sharedCtx = new AudioContext();
    return true;
  } catch {
    return false;
  }
}

function _resumeSharedCtx(): void {
  if (_sharedCtx && _sharedCtx.state === "suspended") {
    _sharedCtx.resume().catch(() => {});
  }
}

function _isCtxRunning(): boolean {
  return !!_sharedCtx && _sharedCtx.state === "running";
}

function _closeSharedCtx(): void {
  if (_sharedCtx && _sharedCtx.state !== "closed") {
    _sharedCtx.close().catch(() => {});
  }
  _sharedCtx = null;
}

// ── Oscillator / ring-pattern helpers ──────────────────────────────────────────

function _playBurst(state: RingState, durationMs: number): void {
  // Guard: context must be the captured running context, not null/closed.
  if (state.dead || !state.ctx || state.ctx.state !== "running") return;
  const ctx = state.ctx;
  const now = ctx.currentTime;
  const dur = durationMs / 1000;
  const fade = 0.025; // 25 ms fade-in / fade-out to avoid clicks

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.18, now + fade);
  gain.gain.setValueAtTime(0.18, now + dur - fade);
  gain.gain.linearRampToValueAtTime(0, now + dur);
  gain.connect(ctx.destination);

  for (const freq of [440, 480]) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + dur);
    const node: OscNode = { osc, gain };
    state.activeNodes.push(node);
    osc.onended = () => {
      const i = state.activeNodes.indexOf(node);
      if (i !== -1) state.activeNodes.splice(i, 1);
    };
  }
}

function _scheduleRing(state: RingState): void {
  if (state.dead) return;
  const after = (fn: () => void, ms: number): void => {
    if (state.dead) return;
    const id = setTimeout(fn, ms);
    state.timers.push(id);
  };

  if (state.type === "incoming") {
    // Double-ring pattern: 400ms · 150ms gap · 400ms · 2000ms silence · repeat
    _playBurst(state, 400);
    after(() => {
      if (state.dead) return;
      _playBurst(state, 400);
      after(() => { if (!state.dead) _scheduleRing(state); }, 400 + 2000);
    }, 400 + 150);
  } else {
    // US ringback: 2 s ring · 4 s silence · repeat
    _playBurst(state, 2000);
    after(() => { if (!state.dead) _scheduleRing(state); }, 2000 + 4000);
  }
}

/**
 * Synchronously kill a ring state machine.
 * MUST be called before ctx.close() — zeroes gain nodes and cancels timers so
 * no oscillator sound escapes when the context is torn down.
 */
function _killRingState(state: RingState): void {
  if (state.dead) return;
  state.dead = true;
  state.timers.forEach(clearTimeout);
  state.timers.length = 0;
  for (const { osc, gain } of state.activeNodes) {
    try {
      const t = state.ctx?.currentTime ?? 0;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(0, t);
      osc.stop(t);
    } catch {}
  }
  state.activeNodes.length = 0;
}

/**
 * Attempt to start a pending ring now that the shared context is confirmed running.
 * No-op if already started or dead.
 */
function _tryStartRing(state: RingState): void {
  if (state.dead || state.started || !_isCtxRunning()) return;
  state.started = true;
  state.ctx = _sharedCtx!; // capture running context reference
  _scheduleRing(state);
}

/**
 * Wire a statechange listener so a pending ring starts the instant the
 * shared context transitions to "running" (async resume, iOS gesture path).
 * Detaches itself after first fire.
 */
function _attachCtxStartListener(state: RingState): void {
  if (!_sharedCtx || _sharedCtx.state !== "suspended") return;
  const ctx = _sharedCtx;
  const onStateChange = () => {
    ctx.removeEventListener("statechange", onStateChange as EventListener);
    if (ctx.state === "running" && !state.dead) {
      _tryStartRing(state);
    }
  };
  ctx.addEventListener("statechange", onStateChange as EventListener);
}

// ── Gesture unlock ─────────────────────────────────────────────────────────────
//
// Runs on every user gesture (click, touchstart, keydown).
// Creates + resumes _sharedCtx so ringtones can play without needing a
// dedicated gesture in the same call stack. By the time a call arrives,
// the context is already "running".
//
// Also starts any ring state machine that was created but waiting for the
// context to become ready (covers: first-session call, post-call-end scenario).

function _onUserGesture(): void {
  // Create context if it doesn't exist or was closed
  if (!_sharedCtx || _sharedCtx.state === "closed") {
    if (!_createSharedCtx()) return;
    console.log("[CALL_AUDIO] shared AudioContext created on user gesture");
  }

  // Resume if suspended (this call stack IS a gesture, so iOS will allow it)
  _resumeSharedCtx();

  // If now running: start any pending rings immediately
  if (_isCtxRunning()) {
    if (_incomingRing && !_incomingRing.dead && !_incomingRing.started) {
      _tryStartRing(_incomingRing);
    }
    if (_outgoingRing && !_outgoingRing.dead && !_outgoingRing.started) {
      _tryStartRing(_outgoingRing);
    }
    return;
  }

  // Still suspended — attach statechange listener for async resume (iOS path)
  if (_incomingRing && !_incomingRing.dead && !_incomingRing.started) {
    _attachCtxStartListener(_incomingRing);
  }
  if (_outgoingRing && !_outgoingRing.dead && !_outgoingRing.started) {
    _attachCtxStartListener(_outgoingRing);
  }
}

if (typeof window !== "undefined") {
  ["click", "touchstart", "keydown"].forEach(ev =>
    window.addEventListener(ev, _onUserGesture, { passive: true })
  );
  window.addEventListener("pagehide", () => stopAllCallSounds("pagehide"));
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}

// ── Public ring API ────────────────────────────────────────────────────────────

/**
 * Start the incoming ringtone. Called by IncomingCallOverlay on mount via
 * useCallRingtone("incoming", true).
 *
 * If _sharedCtx is already running (user tapped something before the call):
 *   → ring starts immediately, synchronously, no Promise involved.
 * If _sharedCtx is suspended or null:
 *   → ring will start the instant the user touches anything on the overlay
 *     (window gesture listener calls _onUserGesture → _tryStartRing).
 */
export function startIncomingRingtone(): void {
  if (_incomingRing) { _killRingState(_incomingRing); _incomingRing = null; }

  // Ensure context exists (may be null after previous call ended)
  if (!_sharedCtx || _sharedCtx.state === "closed") _createSharedCtx();

  _incomingRing = {
    type: "incoming",
    ctx: null,
    dead: false,
    started: false,
    timers: [],
    activeNodes: [],
  };

  console.log(`[CALL_AUDIO] incoming ringtone started | ctxState=${_sharedCtx?.state ?? "none"}`);

  if (_isCtxRunning()) {
    _tryStartRing(_incomingRing);
  } else {
    // Try to resume — succeeds on Chrome after prior interaction
    _resumeSharedCtx();
    // Wire statechange for async resume (iOS)
    _attachCtxStartListener(_incomingRing);
  }
}

/**
 * Stop the incoming ringtone. Kills oscillators synchronously.
 * Called by silenceRing() in incoming-call.tsx (synchronous, before any state update)
 * and by the useCallRingtone effect cleanup.
 */
export function stopIncomingRingtone(reason: string): void {
  if (!_incomingRing) return;
  _killRingState(_incomingRing);
  _incomingRing = null;
  console.log(`[CALL_AUDIO] incoming ringtone stopped: ${reason}`);
}

/**
 * Start outgoing ringback tone (caller side, waiting for receiver to answer).
 */
export function startOutgoingRingback(): void {
  if (_outgoingRing) { _killRingState(_outgoingRing); _outgoingRing = null; }
  if (!_sharedCtx || _sharedCtx.state === "closed") _createSharedCtx();

  _outgoingRing = {
    type: "outgoing",
    ctx: null,
    dead: false,
    started: false,
    timers: [],
    activeNodes: [],
  };

  if (_isCtxRunning()) {
    _tryStartRing(_outgoingRing);
  } else {
    _resumeSharedCtx();
    _attachCtxStartListener(_outgoingRing);
  }
}

/**
 * Stop the outgoing ringback tone.
 */
export function stopOutgoingRingback(reason: string): void {
  if (!_outgoingRing) return;
  _killRingState(_outgoingRing);
  _outgoingRing = null;
}

/**
 * Stop ALL non-voice call audio (ringtones) AND close the shared AudioContext.
 *
 * Closing — not just suspending — is critical on iOS:
 *   getUserMedia({audio:true}) switches AVAudioSession to PlayAndRecord.
 *   This restarts any live AudioContext, briefly re-emitting its sample buffer
 *   through the speaker. The open mic captures those tones and transmits them
 *   to the remote peer as audible beeping/ringing during the connected call.
 *   A CLOSED context cannot be restarted. The 80 ms pause after this call in
 *   use-webrtc.ts ensures the close completes before getUserMedia is called.
 *
 * Called by:
 *   - use-webrtc.ts: cleanupCallAudio("webrtc_init_before_getUserMedia")
 *   - incoming-call.tsx: silenceRing() → cleanupCallAudio("incoming_ring_silenced")
 *   - active-call.tsx: finishCall() → cleanupCallAudio("finish_call_*")
 */
export function stopAllNonVoiceCallAudio(reason: string): void {
  const hadIncoming = !!_incomingRing;
  const hadOutgoing = !!_outgoingRing;
  console.log(`[CALL_AUDIO] non-voice audio stopped: ${reason} | incoming=${hadIncoming} outgoing=${hadOutgoing}`);

  if (_incomingRing) {
    _killRingState(_incomingRing);
    _incomingRing = null;
    console.log(`[CALL_AUDIO] incoming ringtone stopped: ${reason}`);
  }
  if (_outgoingRing) {
    _killRingState(_outgoingRing);
    _outgoingRing = null;
  }

  // Close context AFTER killing oscillators so gain=0 takes effect before close
  _closeSharedCtx();
}

// ── Voice audio element registry ───────────────────────────────────────────────

/**
 * Register the remote voice <audio> (or muted <video>) element so
 * stopAllCallSounds() can detach it when the call ends.
 */
export function registerVoiceAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
): void {
  const dupIdx = _voiceElements.findIndex(e => e.label === label);
  if (dupIdx !== -1) {
    if (_voiceElements[dupIdx].el !== el) {
      console.log(`[CALL_AUDIO] removed duplicate audio element: ${label}`);
      _voiceElements.splice(dupIdx, 1);
    } else {
      return; // same element already registered — no-op
    }
  }
  _voiceElements.push({ el, label });
  console.log(`[CALL_AUDIO] remote voice only mode active: ${label} attached`);
}

export function unregisterVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement): void {
  const idx = _voiceElements.findIndex(e => e.el === el);
  if (idx !== -1) _voiceElements.splice(idx, 1);
}

/**
 * Stop ALL call audio: ringtones + voice elements.
 * Call on call end, unmount, and page leave.
 */
export function stopAllCallSounds(reason: string): void {
  stopAllNonVoiceCallAudio(reason);
  for (const { el } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
  }
  _voiceElements.length = 0;
}

// ── Backward-compat aliases — existing callers unchanged ──────────────────────

export const cleanupCallAudio = stopAllCallSounds;
export const registerCallAudioElement = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

// Legacy type export — keeps any old imports compiling
export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };
