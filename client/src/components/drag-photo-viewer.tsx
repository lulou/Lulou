import { useState, useEffect, useRef, useCallback } from "react";

interface DragPhotoViewerProps {
  photos: string[];
  height?: number;
}

const THRESHOLD_RATIO = 0.28; // fraction of card width to commit a swipe
const ROTATE_FACTOR   = 0.06; // degrees of tilt per px of drag
const FLY_DEG         = 22;   // rotation when card flies off screen

/**
 * Floating-card drag viewer — no library, raw pointer events.
 *
 * Visual model:
 *   Two cards stacked in the same position.
 *   • Front card (current photo): draggable; translates + tilts during drag.
 *   • Back card  (next photo in swipe direction): peeks from behind at 94%
 *     scale, rises to 100% and full opacity as drag progresses.
 *   Cards have rounded corners, box-shadow, and side margins so they look
 *   like separate floating bubbles — not a filmstrip.
 *
 * iOS Safari fix:
 *   Non-passive touchmove listener on the root div calls preventDefault() for
 *   horizontal gestures, preventing the page's overflow-y:auto scroll container
 *   from firing touchcancel and cancelling the drag.
 */
export function DragPhotoViewer({ photos, height = 500 }: DragPhotoViewerProps) {
  const n = photos.length;

  const [index,     setIndex]     = useState(0);
  const [dragX,     setDragX]     = useState(0);
  const [dragging,  setDragging]  = useState(false);
  // "left" | "right" | null — direction the front card is flying off
  const [flyDir,    setFlyDir]    = useState<"left" | "right" | null>(null);

  const rootRef  = useRef<HTMLDivElement>(null);
  const startX   = useRef(0);
  const lastDX   = useRef(0);

  // ── iOS Safari scroll-container fix ─────────────────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el || n <= 1) return;
    let ax = 0, ay = 0, decided = false;
    const onTS = (e: TouchEvent) => { ax = e.touches[0].clientX; ay = e.touches[0].clientY; decided = false; };
    const onTM = (e: TouchEvent) => {
      const dx = Math.abs(e.touches[0].clientX - ax);
      const dy = Math.abs(e.touches[0].clientY - ay);
      if (!decided && dx < 3 && dy < 3) return;
      decided = true;
      if (dx > dy) e.preventDefault();
    };
    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchmove",  onTM, { passive: false });
    return () => { el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); };
  }, [n]);

  // ── Pointer handlers ─────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1 || flyDir !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current  = e.clientX;
    lastDX.current  = 0;
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
    const cw        = rootRef.current?.offsetWidth ?? 375;
    const threshold = cw * THRESHOLD_RATIO;
    const dx        = lastDX.current;
    if      (dx < -threshold && index < n - 1) setFlyDir("left");
    else if (dx >  threshold && index > 0)     setFlyDir("right");
    else                                       setDragX(0); // snap back
  }, [dragging, index, n]);

  // After the fly-off animation ends → advance index, reset state
  const onFrontTransitionEnd = useCallback(() => {
    if (!flyDir) return;
    setIndex(i => flyDir === "left" ? i + 1 : i - 1);
    setFlyDir(null);
    setDragX(0);
  }, [flyDir]);

  // ── Derived visual values ────────────────────────────────────────────────
  const progress = Math.min(Math.abs(dragX) / Math.max(rootRef.current?.offsetWidth ?? 375, 1), 1);

  // Which photo is behind the front card, based on drag direction
  const peekIdx = (dragX < 0 && index < n - 1) ? index + 1
                : (dragX > 0 && index > 0)     ? index - 1
                : (index < n - 1)              ? index + 1
                : (index > 0)                  ? index - 1
                : -1;
  const showBack = n > 1 && peekIdx !== -1;

  // Front card transform
  const tilt = dragX * ROTATE_FACTOR;
  let frontTransform  = `translateX(${dragX}px) rotate(${tilt}deg)`;
  let frontTransition = dragging ? "none" : "transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94)";
  if (flyDir === "left") {
    frontTransform  = `translateX(-160%) rotate(-${FLY_DEG}deg)`;
    frontTransition = "transform 0.38s ease-in";
  } else if (flyDir === "right") {
    frontTransform  = `translateX(160%) rotate(${FLY_DEG}deg)`;
    frontTransition = "transform 0.38s ease-in";
  }

  // Back card rises and becomes opaque as drag progresses
  const backScale   = 0.94 + progress * 0.06;
  const backOpacity = 0.55 + progress * 0.45;
  const backTranslateY = (1 - backScale) * height * 0.18; // subtle rise

  return (
    <div
      ref={rootRef}
      data-testid="drag-photo-viewer"
      style={{
        position: "relative",
        width: "100%",
        height,
        /* extra bottom space so the back card peek shadow isn't clipped */
        paddingBottom: 0,
        touchAction: "pan-y pinch-zoom",
        cursor: n > 1 ? (dragging ? "grabbing" : "grab") : "default",
        userSelect: "none",
        /* transparent bg — cards have their own bg/shadow */
        background: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commitDrag}
      onPointerCancel={commitDrag}
    >
      {/* ── Back card (peek) ──────────────────────────────────────────────── */}
      {showBack && (
        <div
          style={{
            position: "absolute",
            inset: "0 6px",
            borderRadius: 22,
            overflow: "hidden",
            boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
            transform: `scale(${backScale}) translateY(${backTranslateY}px)`,
            opacity: backOpacity,
            transition: dragging ? "none" : "transform 0.32s ease, opacity 0.32s ease",
            zIndex: 1,
          }}
        >
          <img
            src={photos[peekIdx]}
            alt={`Photo ${peekIdx + 1}`}
            draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", display: "block", pointerEvents: "none", userSelect: "none" }}
          />
        </div>
      )}

      {/* ── Front card (current) ─────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          inset: "0 6px",
          borderRadius: 22,
          overflow: "hidden",
          boxShadow: "0 10px 40px rgba(0,0,0,0.32)",
          transform: frontTransform,
          transition: frontTransition,
          zIndex: 2,
          willChange: "transform",
        }}
        onTransitionEnd={flyDir ? onFrontTransitionEnd : undefined}
      >
        <img
          src={photos[index]}
          alt={`Photo ${index + 1}`}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", display: "block", pointerEvents: "none", userSelect: "none" }}
        />

        {/* Subtle vignette so dots are readable */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.08) 45%, transparent 65%)",
          }}
        />
      </div>

      {/* ── Dots ─────────────────────────────────────────────────────────── */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 16,
            left: 0, right: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            zIndex: 3,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === index ? 22 : 7,
                height: 7,
                borderRadius: 3.5,
                background: i === index ? "white" : "rgba(255,255,255,0.46)",
                transition: "width 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
