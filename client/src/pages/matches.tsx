import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/App";
import { isCallSessionCancelled, markCallSessionCancelled } from "@/lib/cancelled-calls";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { useUnreadCounts } from "@/hooks/use-unread-counts";
import { useTypingIndicator } from "@/hooks/use-typing-indicator";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Phone, Video, ChevronDown, ChevronUp, ChevronLeft, PhoneOff, Clock, Check, X, Sparkles, Calendar, Heart, PhoneForwarded, Moon } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import type { Profile, Match, Message, SpinRequest } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_POST_CALL_MESSAGES = 6;
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

function CallTimer({ match, onComplete, isFaceCall }: { match: MatchDetail; onComplete: () => void; isFaceCall?: boolean }) {
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
              onClick={onComplete}
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
              onClick={onComplete}
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
          <Avatar className="w-12 h-12 flex-shrink-0">
            <AvatarImage src={request.profile.photos?.[0]} alt={request.profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {request.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
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
            <Phone className="w-5 h-5 text-green-600 dark:text-green-400" />
            <p className="font-semibold text-sm text-green-700 dark:text-green-400">It's time to talk!</p>
          </div>
          <p className="text-xs text-muted-foreground">Your {callLabel} call is ready. Start when you're both on.</p>
          <Button size="sm" onClick={onStartCall} disabled={startCallPending} className="bg-green-600 hover:bg-green-700 text-white" data-testid={`button-start-scheduled-call-${matchId}`}>
            <Phone className="w-4 h-4 mr-2" /> Start {callLabel === "first" ? "First" : "Second"} Call
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
            <Phone className="w-4 h-4 text-primary shrink-0" />
            <p className="font-medium text-sm">{matchName} wants to schedule your {callLabel} call</p>
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
        <Phone className="w-5 h-5 text-primary mx-auto" />
        <p className="font-medium text-sm text-center">
          {callStage === 0 ? "Ready for your first call?" : "Ready for your second call?"}
        </p>
        <p className="text-xs text-muted-foreground text-center">
          Schedule your {callDuration} {callLabel} call. Pick a time that works for you.
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: matchDetail } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", match.id],
    enabled: expanded,
    refetchInterval: expanded && isActive ? 10000 : false,
  });

  useRealtimeMessages(match.id, expanded);

  const { isOtherTyping, sendTyping, stopTyping } = useTypingIndicator(match.id, user?.id || null, expanded);

  const sendMessage = useMutation({
    mutationFn: async (vars: { content: string; tempId: string }) => {
      if (!match.id) {
        throw new Error("No match selected");
      }
      const authHeaders: Record<string, string> = {};
      const { data: { session } } = await (await import("@/lib/supabase")).supabase.auth.getSession();
      if (session?.access_token) {
        authHeaders["Authorization"] = `Bearer ${session.access_token}`;
      }
      const res = await fetch(`/api/matches/${match.id}/messages`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ content: vars.content }),
        credentials: "include",
      });
      if (!res.ok) {
        let errMsg = `${res.status}: ${res.statusText}`;
        try {
          const body = await res.json();
          errMsg = body.message || JSON.stringify(body);
        } catch {}
        console.error("MSG_SEND_FAIL", errMsg);
        throw new Error(errMsg);
      }
      return res.json();
    },
    onMutate: async (vars: { content: string; tempId: string }) => {
      if (!match.id) return {};
      setMessage("");
      await queryClient.cancelQueries({ queryKey: ["/api/matches", match.id] });
      const previous = queryClient.getQueryData<MatchDetail>(["/api/matches", match.id]);
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
      return { previous };
    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/matches", match.id], context.previous);
      }
      toast({ title: "Could not send", description: error.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
    },
  });

  const startCall = useMutation({
    mutationFn: async () => {
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, callerId: user?.id, callStage, role: "caller" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/start`, {});
      return await res.json();
    },
    onSuccess: (data: any) => {
      console.log("[CALL_UI] CALL_STAGE_ENTERED", { matchId: match.id, callSessionId: data.callSessionId, confirmed: true });
      iCancelledRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
    },
    onError: (error: Error) => {
      console.error("[CALL_UI] CALL_START_FAILED", { matchId: match.id, route: "call/start", error: error.message, errorObj: error });
      toast({ title: "Call failed", description: error.message || "Unknown server error", variant: "destructive" });
    },
  });

  const cancelCall = useMutation({
    mutationFn: async () => {
      console.log("[CALL_UI] CALL_STAGE_EXITED", { matchId: match.id, reason: "caller_cancelled" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      iCancelledRef.current = true;
      markCallSessionCancelled(match.id, detail.callSessionId);
      broadcastCallSignal(match.id, {
        type: "call:cancelled",
        matchId: match.id,
        userId: user!.id,
      });
      queryClient.setQueriesData<(Match & { profile: Profile })[]>({ queryKey: ["/api/matches"] }, (old) => {
        if (!old) return old;
        return old.map(m => m.id === match.id ? { ...m, callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false, callSessionId: null } : m);
      });
      console.log("[CALL_UI] CALL_CANCELLED", { matchId: match.id, reason: "caller_cancelled" });
      toast({ title: "Call cancelled" });
    },
    onError: (error: Error) => {
      markCallSessionCancelled(match.id, detail.callSessionId);
      toast({ title: "Cancel failed", description: error.message, variant: "destructive" });
    },
  });

  const completeCall = useMutation({
    mutationFn: async () => {
      console.log("[CALL_UI] CALL_STAGE_EXITED", { matchId: match.id, reason: "call_completed" });
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/complete`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
      broadcastCallSignal(match.id, {
        type: "call:ended" as any,
        matchId: match.id,
        userId: user!.id,
      });
      console.log("[CALL_UI] CALL_STATE_CLEARED", { matchId: match.id, reason: "call_completed", newStage: data.callStage });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      const stage = data.callStage || 0;
      if (stage === 1) {
        toast({ title: "First call completed", description: "Ready for a longer 15-minute call?" });
      } else if (stage === 2) {
        toast({ title: "Second call completed", description: "Would you like a face-to-face call?" });
      } else {
        toast({ title: "Call completed", description: "Great conversation! Ready to meet in person?" });
      }
    },
    onError: (error: Error) => {
      console.error("[CALL_COMPLETE] FRONTEND_ERROR", { matchId: match.id, error: error.message });
      toast({ title: "Complete call failed", description: error.message, variant: "destructive" });
    },
  });

  const acceptFaceCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/face-call/accept`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
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

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [matchDetail?.messages, expanded]);

  useEffect(() => {
    if (expanded) {
      onMarkRead();
    }
  }, [expanded]);

  const detail = matchDetail || match as unknown as MatchDetail;
  const myMessages = matchDetail?.messages?.filter(m => m.senderId === user?.id) || [];
  const messagesRemaining = MAX_MESSAGES_PER_USER - myMessages.length;
  const isLimitReached = messagesRemaining <= 0;
  const allMessages = matchDetail?.messages || [];
  const callStage = detail.callStage || 0;
  const isUser1 = detail.user1Id === user?.id;

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

  const sparkStep = callStage >= 3 ? 4 : callStage >= 2 ? 3 : callStage === 1 ? 2 : 1;

  const callCancelled = isCallSessionCancelled(match.id, detail.callSessionId);

  const isCallStale = (() => {
    if (!detail.callStartedAt) return false;
    const age = Date.now() - new Date(detail.callStartedAt).getTime();
    if (!detail.callAnswered && age > 120_000) {
      console.log("[CALL_SESSION] STALE_CALL_BLOCKED", { matchId: match.id, callSessionId: detail.callSessionId, ageMs: age, answered: false, source: "inline_chat" });
      return true;
    }
    if (detail.callAnswered && age > 30 * 60_000) {
      console.log("[CALL_SESSION] STALE_CALL_BLOCKED", { matchId: match.id, callSessionId: detail.callSessionId, ageMs: age, answered: true, source: "inline_chat" });
      return true;
    }
    return false;
  })();

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

    if (wasRinging && !isRingingNow && !isCallActive && !iCancelledRef.current) {
      toast({ title: `${match.profile.firstName} declined`, description: "They weren't available right now. Try again later." });
    }
    if (isCallActive || !isRingingNow) {
      wasRingingRef.current = false;
    }
  }, [isCallRinging, isCallActive, iAmCaller, match.profile.firstName, toast]);
  useEffect(() => {
    console.log("[CONNECTION_STAGE] SPARK_PROGRESS_UPDATED", {
      matchId: match.id,
      sparkStep,
      callStage,
      myPostCallMessages,
      bothPostCallLimitReached,
    });
  }, [sparkStep, callStage]);

  const allCallsDone = callStage >= 3;
  const isFaceCallStage = callStage === 2;
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
    <div className="flex flex-col h-full" data-testid={`card-match-${match.id}`}>
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
        <Avatar className="w-10 h-10 shrink-0">
          <AvatarImage src={match.profile.photos?.[0]} alt={match.profile.firstName} />
          <AvatarFallback className="bg-primary/10 text-primary font-semibold text-sm">
            {match.profile.firstName?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm truncate" data-testid={`text-match-name-${match.id}`}>
            {match.profile.firstName}, {match.profile.age}
          </h3>
          <p className="text-xs text-muted-foreground truncate">{match.profile.datingIntent}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0" data-testid={`badge-messages-remaining-${match.id}`}>
            {allCallsDone ? "All calls done" : callStage === 2 ? "Face call stage" : callStage === 1 && bothPostCallLimitReached ? "2nd call ready" : callStage === 1 ? `${myPostCallRemaining} post-call left` : messagesRemaining > 0 ? `${messagesRemaining} left` : "Call time"}
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

      <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid={`messages-container-${match.id}`}>
            {allMessages.length === 0 && (
              <div className="text-center py-6 space-y-2">
                <p className="text-muted-foreground text-sm">Start of your conversation</p>
                <p className="text-xs text-muted-foreground">You each have {MAX_MESSAGES_PER_USER} messages. Make them count.</p>
              </div>
            )}
            {allMessages.filter(m => !m.content.startsWith(SCHEDULE_PREFIX)).map(msg => {
              const isMe = msg.senderId === user?.id;
              const hasReaction = msg.reaction && typeof msg.reaction === 'string' && msg.reaction.length > 0;
              if (hasReaction) {
                console.log("[CHAT] MESSAGE_REACTION_RENDERED", { messageId: msg.id, reaction: msg.reaction });
              }
              return (
                <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"} ${hasReaction ? "mb-2" : ""}`}>
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
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {isCallRinging && iAmCaller ? (
            <div className="p-5 border-t" data-testid={`call-ringing-${match.id}`}>
              <div className="text-center space-y-4">
                <div className="relative w-20 h-20 mx-auto">
                  <div className="absolute inset-0 rounded-full bg-primary/10 animate-ping" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-16 h-16 rounded-full bg-primary/15 flex items-center justify-center">
                      {isFaceCallStage && bothAcceptedFaceCall ? (
                        <Video className="w-6 h-6 text-primary animate-pulse" />
                      ) : (
                        <Phone className="w-6 h-6 text-primary animate-pulse" />
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-sm" data-testid={`text-outgoing-call-${match.id}`}>Calling {match.profile.firstName}...</p>
                  <p className="text-xs text-muted-foreground">Waiting for them to pick up</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    console.log("[MatchChat] CANCEL_CALL_REQUESTED", { matchId: match.id });
                    cancelCall.mutate();
                  }}
                  disabled={cancelCall.isPending}
                  data-testid={`button-cancel-call-${match.id}`}
                >
                  <PhoneOff className="w-4 h-4 mr-2" /> {cancelCall.isPending ? "Cancelling..." : "Cancel Call"}
                </Button>
                <p className="text-xs text-muted-foreground">If they don't pick up, it won't count as your call</p>
              </div>
            </div>
          ) : isCallRinging && !iAmCaller ? (
            <div className="p-5 border-t" data-testid={`call-incoming-inline-${match.id}`}>
              <div className="text-center space-y-4">
                <div className="relative w-20 h-20 mx-auto">
                  <div className="absolute inset-0 rounded-full bg-green-500/10 animate-ping" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-16 h-16 rounded-full bg-green-500/15 flex items-center justify-center">
                      {isFaceCallStage && bothAcceptedFaceCall ? (
                        <Video className="w-6 h-6 text-green-600 animate-pulse" />
                      ) : (
                        <Phone className="w-6 h-6 text-green-600 animate-pulse" />
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-sm" data-testid={`text-incoming-call-${match.id}`}>
                    {match.profile.firstName} is calling you
                  </p>
                  <p className="text-xs text-muted-foreground">Answer to start your conversation</p>
                </div>
              </div>
            </div>
          ) : isCallActive && matchDetail ? (
            <CallTimer match={matchDetail} onComplete={() => completeCall.mutate()} isFaceCall={isFaceCallStage && !!bothAcceptedFaceCall} />
          ) : allCallsDone && matchDetail ? (
            <ReadyToMeetInline detail={matchDetail} matchId={match.id} profileName={match.profile.firstName} />
          ) : allCallsDone ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-2 bg-primary/5 border-primary/20">
                <Check className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">All calls completed</p>
                <p className="text-xs text-muted-foreground">Ready to meet in real life?</p>
              </Card>
            </div>
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
                console.log("[CALL_UI] CALL_REQUEST_STARTED", { matchId: match.id, callStage: 1, callType: "voice_2", role: "caller" });
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
                    <StageHint>Great call! You each have 6 messages before your second call unlocks.</StageHint>
                  )}
                  {myPostCallMessages >= 4 && myPostCallMessages < 6 && (
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
                            sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                          }
                        }}
                        disabled={!message.trim() || sendMessage.isPending}
                        data-testid={`button-send-postcall-${match.id}`}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : isLimitReached ? (
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
                <StageHint>Your first call is approaching — start thinking about when you'd like to talk.</StageHint>
              )}
              {messagesRemaining === 1 && (
                <StageHint>Just 1 message left before your first call unlocks.</StageHint>
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
                      sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                    }
                  }}
                  disabled={!message.trim() || sendMessage.isPending}
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
  );
}

