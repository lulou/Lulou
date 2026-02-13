import { useState, useRef, useEffect } from "react";
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
import { ArrowLeft, Send, Phone } from "lucide-react";
import type { Message, Match, Profile } from "@shared/schema";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;

type MatchDetail = Match & { profile: Profile; messages: Message[] };

export default function Messaging() {
  const [, params] = useRoute("/messages/:matchId");
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const matchId = params?.matchId;

  const { data: matchDetail, isLoading } = useQuery<MatchDetail>({
    queryKey: ["/api/matches", matchId],
    enabled: !!matchId,
  });

  const sendMessage = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/matches/${matchId}/messages`, {
        content: message.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] });
    },
    onError: (error: Error) => {
      toast({ title: "Could not send", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [matchDetail?.messages]);

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

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/matches")} data-testid="button-back-to-matches">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <Avatar className="w-9 h-9">
          <AvatarImage src={matchDetail.profile.photos?.[0]} alt={matchDetail.profile.firstName} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
            {matchDetail.profile.firstName?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm" data-testid="text-chat-name">{matchDetail.profile.firstName}</h3>
          <p className="text-xs text-muted-foreground">{matchDetail.profile.datingIntent}</p>
        </div>
        <Badge variant="outline" className="text-xs" data-testid="badge-messages-remaining">
          {messagesRemaining > 0 ? `${messagesRemaining} left` : "Limit reached"}
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="messages-container">
        {matchDetail.messages?.length === 0 && (
          <div className="text-center py-12 space-y-2">
            <p className="text-muted-foreground text-sm">This is the beginning of your conversation</p>
            <p className="text-xs text-muted-foreground">You each have {MAX_MESSAGES_PER_USER} messages. Make them count.</p>
          </div>
        )}
        {matchDetail.messages?.map(msg => {
          const isMe = msg.senderId === user?.id;
          return (
            <div key={msg.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-md px-4 py-3 text-sm ${
                  isMe
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border"
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

      {isLimitReached ? (
        <div className="p-4 border-t">
          <Card className="p-5 text-center space-y-3 bg-primary/5 border-primary/20">
            <Phone className="w-6 h-6 text-primary mx-auto" />
            <p className="font-medium text-sm">You've both shared a lot</p>
            <p className="text-xs text-muted-foreground">Ready to hear each other's voice? Your first call is free.</p>
            <Button size="sm" data-testid="button-call-prompt">
              <Phone className="w-4 h-4 mr-2" /> Start a Call
            </Button>
          </Card>
        </div>
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
                  if (message.trim()) sendMessage.mutate();
                }
              }}
              data-testid="input-message"
            />
            <Button
              size="icon"
              onClick={() => sendMessage.mutate()}
              disabled={!message.trim() || sendMessage.isPending}
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
    </div>
  );
}
