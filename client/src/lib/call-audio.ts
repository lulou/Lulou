/**
 * call-audio.ts — Global registry for all call-related audio resources.
 *
 * Why this exists:
 *   React's useEffect cleanup is async-ish at the OS level.  When the
 *   ringtone's clearAll() calls ctx.suspend(), the Promise hasn't resolved
 *   before useWebRTC's init() calls getUserMedia().  On iOS, getUserMedia()
 *   triggers an AVAudioSession category switch (→ PlayAndRecord) which
 *   RESTARTS any live AudioContext, causing a brief burst of its last
 *   oscillator state to play through the speaker.  The mic is already open
 *   at that moment → 440/480 Hz tones are captured and transmitted to the
 *   remote peer as "ringing noise".
 *
 *   cleanupCallAudio() runs the SYNCHRONOUS part of the stop (gain=0,
 *   osc.stop(), immediately) and is called from use-webrtc.ts BEFORE
 *   getUserMedia(), guaranteeing silence before the mic opens.
 *
 * Usage:
 *   registerRingtoneContext(ctx, activeNodes)  ← called by use-call-ringtone.ts
 *   cleanupCallAudio(reason)                   ← called everywhere a call ends
 */

export interface RingtoneNode {
  osc: OscillatorNode;
  gain: GainNode;
}

interface RingtoneEntry {
  ctx: AudioContext;
  nodes: RingtoneNode[];
  label: string;
}

interface AudioElEntry {
  el: HTMLAudioElement | HTMLVideoElement;
  label: string;
}

// Module-level singletons — survive React re-renders.
const _ringtones: RingtoneEntry[] = [];
const _audioElements: AudioElEntry[] = [];

// ── Registration ──────────────────────────────────────────────────────────────

export function registerRingtoneContext(
  ctx: AudioContext,
  nodes: RingtoneNode[],
  label: string,
) {
  if (_ringtones.find(e => e.ctx === ctx)) return;
  _ringtones.push({ ctx, nodes, label });
  console.log("[CALL_AUDIO] AudioContext registered:", label, "| total:", _ringtones.length);
}

export function unregisterRingtoneContext(ctx: AudioContext) {
  const idx = _ringtones.findIndex(e => e.ctx === ctx);
  if (idx !== -1) {
    const label = _ringtones[idx].label;
    _ringtones.splice(idx, 1);
    console.log("[CALL_AUDIO] AudioContext unregistered:", label, "| remaining:", _ringtones.length);
  }
}

export function registerCallAudioElement(
  el: HTMLAudioElement | HTMLVideoElement,
  label: string,
) {
  if (_audioElements.find(e => e.el === el)) return;
  _audioElements.push({ el, label });
  console.log("[CALL_AUDIO] Audio element registered:", label);
}

export function unregisterCallAudioElement(el: HTMLAudioElement | HTMLVideoElement) {
  const idx = _audioElements.findIndex(e => e.el === el);
  if (idx !== -1) {
    const label = _audioElements[idx].label;
    _audioElements.splice(idx, 1);
    console.log("[CALL_AUDIO] Audio element unregistered:", label);
  }
}

// ── Master cleanup ────────────────────────────────────────────────────────────

/**
 * Synchronously silence all registered ringtone AudioContexts and detach all
 * audio/video elements.  Call this BEFORE getUserMedia() and from every call
 * end path (hangup, decline, cancel, timer, error, page leave).
 *
 * The synchronous part (gain=0, osc.stop) is what matters for mic isolation;
 * ctx.close() is async and runs in the background.
 */
export function cleanupCallAudio(reason: string) {
  const ctxCount = _ringtones.length;
  const elCount = _audioElements.length;

  console.log(
    `[CALL_AUDIO] cleanupCallAudio("${reason}") — ` +
    `${ctxCount} AudioContext(s), ${elCount} audio element(s)`,
  );

  // ── Ringtone AudioContexts ─────────────────────────────────────────────────
  for (const { ctx, nodes, label } of _ringtones) {
    try {
      // SYNCHRONOUS: zero the gain and stop every oscillator right now.
      // This is what prevents the mic from capturing the tone — the
      // async ctx.suspend() alone is too slow.
      for (const { osc, gain } of nodes) {
        try {
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setValueAtTime(0, ctx.currentTime);
          osc.stop(ctx.currentTime);
        } catch {}
      }
      nodes.length = 0;

      // ASYNC: suspend then close (best-effort, runs in background).
      if (ctx.state !== "closed") {
        ctx.suspend()
          .catch(() => {})
          .finally(() => ctx.close().catch(() => {}));
      }
      console.log("[CALL_AUDIO] Ringtone stopped:", label);
    } catch (e) {
      console.warn("[CALL_AUDIO] Ringtone cleanup error:", label, e);
    }
  }
  _ringtones.length = 0;

  // ── HTML Audio / Video elements ────────────────────────────────────────────
  for (const { el, label } of _audioElements) {
    try {
      el.pause();
      el.srcObject = null;
      console.log("[CALL_AUDIO] Audio element detached:", label);
    } catch (e) {
      console.warn("[CALL_AUDIO] Audio element cleanup error:", label, e);
    }
  }
  _audioElements.length = 0;
}

// ── Page-leave safety net ─────────────────────────────────────────────────────
// If the user navigates away or closes the tab while on a call, stop all audio
// so the mic doesn't remain open and so no tones play in the background.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    cleanupCallAudio("pagehide");
  });
  window.addEventListener("beforeunload", () => {
    cleanupCallAudio("beforeunload");
  });
}
