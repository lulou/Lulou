import { memo, useState, useEffect, type ReactNode } from "react";
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
}

export const ProfilePhotoViewer = memo(function ProfilePhotoViewer({
  photos,
  isLoading = false,
  height = PROFILE_PHOTO_HEIGHT,
  className = "",
  action,
  nameSlot,
}: ProfilePhotoViewerProps) {
  const n = photos.length;

  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: false });
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelectedIndex(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    onSelect();
    return () => { emblaApi.off("select", onSelect); };
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit({ loop: false });
    emblaApi.scrollTo(0, true);
    setSelectedIndex(0);
  }, [photos, emblaApi]);

  useEffect(() => {
    [selectedIndex - 1, selectedIndex, selectedIndex + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, selectedIndex]);

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
      className={`relative w-full ${className}`}
      style={{ height, background: "hsl(var(--muted))" }}
      data-testid="profile-photo-viewer"
    >
      {/* Embla viewport — receives all pointer/touch events directly */}
      <div
        ref={emblaRef}
        className="h-full w-full overflow-hidden"
        style={{ touchAction: "pan-y pinch-zoom" }}
      >
        {/* Embla container — flex row of slides */}
        <div style={{ display: "flex", height: "100%" }}>
          {photos.map((photo, i) => (
            <div
              key={i}
              style={{ flex: "0 0 100%", minWidth: 0, height: "100%" }}
              data-testid={`carousel-slide-${i}`}
            >
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
                  display: "block",
                }}
                onLoad={e => {
                  decodedPhotos.add(photo);
                  (e.currentTarget as HTMLImageElement).style.opacity = "1";
                }}
                data-testid={`img-carousel-photo-${i}`}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Gradient — pointer-events:none, never intercepts drag */}
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

      {/* Dot indicators — pointer-events:none */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 14,
            left: 16,
            display: "flex",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === selectedIndex ? 24 : 7,
                height: 7,
                borderRadius: 3.5,
                backgroundColor:
                  i === selectedIndex ? "white" : "rgba(255,255,255,0.42)",
                transition: "width 0.25s ease, background-color 0.25s ease",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      )}

      {/* Action button — wrapper is pointer-events:none so only the button itself is clickable */}
      {action && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 14,
            zIndex: 3,
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>{action}</div>
        </div>
      )}

      {nameSlot && (
        <div
          style={{
            position: "absolute",
            bottom: 50,
            left: 16,
            right: 16,
            zIndex: 2,
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>{nameSlot}</div>
        </div>
      )}
    </div>
  );
});
