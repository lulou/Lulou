import { useState, useRef, useEffect, useLayoutEffect, useCallback, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Smooth sliding photo carousel.
 *
 * Features:
 * - CSS transform sliding strip — no abrupt image swaps
 * - Touch swipe with live drag feedback (non-passive touchmove via addEventListener)
 * - Mouse/pointer drag support
 * - Direction detection: horizontal drag slides photos, vertical drag scrolls page
 * - Only loads photos ±1 from current index (lazy loads the rest)
 * - Optional built-in arrow buttons + dot indicators
 * - `children` prop for absolute-positioned overlays (close button, name, etc.)
 */

interface PhotoCarouselProps {
  photos: string[];
  /** CSS height of the carousel container */
  height?: number | string;
  /** Controlled index — if provided, also pass onIndexChange */
  currentIndex?: number;
  /** Called when the user swipes/taps to a new photo */
  onIndexChange?: (idx: number) => void;
  /** Show built-in arrow buttons (default true, auto-hidden when ≤1 photo) */
  showArrows?: boolean;
  /** Show built-in pill dot indicators (default true, auto-hidden when ≤1 photo) */
  showDots?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** Absolute-positioned overlay content (close button, name, gradients, etc.) */
  children?: ReactNode;
}

export function PhotoCarousel({
  photos,
  height = 300,
  currentIndex,
  onIndexChange,
  showArrows = true,
  showDots = true,
  className = "",
  style,
  children,
}: PhotoCarouselProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [internalIdx, setInternalIdx] = useState(0);
  const [dragDx, setDragDx] = useState(0);

  // Touch state
  const touchActive = useRef(false);
  const touchDir = useRef<"h" | "v" | null>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  // Pointer (mouse) state
  const pointerActive = useRef(false);
  const pointerMoved = useRef(false);
  const pointerStartX = useRef(0);
  const pointerStartY = useRef(0);

  const idx = currentIndex !== undefined ? currentIndex : internalIdx;
  const n = photos.length;

  const setIdx = useCallback((newIdx: number) => {
    const clamped = Math.max(0, Math.min((photos.length || 1) - 1, newIdx));
    if (currentIndex === undefined) setInternalIdx(clamped);
    onIndexChange?.(clamped);
  }, [currentIndex, photos.length, onIndexChange]);

  // Measure container width synchronously before first paint
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.offsetWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Non-passive touchmove so we can call preventDefault during horizontal drag
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      if (!touchActive.current) return;
      const dx = e.touches[0].clientX - touchStartX.current;
      const dy = e.touches[0].clientY - touchStartY.current;
      if (!touchDir.current) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        touchDir.current = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
      }
      if (touchDir.current === "h") {
        e.preventDefault(); // stop page scroll during horizontal swipe
        setDragDx(dx);
      }
    };
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => el.removeEventListener("touchmove", onMove);
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    touchDir.current = null;
    touchActive.current = true;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    touchActive.current = false;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    setDragDx(0);
    if (touchDir.current === "h" && Math.abs(dx) >= 40) {
      setIdx(dx < 0 ? idx + 1 : idx - 1);
    }
    touchDir.current = null;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    pointerStartX.current = e.clientX;
    pointerStartY.current = e.clientY;
    pointerActive.current = true;
    pointerMoved.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointerActive.current || e.pointerType === "touch") return;
    const dx = e.clientX - pointerStartX.current;
    const dy = e.clientY - pointerStartY.current;
    if (!pointerMoved.current) {
      if (Math.abs(dx) < 5) return;
      if (Math.abs(dy) > Math.abs(dx)) { pointerActive.current = false; return; }
      pointerMoved.current = true;
    }
    setDragDx(dx);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!pointerActive.current || e.pointerType === "touch") return;
    const dx = e.clientX - pointerStartX.current;
    pointerActive.current = false;
    setDragDx(0);
    if (pointerMoved.current && Math.abs(dx) >= 40) {
      setIdx(dx < 0 ? idx + 1 : idx - 1);
    }
    pointerMoved.current = false;
  };

  const isInteracting = touchActive.current || pointerActive.current;
  const tx = containerW > 0 ? -(idx * containerW) + dragDx : 0;

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, ...style }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      data-testid="photo-carousel"
    >
      {n === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <svg viewBox="0 0 80 80" fill="none" className="w-16 h-16 opacity-20">
            <circle cx="40" cy="28" r="14" fill="currentColor" />
            <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
          </svg>
        </div>
      ) : (
        /* Sliding strip */
        <div
          style={{
            display: "flex",
            height: "100%",
            transform: `translateX(${tx}px)`,
            transition: isInteracting ? "none" : "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)",
            willChange: "transform",
          }}
        >
          {photos.map((photo, i) => (
            <div
              key={i}
              style={{
                flexShrink: 0,
                width: containerW || "100%",
                height: "100%",
                background: "hsl(var(--muted))",
              }}
              data-testid={`carousel-slide-${i}`}
            >
              {/* Only render photos ±1 from current to save memory / network */}
              {Math.abs(i - idx) <= 1 && (
                <img
                  src={photo}
                  alt={`Photo ${i + 1}`}
                  loading={i === idx ? "eager" : "lazy"}
                  decoding="async"
                  style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top" }}
                  data-testid={`img-carousel-photo-${i}`}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Built-in arrow buttons */}
      {showArrows && n > 1 && idx > 0 && (
        <button
          className="absolute left-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{ background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          onClick={(e) => { e.stopPropagation(); setIdx(idx - 1); }}
          data-testid="button-carousel-prev"
          aria-label="Previous photo"
        >
          <ChevronLeft className="w-4 h-4 text-white" />
        </button>
      )}
      {showArrows && n > 1 && idx < n - 1 && (
        <button
          className="absolute right-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{ background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          onClick={(e) => { e.stopPropagation(); setIdx(idx + 1); }}
          data-testid="button-carousel-next"
          aria-label="Next photo"
        >
          <ChevronRight className="w-4 h-4 text-white" />
        </button>
      )}

      {/* Built-in pill dot indicators */}
      {showDots && n > 1 && (
        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-1.5 pointer-events-none z-20">
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === idx ? 22 : 7,
                height: 7,
                borderRadius: 3.5,
                background: i === idx ? "white" : "rgba(255,255,255,0.42)",
                transition: "width 0.25s ease, background 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}

      {/* Caller-supplied overlay content (close button, name, gradients, etc.) */}
      {children}
    </div>
  );
}
