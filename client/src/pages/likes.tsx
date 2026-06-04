import { useState, useEffect, useRef, useCallback } from "react";
import { useLanguageContext } from "@/contexts/language-context";
import { usePerfTrace, useRenderCount, isMobile, scheduleIdle } from "@/lib/perf";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, batchPrefetchPhotos } from "@/lib/queryClient";
import { useTabActive } from "@/hooks/use-tab-active";
import {
  Heart, X, Eye, MapPin, Lock, Sparkles, ChevronRight,
  ChevronLeft, Ruler,
} from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { PhotoCarousel } from "@/components/photo-carousel";
import { ElevateModal } from "@/components/elevate-modal";
import { ElevateStatusCard } from "@/components/elevate-status-card";
import { decodedPhotos, EMPTY_PHOTOS } from "@/lib/image-utils";
import type { Profile, Interaction } from "@shared/schema";

type IncomingOpen = Interaction & { profile: Profile };
type MatchCelebration = { firstName: string; photo?: string };
type ElevateStatus = { type: string | null; expiresAt: string | null; active: boolean };

// ─── Match Overlay ─────────────────────────────────────────────────────────────

// Premium taglines — one is chosen at component mount, never changes mid-display.
const MATCH_TAGLINES_LIKES = [
  "Two people. One spark.",
  "Something rare just happened.",
  "A new connection arrived.",
  "Mutual interest. Worth exploring.",
  "The feeling is mutual.",
  "This one feels different.",
  "A genuine connection started here.",
  "Someone felt the same.",
];

// Inject matchFloat keyframe once at module load so it is always defined before
// any MatchOverlay renders. This avoids the Safari/WebKit crash where an inline
// animation style references a keyframe that hasn't been parsed yet.
if (typeof document !== "undefined") {
  const _kfId = "lulou-match-float-style";
  if (!document.getElementById(_kfId)) {
    const _s = document.createElement("style");
    _s.id = _kfId;
    _s.textContent = `@keyframes matchFloat {
      0%, 100% { transform: translateY(0) scale(1);    opacity: 0.35; }
      50%       { transform: translateY(-28px) scale(1.45); opacity: 0.65; }
    }`;
    document.head.appendChild(_s);
  }
}

// Stable particle positions — generated once at module load, never mid-render.
const MATCH_OVERLAY_PARTICLES = Array.from({ length: 20 }, (_, i) => ({
  id: i,
  w: 4 + (i * 7) % 8,
  h: 4 + (i * 11) % 8,
  left: (i * 17) % 100,
  top: (i * 13) % 100,
  dur: 3 + (i * 0.4) % 4,
  delay: (i * 0.28) % 2,
}));

