import { useState, useRef, useEffect, useCallback, useMemo, memo, Fragment, type ReactNode } from "react";
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
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Phone, Video, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, PhoneOff, Clock, Check, X, Sparkles, Calendar, Heart, PhoneForwarded, Moon, User, MapPin } from "lucide-react";
import { LulouFlowerIcon, ProfileAvatar } from "@/components/app-layout";
import { usePerfTrace, useRenderCount, isMobile, scheduleIdle } from "@/lib/perf";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import { PhotoCarousel } from "@/components/photo-carousel";
import { EMPTY_PHOTOS } from "@/lib/image-utils";
import type { Profile, Match, Message, SpinRequest } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_POST_CALL_MESSAGES = 12;
const MAX_POST_STAGE2_MESSAGES = 20;
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

  const stageLabel = isFaceCall ? "Face call" : callStage === 0 ? "First call" : "Second call";
  const completeMessage = callStage === 0
    ? "Great first call! Ready for a longer conversation?"
    : callStage === 1
    ? "Wonderful second call! Would you like to see each other face-to-face?"
    : "Amazing face call! Ready to meet in real life?";

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
            <p className="font-medium text-sm">{stageLabel} in progress</p>
            <p className="text-xs text-muted-foreground">
              {remaining <= 60
                ? "Less than a minute remaining"
                : `${Math.ceil(remaining / 60)} minutes remaining`}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onComplete((duration - remaining) * 1000)}
              data-testid={`button-end-call-${match.id}`}
            >
              <PhoneOff className="w-4 h-4 mr-2" /> End Call
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="font-medium text-sm">Time's up!</p>
            <p className="text-xs text-muted-foreground">{completeMessage}</p>
            <Button
              size="sm"
              onClick={() => onComplete(duration * 1000)}
              data-testid={`button-finish-call-${match.id}`}
            >
              Complete Call
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

  const respond = useMutation({
    mutationFn: async (accept: boolean) => {
      const res = await apiRequest("POST", `/api/spin-requests/${request.id}/respond`, { accept });
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.matchCreated) {
        toast({
          title: "Connected",
          description: `You and ${request.profile.firstName} are now matched! Check your connections.`,
        });
      } else if (data.status === "declined") {
        toast({
          title: "Declined",
          description: `You passed on ${request.profile.firstName}'s request.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/spin-requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
    },
    onError: () => {
      toast({
        title: "Something went wrong",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const timeAgo = request.createdAt
    ? (() => {
        const diff = Date.now() - new Date(request.createdAt).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "Just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
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
                <Sparkles className="w-3 h-3 mr-1" /> Via Intention Wheel
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
              <Check className="w-4 h-4" /> Accept
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-1.5"
              onClick={() => respond.mutate(false)}
              disabled={respond.isPending}
              data-testid={`button-decline-request-${request.id}`}
            >
              <X className="w-4 h-4" /> Decline
            </Button>
          </div>
        )}

        {type === "outgoing" && (
          <div className="mt-3">
            <Badge variant="secondary" className="text-xs" data-testid={`badge-request-status-${request.id}`}>
              {request.status === "pending" ? "Waiting for response" :
               request.status === "accepted" ? "Accepted" : "Declined"}
            </Badge>
          </div>
        )}
      </div>
    </Card>
  );
}

function generateDateSlots(): { label: string; value: string }[] {
  const slots: { label: string; value: string }[] = [];
  const now = new Date();
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const timeSlots = [
    { label: "Morning (10am)", time: "10:00" },
    { label: "Afternoon (2pm)", time: "14:00" },
    { label: "Evening (7pm)", time: "19:00" },
    { label: "Late evening (8:30pm)", time: "20:30" },
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
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const dateSlots = generateDateSlots();

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
      toast({ title: "Availability shared" });
      setShowDatePicker(false);
    },
    onError: (e: Error) => { toast({ title: "Could not save", description: e.message, variant: "destructive" }); },
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
      toast({ title: "Number shared" });
      setShowPhoneInput(false);
    },
    onError: (e: Error) => { toast({ title: "Could not share", description: e.message, variant: "destructive" }); },
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
            <p className="font-medium text-sm">Add your phone number</p>
            <p className="text-xs text-muted-foreground">It will be sent as a message to {profileName}</p>
          </div>
          <Input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="Your phone number" maxLength={20} data-testid={`input-phone-inline-${matchId}`} />
          <div className="flex items-center gap-2 justify-center">
            <Button size="sm" onClick={() => savePhoneAndExchange.mutate()} disabled={!phoneNumber.trim() || savePhoneAndExchange.isPending} data-testid={`button-confirm-exchange-inline-${matchId}`}>
              {savePhoneAndExchange.isPending ? "Sending..." : "Share My Number"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowPhoneInput(false)}>Cancel</Button>
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
            <p className="font-medium text-sm">When are you free?</p>
            <p className="text-xs text-muted-foreground">Select up to 5 time slots</p>
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
          <p className="text-xs text-muted-foreground text-center">{selectedSlots.length}/5 selected</p>
          <div className="flex items-center gap-2 justify-center">
            <Button size="sm" onClick={() => saveAvailability.mutate()} disabled={selectedSlots.length === 0 || saveAvailability.isPending} data-testid={`button-save-avail-inline-${matchId}`}>
              {saveAvailability.isPending ? "Saving..." : "Share Availability"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDatePicker(false)}>Cancel</Button>
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
          <p className="font-medium text-sm">Number shared</p>
          <p className="text-xs text-muted-foreground">
            {theirNumberExchanged ? "You've both exchanged numbers!" : `Waiting for ${profileName} to share theirs.`}
          </p>
          {matchingSlots.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-xs font-medium text-muted-foreground">Your matching date times:</p>
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
        <p className="font-medium text-sm">All calls completed</p>
        <p className="text-xs text-muted-foreground">Ready to meet in real life?</p>

        {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2 justify-center">
              <Heart className="w-3.5 h-3.5 text-primary" />
              <p className="font-medium text-xs text-primary">Your date is on the cards!</p>
              <Heart className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">You both matched on:</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} className="text-xs bg-primary/15 text-primary border-primary/30">{m?.label || s}</Badge>; })}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-center pt-1">
              <Button size="sm" onClick={handleExchangeNumber} data-testid={`button-exchange-number-${matchId}`}>
                <PhoneForwarded className="w-4 h-4 mr-2" /> Exchange Number
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid={`button-update-avail-${matchId}`}>
                <Calendar className="w-4 h-4 mr-2" /> Update Availability
              </Button>
            </div>
          </div>
        ) : (
          <>
            {mySlots.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Your availability:</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {mySlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} variant="secondary" className="text-xs">{m?.label || s}</Badge>; })}
                </div>
              </div>
            )}
            {theirSlots.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{profileName}'s availability:</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {theirSlots.map((s: string) => { const m = dateSlots.find(d => d.value === s); return <Badge key={s} variant="outline" className="text-xs">{m?.label || s}</Badge>; })}
                </div>
              </div>
            )}
            {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length === 0 && (
              <p className="text-xs text-muted-foreground">No matching times yet. Try updating your availability!</p>
            )}
            <div className="flex flex-col gap-2 items-center">
              {mySlots.length === 0 ? (
                <Button size="sm" onClick={() => setShowDatePicker(true)} data-testid={`button-ready-to-meet-${matchId}`}>
                  <Calendar className="w-4 h-4 mr-2" /> Ready to Meet
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid={`button-update-avail-${matchId}`}>
                  <Calendar className="w-4 h-4 mr-2" /> Update Availability
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

function parseScheduleData(msg: Message): { type: string; proposedBy: string; proposedTime: string; stage: number } | null {
  if (!msg.content.startsWith(SCHEDULE_PREFIX)) return null;
  try { return JSON.parse(msg.content.slice(SCHEDULE_PREFIX.length)); }
  catch { return null; }
}

function formatScheduledTime(d: Date, now: number): string {
  const diff = d.getTime() - now;
  if (diff <= 60000) return "now";
  if (diff < 3600000) return `in ${Math.round(diff / 60000)} min`;
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function TimePickerInline({
  quickTimes,
  selectedTime,
  setSelectedTime,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm time",
}: {
  quickTimes: { label: string; value: string }[];
  selectedTime: string;
  setSelectedTime: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  return (
    <div className="space-y-2 pt-1">
      {quickTimes.map(qt => (
        <button
          key={qt.label}
          className={`w-full text-sm px-3 py-2 rounded-md border transition-colors text-left ${selectedTime === qt.value ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted/50"}`}
          onClick={() => setSelectedTime(qt.value)}
        >
          {qt.label}
        </button>
      ))}
      <div className="flex items-center gap-1.5 pt-0.5">
        <span className="text-xs text-muted-foreground shrink-0">Pick a time:</span>
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
          Cancel
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
}: {
  matchId: string;
  matchName: string;
  allMessages: Message[];
  callStage: number;
  startCallPending: boolean;
  onStartCall: () => void;
}) {
  const { user } = useAuth();
  const [showPicker, setShowPicker] = useState(false);
  const [selectedTime, setSelectedTime] = useState("");
  const [now, setNow] = useState(Date.now());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
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
      const t = new Date(scheduleData.proposedTime).getTime();
      if (t <= now + 5 * 60 * 1000) {
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
      toast({ title: "Couldn't schedule call", description: err?.message || "Something went wrong", variant: "destructive" });
    },
  });

  const iAmProposer = scheduleData?.proposedBy === user?.id;
  const scheduledTime = scheduleData?.proposedTime ? new Date(scheduleData.proposedTime) : null;
  const isReadyToStart = scheduleData?.type === "accept" && scheduledTime && scheduledTime.getTime() <= now + 5 * 60 * 1000;
  const callLabel = callStage === 0 ? "first" : "second";
  const callDuration = callStage === 0 ? "10-minute" : "15-minute";
  const isVideoCall = callStage === 1; // Second call is video

  const quickTimes = [
    { label: "Available now", value: new Date().toISOString() },
    { label: "In 30 minutes", value: new Date(now + 30 * 60000).toISOString() },
    { label: "In 1 hour", value: new Date(now + 60 * 60000).toISOString() },
    { label: "In 2 hours", value: new Date(now + 2 * 60 * 60000).toISOString() },
  ];

  const propose = (time: string) => scheduleMutation.mutate({ action: "propose", proposedTime: time });
  const reschedule = (time: string) => scheduleMutation.mutate({ action: "reschedule", proposedTime: time });

  if (isReadyToStart) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-ready-${matchId}`}>
        <Card className="p-4 text-center space-y-3 bg-green-50/60 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/40">
          <div className="flex items-center justify-center gap-2">
            {isVideoCall ? (
              <Video className="w-5 h-5 text-green-600 dark:text-green-400" />
            ) : (
              <Phone className="w-5 h-5 text-green-600 dark:text-green-400" />
            )}
            <p className="font-semibold text-sm text-green-700 dark:text-green-400">
              {isVideoCall ? "It's time to see each other!" : "It's time to talk!"}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {isVideoCall
              ? "Your second call is a video call. Start when you're both ready."
              : `Your ${callLabel} call is ready. Start when you're both on.`}
          </p>
          <Button size="sm" onClick={onStartCall} disabled={startCallPending} className="bg-green-600 hover:bg-green-700 text-white" data-testid={`button-start-scheduled-call-${matchId}`}>
            {isVideoCall ? (
              <><Video className="w-4 h-4 mr-2" /> Start Video Call</>
            ) : (
              <><Phone className="w-4 h-4 mr-2" /> Start {callLabel === "first" ? "First" : "Second"} Call</>
            )}
          </Button>
        </Card>
      </div>
    );
  }

  if (scheduleData?.type === "accept" && scheduledTime) {
    return (
      <div className="p-4 border-t" data-testid={`call-schedule-confirmed-${matchId}`}>
        <Card className="p-4 text-center space-y-2.5 bg-primary/5 border-primary/20">
          <Check className="w-5 h-5 text-primary mx-auto" />
          <p className="font-medium text-sm">Call confirmed</p>
          <p className="text-xs font-medium text-primary">{scheduledTime.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} at {scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
          <p className="text-xs text-muted-foreground">{formatScheduledTime(scheduledTime, now)} — the Start button will appear 5 min before</p>
          <Button size="sm" variant="ghost" className="text-xs text-muted-foreground h-7" onClick={() => { setShowPicker(true); }} data-testid={`button-reschedule-${matchId}`}>Change time</Button>
          {showPicker && (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel="Reschedule"
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
            <p className="font-medium text-sm">Waiting for {matchName}…</p>
          </div>
          {scheduledTime && (
            <p className="text-xs text-muted-foreground">You proposed {formatScheduledTime(scheduledTime, now)} ({scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</p>
          )}
          {!showPicker ? (
            <Button size="sm" variant="outline" className="w-full" onClick={() => setShowPicker(true)} data-testid={`button-change-proposal-${matchId}`}>
              <Clock className="w-3.5 h-3.5 mr-1.5" /> Suggest a different time
            </Button>
          ) : (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel="Update proposal"
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
            {isVideoCall ? (
              <Video className="w-4 h-4 text-primary shrink-0" />
            ) : (
              <Phone className="w-4 h-4 text-primary shrink-0" />
            )}
            <p className="font-medium text-sm">
              {matchName} wants to schedule your {isVideoCall ? "video call" : `${callLabel} call`}
            </p>
          </div>
          {scheduledTime && (
            <p className="text-xs text-muted-foreground">Proposed: {formatScheduledTime(scheduledTime, now)} ({scheduledTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})</p>
          )}
          {!showPicker ? (
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => scheduleMutation.mutate({ action: "accept" })} disabled={scheduleMutation.isPending} data-testid={`button-accept-schedule-${matchId}`}>
                <Check className="w-3.5 h-3.5 mr-1" /> Accept
              </Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowPicker(true)} data-testid={`button-suggest-time-${matchId}`}>
                <Clock className="w-3.5 h-3.5 mr-1" /> Different time
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
              confirmLabel="Propose this time"
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
          <p className="font-medium text-sm text-center">That time didn't work</p>
          <p className="text-xs text-muted-foreground text-center">Either of you can suggest a new time.</p>
          {!showPicker ? (
            <Button size="sm" className="w-full" onClick={() => setShowPicker(true)} data-testid={`button-propose-new-time-${matchId}`}>
              <Calendar className="w-4 h-4 mr-2" /> Propose a new time
            </Button>
          ) : (
            <TimePickerInline
              quickTimes={quickTimes}
              selectedTime={selectedTime}
              setSelectedTime={setSelectedTime}
              confirmLabel="Send proposal"
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
        {isVideoCall ? (
          <Video className="w-5 h-5 text-primary mx-auto" />
        ) : (
          <Phone className="w-5 h-5 text-primary mx-auto" />
        )}
        <p className="font-medium text-sm text-center">
          {callStage === 0 ? "Ready for your first call?" : "Ready for your video call?"}
        </p>
        <p className="text-xs text-muted-foreground text-center">
          {isVideoCall
            ? `Schedule your ${callDuration} video call — camera and mic will be used.`
            : `Schedule your ${callDuration} ${callLabel} call. Pick a time that works for you.`}
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
              <Calendar className="w-4 h-4 mr-2" /> Pick a specific time
            </Button>
          </div>
        ) : (
          <TimePickerInline
            quickTimes={[]}
            selectedTime={selectedTime}
            setSelectedTime={setSelectedTime}
            confirmLabel="Propose this time"
            onConfirm={() => { if (selectedTime) propose(selectedTime); }}
            onCancel={() => { setShowPicker(false); setSelectedTime(""); }}
          />
        )}
      </Card>
    </div>
  );
}

function SparkProgressBar({ sparkStep }: { sparkStep: number }) {
  const steps = ["Match", "Chat", "1st Call", "2nd Call", "Meet"];
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
  const { data: photoData } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const photos = photoData?.photos ?? profile.photos ?? EMPTY_PHOTOS;
  const [photoIdx, setPhotoIdx] = useState(0);

  return (
    <div className="flex flex-col h-full bg-background" data-testid="profile-panel">
      <style>{`
        @keyframes profilePanelIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .profile-panel-body { animation: profilePanelIn 0.22s ease both; }
      `}</style>

      {/* PhotoCarousel handles swipe/drag — overlays injected as children */}
      <PhotoCarousel
        photos={photos}
        height={300}
        currentIndex={photoIdx}
        onIndexChange={setPhotoIdx}
        showArrows={false}
        showDots={false}
        className="flex-shrink-0"
      >
        {/* Bottom gradient */}
        <div
          className="absolute inset-x-0 bottom-0 pointer-events-none z-10"
          style={{ height: "60%", background: "linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.28) 55%, transparent 100%)" }}
        />

        {/* Left arrow */}
        {photos.length > 1 && photoIdx > 0 && (
          <button
            onClick={() => setPhotoIdx(i => Math.max(i - 1, 0))}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center rounded-full transition-all active:scale-90"
            style={{ width: 32, height: 32, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
            data-testid="button-profile-photo-prev"
          >
            <ChevronLeft className="w-4 h-4 text-white" />
          </button>
        )}

        {/* Right arrow (offset from close button) */}
        {photos.length > 1 && photoIdx < photos.length - 1 && (
          <button
            onClick={() => setPhotoIdx(i => Math.min(i + 1, photos.length - 1))}
            className="absolute right-10 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center rounded-full transition-all active:scale-90"
            style={{ width: 32, height: 32, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
            data-testid="button-profile-photo-next"
          >
            <ChevronRight className="w-4 h-4 text-white" />
          </button>
        )}

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-20 flex items-center justify-center rounded-full transition-all active:scale-90"
          style={{ width: 34, height: 34, background: "rgba(0,0,0,0.38)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.18)" }}
          data-testid="button-close-profile-panel"
        >
          <X className="w-4 h-4 text-white" />
        </button>

        {/* Name + location overlay */}
        <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-4">
          <h2 className="font-serif font-bold text-white leading-tight" style={{ fontSize: 22, textShadow: "0 1px 8px rgba(0,0,0,0.5)" }} data-testid="text-profile-panel-name">
            {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
          </h2>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            {profile.location && (
              <span className="flex items-center gap-1 text-white/80 text-xs" data-testid="text-profile-panel-location">
                <MapPin className="w-3 h-3" />
                {profile.location}
              </span>
            )}
            {profile.height && (
              <span className="text-white/70 text-xs" data-testid="text-profile-panel-height">{profile.height}</span>
            )}
          </div>
        </div>

        {/* Top story-bar indicators */}
        {photos.length > 1 && (
          <div className="absolute top-3 left-0 right-10 flex gap-1 px-3 z-20">
            {photos.map((_, i) => (
              <button
                key={i}
                className="flex-1 rounded-full transition-all active:scale-95"
                style={{ height: 3, background: i === photoIdx ? "rgba(255,255,255,0.96)" : "rgba(255,255,255,0.38)" }}
                onClick={() => setPhotoIdx(i)}
                data-testid={`button-profile-photo-dot-${i}`}
              />
            ))}
          </div>
        )}
      </PhotoCarousel>

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
              {profile.datingIntent}
            </span>
          </div>
        )}

        <div className="px-4 pt-4 space-y-5 pb-6">
          {profile.signals && profile.signals.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Vibes</p>
              <div className="flex flex-wrap gap-1.5">
                {profile.signals.map((s, i) => (
                  <span
                    key={i}
                    className="rounded-full px-3 py-1 text-xs font-medium"
                    style={{ background: "hsl(var(--muted))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))" }}
                    data-testid={`badge-profile-panel-signal-${i}`}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.greenFlags && profile.greenFlags.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Green Flags</p>
              <div className="flex flex-wrap gap-1.5">
                {profile.greenFlags.map((f, i) => (
                  <span
                    key={i}
                    className="rounded-full px-3 py-1 text-xs font-medium"
                    style={{ background: "hsl(155 25% 88%)", color: "hsl(155 30% 26%)", border: "1px solid hsl(155 25% 78%)" }}
                    data-testid={`badge-profile-panel-flag-${i}`}
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {profile.connectionStyle && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Connection Style</p>
              <p className="text-sm leading-relaxed text-foreground/85 font-serif italic" data-testid="text-profile-panel-connection-style">
                "{profile.connectionStyle}"
              </p>
            </div>
          )}

          {profile.conversationStarters && profile.conversationStarters.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Ask me about</p>
              <div className="space-y-2">
                {profile.conversationStarters.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-2xl px-4 py-3"
                    style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}
                    data-testid={`text-profile-panel-starter-${i}`}
                  >
                    <p className="text-sm leading-relaxed text-foreground/80">{s}</p>
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

function MatchChat({ match, expanded, onToggleExpand, unreadCount, onMarkRead }: {
  match: MatchWithProfile;
  expanded: boolean;
  onToggleExpand: () => void;
  unreadCount: number;
  onMarkRead: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [message, setMessage] = useState("");
  const [showProfilePanel, setShowProfilePanel] = useState(false);

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
  });

  useRealtimeMessages(match.id, expanded);

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
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueryData<MatchDetail>(["/api/matches", match.id], {
          ...previous,
          messages: [...(previous.messages || []), optimisticMsg],
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

      // Immediately reflect the incremented post-call count so bothPostCallLimitReached / bothStage2LimitReached
      // updates without waiting for the next 10s poll
      if ((callStage === 1 || callStage === 2) && realMsg.senderId === user?.id) {
        const current = queryClient.getQueryData<MatchDetail>(["/api/matches", match.id]);
        if (current) {
          const countPatch = current.user1Id === user.id
            ? { messageCount1: (current.messageCount1 || 0) + 1 }
            : { messageCount2: (current.messageCount2 || 0) + 1 };
          mergeCallFields(queryClient, match.id, countPatch);
        }
      }
    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/matches", match.id], context.previous);
      }
      toast({ title: "Could not send", description: error.message, variant: "destructive" });
    },
  });

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
    },
    onError: (error: Error) => {
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      console.error("[CALL_UI] CALL_START_FAILED", { matchId: match.id, route: "call/start", error: error.message, isAuth });
      toast({
        title: isAuth ? "Session expired" : "Call failed",
        description: isAuth ? "Please refresh and try again." : (error.message || "Unknown server error"),
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
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      if (data?.status === "repaired") {
        toast({ title: "Call cleared", description: "You can now retry your call." });
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_REPAIR] REPAIR_FAILED", { matchId: match.id, error: error.message });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Couldn't clear call", description: "Please try again in a moment.", variant: "destructive" });
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
      toast({ title: "Call cancelled" });
    },
    onError: (error: Error) => {
      const isAuth = error.message === "Unauthorized" || error.message.startsWith("401");
      console.error("[CALL_UI] CALL_CANCEL_FAILED", { matchId: match.id, error: error.message, isAuth });
      markCallSessionCancelled(match.id, lastCallSessionIdRef.current);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      toast({
        title: isAuth ? "Session expired" : "Cancel failed",
        description: isAuth ? "Please refresh and try again." : error.message,
        variant: "destructive",
      });
    },
  });

  const completeCall = useMutation({
    mutationFn: async (vars: { connectedDurationMs: number; callState?: string } = { connectedDurationMs: 0 }) => {
      const body = {
        // CallTimer only shows when the call is active in the DB — treat as connected
        connected: vars.connectedDurationMs > 0,
        connectedDurationMs: vars.connectedDurationMs,
        callState: vars.callState ?? "ended",
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
        toast({ title: "Call ended", description: "The call didn't connect long enough to count — your call slot has been returned." });
      } else {
        const stage = data.callStage || 0;
        if (stage === 1) {
          toast({ title: "First call completed", description: "You now have 12 messages each before your next call." });
        } else if (stage === 2) {
          toast({ title: "Second call completed", description: "You each have 20 messages before the face call unlocks." });
        } else if (stage === 3) {
          toast({ title: "Face call stage unlocked", description: "Would you like a face-to-face video call?" });
        } else {
          toast({ title: "Call completed", description: "Great conversation! Ready to meet in person?" });
        }
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_COMPLETE] FRONTEND_ERROR", { matchId: match.id, error: error.message });
      markCallSessionCancelled(match.id, lastCallSessionIdRef.current);
      mergeCallFields(queryClient, match.id, { callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null });
      broadcastCallSignal(match.id, { type: "call:ended" as any, matchId: match.id, userId: user?.id || "" });
      toast({ title: "Call ended", description: "Connection lost. Returning to chat.", variant: "destructive" });
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
      toast({ title: "Couldn't answer call", description: error.message, variant: "destructive" });
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
      toast({ title: "Call declined" });
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_DECLINE_FAILED", { matchId: match.id, error: error.message });
      toast({ title: "Couldn't decline call", description: error.message, variant: "destructive" });
    },
  });

  const acceptFaceCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/face-call/accept`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      mergeCallFields(queryClient, match.id, data);
      toast({ title: "Face call accepted", description: "Waiting for them to accept too..." });
    },
    onError: (error: Error) => {
      console.error("[FACE_CALL_ACCEPT] FRONTEND_ERROR", { matchId: match.id, error: error.message });
      toast({ title: "Accept face call failed", description: error.message, variant: "destructive" });
    },
  });

  const declineFaceCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/face-call/decline`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      mergeCallFields(queryClient, match.id, data);
      toast({ title: "Face call skipped", description: "No worries - you can always meet in person instead." });
    },
    onError: (error: Error) => {
      console.error("[FACE_CALL_DECLINE] FRONTEND_ERROR", { matchId: match.id, error: error.message });
      toast({ title: "Decline face call failed", description: error.message, variant: "destructive" });
    },
  });

  const removeMatch = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/matches/${match.id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Connection removed", description: `${match.profile.firstName} has been removed from your connections.` });
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
    } else if (isAtBottomRef.current) {
      // New message arrived and user is already at the bottom — smooth follow
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    // If user has scrolled up to read history: do nothing
  }, [matchDetail?.messages?.length, expanded]);

  useEffect(() => {
    if (detail.callSessionId) {
      lastCallSessionIdRef.current = detail.callSessionId;
    }
  }, [detail.callSessionId]);

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
      toast({ title: "5 more messages added", description: "Your conversation has a little more room." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not activate", description: error.message, variant: "destructive" });
    },
  });

  const myMessages = useMemo(
    () => matchDetail?.messages?.filter(m => m.senderId === user?.id) || [],
    [matchDetail?.messages, user?.id],
  );
  const hasMessageExtension = (benefits?.activated?.[match.id]?.message_extension || 0) > 0;
  const hasAvailableExtension = (benefits?.available?.message_extension || 0) > 0;
  const effectiveLimit = hasMessageExtension ? MAX_MESSAGES_PER_USER + 5 : MAX_MESSAGES_PER_USER;
  const messagesRemaining = effectiveLimit - myMessages.length;
  const isLimitReached = messagesRemaining <= 0;
  const rawLimitReached = myMessages.length >= MAX_MESSAGES_PER_USER;
  const allMessages = matchDetail?.messages || [];
  const callStage = detail.callStage || 0;
  const isUser1 = detail.user1Id === user?.id;

  // Stage 1: post-first-call messaging (12 each)
  const myPostCallMessages = callStage === 1
    ? (isUser1 ? (detail.messageCount1 || 0) : (detail.messageCount2 || 0))
    : 0;
  const theirPostCallMessages = callStage === 1
    ? (isUser1 ? (detail.messageCount2 || 0) : (detail.messageCount1 || 0))
    : 0;
  const myPostCallRemaining = MAX_POST_CALL_MESSAGES - myPostCallMessages;
  const myPostCallLimitReached = myPostCallMessages >= MAX_POST_CALL_MESSAGES;
  const theirPostCallLimitReached = theirPostCallMessages >= MAX_POST_CALL_MESSAGES;
  const bothPostCallLimitReached = myPostCallLimitReached && theirPostCallLimitReached;

  // Stage 2: post-second-call messaging (20 each)
  const myStage2Messages = callStage === 2
    ? (isUser1 ? (detail.messageCount1 || 0) : (detail.messageCount2 || 0))
    : 0;
  const theirStage2Messages = callStage === 2
    ? (isUser1 ? (detail.messageCount2 || 0) : (detail.messageCount1 || 0))
    : 0;
  const myStage2Remaining = MAX_POST_STAGE2_MESSAGES - myStage2Messages;
  const myStage2LimitReached = myStage2Messages >= MAX_POST_STAGE2_MESSAGES;
  const theirStage2LimitReached = theirStage2Messages >= MAX_POST_STAGE2_MESSAGES;
  const bothStage2LimitReached = myStage2LimitReached && theirStage2LimitReached;

  const sparkStep = callStage >= 4 ? 4 : callStage >= 2 ? 3 : callStage === 1 ? 2 : 1;

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
      toast({ title: `${match.profile.firstName} declined`, description: "They weren't available right now. Try again later." });
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
        msgs.push({ id: "stage0-approaching", text: "Looks like you two are getting along well. Your first call stage is coming up soon — start thinking about when you'd like to talk." });
      }
      if (messagesRemaining <= 1 || isLimitReached) {
        msgs.push({ id: "stage0-limit", text: "You've reached your call stage. When you're ready, start your first call." });
      }
    }
    if (callStage === 1) {
      msgs.push({ id: "stage1-welcome", text: "Nice call! Head back to chat and continue getting to know each other." });
      msgs.push({ id: "stage1-info", text: "You can now send 12 messages each before your next call unlocks." });
      if (myPostCallMessages >= 6 && !myPostCallLimitReached) {
        msgs.push({ id: "stage1-approaching", text: "Your next call stage is getting close. Start thinking about when you'd like to talk again." });
      }
      if (myPostCallRemaining <= 2 && !myPostCallLimitReached) {
        msgs.push({ id: "stage1-near-limit", text: "Just a couple messages left before your second call unlocks." });
      }
      if (bothPostCallLimitReached) {
        msgs.push({ id: "stage1-unlocked", text: "You've unlocked your second call. Pick a time that suits you both." });
      }
    }
    if (callStage === 2) {
      msgs.push({ id: "stage2-welcome", text: "Great second call! You each have 20 messages before the face call unlocks." });
      if (myStage2Messages >= 10 && !myStage2LimitReached) {
        msgs.push({ id: "stage2-approaching", text: "Getting close — keep the conversation going." });
      }
      if (myStage2Remaining <= 3 && !myStage2LimitReached) {
        msgs.push({ id: "stage2-near-limit", text: `Just ${myStage2Remaining} message${myStage2Remaining !== 1 ? "s" : ""} left before the face call unlocks.` });
      }
      if (bothStage2LimitReached) {
        msgs.push({ id: "stage2-unlocked", text: "Face call unlocked! Opt in when you're both ready to see each other." });
      }
    }
    return msgs;
  }, [callStage, messagesRemaining, isLimitReached, myPostCallMessages, myPostCallRemaining, myPostCallLimitReached, bothPostCallLimitReached, myStage2Messages, myStage2Remaining, myStage2LimitReached, bothStage2LimitReached]);

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
  const isFaceCallStage = callStage === 3;
  const myFaceCallAccepted = detail.user1Id === user?.id ? detail.faceCallUser1Accepted : detail.faceCallUser2Accepted;
  const theirFaceCallAccepted = detail.user1Id === user?.id ? detail.faceCallUser2Accepted : detail.faceCallUser1Accepted;
  const bothAcceptedFaceCall = detail.faceCallUser1Accepted && detail.faceCallUser2Accepted;

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
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur-sm sticky top-0 z-10">
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 -ml-1"
          onClick={onToggleExpand}
          data-testid={`button-back-${match.id}`}
        >
          <ChevronLeft className="w-5 h-5" />
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
              className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-background"
              style={{ width: 15, height: 15 }}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-green-400 border border-background" />
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm truncate leading-tight" data-testid={`text-match-name-${match.id}`}>
              {match.profile.firstName}{match.profile.age ? `, ${match.profile.age}` : ""}
            </h3>
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
              {showProfilePanel ? "Hide profile" : "View profile"}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0" data-testid={`badge-messages-remaining-${match.id}`}>
            {allCallsDone ? "All calls done" : callStage === 3 ? "Face call stage" : callStage === 2 && bothStage2LimitReached ? "Face call ready" : callStage === 2 ? `${myStage2Remaining} left (20 msg)` : callStage === 1 && bothPostCallLimitReached ? "2nd call ready" : callStage === 1 ? `${myPostCallRemaining} post-call left` : messagesRemaining > 0 ? `${messagesRemaining} left` : "Call time"}
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

      {expanded && <SparkProgressBar sparkStep={sparkStep} />}

      <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3" data-testid={`messages-container-${match.id}`}>
            {expanded && matchLoading && !matchDetail && (
              <div className="flex flex-col items-center justify-center py-10 gap-3" data-testid={`chat-loading-${match.id}`}>
                <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                <p className="text-xs text-muted-foreground">Loading conversation…</p>
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
                  return "Could not load messages. Pull down to retry.";
                })()}
              </div>
            )}
            {!matchLoading && !matchError && allMessages.length === 0 && (
              <div className="text-center py-6 space-y-2">
                <p className="text-muted-foreground text-sm">Start of your conversation</p>
                <p className="text-xs text-muted-foreground">You each have {MAX_MESSAGES_PER_USER} messages. Make them count.</p>
              </div>
            )}
            {guidanceByIndex.visibleMsgs.map((msg, i) => {
              const isMe = msg.senderId === user?.id;
              const hasReaction = msg.reaction && typeof msg.reaction === 'string' && msg.reaction.length > 0;
              return (
                <Fragment key={msg.id}>
                  <div className={`flex ${isMe ? "justify-end" : "justify-start"} ${hasReaction ? "mb-2" : ""}`}>
                    <div className="relative">
                      <div
                        className={`max-w-[75vw] rounded-md px-4 py-3 text-sm select-none ${
                          isMe
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted cursor-pointer"
                        } ${!isMe ? "active:scale-[0.98] transition-transform" : ""}`}
                        onClick={() => handleMessageTap(msg)}
                        data-testid={`message-${msg.id}`}
                      >
                        <p className="leading-relaxed">{msg.content}</p>
                        <p className={`text-[10px] mt-1.5 leading-none opacity-60 ${isMe ? "text-primary-foreground" : "text-muted-foreground"}`} data-testid={`timestamp-${msg.id}`}>
                          {formatTimestamp(msg.createdAt)}
                        </p>
                      </div>
                      {hasReaction && (
                        <span
                          className={`absolute -bottom-2.5 ${isMe ? "left-1" : "right-1"} text-sm drop-shadow-sm`}
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
                    {(isFaceCallStage && bothAcceptedFaceCall) || callStage === 1 ? (
                      <Video className="w-6 h-6 animate-pulse" style={{ color: "hsl(350 45% 72%)" }} />
                    ) : (
                      <Phone className="w-6 h-6 animate-pulse" style={{ color: "hsl(350 45% 72%)" }} />
                    )}
                  </div>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white font-serif font-semibold text-base" data-testid={`text-outgoing-call-${match.id}`}>
                    Calling {match.profile.firstName}…
                  </p>
                  <p className="text-white/40 text-xs">Waiting for them to pick up</p>
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
                  {cancelCall.isPending ? "Cancelling…" : "Cancel Call"}
                </button>
                <p className="text-white/25 text-[11px]">If they don't pick up, it won't count as your call</p>
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
                    {(isFaceCallStage && bothAcceptedFaceCall) || callStage === 1 ? (
                      <Video className="w-6 h-6 animate-pulse" style={{ color: "hsl(145 60% 60%)" }} />
                    ) : (
                      <Phone className="w-6 h-6 animate-pulse" style={{ color: "hsl(145 60% 60%)" }} />
                    )}
                  </div>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white font-serif font-semibold text-base" data-testid={`text-incoming-call-${match.id}`}>
                    {match.profile.firstName} is calling
                  </p>
                  <p className="text-white/40 text-xs">Answer to start your conversation</p>
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
                    Decline
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
                    {inlineAnswerCall.isPending ? "Answering…" : "Answer"}
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
                    {repairCall.isPending ? "Clearing…" : "Clear & Retry Call"}
                  </Button>
                </div>
              ) : (
                <div className="text-center space-y-3">
                  <div className="relative w-16 h-16 mx-auto">
                    <div className="absolute inset-0 rounded-full bg-green-500/15 animate-pulse" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      {isFaceCallStage && bothAcceptedFaceCall
                        ? <Video className="w-6 h-6 text-green-600" />
                        : <Phone className="w-6 h-6 text-green-600" />}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-sm" data-testid={`text-call-active-label-${match.id}`}>
                      {isFaceCallStage && bothAcceptedFaceCall ? "Face call in progress" : callStage === 1 ? "Video call in progress" : "First call in progress"}
                    </p>
                    <p className="text-xs text-muted-foreground">Use the call overlay to manage your call</p>
                  </div>
                </div>
              )}
            </div>
          ) : allCallsDone && finalChoice !== 'chat' ? (
            finalChoice === 'date' ? (
              <div>
                <div className="px-4 pt-3 pb-1">
                  <button onClick={() => setFinalChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back-to-final-options">
                    <ChevronLeft className="w-3 h-3" /> Back
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
                    <ChevronLeft className="w-3 h-3" /> Back
                  </button>
                  <div className="text-center space-y-1">
                    <p className="font-semibold text-sm">End this conversation?</p>
                    <p className="text-xs text-muted-foreground">{match.profile.firstName} will be removed from your matches. This can't be undone.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setFinalChoice(null)} data-testid={`button-cancel-end-final-${match.id}`}>Keep</Button>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => removeMatch.mutate()} disabled={removeMatch.isPending} data-testid={`button-confirm-end-final-${match.id}`}>
                      {removeMatch.isPending ? "Removing…" : "End Conversation"}
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
                    <p className="font-semibold text-sm">What's next with {match.profile.firstName}?</p>
                    <p className="text-xs text-muted-foreground">You've completed all your calls together.</p>
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
                        <p className="text-xs font-semibold text-green-700 leading-tight">Plan a Date</p>
                        <p className="text-[10px] mt-0.5" style={{ color: "hsl(155 25% 40%)" }}>Free</p>
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
                        <p className="text-xs font-semibold leading-tight">Keep Chatting</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Continue</p>
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
                        <p className="text-xs font-semibold text-muted-foreground leading-tight">End</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Leave gracefully</p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : isFaceCallStage && !bothAcceptedFaceCall ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
                <Video className="w-5 h-5 text-primary mx-auto" />
                {myFaceCallAccepted ? (
                  <>
                    <p className="font-medium text-sm">You're in for a face call</p>
                    <p className="text-xs text-muted-foreground">
                      Waiting for {match.profile.firstName} to accept the face call...
                    </p>
                    <Badge variant="secondary" className="text-xs mx-auto" data-testid={`badge-face-call-waiting-${match.id}`}>
                      <Clock className="w-3 h-3 mr-1" /> Waiting for response
                    </Badge>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-sm">Ready to see each other?</p>
                    <p className="text-xs text-muted-foreground">
                      After two great calls, you can opt into a 10-minute face-to-face video call. Both of you need to accept.
                    </p>
                    {theirFaceCallAccepted && (
                      <Badge variant="secondary" className="text-xs mx-auto">
                        {match.profile.firstName} has accepted
                      </Badge>
                    )}
                    <div className="flex items-center gap-2 justify-center">
                      <Button
                        size="sm"
                        onClick={() => acceptFaceCall.mutate()}
                        disabled={acceptFaceCall.isPending}
                        data-testid={`button-accept-face-call-${match.id}`}
                      >
                        <Video className="w-4 h-4 mr-2" /> {acceptFaceCall.isPending ? "Accepting..." : "Accept Face Call"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => declineFaceCall.mutate()}
                        disabled={declineFaceCall.isPending}
                        data-testid={`button-decline-face-call-${match.id}`}
                      >
                        Skip
                      </Button>
                    </div>
                  </>
                )}
              </Card>
            </div>
          ) : isFaceCallStage && bothAcceptedFaceCall ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
                <Video className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">You both accepted the face call</p>
                <p className="text-xs text-muted-foreground">Start your 10-minute face-to-face video call whenever you're ready.</p>
                <Button
                  size="sm"
                  onClick={() => {
                    console.log("[CALL_UI] CALL_REQUEST_STARTED", { matchId: match.id, callStage, callType: "face", role: "caller" });
                    startCall.mutate();
                  }}
                  disabled={startCall.isPending || hasExistingCall}
                  data-testid={`button-start-face-call-${match.id}`}
                >
                  <Video className="w-4 h-4 mr-2" /> Start Face Call
                </Button>
              </Card>
            </div>
          ) : callStage === 1 && bothPostCallLimitReached ? (
            <CallSchedulingCard
              matchId={match.id}
              matchName={match.profile.firstName}
              allMessages={allMessages}
              callStage={1}
              startCallPending={startCall.isPending}
              onStartCall={() => {
                console.log("[CALL_UI] CALL_REQUEST_STARTED", { matchId: match.id, callStage: 1, callType: "video_2", role: "caller" });
                startCall.mutate();
              }}
            />
          ) : callStage === 1 ? (
            <div className="border-t" data-testid={`post-call-messaging-${match.id}`}>
              {isOtherTyping && (
                <div className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground" data-testid="text-typing-indicator-postcall">
                  <span className="flex gap-0.5 items-center">
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>{match.profile.firstName} is typing...</span>
                </div>
              )}
              {myPostCallLimitReached ? (
                <div className="p-4 text-center space-y-1" data-testid={`waiting-their-postcall-${match.id}`}>
                  <p className="text-sm font-medium text-primary">Your post-call messages are sent!</p>
                  <p className="text-xs text-muted-foreground">
                    Waiting for {match.profile.firstName} to send their messages before your second call unlocks.
                  </p>
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  {myPostCallMessages === 0 && (
                    <StageHint>Great call! You each have 12 messages before your second call unlocks.</StageHint>
                  )}
                  {myPostCallMessages >= 8 && myPostCallMessages < 12 && (
                    <StageHint>Almost there — {myPostCallRemaining} message{myPostCallRemaining !== 1 ? "s" : ""} left before your second call is ready.</StageHint>
                  )}
                  <div className="flex gap-2 items-end">
                    <Textarea
                      value={message}
                      onChange={e => {
                        setMessage(e.target.value.slice(0, MAX_CHARS));
                        if (e.target.value.trim()) sendTyping();
                      }}
                      placeholder="Keep the momentum going..."
                      className="resize-none min-h-[44px] max-h-[80px] text-sm"
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (message.trim()) {
                            const content = message.trim();
                            stopTyping();
                            forceScrollRef.current = true;
                            sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                          }
                        }
                      }}
                      data-testid={`input-message-postcall-${match.id}`}
                    />
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-[10px] text-muted-foreground tabular-nums" data-testid={`text-postcall-counter-${match.id}`}>
                        {myPostCallMessages}/{MAX_POST_CALL_MESSAGES}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (message.trim()) {
                            const content = message.trim();
                            stopTyping();
                            forceScrollRef.current = true;
                            sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                          }
                        }}
                        disabled={!message.trim()}
                        data-testid={`button-send-postcall-${match.id}`}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : callStage === 2 ? (
            <div className="border-t" data-testid={`post-second-call-messaging-${match.id}`}>
              {isOtherTyping && (
                <div className="flex items-center gap-1.5 px-4 pt-2 text-xs text-muted-foreground" data-testid="text-typing-indicator-stage2">
                  <span className="flex gap-0.5 items-center">
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>{match.profile.firstName} is typing...</span>
                </div>
              )}
              {myStage2LimitReached ? (
                <div className="p-4 text-center space-y-1" data-testid={`waiting-their-stage2-${match.id}`}>
                  <p className="text-sm font-medium text-primary">Your messages are sent!</p>
                  <p className="text-xs text-muted-foreground">
                    {theirStage2LimitReached
                      ? "The face call stage is now unlocked."
                      : `Waiting for ${match.profile.firstName} to finish their messages before the face call unlocks.`}
                  </p>
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  {myStage2Messages === 0 && (
                    <StageHint>Great second call! You each have 20 messages before the face call unlocks.</StageHint>
                  )}
                  {myStage2Messages >= 16 && myStage2Messages < 20 && (
                    <StageHint>Almost there — {myStage2Remaining} message{myStage2Remaining !== 1 ? "s" : ""} left before the face call is ready.</StageHint>
                  )}
                  <div className="flex gap-2 items-end">
                    <Textarea
                      value={message}
                      onChange={e => {
                        setMessage(e.target.value.slice(0, MAX_CHARS));
                        if (e.target.value.trim()) sendTyping();
                      }}
                      placeholder="Keep getting to know each other..."
                      className="resize-none min-h-[44px] max-h-[80px] text-sm"
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (message.trim()) {
                            const content = message.trim();
                            stopTyping();
                            forceScrollRef.current = true;
                            sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                          }
                        }
                      }}
                      data-testid={`input-message-stage2-${match.id}`}
                    />
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-[10px] text-muted-foreground tabular-nums" data-testid={`text-stage2-counter-${match.id}`}>
                        {myStage2Messages}/{MAX_POST_STAGE2_MESSAGES}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (message.trim()) {
                            const content = message.trim();
                            stopTyping();
                            forceScrollRef.current = true;
                            sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                          }
                        }}
                        disabled={!message.trim()}
                        data-testid={`button-send-stage2-${match.id}`}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : rawLimitReached && !hasMessageExtension && hasAvailableExtension && !dismissedExtension ? (
            <div className="p-4 border-t" data-testid={`extension-offer-${match.id}`}>
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-primary">Want to keep going?</p>
                  <p className="text-xs text-muted-foreground">You have a +5 message extension. Add 5 more messages to this conversation?</p>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismissedExtension(true)}
                    data-testid={`button-dismiss-extension-${match.id}`}
                  >
                    Not now
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => activateExtension.mutate()}
                    disabled={activateExtension.isPending}
                    data-testid={`button-activate-extension-${match.id}`}
                  >
                    {activateExtension.isPending ? "Activating..." : "Add 5 messages"}
                  </Button>
                </div>
              </div>
            </div>
          ) : isLimitReached ? (
            nextStepChoice === 'call' ? (
              <div>
                <div className="px-4 pt-3 pb-1">
                  <button onClick={() => setNextStepChoice(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back-to-next-step">
                    <ChevronLeft className="w-3 h-3" /> Back
                  </button>
                </div>
                <CallSchedulingCard
                  matchId={match.id}
                  matchName={match.profile.firstName}
                  allMessages={allMessages}
                  callStage={0}
                  startCallPending={startCall.isPending}
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
                    <ChevronLeft className="w-3 h-3" /> Back
                  </button>
                  <div className="text-center space-y-1">
                    <p className="font-semibold text-sm">End this match?</p>
                    <p className="text-xs text-muted-foreground">{match.profile.firstName} will be removed from your matches. This can't be undone.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setNextStepChoice(null)} data-testid={`button-cancel-end-nextstep-${match.id}`}>Keep</Button>
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => removeMatch.mutate()} disabled={removeMatch.isPending} data-testid={`button-confirm-end-nextstep-${match.id}`}>
                      {removeMatch.isPending ? "Removing…" : "End Match"}
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
                    <p className="font-semibold text-sm">Time for your first call!</p>
                    <p className="text-xs text-muted-foreground">You've reached the message limit. Start a call with {match.profile.firstName} to keep connecting.</p>
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
                      <p className="text-xs font-semibold leading-tight">Start a Call</p>
                      <span className="text-[10px] text-muted-foreground">Free</span>
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
                      <p className="text-xs font-semibold text-muted-foreground leading-tight">End Match</p>
                      <span className="text-[10px] text-muted-foreground">Not the right fit</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <div className="p-3 border-t">
              {isOtherTyping && (
                <div className="flex items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground" data-testid="text-typing-indicator">
                  <span className="flex gap-0.5 items-center">
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>{match.profile.firstName} is typing...</span>
                </div>
              )}
              {messagesRemaining <= 5 && messagesRemaining > 1 && (
                <StageHint>You two are really connecting! A few messages left before you can choose what's next.</StageHint>
              )}
              {messagesRemaining === 1 && (
                <StageHint>This is your last message — make it count. You'll choose what's next after.</StageHint>
              )}
              <div className="flex gap-2 items-end">
                <Textarea
                  value={message}
                  onChange={e => {
                    setMessage(e.target.value.slice(0, MAX_CHARS));
                    if (e.target.value.trim()) sendTyping();
                  }}
                  placeholder="Write something meaningful..."
                  className="resize-none min-h-[44px] max-h-[80px] text-sm"
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (message.trim()) {
                        const content = message.trim();
                        stopTyping();
                        forceScrollRef.current = true;
                        sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                      }
                    }
                  }}
                  data-testid={`input-message-${match.id}`}
                />
                <Button
                  size="icon"
                  onClick={() => {
                    if (message.trim()) {
                      const content = message.trim();
                      stopTyping();
                      forceScrollRef.current = true;
                      sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                    }
                  }}
                  disabled={!message.trim()}
                  data-testid={`button-send-${match.id}`}
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1 text-right">
                {message.length}/{MAX_CHARS}
              </p>
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
    </div>
  );
}

