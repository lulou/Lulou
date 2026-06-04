import { useState, useEffect, useRef, useCallback } from "react";

interface DragPhotoViewerProps {
  photos: string[];
  height?: number;
}

const THRESHOLD_RATIO = 0.28;  // fraction of card width to commit a swipe
const ROTATE_MAX      = 14;    // max tilt degrees at card edge
const FLY_DEG         = 22;    // rotation when card flies off

/**
 * Card-stack photo viewer. No library, raw pointer events.
 *
 * Depth model:
 *   Front card — current photo. Sits at z=2, full size.
 *   Back card  — next photo. Sits at z=1, always visually smaller and lower.
 *
 * Motion design to avoid the "filmstrip" / "connected" look:
 *   Front card exits SIDEWAYS (translateX + rotate).
 *   Back card rises FORWARD (translateY from below + scale up).
 *   These perpendicular trajectories make it perceptually obvious the two
 *   photos are at different depths, not on the same horizontal plane.
 *
 * Scale discipline:
 *   Back card scales from 0.80 → 0.95 during the drag (never reaches 1.0
 *   during drag). It only snaps to 1.0 when fly-off is committed, with a
 *   CSS transition that runs simultaneously with the front card flying out.
 *   This guarantees the back card is always noticeably smaller than the
 *   front card during any mid-drag state.
 *
 * Opacity:
 *   Back card uses easeOut opacity curve so it becomes visible quickly at
 *   the start of a drag, giving immediate feedback without being opaque at
 *   rest (opacity 0 at rest → no "ghost" photo visible through the current card).
 */
