import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Heart, X, Eye, MapPin, Lock } from "lucide-react";
import { BloomFlowerIcon } from "@/components/app-layout";
import type { Profile, Interaction } from "@shared/schema";

type IncomingOpen = Interaction & { profile: Profile };

type MatchCelebration = {
  firstName: string;
  photo?: string;
};

type MatchCountData = { count: number };

function MatchOverlay({ celebration, onClose }: { celebration: MatchCelebration; onClose: () => void }) {
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");

  useEffect(() => {
    const enterTimer = setTimeout(() => setPhase("visible"), 50);
    return () => clearTimeout(enterTimer);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("exit");
    setTimeout(onClose, 500);
  }, [onClose]);

  useEffect(() => {
    const autoClose = setTimeout(handleClose, 4000);
    return () => clearTimeout(autoClose);
  }, [handleClose]);

  const isVisible = phase === "visible";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center cursor-pointer"
      onClick={handleClose}
      data-testid="overlay-match-celebration"
      style={{
        background: "radial-gradient(ellipse at center, hsl(350 45% 52% / 0.95), hsl(350 45% 35% / 0.98))",
        opacity: phase === "exit" ? 0 : 1,
        transition: "opacity 500ms ease",
      }}
    >
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full"
            style={{
              width: `${Math.random() * 8 + 4}px`,
              height: `${Math.random() * 8 + 4}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              background: "hsl(40 60% 85% / 0.4)",
              animation: `float ${3 + Math.random() * 4}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 2}s`,
            }}
          />
        ))}
      </div>

      <div
        className="flex flex-col items-center gap-6 px-8"
        style={{
          transform: isVisible ? "scale(1) translateY(0)" : "scale(0.6) translateY(30px)",
          opacity: isVisible ? 1 : 0,
          transition: "transform 700ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 500ms ease",
        }}
      >
        <BloomFlowerIcon className="w-14 h-14 text-white/80" />

        <div className="relative">
          <Avatar
            className="w-28 h-28 border-4 border-white/30"
            style={{
              transform: isVisible ? "scale(1)" : "scale(0)",
              transition: "transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1) 200ms",
            }}
          >
            <AvatarImage src={celebration.photo} alt={celebration.firstName} />
            <AvatarFallback className="bg-white/20 text-white text-3xl font-semibold">
              {celebration.firstName[0]}
            </AvatarFallback>
          </Avatar>
          <div
            className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center"
            style={{
              transform: isVisible ? "scale(1)" : "scale(0)",
              transition: "transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1) 500ms",
            }}
          >
            <Heart className="w-5 h-5 text-white fill-white" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h1
            className="font-serif text-4xl font-bold text-white tracking-wide"
            data-testid="text-blooming-amazing"
            style={{
              transform: isVisible ? "translateY(0)" : "translateY(20px)",
              opacity: isVisible ? 1 : 0,
              transition: "transform 600ms ease 300ms, opacity 500ms ease 300ms",
              textShadow: "0 2px 20px rgba(0,0,0,0.2)",
            }}
          >
            Blooming Amazing
          </h1>
          <p
            className="text-lg text-white/80 font-medium tracking-widest uppercase"
            data-testid="text-match-made"
            style={{
              transform: isVisible ? "translateY(0)" : "translateY(15px)",
              opacity: isVisible ? 1 : 0,
              transition: "transform 600ms ease 500ms, opacity 500ms ease 500ms",
              letterSpacing: "0.2em",
            }}
          >
            match made
          </p>
        </div>

        <p
          className="text-white/60 text-sm mt-2"
          style={{
            opacity: isVisible ? 1 : 0,
            transition: "opacity 600ms ease 700ms",
          }}
        >
          You and {celebration.firstName} are connected
        </p>

        <p
          className="text-white/40 text-xs"
          style={{
            opacity: isVisible ? 1 : 0,
            transition: "opacity 600ms ease 900ms",
          }}
        >
          Tap anywhere to continue
        </p>
      </div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0) scale(1); opacity: 0.4; }
          50% { transform: translateY(-30px) scale(1.5); opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

function LikeCard({ open, onMatch, onConnectionFull }: { open: IncomingOpen; onMatch: (c: MatchCelebration) => void; onConnectionFull: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const respond = useMutation({
    mutationFn: async (type: "open" | "close") => {
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId: open.fromUserId,
        type,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/match-count"] });
      if (data.matched) {
        onMatch({
          firstName: open.profile.firstName,
          photo: open.profile.photos?.[0],
        });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: "Passed", description: `You passed on ${open.profile.firstName}.` });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card className="p-4" data-testid={`card-liked-${open.fromUserId}`}>
      <div className="flex items-start gap-3">
        <Avatar className="w-14 h-14 flex-shrink-0">
          <AvatarImage src={open.profile.photos?.[0]} alt={open.profile.firstName} />
          <AvatarFallback className="bg-primary/10 text-primary font-semibold text-lg">
            {open.profile.firstName?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm" data-testid={`text-liked-name-${open.fromUserId}`}>
              {open.profile.firstName}, {open.profile.age}
            </h3>
            {open.profile.photoVerified && (
              <Badge variant="secondary" className="text-xs">Verified</Badge>
            )}
          </div>
          {open.profile.location && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="w-3 h-3" />
              <span>{open.profile.location}</span>
            </div>
          )}
          <div className="flex items-center gap-1 flex-wrap">
            {open.profile.signals?.slice(0, 2).map((signal: string) => (
              <Badge key={signal} variant="outline" className="text-xs">{signal}</Badge>
            ))}
            {open.profile.datingIntent && (
              <Badge variant="secondary" className="text-xs">{open.profile.datingIntent}</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => respond.mutate("close")}
            disabled={respond.isPending}
            data-testid={`button-pass-${open.fromUserId}`}
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </Button>
          <Button
            size="icon"
            onClick={() => respond.mutate("open")}
            disabled={respond.isPending}
            data-testid={`button-open-back-${open.fromUserId}`}
          >
            <Heart className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function LikesPage() {
  const [celebration, setCelebration] = useState<MatchCelebration | null>(null);
  const [showFullMessage, setShowFullMessage] = useState(false);

  const { data: likes, isLoading } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: 15000,
  });

  const { data: matchCountData } = useQuery<MatchCountData>({
    queryKey: ["/api/match-count"],
  });

  const connectionsFull = (matchCountData?.count ?? 0) >= 8;

  useEffect(() => {
    if (!connectionsFull) setShowFullMessage(false);
  }, [connectionsFull]);

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-4 max-w-lg mx-auto w-full">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const likesList = likes || [];

  if (likesList.length === 0 && !celebration) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Eye className="w-8 h-8 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-likes">No likes yet</h2>
          <p className="text-muted-foreground text-sm">
            When someone opens your profile, they'll show up here. Keep your profile fresh to attract more interest.
          </p>
        </div>
        {celebration && <MatchOverlay celebration={celebration} onClose={() => setCelebration(null)} />}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-lg mx-auto w-full">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-primary" />
            <h1 className="font-serif text-2xl font-bold" data-testid="text-likes-title">Who Liked You</h1>
          </div>
          <Badge variant="secondary" className="text-xs" data-testid="badge-likes-count">
            {likesList.length}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          These people opened your profile. Open them back to connect, or pass.
        </p>
      </div>

      {(connectionsFull || showFullMessage) && (
        <div
          className="flex flex-col items-center gap-3 py-6 px-4 text-center"
          data-testid="banner-connections-full"
        >
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <p className="font-serif text-base font-semibold text-foreground">
            Connections room is full
          </p>
          <p className="text-sm text-muted-foreground">
            Close a connection to free up space
          </p>
        </div>
      )}

      <div className="space-y-3">
        {likesList.map(open => (
          <LikeCard key={open.id} open={open} onMatch={setCelebration} onConnectionFull={() => setShowFullMessage(true)} />
        ))}
      </div>

      {celebration && <MatchOverlay celebration={celebration} onClose={() => setCelebration(null)} />}
    </div>
  );
}
