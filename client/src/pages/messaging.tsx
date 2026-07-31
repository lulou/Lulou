import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { armCallSession, markSessionAsPaid } from "@/lib/live-call-sessions";
import { getEndedSessionForMatch, clearEndedSessionForMatch } from "@/lib/cancelled-calls";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { ArrowLeft, Send, Phone, Video, Check, Clock, Calendar, Heart, PhoneForwarded, X, Moon, MapPin, Ruler, MessageCircle, Loader2, Mic, Pause, Play, BadgeCheck, Sparkles, ChevronDown, RefreshCw } from "lucide-react";
import { requestMicStream, prewarmMicStream, wasMicGrantedBefore, getMicPermState, releaseMicStream, type MicPermState } from "@/lib/mic-permission";
import { scanContent } from "@/lib/content-filter";
import { formatLastActive } from "@/lib/last-active";
import { PurchasePrompt, type PurchaseFeature } from "@/components/purchase-prompt";
import { PhotoCarousel } from "@/components/photo-carousel";
import { Input } from "@/components/ui/input";
import type { Message, Match, Profile } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";
import { type TranslationKey } from "@/lib/i18n";
import { usePushNotifications } from "@/hooks/use-push-notifications";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;

const FALLBACK_STARTERS = [
  "What made you want to try a more intentional approach to dating?",
  "What's something you've genuinely been excited about lately?",
  "If you could design your ideal first meeting, what would it look like?",
];

type MatchDetail = Match & { profile: Profile; messages: Message[] };

function generateDateSlots(t: (key: TranslationKey) => string): { label: string; value: string }[] {
  const slots: { label: string; value: string }[] = [];
  const now = new Date();
  const dayNames = [t("day_sun"), t("day_mon"), t("day_tue"), t("day_wed"), t("day_thu"), t("day_fri"), t("day_sat")];
  const monthNames = [t("month_jan"), t("month_feb"), t("month_mar"), t("month_apr"), t("month_may"), t("month_jun"), t("month_jul"), t("month_aug"), t("month_sep"), t("month_oct"), t("month_nov"), t("month_dec")];
  const timeSlots = [
    { label: t("time_morning"), time: "10:00" },
    { label: t("time_afternoon"), time: "14:00" },
    { label: t("time_evening"), time: "19:00" },
    { label: t("time_late_evening"), time: "20:30" },
  ];

  for (let d = 1; d <= 7; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() + d);
    const dayLabel = `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}`;
    for (const slot of timeSlots) {
      slots.push({
        label: `${dayLabel} - ${slot.label}`,
        value: `${date.toISOString().slice(0, 10)} ${slot.time}`,
      });
    }
  }
  return slots;
}

