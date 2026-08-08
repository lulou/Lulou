---
name: SpinRoom winner state machine
description: How the intention-wheel SpinRoom stores and reveals the winner without exposing them early or crashing the error boundary.
---

## Rule
The spin winner is stored in `pendingWinnerRef` (a `useRef`, never `useState`) from the moment `spinWheel()` runs. React state (`selectedProfile`, `selectedIndex`, `revealQuote`) is only set **atomically with `go('reveal', 0)`** at t=11.2 s inside the phase-timeline useEffect.

**Why:** Setting `selectedProfile` early (at pullforward t=8.4 s) caused two bugs:
1. The `{showProfile && selectedProfile}` detail sheet mounted at zIndex 4000 during the spin — on iOS this bled above the zIndex-9999 SpinRoom overlay.
2. If `selectedProfile` was later cleared (e.g. via `closeProfile`) while `spinRoomPhase` was still `'buttons'` or `'pause'`, the phase-timeline useEffect (a microtask) hadn't yet called `setSpinRoomPhase('idle')`, leaving the reveal section in a state where it tried to render with null profile → boundary crash.

**How to apply:**
- `spinWheel()` → `pendingWinnerRef.current = { index, profile }` immediately; clears to null.
- Pullforward timeout (t=8.4 s): read `pendingWinnerRef.current` for winner identity; call `saveSpinResult.mutate` + `recordSpin.mutate`; call `go('pullforward', 0)`. Do NOT touch selectedProfile.
- Reveal timeout (t=11.2 s): `setSelectedIndex`, `setSelectedProfile`, `setRevealQuote`, `go('reveal', 0)` — all in one synchronous block so they batch into a single render.
- Pullforward `useLayoutEffect`: snap orbit to `pendingWinnerRef.current?.index ?? orbitFrontCandRef.current` (pre-determined winner, not whoever happens to be at front).
- `closeProfile()` and `sendSpark.onSuccess` both set `pendingWinnerRef.current = null`.

## sendSpark.onSuccess ordering rule
Pre-clear `/api/spin/result` query cache **before** closing the SpinRoom:
```
queryClient.setQueryData(["/api/spin/result"], { profile: null });
setTimeout(() => {
  setShowSpinRoom(false);   // unmounts boundary
  setSelectedProfile(null); // batched — no intermediate render
  ...
  deleteSpinResult.mutate(); // background cleanup
}, 2200);
```
**Why:** Without the pre-clear, after `setSelectedProfile(null)` the query's `enabled` gate flips true, the stale result immediately refetches, and the restoration useEffect re-mounts the profile sheet — creating a ghost result after Send Halo.

Do NOT call `closeProfile()` from inside `sendSpark.onSuccess`; it fires `deleteSpinResult.mutate()` which races with the restoration refetch.
