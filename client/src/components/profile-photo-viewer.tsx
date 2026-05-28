import { memo, useState, type ReactNode } from "react";
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
 * Behaviour is identical to the original `PhotoBubbles` component in discover.tsx:
 *  • isLoading                → shimmer skeleton (mobile: static muted; desktop: animated gradient)
 *  • photos.length === 0      → silhouette fallback
 *  • photos.length > 0        → uncontrolled PhotoCarousel, no arrows, pill dot indicators,
 *                               bottom gradient overlay
 *
 * Used by: Discovery (PhotoBubbles), Intention Wheel detail view, Chatroom ProfilePanel.
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

  // ── Loading shimmer ────────────────────────────────────────────────────────
  // Mobile: static muted colour — the shimmer keyframe scrolls background-position
  // every frame, which forces a continuous GPU repaint on iOS (very expensive).
  // Desktop: animated gradient sweep.
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

  // ── Photo carousel ─────────────────────────────────────────────────────────
  return (
    <PhotoCarousel
      photos={photos}
      height={height}
      showArrows={false}
      showDots={false}
      onIndexChange={setPhotoIndex}
      className={className}
    >
      {/* Bottom gradient — same values as the original PhotoBubbles */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Caller-supplied overlay content (close button, etc.) */}
      {children}

      {/* Bottom bar: [dots ← left | action → right] then optional name slot below */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 z-10">
        <div className="flex items-end justify-between">
          {photos.length > 1 ? (
            <div className="flex items-center gap-1.5 pb-0.5">
              {photos.map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: i === photoIndex ? 24 : 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: i === photoIndex ? "white" : "rgba(255,255,255,0.42)",
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
    </PhotoCarousel>
  );
});
