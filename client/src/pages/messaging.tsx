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
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeMessages } from "@/hooks/use-realtime-messages";
import { ArrowLeft, Send, Phone, Video, Check, Clock, Calendar, Heart, PhoneForwarded, X, Moon, MapPin, Ruler, MessageCircle, Loader2 } from "lucide-react";
import { PhotoCarousel } from "@/components/photo-carousel";
import { Input } from "@/components/ui/input";
import type { Message, Match, Profile } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";
import { type TranslationKey } from "@/lib/i18n";

const MAX_MESSAGES_PER_USER = 15;
const MAX_CHARS = 500;

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
      <div className="p-4 border-t">
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
                <PhoneForwarded className="w-4 h-4 mr-2" /> {t("exchange_number_btn")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
                <Calendar className="w-4 h-4 mr-2" /> {t("update_availability_btn")}
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
                  <Calendar className="w-4 h-4 mr-2" /> {t("ready_to_meet")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => { setSelectedSlots([...mySlots]); setShowDatePicker(true); }} data-testid="button-update-availability">
                  <Calendar className="w-4 h-4 mr-2" /> {t("update_availability_btn")}
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
  const { t } = useLanguageContext();
  const [message, setMessage] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "profile">("chat");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const initialScrollDoneRef = useRef(false);
  const matchId = params?.matchId;

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
      toast({ title: t("connection_closed_title"), description: t("connection_closed_desc") });
      navigate("/matches");
    },
    onError: (error: Error) => {
      toast({ title: t("could_not_close_connection"), description: error.message, variant: "destructive" });
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

  const { broadcastNewMessage } = useRealtimeMessages(matchId, !!matchId);

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
    },
    onError: (error: Error, _vars: any, context: any) => {
      if (context?.previousMsgs) {
        queryClient.setQueryData(["/api/matches", matchId, "messages"], context.previousMsgs);
      }
      toast({ title: t("could_not_send_title"), description: error.message, variant: "destructive" });
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

    if (!initialScrollDoneRef.current) {
      // First load — jump instantly to the bottom
      el.scrollTop = el.scrollHeight;
      initialScrollDoneRef.current = true;
      console.log("[CHAT_REALTIME] scrolled to bottom (initial)", { matchId: matchId?.slice(0, 8), count: msgsData?.messages?.length });
    } else if (forceScrollRef.current) {
      // User just sent a message — jump to bottom
      el.scrollTop = el.scrollHeight;
      forceScrollRef.current = false;
      console.log("[CHAT_REALTIME] scrolled to bottom (force)", { matchId: matchId?.slice(0, 8), count: msgsData?.messages?.length });
    } else if (isAtBottomRef.current) {
      // New message arrived and user is at the bottom — smooth follow
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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

  // ── Restore scroll position after older messages are prepended ──────────────
  useEffect(() => {
    if (scrollAnchorRef.current !== null) {
      const el = messagesContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight - scrollAnchorRef.current;
      scrollAnchorRef.current = null;
    }
  }, [olderMessages]);

  // ── Load older messages (cursor pagination) ─────────────────────────────────
  const loadOlderMessages = useCallback(async () => {
    if (!matchId || isLoadingOlder || !hasMoreMessages) return;
    const cursor = oldestCursorRef.current;
    if (!cursor) return;
    const el = messagesContainerRef.current;
    const savedScrollHeight = el?.scrollHeight ?? 0;
    setIsLoadingOlder(true);
    console.log("[CHAT_LOAD] load_older_start", { matchId, cursor: cursor.slice(0, 20) });
    try {
      const res = await apiRequest("GET", `/api/matches/${matchId}/messages?limit=40&before=${encodeURIComponent(cursor)}`);
      const { messages: older, hasMore } = await res.json();
      setOlderMessages(prev => [...older, ...prev]);
      setHasMoreMessages(hasMore);
      if (older.length > 0) oldestCursorRef.current = (older[0].createdAt as string) ?? null;
      scrollAnchorRef.current = savedScrollHeight;
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
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/matches")} data-testid="button-back-to-matches">
            <ArrowLeft className="w-5 h-5" />
          </Button>
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
  const messagesRemaining = MAX_MESSAGES_PER_USER - myMessages.length;
  const isLimitReached = messagesRemaining <= 0;
  const callStage = matchDetail?.callStage ?? 0;
  const allCallsDone = callStage >= 4;

  const statusLabel = allCallsDone ? t("status_ready_to_meet")
    : callStage === 3 ? t("status_face_call_stage")
    : callStage === 2 ? t("status_20_msg_stage")
    : callStage === 1 ? t("second_call_ready_badge")
    : messagesRemaining > 0 ? t("n_msg_left").replace("{n}", String(messagesRemaining))
    : t("call_time_badge");

  const callPrompt = callStage === 0
    ? { icon: Phone, title: t("call_prompt_stage0_title"), desc: t("call_prompt_stage0_desc"), button: t("start_first_call") }
    : callStage === 1
    ? { icon: Phone, title: t("call_prompt_stage1_title"), desc: t("call_prompt_stage1_desc"), button: t("start_second_call") }
    : callStage === 2
    ? { icon: Phone, title: t("call_prompt_stage2_title"), desc: t("call_prompt_stage2_desc"), button: t("view_on_connections_btn") }
    : callStage === 3
    ? { icon: Video, title: t("ready_to_see_each_other"), desc: t("face_call_desc"), button: t("view_on_connections_btn") }
    : { icon: Check, title: t("all_calls_completed"), desc: t("ready_to_meet_real"), button: "" };

  // shellProfile is always non-null here (guaranteed by the guard above)
  const profile = shellProfile;

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
                {closeConnection.isPending ? t("closing_conn") : t("close_conn_btn")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowCloseConfirm(false)} data-testid="button-cancel-close">
                {t("close_conn_keep")}
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
      </div>

      {showCloseConfirm && (
        <div className="px-4 py-2 bg-destructive/5 border-b">
          <p className="text-xs text-center text-muted-foreground">
            {t("close_connection_confirm").replace("{name}", profile.firstName)}
          </p>
        </div>
      )}

      {/* ── Chat tab ── */}
      {activeTab === "chat" && (
        <>
          <div ref={messagesContainerRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0" data-testid="messages-container">
            {/* Load older messages button — only visible when there are earlier msgs */}
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
            {/* Messages skeleton while first fetch in progress (no cache) */}
            {isMsgsLoading && allMessages.length === 0 && (
              <div className="space-y-3 pt-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
                    <Skeleton className={`h-10 rounded-md ${i % 2 === 0 ? "w-1/2" : "w-2/3"}`} />
                  </div>
                ))}
              </div>
            )}
            {allMessages.length === 0 && !isDetailLoading && (
              <div className="text-center py-12 space-y-2">
                <p className="text-muted-foreground text-sm">{t("convo_beginning")}</p>
                <p className="text-xs text-muted-foreground">{t("initial_messages_info").replace("{n}", String(MAX_MESSAGES_PER_USER))}</p>
              </div>
            )}
            {allMessages.map(msg => {
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
                {callStage === 3 ? (
                  <Button size="sm" onClick={() => navigate("/matches")} data-testid="button-go-to-connections">
                    <Video className="w-4 h-4 mr-2" /> {t("go_to_connections_btn")}
                  </Button>
                ) : callPrompt.button ? (
                  <Button size="sm" onClick={() => navigate("/matches")} data-testid="button-call-prompt">
                    <Phone className="w-4 h-4 mr-2" /> {callPrompt.button}
                  </Button>
                ) : null}
              </Card>
            </div>
          ) : allCallsDone && matchDetail ? (
            <ReadyToMeetSection matchDetail={matchDetail} matchId={matchId!} />
          ) : (
            <div className="p-4 border-t" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 1rem))" }}>
              <div className="flex gap-2 items-end">
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value.slice(0, MAX_CHARS))}
                  placeholder={t("write_meaningful_placeholder")}
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
            <PhotoCarousel
              photos={profile.photos}
              height={400}
              showArrows={profile.photos.length > 1}
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
              <MessageCircle className="w-4 h-4 mr-2" /> {t("back_to_chat_btn")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