function ReadyToMeetSection({ matchDetail, matchId }: { matchDetail: MatchDetail; matchId: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useLanguageContext();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const dateSlots = generateDateSlots(t);

  const isUser1 = matchDetail.user1Id === user?.id;
  const myAvailability = isUser1 ? matchDetail.meetAvailability1 : matchDetail.meetAvailability2;
  const theirAvailability = isUser1 ? matchDetail.meetAvailability2 : matchDetail.meetAvailability1;
  const myNumberExchanged = isUser1 ? matchDetail.numberExchanged1 : matchDetail.numberExchanged2;
  const theirNumberExchanged = isUser1 ? matchDetail.numberExchanged2 : matchDetail.numberExchanged1;

  const mySlots: string[] = myAvailability ? JSON.parse(myAvailability) : [];
  const theirSlots: string[] = theirAvailability ? JSON.parse(theirAvailability) : [];
  const matchingSlots = mySlots.filter(s => theirSlots.includes(s));

  const { data: myProfile } = useQuery<Profile>({ queryKey: ["/api/profile"] });

  const saveAvailability = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${matchId}/meet-availability`, { slots: selectedSlots });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
      toast({ title: t("availability_shared"), description: t("availability_shared_desc").replace("{name}", matchDetail.profile.firstName) });
      setShowDatePicker(false);
    },
    onError: (error: Error) => {
      toast({ title: t("could_not_save"), description: error.message, variant: "destructive" });
    },
  });

  const savePhoneAndExchange = useMutation({
    mutationFn: async () => {
      if (phoneNumber.trim()) {
        await apiRequest("POST", "/api/profile", { phoneNumber: phoneNumber.trim() });
      }
      const res = await apiRequest("POST", `/api/matches/${matchId}/exchange-number`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: t("number_shared_title"), description: t("number_sent_to_desc").replace("{name}", matchDetail.profile.firstName) });
      setShowPhoneInput(false);
    },
    onError: (error: Error) => {
      toast({ title: t("could_not_share"), description: error.message, variant: "destructive" });
    },
  });

  const toggleSlot = (value: string) => {
    setSelectedSlots(prev => {
      if (prev.includes(value)) return prev.filter(s => s !== value);
      if (prev.length >= 5) return prev;
      return [...prev, value];
    });
  };

  const handleExchangeNumber = () => {
    if (myProfile?.phoneNumber) {
      savePhoneAndExchange.mutate();
    } else {
      setShowPhoneInput(true);
    }
  };

  if (showPhoneInput) {
    return (
      <div className="p-4 border-t">
        <Card className="p-5 space-y-4 bg-primary/5 border-primary/20">
          <div className="text-center space-y-2">
            <PhoneForwarded className="w-6 h-6 text-primary mx-auto" />
            <p className="font-medium text-sm">{t("add_your_phone_title")}</p>
            <p className="text-xs text-muted-foreground">{t("number_will_be_sent_to").replace("{name}", matchDetail.profile.firstName)}</p>
          </div>
          <Input
            type="tel"
            value={phoneNumber}
            onChange={e => setPhoneNumber(e.target.value)}
            placeholder={t("your_phone_ph")}
            maxLength={20}
            data-testid="input-phone-number"
          />
          <div className="flex items-center gap-2 justify-center">
            <Button
              size="sm"
              onClick={() => savePhoneAndExchange.mutate()}
              disabled={!phoneNumber.trim() || savePhoneAndExchange.isPending}
              data-testid="button-confirm-exchange"
            >
              {savePhoneAndExchange.isPending ? t("sending_ellipsis") : t("share_my_number")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowPhoneInput(false)} data-testid="button-cancel-phone">
              {t("cancel")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (showDatePicker) {
    return (
      <div className="p-4 border-t">
        <Card className="p-5 space-y-4 bg-primary/5 border-primary/20">
          <div className="text-center space-y-2">
            <Calendar className="w-6 h-6 text-primary mx-auto" />
            <p className="font-medium text-sm">{t("when_are_you_free")}</p>
            <p className="text-xs text-muted-foreground">{t("select_5_slots")}</p>
          </div>
          <div className="max-h-60 overflow-y-auto space-y-1.5">
            {dateSlots.map(slot => {
              const selected = selectedSlots.includes(slot.value);
              return (
                <div
                  key={slot.value}
                  className={`flex items-center gap-2 p-2.5 rounded-md cursor-pointer transition-all text-sm ${
                    selected ? "bg-primary/15 border border-primary/30" : "hover-elevate border border-transparent"
                  }`}
                  onClick={() => toggleSlot(slot.value)}
                  data-testid={`slot-${slot.value}`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selected ? "border-primary bg-primary" : "border-muted-foreground/30"
                  }`}>
                    {selected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                  </div>
                  <span>{slot.label}</span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground text-center">{t("n_of_5_selected").replace("{n}", String(selectedSlots.length))}</p>
          <div className="flex items-center gap-2 justify-center">
            <Button
              size="sm"
              onClick={() => saveAvailability.mutate()}
              disabled={selectedSlots.length === 0 || saveAvailability.isPending}
              data-testid="button-save-availability"
            >
              {saveAvailability.isPending ? t("saving_ellipsis") : t("share_availability_btn")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDatePicker(false)} data-testid="button-cancel-dates">
              {t("cancel")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (myNumberExchanged) {
    return (
      <div className="p-4 border-t space-y-3">
        <Card className="p-5 text-center space-y-3 bg-primary/5 border-primary/20">
          <Heart className="w-6 h-6 text-primary mx-auto" />
          <p className="font-medium text-sm">{t("number_shared_title")}</p>
          <p className="text-xs text-muted-foreground">
            {theirNumberExchanged
              ? t("both_exchanged_numbers")
              : t("number_sent_waiting").replace("{name}", matchDetail.profile.firstName)}
          </p>
          {matchingSlots.length > 0 && (
            <div className="space-y-1 pt-2">
              <p className="text-xs font-medium text-muted-foreground">{t("your_matching_times")}</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => {
                  const matched = dateSlots.find(d => d.value === s);
                  return <Badge key={s} variant="secondary" className="text-xs">{matched?.label || s}</Badge>;
                })}
              </div>
            </div>
          )}
          {theirNumberExchanged && (
            <Button
              className="w-full mt-2"
              onClick={() => navigate(`/date-plan/${matchId}`)}
              data-testid="button-plan-date"
            >
              <Heart className="w-4 h-4 me-2" />
              Plan Your Date in Lulou
            </Button>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 border-t">
      <Card className="p-5 text-center space-y-4 bg-primary/5 border-primary/20">
        <Check className="w-6 h-6 text-primary mx-auto" />
        <p className="font-medium text-sm">{t("all_calls_completed")}</p>
        <p className="text-xs text-muted-foreground">{t("ready_to_meet_real")}</p>

        {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length > 0 ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2 justify-center">
              <Heart className="w-4 h-4 text-primary" />
              <p className="font-medium text-sm text-primary">{t("your_date_on_cards")}</p>
              <Heart className="w-4 h-4 text-primary" />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("you_both_matched_on")}</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => {
                  const matched = dateSlots.find(d => d.value === s);
                  return <Badge key={s} className="text-xs bg-primary/15 text-primary border-primary/30">{matched?.label || s}</Badge>;
                })}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-center pt-1">
              <Button size="sm" onClick={handleExchangeNumber} data-testid="button-exchange-number">
                <PhoneForwarded className="w-4 h-4 me-2" /> {t("exchange_number_btn")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
                <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {mySlots.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("your_availability_lbl")}</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {mySlots.map((s: string) => {
                    const matched = dateSlots.find(d => d.value === s);
                    return <Badge key={s} variant="secondary" className="text-xs">{matched?.label || s}</Badge>;
                  })}
                </div>
              </div>
            )}

            {theirSlots.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">{t("their_availability_lbl").replace("{name}", matchDetail.profile.firstName)}</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {theirSlots.map((s: string) => {
                    const matched = dateSlots.find(d => d.value === s);
                    return <Badge key={s} variant="outline" className="text-xs">{matched?.label || s}</Badge>;
                  })}
                </div>
              </div>
            )}

            {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("no_matching_times")}</p>
            )}

            <div className="flex flex-col gap-2 items-center">
              {mySlots.length === 0 ? (
                <Button size="sm" onClick={() => setShowDatePicker(true)} data-testid="button-ready-to-meet">
                  <Calendar className="w-4 h-4 me-2" /> {t("ready_to_meet")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
                  <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function VoiceNotePlayer({ url, isMe, transcript }: { url: string; isMe: boolean; transcript?: string | null }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [audioError, setAudioError] = useState(false);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause(); else a.play().catch(() => setAudioError(true));
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const progress = duration > 0 ? currentTime / duration : 0;
  const audioTranscriptsEnabled = localStorage.getItem("audio_transcripts") === "true";

  return (
    <div className="flex flex-col gap-1 max-w-[240px]">
      <div
        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl min-w-[180px] ${
          isMe ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        }`}
      >
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setCurrentTime(0); }}
          onLoadedMetadata={e => setDuration((e.target as HTMLAudioElement).duration || 0)}
          onTimeUpdate={e => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
          onError={() => setAudioError(true)}
        />
        {audioError ? (
          <p className="text-[10px] opacity-60 italic flex-1">Unable to play on this device</p>
        ) : (
          <>
            <button
              onClick={e => { e.stopPropagation(); toggle(); }}
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
              style={{ background: isMe ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)" }}
              data-testid="button-voice-play"
            >
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            <div className="flex-1 min-w-0 space-y-1">
              <div
                className="h-1 rounded-full overflow-hidden"
                style={{ background: isMe ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.10)" }}
              >
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${progress * 100}%`,
                    background: isMe ? "rgba(255,255,255,0.80)" : "hsl(var(--primary))",
                  }}
                />
              </div>
              <p className="text-[10px] opacity-55 font-mono tabular-nums">
                {fmt(playing ? currentTime : (duration || 0))}
              </p>
            </div>
            <Mic className="w-3 h-3 shrink-0 opacity-40" />
          </>
        )}
      </div>
      {audioTranscriptsEnabled && transcript && (
        <button
          className={`text-[10px] flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity ${isMe ? "self-end" : "self-start"}`}
          onClick={e => { e.stopPropagation(); setShowTranscript(v => !v); }}
          data-testid="button-voice-transcript-toggle"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${showTranscript ? "rotate-180" : ""}`} />
          {showTranscript ? "Hide transcript" : "Show transcript"}
        </button>
      )}
      {audioTranscriptsEnabled && transcript && showTranscript && (
        <div
          className={`text-xs px-3 py-2 rounded-lg max-w-[240px] italic ${
            isMe ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
          }`}
          data-testid="text-voice-transcript"
        >
          "{transcript}"
        </div>
      )}
    </div>
  );
}

export default function Messaging() {
  const [, params] = useRoute("/messages/:matchId");
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t, isRTL } = useLanguageContext();
  const [message, setMessage] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "profile">("chat");
  const [showAIStarters, setShowAIStarters] = useState(false);
  // True when the user explicitly taps X on the starters panel for this match.
  const [userClosedStarters, setUserClosedStarters] = useState(false);
  const [filterConfirm, setFilterConfirm] = useState<{ content: string; tempId: string; categories: string[] } | null>(null);
  // Tracks messages sent in the current call-stage session for optimistic counter display.
  // Resets when matchId or callStage changes so the counter always starts from the DB value.
  const [localSentCount, setLocalSentCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const matchId = params?.matchId;

  // ─── Fixed-layout measurement refs ───────────────────────────────────────────
  const headerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(60);
  const [composerHeight, setComposerHeight] = useState(70);
  // Viewport metrics for keyboard tracking and debug overlay
  const [vvHeight, setVvHeight] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 800));
  const [vvOffsetTop, setVvOffsetTop] = useState(0);
  // Enable layout debug overlay in Safari console:
  //   localStorage.setItem('lulou_layout_debug','1'); location.reload()
  const isLayoutDebug = typeof window !== "undefined" && localStorage.getItem("lulou_layout_debug") === "1";
  // Build-identity state for the debug strip
  const [swVersion, setSwVersion]     = useState<string>("…");
  const [cacheNames, setCacheNames]   = useState<string[]>([]);

  // ── Draft restoration — runs once per matchId so unsent text survives navigation ──
  useEffect(() => {
    if (!matchId) return;
    try {
      const saved = localStorage.getItem(`chat_draft_${matchId}`);
      if (saved) setMessage(saved);
    } catch { /* noop */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // ── Badge: mark this match as read and sync badge count ───────────────────
  const { setBadge } = usePushNotifications();
  useEffect(() => {
    if (!matchId) return;
    (async () => {
      try {
        const res = await fetch(`/api/messages/${matchId}/mark-read`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        if (res.ok) {
          const { total } = await res.json();
          setBadge(typeof total === "number" ? Math.max(0, total) : 0);
        }
      } catch {
        // Non-fatal — badge just won't update immediately
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // ── Timing (perf diagnostics) ──────────────────────────────────────────────
  const mountedAtRef = useRef(Date.now());

  // ── Immediate shell data from matches-list cache ────────────────────────────
  // ["/api/matches"] is already in memory when navigating from the matches list.
  // We use it so the header (name, avatar) renders at 0ms instead of blocking
  // on the full detail fetch.
  const cachedMatches = queryClient.getQueryData<any[]>(["/api/matches"]);
  const cachedEntry = cachedMatches?.find((m: any) => m.id === matchId) ?? null;

  // ── Pagination state ────────────────────────────────────────────────────────
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const oldestCursorRef = useRef<string | null>(null);
  const scrollAnchorRef = useRef<number | null>(null);
  // Declined session tracking — prevents the CTA card re-appearing after decline.
  // When matchDetail's callSessionId is cleared (decline/cancel), we keep the
  // previous session ID so the card stays suppressed for that session.
  const [declinedSessionIds, setDeclinedSessionIds] = useState<Set<string>>(() => new Set());
  const lastSeenCallSessionIdRef = useRef<string | null>(null);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // column-reverse: scrollTop=0 = visual bottom (newest). Near bottom ≡ low scrollTop.
    isAtBottomRef.current = el.scrollTop <= 80;
  }, []);

  const closeConnection = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/matches/${matchId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: t("connection_closed_title"), description: t("connection_closed_desc") });
      navigate("/matches");
    },
    onError: (error: Error) => {
      toast({ title: t("could_not_close_connection"), description: error.message, variant: "destructive" });
    },
  });

  // ── Call credits (phone icon state in header) ──────────────────────────────
  const { data: callCreditsData } = useQuery<{ phoneCredits: number; videoCredits: number }>({
    queryKey: ["/api/call-credits"],
    enabled: !!matchId,
    staleTime: 30_000,
  });
  const phoneCredits = callCreditsData?.phoneCredits ?? 0;
  const videoCredits = callCreditsData?.videoCredits ?? 0;

  // Voice notes entitlement — unlocks when both users have sent ≥8 messages (or call_stage > 0).
  // First call unlocks at ≥15 messages each way (separate milestone).
  // All popup-seen flags are server-persisted so modals only show once across all devices.
  const { data: voiceNoteData } = useQuery<{
    unlocked: boolean;
    popupSeen: boolean;
    firstCallUnlocked: boolean;
    firstCallPromptSeen: boolean;
  }>({
    queryKey: ["/api/voice-notes/entitlement", matchId],
    enabled: !!matchId,
    staleTime: 0,
    refetchInterval: 60_000, // true-realtime via broadcast; polling is fallback only
  });
  const voiceNotesUnlocked = voiceNoteData?.unlocked ?? false;
  const firstCallUnlocked  = voiceNoteData?.firstCallUnlocked ?? false;

  // Paid call mutation — starts an immediate call using a credit, bypassing stage gates.
  const startPaidCall = useMutation({
    mutationFn: async ({ isVideo }: { isVideo: boolean }) => {
      const res = await apiRequest("POST", `/api/matches/${matchId}/call/start`, { isPaidCredit: true, isVideo });
      const data = await res.json();
      return { data, isVideo };
    },
    onSuccess: ({ data, isVideo }) => {
      const m = data?.match ?? data;
      const callSessionId = m?.callSessionId;
      if (callSessionId) {
        armCallSession(callSessionId);
        markSessionAsPaid(callSessionId, isVideo);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId], exact: true });
      if (callSessionId && user?.id && matchId) {
        broadcastCallSignal(matchId, {
          type: "call:ring",
          matchId,
          callerId: user.id,
          callerName: "",
          callSessionId,
          isVideo,
        });
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] PAID_CALL_FAILED", { matchId, error: error.message });
      toast({
        title: "Call failed",
        description: error.message || "Could not start call. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Purchase prompt state
  const [purchasePromptFeature, setPurchasePromptFeature] = useState<PurchaseFeature | null>(null);

  // Voice-note unlock popup — shown once per user per match after the first call
  // completes. Server-persisted (voiceNotePopupSeen table) so it never repeats.
  const [voiceNotePopupOpen, setVoiceNotePopupOpen] = useState(false);
  // First-call unlock popup — shown once per user per match when both reach 15 messages.
  const [firstCallPopupOpen, setFirstCallPopupOpen] = useState(false);
  // Set to true when the first-call milestone fires while the VN popup is still open.
  // After VN is dismissed, this triggers the first-call celebration immediately.
  const [pendingFirstCallCelebration, setPendingFirstCallCelebration] = useState(false);

  // Realtime VN unlock: fires on both users' clients when the first call completes.
  // Sets popupSeen:false so the recovery useEffect triggers for the receiver.
  const onVoiceNoteUnlock = useCallback(() => {
    console.log("[PROGRESSION] REALTIME_VN_UNLOCK received (post-call)", { matchId: matchId?.slice(0, 8) });
    queryClient.setQueryData(
      ["/api/voice-notes/entitlement", matchId],
      (old: any) => old
        ? { ...old, unlocked: true, popupSeen: false }
        : { unlocked: true, popupSeen: false },
    );
    if (!localStorage.getItem(`vn_popup_${matchId}`)) {
      setVoiceNotePopupOpen(true);
    }
  }, [matchId, queryClient]);

  // Realtime first-call unlock: fires on the OTHER user's client when the sender crossed
  // the 15-message threshold. Routes through pendingFirstCallCelebration so the 1.5s
  // "return to chat" delay and VN-open guard apply uniformly for both users.
  const onFirstCallUnlock = useCallback(() => {
    queryClient.setQueryData(
      ["/api/voice-notes/entitlement", matchId],
      (old: any) => old
        ? { ...old, firstCallUnlocked: true }
        : { unlocked: true, popupSeen: true, firstCallUnlocked: true, firstCallPromptSeen: false },
    );
    if (!localStorage.getItem(`fc_popup_${matchId}`)) {
      setPendingFirstCallCelebration(true);
    }
  }, [matchId, queryClient]);

  // Recording state
  type VoicePhase = "idle" | "recording";
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const isRecording = voicePhase === "recording";
  const [recordingTime, setRecordingTime] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);

  // ── iOS keyboard + viewport metrics ──────────────────────────────────────
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardHeight(kh);
      setVvHeight(vv.height);
      setVvOffsetTop(vv.offsetTop);
    };
    update(); // prime on mount
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // When keyboard opens, scroll to newest if already near bottom.
  // column-reverse: scrollTop=0 = visual bottom.
  useEffect(() => {
    if (keyboardHeight > 0 && (isAtBottomRef.current || forceScrollRef.current)) {
      const id = setTimeout(() => {
        messagesContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
      }, 60);
      return () => clearTimeout(id);
    }
  }, [keyboardHeight]);

  // ── ResizeObserver — measure header + composer for fixed-position bottom/top ──
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    obs.observe(el);
    setHeaderHeight(el.offsetHeight);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setComposerHeight(el.offsetHeight));
    obs.observe(el);
    setComposerHeight(el.offsetHeight);
    return () => obs.disconnect();
  }, []);

  // ── Debug: fetch live SW version + commit via MessageChannel ──────────────
  useEffect(() => {
    if (!isLayoutDebug) return;
    if (!("serviceWorker" in navigator)) { setSwVersion("no-sw"); return; }
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg.active) { setSwVersion("no-active"); return; }
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => {
        if (e.data?.type === "VERSION") {
          setSwVersion(`v${e.data.version}@${e.data.commit ?? "?"}`);
        }
      };
      reg.active.postMessage({ type: "GET_VERSION" }, [port2]);
    }).catch(() => setSwVersion("error"));
  }, [isLayoutDebug]);

  // ── Debug: fetch cache storage key list via MessageChannel ────────────────
  useEffect(() => {
    if (!isLayoutDebug) return;
    if (!("serviceWorker" in navigator)) { setCacheNames(["no-sw"]); return; }
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg.active) { setCacheNames(["no-active"]); return; }
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => {
        if (e.data?.type === "CACHE_NAMES") setCacheNames(e.data.names ?? []);
      };
      reg.active.postMessage({ type: "GET_CACHE_NAMES" }, [port2]);
    }).catch(() => setCacheNames(["error"]));
  }, [isLayoutDebug]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartMsRef = useRef<number>(0);
  // Module-level shared stream — persists across component mounts so iOS never re-prompts.
  const micStreamRef = useRef<MediaStream | null>(null);
  // Permission state — drives the hint pill and denied card.
  const [micPermState, setMicPermState] = useState<MicPermState>(() => getMicPermState());

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
  };

  const startRecording = async () => {
    try {
      // Use the module-level shared stream — persists across component mounts so
      // iOS never re-prompts after the first grant. requestMicStream() is a no-op
      // if the stream is already live (returns immediately, no async getUserMedia).
      const stream = await requestMicStream();
      micStreamRef.current = stream;
      setMicPermState("granted");
      console.log("[VOICE_NOTE_MIC] recording started");

      const preferredTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType = preferredTypes.find(t => {
        try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
      }) ?? "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const actualMimeType = recorder.mimeType || mimeType;
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        // Do NOT stop stream tracks — module keeps the stream alive for the next recording.
        const blob = new Blob(audioChunksRef.current, { type: actualMimeType });
        if (blob.size > 0) sendVoiceNote.mutate({ blob, mimeType: actualMimeType });
        else setVoicePhase("idle");
      };
      recorder.start(100);
      mediaRecorderRef.current = recorder;
      recordingStartMsRef.current = Date.now();
      setVoicePhase("recording");
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(t => {
          if (t >= 59) { stopRecording(); return 60; }
          return t + 1;
        });
      }, 1000);
    } catch (err: any) {
      const isPermission = err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError";
      const isNotFound = err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError";
      if (isPermission) {
        console.log("[VOICE_NOTE_MIC] permission denied");
        setMicPermState("denied");
      } else if (isNotFound) {
        setMicPermState("unavailable");
      }
      // Denied state is shown via inline card — no destructive toast needed.
      if (!isPermission) {
        toast({
          title: isNotFound
            ? "No microphone found on this device"
            : "Could not start recording",
          variant: "destructive",
        });
      }
    }
  };

  const stopRecording = () => {
    const elapsed = Date.now() - recordingStartMsRef.current;
    if (elapsed < 300) {
      cancelRecording();
      toast({ title: "Hold the mic longer", description: "Press and hold while you speak, then release to send." });
      return;
    }
    stopRecordingTimer();
    setVoicePhase("idle");
    setRecordingTime(0);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    stopRecordingTimer();
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.ondataavailable = null;
      mr.onstop = null;
      // Do NOT stop the stream tracks — keep micStreamRef alive for the next recording.
      try { mr.stop(); } catch { /* ignore */ }
    }
    audioChunksRef.current = [];
    setVoicePhase("idle");
    setRecordingTime(0);
  };

  // Pre-warm the shared mic stream as soon as this chat view mounts.
  // If the user previously granted mic permission, we call getUserMedia() in the
  // background NOW (not on button press) so the stream is hot before they hold.
  useEffect(() => {
    if (voiceNotesUnlocked && wasMicGrantedBefore()) {
      prewarmMicStream();
    }
  }, [voiceNotesUnlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── iOS keyboard scroll fix ───────────────────────────────────────────────
  // On iOS Safari the AppLayout uses `position:fixed;inset:0` which is NOT
  // resized when the software keyboard opens (keyboard overlays instead).
  // We listen to visualViewport.resize and scroll the latest message into view
  // after a short delay (keyboard animation is ~250ms on iOS).
  // Also catches the case where the keyboard closes and messages need to
  // scroll back to bottom.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height;
    const handleResize = () => {
      const newHeight = vv.height;
      const diff = prevHeight - newHeight;
      prevHeight = newHeight;
      if (Math.abs(diff) > 50) {
        // Viewport height changed significantly → keyboard opened or closed.
        // Scroll to bottom so the latest message stays above the keyboard.
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
        }, 80);
      }
    };
    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Recovery guard: shows VN popup via polling if the progressionEvent was missed
  // (e.g. a different device sent the threshold message, or browser was briefly offline).
  // The server entitlement endpoint backfills popupSeen=true for callStage > 0 conversations,
  // so this useEffect naturally stays dormant for those — no redundant stage guard needed.
  useEffect(() => {
    if (voiceNotesUnlocked && voiceNoteData?.popupSeen === false) {
      if (!localStorage.getItem(`vn_popup_${matchId}`)) {
        setVoiceNotePopupOpen(true);
      }
    }
  }, [voiceNotesUnlocked, voiceNoteData?.popupSeen, matchId]);

  // Polling recovery: detects FC unlock via the 60s entitlement poll and routes it
  // through pendingFirstCallCelebration so the 1.5s delay and VN-open guard apply.
  useEffect(() => {
    if (
      firstCallUnlocked &&
      voiceNoteData?.firstCallPromptSeen === false &&
      !voiceNotePopupOpen &&
      !localStorage.getItem(`fc_popup_${matchId}`)
    ) {
      setPendingFirstCallCelebration(true);
    }
  }, [firstCallUnlocked, voiceNoteData?.firstCallPromptSeen, voiceNotePopupOpen, matchId]);

  // ── First-call celebration gate ────────────────────────────────────────────
  // Fires when pendingFirstCallCelebration is true AND VN popup is not open.
  // The 1500ms delay gives the user a brief "return to chat" moment, satisfying
  // the spec requirement that FC does not open in the same render tick as VN dismiss.
  useEffect(() => {
    if (!pendingFirstCallCelebration) return;
    if (voiceNotePopupOpen) return; // wait for VN to be dismissed first
    if (localStorage.getItem(`fc_popup_${matchId}`)) {
      setPendingFirstCallCelebration(false); // already seen on another device
      return;
    }
    const t = setTimeout(() => {
      setPendingFirstCallCelebration(false);
      setFirstCallPopupOpen(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [pendingFirstCallCelebration, voiceNotePopupOpen, matchId]);

  // Clean up the MediaRecorder on unmount.
  // Do NOT stop the module-level mic stream — it must survive component remounts
  // so iOS never re-prompts and recording starts instantly on the next chat.
  useEffect(() => {
    return () => {
      stopRecordingTimer();
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") {
        mr.ondataavailable = null;
        mr.onstop = null;
        try { mr.stop(); } catch {}
      }
      // micStreamRef is a local alias — do NOT stop its tracks.
      // The module-level stream in mic-permission.ts stays alive.
      micStreamRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendVoiceNote = useMutation({
    mutationFn: async ({ blob, mimeType }: { blob: Blob; mimeType: string }) => {
      // Client-side guard: reject before encoding to avoid unnecessary work.
      if (blob.size > 3_000_000) throw new Error("Recording too large (max ~60 seconds). Please try again.");
      // FileReader is the safest cross-browser way to convert a Blob to base64 —
      // avoids the O(n) string-concatenation loop that freezes on low-end devices.
      const audioBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Failed to encode audio"));
        reader.readAsDataURL(blob);
      });
      const res = await apiRequest("POST", `/api/voice-notes/send/${matchId}`, { audioBase64, mimeType });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "Failed to send"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId, "messages"] });
      forceScrollRef.current = true;
      setVoicePhase("idle");
    },
    onError: (err: any) => {
      toast({
        title: "Voice note couldn't be sent",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
      setVoicePhase("idle");
    },
  });

  // ── Fast messages query (no profile) ───────────────────────────────────────
  // Hits GET /api/matches/:matchId/messages — only fetches messages rows.
  // Renders the chat list immediately without waiting for profile/stage/calls.
  const { data: msgsData, isLoading: isMsgsLoading } = useQuery<{ messages: Message[]; hasMore: boolean }>({
    queryKey: ["/api/matches", matchId, "messages"],
    enabled: !!matchId,
  });

  // ── Slow detail query (profile + stage + call-status) ───────────────────────
  // Fires in parallel with the messages query. Used only for header, stage
  // prompts, and call status. Messages field in this response is intentionally
  // ignored — the dedicated messages cache above is the source of truth.
  const { data: matchDetail, isLoading: isDetailLoading } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", matchId],
    enabled: !!matchId,
  });

  const { broadcastNewMessage } = useRealtimeMessages(matchId, !!matchId, onVoiceNoteUnlock, onFirstCallUnlock);

  const sendMessage = useMutation({
    mutationFn: async (vars: { content: string; tempId: string }) => {
      if (!matchId) throw new Error("No match");
      const res = await apiRequest("POST", `/api/matches/${matchId}/messages`, { content: vars.content });
      return res.json();
    },
    onMutate: async (vars: { content: string; tempId: string }) => {
      const msgsKey = ["/api/matches", matchId, "messages"];
      // Snapshot messages cache for rollback
      const previousMsgs = queryClient.getQueryData<{ messages: Message[]; hasMore: boolean }>(msgsKey);

      queryClient.cancelQueries({ queryKey: msgsKey });

      const optimisticMsg: Message = {
        id: vars.tempId,
        matchId: matchId!,
        senderId: user?.id || "",
        content: vars.content,
        reaction: null,
        createdAt: new Date(),
        voiceTranscript: null,
      };

      // Optimistic append to messages cache
      if (previousMsgs) {
        queryClient.setQueryData<{ messages: Message[]; hasMore: boolean }>(msgsKey, {
          ...previousMsgs,
          messages: [...previousMsgs.messages, optimisticMsg],
        });
        console.log("[CHAT_REALTIME] message sent optimistic", {
          matchId: matchId?.slice(0, 8), tempId: vars.tempId.slice(0, 12),
        });
      }

      // Optimistically update last-message preview in the matches list
      queryClient.setQueryData<any[]>(["/api/matches"], (list) => {
        if (!list) return list;
        return list.map((m: any) =>
          m.id === matchId
            ? { ...m, lastMessage: { content: vars.content, senderId: user?.id || "", createdAt: new Date() } }
            : m
        );
      });
      return { previousMsgs };
    },
    onSuccess: (data: any) => {
      const realMsg = data as Message;
      const msgsKey = ["/api/matches", matchId, "messages"];

      // ── Apply server-authoritative progression counts ─────────────────────────
      // The server response includes a `progression` block with the post-increment
      // counts for both users (computed atomically). Use these to snap the match
      // detail cache so dbStageCount reflects the real value immediately, then
      // reset the optimistic localSentCount to 0. This replaces the previous
      // approach of blindly incrementing a local counter, which could drift from
      // the server when concurrent sends or a prior race had lost an increment.
      const prog = (data as any).progression as {
        user1Count: number; user2Count: number;
        myCount: number; theirCount: number;
        voiceNotesEligible: boolean; firstCallEligible: boolean;
        callStage: number; currentUserPendingMilestone: string | null;
      } | null | undefined;
      if (prog) {
        queryClient.setQueryData(["/api/matches", matchId], (old: any) =>
          old ? { ...old, messageCount1: prog.user1Count, messageCount2: prog.user2Count } : old
        );
        setLocalSentCount(0);
      } else {
        // Stage 1 / system messages — no progression block; keep the optimistic increment.
        setLocalSentCount(c => c + 1);
      }

      queryClient.setQueryData<{ messages: Message[]; hasMore: boolean }>(msgsKey, (old) => {
        if (!old) return old;
        const tempIdx = old.messages.findIndex(
          m => typeof m.id === "string" && m.id.startsWith("temp-") &&
               m.content === realMsg.content && m.senderId === realMsg.senderId
        );
        if (tempIdx >= 0) {
          const updated = [...old.messages];
          updated[tempIdx] = realMsg;
          return { ...old, messages: updated };
        }
        if (old.messages.some(m => m.id === realMsg.id)) return old;
        return { ...old, messages: [...old.messages, realMsg] };
      });

      // Broadcast to receiver instantly (~50ms) via the realtime broadcast channel.
      // handleNewMessage on the receiver's side deduplicates via message ID.
      broadcastNewMessage(realMsg);

      // ── Milestone progression events (server-authoritative) ───────────────
      // The server response includes a progressionEvent when this message crossed
      // the 8-message VN threshold or the 15-message first-call threshold.
      // This fires the celebration immediately — no 60s polling cycle needed.
      const event = (data as any).progressionEvent as { type: string } | null | undefined;
      const prog2 = (data as any).progression;
      console.log("[PROGRESSION] SEND_SUCCESS", {
        matchId: matchId?.slice(0, 8),
        eventType: event?.type ?? null,
        myCount: prog2?.myCount ?? null,
        theirCount: prog2?.theirCount ?? null,
      });
      if (event?.type === "first_call_unlocked") {
        // Update entitlement cache to reflect both milestones.
        queryClient.setQueryData(
          ["/api/voice-notes/entitlement", matchId],
          (old: any) => old
            ? { ...old, unlocked: true, firstCallUnlocked: true }
            : { unlocked: true, popupSeen: true, firstCallUnlocked: true, firstCallPromptSeen: false },
        );
        // Always route through pendingFirstCallCelebration so the 1.5s delay and
        // VN-open guard apply uniformly for the sender (same as the other user).
        console.log("[PROGRESSION] QUEUING first-call popup (sender path via pendingFirstCallCelebration)");
        setPendingFirstCallCelebration(true);
      }
    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previousMsgs) {
        queryClient.setQueryData(["/api/matches", matchId, "messages"], context.previousMsgs);
      }
      toast({ title: t("could_not_send_title"), description: error.message, variant: "destructive" });
    },
  });

  // ── AI Conversation Starters ──────────────────────────────────────────────
  const aiStartersEnabled = localStorage.getItem("settings_conversation_starter_ai") !== "false";

  // Prefetch starters immediately when the chat opens (not gated on panel visibility)
  // so data is ready the moment the panel appears. Cached for 5 min per match.
  const { data: aiStartersData, isFetching: isStartersFetching } = useQuery<{ starters: string[] }>({
    queryKey: ["/api/matches", matchId, "ai-starters"],
    enabled: !!matchId && aiStartersEnabled,
    staleTime: 5 * 60 * 1000,
  });

  // Reset ALL per-conversation state when navigating to a different conversation.
  // Critical: olderMessages is component state and does NOT reset automatically
  // when matchId changes (the component stays mounted). If Chat A had older messages
  // loaded and the user navigates to new Chat B, olderMessages would still hold
  // Chat A's messages, making allMessages.length > 0 and preventing starters.
  useEffect(() => {
    setUserClosedStarters(false);
    setShowAIStarters(false);
    setOlderMessages([]);
    setHasMoreMessages(false);
    setLocalSentCount(0);
  }, [matchId]);

  // Reset the optimistic sent counter whenever the call stage advances so the
  // counter always starts from the fresh DB value (which resets to 0 after each call).
  const callStageForEffect = matchDetail?.callStage ?? 0;
  useEffect(() => {
    setLocalSentCount(0);
  }, [callStageForEffect]);

  // ── Comment Filter + send helper ──────────────────────────────────────────
  // Clears the persisted draft for this match (called after every successful send path)
  const clearDraft = () => {
    try { localStorage.removeItem(`chat_draft_${matchId}`); } catch { /* noop */ }
  };

  const doSend = (content: string) => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const commentFilterEnabled = localStorage.getItem("settings_comment_filter") !== "false";
    if (commentFilterEnabled) {
      const result = scanContent(content);
      if (result.blocked) {
        toast({
          title: "Message blocked",
          description: `Your message contains ${result.categories.join(", ")} which violates community guidelines.`,
          variant: "destructive",
        });
        return;
      }
      if (result.categories.length > 0) {
        setFilterConfirm({ content, tempId, categories: result.categories });
        return;
      }
    }
    setMessage("");
    clearDraft();
    forceScrollRef.current = true;
    sendMessage.mutate({ content, tempId });
  };

  const toggleReaction = useMutation({
    mutationFn: async ({ messageId, currentReaction }: { messageId: string; currentReaction: string | null }) => {
      const newReaction = currentReaction ? null : "❤️";
      console.log(newReaction ? "[CHAT] MESSAGE_REACTION_ADDED" : "[CHAT] MESSAGE_REACTION_REMOVED", { messageId, matchId });
      const res = await apiRequest("POST", `/api/messages/${messageId}/reaction`, { reaction: newReaction });
      return res.json();
    },
    onMutate: async ({ messageId, currentReaction }) => {
      const msgsKey = ["/api/matches", matchId, "messages"];
      await queryClient.cancelQueries({ queryKey: msgsKey });
      const prev = queryClient.getQueryData<{ messages: Message[]; hasMore: boolean }>(msgsKey);
      if (prev) {
        queryClient.setQueryData<{ messages: Message[]; hasMore: boolean }>(msgsKey, {
          ...prev,
          messages: prev.messages.map(m =>
            m.id === messageId ? { ...m, reaction: currentReaction ? null : "❤️" } : m
          ),
        });
      }
      return { prev };
    },
    onError: (_err: any, _vars: any, context: any) => {
      if (context?.prev) {
        queryClient.setQueryData(["/api/matches", matchId, "messages"], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId, "messages"] });
    },
  });

  const doubleTapRef = useRef<{ id: string; time: number } | null>(null);
  const handleMessageTap = useCallback((msg: any) => {
    if (msg.senderId === user?.id) return;
    const now = Date.now();
    const prev = doubleTapRef.current;
    if (prev && prev.id === msg.id && now - prev.time < 400) {
      doubleTapRef.current = null;
      const currentReaction = (msg.reaction && typeof msg.reaction === 'string' && msg.reaction.length > 0) ? msg.reaction : null;
      toggleReaction.mutate({ messageId: msg.id, currentReaction });
    } else {
      doubleTapRef.current = { id: msg.id, time: now };
    }
  }, [user?.id, toggleReaction]);

  useEffect(() => {
    if (!msgsData?.messages) return;
    const el = messagesContainerRef.current;
    if (!el) return;

    // column-reverse: scrollTop=0 = visual bottom (newest message).
    if (!initialScrollDoneRef.current) {
      el.scrollTop = 0;
      initialScrollDoneRef.current = true;
      console.log("[CHAT_REALTIME] scrolled to bottom (initial)", { matchId: matchId?.slice(0, 8), count: msgsData?.messages?.length });
    } else if (forceScrollRef.current) {
      el.scrollTop = 0;
      forceScrollRef.current = false;
      console.log("[CHAT_REALTIME] scrolled to bottom (force)", { matchId: matchId?.slice(0, 8), count: msgsData?.messages?.length });
    } else if (isAtBottomRef.current) {
      el.scrollTo({ top: 0, behavior: "smooth" });
      console.log("[CHAT_REALTIME] scrolled to bottom (follow)", { matchId: matchId?.slice(0, 8), count: msgsData?.messages?.length });
    }
    // If user is scrolled up reading history: do nothing
  }, [msgsData?.messages?.length]);

  // ── Timing + hasMoreMessages detection ─────────────────────────────────────
  useEffect(() => {
    console.log("[CHAT_LOAD] page_mount", { matchId, hasCachedEntry: !!cachedEntry, ms: 0 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Messages arrive first — detect hasMore and set the oldest cursor for pagination
  useEffect(() => {
    if (msgsData) {
      const ms = Date.now() - mountedAtRef.current;
      const msgCount = msgsData.messages?.length ?? 0;
      console.log("[CHAT_LOAD] msgs_loaded", { matchId, msgCount, hasMore: msgsData.hasMore, ms });
      setHasMoreMessages(msgsData.hasMore);
      if (msgCount > 0) oldestCursorRef.current = msgsData.messages[0].createdAt as unknown as string;
    }
  }, [msgsData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (matchDetail) {
      const ms = Date.now() - mountedAtRef.current;
      console.log("[CHAT_LOAD] detail_loaded", { matchId, callStage: matchDetail.callStage, ms });
    }
  }, [matchDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // With column-reverse layout, the browser's native overflow-anchor behaviour
  // automatically preserves scroll position when older messages are prepended
  // (they appear at the visual top = DOM end). No manual restoration needed.

  // ── Load older messages (cursor pagination) ─────────────────────────────────
  const loadOlderMessages = useCallback(async () => {
    if (!matchId || isLoadingOlder || !hasMoreMessages) return;
    const cursor = oldestCursorRef.current;
    if (!cursor) return;
    setIsLoadingOlder(true);
    console.log("[CHAT_LOAD] load_older_start", { matchId, cursor: cursor.slice(0, 20) });
    try {
      const res = await apiRequest("GET", `/api/matches/${matchId}/messages?limit=40&before=${encodeURIComponent(cursor)}`);
      const { messages: older, hasMore } = await res.json();
      setOlderMessages(prev => [...older, ...prev]);
      setHasMoreMessages(hasMore);
      if (older.length > 0) oldestCursorRef.current = (older[0].createdAt as string) ?? null;
      console.log("[CHAT_LOAD] load_older_done", { matchId, got: older.length, hasMore });
    } catch (err: any) {
      console.warn("[CHAT_LOAD] load_older_failed", { err: err?.message });
    } finally {
      setIsLoadingOlder(false);
    }
  }, [matchId, isLoadingOlder, hasMoreMessages]);

  // ── Resolve profile for immediate shell render ──────────────────────────────
  // Uses matches-list cache so the header shows name/avatar at 0ms.
  const shellProfile = matchDetail?.profile ?? (cachedEntry as any)?.profile ?? null;

  // If nothing at all (no cache + not yet loaded): show minimal skeleton.
  // This is rare — usually cache has data from the matches list.
  if (!shellProfile) {
    return (
      <div className="flex-1 flex flex-col" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="p-4 border-b flex items-center gap-3 bg-background flex-shrink-0 z-10">
          <button
            aria-label="Back to Connections"
            data-testid="button-back-to-matches"
            className="flex-shrink-0 flex items-center justify-center w-11 h-11 -ml-1.5 rounded-full hover:bg-accent transition-colors active:scale-90"
            onClick={() => navigate("/matches")}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Skeleton className="w-9 h-9 rounded-full" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex-1 p-4 space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-2/3 rounded-md" />)}
        </div>
      </div>
    );
  }

  // Loaded but match not found (user not a participant or match deleted)
  if (!isDetailLoading && !matchDetail) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">{t("connection_not_found")}</p>
      </div>
    );
  }

  // Combined messages: older pages (paginated) + current page from messages query.
  // Both are independent of profile/stage — chat renders without waiting for matchDetail.
  const allMessages = [...olderMessages, ...(msgsData?.messages ?? [])];
  const myMessages = allMessages.filter(m => m.senderId === user?.id);
  // callStage must be derived before messagesRemaining so the limit is stage-aware.
  const callStage = matchDetail?.callStage ?? 0;
  const allCallsDone = callStage >= 4;
  // Stage 0: 15 messages → first guided call. Stage 1 (post-call): 25 messages → date planning.
  const msgLimit = callStage >= 1 ? 25 : MAX_MESSAGES_PER_USER;

  // Use the per-stage DB counter (messageCount1/2) which resets to 0 after each call,
  // plus a local optimistic increment for immediate UI feedback when messages are sent.
  // This fixes the bug where myMessages.length counted ALL messages (including previous
  // call stages), making "25 left" display as e.g. "10 left" right after a call.
  const isUser1 = matchDetail?.user1Id === user?.id;
  const dbStageCount = matchDetail
    ? (isUser1 ? (matchDetail.messageCount1 ?? 0) : (matchDetail.messageCount2 ?? 0))
    : null;
  const myStageMessageCount = dbStageCount !== null ? dbStageCount + localSentCount : myMessages.length;
  const messagesRemaining = msgLimit - myStageMessageCount;
  const isLimitReached = messagesRemaining <= 0;

  // Guard the call CTA card when a call is live (ringing or active).
  // messaging.tsx reads matchDetail from ["/api/matches", matchId]; the ring
  // handler now also patches this detail cache so these flags are accurate
  // immediately on ring arrival — without waiting for the next poll refetch.
  const isCallRinging = !!(
    matchDetail?.callStartedAt &&
    !matchDetail?.callAnswered &&
    !matchDetail?.callCompleted &&
    matchDetail?.callSessionId
  );
  const isCallActiveInDetail = !!(
    matchDetail?.callStartedAt &&
    (matchDetail as any)?.callAnswered === true &&
    !matchDetail?.callCompleted &&
    matchDetail?.callSessionId
  );

  // ── Declined session tracking ──────────────────────────────────────────────
  // Detects when a live call session is cleared by the server without
  // callCompleted becoming true — meaning the call was declined or cancelled.
  //
  // TWO sources are checked so the card is suppressed whether or not the user
  // was on this page during the call:
  //
  //   A) lastSeenCallSessionIdRef (component-local) — set while the component
  //      is mounted and the call is ringing/active.  Works for the in-page
  //      case where the user stays on messaging.tsx throughout.
  //
  //   B) getEndedSessionForMatch (module-level Map in cancelled-calls.ts) —
  //      populated by use-call-signaling.ts when call:cancelled / call:declined /
  //      call:ended arrives, regardless of which page is mounted.  Works for the
  //      navigate-after-cancel case where lastSeenCallSessionIdRef is null because
  //      the component mounted fresh after the call already ended.
  useEffect(() => {
    const sessionId  = matchDetail?.callSessionId  ?? null;
    const started    = matchDetail?.callStartedAt  ?? null;
    const completed  = matchDetail?.callCompleted  ?? false;

    if (sessionId && started) {
      // Active or ringing — track the live session ID; clear any stale ended entry
      lastSeenCallSessionIdRef.current = sessionId;
      clearEndedSessionForMatch(matchId!);
      // A new call starting resets any prior declined-session suppression
      setDeclinedSessionIds(new Set());
      console.log("[CALL_DECLINE_FIX] callSessionId=", sessionId, "callStartedAt=", started, "callStage=", callStage);
    } else if (!sessionId && !started && !completed) {
      // Session cleared without completing — check both sources for a session ID
      const fromRef = lastSeenCallSessionIdRef.current;
      const fromMap = getEndedSessionForMatch(matchId!)?.sessionId ?? null;
      const prevId = fromRef ?? fromMap;
      if (prevId) {
        lastSeenCallSessionIdRef.current = null;
        setDeclinedSessionIds(existing => { const s = new Set(existing); s.add(prevId); return s; });
        console.log("[CALL_DECLINE_FIX] declined session id=", prevId, "source=", fromRef ? "ref" : "module-map");
      }
    }
  }, [matchDetail?.callSessionId, matchDetail?.callStartedAt, matchDetail?.callCompleted, matchId]);

  const isDeclinedSession = declinedSessionIds.size > 0;

  // Log when the CTA card boundary is evaluated — helps verify suppression on device
  useEffect(() => {
    if (!isLimitReached && callStage < 2) return;
    const blocked = isCallRinging || isCallActiveInDetail || isDeclinedSession;
    console.log("[CALL_DECLINE_FIX] card render blocked=", String(blocked),
      "callStartedAt=", matchDetail?.callStartedAt ?? null,
      "callSessionId=", matchDetail?.callSessionId ?? null,
      "callStage=", callStage);
  }, [isLimitReached, callStage, isCallRinging, isCallActiveInDetail, isDeclinedSession]);

  // ── Starters visibility (pure derivation — no effect needed) ──────────────
  // System messages (those whose content begins with "__") are call-state signals
  // inserted by the server (e.g. __SCHEDULE__, __PHONE__:, __VOICE__:).
  // They must NOT count when deciding whether a chat is "empty" for AI starters —
  // otherwise any match that went through call scheduling would never show starters
  // even though neither user has sent a real message.
  const nonSystemMessages = allMessages.filter(m => !m.content?.startsWith("__"));

  // Auto-shows when ALL conditions are true:
  //   • setting is enabled (localStorage)
  //   • user hasn't explicitly dismissed for this match
  //   • messages query has finished loading (prevents flash on chats with messages)
  //   • NO real (non-system) messages exist — system-only chats are treated as empty
  //   • still in the initial pre-call stage
  // Also shows when the user manually taps the sparkles toggle.
  const autoShowStarters =
    aiStartersEnabled &&
    !userClosedStarters &&
    !isMsgsLoading &&
    nonSystemMessages.length === 0 &&
    callStage === 0 &&
    !isLimitReached;
  const startersVisible = autoShowStarters || (showAIStarters && !userClosedStarters);

  // ── DIAGNOSTICS: trace starters chain on every render ─────────────────────
  if (import.meta.env.DEV || typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.log("[STARTERS] chain", {
      matchId: matchId?.slice(0, 8),
      aiStartersEnabled,
      userClosedStarters,
      isMsgsLoading,
      allMessagesLength: allMessages.length,
      nonSystemMessagesLength: nonSystemMessages.length,
      olderMessagesLength: olderMessages.length,
      msgsDataLength: msgsData?.messages?.length ?? "undefined",
      callStage,
      isLimitReached,
      autoShowStarters,
      showAIStarters,
      startersVisible,
    });
  }
  const displayStarters = aiStartersData?.starters?.length ? aiStartersData.starters : FALLBACK_STARTERS;

  const statusLabel = allCallsDone ? t("status_ready_to_meet")
    : callStage === 3 ? t("status_face_call_stage")
    : callStage === 2 ? t("status_20_msg_stage")
    : messagesRemaining > 0 ? t("n_msg_left").replace("{n}", String(messagesRemaining))
    : t("call_time_badge");

  const callPrompt = callStage === 0
    ? { icon: Phone, title: t("call_prompt_stage0_title"), desc: t("call_prompt_stage0_desc"), button: t("start_first_call") }
    : callStage === 1
    ? { icon: Calendar, title: t("date_plan_prompt_title"), desc: t("date_plan_prompt_desc"), button: "" }
    : callStage === 2
    ? { icon: Phone, title: t("call_prompt_stage2_title"), desc: t("call_prompt_stage2_desc"), button: t("view_on_connections_btn") }
    : callStage === 3
    ? { icon: Phone, title: t("call_prompt_stage2_title"), desc: t("call_prompt_stage2_desc"), button: t("view_on_connections_btn") }
    : { icon: Check, title: t("all_calls_completed"), desc: t("ready_to_meet_real"), button: "" };

  // shellProfile is always non-null here (guaranteed by the guard above)
  const profile = shellProfile;

  // Bottom edge of the fixed messages viewport (keyboard offset + measured composer)
  const composerBottom = keyboardHeight + composerHeight;

  return (
    <>
      {/* ═══ FIXED HEADER — always viewport-pinned, never clipped by keyboard ═══ */}
      <div
        ref={headerRef}
        className="bg-background border-b"
        style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="px-4 pt-3 pb-0">
        {/* ── Main header row ── */}
        <div className="flex items-center gap-3 pb-2">
          {/* Back button — always present, 44×44 touch target, explicit label */}
          <button
            aria-label="Back to Connections"
            data-testid="button-back-to-matches"
            className="flex-shrink-0 flex items-center justify-center w-11 h-11 -ml-1.5 rounded-full hover:bg-accent transition-colors active:scale-90"
            onClick={() => {
              // Preserve any unsent draft across navigation
              try {
                if (message.trim()) {
                  localStorage.setItem(`chat_draft_${matchId}`, message);
                } else {
                  localStorage.removeItem(`chat_draft_${matchId}`);
                }
              } catch { /* noop */ }
              navigate("/matches");
            }}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <Avatar className="w-9 h-9 flex-shrink-0">
            <AvatarImage src={profile.photos?.[0]} alt={profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
              {profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold text-sm leading-tight truncate" data-testid="text-chat-name">{profile.firstName}</h3>
              {profile.photoVerified && (
                <BadgeCheck className="w-4 h-4 text-primary shrink-0" data-testid="icon-chat-verified" />
              )}
            </div>
            {(() => {
              const myShowLastActive = localStorage.getItem("settings_show_last_active") !== "false";
              const lastActiveLbl = formatLastActive(profile.lastActive, (profile.showLastActive ?? true) && myShowLastActive);
              return lastActiveLbl ? (
                <p className="text-[10px] text-muted-foreground leading-none mt-0.5" data-testid="text-last-active">{lastActiveLbl}</p>
              ) : null;
            })()}
          </div>

          <Badge variant="outline" className="text-xs flex-shrink-0" data-testid="badge-messages-remaining">
            {statusLabel}
          </Badge>
          {!showCloseConfirm ? (
            <Button variant="ghost" size="icon" onClick={() => setShowCloseConfirm(true)} data-testid="button-close-connection">
              <Moon className="w-4 h-4 text-muted-foreground" />
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => closeConnection.mutate()}
                disabled={closeConnection.isPending}
                data-testid="button-confirm-close"
              >
                {closeConnection.isPending ? t("closing_conn") : t("close_conn_btn")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowCloseConfirm(false)} data-testid="button-cancel-close">
                {t("close_conn_keep")}
              </Button>
            </div>
          )}
        </div>

        {/* ── Action tray: phone / video / mic with credit counts ── */}
        {(!allCallsDone || voiceNotesUnlocked) && (
          <div className="flex items-center justify-center gap-6 pb-2.5 border-t border-border/30">
            {!allCallsDone && (
              <button
                onClick={() => {
                  if (phoneCredits > 0) {
                    startPaidCall.mutate({ isVideo: false });
                  } else {
                    setPurchasePromptFeature("phone");
                  }
                }}
                disabled={startPaidCall.isPending}
                className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90 disabled:opacity-50"
                data-testid="button-phone-tray"
              >
                <Phone
                  className="w-[18px] h-[18px] transition-all duration-300"
                  style={!callCreditsData
                    ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                    : phoneCredits > 0
                    ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                    : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
                />
                <span
                  className="text-[10px] font-semibold leading-none"
                  style={phoneCredits > 0 ? { color: "rgb(34,197,94)" } : { color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
                >
                  {!callCreditsData ? "·" : phoneCredits > 0 ? "Use 1" : "Unlock"}
                </span>
              </button>
            )}
            {!allCallsDone && (
              <button
                onClick={() => {
                  if (videoCredits > 0) {
                    startPaidCall.mutate({ isVideo: true });
                  } else {
                    setPurchasePromptFeature("video");
                  }
                }}
                disabled={startPaidCall.isPending}
                className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90 disabled:opacity-50"
                data-testid="button-video-tray"
              >
                <Video
                  className="w-[18px] h-[18px] transition-all duration-300"
                  style={!callCreditsData
                    ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                    : videoCredits > 0
                    ? { color: "rgb(99,102,241)", filter: "drop-shadow(0 0 5px rgba(99,102,241,0.7))" }
                    : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
                />
                <span
                  className="text-[10px] font-semibold leading-none"
                  style={videoCredits > 0 ? { color: "rgb(99,102,241)" } : { color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
                >
                  {!callCreditsData ? "·" : videoCredits > 0 ? "Use 1" : "Unlock"}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                if (!voiceNotesUnlocked) {
                  toast({ description: "Voice notes unlock after your first call." });
                  return;
                }
                if (voicePhase === "idle") startRecording();
                else if (voicePhase === "recording") stopRecording();
              }}
              className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90"
              data-testid="button-mic-tray"
            >
              <Mic
                className="w-[18px] h-[18px] transition-all duration-300"
                style={voiceNotesUnlocked
                  ? { color: voicePhase === "recording" ? "rgb(239,68,68)" : "rgb(34,197,94)", filter: voicePhase === "recording" ? "drop-shadow(0 0 5px rgba(239,68,68,0.7))" : "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                  : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
              />
              <span
                className="text-[10px] font-semibold leading-none"
                style={voiceNotesUnlocked ? { color: voicePhase === "recording" ? "rgb(239,68,68)" : "rgb(34,197,94)" } : { color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
              >
                {voiceNotesUnlocked ? (voicePhase === "recording" ? "Stop" : "Mic") : "Mic"}
              </span>
            </button>
          </div>
        )}

        {/* ── Chat / Profile tab bar ── */}
        <div className="flex" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "chat"}
            onClick={() => setActiveTab("chat")}
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "chat"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="tab-chat"
          >
            {t("tab_chat")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "profile"}
            onClick={() => setActiveTab("profile")}
            className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "profile"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="tab-profile"
          >
            {t("tab_profile_view")}
          </button>
        </div>
        </div>{/* end inner px-4 wrapper */}
        {showCloseConfirm && (
          <div className="px-4 py-2 bg-destructive/5 border-t">
            <p className="text-xs text-center text-muted-foreground">
              {t("close_connection_confirm").replace("{name}", profile.firstName)}
            </p>
          </div>
        )}
      </div>{/* end fixed header */}

      {/* ═══ FIXED MESSAGES AREA ═══ */}
      {activeTab === "chat" && (
        <div
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          data-testid="messages-container"
          style={{
            position: "fixed",
            top: headerHeight,
            left: 0,
            right: 0,
            bottom: composerBottom,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* column-reverse: first DOM child = visual bottom. Few messages naturally
              sit near the composer — no spacer or justify-end needed.              */}
          <div style={{ display: "flex", flexDirection: "column-reverse", gap: "12px", padding: "16px" }}>
          {/* Anchor — DOM-first = visual bottom in column-reverse */}
          <div ref={messagesEndRef} style={{ height: 1, flexShrink: 0 }} />
          {/* Single pass — call-event banners AND chat bubbles, newest first in DOM */}
          {[...allMessages].reverse().map(msg => {
            if (!msg.content) return null;

            // ── Call event banners ──────────────────────────────────────────
            if (msg.content.startsWith("__CALL_EVENT__:")) {
              const isMe = msg.senderId === user?.id;
              let callText = "";
              try {
                const ev = JSON.parse(msg.content.slice("__CALL_EVENT__:".length));
                if (ev.type === "cancelled" || ev.type === "missed") {
                  callText = isMe
                    ? `📞 You called ${matchDetail?.profile?.firstName || "them"}`
                    : `📞 Missed call from ${ev.callerName || matchDetail?.profile?.firstName || ""}`;
                }
                if (ev.type === "declined") {
                  callText = isMe
                    ? `📞 ${ev.calleeName || matchDetail?.profile?.firstName || "They"} declined your call`
                    : `📞 You declined ${ev.callerName || matchDetail?.profile?.firstName || "their"} call`;
                }
                if (ev.type === "ended") callText = "📞 Call ended";
              } catch {}
              if (!callText) return null;
              return (
                <div key={msg.id} className="flex justify-center py-2">
                  <span className="text-xs text-muted-foreground bg-muted/60 rounded-full px-3 py-1.5" data-testid={`call-event-${msg.id}`}>{callText}</span>
                </div>
              );
            }

            // ── Internal protocol — never shown as chat bubbles ─────────────
            if (
              msg.content.startsWith("__SCHEDULE__:") ||
              msg.content.startsWith("__SYS__:") ||
              msg.content.startsWith("__SYSTEM__:")
            ) return null;

            // ── Regular chat bubble ──────────────────────────────────────────
            const isMe = msg.senderId === user?.id;
            const hasReaction = msg.reaction && typeof msg.reaction === "string" && msg.reaction.length > 0;
            const isVoiceNote = msg.content.startsWith("__VOICE__:");
            if (hasReaction) {
              console.log("[CHAT] MESSAGE_REACTION_RENDERED", { messageId: msg.id, reaction: msg.reaction });
            }
            return (
              <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"} ${hasReaction ? "mb-2" : ""}`}>
                <div className="relative">
                  <div
                    className={`w-fit max-w-[75vw] rounded-2xl text-sm select-none ${
                      isVoiceNote
                        ? ""
                        : isMe
                        ? "bg-primary text-primary-foreground px-3 py-2"
                        : "bg-card border cursor-pointer px-3 py-2"
                    } ${!isMe && !isVoiceNote ? "active:scale-[0.98] transition-transform" : ""}`}
                    onClick={isVoiceNote ? undefined : () => handleMessageTap(msg)}
                    data-testid={`message-${msg.id}`}
                  >
                    {isVoiceNote ? (
                      <VoiceNotePlayer
                        url={msg.content.slice("__VOICE__:".length)}
                        isMe={isMe}
                        transcript={(msg as any).voiceTranscript ?? null}
                      />
                    ) : (
                      <>
                        <p className="leading-relaxed">{msg.content.startsWith("__PHONE__:") ? msg.content.slice("__PHONE__:".length) : msg.content.startsWith("__") ? "" : msg.content}</p>
                        <p className={`text-[10px] mt-1.5 leading-none opacity-60 ${isMe ? "text-primary-foreground" : "text-muted-foreground"}`}>
                          {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
                        </p>
                      </>
                    )}
                  </div>
                  {hasReaction && (
                    <span
                      className={`absolute -bottom-2.5 ${isMe === isRTL ? "right-1" : "left-1"} text-sm drop-shadow-sm`}
                      data-testid={`reaction-${msg.id}`}
                    >
                      ❤️
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Empty state — DOM-last = visual top in column-reverse */}
          {allMessages.length === 0 && !isDetailLoading && (
            <div className="text-center py-12 space-y-2">
              <p className="text-muted-foreground text-sm">{t("convo_beginning")}</p>
              <p className="text-xs text-muted-foreground">{t("initial_messages_info").replace("{n}", String(MAX_MESSAGES_PER_USER))}</p>
            </div>
          )}
          {/* Skeleton during first fetch — visual top */}
          {isMsgsLoading && allMessages.length === 0 && (
            <div className="space-y-3 pt-2">
              {[1, 2, 3].map(i => (
                <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
                  <Skeleton className={`h-10 rounded-md ${i % 2 === 0 ? "w-1/2" : "w-2/3"}`} />
                </div>
              ))}
            </div>
          )}
          {/* Load older button — DOM-last = visual top in column-reverse */}
          {hasMoreMessages && (
            <div className="flex justify-center pt-1 pb-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={loadOlderMessages}
                disabled={isLoadingOlder}
                data-testid="button-load-older-messages"
                className="text-xs text-muted-foreground gap-1"
              >
                {isLoadingOlder ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {isLoadingOlder ? t("loading_ellipsis") : t("load_older_msgs")}
              </Button>
            </div>
          )}
          </div>
        </div>
      )}

      {/* ═══ FIXED COMPOSER ═══ */}
      {activeTab === "chat" && (
        <div
          ref={composerRef}
          className="bg-background border-t"
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: keyboardHeight,
            zIndex: 40,
            paddingBottom: keyboardHeight > 0 ? 0 : "env(safe-area-inset-bottom, 0px)",
          }}
        >
          {(isLimitReached || callStage >= 2) && !allCallsDone && !isCallRinging && !isCallActiveInDetail && !isDeclinedSession && !voiceNotePopupOpen && !firstCallPopupOpen ? (
            <div className="p-4">
              <Card className="p-5 text-center space-y-3 bg-primary/5 border-primary/20">
                <callPrompt.icon className="w-6 h-6 text-primary mx-auto" />
                <p className="font-medium text-sm">{callPrompt.title}</p>
                <p className="text-xs text-muted-foreground">{callPrompt.desc}</p>
                {callPrompt.button ? (
                  <Button size="sm" onClick={() => navigate("/matches")} data-testid="button-call-prompt">
                    <Phone className="w-4 h-4 me-2" /> {callPrompt.button}
                  </Button>
                ) : null}
              </Card>
            </div>
          ) : allCallsDone && matchDetail ? (
            <ReadyToMeetSection matchDetail={matchDetail} matchId={matchId!} />
          ) : (
            <div style={{ padding: "1rem" }}>
              {/* ── AI Starters panel — hidden while recording ── */}
              {!isRecording && startersVisible && (
                <div className="mb-3 rounded-2xl border border-primary/15 bg-primary/[0.04] p-3 space-y-2.5" data-testid="ai-starters-panel">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-1.5">
                      <Sparkles className="w-3 h-3 text-primary" /> Conversation starters
                    </p>
                    <div className="flex items-center gap-2">
                      {!isStartersFetching && (
                        <button
                          className="text-[10px] text-primary/70 hover:text-primary flex items-center gap-0.5 transition-colors"
                          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId, "ai-starters"] })}
                          data-testid="button-regenerate-starters"
                        >
                          <RefreshCw className="w-2.5 h-2.5" />&nbsp;Regenerate
                        </button>
                      )}
                      <button
                        className="text-muted-foreground/60 hover:text-muted-foreground p-0.5"
                        onClick={() => { setUserClosedStarters(true); setShowAIStarters(false); }}
                        data-testid="button-close-starters"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {isStartersFetching ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] text-muted-foreground">Generating starters…</p>
                      <div className="flex gap-1.5 flex-wrap">
                        {[1, 2, 3].map(i => (
                          <div key={i} className="h-7 w-28 rounded-full bg-muted animate-pulse" />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1.5 flex-wrap">
                      {displayStarters.map((s, i) => (
                        <button
                          key={i}
                          className="text-xs px-3 py-1.5 rounded-full border border-primary/30 bg-background text-primary hover:bg-primary/10 active:scale-95 transition-all text-left leading-snug"
                          onClick={() => { setMessage(s); setShowAIStarters(false); }}
                          data-testid={`button-starter-${i}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── First-time mic permission hint ── */}
              {voiceNotesUnlocked && micPermState === "unknown" && !wasMicGrantedBefore() && (
                <p className="text-[11px] text-muted-foreground/60 text-center mb-1 px-2 select-none" data-testid="text-mic-hint">
                  Allow microphone once to send voice notes.
                </p>
              )}
              {/* ── Microphone access denied card ── */}
              {(micPermState === "denied" || micPermState === "unavailable") && voiceNotesUnlocked && (
                <div className="mb-2 rounded-xl border border-rose-200/60 bg-rose-50/50 dark:bg-rose-950/20 dark:border-rose-800/40 px-3 py-2.5" data-testid="card-mic-denied">
                  <p className="text-xs font-medium text-rose-700 dark:text-rose-300 mb-0.5">
                    {micPermState === "unavailable" ? "No microphone found" : "Microphone access blocked"}
                  </p>
                  <p className="text-[11px] text-rose-600/80 dark:text-rose-400/80 leading-relaxed">
                    {micPermState === "unavailable"
                      ? "This device doesn't have a microphone available."
                      : "To send voice notes, go to iPhone Settings → Safari → Microphone and tap Allow."}
                  </p>
                </div>
              )}
              <div className="flex gap-2 items-end">
                {/* ── Input column: textarea + char counter directly beneath ── */}
                <div className="flex-1 flex flex-col">
                <div className="relative">
                  {voicePhase === "recording" ? (
                    <div className="flex items-center gap-2 min-h-[44px] px-3 pr-10 rounded-md border border-red-300/50 bg-red-50/40 dark:bg-red-950/20 select-none">
                      <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                      <span className="text-sm text-muted-foreground flex-1 font-mono tabular-nums">
                        {`${Math.floor(recordingTime / 60)}:${String(recordingTime % 60).padStart(2, "0")}`}
                      </span>
                    </div>
                  ) : (
                    <Textarea
                      value={message}
                      onChange={e => setMessage(e.target.value.slice(0, MAX_CHARS))}
                      placeholder={t("write_meaningful_placeholder")}
                      className="resize-none min-h-[44px] max-h-[120px] text-base pr-8 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border-primary/60 focus:outline-none outline-none"
                      onFocus={() => {
                        setInputFocused(true);
                        // Scroll to newest after iOS keyboard animation (~300ms)
                        setTimeout(() => {
                          if (isAtBottomRef.current || forceScrollRef.current) {
                            messagesContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
                          }
                        }, 350);
                      }}
                      onBlur={() => setInputFocused(false)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (message.trim()) doSend(message.trim());
                        }
                      }}
                      data-testid="input-message"
                    />
                  )}
                  {/* Mic inside the input — hold to record, slide away to cancel */}
                  <button
                    onPointerDown={e => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      if (!voiceNotesUnlocked) {
                        toast({ description: "Voice notes unlock after your first call." });
                        return;
                      }
                      if (voicePhase === "idle") startRecording();
                    }}
                    onPointerUp={() => {
                      if (voicePhase === "recording") stopRecording();
                    }}
                    onPointerLeave={() => { if (voicePhase === "recording") cancelRecording(); }}
                    onPointerCancel={() => { if (voicePhase === "recording") cancelRecording(); }}
                    onContextMenu={e => e.preventDefault()}
                    className="absolute right-2 bottom-[10px] flex items-center justify-center select-none transition-transform active:scale-90"
                    data-testid="button-mic-input"
                    title={voiceNotesUnlocked ? (voicePhase === "recording" ? "Release to send" : "Hold to record voice note") : "Unlock voice notes"}
                  >
                    <Mic
                      className="w-[18px] h-[18px] transition-all duration-300"
                      style={voicePhase === "recording"
                        ? { color: "rgb(239,68,68)", filter: "drop-shadow(0 0 5px rgba(239,68,68,0.7))" }
                        : voiceNotesUnlocked
                        ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
                    />
                  </button>
                </div>{/* end relative mic wrapper */}
                {/* Char counter sits below the input, not beneath the send button */}
                {voicePhase === "idle" && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 text-right pr-9 select-none">
                    {message.length}/{MAX_CHARS}
                  </p>
                )}
                </div>{/* end flex-col input column */}

                {/* ✨ Conversation starters — hidden while typing */}
                {aiStartersEnabled && voicePhase === "idle" && !inputFocused && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => { setUserClosedStarters(false); setShowAIStarters(v => !v); }}
                    className={startersVisible ? "text-primary" : "text-muted-foreground"}
                    title="Conversation starters"
                    data-testid="button-ai-starters"
                  >
                    <Sparkles className="w-4 h-4" />
                  </Button>
                )}

                {/* 📞 Voice call shortcut */}
                {!allCallsDone && voicePhase === "idle" && !inputFocused && (
                  <button
                    onClick={() => {
                      if (phoneCredits > 0) startPaidCall.mutate({ isVideo: false });
                      else setPurchasePromptFeature("phone");
                    }}
                    disabled={startPaidCall.isPending}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90 disabled:opacity-50 hover:bg-muted/40"
                    data-testid="button-phone-composer"
                    title={phoneCredits > 0 ? t("start_voice_call") : t("unlock_voice_calling")}
                  >
                    <Phone
                      className="w-[18px] h-[18px] transition-all duration-300"
                      style={!callCreditsData
                        ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                        : phoneCredits > 0
                        ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.5 }}
                    />
                  </button>
                )}

                {/* 🎥 Video call shortcut */}
                {!allCallsDone && voicePhase === "idle" && !inputFocused && (
                  <button
                    onClick={() => {
                      if (videoCredits > 0) startPaidCall.mutate({ isVideo: true });
                      else setPurchasePromptFeature("video");
                    }}
                    disabled={startPaidCall.isPending}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90 disabled:opacity-50 hover:bg-muted/40"
                    data-testid="button-video-composer"
                    title={t("start_video_call")}
                  >
                    <Video
                      className="w-[18px] h-[18px] transition-all duration-300"
                      style={!callCreditsData
                        ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                        : videoCredits > 0
                        ? { color: "rgb(99,102,241)", filter: "drop-shadow(0 0 5px rgba(99,102,241,0.7))" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.5 }}
                    />
                  </button>
                )}

                {/* ➤ Send / recording controls */}
                {sendVoiceNote.isPending ? (
                  <Button size="icon" disabled data-testid="button-send-voice-note">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </Button>
                ) : voicePhase === "recording" ? (
                  <Button size="icon" variant="ghost" onClick={cancelRecording} data-testid="button-cancel-recording">
                    <X className="w-4 h-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onClick={() => { if (message.trim()) doSend(message.trim()); }}
                    disabled={!message.trim()}
                    data-testid="button-send"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                )}
              </div>

              {/* ── Comment filter confirmation ── */}
              {filterConfirm && (
                <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2" data-testid="filter-confirm">
                  <p className="text-xs text-amber-800 dark:text-amber-300 font-medium">
                    Your message may contain <strong>{filterConfirm.categories.join(", ")}</strong>. Send anyway?
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm" variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setFilterConfirm(null)}
                      data-testid="button-filter-cancel"
                    >
                      Edit message
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        const { content, tempId } = filterConfirm;
                        setFilterConfirm(null);
                        setMessage("");
                        clearDraft();
                        forceScrollRef.current = true;
                        sendMessage.mutate({ content, tempId });
                      }}
                      data-testid="button-filter-confirm"
                    >
                      Send anyway
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ FIXED PROFILE TAB ═══ */}
      {activeTab === "profile" && (
        <div
          data-testid="profile-tab-content"
          style={{
            position: "fixed",
            top: headerHeight,
            left: 0,
            right: 0,
            bottom: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {profile.photos?.length > 0 && (
            <PhotoCarousel
              photos={profile.photos}
              height={400}
              showDots={profile.photos.length > 1}
            />
          )}

          <div className="px-4 pt-4 pb-8 space-y-5">
            <div>
              <h3 className="text-xl font-semibold">{profile.firstName}, {profile.age}</h3>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                {profile.location && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0" />{profile.location}
                  </p>
                )}
                {profile.height && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Ruler className="w-3.5 h-3.5 flex-shrink-0" />{profile.height}
                  </p>
                )}
              </div>
            </div>

            {profile.datingIntent && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("here_for_label")}</p>
                <Badge variant="secondary" className="text-sm">{profile.datingIntent}</Badge>
              </div>
            )}

            {profile.signals?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("vibe_label")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {profile.signals.map((s: string, i: number) => (
                    <Badge key={i} variant="outline" className="text-xs">{s}</Badge>
                  ))}
                </div>
              </div>
            )}

            {profile.greenFlags?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("green_flags_label")}</p>
                <div className="flex flex-col gap-1">
                  {profile.greenFlags.map((f: string, i: number) => (
                    <p key={i} className="text-sm flex items-start gap-1.5">
                      <span className="text-emerald-500 mt-0.5">✓</span>{f}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {profile.connectionStyle && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{t("section_connection_style")}</p>
                <p className="text-sm">{profile.connectionStyle}</p>
              </div>
            )}

            {profile.conversationStarters && profile.conversationStarters.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("ask_me_about_label")}</p>
                <div className="space-y-1.5">
                  {profile.conversationStarters.map((cs: string, i: number) => (
                    <p key={i} className="text-sm text-muted-foreground italic">"{cs}"</p>
                  ))}
                </div>
              </div>
            )}

            <Button
              variant="outline"
              className="w-full"
              onClick={() => setActiveTab("chat")}
              data-testid="button-return-to-chat"
            >
              <MessageCircle className="w-4 h-4 me-2" /> {t("back_to_chat_btn")}
            </Button>
          </div>
        </div>
      )}
      <PurchasePrompt
        feature={purchasePromptFeature}
        onClose={() => setPurchasePromptFeature(null)}
        returnPath={window.location.pathname}
      />

      {/* ── Voice-note post-call celebration ── */}
      {voiceNotePopupOpen && (
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 backdrop-blur-sm px-4 pb-8" data-testid="dialog-voice-note-unlock">
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl" style={{ background: "linear-gradient(145deg,#fdf6f0 0%,#fff8f5 55%,#fdf0f3 100%)" }}>
            {/* Sparkle particles — hidden when prefers-reduced-motion */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
              <span className="absolute top-5 right-9 w-1.5 h-1.5 rounded-full bg-rose-300/70 motion-safe:animate-ping" style={{ animationDuration: "2s" }} />
              <span className="absolute top-14 right-5 w-1 h-1 rounded-full bg-amber-300/60 motion-safe:animate-ping" style={{ animationDuration: "2.4s", animationDelay: "0.5s" }} />
              <span className="absolute top-7 left-7 w-1 h-1 rounded-full bg-rose-200/80 motion-safe:animate-ping" style={{ animationDuration: "1.8s", animationDelay: "0.9s" }} />
              <span className="absolute bottom-20 right-7 w-1.5 h-1.5 rounded-full bg-amber-200/60 motion-safe:animate-ping" style={{ animationDuration: "2.2s", animationDelay: "0.3s" }} />
              <span className="absolute bottom-10 left-9 w-1 h-1 rounded-full bg-rose-300/50 motion-safe:animate-ping" style={{ animationDuration: "2.6s", animationDelay: "1.1s" }} />
            </div>
            <div className="relative px-8 pt-10 pb-8 text-center">
              {/* Glow icon */}
              <div className="mx-auto mb-5 w-20 h-20 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#fce7ef,#fdf2e9)", boxShadow: "0 0 28px rgba(244,114,141,0.35),0 0 56px rgba(244,114,141,0.18)" }}>
                <span className="text-4xl" role="img" aria-label="microphone">🎙️</span>
              </div>
              <h2 className="font-serif text-2xl font-bold tracking-tight text-stone-800 mb-2">Congratulations — you've unlocked Voice Notes</h2>
              <p className="text-stone-600 text-sm leading-relaxed mb-7">
                You made it through your first call. Now you can keep the connection going whenever you want to hear each other.
              </p>
              <button
                className="w-full py-3.5 rounded-2xl text-sm font-semibold text-white transition-all active:scale-95"
                style={{ background: "linear-gradient(135deg,#e8526a,#d4445c)" }}
                onClick={() => {
                  localStorage.setItem(`vn_popup_${matchId}`, "1");
                  setVoiceNotePopupOpen(false);
                  queryClient.setQueryData(
                    ["/api/voice-notes/entitlement", matchId],
                    (old: any) => old ? { ...old, popupSeen: true } : old,
                  );
                  apiRequest("POST", `/api/voice-notes/popup-seen/${matchId}`).catch(() => {});
                }}
                data-testid="button-voice-note-popup-continue"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── First-call milestone celebration ── */}
      {firstCallPopupOpen && (
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 backdrop-blur-sm px-4 pb-8" data-testid="dialog-first-call-unlock">
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl" style={{ background: "linear-gradient(145deg,#fdf9f0 0%,#fffcf5 55%,#fdf6e8 100%)" }}>
            {/* Sparkle particles */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
              <span className="absolute top-5 right-9 w-1.5 h-1.5 rounded-full bg-amber-300/70 motion-safe:animate-ping" style={{ animationDuration: "2s" }} />
              <span className="absolute top-14 right-5 w-1 h-1 rounded-full bg-rose-300/50 motion-safe:animate-ping" style={{ animationDuration: "2.4s", animationDelay: "0.5s" }} />
              <span className="absolute top-7 left-7 w-1 h-1 rounded-full bg-amber-200/80 motion-safe:animate-ping" style={{ animationDuration: "1.8s", animationDelay: "0.9s" }} />
              <span className="absolute bottom-20 right-7 w-1.5 h-1.5 rounded-full bg-rose-200/60 motion-safe:animate-ping" style={{ animationDuration: "2.2s", animationDelay: "0.3s" }} />
              <span className="absolute bottom-10 left-9 w-1 h-1 rounded-full bg-amber-300/50 motion-safe:animate-ping" style={{ animationDuration: "2.6s", animationDelay: "1.1s" }} />
            </div>
            <div className="relative px-8 pt-10 pb-8 text-center">
              {/* Glow icon */}
              <div className="mx-auto mb-5 w-20 h-20 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg,#fef3c7,#fde8c9)", boxShadow: "0 0 28px rgba(245,158,11,0.35),0 0 56px rgba(245,158,11,0.18)" }}>
                <span className="text-4xl" role="img" aria-label="telephone">📞</span>
              </div>
              <h2 className="font-serif text-2xl font-bold tracking-tight text-stone-800 mb-2">Your first call is ready</h2>
              <p className="text-stone-600 text-sm leading-relaxed mb-1.5">
                You've built enough connection to take the next step.
              </p>
              <p className="text-stone-400 text-xs leading-relaxed mb-7">
                Start a private 10-minute audio call when you're both ready.
              </p>
              <button
                className="w-full py-3.5 rounded-2xl text-sm font-semibold text-white transition-all active:scale-95"
                style={{ background: "linear-gradient(135deg,#d97706,#b45309)" }}
                onClick={() => {
                  localStorage.setItem(`fc_popup_${matchId}`, "1");
                  setFirstCallPopupOpen(false);
                  queryClient.setQueryData(
                    ["/api/voice-notes/entitlement", matchId],
                    (old: any) => old ? { ...old, firstCallPromptSeen: true } : old,
                  );
                  apiRequest("POST", `/api/first-call/prompt-seen/${matchId}`).catch(() => {});
                }}
                data-testid="button-first-call-popup-continue"
              >
                Unlock call
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Build-identity + layout debug strip ──────────────────────────────
           Gate: localStorage.setItem('lulou_layout_debug','1'); location.reload()
           Shows build commit, bundle file, SW version, cache names, layout metrics.
      ── */}
      {isLayoutDebug && (() => {
        const bundleEl = typeof document !== "undefined"
          ? (document.querySelector('script[src*="/assets/index-"]') as HTMLScriptElement | null)
          : null;
        const bundleFile = bundleEl?.src?.split("/assets/")[1] ?? "(unknown)";
        const swControlled = typeof navigator !== "undefined" ? String(!!navigator.serviceWorker?.controller) : "?";
        return (
          <>
            {/* Info overlay — non-interactive */}
            <div
              style={{
                position: "fixed",
                top: headerHeight + 4,
                right: 8,
                zIndex: 9999,
                background: "rgba(0,0,0,0.88)",
                color: "#3f3",
                fontFamily: "monospace",
                fontSize: 10,
                padding: "5px 8px",
                borderRadius: 6,
                lineHeight: 2,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                maxWidth: "calc(100vw - 16px)",
              }}
            >
              {/* Build identity */}
              <span style={{ color: "#ff0" }}>BUILD</span><br />
              appCommit={__COMMIT_HASH__}<br />
              bundle={bundleFile}<br />
              layoutMode=fixed-layers<br />
              {/* SW identity */}
              <span style={{ color: "#ff0" }}>SW</span><br />
              swVersion={swVersion}<br />
              swControlled={swControlled}<br />
              caches={cacheNames.length === 0 ? "(none)" : cacheNames.join(", ")}<br />
              {/* Layout metrics */}
              <span style={{ color: "#ff0" }}>LAYOUT</span><br />
              vvH:{Math.round(vvHeight)} vvOT:{Math.round(vvOffsetTop)}<br />
              kbInset:{Math.round(keyboardHeight)}<br />
              hdrH:{Math.round(headerHeight)} compH:{Math.round(composerHeight)}<br />
              msgVP:{Math.round(Math.max(0, (vvHeight || window.innerHeight) - headerHeight - composerBottom))}
            </div>

            {/* Refresh App button — interactive */}
            <div
              style={{
                position: "fixed",
                bottom: composerBottom + 8,
                right: 8,
                zIndex: 9999,
              }}
            >
              <button
                onClick={async () => {
                  try {
                    // 1. Unregister all service workers
                    if ("serviceWorker" in navigator) {
                      const regs = await navigator.serviceWorker.getRegistrations();
                      await Promise.all(regs.map((r) => r.unregister()));
                    }
                    // 2. Delete all caches
                    if ("caches" in window) {
                      const keys = await caches.keys();
                      await Promise.all(keys.map((k) => caches.delete(k)));
                    }
                    // 3. Clear the reload-loop guard so the page can reload freely
                    sessionStorage.removeItem("sw_reload_done");
                    // 4. Hard reload (bypasses browser HTTP cache)
                    window.location.reload();
                  } catch {
                    window.location.reload();
                  }
                }}
                style={{
                  background: "#f00",
                  color: "#fff",
                  fontFamily: "monospace",
                  fontSize: 11,
                  fontWeight: "bold",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
                }}
              >
                ⟳ Refresh app
              </button>
            </div>
          </>
        );
      })()}
    </>
  );
}
