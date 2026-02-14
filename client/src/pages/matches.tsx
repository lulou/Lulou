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
import { MessageCircle, Sparkles, Send, Phone, ChevronDown, ChevronUp, PhoneOff, Clock } from "lucide-react";
import type { Profile, Match, Message } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;
const CALL_DURATION_SECONDS = 10 * 60;

type MatchWithProfile = Match & { profile: Profile };
type MatchDetail = Match & { profile: Profile; messages: Message[] };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CallTimer({ match, onComplete }: { match: MatchDetail; onComplete: () => void }) {
  const [remaining, setRemaining] = useState(() => {
    if (!match.callStartedAt) return CALL_DURATION_SECONDS;
    const elapsed = Math.floor((Date.now() - new Date(match.callStartedAt).getTime()) / 1000);
    return Math.max(0, CALL_DURATION_SECONDS - elapsed);
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

  const progress = remaining / CALL_DURATION_SECONDS;
  const isLow = remaining <= 60;

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
            <Phone className={`w-5 h-5 mb-1 ${isLow ? "text-destructive" : "text-primary"}`} />
            <span className={`text-xl font-bold tabular-nums ${isLow ? "text-destructive" : ""}`} data-testid={`text-timer-${match.id}`}>
              {formatTime(remaining)}
            </span>
          </div>
        </div>

        {remaining > 0 ? (
          <div className="space-y-2">
            <p className="font-medium text-sm">Call in progress</p>
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
            <p className="text-xs text-muted-foreground">
              How was the conversation? Ready to meet in person?
            </p>
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

function MatchChat({ match }: { match: MatchWithProfile }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: matchDetail } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", match.id],
    enabled: expanded,
    refetchInterval: expanded ? 3000 : false,
  });

  const sendMessage = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/messages`, {
        content: message.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not send", description: error.message, variant: "destructive" });
    },
  });

  const startCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/start`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
    },
  });

  const completeCall = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${match.id}/call/complete`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches", match.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({ title: "Call completed", description: "Great conversation! Consider meeting in person." });
    },
  });

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
  const isCallActive = detail.callStartedAt && !detail.callCompleted;
  const isCallDone = detail.callCompleted;

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
            <Badge variant="outline" className="text-xs" data-testid={`badge-messages-remaining-${match.id}`}>
              {isCallDone ? "Call completed" : messagesRemaining > 0 ? `${messagesRemaining} left` : "Limit reached"}
            </Badge>
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

          {isCallActive && matchDetail ? (
            <CallTimer match={matchDetail} onComplete={() => completeCall.mutate()} />
          ) : isCallDone ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-2 bg-primary/5 border-primary/20">
                <Phone className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">Call completed</p>
                <p className="text-xs text-muted-foreground">Great conversation! Ready to meet in real life?</p>
              </Card>
            </div>
          ) : isLimitReached ? (
            <div className="p-4 border-t">
              <Card className="p-4 text-center space-y-3 bg-primary/5 border-primary/20">
                <Phone className="w-5 h-5 text-primary mx-auto" />
                <p className="font-medium text-sm">You've both shared a lot — ready to hear each other's voice?</p>
                <p className="text-xs text-muted-foreground">Your first call is free. We suggest 10 minutes to keep it meaningful.</p>
                <Button
                  size="sm"
                  onClick={() => startCall.mutate()}
                  disabled={startCall.isPending}
                  data-testid={`button-call-${match.id}`}
                >
                  <Phone className="w-4 h-4 mr-2" /> {startCall.isPending ? "Starting..." : "Start a Call"}
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
                      if (message.trim()) sendMessage.mutate();
                    }
                  }}
                  data-testid={`input-message-${match.id}`}
                />
                <Button
                  size="icon"
                  onClick={() => sendMessage.mutate()}
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
  const { data: matches, isLoading } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
  });

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

  if (!matches || matches.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-matches">No matches yet</h2>
          <p className="text-muted-foreground text-sm">
            When you and someone both open up, you'll see them here. Keep discovering.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-lg mx-auto w-full">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-bold" data-testid="text-matches-title">Your Connections</h1>
        <p className="text-sm text-muted-foreground">{matches.length} mutual {matches.length === 1 ? "connection" : "connections"}</p>
      </div>

      <div className="space-y-3">
        {matches.map(match => (
          <MatchChat key={match.id} match={match} />
        ))}
      </div>
    </div>
  );
}
