import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";
import { useLanguageContext } from "@/contexts/language-context";

/**
 * Drag-enabled photo carousel — floating-card architecture.
 *
 * CONTAINER STRUCTURE (back to front):
 *
 * 1. Outer div  — pure positioning/gesture layer.
 *    No overflow, no padding, no background.  Completely invisible.
 *    Pointer events and ref live here so getBoundingClientRect() returns
 *    the true card bounds.
 *
 * 2. Shadow element  — position:absolute; inset:0; borderRadius:CARD_RADIUS
 *    Provides the floating box-shadow.  Lives OUTSIDE the clip div so the
 *    shadow is never clipped by overflow:hidden and bleeds freely into the
 *    surrounding page (top, bottom, sides).
 *
 * 3. Depth element  — white card at translate(+5px, +5px).
 *    Lives outside the clip div so its right/bottom 5 px slivers peek out
 *    at rest → physical "deck of cards" feel.  Fades out when dragging.
 *
 * 4. Clip div  — position:absolute; inset:0; overflow:hidden; borderRadius:24.
 *    Sole purpose: hide the offscreen peek card.  No padding, no background.
 *    Cards sit at inset:0 inside → no cream/white gap between card edges and
 *    the clip boundary.
 *
 * 5. Peek card  (z-index 1, inside clip div)
 *    Fully offscreen at rest.  Enters from its LEADING EDGE — rounded corner
 *    first — during drag.  Constant CARD_GAP (12 px) between cards:
 *      dragX ≤ 0 → translateX(calc( 100% + (CARD_GAP + dragX)px))
 *      dragX > 0 → translateX(calc(-100% + (-CARD_GAP + dragX)px))
 *    calc(100%) = element's own rendered width = clip-div width.
 *
 * 6. Current card  (z-index 2, inside clip div)
 *    Active photo.  Translates 1:1 with dragX.  Children ride inside.
 *
 * 7. Arrows / dots  — outside clip div, zIndex:3+, always visible.
 *
 * Gesture: pointer events + setPointerCapture; non-passive touchmove for iOS.
 * Rubber-band (0.25×) at first/last photo edges.
 * Release threshold: 28% of card width, max 90 px.
 * Taps (< 10 px movement): right-half → next, left-half → prev.
 */

