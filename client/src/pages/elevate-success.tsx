import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { getAuthHeaders, queryClient, API_BASE } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Zap, CheckCircle2, XCircle, Loader2, Gift, ArrowRight, Eye, Heart } from "lucide-react";
import { useCountdownSecs, useAnimatedCount, formatCountdown } from "@/lib/elevate-utils";
import { useLanguageContext } from "@/contexts/language-context";

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
  const { t, isRTL } = useLanguageContext();
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
          className="absolute top-0 end-0 w-48 h-48 pointer-events-none opacity-[0.07]"
          style={{ background: "radial-gradient(circle, hsl(350 60% 70%), transparent)", transform: `translate(${isRTL ? "-30%" : "30%"}, -30%)` }}
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
                {isSuper ? t("super_elevate_label") : t("elevate_label")}
              </span>
              {/* Pulsing live indicator */}
              <span className="relative inline-flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 bg-primary" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              <span className="text-xs font-medium text-primary/80">{t("live_label")}</span>
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
            <span className="text-xs text-muted-foreground">{t("profile_views_label")}</span>
          </div>
          <div
            className="flex flex-col items-center py-3 rounded-xl"
            style={{ background: "hsl(350 45% 52% / 0.08)", border: "1px solid hsl(350 45% 52% / 0.15)" }}
          >
            <Heart className="w-5 h-5 text-primary mb-1" />
            <span className="text-2xl font-bold tabular-nums text-primary">{matches}</span>
            <span className="text-xs text-muted-foreground">{t("match")}</span>
          </div>
        </div>

        {/* Tagline */}
        <p className="text-xs text-center" style={{ color: "hsl(350 45% 58%)" }}>
          {isSuper ? t("top_of_discovery") : t("being_discovered")}
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ElevateSuccessPage() {
  const { t } = useLanguageContext();
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [boostInfo, setBoostInfo] = useState<BoostInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const packParam = params.get("pack") ?? "elevate-1";

    if (!sessionId) {
      setErrorMsg(t("missing_session"));
      setPhase("error");
      return;
    }

    const POLL_TRIES    = 8;
    const POLL_MS       = 2000;
    const MAX_FALLBACK  = 5;
    let pollTries       = 0;
    let fallbackTries   = 0;

    const showActive = (data: any) => {
      setBoostInfo({
        elevateType:    data.elevateType    ?? "elevate",
        quantity:       data.quantity       ?? 1,
        creditsAdded:   data.creditsAdded   ?? 1,
        expiresAt:      data.expiresAt      ?? null,
        durationMinutes: data.durationMinutes ?? 30,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/elevate/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/elevate/session-stats"] });
      setPhase("active");
    };

    // ── Phase 2: elevate-activate fallback (Stripe API verification) ─────────
    const activateFallback = async () => {
      fallbackTries++;
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`${API_BASE}/api/stripe/elevate-activate`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          credentials: "include",
        });

        if (res.status === 402) {
          if (fallbackTries < MAX_FALLBACK) setTimeout(activateFallback, POLL_MS);
          else { setErrorMsg(t("payment_verify_failed")); setPhase("error"); }
          return;
        }

        if (res.status === 403) {
          let msg = "Please return to Lulou and sign in with the same account used to start the purchase.";
          try { const d = await res.json(); if (d.message) msg = d.message; } catch {}
          setErrorMsg(msg);
          setPhase("error");
          return;
        }

        let data: any = {};
        try { data = await res.json(); } catch {}

        if (res.ok && data.success) { showActive(data); return; }

        if (fallbackTries < MAX_FALLBACK) setTimeout(activateFallback, POLL_MS * 1.5);
        else { setErrorMsg(data.message ?? t("payment_verify_failed")); setPhase("error"); }
      } catch {
        if (fallbackTries < MAX_FALLBACK) setTimeout(activateFallback, POLL_MS * 1.5);
        else { setErrorMsg(t("network_error_retry")); setPhase("error"); }
      }
    };

    // ── Phase 1: poll purchase-status (webhook confirmation path) ────────────
    const pollStatus = async () => {
      pollTries++;
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(
          `${API_BASE}/api/stripe/purchase-status?session_id=${encodeURIComponent(sessionId)}`,
          { headers: authHeaders, credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          if (data.granted) {
            // Webhook confirmed — fetch live elevate status for the success card
            try {
              const statusRes = await fetch(`${API_BASE}/api/elevate/status`, {
                headers: authHeaders, credentials: "include",
              });
              const status = statusRes.ok ? await statusRes.json() : {};
              const isSuper = packParam === "super-elevate";
              showActive({
                elevateType:     isSuper ? "super_elevate" : "elevate",
                quantity:        1,
                creditsAdded:    1,
                expiresAt:       status.expiresAt ?? null,
                durationMinutes: isSuper ? 60 : 30,
              });
            } catch {
              // status fetch failed — show a generic success
              showActive({ elevateType: "elevate", quantity: 1, creditsAdded: 1, expiresAt: null, durationMinutes: 30 });
            }
            return;
          }
        }
      } catch { /* network error — keep polling */ }

      if (pollTries < POLL_TRIES) setTimeout(pollStatus, POLL_MS);
      else activateFallback();
    };

    pollStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
            {phase === "active" ? (isSuper ? t("super_elevate_label") : t("elevate_label")) : "Lulou"}
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
              <h1 className="font-serif text-2xl font-bold mb-2">{t("confirming_payment")}</h1>
              <p className="text-sm text-muted-foreground">{t("verifying_boost_purchase")}</p>
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
                <h1 className="font-serif text-xl font-bold">{t("boost_is_live")}</h1>
                <p className="text-sm text-muted-foreground">
                  {t("boost_started_now").replace("{dur}", String(boostInfo.durationMinutes)).replace("{mult}", isSuper ? "8×" : "3×")}
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
                    {remainingCredits > 1
                      ? t("remaining_boosts_many").replace("{n}", String(remainingCredits))
                      : t("remaining_boosts_one").replace("{n}", String(remainingCredits))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("activate_anytime")}
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
              {t("continue_exploring")}
              <ArrowRight className="w-5 h-5" />
            </button>

            <p className="text-center text-xs text-muted-foreground pb-6">
              {t("boost_running_note")}
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
              <h1 className="font-serif text-2xl font-bold mb-2">{t("something_went_wrong")}</h1>
              <p className="text-sm text-muted-foreground mb-6">{errorMsg}</p>
            </div>
            <button
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm"
              onClick={() => navigate("/likes")}
              data-testid="button-elevate-error-back"
            >
              {t("back_to_app")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
