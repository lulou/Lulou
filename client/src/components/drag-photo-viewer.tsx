import { useState, useEffect, useRef, useCallback } from "react";

interface DragPhotoViewerProps {
  photos: string[];
  height?: number;
}

export function DragPhotoViewer({ photos, height = 500 }: DragPhotoViewerProps) {
  const n = photos.length;

  const [index,    setIndex]    = useState(0);
  const [dragX,    setDragX]    = useState(0);
  const [dragging, setDragging] = useState(false);
  const [flyDir,   setFlyDir]   = useState<"left" | "right" | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const startX  = useRef(0);
  const lastDX  = useRef(0);

  // iOS Safari: prevent scroll container stealing horizontal drags
  useEffect(() => {
    const el = rootRef.current;
    if (!el || n <= 1) return;
    let ax = 0, ay = 0, decided = false;
    const onTS = (e: TouchEvent) => { ax = e.touches[0].clientX; ay = e.touches[0].clientY; decided = false; };
    const onTM = (e: TouchEvent) => {
      const dx = Math.abs(e.touches[0].clientX - ax);
      const dy = Math.abs(e.touches[0].clientY - ay);
      if (!decided && dx < 3 && dy < 3) return;
      decided = true;
      if (dx > dy) e.preventDefault();
    };
    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchmove",  onTM, { passive: false });
    return () => { el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); };
  }, [n]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (n <= 1 || flyDir !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    lastDX.current = 0;
    setDragging(true);
    setDragX(0);
  }, [n, flyDir]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const dx = e.clientX - startX.current;
    lastDX.current = dx;
    setDragX(dx);
  }, [dragging]);

  const commitDrag = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    const cw = rootRef.current?.offsetWidth ?? 375;
    const dx = lastDX.current;
    const threshold = cw * 0.25;
    if      (dx < -threshold && index < n - 1) setFlyDir("left");
    else if (dx >  threshold && index > 0)     setFlyDir("right");
    else setDragX(0);
  }, [dragging, index, n]);

  const onFlyEnd = useCallback(() => {
    if (!flyDir) return;
    setIndex(i => flyDir === "left" ? i + 1 : i - 1);
    setFlyDir(null);
    setDragX(0);
  }, [flyDir]);

  // Progress 0→1 based on how far the card has been dragged
  const cardW    = rootRef.current?.offsetWidth ?? 375;
  const progress = Math.min(Math.abs(dragX) / Math.max(cardW, 1), 1);

  // Next card index: follows drag direction, falls back to index+1 at rest
  const nextIdx = (dragX < 0 && index < n - 1) ? index + 1
                : (dragX > 0 && index > 0)      ? index - 1
                : (index < n - 1)               ? index + 1
                : (index > 0)                   ? index - 1
                : -1;
  const showNext = n > 1 && nextIdx !== -1;

  // Current card transform
  const rotate = dragX * 0.04;
  let currentTransform  = `translateX(${dragX}px) rotate(${rotate}deg)`;
  let currentTransition = dragging ? "none" : "transform 0.3s ease";

  if (flyDir === "left") {
    currentTransform  = "translateX(-110%) rotate(-20deg)";
    currentTransition = "transform 0.35s ease-in";
  } else if (flyDir === "right") {
    currentTransform  = "translateX(110%) rotate(20deg)";
    currentTransition = "transform 0.35s ease-in";
  }

  // Next card values — exactly as specified
  const flying       = flyDir !== null;
  const nextOpacity  = flying ? 1 : progress;
  const nextScale    = flying ? 1 : 0.9 + progress * 0.1;
  const nextTY       = flying ? 0 : 24 * (1 - progress);
  const nextTransition = dragging
    ? "none"
    : "transform 0.3s ease, opacity 0.3s ease";

  return (
    <div
      ref={rootRef}
      data-testid="drag-photo-viewer"
      style={{
        position:    "relative",
        width:       "100%",
        height,
        touchAction: "pan-y pinch-zoom",
        cursor:      n > 1 ? (dragging ? "grabbing" : "grab") : "default",
        userSelect:  "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={commitDrag}
      onPointerCancel={commitDrag}
    >
      {/* Next card — underneath, hidden at rest */}
      {showNext && (
        <div
          key={nextIdx}
          style={{
            position:        "absolute",
            inset:           "0 0",
            borderRadius:    20,
            overflow:        "hidden",
            boxShadow:       "0 4px 24px rgba(0,0,0,0.18)",
            opacity:         nextOpacity,
            transform:       `scale(${nextScale}) translateY(${nextTY}px)`,
            transition:      nextTransition,
            zIndex:          1,
            transformOrigin: "center center",
          }}
        >
          <img
            src={photos[nextIdx]}
            alt=""
            draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", display: "block", pointerEvents: "none" }}
          />
        </div>
      )}

      {/* Current card — on top, draggable */}
      <div
        style={{
          position:        "absolute",
          inset:           "0 0",
          borderRadius:    20,
          overflow:        "hidden",
          boxShadow:       "0 8px 40px rgba(0,0,0,0.28)",
          transform:       currentTransform,
          transition:      currentTransition,
          zIndex:          2,
          willChange:      "transform",
          transformOrigin: "center center",
        }}
        onTransitionEnd={flyDir ? onFlyEnd : undefined}
      >
        <img
          src={photos[index]}
          alt={`Photo ${index + 1}`}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top", display: "block", pointerEvents: "none" }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 50%)",
          }}
        />
      </div>

      {/* Dots */}
      {n > 1 && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute", bottom: 14, left: 0, right: 0,
            display: "flex", justifyContent: "center", gap: 6,
            pointerEvents: "none", zIndex: 3,
          }}
        >
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width:        i === index ? 20 : 6,
                height:       6,
                borderRadius: 3,
                background:   i === index ? "white" : "rgba(255,255,255,0.5)",
                transition:   "width 0.2s ease",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
