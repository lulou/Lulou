---
name: SpinRoom winner state machine
description: How the intention-wheel SpinRoom stores and reveals the winner without exposing them early or crashing the error boundary.
---

## gitPush callback silent failure pattern

`gitPush({})` returns `{ success: true }` even when commits DO NOT reach GitHub. Always verify with `git fetch origin && git log --oneline origin/main -3` after any push. If origin/main still shows the pre-push commit, the push silently failed and must be retried.

## Orbit RAF / React style conflict rule

**Never put `transform`, `opacity`, `filter`, or `zIndex` in the JSX `style` prop of an RAF-animated element.** React overwrites the RAF's DOM mutations on every re-render — snapping the animation back to its initial position. Remove them from JSX entirely; set them only via the RAF and the mount useEffect.

Also: remove CSS `perspective` from the container and `translateZ` from card transforms. Use only `translate(x, y) scale(s)` with `zIndex`.

## Approach-phase guided deceleration pattern

To make the orbit land exactly on the winner without a visible jump:

1. The approach `useLayoutEffect` **only** sets `spinPhaseRef.current = 'approach'` and resets the start-time/start-angle/correction refs to 0. It does NOT compute the correction angle — doing so captures a stale `orbitAngleRef2` from React render time (a few ms behind the last RAF frame), which causes a visible jump at approach start.

2. The orbit RAF tick, on the **FIRST approach tick** (when `orbitApproachStartTimeRef.current === 0`), captures the live `orbitAngleRef2.current` and computes the always-forward correction (`+= 2π if negative; += 2π again if < 1.0 rad`). Both start angle and correction are computed from the same live RAF state.

3. **Angular convergence gate**: the approach RAF checks `Math.abs(targetAngle - approachAngle) < 0.01 rad` each frame. At `tApproach = 1.0`, floating-point delta ≈ 0 so the gate fires at approach end. pullforward is NOT fired from a fixed timeout — it is fired by the approach RAF directly via `setSpinRoomPhase('pullforward')`.

4. The approach RAF calls `setSpinRoomPhase('pullforward')` + `setMomentumLabel('Narrowing down…')` when converged. The pullforward `useLayoutEffect` handles all subsequent timing.

## Momentum RAF pattern (single-timestamp, no chained timeouts)

The pullforward `useLayoutEffect` uses a **momentum RAF** instead of chained `setTimeout`s. A single `winnerMomentStartRef.current = performance.now()` is captured at pullforward time. Each RAF frame checks `elapsed = now - winnerMomentStartRef.current` and fires milestones:

| elapsed | action |
|---------|--------|
| 0 ms | "Narrowing down…" (set by approach RAF before firing pullforward) |
| 900 ms | label 2 + `scale(1.04)` |
| 1900 ms | label 3 + `scale(1.07)` + `setSpinRoomPhase('momentum')` |
| 3100 ms | `scale(1.10)` hold |
| 4000 ms | reveal: `setSelectedProfile` + `setRevealQuote` + `setSpinRoomPhase('reveal')` |
| 6300 ms | `setSpinRoomPhase('pause')` |
| 9300 ms | `setSpinRoomPhase('buttons')` |

**CRITICAL — no cleanup return from pullforward useLayoutEffect**: A cleanup would cancel `orbitRafRef2.current` the moment `setSpinRoomPhase('momentum')` fires at milestone t=1900 (because the `spinRoomPhase` dep change re-runs the effect cleanup). Milestones t=3100+ would never fire. The momentum RAF is self-terminating (stops when `mI >= milestones.length`) and is cancelled by the orbit RAF useEffect cleanup on `showSpinRoom = false`.

## Winner state machine rules

`pendingWinnerRef` holds the winner from `spinWheel()` until reveal. `selectedProfile` (React state) is only set atomically with `setSpinRoomPhase('reveal')` at milestone t=4000 ms.

**Why:** Setting `selectedProfile` early caused: iOS detail sheet bleeding above SpinRoom overlay; boundary crashes when `closeProfile()` cleared it before the phase timeline reached idle.

**sendSpark.onSuccess ordering**: pre-clear `/api/spin/result` query cache before closing SpinRoom. Without this, the restoration useEffect re-mounts the profile sheet after Send Halo.

## Error boundary — Continue → blank page fix

`onReset` in `IntentResultBoundary`: if `selectedProfile` is still in state → `setSpinRoomPhase('buttons')` (keep result visible). If profile was cleared → `queryClient.fetchQuery('/api/spin/result', { staleTime: 0 })` to restore from server. Only fall back to `'idle'` if server also returns null.

## Boundary error surfacing

`componentDidCatch` pushes two `pushDebugError` entries: one with `errorMessage + firstFrame`, one with the top-4 componentStack. Visible in the in-app debug panel without needing Safari console access on production devices.
