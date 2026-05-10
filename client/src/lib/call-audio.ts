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
 *   SOURCE 2 — <audio ref={remoteAudioRef} playsInline> in active-call.tsx
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
 * ── WHY BACKGROUND NOISE PLAYED DURING CONNECTED CALLS ───────────────────
 *
 *   TWO causes, both now fixed:
 *
 *   CAUSE A — <audio autoPlay> without srcObject:
 *     The <audio ref={remoteAudioRef} autoPlay> element was always rendered
 *     (even before connected) with autoPlay but NO srcObject. On iOS, this
 *     reserves an audio output pipeline immediately. When getUserMedia later
 *     opens the mic (switching AVAudioSession to PlayAndRecord), that idle
 *     pipeline is rerouted — producing a noise burst captured by the mic and
 *     transmitted to the remote peer. Fix: removed autoPlay from the element.
 *     Playback is started explicitly via .play() only after srcObject is set.
 *
 *   CAUSE B — _onUserGesture creating AudioContext during connected call:
 *     The previous guard (hasPendingRing) was the wrong condition. When there
 *     was no pending ring (during a live call), the guard correctly blocked new
 *     context creation — but it also broke the pre-unlock behavior (see below).
 *     Fix: replaced hasPendingRing guard with _micActive flag. When _micActive
 *     is true (mic is open), _onUserGesture is a strict no-op. This prevents
 *     new AudioContexts from joining the iOS AVAudioSession while the mic is live.
 *
 * ── WHY RINGTONE DISAPPEARED ─────────────────────────────────────────────
 *
 *   The hasPendingRing guard broke the pre-unlock behaviour:
 *     Before: _onUserGesture ran on EVERY gesture → AudioContext pre-created
 *             and pre-resumed → by the time a call arrived, context was already
 *             "running" → ring played immediately, synchronously, no race.
 *     After:  _onUserGesture only ran when a pending ring existed → no pre-unlock
 *             → when a call arrived, context was null → iOS could not resume it
 *             without a gesture IN the ring start call stack → ring never played.
 *   Fix: restored the pre-unlock (run on every gesture, create+resume context)
 *   BUT guarded with _micActive so it never fires while the mic is open.
 *
 * ── _micActive FLAG LIFECYCLE ─────────────────────────────────────────────
 *
 *   false  → normal state; _onUserGesture pre-unlocks AudioContext on every tap
 *   true   → set by stopAllNonVoiceCallAudio() (called before getUserMedia and
 *             when WebRTC connects); _onUserGesture is a strict no-op
 *   false  → set by stopAllCallSounds() (call ended, mic closed)
 *
 * ── SHARED CONTEXT LIFECYCLE ─────────────────────────────────────────────
 *
 *   Created  → first user gesture (_onUserGesture when _micActive=false)
 *   Running  → ringtone oscillators play on the shared context
 *   Closed   → stopAllNonVoiceCallAudio() → ctx.close() + _sharedCtx=null
 *   Recreated→ next tap after call ends (_micActive back to false)
 *
 * ── PUBLIC API ────────────────────────────────────────────────────────────
 *
 *   startIncomingRingtone()          — receiver: start ring when overlay mounts
 *   stopIncomingRingtone(reason)     — stop incoming ring, log reason
 *   startOutgoingRingback()          — caller: ringback while waiting for answer
 *   stopOutgoingRingback(reason)     — stop outgoing ringback
 *   stopAllNonVoiceCallAudio(reason) — stop all rings + close shared ctx + set _micActive
 *   registerVoiceAudioElement(el, label) — track remote <audio> element
 *   unregisterVoiceAudioElement(el)      — untrack
 *   stopAllCallSounds(reason)        — stop rings + detach voice elements + clear _micActive
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

/**
 * True while the microphone is open (between stopAllNonVoiceCallAudio and
 * stopAllCallSounds). While true, _onUserGesture is a strict no-op — it must
 * not create or resume an AudioContext that would join the live AVAudioSession.
 */
let _micActive = false;

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
  if (state.dead || !state.ctx || state.ctx.state !== "running") return;
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

