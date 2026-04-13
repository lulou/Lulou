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
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { ArrowLeft, Send, Phone, Video, Check, Clock, Calendar, Heart, PhoneForwarded, X, Moon, MapPin, Ruler, MessageCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { Message, Match, Profile } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;

type MatchDetail = Match & { profile: Profile; messages: Message[] };

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
  const queryClient = useQueryClient();
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [showPhoneInput, setShowPhoneInput] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const dateSlots = generateDateSlots();

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
      toast({ title: "Availability shared", description: `${matchDetail.profile.firstName} will see when you're free.` });
      setShowDatePicker(false);
    },
    onError: (error: Error) => {
      toast({ title: "Could not save", description: error.message, variant: "destructive" });
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
      toast({ title: "Number shared", description: `Your number has been sent to ${matchDetail.profile.firstName}.` });
      setShowPhoneInput(false);
    },
    onError: (error: Error) => {
      toast({ title: "Could not share number", description: error.message, variant: "destructive" });
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
            <p className="font-medium text-sm">Add your phone number</p>
            <p className="text-xs text-muted-foreground">Your number will be sent as a message to {matchDetail.profile.firstName}</p>
          </div>
          <Input
            type="tel"
            value={phoneNumber}
            onChange={e => setPhoneNumber(e.target.value)}
            placeholder="Your phone number"
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
              {savePhoneAndExchange.isPending ? "Sending..." : "Share My Number"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowPhoneInput(false)} data-testid="button-cancel-phone">
              Cancel
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
            <p className="font-medium text-sm">When are you free to meet?</p>
            <p className="text-xs text-muted-foreground">Select up to 5 time slots</p>
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
          <p className="text-xs text-muted-foreground text-center">{selectedSlots.length}/5 selected</p>
          <div className="flex items-center gap-2 justify-center">
            <Button
              size="sm"
              onClick={() => saveAvailability.mutate()}
              disabled={selectedSlots.length === 0 || saveAvailability.isPending}
              data-testid="button-save-availability"
            >
              {saveAvailability.isPending ? "Saving..." : "Share Availability"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDatePicker(false)} data-testid="button-cancel-dates">
              Cancel
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (myNumberExchanged) {
    return (
      <div className="p-4 border-t">
        <Card className="p-5 text-center space-y-3 bg-primary/5 border-primary/20">
          <Heart className="w-6 h-6 text-primary mx-auto" />
          <p className="font-medium text-sm">Number shared</p>
          <p className="text-xs text-muted-foreground">
            {theirNumberExchanged
              ? `You've both exchanged numbers. Time to plan something special!`
              : `Your number has been sent. Waiting for ${matchDetail.profile.firstName} to share theirs.`}
          </p>
          {matchingSlots.length > 0 && (
            <div className="space-y-1 pt-2">
              <p className="text-xs font-medium text-muted-foreground">Your matching date times:</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => {
                  const matched = dateSlots.find(d => d.value === s);
                  return <Badge key={s} variant="secondary" className="text-xs">{matched?.label || s}</Badge>;
                })}
              </div>
            </div>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 border-t">
      <Card className="p-5 text-center space-y-4 bg-primary/5 border-primary/20">
        <Check className="w-6 h-6 text-primary mx-auto" />
        <p className="font-medium text-sm">All calls completed</p>
        <p className="text-xs text-muted-foreground">You've had wonderful conversations. Ready to meet in real life?</p>

        {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length > 0 ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2 justify-center">
              <Heart className="w-4 h-4 text-primary" />
              <p className="font-medium text-sm text-primary">Your date is on the cards!</p>
              <Heart className="w-4 h-4 text-primary" />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">You both matched on:</p>
              <div className="flex flex-wrap gap-1 justify-center">
                {matchingSlots.map((s: string) => {
                  const matched = dateSlots.find(d => d.value === s);
                  return <Badge key={s} className="text-xs bg-primary/15 text-primary border-primary/30">{matched?.label || s}</Badge>;
                })}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-center pt-1">
              <Button size="sm" onClick={handleExchangeNumber} data-testid="button-exchange-number">
                <PhoneForwarded className="w-4 h-4 mr-2" /> Exchange Number
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
                <Calendar className="w-4 h-4 mr-2" /> Update Availability
              </Button>
            </div>
          </div>
        ) : (
          <>
            {mySlots.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Your availability:</p>
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
                <p className="text-xs font-medium text-muted-foreground">{matchDetail.profile.firstName}'s availability:</p>
                <div className="flex flex-wrap gap-1 justify-center">
                  {theirSlots.map((s: string) => {
                    const matched = dateSlots.find(d => d.value === s);
                    return <Badge key={s} variant="outline" className="text-xs">{matched?.label || s}</Badge>;
                  })}
                </div>
              </div>
            )}

            {mySlots.length > 0 && theirSlots.length > 0 && matchingSlots.length === 0 && (
              <p className="text-xs text-muted-foreground">No matching times yet. Try updating your availability!</p>
            )}

            <div className="flex flex-col gap-2 items-center">
              {mySlots.length === 0 ? (
                <Button size="sm" onClick={() => setShowDatePicker(true)} data-testid="button-ready-to-meet">
                  <Calendar className="w-4 h-4 mr-2" /> Ready to Meet
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
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

export default function Messaging() {
  const [, params] = useRoute("/messages/:matchId");
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "profile">("chat");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const matchId = params?.matchId;

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const closeConnection = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/matches/${matchId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Connection closed", description: "You can now connect with someone new." });
      navigate("/matches");
    },
    onError: (error: Error) => {
      toast({ title: "Could not close connection", description: error.message, variant: "destructive" });
    },
  });

  const { data: matchDetail, isLoading } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", matchId],
    enabled: !!matchId,
    // No polling — incoming messages arrive via real-time subscription (useRealtimeMessages)
  });

  useRealtimeMessages(matchId, !!matchId);

  const sendMessage = useMutation({
    mutationFn: async (vars: { content: string; tempId: string }) => {
      if (!matchId) throw new Error("No match");
      const res = await apiRequest("POST", `/api/matches/${matchId}/messages`, { content: vars.content });
      return res.json();
    },
    onMutate: async (vars: { content: string; tempId: string }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/matches", matchId] });
      const previous = queryClient.getQueryData<MatchDetail>(["/api/matches", matchId]);
      if (previous) {
        const optimisticMsg = {
          id: vars.tempId,
          matchId: matchId!,
          senderId: user?.id || "",
          content: vars.content,
          reaction: null,
          createdAt: new Date().toISOString(),
        };
        queryClient.setQueryData<MatchDetail>(["/api/matches", matchId], {
          ...previous,
          messages: [...(previous.messages || []), optimisticMsg],
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
      return { previous };
    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/matches", matchId], context.previous);
      }
      toast({ title: "Could not send", description: error.message, variant: "destructive" });
    },
  });

  const toggleReaction = useMutation({
    mutationFn: async ({ messageId, currentReaction }: { messageId: string; currentReaction: string | null }) => {
      const newReaction = currentReaction ? null : "❤️";
      console.log(newReaction ? "[CHAT] MESSAGE_REACTION_ADDED" : "[CHAT] MESSAGE_REACTION_REMOVED", { messageId, matchId });
      const res = await apiRequest("POST", `/api/messages/${messageId}/reaction`, { reaction: newReaction });
      return res.json();
    },
    onMutate: async ({ messageId, currentReaction }) => {
      const key = ["/api/matches", matchId];
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
    onError: (_err: any, _vars: any, context: any) => {
      if (context?.prev) {
        queryClient.setQueryData(["/api/matches", matchId], context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
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
    if (!matchDetail?.messages) return;
    const el = messagesContainerRef.current;
    if (!el) return;

    if (!initialScrollDoneRef.current) {
      // First load — jump instantly to the bottom
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
    } else if (forceScrollRef.current) {
      // User just sent a message — jump to bottom
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
    } else if (isAtBottomRef.current) {
      // New message arrived and user is at the bottom — smooth follow
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    // If user is scrolled up reading history: do nothing
  }, [matchDetail?.messages?.length]);

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-3">
          <Skeleton className="w-10 h-10 rounded-full" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex-1 p-4 space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-12 w-2/3 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (!matchDetail) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Connection not found</p>
      </div>
    );
  }

  const myMessages = matchDetail.messages?.filter(m => m.senderId === user?.id) || [];
  const messagesRemaining = MAX_MESSAGES_PER_USER - myMessages.length;
  const isLimitReached = messagesRemaining <= 0;
  const callStage = matchDetail.callStage || 0;
  const allCallsDone = callStage >= 3;

  const statusLabel = allCallsDone ? "Ready to meet"
    : callStage === 2 ? "Face call stage"
    : callStage === 1 ? "2nd call ready"
    : messagesRemaining > 0 ? `${messagesRemaining} left`
    : "Call time";

  const callPrompt = callStage === 0
    ? { icon: Phone, title: "You've both shared a lot", desc: "Ready to hear each other's voice? Your first call is 10 minutes.", button: "Start First Call" }
    : callStage === 1
    ? { icon: Phone, title: "First call went great!", desc: "Ready for a longer 15-minute call?", button: "Start Second Call" }
    : callStage === 2
    ? { icon: Video, title: "Ready to see each other?", desc: "Both of you need to accept for a 10-minute face call.", button: "View on Connections" }
    : { icon: Check, title: "All calls completed", desc: "You've had wonderful conversations. Ready to meet in real life?", button: "" };

  const profile = matchDetail.profile;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="px-4 pt-3 pb-0 border-b bg-background">
        <div className="flex items-center gap-3 pb-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/matches")} data-testid="button-back-to-matches">
            <ArrowLeft className="w-5 h-5" />
          </Button>

          <Avatar className="w-9 h-9 flex-shrink-0">
            <AvatarImage src={profile.photos?.[0]} alt={profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
              {profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm leading-tight truncate" data-testid="text-chat-name">{profile.firstName}</h3>
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
                {closeConnection.isPending ? "Closing..." : "Close"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowCloseConfirm(false)} data-testid="button-cancel-close">
                Keep
              </Button>
            </div>
          )}
        </div>

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
            Chat
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
            Profile
          </button>
        </div>
      </div>

      {showCloseConfirm && (
        <div className="px-4 py-2 bg-destructive/5 border-b">
          <p className="text-xs text-center text-muted-foreground">
            Close your connection with {matchDetail.profile.firstName}? This frees a spot for a new connection.
          </p>
        </div>
      )}

      {/* ── Chat tab ── */}
      {activeTab === "chat" && (
        <>
          <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0" data-testid="messages-container">
            {matchDetail.messages?.length === 0 && (
              <div className="text-center py-12 space-y-2">
                <p className="text-muted-foreground text-sm">This is the beginning of your conversation</p>
                <p className="text-xs text-muted-foreground">You each have {MAX_MESSAGES_PER_USER} messages. Make them count.</p>
              </div>
            )}
            {matchDetail.messages?.map(msg => {
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
                          : "bg-card border cursor-pointer"
                      } ${!isMe ? "active:scale-[0.98] transition-transform" : ""}`}
                      onClick={() => handleMessageTap(msg)}
                      data-testid={`message-${msg.id}`}
                    >
                      <p className="leading-relaxed">{msg.content}</p>
                      <p className={`text-[10px] mt-1.5 leading-none opacity-60 ${isMe ? "text-primary-foreground" : "text-muted-foreground"}`}>
                        {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
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

          {(isLimitReached || callStage > 0) && !allCallsDone ? (
            <div className="p-4 border-t">
              <Card className="p-5 text-center space-y-3 bg-primary/5 border-primary/20">
                <callPrompt.icon className="w-6 h-6 text-primary mx-auto" />
                <p className="font-medium text-sm">{callPrompt.title}</p>
                <p className="text-xs text-muted-foreground">{callPrompt.desc}</p>
                {callStage === 2 ? (
                  <Button size="sm" onClick={() => navigate("/matches")} data-testid="button-go-to-connections">
                    <Video className="w-4 h-4 mr-2" /> Go to Connections
                  </Button>
                ) : callPrompt.button ? (
                  <Button size="sm" onClick={() => navigate("/matches")} data-testid="button-call-prompt">
                    <Phone className="w-4 h-4 mr-2" /> {callPrompt.button}
                  </Button>
                ) : null}
              </Card>
            </div>
          ) : allCallsDone ? (
            <ReadyToMeetSection matchDetail={matchDetail} matchId={matchId!} />
          ) : (
            <div className="p-4 border-t">
              <div className="flex gap-2 items-end">
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value.slice(0, MAX_CHARS))}
                  placeholder="Write something meaningful..."
                  className="resize-none min-h-[44px] max-h-[120px] text-sm"
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (message.trim()) {
                        const content = message.trim();
                        setMessage("");
                        forceScrollRef.current = true;
                        sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                      }
                    }
                  }}
                  data-testid="input-message"
                />
                <Button
                  size="icon"
                  onClick={() => {
                    if (message.trim()) {
                      const content = message.trim();
                      setMessage("");
                      forceScrollRef.current = true;
                      sendMessage.mutate({ content, tempId: `temp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
                    }
                  }}
                  disabled={!message.trim()}
                  data-testid="button-send"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1 text-right">
                {message.length}/{MAX_CHARS}
              </p>
            </div>
          )}
        </>
      )}

      {/* ── Profile tab ── */}
      {activeTab === "profile" && (
        <div className="flex-1 overflow-y-auto min-h-0" data-testid="profile-tab-content">
          {profile.photos?.length > 0 && (
            <div className="flex gap-2 overflow-x-auto px-4 pt-4 pb-1 snap-x snap-mandatory">
              {profile.photos.map((photo, i) => (
                <img
                  key={i}
                  src={photo}
                  alt={`${profile.firstName} photo ${i + 1}`}
                  className="w-64 h-80 object-cover rounded-xl flex-shrink-0 snap-start"
                  data-testid={`img-profile-photo-${i}`}
                />
              ))}
            </div>
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
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Here for</p>
                <Badge variant="secondary" className="text-sm">{profile.datingIntent}</Badge>
              </div>
            )}

            {profile.signals?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Vibe</p>
                <div className="flex flex-wrap gap-1.5">
                  {profile.signals.map((s, i) => (
                    <Badge key={i} variant="outline" className="text-xs">{s}</Badge>
                  ))}
                </div>
              </div>
            )}

            {profile.greenFlags?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Green flags</p>
                <div className="flex flex-col gap-1">
                  {profile.greenFlags.map((f, i) => (
                    <p key={i} className="text-sm flex items-start gap-1.5">
                      <span className="text-emerald-500 mt-0.5">✓</span>{f}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {profile.connectionStyle && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Connection style</p>
                <p className="text-sm">{profile.connectionStyle}</p>
              </div>
            )}

            {profile.conversationStarters && profile.conversationStarters.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Ask me about</p>
                <div className="space-y-1.5">
                  {profile.conversationStarters.map((cs, i) => (
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
              <MessageCircle className="w-4 h-4 mr-2" /> Back to chat
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
