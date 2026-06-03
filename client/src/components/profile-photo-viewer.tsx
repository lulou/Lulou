import { memo, useState, useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import useEmblaCarousel from "embla-carousel-react";
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
 * Profile photo viewer — drag/swipe powered by embla-carousel-react.
 *
 * Embla is a battle-tested library that handles Pointer Events, Touch Events,
 * implicit pointer capture, iOS scroll-lock, and cross-browser edge cases
 * internally. Replacing the custom drag system removes all five layers of
 * bespoke pointer-event fixes that were failing on mobile.
 *
 * Navigation:
 *  - Drag/swipe left-right (mouse or touch) — handled by embla
 *  - Arrow buttons (left / right)
 *  - Dot indicators update via embla's 'select' event
 *
 * Tap (single click with no drag) is handled natively by embla: embla does not
 * move the carousel for a click alone, so a click on the left/right arrow
 * buttons fires their onClick normally.
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
  const n = photos.length;

  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: false,
    // Disable drag when there is only one photo so that vertical scroll
    // in a parent container is not accidentally intercepted.
    watchDrag: n > 1,
  });

  const [selectedIndex, setSelectedIndex] = useState(0);

  // Keep selected index in sync with embla scroll position
  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelectedIndex(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    onSelect(); // sync immediately on init
    return () => { emblaApi.off("select", onSelect); };
  }, [emblaApi]);

  // Re-initialise carousel when photos array changes (new profile loaded)
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit();
    emblaApi.scrollTo(0, true); // jump to first photo instantly
    setSelectedIndex(0);
  }, [photos, emblaApi]);

  // Preload current photo and immediate neighbours
  useEffect(() => {
    [selectedIndex - 1, selectedIndex, selectedIndex + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, selectedIndex]);

  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex < n - 1;

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
      className={`relative overflow-hidden select-none ${className}`}
      style={{ height, background: "hsl(var(--muted))" }}
      data-testid="profile-photo-viewer"
    >
      {/* Embla viewport — emblaRef is a callback ref managed by embla */}
      <div ref={emblaRef} style={{ height: "100%", overflow: "hidden" }}>
        {/* Embla container — flex row of slides */}
        <div style={{ display: "flex", height: "100%" }}>
          {photos.map((photo, i) => (
            <div
              key={i}
              style={{ flex: "0 0 100%", minWidth: 0, height: "100%", position: "relative" }}
              data-testid={`carousel-slide-${i}`}
            >
              {/* Only render <img> for current ±1 to keep GPU memory low */}
              {Math.abs(i - selectedIndex) <= 1 && (
                <img
                  src={photo}
                  alt={`Photo ${i + 1}`}
                  loading={i === selectedIndex ? "eager" : "lazy"}
                  decoding="async"
                  draggable={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "center top",
                    opacity: decodedPhotos.has(photo) ? 1 : 0,
                    transition: "opacity 0.08s ease",
                    pointerEvents: "none", // embla owns drag; images must not catch pointer events
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
        </div>
      </div>

      {/* ── EMBLA PROOF LABEL ── remove after confirming live */}
      <div
        style={{
          position: "absolute", top: 10, left: 10, zIndex: 999,
          background: "lime", color: "black", fontWeight: "bold",
          fontSize: 13, padding: "4px 10px", borderRadius: 6,
          pointerEvents: "none", lineHeight: 1.4,
        }}
      >
        EMBLA ACTIVE<br />carousel type: embla
      </div>

      {/* Bottom gradient — above slides, below interactive elements */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Caller-supplied overlay (close button, etc.) */}
      {children}

      {/* Arrow buttons */}
      {n > 1 && canPrev && (
        <button
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => emblaApi?.scrollPrev()}
          data-testid="button-viewer-prev"
          aria-label="Previous photo"
        >
          <ChevronLeft className="w-4 h-4 text-white" />
        </button>
      )}
      {n > 1 && canNext && (
        <button
          className="absolute right-2.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => emblaApi?.scrollNext()}
          data-testid="button-viewer-next"
          aria-label="Next photo"
        >
          <ChevronRight className="w-4 h-4 text-white" />
        </button>
      )}

      {/* Bottom bar: dots + action */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4" style={{ zIndex: 40, pointerEvents: "none" }}>
        <div className="flex items-end justify-between">
          {n > 1 ? (
            <div className="flex items-center gap-1.5 pb-0.5">
              {photos.map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: i === selectedIndex ? 24 : 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: i === selectedIndex ? "white" : "rgba(255,255,255,0.42)",
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
