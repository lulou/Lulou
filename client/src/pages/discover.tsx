import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { MatchOverlay, type MatchCelebration } from "@/components/match-overlay";
import { useLanguageContext } from "@/contexts/language-context";
import { LANGUAGE_NAME_TO_CODE } from "@/lib/i18n";
import { translateSignal, translateGreenFlag, translateIntent, translateStyle, translateStarterItem, translateQuestion } from "@/lib/profile-i18n";
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
import { MessageCircle, HelpCircle, Send, BadgeCheck } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { EMPTY_PHOTOS } from "@/lib/image-utils";
import { ProfileInfoRow } from "@/components/profile-info-row";
import { useAuth } from "@/hooks/use-auth";
import { LulouGuide } from "@/components/lulou-guide";
import { GUIDE_KEYS } from "@/lib/guide-store";

// Full-width draggable photo card.
// Uses ProfilePhotoViewer (shared): photos follow finger, spring-settle on release, gap between slides.
// Gallery photos fetch on card mount; carousel lazy-loads ±1 from current.

// Thin wrapper around the shared ProfilePhotoViewer — memoised so it only
// re-renders when photos/name/disabled/loading state actually changes.
const PhotoBubbles = memo(function PhotoBubbles({ photos, name: _name, onOpen, isDisabled, isPhotosLoading }: { photos: string[]; name: string; onOpen: () => void; isDisabled?: boolean; isPhotosLoading?: boolean }) {
  const { t } = useLanguageContext();
  return (
    <ProfilePhotoViewer
      photos={photos}
      isLoading={isPhotosLoading}
      action={
        <button
          className="flex items-center gap-2 bg-primary text-white rounded-full ps-4 pe-5 py-2.5 text-sm font-semibold shadow-lg active:scale-95 disabled:opacity-60"
          onClick={onOpen}
          disabled={isDisabled}
          data-testid="button-open"
        >
          <span className="text-lg leading-none">❤️</span>
          {t("open")}
        </button>
      }
    />
  );
});

