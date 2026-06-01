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

  // Stable ref callbacks — one per slide index, created once and never recreated.
  //
  // If ref callbacks are inline arrow functions, React treats each render's arrow as
  // a NEW function reference.  React 18 therefore calls:
  //   old callback(null)  →  slideRefs.current[i] = null   ← brief null window
  //   new callback(el)    →  slideRefs.current[i] = el
  //
  // In the Chatroom, MatchChat re-renders constantly (realtime messages, 5-second
  // polling, typing indicators).  Any touchmove that fires inside that null window
  // finds slideRefs.current[i] === null, applyPositions skips the slide, and the
  // photo freezes for that frame — making the drag feel like an instant snap.
  //
  // Storing ONE stable function per index means React sees the same reference every
  // render → skips the null-cleanup step → slideRefs is always populated mid-drag.
  const slideRefFns = useRef<Array<(el: HTMLDivElement | null) => void>>([]);
  // Lazily extend to cover any new photos added
  while (slideRefFns.current.length < photos.length) {
    const i = slideRefFns.current.length;
    slideRefFns.current.push((el) => { slideRefs.current[i] = el; });
  }

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
    // Pixel step used only for scale interpolation — doesn't affect layout math.
    // containerRef is a stable ref so safe to read inside this callback.
    const cw = containerRef.current?.offsetWidth ?? 0;
    const pxStep = cw > 0 ? cw + g : 0;
    slideRefs.current.forEach((el, i) => {
      if (!el) return;
      el.style.transition = transition;
      const txExpr = dragOffset === 0
        ? `calc(${i - currentIdx} * ${step})`
        : `calc(${i - currentIdx} * ${step} + ${dragOffset}px)`;
      if (pxStep > 0) {
        // dist: 0 = perfectly centred, 1 = fully at adjacent slot.
        // Incoming photo scales from 0.95 → 1.0 as it reaches centre;
        // outgoing photo scales from 1.0 → 0.95 as it leaves.
        const pxOff = (i - currentIdx) * pxStep + dragOffset;
        const dist = Math.min(1, Math.abs(pxOff) / pxStep);
        const scale = (1 - 0.05 * dist).toFixed(4);
        el.style.transform = `translateX(${txExpr}) scale(${scale})`;
      } else {
        el.style.transform = `translateX(${txExpr})`;
      }
    });
  }, []); // containerRef & slideRefs are stable refs — safe without dep listing

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
    setDotIdx(clamped); // immediate dot/arrow update
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

  // ── Unified drag via Pointer Events (mouse + touch) ─────────────────────
  //
  // Why Pointer Events instead of Touch Events:
  //   The photo carousel lives inside scrollable panels (matches ProfilePanel,
  //   mobile bottom sheet) that register their own passive touchstart listeners.
  //   Once the browser commits to a scroll gesture on touchstart it ignores
  //   subsequent e.preventDefault() calls in touchmove — our horizontal drag
  //   was being silently swallowed.
  //
  //   Pointer Events + setPointerCapture solves this: once we confirm the
  //   gesture is horizontal we capture the pointerId, which locks all future
  //   pointer events to our element and prevents any parent from stealing them.
  //
  //   touch-action:"none" (set on the container) tells the browser not to
  //   pre-claim any gesture at all, so the very first pointermove is ours.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let startX = 0, startY = 0;
    let dir: "h" | "v" | null = null;
    let activeId: number | null = null;

    const settle = (finalDx: number) => {
      const w = el.offsetWidth || 1;
      // Lower threshold (18 % / min 30 px) so a normal swipe always commits.
      const threshold = Math.max(30, w * 0.18);
      if (Math.abs(finalDx) >= threshold) {
        const newIdx = finalDx < 0
          ? Math.min(idxRef.current + 1, nRef.current - 1)
          : Math.max(idxRef.current - 1, 0);
        if (newIdx !== idxRef.current) {
          applyPositions(newIdx, 0, true);
          commitIdx(newIdx, true); // skip useLayoutEffect re-animation
          return;
        }
      }
      applyPositions(idxRef.current, 0, true); // spring back
    };

    const onPointerDown = (e: PointerEvent) => {
      if (activeId !== null) return; // already tracking a pointer
      // Don't swallow button/link clicks — let them fire normally.
      const target = e.target as HTMLElement;
      if (target.closest("button, a, [role='button']")) return;
      activeId = e.pointerId;
      startX  = e.clientX;
      startY  = e.clientY;
      dir     = null;
      applyPositions(idxRef.current, 0, false); // cancel any ongoing spring
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dir) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // dead-zone
        dir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
        if (dir === "v") {
          // Vertical intent — release capture so the parent can scroll.
          activeId = null;
          applyPositions(idxRef.current, 0, false);
          return;
        }
        // Horizontal confirmed — capture pointer so no parent can steal it.
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      applyPositions(idxRef.current, dx, false); // photo follows finger 1-to-1
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      const capturedDx = e.clientX - startX;
      activeId = null;
      dir      = null;
      settle(capturedDx);
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return;
      activeId = null;
      dir      = null;
      applyPositions(idxRef.current, 0, true); // spring back to current
    };

    el.addEventListener("pointerdown",   onPointerDown);
    el.addEventListener("pointermove",   onPointerMove);
    el.addEventListener("pointerup",     onPointerUp);
    el.addEventListener("pointerleave",  onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);

    return () => {
      el.removeEventListener("pointerdown",   onPointerDown);
      el.removeEventListener("pointermove",   onPointerMove);
      el.removeEventListener("pointerup",     onPointerUp);
      el.removeEventListener("pointerleave",  onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [applyPositions, commitIdx]); // stable callbacks → registers once

  const n = photos.length;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, touchAction: "none", borderRadius: "inherit", ...style }}
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
          ref={slideRefFns.current[i]}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // Each slide clips its own image to rounded corners so the entering
            // photo has a soft curved leading edge (floating-card look) rather
            // than a hard rectangular strip sliding in from the side.
            overflow: "hidden",
            borderRadius: "inherit",
            // Current slide stays on top so the entering card slides in from
            // behind, not over the top of, the outgoing photo.
            zIndex: i === dotIdx ? 2 : 1,
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
