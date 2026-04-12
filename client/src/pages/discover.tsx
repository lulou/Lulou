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
import { MapPin, Ruler, MessageCircle, HelpCircle, Send } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { AnimatePresence, motion } from "framer-motion";

const SLOT_W = 180;
const SLOT_H = 280;
const UNFOCUSED_SCALE = 0.78;

function PhotoBubbles({ photos, name, onOpen, isDisabled, isPhotosLoading }: { photos: string[]; name: string; onOpen: () => void; isDisabled?: boolean; isPhotosLoading?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const focusedRef = useRef(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rafId = useRef(0);
  const ticking = useRef(false);

  const commitFocus = useCallback(() => {
    ticking.current = false;
    const container = scrollRef.current;
    if (!container) return;
    const center = container.scrollLeft + container.offsetWidth / 2;
    let closest = 0;
    let minDist = Infinity;
    itemRefs.current.forEach((el, i) => {
      if (!el) return;
      const mid = el.offsetLeft + el.offsetWidth / 2;
      const d = Math.abs(center - mid);
      if (d < minDist) { minDist = d; closest = i; }
    });
    if (focusedRef.current !== closest) {
      focusedRef.current = closest;
      setFocusedIndex(closest);
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!ticking.current) {
      ticking.current = true;
      rafId.current = requestAnimationFrame(commitFocus);
    }
  }, [commitFocus]);

  useEffect(() => {
    return () => cancelAnimationFrame(rafId.current);
  }, []);

  if (isPhotosLoading) {
    return (
      <div className="h-80 bg-muted/60 rounded-md animate-pulse flex items-center justify-center" data-testid="photo-loading-skeleton">
        <LulouFlowerIcon className="w-10 h-10 text-muted-foreground/30" />
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="flex justify-center py-4 px-4" data-testid="photo-bubbles-empty">
        <div className="relative rounded-2xl overflow-hidden shadow-md bg-muted flex items-center justify-center" style={{ width: SLOT_W, height: SLOT_H }}>
          <LulouFlowerIcon className="w-16 h-16 text-muted-foreground/40" />
          <button
            style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 10 }}
            className="flex items-center gap-1.5 bg-primary text-white rounded-full pl-3 pr-4 py-2 shadow-lg active:scale-95"
            onClick={onOpen}
            disabled={isDisabled}
            data-testid="button-open"
          >
            <span className="text-lg">❤️</span>
            <span className="text-sm font-semibold">Open</span>
          </button>
        </div>
      </div>
    );
  }

  if (photos.length === 1) {
    return (
      <div className="flex justify-center py-4 px-4" data-testid="photo-bubbles">
        <div className="relative rounded-2xl overflow-hidden shadow-lg" style={{ width: SLOT_W, height: SLOT_H }}>
          <img
            src={photos[0]}
            alt={`${name} photo 1`}
            className="w-full h-full object-cover pointer-events-none"
            draggable={false}
            data-testid="img-profile-photo-0"
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "linear-gradient(to top, rgba(0,0,0,0.35) 0%, transparent 40%)",
              pointerEvents: "none",
            }}
          />
          <button
            style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 10 }}
            className="flex items-center gap-1.5 bg-primary text-white rounded-full pl-3 pr-4 py-2 shadow-lg active:scale-95"
            onClick={onOpen}
            disabled={isDisabled}
            data-testid="button-open"
          >
            <span className="text-lg">❤️</span>
            <span className="text-sm font-semibold">Open</span>
          </button>
        </div>
      </div>
    );
  }

  const padSide = `calc(50% - ${SLOT_W / 2}px)`;

  return (
    <div className="relative" data-testid="photo-bubbles-wrapper">
      <div
        ref={scrollRef}
        className="scrollbar-hide select-none"
        style={{
          overflowX: "auto",
          overflowY: "hidden",
          WebkitOverflowScrolling: "touch",
          scrollSnapType: "x mandatory",
        }}
        onScroll={handleScroll}
        data-testid="photo-bubbles"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingTop: 20,
            paddingBottom: 20,
            paddingLeft: padSide,
            paddingRight: padSide,
          }}
        >
          {photos.map((photo, i) => {
            const isFocused = i === focusedIndex;
            return (
              <div
                key={i}
                ref={(el) => { itemRefs.current[i] = el; }}
                style={{
                  flex: "0 0 auto",
                  width: SLOT_W,
                  height: SLOT_H,
                  scrollSnapAlign: "center",
                }}
                data-testid={`photo-bubble-${i}`}
              >
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    borderRadius: 16,
                    overflow: "hidden",
                    transform: isFocused
                      ? "translateZ(0) scale(1)"
                      : `translateZ(0) scale(${UNFOCUSED_SCALE})`,
                    opacity: isFocused ? 1 : 0.55,
                    boxShadow: isFocused
                      ? "0 14px 30px -6px rgba(0,0,0,0.2)"
                      : "0 4px 12px -2px rgba(0,0,0,0.06)",
                    willChange: "transform, opacity",
                    backfaceVisibility: "hidden",
                    transition: "transform 0.3s cubic-bezier(0.25,1,0.5,1), opacity 0.3s ease-out, box-shadow 0.3s ease-out",
                  }}
                >
                  <img
                    src={photo}
                    alt={`${name} photo ${i + 1}`}
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      pointerEvents: "none",
                    }}
                    draggable={false}
                    loading="eager"
                    decoding="async"
                    data-testid={`img-profile-photo-${i}`}
                  />
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: isFocused
                        ? "linear-gradient(to top, rgba(0,0,0,0.32) 0%, transparent 45%)"
                        : "none",
                      pointerEvents: "none",
                    }}
                  />
                  {isFocused && (
                    <button
                      style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", zIndex: 10 }}
                      className="flex items-center gap-1.5 bg-primary text-white rounded-full pl-3 pr-4 py-2 shadow-lg active:scale-95"
                      onClick={(e) => { e.stopPropagation(); onOpen(); }}
                      disabled={isDisabled}
                      data-testid="button-open"
                    >
                      <span className="text-lg">❤️</span>
                      <span className="text-sm font-semibold">Open</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {photos.length > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 5, paddingTop: 2, paddingBottom: 6 }}>
          {photos.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === focusedIndex ? 20 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === focusedIndex
                  ? "hsl(var(--primary))"
                  : "hsl(var(--muted-foreground) / 0.2)",
                transition: "width 0.3s ease-out, background-color 0.3s ease-out",
              }}
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

  const startY = useRef(0);
  const committed = useRef(false);

  const glide = useCallback(() => {
    const el = scrollRef.current;
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
    if (e.pointerType === "touch") return;
    const el = scrollRef.current;
    if (!el) return;
    cancelAnimationFrame(animFrame.current);
    velocity.current = 0;
    isDragging.current = true;
    didDrag.current = false;
    committed.current = false;
    startX.current = e.clientX;
    startY.current = e.clientY;
    lastX.current = e.clientX;
    lastTime.current = Date.now();
    scrollLeftStart.current = el.scrollLeft;
    el.style.cursor = "grabbing";
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !scrollRef.current || e.pointerType === "touch") return;
    if (!committed.current) {
      const adx = Math.abs(e.clientX - startX.current);
      const ady = Math.abs(e.clientY - startY.current);
      if (ady > adx) { isDragging.current = false; return; }
      if (adx < 5) return;
      committed.current = true;
    }
    didDrag.current = true;
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = (dx / dt) * 16;
    lastX.current = e.clientX;
    lastTime.current = now;
    const totalDx = e.clientX - startX.current;
    scrollRef.current.scrollLeft = scrollLeftStart.current - totalDx;
  };

  const handlePointerUp = () => {
    isDragging.current = false;
    committed.current = false;
    if (scrollRef.current) scrollRef.current.style.cursor = "grab";
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
        className="scrollbar-hide select-none cursor-grab"
        style={{
          display: "flex",
          overflowX: "auto",
          overflowY: "hidden",
          WebkitOverflowScrolling: "touch",
          transform: "translateZ(0)",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        data-testid={isStarter ? "slide-starters" : "slide-questions"}
      >
        <div className="flex gap-3 px-1" style={{ display: "flex", gap: 12, paddingLeft: 4, paddingRight: 4 }}>
          {items.map((item, i) => (
            <div
              key={i}
              className={`rounded-md px-4 py-3 text-sm leading-relaxed cursor-pointer ${
                isStarter
                  ? "bg-muted/50 hover-elevate"
                  : "border hover-elevate"
              } ${activeIndex === i ? "ring-2 ring-primary/40" : ""}`}
              style={{
                flex: "0 0 auto",
                maxWidth: 260,
                minWidth: 200,
                transform: "translateZ(0)",
                backfaceVisibility: "hidden",
              }}
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

  // Track which profiles have been shown this session (local queue advancement)
  const [shownIds, setShownIds] = useState<Set<string>>(new Set());
  // Accumulate profiles across refetches so the feed doesn't reset
  const [accumulatedProfiles, setAccumulatedProfiles] = useState<Profile[]>([]);
  const refetchInProgress = useRef(false);

  const { data: profilesData, isLoading, isFetching, refetch } = useQuery<Profile[]>({
    queryKey: ["/api/discover"],
    staleTime: Infinity, // only refetch on explicit demand
  });

  // Merge newly fetched profiles into the accumulated pool (no duplicates)
  useEffect(() => {
    if (!profilesData || !Array.isArray(profilesData)) return;
    setAccumulatedProfiles(prev => {
      const existingIds = new Set(prev.map(p => p.userId));
      const newOnes = profilesData.filter(p => !existingIds.has(p.userId));
      return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
    });
  }, [profilesData]);

  // Profiles not yet shown in this session
  const visibleProfiles = accumulatedProfiles.filter(p => !shownIds.has(p.userId));
  const currentProfile = visibleProfiles[0];
  const nextProfile = visibleProfiles[1];

  // When pool runs low (≤ 2 remaining), silently fetch more from the server
  useEffect(() => {
    if (visibleProfiles.length <= 2 && accumulatedProfiles.length > 0 && !refetchInProgress.current) {
      refetchInProgress.current = true;
      refetch().finally(() => { refetchInProgress.current = false; });
    }
  }, [visibleProfiles.length]);

  // Lazy-load photos for the current card (photos are excluded from the pool query to avoid timeouts)
  const { data: photoData, isLoading: isPhotosLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", currentProfile?.userId, "photos"],
    enabled: !!currentProfile?.userId,
    staleTime: 5 * 60 * 1000,
  });

  // Debug logging: log photo state for each profile card
  useEffect(() => {
    if (!currentProfile?.userId) return;
    if (isPhotosLoading) {
      console.log("[DISCOVER] Photos loading for userId:", currentProfile.userId);
    } else {
      const count = photoData?.photos?.length ?? 0;
      console.log("[DISCOVER] Photos resolved for userId:", currentProfile.userId, "— count:", count, photoData?.photos?.[0] ? "(first url length:" + photoData.photos[0].length + ")" : "(none)");
    }
  }, [currentProfile?.userId, isPhotosLoading, photoData]);

  // Pre-fetch the next card's photos in the background for instant display
  useEffect(() => {
    if (nextProfile?.userId) {
      queryClient.prefetchQuery({
        queryKey: ["/api/profiles", nextProfile.userId, "photos"],
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [nextProfile?.userId]);

  // Merge photos into the pool profile for rendering
  // Note: when isPhotosLoading is true, photos stays empty — PhotoBubbles shows skeleton instead of "No photos"
  const displayProfile = currentProfile
    ? { ...currentProfile, photos: photoData?.photos ?? [] }
    : undefined;

  const interact = useMutation({
    mutationFn: async (type: "open" | "close") => {
      if (!currentProfile) return;
      // Advance the feed immediately — do not wait for a server refetch
      setShownIds(prev => new Set([...prev, currentProfile.userId]));
      try {
        const res = await apiRequest("POST", "/api/interactions", {
          toUserId: currentProfile.userId,
          type,
        });
        return { ...(await res.json()), profileId: currentProfile.userId, interactionType: type };
      } catch (err: any) {
        console.error("INTERACTION_ERROR", type, err?.message || err);
        toast({
          title: type === "open" ? "Couldn't send like" : "Couldn't close",
          description: err?.message || "Something went wrong. Try again.",
          variant: "destructive",
        });
        return { skipped: true };
      }
    },
    onSuccess: (data) => {
      if (data?.skipped) return;
      if (data?.matched) {
        toast({
          title: "It's mutual",
          description: `You and ${data.profileId ? accumulatedProfiles.find(p => p.userId === data.profileId)?.firstName : currentProfile?.firstName} both opened up.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      }
    },
  });

  const handleReply = (promptText: string, reply: string) => {
    toast({
      title: "Reply noted",
      description: `When you match with ${currentProfile?.firstName}, your reply will be sent as your first message.`,
    });
  };

  // Show skeleton on initial load OR when pool is empty and more are being fetched
  const isLoadingMore = isFetching && accumulatedProfiles.length > 0 && visibleProfiles.length === 0;
  if (isLoading || isLoadingMore) {
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

  if (!displayProfile) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <LulouFlowerIcon className="w-8 h-8 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-profiles">That's everyone for now</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Take a breath. New people join Lulou every day. We'll let you know when someone new arrives.
          </p>
        </div>
      </div>
    );
  }

  const photos = displayProfile.photos || [];
  const signals = displayProfile.signals || [];
  const greenFlags = displayProfile.greenFlags || [];
  const conversationStarters = displayProfile.conversationStarters || [];
  const questions = displayProfile.questions || [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b px-5 py-3">
        <div className="max-w-md mx-auto flex items-center gap-2">
          <h1 className="font-serif text-lg font-bold truncate" data-testid="text-discover-sticky-name">
            {displayProfile.firstName}, {displayProfile.age}
          </h1>
          {displayProfile.location && (
            <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
              <MapPin className="w-3 h-3" />
              {displayProfile.location}
            </span>
          )}
        </div>
      </div>
      <div className="max-w-md mx-auto p-4 md:p-6 space-y-5 pb-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={displayProfile.id}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            data-testid="profile-container"
          >
            <Card className="overflow-hidden" data-testid="card-profile">
              <PhotoBubbles photos={photos} name={displayProfile.firstName} onOpen={() => interact.mutate("open")} isDisabled={interact.isPending} isPhotosLoading={isPhotosLoading} />

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
                    {displayProfile.firstName}, {displayProfile.age}
                  </h2>
                  {displayProfile.height && (
                    <div className="flex items-center gap-1 text-muted-foreground text-sm">
                      <Ruler className="w-3.5 h-3.5" />
                      <span data-testid="text-profile-height">{displayProfile.height}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-muted-foreground text-sm">
                    <MapPin className="w-3.5 h-3.5" />
                    <span data-testid="text-profile-location">{displayProfile.location}</span>
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
                  <p className="font-medium" data-testid="text-profile-intent">{displayProfile.datingIntent}</p>
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
                  <p className="font-medium" data-testid="text-profile-style">{displayProfile.connectionStyle}</p>
                </div>
              </div>
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>

      <button
        className="fixed bottom-20 right-4 z-40 w-12 h-12 rounded-full border border-muted-foreground/20 bg-background/90 backdrop-blur-sm flex items-center justify-center text-lg shadow-lg transition-all active:scale-90 hover:border-muted-foreground/40 hover:shadow-xl"
        onClick={() => interact.mutate("close")}
        disabled={interact.isPending}
        data-testid="button-close"
      >
        <span role="img" aria-label="Close">🌙</span>
      </button>
    </div>
  );
}
