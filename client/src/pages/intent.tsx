import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, RotateCw, X, MapPin, Lock, Star, Crown, MessageCircle, HelpCircle, Moon, Volume2, VolumeX, ChevronRight, BadgeCheck } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { ElevateModal } from "@/components/elevate-modal";
import { useAuth } from "@/hooks/use-auth";
import { LulouGuide } from "@/components/lulou-guide";
import { GUIDE_KEYS } from "@/lib/guide-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useTabActive } from "@/hooks/use-tab-active";
import type { Profile } from "@shared/schema";
import { ProfilePhotoViewer } from "@/components/profile-photo-viewer";
import { EMPTY_PHOTOS } from "@/lib/image-utils";
import { useLanguageContext } from "@/contexts/language-context";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { clearAllArmedSessions } from "@/lib/live-call-sessions";

/** Fisher-Yates shuffle — returns a new array, does not mutate input. */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Small "Restore Purchases" text link shown below Halo packs. */
function RestorePurchasesButton() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const handleRestore = async () => {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/stripe/restore-purchases", {});
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? "Restore failed");
      const count = data.restored?.length ?? 0;
      if (count > 0) {
        toast({
          title: `${count} purchase${count === 1 ? "" : "s"} restored`,
          description: data.restored.map((r: { name: string }) => r.name).join(", "),
        });
      } else {
        toast({ title: "All purchases already applied", description: "Nothing new to restore." });
      }
    } catch (err: any) {
      toast({ title: "Restore failed", description: err?.message ?? "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      onClick={handleRestore}
      disabled={loading}
      data-testid="button-restore-purchases-intent"
      style={{
        fontSize: 12, color: "rgba(255,255,255,0.28)",
        background: "none", border: "none", cursor: loading ? "not-allowed" : "pointer",
        padding: "6px 24px", opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "Checking…" : "Restore Purchases"}
    </button>
  );
}

// Lazy-loads a single photo for a wheel item or profile card.
function ProfilePhoto({ userId, className }: { userId: string; className?: string }) {
  const { data, isLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const [photoIndex, setPhotoIndex] = useState(0);
  useEffect(() => { setPhotoIndex(0); }, [userId]);

  const photos = data?.photos ?? [];
  const photo = photos[photoIndex] ?? null;

  if (isLoading) {
    return (
      <div
        className={`${className ?? ""}`}
        style={{
          background: "linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground)/0.08) 50%, hsl(var(--muted)) 75%)",
          backgroundSize: "200% 100%",
          animation: "shimmer 1.4s infinite linear",
        }}
      />
    );
  }

  if (!photo) {
    return (
      <div
        className={`flex items-center justify-center ${className ?? ""}`}
        style={{ background: "linear-gradient(160deg, hsl(var(--muted)) 0%, hsl(var(--muted-foreground)/0.12) 100%)" }}
      >
        <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ width: "40%", height: "40%", opacity: 0.22 }}>
          <circle cx="40" cy="28" r="14" fill="currentColor" />
          <ellipse cx="40" cy="62" rx="24" ry="16" fill="currentColor" />
        </svg>
      </div>
    );
  }

  return (
    <img
      src={photo}
      alt=""
      className={`object-cover ${className ?? ""}`}
      draggable={false}
      onError={() => setPhotoIndex(i => i + 1)}
    />
  );
}

// ── Web Audio engine ─────────────────────────────────────────────────────────
// Completely separate from the call/ringtone AudioContext — no interference.
// AudioContext is only created after the first user gesture (spinWheel click).
function useWheelAudio(muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const lastTickDegRef = useRef(0);

  const ensureCtx = useCallback(() => {
    if (muted) return;
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    } catch {}
  }, [muted]);

  // Short percussive noise burst — one mechanical "tick".
  const tick = useCallback(() => {
    if (muted) return;
    const ctx = ctxRef.current;
    if (!ctx || ctx.state !== "running") return;
    try {
      const sampleRate = ctx.sampleRate;
      const buf = ctx.createBuffer(1, Math.floor(sampleRate * 0.013), sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * 0.0028));
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = 0.22;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch {}
  }, [muted]);

  const resetTick = useCallback((currentAngle: number) => {
    lastTickDegRef.current = currentAngle;
  }, []);

  const tickFromAngle = useCallback((newAngle: number, tickStep: number) => {
    if (Math.abs(newAngle - lastTickDegRef.current) >= tickStep) {
      lastTickDegRef.current = newAngle;
      tick();
    }
  }, [tick]);

  // Premium landing chime: warm G major chord (G4 + D5 + G5) with long natural decay.
  // Richer, warmer, and more neutral than a high-pitched arpeggio.
  const playChime = useCallback(() => {
    if (muted) return;
    const ctx = ctxRef.current;
    if (!ctx || ctx.state !== "running") return;
    try {
      const now = ctx.currentTime;
      // [freq, offset, attackDur, peakGain, decayDur]
      const tones: [number, number, number, number, number][] = [
        [392.00, 0.00, 0.045, 0.20, 2.00],  // G4 — warm fundamental
        [587.33, 0.05, 0.045, 0.13, 1.60],  // D5 — perfect fifth
        [783.99, 0.09, 0.040, 0.07, 1.20],  // G5 — octave sparkle
      ];
      for (const [freq, offset, attack, peak, decay] of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(peak, now + offset + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + decay);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + decay + 0.1);
      }
    } catch {}
  }, [muted]);

  return { ensureCtx, resetTick, tickFromAngle, playChime };
}

// ── Confetti burst (canvas) ──────────────────────────────────────────────────
const CONFETTI_COLORS = ["#d45c74", "#e8a0b0", "#f5d0d8", "#9d3550", "#ffd6e0", "#fff0f3", "#c0c0ff"];

function ConfettiBurst({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = canvas.offsetHeight;

    const particles = Array.from({ length: 72 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.2 + Math.random() * 5.5;
      return {
        x: W / 2, y: H * 0.45,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3.5,
        size: 4 + Math.random() * 5,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.22,
        life: 1,
        decay: 0.012 + Math.random() * 0.014,
        isCircle: Math.random() > 0.5,
      };
    });

    let alive = true;
    const draw = () => {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      let anyAlive = false;
      for (const p of particles) {
        if (p.life <= 0) continue;
        anyAlive = true;
        p.life -= p.decay;
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.18; p.vx *= 0.985;
        p.rot += p.rotSpeed;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.isCircle) {
          ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      if (anyAlive) rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { alive = false; cancelAnimationFrame(rafRef.current); };
  }, [active]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 190 }}
    />
  );
}

// ── Premium match reveal taglines ────────────────────────────────────────────
const MATCH_TAGLINE_KEYS = [
  "tagline_two_energies",
  "tagline_wheel_interesting",
  "tagline_connection_rare",
  "tagline_worth_meeting",
  "tagline_spark_landed",
  "tagline_wheel_good_taste",
  "tagline_feels_real",
  "tagline_not_every_spin",
  "tagline_genuine_started",
  "tagline_rare_appeared",
] as const;

// Floating particle row — purely decorative, generated once per mount.
const REVEAL_PARTICLES = Array.from({ length: 20 }, (_, i) => ({
  id: i,
  size: 3 + (i * 7) % 5,
  left: 4 + (i * 19) % 92,
  bottom: 8 + (i * 13) % 35,
  dur: 4.2 + (i * 0.37) % 5,
  delay: (i * 0.28) % 4,
  color: ["rgba(255,168,188,0.55)", "rgba(212,92,116,0.48)", "rgba(255,210,222,0.42)", "rgba(255,255,255,0.22)"][i % 4],
}));