// Memoised: only re-renders when items/type/onReply actually change.
// Prevents re-render when parent mutation isPending state toggles (2× per tap).
const SlideCards = memo(function SlideCards({ items, type, onReply }: { items: string[]; type: "starter" | "question"; onReply: (text: string, reply: string) => void }) {
  const { t, isRTL, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
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
    // dir="rtl" on the container means scrollLeft=0 is the visual start (right).
    // Dragging left → positive dx → scrollLeft should increase, so subtract a
    // negative velocity (i.e. when flicking left velocity < 0, subtract it to add).
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
    // With dir="rtl", dragging left (negative totalDx on screen) should increase
    // scrollLeft to reveal more content on the left side — so we subtract totalDx
    // (same direction regardless of RTL because the browser normalises it).
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
        dir={isRTL ? "rtl" : "ltr"}
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
        <div className="flex gap-3 px-1" style={{ display: "flex", gap: 12, paddingInlineStart: 4, paddingInlineEnd: 4 }}>
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
            placeholder={isStarter ? t("reply_to_this") : t("share_your_answer")}
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
  const { t, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Dev-only page lifecycle instrumentation — no-op in production
  useRenderCount("Discover");
  const { markDataReceived, markPageReady } = usePerfTrace("DISCOVER");

  // Track which profiles have been shown this session (local queue advancement)
  const [shownIds, setShownIds] = useState<Set<string>>(new Set());
  // Accumulate profiles across refetches so the feed doesn't reset
  const [accumulatedProfiles, setAccumulatedProfiles] = useState<Profile[]>([]);
  const refetchInProgress = useRef(false);

  // Exit animation state — true while the current card is animating out
  const [isExiting, setIsExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (exitTimerRef.current) clearTimeout(exitTimerRef.current); }, []);

  const [guideOpenTriggered,  setGuideOpenTriggered]  = useState(false);
  const [guideCloseTriggered, setGuideCloseTriggered] = useState(false);
  const [guideUndoTriggered,  setGuideUndoTriggered]  = useState(false);

  // Optimistic undo state — set immediately when user acts so the undo button
  // is ready before the server round-trip completes.
  // Initialised from sessionStorage so the undo button survives a page refresh
  // within the same browser session (sessionStorage is cleared on tab close).
  const UNDO_STORAGE_KEY = "lulou_last_acted";
  const [lastActedProfile, setLastActedProfileRaw] = useState<{ id: string; name: string } | null>(() => {
    try {
      const stored = sessionStorage.getItem(UNDO_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as { id: string; name: string; ts: number };
        // Only restore if within the last 24 hours — avoids stale state across days.
        if (Date.now() - parsed.ts < 24 * 60 * 60 * 1000) {
          return { id: parsed.id, name: parsed.name };
        }
      }
    } catch {}
    return null;
  });

  // Wrapper keeps sessionStorage in sync with React state.
  const setLastActedProfile = useCallback((val: { id: string; name: string } | null) => {
    setLastActedProfileRaw(val);
    try {
      if (val) {
        sessionStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify({ ...val, ts: Date.now() }));
      } else {
        sessionStorage.removeItem(UNDO_STORAGE_KEY);
      }
    } catch {}
  }, []);

  const [celebration, setCelebration] = useState<MatchCelebration | null>(null);
  // Ref mirror so the mutationFn closure can read the current value without stale capture.
  const lastActedRef = useRef<{ id: string; name: string } | null>(null);
  useEffect(() => { lastActedRef.current = lastActedProfile; }, [lastActedProfile]);

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
      const capturedFirstName = currentProfile.firstName;
      const capturedPhoto = photoData?.photos?.[0];
      try {
        const res = await apiRequest("POST", "/api/interactions", {
          toUserId: currentProfile.userId,
          type,
        });
        return { ...(await res.json()), profileId: currentProfile.userId, interactionType: type, capturedFirstName, capturedPhoto };
      } catch (err: any) {
        console.error("INTERACTION_ERROR", type, err?.message || err);
        toast({
          title: type === "open" ? t("couldnt_send_like") : t("couldnt_close_action"),
          description: err?.message || t("something_went_wrong"),
          variant: "destructive",
        });
        return { skipped: true };
      }
    },
    onSuccess: (data) => {
      if (data?.skipped) return;

      // ── Permanent cache surgery (ROOT FIX for liked-user reappearing) ────────
      // shownIds hides the card locally but is component state — it resets to an
      // empty Set on every unmount (navigate away → navigate back).  Without this,
      // the stale /api/discover cache (staleTime:Infinity) still holds the liked/
      // passed profile, so on re-mount the merge effect puts it back into
      // accumulatedProfiles and it reappears at the top of the feed.
      //
      // Fix: surgically remove the interacted profile from BOTH the TanStack Query
      // cache AND the local accumulatedProfiles array.  The cache write is O(n)
      // but n ≤ 60 (MAX_POOL_SIZE) and runs once per swipe — negligible cost.
      if (data?.profileId) {
        queryClient.setQueryData<Profile[]>(["/api/discover"], (old) =>
          old ? old.filter(p => p.userId !== (data as any).profileId) : old
        );
        setAccumulatedProfiles(prev => prev.filter(p => p.userId !== (data as any).profileId));
      }

      if (data?.matched) {
        setCelebration({ firstName: data.capturedFirstName ?? "", photo: data.capturedPhoto, matchId: data.matchId });
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      }

      if ((data as any).interactionType === "open")  setGuideOpenTriggered(true);
      if ((data as any).interactionType === "close") setGuideCloseTriggered(true);
    },
  });

  const undoPass = useMutation({
    mutationFn: async () => {
      // Race-condition guard: if the user taps undo immediately after acting,
      // the interaction DB write may not have landed yet. Retry up to 3 times
      // with 400 ms gaps when we know an action was just taken.
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await apiRequest("POST", "/api/discover/undo-pass", {});
        if (res.ok) return res.json() as Promise<{ restoredProfileId: string }>;
        const d = await res.json().catch(() => ({})) as any;
        const msg: string = d.message || "Failed to undo";
        if (msg.includes("No recent action") && lastActedRef.current && attempt < 3) {
          await new Promise<void>(r => setTimeout(r, 400));
          continue;
        }
        throw new Error(msg);
      }
      throw new Error("Failed to undo");
    },
    onSuccess: (data) => {
      const name = lastActedRef.current?.name ?? "them";
      setLastActedProfile(null);
      // Remove the restored profile from shownIds so it reappears immediately
      // in visibleProfiles without waiting for the refetch to settle.
      setShownIds(prev => { const s = new Set(prev); s.delete(data.restoredProfileId); return s; });
      queryClient.invalidateQueries({ queryKey: ["/api/discover"] });
      setGuideUndoTriggered(true);
      toast({ title: "↩ Undo", description: t("undo_pass_success").replace("{name}", name) });
    },
    onError: (err: any) => {
      const msg = err?.message || "";
      if (msg.includes("match") && msg.includes("cannot be undone")) {
        // Match can't be undone — keep lastActedProfile cleared since action stands
        setLastActedProfile(null);
        toast({ title: t("undo_match_conflict"), variant: "destructive" });
      } else if (msg.includes("Free daily undo already used")) {
        toast({ title: t("undo_daily_used"), variant: "destructive" });
      } else if (msg.includes("No undo credits")) {
        toast({ title: t("undo_pass_no_credits"), variant: "destructive" });
      } else if (msg.includes("No recent action") || msg.includes("No recent pass")) {
        setLastActedProfile(null);
        toast({ title: t("undo_pass_none"), variant: "destructive" });
      } else {
        toast({ title: msg || t("something_went_wrong"), variant: "destructive" });
      }
    },
  });

  const handleUndoPass = () => { undoPass.mutate(); };

  // Play the bubble-exit animation, then fire the interaction after it completes.
  // Mirrors the Intention Wheel's card-disperse timing (280 ms matches discoverCardExit).
  const triggerInteract = useCallback((type: "open" | "close") => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    // Set optimistic undo state immediately — before the 280 ms animation
    // and before the server round-trip — so the undo button is ready instantly.
    if (currentProfile) {
      setLastActedProfile({ id: currentProfile.userId, name: currentProfile.firstName });
    }
    setIsExiting(true);
    exitTimerRef.current = setTimeout(() => {
      setIsExiting(false);
      interact.mutate(type);
    }, 280);
  }, [interact.mutate, currentProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable callbacks — prevent SlideCards / PhotoBubbles from re-rendering
  // when parent mutation state changes but these handlers haven't changed.
  const handleOpen = useCallback(() => triggerInteract("open"), [triggerInteract]);

  const handleReply = useCallback((_promptText: string, _reply: string) => {
    toast({
      title: t("reply_noted"),
      description: t("reply_will_be_sent").replace("{name}", currentProfile?.firstName ?? ""),
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
            <p className="text-muted-foreground text-sm">{t("loading_slow_desc")}</p>
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
  const customGreenFlags: string[] = (displayProfile as any).customGreenFlags || [];
  const customSignals: string[] = (displayProfile as any).customSignals || [];
  const allGreenFlags = [...greenFlags, ...customGreenFlags];
  const allSignals = [...signals, ...customSignals];
  const pronouns: string | null = (displayProfile as any).pronouns || null;
  const dateOfBirth: string | null = (displayProfile as any).dateOfBirth || null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b px-5 py-3">
        <div className="max-w-md mx-auto flex items-center gap-2">
          <h1 className="font-serif text-lg font-bold truncate" data-testid="text-discover-sticky-name">
            {displayProfile.firstName}
          </h1>
          {displayProfile.photoVerified && (
            <BadgeCheck className="w-4 h-4 text-primary shrink-0" />
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
          style={{
            animation: isExiting
              ? "discoverCardExit 0.28s cubic-bezier(0.4, 0, 0.2, 1) both"
              : "discoverCardEnter 0.48s cubic-bezier(0.16, 1, 0.3, 1) both",
          }}
          data-testid="profile-container"
        >
            <PhotoBubbles
              photos={photos}
              name={displayProfile.firstName}
              onOpen={handleOpen}
              isDisabled={interact.isPending || isExiting}
              isPhotosLoading={isPhotosLoading}
            />
            <Card className="mt-2" style={{ boxShadow: "0 2px 20px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04)" }} data-testid="card-profile">
              <div className="px-6 pb-8 pt-6 space-y-8" data-testid="profile-about-section">

                {/* ── 1. Identity — first thing above the fold after the photo ── */}
                <div className="space-y-1.5" style={{ animation: "discoverNameEnter 0.45s 0.22s ease both" }}>
                  <div className="flex items-center gap-2">
                    <h2 className="font-serif text-4xl font-bold tracking-tight" data-testid="text-profile-name">
                      {displayProfile.firstName}
                    </h2>
                    {displayProfile.photoVerified && (
                      <BadgeCheck className="w-5 h-5 text-primary shrink-0" data-testid="icon-verified-badge" />
                    )}
                  </div>
                  <ProfileInfoRow
                    age={displayProfile.age}
                    location={displayProfile.location}
                    height={displayProfile.height}
                    dateOfBirth={dateOfBirth}
                    pronouns={pronouns}
                  />
                </div>

                {/* ── 2. Personality signals — quick scan before engagement ── */}
                {allSignals.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("personality")}</p>
                    <DragScrollRow>
                      {allSignals.map(signal => (
                        <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-signal-${signal}`}>
                          {translateSignal(signal, langCode)}
                        </Badge>
                      ))}
                    </DragScrollRow>
                  </div>
                )}

                {/* ── 3. Conversation starters ── */}
                {allStarters.length > 0 && (
                  <div className="space-y-3" data-testid="section-conversation-starters">
                    <div className="flex items-center gap-1.5">
                      <MessageCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("conversation_starters")}</p>
                    </div>
                    <SlideCards items={allStarters.map(s => translateStarterItem(s, langCode))} type="starter" onReply={handleReply} />
                  </div>
                )}

                {/* ── 4. Questions they'd love to know ── */}
                {viewerQuestions.length > 0 && (
                  <div className="space-y-3" data-testid="section-viewer-questions">
                    <div className="flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("they_love_to_know")}</p>
                    </div>
                    <SlideCards items={viewerQuestions.map(vq => vq.question)} type="starter" onReply={handleReply} />
                  </div>
                )}

                {/* ── 5. What to ask them ── */}
                {(questions.length > 0 || customQAsItems.length > 0) && (
                  <div className="space-y-3" data-testid="section-questions">
                    <div className="flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("ask_me")}</p>
                    </div>
                    <SlideCards items={[...questions.map(q => translateQuestion(q, langCode)), ...customQAsItems]} type="question" onReply={handleReply} />
                  </div>
                )}

                {/* ── 6. Intent ── */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("looking_for")}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-lg leading-none" aria-hidden="true">
                      {({"Committed Relationship": "💍", "Serious Dating": "❤️", "Open To Connection": "✨"} as Record<string,string>)[displayProfile.datingIntent ?? ""] ?? "💫"}
                    </span>
                    <p className="text-base font-semibold" data-testid="text-profile-intent">{translateIntent(displayProfile.datingIntent ?? "", t)}</p>
                  </div>
                </div>

                {/* ── 7. Green flags ── */}
                {allGreenFlags.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("green_flags_label")}</p>
                    <DragScrollRow>
                      {allGreenFlags.map(flag => (
                        <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-flag-${flag}`}>
                          {translateGreenFlag(flag, langCode)}
                        </Badge>
                      ))}
                    </DragScrollRow>
                  </div>
                )}

                {/* ── 8. Connection pace ── */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("pace_label")}</p>
                  <p className="text-base font-semibold" data-testid="text-profile-style">{translateStyle(displayProfile.connectionStyle ?? "", t)}</p>
                </div>
              </div>
            </Card>
        </div>
      </div>

      <button
        className="fixed bottom-20 end-4 z-40 w-12 h-12 rounded-full border border-muted-foreground/20 bg-background/90 backdrop-blur-sm flex items-center justify-center text-lg shadow-lg transition-all active:scale-90 hover:border-muted-foreground/40 hover:shadow-xl"
        onClick={() => triggerInteract("close")}
        disabled={interact.isPending || isExiting}
        data-testid="button-close"
      >
        <span role="img" aria-label={t("close_label")}>🌙</span>
      </button>

      <button
        className="fixed bottom-20 start-4 z-40 w-12 h-12 rounded-full border transition-all active:scale-90 hover:shadow-xl flex items-center justify-center text-lg shadow-lg backdrop-blur-sm disabled:opacity-40"
        style={lastActedProfile && !undoPass.isPending
          ? { borderColor: "hsl(var(--primary) / 0.5)", background: "hsl(var(--primary) / 0.08)" }
          : { borderColor: "hsl(var(--muted-foreground) / 0.2)", background: "hsl(var(--background) / 0.9)" }}
        onClick={handleUndoPass}
        disabled={undoPass.isPending || !lastActedProfile}
        title="Undo Last Action"
        data-testid="button-undo-pass"
      >
        <span role="img" aria-label={t("undo_label")}>↩️</span>
      </button>

      {celebration && (
        <MatchOverlay celebration={celebration} onClose={() => setCelebration(null)} />
      )}

      <LulouGuide
        guideKey={GUIDE_KEYS.WELCOME}
        userId={user?.id}
        icon="✨"
        title="Welcome to Lulou"
        body="Take your time. Great connections aren't rushed."
        delay={1200}
        autoDismissMs={5000}
      />
      {guideOpenTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.DISCOVER_OPEN}
          userId={user?.id}
          icon="❤️"
          title="Nice choice"
          body="Open means you're interested. If they open you too, you'll connect."
          delay={600}
        />
      )}
      {guideCloseTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.DISCOVER_CLOSE}
          userId={user?.id}
          icon="🌙"
          title="Changed your mind?"
          body="Undo Close can bring someone back."
          delay={600}
        />
      )}
      {guideUndoTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.DISCOVER_UNDO}
          userId={user?.id}
          title="Nothing is final."
          body="People can be rediscovered."
          delay={400}
        />
      )}
    </div>
  );
}
