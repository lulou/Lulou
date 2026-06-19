import { memo, useState, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";
import { isMobile } from "@/lib/perf";

export const PROFILE_PHOTO_HEIGHT = 420;

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
 * Profile photo viewer — floating-card architecture.
 *
 * CONTAINER STRUCTURE (back to front):
 *
 * 1. Outer div  — pure positioning/gesture layer.
 * 2. Shadow element  — box-shadow outside clip div, never clipped.
 * 3. Clip div  — overflow:hidden; hides offscreen peek card only.
 * 5. Peek card  (z:1) — enters from leading edge during drag.
 * 6. Current card  (z:2) — photo + gradient + nameSlot + action.
 * 7. Photo overlay  (z:5) — entrance animation on tap/arrow nav.
 * 8. Arrows / dots  — outside clip div, zIndex:10, always visible.
 *
 * COMMIT ANIMATION (no jump-cut):
 *   On release past threshold, dragX animates to ±(W+GAP).
 *   This slides current card fully off-screen and peek card to centre.
 *   After 340 ms the active index updates and dragX resets to 0.
 */

const CARD_RADIUS = 24;
const CARD_SHADOW = "0 4px 18px rgba(0,0,0,0.18)";
const CARD_GAP = 12;
const SPRING = "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)";
const COMMIT_MS = 340;

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
  const [committing, setCommitting] = useState(false);
  // suppressTransition = true for exactly one render during the index swap so
  // the current-card div snaps to centre without springing from off-screen.
  const [suppressTransition, setSuppressTransition] = useState(false);
  const [photoOverlay, setPhotoOverlay] = useState<{
    src: string;
    direction: "fwd" | "bwd";
    id: number;
  } | null>(null);

  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const peekCardRef = useRef<HTMLDivElement>(null);
  const pendingDragX = useRef(0);
  const rafRef = useRef<number | null>(null);
  const cardWidthRef = useRef(320);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    setInternalIdx(0);
    setDragX(0);
    setPhotoOverlay(null);
  }, [photos]);

  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

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

  // Measure card width once on mount so transform calculations start accurate.
  useLayoutEffect(() => {
    if (containerRef.current) {
      cardWidthRef.current = containerRef.current.offsetWidth;
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Block new gesture during commit animation or single-photo
    if (n <= 1 || committing) return;
    // Re-measure width at drag start (catches resize since mount)
    if (containerRef.current) cardWidthRef.current = containerRef.current.offsetWidth;
    // Restore peek card visibility if a previous snap-back hid it
    if (peekCardRef.current) peekCardRef.current.style.visibility = "";
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

    // Fire setIsDragging immediately (once per gesture) — no re-render cost
    if (!isDraggingRef.current) {
      isDraggingRef.current = true;
      setIsDragging(true);
    }

    // RAF-throttle setDragX to ≤60 Hz — eliminates per-event React re-renders
    pendingDragX.current = clamped;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        setDragX(pendingDragX.current);
        rafRef.current = null;
      });
    }
  };

  const commitDrag = (finalClientX: number) => {
    const g = gestureRef.current;
    g.pointerId = null;

    // Cancel any RAF pending from the last pointermove
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!isDraggingRef.current) {
      // Tap: navigate by tap zone
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

    const containerWidth = containerRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(containerWidth * 0.28, 90);
    const dx = finalClientX - g.startX;

    const willGoNext = dx < -threshold && safeIdx < n - 1;
    const willGoPrev = dx > threshold && safeIdx > 0;

    isDraggingRef.current = false;
    setIsDragging(false); // enables spring transition

    if (willGoNext || willGoPrev) {
      // ── Commit animation ──────────────────────────────────────────────────
      // Drive dragX to ±(W+GAP): current card exits fully, peek lands at 0.
      // After the spring settles, update the active index and reset dragX.
      const W = cardWidthRef.current;
      const targetDragX = willGoNext ? -(W + CARD_GAP) : (W + CARD_GAP);
      const targetIdx   = willGoNext ? safeIdx + 1 : safeIdx - 1;

      setCommitting(true);
      setDragX(targetDragX); // spring now active (isDragging just set false)

      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        // Suppress CSS transitions for this one render so the current-card div
        // snaps to centre (from its off-screen commit position) without springing,
        // and the peek-card div snaps off-screen without springing.
        // Both show the correct image at the correct place — no visible jump.
        setSuppressTransition(true);
        setCommitting(false);
        goTo(targetIdx);
        setDragX(0);
        // Re-enable transitions on the next frame after layout has settled.
        requestAnimationFrame(() => setSuppressTransition(false));
      }, COMMIT_MS);
    } else {
      // ── Snap-back ─────────────────────────────────────────────────────────
      // Hide peek card while spring carries it back across the screen.
      if (peekCardRef.current) {
        peekCardRef.current.style.visibility = "hidden";
        setTimeout(() => {
          if (peekCardRef.current) peekCardRef.current.style.visibility = "";
        }, COMMIT_MS + 40);
      }
      setDragX(0);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current.pointerId !== e.pointerId) return;
    commitDrag(e.clientX);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current.pointerId !== e.pointerId) return;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    gestureRef.current.pointerId = null;
    isDraggingRef.current = false;
    setIsDragging(false);
    setDragX(0);
  };

  // ── Derive photo sources ─────────────────────────────────────────────────
  const peekIdxRaw = dragX < 0 ? safeIdx + 1 : safeIdx > 0 ? safeIdx - 1 : safeIdx + 1;
  const peekIdx = Math.max(0, Math.min(n - 1, peekIdxRaw));
  const currentPhoto = photos[safeIdx] ?? "";
  const peekPhoto = photos[peekIdx] ?? "";

  // ── Premium motion transforms ─────────────────────────────────────────────
  const W = cardWidthRef.current;
  const progress = W > 0 ? Math.min(Math.abs(dragX) / W, 1) : 0;

  // Current card: shrinks (1→0.93), tilts (±3°), dips (0→8px) as it moves away
  const curScale = (1 - progress * 0.07).toFixed(4);
  const curRot   = W > 0 ? ((dragX / W) * 3).toFixed(2) : "0";
  const curTy    = (progress * 8).toFixed(1);
  const currentCardTransform =
    `translate3d(${dragX}px,${curTy}px,0) scale(${curScale}) rotate(${curRot}deg)`;

  // Peek card: grows (0.92→1.0) as it enters from its leading edge.
  // peekTx = peekBaseX + dragX.  When dragX = ±(W+GAP), peekTx = 0 (centre).
  const peekScale   = (0.92 + progress * 0.08).toFixed(4);
  const peekBaseX   = dragX > 0 ? -(W + CARD_GAP) : (W + CARD_GAP);
  const peekTx      = peekBaseX + dragX;
  const peekTransform = `translate3d(${peekTx}px,0,0) scale(${peekScale})`;

  // Transitions: off while finger is down OR during the one-frame index-swap
  // render so cards snap to their new positions without re-springing.
  const cardTransition = isDragging || suppressTransition ? "none" : SPRING;

  // ── Loading shimmer ────────────────────────────────────────────────────────
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

  // ── Empty state ────────────────────────────────────────────────────────────
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

  // ── Photo carousel ─────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`relative w-full select-none ${className}`}
      style={{
        height,
        touchAction: "pan-y",
      }}
      data-testid="profile-photo-viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {/* ── Shadow element ───────────────────────────────────────────────────
          Transparent div whose box-shadow bleeds freely around the card.
          Outside the clip div so it is never clipped by overflow:hidden. */}
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

      {/* ── Clip div ─────────────────────────────────────────────────────────
          overflow:hidden hides the offscreen peek card only.
          No padding (no cream frame), no background (no visible box).
          Cards at inset:0 → edge-to-edge, visually seamless. */}
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
            ref={peekCardRef}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: CARD_RADIUS,
              overflow: "hidden",
              zIndex: 1,
              transform: peekTransform,
              transition: cardTransition,
              willChange: "transform",
            }}
          >
            <img
              src={peekPhoto}
              alt=""
              draggable={false}
              onLoad={() => decodedPhotos.add(peekPhoto)}
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
            transform: currentCardTransform,
            transition: cardTransition,
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

          {/* Bottom gradient */}
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

          {/* nameSlot */}
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
              <div
                style={{ pointerEvents: "auto" }}
                onPointerDown={e => e.stopPropagation()}
                onPointerUp={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                {nameSlot}
              </div>
            </div>
          )}

          {/* action */}
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
              {/*
                stopPropagation on all three events prevents the outer
                container's pointer-gesture recognizer from seeing taps
                that originated inside the action slot.

                Without this, pointerdown bubbles up → onPointerDown calls
                setPointerCapture → pointerup is routed to the container →
                commitDrag runs with isDraggingRef=false → navigatePhoto
                fires, advancing the photo as a side-effect of the button tap.

                The arrow buttons already do this; the action slot must too.
              */}
              <div
                style={{ pointerEvents: "auto" }}
                onPointerDown={e => e.stopPropagation()}
                onPointerUp={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                {action}
              </div>
            </div>
          )}
        </div>

        {/* Photo bubble overlay — entrance animation on tap/arrow nav */}
        {photoOverlay && (
          <div
            key={photoOverlay.id}
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
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
      </div>

      {/* ── Arrow buttons ────────────────────────────────────────────────────
          Outside clip div → always visible over the photo, never clipped. */}
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
            left: 10,
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
            right: 10,
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

      {/* ── Dot indicators ───────────────────────────────────────────────────
          Outside clip div → stationary during drag; always visible. */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 14,
            left: 22,
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
