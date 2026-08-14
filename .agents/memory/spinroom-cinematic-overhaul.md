---
name: SpinRoom cinematic overhaul (sixth spec)
description: New 9-second timeline replacing the old 11.5s one; CSS FLIP on orbit card; 'pause' phase removed; tick sound wired to visual angle.
---

## What changed

### Phase type
- `'pause'` removed from `SpinPhase` union.
- `'growing'` added — the moment (t=6200ms) when the orbit card begins its FLIP expansion to full-screen.

### New cinematic timeline (pullforward useLayoutEffect milestones)
| t (ms) | Event |
|---|---|
| 0 | Winner card at scale 1.000; "Narrowing down…" text |
| 1800 | "There's something here…" |
| 3800 | "Tonight's connection" + `setSpinRoomPhase('momentum')` |
| 6200 | `flipStarted=true`; `setSpinRoomPhase('growing')`; CSS FLIP starts (2800ms transition) |
| 7600 | `setMomentumLabel('')` — text cleared mid-grow |
| 9000 | Result overlay mounts (`setSpinRoomPhase('reveal')`); chime+vibrate; 'buttons' fires +1500ms later via setTimeout |

### Scale function (_scale)
- Old: peaked at 1.100 at t=10500ms.
- New: peaks at **1.020** at t=6200ms. RAF scale writes stop at t=6200ms (`flipStarted=true`).

### CSS FLIP on orbit card
At t=6200ms milestone:
1. `winnerEl.getBoundingClientRect()` captures current card rect.
2. Compute `heroScale = max(vw/cardWidth, vh/cardHeight)` and `dx/dy` to shift centre to viewport centre.
3. Two nested rAFs flush browser style engine, then apply:
   - `transition: transform 2.8s cubic-bezier(0.25,0.46,0.45,0.94), border-radius 2.8s, box-shadow 1.0s`
   - `transform: translate(calc(-50%+{dx}px), calc(-50%+{dy}px)) scale({heroScale})`
   - `borderRadius: 0px; boxShadow: none`
4. Orbit card grows from card-size to full-viewport over 2800ms.

**Why:** The orbit card's anchor is at `left:50%, top:50%` of the orbit container. The existing `translate(-50%,-50%)` centres it there. We ADD `dx/dy` to shift the card centre to the viewport centre, then multiply the scale.

### Result overlay
- `zIndex: 110` (above orbit card at zIndex:90 during growing).
- **Dark background div removed** — orbit card growing to full-screen is the background.
- **ProfilePhoto wrapper** mounts at `'reveal'` (not 'pause'). `position:absolute, inset:0`. No FLIP — just appears at full-size to replace the orbit card seamlessly (same image, same position, imperceptible handoff).
- **Quote text section removed** — 'reveal' is no longer a quote screen.
- Gradient overlays and profile text+CTA (`spinRoomPhase === 'reveal' || 'buttons'`).
- Carousel parent fades to `opacity:0` at `'reveal'/'buttons'` (NOT at 'growing').
- Carousel parent `pointerEvents:none` at `'growing'/'reveal'/'buttons'`.

### Tick sound wired to visual angle
- `prevOrbitAngleRef` added to track previous-frame orbit angle.
- `resetTick(Math.PI/2)` called when orbit RAF starts (orbit initialises at π/2).
- In normal spin RAF: after `orbitAngleRef2.current += speed * dt`, detect bucket crossings (`floor(angle/spacing) - floor(prevAngle/spacing)`, cap at 3), call `tickFromAngle((prevBucket+tc+1)*spacing, spacing)` for each.
- Same pattern in approach RAF (after setting `orbitAngleRef2.current = approachAngle`).
- Orbit RAF early-return guard: added `'growing'`, removed `'pause'`.

### Approach convergence gate
- Old: `angularError < 0.01` — fired early when winner was near front-centre.
- New: **`tApproach >= 1.0`** — waits for full approach duration to elapse.

### corrA special case removed
- Old: `corrA < 0.05 → dynamicDur = 50ms` (micro-snap, caused visible acceleration jitter).
- New: `dynamicDur = Math.max(400, ...)` — minimum 400ms for all cases, smooth deceleration.

### Old FLIP useLayoutEffect on 'pause'
**Removed entirely.** The `winnerPhotoWrapperRef` ref and the `useLayoutEffect(() => { if (spinRoomPhase !== 'pause') return; ... }, [spinRoomPhase])` block are gone.

## Key invariants
- From t=6200ms: NO RAF writes to `winnerEl.style.transform` — CSS transition owns it.
- `winnerEl.style.zIndex = '90'` set just before FLIP starts (lifts above other orbit cards).
- Momentum text `<p>` visible during `'growing'` (condition includes 'growing') but clears at t=7600ms via `setMomentumLabel('')`.
- The `flipStarted` variable is LOCAL to the pullforward useLayoutEffect closure, not a ref.
