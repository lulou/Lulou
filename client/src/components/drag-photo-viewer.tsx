import { useState, useEffect, useRef, useCallback } from "react";

interface DragPhotoViewerProps {
  photos: string[];
  height?: number;
}

const THRESHOLD_RATIO = 0.28;
const ROTATE_FACTOR   = 0.055;
const FLY_DEG         = 24;

/**
 * Stacked-card drag viewer.
 *
 * Visual model:
 *   Two position-absolute cards in the same container slot.
 *   Front card (z=2): draggable, tilts and translates during drag, flies off on commit.
 *   Back card  (z=1): starts fully hidden (opacity 0, scale 0.88, shifted down 20 px).
 *     As the front card is dragged it fades in and scales up — it is NEVER visible
 *     at rest, so the two photos can never appear side-by-side or connected.
 *     When the front card commits a fly-off the back card immediately targets full
 *     size, so both animations run in parallel and the transition looks natural.
 *   key={peekIdx} on the back card ensures React creates a fresh DOM element each
 *     time the next photo changes, avoiding leftover CSS transform state.
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

  // ── iOS Safari: prevent the scroll container from hijacking horizontal drags
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

  // ── Pointer handlers ──────────────────────────────────────────────────────
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

  const onFrontTransitionEnd = useCallback(() => {
    if (!flyDir) return;
    setIndex(i => flyDir === "left" ? i + 1 : i - 1);
    setFlyDir(null);
    setDragX(0);
  }, [flyDir]);

  // ── Derived values ────────────────────────────────────────────────────────
  const cardW    = rootRef.current?.offsetWidth ?? 375;
  const progress = Math.min(Math.abs(dragX) / Math.max(cardW, 1), 1);

  const peekIdx = (dragX < 0 && index < n - 1) ? index + 1
                : (dragX > 0 && index > 0)      ? index - 1
                : (index < n - 1)               ? index + 1
                : (index > 0)                   ? index - 1
                : -1;
  const showBack = n > 1 && peekIdx !== -1;

  // ── Front card ────────────────────────────────────────────────────────────
  const tilt = dragX * ROTATE_FACTOR;
  let frontTransform  = `translateX(${dragX}px) rotate(${tilt}deg)`;
  let frontTransition: string = dragging
    ? "none"
    : "transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94)";

  if (flyDir === "left") {
    frontTransform  = `translateX(-160%) rotate(-${FLY_DEG}deg)`;
    frontTransition = "transform 0.38s ease-in";
  } else if (flyDir === "right") {
    frontTransform  = `translateX(160%) rotate(${FLY_DEG}deg)`;
    frontTransition = "transform 0.38s ease-in";
  }

  // ── Back card ─────────────────────────────────────────────────────────────
  // At rest (progress=0)  : scale=0.88, opacity=0,   translateY=+20px  → hidden
  // Full drag (progress=1): scale=1.00, opacity=0.92, translateY=0      → fully visible
  // Fly-off committed     : scale=1.00, opacity=1.0,  translateY=0      → parallel with front fly-off
  const flying      = flyDir !== null;
  const backScale   = flying ? 1.0 : 0.88 + progress * 0.12;
  const backOpacity = flying ? 1.0 : progress * 0.92;
  const backTY      = flying ? 0   : 20 * (1 - progress);

  const backTransition = dragging
    ? "none"
    : "transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.35s ease";

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
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commitDrag}
      onPointerCancel={commitDrag}
    >
      {/* Back card — hidden at rest, emerges as front card is dragged away */}
      {showBack && (
        <div
          key={peekIdx}
          style={{
            position:        "absolute",
            inset:           "0 6px",
            borderRadius:    22,
            overflow:        "hidden",
            boxShadow:       "0 4px 20px rgba(0,0,0,0.18)",
            transform:       `scale(${backScale}) translateY(${backTY}px)`,
            opacity:         backOpacity,
            transition:      backTransition,
            zIndex:          1,
            transformOrigin: "center center",
          }}
        >
          <img
            src={photos[peekIdx]}
            alt={`Photo ${peekIdx + 1}`}
            draggable={false}
            style={{
              width: "100%", height: "100%",
              objectFit: "cover", objectPosition: "center top",
              display: "block", pointerEvents: "none", userSelect: "none",
            }}
          />
        </div>
      )}

      {/* Front card — current photo, draggable */}
      <div
        style={{
          position:        "absolute",
          inset:           "0 6px",
          borderRadius:    22,
          overflow:        "hidden",
          boxShadow:       "0 10px 40px rgba(0,0,0,0.30)",
          transform:       frontTransform,
          transition:      frontTransition,
          zIndex:          2,
          willChange:      "transform",
          transformOrigin: "center bottom",
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
        <div
          aria-hidden="true"
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.08) 40%, transparent 60%)",
          }}
        />
      </div>

      {/* Dots */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position:       "absolute",
            bottom:         16,
            left:           0, right: 0,
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
                width:        i === index ? 22 : 7,
                height:       7,
                borderRadius: 3.5,
                background:   i === index ? "white" : "rgba(255,255,255,0.46)",
                transition:   "width 0.25s ease",
                flexShrink:   0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
