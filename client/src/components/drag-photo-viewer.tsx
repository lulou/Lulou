import { useState, useEffect, useRef, useCallback } from "react";

interface DragPhotoViewerProps {
  photos: string[];
  height?: number;
}

const THRESHOLD_RATIO = 0.25; // fraction of container width to commit a swipe

/**
 * Minimal drag-pull photo viewer.
 *
 * No Embla. No custom carousel library. Raw pointer events.
 *
 * How it works:
 *   - All slides sit in a flex strip that is n × container-width wide.
 *   - The strip is translated by CSS calc so no pixel-width measurement is
 *     needed for the base position: translateX(calc(-{index/n * 100}%)).
 *   - During a drag the raw pixel delta is added on top.
 *   - On release, if |delta| > containerWidth × THRESHOLD the index advances;
 *     otherwise the strip snaps back. A CSS transition handles both cases.
 *
 * iOS Safari inside overflow-y:auto fix:
 *   A non-passive touchmove listener calls preventDefault() for horizontal
 *   gestures so the native scroll container cannot claim the touch and fire
 *   touchcancel before the drag commits.
 */
export function DragPhotoViewer({ photos, height = 440 }: DragPhotoViewerProps) {
  const n = photos.length;
  const [index, setIndex] = useState(0);
  const [dragOffset, setDragOffset] = useState(0); // px
  const [dragging, setDragging] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const lastOffset = useRef(0);

  // ── Non-passive touchmove — iOS Safari scroll-container fix ───────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el || n <= 1) return;

    let ax = 0, ay = 0, decided = false;

    const onTouchStart = (e: TouchEvent) => {
      ax = e.touches[0].clientX;
      ay = e.touches[0].clientY;
      decided = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const dx = Math.abs(e.touches[0].clientX - ax);
      const dy = Math.abs(e.touches[0].clientY - ay);
      if (!decided && dx < 3 && dy < 3) return;
      decided = true;
      if (dx > dy) e.preventDefault();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [n]);

  // ── Pointer event handlers ─────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    lastOffset.current = 0;
    setDragging(true);
    setDragOffset(0);
  }, [n]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const delta = e.clientX - startX.current;
    lastOffset.current = delta;
    setDragOffset(delta);
  }, [dragging]);

  const commit = useCallback(() => {
    if (!dragging) return;
    setDragging(false);

    const containerWidth = rootRef.current?.offsetWidth ?? 375;
    const threshold = containerWidth * THRESHOLD_RATIO;
    const delta = lastOffset.current;

    if (delta < -threshold && index < n - 1) {
      setIndex(i => i + 1);
    } else if (delta > threshold && index > 0) {
      setIndex(i => i - 1);
    }
    setDragOffset(0);
  }, [dragging, index, n]);

  // ── Transform ──────────────────────────────────────────────────────────────
  // Each slide occupies 1/n of the strip (which is n × container-width).
  // Base position: -(index/n * 100)% of strip width = -index × container-width.
  const basePercent = -(index / n) * 100;
  const transform = dragging
    ? `translateX(calc(${basePercent}% + ${dragOffset}px))`
    : `translateX(${basePercent}%)`;
  const transition = dragging ? "none" : "transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)";

  return (
    <div
      ref={rootRef}
      data-testid="drag-photo-viewer"
      style={{
        position: "relative",
        width: "100%",
        height,
        overflow: "hidden",
        touchAction: "pan-y pinch-zoom",
        cursor: n > 1 ? (dragging ? "grabbing" : "grab") : "default",
        userSelect: "none",
        background: "#e5e5e5",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commit}
      onPointerCancel={commit}
    >
      {/* Photo strip */}
      <div
        style={{
          display: "flex",
          width: `${n * 100}%`,
          height: "100%",
          transform,
          transition,
          willChange: "transform",
        }}
      >
        {photos.map((src, i) => (
          <div
            key={i}
            style={{ width: `${100 / n}%`, height: "100%", flexShrink: 0 }}
            data-testid={`drag-slide-${i}`}
          >
            <img
              src={src}
              alt={`Photo ${i + 1}`}
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
                display: "block",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </div>
        ))}
      </div>

      {/* Dots */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 14,
            left: 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            zIndex: 1,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === index ? 24 : 7,
                height: 7,
                borderRadius: 3.5,
                background: i === index ? "white" : "rgba(255,255,255,0.5)",
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
