import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useLanguageContext } from "@/contexts/language-context";
import { LANGUAGE_NAME_TO_CODE } from "@/lib/i18n";
import { useAuth } from "@/hooks/use-auth";
import { LulouGuide } from "@/components/lulou-guide";
import { GUIDE_KEYS } from "@/lib/guide-store";
import { translateSignal, translateGreenFlag, translateIntent, translateStyle, translateStarterItem } from "@/lib/profile-i18n";
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
  ChevronLeft, Ruler, Loader2,
} from "lucide-react";
import { PhotoCarousel } from "@/components/photo-carousel";
import { ElevateModal } from "@/components/elevate-modal";
import { ProfileInfoRow } from "@/components/profile-info-row";
import { ElevateStatusCard } from "@/components/elevate-status-card";
import { decodedPhotos, EMPTY_PHOTOS } from "@/lib/image-utils";
import type { Profile, Interaction } from "@shared/schema";
import { MatchOverlay, type MatchCelebration } from "@/components/match-overlay";

type IncomingOpen = Interaction & { profile: Profile };
type ElevateStatus = { type: string | null; expiresAt: string | null; active: boolean };
type IncomingWheelSpark = Interaction & { profile: Profile };


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
  const { t, isRTL, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
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
          title: type === "open" ? t("couldnt_send_like") : t("couldnt_close_action"),
          description: err?.message || t("something_went_wrong"),
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
        onMatch({ firstName: profile.firstName, photo: photos[0], matchId: data.matchId });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: t("passed_title"), description: t("passed_on_name").replace("{name}", profile.firstName) });
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
          className="absolute top-4 start-4 z-20 w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-all"
          style={{ background: "hsl(0 0% 0% / 0.4)", backdropFilter: "blur(8px)" }}
          onClick={handleClose}
          data-testid="button-close-profile-modal"
          aria-label={t("close_profile_aria")}
        >
          {isRTL ? <ChevronRight className="w-5 h-5 text-white" /> : <ChevronLeft className="w-5 h-5 text-white" />}
        </button>

        {/* Photo count badge */}
        {photos.length > 1 && (
          <div
            className="absolute top-4 end-4 z-20 px-2.5 py-1 rounded-full text-white text-xs font-medium"
            style={{ background: "hsl(0 0% 0% / 0.4)", backdropFilter: "blur(8px)" }}
          >
            {photoIndex + 1} / {photos.length}
          </div>
        )}

        {/* Prev arrow */}
        {photos.length > 1 && photoIndex > 0 && (
          <button
            className="absolute start-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
            style={{ background: "hsl(0 0% 0% / 0.35)", backdropFilter: "blur(6px)" }}
            onClick={() => setPhotoIndex(i => Math.max(0, i - 1))}
            data-testid="button-modal-prev-photo"
            aria-label={t("prev_photo_aria")}
          >
            {isRTL ? <ChevronRight className="w-4 h-4 text-white" /> : <ChevronLeft className="w-4 h-4 text-white" />}
          </button>
        )}

        {/* Next arrow */}
        {photos.length > 1 && photoIndex < photos.length - 1 && (
          <button
            className="absolute end-3 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
            style={{ background: "hsl(0 0% 0% / 0.35)", backdropFilter: "blur(6px)" }}
            onClick={() => setPhotoIndex(i => Math.min(photos.length - 1, i + 1))}
            data-testid="button-modal-next-photo"
            aria-label={t("next_photo_aria")}
          >
            {isRTL ? <ChevronLeft className="w-4 h-4 text-white" /> : <ChevronRight className="w-4 h-4 text-white" />}
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
        <div className="absolute bottom-4 inset-x-5 z-20">
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
                {t("verified_label")}
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
              {translateIntent(profile.datingIntent ?? "", t)}
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
                  {translateSignal(s, langCode)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Connection style */}
        {profile.connectionStyle && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("section_connection_style")}</p>
            <p className="text-sm leading-relaxed">{translateStyle(profile.connectionStyle ?? "", t)}</p>
          </div>
        )}

        {/* Green flags */}
        {greenFlags.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("green_flags_label")}</p>
            <div className="flex flex-wrap gap-2">
              {greenFlags.map((g: string) => (
                <Badge key={g} variant="secondary" className="text-sm px-3 py-1 rounded-full">
                  {translateGreenFlag(g, langCode)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Conversation starters */}
        {conversationStarters.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{t("section_conversation_starters")}</p>
            <div className="space-y-2">
              {conversationStarters.map((s: string, i: number) => (
                <div
                  key={i}
                  className="text-sm leading-relaxed rounded-xl px-4 py-3"
                  style={{ background: "hsl(var(--muted) / 0.5)" }}
                >
                  {translateStarterItem(s, langCode)}
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
  const { t, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
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
          title: type === "open" ? t("couldnt_send_like") : t("couldnt_close_action"),
          description: err?.message || t("something_went_wrong"),
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
        onMatch({ firstName: open.profile.firstName, photo, matchId: data.matchId });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: t("passed_title"), description: t("passed_on_name").replace("{name}", open.profile.firstName) });
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
            className="absolute top-3 end-3 px-2 py-0.5 rounded-full text-white text-[11px] font-medium"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
          >
            {t("n_photos").replace("{n}", String(photoCount))}
          </div>
        )}
        {/* Name + age overlay */}
        <div className="absolute bottom-3 inset-x-4">
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
                {t("verified_label")}
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
                {translateSignal(signal, langCode)}
              </Badge>
            ))}
            {open.profile.datingIntent && (
              <Badge variant="secondary" className="text-xs px-2.5 py-0.5 rounded-full">
                {translateIntent(open.profile.datingIntent, t)}
              </Badge>
            )}
          </div>
        )}

        <ProfileInfoRow
          age={open.profile.age}
          location={open.profile.location}
          height={open.profile.height}
          dateOfBirth={(open.profile as any).dateOfBirth}
          pronouns={(open.profile as any).pronouns}
        />

        {/* View full profile hint */}
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Eye className="w-3 h-3" />
          {t("tap_view_full_profile")}
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

