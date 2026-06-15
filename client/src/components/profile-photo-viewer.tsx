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
 * Profile photo viewer — stacked cards architecture.
 *
 * Why stacked cards instead of a flex strip:
 *   The old Embla / flex-strip approach shared one overflow:hidden clipping boundary.
 *   Every photo lived in a connected rectangular frame, so adjacent photos always entered
 *   from the container's sharp rectangular edge (not their own rounded corner), and
 *   box-shadows on inner divs were fully clipped — never visible. The result looked like
 *   a connected strip of panels, not floating cards.
 *
 *   Stacked cards: two photos are rendered at absolute positions inside a container that
 *   has padding:SHADOW_PAD + overflow:hidden.  The CSS overflow:hidden clips at the
 *   PADDING BOX boundary, so the card's box-shadow that bleeds into the padding zone IS
 *   visible — giving each photo a genuine floating-card appearance with a drop shadow.
 *
 * Architecture:
 *   - Peek card (z-index 0): the neighbour photo, stationary and visible as the current
 *     card translates during a drag.
 *   - Current card (z-index 1): the active photo, translates with dragX in real-time.
 *     Gradient, nameSlot, and action are rendered INSIDE this card so they clip to its
 *     rounded corners and move with it during drag.
 *   - Photo bubble overlay (z-index 5): same position as the card; plays the entrance
 *     animation on tap/arrow navigation.
 *   - Dots and arrows are outside both cards so they remain stationary during drag.
 *
 * Gesture handling mirrors PhotoCarousel:
 *   - Pointer events with setPointerCapture for reliable cross-device drag.
 *   - Non-passive touchmove blocks iOS Safari scroll hijack on horizontal gestures.
 *   - Tap navigation (< 5 px movement) triggers the bubble animation.
 *   - Drag navigation skips the bubble — the peek card already shows the destination.
 */

const SHADOW_PAD = 6;
const CARD_RADIUS = 24;
const CARD_SHADOW = "0 3px 14px rgba(0,0,0,0.18)";

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

  const peekIdxRaw = dragX < 0 ? safeIdx + 1 : safeIdx > 0 ? safeIdx - 1 : safeIdx + 1;
  const peekIdx = Math.max(0, Math.min(n - 1, peekIdxRaw));
  const currentPhoto = photos[safeIdx] ?? "";
  const peekPhoto = photos[peekIdx] ?? "";

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
      {/* Peek card — neighbour photo, stationary behind the current card */}
      {n > 1 && peekIdx !== safeIdx && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: SHADOW_PAD,
            borderRadius: CARD_RADIUS,
            overflow: "hidden",
            boxShadow: CARD_SHADOW,
            zIndex: 0,
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

      {/* Current card — active photo + gradient + name/action inside so they
          clip to the card's rounded corners and move together during drag */}
      <div
        style={{
          position: "absolute",
          inset: SHADOW_PAD,
          borderRadius: CARD_RADIUS,
          overflow: "hidden",
          boxShadow: CARD_SHADOW,
          zIndex: 1,
          transform: `translateX(${dragX}px)`,
          transition: isDragging
            ? "none"
            : "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)",
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

      {/* Photo bubble overlay — entrance animation on tap/arrow navigation.
          Positioned identically to the card so it clips at the same rounded
          corners, creating the "bubble slide" effect over the settled photo. */}
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

      {/* Arrow buttons — outside the card so they stay fixed during drag */}
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

      {/* Dot indicators — outside the card, stationary during drag */}
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