function MatchCard({ match, unreadCount, userId, onOpen }: {
  match: MatchWithProfile;
  unreadCount: number;
  userId: string | null;
  onOpen: () => void;
}) {
  return (
    <Card
      className="cursor-pointer hover-elevate transition-all"
      onClick={onOpen}
      data-testid={`button-expand-match-${match.id}`}
    >
      <div className="p-3.5 flex items-center gap-3">
        <div className="relative">
          <Avatar className="w-12 h-12">
            <AvatarImage src={match.profile.photos?.[0]} alt={match.profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {match.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
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
}

export default function Matches() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"new" | "active">("new");
  const { data: matches, isLoading: matchesLoading, error: matchesError } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
  });

  const { data: spinRequestsData, isLoading: requestsLoading, error: requestsError } = useQuery<SpinRequestsData>({
    queryKey: ["/api/spin-requests"],
    refetchInterval: isActive ? 10000 : false,
  });

  const isLoading = matchesLoading || requestsLoading;
  const fetchFailed = !!matchesError || !!requestsError;
  const incomingRequests = spinRequestsData?.incoming || [];
  const outgoingPending = spinRequestsData?.outgoing?.filter(r => r.status === "pending") || [];
  const matchIds = (matches || []).map(m => m.id);

  const handleNewBackgroundMessage = useCallback((matchId: string) => {
    console.log("[CHAT] BACKGROUND_MESSAGE_RECEIVED_INVALIDATING", { matchId });
    queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
  }, [queryClient]);

  const { unreadCounts, markRead } = useUnreadCounts(matchIds, user?.id || null, expandedMatchId, handleNewBackgroundMessage);

  const newConnections = (matches || []).filter(m => !m.lastMessage);
  const activeChats = (matches || []).filter(m => !!m.lastMessage);
  const totalUnread = Object.values(unreadCounts).reduce((sum, n) => sum + n, 0);

  const connectionCount = matches?.length || 0;
  const atLimit = connectionCount >= MAX_CONNECTIONS;
  const hasContent = (matches && matches.length > 0) || incomingRequests.length > 0 || outgoingPending.length > 0;

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

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (!hasContent) {
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
    console.log("[CHAT] CHAT_THREAD_FOCUSED", { matchId: selectedMatch.id, profileName: selectedMatch.profile.firstName });
    return (
      <div className="flex-1 flex flex-col" data-testid="chat-focused-view">
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

      {incomingRequests.length > 0 && (
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

      {outgoingPending.length > 0 && (
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
                newConnections.map(match => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    unreadCount={unreadCounts[match.id] || 0}
                    userId={user?.id || null}
                    onOpen={() => {
                      console.log("[CHAT] CHAT_THREAD_SELECTED", { matchId: match.id, profileName: match.profile.firstName, tab: "new" });
                      setExpandedMatchId(match.id);
                    }}
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
                activeChats.map(match => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    unreadCount={unreadCounts[match.id] || 0}
                    userId={user?.id || null}
                    onOpen={() => {
                      console.log("[CHAT] CHAT_THREAD_SELECTED", { matchId: match.id, profileName: match.profile.firstName, tab: "active" });
                      setExpandedMatchId(match.id);
                    }}
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
