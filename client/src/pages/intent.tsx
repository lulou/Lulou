import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCw, Heart, X, MapPin, Send, MessageCircle } from "lucide-react";
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

export default function IntentPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profiles, isLoading, isError } = useQuery<Profile[]>({
    queryKey: ["/api/popular"],
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
  const [angle, setAngle] = useState(0);
  const [message, setMessage] = useState("");

  const items = profiles || [];
  const count = items.length;
  const angleStep = count > 0 ? 360 / count : 0;
  const radius = count > 4 ? Math.max(200, count * 28) : 180;

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

  const spinWheel = () => {
    if (isSpinning || count === 0) return;
    setIsSpinning(true);
    setSelectedIndex(null);
    setDispersed(false);
    setShowProfile(false);
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

        setTimeout(() => setDispersed(true), 300);
        setTimeout(() => setShowProfile(true), 700);
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
  };

  const interact = useMutation({
    mutationFn: async (toUserId: string) => {
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId,
        type: "open",
      });
      return res.json();
    },
    onSuccess: (data) => {
      const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;
      if (data?.matched) {
        toast({
          title: "It's mutual",
          description: `You and ${selectedProfile?.firstName} both opened up.`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      } else {
        toast({
          title: "Heart sent",
          description: `You opened up to ${selectedProfile?.firstName}.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/discover"] });
      closeProfile();
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" data-testid="intent-page">
      <div className="px-5 pt-6 pb-2">
        <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
          Intention Wheel
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Spin to discover someone special
        </p>
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

        {!dispersed && (
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
            <div className="flex items-center gap-2">
              <Input
                placeholder={`Message ${selectedProfile.firstName}...`}
                value={message}
                onChange={e => setMessage(e.target.value.slice(0, 500))}
                onKeyDown={e => {
                  if (e.key === "Enter" && message.trim()) {
                    toast({
                      title: "Message ready",
                      description: `Your message will be sent when you match with ${selectedProfile.firstName}.`,
                    });
                    interact.mutate(selectedProfile.userId);
                  }
                }}
                className="flex-1"
                data-testid="input-intent-message"
              />
              <Button
                size="icon"
                disabled={interact.isPending}
                onClick={() => {
                  if (message.trim()) {
                    toast({
                      title: "Message ready",
                      description: `Your message will be sent when you match with ${selectedProfile.firstName}.`,
                    });
                  }
                  interact.mutate(selectedProfile.userId);
                }}
                data-testid="button-intent-open"
              >
                {message.trim() ? <Send className="w-4 h-4" /> : <Heart className="w-4 h-4" />}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {message.trim() ? "Send with a message" : "Open your heart"}
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
