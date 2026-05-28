import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, RotateCw, X, MapPin, Lock, Star, Crown, MessageCircle, HelpCircle, Heart, Moon, Volume2, VolumeX, ChevronRight } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { ElevateModal } from "@/components/elevate-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useTabActive } from "@/hooks/use-tab-active";
import type { Profile } from "@shared/schema";
import { ProfilePhotoViewer } from "@/components/profile-photo-viewer";
import { EMPTY_PHOTOS } from "@/lib/image-utils";

/** Fisher-Yates shuffle — returns a new array, does not mutate input. */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

  // Three-note ascending arpeggio: C5 → E5 → G5 (major triad, 140ms stagger).
  // Soft sine waves with natural decay envelope — subtle, elegant, not cheesy.
  const playChime = useCallback(() => {
    if (muted) return;
    const ctx = ctxRef.current;
    if (!ctx || ctx.state !== "running") return;
    try {
      const t = ctx.currentTime;
      const notes: [number, number, number, number][] = [
        [523.25, 0,    0.025, 0.90],  // C5
        [659.25, 0.14, 0.025, 0.80],  // E5
        [783.99, 0.28, 0.025, 0.70],  // G5
      ];
      for (const [freq, offset, attack, dur] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t + offset);
        gain.gain.linearRampToValueAtTime(0.13, t + offset + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, t + offset + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t + offset);
        osc.stop(t + offset + dur + 0.05);
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
const MATCH_TAGLINES = [
  "Two energies aligned.",
  "The wheel found something interesting.",
  "This connection feels rare.",
  "Someone worth meeting just appeared.",
  "A meaningful spark just landed.",
  "The wheel had good taste.",
  "This feels like something real.",
  "Not every spin lands like this.",
  "Something genuine started here.",
  "A rare connection just appeared.",
];

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
  const tagline = useRef(MATCH_TAGLINES[Math.floor(Math.random() * MATCH_TAGLINES.length)]).current;

  useEffect(() => {
    const t = setTimeout(playChime, 200);
    return () => clearTimeout(t);
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
          {isExisting ? "✦  Reconnected  ✦" : "✦  Connection Opened  ✦"}
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
              Get 3× more visibility with Elevate
            </p>
            <p style={{ fontSize: 11, color: "rgba(255,175,195,0.52)", lineHeight: 1.3, margin: "2px 0 0" }}>
              Boost your profile and match faster
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
            Start Conversation
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
            Keep Exploring
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Constants ────────────────────────────────────────────────────────────────
const ITEM_WIDTH = 156;
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
};

function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -11 * t);
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function IntentPage() {
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
  if (profiles !== prevProfilesRef.current) {
    prevProfilesRef.current = profiles ?? null;
    shuffledItemsRef.current = profiles ? shuffleArray(profiles) : [];
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
  const [showConfetti, setShowConfetti] = useState(false);
  const [showElevateInReveal, setShowElevateInReveal] = useState(false);
  const [angle, setAngle] = useState(0);

  // Match reveal state — set after wheelOpen.onSuccess
  const [showMatchReveal, setShowMatchReveal] = useState(false);
  const [matchRevealProfile, setMatchRevealProfile] = useState<Profile | null>(null);
  const [matchRevealIsExisting, setMatchRevealIsExisting] = useState(false);

  const items = shuffledItemsRef.current.length > 0 ? shuffledItemsRef.current : (profiles || []);
  const count = items.length;
  const angleStep = count > 0 ? 360 / count : 0;
  const radius = count > 4 ? Math.max(210, count * 30) : 190;
  const canSpin = spinStatus?.canSpin ?? false;

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
    const dx = e.clientX - lastX.current;
    if (dt > 0) velocity.current = (dx / dt) * 0.8;
    lastX.current = e.clientX;
    lastTime.current = now;
    angleRef.current += dx * 0.32;
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

  const wheelOpen = useMutation({
    mutationFn: async (toUserId: string) => {
      const res = await apiRequest("POST", "/api/wheel/open", { toUserId });
      return res.json() as Promise<{ matchId: string; isExisting: boolean }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      // Capture profile before any state reset — closure reference is stable
      setMatchRevealProfile(selectedProfile);
      setMatchRevealIsExisting(data.isExisting);
      setShowProfile(false);
      setShowMatchReveal(true);
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
    ensureCtx();
    setIsSpinning(true);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setDispersed(false);
    setShowProfile(false);
    setShowPurchase(false);
    setShowConfetti(false);
    setShowMatchReveal(false);
    setMatchRevealProfile(null);

    const targetIndex = Math.floor(Math.random() * count);
    const landedProfile = items[targetIndex];

    console.log("[INTENT] SPIN_START", { totalUsers: count });
    console.log("[INTENT] SPIN_SELECTED", { selectedIndex: targetIndex, selectedName: landedProfile?.firstName });

    const targetAngle = targetIndex * angleStep;
    const currentAngle = angleRef.current;
    const fullSpins = (4 + Math.floor(Math.random() * 2)) * 360;
    const normalizedCurrent = ((currentAngle % 360) + 360) % 360;
    let diff = targetAngle - normalizedCurrent;
    if (diff < 0) diff += 360;
    const totalRotation = fullSpins + diff;
    const duration = 3800 + Math.random() * 1200;
    const startTime = performance.now();
    const startAngle = currentAngle;

    resetTick(currentAngle);

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const rawT = Math.min(elapsed / duration, 1);
      const newAngle = startAngle + totalRotation * easeOutExpo(rawT);
      tickFromAngle(newAngle, 2 + rawT * rawT * 16);
      angleRef.current = newAngle;
      setAngle(newAngle);

      if (rawT < 1) {
        animFrame.current = requestAnimationFrame(animate);
      } else {
        angleRef.current = startAngle + totalRotation;
        setAngle(angleRef.current);
        setSelectedIndex(targetIndex);
        setSelectedProfile(landedProfile ?? null);
        setIsSpinning(false);
        console.log("[INTENT] SPIN_COMPLETE", { selectedName: landedProfile?.firstName });
        if (landedProfile) recordSpin.mutate(landedProfile.userId);
        setTimeout(() => setDispersed(true), 260);
        setTimeout(() => setShowConfetti(true), 420);
        setTimeout(() => setShowProfile(true), 720);
        setTimeout(() => setShowConfetti(false), 2300);
      }
    };

    cancelAnimationFrame(animFrame.current);
    animFrame.current = requestAnimationFrame(animate);
  };

  const closeProfile = () => {
    setShowProfile(false);
    setDispersed(false);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setShowConfetti(false);
    queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
    setTimeout(() => setShowPurchase(true), 300);
  };

  // Resets all wheel/profile/reveal state without triggering the purchase prompt.
  // Used when leaving the reveal overlay — user has already connected, no upsell needed.
  const resetAfterReveal = () => {
    setShowMatchReveal(false);
    setMatchRevealProfile(null);
    setShowProfile(false);
    setDispersed(false);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setShowConfetti(false);
    queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
  };

  useEffect(() => { return () => cancelAnimationFrame(animFrame.current); }, []);
  useEffect(() => {
    const t0 = performance.now();
    console.log("[INTENT] MOUNTED");
    return () => console.log("[INTENT] UNMOUNTED after", Math.round(performance.now() - t0), "ms");
  }, []);

  if (isLoading) {
    if (intentLoadingTooLong) {
      return (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4 max-w-sm">
            <LulouFlowerIcon className="w-10 h-10 text-primary/60 mx-auto" />
            <p className="font-serif text-lg font-semibold">Still loading profiles…</p>
            <p className="text-muted-foreground text-sm">This is taking longer than usual.</p>
            <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium" onClick={() => refetchProfiles()} data-testid="button-retry-intent">Retry</button>
          </div>
        </div>
      );
    }
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
      `}</style>

      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-1">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="font-serif text-2xl font-semibold tracking-tight" data-testid="text-intent-title">
            Intention Wheel
          </h1>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleMute}
              data-testid="button-toggle-sound"
              title={muted ? "Enable sound" : "Mute sound"}
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
                  <Star className="w-3 h-3 mr-1" /> Spin earned
                </Badge>
              ) : (
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                    <div key={i} className={`w-2 h-2 rounded-full transition-colors ${i < consecutiveDays ? "bg-primary" : "bg-muted-foreground/30"}`} data-testid={`streak-dot-${i}`} />
                  ))}
                  <span className="text-xs text-muted-foreground ml-1" data-testid="text-likes-today">{dailyLikes}/{DAILY_LIKE_GOAL}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Wheel stage ── */}
      <div className="flex-1 flex flex-col items-center justify-center gap-5 overflow-hidden">
        <div
          className="relative select-none touch-manipulation"
          style={{
            width: "100%", height: ITEM_HEIGHT + 180,
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

          <div
            className="absolute left-1/2 top-1/2"
            style={{
              transformStyle: "preserve-3d",
              transform: `translateX(-50%) translateY(-50%) rotateY(${-angle}deg)`,
              width: ITEM_WIDTH, height: ITEM_HEIGHT,
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
                    width: ITEM_WIDTH, height: ITEM_HEIGHT,
                    borderRadius: 20, overflow: "hidden",
                    position: "absolute", left: 0, top: 0,
                    transform: dispersed && !isSelected
                      ? `rotateY(${itemAngle}deg) translateZ(${radius}px) translate(${disperseX}px, ${disperseY}px) scale(0)`
                      : `rotateY(${itemAngle}deg) translateZ(${radius}px) scale(${cardScale})`,
                    opacity: dispersed && !isSelected ? 0 : (0.16 + depthFactor * 0.84),
                    zIndex: Math.round(depthFactor * 100),
                    boxShadow,
                    animation: isSelected && !dispersed ? "selectedRing 0.6s ease forwards" : undefined,
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
              width: ITEM_WIDTH + 16, height: ITEM_HEIGHT + 16, borderRadius: 26,
              border: isSpinning ? "1.5px solid rgba(188,78,96,0.55)" : "1.5px solid rgba(188,78,96,0.25)",
              boxShadow: isSpinning ? "0 0 32px 8px rgba(188,78,96,0.20), inset 0 0 24px rgba(188,78,96,0.10)" : "0 0 16px 4px rgba(188,78,96,0.08), inset 0 0 12px rgba(188,78,96,0.05)",
              animation: isSpinning ? "reticleGlow 0.6s ease-in-out infinite" : "reticleGlow 2.8s ease-in-out infinite",
              pointerEvents: "none", zIndex: 200,
              transition: "border-color 0.4s, box-shadow 0.4s",
            }} />
          )}
        </div>

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
                  {isSpinning ? "…" : "Spin"}
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
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                  boxShadow: "0 4px 14px rgba(0,0,0,0.10)",
                  transition: "transform 0.15s ease", outline: "none", WebkitTapHighlightColor: "transparent",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1.05)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                data-testid="button-spin-locked"
              >
                <Lock style={{ width: 22, height: 22 }} />
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.7 }}>Used</span>
              </button>
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
                          {isDone ? "✓" : isCurrentDay ? `${dailyLikes}/${DAILY_LIKE_GOAL}` : `Day ${i + 1}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  Like {DAILY_LIKE_GOAL}× daily for {STREAK_GOAL} days to earn a free spin
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Purchase spins ── */}
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
                <Button className="w-full gap-2" onClick={() => toast({ title: "Coming soon", description: "Spin packs will be available shortly." })} data-testid="button-buy-1-spin">
                  <RotateCw className="w-4 h-4" /> 1 Spin - $1.49
                </Button>
                <Button className="w-full gap-2" variant="outline" onClick={() => toast({ title: "Coming soon", description: "Spin packs will be available shortly." })} data-testid="button-buy-2-spins">
                  <RotateCw className="w-4 h-4" /> 2 Spins - $2.49
                </Button>
              </div>
              {!streakComplete && (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-xs font-medium text-center text-muted-foreground">Or earn a free spin</p>
                  <div className="flex items-center gap-3">
                    {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                      <div key={i} className={`flex-1 h-2 rounded-full ${i < consecutiveDays ? "bg-primary" : "bg-muted"}`} />
                    ))}
                    <span className="text-xs font-medium whitespace-nowrap">{consecutiveDays}/{STREAK_GOAL}</span>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Send {DAILY_LIKE_GOAL} likes daily for {STREAK_GOAL} days in a row
                  </p>
                </div>
              )}
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowPurchase(false)} data-testid="button-dismiss-purchase">
                Maybe later
              </Button>
            </Card>
          </div>
        )}
      </div>

      {/* ── Profile detail sheet ── */}
      {showProfile && selectedProfile && (
        <div
          className="absolute inset-0 z-50 bg-background flex flex-col"
          style={{ animation: "slideUpProfile 0.52s cubic-bezier(0.16, 1, 0.3, 1) forwards" }}
          data-testid="intent-profile-detail"
        >
          <div className="flex-1 overflow-y-auto">

            {/* ① Name + age — absolute TOP of card */}
            <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
              <div style={{ animation: "profileNameAppear 0.45s 0.15s ease both" }}>
                <h2 className="font-serif text-3xl font-bold" data-testid="text-detail-name">
                  {selectedProfile.firstName}{selectedProfile.age ? `, ${selectedProfile.age}` : ""}
                </h2>

                {/* ② Age/location/details immediately under name */}
                {selectedProfile.location && (
                  <div className="flex items-center gap-1.5 mt-1 text-muted-foreground text-sm">
                    <MapPin className="w-3.5 h-3.5" />
                    <span data-testid="text-detail-location">{selectedProfile.location}</span>
                  </div>
                )}
                {selectedProfile.height && (
                  <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-detail-height">{selectedProfile.height}</p>
                )}
              </div>

              <Button
                size="icon" variant="ghost"
                className="rounded-full flex-shrink-0 mt-0.5"
                onClick={closeProfile}
                data-testid="button-close-profile"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* ③ Profile picture — shared carousel, same as Discovery and ProfilePanel */}
            <div data-testid="img-intent-detail-photo">
              <ProfilePhotoViewer
                photos={detailPhotos}
                isLoading={isDetailPhotosLoading}
              />
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
                  <p className="text-sm font-semibold text-foreground leading-tight">Get 3× more visibility with Elevate</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Boost your profile and match faster</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </div>

              {/* ⑤ Reveal text — profile details */}
              {selectedProfile.datingIntent && (
                <Badge variant="secondary" data-testid="text-detail-intent">{selectedProfile.datingIntent}</Badge>
              )}

              {selectedProfile.signals && selectedProfile.signals.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Signals</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.signals.map((signal, i) => (
                      <Badge key={i} variant="outline" data-testid={`badge-detail-signal-${i}`}>{signal}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {selectedProfile.greenFlags && selectedProfile.greenFlags.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Green Flags</p>
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
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Conversation Starters</p>
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
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ask Me</p>
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
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Photos</p>
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
          <div className="absolute bottom-0 left-0 right-0 border-t" style={{ background: "hsl(var(--background)/0.96)", backdropFilter: "blur(16px)" }}>
            <div className="px-5 pt-4 pb-6">
              <div className="flex items-center gap-4">
                {/* Skip button */}
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-2xl border transition-all active:scale-95"
                  style={{
                    background: "hsl(var(--muted)/0.5)",
                    borderColor: "hsl(var(--border))",
                  }}
                  onClick={closeProfile}
                  data-testid="button-intent-skip"
                  aria-label="Skip"
                >
                  <Moon className="w-5 h-5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground font-medium tracking-wide">Skip</span>
                </button>

                {/* Connect button */}
                <button
                  className="flex-[2] flex flex-col items-center gap-1.5 py-3 rounded-2xl transition-all active:scale-95 disabled:opacity-60"
                  style={{
                    background: "linear-gradient(135deg, #d45c74 0%, #9d3550 100%)",
                    boxShadow: "0 4px 20px rgba(188,78,96,0.45), 0 2px 8px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.15)",
                  }}
                  onClick={() => selectedProfile && wheelOpen.mutate(selectedProfile.userId)}
                  disabled={wheelOpen.isPending}
                  data-testid="button-intent-open"
                  aria-label="Connect"
                >
                  {wheelOpen.isPending
                    ? <Loader2 className="w-5 h-5 text-white animate-spin" />
                    : <Heart className="w-5 h-5 text-white fill-current" />
                  }
                  <span className="text-xs text-white font-semibold tracking-wide">
                    {wheelOpen.isPending ? "Connecting…" : "Connect"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Match reveal overlay ── */}
      {showMatchReveal && matchRevealProfile && (
        <MatchRevealOverlay
          profile={matchRevealProfile}
          isExisting={matchRevealIsExisting}
          playChime={playChime}
          onGoToMatches={() => {
            resetAfterReveal();
            navigate("/matches");
          }}
          onDiscover={() => {
            resetAfterReveal();
            setTimeout(() => setShowPurchase(true), 300);
          }}
          onElevate={() => {
            resetAfterReveal();
            setTimeout(() => setShowElevateInReveal(true), 180);
          }}
        />
      )}

      {/* ── Elevate modal (opened from the 3× section in the reveal overlay) ── */}
      {showElevateInReveal && (
        <ElevateModal onClose={() => setShowElevateInReveal(false)} cancelPath="/intent" />
      )}
    </div>
  );
}
