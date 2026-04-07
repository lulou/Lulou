import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useTabActive } from "@/App";
import { Heart, X, Eye, MapPin, Lock, Sparkles, Zap, ChevronRight, Check, Timer } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import type { Profile, Interaction } from "@shared/schema";

type IncomingOpen = Interaction & { profile: Profile };
type MatchCelebration = { firstName: string; photo?: string };
type MatchCountData = { count: number };
type ElevateStatus = { type: string | null; expiresAt: string | null; active: boolean };

function ElevateBanner({ status }: { status: ElevateStatus }) {
  const isSuper = status.type === "super_elevate";
  const expiresAt = status.expiresAt ? new Date(status.expiresAt) : null;
  const remaining = expiresAt ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000)) : 0;

  return (
    <div
      className="rounded-2xl px-4 py-3 flex items-center gap-3"
      style={isSuper
        ? { background: "linear-gradient(135deg, hsl(350 45% 18%), hsl(350 45% 12%))", border: "1px solid hsl(350 45% 32%)" }
        : { background: "hsl(350 45% 52% / 0.08)", border: "1px solid hsl(350 45% 52% / 0.25)" }
      }
      data-testid="banner-elevate-active"
    >
      <div className={[
        "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
        isSuper ? "bg-primary/20" : "bg-primary/15",
      ].join(" ")}>
        {isSuper ? <Zap className="w-4 h-4 text-primary" /> : <Sparkles className="w-4 h-4 text-primary" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className={["text-xs font-semibold", isSuper ? "text-primary" : "text-primary"].join(" ")}>
          {isSuper ? "Super Elevate active" : "Elevate active"}
        </p>
        <p className="text-xs text-muted-foreground">
          {remaining > 0 ? `~${remaining} min remaining — you're being seen more` : "Expires soon"}
        </p>
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
        <Timer className="w-3 h-3" />
        <span>{remaining}m</span>
      </div>
    </div>
  );
}

// ─── Elevate Modal ────────────────────────────────────────────────────────────

const ELEVATE_PACKAGES = [
  {
    id: "elevate-1",
    label: "1 Elevate",
    price: "$9.99",
    perBoost: "$9.99 per boost",
    description: "One visibility boost in Discovery & the Intention Wheel",
    badge: null,
    highlight: false,
  },
  {
    id: "elevate-3",
    label: "3 Elevates",
    price: "$26.99",
    perBoost: "$9.00 per boost",
    description: "Three boosts — great for staying consistently visible",
    badge: "Most Popular",
    highlight: true,
  },
  {
    id: "elevate-5",
    label: "5 Elevates",
    price: "$39.99",
    perBoost: "$8.00 per boost",
    description: "Five boosts at the lowest price — maximum reach",
    badge: "Best Value",
    highlight: true,
  },
] as const;

const SUPER_ELEVATE = {
  id: "super-elevate",
  label: "Super Elevate",
  price: "$34.99",
  description: "Priority placement above all users for a full 24 hours",
} as const;

function ElevateModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  const handlePurchase = async (packageId: string, label: string) => {
    const elevateType = packageId === "super-elevate" ? "super_elevate" : "elevate";
    setPurchasing(true);
    setSelected(packageId);
    try {
      const res = await apiRequest("POST", "/api/elevate", { type: elevateType });
      const data = await res.json();
      if (!data.success) throw new Error("Activation failed");
      const durationLabel = data.durationMinutes === 60 ? "60 minutes" : "30 minutes";
      queryClient.invalidateQueries({ queryKey: ["/api/elevate/status"] });
      toast({
        title: `${label} is now live`,
        description: `Your profile has boosted visibility for ${durationLabel}. More people will find you.`,
      });
      onClose();
    } catch {
      toast({
        title: "Something went wrong",
        description: "Couldn't activate your boost. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPurchasing(false);
      setSelected(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="modal-elevate"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md mx-auto bg-background rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">
        <div
          className="h-1.5 w-12 bg-border rounded-full mx-auto mt-3 sm:hidden"
          aria-hidden
        />

        <div className="px-6 pt-5 pb-2">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="font-serif text-xl font-bold">Elevate Your Profile</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Boost your visibility in Discovery and the Intention Wheel. More eyes on your profile, faster connections.
          </p>
        </div>

        <div className="px-6 pb-2 pt-4 space-y-2.5">
          {ELEVATE_PACKAGES.map(pkg => (
            <button
              key={pkg.id}
              className={[
                "w-full rounded-2xl border text-left transition-all relative overflow-hidden",
                pkg.highlight
                  ? "border-primary/60 bg-primary/5 shadow-sm hover:bg-primary/8"
                  : "border-border bg-card hover:border-primary/30 hover:bg-muted/40",
                selected === pkg.id && purchasing ? "opacity-70" : "",
              ].join(" ")}
              onClick={() => handlePurchase(pkg.id, pkg.label)}
              disabled={purchasing}
              data-testid={`button-elevate-${pkg.id}`}
            >
              {pkg.badge && (
                <span
                  className={[
                    "absolute top-3.5 right-3.5 text-xs font-semibold px-2.5 py-0.5 rounded-full",
                    pkg.badge === "Most Popular"
                      ? "bg-primary text-primary-foreground"
                      : "bg-foreground text-background",
                  ].join(" ")}
                  data-testid={`badge-elevate-${pkg.id}`}
                >
                  {pkg.badge}
                </span>
              )}
              <div className="p-4">
                <div className="flex items-center gap-3 pr-28">
                  <div className={[
                    "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                    pkg.highlight ? "bg-primary/15" : "bg-muted",
                  ].join(" ")}>
                    {selected === pkg.id && purchasing
                      ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      : <Sparkles className={["w-3.5 h-3.5", pkg.highlight ? "text-primary" : "text-muted-foreground"].join(" ")} />
                    }
                  </div>
                  <p className={["font-semibold text-sm", pkg.highlight ? "text-primary" : "text-foreground"].join(" ")}>
                    {pkg.label}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 ml-11">{pkg.description}</p>
                <div className="flex items-baseline gap-2 mt-2 ml-11">
                  <span className={["text-xl font-bold", pkg.highlight ? "text-primary" : "text-foreground"].join(" ")}>
                    {pkg.price}
                  </span>
                  <span className="text-xs text-muted-foreground">{pkg.perBoost}</span>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="px-6 pb-2 pt-3">
          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-background px-3 text-muted-foreground font-medium tracking-widest uppercase">
                Super
              </span>
            </div>
          </div>
        </div>

        <div className="px-6 pb-6">
          <button
            className="w-full rounded-2xl text-left transition-all disabled:opacity-70 overflow-hidden relative"
            style={{
              background: "linear-gradient(135deg, hsl(350 45% 20%), hsl(350 45% 14%))",
              border: "1px solid hsl(350 45% 35%)",
              boxShadow: "0 4px 24px hsl(350 45% 30% / 0.25), inset 0 1px 0 hsl(350 45% 50% / 0.15)",
            }}
            onClick={() => handlePurchase(SUPER_ELEVATE.id, SUPER_ELEVATE.label)}
            disabled={purchasing}
            data-testid="button-super-elevate"
          >
            <div className="absolute top-0 right-0 w-40 h-40 rounded-full opacity-10 pointer-events-none"
              style={{ background: "radial-gradient(circle, hsl(350 45% 70%), transparent)", transform: "translate(30%, -30%)" }}
            />
            <div className="p-5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: "hsl(350 45% 52% / 0.25)", border: "1px solid hsl(350 45% 52% / 0.4)" }}>
                  {selected === SUPER_ELEVATE.id && purchasing
                    ? <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    : <Zap className="w-4 h-4 text-primary" />
                  }
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <p className="font-serif font-bold text-base text-primary">{SUPER_ELEVATE.label}</p>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-primary"
                      style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}>
                      24 hours
                    </span>
                  </div>
                  <p className="text-xs mt-1" style={{ color: "hsl(350 20% 70%)" }}>{SUPER_ELEVATE.description}</p>
                  <ul className="mt-3 space-y-1.5">
                    {[
                      "Maximum visibility across all of Discovery",
                      "Top placement in the Intention Wheel",
                      "Priority above every other profile",
                    ].map(feat => (
                      <li key={feat} className="flex items-center gap-2 text-xs" style={{ color: "hsl(350 20% 65%)" }}>
                        <Check className="w-3 h-3 text-primary shrink-0" />
                        {feat}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="text-2xl font-bold text-primary mt-4 ml-12">{SUPER_ELEVATE.price}</p>
            </div>
          </button>

          <p className="text-center text-xs text-muted-foreground mt-4 leading-relaxed">
            Purchases are non-refundable. Elevates expire after 7 days if unused.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Match Overlay ─────────────────────────────────────────────────────────────

function MatchOverlay({ celebration, onClose }: { celebration: MatchCelebration; onClose: () => void }) {
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");

  useEffect(() => {
    const t = setTimeout(() => setPhase("visible"), 50);
    return () => clearTimeout(t);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("exit");
    setTimeout(onClose, 500);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(handleClose, 4000);
    return () => clearTimeout(t);
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
        <LulouFlowerIcon className="w-14 h-14 text-white/80" />
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
            Simply Amazing
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
          style={{ opacity: isVisible ? 1 : 0, transition: "opacity 600ms ease 700ms" }}
        >
          You and {celebration.firstName} are connected
        </p>
        <p
          className="text-white/40 text-xs"
          style={{ opacity: isVisible ? 1 : 0, transition: "opacity 600ms ease 900ms" }}
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

// ─── Like Card ─────────────────────────────────────────────────────────────────

function LikeCard({ open, onMatch, onConnectionFull }: { open: IncomingOpen; onMatch: (c: MatchCelebration) => void; onConnectionFull: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const respond = useMutation({
    mutationFn: async (type: "open" | "close") => {
      try {
        const res = await apiRequest("POST", "/api/interactions", { toUserId: open.fromUserId, type });
        return res.json();
      } catch (err: any) {
        toast({
          title: type === "open" ? "Couldn't send like" : "Couldn't close",
          description: err?.message || "Something went wrong. Try again.",
          variant: "destructive",
        });
        return { skipped: true };
      }
    },
    onSuccess: (data: any) => {
      if (data?.skipped) return;
      queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/match-count"] });
      if (data.matched) {
        onMatch({ firstName: open.profile.firstName, photo: open.profile.photos?.[0] });
      } else if (data.connectionLimitReached) {
        onConnectionFull();
      } else {
        toast({ title: "Passed", description: `You passed on ${open.profile.firstName}.` });
      }
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

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function LikesPage() {
  const [celebration, setCelebration] = useState<MatchCelebration | null>(null);
  const [showFullMessage, setShowFullMessage] = useState(false);
  const [showElevate, setShowElevate] = useState(false);
  const isActive = useTabActive();

  const { data: likes, isLoading } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: isActive ? 15000 : false,
  });

  const { data: matchCountData } = useQuery<MatchCountData>({
    queryKey: ["/api/match-count"],
  });

  const { data: elevateStatus } = useQuery<ElevateStatus>({
    queryKey: ["/api/elevate/status"],
    refetchInterval: isActive ? 60000 : false,
  });

  const connectionsFull = (matchCountData?.count ?? 0) >= 8;
  const elevateActive = elevateStatus?.active === true;

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
      <>
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-4 max-w-xs mx-auto w-full">
          {elevateActive && elevateStatus && (
            <div className="w-full">
              <ElevateBanner status={elevateStatus} />
            </div>
          )}

          <div className="text-center space-y-5 w-full">
            <div className="w-20 h-20 rounded-full bg-primary/8 border border-primary/15 flex items-center justify-center mx-auto">
              <Eye className="w-9 h-9 text-primary/60" />
            </div>

            <div className="space-y-2">
              <h2 className="font-serif text-2xl font-bold" data-testid="text-no-likes">
                No likes yet
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Elevate your profile to be seen by more people faster
              </p>
            </div>

            {!elevateActive && (
              <button
                className="w-full rounded-xl bg-primary text-primary-foreground px-5 py-3.5 font-semibold text-sm flex items-center justify-center gap-2 shadow-md hover:brightness-105 active:scale-95 transition-all"
                onClick={() => setShowElevate(true)}
                data-testid="button-elevate-cta"
              >
                <Sparkles className="w-4 h-4" />
                Elevate Your Profile
                <ChevronRight className="w-4 h-4 ml-auto opacity-70" />
              </button>
            )}

            <p className="text-xs text-muted-foreground">
              When someone opens your profile, they'll appear here.
            </p>
          </div>
        </div>

        {showElevate && <ElevateModal onClose={() => setShowElevate(false)} />}
      </>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-lg mx-auto w-full">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-primary" />
              <h1 className="font-serif text-2xl font-bold" data-testid="text-likes-title">Who Liked You</h1>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs" data-testid="badge-likes-count">
                {likesList.length}
              </Badge>
              {!elevateActive && (
                <button
                  className="flex items-center gap-1.5 text-xs font-medium text-primary border border-primary/25 bg-primary/5 px-3 py-1.5 rounded-full hover:bg-primary/10 transition-colors"
                  onClick={() => setShowElevate(true)}
                  data-testid="button-elevate-header"
                >
                  <Sparkles className="w-3 h-3" />
                  Elevate
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            These people opened your profile. Open them back to connect, or pass.
          </p>
        </div>

        {elevateActive && elevateStatus && (
          <ElevateBanner status={elevateStatus} />
        )}

        {(connectionsFull || showFullMessage) && (
          <div
            className="flex flex-col items-center gap-3 py-6 px-4 text-center"
            data-testid="banner-connections-full"
          >
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <p className="font-serif text-base font-semibold text-foreground">Connections room is full</p>
            <p className="text-sm text-muted-foreground">Close a connection to free up space</p>
          </div>
        )}

        <div className="space-y-3">
          {likesList.map(open => (
            <LikeCard key={open.id} open={open} onMatch={setCelebration} onConnectionFull={() => setShowFullMessage(true)} />
          ))}
        </div>
      </div>

      {celebration && <MatchOverlay celebration={celebration} onClose={() => setCelebration(null)} />}
      {showElevate && <ElevateModal onClose={() => setShowElevate(false)} />}
    </>
  );
}
