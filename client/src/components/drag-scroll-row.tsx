import { useRef, useEffect, useCallback } from "react";

export function DragScrollRow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftStart = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const velocity = useRef(0);
  const animFrame = useRef(0);

  const glide = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    velocity.current *= 0.92;
    if (Math.abs(velocity.current) < 0.3) {
      velocity.current = 0;
      return;
    }
    el.scrollLeft -= velocity.current;
    animFrame.current = requestAnimationFrame(glide);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(animFrame.current);
    velocity.current = 0;
    isDragging.current = true;
    startX.current = e.clientX;
    lastX.current = e.clientX;
    lastTime.current = Date.now();
    scrollLeftStart.current = el.scrollLeft;
    el.style.cursor = "grabbing";
    el.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !ref.current) return;
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) {
      velocity.current = (dx / dt) * 16;
    }
    lastX.current = e.clientX;
    lastTime.current = now;
    const totalDx = e.clientX - startX.current;
    ref.current.scrollLeft = scrollLeftStart.current - totalDx;
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    if (ref.current) {
      ref.current.style.cursor = "grab";
      ref.current.releasePointerCapture(e.pointerId);
    }
    if (Math.abs(velocity.current) > 1) {
      animFrame.current = requestAnimationFrame(glide);
    }
  };

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

  return (
    <div
      ref={ref}
      className={`flex gap-2 overflow-x-auto scrollbar-hide cursor-grab select-none ${className}`}
      style={{ WebkitOverflowScrolling: "touch" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      data-testid="drag-scroll-row"
    >
      {children}
    </div>
  );
}
