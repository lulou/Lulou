import { useEffect } from "react";
import {
  startIncomingRingtone,
  startOutgoingRingback,
  stopCallSoundsForSession,
} from "../lib/call-audio";

export type RingtoneType = "incoming" | "outgoing";

type RingtoneOwner = {
  tokens: Set<symbol>;
  retry: ReturnType<typeof setInterval> | null;
};

// Several overlays can briefly overlap during navigation/StrictMode remounts.
// They share one retry loop per exact type + session, and cleanup is deferred
// one microtask so an immediate replacement owner can inherit that loop.
const ringtoneOwners = new Map<string, RingtoneOwner>();

function startForOwner(type: RingtoneType, sessionId: string): void {
  if (type === "incoming") startIncomingRingtone(sessionId);
  else startOutgoingRingback(sessionId);
}

export function useCallRingtone(type: RingtoneType, enabled: boolean, sessionId?: string | null) {
  useEffect(() => {
    if (!enabled || !sessionId) return;

    const key = `${type}\u0000${sessionId}`;
    const token = Symbol(key);
    let owner = ringtoneOwners.get(key);

    if (!owner) {
      const tokens = new Set<symbol>([token]);
      const nextOwner: RingtoneOwner = { tokens, retry: null };
      ringtoneOwners.set(key, nextOwner);
      nextOwner.retry = setInterval(() => {
        if (nextOwner.tokens.size > 0 && ringtoneOwners.get(key) === nextOwner) {
          startForOwner(type, sessionId);
        }
      }, 500);
      startForOwner(type, sessionId);
      owner = nextOwner;
    } else {
      owner.tokens.add(token);
    }

    console.log("[RING_DEBUG] source", { type, enabled, sessionId: sessionId.slice(0, 8) });
    return () => {
      const current = ringtoneOwners.get(key);
      if (current !== owner) return;
      current.tokens.delete(token);
      if (current.tokens.size !== 0) return;

      queueMicrotask(() => {
        if (ringtoneOwners.get(key) !== current || current.tokens.size !== 0) return;
        if (current.retry !== null) clearInterval(current.retry);
        ringtoneOwners.delete(key);
        stopCallSoundsForSession(sessionId, "ring_owner_released");
      });
    };
  }, [enabled, type, sessionId]);
}