function MatchOverlay({ celebration, onClose }: { celebration: MatchCelebration; onClose: () => void }) {
  const { t } = useLanguageContext();
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");
  const tagline = useRef(MATCH_TAGLINES_LIKES[Math.floor(Math.random() * MATCH_TAGLINES_LIKES.length)]).current;

  useEffect(() => {
    const timerId = setTimeout(() => setPhase("visible"), 50);
    return () => clearTimeout(timerId);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("exit");
    setTimeout(onClose, 500);
  }, [onClose]);

  useEffect(() => {
    const timerId = setTimeout(handleClose, 4500);
    return () => clearTimeout(timerId);
  }, [handleClose]);

  const isVisible = phase === "visible";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center cursor-pointer"
      onClick={handleClose}
      data-testid="overlay-match-celebration"
      style={{
        background: "radial-gradient(ellipse at center, hsl(350 48% 46% / 0.96), hsl(350 55% 28% / 0.99))",
        opacity: phase === "exit" ? 0 : 1,
        transition: "opacity 500ms ease",
      }}
    >
      {/* Ambient floating particles — positions stable, never regenerated */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {MATCH_OVERLAY_PARTICLES.map(p => (
          <div
            key={p.id}
            className="absolute rounded-full"
            style={{
              width: p.w,
              height: p.h,
              left: `${p.left}%`,
              top: `${p.top}%`,
              background: "hsl(350 60% 88% / 0.38)",
              animation: `matchFloat ${p.dur}s ${p.delay}s ease-in-out infinite`,
            }}
          />
        ))}
      </div>

      <div
        className="flex flex-col items-center gap-5 px-8"
        style={{
          transform: isVisible ? "scale(1) translateY(0)" : "scale(0.62) translateY(28px)",
          opacity: isVisible ? 1 : 0,
          transition: "transform 700ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 500ms ease",
        }}
      >
        <LulouFlowerIcon className="w-12 h-12 text-white/75" />

        {/* Avatar with heart badge */}
        <div className="relative">
          <Avatar
            className="w-28 h-28"
            style={{
              boxShadow: "0 0 0 3px rgba(255,255,255,0.22), 0 0 0 7px rgba(255,255,255,0.08), 0 14px 44px rgba(0,0,0,0.40)",
              transform: isVisible ? "scale(1)" : "scale(0)",
              transition: "transform 620ms cubic-bezier(0.34, 1.56, 0.64, 1) 180ms",
            }}
          >
            <AvatarImage src={celebration.photo} alt={celebration.firstName} />
            <AvatarFallback className="bg-white/20 text-white text-3xl font-semibold">
              {celebration.firstName?.[0] ?? "♡"}
            </AvatarFallback>
          </Avatar>
          <div
            className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-white/18 backdrop-blur-sm flex items-center justify-center"
            style={{
              background: "rgba(255,255,255,0.18)",
              transform: isVisible ? "scale(1)" : "scale(0)",
              transition: "transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1) 480ms",
            }}
          >
            <Heart className="w-5 h-5 text-white fill-white" />
          </div>
        </div>

        {/* Name */}
        <h1
          className="font-serif text-center"
          style={{
            fontSize: "clamp(28px, 8vw, 38px)",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "rgba(255,245,248,0.97)",
            textShadow: "0 2px 20px rgba(0,0,0,0.25)",
            transform: isVisible ? "translateY(0)" : "translateY(18px)",
            opacity: isVisible ? 1 : 0,
            transition: "transform 580ms ease 280ms, opacity 480ms ease 280ms",
          }}
          data-testid="text-blooming-amazing"
        >
          {celebration.firstName}
        </h1>

        {/* Premium tagline */}
        <p
          style={{
            fontSize: 15,
            fontStyle: "italic",
            color: "rgba(255,220,230,0.80)",
            textAlign: "center",
            lineHeight: 1.45,
            transform: isVisible ? "translateY(0)" : "translateY(14px)",
            opacity: isVisible ? 1 : 0,
            transition: "transform 580ms ease 460ms, opacity 480ms ease 460ms",
          }}
          data-testid="text-match-made"
        >
          {tagline}
        </p>

        {/* Rose divider */}
        <div style={{
          width: 40, height: 1,
          background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.50), transparent)",
          opacity: isVisible ? 1 : 0,
          transition: "opacity 500ms ease 600ms",
        }} />

        <p
          className="text-sm"
          style={{
            color: "rgba(255,210,220,0.62)",
            opacity: isVisible ? 1 : 0,
            transition: "opacity 500ms ease 700ms",
          }}
        >
          {t("tap_to_continue")}
        </p>
      </div>

    </div>
  );
}

// ─── Full-Screen Profile Modal ─────────────────────────────────────────────────

