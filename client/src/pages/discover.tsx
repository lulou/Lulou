import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { useLanguageContext } from "@/contexts/language-context";
import { usePerfTrace, useRenderCount, isMobile, scheduleIdle } from "@/lib/perf";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, batchPrefetchPhotos } from "@/lib/queryClient";
import { DragScrollRow } from "@/components/drag-scroll-row";
import { ProfilePhotoViewer } from "@/components/profile-photo-viewer";
import type { Profile } from "@shared/schema";
import { MapPin, Ruler, MessageCircle, HelpCircle, Send } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { EMPTY_PHOTOS } from "@/lib/image-utils";

// Full-width draggable photo card.
// Uses ProfilePhotoViewer (shared): photos follow finger, spring-settle on release, gap between slides.
// Gallery photos fetch on card mount; carousel lazy-loads ±1 from current.

// Thin wrapper around the shared ProfilePhotoViewer — memoised so it only
// re-renders when photos/name/disabled/loading state actually changes.
const PhotoBubbles = memo(function PhotoBubbles({ photos, name: _name, onOpen, isDisabled, isPhotosLoading }: { photos: string[]; name: string; onOpen: () => void; isDisabled?: boolean; isPhotosLoading?: boolean }) {
  return (
    <ProfilePhotoViewer
      photos={photos}
      isLoading={isPhotosLoading}
      action={
        <button
          className="flex items-center gap-2 bg-primary text-white rounded-full pl-4 pr-5 py-2.5 text-sm font-semibold shadow-lg active:scale-95 disabled:opacity-60"
          onClick={onOpen}
          disabled={isDisabled}
          data-testid="button-open"
        >
          <span className="text-lg leading-none">❤️</span>
          Open
        </button>
      }
    />
  );
});

// Memoised: only re-renders when items/type/onReply actually change.
// Prevents re-render when parent mutation isPending state toggles (2× per tap).
const SlideCards = memo(function SlideCards({ items, type, onReply }: { items: string[]; type: "starter" | "question"; onReply: (text: string, reply: string) => void }) {
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

      {/*
        Reply input — CSS max-height/opacity transition instead of framer-motion
        height:"auto" animation. The height:"auto" approach requires a layout
        measurement (getBoundingClientRect) on every frame, causing a synchronous
        reflow. max-height transition is compositor-only and zero-layout-cost.
        The input is always rendered so the transition can play in both directions.
      */}
      <div
        style={{
          maxHeight: activeIndex !== null ? 64 : 0,
          opacity: activeIndex !== null ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.18s ease, opacity 0.15s ease",
          pointerEvents: activeIndex !== null ? "auto" : "none",
        }}
      >
        <div className="flex gap-2 items-end px-1 pt-1">
          <Input
            value={reply}
            onChange={e => setReply(e.target.value.slice(0, 200))}
            placeholder={isStarter ? "Reply to this..." : "Share your answer..."}
            className="text-sm"
            onKeyDown={e => {
              if (e.key === "Enter" && reply.trim() && activeIndex !== null) handleSend(items[activeIndex]);
            }}
            data-testid={`input-reply-${type}`}
          />
          <Button
            size="icon"
            disabled={!reply.trim()}
            onClick={() => activeIndex !== null && handleSend(items[activeIndex])}
            data-testid={`button-reply-send-${type}`}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});

// Max profiles to keep in the accumulated pool. Profiles already dismissed
// are pruned once the pool exceeds this threshold, bounding the useMemo filter cost.
const MAX_POOL_SIZE = 60;

