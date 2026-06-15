import { memo, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";
import { isMobile } from "@/lib/perf";

export const PROFILE_PHOTO_HEIGHT = 440;

interface ProfilePhotoViewerProps {
  photos: string[];
  isLoading?: boolean;
  height?: number;
  className?: string;
  action?: ReactNode;
  nameSlot?: ReactNode;
  children?: ReactNode;
}

/**
 * Profile photo viewer — true stacked-card architecture.
 *
 * THREE LAYERS (back to front):
 *
 * 1. Depth layer  (z-index 0)
 *    A static white/light card offset +5 px right and +5 px down from the current
 *    card position. Its right and bottom 5 px slivers peek out from under the
 *    current card within the SHADOW_PAD buffer zone, giving the physical "deck of
 *    cards" appearance at rest. Fades to opacity:0 the instant dragging starts so
 *    it never appears between the two moving photo cards.
 *
 * 2. Peek card   (z-index 1)
 *    The neighbouring photo card. Fully offscreen at rest:
 *      forward → translateX(calc( 100% + CARD_GAP))   (just right of container)
 *      backward → translateX(calc(-100% − CARD_GAP))   (just left of container)
 *    During drag it enters from its LEADING EDGE, so the rounded corner is visible
 *    first — NOT the card interior.  This is the critical difference from the old
 *    scale(0.94) approach which revealed an interior strip with no rounded corner.
 *    A constant CARD_GAP (12 px) of app background stays visible between the cards.
 *
 * 3. Current card  (z-index 2)
 *    The active photo + gradient + nameSlot + action inside, so they all clip to
 *    the card's rounded corners and move together during drag.
 *
 * 4. Photo bubble overlay (z-index 5)
 *    Plays the entrance animation on tap/arrow navigation only (not on drag).
 *
 * Container: padding = SHADOW_PAD, overflow:hidden.
 * The SHADOW_PAD buffer is INSIDE the clip boundary → card box-shadows are visible.
 *
 * Peek card formula:
 *   dragX ≤ 0 → translateX(calc( 100% + (CARD_GAP + dragX)px))
 *   dragX > 0 → translateX(calc(-100% + (-CARD_GAP + dragX)px))
 * calc(100%) = element's own rendered width (= containerWidth − 2×SHADOW_PAD).
 */

const SHADOW_PAD = 6;
const CARD_RADIUS = 24;
const CARD_SHADOW = "0 4px 18px rgba(0,0,0,0.18)";
const CARD_GAP = 12;
const DEPTH_OFFSET = 5;

export const ProfilePhotoViewer = memo(function ProfilePhotoViewer({
  photos,
  isLoading = false,
  height = PROFILE_PHOTO_HEIGHT,
  className = "",
  action,
  nameSlot,
}: ProfilePhotoViewerProps) {
  const n = photos.length;

  const [internalIdx, setInternalIdx] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [photoOverlay, setPhotoOverlay] = useState<{
    src: string;
    direction: "fwd" | "bwd";
    id: number;
  } | null>(null);

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    pointerId: number | null;
    dirLocked: boolean | null;
  }>({ startX: 0, startY: 0, pointerId: null, dirLocked: null });

  const safeIdx = n === 0 ? 0 : Math.min(internalIdx, n - 1);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(n - 1, next));
      setInternalIdx(clamped);
      setDragX(0);
    },
    [n],
  );

  const navigatePhoto = useCallback(
    (newIdx: number, direction: "fwd" | "bwd") => {
      if (newIdx < 0 || newIdx >= n) return;
      setInternalIdx(newIdx);
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      const id = Date.now();
      setPhotoOverlay({ src: photos[newIdx], direction, id });
      overlayTimerRef.current = setTimeout(
        () => setPhotoOverlay(o => (o?.id === id ? null : o)),
        500,
      );
    },
    [n, photos],
  );

  useEffect(() => {
    return () => {
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    };
  }, []);

  // Reset to first photo when profile changes.
  useEffect(() => {
    setInternalIdx(0);
    setDragX(0);
    setPhotoOverlay(null);
  }, [photos]);

  // Preload neighbours.
  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  // Non-passive touchmove for iOS Safari horizontal gesture claim.
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

    const atStart = safeIdx === 0 && rawDx > 0;
    const atEnd = safeIdx === n - 1 && rawDx < 0;
    const clamped = atStart || atEnd ? rawDx * 0.25 : rawDx;

    isDraggingRef.current = true;
    setIsDragging(true);
    setDragX(clamped);
  };

  const commitDrag = (finalClientX: number) => {
    const g = gestureRef.current;
    g.pointerId = null;

    if (!isDraggingRef.current) {
      // Tap — navigate with bubble animation.
      const el = containerRef.current;
      if (el && n > 1) {
        const rect = el.getBoundingClientRect();
        const x = finalClientX - rect.left;
        const goFwd = x > rect.width / 2;
        if (goFwd && safeIdx < n - 1) navigatePhoto(safeIdx + 1, "fwd");
        else if (!goFwd && safeIdx > 0) navigatePhoto(safeIdx - 1, "bwd");
      }
      return;
    }

    // Drag — navigate without bubble (peek card already showed destination).
    const containerWidth = containerRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(containerWidth * 0.28, 90);
    const dx = finalClientX - g.startX;

    isDraggingRef.current = false;
    setIsDragging(false);
    setDragX(0);

    if (dx < -threshold && safeIdx < n - 1) goTo(safeIdx + 1);
    else if (dx > threshold && safeIdx > 0) goTo(safeIdx - 1);
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

  // Which photo sits behind: next when dragging forward/at rest, prev when dragging back.
  const peekIdxRaw = dragX < 0 ? safeIdx + 1 : safeIdx > 0 ? safeIdx - 1 : safeIdx + 1;
  const peekIdx = Math.max(0, Math.min(n - 1, peekIdxRaw));
  const currentPhoto = photos[safeIdx] ?? "";
  const peekPhoto = photos[peekIdx] ?? "";

  // ── Peek card transform ───────────────────────────────────────────────────────
  // calc(100%) = element's own rendered width (containerWidth − 2×SHADOW_PAD).
  // Forward (dragX ≤ 0): next card enters from RIGHT, leading left edge first.
  // Backward (dragX > 0): prev card enters from LEFT, leading right edge first.
  // Gap between cards is always CARD_GAP = 12 px (constant throughout drag).
  const peekTransform = dragX > 0
    ? `translateX(calc(-100% + ${dragX - CARD_GAP}px))`
    : `translateX(calc(100% + ${dragX + CARD_GAP}px))`;

  const springTransition = "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)";
  const hasNext = safeIdx < n - 1;

  // ── Loading shimmer ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        className={`w-full ${className}`}
        style={{
          height,
          background: isMobile
            ? "hsl(var(--muted))"
            : "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground)/0.08) 50%, hsl(var(--muted)) 75%)",
          backgroundSize: isMobile ? undefined : "200% 100%",
          animation: isMobile ? undefined : "shimmer 1.4s infinite linear",
        }}
        data-testid="photo-loading-skeleton"
      />
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (n === 0) {
    return (
      <div
        className={`w-full relative flex items-center justify-center bg-muted ${className}`}
        style={{ height }}
        data-testid="photo-viewer-empty"
      >
        <svg viewBox="0 0 80 80" fill="none" className="w-16 h-16 opacity-20">
          <circle cx="40" cy="28" r="14" fill="currentColor" />
          <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
        </svg>
        {action && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2">{action}</div>
        )}
      </div>
    );
  }

  // ── Photo carousel ───────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`relative w-full select-none ${className}`}
      style={{
        height,
        background: "transparent",
        touchAction: "pan-y",
        padding: SHADOW_PAD,
        overflow: "hidden",
      }}
      data-testid="profile-photo-viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* ── Layer 1: Depth element ──────────────────────────────────────────────
          Static light card offset right+down, visible as thin slivers at the
          card edges at rest → physical "stacked cards" feel without any drag.
          Fades out when dragging so it doesn't intrude between the photo cards. */}
      {n > 1 && hasNext && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: SHADOW_PAD,
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

      {/* ── Layer 2: Peek card ──────────────────────────────────────────────────
          Neighbouring photo, fully offscreen at rest. Enters from its leading
          edge during drag — the rounded corner arrives first, never a flat strip
          of interior content. Constant CARD_GAP between the two cards. */}
      {n > 1 && peekIdx !== safeIdx && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: SHADOW_PAD,
            borderRadius: CARD_RADIUS,
            overflow: "hidden",
            boxShadow: CARD_SHADOW,
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

      {/* ── Layer 3: Current card ───────────────────────────────────────────────
          Active photo + gradient + nameSlot + action inside, all clipped to the
          card's rounded corners and moving together as one unit during drag. */}
      <div
        style={{
          position: "absolute",
          inset: SHADOW_PAD,
          borderRadius: CARD_RADIUS,
          overflow: "hidden",
          boxShadow: CARD_SHADOW,
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

        {/* Bottom gradient — clips to card's rounded corners */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)",
            zIndex: 1,
          }}
        />

        {/* nameSlot — inside the card so it clips at rounded corners */}
        {nameSlot && (
          <div
            style={{
              position: "absolute",
              bottom: 50,
              left: 12,
              right: 12,
              zIndex: 2,
              pointerEvents: "none",
            }}
          >
            <div style={{ pointerEvents: "auto" }}>{nameSlot}</div>
          </div>
        )}

        {/* action — bottom-right of the card */}
        {action && (
          <div
            style={{
              position: "absolute",
              bottom: 12,
              right: 10,
              zIndex: 3,
              pointerEvents: "none",
            }}
          >
            <div style={{ pointerEvents: "auto" }}>{action}</div>
          </div>
        )}
      </div>

      {/* ── Layer 4: Photo bubble overlay ───────────────────────────────────────
          Plays the entrance animation on tap/arrow navigation.  Positioned at the
          same inset as the current card so it clips at identical rounded corners. */}
      {photoOverlay && (
        <div
          key={photoOverlay.id}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: SHADOW_PAD,
            zIndex: 5,
            borderRadius: CARD_RADIUS,
            overflow: "hidden",
            animation: `${photoOverlay.direction === "fwd" ? "photoEnterRight" : "photoEnterLeft"} 0.42s cubic-bezier(0.16, 1, 0.3, 1) both`,
          }}
        >
          <img
            src={photoOverlay.src}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center top",
              display: "block",
            }}
          />
        </div>
      )}

      {/* Arrow buttons — outside all cards, stay fixed during drag */}
      {n > 1 && safeIdx > 0 && (
        <button
          onClick={e => {
            e.stopPropagation();
            navigatePhoto(safeIdx - 1, "bwd");
          }}
          onPointerDown={e => e.stopPropagation()}
          aria-label="Previous photo"
          data-testid="button-viewer-prev"
          style={{
            position: "absolute",
            left: SHADOW_PAD + 4,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 10,
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
        >
          <ChevronLeft style={{ width: 16, height: 16, color: "white" }} />
        </button>
      )}
      {n > 1 && safeIdx < n - 1 && (
        <button
          onClick={e => {
            e.stopPropagation();
            navigatePhoto(safeIdx + 1, "fwd");
          }}
          onPointerDown={e => e.stopPropagation()}
          aria-label="Next photo"
          data-testid="button-viewer-next"
          style={{
            position: "absolute",
            right: SHADOW_PAD + 4,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 10,
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
        >
          <ChevronRight style={{ width: 16, height: 16, color: "white" }} />
        </button>
      )}

      {/* Dot indicators — outside all cards, stationary during drag */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: SHADOW_PAD + 8,
            left: SHADOW_PAD + 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === safeIdx ? 24 : 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor:
                  i === safeIdx ? "white" : "rgba(255,255,255,0.42)",
                transition: "width 0.25s ease, background-color 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
});
