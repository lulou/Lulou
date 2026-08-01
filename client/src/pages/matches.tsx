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
import { apiRequest, batchPrefetchPhotos, getAuthHeaders, API_BASE } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/hooks/use-tab-active";
import { isCallSessionCancelled, markCallSessionCancelled, clearCancelledSession, isSelfCancelled } from "@/lib/cancelled-calls";
import { requestMicStream, prewarmMicStream, wasMicGrantedBefore, getMicPermState, releaseMicStream, type MicPermState } from "@/lib/mic-permission";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { useUnreadCounts } from "@/hooks/use-unread-counts";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Phone, Video, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, PhoneOff, Clock, Check, X, Sparkles, Calendar, Heart, PhoneForwarded, Moon, User, Mic, Loader2, Pause, Play, BadgeCheck, RotateCcw } from "lucide-react";
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

function renderMessageContent(content: string | null | undefined, t: (k: any) => string): string {
  if (!content) return "";
  if (content.startsWith(VOICE_PREFIX)) {
    return "🎤 Voice message";
  }
  if (content.startsWith(PHONE_PREFIX)) {
    return `${t("my_number_is")} ${content.slice(PHONE_PREFIX.length)}`;
  }
  if (content.startsWith("__CALL_EVENT__:")) {
    try {
      const ev = JSON.parse(content.slice("__CALL_EVENT__:".length));
      if (ev.type === "cancelled" || ev.type === "missed") return "📞 Missed call";
      if (ev.type === "declined") return "📞 Call declined";
      if (ev.type === "ended")    return "📞 Call ended";
    } catch {}
    return "📞 Call";
  }
  if (content.startsWith("__SCHEDULE__:") || content.startsWith("__DATE_")) {
    return "";
  }
  // Safety net: any other unrecognised __ protocol string must never render
  // as raw chat text. __VOICE__ and __PHONE__ are already handled above.
  if (content.startsWith("__")) {
    return "";
  }
  return content;
}

// Renders the conversation-list preview for a match's last message,
// with perspective-aware call event text (isMe derived from senderId vs userId).
function renderMatchPreview(
  msg: { senderId: string | null; content: string | null | undefined },
  userId: string | null | undefined,
  otherFirstName: string | null | undefined,
  t: (k: any) => string,
): string {
  const content = msg.content ?? "";
  if (content.startsWith("__CALL_EVENT__:")) {
    try {
      const ev = JSON.parse(content.slice("__CALL_EVENT__:".length));
      const isMe = msg.senderId === userId;
      if (ev.type === "cancelled" || ev.type === "missed") {
        return isMe
          ? `📞 You called ${otherFirstName || "them"}`
          : `📞 Missed call from ${ev.callerName || otherFirstName || "them"}`;
      }
      if (ev.type === "declined") {
        return isMe
          ? `📞 ${ev.calleeName || otherFirstName || "They"} declined your call`
          : `📞 You declined ${ev.callerName || otherFirstName || "their"} call`;
      }
      if (ev.type === "ended")    return "📞 Call ended";
    } catch {}
    return "📞 Call";
  }
  const prefix = msg.senderId === userId ? t("you_label") : "";
  return prefix + renderMessageContent(content, t);
}

type PendingVoiceNote = {
  tempId: string;
  blobUrl: string;
  blob: Blob;
  mimeType: string;
  tStart: number;
  status: "sending" | "failed";
};

// Set false once Bug 2 (caller-cancel race) is confirmed fixed in production.
const DEBUG_CALLS = true;

// ── Voice Debug Panel ─────────────────────────────────────────────────────────
// Visible only when import.meta.env.DEV=true OR when ?voicedebug=1 is in the URL.
// Shows all voice note lifecycle state on-screen so iPhone issues can be diagnosed
// without a desktop console. Tap "Copy Voice Note Debug" to get a full text dump.

type VoiceDebugLive = {
  // Composer geometry — captured at each recording phase
  composerBefore: string;
  composerDuring: string;
  composerAfter: string;
  // Composer computed CSS snapshot — position/bottom/transform/margin/padding
  // that could cause a visual shift. Captured at key moments.
  composerCSSBefore: string;
  composerCSSDuring: string;
  composerCSSAfter: string;
  // Which JSX branch is active
  voicePhase: string;
  // Blob info
  blobSize: number;
  blobType: string;
  blobDurationMs: number;   // ms from recorder.start() to recorder.onstop()
  // Upload info
  uploadStatus: string;
  uploadBodyType: string;   // "XHR" | "fetch" | "none"
  uploadStartMs: number;    // performance.now() when fetch/XHR begins
  uploadFailMs: number;     // performance.now() when fetch/XHR fails
  uploadErrName: string;    // err.constructor.name or err.name
  uploadError: string;      // err.message
  uploadRespBody: string;   // first 300 chars of server response (on error)
  // Post-upload
  insertStatus: string;
  playbackUrlStatus: string;
  // Pointer + MediaRecorder
  lastPointerEvent: string;
  mrState: string;
};

// Helper: snapshot computed CSS properties that could cause composer layout shifts.
// Called synchronously at pointer-down (before), after setIsRecording (during),
// and after recording ends (after). Returns a compact single-line string.
function snapshotComposerCSS(el: HTMLElement | null): string {
  if (!el) return "(no element)";
  const s = window.getComputedStyle(el);
  // Inline styles take priority — grab both computed and inline
  const inlinePos = el.style.position || "(none)";
  const inlineBot = el.style.bottom || "(none)";
  const inlineMinH = el.style.minHeight || "(none)";
  return (
    `pos=${s.position}(inline:${inlinePos}) ` +
    `bot=${s.bottom}(inline:${inlineBot}) ` +
    `minH=${s.minHeight}(inline:${inlineMinH}) ` +
    `h=${s.height} ` +
    `mb=${s.marginBottom} pb=${s.paddingBottom} ` +
    `transform=${s.transform === "none" ? "none" : s.transform.slice(0, 30)} ` +
    `zIndex=${s.zIndex}`
  );
}

