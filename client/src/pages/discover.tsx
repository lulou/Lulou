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
import { MessageCircle, HelpCircle, Send, BadgeCheck, Loader2, ChevronDown } from "lucide-react";
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
const SlideCards = memo(function SlideCards({ items, type, onReply }: { items: string[]; type: "starter" | "question"; onReply: (text: string, reply: string) => Promise<void> }) {
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
  // Per-card reply state: keyed by card index so each prompt keeps its own text.
  // Reset to {} when the items list changes (i.e. a new profile is displayed).
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // When the items array changes identity the profile has advanced — clear all
  // per-card reply state and collapse any open reply box.
  useEffect(() => {
    setActiveIndex(null);
    setReplies({});
    setIsSending(false);
  }, [items]);

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
    // Toggle the card open/closed; do NOT clear reply text so each card
    // preserves what the user typed even after switching between cards.
    setActiveIndex(activeIndex === i ? null : i);
  };

  const handleSend = async (text: string) => {
    if (activeIndex === null || isSending) return;
    const replyText = (replies[activeIndex] ?? "").trim();
    if (!replyText) return;

    // Dismiss keyboard immediately — before the async round-trip.
    inputRef.current?.blur();

    setIsSending(true);
    try {
      await onReply(text, replyText);
      // Success: clear this card's reply and collapse the reply box.
      setReplies(prev => { const next = { ...prev }; delete next[activeIndex]; return next; });
      setActiveIndex(null);
    } catch {
      // Failure: leave reply text intact so the user can retry or edit.
    } finally {
      setIsSending(false);
    }
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
        <div className="flex gap-2 items-center px-1 pt-1">
          <Input
            ref={inputRef}
            value={activeIndex !== null ? (replies[activeIndex] ?? "") : ""}
            onChange={e => {
              if (activeIndex === null) return;
              setReplies(prev => ({ ...prev, [activeIndex]: e.target.value.slice(0, 200) }));
            }}
            placeholder={isStarter ? t("reply_to_this") : t("share_your_answer")}
            className="text-sm focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-primary"
            style={{ fontSize: 16 }}
            disabled={isSending}
            onKeyDown={e => {
              const replyText = activeIndex !== null ? (replies[activeIndex] ?? "").trim() : "";
              if (e.key === "Enter" && replyText && activeIndex !== null && !isSending) {
                handleSend(items[activeIndex]);
              }
            }}
            data-testid={`input-reply-${type}`}
          />
          <Button
            size="icon"
            disabled={isSending || !(activeIndex !== null && (replies[activeIndex] ?? "").trim())}
            onClick={() => activeIndex !== null && handleSend(items[activeIndex])}
            data-testid={`button-reply-send-${type}`}
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
});

// Max profiles to keep in the accumulated pool. Profiles already dismissed
// are pruned once the pool exceeds this threshold, bounding the useMemo filter cost.
const MAX_POOL_SIZE = 60;

// ── Photo grouping ───────────────────────────────────────────────────────────
// Divides all uploaded photos into balanced groups that are spread throughout
// the profile.  Each group becomes one swipeable gallery (hero or inline).
//
// Rules (n = total photos):
//   1 → [1]
//   2 → [1, 1]
//   3 → [2, 1]
//   4 → [2, 2]
//   5 → [3, 2]
//   6 → [3, 3]
//   7 → [3, 2, 2]
//   8 → [3, 3, 2]
//   9 → [3, 3, 3]
// Never place all photos into one gallery when there are 2 or more.
function computePhotoGroups(photos: string[]): string[][] {
  const n = photos.length;
  if (n === 0) return [[]];
  if (n === 1)  return [photos];
  if (n === 2)  return [photos.slice(0, 1), photos.slice(1)];
  if (n === 3)  return [photos.slice(0, 2), photos.slice(2)];
  if (n === 4)  return [photos.slice(0, 2), photos.slice(2)];
  if (n === 5)  return [photos.slice(0, 3), photos.slice(3)];
  if (n === 6)  return [photos.slice(0, 3), photos.slice(3)];
  if (n === 7)  return [photos.slice(0, 3), photos.slice(3, 5), photos.slice(5)];
  if (n === 8)  return [photos.slice(0, 3), photos.slice(3, 6), photos.slice(6)];
  if (n === 9)  return [photos.slice(0, 3), photos.slice(3, 6), photos.slice(6)];
  // 10+: lead group of 3, then groups of 3 (last may be 1–3)
  const groups: string[][] = [photos.slice(0, 3)];
  for (let i = 3; i < n; i += 3) groups.push(photos.slice(i, i + 3));
  return groups;
}


