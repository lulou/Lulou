import { memo, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
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
 * Profile photo viewer — Embla carousel with iOS Safari drag fix.
 *
 * Root cause of "drag doesn't work on iPhone":
 *   The viewer lives inside `overflow-y: auto` (the page scroll container).
 *   iOS Safari claims ANY touch gesture that starts inside a native scroll
 *   container and fires `touchcancel` / `pointercancel` the moment movement
 *   is detected, terminating Embla's drag mid-gesture.
 *
 * Fix:
 *   Attach a non-passive `touchmove` listener to the Embla root node.
 *   When the gesture is primarily horizontal (|dx| > |dy|), call
 *   `event.preventDefault()`. This tells Safari "this gesture belongs to JS"
 *   before it can fire touchcancel. Vertical scroll still works because we
 *   only preventDefault on horizontal moves.
 *
 * Why click still worked without this fix:
 *   A tap has no movement, so touchcancel never fires. Click → Embla snap
 *   was working through a completely different code path.
 */
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
  // Overlay state drives the bubble animation on tap/arrow photo changes.
  const [photoOverlay, setPhotoOverlay] = useState<{ src: string; direction: "fwd" | "bwd"; id: number } | null>(null);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the Embla root DOM node so we can attach non-passive listeners.
  // emblaRef is a callback ref; we wrap it to also capture the node ourselves.
  const viewportNodeRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      viewportNodeRef.current = node;
      // Forward to Embla's callback ref
      if (typeof emblaRef === "function") emblaRef(node);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [emblaRef],
  );

  // ── iOS Safari horizontal-drag fix ────────────────────────────────────────
  // A non-passive touchmove listener that calls preventDefault() for
  // horizontal gestures, preventing the native scroll container from claiming
  // the touch before Embla can complete the drag.
  useEffect(() => {
    const el = viewportNodeRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let decided = false; // direction decided for this gesture?

    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      decided = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (decided) {
        // Already determined this gesture is horizontal — keep blocking.
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > dy) e.preventDefault();
        return;
      }
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx < 3 && dy < 3) return; // not enough movement yet
      decided = true;
      if (dx > dy) {
        // Horizontal gesture — claim it for Embla before Safari does.
        e.preventDefault();
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    // passive:false is required so preventDefault() is honoured.
    el.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  // Re-attach whenever the DOM node changes (profile switch / reInit).
  // viewportNodeRef.current is stable but we depend on emblaApi so the
  // effect re-runs after Embla initialises and we know the node is live.
  }, [emblaApi]);

  // ── Sync dot indicator + bubble animation on photo change ─────────────────
  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelectedIndex(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    onSelect();
    return () => { emblaApi.off("select", onSelect); };
  }, [emblaApi]);

  // ── Reset carousel when a new profile is shown ────────────────────────────
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit({ loop: false });
    emblaApi.scrollTo(0, true);
    setSelectedIndex(0);
  }, [photos, emblaApi]);

  // ── Preload neighbours ─────────────────────────────────────────────────────
  useEffect(() => {
    [selectedIndex - 1, selectedIndex, selectedIndex + 1].forEach(i => {
      if (photos[i]) preloadPhoto(photos[i]);
    });
  }, [photos, selectedIndex]);

  // ── Navigate with bubble animation ────────────────────────────────────────
  // Arrow buttons and taps call this instead of emblaApi.scrollNext/Prev() so
  // the transition uses a premium overlay pop rather than Embla's default slide.
  // Drag gestures go through Embla naturally (no overlay, no select-event anim).
  const navigatePhoto = useCallback((newIdx: number, direction: "fwd" | "bwd") => {
    if (!emblaApi || newIdx < 0 || newIdx >= n) return;
    emblaApi.scrollTo(newIdx, true); // instant jump — no Embla slide animation
    if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current);
    const id = Date.now();
    setPhotoOverlay({ src: photos[newIdx], direction, id });
    overlayTimerRef.current = setTimeout(
      () => setPhotoOverlay(o => (o?.id === id ? null : o)),
      500,
    );
  }, [emblaApi, n, photos]);

  // ── Tap-to-advance on touch devices ───────────────────────────────────────
  // Distinguishes a tap (< 16 px movement) from a drag. Right half → next,
  // left half → prev. Runs in a separate effect so deps update with selectedIndex.
  useEffect(() => {
    const el = viewportNodeRef.current;
    if (!el || !emblaApi || n <= 1) return;
    let tapX = 0;
    let tapY = 0;
    const onStart = (e: TouchEvent) => {
      tapX = e.touches[0].clientX;
      tapY = e.touches[0].clientY;
    };
    const onEnd = (e: TouchEvent) => {
      const dx = Math.abs(e.changedTouches[0].clientX - tapX);
      const dy = Math.abs(e.changedTouches[0].clientY - tapY);
      if (dx > 16 || dy > 16) return; // drag — let Embla handle it
      const rect = el.getBoundingClientRect();
      const x = e.changedTouches[0].clientX - rect.left;
      const goFwd = x > rect.width / 2;
      navigatePhoto(goFwd ? selectedIndex + 1 : selectedIndex - 1, goFwd ? "fwd" : "bwd");
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchend", onEnd);
    };
  }, [emblaApi, n, selectedIndex, navigatePhoto]);

  // Cleanup overlay timer on unmount.
  useEffect(() => () => { if (overlayTimerRef.current) clearTimeout(overlayTimerRef.current); }, []);

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

  // ── Empty state ────────────────────────────────────────────────────────────
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

  // ── Photo carousel ─────────────────────────────────────────────────────────
  return (
    <div
      className={`relative w-full ${className}`}
      style={{ height, background: "hsl(var(--muted))" }}
      data-testid="profile-photo-viewer"
    >
      {/*
        Embla viewport — the interactive surface.
        touch-action:pan-y pinch-zoom lets Embla own horizontal events at the
        CSS level; the non-passive touchmove listener above enforces this on
        iOS Safari which ignores CSS touch-action when inside a scroll container.
      */}
      <div
        ref={setRefs}
        className="h-full w-full overflow-hidden"
        style={{ touchAction: "pan-y pinch-zoom" }}
      >
        {/* Embla container */}
        <div style={{ display: "flex", height: "100%" }}>
          {photos.map((photo, i) => (
            <div
              key={i}
              style={{ flex: "0 0 100%", minWidth: 0, height: "100%", padding: "0 6px" }}
              data-testid={`carousel-slide-${i}`}
            >
              {/* Inner wrapper clips image to rounded corners; one card per photo. */}
              <div style={{ width: "100%", height: "100%", borderRadius: 18, overflow: "hidden" }}>
                <img
                  src={photo}
                  alt={`Photo ${i + 1}`}
                  loading={Math.abs(i - selectedIndex) <= 1 ? "eager" : "lazy"}
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
                    userSelect: "none",
                  }}
                  onLoad={e => {
                    decodedPhotos.add(photo);
                    (e.currentTarget as HTMLImageElement).style.opacity = "1";
                  }}
                  data-testid={`img-carousel-photo-${i}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Photo transition overlay — bubble animation on tap/arrow navigation.
          Plays over the settled carousel so the effect is always visible,
          regardless of when Embla finishes its (instant) scroll. */}
      {photoOverlay && (
        <div
          key={photoOverlay.id}
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 6,
            right: 6,
            bottom: 0,
            zIndex: 5,
            borderRadius: 18,
            overflow: "hidden",
            animation: `${photoOverlay.direction === "fwd" ? "photoEnterRight" : "photoEnterLeft"} 0.42s cubic-bezier(0.16, 1, 0.3, 1) both`,
          }}
        >
          <img
            src={photoOverlay.src}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center top",
              display: "block",
            }}
          />
        </div>
      )}

      {/* Gradient — pointer-events:none; inset 6 px to stay within the rounded photo card */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 6,
          right: 6,
          bottom: 0,
          pointerEvents: "none",
          borderRadius: 18,
          background:
            "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)",
          zIndex: 1,
        }}
      />

      {/* Arrow buttons — small, sit at mid-height on each edge */}
      {n > 1 && selectedIndex > 0 && (
        <button
          onClick={() => navigatePhoto(selectedIndex - 1, "bwd")}
          aria-label="Previous photo"
          data-testid="button-viewer-prev"
          style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 3,
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <ChevronLeft style={{ width: 16, height: 16, color: "white" }} />
        </button>
      )}
      {n > 1 && selectedIndex < n - 1 && (
        <button
          onClick={() => navigatePhoto(selectedIndex + 1, "fwd")}
          aria-label="Next photo"
          data-testid="button-viewer-next"
          style={{
            position: "absolute",
            right: 10,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 3,
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(0,0,0,0.38)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <ChevronRight style={{ width: 16, height: 16, color: "white" }} />
        </button>
      )}

      {/* Dot indicators — pointer-events:none; left offset accounts for 6 px slide inset */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            bottom: 14,
            left: 22,
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

      {/* Action button — right offset accounts for 6 px slide inset */}
      {action && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 20,
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
            left: 22,
            right: 22,
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
