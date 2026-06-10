import { useState, useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { decodedPhotos, preloadPhoto } from "@/lib/image-utils";
import { useLanguageContext } from "@/contexts/language-context";

/**
 * Tap-zone photo viewer.
 *
 * Tap/click the right half → next photo.
 * Tap/click the left half  → previous photo.
 * Arrow buttons visible on hover (desktop) and always on mobile.
 * Dot indicators update in sync.
 *
 * No drag / swipe for now — this is the reliability version.
 * All props are kept identical to the previous component so every call-site
 * continues to work without changes.
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

  const n = photos.length;
  const idx = controlledIdx !== undefined ? controlledIdx : internalIdx;

  // Clamp whenever the photos array shrinks
  const safeIdx = n === 0 ? 0 : Math.min(idx, n - 1);

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(n - 1, next));
    if (controlledIdx === undefined) setInternalIdx(clamped);
    onIndexChange?.(clamped);
  };

  // Preload current photo and its immediate neighbours
  useEffect(() => {
    [safeIdx - 1, safeIdx, safeIdx + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, safeIdx]);

  // Reset to 0 when a completely new photos array arrives (e.g. profile change)
  useEffect(() => {
    if (controlledIdx === undefined && internalIdx >= n && n > 0) {
      setInternalIdx(0);
    }
  }, [n, controlledIdx, internalIdx]);

  const photo = photos[safeIdx] ?? null;

  return (
    <div
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, background: "hsl(var(--muted))", ...style }}
      data-testid="photo-carousel"
    >
      {/* Empty state placeholder */}
      {n === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <svg viewBox="0 0 80 80" fill="none" className="w-16 h-16 opacity-20">
            <circle cx="40" cy="28" r="14" fill="currentColor" />
            <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
          </svg>
        </div>
      )}

      {/* Current photo */}
      {photo && (
        <img
          key={safeIdx}
          src={photo}
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
            opacity: decodedPhotos.has(photo) ? 1 : 0,
            transition: "opacity 0.08s ease",
          }}
          onLoad={e => {
            decodedPhotos.add(photo);
            (e.currentTarget as HTMLImageElement).style.opacity = "1";
          }}
          data-testid={`img-carousel-photo-${safeIdx}`}
        />
      )}

      {/* ── Tap zones ─────────────────────────────────────────────────────
          Two invisible halves covering the full photo area.
          Pointer-events are only active when there is actually another photo
          in that direction, so the cursor doesn't lie to the user. */}
      {n > 1 && safeIdx > 0 && (
        <button
          aria-label="Previous photo"
          data-testid="button-carousel-tap-prev"
          onClick={() => goTo(safeIdx - 1)}
          style={{
            position: "absolute",
            top: 0,
            insetInlineStart: 0,
            width: "40%",
            height: "100%",
            background: "transparent",
            border: "none",
            cursor: isRTL ? "e-resize" : "w-resize",
            zIndex: 10,
          }}
        />
      )}
      {n > 1 && safeIdx < n - 1 && (
        <button
          aria-label="Next photo"
          data-testid="button-carousel-tap-next"
          onClick={() => goTo(safeIdx + 1)}
          style={{
            position: "absolute",
            top: 0,
            insetInlineEnd: 0,
            width: "60%",
            height: "100%",
            background: "transparent",
            border: "none",
            cursor: isRTL ? "w-resize" : "e-resize",
            zIndex: 10,
          }}
        />
      )}

      {/* ── Arrow buttons ──────────────────────────────────────────────── */}
      {showArrows && n > 1 && safeIdx > 0 && (
        <button
          className="absolute start-2.5 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
          }}
          onClick={() => goTo(safeIdx - 1)}
          data-testid="button-carousel-prev"
          aria-label="Previous photo"
        >
          {isRTL ? <ChevronRight className="w-4 h-4 text-white" /> : <ChevronLeft className="w-4 h-4 text-white" />}
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
          onClick={() => goTo(safeIdx + 1)}
          data-testid="button-carousel-next"
          aria-label="Next photo"
        >
          {isRTL ? <ChevronLeft className="w-4 h-4 text-white" /> : <ChevronRight className="w-4 h-4 text-white" />}
        </button>
      )}

      {/* ── Dot indicators ─────────────────────────────────────────────── */}
      {showDots && n > 1 && (
        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-1.5 pointer-events-none z-20">
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

      {/* Caller-supplied overlay content (close buttons, gradients, name…) */}
      {children}
    </div>
  );
}
