---
name: Embla carousel photo animation
description: How to achieve a custom CSS animation (bubble/pop) on photo change in an Embla carousel without it being invisible.
---

## Rule
Use an **overlay div** approach, not a re-keyed inner wrapper div.

## Why
Embla's `select` event fires **after** the slide transition animation completes. Re-keying a child div on `select` means React re-mounts it once Embla's own slide is already done — the CSS animation plays on a photo the user can't see, so it looks like nothing happened.

## How to apply
1. On button click or tap: call `emblaApi.scrollTo(newIdx, true)` (instant, no Embla animation) then set overlay state `{ src, direction, id }`.
2. Render an `position:absolute inset:0 zIndex:5` overlay `<div>` keyed on `id` with the CSS animation (`photoEnterRight` / `photoEnterLeft`).
3. After ~500 ms, clear the overlay state — the underlying Embla slide is already in final position so removing the overlay is seamless.
4. For drag gestures: let Embla handle physics naturally (no overlay, `select` just updates `selectedIndex`).
5. Tap-to-advance: listen to `touchstart` / `touchend` on the viewport node; skip if movement > 16 px (drag); split left/right half for direction.

**Why:**  The overlay plays simultaneously with the instant jump, so the user always sees the animation. Re-key approaches rely on `select` timing and are invisible.
