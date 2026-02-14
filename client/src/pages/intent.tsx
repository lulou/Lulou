import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flower2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { Profile } from "@shared/schema";

const ITEM_WIDTH = 130;
const ITEM_HEIGHT = 170;

export default function IntentPage() {
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
  const [angle, setAngle] = useState(0);

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
    if (isSpinning) return;
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
    const totalDx = e.clientX - startX.current;
    const angleDelta = (totalDx / 3);
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
      }
    };

    cancelAnimationFrame(animFrame.current);
    animFrame.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    return () => cancelAnimationFrame(animFrame.current);
  }, []);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Flower2 className="w-8 h-8 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <Flower2 className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">Unable to load profiles right now</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <Flower2 className="w-10 h-10 text-primary mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">No profiles to show yet</p>
        </div>
      </div>
    );
  }

  const focusedIndex = getFocusedIndex(angle);
  const selectedProfile = selectedIndex !== null ? items[selectedIndex] : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="intent-page">
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
              transform: `translateX(-50%) translateY(-50%) rotateX(25deg) rotateY(${-angle}deg)`,
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
              const isFront = cosVal > 0.7;
              const depthFactor = (cosVal + 1) / 2;
              const shadowOpacity = 1 - depthFactor;
              const cardScale = 0.7 + depthFactor * 0.3;

              return (
                <div
                  key={profile.id}
                  className={`absolute left-0 top-0 rounded-md overflow-hidden ${
                    isSelected
                      ? "ring-2 ring-primary"
                      : ""
                  }`}
                  style={{
                    width: ITEM_WIDTH,
                    height: ITEM_HEIGHT,
                    transform: `rotateY(${itemAngle}deg) translateZ(${radius}px) scale(${cardScale})`,
                    opacity: 0.4 + depthFactor * 0.6,
                    filter: `brightness(${0.4 + depthFactor * 0.6})`,
                    zIndex: Math.round(depthFactor * 100),
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
                      <Flower2 className="w-8 h-8 text-muted-foreground" />
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

        {selectedProfile && !isSpinning && (
          <Card
            className="mx-5 p-5 space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500 mb-4"
            data-testid="intent-result"
          >
            <div className="flex items-center gap-3 flex-wrap">
              {selectedProfile.photos?.[0] && (
                <img
                  src={selectedProfile.photos[0]}
                  alt={selectedProfile.firstName}
                  className="w-14 h-14 rounded-full object-cover ring-2 ring-primary/20"
                  data-testid="img-intent-result"
                />
              )}
              <div>
                <h3 className="font-serif text-lg font-semibold" data-testid="text-intent-result-name">
                  {selectedProfile.firstName}{selectedProfile.age ? `, ${selectedProfile.age}` : ""}
                </h3>
                {selectedProfile.location && (
                  <p className="text-xs text-muted-foreground" data-testid="text-intent-result-location">
                    {selectedProfile.location}
                  </p>
                )}
              </div>
            </div>

            {selectedProfile.datingIntent && (
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="secondary" data-testid="text-intent-result-intent">
                  {selectedProfile.datingIntent}
                </Badge>
              </div>
            )}

            {selectedProfile.signals && selectedProfile.signals.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedProfile.signals.map((signal, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    data-testid={`text-intent-signal-${i}`}
                  >
                    {signal}
                  </Badge>
                ))}
              </div>
            )}

            {selectedProfile.conversationStarters && selectedProfile.conversationStarters.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Conversation Starter</p>
                <p className="text-sm leading-relaxed" data-testid="text-intent-starter">
                  {selectedProfile.conversationStarters[0]}
                </p>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