// ── Content-section weighting ────────────────────────────────────────────────
// Weights control how the interleave algorithm groups sections between photos.
// Large sections (score ≥ 3) each get their own photo slot whenever possible so
// starters / viewerQuestions / questions are never shown back-to-back.
const W_SMALL  = 1; // identity, signals, intent, pace
const W_MEDIUM = 2; // green flags
const W_LARGE  = 3; // conversation starters, they'd love to know, ask me

type ContentSection = { id: string; weight: number; node: JSX.Element };

/**
 * Distribute `sections` across `targetIndices` group slots using cumulative
 * weight.  Each section is pushed into the current slot; once the running
 * total exceeds (totalWeight / nSlots × slotNumber) we advance to the next
 * slot.  This ensures heavier sections naturally fill their own slot.
 */
function distributeToSlots(
  sections: ContentSection[],
  targetIndices: number[],
  groups: ContentSection[][],
): void {
  if (!sections.length || !targetIndices.length) return;
  const total      = sections.reduce((s, x) => s + x.weight, 0);
  const perSlot    = total / targetIndices.length;
  let slotPtr      = 0;
  let accum        = 0;
  sections.forEach((sec, i) => {
    groups[targetIndices[slotPtr]].push(sec);
    accum += sec.weight;
    if (
      i < sections.length - 1 &&
      accum >= perSlot * (slotPtr + 1) &&
      slotPtr < targetIndices.length - 1
    ) {
      slotPtr++;
    }
  });
}

/**
 * Divide `sections` into (nExtra + 1) content groups for interleaving with
 * extra uploaded photos.
 *
 * Rules:
 *  1. Large sections (starters / viewerQuestions / questions) each get their
 *     own group slot (positions 1…L), so a photo always separates them when
 *     there are enough photo slots.
 *  2. Non-large sections distribute across the remaining empty slots using
 *     cumulative weight.
 *  3. The FIRST slot (before photo 2) always gets some non-large content so
 *     the profile opens with identity details rather than a response wall.
 *  4. The LAST slot (after the final photo) is reserved for non-large content
 *     whenever possible — "final-photo rule".
 *  5. When there are more empty slots than non-large sections, content is
 *     concentrated at the first and last slots rather than scattered thinly
 *     across every gap, avoiding orphan single-line sections in the middle.
 */
function buildPhotoGroups(sections: ContentSection[], nExtra: number): ContentSection[][] {
  const nGroups = nExtra + 1;
  if (nGroups <= 1 || !sections.length) return [sections];

  const large    = sections.filter(s => s.weight >= W_LARGE);
  const nonLarge = sections.filter(s => s.weight <  W_LARGE);
  const groups: ContentSection[][] = Array.from({ length: nGroups }, () => []);

  if (!large.length) {
    // No large sections — spread evenly across all groups.
    distributeToSlots(nonLarge, Array.from({ length: nGroups }, (_, i) => i), groups);
    return groups;
  }

  // Assign large sections to groups 1 … nLargeSlots.
  // nGroups − 1 is the ceiling so the last group is always reserved for non-large.
  const nLargeSlots = Math.min(large.length, nGroups - 1);
  large.forEach((sec, i) => {
    const slot = Math.min(
      1 + Math.floor((i * nLargeSlots) / large.length),
      nLargeSlots,
    );
    groups[slot].push(sec);
  });

  // Collect group indices that are still empty — they receive non-large content.
  const emptyIdx = groups.map((g, i) => (g.length === 0 ? i : -1)).filter(i => i >= 0);

  if (nonLarge.length && emptyIdx.length) {
    // When spare slots outnumber non-large sections, concentrate content at
    // the head and tail of the empty-slot list rather than scattering it
    // one-per-slot through the middle.
    let usedIdx: number[];
    if (nonLarge.length < emptyIdx.length) {
      const firstN = Math.ceil(nonLarge.length / 2);
      const lastN  = Math.floor(nonLarge.length / 2);
      const head   = emptyIdx.slice(0, firstN);
      const tail   = lastN > 0 ? emptyIdx.slice(-lastN) : [];
      usedIdx = [...new Set([...head, ...tail])];
    } else {
      usedIdx = emptyIdx;
    }
    distributeToSlots(nonLarge, usedIdx, groups);
  }

  return groups;
}

