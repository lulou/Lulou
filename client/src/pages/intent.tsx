import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCw, X, MapPin, Send, Lock, Star, Crown } from "lucide-react";
import { BloomFlowerIcon } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Profile } from "@shared/schema";

const ITEM_WIDTH = 130;
const ITEM_HEIGHT = 170;
const DAILY_LIKE_GOAL = 10;

type SpinStatus = {
  spinsToday: number;
  spinsThisWeek: number;
  dailyLikes: number;
  hasMetLikeGoal: boolean;
  canSpin: boolean;
};

export default function IntentPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profiles, isLoading, isError } = useQuery<Profile[]>({
    queryKey: ["/api/popular"],
  });

  const { data: spinStatus } = useQuery<SpinStatus>({
    queryKey: ["/api/spin-status"],
    refetchInterval: 10000,
  });

  const animFrame = useRef(0);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const velocity = useRef(0);
  const angleRef = useRef(0);

  const [isSpinning, setIsSpinning] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [dispersed, setDispersed] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPurchase, setShowPurchase] = useState(false);
  const [angle, setAngle] = useState(0);
  const [message, setMessage] = useState("");

  const items = profiles || [];
  const count = items.length;
  const angleStep = count > 0 ? 360 / count : 0;
  const radius = count > 4 ? Math.max(200, count * 28) : 180;

  const canSpin = spinStatus?.canSpin ?? false;

  const getFocusedIndex = useCallback((currentAngle: number) => {
    if (count === 0) return 0;
    const normalized = ((currentAngle % 360) + 360) % 360;
    const idx = Math.round(normalized / angleStep) % count;
    return idx;
  }, [count, angleStep]);

  const glide = useCallback(() => {
    velocity.current *= 0.95;
    if (Math.abs(velocity.current) < 0.05) {
      velocity.current = 0;
      return;
    }
    angleRef.current += velocity.current;
    setAngle(angleRef.current);
    animFrame.current = requestAnimationFrame(glide);
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isSpinning || dispersed) return;
    cancelAnimationFrame(animFrame.current);
    velocity.current = 0;
    isDragging.current = true;
    startX.current = e.clientX;
    lastX.current = e.clientX;
    lastTime.current = Date.now();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = (dx / dt) * 0.8;
    lastX.current = e.clientX;
    lastTime.current = now;
    angleRef.current += dx * 0.3;
    setAngle(angleRef.current);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (Math.abs(velocity.current) > 0.2) {
      animFrame.current = requestAnimationFrame(glide);
    }
  };

  const recordSpin = useMutation({
    mutationFn: async (standoutUserId: string) => {
      await apiRequest("POST", "/api/spin", { standoutUserId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
    },
  });

  const spinWheel = () => {
    if (isSpinning || count === 0 || !canSpin) return;
    setIsSpinning(true);
    setSelectedIndex(null);
    setDispersed(false);
    setShowProfile(false);
    setShowPurchase(false);
    setMessage("");

    const targetIndex = Math.floor(Math.random() * count);
    const targetAngle = targetIndex * angleStep;

    const currentAngle = angleRef.current;
    const fullSpins = (3 + Math.floor(Math.random() * 2)) * 360;
    const normalizedCurrent = ((currentAngle % 360) + 360) % 360;
    const diff = targetAngle - normalizedCurrent;
    const totalRotation = fullSpins + diff;

    const duration = 3000 + Math.random() * 1000;
    const startTime = Date.now();
    const startAngle = currentAngle;

    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutQuart(progress);

      const newAngle = startAngle + totalRotation * eased;
      angleRef.current = newAngle;
      setAngle(newAngle);

      if (progress < 1) {
        animFrame.current = requestAnimationFrame(animate);
      } else {
        angleRef.current = startAngle + totalRotation;
        setAngle(angleRef.current);
        setSelectedIndex(targetIndex);
        setIsSpinning(false);

        const landedProfile = items[targetIndex];
        if (landedProfile) {
          recordSpin.mutate(landedProfile.userId);
        }

        setTimeout(() => setDispersed(true), 300);
        setTimeout(() => setShowProfile(true), 700);
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
        }, 1200);
      }
    };

    cancelAnimationFrame(animFrame.current);
    animFrame.current = requestAnimationFrame(animate);
  };

  const closeProfile = () => {
    setShowProfile(false);
    setDispersed(false);
    setSelectedIndex(null);
    setMessage("");
    queryClient.invalidateQueries({ queryKey: ["/api/popular"] });

    setTimeout(() => setShowPurchase(true), 300);
  };

  const sendSpinRequest = useMutation({
    mutationFn: async ({ toUserId, msg }: { toUserId: string; msg: string }) => {
      const res = await apiRequest("POST", "/api/spin-requests", {
        toUserId,
        message: msg,
      });
      return res.json();
    },
    onSuccess: () => {
      const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;
      toast({
        title: "Message sent",
        description: `Your message to ${selectedProfile?.firstName} is waiting for their response.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/spin-requests"] });
      closeProfile();
    },
    onError: () => {
      toast({
        title: "Could not send",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <BloomFlowerIcon className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">Unable to load profiles right now</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <BloomFlowerIcon className="w-10 h-10 text-primary mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">No profiles to show yet</p>
        </div>
      </div>
    );
  }

  const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;
  const dailyLikes = spinStatus?.dailyLikes ?? 0;
  const likeProgress = Math.min(dailyLikes / DAILY_LIKE_GOAL, 1);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" data-testid="intent-page">
      <div className="px-5 pt-6 pb-2">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
              Intention Wheel
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Spin to discover someone special
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Daily likes: {dailyLikes}/{DAILY_LIKE_GOAL}</span>
            {spinStatus?.hasMetLikeGoal ? (
              <Badge variant="secondary" className="text-xs" data-testid="badge-goal-met">
                <Star className="w-3 h-3 mr-1" /> Goal met - daily spin unlocked
              </Badge>
            ) : (
              <span className="text-muted-foreground" data-testid="text-goal-progress">
                {DAILY_LIKE_GOAL - dailyLikes} more to unlock daily spin
              </span>
            )}
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-500"
              style={{ width: `${likeProgress * 100}%` }}
              data-testid="progress-likes"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-start gap-4 overflow-y-auto pt-4">
        <div
          className="relative select-none touch-none"
          style={{
            width: "100%",
            height: ITEM_HEIGHT + 120,
            perspective: "800px",
            transition: dispersed ? "opacity 0.5s ease" : undefined,
            opacity: dispersed ? 0 : 1,
            pointerEvents: dispersed ? "none" : "auto",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          data-testid="intent-wheel"
        >
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              transformStyle: "preserve-3d",
              transform: `translateX(-50%) translateY(-50%) rotateY(${-angle}deg)`,
              width: ITEM_WIDTH,
              height: ITEM_HEIGHT,
              transition: isDragging.current ? "none" : undefined,
            }}
          >
            {items.map((profile, i) => {
              const itemAngle = i * angleStep;
              const photo = profile.photos?.[0];
              const isSelected = i === selectedIndex;

              const relativeAngle = ((((-angle + itemAngle) % 360) + 360) % 360);
              const cosVal = Math.cos((relativeAngle * Math.PI) / 180);
              const depthFactor = (cosVal + 1) / 2;
              const shadowOpacity = 1 - depthFactor;
              const cardScale = 0.7 + depthFactor * 0.3;

              const disperseX = dispersed && !isSelected ? (Math.random() - 0.5) * 800 : 0;
              const disperseY = dispersed && !isSelected ? (Math.random() - 0.5) * 600 : 0;
              const disperseScale = dispersed && !isSelected ? 0 : cardScale;
              const disperseOpacity = dispersed && !isSelected ? 0 : (0.4 + depthFactor * 0.6);

              return (
                <div
                  key={profile.id}
                  className={`absolute left-0 top-0 rounded-md overflow-hidden ${
                    isSelected && !dispersed ? "ring-2 ring-primary" : ""
                  }`}
                  style={{
                    width: ITEM_WIDTH,
                    height: ITEM_HEIGHT,
                    transform: dispersed && !isSelected
                      ? `rotateY(${itemAngle}deg) translateZ(${radius}px) translate(${disperseX}px, ${disperseY}px) scale(${disperseScale})`
                      : `rotateY(${itemAngle}deg) translateZ(${radius}px) scale(${cardScale})`,
                    opacity: disperseOpacity,
                    filter: `brightness(${0.4 + depthFactor * 0.6})`,
                    zIndex: Math.round(depthFactor * 100),
                    transition: dispersed ? "all 0.6s cubic-bezier(0.4, 0, 0.2, 1)" : undefined,
                  }}
                  data-testid={`intent-profile-${i}`}
                >
                  {photo ? (
                    <img
                      src={photo}
                      alt={profile.firstName}
                      className="w-full h-full object-cover pointer-events-none"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-full h-full bg-muted flex items-center justify-center">
                      <BloomFlowerIcon className="w-8 h-8 text-muted-foreground" />
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                    <p className="text-white text-xs font-medium truncate">
                      {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
                    </p>
                  </div>
                  <div
                    className="absolute inset-0 rounded-md pointer-events-none"
                    style={{
                      background: `radial-gradient(ellipse at center, rgba(0,0,0,${shadowOpacity * 0.5}) 0%, rgba(0,0,0,${shadowOpacity * 0.7}) 100%)`,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {!dispersed && !showPurchase && (
          <div className="flex flex-col items-center gap-3">
            {canSpin ? (
              <Button
                onClick={spinWheel}
                disabled={isSpinning || items.length === 0}
                className="rounded-full px-8 gap-2"
                size="lg"
                data-testid="button-spin"
              >
                <RotateCw className={`w-5 h-5 ${isSpinning ? "animate-spin" : ""}`} />
                {isSpinning ? "Spinning..." : "Spin"}
              </Button>
            ) : (
              <Button
                onClick={() => setShowPurchase(true)}
                variant="outline"
                className="rounded-full px-8 gap-2"
                size="lg"
                data-testid="button-spin-locked"
              >
                <Lock className="w-4 h-4" />
                Spin used
              </Button>
            )}
            {!canSpin && (spinStatus?.spinsToday ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground text-center max-w-xs" data-testid="text-spin-limit">
                {spinStatus?.hasMetLikeGoal
                  ? "You've used your daily spin. Come back tomorrow or buy more."
                  : `Send ${DAILY_LIKE_GOAL - dailyLikes} more likes today to unlock daily spins. Otherwise you get 1 free spin per week.`}
              </p>
            )}
          </div>
        )}

        {showPurchase && !showProfile && (
          <div className="px-5 w-full max-w-sm mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500" data-testid="purchase-spins-popup">
            <Card className="p-6 space-y-5">
              <div className="text-center space-y-2">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Crown className="w-7 h-7 text-primary" />
                </div>
                <h3 className="font-serif text-xl font-bold">Want more spins?</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {spinStatus?.hasMetLikeGoal
                    ? "You've reached your daily like goal! Buy extra spins to keep discovering."
                    : `Send ${DAILY_LIKE_GOAL - dailyLikes} more likes today to earn a daily spin, or purchase extra spins.`}
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  className="w-full gap-2"
                  onClick={() => {
                    toast({
                      title: "Coming soon",
                      description: "Spin packs will be available shortly.",
                    });
                  }}
                  data-testid="button-buy-1-spin"
                >
                  <RotateCw className="w-4 h-4" />
                  1 Spin - $1.49
                </Button>
                <Button
                  className="w-full gap-2"
                  variant="outline"
                  onClick={() => {
                    toast({
                      title: "Coming soon",
                      description: "Spin packs will be available shortly.",
                    });
                  }}
                  data-testid="button-buy-2-spins"
                >
                  <RotateCw className="w-4 h-4" />
                  2 Spins - $2.49
                </Button>
              </div>

              {!spinStatus?.hasMetLikeGoal && (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-xs font-medium text-center text-muted-foreground">Or earn your daily spin</p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${likeProgress * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium whitespace-nowrap">{dailyLikes}/{DAILY_LIKE_GOAL}</span>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Send {DAILY_LIKE_GOAL - dailyLikes} more likes on Discover to unlock a daily spin
                  </p>
                </div>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setShowPurchase(false)}
                data-testid="button-dismiss-purchase"
              >
                Maybe later
              </Button>
            </Card>
          </div>
        )}
      </div>

      {showProfile && selectedProfile && (
        <div
          className="absolute inset-0 z-50 bg-background flex flex-col"
          style={{ animation: "slideUpProfile 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards" }}
          data-testid="intent-profile-detail"
        >
          <style>{`
            @keyframes slideUpProfile {
              from { transform: translateY(100%); opacity: 0; }
              to { transform: translateY(0); opacity: 1; }
            }
          `}</style>

          <div className="flex-1 overflow-y-auto">
            <div className="relative">
              {selectedProfile.photos?.[0] ? (
                <img
                  src={selectedProfile.photos[0]}
                  alt={selectedProfile.firstName}
                  className="w-full aspect-[3/4] max-h-[50vh] object-cover"
                  data-testid="img-intent-detail-photo"
                />
              ) : (
                <div className="w-full aspect-[3/4] max-h-[50vh] bg-muted flex items-center justify-center">
                  <BloomFlowerIcon className="w-16 h-16 text-muted-foreground" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/80 to-transparent h-24" />

              <Button
                size="icon"
                variant="ghost"
                className="absolute top-3 right-3 bg-black/30 text-white backdrop-blur-sm rounded-full"
                onClick={closeProfile}
                data-testid="button-close-profile"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>

            <div className="px-5 -mt-10 relative space-y-4 pb-32">
              <div>
                <h2 className="font-serif text-3xl font-bold" data-testid="text-detail-name">
                  {selectedProfile.firstName}{selectedProfile.age ? `, ${selectedProfile.age}` : ""}
                </h2>
                {selectedProfile.location && (
                  <div className="flex items-center gap-1.5 mt-1 text-muted-foreground text-sm">
                    <MapPin className="w-3.5 h-3.5" />
                    <span data-testid="text-detail-location">{selectedProfile.location}</span>
                  </div>
                )}
                {selectedProfile.height && (
                  <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-detail-height">
                    {selectedProfile.height}
                  </p>
                )}
              </div>

              {selectedProfile.datingIntent && (
                <Badge variant="secondary" data-testid="text-detail-intent">
                  {selectedProfile.datingIntent}
                </Badge>
              )}

              {selectedProfile.signals && selectedProfile.signals.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Signals</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.signals.map((signal, i) => (
                      <Badge key={i} variant="outline" data-testid={`badge-detail-signal-${i}`}>
                        {signal}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.greenFlags && selectedProfile.greenFlags.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Green Flags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.greenFlags.map((flag, i) => (
                      <Badge key={i} variant="outline" data-testid={`badge-detail-flag-${i}`}>
                        {flag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.conversationStarters && selectedProfile.conversationStarters.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversation Starters</p>
                  <div className="space-y-2">
                    {selectedProfile.conversationStarters.map((starter, i) => (
                      <Card key={i} className="p-3">
                        <p className="text-sm italic" data-testid={`text-detail-starter-${i}`}>"{starter}"</p>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.photos && selectedProfile.photos.length > 1 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Photos</p>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedProfile.photos.slice(1).map((photo, i) => (
                      <img
                        key={i}
                        src={photo}
                        alt={`${selectedProfile.firstName} photo ${i + 2}`}
                        className="w-full aspect-square object-cover rounded-md"
                        data-testid={`img-detail-photo-${i + 1}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 bg-background/95 backdrop-blur-md border-t p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Write a message to {selectedProfile.firstName}. They'll decide whether to connect with you.
            </p>
            <div className="flex items-center gap-2">
              <Input
                placeholder={`Say something meaningful to ${selectedProfile.firstName}...`}
                value={message}
                onChange={e => setMessage(e.target.value.slice(0, 500))}
                onKeyDown={e => {
                  if (e.key === "Enter" && message.trim()) {
                    sendSpinRequest.mutate({ toUserId: selectedProfile.userId, msg: message.trim() });
                  }
                }}
                className="flex-1"
                data-testid="input-intent-message"
              />
              <Button
                size="icon"
                disabled={!message.trim() || sendSpinRequest.isPending}
                onClick={() => {
                  if (message.trim()) {
                    sendSpinRequest.mutate({ toUserId: selectedProfile.userId, msg: message.trim() });
                  }
                }}
                data-testid="button-intent-send"
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {message.length}/500
              </p>
              <Button variant="ghost" size="sm" onClick={closeProfile} data-testid="button-intent-pass">
                Not now
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
