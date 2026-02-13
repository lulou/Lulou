import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flower2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { Profile } from "@shared/schema";

const ITEM_WIDTH = 160;
const ITEM_GAP = 12;
const SLOT_SIZE = ITEM_WIDTH + ITEM_GAP;

export default function IntentPage() {
  const { data: profiles, isLoading, isError } = useQuery<Profile[]>({
    queryKey: ["/api/popular"],
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const animFrame = useRef(0);
  const velocity = useRef(0);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const scrollLeftStart = useRef(0);

  const [isSpinning, setIsSpinning] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const items = profiles || [];

  const getTargetScroll = useCallback((index: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    return index * SLOT_SIZE;
  }, []);

  const updateFocused = useCallback(() => {
    const el = scrollRef.current;
    if (!el || items.length === 0) return;
    const center = el.scrollLeft + el.clientWidth / 2;
    let closest = 0;
    let minDist = Infinity;
    const paddingLeft = el.clientWidth / 2 - ITEM_WIDTH / 2;
    items.forEach((_, i) => {
      const itemCenter = paddingLeft + i * SLOT_SIZE + ITEM_WIDTH / 2;
      const dist = Math.abs(center - itemCenter);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    });
    setFocusedIndex(closest);
  }, [items]);

  const glide = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    velocity.current *= 0.93;
    if (Math.abs(velocity.current) < 0.3) {
      velocity.current = 0;
      updateFocused();
      return;
    }
    el.scrollLeft -= velocity.current;
    updateFocused();
    animFrame.current = requestAnimationFrame(glide);
  }, [updateFocused]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isSpinning) return;
    const el = scrollRef.current;
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
    if (!isDragging.current || !scrollRef.current) return;
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = (dx / dt) * 16;
    lastX.current = e.clientX;
    lastTime.current = now;
    const totalDx = e.clientX - startX.current;
    scrollRef.current.scrollLeft = scrollLeftStart.current - totalDx;
    updateFocused();
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    if (scrollRef.current) {
      scrollRef.current.style.cursor = "grab";
      scrollRef.current.releasePointerCapture(e.pointerId);
    }
    if (Math.abs(velocity.current) > 1) {
      animFrame.current = requestAnimationFrame(glide);
    } else {
      updateFocused();
    }
  };

  const spinWheel = () => {
    if (isSpinning || items.length === 0) return;
    setIsSpinning(true);
    setSelectedIndex(null);

    const el = scrollRef.current;
    if (!el) return;

    const targetIndex = Math.floor(Math.random() * items.length);
    const paddingLeft = el.clientWidth / 2 - ITEM_WIDTH / 2;
    const targetScroll = paddingLeft + targetIndex * SLOT_SIZE + ITEM_WIDTH / 2 - el.clientWidth / 2;

    const currentScroll = el.scrollLeft;

    const passDistance = items.length * SLOT_SIZE;
    const forwardDistance = passDistance * 2 + (targetScroll - currentScroll);

    const duration = 2500 + Math.random() * 800;
    const startTime = Date.now();

    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutQuart(progress);

      const maxScroll = el.scrollWidth - el.clientWidth;
      const rawScroll = currentScroll + forwardDistance * eased;
      const wrappedScroll = rawScroll % (maxScroll + el.clientWidth);
      el.scrollLeft = Math.min(Math.max(0, wrappedScroll), maxScroll);
      updateFocused();

      if (progress < 1) {
        animFrame.current = requestAnimationFrame(animate);
      } else {
        el.scrollLeft = Math.min(Math.max(0, targetScroll), maxScroll);
        setFocusedIndex(targetIndex);
        setSelectedIndex(targetIndex);
        setIsSpinning(false);
      }
    };

    cancelAnimationFrame(animFrame.current);
    animFrame.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

  useEffect(() => {
    if (items.length > 0 && scrollRef.current) {
      const paddingLeft = scrollRef.current.clientWidth / 2 - ITEM_WIDTH / 2;
      scrollRef.current.scrollLeft = paddingLeft;
      updateFocused();
    }
  }, [items, updateFocused]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Flower2 className="w-8 h-8 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <Flower2 className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">Unable to load profiles right now</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <Flower2 className="w-10 h-10 text-primary mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">No profiles to show yet</p>
        </div>
      </div>
    );
  }

  const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="intent-page">
      <div className="px-5 pt-6 pb-2">
        <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
          Intention Wheel
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Spin to discover someone special
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-6 overflow-y-auto">
        <div className="relative w-full">
          <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-2 z-10">
            <div className="w-0 h-0 border-l-[10px] border-r-[10px] border-t-[14px] border-l-transparent border-r-transparent border-t-primary" />
          </div>

          <div
            ref={scrollRef}
            className="overflow-x-auto scrollbar-hide cursor-grab select-none touch-pan-y"
            style={{ WebkitOverflowScrolling: "touch" }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onScroll={updateFocused}
            data-testid="intent-wheel"
          >
            <div
              className="flex items-center"
              style={{
                paddingLeft: `calc(50% - ${ITEM_WIDTH / 2}px)`,
                paddingRight: `calc(50% - ${ITEM_WIDTH / 2}px)`,
                gap: `${ITEM_GAP}px`,
                width: "max-content",
              }}
            >
              {items.map((profile, i) => {
                const isFocused = i === focusedIndex;
                const isSelected = i === selectedIndex;
                const photo = profile.photos?.[0];

                return (
                  <div
                    key={profile.id}
                    className={`relative rounded-md overflow-hidden flex-shrink-0 transition-all duration-300 ease-out ${
                      isSelected
                        ? "ring-2 ring-primary shadow-lg"
                        : isFocused
                          ? "ring-2 ring-primary/30 shadow-md"
                          : "opacity-50 shadow-sm"
                    }`}
                    style={{
                      width: ITEM_WIDTH,
                      height: 200,
                    }}
                    data-testid={`intent-profile-${i}`}
                  >
                    {photo ? (
                      <img
                        src={photo}
                        alt={profile.firstName}
                        className="w-full h-full object-cover pointer-events-none"
                        draggable={false}
                      />
                    ) : (
                      <div className="w-full h-full bg-muted flex items-center justify-center">
                        <Flower2 className="w-8 h-8 text-muted-foreground" />
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                      <p className="text-white text-sm font-medium truncate">
                        {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <Button
          onClick={spinWheel}
          disabled={isSpinning || items.length === 0}
          className="rounded-full px-8 gap-2"
          size="lg"
          data-testid="button-spin"
        >
          <RotateCw className={`w-5 h-5 ${isSpinning ? "animate-spin" : ""}`} />
          {isSpinning ? "Spinning..." : "Spin"}
        </Button>

        {selectedProfile && !isSpinning && (
          <Card
            className="mx-5 p-5 space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 mb-4"
            data-testid="intent-result"
          >
            <div className="flex items-center gap-3 flex-wrap">
              {selectedProfile.photos?.[0] && (
                <img
                  src={selectedProfile.photos[0]}
                  alt={selectedProfile.firstName}
                  className="w-14 h-14 rounded-full object-cover ring-2 ring-primary/20"
                  data-testid="img-intent-result"
                />
              )}
              <div>
                <h3 className="font-serif text-lg font-semibold" data-testid="text-intent-result-name">
                  {selectedProfile.firstName}{selectedProfile.age ? `, ${selectedProfile.age}` : ""}
                </h3>
                {selectedProfile.location && (
                  <p className="text-xs text-muted-foreground" data-testid="text-intent-result-location">
                    {selectedProfile.location}
                  </p>
                )}
              </div>
            </div>

            {selectedProfile.datingIntent && (
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" data-testid="text-intent-result-intent">
                  {selectedProfile.datingIntent}
                </Badge>
              </div>
            )}

            {selectedProfile.signals && selectedProfile.signals.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedProfile.signals.map((signal, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    data-testid={`text-intent-signal-${i}`}
                  >
                    {signal}
                  </Badge>
                ))}
              </div>
            )}

            {selectedProfile.conversationStarters && selectedProfile.conversationStarters.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Conversation Starter</p>
                <p className="text-sm leading-relaxed" data-testid="text-intent-starter">
                  {selectedProfile.conversationStarters[0]}
                </p>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