// ── Collapsible diagnostics panel shown on the Discover error screen ──────────
// Only visible to developers / testers — shows raw auth + session state so that
// bfcache / session-race bugs can be diagnosed from a device screenshot.
function DiscoverDiagPanel({ rows }: { rows: [string, string | null | undefined][] }) {
  const [open, setOpen] = useState(false);
  const hasData = rows.some(([, v]) => v != null && v !== "");
  if (!hasData) return null;
  return (
    <div className="mt-2 text-left">
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors mx-auto"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
        Debug info
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border/40 bg-muted/30 p-3 text-left overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <tbody>
              {rows.map(([label, value]) =>
                value != null && value !== "" ? (
                  <tr key={label} className="align-top">
                    <td className="pr-3 py-0.5 text-muted-foreground whitespace-nowrap font-medium">{label}</td>
                    <td className="py-0.5 font-mono break-all text-foreground/80">{value}</td>
                  </tr>
                ) : null
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

  // Full profile snapshot for undo — stored in a ref (not state) so it never
  // triggers extra re-renders and is always available synchronously.
  const undoProfileRef = useRef<Profile | null>(null);

  // Track how long the loading skeleton has been visible so we can show a
  // "still loading" fallback after 8 seconds instead of a blank skeleton forever.
  const [loadingTooLong, setLoadingTooLong] = useState(false);
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: profilesData, isLoading, isFetching, isError: isDiscoverError, error: discoverError, refetch } = useQuery<Profile[]>({
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

      // Re-inject the snapshotted profile to the FRONT of the pool immediately,
      // without waiting for the server refetch to resolve.  This guarantees the
      // restored profile becomes visibleProfiles[0] on the next render.
      const restoredProfile = undoProfileRef.current;
      if (restoredProfile) {
        setAccumulatedProfiles(prev => {
          if (prev.some(p => p.userId === restoredProfile.userId)) return prev;
          return [restoredProfile, ...prev];
        });
        queryClient.setQueryData<Profile[]>(["/api/discover"], (old) => {
          if (!old) return [restoredProfile];
          if (old.some(p => p.userId === restoredProfile.userId)) return old;
          return [restoredProfile, ...old];
        });
        undoProfileRef.current = null;
      }

      setLastActedProfile(null);
      // Remove from shownIds so the re-injected profile is visible immediately.
      setShownIds(prev => { const s = new Set(prev); s.delete(data.restoredProfileId); return s; });
      // Background refetch to re-sync server state (doesn't disturb the feed).
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
        // Short auto-dismiss — avoids a full-width red bar lingering at top-0 on iPhone.
        toast({ title: t("undo_daily_used"), variant: "destructive", duration: 3500 });
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
      undoProfileRef.current = currentProfile; // full snapshot for front-of-pool injection
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

  // Sending a reply to a prompt counts as opening the profile.
  // Returns a Promise so SlideCards can:
  //   • disable Send and show a spinner while in-flight
  //   • clear the reply text and advance only on success
  //   • keep the reply text intact and re-enable Send on failure
  const handleReply = useCallback(async (_promptText: string, _reply: string): Promise<void> => {
    if (!currentProfile) throw new Error("no_profile");

    const capturedId       = currentProfile.userId;
    const capturedName     = currentProfile.firstName;
    const capturedPhoto    = photoData?.photos?.[0];

    // Snapshot full profile for undo before we hide it.
    undoProfileRef.current = currentProfile;

    // Optimistically hide the profile; rolled back below on failure.
    setShownIds(prev => { const s = new Set(prev); s.add(capturedId); return s; });

    try {
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId: capturedId,
        type: "open",
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as any;
        throw new Error(errBody?.message || `HTTP_${res.status}`);
      }

      const data = await res.json() as any;

      // Permanently remove from cache — same surgery as interact.onSuccess.
      queryClient.setQueryData<Profile[]>(["/api/discover"], old =>
        old ? old.filter(p => p.userId !== capturedId) : old
      );
      setAccumulatedProfiles(prev => prev.filter(p => p.userId !== capturedId));
      setLastActedProfile({ id: capturedId, name: capturedName });

      if (data?.matched) {
        setCelebration({
          firstName: data.capturedFirstName ?? capturedName,
          photo: capturedPhoto,
          matchId: data.matchId,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      }
      setGuideOpenTriggered(true);

      // Trigger exit animation (same timing as triggerInteract).
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      setIsExiting(true);
      exitTimerRef.current = setTimeout(() => setIsExiting(false), 280);

    } catch (err: any) {
      // Roll back the optimistic hide so the profile reappears.
      setShownIds(prev => { const s = new Set(prev); s.delete(capturedId); return s; });
      toast({
        title: t("couldnt_send_like"),
        description: err?.message || t("something_went_wrong"),
        variant: "destructive",
      });
      throw err; // re-throw so SlideCards keeps the reply text
    }
  }, [
    currentProfile,
    photoData,
    queryClient,
    setAccumulatedProfiles,
    setLastActedProfile,
    setCelebration,
    setGuideOpenTriggered,
    setShownIds,
    setIsExiting,
    exitTimerRef,
    toast,
    t,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Collect diagnostics at render time (all reads are synchronous / cheap).
    const _diagRaw = (() => { try { return sessionStorage.getItem("lulou_diag_discover_error"); } catch { return null; } })();
    const _diagFetch = _diagRaw ? (() => { try { return JSON.parse(_diagRaw); } catch { return null; } })() : null;
    const _lastAuthEvent = (() => { try { return localStorage.getItem("lulou_diag_last_auth_event"); } catch { return null; } })();
    const _storedSidRaw = (() => { try { return localStorage.getItem("lulou_session_id"); } catch { return null; } })();
    const _storedSidPrefix = _storedSidRaw ? _storedSidRaw.slice(0, 8) + "…" : "(none)";
    const _verifyResult = (() => { try { return localStorage.getItem("lulou_diag_verify_result"); } catch { return null; } })();
    const _bootstrapStatus = (() => { try { return localStorage.getItem("lulou_diag_bootstrap_status"); } catch { return null; } })();
    const _commitHash = (() => { try { return typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "(unknown)"; } catch { return "(unknown)"; } })();
    const _errorMsg = discoverError instanceof Error ? discoverError.message : String(discoverError ?? "");

    const diagRows: [string, string | null | undefined][] = [
      ["Commit", _commitHash],
      ["Last auth event", _lastAuthEvent],
      ["Stored session prefix", _storedSidPrefix],
      ["Session verify", _verifyResult],
      ["Bootstrap status", _bootstrapStatus],
      ["Query error", _errorMsg || null],
      ...((_diagFetch ? [
        ["Fetch HTTP status", String(_diagFetch.httpStatus ?? "?")],
        ["Server message", _diagFetch.serverMessage],
        ["Server reason", _diagFetch.serverReason],
        ["Sent session prefix", _diagFetch.sentSessionIdPrefix],
        ["Current session prefix (post)", _diagFetch.currentSessionIdPrefix],
        ["Was stale request", _diagFetch.isStaleRequest != null ? String(_diagFetch.isStaleRequest) : null],
        ["Fetch URL", _diagFetch.url],
        ["Diag timestamp", _diagFetch.ts ? new Date(_diagFetch.ts).toISOString() : null],
      ] : []) as [string, string | null][]),
    ];

    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm w-full">
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
          {/* ── Collapsible diagnostics panel ── */}
          <DiscoverDiagPanel rows={diagRows} />
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

  // ── Interleaved photo distribution ───────────────────────────────────────
  // Build an ordered array of only-populated content sections so the
  // distribution algorithm always works on real content, not placeholders.
  const contentSections: ContentSection[] = [
    // 1. Identity — always present
    {
      id: "identity",
      weight: W_SMALL,
      node: (
        <div key="identity" className="space-y-1.5" style={{ animation: "discoverNameEnter 0.45s 0.22s ease both" }}>
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
      ),
    },
    // 2. Personality signals
    ...(allSignals.length > 0 ? [{
      id: "signals",
      weight: W_SMALL,
      node: (
        <div key="signals" className="space-y-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("personality")}</p>
          <DragScrollRow>
            {allSignals.map(signal => (
              <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-signal-${signal}`}>
                {translateSignal(signal, langCode)}
              </Badge>
            ))}
          </DragScrollRow>
        </div>
      ),
    }] : []),
    // 3. Conversation starters
    ...(allStarters.length > 0 ? [{
      id: "starters",
      weight: W_LARGE,
      node: (
        <div key="starters" className="space-y-3" data-testid="section-conversation-starters">
          <div className="flex items-center gap-1.5">
            <MessageCircle className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("conversation_starters")}</p>
          </div>
          <SlideCards items={allStarters.map(s => translateStarterItem(s, langCode))} type="starter" onReply={handleReply} />
        </div>
      ),
    }] : []),
    // 4. They'd love to know
    ...(viewerQuestions.length > 0 ? [{
      id: "viewerQuestions",
      weight: W_LARGE,
      node: (
        <div key="viewerQuestions" className="space-y-3" data-testid="section-viewer-questions">
          <div className="flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("they_love_to_know")}</p>
          </div>
          <SlideCards items={viewerQuestions.map(vq => vq.question)} type="starter" onReply={handleReply} />
        </div>
      ),
    }] : []),
    // 5. Ask me
    ...((questions.length > 0 || customQAsItems.length > 0) ? [{
      id: "questions",
      weight: W_LARGE,
      node: (
        <div key="questions" className="space-y-3" data-testid="section-questions">
          <div className="flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-primary" />
            <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("ask_me")}</p>
          </div>
          <SlideCards items={[...questions.map(q => translateQuestion(q, langCode)), ...customQAsItems]} type="question" onReply={handleReply} />
        </div>
      ),
    }] : []),
    // 6. Intent — always present
    {
      id: "intent",
      weight: W_SMALL,
      node: (
        <div key="intent" className="space-y-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("looking_for")}</p>
          <div className="flex items-center gap-2">
            <span className="text-lg leading-none" aria-hidden="true">
              {({"Committed Relationship": "💍", "Serious Dating": "❤️", "Open To Connection": "✨"} as Record<string,string>)[displayProfile.datingIntent ?? ""] ?? "💫"}
            </span>
            <p className="text-base font-semibold" data-testid="text-profile-intent">{translateIntent(displayProfile.datingIntent ?? "", t)}</p>
          </div>
        </div>
      ),
    },
    // 7. Green flags
    ...(allGreenFlags.length > 0 ? [{
      id: "greenFlags",
      weight: W_MEDIUM,
      node: (
        <div key="greenFlags" className="space-y-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("green_flags_label")}</p>
          <DragScrollRow>
            {allGreenFlags.map(flag => (
              <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-flag-${flag}`}>
                {translateGreenFlag(flag, langCode)}
              </Badge>
            ))}
          </DragScrollRow>
        </div>
      ),
    }] : []),
    // 8. Connection pace — always present
    {
      id: "pace",
      weight: W_SMALL,
      node: (
        <div key="pace" className="space-y-2">
          <p className="text-xs font-semibold tracking-widest uppercase text-primary">{t("pace_label")}</p>
          <p className="text-base font-semibold" data-testid="text-profile-style">{translateStyle(displayProfile.connectionStyle ?? "", t)}</p>
        </div>
      ),
    },
  ];

  // Split all photos into balanced groups (e.g. 6 photos → [[p1,p2,p3],[p4,p5,p6]]).
  // Group 0 goes to the hero viewer; groups 1+ become inline swipeable galleries.
  const photoGroups   = computePhotoGroups(photos);
  const heroPhotos    = photoGroups[0] ?? [];
  const inlineGroups  = photoGroups.slice(1);
  const nInlineGroups = inlineGroups.length;

  // Divide written sections into (nInlineGroups + 1) balanced content groups.
  // Large sections (starters / viewerQuestions / questions) each get their own
  // group so they are always separated by a photo gallery.
  const groups = buildPhotoGroups(contentSections, nInlineGroups);

  // Interleave: contentGroup[0] → gallery → contentGroup[1] → gallery → …
  const renderItems: JSX.Element[] = [];
  groups.forEach((group, gIdx) => {
    group.forEach(sec => renderItems.push(sec.node));
    if (gIdx < nInlineGroups) {
      renderItems.push(
        <ProfilePhotoViewer
          key={`inline-gallery-${gIdx}`}
          photos={inlineGroups[gIdx]}
        />,
      );
    }
  });

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
              photos={heroPhotos}
              name={displayProfile.firstName}
              onOpen={handleOpen}
              isDisabled={interact.isPending || isExiting}
              isPhotosLoading={isPhotosLoading}
            />
            <Card className="mt-2" style={{ boxShadow: "0 2px 20px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04)" }} data-testid="card-profile">
              <div className="px-6 pb-8 pt-6 space-y-8" data-testid="profile-about-section">
                {renderItems}
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
