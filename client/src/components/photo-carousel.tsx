import { useRef, useEffect, useLayoutEffect, useCallback, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";

/**
 * Tactile photo carousel — photos physically follow the finger/mouse in real-time.
 *
 * Design mirrors discover.tsx SlideCards and intent.tsx wheel drag:
 *   - Slides: position:absolute so translateX(calc((i–idx)*100%)) needs no JS measurement
 *   - Drag: direct DOM transform manipulation (zero React re-renders = 60fps)
 *   - Release: spring to next/prev from wherever drag left off, or snap back
 *   - Non-passive touchmove via addEventListener → preventDefault during horizontal drag
 *     prevents page scroll without breaking vertical profile scrolling
 *   - skipAnimation flag prevents useLayoutEffect from restarting an animation that
 *     the drag handler already initiated
 */

interface PhotoCarouselProps {
  photos: string[];
  height?: number | string;
  /** Controlled index. If provided, also pass onIndexChange. */
  currentIndex?: number;
  onIndexChange?: (idx: number) => void;
  showArrows?: boolean;
  showDots?: boolean;
  /**
   * Pixel gap between slides. Creates visible separation — the container background
   * shows briefly between the exiting and entering cards during the spring animation.
   * Default 16. Pass 0 for a seamless strip.
   */
  gap?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Absolute-positioned overlay content (close button, name, gradients…) */
  children?: ReactNode;
}

export function PhotoCarousel({
  photos,
  height = 300,
  currentIndex: controlledIdx,
  onIndexChange,
  showArrows = true,
  showDots = true,
  gap = 16,
  className = "",
  style,
  children,
}: PhotoCarouselProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);

  const [internalIdx, setInternalIdx] = useState(0);
  const [dotIdx, setDotIdx] = useState(0); // drives dot/arrow render only

  const idx = controlledIdx !== undefined ? controlledIdx : internalIdx;

  // Refs for stale-closure safety in event handlers — updated synchronously during render
  const idxRef = useRef(idx);
  const nRef = useRef(photos.length);
  const gapRef = useRef(gap);
  const isMounted = useRef(false);
  const skipNextLayoutEffect = useRef(false); // set when drag handler pre-animates

  // Update inline during render so they're current before any useLayoutEffect runs
  idxRef.current = idx;
  nRef.current = photos.length;
  gapRef.current = gap;

  /**
   * Apply CSS transforms to all slides directly.
   * Each slide: translateX(calc((i – currentIdx) * (100% + gap)) + dragOffsetPx)
   * "100%" = slide's own width = container width (position:absolute; width:100%).
   * The gap adds visible space between cards during the spring animation so each
   * photo feels like a separate card entering/exiting, not a connected strip.
   */
  const applyPositions = useCallback((currentIdx: number, dragOffset: number, animated: boolean) => {
    const g = gapRef.current;
    const transition = animated ? "transform 0.35s cubic-bezier(0.25, 1, 0.5, 1)" : "none";
    const step = g === 0 ? "100%" : `(100% + ${g}px)`;
    slideRefs.current.forEach((el, i) => {
      if (!el) return;
      el.style.transition = transition;
      el.style.transform = dragOffset === 0
        ? `translateX(calc(${i - currentIdx} * ${step}))`
        : `translateX(calc(${i - currentIdx} * ${step} + ${dragOffset}px))`;
    });
  }, []);

  /**
   * Commit a new photo index.
   * alreadyAnimated = true when the drag handler called applyPositions first —
   * tells useLayoutEffect to skip re-animating to the same destination.
   */
  const commitIdx = useCallback((newIdx: number, alreadyAnimated = false) => {
    const clamped = Math.max(0, Math.min(nRef.current - 1, newIdx));
    idxRef.current = clamped;
    skipNextLayoutEffect.current = alreadyAnimated;
    if (controlledIdx === undefined) setInternalIdx(clamped);
    onIndexChange?.(clamped);
    setDotIdx(clamped);
  }, [controlledIdx, onIndexChange]);

  // Re-position slides whenever the photos array is populated or its length changes.
  // This is the critical fix for async photo loading: photos start as [] then arrive
  // as [url1, url2, ...]. The slide <div>s are created in that render but idx hasn't
  // changed, so the [idx] effect below would NOT fire. Without this effect all slides
  // sit stacked at translateX(0) — the last one renders on top looking like a wrong photo.
  useLayoutEffect(() => {
    applyPositions(idxRef.current, 0, false); // instant, no animation
  }, [photos.length, applyPositions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync position whenever committed index changes (animated except on first mount)
  useLayoutEffect(() => {
    const shouldAnimate = isMounted.current; // capture BEFORE setting to true
    isMounted.current = true;
    setDotIdx(idx);
    if (skipNextLayoutEffect.current) {
      // Drag handler already animated to this position — don't restart it
      skipNextLayoutEffect.current = false;
      return;
    }
    applyPositions(idx, 0, shouldAnimate); // false on first mount → no animation
  }, [idx, applyPositions]);

  // Preload only the current slide and its immediate neighbours (prev + next).
  // Decoding just three images avoids saturating the browser's decode queue with
  // all slides at once, while still ensuring the photos the user is most likely
  // to see next are ready in the decoded-bitmap cache before they swipe.
  useEffect(() => {
    [dotIdx - 1, dotIdx, dotIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, dotIdx]);

  // ── Drag / swipe — unified Pointer Events (mouse + touch + stylus) ───────
  //
  // Sequence:
  //   1. pointerdown  — record start position, save pointerId. DO NOT capture
  //                     yet: setPointerCapture in pointerdown causes the iOS
  //                     scroll recognizer to fire pointercancel immediately,
  //                     resetting state before any movement is measured.
  //   2. pointermove  — wait for ≥5px movement (dead zone), then lock direction.
  //   3a. direction="h" — call setPointerCapture (safe now: horizontal intent
  //                        is confirmed, scroll recognizer won't claim it) +
  //                        touchAction:"none" + preventDefault. Move slides 1:1.
  //   3b. direction="v" — drop tracking (pId=null); browser scrolls freely.
  //   4. pointerup    — commit index if past threshold, else spring back.
  //   5. pointercancel — browser reclaimed gesture; restore and snap back.
  //   No pointerleave listener — without early capture the pointer can exit the
  //   element bounds before direction is determined; pointerleave would kill the
  //   gesture. Touch has implicit capture so moves still arrive; mouse stays
  //   within the element for the brief dead-zone window in practice.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let pStartX = 0, pStartY = 0;
    let pDir: "h" | "v" | null = null;
    let pId: number | null = null;

    const endDrag = (finalDx: number) => {
      const w = el.offsetWidth || 1;
      const threshold = Math.max(44, w * 0.22);
      el.style.touchAction = "pan-y";
      pId = null;
      pDir = null;
      if (Math.abs(finalDx) >= threshold) {
        const newIdx = finalDx < 0
          ? Math.min(idxRef.current + 1, nRef.current - 1)
          : Math.max(idxRef.current - 1, 0);
        if (newIdx !== idxRef.current) {
          applyPositions(newIdx, 0, true);
          commitIdx(newIdx, true);
          return;
        }
      }
      applyPositions(idxRef.current, 0, true);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (pId !== null) return;
      if ((e.target as HTMLElement).closest("button, a, [role='button']")) return;
      pStartX = e.clientX;
      pStartY = e.clientY;
      pDir = null;
      pId = e.pointerId;
      // No setPointerCapture here — see comment above.
      applyPositions(idxRef.current, 0, false);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      const dx = e.clientX - pStartX;
      const dy = e.clientY - pStartY;

      if (!pDir) {
        if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // dead zone
        pDir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";

        if (pDir === "v") {
          // Vertical — release tracking, let scroll container take over.
          pId = null;
          pDir = null;
          return;
        }

        // Horizontal confirmed — now safe to capture.
        el.setPointerCapture(e.pointerId);
        el.style.touchAction = "none";
        e.preventDefault();
      }

      if (pDir === "h") {
        e.preventDefault();
        applyPositions(idxRef.current, dx, false);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      const capturedDir = pDir;
      const capturedDx = e.clientX - pStartX;
      pId = null;
      pDir = null;
      el.style.touchAction = "pan-y";
      if (capturedDir === "h") {
        endDrag(capturedDx);
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (pId === null || e.pointerId !== pId) return;
      pId = null;
      pDir = null;
      el.style.touchAction = "pan-y";
      applyPositions(idxRef.current, 0, true);
    };

    el.addEventListener("pointerdown",   onPointerDown);
    // passive:false required: Chrome/Android marks pointermove passive when an
    // overflow-y-auto ancestor exists, silently ignoring e.preventDefault().
    // Without this, the scroll container claims the gesture before we can set
    // touchAction:"none", and the browser fires pointercancel instead of
    // delivering horizontal pointermove events to our handler.
    el.addEventListener("pointermove",   onPointerMove, { passive: false });
    el.addEventListener("pointerup",     onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);

    return () => {
      el.removeEventListener("pointerdown",   onPointerDown);
      el.removeEventListener("pointermove",   onPointerMove);
      el.removeEventListener("pointerup",     onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [applyPositions, commitIdx]);

  const n = photos.length;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, touchAction: "pan-y", background: "hsl(var(--muted))", ...style }}
      data-testid="photo-carousel"
    >
      {n === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <svg viewBox="0 0 80 80" fill="none" className="w-16 h-16 opacity-20">
            <circle cx="40" cy="28" r="14" fill="currentColor" />
            <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
          </svg>
        </div>
      )}

      {/* Slides — position:absolute so 100% == container width, no JS measurement */}
      {photos.map((photo, i) => (
        <div
          key={i}
          ref={el => { slideRefs.current[i] = el; }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            background: "hsl(var(--muted))",
            // Only promote slides adjacent to the visible one to their own GPU
            // compositing layer. Applying willChange to every slide creates N
            // layers (one per photo) which wastes GPU memory on mobile.
            // Inactive slides use "auto" — no layer, no VRAM cost.
            willChange: Math.abs(i - dotIdx) <= 1 ? "transform" : "auto",
            // transform NOT set in JSX — owned entirely by applyPositions
          }}
          data-testid={`carousel-slide-${i}`}
        >
          {/* Load ±1 from current index; everything else is an unloaded placeholder */}
          {Math.abs(i - dotIdx) <= 1 && (
            <img
              src={photo}
              alt={`Photo ${i + 1}`}
              loading={i === dotIdx ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
                // Start fully visible if already in the decoded-bitmap cache,
                // otherwise fade in once the browser finishes decoding.
                // 80ms is imperceptible yet still prevents a hard pop.
                opacity: decodedPhotos.has(photo) ? 1 : 0,
                transition: "opacity 0.08s ease",
              }}
              onLoad={(e) => {
                // Mark decoded globally so future mounts skip the fade
                decodedPhotos.add(photo);
                // Set opacity directly — avoids a React re-render/setState cycle
                (e.currentTarget as HTMLImageElement).style.opacity = "1";
              }}
              data-testid={`img-carousel-photo-${i}`}
            />
          )}
        </div>
      ))}

      {/* Optional built-in arrow buttons */}
      {showArrows && n > 1 && dotIdx > 0 && (
        <button
          className="absolute left-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{ background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          onClick={() => commitIdx(dotIdx - 1)}
          data-testid="button-carousel-prev"
          aria-label="Previous photo"
        >
          <ChevronLeft className="w-4 h-4 text-white" />
        </button>
      )}
      {showArrows && n > 1 && dotIdx < n - 1 && (
        <button
          className="absolute right-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{ background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          onClick={() => commitIdx(dotIdx + 1)}
          data-testid="button-carousel-next"
          aria-label="Next photo"
        >
          <ChevronRight className="w-4 h-4 text-white" />
        </button>
      )}

      {/* Optional built-in pill dot indicators */}
      {showDots && n > 1 && (
        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-1.5 pointer-events-none z-20">
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === dotIdx ? 22 : 7,
                height: 7,
                borderRadius: 3.5,
                background: i === dotIdx ? "white" : "rgba(255,255,255,0.42)",
                transition: "width 0.25s ease, background 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}

      {/* Caller-supplied overlay content (close buttons, name, gradients…) */}
      {children}
    </div>
  );
}
