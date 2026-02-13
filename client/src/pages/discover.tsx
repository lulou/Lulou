import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { DragScrollRow } from "@/components/drag-scroll-row";
import type { Profile } from "@shared/schema";
import { MapPin, Sparkles, Heart, X, Ruler } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

function PhotoBubbles({ photos, name }: { photos: string[]; name: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftStart = useRef(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const updateFocused = () => {
    const container = scrollRef.current;
    if (!container) return;
    const containerCenter = container.scrollLeft + container.offsetWidth / 2;
    let closest = 0;
    let minDist = Infinity;
    itemRefs.current.forEach((el, i) => {
      if (!el) return;
      const itemCenter = el.offsetLeft + el.offsetWidth / 2;
      const dist = Math.abs(containerCenter - itemCenter);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    });
    setFocusedIndex(closest);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    isDragging.current = true;
    startX.current = e.clientX;
    scrollLeftStart.current = el.scrollLeft;
    el.style.cursor = "grabbing";
    el.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !scrollRef.current) return;
    const dx = e.clientX - startX.current;
    scrollRef.current.scrollLeft = scrollLeftStart.current - dx;
    updateFocused();
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    if (scrollRef.current) {
      scrollRef.current.style.cursor = "grab";
      scrollRef.current.releasePointerCapture(e.pointerId);
    }
    updateFocused();
  };

  if (photos.length === 0) {
    return (
      <div className="h-80 bg-muted rounded-md flex items-center justify-center">
        <p className="text-muted-foreground text-sm">No photos</p>
      </div>
    );
  }

  if (photos.length === 1) {
    return (
      <div className="flex justify-center py-4 px-4" data-testid="photo-bubbles">
        <div className="w-56 h-72 rounded-2xl overflow-hidden shadow-md ring-2 ring-primary/15">
          <img
            src={photos[0]}
            alt={`${name} photo 1`}
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
            data-testid="img-profile-photo-0"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative" data-testid="photo-bubbles-wrapper">
      <div
        ref={scrollRef}
        className="overflow-x-auto scrollbar-hide cursor-grab select-none touch-pan-y"
        style={{ WebkitOverflowScrolling: "touch" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onScroll={updateFocused}
        data-testid="photo-bubbles"
      >
        <div
          className="flex items-end gap-3 py-4"
          style={{
            paddingLeft: "calc(50% - 112px)",
            paddingRight: "calc(50% - 112px)",
            width: "max-content",
          }}
        >
          {photos.map((photo, i) => {
            const isFocused = i === focusedIndex;
            return (
              <div
                key={i}
                ref={(el) => { itemRefs.current[i] = el; }}
                className={`rounded-2xl overflow-hidden flex-shrink-0 transition-all duration-300 ease-out ${
                  isFocused
                    ? "w-56 h-72 shadow-lg ring-2 ring-primary/20"
                    : "w-40 h-56 shadow-md opacity-70"
                }`}
                data-testid={`photo-bubble-${i}`}
              >
                <img
                  src={photo}
                  alt={`${name} photo ${i + 1}`}
                  className="w-full h-full object-cover pointer-events-none"
                  draggable={false}
                  data-testid={`img-profile-photo-${i}`}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent pointer-events-none" />
      <div className="absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent pointer-events-none" />

      {photos.length > 1 && (
        <div className="flex justify-center gap-1.5 pt-1 pb-1">
          {photos.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
                i === focusedIndex ? "bg-primary" : "bg-muted-foreground/25"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Discover() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profiles, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/discover"],
  });

  const currentProfile = profiles?.[0];

  const interact = useMutation({
    mutationFn: async (type: "open" | "close") => {
      if (!currentProfile) return;
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId: currentProfile.userId,
        type,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.matched) {
        toast({
          title: "It's mutual",
          description: `You and ${currentProfile?.firstName} both opened up.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/discover"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="h-72 w-full rounded-md" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (!currentProfile) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-profiles">That's everyone for now</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Take a breath. New people join Bloom every day. We'll let you know when someone new arrives.
          </p>
        </div>
      </div>
    );
  }

  const photos = currentProfile.photos || [];
  const signals = currentProfile.signals || [];
  const greenFlags = currentProfile.greenFlags || [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-md mx-auto p-4 md:p-6 space-y-5 pb-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentProfile.id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            data-testid="profile-container"
          >
            <Card className="overflow-hidden" data-testid="card-profile">
              <PhotoBubbles photos={photos} name={currentProfile.firstName} />

              <div className="px-5 pb-5 pt-3 space-y-5" data-testid="profile-about-section">
                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">Personality</p>
                  <DragScrollRow>
                    {signals.map(signal => (
                      <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-signal-${signal}`}>
                        {signal}
                      </Badge>
                    ))}
                  </DragScrollRow>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">Looking for</p>
                  <p className="font-medium" data-testid="text-profile-intent">{currentProfile.datingIntent}</p>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">Green Flags</p>
                  <DragScrollRow>
                    {greenFlags.map(flag => (
                      <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-flag-${flag}`}>
                        {flag}
                      </Badge>
                    ))}
                  </DragScrollRow>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">Pace</p>
                  <p className="font-medium" data-testid="text-profile-style">{currentProfile.connectionStyle}</p>
                </div>

                <div className="border-t pt-4 mt-4">
                  <h2 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
                    {currentProfile.firstName}, {currentProfile.age}
                  </h2>
                  <div className="flex items-center gap-3 mt-1.5 text-muted-foreground text-sm flex-wrap">
                    <div className="flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5" />
                      <span data-testid="text-profile-location">{currentProfile.location}</span>
                    </div>
                    {currentProfile.height && (
                      <div className="flex items-center gap-1">
                        <Ruler className="w-3.5 h-3.5" />
                        <span data-testid="text-profile-height">{currentProfile.height}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <div className="flex items-center justify-center gap-5 mt-6">
              <div className="text-center">
                <Button
                  variant="outline"
                  className="w-14 h-14 rounded-full p-0"
                  onClick={() => interact.mutate("close")}
                  disabled={interact.isPending}
                  data-testid="button-close"
                >
                  <X className="w-5 h-5" />
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">Not for me</p>
              </div>
              <div className="text-center">
                <Button
                  className="w-16 h-16 rounded-full p-0"
                  onClick={() => interact.mutate("open")}
                  disabled={interact.isPending}
                  data-testid="button-open"
                >
                  <Heart className="w-6 h-6" />
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">I'm curious</p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
