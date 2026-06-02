import { memo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PhotoCarousel } from "@/components/photo-carousel";
import { isMobile } from "@/lib/perf";

/**
 * Canonical photo area height shared across every profile photo viewer in the app.
 * Changing this constant updates Discovery, Intention Wheel detail, and Chatroom
 * ProfilePanel all at once.
 */
export const PROFILE_PHOTO_HEIGHT = 440;

interface ProfilePhotoViewerProps {
  photos: string[];
  /** Show shimmer skeleton while photos are being fetched. */
  isLoading?: boolean;
  /** Photo area height in px. Defaults to PROFILE_PHOTO_HEIGHT (440). */
  height?: number;
  /** CSS class applied to the root element in every render state. */
  className?: string;
  /**
   * Bottom-right action slot rendered alongside the pill dot indicators.
   * In the empty-photos state it is centred at the bottom of the panel.
   * Example: the "❤️ Open" button in Discovery.
   */
  action?: ReactNode;
  /**
   * Content rendered just above the dot indicators.
   * Example: name + location overlay in the chatroom ProfilePanel.
   */
  nameSlot?: ReactNode;
  /**
   * Extra absolutely-positioned overlay content injected inside the carousel
   * and empty-state containers.
   * Example: close button at top-right in the chatroom ProfilePanel.
   */
  children?: ReactNode;
}

/**
 * Single source of truth for the Discovery-style profile photo viewer.
 *
 * Tap left 40% → previous photo. Tap right 60% → next photo.
 * Arrow buttons visible when there is a photo in that direction.
 * Dots update in sync.
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

  const goTo = (next: number) => {
    setPhotoIndex(Math.max(0, Math.min(n - 1, next)));
  };

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

  // ── Empty state: silhouette ────────────────────────────────────────────────
  if (photos.length === 0) {
    return (
      <div
        className={`w-full relative flex items-center justify-center bg-muted ${className}`}
        style={{ height }}
        data-testid="photo-viewer-empty"
      >
        <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-16 h-16 opacity-20">
          <circle cx="40" cy="28" r="14" fill="currentColor" />
          <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
        </svg>
        {action && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2">
            {action}
          </div>
        )}
        {children}
      </div>
    );
  }

  // ── Photo viewer ───────────────────────────────────────────────────────────
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ height }}
      data-testid="profile-photo-viewer"
    >
      {/* Photo — renders a single image, no drag, just shows the current one */}
      <PhotoCarousel
        photos={photos}
        height={height}
        currentIndex={safeIdx}
        onIndexChange={setPhotoIndex}
        showArrows={false}
        showDots={false}
      />

      {/* Bottom gradient */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Caller-supplied overlay content (close button, etc.) */}
      {children}

      {/* ── Tap zones — z:30 so they sit above gradient + children ── */}
      {n > 1 && safeIdx > 0 && (
        <button
          aria-label="Previous photo"
          data-testid="button-viewer-tap-prev"
          onClick={() => goTo(safeIdx - 1)}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "40%",
            height: "100%",
            background: "transparent",
            border: "none",
            cursor: "w-resize",
            zIndex: 30,
          }}
        />
      )}
      {n > 1 && safeIdx < n - 1 && (
        <button
          aria-label="Next photo"
          data-testid="button-viewer-tap-next"
          onClick={() => goTo(safeIdx + 1)}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: "60%",
            height: "100%",
            background: "transparent",
            border: "none",
            cursor: "e-resize",
            zIndex: 30,
          }}
        />
      )}

      {/* ── Arrow buttons — z:40 so they are always clickable ── */}
      {n > 1 && safeIdx > 0 && (
        <button
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          style={{
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => goTo(safeIdx - 1)}
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
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            zIndex: 40,
          }}
          onClick={() => goTo(safeIdx + 1)}
          data-testid="button-viewer-next"
          aria-label="Next photo"
        >
          <ChevronRight className="w-4 h-4 text-white" />
        </button>
      )}

      {/* ── Bottom bar: dots + action ── */}
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