// ── Match reveal overlay ─────────────────────────────────────────────────────
// Full-screen cinematic overlay shown after the user taps Connect on a wheel profile.
// Two-zone design: glowing photo fills the upper half; a frosted glass card slides
// up from below carrying the name, tagline, and premium CTAs.
function MatchRevealOverlay({
  profile,
  isExisting,
  playChime,
  onGoToMatches,
  onDiscover,
  onElevate,
}: {
  profile: Profile;
  isExisting: boolean;
  playChime: () => void;
  onGoToMatches: () => void;
  onDiscover: () => void;
  onElevate: () => void;
}) {
  const { t } = useLanguageContext();
  const taglineKey = useRef(MATCH_TAGLINE_KEYS[Math.floor(Math.random() * MATCH_TAGLINE_KEYS.length)]).current;
  const tagline = t(taglineKey);

  useEffect(() => {
    const chimeTimer = setTimeout(playChime, 200);
    return () => clearTimeout(chimeTimer);
  }, [playChime]);

  return (
    <div
      className="absolute inset-0 z-[60] flex flex-col overflow-hidden"
      style={{ animation: "matchRevealBg 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards" }}
      data-testid="match-reveal-overlay"
    >
      {/* ── Layer 0 — cinematic blurred background ── */}
      <div className="absolute inset-0">
        <ProfilePhoto userId={profile.userId} className="w-full h-full" />
        <div className="absolute inset-0" style={{
          backdropFilter: "blur(44px) saturate(1.6)",
          WebkitBackdropFilter: "blur(44px) saturate(1.6)",
        }} />
        <div className="absolute inset-0" style={{
          background: "linear-gradient(180deg, rgba(4,1,8,0.80) 0%, rgba(10,3,16,0.44) 42%, rgba(4,1,8,0.94) 100%)",
        }} />
        <div className="absolute inset-0" style={{
          background: "radial-gradient(ellipse 78% 52% at 50% 44%, rgba(188,78,96,0.34) 0%, transparent 68%)",
        }} />
      </div>

      {/* ── Layer 1 — confetti burst ── */}
      <ConfettiBurst active={true} />

      {/* ── Layer 2 — floating ambient particles ── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {REVEAL_PARTICLES.map(p => (
          <div key={p.id} style={{
            position: "absolute",
            bottom: `${p.bottom}%`,
            left: `${p.left}%`,
            width: p.size, height: p.size,
            borderRadius: "50%",
            background: p.color,
            animation: `floatParticle ${p.dur}s ${p.delay}s ease-in-out infinite`,
          }} />
        ))}
      </div>

      {/* ── Layer 3 — full-height scrollable identity card (name at very top) ── */}
      {/* Hierarchy: Name → Details → Photo → Badge → Elevate → Tagline → CTAs */}
      <div
        className="relative z-10"
        style={{
          flex: "1 1 0",
          overflowY: "auto",
          animation: "cardSlideUp 0.64s 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) both",
          background: "rgba(7,2,13,0.90)",
          backdropFilter: "blur(32px) saturate(1.3)",
          WebkitBackdropFilter: "blur(32px) saturate(1.3)",
          borderTop: "1px solid rgba(255,255,255,0.09)",
          borderRadius: "30px 30px 0 0",
          boxShadow: "0 -16px 64px rgba(0,0,0,0.42)",
          padding: "28px 24px 44px",
        }}
      >
        {/* ① Name — absolute hero, first element */}
        <h2
          className="font-serif text-center"
          style={{
            fontSize: "clamp(32px, 9vw, 44px)",
            fontWeight: 700,
            letterSpacing: "-0.025em",
            lineHeight: 1.08,
            color: "rgba(255,245,250,0.98)",
            textShadow: "0 2px 30px rgba(188,78,96,0.55), 0 1px 6px rgba(0,0,0,0.70)",
            marginBottom: 8,
            animation: "matchRevealTagline 0.52s 0.48s ease both",
          }}
          data-testid="text-reveal-name"
        >
          {profile.firstName}
        </h2>

        {/* ② Age + location details — immediately under name */}
        {(profile.age || profile.location) && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            flexWrap: "wrap", gap: "6px 10px",
            marginBottom: 16,
            animation: "matchRevealTagline 0.44s 0.60s ease both",
          }}>
            {profile.age && (
              <span style={{ fontSize: 16, fontWeight: 600, color: "rgba(255,210,222,0.72)", letterSpacing: "0.01em" }}>
                {profile.age}
              </span>
            )}
            {profile.age && profile.location && (
              <span style={{ color: "rgba(255,255,255,0.18)", fontSize: 13 }}>·</span>
            )}
            {profile.location && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, color: "rgba(255,185,202,0.52)" }}>
                <MapPin style={{ width: 11, height: 11, flexShrink: 0 }} />
                {profile.location}
              </span>
            )}
          </div>
        )}

        {/* ③ Profile photo — "Real Connections" picture, below identity */}
        <div style={{
          display: "flex", justifyContent: "center",
          marginBottom: 14,
          animation: "matchRevealPhoto 0.78s 0.54s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        }}>
          <div style={{ position: "relative" }}>
            <div style={{
              position: "absolute", inset: -26,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(212,92,116,0.28) 0%, rgba(188,78,96,0.06) 58%, transparent 75%)",
              animation: "glowPulse 2.8s ease-in-out infinite",
              pointerEvents: "none",
            }} />
            <div style={{
              position: "absolute", inset: -8,
              borderRadius: "50%",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.09), 0 0 22px 6px rgba(212,92,116,0.18)",
              animation: "glowPulse 2.8s ease-in-out infinite 0.6s",
              pointerEvents: "none",
            }} />
            <div style={{
              width: 148, height: 148,
              borderRadius: "50%", overflow: "hidden", position: "relative",
              boxShadow:
                "0 0 0 2px rgba(255,255,255,0.13)," +
                "0 0 0 5px rgba(212,92,116,0.76)," +
                "0 0 0 10px rgba(212,92,116,0.13)," +
                "0 14px 44px rgba(0,0,0,0.58)",
            }}>
              <ProfilePhoto userId={profile.userId} className="w-full h-full" />
            </div>
            <div style={{
              position: "absolute", inset: -4, borderRadius: "50%",
              background:
                "conic-gradient(from 0deg, transparent 0%, rgba(255,200,215,0.50) 15%," +
                " transparent 34%, rgba(212,92,116,0.38) 55%, transparent 74%, rgba(255,200,215,0.50) 100%)",
              animation: "rotateSlow 8s linear infinite",
              mixBlendMode: "screen", pointerEvents: "none",
            }} />
          </div>
        </div>

        {/* ④ Connection badge — caption below photo */}
        <p style={{
          fontSize: 10, fontWeight: 700, letterSpacing: "0.26em",
          textTransform: "uppercase",
          color: "rgba(255,170,190,0.54)",
          textAlign: "center",
          marginBottom: 14,
          animation: "matchRevealTagline 0.38s 0.72s ease both",
        }}>
          {isExisting ? t("reconnected_label") : t("connection_opened_label")}
        </p>

        {/* ⑤ 3× Elevate upgrade section */}
        <div
          role="button"
          onClick={onElevate}
          data-testid="button-reveal-elevate"
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "11px 14px", borderRadius: 14, marginBottom: 16,
            background: "rgba(212,92,116,0.10)",
            border: "1px solid rgba(212,92,116,0.22)",
            cursor: "pointer",
            transition: "background 0.16s, border-color 0.16s",
            animation: "matchRevealTagline 0.42s 0.82s ease both",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "rgba(212,92,116,0.17)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(212,92,116,0.36)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "rgba(212,92,116,0.10)";
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(212,92,116,0.22)";
          }}
        >
          <div style={{
            width: 34, height: 34, borderRadius: 9, flexShrink: 0,
            background: "linear-gradient(135deg, #e06272 0%, #9c2d49 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 3px 12px rgba(184,56,80,0.42)",
          }}>
            <span style={{ color: "#fff", fontSize: 13, fontWeight: 800, letterSpacing: "-0.03em" }}>3×</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,210,222,0.92)", lineHeight: 1.3, margin: 0 }}>
              {t("elevate_3x_title")}
            </p>
            <p style={{ fontSize: 11, color: "rgba(255,175,195,0.52)", lineHeight: 1.3, margin: "2px 0 0" }}>
              {t("elevate_3x_desc")}
            </p>
          </div>
          <span style={{ fontSize: 14, color: "rgba(255,170,190,0.55)", flexShrink: 0, lineHeight: 1 }}>›</span>
        </div>

        {/* ⑥ Match reveal tagline */}
        <p
          style={{
            fontSize: 15, textAlign: "center", fontStyle: "italic",
            color: "rgba(255,208,220,0.68)", lineHeight: 1.5,
            marginBottom: 16,
            animation: "matchRevealTagline 0.48s 0.94s ease both",
          }}
          data-testid="text-reveal-tagline"
        >
          {tagline}
        </p>

        {/* Rose divider */}
        <div style={{
          width: 48, height: 1, margin: "0 auto 16px",
          background: "linear-gradient(90deg, transparent, rgba(212,92,116,0.78), transparent)",
          animation: "matchRevealTagline 0.34s 1.02s ease both",
        }} />

        {/* ⑦ CTAs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 11, animation: "matchRevealCta 0.46s 1.08s ease both" }}>
          {/* Primary — Start Conversation */}
          <button
            onClick={onGoToMatches}
            data-testid="button-reveal-go-to-matches"
            style={{
              width: "100%", padding: "16px 0",
              borderRadius: 18,
              background: "linear-gradient(135deg, #e06272 0%, #b83858 52%, #9c2d49 100%)",
              color: "#fff",
              fontSize: 16, fontWeight: 700, letterSpacing: "0.025em",
              border: "none", cursor: "pointer",
              boxShadow:
                "0 8px 32px rgba(184,56,80,0.60)," +
                "0 3px 10px rgba(0,0,0,0.44)," +
                "inset 0 1.5px 0 rgba(255,255,255,0.20)",
              transition: "transform 0.13s ease, box-shadow 0.13s ease",
              outline: "none", WebkitTapHighlightColor: "transparent",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
              (e.currentTarget as HTMLElement).style.boxShadow = "0 12px 42px rgba(184,56,80,0.70), 0 4px 14px rgba(0,0,0,0.50), inset 0 1.5px 0 rgba(255,255,255,0.20)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
              (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 32px rgba(184,56,80,0.60), 0 3px 10px rgba(0,0,0,0.44), inset 0 1.5px 0 rgba(255,255,255,0.20)";
            }}
            onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(1px) scale(0.985)"; }}
            onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)"; }}
          >
            {t("start_conversation")}
          </button>

          {/* Secondary — Keep Exploring */}
          <button
            onClick={onDiscover}
            data-testid="button-reveal-discover-more"
            style={{
              width: "100%", padding: "14px 0",
              borderRadius: 18,
              background: "rgba(255,255,255,0.055)",
              color: "rgba(255,208,220,0.62)",
              fontSize: 14, fontWeight: 500, letterSpacing: "0.025em",
              border: "1.5px solid rgba(255,255,255,0.11)",
              cursor: "pointer",
              transition: "color 0.17s, background 0.17s, border-color 0.17s",
              outline: "none", WebkitTapHighlightColor: "transparent",
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.color = "rgba(255,224,232,0.90)";
              el.style.background = "rgba(255,255,255,0.095)";
              el.style.borderColor = "rgba(255,255,255,0.22)";
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.color = "rgba(255,208,220,0.62)";
              el.style.background = "rgba(255,255,255,0.055)";
              el.style.borderColor = "rgba(255,255,255,0.11)";
            }}
          >
            {t("keep_exploring")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Candidates preview strip ─────────────────────────────────────────────────
// Shows up to 7 profile bubbles BEFORE spinning to build excitement.
// The displayed order has NO effect on the winner — the winner is always chosen
// with Math.random() at spin time from the full shuffled pool.
// Tap any bubble to open a photo-only preview of that profile.
function CandidatesPreview({ items, onTap }: { items: Profile[]; onTap?: (profile: Profile) => void }) {
  const { t } = useLanguageContext();
  const [vw, setVw] = useState(() => typeof window !== "undefined" ? window.innerWidth : 390);
  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const bubbleSize = vw < 380 ? 30 : 38;
  const bubbleGap  = vw < 380 ? 4  : 6;
  const maxCount   = vw < 380 ? 5  : 7;
  const preview = useMemo(() => items.slice(0, Math.min(maxCount, items.length)), [items, maxCount]);
  if (preview.length < 2) return null;

  return (
    <div
      style={{
        width: "100%", padding: "4px 16px 8px",
        animation: "previewFadeIn 0.7s 0.2s ease both",
      }}
    >
      <p style={{
        fontSize: 9, fontWeight: 800, letterSpacing: "0.22em",
        textTransform: "uppercase", textAlign: "center",
        color: "hsl(var(--muted-foreground))",
        marginBottom: 10, opacity: 0.7,
      }}>
        {t("tonight_connections")}
      </p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: bubbleGap }}>
        {preview.map((profile, i) => (
          <div
            key={profile.userId}
            style={{ flexShrink: 0, animation: `previewBubbleIn 0.45s ${0.08 + i * 0.06}s ease both` }}
            onClick={() => onTap?.(profile)}
            data-testid={`button-preview-bubble-${i}`}
          >
            <div style={{
              width: bubbleSize, height: bubbleSize, borderRadius: "50%", overflow: "hidden",
              position: "relative",
              boxShadow: onTap
                ? "0 2px 12px rgba(188,78,96,0.28), 0 1px 4px rgba(0,0,0,0.18)"
                : "0 2px 10px rgba(188,78,96,0.18), 0 1px 4px rgba(0,0,0,0.16)",
              border: "1.5px solid rgba(212,92,116,0.28)",
              cursor: onTap ? "pointer" : "default",
              transition: "transform 0.12s ease",
            }}>
              <ProfilePhoto userId={profile.userId} className="w-full h-full" />
              <div style={{
                position: "absolute", inset: 0,
                background: "rgba(8,2,14,0.08)",
              }} />
            </div>
          </div>
        ))}
        {items.length > maxCount && (
          <div style={{
            width: bubbleSize, height: bubbleSize, borderRadius: "50%", flexShrink: 0,
            background: "hsl(var(--muted))",
            border: "1.5px solid rgba(212,92,116,0.18)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "hsl(var(--muted-foreground))" }}>
              +{items.length - maxCount}
            </span>
          </div>
        )}
      </div>
      <p style={{
        fontSize: 10, textAlign: "center", marginTop: 8, fontStyle: "italic",
        color: "hsl(var(--muted-foreground))", opacity: 0.6,
      }}>
        {t("spin_random_desc")}
      </p>
    </div>
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const ITEM_WIDTH = 156;

// Static particle descriptors for the SpinRoom orbit effect — defined once at
// module level so the array reference is stable across renders.
const SPIN_PARTICLES = Array.from({ length: 10 }, (_, i) => ({
  x:     18 + (i % 5) * 14 + Math.sin(i * 1.4) * 6,
  y:     22 + Math.cos(i * 1.9) * 22,
  size:  3  + (i % 3) * 1.5,
  alpha: 0.5 + (i % 3) * 0.17,
  dur:   2.2 + (i % 4) * 0.45,
  delay: i * 0.24,
}));
const ITEM_HEIGHT = 208;
const DAILY_LIKE_GOAL = 10;
const STREAK_GOAL = 3;
const TICK_DEG_STEP = 5;

type SpinStatus = {
  spinsThisWeek: number;
  dailyLikes: number;
  consecutiveDays: number;
  streakComplete: boolean;
  canSpin: boolean;
  purchasedSpins?: number;
};

// Lulou quotes — shown in the reveal stage before profile details appear.
const LULOU_QUOTES = [
  "One possibility. One story.",
  "Sometimes the right person arrives unexpectedly.",
  "Tonight begins with a hello.",
  "Some introductions feel different.",
  "Every connection starts with a moment.",
  "Lulou chose someone for you tonight.",
] as const;

// Custom "prize wheel" ease: confident wind-up → thrilling rush → natural friction stop.
// Phase 1 (0–8 %):  quadratic ease-in — wheel builds momentum from rest.
// Phase 2 (8–62 %): near-linear fast spin — the exciting rush.
// Phase 3 (62–100%): physically accurate friction deceleration.
//   Polynomial f(p) = Vr·p + (3−2Vr)·p² + (Vr−2)·p³ where Vr = v_start·T3/D3.
//   Velocity matches phase 2 at entry and arrives exactly at 0 — no abrupt stop.
//   This covers 18% of travel over 38% of time, giving a long visible slowdown.
function spinEase(t: number): number {
  if (t < 0.08) {
    const p = t / 0.08;
    return p * p * 0.020;
  }
  if (t < 0.62) {
    const p = (t - 0.08) / 0.54;
    return 0.020 + p * 0.800;
  }
  const p = (t - 0.62) / 0.38;
  const Vr = 3.02;
  return 0.820 + 0.180 * (Vr * p + (3 - 2 * Vr) * p * p + (Vr - 2) * p * p * p);
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function IntentPage() {
  const { t, isRTL } = useLanguageContext();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [, navigate] = useLocation();

  const { data: profiles, isLoading, isError, refetch: refetchProfiles } = useQuery<Profile[]>({
    queryKey: ["/api/popular"],
    placeholderData: (prev) => prev,
  });

  const [intentLoadingTooLong, setIntentLoadingTooLong] = useState(false);
  const intentLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isLoading) {
      setIntentLoadingTooLong(false);
      intentLoadingTimerRef.current = setTimeout(() => setIntentLoadingTooLong(true), 8_000);
    } else {
      if (intentLoadingTimerRef.current) { clearTimeout(intentLoadingTimerRef.current); intentLoadingTimerRef.current = null; }
      setIntentLoadingTooLong(false);
    }
    return () => { if (intentLoadingTimerRef.current) clearTimeout(intentLoadingTimerRef.current); };
  }, [isLoading]);

  const { data: spinStatus } = useQuery<SpinStatus>({
    queryKey: ["/api/spin-status"],
    refetchInterval: isActive ? 60_000 : false,
  });

  // ── Sound ────────────────────────────────────────────────────────────────
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("wheel_sound_muted") === "true"; } catch { return false; }
  });
  const toggleMute = useCallback(() => {
    setMuted(prev => {
      const next = !prev;
      try { localStorage.setItem("wheel_sound_muted", String(next)); } catch {}
      return next;
    });
  }, []);
  const { ensureCtx, resetTick, tickFromAngle, playChime } = useWheelAudio(muted);

  // ── Wheel physics ────────────────────────────────────────────────────────
  const animFrame = useRef(0);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const lastX = useRef(0);
  const lastTime = useRef(0);
  const velocity = useRef(0);
  const angleRef = useRef(0);

  const prevProfilesRef = useRef<Profile[] | null>(null);
  const shuffledItemsRef = useRef<Profile[]>([]);
  // Cache the last non-empty set of profiles so the wheel stays visible
  // when a refetch temporarily returns [] (test environment with few users,
  // or after a spin invalidates the query and the API filters leave an empty pool).
  const lastNonEmptyRef = useRef<Profile[]>([]);
  if (profiles !== prevProfilesRef.current) {
    prevProfilesRef.current = profiles ?? null;
    if (profiles && profiles.length > 0) {
      shuffledItemsRef.current = shuffleArray(profiles);
      lastNonEmptyRef.current = shuffledItemsRef.current;
    }
    // When profiles is empty/null, keep shuffledItemsRef unchanged so the
    // wheel continues to display the last known profile cards.
  }

  const [isSpinning, setIsSpinning] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);

  // Fetch full photo set for the detail view — enabled only when a profile is selected.
  const { data: detailPhotoData, isLoading: isDetailPhotosLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", selectedProfile?.userId, "photos"],
    enabled: !!selectedProfile?.userId,
    staleTime: 5 * 60 * 1000,
  });
  const detailPhotos = detailPhotoData?.photos ?? EMPTY_PHOTOS;

  const [dispersed, setDispersed] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPurchase, setShowPurchase] = useState(false);
  const [previewProfile, setPreviewProfile] = useState<Profile | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showElevateInReveal, setShowElevateInReveal] = useState(false);
  const [showSpinExtras, setShowSpinExtras] = useState(false);
  const [sparksCheckoutLoading, setSparksCheckoutLoading] = useState<string | null>(null);
  const [angle, setAngle] = useState(0);

  // Spin room + Halo state
  const [showSpinRoom, setShowSpinRoom] = useState(false);
  const [sparkSent, setSparkSent] = useState(false);
  // Quote shown in reveal stage — picked once when winner lands
  const [revealQuote, setRevealQuote] = useState<string>("");

  // SpinRoom cinematic phase — drives what's visible at each moment
  type SpinPhase = 'idle' | 'accelerate' | 'fast' | 'slow' | 'approach' | 'pullforward' | 'arrive' | 'reveal' | 'pause' | 'buttons';
  const [spinRoomPhase, setSpinRoomPhase] = useState<SpinPhase>('idle');

  // Orbit animation — all RAF-driven via refs (no React re-renders per frame)
  const orbitBubbles    = useRef<(HTMLDivElement | null)[]>([]);
  const orbitAngleRef2  = useRef(0);   // current angle °
  const orbitSpeedRef2  = useRef(0);   // current speed °/s
  const orbitTargetRef  = useRef(0);   // target speed °/s
  const orbitRafRef2    = useRef(0);
  const orbitLastTimeRef = useRef(0);
  const orbitGlowRef    = useRef<HTMLDivElement>(null);
  const orbitRingRef2   = useRef<HTMLDivElement>(null);
  const landingMarkerRef = useRef<HTMLDivElement>(null); // 12 o'clock jewel marker
  const spinPhaseRef = useRef<SpinPhase>('idle');  // readable inside RAF without stale-closure issues

  // Use the last non-empty ref as fallback so the wheel stays visible when the
  // current query result is empty (e.g. test environment, post-spin refetch).
  const items = shuffledItemsRef.current.length > 0
    ? shuffledItemsRef.current
    : lastNonEmptyRef.current;
  const count = items.length;
  const angleStep = count > 0 ? 360 / count : 0;
  const radius = count > 4 ? Math.max(188, count * 26) : 172;
  const canSpin = spinStatus?.canSpin ?? false;

  // Responsive wheel card dimensions — shrink on narrow phones to prevent clipping
  const [viewportW, setViewportW] = useState(() => typeof window !== "undefined" ? window.innerWidth : 390);
  const [viewportH, setViewportH] = useState(() => typeof window !== "undefined" ? window.innerHeight : 800);
  useEffect(() => {
    const h = () => { setViewportW(window.innerWidth); setViewportH(window.innerHeight); };
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const isCompact = viewportH < 700;
  const itemWidth  = viewportW < 380 ? 118 : viewportW < 430 ? 136 : ITEM_WIDTH;
  const itemHeight = Math.round(itemWidth * (ITEM_HEIGHT / ITEM_WIDTH));
  const wheelBufferY = isCompact ? 80 : viewportW < 380 ? 130 : 160;

  const glide = useCallback(() => {
    velocity.current *= 0.94;
    if (Math.abs(velocity.current) < 0.05) { velocity.current = 0; return; }
    angleRef.current += velocity.current;
    tickFromAngle(angleRef.current, TICK_DEG_STEP);
    setAngle(angleRef.current);
    animFrame.current = requestAnimationFrame(glide);
  }, [tickFromAngle]);

  const committedDrag = useRef(false);

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
      if (e.pointerType === "touch") e.preventDefault();
    }
    const now = Date.now();
    const dt = now - lastTime.current;
    const rawDx = e.clientX - lastX.current;
    const dragDelta = isRTL ? -rawDx : rawDx;
    if (dt > 0) velocity.current = (dragDelta / dt) * 0.8;
    lastX.current = e.clientX;
    lastTime.current = now;
    angleRef.current += dragDelta * 0.32;
    setAngle(angleRef.current);
  };

  const handlePointerUp = () => {
    isDragging.current = false;
    committedDrag.current = false;
    if (Math.abs(velocity.current) > 0.2) animFrame.current = requestAnimationFrame(glide);
  };

  const recordSpin = useMutation({
    mutationFn: async (standoutUserId: string) => {
      await apiRequest("POST", "/api/spin", { standoutUserId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
    },
  });

  const sendSpark = useMutation({
    mutationFn: async (toUserId: string) => {
      const res = await apiRequest("POST", "/api/wheel/spark", { toUserId });
      return res.json();
    },
    onSuccess: () => {
      console.log("[WHEEL] SPARK_SENT", { to: selectedProfile?.firstName });
      try { (navigator as any).vibrate?.([40, 20, 80]); } catch {}
      setSparkSent(true);
      setTimeout(() => {
        setShowSpinRoom(false);
        setSparkSent(false);
        closeProfile();
        setTimeout(() => setShowSpinExtras(true), 400);
      }, 2200);
    },
    onError: (error: any) => {
      const raw = error?.message || "";
      let msg = t("something_went_wrong");
      try { const p = JSON.parse(raw); if (p?.message) msg = p.message; } catch {}
      toast({ title: t("could_not_connect_title"), description: msg, variant: "destructive" });
    },
  });

  const saveForLater = useMutation({
    mutationFn: async (profileId: string) => {
      const res = await apiRequest("POST", "/api/wheel/save", { profileId });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as any;
        throw new Error(d.message || "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wheel/saved"] });
      setShowProfile(false);
      toast({ title: t("save_for_later_label"), description: t("save_for_later_done") });
    },
    onError: (err: any) => {
      toast({ title: err?.message || t("something_went_wrong"), variant: "destructive" });
    },
  });

  const spinWheel = () => {
    if (isSpinning || count === 0 || !canSpin) return;
    ensureCtx();
    try { (navigator as any).vibrate?.([30]); } catch {}
    setShowSpinRoom(true);
    setIsSpinning(true);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setDispersed(false);
    setShowProfile(false);
    setShowPurchase(false);
    setShowConfetti(false);
    setSparkSent(false);

    // Winner is chosen fresh at spin time — preview order has NO influence.
    const targetIndex = Math.floor(Math.random() * count);
    const landedProfile = items[targetIndex];

    console.log("[WHEEL] SPIN_START", { totalUsers: count });
    console.log("[WHEEL] ORBIT_ACTIVE", { orbitCount: Math.min(count, 10), ringRadius: 140 });
    console.log("[WHEEL] SPIN_SELECTED", { selectedIndex: targetIndex, selectedName: landedProfile?.firstName, randomSource: "Math.random()" });

    const targetAngle = targetIndex * angleStep;
    const currentAngle = angleRef.current;
    // 5–8 full rotations — randomised so landing position is unpredictable.
    const fullSpins = (5 + Math.floor(Math.random() * 4)) * 360;
    const normalizedCurrent = ((currentAngle % 360) + 360) % 360;
    let diff = targetAngle - normalizedCurrent;
    if (diff < 0) diff += 360;
    const totalRotation = fullSpins + diff;
    // 5.2–6.0s total: shorter and snappier while still allowing a satisfying slowdown.
    const duration = 5200 + Math.random() * 800;
    const startTime = performance.now();
    const startAngle = currentAngle;

    resetTick(currentAngle);

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const rawT = Math.min(elapsed / duration, 1);
      const newAngle = startAngle + totalRotation * spinEase(rawT);
      tickFromAngle(newAngle, 2 + rawT * rawT * 14);
      angleRef.current = newAngle;
      setAngle(newAngle);

      if (rawT < 1) {
        animFrame.current = requestAnimationFrame(animate);
      } else {
        angleRef.current = startAngle + totalRotation;
        setAngle(angleRef.current);
        setIsSpinning(false);
        // Winner is resolved at pullforward time by reading which orbit bubble
        // naturally lands under the 12 o'clock marker — set background display only.
        setTimeout(() => setDispersed(true), 260);
        setTimeout(() => setShowConfetti(true), 420);
        setTimeout(() => setShowConfetti(false), 2300);
      }
    };

    cancelAnimationFrame(animFrame.current);
    animFrame.current = requestAnimationFrame(animate);
  };

  const closeProfile = () => {
    setShowSpinRoom(false);
    setSparkSent(false);
    setShowProfile(false);
    setDispersed(false);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setShowConfetti(false);
    queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
  };

  // ── SpinRoom phase timeline ─────────────────────────────────────────────────
  // Runs entirely independently of the underlying wheel animation so the
  // cinematic 10-12 s experience never collapses to 2-3 s.
  useEffect(() => {
    if (!showSpinRoom) {
      setSpinRoomPhase('idle');
      orbitTargetRef.current = 0;
      return;
    }
    const go = (p: SpinPhase, speed: number) => {
      setSpinRoomPhase(p);
      orbitTargetRef.current = speed;
    };
    go('accelerate', 180);
    console.log('[WHEEL] SPIN_START');
    const ts = [
      setTimeout(() => { go('fast', 360);   console.log('[WHEEL] FAST_PHASE');      },  2000),
      setTimeout(() => { go('slow',  40);   console.log('[WHEEL] SLOW_PHASE');      },  5000),
      // Approach: decelerate orbit to near-zero so one bubble settles under the marker
      setTimeout(() => { go('approach', 0); console.log('[WHEEL] WINNER_APPROACH'); },  7000),
      // Pullforward: read which bubble is at 12 o'clock — that IS the winner
      setTimeout(() => {
        const N_orb = Math.min(items.length, 10);
        const aRad_now = (orbitAngleRef2.current * Math.PI) / 180;
        let closestI = 0;
        let minSin = Infinity;
        for (let ii = 0; ii < N_orb; ii++) {
          const base = (ii / N_orb) * Math.PI * 2 - Math.PI / 2;
          const sinVal = Math.sin(base + aRad_now);
          if (sinVal < minSin) { minSin = sinVal; closestI = ii; }
        }
        const winner = items[closestI];
        console.log('[WHEEL] PULL_FORWARD', { winner: winner?.firstName, index: closestI });
        if (winner) {
          setSelectedIndex(closestI);
          setSelectedProfile(winner);
          setRevealQuote(LULOU_QUOTES[Math.floor(Math.random() * LULOU_QUOTES.length)]);
          recordSpin.mutate(winner.userId);
          setShowProfile(true);
        }
        // Brighten the landing marker at the moment of selection
        if (landingMarkerRef.current) {
          landingMarkerRef.current.style.opacity = '1';
          landingMarkerRef.current.style.filter = 'drop-shadow(0 0 10px rgba(212,92,116,1)) drop-shadow(0 2px 18px rgba(212,92,116,0.70))';
        }
        try { (navigator as any).vibrate?.([15, 10, 30]); } catch {}
        go('pullforward', 0);
      },  8400),
      setTimeout(() => { go('arrive', 0);   console.log('[WHEEL] WINNER_ARRIVE');   },  9800),
      setTimeout(() => {
        go('reveal', 0);
        console.log('[WHEEL] WINNER_REVEAL');
        if (!muted) playChime();
        try { (navigator as any).vibrate?.([60, 40, 120]); } catch {}
      }, 11200),
      setTimeout(() => go('pause',   0), 13500),
      // buttons phase = profile text appears (3 s of clean photo, then sequential reveal)
      setTimeout(() => { go('buttons', 0); console.log('[WHEEL] BUTTONS_VISIBLE'); }, 16500),
    ];
    return () => ts.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSpinRoom]);

  // ── Orbit RAF loop ───────────────────────────────────────────────────────────
  // Drives 60 fps bubble positions + glow intensity via direct DOM mutation.
  useEffect(() => {
    if (!showSpinRoom) {
      cancelAnimationFrame(orbitRafRef2.current);
      spinPhaseRef.current     = 'idle'; // reset so the next open starts fresh
      orbitAngleRef2.current   = 0;
      orbitSpeedRef2.current   = 0;
      orbitLastTimeRef.current = 0;
      return;
    }
    const N = Math.min(items.length, 10);
    const R = 108; // orbit radius px

    const tick = (now: number) => {
      const dt = orbitLastTimeRef.current === 0
        ? 0.016
        : Math.min((now - orbitLastTimeRef.current) / 1000, 0.05);
      orbitLastTimeRef.current = now;

      // Smooth speed lerp — decelerates slightly faster than it accelerates
      const tgt  = orbitTargetRef.current;
      const cur  = orbitSpeedRef2.current;
      const diff = tgt - cur;
      orbitSpeedRef2.current += diff * Math.min(dt * (diff > 0 ? 1.6 : 2.4), 1);

      // Update each bubble — position + depth effect (front/back opacity & glow)
      const speedFrac = Math.min(orbitSpeedRef2.current / 360, 1);

      // During winner animation, freeze orbit angle AND skip all bubble DOM mutations
      // so the CSS transitions on the selected bubble run completely uncontested.
      if (spinPhaseRef.current === 'pullforward' || spinPhaseRef.current === 'arrive') {
        orbitRafRef2.current = requestAnimationFrame(tick);
        return;
      }

      // Advance orbit angle (only when not in winner phases)
      orbitAngleRef2.current = (orbitAngleRef2.current + orbitSpeedRef2.current * dt) % 360;
      const aRad = (orbitAngleRef2.current * Math.PI) / 180;

      // ── 3D Oval carousel positioning ──────────────────────────────────
      // Cards sit on a horizontal ellipse.  carouselCenter is unchanged so
      // the existing winner-selection formula (sinVal min) still picks the
      // card at θ=0 (front of oval, closest to viewer).
      const RX_OVAL = 170; // horizontal radius px
      const Y_TILT  = 30;  // back cards appear this many px above front (camera-looking-down)
      const carouselCenter = -(aRad / (Math.PI * 2)) * N;

      for (let i = 0; i < N; i++) {
        const el = orbitBubbles.current[i];
        if (!el) continue;
        const rawDist = i - carouselCenter;
        const wrapped = ((rawDist % N) + N) % N;
        const t = wrapped > N / 2 ? wrapped - N : wrapped; // signed offset from front card

        // Oval angle: t=0 → front (θ=0), t=±N/2 → back (θ=π)
        const θ    = (t / N) * Math.PI * 2;
        const sinT = Math.sin(θ);
        const cosT = Math.cos(θ);       // +1 = front, -1 = back
        const zNorm = (cosT + 1) / 2;  // 0 = back, 1 = front

        const xPx    = RX_OVAL * sinT;
        const yPx    = -Y_TILT * (1 - zNorm); // back cards rise on screen
        const sc     = 0.34 + 0.66 * zNorm;
        const op     = Math.max(0.10, 0.10 + 0.90 * zNorm);
        const blurPx = Math.max(0, (1 - zNorm) * 4.5 - 0.3);
        const rotY   = -sinT * 36;     // cards face centre tangentially
        const zi     = Math.round(1 + zNorm * 80);

        el.style.transform = `translate(calc(-50% + ${xPx.toFixed(1)}px), calc(-50% + ${yPx.toFixed(1)}px)) perspective(800px) rotateY(${rotY.toFixed(1)}deg) scale(${sc.toFixed(3)})`;
        el.style.opacity   = op.toFixed(3);
        el.style.filter    = blurPx > 0.2 ? `blur(${blurPx.toFixed(1)}px)` : '';
        el.style.zIndex    = String(zi);

        // Front card glow — pulses with spin speed
        if (zNorm > 0.85 && speedFrac > 0.12) {
          const gA = (zNorm * speedFrac * 0.80).toFixed(2);
          el.style.boxShadow = `0 0 ${Math.round(20 + speedFrac * 32)}px rgba(212,92,116,${gA}), 0 8px 28px rgba(0,0,0,0.55)`;
        } else if (zNorm > 0.85) {
          el.style.boxShadow = '0 6px 22px rgba(0,0,0,0.40), 0 0 14px rgba(212,92,116,0.20)';
        } else {
          el.style.boxShadow = '0 4px 14px rgba(0,0,0,0.32)';
        }
      }

      // Glow orb — intensity tracks orbit speed
      if (orbitGlowRef.current) {
        const frac   = Math.min(orbitSpeedRef2.current / 360, 1);
        const spread = Math.round(24 + frac * 64);
        const blur   = Math.round(14 + frac * 44);
        const alpha  = (0.12 + frac * 0.44).toFixed(2);
        orbitGlowRef.current.style.boxShadow =
          `0 0 ${blur}px ${Math.round(spread * 0.35)}px rgba(212,92,116,${alpha}),` +
          `0 0 ${blur * 2}px ${Math.round(spread * 0.7)}px rgba(212,92,116,${(+alpha * 0.5).toFixed(2)})`;
      }

      // Orbit ring border — brightens with speed
      if (orbitRingRef2.current) {
        const frac = Math.min(orbitSpeedRef2.current / 360, 1);
        orbitRingRef2.current.style.borderColor =
          `rgba(212,92,116,${(0.18 + frac * 0.52).toFixed(2)})`;
        orbitRingRef2.current.style.boxShadow = frac > 0.25
          ? `0 0 ${Math.round(10 + frac * 26)}px rgba(212,92,116,${(0.08 + frac * 0.22).toFixed(2)})`
          : 'none';
      }

      // Landing marker glow — pulses gently during slow, brightens as orbit nears 0
      if (landingMarkerRef.current) {
        const phase = spinPhaseRef.current;
        if (phase === 'slow' || phase === 'approach') {
          // Proximity: how close the nearest bubble is to 12 o'clock (sin = -1)
          let minSin = 0;
          for (let ii = 0; ii < N; ii++) {
            const base = (ii / N) * Math.PI * 2 - Math.PI / 2;
            const s = Math.sin(base + aRad);
            if (s < minSin) minSin = s;
          }
          const proximity = (-minSin); // 0..1 where 1 = exactly at top
          const speedFrac = Math.min(orbitSpeedRef2.current / 40, 1);
          const opacity = (0.55 + proximity * 0.45 * (1 - speedFrac * 0.4)).toFixed(2);
          const glowSize = Math.round(4 + proximity * 12);
          const glowAlpha = (0.40 + proximity * 0.55).toFixed(2);
          landingMarkerRef.current.style.opacity = opacity;
          landingMarkerRef.current.style.filter =
            `drop-shadow(0 0 ${glowSize}px rgba(212,92,116,${glowAlpha}))`;
        } else if (phase === 'idle' || phase === 'accelerate' || phase === 'fast') {
          landingMarkerRef.current.style.opacity = '0.45';
          landingMarkerRef.current.style.filter = 'none';
        }
      }

      orbitRafRef2.current = requestAnimationFrame(tick);
    };

    orbitRafRef2.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(orbitRafRef2.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSpinRoom]);

  // ── Pull-forward: winner orbit bubble springs from the ring → centre ────────────
  // useLayoutEffect fires synchronously before paint, so spinPhaseRef.current is
  // set to 'pullforward' before the RAF's very next tick — zero race window.
  useLayoutEffect(() => {
    if (spinRoomPhase !== 'pullforward') return;
    if (selectedIndex === null) return;

    // Gate the RAF immediately (must be first, before any DOM write)
    spinPhaseRef.current = 'pullforward';

    const winner = orbitBubbles.current[selectedIndex];
    if (!winner) return;

    // Highlight the winning carousel card with a rose border
    winner.style.border = '2px solid rgba(212,92,116,0.60)';
    winner.style.borderRadius = '16px';

    // Freeze at current DOM position (orbit angle stopped by RAF gate above)
    winner.style.transition = 'none';
    winner.style.zIndex = '25';

    // Fade + blur all other orbit bubbles
    for (let i = 0; i < Math.min(items.length, 10); i++) {
      const b = orbitBubbles.current[i];
      if (!b || i === selectedIndex) continue;
      b.style.transition = 'opacity 0.55s ease, filter 0.55s ease';
      b.style.opacity = '0';
      b.style.filter = 'blur(3px)';
    }

    // Haptic pulse as the winner starts moving
    try { (navigator as any).vibrate?.([20, 10, 40]); } catch {}

    // One RAF tick so the browser commits the frozen position, then spring to centre
    requestAnimationFrame(() => {
      winner.style.transition =
        'transform 1.35s cubic-bezier(0.12, 0.0, 0.08, 1), box-shadow 1.0s ease 0.20s';
      winner.style.transform = 'translate(-50%, -50%) perspective(800px) rotateY(0deg) scale(2.2)';
      winner.style.boxShadow = '0 0 60px 18px rgba(212,92,116,0.38), 0 0 120px 40px rgba(212,92,116,0.16)';
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinRoomPhase]);

  // ── Arrive: winner settles at centre — halo blooms ────────────────────────────
  useLayoutEffect(() => {
    if (spinRoomPhase !== 'arrive') return;

    spinPhaseRef.current = 'arrive';

    if (selectedIndex === null) return;
    const winner = orbitBubbles.current[selectedIndex];
    if (!winner) return;
    winner.style.transition =
      'transform 1.1s cubic-bezier(0.18, 0.0, 0.08, 1), box-shadow 1.1s ease';
    winner.style.transform = 'translate(-50%, -50%) perspective(800px) rotateY(0deg) scale(2.8)';
    winner.style.boxShadow =
      '0 0 90px 32px rgba(212,92,116,0.55), 0 0 180px 70px rgba(212,92,116,0.22), 0 0 260px 100px rgba(212,92,116,0.10)';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinRoomPhase]);

  useEffect(() => { return () => cancelAnimationFrame(animFrame.current); }, []);
  useEffect(() => {
    const t0 = performance.now();
    console.log("[INTENT] MOUNTED");
    return () => console.log("[INTENT] UNMOUNTED after", Math.round(performance.now() - t0), "ms");
  }, []);

  // ── Sparks purchase success: activate on landing and show toast ───────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("sparks_session");
    if (!sessionId) return;

    // Clean the URL immediately so reload/back doesn't re-trigger
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);

    let tries = 0;
    const activate = async () => {
      tries++;
      try {
        const res = await apiRequest("POST", "/api/stripe/extras-activate", { sessionId });
        const data = await res.json();
        if (res.ok && data.success) {
          queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
          const qty = (data.granted as string[])?.length ?? 1;
          toast({
            title: `✨ ${qty === 1 ? "1 Halo" : `${qty} Halos`} added`,
            description: "Spin the wheel to send a Halo tonight.",
          });
        } else if (res.status === 402 && tries < 6) {
          setTimeout(activate, 2000);
        } else {
          toast({ title: "Activation failed", description: data.message ?? "Please contact support.", variant: "destructive" });
        }
      } catch {
        if (tries < 6) setTimeout(activate, 3000);
      }
    };
    activate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stale-ring guard ──────────────────────────────────────────────────────
  // Belt-and-suspenders: stop any audio and clear all armed call sessions the
  // moment this page mounts. App.tsx location-change effect already does this
  // but may run *before* some async query resolves and potentially re-arms a
  // session from cached DB data. This guard runs AFTER mount, providing a
  // second line of defence against ringtone starting on the Intention Wheel.
  useEffect(() => {
    stopAllNonVoiceCallAudio("intent_page_mount");
    clearAllArmedSessions();
    console.log("[INTENT] RING_GUARD: stopped audio + cleared armed sessions on mount — stale ring blocked");
  }, []);

  // ── Periodic profile refresh while spin is locked ─────────────────────────
  // Keeps the wheel feeling alive — profiles rotate every 90 s so the user
  // sees a changing set of people even without an available spin.
  // Cleans up automatically when the spin becomes available again.
  useEffect(() => {
    if (canSpin || isSpinning) return;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
    }, 90_000);
    return () => clearInterval(id);
  }, [canSpin, isSpinning, queryClient]);

  if (isLoading) {
    if (intentLoadingTooLong) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4 max-w-sm">
            <LulouFlowerIcon className="w-10 h-10 text-primary/60 mx-auto" />
            <p className="font-serif text-lg font-semibold">{t("still_loading_profiles")}</p>
            <p className="text-muted-foreground text-sm">{t("loading_taking_longer")}</p>
            <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium" onClick={() => refetchProfiles()} data-testid="button-retry-intent">{t("retry_btn")}</button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">{t("loading_label")}</p>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <LulouFlowerIcon className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">{t("unable_to_load_profiles")}</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <LulouFlowerIcon className="w-10 h-10 text-primary mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">{t("no_profiles_yet")}</p>
        </div>
      </div>
    );
  }

  const dailyLikes = spinStatus?.dailyLikes ?? 0;
  const consecutiveDays = spinStatus?.consecutiveDays ?? 0;
  const streakComplete = spinStatus?.streakComplete ?? false;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" data-testid="intent-page">

      {/* ── Global keyframes ── */}
      <style>{`
        @keyframes shimmer {
          from { background-position: 200% 0; }
          to   { background-position: -200% 0; }
        }
        @keyframes spinBtn { to { transform: rotate(360deg); } }
        @keyframes spinBtnPulse {
          0%, 100% { box-shadow: 0 0 0 6px rgba(188,78,96,0.12), 0 0 24px 8px rgba(188,78,96,0.24), 0 6px 18px rgba(0,0,0,0.22); }
          50%       { box-shadow: 0 0 0 10px rgba(188,78,96,0.18), 0 0 44px 16px rgba(188,78,96,0.40), 0 10px 28px rgba(0,0,0,0.30); }
        }
        @keyframes reticleGlow {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 1; }
        }
        @keyframes selectedRing {
          0%   { box-shadow: 0 0 0 0px rgba(255,255,255,0.8), 0 0 0 0px rgba(212,92,116,0.9); }
          60%  { box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 0 0 7px rgba(212,92,116,0.85), 0 0 48px 20px rgba(212,92,116,0.55); }
          100% { box-shadow: 0 0 0 2.5px rgba(255,255,255,0.85), 0 0 0 5px rgba(212,92,116,0.8), 0 0 36px 14px rgba(212,92,116,0.45); }
        }
        @keyframes slideUpProfile {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);   opacity: 1; }
        }
        @keyframes profileNameAppear {
          from { transform: translateY(10px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes matchRevealBg {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes matchRevealPhoto {
          from { transform: scale(0.50); opacity: 0; }
          to   { transform: scale(1);    opacity: 1; }
        }
        @keyframes matchRevealTagline {
          from { transform: translateY(18px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes matchRevealCta {
          from { transform: translateY(28px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes glowPulse {
          0%, 100% { opacity: 0.80; transform: scale(1); }
          50%       { opacity: 1;    transform: scale(1.10); }
        }
        @keyframes rotateSlow {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes cardSlideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes floatParticle {
          0%   { transform: translateY(0px)    scale(1);    opacity: 0; }
          14%  { opacity: 1; }
          82%  { opacity: 0.52; }
          100% { transform: translateY(-150px) scale(0.45); opacity: 0; }
        }
        @keyframes previewFadeIn {
          from { opacity: 0; transform: translateY(5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes previewBubbleIn {
          from { opacity: 0; transform: scale(0.65); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes purchaseBgIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes purchaseCardIn {
          from { transform: translateY(32px); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes orbitPulse {
          0%, 100% { transform: translate(-50%, -50%) scale(0.88); opacity: 0.44; }
          50%       { transform: translate(-50%, -50%) scale(1.06); opacity: 0.90; }
        }
        @keyframes rotateOrbit {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes counterRotate {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to   { transform: translate(-50%, -50%) rotate(-360deg); }
        }
        @keyframes wheelDimIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes winnerGlow {
          0%   { box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 0 0 7px rgba(212,92,116,0.9), 0 0 48px 20px rgba(212,92,116,0.55); }
          50%  { box-shadow: 0 0 0 4px rgba(255,255,255,1.0), 0 0 0 10px rgba(212,92,116,1.0), 0 0 72px 32px rgba(212,92,116,0.75); }
          100% { box-shadow: 0 0 0 3px rgba(255,255,255,0.9), 0 0 0 7px rgba(212,92,116,0.9), 0 0 48px 20px rgba(212,92,116,0.55); }
        }
        @keyframes spinRoomIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes spinRoomOrbit {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes spinRoomOrbitFast {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes spinRoomGlow {
          0%, 100% { opacity: 0.55; transform: translate(-50%,-50%) scale(1); }
          50%       { opacity: 1;    transform: translate(-50%,-50%) scale(1.18); }
        }
        @keyframes spinRoomReveal {
          from { transform: translateY(40px); opacity: 0; }
          to   { transform: translateY(0);   opacity: 1; }
        }
        @keyframes haloSentPulse {
          0%   { transform: scale(0.85); opacity: 0; }
          60%  { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1);    opacity: 1; }
        }
        @keyframes haloRingExpand {
          0%   { transform: translate(-50%,-50%) scale(1);    opacity: 0.85; }
          50%  { transform: translate(-50%,-50%) scale(2.8);  opacity: 0.40; }
          100% { transform: translate(-50%,-50%) scale(4.6);  opacity: 0; }
        }
        @keyframes haloRingExpand2 {
          0%   { transform: translate(-50%,-50%) scale(1);    opacity: 0.55; }
          100% { transform: translate(-50%,-50%) scale(3.4);  opacity: 0; }
        }
        @keyframes srRevealBg {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes srWinnerIn {
          0%   { transform: scale(0.58) translateY(32px); filter: blur(14px); opacity: 0; }
          55%  { transform: scale(1.04) translateY(-4px);  filter: blur(0px);  opacity: 1; }
          75%  { transform: scale(0.98) translateY(2px);   filter: blur(0px);  opacity: 1; }
          100% { transform: scale(1.00) translateY(0);     filter: blur(0px);  opacity: 1; }
        }
        @keyframes srTextIn {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
        @keyframes srButtonsIn {
          from { opacity: 0; transform: translateY(24px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
        @keyframes srParticle {
          0%   { opacity: 0; transform: translateY(0px)    scale(1);    }
          12%  { opacity: 0.85; }
          80%  { opacity: 0.22; }
          100% { opacity: 0;   transform: translateY(-130px) scale(0.25); }
        }
        @keyframes srGlowPulse {
          0%, 100% { transform: translate(-50%,-50%) scale(1.00); opacity: 0.65; }
          50%       { transform: translate(-50%,-50%) scale(1.18); opacity: 1.00; }
        }
        @keyframes srBreathe {
          0%, 100% { transform: scale(1.00); }
          50%       { transform: scale(1.09); }
        }
        @keyframes srWatchRotate {
          from { transform: translate(-50%,-50%) rotate(0deg); }
          to   { transform: translate(-50%,-50%) rotate(360deg); }
        }
        @keyframes srAmbientPulse {
          0%, 100% { opacity: 0.45; transform: translate(-50%,-50%) scale(1.00); }
          50%       { opacity: 0.80; transform: translate(-50%,-50%) scale(1.08); }
        }
      `}</style>

      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-1">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
            {t("intention_wheel_title")}
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleMute}
              data-testid="button-toggle-sound"
              title={muted ? t("enable_sound_title") : t("mute_sound_title")}
              style={{
                width: 32, height: 32, borderRadius: "50%",
                border: "1.5px solid hsl(var(--border))",
                background: "transparent",
                color: "hsl(var(--muted-foreground))",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", outline: "none", transition: "color 0.2s",
              }}
            >
              {muted ? <VolumeX style={{ width: 15, height: 15 }} /> : <Volume2 style={{ width: 15, height: 15 }} />}
            </button>
            <div data-testid="streak-indicator">
              {streakComplete ? (
                <Badge variant="secondary" className="text-xs" data-testid="badge-streak-complete">
                  <Star className="w-3 h-3 me-1" /> {t("spin_earned_label")}
                </Badge>
              ) : (
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                    <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i < consecutiveDays ? "bg-primary" : "bg-muted-foreground/30"}`} data-testid={`streak-dot-${i}`} />
                  ))}
                  <span className="text-xs text-muted-foreground ms-1" data-testid="text-likes-today">{dailyLikes}/{DAILY_LIKE_GOAL}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Wheel stage ── */}
      <div
        dir={isRTL ? "rtl" : "ltr"}
        className={`flex-1 flex flex-col items-center overflow-hidden ${isCompact ? "justify-start pt-4 gap-2" : "justify-center gap-5"} transition-all duration-700`}
        style={isSpinning ? {
          background: "radial-gradient(ellipse 90% 65% at 50% 40%, hsl(350 45% 52% / 0.28) 0%, hsl(350 45% 52% / 0.08) 45%, transparent 72%)",
          transition: "background 0.5s ease",
        } : { transition: "background 0.5s ease" }}
      >
        <div
          className="relative select-none touch-manipulation"
          style={{
            width: "100%", height: itemHeight + wheelBufferY,
            perspective: "1000px",
            transition: dispersed ? "opacity 0.55s ease" : undefined,
            opacity: dispersed ? 0 : 1,
            pointerEvents: dispersed ? "none" : "auto",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          data-testid="intent-wheel"
        >
          <ConfettiBurst active={showConfetti} />

          {/* ── Spin dim overlay — darkens wheel cards during active spin ── */}
          {isSpinning && (
            <div style={{
              position: "absolute", inset: 0, zIndex: 120, pointerEvents: "none",
              background: "radial-gradient(ellipse 65% 55% at 50% 50%, rgba(188,78,96,0.22) 0%, rgba(0,0,0,0.62) 100%)",
              animation: "wheelDimIn 0.45s ease forwards",
              borderRadius: 20,
            }} />
          )}

          {/* ── Profile orbit ring — rotating photo ring during active spin ── */}
          {isSpinning && items.length > 0 && (
            <div style={{
              position: "absolute", left: "50%", top: "50%",
              width: 0, height: 0, zIndex: 160, pointerEvents: "none",
              animation: "rotateOrbit 5s linear infinite",
              transformOrigin: "0 0",
            }}>
              {items.slice(0, Math.min(items.length, 10)).map((profile, i) => {
                const n = Math.min(items.length, 10);
                const angleDeg = (i / n) * 360 - 90;
                const RING_R = 140;
                const x = Math.cos(angleDeg * Math.PI / 180) * RING_R;
                const y = Math.sin(angleDeg * Math.PI / 180) * RING_R;
                return (
                  <div
                    key={profile.userId}
                    style={{
                      position: "absolute", left: x, top: y,
                      width: 44, height: 44, borderRadius: "50%", overflow: "hidden",
                      boxShadow: "0 0 0 2.5px rgba(255,255,255,0.55), 0 0 20px rgba(188,78,96,0.70), 0 4px 14px rgba(0,0,0,0.50)",
                      animation: "counterRotate 5s linear infinite",
                      transformOrigin: "22px 22px",
                    }}
                  >
                    <ProfilePhoto userId={profile.userId} className="w-full h-full" />
                  </div>
                );
              })}
            </div>
          )}

          <div
            className="absolute left-1/2 top-1/2"
            style={{
              transformStyle: "preserve-3d",
              transform: `translateX(-50%) translateY(-50%) rotateY(${-angle}deg)`,
              width: itemWidth, height: itemHeight,
            }}
          >
            {items.map((profile, i) => {
              const itemAngle = i * angleStep;
              const isSelected = i === selectedIndex;
              const relativeAngle = ((((-angle + itemAngle) % 360) + 360) % 360);
              const cosVal = Math.cos((relativeAngle * Math.PI) / 180);
              const depthFactor = (cosVal + 1) / 2;
              const cardScale = 0.60 + depthFactor * 0.40;
              const glowAlpha = Math.max(0, Math.pow(cosVal, 2.5));

              const disperseX = dispersed && !isSelected ? (Math.random() - 0.5) * 900 : 0;
              const disperseY = dispersed && !isSelected ? (Math.random() - 0.5) * 700 : 0;

              const boxShadow = isSelected && !dispersed
                ? undefined
                : depthFactor > 0.75 && !dispersed
                ? `0 0 ${Math.round(glowAlpha * 28)}px ${Math.round(glowAlpha * 12)}px rgba(188,78,96,${(glowAlpha * 0.38).toFixed(2)}), 0 8px 24px rgba(0,0,0,0.32)`
                : "0 4px 18px rgba(0,0,0,0.22)";

              return (
                <div
                  key={profile.id}
                  style={{
                    width: itemWidth, height: itemHeight,
                    borderRadius: 20, overflow: "hidden",
                    position: "absolute", left: 0, top: 0,
                    transform: dispersed && !isSelected
                      ? `rotateY(${itemAngle}deg) translateZ(${radius}px) translate(${disperseX}px, ${disperseY}px) scale(0)`
                      : isSelected && !dispersed
                      ? `rotateY(${itemAngle}deg) translateZ(${radius}px) scale(${(cardScale * 1.10).toFixed(3)})`
                      : `rotateY(${itemAngle}deg) translateZ(${radius}px) scale(${cardScale})`,
                    opacity: dispersed && !isSelected ? 0 : (0.16 + depthFactor * 0.84),
                    zIndex: Math.round(depthFactor * 100),
                    boxShadow,
                    animation: isSelected && !dispersed ? "winnerGlow 1.6s ease-in-out infinite" : undefined,
                    transition: dispersed ? "all 0.7s cubic-bezier(0.4, 0, 0.2, 1)" : "box-shadow 0.3s ease",
                  }}
                  data-testid={`intent-profile-${i}`}
                >
                  <ProfilePhoto userId={profile.userId} className="w-full h-full pointer-events-none" />
                  <div style={{ position: "absolute", inset: 0, background: "linear-gradient(175deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.10) 58%, rgba(0,0,0,0.82) 100%)", pointerEvents: "none" }} />
                  <div style={{
                    position: "absolute", bottom: 0, left: 0, right: 0, padding: "10px 12px 13px", pointerEvents: "none",
                    animation: isSelected && !dispersed ? "profileNameAppear 0.4s 0.2s ease both" : undefined,
                  }}>
                    <p style={{ color: "#fff", fontSize: 13, fontWeight: 700, letterSpacing: "0.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textShadow: "0 1px 8px rgba(0,0,0,0.65)" }}>
                      {profile.firstName}{profile.age ? `, ${profile.age}` : ""}
                    </p>
                  </div>
                  {isSelected && !dispersed && (
                    <div style={{ position: "absolute", inset: 0, borderRadius: 20, boxShadow: "inset 0 0 0 2.5px rgba(255,255,255,0.80)", pointerEvents: "none" }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Centre reticle */}
          {!dispersed && (
            <div style={{
              position: "absolute", left: "50%", top: "50%",
              transform: "translateX(-50%) translateY(-50%)",
              width: itemWidth + 16, height: itemHeight + 16, borderRadius: 26,
              border: isSpinning ? "1.5px solid rgba(188,78,96,0.55)" : "1.5px solid rgba(188,78,96,0.25)",
              boxShadow: isSpinning ? "0 0 32px 8px rgba(188,78,96,0.20), inset 0 0 24px rgba(188,78,96,0.10)" : "0 0 16px 4px rgba(188,78,96,0.08), inset 0 0 12px rgba(188,78,96,0.05)",
              animation: isSpinning ? "reticleGlow 0.6s ease-in-out infinite" : "reticleGlow 2.8s ease-in-out infinite",
              pointerEvents: "none", zIndex: 200,
              transition: "border-color 0.4s, box-shadow 0.4s",
            }} />
          )}
        </div>

        {/* ── Candidates preview strip ── */}
        {/* Always shown (regardless of canSpin) so users can see who is on the
            wheel and feel engaged even while waiting for their next free spin. */}
        {!isSpinning && !dispersed && !showPurchase && !showProfile && (
          <CandidatesPreview items={items} onTap={setPreviewProfile} />
        )}

        {/* ── Spin button & streak ── */}
        {!dispersed && !showPurchase && (
          <div className="flex flex-col items-center gap-4 px-6 w-full max-w-xs mx-auto">
            {canSpin ? (
              <button
                onClick={spinWheel}
                disabled={isSpinning || items.length === 0}
                style={{
                  width: 96, height: 96, borderRadius: "50%", border: "none",
                  background: isSpinning
                    ? "radial-gradient(circle at 50% 35%, #e06278, #a83c55)"
                    : "radial-gradient(circle at 50% 35%, #d45c74, #9d3550)",
                  color: "#fff", cursor: isSpinning ? "default" : "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5,
                  animation: !isSpinning && canSpin ? "spinBtnPulse 2.6s ease-in-out infinite" : "none",
                  transition: "background 0.3s ease, transform 0.15s ease",
                  outline: "none", WebkitTapHighlightColor: "transparent", flexShrink: 0,
                }}
                onMouseEnter={e => { if (!isSpinning) (e.currentTarget as HTMLElement).style.transform = "scale(1.07)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.95)"; }}
                onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1.07)"; }}
                data-testid="button-spin"
              >
                <RotateCw style={{ width: 26, height: 26, animation: isSpinning ? "spinBtn 0.65s linear infinite" : "none" }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.13em", textTransform: "uppercase", opacity: 0.93 }}>
                  {isSpinning ? "…" : t("spin_label")}
                </span>
              </button>
            ) : (
              <button
                onClick={() => setShowPurchase(true)}
                style={{
                  width: 96, height: 96, borderRadius: "50%",
                  border: "1.5px solid hsl(var(--border))",
                  background: "linear-gradient(145deg, hsl(var(--muted)), hsl(var(--muted-foreground)/0.08))",
                  color: "hsl(var(--muted-foreground))", cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5,
                  boxShadow: "0 4px 14px rgba(0,0,0,0.10)",
                  transition: "transform 0.15s ease", outline: "none", WebkitTapHighlightColor: "transparent",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1.05)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                data-testid="button-spin-locked"
              >
                <Lock style={{ width: 20, height: 20 }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.13em", textTransform: "uppercase", opacity: 0.50 }}>
                  {t("spin_label")}
                </span>
              </button>
            )}

            {/* Purchased Sparks remaining badge */}
            {(spinStatus?.purchasedSpins ?? 0) > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "rgba(212,92,116,0.12)",
                border: "1px solid rgba(212,92,116,0.30)",
                borderRadius: 20, padding: "5px 12px",
                marginTop: -4,
              }}>
                <span style={{ fontSize: 12, color: "rgba(212,92,116,0.95)", fontWeight: 700 }}>
                  ✨ {spinStatus!.purchasedSpins} Halo{spinStatus!.purchasedSpins === 1 ? "" : "s"} remaining
                </span>
              </div>
            )}

            {/* CTA hint below the locked button */}
            {!canSpin && (
              <p style={{
                fontSize: 11, textAlign: "center",
                color: "hsl(var(--muted-foreground))",
                lineHeight: 1.4, marginTop: -6,
              }}>
                {streakComplete
                  ? t("spin_earned_label")
                  : t("buy_spins_or_earn_free")}
              </p>
            )}

            {!streakComplete && (
              <div className="w-full space-y-1.5">
                <div className="flex items-center gap-2">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => {
                    const isCurrentDay = i === consecutiveDays;
                    const isDone = i < consecutiveDays;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full h-1.5 rounded-full overflow-hidden bg-muted">
                          {isDone ? <div className="w-full h-full bg-primary rounded-full" /> :
                           isCurrentDay ? <div className="h-full bg-primary/60 rounded-full transition-all duration-500" style={{ width: `${Math.min(dailyLikes / DAILY_LIKE_GOAL, 1) * 100}%` }} /> : null}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {isDone ? "✓" : isCurrentDay ? `${dailyLikes}/${DAILY_LIKE_GOAL}` : `${t("day_label")} ${i + 1}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  {t("like_daily_earn_spin_desc").replace("{n}", String(DAILY_LIKE_GOAL)).replace("{days}", String(STREAK_GOAL))}
                </p>
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── Purchase overlay ──
           Rendered at z-[200] to sit above 3D wheel cards (which can reach z:100
           via 3D stacking context). A dark blurred backdrop covers the wheel
           entirely — freezing it visually, hiding card glow paths, and balancing
           the left/right card geometry. The Card slides up from the bottom.      */}
      {showPurchase && !showProfile && (
        <div
          className="absolute inset-0 z-[200] flex flex-col"
          style={{
            background: "rgba(8,2,14,0.56)",
            backdropFilter: "blur(11px) saturate(0.75)",
            WebkitBackdropFilter: "blur(11px) saturate(0.75)",
            animation: "purchaseBgIn 0.28s ease both",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowPurchase(false); }}
          data-testid="purchase-spins-backdrop"
        >
          <div
            className="mt-auto px-5 pb-8 w-full max-w-sm mx-auto"
            style={{ animation: "purchaseCardIn 0.38s 0.06s cubic-bezier(0.16, 1, 0.3, 1) both" }}
            data-testid="purchase-spins-popup"
          >
            <Card className="p-6 space-y-5">
              <div className="text-center space-y-2">
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <Crown className="w-7 h-7 text-primary" />
                </div>
                <h3 className="font-serif text-xl font-bold">Want more Halos?</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {streakComplete
                    ? t("earned_spin_desc")
                    : t("build_streak_desc").replace("{n}", String(STREAK_GOAL))}
                </p>
              </div>
              <div className="space-y-2">
                <Button className="w-full gap-2" onClick={() => { setShowPurchase(false); setShowSpinExtras(true); }} data-testid="button-get-halos">
                  ✨ Get Halos
                </Button>
              </div>
              {!streakComplete && (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-xs font-medium text-center text-muted-foreground">{t("or_earn_free_spin")}</p>
                  <div className="flex items-center gap-3">
                    {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                      <div key={i} className={`flex-1 h-2 rounded-full ${i < consecutiveDays ? "bg-primary" : "bg-muted"}`} />
                    ))}
                    <span className="text-xs font-medium whitespace-nowrap">{consecutiveDays}/{STREAK_GOAL}</span>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    {t("send_likes_streak_desc").replace("{n}", String(DAILY_LIKE_GOAL)).replace("{days}", String(STREAK_GOAL))}
                  </p>
                </div>
              )}
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowPurchase(false)} data-testid="button-dismiss-purchase">
                {t("maybe_later")}
              </Button>
            </Card>
          </div>
        </div>
      )}

      {/* ── Bubble tap preview — photo-only modal ── */}
      {/* Opens when a user taps a profile bubble in the CandidatesPreview strip.
          Shows only the profile photo + name. Tap backdrop or X to dismiss. */}
      {previewProfile && !showProfile && !showPurchase && (
        <div
          className="absolute inset-0 z-[250] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.88)" }}
          onClick={() => setPreviewProfile(null)}
          data-testid="preview-photo-backdrop"
        >
          <div
            className="relative mx-5 w-full max-w-xs"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative rounded-2xl overflow-hidden shadow-2xl" style={{ aspectRatio: "3/4" }}>
              <ProfilePhoto userId={previewProfile.userId} className="w-full h-full" />
              <div style={{
                position: "absolute", inset: 0,
                background: "linear-gradient(175deg, rgba(0,0,0,0) 50%, rgba(0,0,0,0.75) 100%)",
                pointerEvents: "none",
              }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 18px 20px" }}>
                <p className="text-white font-bold text-xl" style={{ textShadow: "0 1px 8px rgba(0,0,0,0.7)" }}>
                  {previewProfile.firstName}{previewProfile.age ? `, ${previewProfile.age}` : ""}
                </p>
                {previewProfile.location && (
                  <p className="text-white/70 text-sm mt-0.5">{previewProfile.location}</p>
                )}
              </div>
            </div>
            <button
              className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
              onClick={() => setPreviewProfile(null)}
              data-testid="button-close-preview"
            >
              <X className="w-4 h-4 text-white" />
            </button>
            <p className="text-center text-white/40 text-xs mt-3">
              {t("spin_random_desc")}
            </p>
          </div>
        </div>
      )}

      {/* ── Profile detail sheet ── */}
      {showProfile && selectedProfile && (
        <div
          className="absolute inset-0 z-50 bg-background flex flex-col"
          style={{ animation: "slideUpProfile 0.52s cubic-bezier(0.16, 1, 0.3, 1) forwards" }}
          data-testid="intent-profile-detail"
        >
          <div className="flex-1 overflow-y-auto">

            {/* ── Tonight's Connection hero ── */}
            <div style={{
              padding: "22px 20px 16px",
              background: "linear-gradient(180deg, hsl(350 45% 52% / 0.07) 0%, transparent 100%)",
              textAlign: "center",
              position: "relative",
            }}>
              <p style={{
                fontSize: 9, fontWeight: 800, letterSpacing: "0.28em",
                textTransform: "uppercase", color: "hsl(350 45% 52%)",
                marginBottom: 8,
                animation: "profileNameAppear 0.38s 0.10s ease both",
              }}>
                Tonight's Connection
              </p>
              <h2
                className="font-serif"
                style={{
                  fontSize: "clamp(26px, 7vw, 32px)", fontWeight: 700,
                  letterSpacing: "-0.02em", lineHeight: 1.1,
                  color: "hsl(var(--foreground))", margin: 0,
                  animation: "profileNameAppear 0.44s 0.16s ease both",
                }}
                data-testid="text-detail-name"
              >
                {selectedProfile.firstName}{selectedProfile.age ? `, ${selectedProfile.age}` : ""}
                {selectedProfile.photoVerified && (
                  <BadgeCheck className="inline w-5 h-5 text-primary ms-2 align-middle" data-testid="icon-intent-verified" />
                )}
              </h2>
              {selectedProfile.signals && selectedProfile.signals.length > 0 && (
                <p style={{
                  fontSize: 13, fontStyle: "italic",
                  color: "hsl(var(--muted-foreground))",
                  marginTop: 6,
                  animation: "profileNameAppear 0.48s 0.22s ease both",
                }}>
                  {selectedProfile.signals[0]}
                </p>
              )}
              {(selectedProfile.location || selectedProfile.height) && (
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexWrap: "wrap", gap: "4px 10px", marginTop: 8,
                  animation: "profileNameAppear 0.42s 0.28s ease both",
                }}>
                  {selectedProfile.location && (
                    <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12, color: "hsl(var(--muted-foreground))" }}>
                      <MapPin style={{ width: 11, height: 11 }} />
                      <span data-testid="text-detail-location">{selectedProfile.location}</span>
                    </span>
                  )}
                  {selectedProfile.height && (
                    <span style={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} data-testid="text-detail-height">
                      {selectedProfile.height}
                    </span>
                  )}
                </div>
              )}
              <button
                onClick={closeProfile}
                data-testid="button-close-profile"
                style={{
                  position: "absolute", top: 12, right: 12,
                  width: 30, height: 30, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "hsl(var(--muted)/0.7)", border: "1px solid hsl(var(--border))",
                  cursor: "pointer", outline: "none",
                }}
              >
                <X style={{ width: 14, height: 14, color: "hsl(var(--muted-foreground))" }} />
              </button>
            </div>

            {/* ③ Profile picture — single-image, aspect-ratio constrained (not a carousel) */}
            <div data-testid="img-intent-detail-photo" className="w-full aspect-[3/4] max-h-[54vh] overflow-hidden">
              <ProfilePhoto userId={selectedProfile.userId} className="w-full h-full" />
            </div>

            <div className="px-5 pt-4 space-y-4 pb-36">

              {/* ④ 3× Elevate section */}
              <div
                role="button"
                onClick={() => setShowElevateInReveal(true)}
                data-testid="button-detail-elevate"
                className="flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all active:scale-[0.98]"
                style={{
                  background: "hsl(350 45% 52% / 0.06)",
                  border: "1px solid hsl(350 45% 52% / 0.18)",
                }}
              >
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, hsl(350 45% 60%), hsl(350 45% 38%))" }}
                >
                  <span className="text-white text-xs font-extrabold tracking-tight">3×</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground leading-tight">{t("elevate_3x_title")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t("elevate_3x_desc")}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </div>

              {/* ⑤ Reveal text — profile details */}
              {selectedProfile.datingIntent && (
                <Badge variant="secondary" data-testid="text-detail-intent">{selectedProfile.datingIntent}</Badge>
              )}

              {selectedProfile.signals && selectedProfile.signals.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_signals")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.signals.map((signal, i) => (
                      <Badge key={i} variant="outline" data-testid={`badge-detail-signal-${i}`}>{signal}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.greenFlags && selectedProfile.greenFlags.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_green_flags")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.greenFlags.map((flag, i) => (
                      <Badge key={i} variant="outline" data-testid={`badge-detail-flag-${i}`}>{flag}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.conversationStarters && selectedProfile.conversationStarters.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <MessageCircle className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_conversation_starters")}</p>
                  </div>
                  <div className="space-y-2">
                    {selectedProfile.conversationStarters.map((starter, i) => (
                      <div key={i} className="rounded-md p-3 text-sm bg-muted/50" data-testid={`text-detail-starter-${i}`}>
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
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_ask_me")}</p>
                  </div>
                  <div className="space-y-2">
                    {selectedProfile.questions.map((question, i) => (
                      <div key={i} className="rounded-md p-3 text-sm border" data-testid={`text-detail-question-${i}`}>
                        <p>{question}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.photos && selectedProfile.photos.length > 1 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_photos")}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedProfile.photos.slice(1).map((photo, i) => (
                      <img key={i} src={photo} alt={`${selectedProfile.firstName} photo ${i + 2}`} className="w-full aspect-square object-cover rounded-md" data-testid={`img-detail-photo-${i + 1}`} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ⑥ CTA action bar */}
          <div className="absolute bottom-0 start-0 end-0 border-t" style={{ background: "hsl(var(--background)/0.96)", backdropFilter: "blur(16px)" }}>
            <div className="px-5 pt-4 pb-6">
              <div className="flex items-center gap-3">
                {/* Skip button */}
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-2xl border transition-all active:scale-95"
                  style={{
                    background: "hsl(var(--muted)/0.5)",
                    borderColor: "hsl(var(--border))",
                  }}
                  onClick={closeProfile}
                  data-testid="button-intent-skip"
                  aria-label={t("skip_label")}
                >
                  <Moon className="w-5 h-5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-semibold tracking-[0.12em] uppercase">CLOSE 🌙</span>
                </button>

                {/* Save For Later button */}
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-2xl border transition-all active:scale-95 disabled:opacity-50"
                  style={{
                    background: "hsl(var(--muted)/0.5)",
                    borderColor: "hsl(155 25% 50% / 0.4)",
                  }}
                  onClick={() => selectedProfile && saveForLater.mutate(selectedProfile.userId)}
                  disabled={saveForLater.isPending}
                  data-testid="button-intent-save-later"
                  aria-label={t("save_for_later_label")}
                >
                  {saveForLater.isPending
                    ? <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                    : <Star className="w-5 h-5 text-muted-foreground" />
                  }
                  <span className="text-xs text-muted-foreground font-medium tracking-wide">{t("save_for_later_label")}</span>
                </button>

                {/* ✨ Send Halo button */}
                <button
                  className="flex-[2] flex flex-col items-center gap-1.5 py-3 rounded-2xl transition-all active:scale-95 disabled:opacity-60"
                  style={{
                    background: "linear-gradient(135deg, #d45c74 0%, #9d3550 100%)",
                    boxShadow: "0 4px 20px rgba(188,78,96,0.45), 0 2px 8px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.15)",
                  }}
                  onClick={() => selectedProfile && sendSpark.mutate(selectedProfile.userId)}
                  disabled={sendSpark.isPending}
                  data-testid="button-intent-send-halo"
                  aria-label="Send Halo"
                >
                  {sendSpark.isPending
                    ? <Loader2 className="w-5 h-5 text-white animate-spin" />
                    : <span className="text-lg leading-none">✨</span>
                  }
                  <span className="text-xs text-white font-semibold tracking-[0.12em] uppercase">
                    {sendSpark.isPending ? "Sending…" : "Send Halo"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SpinRoom overlay — cinematic 10-12 s reveal, position:fixed ── */}
      {showSpinRoom && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "#0d0812",
            overflow: "hidden",
            animation: "spinRoomIn 0.28s ease forwards",
          }}
          data-testid="spin-room-overlay"
        >
          {/* ── CAROUSEL STAGE — Cover Flow horizontal carousel ── */}
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center",
            opacity: (spinRoomPhase === 'reveal' || spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') ? 0 : 1,
            transition: "opacity 1.4s cubic-bezier(0.4,0,0.2,1)",
            pointerEvents: (spinRoomPhase === 'reveal' || spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') ? "none" : "auto",
          }}>
            {/* Deep ambient radial glow behind carousel */}
            <div style={{
              position: "absolute", top: "48%", left: "50%",
              transform: "translate(-50%,-50%)",
              width: 460, height: 340, borderRadius: "50%",
              background: "radial-gradient(ellipse at center, rgba(212,92,116,0.14) 0%, transparent 68%)",
              pointerEvents: "none",
              opacity: spinRoomPhase === 'fast' ? 1 : 0.55,
              transition: "opacity 1.2s ease",
            }} />

            {/* Header — "TONIGHT'S CONNECTION" */}
            <div style={{
              position: "relative", zIndex: 2, textAlign: "center",
              paddingTop: "max(env(safe-area-inset-top,0px), 28px)",
              paddingBottom: 6, paddingLeft: 56, paddingRight: 56, width: "100%",
            }}>
              <p style={{
                fontSize: 9, fontWeight: 900, letterSpacing: "0.36em",
                textTransform: "uppercase", color: "rgba(212,92,116,0.88)",
                marginBottom: 7,
              }}>
                {t("spin_room_title")}
              </p>
              <p style={{
                fontSize: 12, color: "rgba(255,255,255,0.28)",
                fontStyle: "italic", margin: 0,
                opacity: spinRoomPhase === 'accelerate' ? 1 : 0,
                transition: "opacity 0.7s ease",
              }}>
                {t("spin_room_subtitle")}
              </p>
            </div>

            {/* ── Carousel area ── */}
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              position: "relative", zIndex: 2, width: "100%",
            }}>

              {/* Landing indicator — glowing rose-gold diamond pointer above centre slot */}
              <div
                ref={landingMarkerRef}
                style={{
                  position: "absolute",
                  top: "calc(50% - 118px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex", flexDirection: "column", alignItems: "center",
                  pointerEvents: "none", zIndex: 100,
                  opacity: 0.45,
                  transition: "opacity 0.5s ease, filter 0.5s ease",
                }}
              >
                {/* Crown jewel — rose-gold rotated square (diamond) */}
                <div style={{
                  width: 11, height: 11,
                  background: "linear-gradient(135deg, #fce4e9 0%, #d45c74 38%, #9d3550 100%)",
                  transform: "rotate(45deg)",
                  boxShadow: "0 0 7px rgba(212,92,116,0.70), 0 0 18px rgba(212,92,116,0.34)",
                  borderRadius: "2px",
                  flexShrink: 0,
                }} />
                {/* Stem */}
                <div style={{
                  width: 1.5, height: 14,
                  background: "linear-gradient(to bottom, rgba(212,92,116,0.85), rgba(212,92,116,0.12))",
                  marginTop: -1, flexShrink: 0,
                }} />
                {/* Touch-point dot */}
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "rgba(212,92,116,0.90)",
                  boxShadow: "0 0 6px 2px rgba(212,92,116,0.55)",
                  flexShrink: 0,
                }} />
              </div>

              {/* 3D oval stage — no overflow:hidden so pullforward card can scale freely */}
              <div style={{
                position: "relative", width: "100%", height: 260,
                flexShrink: 0,
              }}>
                {/* Ambient glow orb at oval centre — box-shadow driven by RAF */}
                <div ref={orbitGlowRef} style={{
                  position: "absolute", top: "50%", left: "50%",
                  width: 160, height: 160, borderRadius: "50%",
                  transform: "translate(-50%,-50%)",
                  pointerEvents: "none",
                  animation: "srAmbientPulse 2.8s ease-in-out infinite",
                }} />

                {/* Outer neon Halo ring — circle tilted via rotateX to look like a horizontal oval hoop */}
                <div ref={orbitRingRef2} style={{
                  position: "absolute", top: "50%", left: "50%",
                  width: 380, height: 380,
                  marginLeft: -190, marginTop: -190,
                  borderRadius: "50%",
                  border: "1px solid rgba(212,92,116,0.28)",
                  transform: "perspective(800px) rotateX(76deg)",
                  pointerEvents: "none", zIndex: 1,
                }} />

                {/* Inner guide ring — slightly smaller, more transparent */}
                <div style={{
                  position: "absolute", top: "50%", left: "50%",
                  width: 300, height: 300,
                  marginLeft: -150, marginTop: -150,
                  borderRadius: "50%",
                  border: "1px solid rgba(212,92,116,0.12)",
                  transform: "perspective(800px) rotateX(76deg)",
                  pointerEvents: "none", zIndex: 1,
                }} />

                {/* Profile cards — RAF-positioned on the 3D oval */}
                {items.slice(0, Math.min(items.length, 10)).map((item, i) => {
                  const N2 = Math.min(items.length, 10);
                  // Static initial oval positions (RAF overwrites on first frame)
                  const t0s   = ((i % N2) + N2) % N2;
                  const ts    = t0s > N2 / 2 ? t0s - N2 : t0s;
                  const θ0    = (ts / N2) * Math.PI * 2;
                  const sinT0 = Math.sin(θ0);
                  const cosT0 = Math.cos(θ0);
                  const zN0   = (cosT0 + 1) / 2;
                  const xPx0  = (170 * sinT0).toFixed(1);
                  const yPx0  = (-30 * (1 - zN0)).toFixed(1);
                  const sc0   = (0.34 + 0.66 * zN0).toFixed(3);
                  const op0   = Math.max(0.10, 0.10 + 0.90 * zN0).toFixed(3);
                  const rotY0 = (-sinT0 * 36).toFixed(1);
                  return (
                    <div
                      key={item.userId}
                      ref={el => { orbitBubbles.current[i] = el; }}
                      style={{
                        position: "absolute", top: "50%", left: "50%",
                        transform: `translate(calc(-50% + ${xPx0}px), calc(-50% + ${yPx0}px)) perspective(800px) rotateY(${rotY0}deg) scale(${sc0})`,
                        width: 110, height: 165,
                        borderRadius: 16,
                        overflow: "hidden",
                        opacity: Number(op0),
                        boxShadow: "0 4px 14px rgba(0,0,0,0.32)",
                        flexShrink: 0,
                        willChange: "transform, opacity, box-shadow",
                      }}
                    >
                      <ProfilePhoto userId={item.userId} className="w-full h-full" />
                      {/* Bottom gradient */}
                      <div style={{
                        position: "absolute", inset: 0,
                        background: "linear-gradient(to bottom, transparent 50%, rgba(0,0,0,0.65) 100%)",
                        pointerEvents: "none",
                      }} />
                      {/* Rose glass border */}
                      <div style={{
                        position: "absolute", inset: 0, borderRadius: 16,
                        border: "1.5px solid rgba(212,92,116,0.28)",
                        pointerEvents: "none",
                      }} />
                    </div>
                  );
                })}

                {/* Left / right vignette fades */}
                <div style={{
                  position: "absolute", top: 0, left: 0, bottom: 0, width: 70,
                  background: "linear-gradient(to right, #0d0812 0%, transparent 100%)",
                  pointerEvents: "none", zIndex: 15,
                }} />
                <div style={{
                  position: "absolute", top: 0, right: 0, bottom: 0, width: 70,
                  background: "linear-gradient(to left, #0d0812 0%, transparent 100%)",
                  pointerEvents: "none", zIndex: 15,
                }} />
              </div>

              {/* Phase status text */}
              <div style={{ marginTop: 32, textAlign: "center", minHeight: 30 }}>
                {spinRoomPhase === 'accelerate' && (
                  <p key="acc" style={{
                    fontSize: 11, color: "rgba(255,255,255,0.36)",
                    letterSpacing: "0.16em", textTransform: "uppercase",
                    animation: "srTextIn 0.5s ease forwards",
                  }}>Finding tonight's connection…</p>
                )}
                {spinRoomPhase === 'fast' && (
                  <p key="fast" style={{
                    fontSize: 17, color: "rgba(212,92,116,0.72)",
                    letterSpacing: "0.44em",
                    animation: "srTextIn 0.4s ease forwards",
                  }}>✦ ✦ ✦</p>
                )}
                {spinRoomPhase === 'slow' && (
                  <p key="slow" style={{
                    fontSize: 11, fontStyle: "italic",
                    color: "rgba(255,255,255,0.40)",
                    animation: "srTextIn 0.5s ease forwards",
                  }}>Narrowing down…</p>
                )}
                {spinRoomPhase === 'approach' && (
                  <p key="approach" style={{
                    fontSize: 11, fontStyle: "italic",
                    color: "rgba(255,255,255,0.50)",
                    animation: "srTextIn 0.5s ease forwards",
                  }}>Almost there…</p>
                )}
              </div>
            </div>

            {/* Floating particles — visible during fast + slow phases */}
            {SPIN_PARTICLES.map((p, i) => (
              <div key={i} style={{
                position: "absolute",
                left: `${p.x}%`, top: `${p.y}%`,
                width: p.size, height: p.size, borderRadius: "50%",
                background: `rgba(212,92,116,${p.alpha})`,
                pointerEvents: "none",
                opacity: (spinRoomPhase === 'fast' || spinRoomPhase === 'slow') ? 1 : 0,
                transition: "opacity 0.5s ease",
                animation: `srParticle ${p.dur}s ${p.delay}s ease-in-out infinite`,
              }} />
            ))}

            {/* Close button during carousel stage */}
            <button
              onClick={closeProfile}
              data-testid="button-spin-room-close"
              style={{
                position: "absolute",
                top: "max(env(safe-area-inset-top,0px), 14px)", left: 14,
                zIndex: 30, width: 40, height: 40, borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.09)",
                cursor: "pointer", fontSize: 17, lineHeight: 1,
              }}
            >🌙</button>
          </div>

          {/* ── REVEAL STAGE — 3 phases: quote → photo → introduction ── */}
          {(spinRoomPhase === 'reveal' || spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') && selectedProfile && (
            <div style={{ position: "absolute", inset: 0, zIndex: 10 }}>

              {/* ── Dark base — always fills screen ── */}
              <div style={{
                position: "absolute", inset: 0,
                background: "#0d0812",
                animation: "srRevealBg 0.8s ease forwards",
              }} />

              {/* ── Photo — cinematic entrance at pause phase ── */}
              {/* Mounts only at pause/buttons so srWinnerIn animation plays on entry */}
              {(spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') && (
                <div style={{
                  position: "absolute", inset: 0,
                  animation: "srWinnerIn 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                  transformOrigin: "center 40%",
                }}>
                  <ProfilePhoto userId={selectedProfile.userId} className="w-full h-full" />
                </div>
              )}

              {/* ── Top vignette — safe area + close button backdrop ── */}
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, height: 130,
                background: "linear-gradient(#0d0812 0%, rgba(13,8,18,0.52) 52%, transparent 100%)",
                pointerEvents: "none", zIndex: 4,
              }} />

              {/* ── Bottom gradient — protects the lower 42% where all text lives ── */}
              {(spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') && (
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0, height: "44%",
                  background: "linear-gradient(transparent 0%, rgba(13,8,18,0.78) 32%, rgba(13,8,18,0.97) 65%, #0d0812 100%)",
                  pointerEvents: "none", zIndex: 4,
                }} />
              )}

              {/* ── Subtle rose bloom over upper photo ── */}
              {(spinRoomPhase === 'pause' || spinRoomPhase === 'buttons') && (
                <div style={{
                  position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none",
                  background: "radial-gradient(ellipse 80% 50% at 50% 22%, rgba(212,92,116,0.14) 0%, transparent 62%)",
                }} />
              )}

              {/* ── PHASE 1: QUOTE — centered on dark screen, only during reveal ── */}
              {spinRoomPhase === 'reveal' && (
                <div style={{
                  position: "absolute", inset: 0, zIndex: 5,
                  display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center",
                  padding: "0 44px",
                  pointerEvents: "none",
                }}>
                  <p style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: 19, fontStyle: "italic",
                    color: "rgba(255,255,255,0.80)",
                    letterSpacing: "0.01em", lineHeight: 1.65,
                    textShadow: "0 2px 32px rgba(0,0,0,0.55)",
                    animation: "srTextIn 1.2s 0.3s ease both",
                    textAlign: "center", margin: 0,
                  }}>
                    "{revealQuote}"
                  </p>
                  <p style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.26em",
                    textTransform: "uppercase", color: "rgba(212,92,116,0.85)",
                    marginTop: 14,
                    animation: "srTextIn 0.65s 1.55s ease both",
                    textShadow: "0 0 18px rgba(212,92,116,0.50)",
                  }}>— Lulou</p>
                </div>
              )}

              {/* ── PHASE 3: PROFILE TEXT + CTA — bottom 33%, appears at buttons phase ── */}
              {/* Mounts fresh at buttons phase so all animation-delays start from zero */}
              {spinRoomPhase === 'buttons' && (
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 6,
                  display: "flex", flexDirection: "column", alignItems: "center",
                  padding: "0 22px",
                  paddingBottom: "max(env(safe-area-inset-bottom,0px), 32px)",
                  textAlign: "center",
                }}>
                  {/* Eyebrow — 0.2 s */}
                  <p style={{
                    fontSize: 9, fontWeight: 900, letterSpacing: "0.42em",
                    textTransform: "uppercase", color: "rgba(212,92,116,0.94)",
                    margin: "0 0 10px",
                    animation: "srTextIn 0.50s 0.2s ease both",
                  }}>
                    {t("spin_room_title")}
                  </p>

                  {/* Name — 0.9 s */}
                  <h2 style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: "clamp(28px,7.5vw,40px)", fontWeight: 700,
                    color: "#fff", margin: "0 0 4px", lineHeight: 1.05,
                    textShadow: "0 2px 28px rgba(0,0,0,0.75)",
                    animation: "srTextIn 0.75s 0.9s ease both",
                  }}>
                    {selectedProfile.firstName}
                    {selectedProfile.photoVerified && (
                      <BadgeCheck style={{
                        display: "inline", width: 18, height: 18,
                        color: "#d45c74", marginLeft: 6, verticalAlign: "middle",
                      }} />
                    )}
                  </h2>

                  {/* Age — 1.65 s */}
                  {selectedProfile.age && (
                    <p style={{
                      fontSize: 15, fontWeight: 300,
                      color: "rgba(255,255,255,0.48)", margin: "4px 0 0",
                      animation: "srTextIn 0.50s 1.65s ease both",
                    }}>
                      {selectedProfile.age}
                    </p>
                  )}

                  {/* Signal word — 2.35 s */}
                  {selectedProfile.signals && selectedProfile.signals.length > 0 && (
                    <p style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: 14, fontStyle: "italic",
                      color: "rgba(255,255,255,0.58)", margin: "7px 0 0",
                      animation: "srTextIn 0.55s 2.35s ease both",
                    }}>
                      "{selectedProfile.signals[0]}"
                    </p>
                  )}

                  {/* Location — 2.95 s */}
                  {selectedProfile.location && (
                    <p style={{
                      fontSize: 12, color: "rgba(255,255,255,0.28)", margin: "6px 0 0",
                      display: "flex", alignItems: "center",
                      justifyContent: "center", gap: 4,
                      animation: "srTextIn 0.45s 2.95s ease both",
                    }}>
                      <MapPin style={{ width: 11, height: 11 }} />
                      {selectedProfile.location}
                    </p>
                  )}

                  {/* CTA — 3.65 s (or halo-sent state) */}
                  {sparkSent ? (
                    <div style={{
                      marginTop: 22, width: "100%",
                      animation: "haloSentPulse 0.50s cubic-bezier(0.34,1.56,0.64,1) forwards",
                    }}>
                      <p style={{
                        fontSize: 19, fontWeight: 700,
                        color: "rgba(212,92,116,1.0)", letterSpacing: "0.08em",
                      }}>✨ Halo Sent</p>
                      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.38)", marginTop: 5 }}>
                        We'll let you know if they feel the same.
                      </p>
                    </div>
                  ) : (
                    <div style={{
                      display: "flex", gap: 12, marginTop: 20, width: "100%",
                      animation: "srTextIn 0.60s 3.65s ease both",
                    }}>
                      <button
                        onClick={() => { closeProfile(); setTimeout(() => setShowSpinExtras(true), 350); }}
                        data-testid="button-spin-room-pass"
                        style={{
                          flex: 1, padding: "16px 10px", borderRadius: 18,
                          background: "rgba(255,255,255,0.08)",
                          border: "1px solid rgba(255,255,255,0.13)",
                          color: "rgba(255,255,255,0.65)", fontSize: 13,
                          fontWeight: 600, cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        }}
                      >
                        <span>🌙</span><span>Close</span>
                      </button>
                      <button
                        onClick={() => selectedProfile && sendSpark.mutate(selectedProfile.userId)}
                        disabled={sendSpark.isPending}
                        data-testid="button-spin-room-send-halo"
                        style={{
                          flex: 2, padding: "16px 10px", borderRadius: 18,
                          background: sendSpark.isPending
                            ? "rgba(212,92,116,0.38)"
                            : "linear-gradient(135deg,#d45c74 0%,#9d3550 100%)",
                          boxShadow: sendSpark.isPending
                            ? "none"
                            : "0 4px 22px rgba(188,78,96,0.50)",
                          border: "none", color: "#fff",
                          fontSize: 13, fontWeight: 700,
                          letterSpacing: "0.14em", textTransform: "uppercase",
                          cursor: sendSpark.isPending ? "default" : "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                        }}
                      >
                        {sendSpark.isPending
                          ? <Loader2 style={{ width: 15, height: 15, animation: "spinBtn 0.65s linear infinite" }} />
                          : <span style={{ fontSize: 16, lineHeight: 1 }}>✦</span>
                        }
                        <span>{sendSpark.isPending ? "Sending…" : "Send Halo"}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Close button — always reachable in top-left ── */}
              <button
                onClick={() => { closeProfile(); setTimeout(() => setShowSpinExtras(true), 350); }}
                data-testid="button-spin-room-close"
                style={{
                  position: "absolute",
                  top: "max(env(safe-area-inset-top,0px), 14px)", left: 14,
                  zIndex: 30, width: 40, height: 40, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.14)",
                  cursor: "pointer", fontSize: 17, lineHeight: 1,
                }}
              >🌙</button>
            </div>
          )}

        </div>
      )}

      {/* ── Spin Extras Sheet — slides up after Close or Spark Sent ── */}
      {showSpinExtras && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9500,
            background: "rgba(0,0,0,0.70)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            display: "flex", alignItems: "flex-end",
          }}
          onClick={() => setShowSpinExtras(false)}
        >
          <div
            style={{
              width: "100%",
              background: "linear-gradient(180deg, #130e1c 0%, #0d0812 100%)",
              borderRadius: "28px 28px 0 0",
              border: "1px solid rgba(212,92,116,0.22)",
              borderBottom: "none",
              paddingBottom: "max(env(safe-area-inset-bottom,0px), 28px)",
              boxShadow: "0 -8px 60px rgba(212,92,116,0.12)",
              animation: "srButtonsIn 0.52s cubic-bezier(0.34,1.56,0.64,1) both",
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div style={{ textAlign: "center", paddingTop: 14, paddingBottom: 6 }}>
              <div style={{
                width: 36, height: 3, borderRadius: 2,
                background: "rgba(255,255,255,0.18)", margin: "0 auto",
              }} />
            </div>

            {/* Header */}
            <div style={{ textAlign: "center", padding: "18px 28px 14px" }}>
              <p style={{
                fontSize: 9, fontWeight: 900, letterSpacing: "0.36em",
                textTransform: "uppercase", color: "rgba(212,92,116,0.80)",
                marginBottom: 12,
              }}>
                Tonight's Halo Is Complete
              </p>
              <h2 style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: 24, fontWeight: 700, color: "#fff",
                margin: 0, lineHeight: 1.2,
              }}>
                Want to discover more tonight?
              </h2>
              <p style={{
                fontSize: 13, color: "rgba(255,255,255,0.38)",
                marginTop: 8, marginBottom: 0,
              }}>
                Each Halo opens a new connection.
              </p>
              {(spinStatus?.purchasedSpins ?? 0) > 0 && (
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  marginTop: 12,
                  background: "rgba(212,92,116,0.14)",
                  border: "1px solid rgba(212,92,116,0.32)",
                  borderRadius: 20, padding: "5px 14px",
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "rgba(212,92,116,1)" }}>
                    ✨ {spinStatus!.purchasedSpins} Halo{spinStatus!.purchasedSpins === 1 ? "" : "s"} remaining
                  </span>
                </div>
              )}
            </div>

            {/* Divider */}
            <div style={{
              height: 1, background: "rgba(212,92,116,0.14)",
              margin: "4px 24px 18px",
            }} />

            {/* Section label */}
            <p style={{
              fontSize: 10, fontWeight: 800, letterSpacing: "0.24em",
              textTransform: "uppercase", color: "rgba(212,92,116,0.72)",
              textAlign: "center", marginBottom: 14,
            }}>✨ Get More Halos</p>

            {/* Halo packs */}
            <div style={{ padding: "0 20px", display: "flex", flexDirection: "column", gap: 10 }}>
              {(
                [
                  { itemId: "sparks-1", label: "1 Halo",  sub: "One more connection tonight",  price: "$2.99",  highlight: false },
                  { itemId: "sparks-3", label: "3 Halos", sub: "Three more chances tonight",   price: "$6.99",  highlight: true  },
                  { itemId: "sparks-5", label: "5 Halos", sub: "Explore freely tonight",       price: "$9.99",  highlight: false },
                ] as const
              ).map(({ itemId, label, sub, price, highlight }) => (
                <button
                  key={itemId}
                  data-testid={`button-spin-extra-${itemId.split("-")[1]}`}
                  disabled={sparksCheckoutLoading === itemId}
                  onClick={async () => {
                    console.log(`[HALO_BUY] CLICK item=${itemId}`);
                    if (sparksCheckoutLoading) return;
                    setSparksCheckoutLoading(itemId);
                    try {
                      console.log(`[CHECKOUT] REQUEST_RECEIVED item=${itemId}`);
                      const res = await apiRequest("POST", "/api/stripe/extras-checkout", {
                        itemId,
                        returnPath: "/intent",
                      });
                      const data = await res.json();
                      console.log(`[CHECKOUT] HALO_RESPONSE item=${itemId} ok=${res.ok} hasUrl=${!!data?.url}`);
                      if (res.ok && data.url) {
                        sessionStorage.setItem("lulou_stripe_checkout", "1");
                        window.location.href = data.url;
                      } else {
                        console.error(`[CHECKOUT] HALO_NO_URL item=${itemId}`, data);
                        toast({ title: "Checkout failed", description: data.message ?? "Please try again.", variant: "destructive" });
                        setSparksCheckoutLoading(null);
                      }
                    } catch (err: any) {
                      console.error(`[CHECKOUT] HALO_ERROR item=${itemId}`, { message: err?.message, stack: err?.stack });
                      toast({ title: "Checkout failed", description: err?.message ?? "Please try again.", variant: "destructive" });
                      setSparksCheckoutLoading(null);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "14px 18px", borderRadius: 18,
                    background: highlight
                      ? "linear-gradient(135deg, rgba(212,92,116,0.22) 0%, rgba(157,53,80,0.16) 100%)"
                      : "rgba(255,255,255,0.05)",
                    border: `1px solid ${highlight ? "rgba(212,92,116,0.42)" : "rgba(255,255,255,0.09)"}`,
                    cursor: sparksCheckoutLoading ? "not-allowed" : "pointer",
                    opacity: sparksCheckoutLoading && sparksCheckoutLoading !== itemId ? 0.5 : 1,
                  }}
                >
                  <div style={{ textAlign: "left" }}>
                    <p style={{ fontSize: 15, fontWeight: 700, color: "#fff", margin: 0 }}>{label}</p>
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.38)", margin: 0, marginTop: 2 }}>{sub}</p>
                  </div>
                  {sparksCheckoutLoading === itemId ? (
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,0.40)" }}>…</span>
                  ) : (
                    <span style={{ fontSize: 14, fontWeight: 700, color: highlight ? "rgba(212,92,116,1.0)" : "rgba(255,255,255,0.50)" }}>{price}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Restore Purchases + Back to Lulou */}
            <div style={{ textAlign: "center", paddingTop: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
              <RestorePurchasesButton />
              <button
                onClick={() => setShowSpinExtras(false)}
                data-testid="button-spin-extras-dismiss"
                style={{
                  fontSize: 13, color: "rgba(255,255,255,0.30)",
                  background: "none", border: "none", cursor: "pointer",
                  padding: "8px 24px",
                }}
              >
                Back to Lulou
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Elevate modal ── */}
      {showElevateInReveal && (
        <ElevateModal onClose={() => setShowElevateInReveal(false)} cancelPath="/intent" />
      )}

      {/* First-time Spin Room guide */}
      <LulouGuide
        guideKey={GUIDE_KEYS.SPIN_ROOM_ENTRY}
        userId={user?.id}
        icon="✦"
        title={t("spin_room_guide_title")}
        body={t("spin_room_guide_body")}
        delay={800}
        autoDismissMs={6000}
      />
    </div>
  );
}