// ─── Spark Card ────────────────────────────────────────────────────────────────

function SparkCard({
  spark,
  onMatch,
  onDecline,
}: {
  spark: IncomingWheelSpark;
  onMatch: (c: MatchCelebration) => void;
  onDecline: () => void;
}) {
  const { t } = useLanguageContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const firstPhoto = spark.profile.photos?.[0] ?? null;

  const acceptSpark = useMutation({
    mutationFn: async () => {
      console.log("[HALO] ACCEPT_CLICK", { sparkId: spark.id, fromUserId: spark.fromUserId });
      const payload = { fromUserId: spark.fromUserId };
      console.log("[HALO] ACCEPT_PAYLOAD", payload);
      const res = await apiRequest("POST", "/api/wheel/spark/accept", payload);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/wheel/sparks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      if (data?.matchId) {
        onMatch({
          matchId: data.matchId,
          firstName: spark.profile.firstName ?? "",
          photo: spark.profile.photos?.[0],
        });
      }
      onDecline();
    },
    onError: (err: any) => {
      toast({ title: err?.message || t("something_went_wrong"), variant: "destructive" });
    },
  });

  const declineSpark = useMutation({
    mutationFn: async () => {
      console.log("[HALO] DECLINE_CLICK", { sparkId: spark.id, fromUserId: spark.fromUserId });
      const payload = { fromUserId: spark.fromUserId };
      console.log("[HALO] DECLINE_PAYLOAD", payload);
      await apiRequest("POST", "/api/wheel/spark/decline", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wheel/sparks"] });
      onDecline();
    },
    onError: (err: any) => {
      toast({ title: err?.message || t("something_went_wrong"), variant: "destructive" });
    },
  });

  const isPending = acceptSpark.isPending || declineSpark.isPending;

  return (
    <div
      data-testid={`card-spark-${spark.fromUserId}`}
      style={{
        borderRadius: 18,
        border: "1.5px solid rgba(212,92,116,0.45)",
        boxShadow: "0 0 22px 4px rgba(212,92,116,0.12), 0 2px 12px rgba(0,0,0,0.08)",
        background: "linear-gradient(145deg, rgba(255,248,250,1) 0%, rgba(255,240,244,1) 100%)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* ✦ badge */}
      <div style={{
        position: "absolute", top: 10, left: 10, zIndex: 10,
        display: "flex", alignItems: "center", gap: 5,
        background: "linear-gradient(135deg,#d45c74,#9d3550)",
        borderRadius: 20, padding: "3px 9px",
        boxShadow: "0 2px 8px rgba(188,78,96,0.38)",
      }}>
        <span style={{ fontSize: 10, color: "#fff", fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase" }}>
          {t("spark_badge_label")}
        </span>
      </div>

      <div className="flex gap-3 p-3 pt-11 items-center">
        {/* Photo */}
        <div style={{ width: 68, height: 68, borderRadius: 14, overflow: "hidden", flexShrink: 0, position: "relative" }}>
          {firstPhoto ? (
            <img
              src={firstPhoto}
              alt=""
              className="w-full h-full object-cover"
              draggable={false}
              style={{ opacity: decodedPhotos.has(firstPhoto) ? 1 : 0, transition: "opacity 80ms ease" }}
              onLoad={e => {
                decodedPhotos.add(firstPhoto);
                (e.currentTarget as HTMLImageElement).style.opacity = "1";
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, hsl(350 45% 92%), hsl(350 45% 82%))" }}>
              <span className="font-serif font-bold text-2xl" style={{ color: "hsl(350 45% 52%)" }}>
                {spark.profile.firstName?.[0]}
              </span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-serif font-bold text-base leading-tight" style={{ color: "#1a1018" }}>
              {spark.profile.firstName}{spark.profile.age ? `, ${spark.profile.age}` : ""}
            </span>
            {spark.profile.photoVerified && (
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4" style={{ background: "rgba(212,92,116,0.12)", color: "#9d3550", border: "1px solid rgba(212,92,116,0.22)" }}>
                {t("verified_label")}
              </Badge>
            )}
          </div>
          {spark.profile.location && (
            <div className="flex items-center gap-1 mt-0.5">
              <MapPin className="w-3 h-3" style={{ color: "rgba(212,92,116,0.7)" }} />
              <span className="text-xs truncate" style={{ color: "rgba(100,60,80,0.6)" }}>{spark.profile.location}</span>
            </div>
          )}
          {spark.profile.signals && spark.profile.signals.length > 0 && (
            <p className="text-xs mt-0.5 truncate" style={{ color: "rgba(100,60,80,0.55)", fontStyle: "italic" }}>
              {spark.profile.signals[0]}
            </p>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 px-3 pb-3">
        <button
          onClick={() => declineSpark.mutate()}
          disabled={isPending}
          data-testid={`button-spark-pass-${spark.fromUserId}`}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
          style={{ background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.07)", color: "rgba(60,30,50,0.55)" }}
        >
          <span>🌙</span>
          <span>{t("spark_pass_btn")}</span>
        </button>
        <button
          onClick={() => acceptSpark.mutate()}
          disabled={isPending}
          data-testid={`button-spark-accept-${spark.fromUserId}`}
          className="flex-[2] flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-95 disabled:opacity-60"
          style={{
            background: "linear-gradient(135deg,#d45c74 0%,#9d3550 100%)",
            boxShadow: "0 3px 14px rgba(188,78,96,0.40)",
            color: "#fff",
          }}
        >
          {acceptSpark.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <span style={{ fontSize: 13 }}>✨</span>
          )}
          <span>{t("spark_accept_btn")}</span>
        </button>
      </div>
    </div>
  );
}


// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function LikesPage() {
  const { t } = useLanguageContext();
  const { user } = useAuth();
  const [celebration, setCelebration] = useState<MatchCelebration | null>(null);
  const [showFullMessage, setShowFullMessage] = useState(false);
  const [showElevate, setShowElevate] = useState(false);
  const [elevateGuideTriggered, setElevateGuideTriggered] = useState(false);
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
        title: t("checkout_cancelled_title"),
        description: t("checkout_cancelled_desc"),
      });
      window.history.replaceState({}, "", "/likes");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queryClient = useQueryClient();

  const { data: likes, isLoading, isError: isLikesError, refetch: refetchLikes } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    staleTime: 0,               // always stale → refetchOnWindowFocus actually fires
    refetchInterval: isActive ? 15000 : false,
    refetchOnWindowFocus: true,
  });

  // Realtime subscription — Supabase postgres_changes on the interactions table
  // filtered to rows where to_user_id = current user.  When Account A likes
  // Account B, this fires on B's client immediately, invalidating the cache and
  // pulling the new row — no need to wait for the 15-second poll.
  useEffect(() => {
    if (!user?.id) return;
    const channel = supabase
      .channel(`incoming-likes:${user.id}`)
      .on(
        "postgres_changes" as any,
        {
          event: "INSERT",
          schema: "public",
          table: "interactions",
          filter: `to_user_id=eq.${user.id}`,
        },
        (payload: any) => {
          if (payload?.new?.type !== "open") return; // ignore close/wheel_connection
          console.log("[LIKES_RT] new incoming open received — invalidating cache");
          queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
        }
      )
      .subscribe((status: string) => {
        console.log(`[LIKES_RT] channel status=${status} userId=${user.id.slice(0,8)}…`);
      });
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, queryClient]);

  const { data: sparks } = useQuery<IncomingWheelSpark[]>({
    queryKey: ["/api/wheel/sparks"],
    refetchInterval: isActive ? 20000 : false,
    refetchOnWindowFocus: true,
  });
  const sparkList = sparks ?? [];

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
    refetchInterval: isActive ? 15000 : false,
    refetchOnWindowFocus: true,
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
                onClick={() => { setShowElevate(true); setElevateGuideTriggered(true); }}
                data-testid="button-elevate-cta"
              >
                <Sparkles className="w-4 h-4" />
                {t("elevate_profile_btn")}
                <ChevronRight className="w-4 h-4 ms-auto opacity-70" />
              </button>
            )}

            <p className="text-xs text-muted-foreground">
              {t("likes_appear_here")}
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
                  onClick={() => { setShowElevate(true); setElevateGuideTriggered(true); }}
                  data-testid="button-elevate-header"
                >
                  <Sparkles className="w-3 h-3" />
                  {t("elevate_label")}
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("who_liked_you_desc")}
          </p>
        </div>

        {elevateActive && elevateStatus?.type && (
          <ElevateStatusCard
            elevateType={elevateStatus.type}
            expiresAt={elevateStatus.expiresAt}
          />
        )}

        {/* ── Lulou Halos section — above normal likes ── */}
        {sparkList.length > 0 && (
          <div className="space-y-2" data-testid="section-sparks">
            <div className="flex items-center gap-2 pb-1">
              <h2 className="font-serif text-base font-bold" style={{ color: "hsl(350 45% 38%)" }} data-testid="text-sparks-title">
                {t("sparks_section_title")}
              </h2>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 ms-auto" style={{ background: "rgba(212,92,116,0.10)", color: "#9d3550", border: "1px solid rgba(212,92,116,0.20)" }}>
                {sparkList.length}
              </Badge>
            </div>
            {sparkList.map(spark => (
              <SparkCard
                key={spark.id}
                spark={spark}
                onMatch={setCelebration}
                onDecline={() => {}}
              />
            ))}
          </div>
        )}

        {(connectionsFull || showFullMessage) && (
          <div
            className="flex flex-col items-center gap-3 py-6 px-4 text-center"
            data-testid="banner-connections-full"
          >
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <p className="font-serif text-base font-semibold text-foreground">{t("connections_room_full")}</p>
            <p className="text-sm text-muted-foreground">{t("close_conn_free_space")}</p>
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

      {elevateGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.ELEVATE_SCREEN}
          userId={user?.id}
          title="More visibility."
          body="Elevate places your profile in front of more compatible people."
          delay={1000}
        />
      )}
    </>
  );
}