export default function Discover() {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Dev-only page lifecycle instrumentation — no-op in production
  useRenderCount("Discover");
  const { markDataReceived, markPageReady } = usePerfTrace("DISCOVER");

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

  // Perf: fire DATA_RECEIVED once the profile pool arrives
  useEffect(() => {
    if (profilesData) markDataReceived({ count: profilesData.length });
  }, [profilesData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop the "loading too long" timer based on isLoading state
  useEffect(() => {
    if (isLoading) {
      setLoadingTooLong(false);
      loadingTimerRef.current = setTimeout(() => setLoadingTooLong(true), 8_000);
    } else {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setLoadingTooLong(false);
    }
    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    };
  }, [isLoading]);

  // Keep a ref mirror of shownIds so the merge effect can prune without
  // needing shownIds as a dependency (which would cause the effect to re-run on
  // every tap and re-merge unnecessarily).
  const shownIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { shownIdsRef.current = shownIds; }, [shownIds]);

  // Merge newly fetched profiles into the accumulated pool (no duplicates).
  // When the pool grows past MAX_POOL_SIZE, prune already-shown profiles to keep
  // the array small — this bounds the visibleProfiles useMemo filter cost.
  useEffect(() => {
    if (!profilesData || !Array.isArray(profilesData)) return;
    setAccumulatedProfiles(prev => {
      const existingIds = new Set(prev.map(p => p.userId));
      const newOnes = profilesData.filter(p => !existingIds.has(p.userId));
      if (newOnes.length === 0) return prev;
      const combined = [...prev, ...newOnes];
      if (combined.length > MAX_POOL_SIZE) {
        // Prune profiles already dismissed to keep the array bounded.
        const pruned = combined.filter(p => !shownIdsRef.current.has(p.userId));
        return pruned.length > 0 ? pruned : combined;
      }
      return combined;
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

  // Lazy-load photos for the current card (photos are excluded from the pool query)
  const { data: photoData, isLoading: isPhotosLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", currentProfile?.userId, "photos"],
    enabled: !!currentProfile?.userId,
    staleTime: 5 * 60 * 1000,
  });

  // Batch-prefetch photos for the current card (and next on desktop).
  // Mobile: fetch only the current card immediately so the network + decode
  //   work doesn't compete with the first React paint. The next card is queued
  //   via scheduleIdle — it fires once the first frame is committed.
  // Desktop: prefetch current + next 2 eagerly (3 total) — more cores/memory.
  // batchPrefetchPhotos is idempotent: skips IDs with fresh cache so it's
  // safe to call on every visibleProfiles change.
  useEffect(() => {
    if (!visibleProfiles.length) return;
    const immediateIds = visibleProfiles
      .slice(0, isMobile ? 1 : 3)
      .map(p => p.userId)
      .filter(Boolean);
    if (immediateIds.length > 0) batchPrefetchPhotos(immediateIds);
    // Defer next card on mobile — fire after the current render commits
    if (isMobile && visibleProfiles.length > 1) {
      scheduleIdle(() => {
        const deferred = visibleProfiles.slice(1, 2).map(p => p.userId).filter(Boolean);
        if (deferred.length > 0) batchPrefetchPhotos(deferred);
      });
    }
  }, [visibleProfiles]);

  // Perf: PAGE_READY fires once both the profile list AND its first photo are loaded
  useEffect(() => {
    if (!isPhotosLoading && photoData?.photos?.length) {
      markPageReady({ photoCount: photoData.photos.length });
    }
  }, [isPhotosLoading, photoData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge photos into the pool profile for rendering.
  // Memoised so re-renders from mutation isPending state don't recreate the
  // object and thrash child component prop comparisons.
  // EMPTY_PHOTOS is a stable module-level reference — avoids a new [] on every
  // render while photos are loading.
  const displayProfile = useMemo(() => {
    if (!currentProfile) return undefined;
    return { ...currentProfile, photos: photoData?.photos ?? EMPTY_PHOTOS };
  }, [currentProfile, photoData?.photos]);

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
          title: t("its_mutual"),
          description: `You and ${data.profileId ? accumulatedProfiles.find(p => p.userId === data.profileId)?.firstName : currentProfile?.firstName} both opened up.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      }
    },
  });

  // Stable callbacks — prevent SlideCards / PhotoBubbles from re-rendering
  // when parent mutation state changes but these handlers haven't changed.
  const handleOpen = useCallback(() => interact.mutate("open"), [interact.mutate]);

  const handleReply = useCallback((_promptText: string, _reply: string) => {
    toast({
      title: t("reply_noted"),
      description: `When you match with ${currentProfile?.firstName}, your reply will be sent as your first message.`,
    });
  }, [toast, t, currentProfile?.firstName]);

  // ─── STEP 2: Minimal render — confirms routing/layout works ─────────────────
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
            <h2 className="font-serif text-xl font-bold" data-testid="text-discover-slow">{t("loading_slow")}</h2>
            <p className="text-muted-foreground text-sm">This is taking longer than usual. Tap retry to try again.</p>
            <button
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
              onClick={() => { setLoadingTooLong(false); refetch(); }}
              data-testid="button-retry-discover-slow"
            >
              {t("retry")}
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
          <h2 className="font-serif text-xl font-bold" data-testid="text-discover-error">{t("error_load_profiles")}</h2>
          <p className="text-muted-foreground text-sm">{t("something_went_wrong")}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={() => refetch()}
            data-testid="button-retry-discover"
          >
            {t("try_again")}
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
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-profiles">{t("all_caught_up")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("all_caught_up_desc")}
          </p>
        </div>
      </div>
    );
  }

  const photos = displayProfile.photos;
  const signals = displayProfile.signals || [];
  const greenFlags = displayProfile.greenFlags || [];
  const conversationStarters = displayProfile.conversationStarters || [];
  const questions = displayProfile.questions || [];
  const customQuestions: Array<{ question: string; answer: string }> = (displayProfile as any).customQuestions || [];
  const customQAsItems = customQuestions.map(cq => `${cq.question} ${cq.answer}`);
  const viewerQuestions: Array<{ question: string }> = (displayProfile as any).viewerQuestions || [];
  const customStarters: string[] = (displayProfile as any).customStarters || [];
  const allStarters = [...conversationStarters, ...customStarters];

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
        {/*
          Pure CSS fade-in — replaces framer-motion AnimatePresence.
          React unmounts the old card and mounts the new one when the key
          changes. The "fadeIn" keyframe (defined in index.css) and
          animationFillMode:"both" ensure the card starts at opacity:0
          before the browser paints — identical visual to motion.div but
          with zero JS per-frame overhead. This matters most on iPhone
          where framer-motion's JS scheduler competes with the main thread
          during profile transitions.
        */}
        <div
          key={displayProfile.id}
          style={{ animation: "fadeIn 0.12s ease both" }}
          data-testid="profile-container"
        >
            <Card className="overflow-hidden" data-testid="card-profile">
              <PhotoBubbles
                photos={photos}
                name={displayProfile.firstName}
                onOpen={handleOpen}
                isDisabled={interact.isPending}
                isPhotosLoading={isPhotosLoading}
              />

              <div className="px-5 pb-5 pt-3 space-y-5" data-testid="profile-about-section">
                {allStarters.length > 0 && (
                  <div className="space-y-3" data-testid="section-conversation-starters">
                    <div className="flex items-center gap-1.5">
                      <MessageCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("conversation_starters")}</p>
                    </div>
                    <SlideCards items={allStarters} type="starter" onReply={handleReply} />
                  </div>
                )}

                {viewerQuestions.length > 0 && (
                  <div className="space-y-3" data-testid="section-viewer-questions">
                    <div className="flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-medium tracking-wider uppercase text-primary">They'd love to know</p>
                    </div>
                    <SlideCards items={viewerQuestions.map(vq => vq.question)} type="starter" onReply={handleReply} />
                  </div>
                )}

                {(questions.length > 0 || customQAsItems.length > 0) && (
                  <div className="space-y-3" data-testid="section-questions">
                    <div className="flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("ask_me")}</p>
                    </div>
                    <SlideCards items={[...questions, ...customQAsItems]} type="question" onReply={handleReply} />
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
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("personality")}</p>
                  <DragScrollRow>
                    {signals.map(signal => (
                      <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-signal-${signal}`}>
                        {signal}
                      </Badge>
                    ))}
                  </DragScrollRow>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("looking_for")}</p>
                  <p className="font-medium" data-testid="text-profile-intent">{displayProfile.datingIntent}</p>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("green_flags_label")}</p>
                  <DragScrollRow>
                    {greenFlags.map(flag => (
                      <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-flag-${flag}`}>
                        {flag}
                      </Badge>
                    ))}
                  </DragScrollRow>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("pace_label")}</p>
                  <p className="font-medium" data-testid="text-profile-style">{displayProfile.connectionStyle}</p>
                </div>
              </div>
            </Card>
        </div>
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
