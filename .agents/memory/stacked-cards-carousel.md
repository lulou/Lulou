---
name: Stacked cards carousel pattern
description: Why flex-strip carousels look wrong and how stacked absolute cards fix shadows and rounded entry edges.
---

## The Rule
Both `PhotoCarousel` and `ProfilePhotoViewer` use stacked `position:absolute` cards, NOT a flex strip.

## Why
A flex strip with `overflow:hidden` on the container:
1. Clips all `box-shadow` on inner divs — shadows never render.
2. Adjacent photos enter from the container's rectangular edge (not their own rounded corner), making all photos look like a single connected panel.

## How It Works
- Container: `padding: SHADOW_PAD (6px); overflow: hidden`
- CSS `overflow:hidden` clips at the **padding box** boundary (the outer edge of the padding area).
- Cards: `position: absolute; inset: SHADOW_PAD; borderRadius: CARD_RADIUS (24px); overflow: hidden; boxShadow: CARD_SHADOW`
- The card's shadow bleeds outward into the 6px padding zone, which IS within the clipping boundary → shadow is visible. ✓

## Card Architecture
Only two cards rendered at a time:
- **Peek card** (z-index 0): the neighbour photo, stationary behind current.
- **Current card** (z-index 1): active photo, `translateX(dragX)` during drag.

## Children/Overlays
- In `PhotoCarousel`: caller-supplied `children` go INSIDE the current card (whole card object moves together during drag).
- In `ProfilePhotoViewer`: gradient, `nameSlot`, `action` go INSIDE the current card (clip to card's rounded corners; move with drag — correct UX since they're "on" the photo).
- Dots and arrows go OUTSIDE both cards (they stay fixed while the card drags).
- `photoOverlay` (bubble animation) is at `position:absolute; inset:SHADOW_PAD` as a sibling at z-index 5, above the card.

## Constants
```
SHADOW_PAD = 6
CARD_RADIUS = 24
CARD_SHADOW = "0 3px 14px rgba(0,0,0,0.18)"
```

**Why:** Shadow needs ~6px of breathing room to be visible. Larger SHADOW_PAD (10px) would make cards noticeably smaller than the container; 6px is subtle and unnoticeable.
