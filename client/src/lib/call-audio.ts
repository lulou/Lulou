/**
 * call-audio.ts — Central call audio manager.
 *
 * THREE PUBLIC AUDIO CONTROL FUNCTIONS:
 *   startIncomingRingtone()           — receiver hears ring while overlay shows
 *   stopIncomingRingtone(reason)      — stop only the incoming ring
 *   stopAllNonVoiceCallAudio(reason)  — stop all rings (incoming + outgoing)
 *
 * VOICE AUDIO ELEMENT TRACKING:
 *   registerVoiceAudioElement(el, label)   — track remote voice <audio>
 *   unregisterVoiceAudioElement(el)        — untrack
 *   stopAllCallSounds(reason)              — stops rings AND detaches voice elements
 *
 * BACKWARD-COMPAT ALIASES (no callers need to change):
 *   cleanupCallAudio = stopAllCallSounds
 *   registerCallAudioElement = registerVoiceAudioElement
 *   unregisterCallAudioElement = unregisterVoiceAudioElement
 *
 * ── WHY statechange INSTEAD OF ctx.resume().then() ──────────────────────────
 *
 *   The old code used:
 *     ctx.resume()
 *       .then(() => { if (!state.dead) ring(); })
 *       .catch(() => { if (!state.dead) ring(); });   ← BUG: ring on failed resume
 *
 *   TWO bugs:
 *   1. On iOS Safari, ctx.resume() stays pending until a user gesture. When the
 *      user taps Answer, stopAllCallSounds() sets state.dead=true synchronously,
 *      then the gesture resolves the pending promise as a microtask. The .then()
 *      correctly sees state.dead=true. BUT — the .catch() fires if the context
 *      failed to resume (e.g. on a browser that rejects non-gesture resumes),
 *      and that callback ALSO calls ring(). If state.dead wasn't set (because
 *      stopAllCallSounds was never called — e.g. the ring was just not starting),
 *      oscillators are created on a suspended context. When anything later
 *      causes the context to run, those scheduled oscillators emit.
 *   2. On Chrome, ctx.resume() resolves immediately for already-unlocked pages.
 *      But the .then() callback fires as a microtask AFTER the current sync
 *      task (the click handler). This means state.dead=true IS set before ring()
 *      is called. This is correct. But the outgoing ringback on the CALLER's
 *      side has a different problem: when callAnswered arrives, isRinging
 *      becomes false and webrtcEnabled becomes true simultaneously. The outgoing
 *      ring's clearAll() runs in the React cleanup pass, but getUserMedia opens
 *      the mic in the new effect. If ANY oscillator is still emitting (because
 *      osc.stop() hasn't taken effect yet — it schedules at ctx.currentTime but
 *      the audio thread processes it with a small buffer lag), the mic captures
 *      that tone and transmits it to the receiver.
 *
 *   FIX: Use ctx.addEventListener("statechange", tryStart) INSTEAD.
 *   - tryStart checks state.dead synchronously on every statechange event.
 *   - state.dead is set by _killState() which is called FIRST in all stop paths.
 *   - No .catch() path that calls ring() on a potentially-resumable context.
 *   - _onUserGesture runs on EVERY gesture (not just first) so a user tapping
 *     anywhere on the overlay will resume the context and start the ring.
 *
 * ── WHY stopAllNonVoiceCallAudio KILLS STATE MACHINE BEFORE STOPPING OSCILLATORS
 *
 *   _killState() sets state.dead=true and clears all pending timers BEFORE we
 *   stop the oscillators. This ensures that even if a statechange event is
 *   already queued (e.g., ctx just transitioned to "running"), the tryStart
 *   callback sees dead=true and returns without calling ring(). Order matters.
 *
 * ── EXHAUSTIVE AUDIO SOURCE LIST ─────────────────────────────────────────────
 *   1. call-audio.ts _incomingState / _outgoingState — Web Audio API oscillators
 *   2. active-call.tsx <audio ref={remoteAudioRef}> — remote WebRTC voice (UNMUTED)
 *   3. active-call.tsx <video ref={remoteVideoRef} muted> — remote video (MUTED)
 *   4. active-call.tsx <video ref={localVideoRef} muted> — local self-view (MUTED)
 *   No new Audio(), no audio files, no other sound sources exist in the call system.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Internal per-tone state machine. */
interface RingState {
  ctx: AudioContext;
  type: "incoming" | "outgoing";
  dead: boolean;
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
  activeNodes: Array<{ osc: OscillatorNode; gain: GainNode }>;
}

