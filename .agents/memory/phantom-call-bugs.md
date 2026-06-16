---
name: Phantom call / missed ring bugs
description: Three root-cause bugs in the call signaling system found during a full audit; all fixed.
---

## Bug 1 — Post-load call permanently startup-cancelled in pre-sweep window (use-call-signaling.ts)

**Rule:** When `!isStartupSweepComplete()` AND `ringTimestampMs >= APP_LOAD_TIME`, do NOT call `markStartupCancelledSession`. Just return and defer to the next rering.

**Why:** Any `call:ring` arriving before the sweep completes (0–3 s after page load) was unconditionally marked `startupCancelledOnly`. If the call genuinely started after `APP_LOAD_TIME` (a fresh call in the startup window), every subsequent rering hit `isStartupCancelledOnly → markCallSessionCancelled` (permanent) and was blocked forever. The fix: only mark startup-cancelled for calls whose sessionId timestamp predates `APP_LOAD_TIME`; post-load calls just return (deferred).

**How to apply:** The guard is the `if (!isStartupSweepComplete())` block in `use-call-signaling.ts`. Check `ringTimestampMs >= APP_LOAD_TIME` and `return` without marking.

---

## Bug 2 — Location-change effect disarms live ring before React re-renders (App.tsx)

**Rule:** The location effect's `clearAllArmedSessions()` guard must check BOTH `!hasActiveCallRef.current` AND `!hasRingRef.current`.

**Why:** `armCallSession()` and `callRingHandler(true)` (which sets `hasRingRef.current = true`) run synchronously in the Realtime signal handler before React re-renders. If the user taps a nav button in the ~50 ms gap between ring arrival and React processing the arm, `hasActiveCallRef.current` is still false (last render), so the location effect fires and disarms the live session — dropping the genuine incoming call. `hasRingRef.current` is the synchronous signal that bridges this gap.

**How to apply:** `if (!hasActiveCallRef.current && !hasRingRef.current) { clearAllArmedSessions(); }`

---

## Bug 3 — processEndSignal dedup key missing callSessionId (use-call-signaling.ts)

**Rule:** The dedup key must be `${matchId}:${reason}:${callSessionId ?? ""}`.

**Why:** The old key was `${matchId}:${reason}`. Two sequential calls on the same match (e.g., a 10 min call followed immediately by a second call) could both end within the 10 s dedup window. The second call's `call:ended/declined/cancelled` signal would be treated as a duplicate and dropped — `callEndedCallback` would never fire, leaving `markCallEnded` uncalled and the overlay stuck.

**How to apply:** Change the key construction in `processEndSignal` in `use-call-signaling.ts`.
