import { type ElementType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, Zap, Eye, Heart } from "lucide-react";
import { useTabActive } from "@/hooks/use-tab-active";
import { useCountdownSecs, useAnimatedCount, formatCountdown } from "@/lib/elevate-utils";
import { useLanguageContext } from "@/contexts/language-context";

// Inject shimmer + glow keyframes synchronously at module load so they are
// guaranteed to exist before any ElevateStatusCard render.  Doing it in a
// useEffect created a one-frame window where Safari/WebKit tried to start an
// animation whose @keyframes hadn't been parsed yet — crashing the page.
if (typeof document !== "undefined") {
  const _kfId = "elevate-shimmer-style";
  if (!document.getElementById(_kfId)) {
    const _s = document.createElement("style");
    _s.id = _kfId;
    _s.textContent = `
      @keyframes elevate-shimmer {
        0%   { background-position: -200% center; }
        100% { background-position: 200% center; }
      }
      .elevate-shimmer-text {
        background: linear-gradient(
          90deg,
          hsl(350 45% 62%) 0%,
          hsl(350 55% 80%) 40%,
          hsl(350 45% 62%) 60%,
          hsl(350 55% 75%) 100%
        );
        background-size: 200% auto;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: elevate-shimmer 3s linear infinite;
      }
      .super-shimmer-text {
        background: linear-gradient(
          90deg,
          hsl(350 45% 72%) 0%,
          hsl(30 80% 85%) 35%,
          hsl(350 45% 72%) 60%,
          hsl(30 60% 80%) 100%
        );
        background-size: 200% auto;
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: elevate-shimmer 2.4s linear infinite;
      }
      @keyframes elevate-glow-pulse {
        0%, 100% { box-shadow: 0 0 0 0 hsl(350 45% 52% / 0); }
        50%       { box-shadow: 0 0 20px 4px hsl(350 45% 52% / 0.18); }
      }
      @keyframes super-glow-pulse {
        0%, 100% { box-shadow: 0 4px 24px hsl(350 45% 30% / 0.3), 0 0 0 0 hsl(350 45% 52% / 0); }
        50%       { box-shadow: 0 4px 32px hsl(350 45% 30% / 0.45), 0 0 24px 6px hsl(350 45% 52% / 0.22); }
      }
    `;
    document.head.appendChild(_s);
  }
}

type SessionStats = {
  views: number;
  matches: number;
  active: boolean;
  expiresAt: string | null;
  startedAt: string | null;
};

// ── Pulsing dot ───────────────────────────────────────────────────────────────

function PulseDot({ isSuper }: { isSuper: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
        style={{ background: isSuper ? "hsl(350 45% 62%)" : "hsl(350 45% 52%)" }}
      />
      <span
        className="relative inline-flex rounded-full h-2 w-2"
        style={{ background: isSuper ? "hsl(350 45% 65%)" : "hsl(350 45% 55%)" }}
      />
    </span>
  );
}

// ── Stat chip ─────────────────────────────────────────────────────────────────

function StatChip({
  icon: Icon,
  value,
  label,
  isSuper,
}: {
  icon: ElementType;
  value: number;
  label: string;
  isSuper: boolean;
}) {
  const displayed = useAnimatedCount(value);
  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl"
      style={isSuper
        ? { background: "hsl(350 45% 52% / 0.15)", border: "1px solid hsl(350 45% 52% / 0.2)" }
        : { background: "hsl(350 45% 52% / 0.08)", border: "1px solid hsl(350 45% 52% / 0.15)" }
      }
    >
      <Icon className="w-3.5 h-3.5 text-primary shrink-0" />
      <span className="font-bold text-sm tabular-nums text-primary">{displayed}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ElevateStatusCard({
  elevateType,
  expiresAt: expiresAtStr,
}: {
  elevateType: string;
  expiresAt: string | null;
}) {
  const { t, isRTL } = useLanguageContext();
  const isSuper = elevateType === "super_elevate";
  const isActive = useTabActive();
  const expiresAt = expiresAtStr ? new Date(expiresAtStr) : null;
  const secs = useCountdownSecs(expiresAt);

  const { data: stats } = useQuery<SessionStats>({
    queryKey: ["/api/elevate/session-stats"],
    refetchInterval: isActive ? 30_000 : false,
    staleTime: 0,
  });

  const views = stats?.views ?? 0;
  const matches = stats?.matches ?? 0;

  return (
    <div
      data-testid="elevate-status-card"
      className="rounded-2xl overflow-hidden relative"
      style={isSuper
        ? {
            background: "linear-gradient(135deg, hsl(350 45% 17%), hsl(350 45% 11%))",
            border: "1px solid hsl(350 45% 32%)",
            animation: "super-glow-pulse 3s ease-in-out infinite",
          }
        : {
            background: "hsl(350 45% 52% / 0.07)",
            border: "1px solid hsl(350 45% 52% / 0.28)",
            animation: "elevate-glow-pulse 3.5s ease-in-out infinite",
          }
      }
    >
      {/* Decorative radial for Super */}
      {isSuper && (
        <div
          className="absolute top-0 end-0 w-48 h-48 pointer-events-none opacity-[0.07]"
          style={{
            background: "radial-gradient(circle, hsl(350 60% 70%), transparent)",
            transform: `translate(${isRTL ? "-30%" : "30%"}, -30%)`,
          }}
        />
      )}

      <div className="relative p-4">
        {/* Header row */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
              style={isSuper
                ? { background: "hsl(350 45% 52% / 0.25)", border: "1px solid hsl(350 45% 52% / 0.35)" }
                : { background: "hsl(350 45% 52% / 0.15)" }
              }
            >
              {isSuper
                ? <Zap className="w-3.5 h-3.5 text-primary" />
                : <Sparkles className="w-3.5 h-3.5 text-primary" />
              }
            </div>

            <div className="flex items-center gap-2">
              <span
                className={isSuper ? "super-shimmer-text" : "elevate-shimmer-text"}
                style={{ fontFamily: "inherit", fontWeight: 700, fontSize: "0.875rem" }}
              >
                {isSuper ? t("super_elevate_label") : t("elevate_label")}
              </span>
              <PulseDot isSuper={isSuper} />
              <span className="text-xs font-medium text-primary/80">{t("live_label")}</span>
            </div>
          </div>

          {/* Countdown */}
          <div
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg"
            style={isSuper
              ? { background: "hsl(350 45% 52% / 0.18)", border: "1px solid hsl(350 45% 52% / 0.25)" }
              : { background: "hsl(350 45% 52% / 0.1)" }
            }
          >
            <span className="text-xs tabular-nums font-bold text-primary">
              {formatCountdown(secs)}
            </span>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatChip icon={Eye} value={views} label={t("views_label")} isSuper={isSuper} />
          <StatChip icon={Heart} value={matches} label={t("matches_label")} isSuper={isSuper} />
          <span className="text-xs text-muted-foreground ms-auto hidden sm:block">
            {isSuper ? t("eight_x_priority") : t("three_x_visibility")}
          </span>
        </div>

        {/* Tagline */}
        <p className="text-xs mt-2.5" style={{ color: isSuper ? "hsl(350 45% 55%)" : "hsl(350 45% 55%)" }}>
          {isSuper ? t("super_elevate_tagline") : t("elevate_tagline")}
        </p>
      </div>
    </div>
  );
}
