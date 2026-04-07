import { useState, useEffect, useRef } from "react";

export function useCountdownSecs(expiresAt: Date | null): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!expiresAt) { setSecs(0); return; }
    const tick = () => setSecs(Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return secs;
}

export function useAnimatedCount(target: number): number {
  const [display, setDisplay] = useState(0);
  const prevTarget = useRef(0);
  useEffect(() => {
    if (target === prevTarget.current) return;
    const from = prevTarget.current;
    prevTarget.current = target;
    const diff = target - from;
    const steps = Math.min(Math.abs(diff) * 2, 24);
    if (steps === 0) { setDisplay(target); return; }
    let step = 0;
    const id = setInterval(() => {
      step++;
      setDisplay(Math.round(from + (diff * step) / steps));
      if (step >= steps) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, [target]);
  return display;
}

export function formatCountdown(secs: number): string {
  if (secs <= 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