const MatchCard = memo(function MatchCard({ match, unreadCount, userId, onOpen }: {
  match: MatchWithProfile;
  unreadCount: number;
  userId: string | null;
  onOpen: (matchId: string) => void;
}) {
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
            <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1" data-testid={`badge-unread-${match.id}`}>
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
              ? (match.lastMessage.senderId === userId ? "You: " : "") + match.lastMessage.content
              : match.profile.datingIntent || "Start the conversation"}
          </p>
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      </div>
    </Card>
  );
});

export default function Matches() {
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
    queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
  }, [queryClient]);

  // `isActive` gates channel creation — when the Connections tab is hidden
  // (display:none via PersistentTabs) all unread WebSocket channels are torn
  // down.  They are rebuilt the moment the user taps back to this tab.
  const { unreadCounts, markRead } = useUnreadCounts(matchIds, user?.id || null, expandedMatchId, handleNewBackgroundMessage, isActive);



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

  const connectionCount = matches?.length || 0;
  const atLimit = connectionCount >= MAX_CONNECTIONS;
  const hasContent = (matches && matches.length > 0) || incomingRequests.length > 0 || outgoingPending.length > 0 || requestsLoading;

  const debugLine = (extra?: string) => (
    <div className="px-4 py-1.5 text-[10px] text-muted-foreground/60 font-mono bg-muted/30 border-b" data-testid="debug-line">
      Logged in as: {user?.id || "—"} · Matches loaded: {matches?.length ?? "—"}{extra ? ` · ${extra}` : ""}
    </div>
  );

  if (fetchFailed) {
    const errMsg = matchesError?.message || requestsError?.message || "Could not load connections";
    console.error("MATCHES_FETCH_ERROR", errMsg);
    return (
      <div className="flex-1 flex flex-col">
        {debugLine(`Error: ${errMsg}`)}
        <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
            <Moon className="w-8 h-8 text-destructive" />
          </div>
          <h2 className="font-serif text-xl font-bold" data-testid="text-matches-error">Something went wrong</h2>
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
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-matches">No connections yet</h2>
          <p className="text-muted-foreground text-sm">
            When someone sends you a message through the Intention Wheel, or you match on Discover, you'll see them here.
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
          onMarkRead={() => markRead(selectedMatch.id)}
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
          <h1 className="font-serif text-2xl font-bold" data-testid="text-matches-title">Your Connections</h1>
          <Badge variant={atLimit ? "destructive" : "secondary"} className="text-xs" data-testid="badge-connection-count">
            {connectionCount}/{MAX_CONNECTIONS}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {atLimit && "Connection limit reached - remove a chat to connect with new people"}
          {!atLimit && incomingRequests.length > 0 && `${incomingRequests.length} pending ${incomingRequests.length === 1 ? "request" : "requests"}`}
          {!atLimit && incomingRequests.length > 0 && matches && matches.length > 0 && " · "}
          {!atLimit && matches && matches.length > 0 && `${matches.length} ${matches.length === 1 ? "connection" : "connections"}`}
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
            <h2 className="font-semibold text-sm">Incoming Requests</h2>
            <Badge variant="secondary" className="text-xs">{incomingRequests.length}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            These people found you through the Intention Wheel and sent you a message. Accept to start a conversation.
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
            <h2 className="font-semibold text-sm text-muted-foreground">Sent Requests</h2>
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
              onClick={() => setActiveTab("new")}
              data-testid="tab-new-connections"
            >
              New Connections
              {newConnections.length > 0 && (
                <Badge variant="secondary" className="text-xs px-1.5 h-4">{newConnections.length}</Badge>
              )}
            </button>
            <button
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${activeTab === "active" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground"}`}
              onClick={() => setActiveTab("active")}
              data-testid="tab-active-chats"
            >
              Active Chats
              {totalUnread > 0 && (
                <Badge variant="destructive" className="text-xs px-1.5 h-4">{totalUnread}</Badge>
              )}
            </button>
          </div>

          {activeTab === "new" && (
            <div className="space-y-2" data-testid="tab-panel-new">
              {newConnections.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {activeChats.length > 0 ? "All your connections have active chats." : "No new connections yet."}
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
                  No active chats yet. Open a new connection to start talking.
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
