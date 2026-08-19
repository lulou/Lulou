---
name: SpinRoom cinematic finish
description: Wheel winner planning and the measured, original-card-to-hero handoff used by the Intention Wheel.
---

## Winner planning

**Rule:** Start the winner-guided deceleration while the orbit still has visible
speed. Freeze the live visual angle, candidate order, and chosen winner once,
then use only the natural forward distance to its front-centre target.

**Why:** A correction selected after the orbit has nearly stopped can span several
cards and feels like a late acceleration, even when it eventually lands correctly.

**How to apply:** The guided motion's initial velocity must be no greater than
the preceding visual-frame velocity. Never add a convenience full rotation; tick
audio follows actual angle crossings through the exact final stop.

## Hero handoff

**Rule:** The locked orbit winner is the sole visible photo while it grows from
its measured card rectangle to a measured, invisible hero destination. Show the
result photo only after its wrapper and the original card differ by at most one
pixel in every rectangle dimension.

**Why:** Scaling the card slightly and then mounting a full-size photo creates a
visible geometry jump on iPhone Safari.

**How to apply:** Keep card geometry outside React's style ownership during the
transition. Re-measure the target immediately before handoff; if the viewport
changes, realign the original card and retry the hidden handoff. Scope handoff
timers and animation frames to the current spin so a close/re-spin cannot revive
an old result.