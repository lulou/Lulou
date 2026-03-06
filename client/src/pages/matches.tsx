import { useState, useRef, useEffect } from "react";
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
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Phone, Video, ChevronDown, ChevronUp, PhoneOff, Clock, Check, X, Sparkles, Calendar, Heart, PhoneForwarded, Moon } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { broadcastCallSignal } from "@/hooks/use-call-signaling";
import type { Profile, Match, Message, SpinRequest } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;

const CALL_DURATIONS = [10 * 60, 15 * 60, 10 * 60];

function getCallDuration(stage: number): number {
  return CALL_DURATIONS[stage] || CALL_DURATIONS[0];
}

type MatchWithProfile = Match & { profile: Profile };
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

function MatchChat({ match }: { match: MatchWithProfile }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: matchDetail } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", match.id],
    enabled: expanded,
    refetchInterval: expanded && isActive ? 10000 : false,
  });

  useRealtimeMessages(match.id, expanded);

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
      const path = `/api/matches/${match.id}/call/start`;
      console.log("[Call] CALL_API_REQUEST", { path, method: "POST", matchId: match.id });
      const res = await apiRequest("POST", path, {});
      const data = await res.json();
      console.log("[Call] CALL_API_RESPONSE", { path, status: res.status, callSessionId: data.callSessionId });
      return data;
    },
    onSuccess: (data: any) => {
      console.log("[Call] CALL_SESSION_CREATED", { matchId: match.id, callSessionId: data.callSessionId });
      broadcastCallSignal(match.id, {
        type: "call:ring",
        matchId: match.id,
        callerId: user!.id,
        callerName: "You",
        callSessionId: data.callSessionId,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
    },
    onError: (error: Error) => {
      console.error("[Call] CALL_API_RESPONSE error:", error.message);
      toast({ title: "Call failed", description: error.message, variant: "destructive" });
    },
  });

  const cancelCall = useMutation({
    mutationFn: async () => {
      console.log("[Call] CALL_CANCELLED - cancelling call for match:", match.id);
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      console.log("[Call] Call cancelled, broadcasting cancel signal");
      iCancelledRef.current = true;
      broadcastCallSignal(match.id, {
        type: "call:cancelled",
        matchId: match.id,
        userId: user!.id,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Call cancelled", description: "No worries - the call wasn't connected so it doesn't count." });
    },
  });

  const completeCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/complete`, {});
      return res.json();
    },
    onSuccess: (data: any) => {
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

  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const wasRingingRef = useRef(false);
  const iCancelledRef = useRef(false);

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [matchDetail?.messages, expanded]);

  const detail = matchDetail || match as unknown as MatchDetail;
  const myMessages = matchDetail?.messages?.filter(m => m.senderId === user?.id) || [];
  const messagesRemaining = MAX_MESSAGES_PER_USER - myMessages.length;
  const isLimitReached = messagesRemaining <= 0;
  const allMessages = matchDetail?.messages || [];
  const callStage = detail.callStage || 0;
  const isCallRinging = detail.callStartedAt && detail.callSessionId && !detail.callAnswered && !detail.callCompleted;
  const isCallActive = detail.callStartedAt && detail.callSessionId && detail.callAnswered && !detail.callCompleted;

  const iAmCaller = detail.callInitiatorId === user?.id;
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
  const allCallsDone = callStage >= 3;
  const isFaceCallStage = callStage === 2;
  const myFaceCallAccepted = detail.user1Id === user?.id ? detail.faceCallUser1Accepted : detail.faceCallUser2Accepted;
  const theirFaceCallAccepted = detail.user1Id === user?.id ? detail.faceCallUser2Accepted : detail.faceCallUser1Accepted;
  const bothAcceptedFaceCall = detail.faceCallUser1Accepted && detail.faceCallUser2Accepted;

  return (
    <Card className="overflow-hidden" data-testid={`card-match-${match.id}`}>
      <div
        className="p-4 cursor-pointer hover-elevate transition-all"
        onClick={() => setExpanded(!expanded)}
        data-testid={`button-expand-match-${match.id}`}
      >
        <div className="flex items-center gap-4">
          <Avatar className="w-14 h-14">
            <AvatarImage src={match.profile.photos?.[0]} alt={match.profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {match.profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold" data-testid={`text-match-name-${match.id}`}>
                {match.profile.firstName}, {match.profile.age}
              </h3>
              {match.profile.signals?.[0] && (
                <Badge variant="secondary" className="text-xs">
                  {match.profile.signals[0]}
                </Badge>
              )}
              {isCallRinging && (
                <Badge variant="secondary" className="text-xs" data-testid={`badge-call-ringing-${match.id}`}>
                  <Phone className="w-3 h-3 mr-1 animate-pulse" /> Ringing
                </Badge>
              )}
              {isCallActive && (
                <Badge variant="default" className="text-xs" data-testid={`badge-call-active-${match.id}`}>
                  <Clock className="w-3 h-3 mr-1" /> On Call
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{match.profile.datingIntent}</p>
          </div>
          <div className="flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-muted-foreground/50" />
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t" data-testid={`chat-section-${match.id}`}>
          <div className="flex items-center justify-between gap-2 px-4 py-2 bg-muted/30">
            <p className="text-xs text-muted-foreground font-medium">Chat</p>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs" data-testid={`badge-messages-remaining-${match.id}`}>
                {allCallsDone ? "All calls done" : callStage === 2 ? "Face call stage" : callStage === 1 ? "2nd call ready" : messagesRemaining > 0 ? `${messagesRemaining} left` : "Call time"}
              </Badge>
              {showRemoveConfirm ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Remove?</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeMatch.mutate()}
                    disabled={removeMatch.isPending}
                    data-testid={`button-confirm-remove-${match.id}`}
                  >
                    <Check className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
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
                  onClick={() => setShowRemoveConfirm(true)}
                  data-testid={`button-remove-match-${match.id}`}
                >
                  <Moon className="w-3.5 h-3.5 text-muted-foreground" />
                </Button>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-4 space-y-3" data-testid={`messages-container-${match.id}`}>
            {allMessages.length === 0 && (
              <div className="text-center py-6 space-y-2">
                <p className="text-muted-foreground text-sm">Start of your conversation</p>
                <p className="text-xs text-muted-foreground">You each have {MAX_MESSAGES_PER_USER} messages. Make them count.</p>
              </div>
            )}
            {allMessages.map(msg => {
              const isMe = msg.senderId === user?.id;
              return (
                <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[75%] rounded-md px-4 py-3 text-sm ${
                      isMe
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                    data-testid={`message-${msg.id}`}
                  >
                    <p className="leading-relaxed">{msg.content}</p>
                    <p className={`text-xs mt-1 ${isMe ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                      {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {isCallRinging ? (
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
                  <p className="font-medium text-sm">Calling {match.profile.firstName}...</p>
                  <p className="text-xs text-muted-foreground">Waiting for them to pick up</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => cancelCall.mutate()}
                  disabled={cancelCall.isPending}
                  data-testid={`button-cancel-call-${match.id}`}
                >
                  <PhoneOff className="w-4 h-4 mr-2" /> Cancel Call
                </Button>
                <p className="text-xs text-muted-foreground">If they don't pick up, it won't count as your call</p>
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
                  onClick={() => startCall.mutate()}
                  disabled={startCall.isPending}
                  data-testid={`button-start-face-call-${match.id}`}
                >
                  <Video className="w-4 h-4 mr-2" /> {startCall.isPending ? "Starting..." : "Start Face Call"}
                </Button>
              </Card>
            </div>
          ) : callStage === 1 ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
                <Phone className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">First call went great!</p>
                <p className="text-xs text-muted-foreground">Ready for a longer 15-minute call to go deeper?</p>
                <Button
                  size="sm"
                  onClick={() => startCall.mutate()}
                  disabled={startCall.isPending}
                  data-testid={`button-second-call-${match.id}`}
                >
                  <Phone className="w-4 h-4 mr-2" /> {startCall.isPending ? "Starting..." : "Start Second Call"}
                </Button>
              </Card>
            </div>
          ) : isLimitReached ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
                <Phone className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">You've both shared a lot - ready to hear each other's voice?</p>
                <p className="text-xs text-muted-foreground">Your first call is 10 minutes to keep it meaningful.</p>
                <Button
                  size="sm"
                  onClick={() => startCall.mutate()}
                  disabled={startCall.isPending}
                  data-testid={`button-call-${match.id}`}
                >
                  <Phone className="w-4 h-4 mr-2" /> {startCall.isPending ? "Starting..." : "Start First Call"}
                </Button>
              </Card>
            </div>
          ) : (
            <div className="p-3 border-t">
              <div className="flex gap-2 items-end">
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value.slice(0, MAX_CHARS))}
                  placeholder="Write something meaningful..."
                  className="resize-none min-h-[44px] max-h-[80px] text-sm"
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (message.trim()) {
                        const content = message.trim();
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
      )}
    </Card>
  );
}

export default function Matches() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
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
        <div className="space-y-3">
          {(incomingRequests.length > 0 || outgoingPending.length > 0) && (
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-primary" />
              <h2 className="font-semibold text-sm">Active Connections</h2>
              <Badge variant="secondary" className="text-xs">{matches.length}</Badge>
            </div>
          )}
          {matches.map(match => (
            <MatchChat key={match.id} match={match} />
          ))}
        </div>
      )}

      </div>
    </div>
  );
}