function VoiceDebugPanel({
  live,
  log,
  keyboardOpen,
  inputFocused,
  isRecording,
  mediaRecorderRef,
  composerRef,
  onClear,
  onSnapCSS,
}: {
  live: React.MutableRefObject<VoiceDebugLive>;
  log: string[];
  keyboardOpen: boolean;
  inputFocused: boolean;
  isRecording: boolean;
  mediaRecorderRef: React.MutableRefObject<MediaRecorder | null>;
  composerRef: React.MutableRefObject<HTMLDivElement | null>;
  onClear: () => void;
  onSnapCSS: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const vv = window.visualViewport;
  const l = live.current;
  const mrState = mediaRecorderRef.current?.state ?? "none";

  const allText = [
    `=== LIVE SNAPSHOT ${new Date().toISOString()} ===`,
    `UA: ${navigator.userAgent}`,
    ``,
    `=== VIEWPORT / KEYBOARD ===`,
    `keyboardOpen: ${keyboardOpen}  inputFocused: ${inputFocused}`,
    `isRecording: ${isRecording}  voicePhase: ${l.voicePhase || "idle"}  MR: ${mrState}`,
    `VP h=${vv ? Math.round(vv.height) : "N/A"} offsetTop=${vv ? Math.round(vv.offsetTop) : "N/A"} scale=${vv ? vv.scale.toFixed(3) : "N/A"}`,
    `window.innerHeight=${window.innerHeight} screen.height=${window.screen.height} outerHeight=${window.outerHeight}`,
    ``,
    `=== COMPOSER GEOMETRY ===`,
    `BEFORE rect:  ${l.composerBefore || "not captured"}`,
    `DURING rect:  ${l.composerDuring || "not captured"}`,
    `AFTER  rect:  ${l.composerAfter || "not captured"}`,
    ``,
    `=== COMPOSER CSS (computed + inline) ===`,
    `BEFORE css:   ${l.composerCSSBefore || "not captured"}`,
    `DURING css:   ${l.composerCSSDuring || "not captured"}`,
    `AFTER  css:   ${l.composerCSSAfter || "not captured"}`,
    `LIVE   css:   ${snapshotComposerCSS(composerRef.current)}`,
    ``,
    `=== BLOB ===`,
    `size: ${l.blobSize}B  type: "${l.blobType}"  durationMs: ${l.blobDurationMs || 0}`,
    ``,
    `=== UPLOAD ===`,
    `status: ${l.uploadStatus || "idle"}`,
    `bodyType: ${l.uploadBodyType || "none"}  startMs: ${l.uploadStartMs || 0}`,
    `failMs: ${l.uploadFailMs || 0}  (elapsed: ${l.uploadStartMs && l.uploadFailMs ? l.uploadFailMs - l.uploadStartMs : 0}ms)`,
    `errName: ${l.uploadErrName || "none"}`,
    `errMessage: ${l.uploadError || "none"}`,
    `respBody: ${l.uploadRespBody || "none"}`,
    `insert: ${l.insertStatus || "idle"}`,
    `playback: ${l.playbackUrlStatus || "idle"}`,
    ``,
    `=== POINTER ===`,
    `lastPointer: ${l.lastPointerEvent || "none"}`,
    ``,
    `=== EVENT LOG (newest first) ===`,
    ...log,
  ].join("\n");

  const handleCopy = () => {
    // On iOS Safari, navigator.share() is far more reliable than clipboard.
    // It lets the user send the dump to Notes, Messages, Mail, etc.
    if (navigator.share) {
      navigator.share({ title: "Voice Debug Dump", text: allText })
        .catch(() => {
          // User dismissed share sheet — fall through to clipboard
          copyToClipboard();
        });
      return;
    }
    copyToClipboard();
  };
  const copyToClipboard = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(allText)
        .then(() => { alert("✅ Copied! Paste in chat."); })
        .catch(() => { fallbackCopy(); });
    } else {
      fallbackCopy();
    }
  };
  const fallbackCopy = () => {
    // Last resort: put text in a textarea and execCommand
    const ta = document.createElement("textarea");
    ta.value = allText;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); alert("✅ Copied!"); }
    catch { prompt("Select all & copy:", allText); }
    document.body.removeChild(ta);
  };

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 99999,
      background: "rgba(0,0,0,0.95)",
      color: "#00ff88",
      fontSize: 9,
      fontFamily: "'Courier New', monospace",
      lineHeight: 1.35,
      maxHeight: "40vh",
      overflowY: "auto",
      borderBottom: "2px solid #00ff88",
    }}>
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: "4px 6px",
        background: "rgba(0,0,0,0.7)",
        position: "sticky",
        top: 0,
        zIndex: 1,
      }}>
        <button
          onClick={handleCopy}
          style={{ background: "#00ff88", color: "#000", border: "none", borderRadius: 3, padding: "4px 10px", fontSize: 11, fontWeight: "bold", cursor: "pointer", flex: "1 0 auto" }}
        >
          📋 Copy Debug Dump
        </button>
        <button
          onClick={onSnapCSS}
          style={{ background: "#00aaff", color: "#000", border: "none", borderRadius: 3, padding: "4px 8px", fontSize: 10, fontWeight: "bold", cursor: "pointer" }}
          title="Snapshot current composer CSS to LIVE css line above"
        >
          📸 Snap CSS
        </button>
        <button
          onClick={onClear}
          style={{ background: "#ff4444", color: "#fff", border: "none", borderRadius: 3, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}
        >
          Clear
        </button>
      </div>
      <pre style={{ margin: 0, padding: "4px 8px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {allText}
      </pre>
    </div>
  );
}

// Module-level coordinator: only one VoiceNoteBubble plays at a time.
// When a bubble starts playing it stores its pause callback here.
// The next bubble to start will call it first, pausing the previous.
let _vnGlobalPause: (() => void) | null = null;

function VoiceNoteBubble({ url, isMe, status, onRetry, onLoadStateChange }: {
  url: string;
  isMe: boolean;
  status?: "sending" | "failed";
  onRetry?: () => void;
  onLoadStateChange?: (state: string, url: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // "loading" = waiting for metadata; "ready" = playable; "retrying" = CDN not ready yet; "error" = gave up
  const [loadState, setLoadState] = useState<"loading" | "ready" | "retrying" | "error">("loading");
  // Incrementing this key remounts the <audio> element, forcing a fresh network request on retry
  const [audioKey, setAudioKey] = useState(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tLoadStartRef = useRef(Date.now());
  // Direct ref to the audio element — avoids fragile document.getElementById lookups
  // which silently return null if the element isn't in the DOM at the exact moment of query.
  const audioRef = useRef<HTMLAudioElement>(null);
  // Stable ref to this bubble's pause callback — registered in the global coordinator on play.
  const myPauseRef = useRef<() => void>(() => { audioRef.current?.pause(); });

  // Reset load state whenever the URL or status changes (e.g. optimistic → real message)
  useEffect(() => {
    setLoadState("loading");
    setDuration(0);
    setCurrentTime(0);
    setPlaying(false);
    retryCountRef.current = 0;
    tLoadStartRef.current = Date.now();
    setAudioKey(k => k + 1);
    return () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report load state changes to parent debug panel (noop when not in debug mode)
  useEffect(() => {
    console.log(`[VOICE_NOTE_PIPELINE] playback loadState="${loadState}" url="${url.slice(0, 60)}"`);
    onLoadStateChange?.(loadState, url);
  }, [loadState]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAudioError = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    // While the bubble is in "sending" state, the blob URL is always valid — suppress.
    if (status === "sending") return;
    const a = e.target as HTMLAudioElement;
    const mediaErr = a.error;
    const errCode = mediaErr?.code ?? -1;
    const errMsg = mediaErr?.message ?? "unknown";
    console.error(`[VOICE_NOTE_PLAYBACK] error code=${errCode} message="${errMsg}" src="${url.slice(0, 80)}" readyState=${a.readyState} networkState=${a.networkState}`);
    // For real CDN URLs, Supabase storage edge propagation can take a moment.
    // Exponential backoff: fast first retry (500ms), backing off to 4s max.
    const RETRY_DELAYS_MS = [500, 800, 1500, 2500, 4000];
    const MAX_RETRIES = RETRY_DELAYS_MS.length;
    if (retryCountRef.current < MAX_RETRIES) {
      const delayMs = RETRY_DELAYS_MS[retryCountRef.current];
      retryCountRef.current += 1;
      console.log(`[VOICE_NOTE_PIPELINE] playback failed (code=${errCode} msg="${errMsg}") — retry ${retryCountRef.current}/${MAX_RETRIES} in ${delayMs}ms url="${url.slice(0, 60)}"`);
      setLoadState("retrying");
      retryTimerRef.current = setTimeout(() => {
        setAudioKey(k => k + 1); // remounts <audio>, triggers a fresh fetch of the CDN URL
      }, delayMs);
    } else {
      console.error(`[VOICE_NOTE_PIPELINE] playback failed permanently (code=${errCode} msg="${errMsg}") after ${MAX_RETRIES} retries url="${url.slice(0, 60)}"`);
      setLoadState("error");
    }
  };

  // Toggle play/pause.
  // Uses audioRef (direct React ref) — NOT document.getElementById, which was the previous
  // silent-failure point: getElementById returned null whenever the element hadn't yet been
  // committed to the DOM (key change cycle) or when multiple bubbles shared the same ID.
  const toggle = () => {
    const a = audioRef.current;
    console.log(`[VOICE_NOTE_PLAYBACK] play tapped — ref=${a ? "ok" : "NULL"} playing=${playing} loadState=${loadState} src="${url.slice(0, 80)}"`);
    if (!a) {
      console.error("[VOICE_NOTE_PLAYBACK] audio ref is null — element not mounted yet");
      return;
    }
    console.log(`[VOICE_NOTE_PLAYBACK] audio src="${a.src.slice(0, 80)}" readyState=${a.readyState} networkState=${a.networkState} paused=${a.paused}`);
    if (playing) {
      a.pause();
    } else {
      // Pause any other currently playing voice note first (one-at-a-time policy).
      if (_vnGlobalPause && _vnGlobalPause !== myPauseRef.current) {
        _vnGlobalPause();
      }
      _vnGlobalPause = myPauseRef.current;
      // On iOS, play() triggers the audio load (since preload is effectively "none").
      // onLoadedMetadata fires when ready → loadState becomes "ready" → duration appears.
      console.log("[VOICE_NOTE_PLAYBACK] play() called");
      a.play().then(() => {
        console.log("[VOICE_NOTE_PLAYBACK] play() resolved — playback started");
      }).catch((playErr: Error) => {
        console.error(`[VOICE_NOTE_PLAYBACK] play() rejected: ${playErr.name}: ${playErr.message}`);
        // Any rejection is visible — show error state so user can tap to retry
        setLoadState("error");
      });
    }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const progress = duration > 0 ? currentTime / duration : 0;
  // Remaining time (for display while playing, iMessage-style)
  const remaining = duration > 0 ? Math.max(0, duration - currentTime) : 0;
  // Show play button even while uploading (blob URL is immediately playable by the sender).
  // Only hide for hard failures. iOS requires a user gesture to trigger audio loading.
  const showPlayBtn = status !== "failed" && loadState !== "error";

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl min-w-[180px] max-w-[240px] ${
        isMe ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
      }`}
      data-testid="voice-note-bubble"
    >
      {/* Audio element — always rendered (even during "sending") so the sender can tap play
          on the local blob URL before the CDN upload completes.
          ref={audioRef} gives toggle() a direct React handle — no getElementById needed.
          preload="auto" is set but iOS Safari ignores it; actual load starts on play(). */}
      <audio
        ref={audioRef}
        key={audioKey}
        src={url}
        preload="auto"
        onPlay={() => { console.log("[VOICE_NOTE_PLAYBACK] canplay fired — audio is playing"); setPlaying(true); }}
        onPause={() => { setPlaying(false); if (_vnGlobalPause === myPauseRef.current) _vnGlobalPause = null; }}
        onEnded={() => { setPlaying(false); setCurrentTime(0); if (_vnGlobalPause === myPauseRef.current) _vnGlobalPause = null; }}
        onLoadedMetadata={e => {
          const d = (e.target as HTMLAudioElement).duration || 0;
          const loadMs = Date.now() - tLoadStartRef.current;
          console.log(`[VOICE_NOTE_PLAYBACK] canplay fired — loadedMetadata duration=${d.toFixed(2)}s loadMs=${loadMs}ms`);
          console.log(`[VOICE_NOTE_SPEED] audio canplay — loadMs=${loadMs}ms duration=${d.toFixed(2)}s`);
          setDuration(d);
          setLoadState("ready");
        }}
        onCanPlay={e => {
          // Backup for iOS: canplay fires when enough data is available to start playback.
          // This can fire instead of / before loadedmetadata on some iOS Safari versions.
          if (loadState !== "ready") {
            const d = (e.target as HTMLAudioElement).duration || 0;
            const loadMs = Date.now() - tLoadStartRef.current;
            console.log(`[VOICE_NOTE_PLAYBACK] canplay fired — canPlay duration=${d.toFixed(2)}s loadMs=${loadMs}ms`);
            console.log(`[VOICE_NOTE_SPEED] audio canplay — loadMs=${loadMs}ms duration=${d.toFixed(2)}s`);
            setDuration(d);
            setLoadState("ready");
          }
        }}
        onTimeUpdate={e => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
        onError={handleAudioError}
        style={{ display: "none" }}
      />

      {status === "failed" ? (
        /* ── Upload failed — user can retry ── */
        <>
          <button
            onClick={e => { e.stopPropagation(); onRetry?.(); }}
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: isMe ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)" }}
            data-testid="button-voice-note-retry"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] opacity-70">Failed — tap to retry</p>
          </div>
          <Mic className="w-3 h-3 shrink-0 opacity-40" />
        </>
      ) : loadState === "error" ? (
        /* ── Hard error after retries exhausted ── */
        <>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: isMe ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)" }}>
            <button
              onClick={e => { e.stopPropagation(); retryCountRef.current = 0; setAudioKey(k => k + 1); setLoadState("loading"); }}
              data-testid="button-voice-note-reload"
              title="Reload"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] opacity-60 italic">Tap to reload</p>
          </div>
          <Mic className="w-3 h-3 shrink-0 opacity-40" />
        </>
      ) : showPlayBtn ? (
        /* ── Play / loading / ready / sending state ──
           The play button is shown even while uploading so the sender can listen immediately.
           While loading (CDN not ready yet), a subtle spinner overlays the icon.
           A pulsing badge in the corner indicates the upload is still in progress. */
        <>
          <div className="relative shrink-0">
            <button
              onClick={e => { e.stopPropagation(); toggle(); }}
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: isMe ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)", transition: "opacity 120ms ease" }}
              data-testid="button-voice-note-play"
            >
              {playing ? (
                <Pause className="w-3.5 h-3.5" />
              ) : loadState === "loading" || loadState === "retrying" ? (
                <Play className="w-3.5 h-3.5 opacity-60" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
            </button>
            {/* Spinner overlay while loading from CDN */}
            {(loadState === "loading" || loadState === "retrying") && !playing && (
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <Loader2 className="w-6 h-6 animate-spin opacity-25" />
              </span>
            )}
            {/* Pulsing upload-in-progress badge */}
            {status === "sending" && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse pointer-events-none"
                style={{ background: isMe ? "rgba(255,255,255,0.75)" : "hsl(var(--primary))" }}
              />
            )}
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div
              className="h-1 rounded-full overflow-hidden"
              style={{ background: isMe ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.10)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress * 100}%`,
                  background: isMe ? "rgba(255,255,255,0.80)" : "hsl(var(--primary))",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
            <p className="text-[10px] opacity-55 font-mono tabular-nums">
              {status === "sending" && !playing
                ? "Sending…"
                : playing
                ? fmt(remaining)
                : fmt(duration || 0)}
            </p>
          </div>
          <Mic className="w-3 h-3 shrink-0 opacity-40" />
        </>
      ) : null}
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
  // Realtime unlock: instantly mark entitlement cache as unlocked when the broadcast fires.
  // Must be declared before useRealtimeMessages (which wires the broadcast listener).
  const onVoiceNoteUnlock = useCallback(() => {
    queryClient.setQueryData(
      ["/api/voice-notes/entitlement", match.id],
      (old: any) => old ? { ...old, unlocked: true } : { unlocked: true, popupSeen: false },
    );
  }, [match.id, queryClient]);
  const [, navigate] = useLocation();
  const isActive = useTabActive();
  const [message, setMessage] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  // ── Voice debug panel state ────────────────────────────────────────────────
  // voicedebug panel: dev builds only — never shown in production regardless of URL params
  const voiceDebugEnabled = import.meta.env.DEV;
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const debugLiveRef = useRef<VoiceDebugLive>({
    composerBefore: "",
    composerDuring: "",
    composerAfter: "",
    composerCSSBefore: "",
    composerCSSDuring: "",
    composerCSSAfter: "",
    voicePhase: "idle",
    blobSize: 0,
    blobType: "",
    blobDurationMs: 0,
    uploadStatus: "",
    uploadBodyType: "",
    uploadStartMs: 0,
    uploadFailMs: 0,
    uploadErrName: "",
    uploadError: "",
    uploadRespBody: "",
    insertStatus: "",
    playbackUrlStatus: "",
    lastPointerEvent: "",
    mrState: "",
  });
  const addDbg = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    setDebugLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 120));
  }, []);
  // ── end debug ──────────────────────────────────────────────────────────────

  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [sheetDragY, setSheetDragY] = useState(0);
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  const sheetGestureRef = useRef<{ active: boolean; startY: number; velocityBuf: { y: number; t: number }[] }>({ active: false, startY: 0, velocityBuf: [] });
  const [showAIStarters, setShowAIStarters] = useState(false);
  const hasAutoShownStartersRef = useRef(false);
  const [filterConfirm, setFilterConfirm] = useState<{ content: string; tempId: string; categories: string[] } | null>(null);
  const [chatGuideTriggered,    setChatGuideTriggered]    = useState(false);
  const [callGuideTriggered,    setCallGuideTriggered]    = useState(false);
  const [videoGuideTriggered,   setVideoGuideTriggered]   = useState(false);
  const [micHoldGuideTriggered, setMicHoldGuideTriggered] = useState(false);
  // Tracks messages sent in the current call-stage session for optimistic counter display.
  // Resets when match.id or callStage changes so the badge always starts from the DB value.
  const [localSentCount, setLocalSentCount] = useState(0);

  // Visual-viewport sync — keeps the shell aligned with the visible area when the iOS
  // keyboard opens (visualViewport.offsetTop becomes non-zero; layout viewport stays put)
  const [vpTop,    setVpTop]    = useState(() => window.visualViewport?.offsetTop ?? 0);
  const [vpHeight, setVpHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight);

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

  const { broadcastNewMessage, broadcastDateChoice } = useRealtimeMessages(match.id, expanded, onVoiceNoteUnlock);

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
            : t("unknown_server_error"),
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
        description: isSelfCall ? t("cant_call_yourself_desc") : isAuth ? t("please_refresh_desc") : t("unknown_server_error"),
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
      const _ts = Date.now();
      // Set SYNCHRONOUSLY before any await — this must be visible to the
      // wasRinging/selfCancelled effect even if the server's Realtime
      // call:cancelled broadcast arrives before the HTTP response.
      iCancelledRef.current = true;
      const sessionId = lastCallSessionIdRef.current;
      // Belt-and-suspenders: register the cancel synchronously so isSelfCancelled()
      // returns true even before onSuccess fires (covers any Realtime race).
      markCallSessionCancelled(match.id, sessionId);
      if (DEBUG_CALLS) console.log("[BUG2_PROOF] mutationFn_start — iCancelledRef_set_true", { matchId: match.id, ts: _ts, callSessionId: sessionId });
      console.log("[CALL_UI] CALL_CANCELLED", { matchId: match.id, callSessionId: sessionId, userId: user?.id, role: "caller" });
      console.log("[CALL_UI] CALL_STAGE_EXITED", { matchId: match.id, reason: "caller_cancelled" });
      if (DEBUG_CALLS) console.log("[BUG2_PROOF] POST_cancel_sending", { matchId: match.id, ts: Date.now() });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      if (DEBUG_CALLS) console.log("[BUG2_PROOF] POST_cancel_response_received", { matchId: match.id, ts: Date.now() });
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
        description: isAuth ? t("please_refresh_desc") : t("unknown_server_error"),
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
      toast({ title: t("couldnt_answer_title"), description: t("unknown_server_error"), variant: "destructive" });
    },
  });

  const inlineDeclineCall = useMutation({
    mutationFn: async () => {
      const sessionId = lastCallSessionIdRef.current;
      // Also read session ID from the list cache — the ring handler only patches
      // the LIST cache, not the DETAIL cache.  If matchDetail loaded before the
      // call started, lastCallSessionIdRef may still be null.
      const cachedList = queryClient.getQueryData<any[]>(["/api/matches"]);
      const listSessionId = cachedList?.find((m: any) => m.id === match.id)?.callSessionId ?? null;
      console.log("[CALL_DECLINE] clicked — ref:", sessionId, "list:", listSessionId);
      console.log("[CALL_UI] CALL_DECLINED", { matchId: match.id, callSessionId: sessionId ?? listSessionId, userId: user?.id, role: "receiver", source: "inline_chat" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return await res.json();
    },
    onSuccess: () => {
      const sessionId = lastCallSessionIdRef.current;
      // Belt-and-suspenders: also read from the list cache in case the ref is
      // stale or null (detail loaded before ring arrived, so ref never updated).
      const cachedList = queryClient.getQueryData<any[]>(["/api/matches"]);
      const listSessionId = cachedList?.find((m: any) => m.id === match.id)?.callSessionId ?? null;
      const effectiveSessionId = sessionId || listSessionId;
      console.log("[CALL_DECLINE] onSuccess — ref:", sessionId, "list:", listSessionId, "effective:", effectiveSessionId);
      markCallSessionCancelled(match.id, sessionId);
      if (listSessionId && listSessionId !== sessionId) {
        markCallSessionCancelled(match.id, listSessionId);
        console.log("[CALL_DECLINE] also cancelled list session:", listSessionId);
      }
      broadcastCallSignal(match.id, {
        type: "call:declined",
        matchId: match.id,
        userId: user?.id ?? "",
        callSessionId: effectiveSessionId,
      } as any);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      const listAfter = queryClient.getQueryData<any[]>(["/api/matches"]);
      const matchAfter = listAfter?.find((m: any) => m.id === match.id);
      const detailAfter = queryClient.getQueryData<any>(["/api/matches", match.id]);
      console.log("[CALL_DECLINE] list cache after patch — callStartedAt:", matchAfter?.callStartedAt, "callSessionId:", matchAfter?.callSessionId);
      console.log("[CALL_DECLINE] detail cache after patch — callStartedAt:", detailAfter?.callStartedAt, "callSessionId:", detailAfter?.callSessionId);
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id], exact: true });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"], exact: true });
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
      el.scrollTop = el.scrollHeight; // stay inside messages container; never touch outer page
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

  // Trigger the mic-hold onboarding tip once per user when they first open any chat
  useEffect(() => {
    if (!expanded) return;
    const timer = setTimeout(() => setMicHoldGuideTriggered(true), 1800);
    return () => clearTimeout(timer);
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (expanded) {
      onMarkRead();
    }
  }, [expanded]);

  // Sync chat shell position/height to the visual viewport so the entire shell
  // (header + messages + composer) tracks the visible area when the iOS keyboard opens.
  // Uses RAF to batch updates and prevent jank.
  useEffect(() => {
    if (!expanded) return;
    let rafId: number;
    const update = () => {
      const vv = window.visualViewport;
      setVpTop(vv?.offsetTop ?? 0);
      setVpHeight(vv?.height ?? window.innerHeight);
    };
    const schedule = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(update); };
    update(); // immediate on open
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      cancelAnimationFrame(rafId);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
    };
  }, [expanded]);

  // Lock document overflow while chat is open so the background page cannot scroll.
  // IMPORTANT: do NOT use body.style.position="fixed" — on iOS Safari, position:fixed on
  // the body creates a new containing block for position:fixed children, shifting the chat
  // shell by -scrollY pixels. overflow:hidden is sufficient here; the visualViewport sync
  // above handles actual positioning.
  useEffect(() => {
    if (!expanded) return;
    const savedScrollY = window.scrollY;
    document.documentElement.classList.add("chat-open");
    document.body.classList.add("chat-open");
    return () => {
      document.documentElement.classList.remove("chat-open");
      document.body.classList.remove("chat-open");
      window.scrollTo(0, savedScrollY);
    };
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

  // Voice notes entitlement — unlocks when both users have sent ≥8 messages (or call_stage > 0).
  // First call unlocks at ≥15 messages each way (separate milestone).
  // All popup-seen flags are server-persisted so modals only show once across all devices.
  const { data: voiceNoteData } = useQuery<{
    unlocked: boolean;
    popupSeen: boolean;
    firstCallUnlocked: boolean;
    firstCallPromptSeen: boolean;
  }>({
    queryKey: ["/api/voice-notes/entitlement", match.id],
    enabled: expanded,
    staleTime: 0,
    refetchInterval: 60_000, // true-realtime via broadcast; polling is fallback only
  });
  const voiceNotesUnlocked = voiceNoteData?.unlocked ?? false;
  const firstCallUnlocked  = voiceNoteData?.firstCallUnlocked ?? false;

  // Purchase prompt state
  const [purchasePromptFeature, setPurchasePromptFeature] = useState<PurchaseFeature | null>(null);

  // Voice-note unlock popup — shown once per user per match when unlock first detected.
  // Server is source of truth (popupSeen); localStorage is a fast local cache to
  // avoid a flash on re-mount before the query response arrives.
  const [voiceNotePopupOpen, setVoiceNotePopupOpen] = useState(false);

  // First-call unlock popup — shown once per user per match when both users hit 15 messages.
  // Shown only after the voice-note popup (if any) has been dismissed to prevent overlap.
  const [firstCallPopupOpen, setFirstCallPopupOpen] = useState(false);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voicePhase = isRecording ? "recording" as const : "idle" as const;
  const recordingStartMsRef = useRef<number>(0);
  // Module-level shared stream — persists across component mounts so iOS never re-prompts.
  // micStreamRef is kept only for waveform analyser compatibility; actual stream comes from
  // the mic-permission module which lives at module scope (survives chat switching).
  const micStreamRef = useRef<MediaStream | null>(null);
  // Permission state — drives the hint pill and denied card.
  const [micPermState, setMicPermState] = useState<MicPermState>(() => getMicPermState());
  // Synchronous recording-state ref — avoids the async race between startRecording()
  // awaits and pointerUp firing before setState resolves.
  const isRecordingRef = useRef(false);
  // Set true when the user releases/cancels while the recorder is still initialising.
  const stopRequestedRef = useRef(false);
  // Live waveform analyser — optional, fails silently.
  // IMPORTANT: waveform bar heights are updated via DIRECT DOM manipulation (waveformBarEls refs)
  // rather than React state. This eliminates 60 re-renders/second during recording which was
  // causing iOS to repaint and visually jump the fixed-position composer.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const waveformRafRef = useRef<number | null>(null);
  const waveformBarEls = useRef<HTMLDivElement[]>([]);
  const [pendingVoiceNotes, setPendingVoiceNotes] = useState<PendingVoiceNote[]>([]);
  // Slide-to-cancel: track pointer start X + whether threshold crossed
  const pointerStartXRef = useRef(0);
  const cancelPendingRef = useRef(false);
  const [cancelPending, setCancelPending] = useState(false);

  const stopWaveform = () => {
    if (waveformRafRef.current) { cancelAnimationFrame(waveformRafRef.current); waveformRafRef.current = null; }
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
    analyserRef.current = null;
    // Reset bar heights directly — no React state update needed
    waveformBarEls.current.forEach(el => { if (el) el.style.height = "3px"; });
  };

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
  };

  const startRecording = async () => {
    // Guard against double-start. isRecordingRef is set synchronously BEFORE any
    // await so even an immediate pointerUp (before getUserMedia resolves) is caught.
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    stopRequestedRef.current = false;
    // Record start time synchronously so the elapsed check works for quick releases.
    recordingStartMsRef.current = Date.now();
    // CRITICAL iOS FIX: focus the textarea SYNCHRONOUSLY before any await.
    // iOS Safari fires blur on the active element when JS enters an async microtask
    // gap (e.g. awaiting getUserMedia). If blur fires first, the keyboard closes and
    // the composer drops. Calling focus() here, before the first await, keeps iOS
    // focused on the textarea and the keyboard stays open.
    textareaRef.current?.focus({ preventScroll: true });
    try {
      // Use the module-level shared stream — persists across component mounts so
      // iOS never re-prompts after the first grant. requestMicStream() is a no-op
      // if the stream is already live (returns immediately, no async getUserMedia).
      const stream = await requestMicStream();
      micStreamRef.current = stream; // also store locally for the waveform analyser
      setMicPermState("granted");

      // iOS Safari: prefer audio/mp4 first since isTypeSupported may return false for
      // webm/ogg even though audio/mp4 works. Putting it last risks the fallback path
      // where recorder.mimeType is empty → upload sends wrong Content-Type → FFmpeg fail.
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      const preferredTypes = isIOS
        ? ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"]
        : ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
      const mimeType = preferredTypes.find(t => {
        try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
      }) ?? "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      // recorder.mimeType is the authoritative type (browser fills it even when we don't
      // specify one). Fall back to mimeType from isTypeSupported, then to platform guess.
      const recorderMime = recorder.mimeType || mimeType;
      // If both are empty (buggy iOS Safari that doesn't report mimeType), guess from UA.
      const actualMimeType = recorderMime || (isIOS ? "audio/mp4" : "audio/webm");
      console.log(`[VOICE_NOTE_SEND] recording started isIOS=${isIOS} mimeType="${mimeType}" recorderMime="${recorder.mimeType}" actualMimeType="${actualMimeType}"`);
      addDbg(`recStart isIOS=${isIOS} req="${mimeType}" got="${recorder.mimeType}" actual="${actualMimeType}"`);
      audioChunksRef.current = [];
      const recStartPerfMs = performance.now(); // for computing duration in onstop
      recorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
        addDbg(`chunk ${audioChunksRef.current.length} size=${e.data.size}B`);
      };
      recorder.onstop = () => {
        // Do NOT stop stream tracks — module keeps the stream alive for the next recording.
        const tStop = performance.now();
        const durationMs = Math.round(tStop - recStartPerfMs);
        debugLiveRef.current.blobDurationMs = durationMs;
        console.log(`[VOICE_NOTE_SEND] recording stopped chunks=${audioChunksRef.current.length} durationMs=${durationMs}`);
        addDbg(`recStop chunks=${audioChunksRef.current.length} durationMs=${durationMs}`);
        const blob = new Blob(audioChunksRef.current, { type: actualMimeType });
        console.log(`[VOICE_NOTE_SEND] blob size=${blob.size}B type="${blob.type}" durationMs=${Math.round(performance.now() - tStop)}`);
        debugLiveRef.current.blobSize = blob.size;
        debugLiveRef.current.blobType = blob.type || actualMimeType || "(empty)";
        addDbg(`onstop blob=${blob.size}B type="${blob.type || "(empty)"}" actual="${actualMimeType}"`);
        if (blob.size === 0) {
          // MediaRecorder produced no data — genuine failure (e.g. mic denied mid-session).
          console.error("[VOICE_NOTE_SEND] blob size=0 — recording produced no audio");
          debugLiveRef.current.uploadStatus = "FAILED: blob=0B";
          addDbg(`FAIL blob.size=0 — no audio captured`);
          toast({ title: "Recording failed. Please try again.", variant: "destructive" });
          return;
        }
        if (blob.size > 0) {
          const blobUrl = URL.createObjectURL(blob);
          const tempId = `voice-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const tStart = performance.now();
          // Show bubble IMMEDIATELY — upload happens in background
          console.log(`[VOICE_NOTE_SEND] optimistic bubble shown tempId=${tempId}`);
          addDbg(`optimistic bubble shown, calling mutate`);
          setPendingVoiceNotes(prev => [...prev, { tempId, blobUrl, blob, mimeType: actualMimeType, tStart, status: "sending" }]);
          forceScrollRef.current = true;
          sendVoiceNote.mutate({ tempId, blobUrl, blob, mimeType: actualMimeType, tStart });
        }
      };
      recorder.start(100);
      // ── Live waveform analyser (optional — fails silently on restrictive browsers) ──
      try {
        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtxClass) {
          const ctx = new AudioCtxClass() as AudioContext;
          audioCtxRef.current = ctx;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          analyser.smoothingTimeConstant = 0.75;
          analyserRef.current = analyser;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const freqData = new Uint8Array(analyser.frequencyBinCount);
          const tick = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(freqData);
            // Direct DOM update — zero React re-renders, zero layout thrash on iOS
            const bars = waveformBarEls.current;
            for (let i = 0; i < bars.length; i++) {
              if (bars[i]) {
                const idx = Math.floor(i * freqData.length / bars.length);
                bars[i].style.height = Math.max(3, (freqData[idx] / 255) * 20) + "px";
              }
            }
            waveformRafRef.current = requestAnimationFrame(tick);
          };
          waveformRafRef.current = requestAnimationFrame(tick);
        }
      } catch { /* analyser is non-critical — pulse dot is the fallback */ }
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingTime(0);
      // Light haptic feedback when recording starts (no-op on unsupported browsers)
      try { navigator.vibrate(25); } catch {}
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(t => {
          if (t >= 59) { stopRecording(); return 60; }
          return t + 1;
        });
      }, 1000);
      // If the user released before setup completed, stop/cancel immediately.
      if (stopRequestedRef.current) stopRecording();
    } catch (err: any) {
      isRecordingRef.current = false;
      stopRequestedRef.current = false;
      const isPermission = err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError";
      const isNotFound = err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError";
      if (isPermission) {
        console.log("[VOICE_NOTE] permission denied");
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
    // Signal stop intent — startRecording checks this flag after async setup completes.
    stopRequestedRef.current = true;
    // If the recorder isn't ready yet, the check in startRecording handles it.
    if (!isRecordingRef.current) return;
    const elapsed = Date.now() - recordingStartMsRef.current;
    if (elapsed < 500) {
      // Too short (< 0.5 s per spec) — cancel silently; no toast for accidental touches.
      cancelRecording();
      return;
    }
    stopWaveform();
    stopRecordingTimer();
    // Release composer height lock (applied synchronously in onPointerDown).
    // Must be cleared BEFORE setIsRecording(false) so the composer height
    // never flickers — the lock kept it stable during recording, and clearing
    // it now lets the element return to its natural (same) height.
    if (composerRef.current) composerRef.current.style.minHeight = "";
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    isRecordingRef.current = false;
    // Light haptic feedback when recording ends
    try { navigator.vibrate(15); } catch {}
    cancelPendingRef.current = false;
    setCancelPending(false);
    setIsRecording(false);
    setRecordingTime(0);
  };

  const cancelRecording = () => {
    stopWaveform();
    stopRecordingTimer();
    // Release composer height lock.
    if (composerRef.current) composerRef.current.style.minHeight = "";
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.ondataavailable = null;
      mr.onstop = null;
      // Do NOT stop the stream tracks — keep micStreamRef alive for the next recording.
      try { mr.stop(); } catch { /* ignore */ }
    }
    audioChunksRef.current = [];
    isRecordingRef.current = false;
    stopRequestedRef.current = false;
    // Distinct haptic pattern for cancel (so user knows it was cancelled, not sent)
    try { navigator.vibrate([20, 30, 20]); } catch {}
    cancelPendingRef.current = false;
    setCancelPending(false);
    setIsRecording(false);
    setRecordingTime(0);
  };

  // Pre-warm the shared mic stream as soon as this chat view mounts.
  // If the user previously granted mic permission, we call getUserMedia() in the
  // background NOW (not on button press) so the stream is hot before they hold.
  // This makes recording feel instant — no async delay on the first hold.
  useEffect(() => {
    if (voiceNotesUnlocked && wasMicGrantedBefore()) {
      prewarmMicStream();
    }
  }, [voiceNotesUnlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the one-time voice-note unlock popup when: unlocked AND server says not yet seen.
  // localStorage is a fast local cache to prevent a flash before the next query response.
  useEffect(() => {
    if (voiceNotesUnlocked && voiceNoteData?.popupSeen === false) {
      if (!localStorage.getItem(`vn_popup_${match.id}`)) {
        setVoiceNotePopupOpen(true);
      }
    }
  }, [voiceNotesUnlocked, voiceNoteData?.popupSeen, match.id]);

  // Show the one-time first-call unlock popup when:
  //   • firstCallUnlocked is true (both users reached 15 messages each way)
  //   • firstCallPromptSeen is false (server has not yet recorded this user seeing it)
  //   • voice-note popup is NOT currently open (no overlapping modals)
  useEffect(() => {
    if (
      firstCallUnlocked &&
      voiceNoteData?.firstCallPromptSeen === false &&
      !voiceNotePopupOpen &&
      !localStorage.getItem(`fc_popup_${match.id}`)
    ) {
      setFirstCallPopupOpen(true);
    }
  }, [firstCallUnlocked, voiceNoteData?.firstCallPromptSeen, voiceNotePopupOpen, match.id]);

  // Clean up the MediaRecorder, waveform, and pending blob URLs on unmount.
  // Do NOT stop the module-level mic stream — it must survive component remounts
  // so iOS never re-prompts and recording starts instantly on the next chat.
  useEffect(() => {
    return () => {
      stopWaveform();
      stopRecordingTimer();
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") {
        mr.ondataavailable = null;
        mr.onstop = null;
        try { mr.stop(); } catch {}
      }
      isRecordingRef.current = false;
      stopRequestedRef.current = false;
      // micStreamRef is a local alias — do NOT stop its tracks.
      // The module-level stream in mic-permission.ts stays alive.
      micStreamRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke pending blob URLs when this chat closes to free browser memory.
  // Pending notes are per-chat so we can safely revoke on unmount.
  useEffect(() => {
    return () => {
      setPendingVoiceNotes(prev => {
        prev.forEach(pv => { try { URL.revokeObjectURL(pv.blobUrl); } catch {} });
        return [];
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── [VOICE_NOTE_LAYOUT] diagnostics ─────────────────────────────────────────
  const inputFocusedRef = useRef(false);
  inputFocusedRef.current = inputFocused;

  // Recording state transitions — populate debugLiveRef for VoiceDebugPanel (DEV only).
  useEffect(() => {
    const el = composerRef.current;
    const r = el?.getBoundingClientRect();
    const phase = isRecording ? "recording" : "idle";
    debugLiveRef.current.voicePhase = phase;

    if (isRecording && el && r) {
      const txt = `top=${Math.round(r.top)} bot=${Math.round(r.bottom)} h=${Math.round(r.height)}`;
      debugLiveRef.current.composerDuring = txt;
      debugLiveRef.current.composerCSSDuring = snapshotComposerCSS(el);
    } else if (el) {
      const r2 = el.getBoundingClientRect();
      const txt2 = `top=${Math.round(r2.top)} bot=${Math.round(r2.bottom)} h=${Math.round(r2.height)}`;
      debugLiveRef.current.composerAfter = txt2;
      debugLiveRef.current.composerCSSAfter = snapshotComposerCSS(el);
    }
  }, [isRecording]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendVoiceNote = useMutation({
    mutationFn: async ({ blob, mimeType, tStart }: { blob: Blob; mimeType: string; blobUrl: string; tempId: string; tStart: number }) => {
      // ── Step 1: Validate blob ──
      const durationMs = debugLiveRef.current.blobDurationMs || 0;
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      const filename = mimeType.includes("mp4") ? "voice.m4a" : mimeType.includes("ogg") ? "voice.ogg" : "voice.webm";

      console.log(`[VOICE_NOTE_SPEED] recording stopped — blobSize=${blob.size}B mimeType="${mimeType}" durationMs=${durationMs}`);
      console.log(`[VOICE_NOTE_PIPELINE] recording stopped`);
      console.log(`[VOICE_NOTE_PIPELINE] blob size=${blob.size}`);
      console.log(`[VOICE_NOTE_PIPELINE] blob type=${blob.type || "(empty)"}`);
      console.log(`[VOICE_NOTE_PIPELINE] durationMs=${durationMs}`);
      console.log(`[VOICE_NOTE_PIPELINE] filename=${filename}`);
      console.log(`[VOICE_NOTE_SEND] blob created size=${blob.size}B type="${blob.type}" mimeType="${mimeType}"`);
      debugLiveRef.current.blobSize = blob.size;
      debugLiveRef.current.blobType = blob.type || mimeType || "(empty)";
      debugLiveRef.current.uploadStatus = "validating";
      debugLiveRef.current.uploadError = "";
      addDbg(`blob size=${blob.size}B type="${blob.type || "(empty)"}" mime="${mimeType}"`);
      if (blob.size === 0) throw new Error("Recording failed. Please try again.");
      if (blob.size > 3_000_000) throw new Error("Recording too large (max ~60 seconds). Please try again.");

      // ── Step 2: Fetch auth headers ──
      const fullUploadUrl = API_BASE + `/api/voice-notes/send/${match.id}`;
      debugLiveRef.current.uploadStatus = "uploading…";
      addDbg(`upload → ${fullUploadUrl.slice(-50)} blob=${blob.size}B mime="${mimeType}"`);

      let authHeaders: Record<string, string>;
      try {
        authHeaders = await getAuthHeaders();
      } catch (authErr: any) {
        throw new Error(`Auth error — please refresh and try again: ${authErr.message}`);
      }
      const authPresent = !!(authHeaders.Authorization || authHeaders.authorization);

      // ── Step 3: Build FormData ─────────────────────────────────────────────────
      // FormData multipart/form-data is the only reliable way to send binary audio
      // on iOS Safari. Raw binary fetch throws "Load failed" on iOS.
      // CRITICAL: Do NOT set Content-Type header manually — the browser sets it to
      // "multipart/form-data; boundary=…" automatically. Setting it manually drops
      // the boundary parameter and the server cannot parse the body.
      //
      // X-Voice-Mime was removed from fetch headers — it triggered CORS preflight
      // failures on cross-origin deploys (Vercel → Replit) because it was not in
      // Access-Control-Allow-Headers. The mimeType is already sent in the FormData
      // body so the server reads it from req.body.mimeType instead.
      const formData = new FormData();
      formData.append("audio", blob, filename);
      formData.append("mimeType", mimeType);
      formData.append("durationMs", String(durationMs));

      console.log(`[VOICE_NOTE_SPEED] upload started — blobSize=${blob.size}B url="${fullUploadUrl.slice(-60)}"`);
      console.log(`[VOICE_NOTE_PIPELINE] upload url=${fullUploadUrl}`);
      console.log(`[VOICE_NOTE_PIPELINE] upload method=POST`);
      console.log(`[VOICE_NOTE_PIPELINE] body type=FormData`);
      console.log(`[VOICE_NOTE_PIPELINE] auth header present=${authPresent}`);
      debugLiveRef.current.uploadBodyType = "FormData+fetch";
      debugLiveRef.current.uploadStartMs = performance.now();
      addDbg(`upload started FormData isIOS=${isIOS} size=${blob.size} file="${filename}"`);

      // ── Step 4: Send request ───────────────────────────────────────────────────
      const tUpload = performance.now();
      let res: Response;
      console.log(`[VOICE_NOTE_PIPELINE] request started`);
      console.log(`[VOICE_NOTE_SEND] upload → ${fullUploadUrl} blobSize=${blob.size} isIOS=${isIOS}`);
      try {
        res = await fetch(fullUploadUrl, {
          method: "POST",
          headers: {
            // No Content-Type — browser sets multipart/form-data + boundary automatically.
            // No X-Voice-Mime — removed because it triggered CORS preflight failures.
            // mimeType is in the FormData body instead (req.body.mimeType on server).
            ...authHeaders,
          },
          body: formData,
        });
      } catch (uploadErr: any) {
        debugLiveRef.current.uploadFailMs = performance.now();
        const errName = uploadErr?.name || uploadErr?.constructor?.name || "Error";
        const errMsg = uploadErr?.message || "unknown";
        debugLiveRef.current.uploadErrName = errName;
        debugLiveRef.current.uploadError = errMsg;
        addDbg(`upload FAILED errName="${errName}" errMsg="${errMsg}"`);
        console.error(`[VOICE_NOTE_PIPELINE] request failed exception name=${errName} message=${errMsg}`);
        console.error(`[VOICE_NOTE_UPLOAD] FAILED name="${errName}" msg="${errMsg}" url="${fullUploadUrl}" isIOS=${isIOS}`);
        throw new Error(`Couldn't send voice message — tap the bubble to retry.`);
      }

      const uploadMs = Math.round(performance.now() - tUpload);
      const respCt = res.headers.get("content-type") || "(none)";
      console.log(`[VOICE_NOTE_SPEED] upload complete — status=${res.status} uploadMs=${uploadMs}ms`);
      console.log(`[VOICE_NOTE_PIPELINE] response status=${res.status}`);
      console.log(`[VOICE_NOTE_PIPELINE] response content-type=${respCt}`);
      debugLiveRef.current.uploadStatus = `HTTP ${res.status} (${uploadMs}ms)`;
      addDbg(`uploadResp HTTP ${res.status} ct="${respCt}" in ${uploadMs}ms`);
      console.log(`[VOICE_NOTE_SEND] upload response status=${res.status} ms=${uploadMs}`);

      // ── Step 5: Parse server response ──
      let data: any;
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) {
        console.error(`[VOICE_NOTE_SEND] server error status=${res.status} message="${data?.message}"`);
        debugLiveRef.current.uploadError = `${res.status}: ${data?.message || "unknown"}`;
        addDbg(`serverErr ${res.status} "${data?.message || "no msg"}"`);
        throw new Error(data?.message || `Server error ${res.status} — please try again`);
      }

      // ── Step 6: Verify message was inserted ──
      const messageId = data?.message?.id;
      const publicUrl = data?.message?.content?.startsWith("__VOICE__:") ? data.message.content.slice(10) : "(no url)";
      const totalMs = Math.round(performance.now() - tStart);
      console.log(`[VOICE_NOTE_SPEED] server processed — response parsed totalMs=${totalMs}ms`);
      console.log(`[VOICE_NOTE_SEND] message inserted id=${messageId} url="${publicUrl}" totalMs=${totalMs}`);
      debugLiveRef.current.insertStatus = messageId ? `ok id=${messageId}` : "WARN: no message obj";
      addDbg(`insert ${messageId ? "ok id=" + messageId : "WARN: no msg"} url="${publicUrl.slice(0,60)}"`);
      if (!data?.message) {
        console.warn(`[VOICE_NOTE_SEND] server returned success but no message object`);
      }

      // ── Preload CDN URL immediately so it's cached before bubble mounts ──
      // The VoiceNoteBubble will mount with the CDN URL right after this returns.
      // Starting the fetch now gives the browser a head-start, reducing or eliminating
      // the CDN propagation wait that causes the initial "loading" state.
      if (publicUrl !== "(no url)") {
        console.log(`[VOICE_NOTE_SPEED] playback url ready — preloading CDN url now`);
        try {
          const preloadAudio = new Audio();
          preloadAudio.preload = "auto";
          preloadAudio.src = publicUrl;
          preloadAudio.load();
        } catch { /* ignore preload errors — bubble will retry normally */ }
      }

      console.log(`[VOICE_NOTE_SPEED] total ms — ${totalMs}ms from recording stopped to CDN preload started`);
      return data;
    },
    onSuccess: (data: any, vars) => {
      const realMsg = data?.message as Message | undefined;
      // Delay blob URL revoke by 15s — the CDN preload audio element references it and the
      // browser may still be mid-fetch. Revoking immediately cuts that off on some browsers.
      setTimeout(() => URL.revokeObjectURL(vars.blobUrl), 15_000);
      if (realMsg) {
        // Atomically replace pending entry with the real server message in the cache
        queryClient.setQueryData<MatchDetail>(["/api/matches", match.id], (old) => {
          if (!old) return old;
          const exists = old.messages.some(m => m.id === realMsg.id);
          if (exists) return old;
          return { ...old, messages: [...old.messages, realMsg] };
        });
        broadcastNewMessage(realMsg);
        console.log(`[VOICE_NOTE_SEND] cache updated messageId=${realMsg.id} — voice note visible`);
        addDbg(`onSuccess: cache updated id=${realMsg.id}`);
      } else {
        console.warn(`[VOICE_NOTE_SEND] no realMsg in response — invalidating query`);
        addDbg(`onSuccess: no realMsg — invalidating query`);
        queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      }
      // Remove the pending entry — real message is now in cache
      setPendingVoiceNotes(prev => prev.filter(v => v.tempId !== vars.tempId));
      forceScrollRef.current = true;
    },
    onError: (err: any, vars) => {
      // Mark as failed so user can retry — do NOT remove from list
      console.error(`[VOICE_NOTE_SEND] FAILED error="${err?.message}"`);
      debugLiveRef.current.uploadStatus = "FAILED";
      debugLiveRef.current.uploadError = err?.message || "unknown";
      addDbg(`onError: "${err?.message || "unknown"}"`);
      setPendingVoiceNotes(prev => prev.map(v => v.tempId === vars.tempId ? { ...v, status: "failed" } : v));
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

    const isCancelledByRef  = iCancelledRef.current;
    const isCancelledByFunc = isSelfCancelled(match.id, lastCallSessionIdRef.current ?? "");
    const selfCancelled = isCancelledByRef || isCancelledByFunc;
    // [BUG2_PROOF] Log every evaluation so we can confirm iCancelledRef was
    // already true when the Realtime call:cancelled signal arrived.
    if (DEBUG_CALLS) console.log("[BUG2_PROOF] ringing_effect_eval", {
      ts: Date.now(),
      matchId: match.id,
      wasRinging,
      isRingingNow,
      isCallActive,
      selfCancelled,
      iCancelledByRef: isCancelledByRef,
      isCancelledByFunc,
      sessionId: lastCallSessionIdRef.current,
      willToast: wasRinging && !isRingingNow && !isCallActive && !selfCancelled,
    });
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
      m => m.content != null && !m.content.startsWith(SCHEDULE_PREFIX) && !m.content.startsWith("__SYSTEM__:") && !m.content.startsWith("__SYS__:")
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
    <div
      className="fixed left-0 right-0 flex flex-col overflow-hidden"
      style={{ top: vpTop, height: vpHeight, background: "hsl(var(--background))" }}
      data-testid={`card-match-${match.id}`}
    >

      {/* Standard flex-column chat layout. 100dvh shrinks with the keyboard on iOS —
          no manual keyboardHeight tracking needed. Browser handles everything. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      {/* HEADER — sticky at top, safe-area-aware. overflow-hidden on column (no height:100%)
          prevents the Safari BFC+percentage-height bug that caused clipping in earlier builds.
          The column gets its height from flex cross-axis stretch (definite), not a percentage. */}
      <div style={{ position: "relative", top: 0, zIndex: 10, width: "100%", flexShrink: 0, paddingTop: "env(safe-area-inset-top)", background: "hsl(var(--background))", borderBottom: "1px solid hsl(var(--border)/0.5)" }}>
        {/* ── Main header row ── */}
        <div className={"flex items-center gap-3 px-4 " + (inputFocused ? "pt-1 pb-2" : "pt-3 pb-2")}>
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 -ms-1 min-w-[44px] min-h-[44px]"
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
            {!inputFocused && (() => {
              const myShowLastActive = localStorage.getItem("settings_show_last_active") !== "false";
              const lbl = formatLastActive(match.profile.lastActive, (match.profile.showLastActive ?? true) && myShowLastActive);
              return lbl ? (
                <p className="text-[10px] text-muted-foreground leading-none mt-0.5" data-testid={`text-last-active-${match.id}`}>{lbl}</p>
              ) : null;
            })()}
            {!inputFocused && <span
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
            </span>}
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
        {/* ── Action tray: phone / video / face-call / mic with credit counts ── */}
        <div className={"flex items-center justify-center gap-6 px-4 pb-2.5 border-t border-border/30" + (inputFocused ? " hidden" : "")}>
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
            {/* ── Face / video call button — unlocks after all voice calls done ── */}
            {allCallsDone && (
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
                data-testid={`button-face-call-tray-${match.id}`}
                title={t("face_call_label")}
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
                  {!callCreditsData ? "·" : (videoCredits ?? 0) > 0 ? "Face" : "Unlock"}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                if (!voiceNotesUnlocked) {
                  toast({ description: "Voice notes unlock after you've both sent 10 messages." });
                  return;
                }
                if (voicePhase === "recording") stopRecording();
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
      {expanded && !inputFocused && <SparkProgressBar sparkStep={sparkStep} />}
      {expanded && !inputFocused && postCallProgressReady && eitherKeep && (
        <div className="px-4 py-2 border-b border-border/40 bg-primary/3" data-testid={`date-plan-hint-bar-${match.id}`}>
          <p className="text-[11px] text-center text-muted-foreground">
            {t("plan_date_cta_hint")}
          </p>
        </div>
      )}
      </div>{/* /header */}

      {/* MESSAGES — flex:1 fills the space between header and composer */}
      <div ref={messagesContainerRef} onScroll={handleMessagesScroll}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}
        data-testid={`messages-container-${match.id}`}
      >
        <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} className="px-4 pt-3 pb-1.5 space-y-3">
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

              // ── Call event system messages ────────────────────────────────
              if (!msg.content) return null;
              if (msg.content.startsWith("__CALL_EVENT__:")) {
                let callText = "";
                try {
                  const ev = JSON.parse(msg.content.slice("__CALL_EVENT__:".length));
                  if (ev.type === "cancelled" || ev.type === "missed") {
                    callText = isMe
                      ? `📞 You called ${match.profile.firstName}`
                      : `📞 Missed call from ${ev.callerName || match.profile.firstName}`;
                  }
                  if (ev.type === "declined") {
                    callText = isMe
                      ? `📞 ${ev.calleeName || match.profile.firstName} declined your call`
                      : `📞 You declined ${ev.callerName || match.profile.firstName}'s call`;
                  }
                  if (ev.type === "ended")    callText = "📞 Call ended";
                } catch {}
                if (!callText) return null;
                return (
                  <div key={msg.id} className="flex justify-center py-1.5">
                    <span className="text-xs text-muted-foreground bg-muted/50 rounded-full px-3 py-1" data-testid={`call-event-${msg.id}`}>{callText}</span>
                  </div>
                );
              }

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
            {/* Optimistic voice note bubbles — appear instantly on mic release, removed when upload completes */}
            {pendingVoiceNotes.map(pv => (
              <div key={pv.tempId} className="flex justify-end">
                <div className="relative">
                  <div className="max-w-[75vw] rounded-md text-sm select-none">
                    <VoiceNoteBubble
                      url={pv.blobUrl}
                      isMe={true}
                      status={pv.status}
                      onRetry={() => {
                        // Reset to sending + retry the upload
                        setPendingVoiceNotes(prev => prev.map(v => v.tempId === pv.tempId ? { ...v, status: "sending" } : v));
                        sendVoiceNote.mutate({ tempId: pv.tempId, blobUrl: pv.blobUrl, blob: pv.blob, mimeType: pv.mimeType, tStart: performance.now() });
                      }}
                      onLoadStateChange={(state, url) => {
                        debugLiveRef.current.playbackUrlStatus = `${state} (${url.slice(0, 40)})`;
                        addDbg(`playback loadState="${state}" url="${url.slice(0, 40)}"`);
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} style={{ height: 0, margin: 0, padding: 0 }} />
          </div>{/* end inner message stack */}
        </div>

          {/* ── Voice Debug Panel — only in dev mode or ?voicedebug=1 ── */}
          {voiceDebugEnabled && expanded && (
            <VoiceDebugPanel
              live={debugLiveRef}
              log={debugLog}
              keyboardOpen={inputFocused}
              inputFocused={inputFocused}
              isRecording={isRecording}
              mediaRecorderRef={mediaRecorderRef}
              composerRef={composerRef}
              onClear={() => setDebugLog([])}
              onSnapCSS={() => {
                const snap = snapshotComposerCSS(composerRef.current);
                addDbg(`MANUAL-SNAP: ${snap}`);
              }}
            />
          )}

      {/* BOTTOM PANEL — sits at bottom of flex column, naturally above keyboard */}
      <div style={{ flexShrink: 0, background: "hsl(var(--background))" }}>
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
                    if (DEBUG_CALLS) console.log("[BUG2_PROOF] cancel_btn_pressed", { matchId: match.id, ts: Date.now(), iCancelledRef_before: iCancelledRef.current });
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
            <div ref={composerRef} className="px-2 pt-2 border-t" style={{ borderTop: "1px solid hsl(var(--border))", paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
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
              {/* ── First-time mic permission hint ── */}
              {voiceNotesUnlocked && micPermState !== "granted" && !wasMicGrantedBefore() && (
                <p className="text-[11px] text-muted-foreground/60 text-center mb-1 px-2 select-none" data-testid={`text-mic-hint-${match.id}`}>
                  Allow microphone once to send voice notes.
                </p>
              )}
              {/* ── Microphone access denied card ── */}
              {(micPermState === "denied" || micPermState === "unavailable") && voiceNotesUnlocked && (
                <div className="mb-2 rounded-xl border border-rose-200/60 bg-rose-50/50 dark:bg-rose-950/20 dark:border-rose-800/40 px-3 py-2.5" data-testid={`card-mic-denied-${match.id}`}>
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
                {/* ── Input wrapper with embedded mic ── */}
                {/*
                  IMPORTANT: The textarea is ALWAYS in the DOM. During recording we apply
                  `invisible pointer-events-none` so it takes up the exact same space but
                  isn't visible. An absolutely-positioned overlay shows the waveform on top.
                  This prevents ANY layout shift when recording starts/stops.
                */}
                <div className="relative flex-1">
                  <Textarea
                    ref={textareaRef}
                    value={message}
                    onChange={e => {
                      setMessage(e.target.value.slice(0, MAX_CHARS));
                      if (e.target.value.trim()) sendTyping();
                    }}
                    placeholder={t("write_meaningful_placeholder")}
                    className={`resize-none min-h-[40px] max-h-[96px] text-base pr-8 transition-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0${voicePhase === "recording" ? " opacity-0 pointer-events-none" : ""}`}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => {
                      // CRITICAL: if iOS fires blur while recording, refocus SYNCHRONOUSLY
                      // (no RAF delay). requestAnimationFrame gives the keyboard time to
                      // start its dismissal animation before focus returns. Synchronous
                      // .focus() inside the blur handler cancels the dismissal immediately.
                      const blurDuringRecording = isRecordingRef.current;
                      console.log(`[VOICE_NOTE_LAYOUT] input blurred? recording=${blurDuringRecording}`);
                      addDbg(`blur recording=${blurDuringRecording}`);
                      if (blurDuringRecording) {
                        textareaRef.current?.focus({ preventScroll: true }); // sync, no RAF
                        return;
                      }
                      setInputFocused(false);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (message.trim()) { const c = message.trim(); setMessage(""); doSend(c); }
                      }
                    }}
                    data-testid={`input-message-${match.id}`}
                  />
                  {/* Recording overlay — absolute so it occupies the same space as the textarea.
                      Colors use Lulou primary rose (hsl 350 45% 52%) throughout. */}
                  {voicePhase === "recording" && (
                    <div
                      className="absolute inset-0 flex items-center gap-2 px-3 pr-10 rounded-md select-none pointer-events-none"
                      style={{
                        border: "1px solid hsl(350 45% 52% / 0.35)",
                        background: "hsl(350 45% 52% / 0.05)",
                      }}
                    >
                      {cancelPending ? (
                        /* Slide-cancel mode: show cancel confirmation text */
                        <span
                          className="flex-1 text-sm font-medium"
                          style={{ color: "hsl(350 45% 48%)" }}
                        >
                          ← Release to cancel
                        </span>
                      ) : (
                        /* Normal recording: waveform bars (heights via direct DOM refs) */
                        <div className="flex items-end gap-[2px] h-[22px] flex-1">
                          {Array.from({ length: 20 }, (_, i) => (
                            <div
                              key={i}
                              ref={el => { if (el) waveformBarEls.current[i] = el; }}
                              style={{
                                flex: 1,
                                height: "3px",
                                borderRadius: 1.5,
                                background: "hsl(350 45% 52%)",
                                transition: "height 0.06s ease",
                                willChange: "height",
                              }}
                            />
                          ))}
                        </div>
                      )}
                      {/* Recording indicator dot + timer */}
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className="w-1.5 h-1.5 rounded-full animate-pulse"
                          style={{ background: "hsl(350 45% 52%)" }}
                        />
                        <span
                          className="text-sm font-mono tabular-nums font-semibold"
                          style={{ color: "hsl(350 45% 48%)" }}
                        >
                          {`${Math.floor(recordingTime / 60)}:${String(recordingTime % 60).padStart(2, "0")}`}
                        </span>
                      </div>
                    </div>
                  )}
                  {/* Mic inside the input — hold to record, release to send.
                      IMPORTANT: e.preventDefault() on pointerdown is CRITICAL on iOS.
                      Without it, pressing the mic button blurs the textarea → iOS keyboard
                      dismisses → visual viewport changes height → the entire composer jumps.
                      e.preventDefault() keeps focus on the textarea so the keyboard stays up. */}
                  <button
                    tabIndex={-1}
                    onPointerDown={e => {
                      // Prevent focus transfer and iOS keyboard dismissal — MUST be first
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      // Reset slide-cancel state for this new recording gesture
                      pointerStartXRef.current = e.clientX;
                      cancelPendingRef.current = false;
                      setCancelPending(false);
                      // CRITICAL: lock composer height SYNCHRONOUSLY before any React state
                      // change. This is the only safe moment — no async gap, no re-render,
                      // no useEffect. Setting minHeight here means even if the keyboard
                      // closes (viewport resize) or a conditional element changes height,
                      // the composer cannot shrink. Released in stopRecording/cancelRecording.
                      const composerEl = composerRef.current;
                      const r = composerEl?.getBoundingClientRect();
                      // Snapshot CSS BEFORE locking minHeight so we see the natural computed styles
                      const cssBefore = snapshotComposerCSS(composerEl ?? null);
                      if (composerEl && r) {
                        composerEl.style.minHeight = `${Math.round(r.height)}px`;
                      }
                      // Log + snapshot composer position BEFORE recording starts
                      const vv = window.visualViewport;
                      if (r) {
                        const txt = `top=${Math.round(r.top)} bot=${Math.round(r.bottom)} h=${Math.round(r.height)}`;
                        const vpTxt = vv ? ` VP.h=${Math.round(vv.height)} VP.ot=${Math.round(vv.offsetTop)}` : "";
                        debugLiveRef.current.composerBefore = txt + vpTxt;
                        debugLiveRef.current.composerCSSBefore = cssBefore;
                        debugLiveRef.current.composerDuring = "";
                        debugLiveRef.current.composerCSSDuring = "";
                        debugLiveRef.current.composerAfter = "";
                        debugLiveRef.current.composerCSSAfter = "";
                        debugLiveRef.current.voicePhase = "idle";
                        debugLiveRef.current.blobSize = 0;
                        debugLiveRef.current.blobType = "";
                        debugLiveRef.current.blobDurationMs = 0;
                        debugLiveRef.current.uploadStatus = "";
                        debugLiveRef.current.uploadBodyType = "";
                        debugLiveRef.current.uploadStartMs = 0;
                        debugLiveRef.current.uploadFailMs = 0;
                        debugLiveRef.current.uploadErrName = "";
                        debugLiveRef.current.uploadError = "";
                        debugLiveRef.current.uploadRespBody = "";
                        debugLiveRef.current.insertStatus = "";
                        debugLiveRef.current.playbackUrlStatus = "";
                        debugLiveRef.current.lastPointerEvent = `DOWN @ ${new Date().toISOString().slice(11,23)}`;
                        addDbg(`ptrDOWN — before: ${txt} minH=${Math.round(r.height)}px locked`);
                      }
                      if (!voiceNotesUnlocked) {
                        toast({ description: "Voice notes unlock after you've both sent 10 messages." });
                        return;
                      }
                      startRecording();
                    }}
                    onTouchStart={e => {
                      // iOS Safari: touchstart with preventDefault is the MOST RELIABLE way
                      // to prevent the browser from transferring focus away from the textarea.
                      // pointerdown+preventDefault alone is insufficient on some iOS versions.
                      e.preventDefault();
                      addDbg(`touchStart (iOS focus-lock)`);
                    }}
                    onPointerMove={e => {
                      // Slide-to-cancel: if user drags > 55px left while recording, arm cancel
                      if (!isRecordingRef.current) return;
                      const dx = e.clientX - pointerStartXRef.current;
                      const shouldCancel = dx < -55;
                      if (shouldCancel !== cancelPendingRef.current) {
                        cancelPendingRef.current = shouldCancel;
                        setCancelPending(shouldCancel);
                      }
                    }}
                    onPointerUp={e => {
                      e.preventDefault();
                      debugLiveRef.current.lastPointerEvent = `UP @ ${new Date().toISOString().slice(11,23)}`;
                      addDbg(`ptrUP — isRecording=${isRecordingRef.current} cancelPending=${cancelPendingRef.current}`);
                      stopRequestedRef.current = true;
                      if (isRecordingRef.current) {
                        // cancelPendingRef is always current (ref, not stale closure)
                        if (cancelPendingRef.current) {
                          cancelRecording();
                        } else {
                          stopRecording();
                        }
                      }
                    }}
                    onPointerCancel={e => {
                      e.preventDefault();
                      debugLiveRef.current.lastPointerEvent = `CANCEL @ ${new Date().toISOString().slice(11,23)}`;
                      addDbg(`ptrCANCEL — isRecording=${isRecordingRef.current}`);
                      stopRequestedRef.current = true;
                      if (isRecordingRef.current) cancelRecording();
                    }}
                    onContextMenu={e => e.preventDefault()}
                    onMouseDown={e => e.preventDefault()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center select-none"
                    style={{
                      touchAction: "none",
                      WebkitUserSelect: "none" as React.CSSProperties["WebkitUserSelect"],
                      WebkitTouchCallout: "none" as any,
                      transform: voicePhase === "recording" ? "scale(1.35)" : "scale(1)",
                      transition: "transform 200ms ease",
                    }}
                    data-testid={`button-mic-input-${match.id}`}
                    title={!voiceNotesUnlocked ? "Unlock voice notes" : voicePhase === "recording" ? "Release to send" : "Hold to record"}
                  >
                    <Mic
                      className="w-[18px] h-[18px]"
                      style={voicePhase === "recording"
                        ? { color: "hsl(350,45%,52%)", filter: "drop-shadow(0 0 8px hsl(350 45% 52% / 0.9))", transition: "all 200ms ease" }
                        : voiceNotesUnlocked
                        ? { color: "rgb(34,197,94)", filter: "drop-shadow(0 0 5px rgba(34,197,94,0.7))", transition: "all 200ms ease" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.35, transition: "all 200ms ease" }}
                    />
                  </button>
                  {/* Pulsing halo ring around mic while recording — Lulou rose, no layout impact */}
                  {voicePhase === "recording" && (
                    <span
                      className="absolute right-2 bottom-[10px] w-[18px] h-[18px] rounded-full animate-ping pointer-events-none"
                      style={{ background: "hsl(350 45% 52% / 0.22)", animationDuration: "1.4s" }}
                    />
                  )}
                </div>
                {/*
                  AI starters and phone buttons use !inputFocused as a RENDER condition
                  (not just visibility) so the input is truly full-width when the keyboard is open.
                  This is SAFE with e.preventDefault() on the mic button: mic press never causes
                  a blur when the keyboard is open, so inputFocused stays true and these buttons
                  are never inserted into the DOM mid-recording (which would cause a shift).
                  When recording starts while the keyboard is CLOSED (inputFocused=false),
                  the buttons are already in the DOM — we use visibility:hidden so they keep
                  their flex space without being removed.
                */}
                {/* ✨ Conversation starters — hidden while input is focused */}
                {aiStartersEnabled && !inputFocused && (
                  <Button
                    size="icon"
                    variant="ghost"
                    tabIndex={-1}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setShowAIStarters(v => !v)}
                    className={showAIStarters ? "text-primary" : "text-muted-foreground"}
                    style={{ visibility: voicePhase === "recording" ? "hidden" : "visible" }}
                    data-testid={`button-ai-starters-${match.id}`}
                  >
                    <Sparkles className="w-4 h-4" />
                  </Button>
                )}
                {/* 📞 Voice call shortcut — only when keyboard is closed */}
                {!allCallsDone && !inputFocused && (
                  <button
                    tabIndex={-1}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      if ((phoneCredits ?? 0) > 0) startPaidCall.mutate({ isVideo: false });
                      else setPurchasePromptFeature("phone");
                    }}
                    disabled={startPaidCall.isPending}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90 disabled:opacity-50 hover:bg-muted/40"
                    style={{ visibility: voicePhase === "recording" ? "hidden" : "visible" }}
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
                {/* 🎥 Video / face call shortcut — always visible at any call-capable
                    stage so the icon is next to the phone icon in the composer.
                    Grey/locked when no credits; active (indigo glow) when available.
                    Previously gated on allCallsDone which hid it during early stages. */}
                {!inputFocused && (
                  <button
                    tabIndex={-1}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      if ((videoCredits ?? 0) > 0) startPaidCall.mutate({ isVideo: true });
                      else setPurchasePromptFeature("video");
                    }}
                    disabled={startPaidCall.isPending}
                    className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-all active:scale-90 disabled:opacity-50 hover:bg-muted/40"
                    style={{ visibility: voicePhase === "recording" ? "hidden" : "visible" }}
                    data-testid={`button-video-composer-${match.id}`}
                    title={t("start_video_call")}
                  >
                    <Video
                      className="w-[18px] h-[18px] transition-all duration-300"
                      style={!callCreditsData
                        ? { color: "hsl(var(--muted-foreground))", opacity: 0.4 }
                        : (videoCredits ?? 0) > 0
                        ? { color: "rgb(99,102,241)", filter: "drop-shadow(0 0 5px rgba(99,102,241,0.7))" }
                        : { color: "hsl(var(--muted-foreground))", opacity: 0.5 }}
                    />
                  </button>
                )}
                {/* ➤ Send / Cancel — same size="icon" in both states so the flex row doesn't shift */}
                {voicePhase === "recording" ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    tabIndex={-1}
                    onMouseDown={e => e.preventDefault()}
                    onClick={cancelRecording}
                    data-testid={`button-cancel-recording-${match.id}`}
                  >
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
              <p className="text-xs text-muted-foreground mt-1 text-start">
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
      </div>{/* /bottom panel */}
      </div>{/* /chat column */}

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
          className="lg:hidden fixed inset-0 z-[200]"
          data-testid="profile-panel-mobile-sheet"
          style={{ animation: "sheetFadeIn 0.18s ease both" }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: "rgba(0,0,0,0.48)",
              opacity: sheetDragY > 0 ? Math.max(0.1, 1 - sheetDragY / 320) : 1,
              transition: isSheetDragging ? "none" : "opacity 0.25s ease",
              backdropFilter: isMobile ? undefined : "blur(4px)",
              WebkitBackdropFilter: isMobile ? undefined : "blur(4px)",
            }}
            onClick={() => { if (!isSheetDragging) setShowProfilePanel(false); }}
          />
          <div
            className="absolute inset-x-0 bottom-0 overflow-hidden"
            style={{
              maxHeight: "88dvh",
              borderRadius: "20px 20px 0 0",
              background: "hsl(var(--background))",
              boxShadow: "0 -8px 40px rgba(0,0,0,0.18)",
              animation: sheetDragY > 0 ? "none" : "sheetSlideUp 0.28s cubic-bezier(0.22,1,0.36,1) both",
              transform: sheetDragY > 0 ? `translateY(${sheetDragY}px)` : undefined,
              transition: isSheetDragging ? "none" : "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)",
            }}
          >
            {/* Drag handle — native-feel iOS sheet dismiss */}
            <div
              className="flex justify-center pt-2.5 pb-2 flex-shrink-0 cursor-grab active:cursor-grabbing"
              style={{ touchAction: "none" }}
              onPointerDown={e => {
                sheetGestureRef.current = {
                  active: true,
                  startY: e.clientY,
                  velocityBuf: [{ y: e.clientY, t: Date.now() }],
                };
                setIsSheetDragging(false);
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={e => {
                const g = sheetGestureRef.current;
                if (!g.active) return;
                const dy = e.clientY - g.startY;
                if (dy > 1) {
                  if (!isSheetDragging) setIsSheetDragging(true);
                  // 1:1 tracking up to 160 px, then 25% resistance — matches iOS Maps physics
                  const translated = dy <= 160 ? dy : 160 + (dy - 160) * 0.25;
                  setSheetDragY(translated);
                  // Velocity ring buffer — cap at 8 samples for performance
                  g.velocityBuf.push({ y: e.clientY, t: Date.now() });
                  if (g.velocityBuf.length > 8) g.velocityBuf.shift();
                }
              }}
              onPointerUp={e => {
                const g = sheetGestureRef.current;
                if (!g.active) return;
                g.active = false;
                const dy = e.clientY - g.startY;
                setIsSheetDragging(false);
                // Velocity from last 4 samples (px/s, positive = downward)
                let velocity = 0;
                const buf = g.velocityBuf;
                if (buf.length >= 2) {
                  const recent = buf.slice(-4);
                  const dt = recent[recent.length - 1].t - recent[0].t;
                  const dd = recent[recent.length - 1].y - recent[0].y;
                  velocity = dt > 0 ? (dd / dt) * 1000 : 0;
                }
                // Dismiss: distance threshold OR velocity flick
                const shouldDismiss = dy > 50 || velocity > 450;
                setSheetDragY(0);
                if (shouldDismiss) setShowProfilePanel(false);
              }}
              onPointerCancel={() => {
                sheetGestureRef.current.active = false;
                setIsSheetDragging(false);
                setSheetDragY(0);
              }}
            >
              <div className="w-10 h-1 rounded-full" style={{ background: "hsl(var(--muted-foreground)/0.25)" }} />
            </div>
            <div style={{ height: "calc(88dvh - 24px)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <ProfilePanel profile={match.profile} onClose={() => { setSheetDragY(0); setShowProfilePanel(false); }} />
            </div>
          </div>
        </div>
      )}
      <PurchasePrompt
        feature={purchasePromptFeature}
        onClose={() => setPurchasePromptFeature(null)}
        returnPath={window.location.pathname}
      />

      {voiceNotePopupOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 px-6" data-testid={`dialog-voice-note-unlock-${match.id}`}>
          <div className="bg-background rounded-2xl p-6 w-full max-w-xs shadow-xl text-center">
            <p className="text-3xl mb-3">🎙️</p>
            <h2 className="font-semibold text-lg mb-2">Voice notes unlocked</h2>
            <p className="text-sm text-muted-foreground mb-5">
              You've both sent 8 messages — voice notes are now open. Keep the conversation going.
            </p>
            <Button
              className="w-full"
              onClick={() => {
                localStorage.setItem(`vn_popup_${match.id}`, "1");
                setVoiceNotePopupOpen(false);
                // Optimistically mark seen in cache so popup won't show again on re-mount
                queryClient.setQueryData(
                  ["/api/voice-notes/entitlement", match.id],
                  (old: any) => old ? { ...old, popupSeen: true } : old,
                );
                // Persist to server so it's durable across devices
                apiRequest("POST", `/api/voice-notes/popup-seen/${match.id}`).catch(() => {});
              }}
              data-testid={`button-voice-note-popup-continue-${match.id}`}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {firstCallPopupOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 px-6" data-testid={`dialog-first-call-unlock-${match.id}`}>
          <div className="bg-background rounded-2xl p-6 w-full max-w-xs shadow-xl text-center">
            <p className="text-3xl mb-3">📞</p>
            <h2 className="font-semibold text-lg mb-2">First call unlocked</h2>
            <p className="text-sm text-muted-foreground mb-5">
              You've both sent 15 messages. Time to hear each other's voices — schedule your first call below.
            </p>
            <Button
              className="w-full"
              onClick={() => {
                localStorage.setItem(`fc_popup_${match.id}`, "1");
                setFirstCallPopupOpen(false);
                // Optimistically mark seen in cache so popup won't re-appear on re-mount
                queryClient.setQueryData(
                  ["/api/voice-notes/entitlement", match.id],
                  (old: any) => old ? { ...old, firstCallPromptSeen: true } : old,
                );
                // Persist to server so it's durable across devices
                apiRequest("POST", `/api/first-call/prompt-seen/${match.id}`).catch(() => {});
              }}
              data-testid={`button-first-call-popup-continue-${match.id}`}
            >
              Let's go
            </Button>
          </div>
        </div>
      )}

      {micHoldGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.MIC_HOLD}
          userId={user?.id}
          icon="🎙"
          title="Hold to record a voice note"
          body="Release to send automatically. Slide left to cancel."
          delay={400}
        />
      )}
      {chatGuideTriggered && (
        <LulouGuide
          guideKey={GUIDE_KEYS.CHAT_FIRST_MESSAGE}
          userId={user?.id}
          title="15 messages each way"
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
              ? renderMatchPreview(match.lastMessage, userId, match.profile.firstName, t)
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

  // ── Active chat session tracking (push suppression) ────────────────────────
  // When the user opens a chatroom, POST the matchId to the server so it knows
  // the recipient is actively viewing this chat.  A 20-second heartbeat keeps
  // the row fresh while they remain in the chat.  On exit (close button, back,
  // unmount, or page hidden) the row is cleared so push notifications resume.
  useEffect(() => {
    if (!user?.id) return;
    if (!expandedMatchId) {
      // User closed the chat — clear the active record (fire-and-forget)
      fetch("/api/chat/active", { method: "DELETE", credentials: "include" }).catch(() => {});
      return;
    }

    // User opened a chat — register immediately
    const register = () =>
      fetch("/api/chat/active", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: expandedMatchId }),
      }).catch(() => {});

    register();

    // Heartbeat: re-POST every 20s to keep the row fresh (server window is 45s)
    const heartbeatId = setInterval(register, 20_000);

    // If user backgrounds the page / switches tabs, clear the record immediately
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        fetch("/api/chat/active", { method: "DELETE", credentials: "include" }).catch(() => {});
      } else if (document.visibilityState === "visible") {
        // Re-register when they come back
        register();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(heartbeatId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      fetch("/api/chat/active", { method: "DELETE", credentials: "include" }).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedMatchId, user?.id]);
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

  if (fetchFailed) {
    const errMsg = matchesError?.message || requestsError?.message || t("could_not_load_connections");
    console.error("MATCHES_FETCH_ERROR", errMsg);
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
            <Moon className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="font-serif text-xl font-bold" data-testid="text-matches-error">{t("something_went_wrong")}</h2>
          <p className="text-muted-foreground text-sm" data-testid="text-matches-error-detail">{t("we_are_having_trouble_loading")}</p>
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
      <div className="fixed inset-0 z-[10000] bg-background" data-testid="chat-focused-view">
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
