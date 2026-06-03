import { memo, useState, useRef, useLayoutEffect, useEffect, useCallback, type ReactNode } from "react";
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
 * Profile photo viewer with drag-pull + tap navigation.
 *
 * Bug fixes applied:
 *
 * FIX 1 — Callback ref instead of useEffect([]):
 *   useEffect(fn, []) runs once after the FIRST render. If that render is the
 *   loading shimmer or empty-state (no container div), containerRef is null,
 *   the effect bails, and listeners are never attached when photos later arrive.
 *   A callback ref fires exactly when the element mounts/unmounts regardless of
 *   render order, guaranteeing listeners are always attached after photo load.
 *
 * FIX 2 — <div> tap zones instead of <button>:
 *   Browsers (Chrome/Safari/Firefox) apply implicit pointer capture to <button>
 *   on pointerdown. This locks subsequent pointermove events to the button,
 *   interfering with our explicit el.setPointerCapture() call. Plain <div>
 *   elements have no implicit pointer capture. Tap detection is moved into onUp:
 *   if no directional movement was detected (dir stays null), the pointer release
 *   position determines prev/next.
 */
export const ProfilePhotoViewer = memo(function ProfilePhotoViewer({
  photos,
  isLoading = false,
  height = PROFILE_PHOTO_HEIGHT,
  className = "",
  action,
  nameSlot,
  children,
}: ProfilePhotoViewerProps) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const n = photos.length;
  const safeIdx = n === 0 ? 0 : Math.min(photoIndex, n - 1);

  // Stale-closure-safe refs — updated synchronously on every render
  const idxRef = useRef(safeIdx);
  const nRef   = useRef(n);
  idxRef.current = safeIdx;
  nRef.current   = n;

  const slideRefs  = useRef<(HTMLDivElement | null)[]>([]);
  const isMounted  = useRef(false);
  const skipLayout = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Direct-DOM slide positioning — zero React re-renders during drag
  // applyPositions only reads slideRefs.current (always up to date), so it is
  // safe to call from inside the stable callback-ref closure.
  const applyPositions = (atIdx: number, dragOffset: number, animated: boolean) => {
    const tr = animated ? "transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)" : "none";
    slideRefs.current.forEach((el, i) => {
      if (!el) return;
      el.style.transition = tr;
      el.style.transform  = dragOffset === 0
        ? `translateX(calc(${i - atIdx} * 100%))`
        : `translateX(calc(${i - atIdx} * 100% + ${dragOffset}px))`;
    });
  };

  // ── Callback ref ─────────────────────────────────────────────────────────────
  // Called with the element when it mounts, null when it unmounts.
  // useCallback(fn, []) keeps identity stable so React does not re-run it on
  // every render (which would cause a mount→unmount→remount loop).
  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous listeners before re-attaching (or when unmounting)
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;

    let pId: number | null = null;
    let startX = 0, startY = 0;
    let dir: "h" | "v" | null = null;

    const commitDrag = (dx: number) => {
      el.style.touchAction = "pan-y";
      const threshold = Math.max(44, (el.offsetWidth || 300) * 0.22);
      if (Math.abs(dx) >= threshold) {
        const next = dx < 0
          ? Math.min(idxRef.current + 1, nRef.current - 1)
          : Math.max(idxRef.current - 1, 0);
        if (next !== idxRef.current) {
          applyPositions(next, 0, true);
          skipLayout.current = true;
          setPhotoIndex(next);
          return;
        }
      }
      applyPositions(idxRef.current, 0, true);
    };

    // Tap: press and release with no directional movement (dir stayed null)
    const commitTap = (tapClientX: number) => {
      const rect = el.getBoundingClientRect();
      const tapX = tapClientX - rect.left;
      const goRight = tapX > el.offsetWidth * 0.4; // left 40% = prev, rest = next
      if (goRight && idxRef.current < nRef.current - 1) {
        setPhotoIndex(idxRef.current + 1);
      } else if (!goRight && idxRef.current > 0) {
        setPhotoIndex(idxRef.current - 1);
      }
    };

    const onDown = (e: PointerEvent) => {
      if (pId !== null) return;
      // Skip drags that originate on the frosted arrow buttons
      if ((e.target as HTMLElement).closest("[data-drag-ignore]")) return;
      pId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dir = null;
      applyPositions(idxRef.current, 0, false); // cancel any in-progress spring
    };

    const onMove = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!dir) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // dead zone
        dir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
        if (dir === "v") {
          // Vertical intent — release tracking so the scroll container takes over
          pId = null; dir = null; return;
        }
        // Horizontal confirmed — NOW safe to capture (iOS won't fire pointercancel)
        el.setPointerCapture(e.pointerId);
        el.style.touchAction = "none";
        e.preventDefault();
      }

      if (dir === "h") {
        e.preventDefault();
        applyPositions(idxRef.current, dx, false);
      }
    };

    const onUp = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      const capturedDir = dir;
      const dx = e.clientX - startX;
      const upClientX = e.clientX;
      pId = null; dir = null;
      el.style.touchAction = "pan-y";

      if (capturedDir === "h") {
        commitDrag(dx);
      } else if (capturedDir === null) {
        // No directional movement detected → treat as a tap
        commitTap(upClientX);
      }
      // capturedDir === "v" is already handled in onMove (pId cleared there)
    };

    const onCancel = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      pId = null; dir = null;
      el.style.touchAction = "pan-y";
      applyPositions(idxRef.current, 0, true);
    };

    el.addEventListener("pointerdown",   onDown);
    el.addEventListener("pointermove",   onMove,   { passive: false });
    el.addEventListener("pointerup",     onUp);
    el.addEventListener("pointercancel", onCancel);

    cleanupRef.current = () => {
      el.removeEventListener("pointerdown",   onDown);
      el.removeEventListener("pointermove",   onMove);
      el.removeEventListener("pointerup",     onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-position immediately when photos array length changes (async photo load)
  useLayoutEffect(() => {
    applyPositions(idxRef.current, 0, false);
  }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animated sync whenever committed index changes
  useLayoutEffect(() => {
    const shouldAnimate = isMounted.current;
    isMounted.current = true;
    if (skipLayout.current) { skipLayout.current = false; return; }
    applyPositions(safeIdx, 0, shouldAnimate);
  }, [safeIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preload current ±1 neighbours
  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  // Reset to photo 0 when a new profile's photos array arrives
  const prevPhotosRef = useRef(photos);
  if (prevPhotosRef.current !== photos) {
    prevPhotosRef.current = photos;
    if (photoIndex !== 0) setPhotoIndex(0);
  }

  // ── Loading shimmer ─────────────────────────────────────────────────────────
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
          animation:      isMobile ? undefined : "shimmer 1.4s infinite linear",
        }}
        data-testid="photo-loading-skeleton"
      />
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
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
        {action && <div className="absolute bottom-5 left-1/2 -translate-x-1/2">{action}</div>}
        {children}
      </div>
    );
  }

  // ── Photo viewer ────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerCallbackRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, touchAction: "pan-y", background: "hsl(var(--muted))" }}
      data-testid="profile-photo-viewer"
    >
      {/* Photo slides — position:absolute so "100%" == container width.
          Transform is owned entirely by applyPositions (not set in JSX). */}
      {photos.map((photo, i) => (
        <div
          key={i}
          ref={el => { slideRefs.current[i] = el; }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            willChange: Math.abs(i - safeIdx) <= 1 ? "transform" : "auto",
          }}
          data-testid={`carousel-slide-${i}`}
        >
          {Math.abs(i - safeIdx) <= 1 && (
            <img
              src={photo}
              alt={`Photo ${i + 1}`}
              loading={i === safeIdx ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
                opacity: decodedPhotos.has(photo) ? 1 : 0,
                transition: "opacity 0.08s ease",
              }}
              onLoad={e => {
                decodedPhotos.add(photo);
                (e.currentTarget as HTMLImageElement).style.opacity = "1";
              }}
              data-testid={`img-carousel-photo-${i}`}
            />
          )}
        </div>
      ))}

      {/* Bottom gradient — pointer-events:none so drag passes through */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Caller-supplied overlay (close button, etc.) */}
      {children}

      {/* Arrow buttons — data-drag-ignore prevents drag from starting on them.
          These are small (36×36 px) centred targets; click still works. */}
      {n > 1 && safeIdx > 0 && (
        <button
          data-drag-ignore
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => setPhotoIndex(i => Math.max(0, i - 1))}
          data-testid="button-viewer-prev"
          aria-label="Previous photo"
        >
          <ChevronLeft className="w-4 h-4 text-white" />
        </button>
      )}
      {n > 1 && safeIdx < n - 1 && (
        <button
          data-drag-ignore
          className="absolute right-2.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => setPhotoIndex(i => Math.min(nRef.current - 1, i + 1))}
          data-testid="button-viewer-next"
          aria-label="Next photo"
        >
          <ChevronRight className="w-4 h-4 text-white" />
        </button>
      )}

      {/* Bottom bar: dots + action slot */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4" style={{ zIndex: 40, pointerEvents: "none" }}>
        <div className="flex items-end justify-between">
          {n > 1 ? (
            <div className="flex items-center gap-1.5 pb-0.5">
              {photos.map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: i === safeIdx ? 24 : 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: i === safeIdx ? "white" : "rgba(255,255,255,0.42)",
                    transition: "width 0.25s ease, background-color 0.25s ease",
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>
          ) : (
            <div />
          )}
          <div style={{ pointerEvents: "auto" }}>{action}</div>
        </div>
        {nameSlot && <div className="mt-2" style={{ pointerEvents: "auto" }}>{nameSlot}</div>}
      </div>
    </div>
  );
});
