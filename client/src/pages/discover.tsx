import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { DragScrollRow } from "@/components/drag-scroll-row";
import { PhotoCarousel } from "@/components/photo-carousel";
import type { Profile } from "@shared/schema";
import { MapPin, Ruler, MessageCircle, HelpCircle, Send } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { AnimatePresence, motion } from "framer-motion";
import { EMPTY_PHOTOS } from "@/lib/image-utils";

// Full-width draggable photo card.
// Uses PhotoCarousel: photos follow finger, spring-settle on release, gap between slides.
// Gallery photos fetch on card mount; carousel lazy-loads ±1 from current.
const PHOTO_HEIGHT = 440;

function PhotoBubbles({ photos, name: _name, onOpen, isDisabled, isPhotosLoading }: { photos: string[]; name: string; onOpen: () => void; isDisabled?: boolean; isPhotosLoading?: boolean }) {
  const [photoIndex, setPhotoIndex] = useState(0);

  if (isPhotosLoading) {
    return (
      <div
        className="w-full"
        style={{
          height: PHOTO_HEIGHT,
          background: "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground)/0.08) 50%, hsl(var(--muted)) 75%)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.4s infinite linear",
        }}
        data-testid="photo-loading-skeleton"
      />
    );
  }

  if (photos.length === 0) {
    return (
      <div
        className="w-full relative flex items-center justify-center bg-muted"
        style={{ height: PHOTO_HEIGHT }}
        data-testid="photo-bubbles-empty"
      >
        <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-16 h-16 opacity-20">
          <circle cx="40" cy="28" r="14" fill="currentColor" />
          <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
        </svg>
        <button
          className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-primary text-white rounded-full pl-4 pr-5 py-2.5 text-sm font-semibold shadow-lg active:scale-95 disabled:opacity-60"
          onClick={onOpen}
          disabled={isDisabled}
          data-testid="button-open"
        >
          <span className="text-lg">❤️</span>
          Open
        </button>
      </div>
    );
  }

  return (
    <PhotoCarousel
      photos={photos}
      height={PHOTO_HEIGHT}
      showArrows={false}
      showDots={false}
      onIndexChange={setPhotoIndex}
    >
      {/* Bottom gradient */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.1) 48%, transparent 68%)" }}
      />

      {/* Bottom bar: dot indicators (left) + Open button (right) */}
      <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 flex items-end justify-between" style={{ zIndex: 10 }}>
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
        <button
          className="flex items-center gap-2 bg-primary text-white rounded-full pl-4 pr-5 py-2.5 text-sm font-semibold shadow-lg active:scale-95 disabled:opacity-60"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          disabled={isDisabled}
          data-testid="button-open"
        >
          <span className="text-lg leading-none">❤️</span>
          Open
        </button>
      </div>
    </PhotoCarousel>
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

  useEffect(() => {
    const t0 = performance.now();
    console.log("[PERF] DISCOVER_FIRST_RENDER", { ms: Math.round(t0) });
    return () => console.log("[PERF] DISCOVER_UNMOUNTED", { visibleMs: Math.round(performance.now() - t0) });
  }, []);

  // Track which profiles have been shown this session (local queue advancement)
  const [shownIds, setShownIds] = useState<Set<string>>(new Set());
  // Accumulate profiles across refetches so the feed doesn't reset
  const [accumulatedProfiles, setAccumulatedProfiles] = useState<Profile[]>([]);
  const refetchInProgress = useRef(false);

  // Track how long the loading skeleton has been visible so we can show a
  // "still loading" fallback after 8 seconds instead of a blank skeleton forever.
  const [loadingTooLong, setLoadingTooLong] = useState(false);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: profilesData, isLoading, isFetching, isError: isDiscoverError, refetch } = useQuery<Profile[]>({
    queryKey: ["/api/discover"],
    staleTime: Infinity, // only refetch on explicit demand
  });

  // Start/stop the "loading too long" timer based on isLoading state
  useEffect(() => {
    if (isLoading) {
      console.log("[DISCOVER] QUERY_LOADING_START");
      setLoadingTooLong(false);
      loadingTimerRef.current = setTimeout(() => {
        console.warn("[DISCOVER] QUERY_LOADING_SLOW: still loading after 8 s — showing retry UI");
        setLoadingTooLong(true);
      }, 8_000);
    } else {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setLoadingTooLong(false);
      console.log("[DISCOVER] QUERY_LOADING_END", {
        isError: isDiscoverError,
        rawCount: Array.isArray(profilesData) ? profilesData.length : 0,
      });
    }
    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    };
  }, [isLoading]);

  // Merge newly fetched profiles into the accumulated pool (no duplicates)
  useEffect(() => {
    if (!profilesData || !Array.isArray(profilesData)) return;
    const rawCount = profilesData.length;
    setAccumulatedProfiles(prev => {
      const existingIds = new Set(prev.map(p => p.userId));
      const newOnes = profilesData.filter(p => !existingIds.has(p.userId));
      console.log("[DISCOVER] PROFILES_MERGED", {
        rawCount,
        newCount: newOnes.length,
        totalAccumulated: prev.length + newOnes.length,
      });
      return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
    });
  }, [profilesData]);

  // Profiles not yet shown in this session — memoised so the filter only
  // reruns when either the accumulated pool or the shown-id set actually changes.
  const visibleProfiles = useMemo(
    () => accumulatedProfiles.filter(p => !shownIds.has(p.userId)),
    [accumulatedProfiles, shownIds],
  );
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

  // Merge photos into the pool profile for rendering.
  // EMPTY_PHOTOS is a stable module-level reference — avoids creating a new []
  // literal on every render while photos are loading, which would otherwise cause
  // the PhotoCarousel preload useEffect to re-fire on every render cycle.
  const displayProfile = currentProfile
    ? { ...currentProfile, photos: photoData?.photos ?? EMPTY_PHOTOS }
    : undefined;

  const interact = useMutation({
    mutationFn: async (type: "open" | "close") => {
      if (!currentProfile) return;
      // Advance the feed immediately — do not wait for a server refetch.
      // Use Set copy + .add() instead of spread to avoid O(n) array allocation.
      setShownIds(prev => { const s = new Set(prev); s.add(currentProfile.userId); return s; });
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

  // ─── STEP 2: Minimal render — confirms routing/layout works ─────────────────
  // Set STEP2_MINIMAL = false once we confirm this page renders (Step 4 restore).
  const STEP2_MINIMAL = false;
  if (STEP2_MINIMAL) {
    return (
      <div className="flex-1 p-6 space-y-3" data-testid="discover-diagnostic">
        <h2 className="text-lg font-semibold">Discover — Page Rendered ✓</h2>
        <div className="text-xs font-mono text-muted-foreground space-y-0.5">
          <div>isLoading: {String(isLoading)}</div>
          <div>isError: {String(isDiscoverError)}</div>
          <div>profiles accumulated: {accumulatedProfiles.length}</div>
          <div>visible: {visibleProfiles.length}</div>
        </div>
      </div>
    );
  }

  // Show skeleton on initial load OR when pool is empty and more are being fetched
  const isLoadingMore = isFetching && accumulatedProfiles.length > 0 && visibleProfiles.length === 0;
  if (isLoading || isLoadingMore) {
    if (loadingTooLong) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4 max-w-sm">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <LulouFlowerIcon className="w-8 h-8 text-primary/60" />
            </div>
            <h2 className="font-serif text-xl font-bold" data-testid="text-discover-slow">Still loading profiles…</h2>
            <p className="text-muted-foreground text-sm">This is taking longer than usual. Tap retry to try again.</p>
            <button
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
              onClick={() => { setLoadingTooLong(false); refetch(); }}
              data-testid="button-retry-discover-slow"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b px-5 py-3">
          <div className="max-w-md mx-auto">
            <Skeleton className="h-6 w-40" />
          </div>
        </div>
        <div className="max-w-md mx-auto p-4 md:p-6 space-y-5 pb-6">
          <Skeleton className="h-72 w-full rounded-md" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (isDiscoverError && accumulatedProfiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
            <LulouFlowerIcon className="w-8 h-8 text-primary/60" />
          </div>
          <h2 className="font-serif text-xl font-bold" data-testid="text-discover-error">Couldn't load profiles</h2>
          <p className="text-muted-foreground text-sm">Something went wrong loading discovery. Your connection is fine.</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={() => refetch()}
            data-testid="button-retry-discover"
          >
            Try Again
          </button>
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
