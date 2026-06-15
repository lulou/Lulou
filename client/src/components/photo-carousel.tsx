import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";
import { useLanguageContext } from "@/contexts/language-context";

/**
 * Drag-enabled photo carousel.
 *
 * Behaviour:
 *   - Renders all photos in a flex strip; CSS translateX follows the drag in
 *     real-time so the next/prev photo is always visible while dragging.
 *   - Uses Pointer Events (works on touch + mouse) with setPointerCapture so
 *     the drag continues even if the pointer leaves the element.
 *   - Non-passive touchmove listener calls preventDefault() for horizontal
 *     gestures → prevents the iOS Safari scroll container from claiming the
 *     touch before JS can handle it.
 *   - Direction is decided on the first significant movement (≥5 px):
 *       horizontal → carousel drag, vertical → ignored (native scroll).
 *   - Rubber-band resistance (0.25×) at the first/last photo edge.
 *   - On release: if displacement > threshold (28 % of width, max 90 px)
 *     → navigate; otherwise → smooth snap-back.
 *   - Short movements (<10 px) that end without locking direction are treated
 *     as taps: right half → next, left half → prev.
 *   - Snap / snap-back animated with CSS transition; real-time drag has no
 *     transition so it follows the finger instantly.
 *   - Arrow buttons stop pointer-event propagation so they don't start a drag.
 *   - Neighbor photos loaded eagerly so they are ready before the drag ends.
 */

interface PhotoCarouselProps {
  photos: string[];
  height?: number | string;
  currentIndex?: number;
  onIndexChange?: (idx: number) => void;
  showArrows?: boolean;
  showDots?: boolean;
  gap?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
}