function _tryStartRing(state: RingState): void {
  if (state.dead || state.started || !_isCtxRunning()) return;
  state.started = true;
  state.ctx = _sharedCtx!;
  _scheduleRing(state);
}

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
//
// PURPOSE: Pre-unlock the shared AudioContext so it is already "running" by the
// time a call arrives. Without this, the ring would need a gesture IN the same
// call stack as startIncomingRingtone(), which is not guaranteed on iOS.
//
// CRITICAL GUARD — _micActive:
//   When _micActive is true, the microphone is open (getUserMedia has run).
//   Creating or resuming an AudioContext while the mic is open causes iOS to
//   re-negotiate the AVAudioSession (PlayAndRecord), producing a noise burst
//   through the speaker that the open mic captures and transmits to the remote.
//   This fires on EVERY tap (mute, speaker, screen) during the connected call.
//   When _micActive is true this function is a strict no-op — nothing audio-related
//   is touched regardless of any other state.

function _onUserGesture(): void {
  // Mic is open — do not touch the AudioContext under any circumstances.
  if (_micActive) return;

  // Pre-unlock: ensure the shared AudioContext exists and is running so rings
  // can start synchronously when a call arrives (no Promise/race on iOS).
  if (!_sharedCtx || _sharedCtx.state === "closed") {
    if (!_createSharedCtx()) return;
  }
  _resumeSharedCtx();

  // If now running: start any pending rings immediately.
  if (_isCtxRunning()) {
    if (_incomingRing && !_incomingRing.dead && !_incomingRing.started) {
      _tryStartRing(_incomingRing);
    }
    if (_outgoingRing && !_outgoingRing.dead && !_outgoingRing.started) {
      _tryStartRing(_outgoingRing);
    }
    return;
  }

  // Still suspended (async resume, iOS path) — wire statechange listeners.
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

  console.log(`[CALL_AUDIO] incoming ringtone started | ctxState=${_sharedCtx?.state ?? "none"} micActive=${_micActive}`);

  if (_isCtxRunning()) {
    _tryStartRing(_incomingRing);
  } else {
    _resumeSharedCtx();
    _attachCtxStartListener(_incomingRing);
  }
}

/**
 * Stop the incoming ringtone. Kills oscillators synchronously.
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
  console.log(`[CALL_AUDIO] outgoing ringback stopped: ${reason}`);
}

/**
 * Stop ALL non-voice call audio (ringtones) AND close the shared AudioContext.
 * Also sets _micActive = true to block _onUserGesture from creating any new
 * AudioContext while the mic is open.
 *
 * Called:
 *   - Before getUserMedia (use-webrtc.ts via cleanupCallAudio)
 *   - When WebRTC connects (active-call.tsx connectionState effect)
 *   - From stopAllCallSounds (call end)
 */
export function stopAllNonVoiceCallAudio(reason: string): void {
  const hadIncoming = !!_incomingRing;
  const hadOutgoing = !!_outgoingRing;

  if (_incomingRing) {
    _killRingState(_incomingRing);
    _incomingRing = null;
  }
  if (_outgoingRing) {
    _killRingState(_outgoingRing);
    _outgoingRing = null;
  }

  // Close context AFTER killing oscillators so gain=0 takes effect before close.
  _closeSharedCtx();

  // Block _onUserGesture from recreating AudioContext while mic is open.
  _micActive = true;

  console.log(`[CALL_AUDIO] non-voice audio stopped: ${reason} | incoming=${hadIncoming} outgoing=${hadOutgoing} micActive=true`);
  console.log(`[CALL_AUDIO_AUDIT] non-voice sound disabled (reason=${reason})`);
}

// ── Voice audio element registry ───────────────────────────────────────────────

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
      return;
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
 * Clears _micActive so _onUserGesture pre-unlocks again on the next tap.
 * Call on call end, unmount, and page leave.
 */
export function stopAllCallSounds(reason: string): void {
  stopAllNonVoiceCallAudio(reason);

  for (const { el } of _voiceElements) {
    try { el.pause(); } catch {}
    try { el.srcObject = null; } catch {}
  }
  _voiceElements.length = 0;

  // Mic is now closed — allow _onUserGesture to pre-unlock AudioContext again.
  _micActive = false;

  console.log(`[CALL_AUDIO] all call audio stopped: ${reason} | micActive=false`);
}

// ── Backward-compat aliases — existing callers unchanged ──────────────────────

export const cleanupCallAudio = stopAllCallSounds;
export const registerCallAudioElement = registerVoiceAudioElement;
export const unregisterCallAudioElement = unregisterVoiceAudioElement;

export type RingtoneNode = { osc: OscillatorNode; gain: GainNode };
