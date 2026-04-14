import { useEffect, useRef } from "react";

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
 */
export function useCallRingtone(type: RingtoneType, enabled: boolean) {
  const stateRef = useRef<{
    ctx: AudioContext;
    timers: ReturnType<typeof setTimeout>[];
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

    const state = { ctx, timers: [] as ReturnType<typeof setTimeout>[], dead: false };
    stateRef.current = state;

    const addTimer = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      state.timers.push(id);
      return id;
    };

    const clearAll = () => {
      state.dead = true;
      state.timers.forEach(clearTimeout);
      state.timers.length = 0;
      state.ctx.close().catch(() => {});
      stateRef.current = null;
    };

    /**
     * Play a single burst of two blended sine waves (440 Hz + 480 Hz).
     * Smooth 25 ms fade-in / fade-out prevents clicking artefacts.
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

    ctx.resume().then(() => { if (!state.dead) ring(); }).catch(() => { if (!state.dead) ring(); });

    return clearAll;
  }, [enabled, type]);
}
