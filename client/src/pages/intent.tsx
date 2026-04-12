import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, RotateCw, X, MapPin, Lock, Star, Crown, MessageCircle, HelpCircle, Heart, Moon } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useTabActive } from "@/App";
import type { Profile } from "@shared/schema";

// Lazy-loads a single photo for a wheel item or profile card.
// Photos are excluded from the pool queries to prevent DB statement timeouts.
function ProfilePhoto({ userId, className }: { userId: string; className?: string }) {
  const { data } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const photo = data?.photos?.[0];
  if (!photo) {
    return (
      <div className={`bg-muted flex items-center justify-center ${className ?? ""}`}>
        <LulouFlowerIcon className="w-8 h-8 text-muted-foreground" />
      </div>
    );
  }
  return <img src={photo} alt="" className={`object-cover ${className ?? ""}`} draggable={false} />;
}

const ITEM_WIDTH = 130;
const ITEM_HEIGHT = 170;
const DAILY_LIKE_GOAL = 10;
const STREAK_GOAL = 3;

type SpinStatus = {
  spinsThisWeek: number;
  dailyLikes: number;
  consecutiveDays: number;
  streakComplete: boolean;
  canSpin: boolean;
};

export default function IntentPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [, navigate] = useLocation();

  const { data: profiles, isLoading, isError } = useQuery<Profile[]>({
    queryKey: ["/api/popular"],
  });

  const { data: spinStatus } = useQuery<SpinStatus>({
    queryKey: ["/api/spin-status"],
    refetchInterval: isActive ? 10000 : false,
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

  const committedDrag = useRef(false);
  const startY = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isSpinning || dispersed) return;
    cancelAnimationFrame(animFrame.current);
    velocity.current = 0;
    isDragging.current = true;
    committedDrag.current = false;
    startX.current = e.clientX;
    startY.current = e.clientY;
    lastX.current = e.clientX;
    lastTime.current = Date.now();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    if (!committedDrag.current) {
      const adx = Math.abs(e.clientX - startX.current);
      const ady = Math.abs(e.clientY - startY.current);
      if (ady > adx) { isDragging.current = false; return; }
      if (adx < 8) return;
      committedDrag.current = true;
      if (e.pointerType === "touch") {
        e.preventDefault();
      }
    }
    const now = Date.now();
    const dt = now - lastTime.current;
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = (dx / dt) * 0.8;
    lastX.current = e.clientX;
    lastTime.current = now;
    angleRef.current += dx * 0.3;
    setAngle(angleRef.current);
  };

  const handlePointerUp = () => {
    isDragging.current = false;
    committedDrag.current = false;
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

  const wheelOpen = useMutation({
    mutationFn: async (toUserId: string) => {
      const res = await apiRequest("POST", "/api/wheel/open", { toUserId });
      return res.json() as Promise<{ matchId: string; isExisting: boolean }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.isExisting ? "Connection reopened" : "Connected!",
        description: "Head to your matches to start the conversation.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      closeProfile();
      navigate("/matches");
    },
    onError: (error: any) => {
      const raw = error?.message || "";
      let msg = "Something went wrong. Try again.";
      try { const p = JSON.parse(raw); if (p?.message) msg = p.message; } catch {}
      toast({ title: "Could not connect", description: msg, variant: "destructive" });
    },
  });

  const spinWheel = () => {
    if (isSpinning || count === 0 || !canSpin) return;
    setIsSpinning(true);
    setSelectedIndex(null);
    setDispersed(false);
    setShowProfile(false);
    setShowPurchase(false);

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
    queryClient.invalidateQueries({ queryKey: ["/api/popular"] });

    setTimeout(() => setShowPurchase(true), 300);
  };


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
          <LulouFlowerIcon className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">Unable to load profiles right now</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <LulouFlowerIcon className="w-10 h-10 text-primary mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">No profiles to show yet</p>
        </div>
      </div>
    );
  }

  const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;
  const dailyLikes = spinStatus?.dailyLikes ?? 0;
  const consecutiveDays = spinStatus?.consecutiveDays ?? 0;
  const streakComplete = spinStatus?.streakComplete ?? false;
  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" data-testid="intent-page">
      <div className="px-5 pt-5 pb-1">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
              Intention Wheel
            </h1>
          </div>
          <div className="flex items-center gap-2" data-testid="streak-indicator">
            {streakComplete ? (
              <Badge variant="secondary" className="text-xs" data-testid="badge-streak-complete">
                <Star className="w-3 h-3 mr-1" /> Spin earned
              </Badge>
            ) : (
              <div className="flex items-center gap-1.5">
                {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                  <div
                    key={i}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      i < consecutiveDays ? "bg-primary" : "bg-muted-foreground/30"
                    }`}
                    data-testid={`streak-dot-${i}`}
                  />
                ))}
                <span className="text-xs text-muted-foreground ml-1" data-testid="text-likes-today">
                  {dailyLikes}/{DAILY_LIKE_GOAL}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-4 overflow-hidden">
        <div
          className="relative select-none touch-manipulation"
          style={{
            width: "100%",
            height: ITEM_HEIGHT + 140,
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
              const isSelected = i === selectedIndex;

              const relativeAngle = ((((-angle + itemAngle) % 360) + 360) % 360);
              const cosVal = Math.cos((relativeAngle * Math.PI) / 180);
              const depthFactor = (cosVal + 1) / 2;
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
                    zIndex: Math.round(depthFactor * 100),
                    transition: dispersed ? "all 0.6s cubic-bezier(0.4, 0, 0.2, 1)" : undefined,
                  }}
                  data-testid={`intent-profile-${i}`}
                >
                  <ProfilePhoto userId={profile.userId} className="w-full h-full pointer-events-none" />
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                    <p className="text-white text-xs font-medium truncate">
                      {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {!dispersed && !showPurchase && (
          <div className="flex flex-col items-center gap-2 px-6 w-full max-w-xs mx-auto">
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

            {!streakComplete && (
              <div className="w-full mt-1">
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => {
                    const isCurrentDay = i === consecutiveDays;
                    const isDone = i < consecutiveDays;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full h-1.5 rounded-full overflow-hidden bg-muted">
                          {isDone ? (
                            <div className="w-full h-full bg-primary rounded-full" />
                          ) : isCurrentDay ? (
                            <div
                              className="h-full bg-primary/50 rounded-full transition-all duration-500"
                              style={{ width: `${Math.min(dailyLikes / DAILY_LIKE_GOAL, 1) * 100}%` }}
                            />
                          ) : null}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {isDone ? "Done" : isCurrentDay ? `${dailyLikes}/${DAILY_LIKE_GOAL}` : `Day ${i + 1}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
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
                  {streakComplete
                    ? "Your 3-day streak earned you a spin! Purchase extra spins to keep discovering."
                    : `Build a ${STREAK_GOAL}-day like streak to earn a free spin, or purchase extra spins.`}
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

              {!streakComplete && (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-xs font-medium text-center text-muted-foreground">Or earn a free spin</p>
                  <div className="flex items-center gap-3">
                    {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                      <div
                        key={i}
                        className={`flex-1 h-2 rounded-full ${
                          i < consecutiveDays ? "bg-primary" : "bg-muted"
                        }`}
                      />
                    ))}
                    <span className="text-xs font-medium whitespace-nowrap">{consecutiveDays}/{STREAK_GOAL}</span>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Send {DAILY_LIKE_GOAL} likes daily for {STREAK_GOAL} days in a row to earn a free spin
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
              <div data-testid="img-intent-detail-photo" className="w-full aspect-[3/4] max-h-[50vh] overflow-hidden">
                <ProfilePhoto userId={selectedProfile.userId} className="w-full h-full" />
              </div>
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
                  <div className="flex items-center gap-1.5">
                    <MessageCircle className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversation Starters</p>
                  </div>
                  <div className="space-y-2">
                    {selectedProfile.conversationStarters.map((starter, i) => (
                      <div
                        key={i}
                        className="rounded-md p-3 text-sm bg-muted/50"
                        data-testid={`text-detail-starter-${i}`}
                      >
                        <p className="italic">"{starter}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.questions && selectedProfile.questions.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ask Me</p>
                  </div>
                  <div className="space-y-2">
                    {selectedProfile.questions.map((question, i) => (
                      <div
                        key={i}
                        className="rounded-md p-3 text-sm border"
                        data-testid={`text-detail-question-${i}`}
                      >
                        <p>{question}</p>
                      </div>
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

          <div className="absolute bottom-0 left-0 right-0 bg-background/95 backdrop-blur-md border-t p-5">
            <div className="flex items-center justify-center gap-8">
              <button
                className="w-16 h-16 rounded-full flex items-center justify-center bg-muted border border-border text-2xl shadow-sm hover:scale-105 active:scale-95 transition-transform"
                onClick={closeProfile}
                data-testid="button-intent-skip"
                aria-label="Skip"
              >
                <Moon className="w-6 h-6 text-muted-foreground" />
              </button>
              <button
                className="w-16 h-16 rounded-full flex items-center justify-center bg-primary text-primary-foreground text-2xl shadow-md hover:scale-105 active:scale-95 transition-transform disabled:opacity-60"
                onClick={() => selectedProfile && wheelOpen.mutate(selectedProfile.userId)}
                disabled={wheelOpen.isPending}
                data-testid="button-intent-open"
                aria-label="Connect"
              >
                {wheelOpen.isPending
                  ? <Loader2 className="w-6 h-6 animate-spin" />
                  : <Heart className="w-6 h-6 fill-current" />
                }
              </button>
            </div>
            <p className="text-xs text-center text-muted-foreground mt-3">
              Tap ❤️ to connect · 🌙 to skip
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