export function DragPhotoViewer({ photos, height = 500 }: DragPhotoViewerProps) {
  const n = photos.length;

  const [index,    setIndex]    = useState(0);
  const [dragX,    setDragX]    = useState(0);
  const [dragging, setDragging] = useState(false);
  const [flyDir,   setFlyDir]   = useState<"left" | "right" | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const startX  = useRef(0);
  const lastDX  = useRef(0);

  // iOS Safari: prevent scroll container from firing touchcancel on horizontal drags
  useEffect(() => {
    const el = rootRef.current;
    if (!el || n <= 1) return;
    let ax = 0, ay = 0, decided = false;
    const onTS = (e: TouchEvent) => {
      ax = e.touches[0].clientX;
      ay = e.touches[0].clientY;
      decided = false;
    };
    const onTM = (e: TouchEvent) => {
      const dx = Math.abs(e.touches[0].clientX - ax);
      const dy = Math.abs(e.touches[0].clientY - ay);
      if (!decided && dx < 3 && dy < 3) return;
      decided = true;
      if (dx > dy) e.preventDefault();
    };
    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchmove",  onTM, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove",  onTM);
    };
  }, [n]);

  // Pointer handlers
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1 || flyDir !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    lastDX.current = 0;
    setDragging(true);
    setDragX(0);
  }, [n, flyDir]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const dx = e.clientX - startX.current;
    lastDX.current = dx;
    setDragX(dx);
  }, [dragging]);

  const commitDrag = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    const cw = rootRef.current?.offsetWidth ?? 375;
    const dx = lastDX.current;
    if      (dx < -(cw * THRESHOLD_RATIO) && index < n - 1) setFlyDir("left");
    else if (dx >  (cw * THRESHOLD_RATIO) && index > 0)     setFlyDir("right");
    else setDragX(0);
  }, [dragging, index, n]);

  // Front card fly-off complete → advance index, reset
  const onFrontTransitionEnd = useCallback(() => {
    if (!flyDir) return;
    setIndex(i => flyDir === "left" ? i + 1 : i - 1);
    setFlyDir(null);
    setDragX(0);
  }, [flyDir]);

  // Derived state
  const cardW = rootRef.current?.offsetWidth ?? 375;

  // Raw progress 0→1 (fraction of card width dragged)
  const rawProgress = Math.min(Math.abs(dragX) / Math.max(cardW, 1), 1);

  // Which photo sits behind the front card
  const peekIdx = (dragX < 0 && index < n - 1) ? index + 1
                : (dragX > 0 && index > 0)      ? index - 1
                : (index < n - 1)               ? index + 1
                : (index > 0)                   ? index - 1
                : -1;
  const showBack = n > 1 && peekIdx !== -1;

  // ── Front card styles ─────────────────────────────────────────────────────
  // Tilt is capped at ROTATE_MAX regardless of drag distance.
  const tilt = Math.max(-ROTATE_MAX, Math.min(ROTATE_MAX, dragX * 0.06));

  let frontTransform  = `translateX(${dragX}px) rotate(${tilt}deg)`;
  let frontTransition = dragging
    ? "none"
    : "transform 0.34s cubic-bezier(0.25, 0.46, 0.45, 0.94)";

  if (flyDir === "left") {
    frontTransform  = `translateX(-140%) rotate(-${FLY_DEG}deg)`;
    frontTransition = "transform 0.40s cubic-bezier(0.55, 0, 1, 0.45)";
  } else if (flyDir === "right") {
    frontTransform  = `translateX(140%) rotate(${FLY_DEG}deg)`;
    frontTransition = "transform 0.40s cubic-bezier(0.55, 0, 1, 0.45)";
  }

  // ── Back card styles ──────────────────────────────────────────────────────
  //
  // EaseOut opacity: appears quickly at the start of drag, so user gets
  // immediate visual feedback that another card is waiting.
  //   opacityP = 1 − (1 − rawProgress)²   →  easeOut quadratic
  //
  // Scale: rises from 0.80 → 0.95 during drag (never reaches 1.0 mid-drag).
  //   The persistent 5%+ size gap prevents the back card from ever looking
  //   the same size as the front card while they are simultaneously visible.
  //
  // translateY: rises from +60px → +4px during drag.
  //   Downward-shifted starting position + vertical upward motion = clear
  //   "coming forward from behind" depth cue.
  //
  // Fly-off: back card snaps to scale 1.0, translateY 0, opacity 1.0 with a
  //   smooth CSS transition that runs in parallel with the front card flying out.
  //   When the front card's transitionEnd fires, the back card is already at
  //   full size, so the swap looks instantaneous.

  const flying = flyDir !== null;

  let backScale: number;
  let backOpacity: number;
  let backTY: number;

  if (flying) {
    backScale   = 1.0;
    backOpacity = 1.0;
    backTY      = 0;
  } else {
    const opacityP = 1 - Math.pow(1 - rawProgress, 2); // easeOut
    backScale   = 0.80 + rawProgress * 0.15;            // 0.80 → 0.95
    backOpacity = Math.min(opacityP * 1.15, 0.97);      // 0 → 0.97 (easeOut)
    backTY      = 60 - rawProgress * 56;                // 60px → 4px
  }

  const backTransition = dragging
    ? "none"
    : flying
      ? "transform 0.38s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.22s ease"
      : "transform 0.30s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.30s ease";

  // Shadow on front card intensifies while dragging to emphasise it lifting
  const frontShadow = dragging
    ? "0 20px 60px rgba(0,0,0,0.45), 0 6px 20px rgba(0,0,0,0.25)"
    : "0 8px 32px rgba(0,0,0,0.28)";

  return (
    <div
      ref={rootRef}
      data-testid="drag-photo-viewer"
      style={{
        position:    "relative",
        width:       "100%",
        height,
        touchAction: "pan-y pinch-zoom",
        cursor:      n > 1 ? (dragging ? "grabbing" : "grab") : "default",
        userSelect:  "none",
        background:  "transparent",
        // Allow back card shadow to render without clipping
        overflow:    "visible",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commitDrag}
      onPointerCancel={commitDrag}
    >
      {/* ── Back card ──────────────────────────────────────────────────────
          Completely hidden at rest. Rises forward as front card is dragged.
          key={peekIdx} forces remount when the target photo changes,
          preventing leftover CSS transform state from the previous card.     */}
      {showBack && (
        <div
          key={peekIdx}
          style={{
            position:        "absolute",
            inset:           "0 6px",
            borderRadius:    22,
            overflow:        "hidden",
            boxShadow:       "0 4px 16px rgba(0,0,0,0.22)",
            transform:       `scale(${backScale.toFixed(4)}) translateY(${backTY.toFixed(1)}px)`,
            opacity:         backOpacity,
            transition:      backTransition,
            zIndex:          1,
            transformOrigin: "center center",
          }}
        >
          <img
            src={photos[peekIdx]}
            alt=""
            draggable={false}
            style={{
              width: "100%", height: "100%",
              objectFit: "cover", objectPosition: "center top",
              display: "block", pointerEvents: "none", userSelect: "none",
            }}
          />
          {/* Dim overlay: simulates front card casting a shadow on the back card.
              Fades out as the front card moves away (1−rawProgress).              */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute", inset: 0,
              background: "rgba(0,0,0,0.28)",
              opacity: flying ? 0 : (1 - rawProgress),
              transition: dragging ? "none" : "opacity 0.30s ease",
              pointerEvents: "none",
              borderRadius: 22,
            }}
          />
        </div>
      )}

      {/* ── Front card ─────────────────────────────────────────────────────
          transformOrigin "50% 80%" pivots near the lower third of the card,
          giving a natural "hand holding the card" tilt feel.                 */}
      <div
        style={{
          position:        "absolute",
          inset:           "0 6px",
          borderRadius:    22,
          overflow:        "hidden",
          boxShadow:       frontShadow,
          transform:       frontTransform,
          transition:      frontTransition,
          zIndex:          2,
          willChange:      "transform",
          transformOrigin: "50% 80%",
        }}
        onTransitionEnd={flyDir ? onFrontTransitionEnd : undefined}
      >
        <img
          src={photos[index]}
          alt={`Photo ${index + 1}`}
          draggable={false}
          style={{
            width: "100%", height: "100%",
            objectFit: "cover", objectPosition: "center top",
            display: "block", pointerEvents: "none", userSelect: "none",
          }}
        />
        {/* Vignette so dots stay readable over any photo */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.05) 38%, transparent 55%)",
          }}
        />
      </div>

      {/* ── Dots ───────────────────────────────────────────────────────── */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position:       "absolute",
            bottom:         14,
            left:           0,
            right:          0,
            display:        "flex",
            justifyContent: "center",
            alignItems:     "center",
            gap:            6,
            pointerEvents:  "none",
            zIndex:         3,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width:        i === index ? 20 : 6,
                height:       6,
                borderRadius: 3,
                background:   i === index ? "white" : "rgba(255,255,255,0.50)",
                transition:   "width 0.22s ease",
                flexShrink:   0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