interface VoiceElEntry {
  el: HTMLAudioElement | HTMLVideoElement;
  label: string;
}

// ── Module state ──────────────────────────────────────────────────────────────

let _incomingState: RingState | null = null;
let _outgoingState: RingState | null = null;
const _voiceElements: VoiceElEntry[] = [];
let _audioUnlocked = false;

// ── Audio context unlock ───────────────────────────────────────────────────────
// Runs on every user gesture. Resumes any suspended ringtone context so the
// ring starts the moment the user interacts with the page — not just on the
// very first gesture (old one-shot approach missed subsequent calls).

function _resumeAllSuspended() {
  if (_incomingState && _incomingState.ctx.state === "suspended") {
    _incomingState.ctx.resume().catch(() => {});
  }
  if (_outgoingState && _outgoingState.ctx.state === "suspended") {
    _outgoingState.ctx.resume().catch(() => {});
  }
}

function _onUserGesture() {
  if (!_audioUnlocked) {
    _audioUnlocked = true;
    console.log("[CALL_AUDIO] audio context unlocked by user gesture");
  }
  _resumeAllSuspended();
}

if (typeof window !== "undefined") {
  // passive: true — listener runs every gesture, not just first
  ["click", "touchstart", "keydown"].forEach(ev =>
    window.addEventListener(ev, _onUserGesture, { passive: true })
  );
  window.addEventListener("pagehide", () => stopAllCallSounds("pagehide"));
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}

// ── Ring state machine internal helpers ───────────────────────────────────────

/**
 * Kill the state machine synchronously.
 * MUST be called BEFORE stopping oscillators so that any pending statechange
 * event (ctx just became "running") sees dead=true and does not restart the ring.
 */
function _killState(state: RingState) {
  if (state.dead) return;
  state.dead = true;
  state.timers.forEach(clearTimeout);
  state.timers.length = 0;
}

function _stopRingState(state: RingState) {
  _killState(state); // must be first
  for (const { osc, gain } of state.activeNodes) {
    try {
      gain.gain.cancelScheduledValues(state.ctx.currentTime);
      gain.gain.setValueAtTime(0, state.ctx.currentTime);
      osc.stop(state.ctx.currentTime);
    } catch {}
  }
  state.activeNodes.length = 0;
  const ctx = state.ctx;
  if (ctx.state !== "closed") {
    ctx.suspend().catch(() => {}).finally(() => ctx.close().catch(() => {}));
  }
}

function _playBurst(state: RingState, durationMs: number) {
  if (state.dead) return;
  const ctx = state.ctx;
  const now = ctx.currentTime;
  const dur = durationMs / 1000;
  const fade = 0.025;

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
    const node = { osc, gain };
    state.activeNodes.push(node);
    osc.onended = () => {
      const idx = state.activeNodes.indexOf(node);
      if (idx !== -1) state.activeNodes.splice(idx, 1);
    };
  }
}

function _scheduleRing(state: RingState) {
  if (state.dead) return;
  const addTimer = (fn: () => void, ms: number) => {
    if (state.dead) return;
    const id = setTimeout(fn, ms);
    state.timers.push(id);
  };
  if (state.type === "incoming") {
    // Pattern: 400ms ring · 150ms gap · 400ms ring · 2000ms silence
    _playBurst(state, 400);
    addTimer(() => {
      if (state.dead) return;
      _playBurst(state, 400);
      addTimer(() => { if (!state.dead) _scheduleRing(state); }, 400 + 2000);
    }, 400 + 150);
  } else {
    // US ringback: 2 s ring · 4 s silence
    _playBurst(state, 2000);
    addTimer(() => { if (!state.dead) _scheduleRing(state); }, 2000 + 4000);
  }
}

/**
 * Create and wire a ring state machine.
 * Uses ctx.addEventListener("statechange") instead of ctx.resume().then() to
 * avoid calling ring() from a Promise callback that might fire after cleanup.
 */
