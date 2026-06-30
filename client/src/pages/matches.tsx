import { useState, useRef, useEffect, useCallback, useMemo, memo, Fragment, type ReactNode } from "react";
import { LulouGuide } from "@/components/lulou-guide";
import { GUIDE_KEYS } from "@/lib/guide-store";
import { useLocation } from "wouter";
import { useLanguageContext } from "@/contexts/language-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, batchPrefetchPhotos } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/hooks/use-tab-active";
import { isCallSessionCancelled, markCallSessionCancelled, clearCancelledSession } from "@/lib/cancelled-calls";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { useUnreadCounts } from "@/hooks/use-unread-counts";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Phone, Video, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, PhoneOff, Clock, Check, X, Sparkles, Calendar, Heart, PhoneForwarded, Moon, User, Mic, Loader2, Pause, Play, BadgeCheck } from "lucide-react";
import { ProfileInfoRow } from "@/components/profile-info-row";
import { LANGUAGE_NAME_TO_CODE } from "@/lib/i18n";
import { translateSignal, translateGreenFlag, translateIntent, translateStyle, translateStarterItem } from "@/lib/profile-i18n";
import { scanContent } from "@/lib/content-filter";
import { formatLastActive } from "@/lib/last-active";
import { LulouFlowerIcon, ProfileAvatar } from "@/components/app-layout";
import { usePerfTrace, useRenderCount, isMobile, scheduleIdle } from "@/lib/perf";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { armCallSession, markSessionAsPaid } from "@/lib/live-call-sessions";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { ProfilePhotoViewer } from "@/components/profile-photo-viewer";
import { PurchasePrompt, type PurchaseFeature } from "@/components/purchase-prompt";
import { EMPTY_PHOTOS } from "@/lib/image-utils";
import type { Profile, Match, Message, SpinRequest } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const POST_CALL_THRESHOLD = 25;
const MAX_CHARS = 500;

const CALL_DURATIONS = [10 * 60, 15 * 60, 10 * 60];

function getCallDuration(stage: number): number {
  return CALL_DURATIONS[stage] || CALL_DURATIONS[0];
}

type MatchWithProfile = Match & { profile: Profile; lastMessage?: { content: string; senderId: string; createdAt: Date | null } | null };
type MatchDetail = Match & { profile: Profile; messages: Message[] };
type SpinRequestWithProfile = SpinRequest & { profile: Profile };
type SpinRequestsData = {
  incoming: SpinRequestWithProfile[];
  outgoing: SpinRequestWithProfile[];
};
const MAX_CONNECTIONS = 8;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CallTimer({ match, onComplete, isFaceCall }: { match: MatchDetail; onComplete: (connectedDurationMs: number) => void; isFaceCall?: boolean }) {
  const { t } = useLanguageContext();
  const callStage = match.callStage || 0;
  const duration = getCallDuration(callStage);
  const CallIcon = isFaceCall ? Video : Phone;

  const [remaining, setRemaining] = useState(() => {
    if (!match.callStartedAt) return duration;
    const elapsed = Math.floor((Date.now() - new Date(match.callStartedAt).getTime()) / 1000);
    return Math.max(0, duration - elapsed);
  });

  useEffect(() => {
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [remaining]);

  const progress = remaining / duration;
  const isLow = remaining <= 60;

  const stageLabel = isFaceCall ? t("face_call_label") : t("first_call");
  const completeMessage = callStage >= 2 ? t("complete_msg_stage_2") : t("complete_msg_stage_0");

  return (
    <div className="p-5 border-t" data-testid={`call-timer-${match.id}`}>
      <div className="text-center space-y-4">
        <div className="relative w-28 h-28 mx-auto">
          <svg className="w-28 h-28 -rotate-90" viewBox="0 0 112 112">
            <circle cx="56" cy="56" r="50" fill="none" stroke="currentColor" strokeWidth="4" className="text-muted/30" />
            <circle
              cx="56" cy="56" r="50" fill="none"
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 50}`}
              strokeDashoffset={`${2 * Math.PI * 50 * (1 - progress)}`}
              className={`transition-all duration-1000 ${isLow ? "text-destructive" : "text-primary"}`}
              stroke="currentColor"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <CallIcon className={`w-5 h-5 mb-1 ${isLow ? "text-destructive" : "text-primary"}`} />
            <span className={`text-xl font-bold tabular-nums ${isLow ? "text-destructive" : ""}`} data-testid={`text-timer-${match.id}`}>
              {formatTime(remaining)}
            </span>
          </div>
        </div>

        {remaining > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-sm">{stageLabel} {t("call_in_progress")}</p>
            <p className="text-xs text-muted-foreground">
              {remaining <= 60
                ? t("less_than_minute")
                : `${Math.ceil(remaining / 60)} ${t("minutes_remaining_label")}`}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onComplete((duration - remaining) * 1000)}
              data-testid={`button-end-call-${match.id}`}
            >
              <PhoneOff className="w-4 h-4 me-2" /> {t("end_call")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="font-medium text-sm">{t("time_up")}</p>
            <p className="text-xs text-muted-foreground">{completeMessage}</p>
            <Button
              size="sm"
              onClick={() => onComplete(duration * 1000)}
              data-testid={`button-finish-call-${match.id}`}
            >
              {t("complete_call")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SpinRequestCard({ request, type }: { request: SpinRequestWithProfile; type: "incoming" | "outgoing" }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Lazy-load avatar photo — photos are not included in /api/spin-requests
  const { data: spinPhotosData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", request.profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const spinAvatarSrc = spinPhotosData?.photos?.[0];

  const { t } = useLanguageContext();
  const respond = useMutation({
    mutationFn: async (accept: boolean) => {
      const res = await apiRequest("POST", `/api/spin-requests/${request.id}/respond`, { accept });
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.matchCreated) {
        toast({
          title: t("connected_toast"),
          description: t("now_matched_desc").replace("{name}", request.profile.firstName),
        });
      } else if (data.status === "declined") {
        toast({
          title: t("declined_toast"),
          description: t("passed_on_desc").replace("{name}", request.profile.firstName),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/spin-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
    },
    onError: () => {
      toast({
        title: t("something_went_wrong"),
        description: t("retry"),
        variant: "destructive",
      });
    },
  });

  const timeAgo = request.createdAt
    ? (() => {
        const diff = Date.now() - new Date(request.createdAt).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return t("just_now");
        if (mins < 60) return `${mins}${t("time_ago_min")}`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}${t("time_ago_hr")}`;
        return `${Math.floor(hrs / 24)}${t("time_ago_day")}`;
      })()
    : "";

  return (
    <Card className="overflow-hidden" data-testid={`spin-request-${request.id}`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <ProfileAvatar src={spinAvatarSrc} name={request.profile.firstName} className="w-12 h-12" />
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm" data-testid={`text-request-name-${request.id}`}>
                {request.profile.firstName}, {request.profile.age}
              </h3>
              <Badge variant="outline" className="text-xs">
                <Sparkles className="w-3 h-3 me-1" /> {t("via_intention_wheel")}
              </Badge>
            </div>
            {request.profile.location && (
              <p className="text-xs text-muted-foreground">{request.profile.location}</p>
            )}
            <p className="text-xs text-muted-foreground">{timeAgo}</p>
          </div>
        </div>

        <div className="mt-3 bg-muted/50 rounded-md p-3">
          <p className="text-sm leading-relaxed" data-testid={`text-request-message-${request.id}`}>
            "{request.message}"
          </p>
        </div>

        {type === "incoming" && (
          <div className="flex items-center gap-2 mt-3">
            <Button
              className="flex-1 gap-1.5"
              onClick={() => respond.mutate(true)}
              disabled={respond.isPending}
              data-testid={`button-accept-request-${request.id}`}
            >
              <Check className="w-4 h-4" /> {t("accept")}
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-1.5"
              onClick={() => respond.mutate(false)}
              disabled={respond.isPending}
              data-testid={`button-decline-request-${request.id}`}
            >
              <X className="w-4 h-4" /> {t("decline_label")}
            </Button>
          </div>
        )}

        {type === "outgoing" && (
          <div className="mt-3">
            <Badge variant="secondary" className="text-xs" data-testid={`badge-request-status-${request.id}`}>
              {request.status === "pending" ? t("waiting_for_response") :
               request.status === "accepted" ? t("accepted_label") : t("declined_toast")}
            </Badge>
          </div>
        )}
      </div>
    </Card>
  );
}

function generateDateSlots(t: (key: string) => string): { label: string; value: string }[] {
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
      slots.push({ label: `${dayLabel} - ${slot.label}`, value: `${date.toISOString().slice(0, 10)} ${slot.time}` });
    }
  }
  return slots;
}

