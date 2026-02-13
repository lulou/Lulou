import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { DragScrollRow } from "@/components/drag-scroll-row";
import type { Profile } from "@shared/schema";
import { MapPin, Sparkles, Ruler, MessageCircle, HelpCircle, Send } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

function PhotoBubbles({ photos, name }: { photos: string[]; name: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftStart = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const velocity = useRef(0);
  const animFrame = useRef<number>(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const updateFocused = useCallback(() => {
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
  }, []);

  const glide = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(velocity.current) < 0.5) {
      velocity.current = 0;
      updateFocused();
      return;
    }
    el.scrollLeft -= velocity.current;
    velocity.current *= 0.94;
    updateFocused();
    animFrame.current = requestAnimationFrame(glide);
  }, [updateFocused]);

  const handlePointerDown = (e: React.PointerEvent) => {
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
    if (dt > 0) {
      velocity.current = dx / dt * 16;
    }
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

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

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

function SlideCards({ items, type, onReply }: { items: string[]; type: "starter" | "question"; onReply: (text: string, reply: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const didDrag = useRef(false);
  const startX = useRef(0);
  const scrollLeftStart = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const velocity = useRef(0);
  const animFrame = useRef<number>(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [reply, setReply] = useState("");

  const glide = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(velocity.current) < 0.5) {
      velocity.current = 0;
      return;
    }
    el.scrollLeft -= velocity.current;
    velocity.current *= 0.93;
    animFrame.current = requestAnimationFrame(glide);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    cancelAnimationFrame(animFrame.current);
    velocity.current = 0;
    isDragging.current = true;
    didDrag.current = false;
    startX.current = e.clientX;
    lastX.current = e.clientX;
    lastTime.current = Date.now();
    scrollLeftStart.current = el.scrollLeft;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !scrollRef.current) return;
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = dx / dt * 16;
    lastX.current = e.clientX;
    lastTime.current = now;
    const totalDx = e.clientX - startX.current;
    if (Math.abs(totalDx) > 5) didDrag.current = true;
    scrollRef.current.scrollLeft = scrollLeftStart.current - totalDx;
  };

  const handlePointerUp = () => {
    isDragging.current = false;
    if (Math.abs(velocity.current) > 1) {
      animFrame.current = requestAnimationFrame(glide);
    }
  };

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

  const handleCardClick = (i: number) => {
    if (didDrag.current) return;
    setActiveIndex(activeIndex === i ? null : i);
    setReply("");
  };

  const handleSend = (text: string) => {
    if (!reply.trim()) return;
    onReply(text, reply.trim());
    setReply("");
    setActiveIndex(null);
  };

  const isStarter = type === "starter";

  return (
    <div className="space-y-2">
      <div
        ref={scrollRef}
        className="overflow-x-auto scrollbar-hide select-none touch-pan-y cursor-grab"
        style={{ WebkitOverflowScrolling: "touch" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        data-testid={isStarter ? "slide-starters" : "slide-questions"}
      >
        <div className="flex gap-3 px-1" style={{ width: "max-content" }}>
          {items.map((item, i) => (
            <div
              key={i}
              className={`rounded-md px-4 py-3 text-sm leading-relaxed flex-shrink-0 cursor-pointer transition-all ${
                isStarter
                  ? "bg-muted/50 hover-elevate"
                  : "border hover-elevate"
              } ${activeIndex === i ? "ring-2 ring-primary/40" : ""}`}
              style={{ maxWidth: "260px", minWidth: "200px" }}
              onClick={() => handleCardClick(i)}
              data-testid={isStarter ? `text-starter-${i}` : `text-question-${i}`}
            >
              {item}
            </div>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {activeIndex !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex gap-2 items-end px-1">
              <Input
                value={reply}
                onChange={e => setReply(e.target.value.slice(0, 200))}
                placeholder={isStarter ? "Reply to this..." : "Share your answer..."}
                className="text-sm"
                onKeyDown={e => {
                  if (e.key === "Enter" && reply.trim()) handleSend(items[activeIndex]);
                }}
                data-testid={`input-reply-${type}`}
              />
              <Button
                size="icon"
                disabled={!reply.trim()}
                onClick={() => handleSend(items[activeIndex!])}
                data-testid={`button-reply-send-${type}`}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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

  const handleReply = (promptText: string, reply: string) => {
    toast({
      title: "Reply noted",
      description: `When you match with ${currentProfile?.firstName}, your reply will be sent as your first message.`,
    });
  };

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
  const conversationStarters = currentProfile.conversationStarters || [];
  const questions = currentProfile.questions || [];

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
                {conversationStarters.length > 0 && (
                  <div className="space-y-3" data-testid="section-conversation-starters">
                    <div className="flex items-center gap-1.5">
                      <MessageCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-medium tracking-wider uppercase text-primary">Conversation Starters</p>
                    </div>
                    <SlideCards items={conversationStarters} type="starter" onReply={handleReply} />
                  </div>
                )}

                {questions.length > 0 && (
                  <div className="space-y-3" data-testid="section-questions">
                    <div className="flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-medium tracking-wider uppercase text-primary">Ask Me</p>
                    </div>
                    <SlideCards items={questions} type="question" onReply={handleReply} />
                  </div>
                )}

                <div className="flex items-baseline gap-2 flex-wrap">
                  <h2 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
                    {currentProfile.firstName}, {currentProfile.age}
                  </h2>
                  {currentProfile.height && (
                    <div className="flex items-center gap-1 text-muted-foreground text-sm">
                      <Ruler className="w-3.5 h-3.5" />
                      <span data-testid="text-profile-height">{currentProfile.height}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-muted-foreground text-sm">
                    <MapPin className="w-3.5 h-3.5" />
                    <span data-testid="text-profile-location">{currentProfile.location}</span>
                  </div>
                </div>

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
              </div>
            </Card>

            <div className="flex items-center justify-center gap-6 mt-6">
              <div className="text-center">
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full text-2xl"
                  onClick={() => interact.mutate("close")}
                  disabled={interact.isPending}
                  data-testid="button-close"
                >
                  <span role="img" aria-label="Close">&#127769;</span>
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">Close</p>
              </div>
              <div className="text-center">
                <Button
                  size="icon"
                  className="rounded-full text-3xl"
                  onClick={() => interact.mutate("open")}
                  disabled={interact.isPending}
                  data-testid="button-open"
                >
                  <span role="img" aria-label="Open">&#10084;&#65039;</span>
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">Open</p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
