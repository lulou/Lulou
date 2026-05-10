/**
 * call-audio.ts — Global registry for all call-related audio resources.
 *
 * WHY markDead() MUST BE CALLED FIRST IN stopAllCallSounds():
 *
 *   When the IncomingCallOverlay appears without a prior user gesture the
 *   browser keeps the AudioContext suspended (autoplay policy).  ctx.resume()
 *   returns a pending promise.  When the user taps "Answer" that tap is a
 *   user-gesture that ALSO resolves every pending resume() promise on the page.
 *   If we only zero the oscillators but don't set state.dead=true, the
 *   resume callback fires AFTER our cleanup and calls ring() again — creating
 *   fresh, orphaned oscillators that are no longer in _ringtones[] and can
 *   never be stopped.  markDead() sets state.dead=true SYNCHRONOUSLY so the
 *   resume callback sees it and returns immediately.
 *
 * AUDIO SOURCES IN THIS APP (exhaustive list):
 *   1. use-call-ringtone.ts  — Web Audio API oscillators, synthesised ring
 *   2. active-call.tsx        — <audio> element for remote WebRTC stream
 *   3. active-call.tsx        — <video muted> for remote video (audio off)
 *   4. active-call.tsx        — <video muted> for local self-view (audio off)
 *   All of the above are tracked here and silenced by stopAllCallSounds().
 *
 * Usage:
 *   registerRingtoneContext(ctx, nodes, label, markDead)  ← use-call-ringtone.ts
 *   registerCallAudioElement(el, label)                   ← active-call.tsx
 *   stopAllCallSounds(reason)                             ← called everywhere
 */

export interface RingtoneNode {
  osc: OscillatorNode;
  gain: GainNode;
}

interface RingtoneEntry {
  ctx: AudioContext;
  nodes: RingtoneNode[];
  label: string;
  /** Sets state.dead=true AND clears all pending timers inside the hook.
   *  Must be called BEFORE zeroing oscillators so the ctx.resume() callback
   *  cannot restart the ring state-machine after cleanup. */
  markDead: () => void;
}

interface AudioElEntry {
  el: HTMLAudioElement | HTMLVideoElement;
  label: string;
}

const _ringtones: RingtoneEntry[] = [];
const _audioElements: AudioElEntry[] = [];

// ── Audio-context unlock ───────────────────────────────────────────────────────
// Browsers suspend new AudioContexts until a user gesture occurs (autoplay
// policy).  This listener resumes any live ringtone context on the first
// interaction so the ring starts immediately if the user is already in the app
// doing something when the call arrives.
let _audioUnlocked = false;
function _onUserGesture() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  console.log("[CALL_AUDIO] audio context unlocked by user gesture — resuming any suspended ringtone contexts");
  for (const { ctx } of _ringtones) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }
}
if (typeof window !== "undefined") {
  ["click", "touchstart", "keydown"].forEach(ev =>
    window.addEventListener(ev, _onUserGesture, { passive: true })
  );
}

// ── Registration ───────────────────────────────────────────────────────────────

export function registerRingtoneContext(
  ctx: AudioContext,
  nodes: RingtoneNode[],
  label: string,
  markDead: () => void,
) {
  if (_ringtones.find(e => e.ctx === ctx)) return;
  _ringtones.push({ ctx, nodes, label, markDead });
  console.log("[CALL_AUDIO] incoming ringtone start:", label, "| total registered:", _ringtones.length);
  // If the user has already interacted, resume immediately so the ring doesn't
  // wait for the next gesture.
  if (_audioUnlocked && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

export function unregisterRingtoneContext(ctx: AudioContext) {
  const idx = _ringtones.findIndex(e => e.ctx === ctx);
  if (idx !== -1) {
    const label = _ringtones[idx].label;
    _ringtones.splice(idx, 1);
    console.log("[CALL_AUDIO] ringtone context unregistered:", label, "| remaining:", _ringtones.length);
  }
}

export function registerCallAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
) {
  if (_audioElements.find(e => e.el === el)) return;
  _audioElements.push({ el, label });
  console.log("[CALL_AUDIO] remote voice audio attached:", label);
}

export function unregisterCallAudioElement(el: HTMLAudioElement | HTMLVideoElement) {
  const idx = _audioElements.findIndex(e => e.el === el);
  if (idx !== -1) {
    const label = _audioElements[idx].label;
    _audioElements.splice(idx, 1);
    console.log("[CALL_AUDIO] audio element unregistered:", label);
  }
}

// ── Master stop ────────────────────────────────────────────────────────────────

/**
 * THE single function that must be called on every call end path.
 *
 * Order of operations is critical:
 *   1. markDead()  — synchronously kills the ring state-machine (timers + dead flag)
 *                    BEFORE the ctx.resume() promise can resolve and restart it.
 *   2. Zero gain   — silences oscillators that are already running.
 *   3. osc.stop()  — stops oscillators.
 *   4. ctx.suspend → ctx.close() — async cleanup of the audio render thread.
 *   5. Detach HTML audio/video elements — stops remote voice playback.
 */
export function stopAllCallSounds(reason: string) {
  const ctxCount = _ringtones.length;
  const elCount = _audioElements.length;

  console.log(
    `[CALL_AUDIO] stop all call sounds: ${reason} — ` +
    `${ctxCount} ringtone context(s), ${elCount} audio element(s)`,
  );

  // ── Step 1: Kill every ring state-machine FIRST ────────────────────────────
  // markDead() sets state.dead=true and clears all pending setTimeout handles
  // BEFORE the ctx.resume() promise (which may be pending due to autoplay
  // policy) can resolve.  Without this, the resume callback fires after cleanup
  // and calls ring() on an already-cleared context, creating orphaned
  // oscillators that can never be stopped.
  for (const entry of _ringtones) {
    try { entry.markDead(); } catch {}
  }

  // ── Step 2–4: Stop oscillators and close contexts ─────────────────────────
  for (const { ctx, nodes, label } of _ringtones) {
    try {
      for (const { osc, gain } of nodes) {
        try {
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setValueAtTime(0, ctx.currentTime);
          osc.stop(ctx.currentTime);
        } catch {}
      }
      nodes.length = 0;

      if (ctx.state !== "closed") {
        ctx.suspend()
          .catch(() => {})
          .finally(() => ctx.close().catch(() => {}));
      }
      console.log("[CALL_AUDIO] ringtone stopped:", label);
    } catch (e) {
      console.warn("[CALL_AUDIO] ringtone cleanup error:", label, e);
    }
  }
  _ringtones.length = 0;

  // ── Step 5: Detach HTML audio/video elements ───────────────────────────────
  for (const { el, label } of _audioElements) {
    try {
      el.pause();
      el.srcObject = null;
      console.log("[CALL_AUDIO] audio element detached:", label);
    } catch (e) {
      console.warn("[CALL_AUDIO] audio element cleanup error:", label, e);
    }
  }
  _audioElements.length = 0;
}

/** Backward-compat alias — all existing call sites work without changes. */
export const cleanupCallAudio = stopAllCallSounds;

// ── Page-leave safety net ─────────────────────────────────────────────────────
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => stopAllCallSounds("pagehide"));
  window.addEventListener("beforeunload", () => stopAllCallSounds("beforeunload"));
}