export function PhotoCarousel({
  photos,
  height = 300,
  currentIndex: controlledIdx,
  onIndexChange,
  showArrows = true,
  showDots = true,
  className = "",
  style,
  children,
}: PhotoCarouselProps) {
  const { isRTL } = useLanguageContext();
  const [internalIdx, setInternalIdx] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Refs for synchronous reads inside event handlers (no stale-closure issues).
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    pointerId: number | null;
    dirLocked: boolean | null; // null=undecided, true=horiz, false=vert
  }>({ startX: 0, startY: 0, pointerId: null, dirLocked: null });

  const n = photos.length;
  const idx = controlledIdx !== undefined ? controlledIdx : internalIdx;
  const safeIdx = n === 0 ? 0 : Math.min(idx, n - 1);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(n - 1, next));
      if (controlledIdx === undefined) setInternalIdx(clamped);
      onIndexChange?.(clamped);
    },
    [n, controlledIdx, onIndexChange],
  );

  // Preload current photo and immediate neighbours.
  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  // Clamp when photos array shrinks.
  useEffect(() => {
    if (controlledIdx === undefined && internalIdx >= n && n > 0) {
      setInternalIdx(0);
    }
  }, [n, controlledIdx, internalIdx]);

  // ── Non-passive touchmove for iOS Safari ────────────────────────────────────
  // Must be attached imperatively (passive:false) — React synthetic events are
  // passive by default and cannot call preventDefault().
  useEffect(() => {
    const el = containerRef.current;
    if (!el || n <= 1) return;

    const onTouchMove = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.dirLocked === true) {
        // Confirmed horizontal — block Safari from scrolling.
        e.preventDefault();
      } else if (g.dirLocked === null) {
        const dx = Math.abs(e.touches[0].clientX - g.startX);
        const dy = Math.abs(e.touches[0].clientY - g.startY);
        if (dx > 3 && dx > dy) e.preventDefault();
      }
    };

    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, [n]);

  // ── Pointer event handlers ───────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1) return;
    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      dirLocked: null,
    };
    isDraggingRef.current = false;
    // Capture so we still receive events if pointer leaves the element.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;

    const rawDx = e.clientX - g.startX;
    const rawDy = e.clientY - g.startY;

    // Direction decision on first significant movement.
    if (g.dirLocked === null) {
      if (Math.abs(rawDx) < 5 && Math.abs(rawDy) < 5) return;
      g.dirLocked = Math.abs(rawDx) >= Math.abs(rawDy);
    }
    if (!g.dirLocked) return; // vertical — let native scroll handle it

    // Account for RTL (swipe direction is mirrored).
    const dx = isRTL ? -rawDx : rawDx;

    // Rubber-band resistance at edges.
    const atStart = safeIdx === 0 && dx > 0;
    const atEnd = safeIdx === n - 1 && dx < 0;
    const clamped = atStart || atEnd ? dx * 0.25 : dx;

    isDraggingRef.current = true;
    setIsDragging(true);
    setDragX(clamped);
  };

  const commitDrag = (finalClientX: number) => {
    const g = gestureRef.current;
    g.pointerId = null;

    if (!isDraggingRef.current) {
      // Short movement → treat as tap: navigate based on which half was tapped.
      const el = containerRef.current;
      if (el && n > 1) {
        const rect = el.getBoundingClientRect();
        const x = finalClientX - rect.left;
        const goFwd = isRTL ? x < rect.width / 2 : x > rect.width / 2;
        if (goFwd && safeIdx < n - 1) goTo(safeIdx + 1);
        else if (!goFwd && safeIdx > 0) goTo(safeIdx - 1);
      }
      return;
    }

    // Full drag — threshold check.
    const containerWidth = containerRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(containerWidth * 0.28, 90);
    const rawDx = finalClientX - g.startX;
    const dx = isRTL ? -rawDx : rawDx;

    isDraggingRef.current = false;
    setIsDragging(false);

    if (dx < -threshold && safeIdx < n - 1) {
      goTo(safeIdx + 1);
    } else if (dx > threshold && safeIdx > 0) {
      goTo(safeIdx - 1);
    }
    // Always reset dragX — snap-back transition plays if we didn't navigate.
    setDragX(0);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current.pointerId !== e.pointerId) return;
    commitDrag(e.clientX);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current.pointerId !== e.pointerId) return;
    gestureRef.current.pointerId = null;
    isDraggingRef.current = false;
    setIsDragging(false);
    setDragX(0);
  };

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, background: "hsl(var(--muted))", touchAction: "pan-y", ...style }}
      data-testid="photo-carousel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {n === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <svg viewBox="0 0 80 80" fill="none" className="w-16 h-16 opacity-20">
            <circle cx="40" cy="28" r="14" fill="currentColor" />
            <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
          </svg>
        </div>
      )}

      {/* ── Photo strip ─────────────────────────────────────────────────────── */}
      {n > 0 && (
        <div
          style={{
            display: "flex",
            height: "100%",
            // Position so the current photo is centred, then offset by drag.
            transform: `translateX(calc(${safeIdx * -100}% + ${dragX}px))`,
            // No transition while dragging (real-time tracking).
            // Smooth spring when snapping or navigating.
            transition: isDragging
              ? "none"
              : "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)",
            willChange: "transform",
          }}
        >
          {photos.map((photo, i) => (
            <div
              key={photo + i}
              style={{ flex: "0 0 100%", minWidth: 0, height: "100%" }}
            >
              <img
                src={photo}
                alt={`Photo ${i + 1}`}
                // Eager for current + immediate neighbours so they are ready
                // before the drag completes; lazy for the rest.
                loading={Math.abs(i - safeIdx) <= 1 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "center top",
                  opacity: decodedPhotos.has(photo) ? 1 : 0,
                  transition: "opacity 0.08s ease",
                  display: "block",
                  userSelect: "none",
                  pointerEvents: "none", // let the container handle all events
                }}
                onLoad={e => {
                  decodedPhotos.add(photo);
                  (e.currentTarget as HTMLImageElement).style.opacity = "1";
                }}
                data-testid={`img-carousel-photo-${i}`}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── Arrow buttons ────────────────────────────────────────────────────── */}
      {showArrows && n > 1 && safeIdx > 0 && (
        <button
          className="absolute start-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
          }}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => goTo(safeIdx - 1)}
          data-testid="button-carousel-prev"
          aria-label="Previous photo"
        >
          {isRTL ? (
            <ChevronRight className="w-4 h-4 text-white" />
          ) : (
            <ChevronLeft className="w-4 h-4 text-white" />
          )}
        </button>
      )}
      {showArrows && n > 1 && safeIdx < n - 1 && (
        <button
          className="absolute end-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
          }}
          onPointerDown={e => e.stopPropagation()}
          onClick={() => goTo(safeIdx + 1)}
          data-testid="button-carousel-next"
          aria-label="Next photo"
        >
          {isRTL ? (
            <ChevronLeft className="w-4 h-4 text-white" />
          ) : (
            <ChevronRight className="w-4 h-4 text-white" />
          )}
        </button>
      )}

      {/* ── Dot indicators ───────────────────────────────────────────────────── */}
      {showDots && n > 1 && (
        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-1.5 pointer-events-none z-20">
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === safeIdx ? 22 : 7,
                height: 7,
                borderRadius: 3.5,
                background:
                  i === safeIdx ? "white" : "rgba(255,255,255,0.42)",
                transition: "width 0.25s ease, background 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}

      {/* Caller-supplied overlay content (close buttons, gradients, name…) */}
      {children}
    </div>
  );
}