const CARD_RADIUS = 24;
const CARD_SHADOW = "0 4px 18px rgba(0,0,0,0.18)";
const CARD_GAP = 12;
const DEPTH_OFFSET = 5;

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

  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    pointerId: number | null;
    dirLocked: boolean | null;
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

  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  useEffect(() => {
    if (controlledIdx === undefined && internalIdx >= n && n > 0) {
      setInternalIdx(0);
    }
  }, [n, controlledIdx, internalIdx]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || n <= 1) return;

    const onTouchMove = (e: TouchEvent) => {
      const g = gestureRef.current;
      if (g.dirLocked === true) {
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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1) return;
    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      dirLocked: null,
    };
    isDraggingRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;

    const rawDx = e.clientX - g.startX;
    const rawDy = e.clientY - g.startY;

    if (g.dirLocked === null) {
      if (Math.abs(rawDx) < 5 && Math.abs(rawDy) < 5) return;
      g.dirLocked = Math.abs(rawDx) >= Math.abs(rawDy);
    }
    if (!g.dirLocked) return;

    const dx = isRTL ? -rawDx : rawDx;
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

    const containerWidth = containerRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(containerWidth * 0.28, 90);
    const rawDx = finalClientX - g.startX;
    const dx = isRTL ? -rawDx : rawDx;

    isDraggingRef.current = false;
    setIsDragging(false);
    setDragX(0);

    if (dx < -threshold && safeIdx < n - 1) {
      goTo(safeIdx + 1);
    } else if (dx > threshold && safeIdx > 0) {
      goTo(safeIdx - 1);
    }
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

  const peekIdxRaw = dragX < 0 ? safeIdx + 1 : safeIdx > 0 ? safeIdx - 1 : safeIdx + 1;
  const peekIdx = Math.max(0, Math.min(n - 1, peekIdxRaw));
  const currentPhoto = photos[safeIdx];
  const peekPhoto = photos[peekIdx];

  // Peek card is fully offscreen at rest; enters from its leading edge during drag.
  // calc(100%) = element's own width = clip-div width = outer-div width.
  const peekTransform = dragX > 0
    ? `translateX(calc(-100% + ${dragX - CARD_GAP}px))`
    : `translateX(calc(100% + ${dragX + CARD_GAP}px))`;

  const springTransition = "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)";
  const hasNext = safeIdx < n - 1;

  return (
    <div
      ref={containerRef}
      className={`relative select-none ${className}`}
      style={{
        height,
        touchAction: "pan-y",
        ...style,
      }}
      data-testid="photo-carousel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* ── Empty state ────────────────────────────────────────────────────────── */}
      {n === 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: CARD_RADIUS,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "hsl(var(--muted))",
          }}
        >
          <svg viewBox="0 0 80 80" fill="none" style={{ width: 64, height: 64, opacity: 0.2 }}>
            <circle cx="40" cy="28" r="14" fill="currentColor" />
            <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
          </svg>
        </div>
      )}

      {n > 0 && (
        <>
          {/* ── Shadow element ─────────────────────────────────────────────────
              Transparent div whose box-shadow bleeds freely into the surrounding
              page.  Lives OUTSIDE the clip div so overflow:hidden never clips it.
              The shadow follows the card's exact 24 px rounded shape. */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: CARD_RADIUS,
              boxShadow: CARD_SHADOW,
              pointerEvents: "none",
            }}
          />

          {/* ── Depth element ──────────────────────────────────────────────────
              White card offset +5 px right/down.  Lives OUTSIDE the clip div so
              its right and bottom 5 px slivers ARE visible → stacked-deck feel.
              Fades out when dragging so it doesn't appear between moving cards. */}
          {n > 1 && hasNext && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: CARD_RADIUS,
                background: "rgba(255,255,255,0.85)",
                boxShadow: "0 2px 10px rgba(0,0,0,0.10)",
                zIndex: 0,
                transform: `translate(${DEPTH_OFFSET}px, ${DEPTH_OFFSET}px)`,
                opacity: isDragging ? 0 : 1,
                transition: isDragging ? "none" : "opacity 0.18s ease",
                pointerEvents: "none",
              }}
            />
          )}

          {/* ── Clip div ───────────────────────────────────────────────────────
              overflow:hidden hides the offscreen peek card.
              No padding (no cream/white gap), no background (no frame).
              Cards sit at inset:0 → edge-to-edge, visually seamless. */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflow: "hidden",
              borderRadius: CARD_RADIUS,
              zIndex: 1,
            }}
          >
            {/* Peek card */}
            {n > 1 && peekIdx !== safeIdx && (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: CARD_RADIUS,
                  overflow: "hidden",
                  zIndex: 1,
                  transform: peekTransform,
                  transition: isDragging ? "none" : springTransition,
                  willChange: "transform",
                }}
              >
                <img
                  src={peekPhoto}
                  alt=""
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
            )}

            {/* Current card */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: CARD_RADIUS,
                overflow: "hidden",
                zIndex: 2,
                transform: `translateX(${dragX}px)`,
                transition: isDragging ? "none" : springTransition,
                willChange: "transform",
              }}
            >
              <img
                src={currentPhoto}
                alt={`Photo ${safeIdx + 1}`}
                loading="eager"
                decoding="async"
                draggable={false}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "center top",
                  opacity: decodedPhotos.has(currentPhoto) ? 1 : 0,
                  transition: "opacity 0.08s ease",
                  display: "block",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
                onLoad={e => {
                  decodedPhotos.add(currentPhoto);
                  (e.currentTarget as HTMLImageElement).style.opacity = "1";
                }}
                data-testid={`img-carousel-photo-${safeIdx}`}
              />
              {children}
            </div>
          </div>

          {/* ── Arrow buttons ─────────────────────────────────────────────────
              Outside clip div → never clipped; always visible over the photo. */}
          {showArrows && n > 1 && safeIdx > 0 && (
            <button
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                zIndex: 3,
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.38)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                border: "1px solid rgba(255,255,255,0.18)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => goTo(safeIdx - 1)}
              data-testid="button-carousel-prev"
              aria-label="Previous photo"
            >
              {isRTL ? (
                <ChevronRight style={{ width: 16, height: 16, color: "white" }} />
              ) : (
                <ChevronLeft style={{ width: 16, height: 16, color: "white" }} />
              )}
            </button>
          )}
          {showArrows && n > 1 && safeIdx < n - 1 && (
            <button
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                zIndex: 3,
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.38)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                border: "1px solid rgba(255,255,255,0.18)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => goTo(safeIdx + 1)}
              data-testid="button-carousel-next"
              aria-label="Next photo"
            >
              {isRTL ? (
                <ChevronLeft style={{ width: 16, height: 16, color: "white" }} />
              ) : (
                <ChevronRight style={{ width: 16, height: 16, color: "white" }} />
              )}
            </button>
          )}

          {/* ── Dot indicators ────────────────────────────────────────────────
              Outside clip div → stationary during drag; always visible. */}
          {showDots && n > 1 && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                bottom: 9,
                left: 0,
                right: 0,
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
                    width: i === safeIdx ? 22 : 7,
                    height: 7,
                    borderRadius: 3.5,
                    background: i === safeIdx ? "white" : "rgba(255,255,255,0.42)",
                    transition: "width 0.25s ease, background 0.25s ease",
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
