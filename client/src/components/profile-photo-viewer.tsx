import { memo, useState, useRef, useEffect, useLayoutEffect, type ReactNode } from "react";
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
 * Profile photo viewer with drag-pull navigation.
 *
 * Drag/swipe: photos follow the finger/mouse horizontally in real-time.
 *   Release past threshold  → commits to next/prev photo (animated spring).
 *   Release below threshold → snaps back.
 * Tap fallback: transparent tap-zone buttons cover left 40% / right 60%.
 *   A real drag calls e.preventDefault() during pointermove, which suppresses
 *   the click event. A plain tap (no drag) still fires click normally.
 * Arrow buttons and dot indicators update in sync.
 *
 * Pointer Events sequence (avoids the iOS pointercancel bug):
 *   pointerdown  — record start, save pointerId. NO setPointerCapture yet.
 *   pointermove  — wait for ≥5px dead zone, detect direction.
 *                  Vertical → release tracking (browser scrolls freely).
 *                  Horizontal confirmed → setPointerCapture NOW (safe: scroll
 *                  recognizer won't fire pointercancel once direction is known)
 *                  + touchAction:"none" + e.preventDefault().
 *   pointerup    — commit if past threshold, else spring back.
 *   pointercancel — browser reclaimed; snap back.
 * pointermove listener is { passive:false } so preventDefault() is honoured
 * even when an overflow-y-auto ancestor exists (Chrome/Android behaviour).
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

  // Refs for stale-closure safety — updated synchronously before effects run
  const idxRef = useRef(safeIdx);
  const nRef  = useRef(n);
  idxRef.current = safeIdx;
  nRef.current   = n;

  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs    = useRef<(HTMLDivElement | null)[]>([]);
  const isMounted    = useRef(false);
  const skipLayout   = useRef(false); // drag handler pre-animated — skip layout re-run

  // ── Direct-DOM slide positioning (zero React re-renders during drag) ────────
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

  // Re-position on photos array length change (handles async photo load)
  useLayoutEffect(() => {
    applyPositions(idxRef.current, 0, false);
  }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync when committed index changes
  useLayoutEffect(() => {
    const shouldAnimate = isMounted.current;
    isMounted.current = true;
    if (skipLayout.current) { skipLayout.current = false; return; }
    applyPositions(safeIdx, 0, shouldAnimate);
  }, [safeIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preload current ±1
  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  // Reset index when profile changes (photos array replaced entirely)
  const prevPhotosRef = useRef(photos);
  if (prevPhotosRef.current !== photos) {
    prevPhotosRef.current = photos;
    if (photoIndex !== 0) setPhotoIndex(0);
  }

  // ── Drag / swipe via Pointer Events ────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let pId: number | null = null;
    let startX = 0, startY = 0;
    let dir: "h" | "v" | null = null;

    const commit = (dx: number) => {
      const threshold = Math.max(44, (el.offsetWidth || 300) * 0.22);
      el.style.touchAction = "pan-y";
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

    const onDown = (e: PointerEvent) => {
      if (pId !== null) return;
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
        if (dir === "v") { pId = null; dir = null; return; } // let scroll take over

        // Horizontal confirmed — safe to capture now (iOS won't fire pointercancel)
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
      pId = null; dir = null;
      el.style.touchAction = "pan-y";
      if (capturedDir === "h") commit(dx);
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
    return () => {
      el.removeEventListener("pointerdown",   onDown);
      el.removeEventListener("pointermove",   onMove);
      el.removeEventListener("pointerup",     onUp);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      ref={containerRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, touchAction: "pan-y", background: "hsl(var(--muted))" }}
      data-testid="profile-photo-viewer"
    >
      {/* Photo slides — position:absolute so "100%" == container width */}
      {photos.map((photo, i) => (
        <div
          key={i}
          ref={el => { slideRefs.current[i] = el; }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // transform is owned entirely by applyPositions — not set in JSX
            willChange: Math.abs(i - safeIdx) <= 1 ? "transform" : "auto",
          }}
          data-testid={`carousel-slide-${i}`}
        >
          {/* Only decode images for current ±1 to save GPU memory */}
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

      {/* Bottom gradient — pointer-events:none so it never swallows taps */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Caller-supplied overlay (close button, etc.) */}
      {children}

      {/* Tap zones — fallback for tap-only interactions.
          A real horizontal drag calls e.preventDefault() in pointermove,
          which suppresses the click event so both coexist cleanly. */}
      {n > 1 && safeIdx > 0 && (
        <button
          aria-label="Previous photo"
          data-testid="button-viewer-tap-prev"
          onClick={() => setPhotoIndex(i => Math.max(0, i - 1))}
          style={{
            position: "absolute", top: 0, left: 0,
            width: "40%", height: "100%",
            background: "transparent", border: "none",
            cursor: "w-resize", zIndex: 30,
          }}
        />
      )}
      {n > 1 && safeIdx < n - 1 && (
        <button
          aria-label="Next photo"
          data-testid="button-viewer-tap-next"
          onClick={() => setPhotoIndex(i => Math.min(nRef.current - 1, i + 1))}
          style={{
            position: "absolute", top: 0, right: 0,
            width: "60%", height: "100%",
            background: "transparent", border: "none",
            cursor: "e-resize", zIndex: 30,
          }}
        />
      )}

      {/* Arrow buttons — always above tap zones */}
      {n > 1 && safeIdx > 0 && (
        <button
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

      {/* Bottom bar: dots + action */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4" style={{ zIndex: 40 }}>
        <div className="flex items-end justify-between">
          {n > 1 ? (
            <div className="flex items-center gap-1.5 pb-0.5 pointer-events-none">
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
          {action}
        </div>
        {nameSlot && <div className="mt-2">{nameSlot}</div>}
      </div>
    </div>
  );
});
