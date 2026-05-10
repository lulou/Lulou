import { useEffect, useRef } from "react";
import {
  registerRingtoneContext,
  unregisterRingtoneContext,
  type RingtoneNode,
} from "@/lib/call-audio";

export type RingtoneType = "incoming" | "outgoing";

/**
 * Synthesises a phone ringtone using the Web Audio API.
 *
 * incoming  – double-ring pattern (400ms burst · 150ms gap · 400ms burst · 2 s silence)
 * outgoing  – US ringback pattern  (2 s ring · 4 s silence)
 *
 * The tone starts when `enabled` becomes true and stops the moment it becomes
 * false (or when the component unmounts).  Stale schedules are cancelled on
 * every cleanup so there is never a ghost ring.
 *
 * Every AudioContext created here is registered with call-audio.ts so that
 * stopAllCallSounds() can stop it synchronously from any call end path BEFORE
 * getUserMedia() opens the mic — preventing the OS audio-session restart
 * (iOS AVAudioSession) from re-emitting the oscillator burst into the mic.
 *
 * CRITICAL — markDead callback:
 *   stopAllCallSounds() calls markDead() BEFORE zeroing oscillators.  This sets
 *   state.dead=true AND clears all pending timers so the ctx.resume() promise
 *   (which may be pending due to autoplay policy and can resolve the moment the
 *   user taps anything) cannot re-enter ring() after cleanup.
 */
export function useCallRingtone(type: RingtoneType, enabled: boolean) {
  const stateRef = useRef<{
    ctx: AudioContext;
    timers: ReturnType<typeof setTimeout>[];
    activeNodes: RingtoneNode[];
    dead: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }

    console.log("[CALL_RINGTONE] START type=", type, "| contextState=", ctx.state);

    const state = {
      ctx,
      timers: [] as ReturnType<typeof setTimeout>[],
      activeNodes: [] as RingtoneNode[],
      dead: false,
    };
    stateRef.current = state;

    // markDead: called by stopAllCallSounds() BEFORE it zeros oscillators.
    // Must set state.dead=true AND clear all pending timers so the ctx.resume()
    // callback cannot call ring() after cleanup completes.
    const markDead = () => {
      if (state.dead) return;
      state.dead = true;
      state.timers.forEach(clearTimeout);
      state.timers.length = 0;
      console.log("[CALL_RINGTONE] markDead() called — ring state-machine halted", { type });
    };

    // Register with the global call-audio registry so stopAllCallSounds()
    // can reach this context, its oscillators, and the markDead callback.
    registerRingtoneContext(ctx, state.activeNodes, `ringtone:${type}`, markDead);

    const addTimer = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      state.timers.push(id);
      return id;
    };

    const clearAll = () => {
      // Mark dead first so ctx.resume() callback cannot restart the ring.
      markDead();

      // Unregister FIRST so stopAllCallSounds() won't double-stop these nodes.
      unregisterRingtoneContext(ctx);

      // SYNCHRONOUS: zero gain and stop every oscillator right now.
      for (const { osc, gain } of state.activeNodes) {
        try {
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setValueAtTime(0, ctx.currentTime);
          osc.stop(ctx.currentTime);
        } catch {}
      }
      state.activeNodes.length = 0;

      // ASYNC: suspend → close (best-effort, background).
      ctx.suspend()
        .catch(() => {})
        .finally(() => ctx.close().catch(() => {}));

      stateRef.current = null;
      console.log("[CALL_RINGTONE] STOP type=", type);
    };

    /**
     * Play a single burst of two blended sine waves (440 Hz + 480 Hz).
     * Smooth 25 ms fade-in / fade-out prevents clicking artefacts.
     * Live nodes are tracked so clearAll() can stop them immediately.
     */
    const playBurst = (durationMs: number) => {
      if (state.dead) return;
      const { ctx } = state;
      const now = ctx.currentTime;
      const dur = durationMs / 1000;
      const fade = 0.025;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + fade);
      gain.gain.setValueAtTime(0.2, now + dur - fade);
      gain.gain.linearRampToValueAtTime(0, now + dur);
      gain.connect(ctx.destination);

      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + dur);
        state.activeNodes.push({ osc, gain });
        osc.onended = () => {
          const idx = state.activeNodes.findIndex(n => n.osc === osc);
          if (idx !== -1) state.activeNodes.splice(idx, 1);
        };
      }
    };

    const ring = () => {
      if (state.dead) return;

      if (type === "incoming") {
        playBurst(400);
        addTimer(() => {
          playBurst(400);
          addTimer(ring, 400 + 2000);
        }, 400 + 150);
      } else {
        playBurst(2000);
        addTimer(ring, 2000 + 4000);
      }
    };

    // Resume the context (may be suspended due to autoplay policy).
    // If the user has already interacted, this resolves immediately.
    // If not, call-audio.ts will resume it on the next user gesture via
    // the global _onUserGesture listener — before the user taps Answer.
    ctx.resume()
      .then(() => { if (!state.dead) ring(); })
      .catch(() => { if (!state.dead) ring(); });

    return clearAll;
  }, [enabled, type]);
}