function _createRingState(type: "incoming" | "outgoing"): RingState | null {
  let ctx: AudioContext;
  try { ctx = new AudioContext(); } catch { return null; }

  const state: RingState = {
    ctx,
    type,
    dead: false,
    started: false,
    timers: [],
    activeNodes: [],
  };

  // tryStart: called when context transitions to "running".
  // Checks dead+started guards so it fires ring() exactly once.
  const tryStart = () => {
    // Always remove the listener — we either start once or bail permanently.
    ctx.removeEventListener("statechange", tryStart as EventListener);
    if (state.dead || state.started) return;
    if (ctx.state !== "running") {
      // Context transitioned to something other than "running" (e.g. "closed").
      // Re-attach if it might still become running:
      if (ctx.state === "suspended") {
        ctx.addEventListener("statechange", tryStart as EventListener);
      }
      return;
    }
    state.started = true;
    _scheduleRing(state);
  };

  ctx.addEventListener("statechange", tryStart as EventListener);

  // Try to resume immediately. The promise result is intentionally ignored —
  // ring() is triggered only via the statechange event, never from .then()/.catch().
  ctx.resume().catch(() => {});

  // If already running (rare — new contexts almost always start suspended):
  if (ctx.state === "running") {
    tryStart();
  }

  // If audio policy is already unlocked, force another resume attempt.
  if (_audioUnlocked && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  return state;
}

// ── Public ring API ───────────────────────────────────────────────────────────

/** Start the incoming ringtone. Call from IncomingCallOverlay on mount. */
export function startIncomingRingtone() {
  // Stop any lingering instance first (defensive — shouldn't be one).
  if (_incomingState && !_incomingState.dead) {
    _stopRingState(_incomingState);
  }
  _incomingState = _createRingState("incoming");
  console.log(`[CALL_AUDIO] incoming ringtone start | ctxState=${_incomingState?.ctx.state}`);
}

/** Stop only the incoming ringtone. */
export function stopIncomingRingtone(reason: string) {
  if (!_incomingState) return;
  console.log(`[CALL_AUDIO] incoming ringtone stop: ${reason}`);
  _stopRingState(_incomingState);
  _incomingState = null;
}

/** Start the outgoing ringback tone (caller waiting for answer). */
export function startOutgoingRingback() {
  if (_outgoingState && !_outgoingState.dead) return;
  if (_outgoingState) { _stopRingState(_outgoingState); }
  _outgoingState = _createRingState("outgoing");
}

/** Stop the outgoing ringback tone. */
export function stopOutgoingRingback(reason: string) {
  if (!_outgoingState) return;
  _stopRingState(_outgoingState);
  _outgoingState = null;
}

/**
 * Stop all ringtones (incoming + outgoing) but NOT the remote voice element.
 * Call before getUserMedia so no oscillator tones can be captured by the mic.
 */
export function stopAllNonVoiceCallAudio(reason: string) {
  const hasIncoming = !!_incomingState;
  const hasOutgoing = !!_outgoingState;
  console.log(`[CALL_AUDIO] stop all non-voice audio: ${reason} | incoming=${hasIncoming} outgoing=${hasOutgoing}`);
  if (_incomingState) {
    _stopRingState(_incomingState);
    _incomingState = null;
    console.log(`[CALL_AUDIO] incoming ringtone stop: ${reason}`);
  }
  if (_outgoingState) {
    _stopRingState(_outgoingState);
    _outgoingState = null;
  }
}

// ── Voice audio element tracking ──────────────────────────────────────────────

/**
 * Register the remote voice <audio> or muted <video> element so it is detached
 * when stopAllCallSounds() is called at call end.
 */
export function registerVoiceAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
) {
  // Detect and remove any duplicate by label (different element, same logical slot).
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
  console.log(`[CALL_AUDIO] remote voice attached: ${label}`);
}

export function unregisterVoiceAudioElement(el: HTMLAudioElement | HTMLVideoElement) {
  const idx = _voiceElements.findIndex(e => e.el === el);
  if (idx !== -1) _voiceElements.splice(idx, 1);
}

/**
 * Stop ALL call audio: ringtones + remote voice elements.
 * Call on call end (finishCall, unmount, page leave).
 */
export function stopAllCallSounds(reason: string) {
  console.log(`[CALL_AUDIO] stop all call sounds: ${reason}`);
  stopAllNonVoiceCallAudio(reason);
  for (const { el, label } of _voiceElements) {
    try {
      el.pause();
      el.srcObject = null;
    } catch {}
  }
  _voiceElements.length = 0;
}

// ── Backward-compat aliases ───────────────────────────────────────────────────
// All existing call sites (active-call, incoming-call, use-webrtc) work unchanged.

export const cleanupCallAudio = stopAllCallSounds;
export const registerCallAudioElement = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

// Legacy type — still exported so any old imports don't break.
export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };
