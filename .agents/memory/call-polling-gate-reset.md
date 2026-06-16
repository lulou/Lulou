---
name: Call polling gate stale reset
description: hasRingRef.current must be reset to false when all three call memos go null; the stale-call timeout path never fires callEndedCallback, leaving the gate permanently true.
---

## The rule
Always watch `[incomingCall, callerRingingCall, activeCall]` together and reset `hasRingRef.current = false` when all three become null, regardless of why they became null.

## Why
`hasRingRef.current = true` is only ever cleared by `callEndedCallback` → `markCallEnded` (normal call end or explicit cancel signal).  
When `isStaleCall()` fires (90 s unanswered timeout) the three memos quietly drop to null and the overlays unmount — but **no signal is sent**, so `callEndedCallback` never fires.  
With `hasRingRef.current = true`, the `refetchInterval` gate in CallDetectors returns `false` (polling paused), so no match-list polls fire until the next Realtime event or logout. New calls appear via Realtime but stale poll data lingers.

## How to apply
In `CallDetectors` (`client/src/App.tsx`), after the three memos are computed:

```ts
useEffect(() => {
  const hasAnyCall = !!(incomingCall || callerRingingCall || activeCall);
  if (!hasAnyCall && hasRingRef.current) {
    hasRingRef.current = false;
    console.log("[CALL_FIX] ring polling gate reset — no active calls (stale or ended)");
  }
}, [incomingCall, callerRingingCall, activeCall]);
```

This is a safety net — it fires for all call-end paths (normal, cancel, stale, logout) and is idempotent when `hasRingRef.current` is already false.

## Server-side companion fix
`clearStaleCallsOnStartup()` runs once at boot. Add a `setInterval` inside `registerRoutes` (every 5 min) that queries `callStartedAt IS NOT NULL`, clears rows older than 2 min (unanswered) or 10 min (answered), and broadcasts `call:ended` for each — so long-running servers don't accumulate orphaned call rows between restarts.