function ReadyToMeetInline({ detail, matchId, profileName }: { detail: MatchDetail; matchId: string; profileName: string }) {
  const { t } = useLanguageContext();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const dateSlots = generateDateSlots(t as (key: string) => string);

  const isUser1 = detail.user1Id === user?.id;
  const myAvailability = isUser1 ? detail.meetAvailability1 : detail.meetAvailability2;
  const theirAvailability = isUser1 ? detail.meetAvailability2 : detail.meetAvailability1;
  const myNumberExchanged = isUser1 ? detail.numberExchanged1 : detail.numberExchanged2;
  const theirNumberExchanged = isUser1 ? detail.numberExchanged2 : detail.numberExchanged1;
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
      toast({ title: t("availability_shared") });
      setShowDatePicker(false);
    },
    onError: (e: Error) => { toast({ title: t("could_not_save"), description: e.message, variant: "destructive" }); },
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
      toast({ title: t("number_shared_title") });
      setShowPhoneInput(false);
    },
    onError: (e: Error) => { toast({ title: t("could_not_share"), description: e.message, variant: "destructive" }); },
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
        <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
          <div className="text-center space-y-1">
            <PhoneForwarded className="w-5 h-5 text-primary mx-auto" />
            <p className="font-medium text-sm">{t("add_your_phone_title")}</p>
            <p className="text-xs text-muted-foreground">{t("phone_sent_as_message").replace("{name}", profileName)}</p>
          </div>
          <Input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder={t("your_phone_ph")} maxLength={20} data-testid={`input-phone-inline-${matchId}`} />
          <div className="flex items-center gap-2 justify-center">
            <Button size="sm" onClick={() => savePhoneAndExchange.mutate()} disabled={!phoneNumber.trim() || savePhoneAndExchange.isPending} data-testid={`button-confirm-exchange-inline-${matchId}`}>
              {savePhoneAndExchange.isPending ? t("sending_ellipsis") : t("share_my_number")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowPhoneInput(false)}>{t("cancel_btn")}</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (showDatePicker) {
    return (
      <div className="p-4 border-t">
        <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
          <div className="text-center space-y-1">
            <Calendar className="w-5 h-5 text-primary mx-auto" />
            <p className="font-medium text-sm">{t("when_are_you_free")}</p>
            <p className="text-xs text-muted-foreground">{t("select_5_slots")}</p>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {dateSlots.map(slot => {
              const selected = selectedSlots.includes(slot.value);
              return (
                <div key={slot.value} className={`flex items-center gap-2 p-2 rounded-md cursor-pointer transition-all text-xs ${selected ? "bg-primary/15 border border-primary/30" : "hover-elevate border border-transparent"}`} onClick={() => toggleSlot(slot.value)} data-testid={`slot-inline-${slot.value}-${matchId}`}>
                  <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? "border-primary bg-primary" : "border-muted-foreground/30"}`}>
                    {selected && <Check className="w-2 h-2 text-primary-foreground" />}
                  </div>
                  <span>{slot.label}</span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground text-center">{selectedSlots.length}/5 {t("slots_selected_label")}</p>
          <div className="flex items-center gap-2 justify-center">
            <Button size="sm" onClick={() => saveAvailability.mutate()} disabled={selectedSlots.length === 0 || saveAvailability.isPending} data-testid={`button-save-avail-inline-${matchId}`}>
              {saveAvailability.isPending ? t("saving_ellipsis") : t("share_availability_btn")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDatePicker(false)}>{t("cancel_btn")}</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (myNumberExchanged) {
    return (
      <div className="p-4 border-t">
        <Card className="p-4 text-center space-y-2 bg-primary/5 border-primary/20">
          <Heart className="w-5 h-5 text-primary mx-auto" />
          <p className="font-medium text-sm">{t("number_shared_title")}</p>
          <p className="text-xs text-muted-foreground">
            {theirNumberExchanged ? t("both_exchanged_numbers") : t("waiting_for_their_number")}
          </p>
          {matchingSlots.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium text-muted-foreground">{t("your_matching_times")}</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} className="text-xs bg-primary/15 text-primary border-primary/30">{m?.label || s}</Badge>; })}
              </div>
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 border-t">
      <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
        <Check className="w-5 h-5 text-primary mx-auto" />
        <p className="font-medium text-sm">{t("all_calls_completed")}</p>
        <p className="text-xs text-muted-foreground">{t("ready_to_meet_real")}</p>

        {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 justify-center">
              <Heart className="w-3.5 h-3.5 text-primary" />
              <p className="font-medium text-xs text-primary">{t("your_date_on_cards")}</p>
              <Heart className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t("you_both_matched_on")}</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} className="text-xs bg-primary/15 text-primary border-primary/30">{m?.label || s}</Badge>; })}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-center pt-1">
              <Button size="sm" onClick={handleExchangeNumber} data-testid={`button-exchange-number-${matchId}`}>
                <PhoneForwarded className="w-4 h-4 me-2" /> {t("exchange_number_btn")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid={`button-update-avail-${matchId}`}>
                <Calendar className="w-4 h-4 me-2" /> {t("update_availability_btn")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {mySlots.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t("your_availability_lbl")}</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {mySlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} variant="secondary" className="text-xs">{m?.label || s}</Badge>; })}
                </div>
              </div>
            )}
            {theirSlots.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t("their_availability_lbl").replace("{name}", profileName)}</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {theirSlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} variant="outline" className="text-xs">{m?.label || s}</Badge>; })}
                </div>
              </div>
            )}
            {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("no_matching_times")}</p>
            )}
            <div className="flex flex-col gap-2 items-center">
              {mySlots.length === 0 ? (
                <Button size="sm" onClick={() => setShowDatePicker(true)} data-testid={`button-ready-to-meet-${matchId}`}>
                  <Calendar className="w-4 h-4 me-2" /> {t("ready_to_meet")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid={`button-update-avail-${matchId}`}>
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

const SCHEDULE_PREFIX = "__SCHEDULE__:";
const PHONE_PREFIX = "__PHONE__:";
const VOICE_PREFIX = "__VOICE__:";

function renderMessageContent(content: string, t: (k: any) => string): string {
  if (content.startsWith(PHONE_PREFIX)) {
    return `${t("my_number_is")} ${content.slice(PHONE_PREFIX.length)}`;
  }
  return content;
}

function VoiceNoteBubble({ url, isMe }: { url: string; isMe: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioError, setAudioError] = useState(false);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause(); else a.play().catch(() => setAudioError(true));
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl min-w-[180px] max-w-[240px] ${
        isMe ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
      }`}
      data-testid="voice-note-bubble"
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
            data-testid="button-voice-note-play"
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
  );
}

function parseScheduleData(msg: Message): { type: string; proposedBy: string; proposedTime: string; stage: number } | null {
  if (!msg.content.startsWith(SCHEDULE_PREFIX)) return null;
  try { return JSON.parse(msg.content.slice(SCHEDULE_PREFIX.length)); }
  catch { return null; }
}

function formatScheduledTime(d: Date, now: number, t: (k: any) => string): string {
  const diff = d.getTime() - now;
  if (diff <= 60000) return t("sched_now");
  if (diff < 3600000) return t("sched_in_min").replace("{n}", String(Math.round(diff / 60000)));
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function TimePickerInline({
  quickTimes,
  selectedTime,
  setSelectedTime,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  quickTimes: { label: string; value: string }[];
  selectedTime: string;
  setSelectedTime: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  const { t } = useLanguageContext();
  return (
    <div className="space-y-2 pt-1">
      {quickTimes.map(qt => (
        <button
          key={qt.label}
          className={`w-full text-sm px-3 py-2 rounded-md border transition-colors text-start ${selectedTime === qt.value ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted/50"}`}
          onClick={() => setSelectedTime(qt.value)}
        >
          {qt.label}
        </button>
      ))}
      <div className="flex items-center gap-1.5 pt-0.5">
        <span className="text-xs text-muted-foreground shrink-0">{t("pick_a_time_label")}</span>
        <Input
          type="datetime-local"
          min={new Date().toISOString().slice(0, 16)}
          value={selectedTime ? new Date(selectedTime).toISOString().slice(0, 16) : ""}
          onChange={e => {
            if (e.target.value) setSelectedTime(new Date(e.target.value).toISOString());
          }}
          className="text-xs h-8 flex-1"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onConfirm} disabled={!selectedTime} className="flex-1" data-testid="button-confirm-time">
          {confirmLabel}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} className="flex-1" data-testid="button-cancel-time">
          {t("cancel_btn")}
        </Button>
      </div>
    </div>
  );
}

function CallSchedulingCard({
  matchId,
  matchName,
  allMessages,
  callStage,
  startCallPending,
  onStartCall,
  phoneCredits,
}: {
  matchId: string;
  matchName: string;
  allMessages: Message[];
  callStage: number;
  startCallPending: boolean;
  onStartCall: () => void;
  phoneCredits?: number;
}) {
  const { t } = useLanguageContext();
  const { user } = useAuth();
  const [showPicker, setShowPicker] = useState(false);
  const [selectedTime, setSelectedTime] = useState("");
  const [now, setNow] = useState(Date.now());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(ticker);
  }, []);

  const scheduleData = useMemo(() => {
    const msgs = allMessages
      .filter(m => m.content.startsWith(SCHEDULE_PREFIX))
      .filter(m => { const d = parseScheduleData(m); return d?.stage === callStage; });
    if (msgs.length === 0) return null;
    return parseScheduleData(msgs[msgs.length - 1]);
  }, [allMessages, callStage]);

  useEffect(() => {
    if (scheduleData?.type === "accept") {
      const scheduledTs = new Date(scheduleData.proposedTime).getTime();
      if (scheduledTs <= now + 5 * 60 * 1000) {
        console.log("[CALL_SCHEDULE] CALL_READY_TO_START", { matchId, callStage, scheduledTime: scheduleData.proposedTime });
      }
    }
  }, [scheduleData, now]);

  const scheduleMutation = useMutation({
    mutationFn: async ({ action, proposedTime }: { action: string; proposedTime?: string }) => {
      const r = await apiRequest("POST", `/api/matches/${matchId}/schedule-call`, { action, proposedTime });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
      setShowPicker(false);
      setSelectedTime("");
    },
    onError: (err: any) => {
      toast({ title: t("couldnt_schedule_call"), description: err?.message || t("something_went_wrong"), variant: "destructive" });
    },
  });

  const iAmProposer = scheduleData?.proposedBy === user?.id;
  const scheduledTime = scheduleData?.proposedTime ? new Date(scheduleData.proposedTime) : null;
  const isReadyToStart = scheduleData?.type === "accept" && scheduledTime && scheduledTime.getTime() <= now + 5 * 60 * 1000;
  const callDurationKey = "duration_10_min";
  const hasPhoneCredits = true; // guided first call is always free — no credits required

  const quickTimes = [
    { label: t("call_time_now"), value: new Date().toISOString() },
    { label: t("call_time_30m"), value: new Date(now + 30 * 60000).toISOString() },
    { label: t("call_time_1h"), value: new Date(now + 60 * 60000).toISOString() },
    { label: t("call_time_2h"), value: new Date(now + 2 * 60 * 60000).toISOString() },
  ];

  const propose = (time: string) => scheduleMutation.mutate({ action: "propose", proposedTime: time });
  const reschedule = (time: string) => scheduleMutation.mutate({ action: "reschedule", proposedTime: time });

  if (isReadyToStart) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-ready-${matchId}`}>
        <Card className="p-4 text-center space-y-3 bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/40">
          <div className="flex items-center justify-center gap-2">
            <Phone className="w-5 h-5 text-green-600 dark:text-green-400" />
            <p className="font-semibold text-sm text-green-700 dark:text-green-400">
              {t("its_time_to_talk")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("call_ready_start")}
          </p>
          <Button
            size="sm"
            onClick={onStartCall}
            disabled={startCallPending || !hasPhoneCredits}
            className={hasPhoneCredits ? "bg-green-600 hover:bg-green-700 text-white" : "bg-muted text-muted-foreground"}
            data-testid={`button-start-scheduled-call-${matchId}`}
          >
            <Phone className="w-4 h-4 me-2" /> {t("start_first_call")}
          </Button>
          {!hasPhoneCredits && (
            <p className="text-xs text-muted-foreground" data-testid={`text-no-credits-${matchId}`}>
              {t("need_phone_credits_msg")}
            </p>
          )}
        </Card>
      </div>
    );
  }

  if (scheduleData?.type === "accept" && scheduledTime) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-confirmed-${matchId}`}>
        <Card className="p-4 text-center space-y-2.5 bg-primary/5 border-primary/20">
          <Check className="w-5 h-5 text-primary mx-auto" />
          <p className="font-medium text-sm">{t("call_confirmed")}</p>
          <p className="text-xs font-medium text-primary">{scheduledTime.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at {scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          <p className="text-xs text-muted-foreground">{t("sched_confirmed_note").replace("{time}", formatScheduledTime(scheduledTime, now, t))}</p>
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground h-7" onClick={() => { setShowPicker(true); }} data-testid={`button-reschedule-${matchId}`}>{t("change_time")}</Button>
          {showPicker && (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel={t("reschedule_label")}
              onConfirm={() => { if (selectedTime) reschedule(selectedTime); }}
              onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
            />
          )}
        </Card>
      </div>
    );
  }

  if ((scheduleData?.type === "propose" || scheduleData?.type === "reschedule") && iAmProposer) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-waiting-${matchId}`}>
        <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <p className="font-medium text-sm">{t("waiting_for_name").replace("{name}", matchName)}</p>
          </div>
          {scheduledTime && (
            <p className="text-xs text-muted-foreground">{t("you_proposed")} {formatScheduledTime(scheduledTime, now, t)} ({scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</p>
          )}
          {!showPicker ? (
            <Button size="sm" variant="outline" className="w-full" onClick={() => setShowPicker(true)} data-testid={`button-change-proposal-${matchId}`}>
              <Clock className="w-3.5 h-3.5 me-1.5" /> {t("suggest_different_time")}
            </Button>
          ) : (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel={t("update_proposal")}
              onConfirm={() => { if (selectedTime) reschedule(selectedTime); }}
              onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
            />
          )}
        </Card>
      </div>
    );
  }

  if ((scheduleData?.type === "propose" || scheduleData?.type === "reschedule") && !iAmProposer) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-incoming-${matchId}`}>
        <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-primary shrink-0" />
            <p className="font-medium text-sm">
              {t("wants_to_schedule").replace("{name}", matchName).replace("{type}", `${t(callStage === 0 ? "first_label" : "second_label")} ${t("call_label")}`)}
            </p>
          </div>
          {scheduledTime && (
            <p className="text-xs text-muted-foreground">{t("proposed_label")} {formatScheduledTime(scheduledTime, now, t)} ({scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</p>
          )}
          {!showPicker ? (
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => scheduleMutation.mutate({ action: "accept" })} disabled={scheduleMutation.isPending} data-testid={`button-accept-schedule-${matchId}`}>
                <Check className="w-3.5 h-3.5 me-1" /> {t("accept")}
              </Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowPicker(true)} data-testid={`button-suggest-time-${matchId}`}>
                <Clock className="w-3.5 h-3.5 me-1" /> {t("different_time")}
              </Button>
              <Button size="sm" variant="ghost" className="shrink-0 px-2" onClick={() => scheduleMutation.mutate({ action: "decline" })} disabled={scheduleMutation.isPending} data-testid={`button-decline-schedule-${matchId}`}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel={t("propose_this_time")}
              onConfirm={() => { if (selectedTime) reschedule(selectedTime); }}
              onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
            />
          )}
        </Card>
      </div>
    );
  }

  if (scheduleData?.type === "decline") {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-declined-${matchId}`}>
        <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
          <p className="font-medium text-sm text-center">{t("that_time_didnt_work")}</p>
          <p className="text-xs text-muted-foreground text-center">{t("either_suggest_new_time")}</p>
          {!showPicker ? (
            <Button size="sm" className="w-full" onClick={() => setShowPicker(true)} data-testid={`button-propose-new-time-${matchId}`}>
              <Calendar className="w-4 h-4 me-2" /> {t("propose_new_time")}
            </Button>
          ) : (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel={t("send_proposal")}
              onConfirm={() => { if (selectedTime) reschedule(selectedTime); }}
              onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
            />
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 border-t" data-testid={`call-schedule-initial-${matchId}`}>
      <Card className="p-4 space-y-3 bg-primary/5 border-primary/20">
        <Phone className="w-5 h-5 text-primary mx-auto" />
        <p className="font-medium text-sm text-center">
          {t("ready_first_call")}
        </p>
        <p className="text-xs text-muted-foreground text-center">
          {t("schedule_voice_call_desc").replace("{duration}", t(callDurationKey)).replace("{label}", t("first_label"))}
        </p>
        {!showPicker ? (
          <div className="space-y-2">
            {quickTimes.map(qt => (
              <Button
                key={qt.label}
                size="sm"
                variant="outline"
                className="w-full justify-start"
                onClick={() => propose(qt.value)}
                disabled={scheduleMutation.isPending}
                data-testid={`button-quick-time-${qt.label.replace(/\s+/g, "-").toLowerCase()}-${matchId}`}
              >
                {qt.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="w-full text-muted-foreground" onClick={() => setShowPicker(true)} data-testid={`button-pick-time-${matchId}`}>
              <Calendar className="w-4 h-4 me-2" /> {t("pick_specific_time")}
            </Button>
          </div>
        ) : (
          <TimePickerInline
            quickTimes={[]}
            selectedTime={selectedTime}
            setSelectedTime={setSelectedTime}
            confirmLabel={t("propose_this_time")}
            onConfirm={() => { if (selectedTime) propose(selectedTime); }}
            onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
          />
        )}
      </Card>
    </div>
  );
}

function SparkProgressBar({ sparkStep }: { sparkStep: number }) {
  const { t } = useLanguageContext();
  const steps = [t("spark_match"), t("spark_chat"), t("spark_1st_call"), t("spark_meet")];
  return (
    <div className="px-4 py-2.5 bg-primary/[0.03] border-b flex items-center justify-center" data-testid="spark-progress-bar">
      {steps.map((label, i) => {
        const isDone = i < sparkStep;
        const isCurrent = i === sparkStep;
        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center gap-0.5">
              <div className={`w-2 h-2 rounded-full transition-all ${
                isDone ? "bg-primary" :
                isCurrent ? "bg-primary ring-2 ring-primary/30 ring-offset-1" :
                "bg-muted-foreground/20"
              }`} />
              <span className={`text-[8px] leading-none whitespace-nowrap ${
                isCurrent ? "text-primary font-semibold" :
                isDone ? "text-primary/50" :
                "text-muted-foreground/35"
              }`}>{label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={`w-6 h-px mb-2.5 mx-0.5 ${i < sparkStep ? "bg-primary/40" : "bg-muted-foreground/15"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StageHint({ children }: { children: ReactNode }) {
  return (
    <div className="mx-3 mb-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10 text-[11px] text-primary/65 text-center leading-relaxed" data-testid="stage-hint">
      {children}
    </div>
  );
}

function SystemGuidanceMessage({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex justify-center my-1.5" data-testid={testId || "system-guidance-message"}>
      <div className="text-center px-3 max-w-[76%]">
        <p className="text-[8px] font-medium text-muted-foreground/35 uppercase tracking-widest mb-0.5">Lulou</p>
        <p className="text-[10px] text-muted-foreground/55 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

function ProfilePanel({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
  const { data: photoData, isLoading: isPhotosLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", profile.userId, "photos"],
    enabled: !!profile.userId,
    staleTime: 5 * 60 * 1000,
  });
  const photos = photoData?.photos ?? profile.photos ?? EMPTY_PHOTOS;

  return (
    <div className="flex flex-col h-full bg-background" data-testid="profile-panel">

      {/* Shared photo viewer — same component as Discovery and Intention Wheel */}
      <div className="flex-shrink-0">
      <ProfilePhotoViewer
        photos={photos}
        isLoading={isPhotosLoading}
        height={320}
        className=""
        nameSlot={
          <div className="flex items-center gap-2">
            <h2
              className="font-serif font-bold text-white leading-tight"
              style={{ fontSize: 22, textShadow: "0 1px 8px rgba(0,0,0,0.5)" }}
              data-testid="text-profile-panel-name"
            >
              {profile.firstName}
            </h2>
            {profile.photoVerified && (
              <BadgeCheck className="w-5 h-5 text-white drop-shadow" data-testid="icon-profile-panel-verified" />
            )}
          </div>
        }
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 end-3 z-20 flex items-center justify-center rounded-full transition-all active:scale-90"
          style={{ width: 34, height: 34, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          data-testid="button-close-profile-panel"
        >
          <X className="w-4 h-4 text-white" />
        </button>
      </ProfilePhotoViewer>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto profile-panel-body" style={{ paddingBottom: "env(safe-area-inset-bottom, 16px)" }}>
        {profile.datingIntent && (
          <div className="px-4 pt-4">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                background: "linear-gradient(135deg, hsl(350 45% 52% / 0.13), hsl(350 45% 52% / 0.07))",
                color: "hsl(350 45% 44%)",
                border: "1px solid hsl(350 45% 52% / 0.22)",
              }}
              data-testid="badge-profile-panel-intent"
            >
              <Heart className="w-3 h-3" />
              {translateIntent(profile.datingIntent ?? "", t)}
            </span>
          </div>
        )}

        {(profile.age != null || profile.location || profile.height || (profile as any).dateOfBirth || (profile as any).pronouns) && (
          <div className="px-4 pt-4">
            <ProfileInfoRow
              age={profile.age}
              location={profile.location}
              height={profile.height}
              dateOfBirth={(profile as any).dateOfBirth}
              pronouns={(profile as any).pronouns}
            />
          </div>
        )}

        <div className="px-4 pt-4 space-y-5 pb-6">
          {profile.signals && profile.signals.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">{t("personality")}</p>
              <div className="flex flex-wrap gap-1.5">
                {profile.signals.map((s, i) => (
                  <span
                    key={i}
                    className="rounded-full px-3 py-1 text-xs font-medium"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))" }}
                    data-testid={`badge-profile-panel-signal-${i}`}
                  >
                    {translateSignal(s, langCode)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.greenFlags && profile.greenFlags.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">{t("green_flags_label")}</p>
              <div className="flex flex-wrap gap-1.5">
                {profile.greenFlags.map((f, i) => (
                  <span
                    key={i}
                    className="rounded-full px-3 py-1 text-xs font-medium"
                    style={{ background: "hsl(155 25% 88%)", color: "hsl(155 30% 26%)", border: "1px solid hsl(155 25% 78%)" }}
                    data-testid={`badge-profile-panel-flag-${i}`}
                  >
                    {translateGreenFlag(f, langCode)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.connectionStyle && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">{t("pace_label")}</p>
              <p className="text-sm leading-relaxed text-foreground/85 font-serif italic" data-testid="text-profile-panel-connection-style">
                "{translateStyle(profile.connectionStyle ?? "", t)}"
              </p>
            </div>
          )}

          {profile.conversationStarters && profile.conversationStarters.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">{t("ask_me")}</p>
              <div className="space-y-2">
                {profile.conversationStarters.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-2xl px-4 py-3"
                    style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}
                    data-testid={`text-profile-panel-starter-${i}`}
                  >
                    <p className="text-sm leading-relaxed text-foreground/80">{translateStarterItem(s, langCode)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function mergeCallFields(
  qc: ReturnType<typeof useQueryClient>,
  matchId: string,
  data: Record<string, any>,
) {
  const CALL_KEYS = [
    "callStartedAt", "callInitiatorId", "callAnswered", "callCompleted",
    "callSessionId", "callStage", "messageCount1", "messageCount2",
    "faceCallUser1Accepted", "faceCallUser2Accepted",
  ];
  const patch: Record<string, any> = {};
  for (const k of CALL_KEYS) {
    if (k in data) patch[k] = data[k];
  }
  qc.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, (old) => {
    if (!old || !Array.isArray(old)) return old;
    return old.map(m => m.id === matchId ? { ...m, ...patch } as MatchWithProfile : m);
  });
  qc.setQueriesData<MatchDetail>({ queryKey: ["/api/matches", matchId] }, (old) => {
    if (!old) return old;
    return { ...old, ...patch } as MatchDetail;
  });
}

function _MatchChat({ match, expanded, onToggleExpand, unreadCount, onMarkRead }: {
  match: MatchWithProfile;
  expanded: boolean;
  onToggleExpand: () => void;
  unreadCount: number;
  onMarkRead: () => void;
}) {
  const { t, isRTL, language } = useLanguageContext();
  const langCode = LANGUAGE_NAME_TO_CODE[language] ?? "en";
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const isActive = useTabActive();
  const [message, setMessage] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [showAIStarters, setShowAIStarters] = useState(false);
  const hasAutoShownStartersRef = useRef(false);
  const [filterConfirm, setFilterConfirm] = useState<{ content: string; tempId: string; categories: string[] } | null>(null);
  const [chatGuideTriggered,  setChatGuideTriggered]  = useState(false);
  const [callGuideTriggered,  setCallGuideTriggered]  = useState(false);
  const [videoGuideTriggered, setVideoGuideTriggered] = useState(false);
  // Tracks messages sent in the current call-stage session for optimistic counter display.
  // Resets when match.id or callStage changes so the badge always starts from the DB value.
  const [localSentCount, setLocalSentCount] = useState(0);

  // Lazy-load the chat header avatar — photos are stripped from /api/matches.
  // Shares the same cache key as ProfilePanel so the photo is loaded at most once.
  const { data: headerPhotosData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", match.profile.userId, "photos"],
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });
  const headerAvatarSrc = headerPhotosData?.photos?.[0];
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const wasExpandedRef = useRef(false);
  const guidanceInsertIndexRef = useRef<Map<string, number>>(new Map());

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const { data: matchDetail, isLoading: matchLoading, error: matchError } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", match.id],
    enabled: expanded,
    // Primary delivery: real-time subscription (useRealtimeMessages) — ~50ms
    // Fallback: poll every 30 s in case a broadcast packet is dropped.
    refetchInterval: expanded ? 30000 : false,
    // Keep previous data visible during background refetches — prevents the
    // chat from briefly blanking to a loading state on every 30 s poll cycle.
    placeholderData: (prev) => prev,
  });

  const { broadcastNewMessage, broadcastDateChoice } = useRealtimeMessages(match.id, expanded);

  // ── AI Conversation Starters ──────────────────────────────────────────────
  const aiStartersEnabled = localStorage.getItem("settings_conversation_starter_ai") !== "false";
  const { data: aiStartersData } = useQuery<{ starters: string[] }>({
    queryKey: ["/api/matches", match.id, "ai-starters", langCode],
    enabled: expanded && showAIStarters && aiStartersEnabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { getAuthHeaders } = await import("@/lib/queryClient");
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/matches/${match.id}/ai-starters?lang=${encodeURIComponent(langCode)}`, { headers });
      if (!res.ok) throw new Error("Failed to load starters");
      return res.json();
    },
  });

  const { isOtherTyping, sendTyping, stopTyping } = useTypingIndicator(match.id, user?.id || null, expanded);

  const sendMessage = useMutation({
    mutationFn: async (vars: { content: string; tempId: string }) => {
      if (!match.id) {
        throw new Error("No match selected");
      }
      const res = await apiRequest("POST", `/api/matches/${match.id}/messages`, { content: vars.content });
      return res.json();
    },
    onMutate: async (vars: { content: string; tempId: string }) => {
      if (!match.id) return {};

      // Snapshot current state for error rollback FIRST
      const previous = queryClient.getQueryData<MatchDetail>(["/api/matches", match.id]);

      // Fire cancel signal immediately (no await) — the abort goes out now,
      // but we don't block on it so the optimistic update renders in the same tick.
      queryClient.cancelQueries({ queryKey: ["/api/matches", match.id] });

      // Clear input and show optimistic message SYNCHRONOUSLY (no async gap = instant UI)
      setMessage("");
      if (previous) {
        const optimisticMsg = {
          id: vars.tempId,
          matchId: match.id,
          senderId: user?.id || "",
          content: vars.content,
          reaction: null,
          createdAt: new Date(),
          voiceTranscript: null,
        };
        queryClient.setQueryData<MatchDetail>(["/api/matches", match.id], {
          ...previous,
          messages: [...(previous.messages || []), optimisticMsg],
        });
        console.log("[CHAT_REALTIME] message sent optimistic", {
          matchId: match.id.slice(0, 8), tempId: vars.tempId.slice(0, 12),
        });
      }
      // Optimistically update last-message preview in the matches list
      queryClient.setQueryData<MatchWithProfile[]>(["/api/matches"], (list) => {
        if (!list) return list;
        return list.map(m =>
          m.id === match.id
            ? { ...m, lastMessage: { content: vars.content, senderId: user?.id || "", createdAt: new Date() } }
            : m
        );
      });
      return { previous };
    },
    onSuccess: (data: any) => {
      const realMsg = data as Message;
      // Increment the optimistic per-stage counter so the badge decreases immediately.
      setLocalSentCount(c => {
        const newCount = c + 1;
        // When this message pushes us to/past the post-call threshold in stage 1,
        // schedule a refetch so theirPostCallCount is fresh and postCallProgressReady
        // updates as soon as the server has incremented the DB counter.
        if (callStage >= 1 && (myPostCallCount + newCount) >= POST_CALL_THRESHOLD) {
          setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
          }, 700);
        }
        return newCount;
      });
      queryClient.setQueryData<MatchDetail>(["/api/matches", match.id], (old) => {
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
        const exists = old.messages.some(m => m.id === realMsg.id);
        if (exists) return old;
        return { ...old, messages: [...old.messages, realMsg] };
      });

      setChatGuideTriggered(true);
      // Broadcast to receiver instantly (~50ms) via the realtime broadcast channel.
      // handleNewMessage on the receiver's side deduplicates via message ID.
      broadcastNewMessage(realMsg);

    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/matches", match.id], context.previous);
      }
      toast({ title: t("could_not_send_title"), description: error.message, variant: "destructive" });
    },
  });

  // ── Comment filter + send helper ──────────────────────────────────────────
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
    stopTyping();
    forceScrollRef.current = true;
    sendMessage.mutate({ content, tempId });
  };

  const startCall = useMutation({
    mutationFn: async () => {
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, callerId: user?.id, callStage, role: "caller" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/start`, {});
      return await res.json();
    },
    onSuccess: (data: any) => {
      const m = data?.match ?? data;
      console.log("[CALL_UI] CALL_REQUEST_STARTED", { matchId: match.id, callSessionId: m?.callSessionId });
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, callSessionId: m?.callSessionId, role: "caller" });
      iCancelledRef.current = false;
      mergeCallFields(queryClient, match.id, m);
      const callSessionId = m?.callSessionId;
      // Arm the session for the CALLER. Only armed sessions may mount overlays
      // or play ringback. This prevents a stale DB row from re-triggering audio
      // if the user navigates to Connections/Matches after this call ends and the
      // server DB hasn't been cleared yet.
      if (callSessionId) {
        armCallSession(callSessionId);
        console.log("[LIVE_CALL] caller session armed via startCall", { callSessionId: callSessionId.slice(0, 8) });
      }
      if (callSessionId && user?.id) {
        broadcastCallSignal(match.id, {
          type: "call:ring",
          matchId: match.id,
          callerId: user.id,
          callerName: "",
          callSessionId,
        });
        console.log("[CALL_UI] CALL_RING_CLIENT_BROADCAST", { matchId: match.id, callSessionId, callerId: user.id });
      }
      setCallGuideTriggered(true);
    },
    onError: (error: Error) => {
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      const isSelfCall = error.message?.includes("own account");
      console.error("[CALL_UI] CALL_START_FAILED", { matchId: match.id, route: "call/start", error: error.message, isAuth, isSelfCall });
      toast({
        title: isSelfCall ? t("cant_call_yourself_title") : isAuth ? t("session_expired_title") : t("call_failed_title"),
        description: isSelfCall
          ? t("cant_call_yourself_desc")
          : isAuth
            ? t("please_refresh_desc")
            : (error.message || t("unknown_server_error")),
        variant: "destructive",
      });
    },
  });

  const startPaidCall = useMutation({
    mutationFn: async ({ isVideo }: { isVideo: boolean }) => {
      console.log("[CALL_UI] PAID_CALL_REQUESTED", { matchId: match.id, callerId: user?.id, isVideo });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/start`, { isPaidCredit: true, isVideo });
      const data = await res.json();
      return { data, isVideo };
    },
    onSuccess: ({ data, isVideo }) => {
      const m = data?.match ?? data;
      const callSessionId = m?.callSessionId;
      if (callSessionId) {
        armCallSession(callSessionId);
        markSessionAsPaid(callSessionId, isVideo);
        console.log("[LIVE_CALL] caller session armed via startPaidCall", { callSessionId: callSessionId.slice(0, 8), isVideo });
      }
      mergeCallFields(queryClient, match.id, m);
      if (callSessionId && user?.id) {
        broadcastCallSignal(match.id, {
          type: "call:ring",
          matchId: match.id,
          callerId: user.id,
          callerName: "",
          callSessionId,
          isVideo,
        });
        console.log("[CALL_UI] PAID_CALL_RING_BROADCAST", { matchId: match.id, callSessionId, isVideo });
      }
      if (isVideo) setVideoGuideTriggered(true);
      else setCallGuideTriggered(true);
    },
    onError: (error: Error) => {
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      const isSelfCall = error.message?.includes("own account");
      toast({
        title: isSelfCall ? t("cant_call_yourself_title") : isAuth ? t("session_expired_title") : t("call_failed_title"),
        description: isSelfCall ? t("cant_call_yourself_desc") : isAuth ? t("please_refresh_desc") : (error.message || t("unknown_server_error")),
        variant: "destructive",
      });
    },
  });

  const repairCall = useMutation({
    mutationFn: async () => {
      const sessionId = lastCallSessionIdRef.current ?? detail.callSessionId;
      console.log("[CALL_REPAIR] REPAIR_REQUESTED", { matchId: match.id, callSessionId: sessionId, userId: user?.id, callAgeMs });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/repair`, {});
      const data = await res.json();
      console.log("[CALL_REPAIR] REPAIR_RESPONSE", { matchId: match.id, status: data.status, reason: data.reason, callAgeMs });
      return data;
    },
    onSuccess: (data: any) => {
      const patchMatch = data?.match ?? data;
      mergeCallFields(queryClient, match.id, {
        callStartedAt: patchMatch?.callStartedAt ?? null,
        callInitiatorId: patchMatch?.callInitiatorId ?? null,
        callAnswered: patchMatch?.callAnswered ?? false,
        callCompleted: patchMatch?.callCompleted ?? false,
        callSessionId: patchMatch?.callSessionId ?? null,
      });
      // mergeCallFields already patched both list and detail caches — no
      // broad list refetch needed.  Detail invalidation ensures fresh data.
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id], exact: true });
      if (data?.status === "repaired") {
        toast({ title: t("call_cleared_title"), description: t("call_cleared_desc") });
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_REPAIR] REPAIR_FAILED", { matchId: match.id, error: error.message });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
      toast({ title: t("couldnt_clear_call_title"), description: t("couldnt_clear_call_desc"), variant: "destructive" });
    },
  });

  const cancelCall = useMutation({
    mutationFn: async () => {
      // Set immediately so a concurrent 10s poll doesn't trigger the "declined" toast
      iCancelledRef.current = true;
      const sessionId = lastCallSessionIdRef.current;
      console.log("[CALL_UI] CALL_CANCELLED", { matchId: match.id, callSessionId: sessionId, userId: user?.id, role: "caller" });
      console.log("[CALL_UI] CALL_STAGE_EXITED", { matchId: match.id, reason: "caller_cancelled" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      const sessionId = lastCallSessionIdRef.current;
      markCallSessionCancelled(match.id, sessionId);
      broadcastCallSignal(match.id, {
        type: "call:cancelled",
        matchId: match.id,
        userId: user!.id,
        callSessionId: sessionId,
      } as any);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", { matchId: match.id, reason: "caller_cancelled_inline", note: "messages and thread intact" });
      toast({ title: t("call_cancelled_title") });
    },
    onError: (error: Error) => {
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      console.error("[CALL_UI] CALL_CANCEL_FAILED", { matchId: match.id, error: error.message, isAuth });
      markCallSessionCancelled(match.id, lastCallSessionIdRef.current);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      toast({
        title: isAuth ? t("session_expired_title") : t("cancel_failed_title"),
        description: isAuth ? t("please_refresh_desc") : error.message,
        variant: "destructive",
      });
    },
  });

  const completeCall = useMutation({
    mutationFn: async (vars: { connectedDurationMs: number; callState?: string; callType?: string } = { connectedDurationMs: 0 }) => {
      const body = {
        // CallTimer only shows when the call is active in the DB — treat as connected
        connected: vars.connectedDurationMs > 0,
        connectedDurationMs: vars.connectedDurationMs,
        callState: vars.callState ?? "ended",
        callType: vars.callType ?? "phone",
      };
      console.log("[CALL_UI] CALL_STATE:ended", { matchId: match.id, callSessionId: lastCallSessionIdRef.current, userId: user?.id, isCaller: iAmCaller, source: "inline_chat", ...body });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/complete`, body);
      return res.json();
    },
    onSuccess: (data: any) => {
      broadcastCallSignal(match.id, {
        type: "call:ended" as any,
        matchId: match.id,
        userId: user!.id,
      });
      console.log("[CALL_UI] CALL_STATE_CLEARED", { matchId: match.id, newStage: data.callStage, callCounted: data.callCounted });
      mergeCallFields(queryClient, match.id, data);
      if (!data.callCounted) {
        toast({ title: t("call_ended_title"), description: t("call_not_counted_desc") });
      } else {
        const stage = data.callStage || 0;
        if (stage === 1) {
          toast({ title: t("first_call_completed_title"), description: t("first_call_completed_desc") });
        } else if (stage === 2) {
          toast({ title: t("call_completed_title"), description: t("call_completed_desc") });
        } else if (stage === 3) {
          toast({ title: t("face_call_stage_title"), description: t("face_call_stage_desc") });
        } else {
          toast({ title: t("call_completed_title"), description: t("call_completed_desc") });
        }
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_COMPLETE] FRONTEND_ERROR", { matchId: match.id, error: error.message });
      markCallSessionCancelled(match.id, lastCallSessionIdRef.current);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      broadcastCallSignal(match.id, { type: "call:ended" as any, matchId: match.id, userId: user?.id || "" });
      toast({ title: t("call_ended_title"), description: t("connection_lost_desc"), variant: "destructive" });
    },
  });

  const inlineAnswerCall = useMutation({
    mutationFn: async () => {
      console.log("[CALL_UI] CALL_ANSWERED", { matchId: match.id, callSessionId: lastCallSessionIdRef.current, userId: user?.id, role: "receiver", source: "inline_chat" });
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, role: "receiver", callStage });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/answer`, {});
      return await res.json();
    },
    onSuccess: () => {
      broadcastCallSignal(match.id, {
        type: "call:answered",
        matchId: match.id,
        userId: user!.id,
      } as any);
      mergeCallFields(queryClient, match.id, { callAnswered: true });
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_ANSWER_FAILED", { matchId: match.id, error: error.message });
      markCallSessionCancelled(match.id, lastCallSessionIdRef.current);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      toast({ title: t("couldnt_answer_title"), description: error.message, variant: "destructive" });
    },
  });

  const inlineDeclineCall = useMutation({
    mutationFn: async () => {
      const sessionId = lastCallSessionIdRef.current;
      console.log("[CALL_UI] CALL_DECLINED", { matchId: match.id, callSessionId: sessionId, userId: user?.id, role: "receiver", source: "inline_chat" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return await res.json();
    },
    onSuccess: () => {
      const sessionId = lastCallSessionIdRef.current;
      markCallSessionCancelled(match.id, sessionId);
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user!.id,
        callSessionId: sessionId,
      } as any);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", { matchId: match.id, reason: "receiver_declined_inline", note: "messages and thread intact" });
      toast({ title: t("call_declined_title") });
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_DECLINE_FAILED", { matchId: match.id, error: error.message });
      toast({ title: t("couldnt_decline_title"), description: error.message, variant: "destructive" });
    },
  });


  const removeMatch = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/matches/${match.id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
      toast({ title: t("connection_removed_title"), description: t("connection_removed_desc").replace("{name}", match.profile.firstName) });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleReaction = useMutation({
    mutationFn: async ({ messageId, currentReaction }: { messageId: string; currentReaction: string | null }) => {
      const newReaction = currentReaction ? null : "❤️";
      console.log(newReaction ? "[CHAT] MESSAGE_REACTION_ADDED" : "[CHAT] MESSAGE_REACTION_REMOVED", { messageId, matchId: match.id });
      const res = await apiRequest("POST", `/api/messages/${messageId}/reaction`, { reaction: newReaction });
      return res.json();
    },
    onMutate: async ({ messageId, currentReaction }) => {
      const key = ["/api/matches", match.id];
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<MatchDetail>(key);
      if (prev) {
        queryClient.setQueryData<MatchDetail>(key, {
          ...prev,
          messages: prev.messages.map(m =>
            m.id === messageId ? { ...m, reaction: currentReaction ? null : "❤️" } : m
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(["/api/matches", match.id], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
    },
  });

  const doubleTapRef = useRef<{ id: string; time: number } | null>(null);
  const handleMessageTap = useCallback((msg: Message) => {
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

  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const wasRingingRef = useRef(false);
  const iCancelledRef = useRef(false);
  const lastCallSessionIdRef = useRef<string | null>(null);

  // MUST be declared before any useEffect that references it in a dependency array
  // (fixes: ReferenceError – Cannot access 'detail' before initialization → white screen crash)
  const detail = matchDetail || match as unknown as MatchDetail;

  useEffect(() => {
    const justExpanded = expanded && !wasExpandedRef.current;
    wasExpandedRef.current = expanded;

    if (!expanded) return;

    const el = messagesContainerRef.current;
    if (!el) return;

    if (justExpanded || forceScrollRef.current) {
      // Chat just opened or user just sent a message — jump to bottom instantly
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
      console.log("[CHAT_REALTIME] scrolled to bottom (force)", { matchId: match.id.slice(0, 8), count: matchDetail?.messages?.length });
    } else if (isAtBottomRef.current) {
      // New message arrived and user is already at the bottom — smooth follow
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      console.log("[CHAT_REALTIME] scrolled to bottom (follow)", { matchId: match.id.slice(0, 8), count: matchDetail?.messages?.length });
    }
    // If user has scrolled up to read history: do nothing
  }, [matchDetail?.messages?.length, expanded]);

  useEffect(() => {
    if (detail.callSessionId) {
      lastCallSessionIdRef.current = detail.callSessionId;
    }
  }, [detail.callSessionId]);

  // Reset the optimistic sent counter and per-stage UI state whenever the match or call
  // stage changes so counters always start from the fresh DB value.
  useEffect(() => {
    setLocalSentCount(0);
  }, [match.id, detail.callStage]);

  useEffect(() => {
    if (expanded) {
      onMarkRead();
    }
  }, [expanded]);
  const { data: benefits } = useQuery<{
    available: Record<string, number>;
    activated: Record<string, Record<string, number>>;
  }>({ queryKey: ["/api/benefits"], enabled: expanded });

  const [dismissedExtension, setDismissedExtension] = useState(false);
  const [nextStepChoice, setNextStepChoice] = useState<null | 'call' | 'end'>(null);
  const [finalChoice, setFinalChoice] = useState<null | 'date' | 'chat' | 'end'>(null);

  const { data: elevateStatus } = useQuery<{ active: boolean; elevateCredits: number; superElevateCredits: number }>({
    queryKey: ["/api/elevate/status"],
    enabled: expanded,
    staleTime: 60_000,
  });
  const hasElevate = !!(elevateStatus?.active || (elevateStatus?.elevateCredits ?? 0) > 0 || (elevateStatus?.superElevateCredits ?? 0) > 0);

  const { data: callCreditsData } = useQuery<{ phoneCredits: number; videoCredits: number }>({
    queryKey: ["/api/call-credits"],
    enabled: expanded,
    staleTime: 30_000,
  });
  const phoneCredits = callCreditsData?.phoneCredits;
  const videoCredits = callCreditsData?.videoCredits;

  // Voice notes entitlement (either user in this match having the unlock activates it for both)
  const { data: voiceNoteData } = useQuery<{ unlocked: boolean; isMine: boolean }>({
    queryKey: ["/api/voice-notes/entitlement", match.id],
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });
  const voiceNotesUnlocked = voiceNoteData?.unlocked ?? false;

  // Purchase prompt state
  const [purchasePromptFeature, setPurchasePromptFeature] = useState<PurchaseFeature | null>(null);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voicePhase = isRecording ? "recording" as const : "idle" as const;
  const recordingStartMsRef = useRef<number>(0);

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
  };

  const startRecording = async () => {
    try {
      // Detect first-time permission prompt — show a hint instead of starting recording.
      const micPerm = await navigator.permissions?.query({ name: "microphone" as PermissionName }).catch(() => null);
      const needsPermission = micPerm?.state === "prompt";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (needsPermission) {
        stream.getTracks().forEach(t => t.stop());
        toast({ title: "Hold the mic to record", description: "Press and hold while you speak, then release to send." });
        return;
      }
      const preferredTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType = preferredTypes.find(t => {
        try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
      }) ?? "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const actualMimeType = recorder.mimeType || mimeType;
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: actualMimeType });
        if (blob.size > 0) sendVoiceNote.mutate({ blob, mimeType: actualMimeType });
      };
      recorder.start(100);
      mediaRecorderRef.current = recorder;
      recordingStartMsRef.current = Date.now();
      setIsRecording(true);
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
      toast({
        title: isPermission ? "Microphone access denied"
          : isNotFound ? "No microphone found on this device"
          : "Could not start recording",
        variant: "destructive",
      });
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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    setRecordingTime(0);
  };

  const cancelRecording = () => {
    stopRecordingTimer();
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.ondataavailable = null;
      mr.onstop = null;
      try { mr.stream?.getTracks().forEach(t => t.stop()); mr.stop(); } catch { /* ignore */ }
    }
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingTime(0);
  };

  // Release the microphone if the component unmounts while recording is active.
  // Without this the browser mic-in-use indicator stays on after the chat is closed.
  useEffect(() => {
    return () => {
      stopRecordingTimer();
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") {
        mr.ondataavailable = null;
        mr.onstop = null;
        try { mr.stream?.getTracks().forEach(t => t.stop()); } catch {}
        try { mr.stop(); } catch {}
      }
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
      const res = await apiRequest("POST", `/api/voice-notes/send/${match.id}`, { audioBase64, mimeType });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "Failed to send"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      forceScrollRef.current = true;
    },
    onError: (err: any) => {
      toast({ title: err?.message || "Failed to send voice note", variant: "destructive" });
    },
  });

  const activateExtension = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/benefits/activate", { type: "message_extension", matchId: match.id });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to activate");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/benefits"] });
      setDismissedExtension(false);
      toast({ title: t("messages_added_title"), description: t("messages_added_desc") });
    },
    onError: (error: Error) => {
      toast({ title: t("could_not_activate_title"), description: error.message, variant: "destructive" });
    },
  });

  const myMessages = useMemo(
    () => matchDetail?.messages?.filter(m => m.senderId === user?.id) || [],
    [matchDetail?.messages, user?.id],
  );
  const hasMessageExtension = (benefits?.activated?.[match.id]?.message_extension || 0) > 0;
  const hasAvailableExtension = (benefits?.available?.message_extension || 0) > 0;
  const effectiveLimit = hasMessageExtension ? MAX_MESSAGES_PER_USER + 5 : MAX_MESSAGES_PER_USER;
  const callStage = detail.callStage || 0;
  const isUser1 = detail.user1Id === user?.id;
  const myPostCallCount   = isUser1 ? (detail.messageCount1 || 0) : (detail.messageCount2 || 0);
  const theirPostCallCount = isUser1 ? (detail.messageCount2 || 0) : (detail.messageCount1 || 0);

  // Always use the per-stage DB counter (message_count_1/2) + local optimistic sent count.
  // message_count_1/2 is:
  //   • incremented only for text messages (not __SCHEDULE__, __VOICE__, __PHONE__)
  //   • reset to 0 by completeCall() after each call
  // This is the single source of truth — both server enforcement (getUserMessageCount)
  // and client display now use the same value, preventing any UI/server mismatch.
  const myCurrentStageCount = myPostCallCount + localSentCount;
  const stageLimit = callStage >= 1 ? POST_CALL_THRESHOLD : effectiveLimit;
  const messagesRemaining = stageLimit - myCurrentStageCount;
  const isLimitReached = messagesRemaining <= 0;
  const rawLimitReached = myCurrentStageCount >= MAX_MESSAGES_PER_USER;
  const allMessages = matchDetail?.messages || [];

  // Auto-show AI starters when chat first opens and has no real user messages yet.
  useEffect(() => {
    if (!expanded || !aiStartersEnabled || hasAutoShownStartersRef.current) return;
    if (!matchDetail) return; // still loading
    const realMessages = allMessages.filter(m => !m.content.startsWith("__"));
    if (realMessages.length === 0) {
      setShowAIStarters(true);
    }
    hasAutoShownStartersRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, !!matchDetail]);

  // Include localSentCount so the card appears instantly when the user sends their 25th message.
  const postCallProgressReady = callStage >= 1
    && myCurrentStageCount >= POST_CALL_THRESHOLD
    && theirPostCallCount >= POST_CALL_THRESHOLD;
  const postCallApproaching = callStage >= 1 && !postCallProgressReady
    && myCurrentStageCount >= POST_CALL_THRESHOLD - 5
    && theirPostCallCount >= POST_CALL_THRESHOLD - 5;

  const myChoice = ((isUser1 ? detail.dateChoiceUser1 : detail.dateChoiceUser2) ?? null) as 'plan' | 'keep' | null;
  const theirChoice = ((isUser1 ? detail.dateChoiceUser2 : detail.dateChoiceUser1) ?? null) as 'plan' | 'keep' | null;
  const eitherKeep = myChoice === 'keep' || theirChoice === 'keep';
  const bothPlan = myChoice === 'plan' && theirChoice === 'plan';
  const iWaitingForThem = myChoice === 'plan' && !theirChoice;

  const setDateChoiceMut = useMutation({
    mutationFn: async (choice: 'plan' | 'keep' | null) => {
      await apiRequest("POST", `/api/matches/${match.id}/date-choice`, { choice });
    },
    onMutate: async (choice) => {
      queryClient.setQueryData<any>(["/api/matches", match.id], (old: any) => {
        if (!old) return old;
        return isUser1 ? { ...old, dateChoiceUser1: choice } : { ...old, dateChoiceUser2: choice };
      });
    },
    onSuccess: (_, choice) => {
      broadcastDateChoice(user?.id ?? '', choice);
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
    },
  });

  const sparkStep = callStage >= 4 ? 3 : callStage >= 1 ? 2 : 1;

  const callCancelled = isCallSessionCancelled(match.id, detail.callSessionId);

  const callAgeMs = detail.callStartedAt ? Date.now() - new Date(detail.callStartedAt).getTime() : 0;

  const isCallStale = (() => {
    if (!detail.callStartedAt) return false;
    if (!detail.callAnswered && callAgeMs > 120_000) {
      console.log("[CALL_SESSION] STALE_CALL_BLOCKED", { matchId: match.id, callSessionId: detail.callSessionId, ageMs: callAgeMs, answered: false, source: "inline_chat" });
      return true;
    }
    if (detail.callAnswered && callAgeMs > 5 * 60_000) {
      console.log("[CALL_SESSION] STALE_CALL_BLOCKED", { matchId: match.id, callSessionId: detail.callSessionId, ageMs: callAgeMs, answered: true, source: "inline_chat" });
      return true;
    }
    return false;
  })();

  // An answered call that has been "in progress" for > 2 min without completing
  // means WebRTC never connected or the overlay was lost — show a repair button.
  const isCallAnsweredStuck = !!detail.callAnswered && !detail.callCompleted && !!detail.callStartedAt && callAgeMs > 2 * 60_000;

  const isCallRinging = (
    !!detail.callStartedAt &&
    !detail.callAnswered &&
    !detail.callCompleted &&
    !!detail.callSessionId &&
    !callCancelled &&
    !isCallStale
  );
  const isCallActive = (
    !!detail.callStartedAt &&
    detail.callAnswered === true &&
    !detail.callCompleted &&
    !!detail.callSessionId &&
    !callCancelled &&
    !isCallStale
  );

  if (detail.callStartedAt) {
    console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", {
      matchId: match.id,
      callSessionId: detail.callSessionId,
      isCallRinging,
      isCallActive,
      callCancelled,
      isCallStale,
      messageCount: allMessages.length,
    });
  }

  const iAmCaller = detail.callInitiatorId === user?.id;
  const hasExistingCall = isCallRinging || isCallActive;
  const prevRingingRef = useRef(false);
  useEffect(() => {
    const wasRinging = prevRingingRef.current;
    const isRingingNow = !!(isCallRinging && iAmCaller);
    prevRingingRef.current = isRingingNow;

    const selfCancelled = iCancelledRef.current;
    if (wasRinging && !isRingingNow && !isCallActive && !selfCancelled) {
      console.log("[CALL_UI] CALL_DECLINED", { matchId: match.id, reason: "declined_by_receiver_detected", callSessionId: lastCallSessionIdRef.current });
      toast({ title: t("name_declined_title").replace("{name}", match.profile.firstName), description: t("name_declined_desc") });
    }
    if (isCallActive || !isRingingNow) {
      wasRingingRef.current = false;
    }
  }, [isCallRinging, isCallActive, iAmCaller, match.profile.firstName, toast]);
  // (connection stage tracking — no logging needed on every stage change)

  const guidanceMessages = useMemo(() => {
    const msgs: { id: string; text: string }[] = [];
    if (callStage === 0) {
      if (messagesRemaining <= 5 && messagesRemaining > 1) {
        msgs.push({ id: "stage0-approaching", text: t("stage0_approaching") });
      }
      if (messagesRemaining <= 1 || isLimitReached) {
        msgs.push({ id: "stage0-limit", text: t("stage0_limit") });
      }
    } else if (callStage === 1 && !postCallProgressReady) {
      // Build-up guidance before date-planning stage. Each milestone shows once and
      // stays pinned in the message list at the index where it first appeared.
      if (messagesRemaining === 5) {
        msgs.push({ id: "stage1-date-5", text: t("stage1_date_5left") });
      } else if (messagesRemaining === 3) {
        msgs.push({ id: "stage1-date-3", text: t("stage1_date_3left") });
      } else if (messagesRemaining === 1) {
        msgs.push({ id: "stage1-date-1", text: t("stage1_date_1left") });
      }
    }
    return msgs;
  }, [t, callStage, messagesRemaining, isLimitReached, postCallProgressReady]);

  // Track the message-list index at which each guidance message first appeared so it
  // stays at that position and gets pushed upward naturally as new messages arrive.
  const guidanceByIndex = useMemo(() => {
    const visibleMsgs = allMessages.filter(
      m => !m.content.startsWith(SCHEDULE_PREFIX) && !m.content.startsWith("__SYSTEM__:")
    );

    // Record insertion index for guidance messages appearing for the first time
    const activeIds = new Set(guidanceMessages.map(m => m.id));
    guidanceMessages.forEach(msg => {
      if (!guidanceInsertIndexRef.current.has(msg.id)) {
        guidanceInsertIndexRef.current.set(msg.id, visibleMsgs.length);
      }
    });

    // Clean up guidance messages that are no longer active
    for (const id of Array.from(guidanceInsertIndexRef.current.keys())) {
      if (!activeIds.has(id)) {
        guidanceInsertIndexRef.current.delete(id);
      }
    }

    // Build map: "after this many messages" → guidance list
    const map = new Map<number, { id: string; text: string }[]>();
    guidanceMessages.forEach(msg => {
      const idx = guidanceInsertIndexRef.current.get(msg.id)!;
      if (!map.has(idx)) map.set(idx, []);
      map.get(idx)!.push(msg);
    });

    return { map, visibleMsgs };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidanceMessages, allMessages]);

  const allCallsDone = callStage >= 4;

  const formatTimestamp = (dateStr: string | null | undefined) => {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (msgDay.getTime() === today.getTime()) return time;
    if (msgDay.getTime() === yesterday.getTime()) return `Yesterday`;
    const sixDaysAgo = new Date(today.getTime() - 6 * 86400000);
    if (msgDay >= sixDaysAgo) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  if (!expanded) return null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid={`card-match-${match.id}`}>
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="border-b bg-background/95 backdrop-blur-sm sticky top-0 z-10">
        {/* ── Main header row ── */}
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 -ms-1"
          onClick={onToggleExpand}
          data-testid={`button-back-${match.id}`}
        >
          {isRTL ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </Button>
        <button
          className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-xl transition-all active:scale-[0.98]"
          style={{ WebkitTapHighlightColor: "transparent", outline: "none" }}
          onClick={() => setShowProfilePanel(p => !p)}
          data-testid={`button-view-profile-${match.id}`}
        >
          <div className="relative shrink-0">
            <ProfileAvatar src={headerAvatarSrc} name={match.profile.firstName} className="w-10 h-10" />
            <span
              className="absolute -bottom-0.5 -end-0.5 flex items-center justify-center rounded-full bg-background"
              style={{ width: 15, height: 15 }}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-green-400 border border-background" />
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3 className="font-semibold text-sm truncate leading-tight" data-testid={`text-match-name-${match.id}`}>
                {match.profile.firstName}{match.profile.age ? `, ${match.profile.age}` : ""}
              </h3>
              {match.profile.photoVerified && (
                <BadgeCheck className="w-4 h-4 text-primary shrink-0" data-testid={`icon-verified-${match.id}`} />
              )}
            </div>
            {(() => {
              const myShowLastActive = localStorage.getItem("settings_show_last_active") !== "false";
              const lbl = formatLastActive(match.profile.lastActive, (match.profile.showLastActive ?? true) && myShowLastActive);
              return lbl ? (
                <p className="text-[10px] text-muted-foreground leading-none mt-0.5" data-testid={`text-last-active-${match.id}`}>{lbl}</p>
              ) : null;
            })()}
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 mt-0.5 text-[10px] font-semibold transition-all"
              style={showProfilePanel ? {
                background: "linear-gradient(135deg, hsl(350 45% 52% / 0.18), hsl(350 45% 52% / 0.10))",
                color: "hsl(350 45% 44%)",
                border: "1px solid hsl(350 45% 52% / 0.3)",
              } : {
                background: "hsl(var(--muted))",
                color: "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
              }}
            >
              <User className="w-2.5 h-2.5" />
              {showProfilePanel ? t("hide_profile_btn") : t("view_profile_btn")}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0" data-testid={`badge-messages-remaining-${match.id}`}>
            {(allCallsDone || (eitherKeep && postCallProgressReady)) ? t("all_calls_done") : messagesRemaining > 0 ? t("n_msg_left").replace("{n}", String(messagesRemaining)) : t("call_time_badge")}
          </Badge>
          {showRemoveConfirm ? (
            <div className="flex items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="w-7 h-7"
                onClick={() => removeMatch.mutate()}
                disabled={removeMatch.isPending}
                data-testid={`button-confirm-remove-${match.id}`}
              >
                <Check className="w-3.5 h-3.5 text-destructive" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="w-7 h-7"
                onClick={() => setShowRemoveConfirm(false)}
                data-testid={`button-cancel-remove-${match.id}`}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7"
              onClick={() => setShowRemoveConfirm(true)}
              data-testid={`button-remove-match-${match.id}`}
            >
              <Moon className="w-3.5 h-3.5 text-muted-foreground" />
            </Button>
          )}
        </div>
        </div>
        {/* ── Action tray: phone / video / mic with credit counts ── */}
        {(!allCallsDone || voiceNotesUnlocked) && (
          <div className="flex items-center justify-center gap-6 px-4 pb-2.5 border-t border-border/30">
            {!allCallsDone && (
              <button
                onClick={() => {
                  if ((phoneCredits ?? 0) > 0) {
                    startPaidCall.mutate({ isVideo: false });
                  } else {
                    setPurchasePromptFeature("phone");
                  }
                }}
                disabled={startPaidCall.isPending}
                className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90 disabled:opacity-50"
                data-testid={`button-phone-tray-${match.id}`}
              >
                <Phone
                  className="w-[18px] h-[18px] transition-all duration-300"
                  style={!callCreditsData
                    ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                    : (phoneCredits ?? 0) > 0
                    ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                    : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
                />
                <span
                  className="text-[10px] font-semibold leading-none"
                  style={(phoneCredits ?? 0) > 0 ? { color: "rgb(34,197,94)" } : { color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
                >
                  {!callCreditsData ? "·" : (phoneCredits ?? 0) > 0 ? "Use 1" : "Unlock"}
                </span>
              </button>
            )}
            {!allCallsDone && (
              <button
                onClick={() => {
                  if ((videoCredits ?? 0) > 0) {
                    startPaidCall.mutate({ isVideo: true });
                  } else {
                    setPurchasePromptFeature("video");
                  }
                }}
                disabled={startPaidCall.isPending}
                className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90 disabled:opacity-50"
                data-testid={`button-video-tray-${match.id}`}
              >
                <Video
                  className="w-[18px] h-[18px] transition-all duration-300"
                  style={!callCreditsData
                    ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                    : (videoCredits ?? 0) > 0
                    ? { color: "rgb(99,102,241)", filter: "drop-shadow(0 0 5px rgba(99,102,241,0.7))" }
                    : { color: "hsl(var(--muted-foreground))", opacity: 0.35 }}
                />
                <span
                  className="text-[10px] font-semibold leading-none"
                  style={(videoCredits ?? 0) > 0 ? { color: "rgb(99,102,241)" } : { color: "hsl(var(--muted-foreground))", opacity: 0.6 }}
                >
                  {!callCreditsData ? "·" : (videoCredits ?? 0) > 0 ? "Use 1" : "Unlock"}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                if (!voiceNotesUnlocked) setPurchasePromptFeature("mic");
                else if (voicePhase === "recording") stopRecording();
              }}
              className="flex flex-col items-center gap-0.5 min-w-[44px] py-1.5 px-2 rounded-xl transition-all active:scale-90"
              data-testid={`button-mic-tray-${match.id}`}
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
                {voiceNotesUnlocked ? (voicePhase === "recording" ? "Rec" : "On") : "Mic"}
              </span>
            </button>
          </div>
        )}
      </div>

      {expanded && <SparkProgressBar sparkStep={sparkStep} />}
      {expanded && postCallProgressReady && eitherKeep && (
        <div className="px-4 py-2 border-b border-border/40 bg-primary/3" data-testid={`date-plan-hint-bar-${match.id}`}>
          <p className="text-[11px] text-center text-muted-foreground">
            {t("plan_date_cta_hint")}
          </p>
        </div>
      )}

      <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3" data-testid={`messages-container-${match.id}`}>
            {expanded && matchLoading && !matchDetail && (
              <div className="flex flex-col items-center justify-center py-10 gap-3" data-testid={`chat-loading-${match.id}`}>
                <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                <p className="text-xs text-muted-foreground">{t("loading_conversation")}</p>
              </div>
            )}
            {expanded && matchError && (
              <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm text-center" data-testid={`chat-error-${match.id}`}>
                {(() => {
                  const err = matchError as Error;
                  console.error("[CHAT_ROOM_LOAD_ERROR]", {
                    matchId: match.id,
                    message: err?.message,
                    stack: err?.stack,
                  });
                  return t("could_not_load_messages");
                })()}
              </div>
            )}
            {!matchLoading && !matchError && allMessages.length === 0 && (
              <div className="text-center py-6 space-y-2">
                <p className="text-muted-foreground text-sm">{t("chat_start_label")}</p>
                <p className="text-xs text-muted-foreground">{t("initial_messages_info").replace("{n}", String(MAX_MESSAGES_PER_USER))}</p>
              </div>
            )}
            {guidanceByIndex.visibleMsgs.map((msg, i) => {
              const isMe = msg.senderId === user?.id;
              const hasReaction = msg.reaction && typeof msg.reaction === 'string' && msg.reaction.length > 0;
              const isVoiceNote = msg.content.startsWith(VOICE_PREFIX);
              return (
                <Fragment key={msg.id}>
                  <div className={`flex ${isMe ? "justify-end" : "justify-start"} ${hasReaction ? "mb-2" : ""}`}>
                    <div className="relative">
                      <div
                        className={`max-w-[75vw] rounded-md text-sm select-none ${
                          isVoiceNote
                            ? ""
                            : isMe
                            ? "bg-primary text-primary-foreground px-4 py-3"
                            : "bg-muted cursor-pointer px-4 py-3"
                        } ${!isMe && !isVoiceNote ? "active:scale-[0.98] transition-transform" : ""}`}
                        onClick={isVoiceNote ? undefined : () => handleMessageTap(msg)}
                        data-testid={`message-${msg.id}`}
                      >
                        {isVoiceNote ? (
                          <VoiceNoteBubble url={msg.content.slice(VOICE_PREFIX.length)} isMe={isMe} />
                        ) : (
                          <>
                            <p className="leading-relaxed">{renderMessageContent(msg.content, t)}</p>
                            <p className={`text-[10px] mt-1.5 leading-none opacity-60 ${isMe ? "text-primary-foreground" : "text-muted-foreground"}`} data-testid={`timestamp-${msg.id}`}>
                              {formatTimestamp(msg.createdAt as unknown as string | null)}
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
                  {(guidanceByIndex.map.get(i + 1) || []).map(g => (
                    <SystemGuidanceMessage key={g.id} testId={`guidance-${g.id}`}>{g.text}</SystemGuidanceMessage>
                  ))}
                </Fragment>
              );
            })}
            {(guidanceByIndex.map.get(guidanceByIndex.visibleMsgs.length) || []).map(g => (
              <SystemGuidanceMessage key={g.id} testId={`guidance-${g.id}`}>{g.text}</SystemGuidanceMessage>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {isCallRinging && iAmCaller ? (
            <div
              className="border-t"
              style={{ background: "linear-gradient(160deg, hsl(350 45% 14%) 0%, hsl(350 40% 9%) 100%)" }}
              data-testid={`call-ringing-${match.id}`}
            >
              <div className="flex flex-col items-center gap-4 py-7 px-5">
                {/* Pulsing icon */}
                <div className="relative flex items-center justify-center w-20 h-20">
                  <div
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ background: "hsl(350 45% 52% / 0.12)", animationDuration: "1.8s" }}
                  />
                  <div
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ background: "hsl(350 45% 52% / 0.08)", animationDuration: "2.4s", animationDelay: "0.3s" }}
                  />
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center"
                    style={{ background: "hsl(350 45% 52% / 0.18)", border: "1.5px solid hsl(350 45% 52% / 0.3)" }}
                  >
                    <Phone className="w-6 h-6 animate-pulse" style={{ color: "hsl(350 45% 72%)" }} />
                  </div>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white font-serif font-semibold text-base" data-testid={`text-outgoing-call-${match.id}`}>
                    {t("calling_name").replace("{name}", match.profile.firstName)}
                  </p>
                  <p className="text-white/40 text-xs">{t("waiting_to_pick_up")}</p>
                </div>
                <button
                  className="flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium active:scale-95 transition-all"
                  style={{
                    background: "hsl(0 60% 25% / 0.5)",
                    border: "1.5px solid hsl(0 60% 45% / 0.4)",
                    color: "hsl(0 60% 75%)",
                  }}
                  onClick={() => {
                    console.log("[MatchChat] CANCEL_CALL_REQUESTED", { matchId: match.id });
                    cancelCall.mutate();
                  }}
                  disabled={cancelCall.isPending}
                  data-testid={`button-cancel-call-${match.id}`}
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  {cancelCall.isPending ? t("cancelling_label") : t("cancel_call_btn")}
                </button>
                <p className="text-white/25 text-[11px]">{t("if_they_dont_pick_up")}</p>
              </div>
            </div>
          ) : isCallRinging && !iAmCaller ? (
            <div
              className="border-t"
              style={{ background: "linear-gradient(160deg, hsl(145 45% 12%) 0%, hsl(145 40% 8%) 100%)" }}
              data-testid={`call-incoming-inline-${match.id}`}
            >
              <div className="flex flex-col items-center gap-4 py-7 px-5">
                {/* Pulsing icon */}
                <div className="relative flex items-center justify-center w-20 h-20">
                  <div
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ background: "hsl(145 60% 40% / 0.12)", animationDuration: "1.8s" }}
                  />
                  <div
                    className="absolute inset-0 rounded-full animate-ping"
                    style={{ background: "hsl(145 60% 40% / 0.08)", animationDuration: "2.4s", animationDelay: "0.3s" }}
                  />
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center"
                    style={{ background: "hsl(145 60% 35% / 0.2)", border: "1.5px solid hsl(145 60% 45% / 0.35)" }}
                  >
                    <Phone className="w-6 h-6 animate-pulse" style={{ color: "hsl(145 60% 60%)" }} />
                  </div>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white font-serif font-semibold text-base" data-testid={`text-incoming-call-${match.id}`}>
                    {t("is_calling_label").replace("{name}", match.profile.firstName)}
                  </p>
                  <p className="text-white/40 text-xs">{t("answer_to_start_hint")}</p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium active:scale-95 transition-all"
                    style={{
                      background: "hsl(0 60% 22% / 0.5)",
                      border: "1.5px solid hsl(0 60% 42% / 0.4)",
                      color: "hsl(0 60% 72%)",
                    }}
                    onClick={() => inlineDeclineCall.mutate()}
                    disabled={inlineAnswerCall.isPending || inlineDeclineCall.isPending}
                    data-testid={`button-decline-inline-${match.id}`}
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    {t("decline_label")}
                  </button>
                  <button
                    className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-semibold active:scale-95 transition-all"
                    style={{
                      background: "linear-gradient(135deg, hsl(145 60% 36%), hsl(145 60% 28%))",
                      boxShadow: "0 4px 20px hsl(145 60% 32% / 0.45)",
                      border: "1.5px solid hsl(145 60% 52% / 0.3)",
                      color: "white",
                    }}
                    onClick={() => inlineAnswerCall.mutate()}
                    disabled={inlineAnswerCall.isPending || inlineDeclineCall.isPending}
                    data-testid={`button-answer-inline-${match.id}`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    {inlineAnswerCall.isPending ? t("answering_label") : t("answer_label")}
                  </button>
                </div>
              </div>
            </div>
          ) : isCallActive ? (
            <div className="p-5 border-t" data-testid={`call-active-banner-${match.id}`}>
              {isCallAnsweredStuck ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3 text-center" data-testid={`call-stuck-banner-${match.id}`}>
                  <div className="space-y-1">
                    <p className="font-medium text-sm text-amber-900" data-testid={`text-call-stuck-label-${match.id}`}>
                      Call seems stuck
                    </p>
                    <p className="text-xs text-amber-700">
                      The call overlay was lost or didn't connect. You can clear it and retry for free.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-400 text-amber-900 hover:bg-amber-100 w-full"
                    disabled={repairCall.isPending}
                    onClick={() => repairCall.mutate()}
                    data-testid={`button-repair-call-${match.id}`}
                  >
                    {repairCall.isPending ? t("clearing_label") : t("clear_retry_call")}
                  </Button>
                </div>
              ) : (
                <div className="text-center space-y-3">
                  <div className="relative w-16 h-16 mx-auto">
                    <div className="absolute inset-0 rounded-full bg-green-500/15 animate-pulse" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Phone className="w-6 h-6 text-green-600" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-sm" data-testid={`text-call-active-label-${match.id}`}>
                      {t("first_call_in_progress")}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("use_overlay_to_manage")}</p>
                  </div>
                </div>
              )}
            </div>
          ) : allCallsDone && finalChoice !== 'chat' ? (
            finalChoice === 'date' ? (
              <div>
                <div className="px-4 pt-3 pb-1">
                  <button onClick={() => setFinalChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back-to-final-options">
                    {isRTL ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />} {t("back_label")}
                  </button>
                </div>
                {matchDetail ? (
                  <ReadyToMeetInline detail={matchDetail} matchId={match.id} profileName={match.profile.firstName} />
                ) : (
                  <div className="p-4 flex justify-center"><div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>
                )}
              </div>
            ) : finalChoice === 'end' ? (
              <div className="p-4 border-t" data-testid={`final-end-confirm-${match.id}`}>
                <div className="rounded-2xl border border-destructive/15 bg-destructive/5 p-4 space-y-3">
                  <button onClick={() => setFinalChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {isRTL ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />} {t("back_label")}
                  </button>
                  <div className="text-center space-y-1">
                    <p className="font-semibold text-sm">{t("end_conversation_confirm")}</p>
                    <p className="text-xs text-muted-foreground">{t("removed_from_matches").replace("{name}", match.profile.firstName)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setFinalChoice(null)} data-testid={`button-cancel-end-final-${match.id}`}>{t("keep_btn")}</Button>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => removeMatch.mutate()} disabled={removeMatch.isPending} data-testid={`button-confirm-end-final-${match.id}`}>
                      {removeMatch.isPending ? t("removing_label") : t("end_conversation_btn")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 border-t" data-testid={`final-stage-card-${match.id}`}>
                <style>{`
                  @keyframes finalCardIn { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
                  .final-card-anim { animation: finalCardIn 0.26s ease both; }
                `}</style>
                <div className="final-card-anim space-y-3">
                  <div className="text-center space-y-1">
                    <Sparkles className="w-4 h-4 text-primary mx-auto" />
                    <p className="font-semibold text-sm">{t("whats_next_name").replace("{name}", match.profile.firstName)}</p>
                    <p className="text-xs text-muted-foreground">{t("completed_all_calls_hint")}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setFinalChoice('date')}
                      className="flex flex-col items-center gap-2 rounded-2xl p-3 text-center transition-all active:scale-[0.97]"
                      style={{ background: "hsl(155 25% 88%)", border: "1px solid hsl(155 25% 75%)" }}
                      data-testid={`button-plan-date-final-${match.id}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.65)" }}>
                        <Calendar className="w-4 h-4 text-green-700" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-green-700 leading-tight">{t("plan_date_btn")}</p>
                        <p className="text-[10px] mt-0.5" style={{ color: "hsl(155 25% 40%)" }}>{t("free_label")}</p>
                      </div>
                    </button>
                    <button
                      onClick={() => setFinalChoice('chat')}
                      className="flex flex-col items-center gap-2 rounded-2xl p-3 text-center transition-all active:scale-[0.97]"
                      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                      data-testid={`button-keep-chatting-final-${match.id}`}
                    >
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <MessageCircle className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold leading-tight">{t("keep_chatting_btn")}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{t("continue_label")}</p>
                      </div>
                    </button>
                    <button
                      onClick={() => setFinalChoice('end')}
                      className="flex flex-col items-center gap-2 rounded-2xl p-3 text-center transition-all active:scale-[0.97]"
                      style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                      data-testid={`button-end-conversation-final-${match.id}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "hsl(var(--background)/0.6)" }}>
                        <X className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground leading-tight">{t("end_label")}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{t("leave_gracefully_label")}</p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : postCallProgressReady && bothPlan ? (
            <div>
              <div className="px-4 pt-3 pb-1">
                <button onClick={() => setDateChoiceMut.mutate(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-back-date-plan-${match.id}`}>
                  {isRTL ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />} {t("back_label")}
                </button>
              </div>
              {matchDetail ? (
                <ReadyToMeetInline detail={matchDetail} matchId={match.id} profileName={match.profile.firstName} />
              ) : (
                <div className="p-4 flex justify-center"><div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" /></div>
              )}
            </div>
          ) : postCallProgressReady && iWaitingForThem ? (
            <div className="p-4 border-t" data-testid={`date-choice-waiting-${match.id}`}>
              <style>{`
                @keyframes datePlanIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                .date-plan-anim { animation: datePlanIn 0.26s ease both; }
              `}</style>
              <div className="date-plan-anim space-y-3">
                <div className="text-center space-y-1">
                  <Clock className="w-4 h-4 text-muted-foreground mx-auto" />
                  <p className="font-semibold text-sm">{t("date_choice_waiting_title")}</p>
                  <p className="text-xs text-muted-foreground">{t("date_choice_waiting_desc").replace("{name}", match.profile.firstName)}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setDateChoiceMut.mutate(null)}
                  disabled={setDateChoiceMut.isPending}
                  data-testid={`button-cancel-plan-${match.id}`}
                >
                  <MessageCircle className="w-3.5 h-3.5 me-1.5" /> {t("keep_messaging_btn")}
                </Button>
              </div>
            </div>
          ) : postCallProgressReady && !eitherKeep && myChoice === null ? (
            <div className="p-4 border-t" data-testid={`date-plan-choice-${match.id}`}>
              <style>{`
                @keyframes datePlanIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                .date-plan-anim { animation: datePlanIn 0.26s ease both; }
              `}</style>
              <div className="date-plan-anim space-y-3">
                <div className="text-center space-y-1">
                  <Calendar className="w-4 h-4 text-primary mx-auto" />
                  <p className="font-semibold text-sm">{t("date_plan_ready_title")}</p>
                  <p className="text-xs text-muted-foreground">{t("date_plan_ready_desc")}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    onClick={() => setDateChoiceMut.mutate('plan')}
                    disabled={setDateChoiceMut.isPending}
                    className="w-full"
                    data-testid={`button-plan-date-now-${match.id}`}
                  >
                    <Calendar className="w-3.5 h-3.5 me-1.5" /> {t("plan_date_btn")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDateChoiceMut.mutate('keep')}
                    disabled={setDateChoiceMut.isPending}
                    className="w-full"
                    data-testid={`button-keep-messaging-${match.id}`}
                  >
                    <MessageCircle className="w-3.5 h-3.5 me-1.5" /> {t("keep_messaging_btn")}
                  </Button>
                </div>
              </div>
            </div>
          ) : callStage === 0 && rawLimitReached && !hasMessageExtension && hasAvailableExtension && !dismissedExtension ? (
            <div className="p-4 border-t" data-testid={`extension-offer-${match.id}`}>
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-primary">{t("want_to_keep_going")}</p>
                  <p className="text-xs text-muted-foreground">{t("extension_offer_body")}</p>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismissedExtension(true)}
                    data-testid={`button-dismiss-extension-${match.id}`}
                  >
                    {t("not_now_btn")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => activateExtension.mutate()}
                    disabled={activateExtension.isPending}
                    data-testid={`button-activate-extension-${match.id}`}
                  >
                    {activateExtension.isPending ? t("activating_label") : t("add_5_messages_btn")}
                  </Button>
                </div>
              </div>
            </div>
          ) : callStage === 0 && isLimitReached ? (
            nextStepChoice === 'call' ? (
              <div>
                <div className="px-4 pt-3 pb-1">
                  <button onClick={() => setNextStepChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back-to-next-step">
                    {isRTL ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />} {t("back_label")}
                  </button>
                </div>
                <CallSchedulingCard
                  matchId={match.id}
                  matchName={match.profile.firstName}
                  allMessages={allMessages}
                  callStage={0}
                  startCallPending={startCall.isPending}
                  phoneCredits={phoneCredits}
                  onStartCall={() => {
                    console.log("[CALL_UI] CALL_REQUEST_STARTED", { matchId: match.id, callStage: 0, callType: "voice_1", role: "caller" });
                    startCall.mutate();
                  }}
                />
              </div>
            ) : nextStepChoice === 'end' ? (
              <div className="p-4 border-t" data-testid={`next-step-end-confirm-${match.id}`}>
                <div className="rounded-2xl border border-destructive/15 bg-destructive/5 p-4 space-y-3">
                  <button onClick={() => setNextStepChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {isRTL ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />} {t("back_label")}
                  </button>
                  <div className="text-center space-y-1">
                    <p className="font-semibold text-sm">{t("end_this_match_confirm")}</p>
                    <p className="text-xs text-muted-foreground">{t("removed_from_matches").replace("{name}", match.profile.firstName)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setNextStepChoice(null)} data-testid={`button-cancel-end-nextstep-${match.id}`}>{t("keep_btn")}</Button>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => removeMatch.mutate()} disabled={removeMatch.isPending} data-testid={`button-confirm-end-nextstep-${match.id}`}>
                      {removeMatch.isPending ? t("removing_label") : t("end_match_btn")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 border-t" data-testid={`next-step-card-${match.id}`}>
                <style>{`
                  @keyframes nextStepIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                  .next-step-anim { animation: nextStepIn 0.26s ease both; }
                `}</style>
                <div className="next-step-anim space-y-3">
                  <div className="text-center space-y-1">
                    <Phone className="w-4 h-4 text-primary mx-auto" />
                    <p className="font-semibold text-sm">{t("time_for_first_call")}</p>
                    <p className="text-xs text-muted-foreground">{t("reached_message_limit_call").replace("{name}", match.profile.firstName)}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setNextStepChoice('call')}
                      className="flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center transition-all active:scale-[0.97]"
                      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}
                      data-testid={`button-next-start-call-${match.id}`}
                    >
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                        <Phone className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-xs font-semibold leading-tight">{t("start_a_call_btn")}</p>
                      <span className="text-[10px] text-muted-foreground">{t("free_label")}</span>
                    </button>
                    <button
                      onClick={() => setNextStepChoice('end')}
                      className="flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center transition-all active:scale-[0.97]"
                      style={{ background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))" }}
                      data-testid={`button-next-end-match-${match.id}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "hsl(var(--background)/0.6)" }}>
                        <X className="w-4 h-4 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-muted-foreground leading-tight">{t("end_match_btn")}</p>
                      <span className="text-[10px] text-muted-foreground">{t("not_right_fit_label")}</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="p-3 border-t" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0.75rem))" }}>
              {isOtherTyping && (
                <div className="flex items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground" data-testid="text-typing-indicator">
                  <span className="flex gap-0.5 items-center">
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>{match.profile.firstName} {t("is_typing_label")}</span>
                </div>
              )}
              {postCallProgressReady && eitherKeep && (
                <div className="mb-3 pb-3 border-b border-border/50" data-testid={`date-plan-banner-${match.id}`}>
                  <button
                    onClick={() => setDateChoiceMut.mutate('plan')}
                    className="w-full flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-left hover:bg-primary/10 transition-colors"
                    data-testid={`button-plan-date-cta-${match.id}`}
                  >
                    <span className="text-xs text-muted-foreground">{t("plan_date_cta_hint")}</span>
                    <span className="text-xs font-medium text-primary flex items-center gap-1 shrink-0">
                      <Calendar className="w-3 h-3" /> {t("plan_date_btn")}
                    </span>
                  </button>
                </div>
              )}
              {postCallApproaching && (
                <StageHint>{t("post_call_approaching_hint").replace("{name}", match.profile.firstName)}</StageHint>
              )}
              {callStage === 0 && messagesRemaining <= 5 && messagesRemaining > 1 && (
                <StageHint>{t("really_connecting_hint")}</StageHint>
              )}
              {callStage === 0 && messagesRemaining === 1 && (
                <StageHint>{t("last_message_hint")}</StageHint>
              )}
              <div className="flex gap-2 items-end">
                {/* ── Input wrapper with embedded mic ── */}
                <div className="relative flex-1">
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
                      onChange={e => {
                        setMessage(e.target.value.slice(0, MAX_CHARS));
                        if (e.target.value.trim()) sendTyping();
                      }}
                      placeholder={t("write_meaningful_placeholder")}
                      className="resize-none min-h-[44px] max-h-[80px] text-sm pr-8"
                      onFocus={() => setInputFocused(true)}
                      onBlur={() => setInputFocused(false)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (message.trim()) { const c = message.trim(); setMessage(""); doSend(c); }
                        }
                      }}
                      data-testid={`input-message-${match.id}`}
                    />
                  )}
                  {/* Mic inside the input — hold to record, slide away to cancel */}
                  <button
                    onPointerDown={e => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      if (!voiceNotesUnlocked) { setPurchasePromptFeature("mic"); return; }
                      if (voicePhase === "idle") startRecording();
                    }}
                    onPointerUp={() => {
                      if (voicePhase === "recording") stopRecording();
                    }}
                    onPointerLeave={() => { if (voicePhase === "recording") cancelRecording(); }}
                    onPointerCancel={() => { if (voicePhase === "recording") cancelRecording(); }}
                    onContextMenu={e => e.preventDefault()}
                    className="absolute right-2 bottom-[10px] flex items-center justify-center select-none transition-transform active:scale-90"
                    data-testid={`button-mic-input-${match.id}`}
                    title={!voiceNotesUnlocked ? "Unlock voice notes" : voicePhase === "recording" ? "Release to send" : "Hold to record"}
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
                </div>
                {/* ✨ Conversation starters — hidden while typing */}
                {aiStartersEnabled && voicePhase === "idle" && !inputFocused && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setShowAIStarters(v => !v)}
                    className={showAIStarters ? "text-primary" : "text-muted-foreground"}
                    data-testid={`button-ai-starters-${match.id}`}
                  >
                    <Sparkles className="w-4 h-4" />
                  </Button>
                )}
                {/* 📞 Voice call shortcut — hidden while typing */}
                {!allCallsDone && voicePhase === "idle" && !inputFocused && (
                  <button
                    onClick={() => {
                      if ((phoneCredits ?? 0) > 0) startPaidCall.mutate({ isVideo: false });
                      else setPurchasePromptFeature("phone");
                    }}
                    disabled={startPaidCall.isPending}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90 disabled:opacity-50 hover:bg-muted/40"
                    data-testid={`button-phone-composer-${match.id}`}
                    title={(phoneCredits ?? 0) > 0 ? t("start_voice_call") : t("unlock_voice_calling")}
                  >
                    <Phone
                      className="w-[18px] h-[18px] transition-all duration-300"
                      style={!callCreditsData
                        ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                        : (phoneCredits ?? 0) > 0
                        ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.5 }}
                    />
                  </button>
                )}
                {/* ➤ Send / recording controls */}
                {sendVoiceNote.isPending ? (
                  <Button size="icon" disabled data-testid={`button-send-voice-note-${match.id}`}>
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </Button>
                ) : voicePhase === "recording" ? (
                  <Button size="icon" variant="ghost" onClick={cancelRecording} data-testid={`button-cancel-recording-${match.id}`}>
                    <X className="w-4 h-4" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { if (message.trim()) { const c = message.trim(); setMessage(""); doSend(c); } }}
                    disabled={!message.trim()}
                    data-testid={`button-send-${match.id}`}
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 text-end">
                {message.length}/{MAX_CHARS}
              </p>

              {/* ── AI Starters panel ── */}
              {showAIStarters && aiStartersEnabled && (
                <div className="mt-2 space-y-1.5" data-testid={`ai-starters-panel-${match.id}`}>
                  <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-primary" /> Conversation starters
                  </p>
                  {!aiStartersData ? (
                    <div className="flex gap-1.5 flex-wrap">
                      {[1,2,3].map(i => <div key={i} className="h-7 w-28 rounded-full bg-muted animate-pulse" />)}
                    </div>
                  ) : (
                    <div className="flex gap-1.5 flex-wrap">
                      {(aiStartersData.starters ?? []).map((s, i) => (
                        <button
                          key={i}
                          className="text-xs px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 active:scale-95 transition-all text-left leading-snug"
                          onClick={() => { setMessage(s); setShowAIStarters(false); }}
                          data-testid={`button-starter-${match.id}-${i}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Comment filter confirmation ── */}
              {filterConfirm && (
                <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2" data-testid={`filter-confirm-${match.id}`}>
                  <p className="text-xs text-amber-800 dark:text-amber-300 font-medium">
                    Your message may contain <strong>{filterConfirm.categories.join(", ")}</strong>. Send anyway?
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setFilterConfirm(null)} data-testid={`button-filter-cancel-${match.id}`}>
                      Edit message
                    </Button>
                    <Button
                      size="sm" className="h-7 text-xs"
                      onClick={() => {
                        const { content, tempId } = filterConfirm;
                        setFilterConfirm(null);
                        stopTyping();
                        forceScrollRef.current = true;
                        sendMessage.mutate({ content, tempId });
                      }}
                      data-testid={`button-filter-confirm-${match.id}`}
                    >
                      Send anyway
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
      </div>

      {showProfilePanel && (
        <div
          className="hidden lg:flex flex-col overflow-hidden flex-shrink-0"
          style={{
            width: 320,
            borderLeft: "1px solid hsl(var(--border))",
            animation: "sidebarSlideIn 0.22s cubic-bezier(0.22,1,0.36,1) both",
          }}
        >
          <style>{`
            @keyframes sidebarSlideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
            @keyframes sheetSlideUp { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
            @keyframes sheetFadeIn { from { opacity: 0; } to { opacity: 1; } }
          `}</style>
          <ProfilePanel profile={match.profile} onClose={() => setShowProfilePanel(false)} />
        </div>
      )}

      {showProfilePanel && (
        <div
          className="lg:hidden fixed inset-0 z-[60]"
          data-testid="profile-panel-mobile-sheet"
          style={{ animation: "sheetFadeIn 0.18s ease both" }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: "rgba(0,0,0,0.48)",
              // Skip backdrop-blur on mobile — forces full-screen GPU rasterisation
              // on every frame, severely degrading scroll/animation on iPhone.
              backdropFilter: isMobile ? undefined : "blur(4px)",
              WebkitBackdropFilter: isMobile ? undefined : "blur(4px)",
            }}
            onClick={() => setShowProfilePanel(false)}
          />
          <div
            className="absolute inset-x-0 bottom-0 overflow-hidden"
            style={{
              maxHeight: "88dvh",
              borderRadius: "20px 20px 0 0",
              background: "hsl(var(--background))",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
              animation: "sheetSlideUp 0.28s cubic-bezier(0.22,1,0.36,1) both",
            }}
          >
            <div className="flex justify-center pt-2.5 pb-1 flex-shrink-0">
              <div className="w-10 h-1 rounded-full" style={{ background: "hsl(var(--muted-foreground)/0.25)" }} />
            </div>
            <div style={{ height: "calc(88dvh - 20px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <ProfilePanel profile={match.profile} onClose={() => setShowProfilePanel(false)} />
            </div>
          </div>
        </div>
      )}
      <PurchasePrompt
        feature={purchasePromptFeature}
        onClose={() => setPurchasePromptFeature(null)}
        returnPath={window.location.pathname}
      />

      {chatGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.CHAT_FIRST_MESSAGE}
          userId={user?.id}
          title="15 messages each"
          body="Enough to spark chemistry before hearing their voice."
          delay={700}
        />
      )}
      {callGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.CALLS_FIRST_PHONE}
          userId={user?.id}
          icon="📞"
          title="Hear their voice."
          body="Your first call lasts 10 minutes. No pressure."
          delay={700}
        />
      )}
      {videoGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.CALLS_FIRST_VIDEO}
          userId={user?.id}
          icon="✨"
          title="Now you can be seen."
          body="Chemistry deserves more than text."
          delay={700}
        />
      )}
    </div>
  );
}

// Memoize to prevent re-renders from parent (MatchesTab) re-renders caused by
// the 5-second /api/matches poll in CallDetectors. React.memo with TanStack
// Query structural sharing means MatchChat only re-renders when its `match`
// prop data actually changes, not on every poll cycle.
const MatchChat = memo(_MatchChat);

const MatchCard = memo(function MatchCard({ match, unreadCount, userId, onOpen }: {
  match: MatchWithProfile;
  unreadCount: number;
  userId: string | null;
  onOpen: (matchId: string) => void;
}) {
  const { t } = useLanguageContext();
  useRenderCount("MatchCard");
  // Lazy-load avatar photo — photos are not included in /api/matches list response
  const { data: cardPhotosData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", match.profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const cardAvatarSrc = cardPhotosData?.photos?.[0];

  return (
    <Card
      className="cursor-pointer hover-elevate transition-all"
      onClick={() => onOpen(match.id)}
      data-testid={`button-expand-match-${match.id}`}
    >
      <div className="p-3.5 flex items-center gap-3">
        <div className="relative">
          <ProfileAvatar src={cardAvatarSrc} name={match.profile.firstName} className="w-12 h-12" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -end-1 bg-primary text-primary-foreground text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1" data-testid={`badge-unread-${match.id}`}>
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm truncate" data-testid={`text-match-name-${match.id}`}>
            {match.profile.firstName}, {match.profile.age}
          </h3>
          <p className="text-xs text-muted-foreground truncate mt-0.5" data-testid={`text-last-message-${match.id}`}>
            {match.lastMessage
              ? (match.lastMessage.senderId === userId ? t("you_label") : "") + renderMessageContent(match.lastMessage.content, t)
              : (match.profile.datingIntent ? translateIntent(match.profile.datingIntent, t) : t("start_conversation"))}
          </p>
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      </div>
    </Card>
  );
});

export default function Matches() {
  const { t } = useLanguageContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);

  // Dev-only page lifecycle instrumentation — no-op in production
  useRenderCount("MatchesPage");
  const { markDataReceived, markPageReady } = usePerfTrace("CONNECTIONS");
  // Stable handler — won't change across renders, so React.memo on MatchCard actually skips re-renders
  const handleMatchOpen = useCallback((matchId: string) => {
    setExpandedMatchId(matchId);
  }, []);
  const [activeTab, setActiveTab] = useState<"new" | "active">("new");
  // Belt-and-suspenders: kill any stale ringtone/ringback the moment the user
  // taps either internal tab. The primary guard is in CallDetectors (the rering
  // effect no longer re-arms sessions), but an explicit stop here ensures zero
  // audio leaks even if some future change touches the arming logic.
  const handleTabChange = useCallback((tab: "new" | "active") => {
    stopAllNonVoiceCallAudio("connections_tab_switch");
    setActiveTab(tab);
  }, []);
  const { data: matches, isLoading: matchesLoading, error: matchesError } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    // staleTime: Infinity (global default) — CallDetectors already owns this
    // query with refetchInterval:30s, so a staleTime override here would cause
    // an extra fetch on every tab switch once data is >30 s old.
    // placeholderData keeps the previous match list visible during background
    // refetches (e.g. after a new incoming message invalidates the cache).
    placeholderData: (prev) => prev,
  });

  // Batch-prefetch avatars on list arrival.
  // Mobile limit: 3 — just enough for the first visible items; decode pressure
  //   from 5+ simultaneous decode jobs at page load degrades first-frame speed.
  // Desktop limit: 10 — more cores and RAM available.
  useEffect(() => {
    if (!matches || matches.length === 0) return;
    const limit = isMobile ? 3 : 10;
    const ids = matches.slice(0, limit).map(m => m.profile?.userId).filter(Boolean) as string[];
    if (ids.length > 0) batchPrefetchPhotos(ids);
  }, [matches]);

  // Progressive rendering — mount only the first N cards immediately so the
  // page header and top items appear at first paint without waiting for all
  // MatchCard hooks to initialise at once (each card has its own useQuery hook).
  // After the list data arrives, scheduleIdle expands to the full list during
  // the browser's next idle window — imperceptible to the user.
  const [visibleCount, setVisibleCount] = useState<number>(isMobile ? 5 : Infinity);
  useEffect(() => {
    if (!isMobile || !matches || matches.length <= 5) return;
    scheduleIdle(() => setVisibleCount(Infinity));
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  // Perf instrumentation — dev-only, no-op in production
  useEffect(() => {
    if (matches) markDataReceived({ count: matches.length });
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!matchesLoading && matches) markPageReady({ count: matches.length });
  }, [matchesLoading, matches]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Defensive call-state sweep on tab activation ─────────────────────────
  // When the Connections tab becomes visible (isActive: false → true), scan
  // the /api/matches cache and clear any stale call fields for sessions that
  // are already known-cancelled.  A background 10 s poll may have written
  // stale DB data (callStartedAt still set) to the cache while this tab was
  // hidden.  Without this sweep those stale fields would immediately mount
  // ActiveCallOverlay / IncomingCallOverlay — calling getUserMedia() and
  // playing ringtone/ringback — even though no call is actually in progress.
  const _tabSweepPrevRef = useRef(false);
  useEffect(() => {
    const wasActive = _tabSweepPrevRef.current;
    _tabSweepPrevRef.current = isActive;
    if (!isActive || wasActive) return; // only fires on false → true transition

    const cached = queryClient.getQueryData<any[]>(["/api/matches"]);
    if (!cached) return;

    const hasStaleCalls = cached.some(
      m => m.callStartedAt && m.callSessionId && isCallSessionCancelled(m.id, m.callSessionId),
    );
    if (!hasStaleCalls) return;

    console.log("[CALL_BOOT] matches-tab sweep: clearing stale call state from cache");
    queryClient.setQueryData<any[]>(["/api/matches"], cached.map(m => {
      if (!m.callStartedAt || !m.callSessionId) return m;
      if (!isCallSessionCancelled(m.id, m.callSessionId)) return m;
      console.log("[CALL_BOOT] matches-tab sweep cleared", { matchId: m.id, callSessionId: m.callSessionId });
      return { ...m, callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null };
    }));
  }, [isActive, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: spinRequestsData, isLoading: requestsLoading, error: requestsError } = useQuery<SpinRequestsData>({
    queryKey: ["/api/spin-requests"],
    refetchInterval: isActive ? 30_000 : false,
    // staleTime: Infinity (global default) — refetchInterval above handles
    // freshness; a short staleTime would add a redundant fetch on every tab switch.
  });

  // Only block on matches loading — spin-requests show a skeleton in their section independently
  const isLoading = matchesLoading;
  const fetchFailed = !!matchesError;
  const incomingRequests = spinRequestsData?.incoming || [];
  const outgoingPending = useMemo(
    () => spinRequestsData?.outgoing?.filter(r => r.status === "pending") || [],
    [spinRequestsData],
  );
  const matchIds = useMemo(() => (matches || []).map(m => m.id), [matches]);


  const handleNewBackgroundMessage = useCallback((matchId: string) => {
    // Do NOT invalidate the full /api/matches list here — the 5s App.tsx poll
    // updates lastMessage within 5 s and useRealtimeMessages patches it instantly
    // for open chats.  A broad list invalidation on every background message
    // causes a redundant network round-trip on each incoming message.
    queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId], exact: true });
  }, [queryClient]);

  // `isActive` gates channel creation — when the Connections tab is hidden
  // (display:none via PersistentTabs) all unread WebSocket channels are torn
  // down.  They are rebuilt the moment the user taps back to this tab.
  const { unreadCounts, markRead } = useUnreadCounts(matchIds, user?.id || null, expandedMatchId, handleNewBackgroundMessage, isActive);
  const { setBadge, syncBadgeFromServer } = usePushNotifications();



  // ─── STEP 2: Minimal render — confirms routing/layout works ─────────────────
  const STEP2_MINIMAL = false;
  if (STEP2_MINIMAL) {
    return (
      <div className="flex-1 p-6 space-y-3" data-testid="matches-diagnostic">
        <h2 className="text-lg font-semibold">Matches — Page Rendered ✓</h2>
        <div className="text-xs font-mono text-muted-foreground space-y-0.5">
          <div>userId: {user?.id?.slice(0, 8) ?? "—"}</div>
          <div>isLoading: {String(matchesLoading)}</div>
          <div>isError: {String(!!matchesError)}</div>
          <div>matches: {matches?.length ?? "—"}</div>
        </div>
      </div>
    );
  }

  const newConnections = useMemo(() => (matches || []).filter(m => !m.lastMessage), [matches]);
  const activeChats    = useMemo(() => (matches || []).filter(m => !!m.lastMessage), [matches]);
  const totalUnread    = useMemo(() => Object.values(unreadCounts).reduce((sum, n) => sum + n, 0), [unreadCounts]);

  // ── App-icon badge: reflect real-time unread count while app is open ───────
  // On cold open: sync from server (covers messages received while closed).
  // While running: keep badge in sync with live Realtime unread counts.
  useEffect(() => { syncBadgeFromServer(); }, [syncBadgeFromServer]);
  useEffect(() => { setBadge(totalUnread); }, [totalUnread, setBadge]);

  const connectionCount = matches?.length || 0;
  const atLimit = connectionCount >= MAX_CONNECTIONS;
  const hasContent = (matches && matches.length > 0) || incomingRequests.length > 0 || outgoingPending.length > 0 || requestsLoading;

  const debugLine = (extra?: string) => (
    <div className="px-4 py-1.5 text-[10px] text-muted-foreground/60 font-mono bg-muted/30 border-b" data-testid="debug-line">
      Logged in as: {user?.id || "—"} · Matches loaded: {matches?.length ?? "—"}{extra ? ` · ${extra}` : ""}
    </div>
  );

  if (fetchFailed) {
    const errMsg = matchesError?.message || requestsError?.message || t("could_not_load_connections");
    console.error("MATCHES_FETCH_ERROR", errMsg);
    return (
      <div className="flex-1 flex flex-col">
        {debugLine(`Error: ${errMsg}`)}
        <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
            <Moon className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="font-serif text-xl font-bold" data-testid="text-matches-error">{t("something_went_wrong")}</h2>
          <p className="text-muted-foreground text-sm" data-testid="text-matches-error-detail">{errMsg}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
              queryClient.invalidateQueries({ queryKey: ["/api/spin-requests"] });
            }}
            data-testid="button-retry-matches"
          >
            Try Again
          </button>
        </div>
      </div>
      </div>
    );
  }

  if (!isLoading && !hasContent) {
    return (
      <div className="flex-1 flex flex-col">
        {debugLine()}
        <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <LulouFlowerIcon className="w-8 h-8 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-matches">{t("no_connections_yet")}</h2>
          <p className="text-muted-foreground text-sm">
            {t("wheel_or_discover_empty_desc")}
          </p>
        </div>
      </div>
      </div>
    );
  }

  const selectedMatch = expandedMatchId ? matches?.find(m => m.id === expandedMatchId) : null;

  if (selectedMatch) {
    return (
      <div className="fixed inset-0 z-50 bg-background flex flex-col" data-testid="chat-focused-view">
        <MatchChat
          match={selectedMatch}
          expanded={true}
          onToggleExpand={() => setExpandedMatchId(null)}
          unreadCount={unreadCounts[selectedMatch.id] || 0}
          onMarkRead={() => {
            markRead(selectedMatch.id);
            fetch(`/api/messages/${selectedMatch.id}/mark-read`, {
              method: "POST", credentials: "include",
              headers: { "Content-Type": "application/json" },
            }).then(r => r.json()).then(({ total }) => {
              setBadge(typeof total === "number" ? Math.max(0, total) : 0);
            }).catch(() => {});
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {debugLine()}
      <div className="p-6 space-y-6 max-w-lg mx-auto w-full">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="font-serif text-2xl font-bold" data-testid="text-matches-title">{t("your_connections_title")}</h1>
          <Badge variant={atLimit ? "destructive" : "secondary"} className="text-xs" data-testid="badge-connection-count">
            {connectionCount}/{MAX_CONNECTIONS}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {atLimit && t("connection_limit_reached")}
          {!atLimit && incomingRequests.length > 0 && (incomingRequests.length === 1 ? t("n_pending_request").replace("{n}", "1") : t("n_pending_requests").replace("{n}", String(incomingRequests.length)))}
          {!atLimit && incomingRequests.length > 0 && matches && matches.length > 0 && " · "}
          {!atLimit && matches && matches.length > 0 && (matches.length === 1 ? t("n_connection_one").replace("{n}", "1") : t("n_connections_many").replace("{n}", String(matches.length)))}
        </p>
      </div>

      {/* Inline skeleton while /api/matches loads — page header is always visible */}
      {isLoading && (
        <div className="space-y-3" data-testid="section-matches-loading">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-20 w-full rounded-md" />
          ))}
        </div>
      )}

      {requestsLoading && (
        <div className="space-y-3" data-testid="section-requests-loading">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-20 w-full rounded-md" />
        </div>
      )}

      {!requestsLoading && incomingRequests.length > 0 && (
        <div className="space-y-3" data-testid="section-incoming-requests">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-sm">{t("incoming_requests_title")}</h2>
            <Badge variant="secondary" className="text-xs">{incomingRequests.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("incoming_requests_desc")}
          </p>
          {incomingRequests.map(req => (
            <SpinRequestCard key={req.id} request={req} type="incoming" />
          ))}
        </div>
      )}

      {!requestsLoading && outgoingPending.length > 0 && (
        <div className="space-y-3" data-testid="section-outgoing-requests">
          <div className="flex items-center gap-2">
            <Send className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-muted-foreground">{t("sent_requests_title")}</h2>
            <Badge variant="outline" className="text-xs">{outgoingPending.length}</Badge>
          </div>
          {outgoingPending.map(req => (
            <SpinRequestCard key={req.id} request={req} type="outgoing" />
          ))}
        </div>
      )}

      {matches && matches.length > 0 && (
        <div data-testid="section-match-list">
          <div className="flex border-b mb-4" data-testid="tabs-connections">
            <button
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === "new" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground"}`}
              onClick={() => handleTabChange("new")}
              data-testid="tab-new-connections"
            >
              {t("new_connections_tab")}
              {newConnections.length > 0 && (
                <Badge variant="secondary" className="text-xs px-1.5 h-4">{newConnections.length}</Badge>
              )}
            </button>
            <button
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === "active" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground"}`}
              onClick={() => handleTabChange("active")}
              data-testid="tab-active-chats"
            >
              {t("active_chats_tab")}
              {totalUnread > 0 && (
                <Badge variant="destructive" className="text-xs px-1.5 h-4">{totalUnread}</Badge>
              )}
            </button>
          </div>

          {activeTab === "new" && (
            <div className="space-y-2" data-testid="tab-panel-new">
              {newConnections.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {activeChats.length > 0 ? t("all_chats_have_active") : t("no_new_connections")}
                </p>
              ) : (
                newConnections.slice(0, visibleCount).map(match => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    unreadCount={unreadCounts[match.id] || 0}
                    userId={user?.id || null}
                    onOpen={handleMatchOpen}
                  />
                ))
              )}
            </div>
          )}

          {activeTab === "active" && (
            <div className="space-y-2" data-testid="tab-panel-active">
              {activeChats.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {t("no_active_chats_yet")}
                </p>
              ) : (
                activeChats.slice(0, visibleCount).map(match => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    unreadCount={unreadCounts[match.id] || 0}
                    userId={user?.id || null}
                    onOpen={handleMatchOpen}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}

      </div>
    </div>
  );
}
