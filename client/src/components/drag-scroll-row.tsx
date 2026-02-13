import { useRef } from "react";

export function DragScrollRow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    isDragging.current = true;
    startX.current = e.clientX;
    scrollLeft.current = el.scrollLeft;
    el.style.cursor = "grabbing";
    el.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !ref.current) return;
    const dx = e.clientX - startX.current;
    ref.current.scrollLeft = scrollLeft.current - dx;
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    if (ref.current) {
      ref.current.style.cursor = "grab";
      ref.current.releasePointerCapture(e.pointerId);
    }
  };

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
