import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Zap, CheckCircle2, XCircle, Loader2, Gift, ArrowRight, Eye, Heart } from "lucide-react";
import { useCountdownSecs, useAnimatedCount, formatCountdown } from "@/lib/elevate-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "verifying" | "active" | "error";

type BoostInfo = {
  elevateType: "elevate" | "super_elevate";
  quantity: number;
  creditsAdded: number;
  expiresAt: string | null;
  durationMinutes: number;
};

type SessionStats = {
  views: number;
  matches: number;
  active: boolean;
  expiresAt: string | null;
};

// ── Live status card (standalone, no tab context needed) ──────────────────────

function LiveStatusCard({ boostInfo }: { boostInfo: BoostInfo }) {
  const isSuper = boostInfo.elevateType === "super_elevate";
  const expiresAt = boostInfo.expiresAt ? new Date(boostInfo.expiresAt) : null;
  const secs = useCountdownSecs(expiresAt);

  const { data: stats } = useQuery<SessionStats>({
    queryKey: ["/api/elevate/session-stats"],
    refetchInterval: 15_000,
    staleTime: 0,
  });

  const views = useAnimatedCount(stats?.views ?? 0);
  const matches = useAnimatedCount(stats?.matches ?? 0);

  return (
    <div
      className="rounded-2xl overflow-hidden relative w-full"
      style={isSuper
        ? {
            background: "linear-gradient(135deg, hsl(350 45% 17%), hsl(350 45% 11%))",
            border: "1px solid hsl(350 45% 32%)",
          }
        : {
            background: "hsl(350 45% 52% / 0.07)",
            border: "1px solid hsl(350 45% 52% / 0.28)",
          }
      }
      data-testid="elevate-success-live-card"
    >
      {isSuper && (
        <div
          className="absolute top-0 right-0 w-48 h-48 pointer-events-none opacity-[0.07]"
          style={{ background: "radial-gradient(circle, hsl(350 60% 70%), transparent)", transform: "translate(30%, -30%)" }}
        />
      )}

      <div className="relative p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={isSuper
                ? { background: "hsl(350 45% 52% / 0.25)", border: "1px solid hsl(350 45% 52% / 0.35)" }
                : { background: "hsl(350 45% 52% / 0.15)" }
              }
            >
              {isSuper ? <Zap className="w-4 h-4 text-primary" /> : <Sparkles className="w-4 h-4 text-primary" />}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-primary">
                {isSuper ? "Super Elevate" : "Elevate"}
              </span>
              {/* Pulsing live indicator */}
              <span className="relative inline-flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 bg-primary" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              <span className="text-xs font-medium text-primary/80">Live</span>
            </div>
          </div>

          {/* Countdown */}
          <div
            className="px-2.5 py-1 rounded-lg"
            style={isSuper
              ? { background: "hsl(350 45% 52% / 0.18)", border: "1px solid hsl(350 45% 52% / 0.25)" }
              : { background: "hsl(350 45% 52% / 0.1)" }
            }
          >
            <span className="text-sm tabular-nums font-bold text-primary">
              {secs > 0 ? formatCountdown(secs) : "—"}
            </span>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div
            className="flex flex-col items-center py-3 rounded-xl"
            style={{ background: "hsl(350 45% 52% / 0.08)", border: "1px solid hsl(350 45% 52% / 0.15)" }}
          >
            <Eye className="w-5 h-5 text-primary mb-1" />
            <span className="text-2xl font-bold tabular-nums text-primary">{views}</span>
            <span className="text-xs text-muted-foreground">profile views</span>
          </div>
          <div
            className="flex flex-col items-center py-3 rounded-xl"
            style={{ background: "hsl(350 45% 52% / 0.08)", border: "1px solid hsl(350 45% 52% / 0.15)" }}
          >
            <Heart className="w-5 h-5 text-primary mb-1" />
            <span className="text-2xl font-bold tabular-nums text-primary">{matches}</span>
            <span className="text-xs text-muted-foreground">matches</span>
          </div>
        </div>

        {/* Tagline */}
        <p className="text-xs text-center" style={{ color: "hsl(350 45% 58%)" }}>
          {isSuper
            ? "You're at the top of Discovery and the Intention Wheel right now"
            : "You're being discovered by more people right now"
          }
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ElevateSuccessPage() {
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [boostInfo, setBoostInfo] = useState<BoostInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      setErrorMsg("Missing payment session. Please try again.");
      setPhase("error");
      return;
    }

    let tries = 0;
    const maxTries = 8;
    const interval = 2000;

    const verify = async () => {
      tries++;
      try {
        const res = await apiRequest("POST", "/api/stripe/elevate-activate", { sessionId });
        const data = await res.json();

        if (res.ok && data.success) {
          setBoostInfo({
            elevateType: data.elevateType ?? "elevate",
            quantity: data.quantity ?? 1,
            creditsAdded: data.creditsAdded ?? 1,
            expiresAt: data.expiresAt ?? null,
            durationMinutes: data.durationMinutes ?? 30,
          });
          queryClient.invalidateQueries({ queryKey: ["/api/elevate/status"] });
          queryClient.invalidateQueries({ queryKey: ["/api/elevate/session-stats"] });
          setPhase("active");
          return;
        }

        if (res.status === 402 && tries < maxTries) {
          setTimeout(verify, interval);
        } else {
          setErrorMsg(data.message ?? "Payment verification failed. If you were charged, contact support.");
          setPhase("error");
        }
      } catch {
        if (tries < maxTries) {
          setTimeout(verify, interval * 1.5);
        } else {
          setErrorMsg("Network error. Please check your connection and try again.");
          setPhase("error");
        }
      }
    };

    verify();
  }, []);

  const remainingCredits = boostInfo
    ? boostInfo.creditsAdded - 1  // one was auto-activated
    : 0;
  const isSuper = boostInfo?.elevateType === "super_elevate";

  return (
    <div className="min-h-screen bg-background">
      {/* Minimal header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-2 max-w-md mx-auto">
        <div className="flex items-center gap-2">
          {isSuper
            ? <Zap className="w-5 h-5 text-primary" />
            : <Sparkles className="w-5 h-5 text-primary" />
          }
          <span className="font-serif font-semibold text-base">
            {phase === "active" ? (isSuper ? "Super Elevate" : "Elevate") : "Lulou"}
          </span>
        </div>
      </div>

      <div className="max-w-md mx-auto px-5 py-4 space-y-5">

        {/* ── Verifying ── */}
        {phase === "verifying" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">Confirming payment…</h1>
              <p className="text-sm text-muted-foreground">Verifying your purchase and activating your boost.</p>
            </div>
          </div>
        )}

        {/* ── Active boost ── */}
        {phase === "active" && boostInfo && (
          <>
            {/* Success header */}
            <div className="flex items-center gap-3 pt-2">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
                style={isSuper
                  ? { background: "linear-gradient(135deg, hsl(350 45% 20%), hsl(350 45% 14%))", border: "1px solid hsl(350 45% 35%)" }
                  : { background: "hsl(350 45% 52% / 0.12)", border: "1px solid hsl(350 45% 52% / 0.3)" }
                }
              >
                <CheckCircle2 className="w-6 h-6 text-green-400" />
              </div>
              <div>
                <h1 className="font-serif text-xl font-bold">Your boost is live!</h1>
                <p className="text-sm text-muted-foreground">
                  {boostInfo.durationMinutes} min · {isSuper ? "8×" : "3×"} visibility · Started now
                </p>
              </div>
            </div>

            {/* Live status card */}
            <LiveStatusCard boostInfo={boostInfo} />

            {/* Remaining credits */}
            {remainingCredits > 0 && (
              <div
                className="flex items-center gap-3 p-4 rounded-2xl"
                style={{ background: "hsl(350 45% 52% / 0.05)", border: "1px solid hsl(350 45% 52% / 0.18)" }}
              >
                <Gift className="w-5 h-5 text-primary shrink-0" />
                <div>
                  <p className="text-sm font-semibold">
                    {remainingCredits} more boost{remainingCredits > 1 ? "s" : ""} saved to your account
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Activate them anytime from the Elevate screen.
                  </p>
                </div>
              </div>
            )}

            {/* Continue button */}
            <button
              className="w-full py-4 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
              style={{ background: "hsl(350 45% 52%)", color: "white", boxShadow: "0 4px 16px hsl(350 45% 40% / 0.35)" }}
              onClick={() => navigate("/likes")}
              data-testid="button-elevate-continue"
            >
              Continue Exploring
              <ArrowRight className="w-5 h-5" />
            </button>

            <p className="text-center text-xs text-muted-foreground pb-6">
              Your boost keeps running while you use the app. Check the Likes screen to see real-time stats.
            </p>
          </>
        )}

        {/* ── Error ── */}
        {phase === "error" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="w-20 h-20 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
              <XCircle className="w-9 h-9 text-destructive" />
            </div>
            <div className="text-center">
              <h1 className="font-serif text-2xl font-bold mb-2">Something went wrong</h1>
              <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
            </div>
            <button
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
              onClick={() => navigate("/likes")}
              data-testid="button-elevate-error-back"
            >
              Back to app
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