function ProfileModal({
  open,
  onClose,
  onMatch,
  onConnectionFull,
}: {
  open: IncomingOpen;
  onClose: () => void;
  onMatch: (c: MatchCelebration) => void;
  onConnectionFull: () => void;
}) {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [photoIndex, setPhotoIndex] = useState(0);
  const [visible, setVisible] = useState(false);

  // Slide in from bottom on mount
  useEffect(() => {
    const rafId = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(rafId);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  // Prevent background scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const profile = open.profile;

  // Fetch photos lazily — shares the same TanStack Query cache key as LikeCard,
  // so if the card already fetched them the modal gets the result instantly.
  const { data: photosData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const photos = photosData?.photos ?? EMPTY_PHOTOS;

  const signals = profile.signals ?? [];
  const greenFlags = profile.greenFlags ?? [];
  const conversationStarters = profile.conversationStarters ?? [];
  const questions = profile.questions ?? [];

  const respond = useMutation({
    mutationFn: async (type: "open" | "close") => {
      try {
        const res = await apiRequest("POST", "/api/interactions", { toUserId: open.fromUserId, type });
        return res.json();
      } catch (err: any) {
        toast({
          title: type === "open" ? "Couldn't send like" : "Couldn't close",
          description: err?.message || "Something went wrong. Try again.",
          variant: "destructive",
        });
        return { skipped: true };
      }
    },
    onSuccess: (data: any) => {
      if (data?.skipped) return;
      queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      handleClose();
      if (data.matched) {
        onMatch({ firstName: profile.firstName, photo: photos[0] });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: "Passed", description: `You passed on ${profile.firstName}.` });
      }
    },
  });

  return (
    <div
      className="fixed inset-0 z-50"
      data-testid={`modal-profile-${open.fromUserId}`}
      style={{
        background: "hsl(var(--background))",
        transform: visible ? "translateY(0)" : "translateY(100%)",
        transition: "transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {/* ── Photo Carousel — PhotoCarousel handles swipe/drag, overlays as children */}
      <PhotoCarousel
        photos={photos}
        currentIndex={photoIndex}
        onIndexChange={setPhotoIndex}
        showArrows={false}
        showDots={false}
        style={{ height: "60vh", minHeight: 300, maxHeight: 520 }}
      >
        {/* Empty state (no photos) */}
        {photos.length === 0 && (
          <div
            className="absolute inset-0 flex items-center justify-center z-10"
            style={{ background: "linear-gradient(135deg, hsl(350 45% 92%), hsl(350 45% 82%))" }}
          >
            <span className="font-serif text-9xl font-bold" style={{ color: "hsl(350 45% 52%)" }}>
              {profile.firstName?.[0]}
            </span>
          </div>
        )}

        {/* Bottom gradient */}
        <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/80 via-black/25 to-transparent pointer-events-none z-10" />

        {/* Close / back button */}
        <button
          className="absolute top-4 left-4 z-20 w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-all"
          style={{ background: "hsl(0 0% 0% / 0.4)", backdropFilter: "blur(8px)" }}
          onClick={handleClose}
          data-testid="button-close-profile-modal"
          aria-label="Close profile"
        >
          <ChevronLeft className="w-5 h-5 text-white" />
        </button>

        {/* Photo count badge */}
        {photos.length > 1 && (
          <div
            className="absolute top-4 right-4 z-20 px-2.5 py-1 rounded-full text-white text-xs font-medium"
            style={{ background: "hsl(0 0% 0% / 0.4)", backdropFilter: "blur(8px)" }}
          >
            {photoIndex + 1} / {photos.length}
          </div>
        )}

        {/* Prev arrow */}
        {photos.length > 1 && photoIndex > 0 && (
          <button
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
            style={{ background: "hsl(0 0% 0% / 0.35)", backdropFilter: "blur(6px)" }}
            onClick={() => setPhotoIndex(i => Math.max(0, i - 1))}
            data-testid="button-modal-prev-photo"
            aria-label="Previous photo"
          >
            <ChevronLeft className="w-4 h-4 text-white" />
          </button>
        )}

        {/* Next arrow */}
        {photos.length > 1 && photoIndex < photos.length - 1 && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
            style={{ background: "hsl(0 0% 0% / 0.35)", backdropFilter: "blur(6px)" }}
            onClick={() => setPhotoIndex(i => Math.min(photos.length - 1, i + 1))}
            data-testid="button-modal-next-photo"
            aria-label="Next photo"
          >
            <ChevronRight className="w-4 h-4 text-white" />
          </button>
        )}

        {/* Dot indicators */}
        {photos.length > 1 && (
          <div className="absolute bottom-[5.5rem] inset-x-0 flex justify-center gap-1.5 z-20 pointer-events-none">
            {photos.map((_, i) => (
              <div
                key={i}
                style={{
                  width: i === photoIndex ? 20 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: i === photoIndex ? "white" : "rgba(255,255,255,0.45)",
                  transition: "width 0.25s ease, background 0.25s ease",
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        )}

        {/* Name / age / location overlay */}
        <div className="absolute bottom-4 left-5 right-5 z-20">
          <div className="flex items-end justify-between gap-2">
            <div>
              <h2
                className="text-white font-serif text-3xl font-bold leading-tight drop-shadow-xl"
                data-testid="text-modal-name"
              >
                {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
              </h2>
              {profile.location && (
                <div className="flex items-center gap-1 mt-1">
                  <MapPin className="w-3.5 h-3.5 text-white/70" />
                  <span className="text-white/80 text-sm">{profile.location}</span>
                </div>
              )}
            </div>
            {profile.photoVerified && (
              <Badge
                variant="secondary"
                className="text-xs px-2 py-0.5 bg-white/20 text-white border-white/30 backdrop-blur-sm shrink-0"
              >
                Verified
              </Badge>
            )}
          </div>
        </div>
      </PhotoCarousel>

      {/* ── Profile Content ──────────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-36 space-y-6 max-w-lg mx-auto">

        {/* Intent + height row */}
        <div className="flex flex-wrap items-center gap-3">
          {profile.datingIntent && (
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium"
              style={{ background: "hsl(350 45% 52% / 0.1)", color: "hsl(350 45% 42%)" }}
            >
              <Heart className="w-3.5 h-3.5" />
              {profile.datingIntent}
            </div>
          )}
          {profile.height && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Ruler className="w-3.5 h-3.5" />
              {profile.height}
            </div>
          )}
        </div>

        {/* Signals / Interests */}
        {signals.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("section_interests")}</p>
            <div className="flex flex-wrap gap-2">
              {signals.map((s: string) => (
                <Badge key={s} variant="outline" className="text-sm px-3 py-1 rounded-full">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Connection style */}
        {profile.connectionStyle && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("section_connection_style")}</p>
            <p className="text-sm leading-relaxed">{profile.connectionStyle}</p>
          </div>
        )}

        {/* Green flags */}
        {greenFlags.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Green Flags</p>
            <div className="flex flex-wrap gap-2">
              {greenFlags.map((g: string) => (
                <Badge key={g} variant="secondary" className="text-sm px-3 py-1 rounded-full">
                  {g}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Conversation starters */}
        {conversationStarters.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Conversation Starters</p>
            <div className="space-y-2">
              {conversationStarters.map((s: string, i: number) => (
                <div
                  key={i}
                  className="text-sm leading-relaxed rounded-xl px-4 py-3"
                  style={{ background: "hsl(var(--muted) / 0.5)" }}
                >
                  {s}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Profile questions */}
        {questions.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("section_about_me")}</p>
            <div className="space-y-2">
              {questions.map((q: string, i: number) => (
                <div
                  key={i}
                  className="text-sm leading-relaxed rounded-xl px-4 py-3"
                  style={{ background: "hsl(var(--muted) / 0.5)" }}
                >
                  {q}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Sticky Action Bar ────────────────────────────────────────────────── */}
      <div
        className="fixed bottom-0 inset-x-0 z-10 px-5 py-4 border-t"
        style={{ background: "hsl(var(--background))" }}
      >
        <div className="flex gap-3 max-w-lg mx-auto">
          <Button
            variant="outline"
            className="flex-1 gap-2 h-12 text-sm font-medium"
            onClick={() => respond.mutate("close")}
            disabled={respond.isPending}
            data-testid={`button-modal-pass-${open.fromUserId}`}
          >
            <X className="w-4 h-4" />
            {t("btn_pass")}
          </Button>
          <Button
            className="flex-1 gap-2 h-12 text-sm font-medium"
            onClick={() => respond.mutate("open")}
            disabled={respond.isPending}
            data-testid={`button-modal-like-back-${open.fromUserId}`}
          >
            <Heart className="w-4 h-4" />
            {t("btn_like_back")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Like Card ─────────────────────────────────────────────────────────────────

function LikeCard({
  open,
  onMatch,
  onConnectionFull,
  onOpenProfile,
}: {
  open: IncomingOpen;
  onMatch: (c: MatchCelebration) => void;
  onConnectionFull: () => void;
  onOpenProfile: () => void;
}) {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Lazy-load photos — same pattern as Discovery. Photos are stripped from the
  // /api/who-liked-you batch response so that 50 profiles don't carry 7.5 MB of
  // image data in a single call. Each card fetches its own photo independently.
  const { data: photosData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", open.profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const photo    = photosData?.photos?.[0];
  const photoCount = photosData?.photos?.length ?? 0;

  const respond = useMutation({
    mutationFn: async (type: "open" | "close") => {
      try {
        const res = await apiRequest("POST", "/api/interactions", { toUserId: open.fromUserId, type });
        return res.json();
      } catch (err: any) {
        toast({
          title: type === "open" ? "Couldn't send like" : "Couldn't close",
          description: err?.message || "Something went wrong. Try again.",
          variant: "destructive",
        });
        return { skipped: true };
      }
    },
    onSuccess: (data: any) => {
      if (data?.skipped) return;
      queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      if (data.matched) {
        onMatch({ firstName: open.profile.firstName, photo });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: "Passed", description: `You passed on ${open.profile.firstName}.` });
      }
    },
  });

  return (
    <Card
      className="overflow-hidden shadow-sm cursor-pointer active:scale-[0.99] transition-transform"
      data-testid={`card-liked-${open.fromUserId}`}
      onClick={onOpenProfile}
    >
      {/* Photo header with gradient overlay */}
      <div className="relative h-52 bg-primary/8">
        {photo ? (
          <img
            src={photo}
            alt={open.profile.firstName}
            className="w-full h-full object-cover"
            decoding="async"
            style={{
              opacity: decodedPhotos.has(photo) ? 1 : 0,
              transition: "opacity 80ms ease",
            }}
            onLoad={e => {
              decodedPhotos.add(photo);
              (e.currentTarget as HTMLImageElement).style.opacity = "1";
            }}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, hsl(350 45% 92%), hsl(350 45% 82%))" }}
          >
            <span className="font-serif text-7xl font-bold" style={{ color: "hsl(350 45% 52%)" }}>
              {open.profile.firstName?.[0]}
            </span>
          </div>
        )}
        {/* Bottom gradient for text legibility */}
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />
        {/* Photo count hint */}
        {photoCount > 1 && (
          <div
            className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
          >
            {photoCount} photos
          </div>
        )}
        {/* Name + age overlay */}
        <div className="absolute bottom-3 left-4 right-4">
          <div className="flex items-end justify-between gap-2">
            <div>
              <h3
                className="text-white font-serif text-2xl font-bold leading-tight drop-shadow-lg"
                data-testid={`text-liked-name-${open.fromUserId}`}
              >
                {open.profile.firstName}{open.profile.age ? `, ${open.profile.age}` : ""}
              </h3>
              {open.profile.location && (
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3 text-white/70" />
                  <span className="text-white/70 text-xs">{open.profile.location}</span>
                </div>
              )}
            </div>
            {open.profile.photoVerified && (
              <Badge
                variant="secondary"
                className="text-[10px] px-2 py-0.5 bg-white/20 text-white border-white/30 backdrop-blur-sm flex-shrink-0"
              >
                Verified
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Details + actions */}
      <div className="p-4 space-y-4">
        {/* Tags row */}
        {(open.profile.signals?.length > 0 || open.profile.datingIntent) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {open.profile.signals?.slice(0, 3).map((signal: string) => (
              <Badge key={signal} variant="outline" className="text-xs px-2.5 py-0.5 rounded-full">
                {signal}
              </Badge>
            ))}
            {open.profile.datingIntent && (
              <Badge variant="secondary" className="text-xs px-2.5 py-0.5 rounded-full">
                {open.profile.datingIntent}
              </Badge>
            )}
          </div>
        )}

        {/* View full profile hint */}
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Eye className="w-3 h-3" />
          Tap to view full profile
        </p>

        {/* Action buttons — stop propagation so they don't open the modal */}
        <div className="flex gap-3" onClick={e => e.stopPropagation()}>
          <Button
            variant="outline"
            className="flex-1 gap-2 h-11 text-sm font-medium"
            onClick={() => respond.mutate("close")}
            disabled={respond.isPending}
            data-testid={`button-pass-${open.fromUserId}`}
          >
            <X className="w-4 h-4" />
            {t("btn_pass")}
          </Button>
          <Button
            className="flex-1 gap-2 h-11 text-sm font-medium"
            onClick={() => respond.mutate("open")}
            disabled={respond.isPending}
            data-testid={`button-open-back-${open.fromUserId}`}
          >
            <Heart className="w-4 h-4" />
            {t("btn_like_back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function LikesPage() {
  const { t } = useLanguageContext();
  const [celebration, setCelebration] = useState<MatchCelebration | null>(null);
  const [showFullMessage, setShowFullMessage] = useState(false);
  const [showElevate, setShowElevate] = useState(false);
  const [selectedLike, setSelectedLike] = useState<IncomingOpen | null>(null);
  const isActive = useTabActive();
  useRenderCount("LikesPage");

  // Progressive rendering — mount only the first N LikeCards immediately.
  // Each LikeCard has its own useQuery hook that issues a photo fetch; mounting
  // all at once spikes both the React reconciler cost and the network queue.
  // Remaining cards are revealed during idle after the first frame commits.
  const [visibleCount, setVisibleCount] = useState<number>(isMobile ? 5 : Infinity);
  const { toast } = useToast();

  // Dev-only page lifecycle instrumentation — no-op in production
  const { markDataReceived, markPageReady } = usePerfTrace("LIKES");

  // Detect return from a cancelled Stripe checkout session (only when actually on /likes)
  useEffect(() => {
    if (window.location.pathname !== "/likes") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "cancelled") {
      toast({
        title: "Checkout cancelled",
        description: "No payment was made. You can boost your profile whenever you're ready.",
      });
      window.history.replaceState({}, "", "/likes");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: likes, isLoading, isError: isLikesError, refetch: refetchLikes } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: isActive ? 60000 : false,
  });

  // Batch-prefetch photos on list arrival.
  // Mobile limit: 3 — just enough for the first visible items; decode pressure
  //   from 5+ simultaneous decode jobs at page load slows first-frame speed.
  // Desktop limit: 10 — more cores and RAM available.
  useEffect(() => {
    if (!likes || likes.length === 0) return;
    const limit = isMobile ? 3 : 10;
    const ids = likes.slice(0, limit).map(l => l.profile?.userId).filter(Boolean) as string[];
    if (ids.length > 0) batchPrefetchPhotos(ids);
  }, [likes]);

  // After the list arrives, reveal remaining cards during idle time so the
  // initial render only processes the first 5 items on mobile.
  useEffect(() => {
    if (!isMobile || !likes || likes.length <= 5) return;
    scheduleIdle(() => setVisibleCount(Infinity));
  }, [likes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Perf instrumentation — dev-only, no-op in production
  useEffect(() => {
    if (likes) markDataReceived({ count: likes.length });
  }, [likes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isLoading && likes) markPageReady({ count: likes.length });
  }, [isLoading, likes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive connection count from the already-cached matches list —
  // avoids a separate /api/match-count round trip (~500 ms) on every Likes page visit.
  const { data: _cachedMatches } = useQuery<any[]>({ queryKey: ["/api/matches"] });
  const connectionsFull = (_cachedMatches?.length ?? 0) >= 8;

  const { data: elevateStatus } = useQuery<ElevateStatus>({
    queryKey: ["/api/elevate/status"],
    refetchInterval: isActive ? 60000 : false,
  });
  const elevateActive = elevateStatus?.active === true;

  useEffect(() => {
    if (!connectionsFull) setShowFullMessage(false);
  }, [connectionsFull]);


  if (isLikesError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <Eye className="w-10 h-10 text-muted-foreground/40 mx-auto" />
          <h2 className="font-serif text-xl font-bold" data-testid="text-likes-error">{t("couldnt_load_likes")}</h2>
          <p className="text-sm text-muted-foreground">{t("something_went_wrong")}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={() => refetchLikes()}
            data-testid="button-retry-likes"
          >
            {t("try_again")}
          </button>
        </div>
      </div>
    );
  }

  const likesList = likes || [];

  if (!isLoading && likesList.length === 0 && !celebration) {
    return (
      <>
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-4 max-w-xs mx-auto w-full">
          {elevateActive && elevateStatus?.type && (
            <div className="w-full">
              <ElevateStatusCard
                elevateType={elevateStatus.type}
                expiresAt={elevateStatus.expiresAt}
              />
            </div>
          )}

          <div className="text-center space-y-5 w-full">
            <div className="w-20 h-20 rounded-full bg-primary/8 border border-primary/15 flex items-center justify-center mx-auto">
              <Eye className="w-9 h-9 text-primary/60" />
            </div>

            <div className="space-y-2">
              <h2 className="font-serif text-2xl font-bold" data-testid="text-no-likes">
                {t("no_likes_yet")}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("no_likes_desc")}
              </p>
            </div>

            {!elevateActive && (
              <button
                className="w-full rounded-xl bg-primary text-primary-foreground px-5 py-3.5 font-semibold text-sm flex items-center justify-center gap-2 shadow-md hover:brightness-105 active:scale-95 transition-all"
                onClick={() => setShowElevate(true)}
                data-testid="button-elevate-cta"
              >
                <Sparkles className="w-4 h-4" />
                {t("elevate_profile_btn")}
                <ChevronRight className="w-4 h-4 ml-auto opacity-70" />
              </button>
            )}

            <p className="text-xs text-muted-foreground">
              When someone opens your profile, they'll appear here.
            </p>
          </div>
        </div>

        {showElevate && <ElevateModal onClose={() => setShowElevate(false)} />}
      </>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-lg mx-auto w-full">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-primary" />
              <h1 className="font-serif text-2xl font-bold" data-testid="text-likes-title">{t("who_liked_you")}</h1>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs" data-testid="badge-likes-count">
                {likesList.length}
              </Badge>
              {!elevateActive && (
                <button
                  className="flex items-center gap-1.5 text-xs font-medium text-primary border border-primary/25 bg-primary/5 px-3 py-1.5 rounded-full hover:bg-primary/10 transition-colors"
                  onClick={() => setShowElevate(true)}
                  data-testid="button-elevate-header"
                >
                  <Sparkles className="w-3 h-3" />
                  Elevate
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            These people opened your profile. Tap a card to see their full profile.
          </p>
        </div>

        {elevateActive && elevateStatus?.type && (
          <ElevateStatusCard
            elevateType={elevateStatus.type}
            expiresAt={elevateStatus.expiresAt}
          />
        )}

        {(connectionsFull || showFullMessage) && (
          <div
            className="flex flex-col items-center gap-3 py-6 px-4 text-center"
            data-testid="banner-connections-full"
          >
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <p className="font-serif text-base font-semibold text-foreground">Connections room is full</p>
            <p className="text-sm text-muted-foreground">Close a connection to free up space</p>
          </div>
        )}

        {/* Inline skeleton while /api/who-liked-you loads — page header visible immediately */}
        {isLoading && (
          <div className="space-y-3" data-testid="section-likes-loading">
            {[1, 2, 3].map(i => (
              <Skeleton key={i} className="h-20 w-full rounded-md" />
            ))}
          </div>
        )}

        <div className="space-y-3">
          {likesList.slice(0, visibleCount).map(open => (
            <LikeCard
              key={open.id}
              open={open}
              onMatch={setCelebration}
              onConnectionFull={() => setShowFullMessage(true)}
              onOpenProfile={() => setSelectedLike(open)}
            />
          ))}
        </div>
      </div>

      {/* Full-screen profile modal */}
      {selectedLike && (
        <ProfileModal
          open={selectedLike}
          onClose={() => setSelectedLike(null)}
          onMatch={setCelebration}
          onConnectionFull={() => { setShowFullMessage(true); setSelectedLike(null); }}
        />
      )}

      {celebration && <MatchOverlay celebration={celebration} onClose={() => setCelebration(null)} />}
      {showElevate && <ElevateModal onClose={() => setShowElevate(false)} />}
    </>
  );
}
