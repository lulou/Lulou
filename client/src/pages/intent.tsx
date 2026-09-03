import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, Component, type ReactNode, type ErrorInfo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, X, MapPin, Star, Crown, MessageCircle, HelpCircle, Moon, Volume2, VolumeX, ChevronRight, BadgeCheck, Heart, RotateCw } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { ElevateModal } from "@/components/elevate-modal";
import { useAuth } from "@/hooks/use-auth";
import { LulouGuide } from "@/components/lulou-guide";
import { GUIDE_KEYS } from "@/lib/guide-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import {
  pushDebugError,
  pushWheelEntry, getWheelEntries, subscribeWheelEntries,
  _dbg, _dbgListeners,
  type WheelEntry,
} from "@/lib/debug-store";
import { startPurchase, restorePurchases, subscribeDebug, type PurchaseDebugInfo } from "@/lib/purchase-service";
import { useTabActive } from "@/hooks/use-tab-active";
import type { Profile } from "@shared/schema";
import { ProfilePhotoViewer } from "@/components/profile-photo-viewer";
import { EMPTY_PHOTOS } from "@/lib/image-utils";
import { useLanguageContext } from "@/contexts/language-context";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { clearAllArmedSessions } from "@/lib/live-call-sessions";
import { liveCandidateQueryOptions } from "@/lib/live-candidate-query-options";
import { useCandidateFeedRefresh } from "@/hooks/use-candidate-feed-refresh";
import { setServiceWorkerReloadBlocked } from "@/lib/service-worker";
import { canApplyWheelCandidateUpdate, resolveWheelDismissal } from "@/lib/wheel-presentation-guard";
import { canStartHaloSend, SPIN_ROOM_TIMING } from "@/lib/spin-room-timing";
import { getWheelRestingDistance } from "@/lib/wheel-idle-presentation";
import { formatDistance, useUnits } from "@/lib/units";
import type { CandidateFeed } from "@/lib/candidate-feed";

// ── Module-level wheel-state logger ──────────────────────────────────────────
// Callable from RAF closures, class methods, and useLayoutEffect — anything
// that cannot use React hooks. Writes to both the browser console AND the
// in-app WheelDebugPanel ring buffer so a production iPhone can self-report
// without needing Safari console access.
function logWheelState(entry: Record<string, unknown>): void {
  console.log('[INTENTION_WHEEL_STATE]', entry);
  pushWheelEntry(entry);
  // Transport to Railway — skip scale_sample (already POSTed as type='scale')
  if (entry.event !== 'scale_sample') {
    postWheelDiag('state', entry);
  }
}

// ── Telemetry transport — sends critical events to Railway production logs ────
// Callable from RAF closures and class methods (no hooks needed).
// Uses API_BASE so the request reaches Railway when served from Vercel:
//   • Vercel deploy: API_BASE = "https://lulou-production.up.railway.app"
//   • Replit dev:    API_BASE = "" (same-origin relative URL)
// The previous fetch('/api/debug/...') used a relative URL which Vercel's SPA
// rewrite handled with HTTP 405 — it never reached Railway. This fixes that.
function postWheelDiag(type: 'boundary' | 'scale' | 'orbit' | 'state' | 'winner_node', data: Record<string, unknown>): void {
  try {
    fetch(`${API_BASE}/api/debug/intention-wheel-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ type, ...data }),
    }).catch(() => {}); // fire-and-forget; never throw or block caller
  } catch { /* guard against any sync error */ }
}

// ── SpinRoom result error boundary ───────────────────────────────────────────
// Wraps the reveal/pause/buttons render inside SpinRoom. If a render crash
// occurs (null field access, bad URL, stale state), catches it here and shows
// a safe "Try again" inline state instead of crashing the whole page.

interface IntentResultBoundaryState { hasError: boolean; errorMsg: string; stack: string }
class IntentResultBoundary extends Component<
  { children: ReactNode; onReset: () => void; onBackToWheel: () => void; recovering?: boolean },
  IntentResultBoundaryState
> {
  constructor(props: IntentResultBoundary["props"]) {
    super(props);
    this.state = { hasError: false, errorMsg: "", stack: "" };
  }
  static getDerivedStateFromError(err: unknown): IntentResultBoundaryState {
    const msg   = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    return { hasError: true, errorMsg: msg, stack };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const firstFrame = (error.stack ?? '').split('\n')
      .find(l => l.includes('.tsx') || l.includes('.ts'))?.trim() ?? 'unknown';
    const compStackTop = (info.componentStack ?? '').split('\n').slice(1, 5).join(' → ').trim();
    console.error('[INTENTION_WHEEL_STATE]', {
      event: 'boundary_error',
      errorMessage: error.message,
      firstFrame,
      componentStack: compStackTop,
    });
    // Two pushDebugError entries so the exact exception is visible in the
    // in-app debug panel without needing Safari console access on device.
    pushDebugError(`[spin_boundary] ${error.message} | ${firstFrame}`);
    pushDebugError(`[spin_boundary_tree] ${compStackTop}`);
    // POST to Railway via postWheelDiag so it reaches the backend even on
    // Vercel (relative URL was hitting Vercel's SPA rewrite → HTTP 405).
    postWheelDiag('boundary', {
      errorMessage: error.message,
      stack: (error.stack ?? '').split('\n').slice(0, 8).join('\n'),
      componentStack: (info.componentStack ?? '').split('\n').slice(0, 10).join('\n'),
      firstFrame,
      recentWheelLog: getWheelEntries().slice(-8),
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          padding: "32px 28px",
          background: "rgba(13,8,18,0.96)",
        }}>
          <Moon style={{ width: 30, height: 30, marginBottom: 12, color: "rgba(226,176,164,0.82)" }} />
          <p style={{
            fontSize: 15, fontWeight: 600, color: "rgba(255,255,255,0.80)",
            textAlign: "center", marginBottom: 6,
          }}>Something slipped away</p>
          <p style={{
            fontSize: 12, color: "rgba(255,255,255,0.35)",
            textAlign: "center", marginBottom: 24,
          }}>Your spin was recorded. Tap below to continue.</p>
          {/* Primary: fetch fresh persisted result from server and restore */}
          <button
            disabled={!!this.props.recovering}
            onClick={() => { if (!this.props.recovering) this.props.onReset(); }}
            style={{
              padding: "14px 32px", borderRadius: 18, marginBottom: 12, width: "100%",
              background: this.props.recovering
                ? "rgba(212,92,116,0.38)"
                : "linear-gradient(135deg,#d45c74 0%,#9d3550 100%)",
              border: "none", color: "#fff",
              fontSize: 14, fontWeight: 700,
              letterSpacing: "0.10em",
              cursor: this.props.recovering ? "default" : "pointer",
              opacity: this.props.recovering ? 0.65 : 1,
              transition: "opacity 0.2s, background 0.2s",
            }}
          >
            {this.props.recovering ? "Recovering\u2026" : "Retry Result"}
          </button>
          {/* Secondary: reset only wheel local state; return to spin screen */}
          <button
            disabled={!!this.props.recovering}
            onClick={() => { if (!this.props.recovering) this.props.onBackToWheel(); }}
            style={{
              padding: "12px 32px", borderRadius: 18, width: "100%",
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.13)",
              color: "rgba(255,255,255,0.55)",
              fontSize: 13, fontWeight: 500,
              cursor: this.props.recovering ? "default" : "pointer",
              opacity: this.props.recovering ? 0.50 : 1,
              transition: "opacity 0.2s",
            }}
          >
            Back to Intention Wheel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Fisher-Yates shuffle — returns a new array, does not mutate input. */
// ── SpinRoom orbit constants ────────────────────────────────────────────────
// 5 cards on an elliptical orbit.  Front position = angle π/2 (sin = 1, depth = 1).
// Cards rotate in the positive-angle direction (counter-clockwise in math coords,
// visually left-to-right across the front).
const ORBIT_N           = 5;
const ORBIT_RX          = 108;
const ORBIT_RY          = 12;
const ORBIT_CARD_WIDTH  = 168;
const ORBIT_CARD_HEIGHT = 224;
const ORBIT_STAGE_HEIGHT = 286;

async function decodeOrbitPhoto(url: string): Promise<string | null> {
  if (!url) return null;
  const image = new Image();
  image.src = url;
  try {
    await Promise.race([
      typeof image.decode === "function"
        ? image.decode()
        : new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("image load failed"));
          }),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error("image decode timeout")), 4_000),
      ),
    ]);
    return url;
  } catch {
    return null;
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * renderText — safe primitive extractor.
 * Profile fields (signals, greenFlags, etc.) are typed as string[] but some
 * API paths may return objects with shape { key: string; text: string }.
 * Rendering an object directly throws React error #31.  This normaliser
 * always returns a plain string so JSX is safe regardless of format.
 */
const renderText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof (value as Record<string, unknown>).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  return "";
};

/**
 * normaliseProfileForRender — sanitise ALL API profile fields before setting React state.
 *
 * Several fields are rendered directly as JSX text (firstName, location).
 * If the API returns { key, text } objects instead of plain strings, React throws
 * error #31 ("Objects are not valid as a React child").
 *
 * This function converts every directly-rendered field through renderText so JSX is
 * always given a plain string, and converts string[] fields (signals, etc.) the same way.
 */
function normaliseProfileForRender(p: Profile): Profile {
  const safeStr = (v: unknown): string => (typeof v === 'string' ? v : renderText(v));
  const safeArr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map(renderText) : [];
  const raw = p as Record<string, unknown>;
  return {
    ...p,
    // Scalar string fields rendered directly as JSX children
    firstName: safeStr(raw.firstName),
    lastName:  safeStr(raw.lastName),
    ...(raw.location != null ? { location: safeStr(raw.location) } : {}),
    // String-array fields: each element rendered via renderText in JSX
    ...(Array.isArray(raw.signals)      ? { signals:      safeArr(raw.signals) }      : {}),
    ...(Array.isArray(raw.greenFlags)   ? { greenFlags:   safeArr(raw.greenFlags) }   : {}),
    ...(Array.isArray(raw.dealBreakers) ? { dealBreakers: safeArr(raw.dealBreakers) } : {}),
  } as Profile;
}

/** Small "Restore Purchases" text link shown below Halo packs. */
function RestorePurchasesButton() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  return (
    <button
      onClick={() => void restorePurchases({
        onLoading: setLoading,
        onComplete: (count, names) => {
          if (count > 0) {
            toast({ title: `${count} purchase${count === 1 ? "" : "s"} restored`, description: names.join(", ") });
          } else {
            toast({ title: "All purchases already applied", description: "Nothing new to restore." });
          }
        },
        onError: (msg) => toast({ title: "Restore failed", description: msg, variant: "destructive" }),
      })}
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
// Lulou fallback avatar — shown for unverified profiles and when no photo loads.
function ProfileAvatarFallback({ className }: { className?: string }) {
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

/**
 * ProfilePhoto — shows a user's primary uploaded photo (photos[0]).
 *
 * Only the first (primary) photo is shown.  Secondary photos are never cycled
 * through in wheel surfaces — they may contain arbitrary content that has not
 * been individually moderated.  If the primary photo is absent or fails to
 * load, the Lulou fallback avatar is rendered instead.
 */
function ProfilePhoto({ userId, className }: { userId: string; className?: string }) {
  const { data, isLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => { setPhotoFailed(false); }, [userId]);

  // Always show primary (photos[0]) — never rotate to secondary photos.
  const photo = (data?.photos ?? [])[0] ?? null;

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

  if (!photo || photoFailed) return <ProfileAvatarFallback className={className} />;

  return (
    <img
      src={photo}
      alt=""
      className={`object-cover ${className ?? ""}`}
      draggable={false}
      onError={() => setPhotoFailed(true)}
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
          background: "linear-gradient(180deg, rgba(40,24,33,0.08), rgba(16,8,13,0.18))",
        }} />
      </div>

      {/* ── Layer 1 — confetti burst ── */}
      {/* Confetti intentionally omitted: the reveal should feel like an introduction, not a prize. */}

      {/* ── Layer 2 — floating ambient particles ── */}
      {false && <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
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
      </div>}

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
function CandidateThumbnail({
  profile,
  index,
  width,
  height,
  onTap,
}: {
  profile: Profile;
  index: number;
  width: number;
  height: number;
  onTap?: (profile: Profile) => void;
}) {
  const { data, isLoading } = useQuery<{ photos: string[] }>({
    queryKey: ["/api/profiles", profile.userId, "photos"],
    staleTime: 5 * 60 * 1000,
  });
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => setPhotoFailed(false), [profile.userId]);

  const photo = data?.photos?.[0]?.trim();
  if (isLoading || !photo || photoFailed) return null;

  return (
    <button
      type="button"
      onClick={() => onTap?.(profile)}
      data-testid={`button-preview-bubble-${index}`}
      style={{
        flexShrink: 0,
        width,
        height,
        padding: 0,
        border: "none",
        outline: "none",
        borderRadius: 15,
        overflow: "hidden",
        background: "transparent",
        boxShadow: "0 7px 18px rgba(8,4,6,0.30)",
        cursor: onTap ? "pointer" : "default",
        animation: `previewBubbleIn 0.45s ${0.08 + index * 0.06}s ease both`,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <img
        src={photo}
        alt=""
        draggable={false}
        onError={() => setPhotoFailed(true)}
        style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
      />
    </button>
  );
}

function CandidatesPreview({ items, onTap }: { items: Profile[]; onTap?: (profile: Profile) => void }) {
  const { t } = useLanguageContext();
  const [vw, setVw] = useState(() => typeof window !== "undefined" ? window.innerWidth : 390);
  useEffect(() => {
    const h = () => setVw(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const cardWidth = vw < 380 ? 44 : 46;
  const cardHeight = vw < 380 ? 54 : 56;
  const cardGap = 8;
  const maxCount = 5;
  const preview = useMemo(() => items.slice(0, Math.min(maxCount, items.length)), [items, maxCount]);
  if (preview.length < 2) return null;

  return (
    <div
      style={{
        width: "calc(100% - 24px)",
        maxWidth: 390,
        padding: "0 8px",
        borderRadius: 24,
        background: "transparent",
        border: "none",
        boxShadow: "none",
        animation: "previewFadeIn 0.7s 0.2s ease both",
      }}
    >
      <p style={{
        fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
        textAlign: "center",
        color: "rgba(255,239,235,0.72)",
        marginBottom: 10,
      }}>
        {t("tonight_connections")}
      </p>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: cardGap, overflow: "hidden" }}>
        {preview.map((profile, i) => (
          <CandidateThumbnail
            key={profile.userId}
            profile={profile}
            index={i}
            width={cardWidth}
            height={cardHeight}
            onTap={onTap}
          />
        ))}
      </div>
      <p style={{
        fontSize: 10, lineHeight: 1.2, textAlign: "center", marginTop: 10,
        color: "rgba(255,244,239,0.42)",
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

// Lulou quote keys — i18n keys resolved at render time so they update with language.
const LULOU_QUOTE_KEYS = [
  "lulou_quote_1",
  "lulou_quote_2",
  "lulou_quote_3",
  "lulou_quote_4",
  "lulou_quote_5",
  "lulou_quote_6",
] as const;

// DNA insights shown in the spin-room reveal — framed as an observation about
// the selected profile, not proof of algorithmic selection (the spin is random).
// Deterministically assigned per profile via userId so the same person always
// shows the same line, avoiding the impression of a hidden scoring system.
const WHEEL_DNA_INSIGHTS = [
  "They seem to value meaningful conversation over small talk.",
  "Something about how they approach connection feels genuine.",
  "Their profile suggests a preference for depth over surface-level connection.",
  "They appear to move at a thoughtful, intentional pace.",
  "Their openness suggests they're looking for something real.",
  "Something in their approach to relationships feels grounded.",
  "They seem to communicate with both warmth and clarity.",
  "Their signals suggest someone who values emotional consistency.",
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

const ACTIVE_ORBIT_DURATION_MS = 4200;
const REDUCED_ORBIT_DURATION_MS = 1800;
const ACTIVE_ORBIT_FULL_TURNS = 2;

// Integrated velocity profile for the visible SpinRoom orbit.
//
// 0–6%: smoothstep acceleration from rest (about 250 ms at normal duration)
// 6–43%: sustained high speed
// 43–100%: one continuous smootherstep deceleration to zero
//
// Returning integrated distance rather than a per-phase target speed means every
// frame is derived from one timestamp and one curve. Velocity is continuous at
// both joins, and the final value is exactly 1 so the preselected winner reaches
// centre without a correction snap.
function activeOrbitProgress(rawT: number): number {
  const t = Math.max(0, Math.min(rawT, 1));
  const accelerationEnd = 0.06;
  const slowdownStart = 0.43;
  const slowdownSpan = 1 - slowdownStart;
  const accelerationArea = accelerationEnd * 0.5;
  const cruiseArea = slowdownStart - accelerationEnd;
  const slowdownArea = slowdownSpan * 0.5;
  const totalArea = accelerationArea + cruiseArea + slowdownArea;

  if (t <= accelerationEnd) {
    const u = t / accelerationEnd;
    const integratedSmoothstep = u * u * u - 0.5 * u * u * u * u;
    return (accelerationEnd * integratedSmoothstep) / totalArea;
  }
  if (t <= slowdownStart) {
    return (accelerationArea + (t - accelerationEnd)) / totalArea;
  }

  const q = (t - slowdownStart) / slowdownSpan;
  // Integral of 1 - smootherstep(q), whose endpoint velocity and acceleration
  // both reach zero: q - q^6 + 3q^5 - 2.5q^4.
  const integratedSlowdown =
    q - Math.pow(q, 6) + 3 * Math.pow(q, 5) - 2.5 * Math.pow(q, 4);
  return (
    accelerationArea +
    cruiseArea +
    slowdownSpan * integratedSlowdown
  ) / totalArea;
}

// ── Wheel Debug Panel ─────────────────────────────────────────────────────────
// Always visible inside the SpinRoom overlay — no DEV gate, no Safari console.
// Shows the last 12 [INTENTION_WHEEL_STATE] events and last 4 pushDebugError
// entries so any production device can self-report the exact state at failure.
function WheelDebugPanel() {
  const [entries, setEntries] = useState<WheelEntry[]>(() => getWheelEntries().slice());
  const [errors,  setErrors]  = useState<string[]>(() => _dbg.errors.slice());

  useEffect(() => {
    const u1 = subscribeWheelEntries(() => setEntries(getWheelEntries().slice()));
    // Also show boundary/pushDebugError entries which go to _dbgListeners
    const u2 = () => setErrors(_dbg.errors.slice());
    _dbgListeners.add(u2);
    return () => { u1(); _dbgListeners.delete(u2); };
  }, []);

  const hasData = entries.length > 0 || errors.length > 0;

  return (
    <div
      data-testid="wheel-debug-panel"
      style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        zIndex: 10001,
        background: "rgba(0,0,0,0.88)",
        maxHeight: "45vh", overflowY: "auto",
        padding: "6px 8px",
        paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)",
        fontFamily: "monospace", fontSize: 9, lineHeight: 1.45,
        color: "#ccc",
        WebkitOverflowScrolling: "touch" as React.CSSProperties["WebkitOverflowScrolling"],
      }}
    >
      <div style={{ color: "rgba(212,92,116,0.9)", fontWeight: 700, marginBottom: 3 }}>
        WHEEL LOG · {__COMMIT_HASH__} · {entries.length} events
      </div>
      {!hasData && (
        <div style={{ color: "#555", fontStyle: "italic" }}>— no events yet —</div>
      )}
      {errors.slice(0, 4).map((e, i) => (
        <div key={`err-${i}`} style={{
          color: "#f99", borderBottom: "1px solid rgba(255,80,80,0.18)",
          paddingBottom: 2, marginBottom: 2,
        }}>
          {e}
        </div>
      ))}
      {entries.slice(0, 12).map((entry, i) => (
        <div key={i} style={{
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          paddingBottom: 3, marginBottom: 3,
        }}>
          <div style={{ color: "rgba(212,92,116,0.85)" }}>
            {entry._ts} <strong>{String(entry.event)}</strong>
          </div>
          {Object.entries(entry).filter(([k]) => k !== 'event' && k !== '_ts').map(([k, v]) => (
            <div key={k} style={{ paddingLeft: 8 }}>
              <span style={{ color: "#777" }}>{k}: </span>
              <span style={{ color: "#fff", wordBreak: "break-all" }}>
                {v == null ? 'null' : String(v)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── CheckoutDiagPanel ─────────────────────────────────────────────────────────
// Subscribes to purchase-service debug state and renders a visible on-screen
// banner showing exactly what the server returned:  URL (success) or error msg.
// Clears itself whenever the sheet is closed.

interface CheckoutDiagPanelProps {
  diag: PurchaseDebugInfo | null;
  onSubscribe: (info: PurchaseDebugInfo | null) => void;
  open: boolean;
}

function CheckoutDiagPanel({ diag, onSubscribe, open }: CheckoutDiagPanelProps) {
  // Subscribe once and pipe updates to parent state
  useEffect(() => {
    const unsub = subscribeDebug(onSubscribe);
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear panel whenever the sheet closes
  useEffect(() => {
    if (!open) onSubscribe(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!diag) return null;

  const hasUrl   = !!diag.redirectUrl;
  const hasError = !!diag.error;
  const pending  = !hasUrl && !hasError;

  const bg    = hasError ? "rgba(220,38,60,0.18)"  : hasUrl ? "rgba(34,197,94,0.15)"  : "rgba(255,255,255,0.07)";
  const border= hasError ? "rgba(220,38,60,0.45)"  : hasUrl ? "rgba(34,197,94,0.40)"  : "rgba(255,255,255,0.12)";
  const label = hasError ? "❌ Checkout error"      : hasUrl ? "✅ Stripe session ready" : "⏳ Contacting Stripe…";
  const color = hasError ? "#f87171"               : hasUrl ? "#4ade80"                : "rgba(255,255,255,0.55)";

  const row = (k: string, v: string | null | undefined, hi?: string) => (
    <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
      <span style={{ color: "rgba(255,255,255,0.35)", minWidth: 130 }}>{k}</span>
      <span style={{ color: hi ?? "rgba(255,255,255,0.75)", wordBreak: "break-all" }}>{v ?? "—"}</span>
    </div>
  );

  return (
    <div
      data-testid="checkout-diag-panel"
      style={{
        margin: "4px 20px 0",
        padding: "12px 14px",
        borderRadius: 14,
        background: bg,
        border: `1px solid ${border}`,
        fontSize: 11,
        fontFamily: "monospace",
        wordBreak: "break-all",
      }}
    >
      <p style={{ color, fontWeight: 700, margin: 0, marginBottom: 6 }}>{label}</p>

      {/* Always-visible account identity rows */}
      {row("Stripe Account ID:", diag.accountId || "fetching…", diag.accountId ? "#facc15" : undefined)}
      {row("Livemode:", diag.livemode === null ? "fetching…" : String(diag.livemode), diag.livemode === true ? "#f87171" : diag.livemode === false ? "#4ade80" : undefined)}
      {row("Secret key prefix:", diag.secretKeyPrefix || "…")}
      {row("Pub key prefix:", diag.pubKeyPrefix || "…")}

      {pending && (
        <div style={{ marginTop: 6, color: "rgba(255,255,255,0.35)" }}>
          product={diag.product} · token={diag.hasToken ? "yes" : "NO"} · status={diag.status ?? "…"}
        </div>
      )}

      {hasUrl && (
        <>
          {row("Session ID:", diag.sessionId)}
          <div style={{ marginTop: 6 }}>
            <a
              href={diag.redirectUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#4ade80", textDecoration: "underline" }}
              data-testid="checkout-diag-url"
            >
              Open Stripe Checkout ↗
            </a>
            <span style={{ color: "rgba(255,255,255,0.25)", marginLeft: 8 }}>
              (auto-redirected — tap if stuck)
            </span>
          </div>
          <div style={{ marginTop: 4, color: "rgba(255,255,255,0.28)", fontSize: 10 }}>
            ⚠ Compare Account ID above against your Stripe dashboard URL
            (dashboard.stripe.com/acct_XXXXXXXX) to confirm they match.
          </div>
        </>
      )}

      {hasError && (
        <p style={{ color: "#fca5a5", margin: "6px 0 0" }}>{diag.error}</p>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function IntentPage() {
  const { t, isRTL, language } = useLanguageContext();
  const [units] = useUnits();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isActive = useTabActive();
  const [, navigate] = useLocation();

  const { data: profiles, isLoading, isError, refetch: refetchProfiles } = useQuery<CandidateFeed<Profile>>({
    queryKey: ["/api/popular"],
    ...liveCandidateQueryOptions,
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

  // ── Wheel diagnostics (auto-fetched when Wheel returns 0 profiles) ────────
  // Fetches /api/popular/debug whenever the profiles query succeeds with an
  // empty array so the empty state can show a copyable filter breakdown.
  const showWheelEmpty = !isLoading && !isError && profiles !== undefined && profiles.length === 0;
  const { data: wheelDiag, isLoading: wheelDiagLoading } = useQuery<any>({
    queryKey: ["/api/popular/debug"],
    enabled: showWheelEmpty,
    staleTime: 0,
    retry: 1,
  });
  const [wheelDiagExpanded, setWheelDiagExpanded] = useState(false);
  const wheelDiagRef = useRef<HTMLPreElement>(null);

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
  // Set synchronously at spin start, before React can render an in-flight query
  // response. This preserves the candidate order used to choose the winner.
  const presentationLockedRef = useRef(false);
  if (profiles !== prevProfilesRef.current && canApplyWheelCandidateUpdate(presentationLockedRef.current)) {
    prevProfilesRef.current = profiles ?? null;
    if (profiles && profiles.length > 0) {
      shuffledItemsRef.current = shuffleArray(profiles);
    } else if (profiles) {
      // A successful empty response is authoritative. Keeping the previous cards
      // here made the Wheel display candidates that no longer matched the current
      // radius/preferences while Discover truthfully showed an empty live pool.
      shuffledItemsRef.current = [];
    }
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
  const profilePhotos = detailPhotos.length > 0
    ? detailPhotos
    : (selectedProfile?.photos ?? EMPTY_PHOTOS);
  const { data: photoReactionData } = useQuery<{ photoUrls: string[] }>({
    queryKey: ["/api/profile-photo-reactions", selectedProfile?.userId],
    enabled: !!selectedProfile?.userId,
    staleTime: 30_000,
  });
  const { data: promptReplyData } = useQuery<{ replies: Array<{ promptText: string; replyText: string }> }>({
    queryKey: ["/api/profile-prompt-replies", selectedProfile?.userId],
    enabled: !!selectedProfile?.userId,
    staleTime: 30_000,
  });
  const heartedPhotos = new Set(photoReactionData?.photoUrls ?? []);
  const togglePhotoHeart = useMutation({
    mutationFn: async ({ photoUrl, liked }: { photoUrl: string; liked: boolean }) => {
      const res = await apiRequest("PUT", "/api/profile-photo-reactions", {
        profileUserId: selectedProfile?.userId,
        photoUrl,
        liked,
      });
      if (!res.ok) throw new Error("Couldn't save photo heart");
      return res.json() as Promise<{ liked: boolean }>;
    },
    onMutate: async ({ photoUrl, liked }) => {
      const key = ["/api/profile-photo-reactions", selectedProfile?.userId];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{ photoUrls: string[] }>(key);
      queryClient.setQueryData<{ photoUrls: string[] }>(key, current => {
        const currentUrls = current?.photoUrls ?? [];
        return { photoUrls: liked ? [...new Set([...currentUrls, photoUrl])] : currentUrls.filter(url => url !== photoUrl) };
      });
      return { previous, key };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.key, context.previous);
      toast({ title: t("something_went_wrong"), variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/profile-photo-reactions", selectedProfile?.userId] }),
  });
  const savePromptReply = useMutation({
    mutationFn: async ({ promptText, replyText }: { promptText: string; replyText: string }) => {
      const res = await apiRequest("PUT", "/api/profile-prompt-replies", {
        profileUserId: selectedProfile?.userId, promptText, replyText,
      });
      if (!res.ok) throw new Error("Couldn't save reply");
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<{ replies: Array<{ promptText: string; replyText: string }> }>(
        ["/api/profile-prompt-replies", selectedProfile?.userId],
        current => {
          const replies = current?.replies ?? [];
          return { replies: [...replies.filter(reply => reply.promptText !== variables.promptText), variables] };
        },
      );
      setReplySavedFor(variables.promptText);
    },
    onError: () => toast({ title: t("something_went_wrong"), variant: "destructive" }),
  });

  const [dispersed, setDispersed] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPurchase, setShowPurchase] = useState(false);
  const [previewProfile, setPreviewProfile] = useState<Profile | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [showElevateInReveal, setShowElevateInReveal] = useState(false);
  const [showSpinExtras, setShowSpinExtras] = useState(false);
  const [sparksCheckoutLoading, setSparksCheckoutLoading] = useState<string | null>(null);
  const [checkoutDiag, setCheckoutDiag] = useState<PurchaseDebugInfo | null>(null);
  // Drag-to-dismiss state for the Halo buy sheet
  const [haloDragY, setHaloDragY] = useState(0);
  const [haloDragSnapping, setHaloDragSnapping] = useState(false);
  const haloDragRef = useRef({ startY: 0, startTime: 0, active: false, currentY: 0 });
  const haloDismissTimerRef = useRef<number | null>(null);
  const haloSendInFlightRef = useRef(false);
  const closeProfileRef = useRef<(() => void) | null>(null);
  const [angle, setAngle] = useState(0);

  // Spin room + Halo state
  const [showSpinRoom, setShowSpinRoom] = useState(false);
  const [isResultClosing, setIsResultClosing] = useState(false);
  const [isHaloDismissing, setIsHaloDismissing] = useState(false);

  // Do not replace the wheel's candidate set during an active spin or result
  // reveal. On normal tab entry/foreground, this is a live feed just like
  // Discover, even though PersistentTabs never remounts this component.
  useCandidateFeedRefresh({
    active: isActive,
    enabled: !isSpinning && !showSpinRoom && !selectedProfile,
    feed: "intention-wheel",
    refresh: refetchProfiles,
  });
  useEffect(() => {
    setServiceWorkerReloadBlocked(isSpinning || showSpinRoom || !!selectedProfile || isResultClosing);
  }, [isSpinning, showSpinRoom, selectedProfile, isResultClosing]);
  useEffect(() => () => setServiceWorkerReloadBlocked(false), []);
  const [heroHandoffComplete, setHeroHandoffComplete] = useState(false);
  const [sparkSent, setSparkSent] = useState(false);
  const sparkSentRef = useRef(false);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySavedFor, setReplySavedFor] = useState<string | null>(null);
  // boundaryKey: incrementing remounts IntentResultBoundary with fresh hasError=false state.
  // boundaryRecovering: true while onReset fetch is in-flight — disables Continue button.
  const [boundaryKey,        setBoundaryKey]        = useState(0);
  const [boundaryRecovering, setBoundaryRecovering] = useState(false);
  // Quote shown in reveal stage — picked once when winner lands
  const [revealQuote, setRevealQuote] = useState<string>("");
  // Tension-build label shown during pullforward/momentum phases
  const [momentumLabel, setMomentumLabel] = useState<string>('');

  const { data: sparkStatus } = useQuery<{ sent: boolean }>({
    queryKey: ["/api/wheel/spark/status", selectedProfile?.userId],
    enabled: !!selectedProfile?.userId,
    staleTime: 15_000,
  });
  const haloSent = sparkSent || sparkStatus?.sent === true;
  useEffect(() => {
    sparkSentRef.current = haloSent;
    if (sparkStatus?.sent && !sparkSent) setSparkSent(true);
  }, [haloSent, sparkSent, sparkStatus?.sent]);

  useEffect(() => {
    if (!showSpinExtras) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [showSpinExtras]);

  // Real DNA compatibility reason for the spin-room reveal.
  // Uses /api/dna/reasons/:id → generateReasons(viewerDna, candidateDna) which produces
  // phrases like "You both value calm communication and emotional consistency."
  // Falls back to a neutral phrase when either user hasn't completed Connection DNA.
  const { data: dnaReasonsData } = useQuery<{ reasons: string[]; total: number }>({
    queryKey: ["/api/dna/reasons", selectedProfile?.userId],
    enabled: !!selectedProfile?.userId && showSpinRoom,
    staleTime: 10 * 60 * 1000,
  });
  // dnaReasonsData.reasons elements can arrive as {key,text} objects at runtime even
  // though typed as string[].  Rendering a raw object throws React error #31 ("Objects
  // are not valid as a React child").  renderText() extracts .text or returns '' for
  // nullish, so the ?? fallback kicks in for both missing data AND bad-shaped objects.
  const spinRoomInsight: string =
    renderText(dnaReasonsData?.reasons?.[0] as unknown) || t("spin_room_compat_fallback");

  // SpinRoom cinematic phase — drives what's visible at each moment
  // 'growing' = the locked orbit winner is being directly resized from its measured
  // card rect into the measured full-screen hero rect. The original DOM node stays
  // visible until the result photo has a geometry-identical handoff.
  type SpinPhase = 'idle' | 'accelerate' | 'fast' | 'slow' | 'approach' | 'pullforward' | 'arrive' | 'momentum' | 'growing' | 'reveal' | 'buttons';
  type HeroRect = { left: number; top: number; width: number; height: number };
  const [spinRoomPhase, setSpinRoomPhase] = useState<SpinPhase>('idle');

  // ── Orbit carousel: 5 stable card slots rotating on an ellipse ─────────────
  // 5 DOM divs are mounted once and never unmounted during the spin.
  // Their transforms are mutated directly by the rAF loop — zero React setState per frame.
  // orbitFrontCandRef tracks which slot (= candidate index) is currently at the front.
  // It is read by the pullforward timeout to choose the winner.
  const orbitCardRefs = useRef<(HTMLDivElement | null)[]>(Array(ORBIT_N).fill(null));
  const [orbitPhotoUrls, setOrbitPhotoUrls] = useState<(string | null)[]>(Array(ORBIT_N).fill(null));
  const spinPreparingRef = useRef(false);
  const [isPreparingSpin, setIsPreparingSpin] = useState(false);
  // Slot index (0–4) of the candidate currently closest to the front (depth peak).
  const orbitFrontCandRef = useRef(0);

  // ── Pre-determined winner (internal only until 'reveal' phase) ───────────────
  // Chosen in spinWheel() and stored here. Never put into React state until the
  // reveal phase fires — this prevents ANY winner exposure during the orbit spin.
  // Read by pullforward to steer the orbit snap, and by the 'reveal' timeout to
  // set selectedProfile (which is what actually mounts the reveal section).
  const pendingWinnerRef = useRef<{ index: number; profile: Profile } | null>(null);
  // This confirmation belongs to one exact event: the orbit lock.
  const winnerLockChimePlayedRef = useRef(false);

  // Orbit animation refs (glow + speed tracking only; bubble positioning removed)
  const orbitBubbles    = useRef<(HTMLDivElement | null)[]>([]); // kept for type compat
  const orbitAngleRef2  = useRef(0);
  const orbitSpeedRef2  = useRef(0);   // current speed °/s (used for glow intensity)
  const orbitTargetRef  = useRef(0);   // target speed °/s
  const orbitRafRef2    = useRef(0);
  const orbitLastTimeRef = useRef(0);
  const orbitGlowRef        = useRef<HTMLDivElement>(null);
  const heroTargetMeasureRef = useRef<HTMLDivElement>(null);
  const resultPhotoWrapperRef = useRef<HTMLDivElement>(null);
  // Ref to the momentum-label <p> so logWinnerNode can read its computed styles
  // without needing Safari Web Inspector. Attached via ref={momentumTextRef} in JSX.
  const momentumTextRef     = useRef<HTMLParagraphElement | null>(null);
  // Tracks the orbit angle at the previous RAF frame so the orbit tick-sound detector
  // can compute how many card-spacing boundaries were crossed in one frame.
  const prevOrbitAngleRef   = useRef(0);
  const orbitRingRef2   = useRef<HTMLDivElement>(null);  // kept for type compat
  const landingMarkerRef = useRef<HTMLDivElement>(null); // kept for type compat
  const spinPhaseRef = useRef<SpinPhase>('idle');  // readable inside RAF without stale-closure issues
  // ── Approach phase: guided deceleration toward winner ─────────────────────
  // Set by the approach useLayoutEffect; read by the orbit RAF tick.
  const orbitApproachCorrectionRef  = useRef(0);  // total angular distance (always positive/forward)
  const orbitApproachStartAngleRef  = useRef(0);  // orbit angle at approach start
  const orbitApproachStartTimeRef   = useRef(0);  // RAF timestamp when approach began (0 = not yet)
  // Computed on the guided-stop first tick to match current orbit speed — prevents jump.
  const orbitApproachDurationRef    = useRef(2400); // ms; overwritten per-spin
  // Turns the existing slow phase into a winner-planned guided stop. Starting this
  // while the orbit is still moving quickly avoids a distinct late correction spin.
  const orbitGuidedStopRef          = useRef(false);
  const heroTargetRectRef           = useRef<HeroRect | null>(null);
  // Becomes true only after the winning card's resting viewport rect has been
  // measured. JSX then stops writing its geometry until the handoff completes.
  const winnerHeroDomOwnedRef       = useRef(false);
  const spinGenerationRef           = useRef(0);
  const spinTimeoutIdsRef           = useRef<Set<number>>(new Set());
  const handoffRafRef               = useRef(0);
  // Set true when pullforward fires; any subsequent orbit angle change is a bug.
  const orbitLockedRef              = useRef(false);
  const winnerMomentStartRef        = useRef(0);  // performance.now() at pullforward; momentum RAF derives elapsed from this

  // During a spin, presentationLockedRef prevents query updates from changing
  // the candidate order. Outside that protected window, this always mirrors the
  // latest successful server pool, including an authoritative empty result.
  const items = shuffledItemsRef.current;
  const count = items.length;
  const angleStep = count > 0 ? 360 / count : 0;
  const radius = count > 4 ? Math.max(188, count * 26) : 172;
  const canSpin = spinStatus?.canSpin ?? false;

  const cancelWheelAsync = () => {
    spinTimeoutIdsRef.current.forEach(id => clearTimeout(id));
    spinTimeoutIdsRef.current.clear();
    cancelAnimationFrame(handoffRafRef.current);
    handoffRafRef.current = 0;
  };
  const scheduleWheelTimeout = (generation: number, callback: () => void, delay: number) => {
    const id = window.setTimeout(() => {
      spinTimeoutIdsRef.current.delete(id);
      if (spinGenerationRef.current === generation) callback();
    }, delay);
    spinTimeoutIdsRef.current.add(id);
    return id;
  };
  const scheduleHandoffFrame = (generation: number, callback: () => void) => {
    cancelAnimationFrame(handoffRafRef.current);
    handoffRafRef.current = requestAnimationFrame(() => {
      handoffRafRef.current = 0;
      if (spinGenerationRef.current === generation) callback();
    });
  };

  // Responsive wheel card dimensions — shrink on narrow phones to prevent clipping
  const [viewportW, setViewportW] = useState(() => typeof window !== "undefined" ? window.innerWidth : 390);
  const [viewportH, setViewportH] = useState(() => typeof window !== "undefined" ? window.innerHeight : 800);
  useEffect(() => {
    const h = () => { setViewportW(window.innerWidth); setViewportH(window.innerHeight); };
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  const isCompact = viewportH < 700;
  const itemWidth  = viewportW < 380 ? 160 : viewportW < 430 ? 170 : 216;
  const itemHeight = Math.round(itemWidth * (ITEM_HEIGHT / ITEM_WIDTH));
  // The main wheel is a static preview until Spin is pressed. Its resting layout
  // uses a wider, controlled card spread; the actual spin-time wheel radius and
  // transforms remain unchanged below.
  const restingCarouselRadius = Math.min(radius, Math.max(116, Math.floor(viewportW * 0.36)));
  const carouselRadius = (isSpinning || dispersed) ? radius : restingCarouselRadius;
  // Explicit resting slots prevent the 72° five-card ring from turning side
  // portraits into foreshortened strips on narrow phones. Side cards use
  // uniform scale plus a modest Y tilt, preserving their portrait ratio.
  const restingGap = viewportW < 380 ? 8 : 9;
  const restingSideWidth = Math.round(itemWidth * 0.506);
  const restingSideHeight = Math.round(itemHeight * 0.74);
  const restingSideOffset = Math.round(itemWidth / 2 + restingSideWidth / 2 + restingGap);
  const restingOuterOffset = Math.round(itemWidth * 0.75);
  // wheelBufferY = space below the card centre — must fit the name/age caption.
  // Formula: needs >= itemHeight * 0.10 + 96 px (card overhang + caption + margin).
  const wheelBufferY = isCompact ? 46 : viewportW < 380 ? 56 : 64;
  // The idle hero has its identity in a dedicated in-card footer, so it does not
  // need the external caption buffer reserved for the active spinning state.
  const restingStageExtra = viewportH < 760 ? 28 : 52;
  const wheelStageHeight = itemHeight + (isSpinning ? wheelBufferY : restingStageExtra);
  const isRestingComposition = !isSpinning && !dispersed && !showPurchase && !showProfile;

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

  // Dedup guard — prevents a second recordSpin call if the timer fires twice
  // (e.g. due to a fast re-mount or dev StrictMode double-effect).
  const recordSpinFiredRef = useRef(false);
  // Set true in saveSpinResult.onSuccess; checked by the reveal guard at t=5000 ms
  // to confirm the result is server-persisted before mounting the result UI.
  const saveSpinSucceededRef = useRef(false);

  const recordSpin = useMutation({
    mutationFn: async (standoutUserId: string) => {
      console.log("[INTENTION_WHEEL] spin_request_started", { standoutUserId });
      await apiRequest("POST", "/api/spin", { standoutUserId });
    },
    onSuccess: () => {
      console.log("[INTENTION_WHEEL] result_persisted");
      queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
    },
    onError: (err: unknown) => {
      console.error("[INTENTION_WHEEL] spin_record_failed", err);
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
      // The saved result stays intact. The sent state is verified from the
      // server on every restore, so dismissing an upsell cannot re-enable a
      // second Halo for the same connection.
      queryClient.invalidateQueries({ queryKey: ["/api/wheel/spark/status", selectedProfile?.userId] });
      // Keep the acknowledgement visible briefly, then use the same guarded
      // close lifecycle as an explicit dismissal. This clears the saved result
      // only after the acknowledgement has been visible and releases the
      // presentation lock through closeProfile's persistence callback.
      if (haloDismissTimerRef.current !== null) {
        window.clearTimeout(haloDismissTimerRef.current);
      }
      haloDismissTimerRef.current = window.setTimeout(() => {
        setIsHaloDismissing(true);
        haloDismissTimerRef.current = window.setTimeout(() => {
          haloDismissTimerRef.current = null;
          closeProfileRef.current?.();
        }, 260);
      }, SPIN_ROOM_TIMING.haloAcknowledgementMs);
    },
    onError: (error: any) => {
      haloSendInFlightRef.current = false;
      const raw = error?.message || "";
      let msg = t("something_went_wrong");
      try { const p = JSON.parse(raw); if (p?.message) msg = p.message; } catch {}
      toast({ title: t("could_not_connect_title"), description: msg, variant: "destructive" });
    },
  });

  // Auto-save the spin result to the server at pullforward time so it persists
  // across refresh, app close, and other devices.  Uses an upsert route that
  // bypasses the 409 guard on POST /api/wheel/save (which is for user-initiated saves).
  const saveSpinResult = useMutation({
    mutationFn: (profileId: string) => apiRequest("POST", "/api/spin/result", { profileId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/spin/result"] }),
  });

  // Delete the server-persisted spin result when the user explicitly acts on it.
  const deleteSpinResult = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/wheel/saved"),
    onSuccess: () => queryClient.setQueryData(["/api/spin/result"], { profile: null }),
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

  const spinWheel = async () => {
    if (isSpinning || spinPreparingRef.current || count === 0 || !canSpin) return;
    presentationLockedRef.current = true;
    spinPreparingRef.current = true;
    setIsPreparingSpin(true);
    cancelWheelAsync();
    spinGenerationRef.current += 1;

    const initialOrbitIds = Array.from(
      { length: ORBIT_N },
      (_, i) => items[i % Math.min(items.length, ORBIT_N)].userId,
    );
    const preparedPhotoUrls = await Promise.all(
      initialOrbitIds.map(async (userId) => {
        try {
          const data = await queryClient.fetchQuery<{ photos: string[] }>({
            queryKey: ["/api/profiles", userId, "photos"],
            staleTime: 5 * 60 * 1000,
          });
          return await decodeOrbitPhoto(data.photos?.[0]?.trim() ?? "");
        } catch {
          return null;
        }
      }),
    );
    setOrbitPhotoUrls(preparedPhotoUrls);
    spinPreparingRef.current = false;
    setIsPreparingSpin(false);

    setHeroHandoffComplete(false);
    ensureCtx();
    try { (navigator as any).vibrate?.([30]); } catch {}
    // Reset dedup guard so this fresh spin can record
    recordSpinFiredRef.current = false;
    saveSpinSucceededRef.current = false;
    pendingWinnerRef.current = null;
    winnerLockChimePlayedRef.current = false;
    orbitLockedRef.current = false;
    winnerHeroDomOwnedRef.current = false;
    console.log("[INTENTION_WHEEL] spin_request_started", { candidateCount: count });
    setShowSpinRoom(true);
    setIsSpinning(true);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setDispersed(false);
    setShowProfile(false);
    setShowPurchase(false);
    setShowConfetti(false);
    setSparkSent(false);

    // ── Pre-determine winner for the SpinRoom orbit ──────────────────────────
    // Only orbit-visible candidates (first ORBIT_N items) are eligible so the
    // winner card is always physically in the orbit ring and can be snapped to.
    // Stored in a ref — NOT state — so it is never rendered before reveal phase.
    const spinN = Math.min(count, ORBIT_N);
    const spinWinnerIdx = Math.floor(Math.random() * spinN);
    pendingWinnerRef.current = { index: spinWinnerIdx, profile: items[spinWinnerIdx] };

    // ── Background wheel animation (non-SpinRoom) ────────────────────────────
    // Uses a separate random index for the legacy angle-based wheel display that
    // plays behind the SpinRoom overlay.  Not connected to winner selection.
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
    if (isResultClosing) return;
    if (haloDismissTimerRef.current !== null) {
      window.clearTimeout(haloDismissTimerRef.current);
      haloDismissTimerRef.current = null;
    }
    haloSendInFlightRef.current = false;
    setIsHaloDismissing(false);
    cancelWheelAsync();
    spinGenerationRef.current += 1;
    setHeroHandoffComplete(false);
    // Close is an explicit advance action, even after a successful Halo.
    // The sent state remains stable while the result is open/reopened, but a
    // deliberate dismissal must return the member to future Wheel spins.
    // Keep a deferred service-worker reload blocked until this explicit
    // dismissal is persisted; otherwise an update could revive the result.
    setIsResultClosing(true);
    const profileToRestore = selectedProfile;
    deleteSpinResult.mutate(undefined, {
      onSuccess: () => {
        const outcome = resolveWheelDismissal(true);
        if (!outcome.releasePresentation) return;
        presentationLockedRef.current = false;
        prevProfilesRef.current = null;
        setIsResultClosing(false);
        queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
      },
      onError: (error) => {
        const outcome = resolveWheelDismissal(false);
        if (!outcome.reopenResult) return;
        // The result is still persisted. Restore it so the member can retry
        // rather than letting a pending worker update make it reappear later.
        setIsResultClosing(false);
        setShowSpinRoom(true);
        setSelectedProfile(profileToRestore);
        setSpinRoomPhase("buttons");
        toast({
          title: t("something_went_wrong"),
          description: error instanceof Error ? error.message : t("retry"),
          variant: "destructive",
        });
      },
    });
    pendingWinnerRef.current = null;
    recordSpinFiredRef.current = false;
    setShowSpinRoom(false);
    setSparkSent(false);
    setReplyTarget(null);
    setReplyDraft("");
    setReplySavedFor(null);
    setShowProfile(false);
    setDispersed(false);
    angleRef.current = 0;
    setAngle(0);
    setSelectedIndex(null);
    setSelectedProfile(null);
    setShowConfetti(false);
  };
  closeProfileRef.current = closeProfile;

  const handleSendHalo = () => {
    if (!canStartHaloSend({
      hasWinner: !!selectedProfile,
      haloSent,
      mutationPending: sendSpark.isPending,
      inFlight: haloSendInFlightRef.current,
    })) return;
    if (!selectedProfile) return;
    haloSendInFlightRef.current = true;
    sendSpark.mutate(selectedProfile.userId);
  };

  // ── SpinRoom copy timeline ──────────────────────────────────────────────────
  // These timers only change the supporting copy/phase label. Visible movement
  // is driven by activeOrbitProgress inside the single orbit RAF below.
  useEffect(() => {
    if (!showSpinRoom) {
      setSpinRoomPhase('idle');
      setMomentumLabel('');
      orbitTargetRef.current = 0;
      spinPhaseRef.current = 'idle';
      return;
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const go = (p: SpinPhase) => {
      spinPhaseRef.current = p;
      setSpinRoomPhase(p);
    };
    go('accelerate');
    console.log('[WHEEL] SPIN_START');
    const ts = [
      setTimeout(() => { go('fast'); console.log('[WHEEL] FAST_PHASE'); }, reducedMotion ? 120 : 250),
      setTimeout(() => { go('slow'); console.log('[WHEEL] CONTINUOUS_SLOWDOWN_PHASE'); }, reducedMotion ? 500 : 1800),
    ];
    return () => ts.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSpinRoom]);

  // ── Orbit RAF — drives all 5 card positions + glow ──────────────────────────
  // One rAF loop handles everything: angle advance, per-card depth math, DOM mutation.
  // Zero React setState during motion. The RAF exclusively owns transform,
  // opacity, and depth on stable, decode-complete card nodes.
  useEffect(() => {
    if (!showSpinRoom) {
      cancelAnimationFrame(orbitRafRef2.current);
      orbitCardRefs.current.forEach((el) => {
        if (el) el.removeAttribute('style');
      });
      spinPhaseRef.current     = 'idle';
      orbitSpeedRef2.current   = 0;
      orbitAngleRef2.current   = 0;
      orbitLastTimeRef.current = 0;
      orbitLockedRef.current   = false;
      orbitGuidedStopRef.current = false;
      heroTargetRectRef.current = null;
      winnerHeroDomOwnedRef.current = false;
      return;
    }
    const N = Math.min(items.length, ORBIT_N);
    if (N === 0) return;
    // Card 0 starts at the front (sin(angle + 0) = 1 → angle = π/2).
    orbitAngleRef2.current   = Math.PI / 2;
    prevOrbitAngleRef.current = Math.PI / 2; // tick detector baseline
    resetTick(Math.PI / 2);                  // sync tick tracker to orbit start angle
    orbitGuidedStopRef.current = false;
    heroTargetRectRef.current = null;
    winnerHeroDomOwnedRef.current = false;

    // Apply initial transforms instantly (no animation).
    // IMPORTANT: these DOM mutations happen here in the useEffect, NOT in JSX style,
    // because React must never overwrite the RAF's values during re-renders.
    for (let i = 0; i < ORBIT_N; i++) {
      const el = orbitCardRefs.current[i];
      if (!el) continue;
      // Reset every direct winner-to-hero mutation from the prior spin before the
      // orbit begins. These geometry properties deliberately stay out of JSX so
      // React renders cannot interrupt the RAF-owned transition.
      el.style.position = 'absolute';
      el.style.left = '50%';
      el.style.top = '50%';
      el.style.width = `${ORBIT_CARD_WIDTH}px`;
      el.style.height = `${ORBIT_CARD_HEIGHT}px`;
      el.style.visibility = 'visible';
      el.style.borderRadius = '28px';
      el.style.boxShadow = '';
      el.style.willChange = 'transform, opacity';
      el.style.backfaceVisibility = 'hidden';
      el.style.webkitBackfaceVisibility = 'hidden';
      const theta  = orbitAngleRef2.current + (2 * Math.PI / N) * i;
      const sinT   = Math.sin(theta);
      const cosT   = Math.cos(theta);
      const depth  = (sinT + 1) / 2;
      const scale  = (0.80 + depth * 0.20).toFixed(3);
      const x      = (cosT * ORBIT_RX).toFixed(1);
      const y      = ((1 - depth) * ORBIT_RY).toFixed(1);
      const rotate = (-cosT * 2.2).toFixed(2);
      el.style.transition = 'none';
      el.style.transform  = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), 0) rotate(${rotate}deg) scale(${scale})`;
      el.style.opacity    = (0.08 + Math.pow(depth, 2.2) * 0.92).toFixed(3);
      el.style.zIndex     = String(Math.round(depth * 100));
    }
    orbitFrontCandRef.current = 0; // card 0 is at front initially

    const orbitStartMs = performance.now();
    const orbitStartAngle = Math.PI / 2;
    const winnerIndex = pendingWinnerRef.current?.index ?? 0;
    const winnerTheta = orbitStartAngle + (2 * Math.PI / N) * winnerIndex;
    let winnerCorrection = (Math.PI / 2 - winnerTheta) % (2 * Math.PI);
    if (winnerCorrection < 0) winnerCorrection += 2 * Math.PI;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const orbitDurationMs = reducedMotion ? REDUCED_ORBIT_DURATION_MS : ACTIVE_ORBIT_DURATION_MS;
    const fullTurns = reducedMotion ? 1 : ACTIVE_ORBIT_FULL_TURNS;
    const orbitTravel = fullTurns * 2 * Math.PI + winnerCorrection;
    const orbitTargetAngle = orbitStartAngle + orbitTravel;
    let orbitElapsedMs = 0;
    let   logLastSec   = -1;

    const tick = (now: number) => {
      const dt = orbitLastTimeRef.current === 0
        ? 0.016
        : Math.min((now - orbitLastTimeRef.current) / 1000, 0.05);
      orbitLastTimeRef.current = now;
      orbitElapsedMs += dt * 1000;

      const phase = spinPhaseRef.current;

      // ── Approach phase: guided cubic-ease interpolation toward winner ─────
      // On the FIRST tick after approach begins, we capture the live orbit angle
      // (orbitAngleRef2) as the start and compute the exact correction from it.
      // This prevents the stale-angle jump that occurred when the useLayoutEffect
      // computed correction from a React-render snapshot (a few ms behind the RAF).
       if (orbitGuidedStopRef.current) {
        if (orbitApproachStartTimeRef.current === 0) {
          // First guided-stop tick — initialise from live RAF state.
          // IMPORTANT: read angle and speed from refs (RAF values), NOT from React state
          // (which is a few ms stale at render time).
          orbitApproachStartTimeRef.current  = now;
          orbitApproachStartAngleRef.current = orbitAngleRef2.current;
          // Compute always-forward angular distance to place winner at front (θ = π/2).
          const winnerIdxA = pendingWinnerRef.current?.index ?? 0;
          const thetaWinA  = orbitAngleRef2.current + (2 * Math.PI / N) * winnerIdxA;
          let corrA = (Math.PI / 2 - thetaWinA) % (2 * Math.PI);
          if (corrA < 0) corrA += 2 * Math.PI;
          // `corrA` is the one natural forward distance to the winner. Never add a
          // full turn here: doing so was the production root cause of the earlier
          // jump-spin. Starting at 5000 ms means even a large correction happens
          // while the wheel is visibly fast rather than after it appears stopped.
          orbitApproachCorrectionRef.current = corrA;
          // Compute a duration that never makes the first guided frame faster than
          // the previous visual frame. Cubic-ease-out has v(0)=3*distance/duration.
          // cubic-ease-out d/dt at t=0 = 3 * corrA / (dur_ms / 1000)
          // → dur_ms = 3000 * corrA / currentSpeed
          const currentSpeed = Math.max(0.05, orbitSpeedRef2.current); // rad/s
          // The 800 ms floor can only reduce initial velocity; it cannot accelerate
          // a near-front winner. The upper bound leaves enough room for a natural
          // stop without adding an artificial extra revolution.
          const dynamicDur = Math.max(800, Math.min(6500, Math.ceil(3000 * corrA / currentSpeed)));
          orbitApproachDurationRef.current = dynamicDur;
          const targetA = orbitApproachStartAngleRef.current + corrA;
          logWheelState({
            event: 'approach_start',
            orbitAngle: orbitAngleRef2.current.toFixed(4),
            targetAngle: targetA.toFixed(4),
            correctionRad: corrA.toFixed(4),
            winnerIndex: winnerIdxA,
            approachDurMs: dynamicDur,
            orbitSpeedRads: currentSpeed.toFixed(3),
            guidedAtMs: Math.round(now - orbitStartMs),
            pendingWinnerUserId: pendingWinnerRef.current?.profile?.userId ?? null,
          });
          // Transport to Railway so production orbit trace is readable without Safari console.
          postWheelDiag('orbit', {
            event: 'approach_start',
            currentAngle: orbitAngleRef2.current.toFixed(4),
            targetAngle: targetA.toFixed(4),
            correctionRad: corrA.toFixed(4),
            approachDuration: dynamicDur,
            orbitSpeed: currentSpeed.toFixed(3),
            guidedAtMs: Math.round(now - orbitStartMs),
            winnerLocked: false,
          });
        }

        const APPROACH_DUR = orbitApproachDurationRef.current; // ms — matched to current orbit speed
        const tApproach    = Math.min((now - orbitApproachStartTimeRef.current) / APPROACH_DUR, 1);
        const easeApproach = 1 - Math.pow(1 - tApproach, 3); // cubic ease-out
        const targetAngleA = orbitApproachStartAngleRef.current + orbitApproachCorrectionRef.current;
        const approachAngle = orbitApproachStartAngleRef.current +
                              orbitApproachCorrectionRef.current * easeApproach;
        // Tick sound: detect card-spacing crossings during approach deceleration.
        // Call tickFromAngle once per crossed boundary (cap at 3 per frame).
        {
          const _ts = (2 * Math.PI) / N;
          const _pb = Math.floor(prevOrbitAngleRef.current / _ts);
          const _cb = Math.floor(approachAngle / _ts);
          for (let tc = 0; tc < Math.min(_cb - _pb, 3); tc++) {
            tickFromAngle((_pb + tc + 1) * _ts, _ts);
          }
          prevOrbitAngleRef.current = approachAngle;
        }
        orbitAngleRef2.current = approachAngle;

        let frontI2 = 0, frontDepth2 = -1;
        for (let i = 0; i < ORBIT_N; i++) {
          const el = orbitCardRefs.current[i];
          if (!el) continue;
          const theta2 = approachAngle + (2 * Math.PI / N) * i;
          const sinT2  = Math.sin(theta2);
          const cosT2  = Math.cos(theta2);
          const depth2 = (sinT2 + 1) / 2;
          const scale2 = (0.80 + depth2 * 0.20).toFixed(3);
          const x2     = (cosT2 * ORBIT_RX).toFixed(1);
          const y2     = ((1 - depth2) * ORBIT_RY).toFixed(1);
          const rotate2 = (-cosT2 * 2.2).toFixed(2);
          el.style.transform = `translate3d(calc(-50% + ${x2}px), calc(-50% + ${y2}px), 0) rotate(${rotate2}deg) scale(${scale2})`;
          el.style.opacity   = (0.08 + Math.pow(depth2, 2.2) * 0.92).toFixed(3);
          el.style.zIndex    = String(Math.round(depth2 * 100));
          if (depth2 > frontDepth2) { frontDepth2 = depth2; frontI2 = i; }
        }
        orbitFrontCandRef.current = frontI2;
        // Keep the stage tonal as the orbit slows; the cards provide the motion.
        if (orbitGlowRef.current) {
          orbitGlowRef.current.style.boxShadow = '0 24px 70px rgba(12,6,10,0.18)';
        }

        // ── Convergence gate: fire pullforward when the approach duration has
        // fully elapsed (tApproach ≥ 1.0).  This replaces the old angularError<0.01
        // threshold which fired early when the winner was already near front-centre
        // (small corrA → error shrank below threshold mid-animation → jitter snap).
        if (tApproach >= 1.0) {
          // Snap to exact target, then hand off to pullforward.
          orbitAngleRef2.current = targetAngleA;
          // Apply exact final position to winner card
          const wIdxFinal = pendingWinnerRef.current?.index ?? frontI2;
          const elFinal   = orbitCardRefs.current[wIdxFinal];
          if (elFinal) {
            elFinal.style.transform = 'translate3d(-50%, -50%, 0) rotate(0deg) scale(1)';
            elFinal.style.opacity   = '1';
          }
          logWheelState({
            event: 'approach_complete',
            tApproach: tApproach.toFixed(6),
            winnerIndex: wIdxFinal,
            orbitAngle: targetAngleA.toFixed(4),
          });
          postWheelDiag('orbit', {
            event: 'approach_complete',
            currentAngle: targetAngleA.toFixed(4),
            tApproach: tApproach.toFixed(6),
            winnerLocked: false,
          });
          orbitGuidedStopRef.current = false;
          // Fire pullforward — pullforward useLayoutEffect drives all subsequent timing.
          setSpinRoomPhase('pullforward');
          setMomentumLabel('Narrowing down\u2026');
          return; // stop RAF; pullforward useLayoutEffect cancels the handle
        }

        orbitRafRef2.current = requestAnimationFrame(tick);
        return;
      }

      // Pause orbit when pullforward/reveal/etc. own the DOM.
      // Returning without rescheduling stops the RAF loop intentionally.
      // 'growing' is included: the CSS FLIP transition drives the winner card during
      // the growing phase and the orbit RAF must not overwrite its transform.
      if (phase === 'pullforward' || phase === 'arrive' || phase === 'momentum' ||
          phase === 'growing'     || phase === 'reveal' || phase === 'buttons') return;

      // Derive the whole orbit from one elapsed timestamp and one continuous
      // distance curve. There are no per-phase speed targets and no accumulated
      // frame-time drift.
      // Invariant: orbitAngle must NOT change after WINNER_LOCKED (pullforward).
      if (orbitLockedRef.current) {
        console.warn('[INTENTION_WHEEL_BUG]', 'orbit_changed_after_lock', {
          phase, speed: orbitSpeedRef2.current.toFixed(3) });
        postWheelDiag('orbit', {
          event: 'orbit_changed_after_lock',
          phase,
          currentAngle: orbitAngleRef2.current.toFixed(4),
          speed: orbitSpeedRef2.current.toFixed(3),
          winnerLocked: true,
        });
        // Hard stop — do NOT write to orbitAngle after WINNER_LOCKED.
        return;
      }
      const _prevAngle = orbitAngleRef2.current;
      // Accumulate clamped RAF deltas rather than using wall-clock elapsed time.
      // A backgrounded tab therefore resumes from its previous visual position
      // instead of jumping several seconds ahead on the first returning frame.
      const orbitElapsed = orbitElapsedMs;
      const orbitT = Math.min(orbitElapsed / orbitDurationMs, 1);
      orbitAngleRef2.current = orbitStartAngle + orbitTravel * activeOrbitProgress(orbitT);
      if (orbitT >= 1) orbitAngleRef2.current = orbitTargetAngle;
      const angle = orbitAngleRef2.current;
      orbitSpeedRef2.current = dt > 0 ? Math.max(0, (angle - _prevAngle) / dt) : 0;
      // Tick sound: play once per card-spacing boundary crossed (angle-driven, not timer).
      {
        const _ts = (2 * Math.PI) / N;
        const _pb = Math.floor(_prevAngle / _ts);
        const _cb = Math.floor(angle      / _ts);
        for (let tc = 0; tc < Math.min(_cb - _pb, 3); tc++) {
          tickFromAngle((_pb + tc + 1) * _ts, _ts);
        }
        prevOrbitAngleRef.current = angle;
      }

      // Update all 5 card DOM elements in one batch.
      // transform/opacity/filter/zIndex are NOT in the JSX style prop so React
      // never overwrites these mutations between frames.
      let frontI = 0, frontDepth = -1;
      for (let i = 0; i < ORBIT_N; i++) {
        const el = orbitCardRefs.current[i];
        if (!el) continue;
        const theta = angle + (2 * Math.PI / N) * i;
        const sinT  = Math.sin(theta);
        const cosT  = Math.cos(theta);
        const depth = (sinT + 1) / 2;
        const scale = (0.80 + depth * 0.20).toFixed(3);
        const x     = (cosT * ORBIT_RX).toFixed(1);
        const y     = ((1 - depth) * ORBIT_RY).toFixed(1);
        const rotate = (-cosT * 2.2).toFixed(2);
        el.style.transform = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), 0) rotate(${rotate}deg) scale(${scale})`;
        el.style.opacity   = (0.08 + Math.pow(depth, 2.2) * 0.92).toFixed(3);
        el.style.zIndex    = String(Math.round(depth * 100));
        if (depth > frontDepth) { frontDepth = depth; frontI = i; }

      }
      orbitFrontCandRef.current = frontI;

      // Per-second diagnostic log — confirms baseAngle IS advancing each second.
      // Logs once per elapsed second; never every frame.
      const nowSec = Math.floor((now - orbitStartMs) / 1000);
      if (nowSec > logLastSec) {
        logLastSec = nowSec;
        console.log('[INTENTION_WHEEL_ORBIT]', {
          baseAngle: orbitAngleRef2.current.toFixed(3),
          elapsedSec: nowSec,
          velocity: orbitSpeedRef2.current.toFixed(3),
          frontIndex: frontI,
          positions: Array.from({ length: N }, (_, ii) => {
            const th = orbitAngleRef2.current + (2 * Math.PI / N) * ii;
            return { slot: ii, x: +(Math.cos(th) * ORBIT_RX).toFixed(0), y: +(Math.sin(th) * ORBIT_RY).toFixed(0) };
          }),
        });
      }

      // Keep the stage quiet at every speed rather than pulsing like a game.
      if (orbitGlowRef.current) {
        orbitGlowRef.current.style.boxShadow = '0 24px 70px rgba(12,6,10,0.18)';
      }

      if (orbitT >= 1) {
        orbitSpeedRef2.current = 0;
        orbitFrontCandRef.current = winnerIndex;
        logWheelState({
          event: 'continuous_orbit_complete',
          durationMs: Math.round(orbitElapsed),
          winnerIndex,
          orbitAngle: orbitTargetAngle.toFixed(4),
          reducedMotion,
        });
        setSpinRoomPhase('pullforward');
        setMomentumLabel('Narrowing down\u2026');
        return;
      }

      orbitRafRef2.current = requestAnimationFrame(tick);
    };
    orbitRafRef2.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(orbitRafRef2.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSpinRoom]);

  // ── Pull-forward: orbit converged; winner centred; drive ALL subsequent timing ─
  // This effect owns every milestone from "winner locked" to "buttons visible".
  // A single winnerMomentStart RAF replaces chained timeouts so elapsed time is
  // derived from a real timestamp — not assumed from stacked setTimeout durations.
  //
  // Required timing (user spec):
  //   0–1300 ms:    "Narrowing down…"   (set by approach RAF before firing this phase)
  //   1300–2600 ms: "There's something here…" + scale 1.000 → 1.015
  //   2600–4300 ms: "Tonight's connection" holds while the room darkens
  //   4300–7300 ms: original winner geometry grows from card → hero
  //   7300–8200 ms: full hero geometry holds before the guarded handoff
  //   8200 ms:      result mounts only after geometry verification
  //
  // CLEANUP: The RAF is self-terminating (stops when all milestones fire) and is
  // also cancelled by the orbit RAF useEffect's cleanup when showSpinRoom = false.
  // We intentionally do NOT return a cleanup here — a cleanup would cancel the
  // momentum RAF the moment setSpinRoomPhase('momentum') fires at milestone t=1900
  // (because spinRoomPhase dep change re-runs this effect's cleanup).
  useLayoutEffect(() => {
    if (spinRoomPhase !== 'pullforward') return;
    const spinGeneration = spinGenerationRef.current;
    const isCurrentSpin = () => spinGenerationRef.current === spinGeneration;
    spinPhaseRef.current = 'pullforward';
    cancelAnimationFrame(orbitRafRef2.current);
    orbitApproachStartTimeRef.current = 0; // reset for next spin

    const pending  = pendingWinnerRef.current;
    const winner   = pending?.profile ?? null;
    const frontI   = pending?.index ?? orbitFrontCandRef.current;
    const winnerEl = orbitCardRefs.current[frontI];

    if (!winner?.userId) {
      // Approach RAF should have guarded this; abort safely if it slipped through.
      logWheelState({ event: 'pullforward_no_winner', frontI });
      setShowSpinRoom(false);
      return;
    }

    // ── WINNER_LOCKED — orbit angle must not change after this point ─────────
    orbitLockedRef.current = true;
    logWheelState({
      event: 'pullforward',
      winnerIndex: frontI,
      pendingWinnerUserId: winner.userId,
      orbitAngle: orbitAngleRef2.current.toFixed(4),
    });
    postWheelDiag('orbit', {
      event: 'pullforward',
      currentAngle: orbitAngleRef2.current.toFixed(4),
      winnerUserId: winner.userId,
      winnerLocked: true,
    });

    // ── Persist NOW — 6 s before reveal mounts, giving server time to save ──
    saveSpinSucceededRef.current = false;
    logWheelState({ event: 'persist_start', pendingWinnerUserId: winner.userId });
    saveSpinResult.mutate(winner.userId, {
      onSuccess: () => {
        if (!isCurrentSpin()) return;
        saveSpinSucceededRef.current = true;
        logWheelState({ event: 'persist_success', persistedUserId: winner.userId });
      },
    });
    if (!recordSpinFiredRef.current) {
      recordSpinFiredRef.current = true;
      recordSpin.mutate(winner.userId);
    }

    // ── Step 0: lock winner card; capture loser opacities from guided stop ─────
    // The approach RAF's final tick left each card at its per-depth opacity.
    // We read those values here so the momentum RAF can fade FROM there (not from
    // a hardcoded 0.28), preventing the "cards jump brighter" artifact that made
    // the orbit look still-active at pullforward start.
    const copyRect = (rect: DOMRect): HeroRect => ({
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    });
    const startRect = winnerEl ? copyRect(winnerEl.getBoundingClientRect()) : null;
    const targetRect = heroTargetMeasureRef.current
      ? copyRect(heroTargetMeasureRef.current.getBoundingClientRect())
      : null;
    heroTargetRectRef.current = targetRect;

    if (winnerEl && startRect) {
      // Preserve the winner's exact visual rectangle, then take direct ownership
      // of its viewport geometry. React intentionally does not own these props,
      // so re-renders during the text sequence cannot interrupt this one DOM node.
      winnerEl.style.transition = 'none';
      winnerEl.style.position   = 'fixed';
      winnerEl.style.left       = `${startRect.left}px`;
      winnerEl.style.top        = `${startRect.top}px`;
      winnerEl.style.width      = `${startRect.width}px`;
      winnerEl.style.height     = `${startRect.height}px`;
      winnerEl.style.transform  = 'none';
      winnerEl.style.opacity    = '1';
      winnerEl.style.filter     = '';
      winnerEl.style.visibility = 'visible';
      winnerEl.style.zIndex     = '200';
      winnerEl.style.boxShadow  = '0 22px 64px rgba(12,6,10,0.34)';
      logWheelState({
        event: 'hero_geometry_locked',
        startRect: `${startRect.left.toFixed(1)},${startRect.top.toFixed(1)} ${startRect.width.toFixed(1)}x${startRect.height.toFixed(1)}`,
        targetRect: targetRect
          ? `${targetRect.left.toFixed(1)},${targetRect.top.toFixed(1)} ${targetRect.width.toFixed(1)}x${targetRect.height.toFixed(1)}`
          : 'missing',
      });
      winnerHeroDomOwnedRef.current = true;
    }
    // Capture loser starting opacities; disable any residual CSS transitions.
    const loserStartAlpha: number[] = new Array(ORBIT_N).fill(0);
    for (let i = 0; i < ORBIT_N; i++) {
      if (i === frontI) continue;
      const el = orbitCardRefs.current[i];
      if (el) {
        loserStartAlpha[i] = parseFloat(el.style.opacity || '0');
        el.style.transition = 'none'; // RAF owns opacity/filter from here
      }
    }
    if (orbitGlowRef.current) {
      orbitGlowRef.current.style.transition = '';
      orbitGlowRef.current.style.boxShadow  = '0 24px 70px rgba(12,6,10,0.18)';
    }
    if (!winnerLockChimePlayedRef.current) {
      winnerLockChimePlayedRef.current = true;
      playChime();
    }
    try { (navigator as any).vibrate?.([20, 10, 40]); } catch {}

    // ── Winner-reveal RAF — sole owner of winner card geometry until handoff ───
    //
    // CINEMATIC TIMELINE:
    //   0–2600 ms     locked card stays at its actual start rect; copy and glow build
    //   2600–4300 ms  "Tonight's connection" holds; hero geometry stays still
    //   4300–7300 ms  original card interpolates startRect → targetRect (3 seconds)
    //   7300–8200 ms  full hero geometry holds
    //   8200 ms       geometry-checked result handoff; buttons fire +700 ms later
    //
    // Loser-card opacity: fade from approach-residual → 0 over first 1800 ms.
    winnerMomentStartRef.current = performance.now();

    const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
    const geometryProgress = (elapsed: number) => {
      const raw = Math.min(
        1,
        Math.max(0, (elapsed - SPIN_ROOM_TIMING.growStartMs) / SPIN_ROOM_TIMING.growDurationMs),
      );
      // The gentle front-load reaches ~38% and ~73% at the requested checkpoints,
      // then eases a little more slowly into the final hero rectangle.
      return raw + 0.10 * raw * (1 - raw);
    };

    // Helper: log [INTENTION_WHEEL_WINNER_NODE] diagnostics.
    // Reads computed geometry + opacity so we can verify via Railway logs whether
    // the orbit card is visible and whether the text is visible at each checkpoint.
    // No behaviour changes — instrumentation only.
    const logWinnerNode = (checkpoint: string, label = '') => {
      const el  = orbitCardRefs.current[frontI];
      const xfm = el?.style.transform ?? '(none)';
      const scaleMatch = xfm.match(/scale\(([\d.]+)\)/);
      const elCs  = el ? getComputedStyle(el) : null;
      const elBrc = el ? el.getBoundingClientRect() : null;

      // Text element state — points to the <p> with ref={momentumTextRef}
      const txtEl  = momentumTextRef.current;
      const txtCs  = txtEl ? getComputedStyle(txtEl) : null;
      const txtBrc = txtEl ? txtEl.getBoundingClientRect() : null;
      // Walk up to check if any ancestor is display:none / visibility:hidden
      let ancestorHides = false;
      let node: HTMLElement | null = txtEl ?? null;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          ancestorHides = true; break;
        }
        node = node.parentElement;
      }

      const payload = {
        checkpoint,
        // Winner card
        userId:       winner.userId,
        slot:         frontI,
        reactKey:     frontI,
        transform:    xfm,
        scale:        scaleMatch ? scaleMatch[1] : '?',
        isConnected:  el?.isConnected ?? false,
        width:        elBrc ? elBrc.width.toFixed(1)  : '?',
        height:       elBrc ? elBrc.height.toFixed(1) : '?',
        cardOpacity:  el?.style.opacity ?? elCs?.opacity ?? '?',
        cardZIndex:   el?.style.zIndex  ?? elCs?.zIndex  ?? '?',
        phase:        spinPhaseRef.current,
        // Text element
        textContent:  txtEl?.textContent?.trim() ?? '(null)',
        textLabel:    label,
        textExists:   !!(txtEl?.isConnected),
        textOpacity:  txtCs?.opacity     ?? '?',
        textDisplay:  txtCs?.display     ?? '?',
        textVisibility: txtCs?.visibility ?? '?',
        textZIndex:   txtCs?.zIndex      ?? '?',
        textRect:     txtBrc
          ? `${txtBrc.x.toFixed(0)},${txtBrc.y.toFixed(0)} ${txtBrc.width.toFixed(0)}×${txtBrc.height.toFixed(0)}`
          : '?',
        ancestorHidesText: ancestorHides,
      };

      // Client console (Safari Web Inspector)
      console.log('[INTENTION_WHEEL_WINNER_NODE]', payload);
      // Railway transport — accessible without a physical device
      postWheelDiag('winner_node', payload);
    };

    type Milestone = { t: number; fn: () => void };
    const milestones: Milestone[] = [
      // t=1300: "There's something here…"
      { t: SPIN_ROOM_TIMING.firstMessageMs, fn: () => {
        setMomentumLabel('There\u2019s something here\u2026');
        logWheelState({ event: 'text_1', elapsed: SPIN_ROOM_TIMING.firstMessageMs });
        logWinnerNode('text_1', 'There\u2019s something here\u2026');
      }},
      // t=2600: "Tonight's connection" + go('momentum')
      // 'momentum' keeps the orbit RAF early-return guard active.
      { t: SPIN_ROOM_TIMING.finalMessageMs, fn: () => {
        setMomentumLabel('Tonight\u2019s connection');
        setSpinRoomPhase('momentum');
        logWheelState({ event: 'text_2', elapsed: SPIN_ROOM_TIMING.finalMessageMs });
        logWinnerNode('text_2', 'Tonight\u2019s connection');
      }},
      // t=4300: GROWING — the final words have held for a readable beat before
      // the existing geometry enlargement begins.
      { t: SPIN_ROOM_TIMING.growStartMs, fn: () => {
        setSpinRoomPhase('growing');
        logWheelState({ event: 'growing_start', elapsed: SPIN_ROOM_TIMING.growStartMs });
        logWinnerNode('growing_start', 'Tonight\u2019s connection');
      }},
      // t=4300: clear the final words as the existing enlargement starts.
      { t: SPIN_ROOM_TIMING.growStartMs, fn: () => {
        setMomentumLabel('');
        logWheelState({ event: 'text_fade_out', elapsed: SPIN_ROOM_TIMING.growStartMs });
      }},
      // t=8200: Result may only take over after the original winner has held the
      // target geometry and its measured rectangle matches the measured hero target.
      { t: SPIN_ROOM_TIMING.resultHandoffMs, fn: () => {
        logWheelState({ event: 'result_start', elapsed: SPIN_ROOM_TIMING.resultHandoffMs });
        logWinnerNode('result_start', '');

        const revealAttempt = (attempt: number) => {
          if (!isCurrentSpin()) return;
          if (!saveSpinSucceededRef.current && attempt < 15) {
            logWheelState({ event: 'result_waiting_for_persist', attempt });
            scheduleWheelTimeout(spinGeneration, () => revealAttempt(attempt + 1), 200);
            return;
          }
          const orbitRect = winnerEl ? copyRect(winnerEl.getBoundingClientRect()) : null;
          const liveTarget = heroTargetMeasureRef.current
            ? copyRect(heroTargetMeasureRef.current.getBoundingClientRect())
            : null;
          if (liveTarget) heroTargetRectRef.current = liveTarget;
          const target = liveTarget ?? heroTargetRectRef.current;
          const deltaLeft = orbitRect && target ? orbitRect.left - target.left : Number.NaN;
          const deltaTop = orbitRect && target ? orbitRect.top - target.top : Number.NaN;
          const deltaWidth = orbitRect && target ? orbitRect.width - target.width : Number.NaN;
          const deltaHeight = orbitRect && target ? orbitRect.height - target.height : Number.NaN;
          const geometryMatches = !!orbitRect && !!target &&
            Math.abs(deltaLeft) <= 1 && Math.abs(deltaTop) <= 1 &&
            Math.abs(deltaWidth) <= 1 && Math.abs(deltaHeight) <= 1;
          const handoffPayload = {
            event: 'handoff_preflight',
            orbitRect: orbitRect
              ? `${orbitRect.left.toFixed(1)},${orbitRect.top.toFixed(1)} ${orbitRect.width.toFixed(1)}x${orbitRect.height.toFixed(1)}`
              : 'missing',
            resultRect: target
              ? `${target.left.toFixed(1)},${target.top.toFixed(1)} ${target.width.toFixed(1)}x${target.height.toFixed(1)}`
              : 'missing',
            deltaLeft: Number.isFinite(deltaLeft) ? deltaLeft.toFixed(2) : 'missing',
            deltaTop: Number.isFinite(deltaTop) ? deltaTop.toFixed(2) : 'missing',
            deltaWidth: Number.isFinite(deltaWidth) ? deltaWidth.toFixed(2) : 'missing',
            deltaHeight: Number.isFinite(deltaHeight) ? deltaHeight.toFixed(2) : 'missing',
            geometryMatches,
            attempt,
          };
          console.log('[INTENTION_WHEEL_HANDOFF]', handoffPayload);
          logWheelState(handoffPayload);
          postWheelDiag('winner_node', handoffPayload);
          if (!geometryMatches) {
            // A mobile viewport can change while the cinematic card is growing.
            // Re-align the original node to the newly measured target and retry;
            // never reveal a second image against stale geometry.
            if (winnerEl && target) {
              winnerEl.style.left = `${target.left.toFixed(2)}px`;
              winnerEl.style.top = `${target.top.toFixed(2)}px`;
              winnerEl.style.width = `${target.width.toFixed(2)}px`;
              winnerEl.style.height = `${target.height.toFixed(2)}px`;
              winnerEl.style.borderRadius = '0px';
            }
            if (attempt < 30) {
              scheduleHandoffFrame(spinGeneration, () => revealAttempt(attempt + 1));
            } else {
              logWheelState({ event: 'handoff_blocked_geometry_mismatch' });
            }
            return;
          }
          const profileNow = pendingWinnerRef.current?.profile;
          if (!profileNow?.userId) {
            logWheelState({ event: 'result_aborted_no_winner' });
            setShowSpinRoom(false);
            return;
          }
          // Normalise ALL directly-rendered fields — prevents React error #31.
          const normProfile = normaliseProfileForRender(profileNow);
          logWheelState({
            event: 'result_ready',
            selectedProfileUserId: profileNow.userId,
            saveSucceeded:         saveSpinSucceededRef.current,
          });
          logWinnerNode('result_ready');
          setSelectedIndex(pendingWinnerRef.current?.index ?? frontI);
          setSelectedProfile(normProfile);
          setRevealQuote(LULOU_QUOTE_KEYS[Math.floor(Math.random() * LULOU_QUOTE_KEYS.length)]);
          // The result photo mounts only after its planned viewport rect matches the
          // still-visible orbit winner. The layout effect below logs the actual
          // result-photo measurement and hides the old owner on the next frame.
          setHeroHandoffComplete(false);
          setSpinRoomPhase('reveal');
          try { (navigator as any).vibrate?.([60, 40, 120]); } catch {}
        };
        revealAttempt(0);
      }},
    ];

    let mI = 0;
    let geometryLogBucket = -1;
    const momentumTick = (now: number) => {
      const elapsed = now - winnerMomentStartRef.current;

      // ── Per-frame DOM writes — original winner owns the whole enlargement ────
      if (winnerEl && startRect && targetRect) {
        const progress = geometryProgress(elapsed);
        winnerEl.style.left = `${lerp(startRect.left, targetRect.left, progress).toFixed(2)}px`;
        winnerEl.style.top = `${lerp(startRect.top, targetRect.top, progress).toFixed(2)}px`;
        winnerEl.style.width = `${lerp(startRect.width, targetRect.width, progress).toFixed(2)}px`;
        winnerEl.style.height = `${lerp(startRect.height, targetRect.height, progress).toFixed(2)}px`;
        winnerEl.style.borderRadius = `${lerp(18, 0, progress).toFixed(2)}px`;
        const gt = Math.min(1, elapsed / 7000);
        winnerEl.style.boxShadow =
          `0 ${Math.round(18 + gt * 8)}px ${Math.round(46 + gt * 18)}px rgba(12,6,10,${(0.30 + gt * 0.12).toFixed(3)})`;
        const geometryBucket = Math.floor(elapsed / 500);
        if (geometryBucket > geometryLogBucket) {
          geometryLogBucket = geometryBucket;
          const rect = winnerEl.getBoundingClientRect();
          const payload = {
            elapsed: Math.round(elapsed),
            geometryProgress: progress.toFixed(4),
            rect: `${rect.left.toFixed(1)},${rect.top.toFixed(1)} ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
          };
          console.log('[INTENTION_WHEEL_HERO_GEOMETRY]', payload);
          logWheelState({ event: 'hero_geometry_sample', ...payload });
          postWheelDiag('scale', { ...payload, phase: spinPhaseRef.current, winnerUserId: winner.userId });
        }
      }
      // A static tonal shadow supports the original winner without a reveal bloom.
      if (orbitGlowRef.current) {
        orbitGlowRef.current.style.boxShadow = '0 24px 70px rgba(12,6,10,0.18)';
      }
      // Loser cards: fade from approach-residual opacity → 0 over first 1800 ms.
      const loserT = elapsed < 1800 ? Math.max(0, 1 - elapsed / 1800) : 0;
      for (let i = 0; i < ORBIT_N; i++) {
        if (i === frontI) continue;
        const loserEl = orbitCardRefs.current[i];
        if (loserEl) {
          const alpha = loserStartAlpha[i] * loserT;
          loserEl.style.opacity = alpha.toFixed(3);
          loserEl.style.filter  = alpha > 0.05 ? `blur(${(3 * loserT).toFixed(1)}px)` : 'blur(6px)';
        }
      }

      // ── Milestone triggers ─────────────────────────────────────────────────
      while (mI < milestones.length && elapsed >= milestones[mI].t) {
        milestones[mI].fn();
        mI++;
      }
      if (mI < milestones.length) {
        orbitRafRef2.current = requestAnimationFrame(momentumTick);
      }
      // RAF naturally stops after the geometry-checked handoff milestone fires.
    };
    orbitRafRef2.current = requestAnimationFrame(momentumTick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinRoomPhase]);

  // The preflight above prevents mounting a second photo at the wrong geometry.
  // This layout read verifies the mounted result wrapper as well, then transfers
  // ownership on the following frame so there is never a visible card-to-photo jump.
  useLayoutEffect(() => {
    if (spinRoomPhase !== 'reveal' && spinRoomPhase !== 'buttons') return;
    const orbitEl = orbitCardRefs.current[pendingWinnerRef.current?.index ?? -1];
    const resultEl = resultPhotoWrapperRef.current;
    if (!orbitEl || !resultEl) return;

    const orbitRect = orbitEl.getBoundingClientRect();
    const resultRect = resultEl.getBoundingClientRect();
    const deltaLeft = orbitRect.left - resultRect.left;
    const deltaTop = orbitRect.top - resultRect.top;
    const deltaWidth = orbitRect.width - resultRect.width;
    const deltaHeight = orbitRect.height - resultRect.height;
    const geometryMatches =
      Math.abs(deltaLeft) <= 1 && Math.abs(deltaTop) <= 1 &&
      Math.abs(deltaWidth) <= 1 && Math.abs(deltaHeight) <= 1;
    const payload = {
      event: 'handoff_measured',
      orbitRect: `${orbitRect.left.toFixed(1)},${orbitRect.top.toFixed(1)} ${orbitRect.width.toFixed(1)}x${orbitRect.height.toFixed(1)}`,
      resultRect: `${resultRect.left.toFixed(1)},${resultRect.top.toFixed(1)} ${resultRect.width.toFixed(1)}x${resultRect.height.toFixed(1)}`,
      deltaLeft: deltaLeft.toFixed(2),
      deltaTop: deltaTop.toFixed(2),
      deltaWidth: deltaWidth.toFixed(2),
      deltaHeight: deltaHeight.toFixed(2),
      geometryMatches,
    };
    console.log('[INTENTION_WHEEL_HANDOFF]', payload);
    logWheelState(payload);
    postWheelDiag('winner_node', payload);

    if (!geometryMatches) {
      // A resize landed between the preflight and this layout read. Preserve the
      // original photo, re-align it to the newly measured target, then retry the
      // hidden handoff rather than stranding the user in the growing phase.
      cancelWheelAsync();
      const recoveryGeneration = spinGenerationRef.current + 1;
      spinGenerationRef.current = recoveryGeneration;
      const realignWinner = () => {
        const target = heroTargetMeasureRef.current?.getBoundingClientRect();
        if (!target) return;
        orbitEl.style.left = `${target.left.toFixed(2)}px`;
        orbitEl.style.top = `${target.top.toFixed(2)}px`;
        orbitEl.style.width = `${target.width.toFixed(2)}px`;
        orbitEl.style.height = `${target.height.toFixed(2)}px`;
        orbitEl.style.borderRadius = '0px';
        heroTargetRectRef.current = {
          left: target.left, top: target.top, width: target.width, height: target.height,
        };
      };
      realignWinner();
      setHeroHandoffComplete(false);
      setSpinRoomPhase('growing');
      scheduleHandoffFrame(recoveryGeneration, () => {
        realignWinner();
        scheduleHandoffFrame(recoveryGeneration, () => {
          setSpinRoomPhase('reveal');
        });
      });
      return;
    }
    setHeroHandoffComplete(true);
    scheduleHandoffFrame(spinGenerationRef.current, () => {
      orbitEl.style.visibility = 'hidden';
    });
    if (spinRoomPhase === 'reveal') {
      const generation = spinGenerationRef.current;
      scheduleWheelTimeout(generation, () => {
        setSpinRoomPhase('buttons');
        console.log('[WHEEL] BUTTONS_VISIBLE');
      }, SPIN_ROOM_TIMING.controlsDelayMs);
    }
  }, [spinRoomPhase]);

  // ── Arrive: update phase ref only (winner state already applied by pullforward) ─
  useLayoutEffect(() => {
    if (spinRoomPhase !== 'arrive') return;
    spinPhaseRef.current = 'arrive';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinRoomPhase]);

  // The result overlay receives the winner only after the direct card-to-hero
  // geometry handoff above has passed its measured tolerance check.

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrame.current);
      cancelWheelAsync();
      spinGenerationRef.current += 1;
    };
  // Intentionally registered once: refs keep the cleanup current without making
  // phase changes cancel the active cinematic sequence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const t0 = performance.now();
    console.log("[INTENT] MOUNTED");
    return () => console.log("[INTENT] UNMOUNTED after", Math.round(performance.now() - t0), "ms");
  }, []);

  // ── Sparks purchase success: confirm payment then show toast ──────────────
  // Phase 1: poll purchase-status (webhook path, DB-only read, no granting)
  // Phase 2: fall back to extras-activate (verified Stripe API fallback)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("sparks_session");
    if (!sessionId) return;

    // Clean the URL immediately so reload/back doesn't re-trigger
    window.history.replaceState({}, "", window.location.pathname);

    const POLL_TRIES   = 8;
    const POLL_MS      = 2000;
    const MAX_FALLBACK = 5;
    let pollTries      = 0;
    let fallbackTries  = 0;

    const showSuccess = (qty: number) => {
      queryClient.invalidateQueries({ queryKey: ["/api/spin-status"] });
      toast({
        title: `${qty === 1 ? "1 Halo" : `${qty} Halos`} added`,
        description: "Spin the wheel to send a Halo tonight.",
      });
    };

    const activateFallback = async () => {
      fallbackTries++;
      try {
        const res = await apiRequest("POST", "/api/stripe/extras-activate", { sessionId });
        const data = await res.json();
        if (res.ok && data.success) {
          const qty = (data.granted as string[])?.filter((g: string) => g === "spin_credit").length ?? 1;
          showSuccess(qty);
        } else if (res.status === 402 && fallbackTries < MAX_FALLBACK) {
          setTimeout(activateFallback, POLL_MS);
        } else {
          toast({ title: "Activation failed", description: data.message ?? "Please contact support.", variant: "destructive" });
        }
      } catch {
        if (fallbackTries < MAX_FALLBACK) setTimeout(activateFallback, POLL_MS * 1.5);
      }
    };

    const pollStatus = async () => {
      pollTries++;
      try {
        const authHeaders = await import("@/lib/queryClient").then(m => m.getAuthHeaders());
        const { API_BASE: base } = await import("@/lib/queryClient");
        const res = await fetch(
          `${base}/api/stripe/purchase-status?session_id=${encodeURIComponent(sessionId)}`,
          { headers: authHeaders, credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          if (data.granted) {
            // Count spark credits from itemRef (e.g. "sparks-3" → 3)
            const match = String(data.itemRef ?? "").match(/sparks-(\d+)/);
            showSuccess(match ? parseInt(match[1], 10) : 1);
            return;
          }
        }
      } catch { /* keep polling */ }

      if (pollTries < POLL_TRIES) setTimeout(pollStatus, POLL_MS);
      else activateFallback();
    };

    pollStatus();
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

  // ── Spin result restoration ─────────────────────────────────────────────────
  // On mount, check the server for a persisted spin result (saved_wheel_profiles
  // table).  If one exists, fetch the full profile and restore the detail sheet
  // so the user can still act on their result after refresh, close, or switching
  // devices.  The query is disabled once a profile is already showing.
  const { data: savedSpinResultData } = useQuery<{ profile: Profile | null }>({
    queryKey: ["/api/spin/result"],
    staleTime: 0,
    enabled: !selectedProfile && !showSpinRoom,
  });
  useEffect(() => {
    const p = savedSpinResultData?.profile;
    if (!p?.userId) return;
    if (selectedProfile || showSpinRoom) return;  // active spin takes precedence
    console.log("[INTENTION_WHEEL] result_restored_from_server", { candidateId: p.userId });
    setSelectedProfile(p);
    setShowProfile(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSpinResultData]);

  // ── Periodic profile refresh while spin is locked ─────────────────────────
  // Keeps the wheel feeling alive — profiles rotate every 90 s so the user
  // sees a changing set of people even without an available spin.
  // Cleans up automatically when the spin becomes available again.
  useEffect(() => {
    if (canSpin || isSpinning || showSpinRoom || selectedProfile) return;
    const id = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
    }, 90_000);
    return () => clearInterval(id);
  }, [canSpin, isSpinning, showSpinRoom, selectedProfile, queryClient]);

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
    // Error state: network failure, 401, 403, 500, missing profile row, etc.
    // Always show a Retry button — never let a transient error look like "no profiles".
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <LulouFlowerIcon className="w-10 h-10 text-muted-foreground mx-auto opacity-60" />
          <p className="text-muted-foreground text-sm">{t("unable_to_load_profiles")}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={() => refetchProfiles()}
            data-testid="button-retry-intent-error"
          >
            {t("retry_btn")}
          </button>
        </div>
      </div>
    );
  }

  // Empty state: only shown after a SUCCESSFUL 200 response that genuinely
  // returned no eligible candidates.  Must never appear for errors.
  if (items.length === 0) {
    // Build a safe copyable summary of the diagnostic data
    const diagText = wheelDiag
      ? (() => {
          const d = wheelDiag;
          const fc = d.filterCounts ?? {};
          const lines: string[] = [
            "[WHEEL_DIAG]",
            `user=${d.userIdPrefix}  gender=${d.gender ?? "(unset)"}  normGender=${d.normGender ?? "(unset)"}`,
            `preference=${d.preference ?? "(unset)"}  normPreference=${d.normPreference ?? "(unset)"}`,
            `targetGenders=${JSON.stringify(d.targetGenders)}`,
            `prefsIncludingMyGender=${JSON.stringify(d.prefsIncludingMyGender)}`,
            `location=${d.location ?? "(unset)"}  hasCoords=${d.hasCoords}  radius=${d.locationRadius}mi`,
            `ageRange=${d.ageRange}`,
            "",
            "[EXCLUSION SETS]",
            `wheelActedCount=${d.wheelActedCount}  discoverActedCount=${d.discoverActedCount}`,
            `activeMatchCount=${d.activeMatchCount}  inboundLikerCount=${d.inboundLikerCount}`,
            `discoverOnlySaved=${d.discoverOnlySaved}  (profiles re-admitted by discover-isolation fix)`,
            "",
            "[FILTER COUNTS]",
            `totalInDb=${fc.totalInDb}`,
            `afterSelf=${fc.afterSelf}`,
            `afterPaused=${fc.afterPaused}`,
            `afterEmailVerified=${fc.afterEmailVerified}`,
            `afterOnboarding=${fc.afterOnboarding}`,
            `afterGenderPref=${fc.afterGenderPref}`,
            `afterAge=${fc.afterAge}`,
            `afterActiveMatch=${fc.afterActiveMatch}`,
            `afterWheelActed=${fc.afterWheelActed}`,
            `afterInboundLiker=${fc.afterInboundLiker}`,
            `afterDistance=${fc.afterDistance}`,
            `FINAL=${fc.finalCount}`,
            "",
            "[EXCLUSIONS]",
            ...((d.exclusions ?? []) as any[]).map((e: any) =>
              `  ${e.candidateIdPrefix} ${e.candidateName}: ${e.excludedReason}`
            ),
            "",
            `diagMs=${d.diagMs}`,
          ];
          return lines.join("\n");
        })()
      : null;

    return (
      <div className="flex-1 flex flex-col items-center justify-start p-6 overflow-y-auto">
        <div className="text-center space-y-4 max-w-sm w-full mt-8">
          <LulouFlowerIcon className="w-10 h-10 text-primary mx-auto opacity-60" />
          {profiles?.emptyReason === "distance" ? (
            <>
              <h2 className="font-serif text-xl font-bold" data-testid="text-intent-no-profiles-distance">
                {t("intent_distance_empty_title")}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("intent_distance_empty_desc").replace(
                  "{distance}",
                  formatDistance(profiles.radiusMiles ?? 0, units),
                )}
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t("intent_distance_empty_prompt")}
              </p>
              <button
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
                onClick={() => navigate("/profile?focus=distance")}
                data-testid="button-expand-intent-distance"
              >
                {t("expand_distance_btn")}
              </button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">{t("no_profiles_yet")}</p>
              <button
                className="px-4 py-2 rounded-md bg-primary/10 text-primary text-sm font-medium"
                onClick={() => refetchProfiles()}
                data-testid="button-refresh-intent-empty"
              >
                {t("retry_btn")}
              </button>
            </>
          )}

          {/* Developer-only empty-state diagnostics; normal users see the
              polished empty state above without internal filtering details. */}
          {import.meta.env.DEV && showWheelEmpty && (
            <div className="mt-4 text-left">
              <button
                className="text-xs text-muted-foreground underline underline-offset-2"
                onClick={() => setWheelDiagExpanded(v => !v)}
              >
                {wheelDiagLoading ? "Loading debug info…" : wheelDiagExpanded ? "Hide debug info ▲" : "Show debug info ▼"}
              </button>

              {wheelDiagExpanded && !wheelDiagLoading && (
                <div className="mt-2 rounded-md border border-border bg-muted/40 p-3">
                  {wheelDiag ? (
                    <>
                      {/* Summary row */}
                      <div className="flex flex-wrap gap-2 mb-3 text-xs">
                        {([
                          ["Total in DB", wheelDiag.filterCounts?.totalInDb],
                          ["Compat", wheelDiag.filterCounts?.afterGenderPref],
                          ["After age", wheelDiag.filterCounts?.afterAge],
                          ["After wheel-acted", wheelDiag.filterCounts?.afterWheelActed],
                          ["After likers", wheelDiag.filterCounts?.afterInboundLiker],
                          ["Final", wheelDiag.filterCounts?.finalCount],
                        ] as [string, number | undefined][]).map(([label, val]) => (
                          <span key={label} className="px-2 py-0.5 rounded bg-muted border border-border font-mono">
                            {label}: <span className={val === 0 ? "text-red-400" : "text-green-400"}>{val ?? "?"}</span>
                          </span>
                        ))}
                      </div>

                      {/* User context */}
                      <div className="text-xs text-muted-foreground mb-2 font-mono space-y-0.5">
                        <div>gender: <span className="text-foreground">{wheelDiag.normGender || "(unset)"}</span>  →  targetGenders: <span className="text-foreground">{JSON.stringify(wheelDiag.targetGenders)}</span></div>
                        <div>pref: <span className="text-foreground">{wheelDiag.normPreference || "(unset)"}</span>  →  prefsIncludingMe: <span className="text-foreground">{JSON.stringify(wheelDiag.prefsIncludingMyGender)}</span></div>
                        <div>coords: <span className={wheelDiag.hasCoords ? "text-green-400" : "text-red-400"}>{String(wheelDiag.hasCoords)}</span>  radius: <span className="text-foreground">{wheelDiag.locationRadius}mi</span>  ageRange: <span className="text-foreground">{wheelDiag.ageRange}</span></div>
                        <div>discoverOnlySaved: <span className={wheelDiag.discoverOnlySaved > 0 ? "text-green-400" : "text-foreground"}>{wheelDiag.discoverOnlySaved}</span>  wheelActed: <span className="text-foreground">{wheelDiag.wheelActedCount}</span>  inboundLikers: <span className="text-foreground">{wheelDiag.inboundLikerCount}</span></div>
                      </div>

                      {/* Exclusions list */}
                      {(wheelDiag.exclusions ?? []).length > 0 && (
                        <pre
                          ref={wheelDiagRef}
                          className="text-xs font-mono text-muted-foreground bg-background rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all"
                          style={{ fontSize: "10px" }}
                        >
                          {(wheelDiag.exclusions as any[]).map((e: any) =>
                            `${e.candidateIdPrefix} ${e.candidateName}: ${e.excludedReason}`
                          ).join("\n")}
                        </pre>
                      )}
                      {(wheelDiag.exclusions ?? []).length === 0 && (
                        <p className="text-xs text-green-400 font-mono">No exclusions — filter chain produced 0 candidates from {wheelDiag.filterCounts?.totalInDb ?? "?"} total profiles</p>
                      )}

                      {/* Copy button */}
                      {diagText && (
                        <button
                          className="mt-2 w-full px-3 py-1.5 rounded bg-muted border border-border text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            try {
                              navigator.clipboard.writeText(diagText);
                            } catch {
                              /* clipboard not available — user can select-all manually */
                            }
                          }}
                        >
                          Copy wheel debug info
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-red-400 font-mono">Debug query failed — check Railway logs for [WHEEL_DEBUG] error</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const dailyLikes = spinStatus?.dailyLikes ?? 0;
  const consecutiveDays = spinStatus?.consecutiveDays ?? 0;
  const streakComplete = spinStatus?.streakComplete ?? false;

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      style={{ background: "linear-gradient(180deg, #292022 0%, #171416 52%, #110f11 100%)" }}
      data-testid="intent-page"
    >

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
          0%, 100% { box-shadow: 0 16px 34px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,239,242,0.42), 0 0 0 5px rgba(212,92,116,0.16); }
          50%       { box-shadow: 0 18px 38px rgba(0,0,0,0.44), 0 0 0 1px rgba(255,247,249,0.58), 0 0 0 7px rgba(212,92,116,0.24), 0 0 28px rgba(212,92,116,0.20); }
        }
        @keyframes spinRoomIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes spinRoomOut {
          from { opacity: 1; transform: scale(1); }
          to   { opacity: 0; transform: scale(0.975); }
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
        @keyframes srSubtitlePulse {
          0%, 100% { opacity: 0.40; }
          50%       { opacity: 0.80; }
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
        @keyframes spinRoomTensionDarken {
          from { opacity: 0; }
          to   { opacity: 0.16; }
        }
      `}</style>

      {/* ── Header ── */}
      <div
        className="px-6"
        style={{
          paddingTop: "calc(14px + env(safe-area-inset-top, 0px))",
          paddingBottom: "14px",
        }}
      >
        <div className="flex items-center justify-between gap-5">
          <div>
            <h1
              className="font-serif text-[26px] font-medium tracking-[-0.025em] leading-none"
              style={{ color: "rgba(255,248,244,0.96)" }}
              data-testid="text-intent-title"
            >
              {t("intention_wheel_title")}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleMute}
              data-testid="button-toggle-sound"
              title={muted ? t("enable_sound_title") : t("mute_sound_title")}
              style={{
                width: 28, height: 28, borderRadius: 14,
                border: "none",
                background: "transparent",
                color: "rgba(255,242,236,0.48)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", outline: "none", transition: "color 0.2s",
              }}
            >
              {muted ? <VolumeX style={{ width: 14, height: 14 }} /> : <Volume2 style={{ width: 14, height: 14 }} />}
            </button>
            <div data-testid="streak-indicator" style={{ minWidth: 58 }}>
              {streakComplete ? (
                <Badge
                  variant="secondary"
                  className="text-xs"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "rgba(255,239,233,0.58)",
                  }}
                  data-testid="badge-streak-complete"
                >
                  {t("spin_earned_label")}
                </Badge>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-right" style={{ color: "rgba(255,239,233,0.46)" }} data-testid="text-likes-today">
                    {dailyLikes}/{DAILY_LIKE_GOAL}
                  </span>
                  <div className="flex items-center justify-end gap-1">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => (
                    <div
                      key={i}
                      className="h-px w-3 rounded-full transition-colors"
                      style={{ background: i < consecutiveDays ? "rgba(224,154,151,0.56)" : "rgba(255,240,234,0.14)" }}
                      data-testid={`streak-dot-${i}`}
                    />
                  ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Wheel stage ── */}
      <div
        dir={isRTL ? "rtl" : "ltr"}
        className={`flex-1 min-h-0 w-full flex flex-col items-center overflow-hidden ${isCompact ? "justify-start pt-0.5 gap-1" : "justify-start pt-0.5 gap-1"} transition-all duration-700`}
        style={{
          background: isSpinning
            ? "linear-gradient(180deg, #241b1e 0%, #151214 100%)"
            : "linear-gradient(180deg, #302427 0%, #171416 100%)",
          justifyContent: isRestingComposition ? "center" : "flex-start",
          transition: "background 0.5s ease",
        }}
      >
        <div
          className="relative select-none touch-manipulation"
          style={{
            width: "100%",
            maxWidth: 390,
            height: wheelStageHeight,
            flexShrink: 0,
            borderRadius: 0,
            overflow: "hidden",
            background: "transparent",
            border: "none",
            boxShadow: "none",
            perspective: isSpinning ? "1000px" : "none",
            transition: dispersed ? "opacity 0.55s ease" : undefined,
            opacity: dispersed ? 0 : 1,
            pointerEvents: dispersed ? "none" : "auto",
          }}
          data-testid="intent-wheel"
        >
          {/* Old-wheel resting structure: one dominant centre portrait with one
               smaller real profile partially visible on each available side.
               The same mounted cards physically orbit when Spin begins. */}
          {!dispersed && (
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                transformStyle: isSpinning ? "preserve-3d" : "flat",
                transform: !isSpinning && !dispersed
                  ? "translateX(-50%) translateY(-50%)"
                  : `translateX(-50%) translateY(-50%) rotateY(${-angle}deg)`,
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
                const isResting = !isSpinning && !dispersed;
                // Resting order is centre, left, right. Further cards stay
                // mounted for the full wheel data flow but are hidden from
                // the prominent idle presentation.
                const restingDistance = getWheelRestingDistance(i);
                const restingSlot = i === 0 ? 0 : i % 2 === 1 ? -((i + 1) / 2) : i / 2;
                const restingScale = restingDistance === 0 ? 1 : restingDistance === 1 ? 0.75 : 0.60;
                const restingCardWidth = restingDistance === 1 ? restingSideWidth : itemWidth;
                const restingCardHeight = restingDistance === 1 ? restingSideHeight : itemHeight;
                const restingX = restingSlot === 0
                  ? 0
                  : restingSlot * (restingDistance === 1 ? restingSideOffset : restingOuterOffset);
                const restingTilt = 0;
                const restingZ = restingDistance === 0 ? 16 : restingDistance === 1 ? 4 : 0;
                // The resting composition exposes one real card on each side of
                // the dominant profile. Missing candidates simply do not render.
                const restingVisible = restingDistance <= 1;

                const disperseX = dispersed && !isSelected ? (Math.random() - 0.5) * 900 : 0;
                const disperseY = dispersed && !isSelected ? (Math.random() - 0.5) * 700 : 0;

                 const boxShadow = isResting
                   ? "0 24px 58px rgba(7,4,6,0.38)"
                  : isSelected && !dispersed
                   ? "0 22px 46px rgba(0,0,0,0.44), 0 2px 8px rgba(0,0,0,0.22), 0 0 0 1px rgba(86,39,53,0.48)"
                  : depthFactor > 0.75 && !dispersed
                  ? `0 ${Math.round(10 + glowAlpha * 8)}px ${Math.round(24 + glowAlpha * 10)}px rgba(0,0,0,0.34), 0 0 ${Math.round(glowAlpha * 18)}px rgba(188,78,96,${(glowAlpha * 0.18).toFixed(2)})`
                  : "0 12px 30px rgba(0,0,0,0.30)";

                return (
                  <div
                    key={profile.id}
                    style={{
                      width: isResting ? restingCardWidth : itemWidth,
                      height: isResting ? restingCardHeight : itemHeight,
                       borderRadius: 24, overflow: "hidden",
                      position: "absolute",
                      left: isResting && restingDistance === 1 ? (itemWidth - restingCardWidth) / 2 : 0,
                      top: isResting && restingDistance === 1 ? (itemHeight - restingCardHeight) / 2 : 0,
                       border: "none",
                       outline: "none",
                      transform: isResting
                        ? `translateX(${restingX}px) translateZ(${restingZ}px) rotate(${restingTilt}deg) scale(${restingDistance === 1 ? 1 : restingScale})`
                        : dispersed && !isSelected
                         ? `rotateY(${itemAngle}deg) translateZ(${carouselRadius}px) translate(${disperseX}px, ${disperseY}px) scale(0)`
                        : isSelected && !dispersed
                         ? `rotateY(${itemAngle}deg) translateZ(${carouselRadius}px) scale(${(cardScale * 1.10).toFixed(3)})`
                         : `rotateY(${itemAngle}deg) translateZ(${carouselRadius}px) scale(${cardScale})`,
                      opacity: isResting
                        ? (restingVisible ? 1 : 0)
                        : dispersed && !isSelected ? 0 : (0.16 + depthFactor * 0.84),
                      filter: isResting
                        ? (restingDistance === 0 ? undefined : "saturate(0.82) brightness(0.78)")
                        : !isSpinning && depthFactor < 0.92
                        ? `blur(${((1 - depthFactor) * 3.5).toFixed(1)}px)`
                        : undefined,
                      zIndex: isResting
                        ? (restingDistance === 0 ? 100 : restingDistance === 1 ? 80 : 60)
                        : Math.round(depthFactor * 100),
                      boxShadow,
                      pointerEvents: isResting && !restingVisible ? "none" : "auto",
                      animation: undefined,
                      transition: dispersed
                        ? "all 0.7s cubic-bezier(0.4, 0, 0.2, 1)"
                          : isResting ? "transform 0.46s cubic-bezier(0.22,1,0.36,1), opacity 0.35s ease, filter 0.35s ease, box-shadow 0.3s ease" : "box-shadow 0.3s ease",
                    }}
                    data-testid={`intent-profile-${i}`}
                  >
                    <div style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                        bottom: isResting && restingVisible && restingDistance === 0 ? 52 : 0,
                      overflow: "hidden",
                      background: "rgba(255,244,239,0.06)",
                    }}>
                      <ProfilePhoto userId={profile.userId} className="w-full h-full pointer-events-none" />
                    </div>
                    <div style={{
                        position: "absolute", inset: 0, borderRadius: 24,
                      background: isResting && restingVisible
                        ? "linear-gradient(180deg, transparent 62%, rgba(10,7,9,0.04) 75%, rgba(10,7,9,0.18) 100%)"
                        : "linear-gradient(175deg, rgba(8,3,12,0) 56%, rgba(8,3,12,0.06) 76%, rgba(8,3,12,0.30) 100%)",
                      pointerEvents: "none",
                    }} />
                    {isResting && restingVisible && restingDistance === 0 && (
                      <div style={{
                        position: "absolute", left: 0, right: 0, bottom: 0,
                        height: 52,
                        minHeight: 0,
                        boxSizing: "border-box",
                        padding: "6px 12px 7px",
                        display: "flex", flexDirection: "column", justifyContent: "center",
                        background: "linear-gradient(135deg, rgba(45,32,36,0.98), rgba(28,23,25,0.98))",
                        borderTop: "none",
                        color: "#fff", pointerEvents: "none",
                      }}>
                        <p style={{
                          margin: 0, fontFamily: "'Playfair Display', Georgia, serif",
                           fontSize: 17, lineHeight: 1.05, fontWeight: 500,
                          letterSpacing: "-0.02em",
                        }}>
                          {profile.firstName}
                          {profile.age ? <span style={{ fontFamily: "inherit", fontWeight: 400 }}>, {profile.age}</span> : null}
                        </p>
                        {profile.location ? (
                          <p style={{
                             margin: "2px 0 0", display: "flex", alignItems: "center", gap: 4,
                            fontSize: 9.5, lineHeight: 1.1, color: "rgba(255,255,255,0.72)",
                          }}>
                            <MapPin style={{ width: 11, height: 11 }} />
                            {profile.location}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Name + age caption — only shown during active spin / dispersal ── */}
          {selectedIndex !== null && items[selectedIndex] && isSpinning && !dispersed && (
            <div
              style={{
                position: "absolute",
                top: `calc(50% + ${Math.round(itemHeight * 1.10 / 2 + 10)}px)`,
                left: 0, right: 0,
                textAlign: "center",
                pointerEvents: "none",
                zIndex: 210,
                padding: "0 32px",
              }}
            >
              <p style={{
                color: "#fff",
                fontSize: isCompact ? 13 : 15,
                fontWeight: 700,
                letterSpacing: "0.015em",
                textShadow: "0 1px 14px rgba(0,0,0,0.85), 0 2px 28px rgba(0,0,0,0.65)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                animation: "profileNameAppear 0.4s 0.25s ease both",
                lineHeight: 1.3,
                margin: 0,
              }}>
                {items[selectedIndex].firstName}
                {items[selectedIndex].age
                  ? <span style={{ fontWeight: 400, opacity: 0.70 }}>, {items[selectedIndex].age}</span>
                  : null}
              </p>
            </div>
          )}

        </div>

        {/* Explicit spacing keeps the preview close to the carousel and gives
            each control tier its own readable interval. */}
        <div
          style={{
            width: "100%",
            flex: isRestingComposition ? "0 0 auto" : 1,
            minHeight: isRestingComposition ? undefined : 0,
            paddingTop: 12,
            paddingBottom: 18,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
          }}
        >
          {/* ── Candidates preview strip ── */}
          {/* Always shown (regardless of canSpin) so users can see who is on the
              wheel and feel engaged even while waiting for their next free spin. */}
          {!isSpinning && !dispersed && !showPurchase && !showProfile && (
            <CandidatesPreview items={items} onTap={setPreviewProfile} />
          )}

          {/* ── Spin button & streak ── */}
          {!dispersed && !showPurchase && (
            <div
              className="flex flex-col items-center px-6 w-full max-w-xs mx-auto"
              style={{ paddingBottom: 0, marginTop: 24 }}
            >
            {canSpin ? (
              <button
                onClick={spinWheel}
                disabled={isSpinning || isPreparingSpin || items.length === 0}
                style={{
                  width: 72, height: 72, borderRadius: "50%",
                  border: "1px solid rgba(255,231,223,0.28)",
                  background: isSpinning || isPreparingSpin
                    ? "linear-gradient(145deg, #8d515b, #623440)"
                    : "radial-gradient(circle at 36% 28%, #c6777f 0%, #a15360 38%, #773846 100%)",
                  boxShadow: isSpinning || isPreparingSpin
                    ? "0 8px 22px rgba(18,8,13,0.24), inset 0 1px 0 rgba(255,255,255,0.10)"
                    : "0 12px 28px rgba(54,20,29,0.42), inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -10px 22px rgba(52,19,29,0.16)",
                  color: "#fff", cursor: isSpinning || isPreparingSpin ? "default" : "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                  animation: "none",
                  transition: "background 0.3s ease, transform 0.12s ease, box-shadow 0.12s ease",
                  outline: "none", WebkitTapHighlightColor: "transparent", flexShrink: 0,
                }}
                onMouseEnter={e => { if (!isSpinning && !isPreparingSpin) (e.currentTarget as HTMLElement).style.transform = "translateY(-1px) scale(1.025)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(1px) scale(0.965)"; }}
                onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-1px) scale(1.025)"; }}
                data-testid="button-spin"
              >
                <RotateCw style={{ width: 20, height: 20, opacity: 0.90, animation: isSpinning ? "spinBtn 0.7s linear infinite" : "none" }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.94 }}>
                  {isSpinning ? "…" : t("spin_label")}
                </span>
              </button>
            ) : (
              <button
                onClick={() => setShowPurchase(true)}
                aria-label={t("spin_label")}
                style={{
                  width: 72, height: 72, borderRadius: "50%",
                  border: "1px solid rgba(255,231,223,0.22)",
                  background: "radial-gradient(circle at 36% 28%, #a9636d 0%, #824552 42%, #60303b 100%)",
                  color: "rgba(255,244,240,0.90)", cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                  boxShadow: "0 10px 24px rgba(31,12,19,0.34), inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -9px 20px rgba(38,13,21,0.18)",
                  transition: "transform 0.12s ease, box-shadow 0.12s ease",
                  outline: "none", WebkitTapHighlightColor: "transparent", flexShrink: 0,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-1px) scale(1.025)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(1px) scale(0.965)"; }}
                onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "translateY(-1px) scale(1.025)"; }}
                data-testid="button-spin-locked"
              >
                <RotateCw style={{ width: 20, height: 20, opacity: 0.82 }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>
                  {t("spin_label")}
                </span>
              </button>
            )}

            {/* Purchased Sparks remaining badge */}
            {(spinStatus?.purchasedSpins ?? 0) > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 5,
                  background: "rgba(255,226,217,0.08)",
                  border: "1px solid rgba(255,226,217,0.16)",
                borderRadius: 20, padding: "5px 12px",
                marginTop: 14,
              }}>
                <span style={{ fontSize: 12, color: "rgba(212,92,116,0.95)", fontWeight: 700 }}>
                  {spinStatus!.purchasedSpins} Halo{spinStatus!.purchasedSpins === 1 ? "" : "s"} remaining
                </span>
              </div>
            )}

            {/* CTA hint below the locked button */}
            {!canSpin && (
              <p style={{
                fontSize: 11, textAlign: "center",
                color: "rgba(255,255,255,0.48)",
                lineHeight: 1.4, margin: "14px 0 0",
              }}>
                {streakComplete
                  ? t("spin_earned_label")
                  : t("buy_spins_or_earn_free")}
              </p>
            )}

            {!streakComplete && (
              <div className="w-full" style={{ marginTop: 14 }}>
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: STREAK_GOAL }).map((_, i) => {
                    const isCurrentDay = i === consecutiveDays;
                    const isDone = i < consecutiveDays;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                        <div className="w-full h-px rounded-full overflow-hidden" style={{ background: "rgba(255,240,234,0.16)" }}>
                          {isDone ? <div className="w-full h-full rounded-full" style={{ background: "rgba(224,154,151,0.76)" }} /> :
                           isCurrentDay ? <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(dailyLikes / DAILY_LIKE_GOAL, 1) * 100}%`, background: "rgba(224,154,151,0.62)" }} /> : null}
                        </div>
                        <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.48)" }}>
                          {isDone ? "✓" : isCurrentDay ? `${dailyLikes}/${DAILY_LIKE_GOAL}` : `${t("day_label")} ${i + 1}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-center" style={{ color: "rgba(255,255,255,0.48)", margin: "10px 0 0" }}>
                  {t("like_daily_earn_spin_desc").replace("{n}", String(DAILY_LIKE_GOAL)).replace("{days}", String(STREAK_GOAL))}
                </p>
              </div>
            )}
            </div>
          )}
        </div>

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
                  Get Halos
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
                  {renderText(selectedProfile.signals[0])}
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
            <div data-testid="img-intent-detail-photo" className="relative w-full aspect-[3/4] max-h-[54vh] overflow-hidden">
              <ProfilePhoto userId={selectedProfile.userId} className="w-full h-full" />
              {profilePhotos[0] && (
                <button
                  type="button"
                  aria-label={heartedPhotos.has(profilePhotos[0]) ? "Remove photo heart" : "Heart this photo"}
                  data-testid="button-detail-photo-heart-0"
                  disabled={togglePhotoHeart.isPending}
                  onClick={() => togglePhotoHeart.mutate({ photoUrl: profilePhotos[0], liked: !heartedPhotos.has(profilePhotos[0]) })}
                  className="absolute top-3 right-3 grid h-10 w-10 place-items-center rounded-full border border-white/25 bg-black/35 backdrop-blur disabled:opacity-50"
                >
                  <Heart className="h-5 w-5" fill={heartedPhotos.has(profilePhotos[0]) ? "#d45c74" : "none"} color={heartedPhotos.has(profilePhotos[0]) ? "#d45c74" : "white"} />
                </button>
              )}
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
                    {selectedProfile.signals.map((signal, i) => {
                      const key = (signal !== null && typeof signal === "object" && "key" in signal) ? String((signal as Record<string,unknown>).key) : String(i);
                      return <Badge key={key} variant="outline" data-testid={`badge-detail-signal-${i}`}>{renderText(signal)}</Badge>;
                    })}
                  </div>
                </div>
              )}

              {selectedProfile.greenFlags && selectedProfile.greenFlags.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_green_flags")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfile.greenFlags.map((flag, i) => {
                      const key = (flag !== null && typeof flag === "object" && "key" in flag) ? String((flag as Record<string,unknown>).key) : String(i);
                      return <Badge key={key} variant="outline" data-testid={`badge-detail-flag-${i}`}>{renderText(flag)}</Badge>;
                    })}
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
                    {selectedProfile.conversationStarters.map((starter, i) => {
                      const key = (starter !== null && typeof starter === "object" && "key" in starter) ? String((starter as Record<string,unknown>).key) : String(i);
                      return (
                        <div key={key} className="rounded-md p-3 text-sm bg-muted/50" data-testid={`text-detail-starter-${i}`}>
                          <p className="italic">"{renderText(starter)}"</p>
                          {language === "English" && <button type="button" onClick={() => { const prompt = renderText(starter); setReplyTarget(prompt); setReplyDraft(promptReplyData?.replies.find(reply => reply.promptText === prompt)?.replyText ?? ""); setReplySavedFor(null); }} className="mt-2 text-xs font-semibold text-primary">{t("reply_label")}</button>}
                        </div>
                      );
                    })}
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
                    {selectedProfile.questions.map((question, i) => {
                      const key = (question !== null && typeof question === "object" && "key" in question) ? String((question as Record<string,unknown>).key) : String(i);
                      return (
                        <div key={key} className="rounded-md p-3 text-sm border" data-testid={`text-detail-question-${i}`}>
                          <p>{renderText(question)}</p>
                          {language === "English" && <button type="button" onClick={() => { const prompt = renderText(question); setReplyTarget(prompt); setReplyDraft(promptReplyData?.replies.find(reply => reply.promptText === prompt)?.replyText ?? ""); setReplySavedFor(null); }} className="mt-2 text-xs font-semibold text-primary">{t("reply_label")}</button>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {language === "English" && replyTarget && (
                <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3 space-y-2" data-testid="intent-contextual-reply">
                  <p className="text-xs text-muted-foreground">{t("reply_to_prompt_label").replace("{prompt}", replyTarget)}</p>
                  <textarea value={replyDraft} onChange={e => setReplyDraft(e.target.value)} maxLength={500} placeholder={t("reply_placeholder")} className="min-h-20 w-full resize-none rounded-xl border bg-background p-3 text-sm outline-none focus:border-primary" />
                  <button type="button" disabled={!replyDraft.trim() || savePromptReply.isPending} onClick={() => savePromptReply.mutate({ promptText: replyTarget, replyText: replyDraft })} className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                    {replySavedFor === replyTarget ? t("reply_saved_label") : t("reply_save_label")}
                  </button>
                  <p className="text-[11px] text-muted-foreground">{t("reply_saved_hint")}</p>
                </div>
              )}

              {profilePhotos.length > 1 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("section_photos")}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {profilePhotos.slice(1).map((photo, i) => (
                      <div key={photo} className="relative">
                        <img src={photo} alt={`${selectedProfile.firstName} photo ${i + 2}`} className="w-full aspect-square object-cover rounded-md" data-testid={`img-detail-photo-${i + 1}`} />
                        <button type="button" aria-label={heartedPhotos.has(photo) ? "Remove photo heart" : "Heart this photo"} onClick={() => togglePhotoHeart.mutate({ photoUrl: photo, liked: !heartedPhotos.has(photo) })} className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/40">
                          <Heart className="h-4 w-4" fill={heartedPhotos.has(photo) ? "#d45c74" : "none"} color={heartedPhotos.has(photo) ? "#d45c74" : "white"} />
                        </button>
                      </div>
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
                    order: 2,
                    background: "hsl(var(--muted)/0.5)",
                    borderColor: "hsl(var(--border))",
                  }}
                  onClick={closeProfile}
                  data-testid="button-intent-skip"
                  aria-label={t("skip_label")}
                >
                  <Moon className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-semibold tracking-[0.12em] uppercase">CLOSE</span>
                </button>

                {/* Save For Later button */}
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 rounded-2xl border transition-all active:scale-95 disabled:opacity-50"
                  style={{
                    order: 1,
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

                {/* Send Halo button */}
                <button
                  className="flex-[2] flex flex-col items-center gap-1.5 py-3 rounded-2xl transition-all active:scale-95 disabled:opacity-60"
                  style={{
                    order: 3,
                    background: "linear-gradient(135deg, #d45c74 0%, #9d3550 100%)",
                    boxShadow: "0 4px 20px rgba(188,78,96,0.45), 0 2px 8px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.15)",
                  }}
                  onClick={handleSendHalo}
                  disabled={sendSpark.isPending || haloSent || haloSendInFlightRef.current}
                  data-testid="button-intent-send-halo"
                  aria-label="Send Halo"
                >
                  {sendSpark.isPending
                    ? <Loader2 className="w-5 h-5 text-white animate-spin" />
                    : <Heart className="w-5 h-5 text-white" />
                  }
                  <span className="text-xs text-white font-semibold tracking-[0.12em] uppercase">
                    {haloSent ? "Halo Sent" : sendSpark.isPending ? "Sending…" : "Send Halo"}
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
            background: "linear-gradient(160deg, #262022 0%, #1c1719 58%, #110f11 100%)",
            overflow: "hidden",
            animation: isHaloDismissing
              ? "spinRoomOut 0.26s cubic-bezier(0.4,0,0.2,1) forwards"
              : "spinRoomIn 0.28s ease forwards",
          }}
          data-testid="spin-room-overlay"
        >
          {/* The exact destination rectangle exists and is measurable while the
              original winner grows. It contains no image until handoff succeeds. */}
          <div
            ref={heroTargetMeasureRef}
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }}
          />
          {/* ── CAROUSEL STAGE — Cover Flow horizontal carousel ── */}
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center",
            // Carousel fades to 0 at 'reveal'/'buttons' — by then the result overlay's
            // ProfilePhoto (same image, same position) is the visible hero.
            // During 'growing' the orbit card IS the hero; carousel must stay opaque.
            opacity: heroHandoffComplete && (spinRoomPhase === 'reveal' || spinRoomPhase === 'buttons') ? 0 : 1,
            transition: "opacity 1.4s cubic-bezier(0.4,0,0.2,1)",
            pointerEvents: (spinRoomPhase === 'growing' || spinRoomPhase === 'reveal' || spinRoomPhase === 'buttons') ? "none" : "auto",
          }}>
            {/* Build and winner diagnostics remain available in the console and
                telemetry. This compact on-screen marker is development-only. */}
            {import.meta.env.DEV && (
              <div style={{
                position: "absolute",
                top: "max(env(safe-area-inset-top, 0px), 6px)",
                right: 6, zIndex: 9999,
                padding: "3px 6px",
                background: "rgba(0,0,0,0.72)",
                fontFamily: "monospace", fontSize: 8, color: "rgba(212,92,116,0.85)",
                lineHeight: 1.5, borderRadius: 3,
                pointerEvents: "none", userSelect: "none",
              }}>
                <div>WHEEL · {__COMMIT_HASH__}</div>
                <div>phase: {spinRoomPhase}</div>
                <div>winner: {pendingWinnerRef.current?.profile?.userId?.slice(-6) ?? '—'}</div>
                <div>selected: {selectedProfile?.userId?.slice(-6) ?? '—'}</div>
              </div>
            )}

            {/* The tension veil darkens the complete room after the wheel has
                stopped, while the locked winner and status copy remain above it. */}
            {(spinRoomPhase === 'pullforward' || spinRoomPhase === 'momentum' || spinRoomPhase === 'growing') && (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute", inset: 0, zIndex: 1,
                  background: "#000",
                  pointerEvents: "none",
                  animation: "spinRoomTensionDarken 3.2s ease forwards",
                }}
              />
            )}

            {/* Deep ambient radial glow behind carousel */}
            <div style={{
              position: "absolute", top: "48%", left: "50%",
              transform: "translate(-50%,-50%)",
              width: 430, height: 320, borderRadius: "50%",
              background: "rgba(255,226,217,0.035)",
              pointerEvents: "none",
              opacity: 1,
              transition: "opacity 1.2s ease",
            }} />

            {/* Header — "TONIGHT'S CONNECTION" */}
            <div style={{
              position: "relative", zIndex: 2, textAlign: "center",
              paddingTop: "max(env(safe-area-inset-top,0px), 28px)",
              paddingBottom: 6, paddingLeft: 56, paddingRight: 56, width: "100%",
            }}>
              <p style={{
                fontFamily: "'Playfair Display', Georgia, serif",
                fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em",
                color: "rgba(255,244,239,0.88)",
                marginBottom: 8,
              }}>
                {t("spin_room_title")}
              </p>
              <p style={{
                fontSize: 11, color: "rgba(255,239,232,0.42)",
                margin: 0,
                opacity: spinRoomPhase === 'accelerate' ? 1 : 0,
                transition: "opacity 0.7s ease",
              }}>
                {t("spin_room_subtitle")}
              </p>
            </div>

            {/* ── 3-card carousel area ── */}
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              position: "relative", zIndex: 2, width: "100%",
            }}>
              {/* ── 5-card orbital stage — cards rotate on a flat ellipse ── */}
              {/* All 5 divs stay mounted for the entire spin.  Their transform,       */}
              {/* opacity and zIndex are owned EXCLUSIVELY by the orbit RAF            */}
              {/* (direct el.style mutations).  Those properties are NOT in the JSX    */}
              {/* style object — React must never overwrite the RAF's values.           */}
              {/* No CSS perspective: cards face the viewer straight-on at all times.  */}
              <div style={{
                position: "relative", width: "100%", height: ORBIT_STAGE_HEIGHT, flexShrink: 0,
              }}>
              {/* Restrained tonal stage; the RAF still owns its measured ref. */}
                <div ref={orbitGlowRef} style={{
                  position: "absolute", top: "50%", left: "50%",
                  width: 240, height: 240, borderRadius: "50%",
                  transform: "translate(-50%,-50%)",
                  pointerEvents: "none", zIndex: 0,
                  opacity: 0.16,
                  background: "radial-gradient(circle, rgba(183,105,116,0.18), rgba(82,43,52,0.04) 58%, transparent 74%)",
                }} />

                {/* 5 orbit cards — positions driven entirely by the orbit RAF.        */}
                {/* DO NOT add transform/opacity/filter/zIndex to the style prop here  */}
                {/* — React would overwrite the RAF's mutations on every re-render.     */}
                {Array.from({ length: ORBIT_N }, (_, i) => (
                  <div
                    key={i}
                    ref={el => {
                      orbitCardRefs.current[i] = el;
                      // Keep viewport geometry entirely outside React's style diff.
                      // This runs on mount/new-spin while the normal orbit owns the
                      // card, but deliberately leaves the locked winner untouched.
                      if (el && !winnerHeroDomOwnedRef.current) {
                        el.style.position = 'absolute';
                        el.style.left = '50%';
                        el.style.top = '50%';
                        el.style.width = `${ORBIT_CARD_WIDTH}px`;
                        el.style.height = `${ORBIT_CARD_HEIGHT}px`;
                        el.style.borderRadius = '28px';
                        el.style.visibility = 'visible';
                      }
                    }}
                    style={{
                      overflow: "hidden",
                      willChange: "transform, opacity",
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                      transformStyle: "preserve-3d",
                      boxShadow: "0 18px 42px rgba(16,8,12,0.34)",
                    }}
                  >
                    {orbitPhotoUrls[i] ? (
                      <img
                        src={orbitPhotoUrls[i]!}
                        alt=""
                        draggable={false}
                        decoding="sync"
                        className="w-full h-full object-cover pointer-events-none"
                        style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
                      />
                    ) : (
                      <ProfileAvatarFallback className="w-full h-full pointer-events-none" />
                    )}
                    {/* Bottom readability gradient */}
                    <div style={{
                      position: "absolute", inset: 0,
                      background: "linear-gradient(to bottom, transparent 62%, rgba(0,0,0,0.34) 100%)",
                      pointerEvents: "none",
                    }} />
                  </div>
                ))}

              </div>

              {/* Phase status text */}
              <div style={{ position: "relative", zIndex: 220, marginTop: 18, textAlign: "center", minHeight: 48, pointerEvents: "none" }}>
                {spinRoomPhase === 'accelerate' && (
                  <p key="acc" style={{ fontSize: 12, color: "rgba(255,240,234,0.58)", letterSpacing: "0.02em", animation: "srTextIn 0.5s ease forwards" }}>
                    Taking a closer look…
                  </p>
                )}
                {spinRoomPhase === 'fast' && (
                  <p key="fast" style={{ fontSize: 12, color: "rgba(255,240,234,0.42)", letterSpacing: "0.08em", animation: "srTextIn 0.4s ease forwards" }}>A considered introduction</p>
                )}
                {spinRoomPhase === 'slow' && (
                  <p key="slow" style={{ fontSize: 12, fontStyle: "italic", color: "rgba(255,240,234,0.48)", animation: "srTextIn 0.5s ease forwards" }}>Nearly there</p>
                )}
                {spinRoomPhase === 'approach' && (
                  <p key="approach" style={{ fontSize: 12, fontStyle: "italic", color: "rgba(255,240,234,0.54)", animation: "srTextIn 0.5s ease forwards" }}>A moment for someone new</p>
                )}
                {(spinRoomPhase === 'pullforward' || spinRoomPhase === 'arrive' || spinRoomPhase === 'momentum' || spinRoomPhase === 'growing') && momentumLabel && (
                  <p
                    key={momentumLabel}
                    ref={momentumTextRef}
                    style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: 15, fontStyle: "italic",
                      color: "rgba(255,255,255,0.75)",
                      letterSpacing: "0.03em",
                      animation: "srTextIn 0.6s ease both",
                      textAlign: "center",
                    }}
                  >{momentumLabel}</p>
                )}
                <div style={{
                  width: 72, height: 1, margin: "14px auto 0",
                  background: "rgba(255,244,239,0.12)", overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    width: spinRoomPhase === 'accelerate' ? "18%"
                      : spinRoomPhase === 'fast' ? "42%"
                      : spinRoomPhase === 'slow' ? "66%"
                      : spinRoomPhase === 'approach' ? "84%"
                      : "100%",
                    background: "rgba(224,154,151,0.64)",
                    transition: "width 1.2s cubic-bezier(0.4,0,0.2,1)",
                  }} />
                </div>
              </div>
            </div>

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
            ><X style={{ width: 17, height: 17, color: "rgba(255,245,240,0.76)" }} /></button>
          </div>

          {/* ── REVEAL STAGE — orbit card fills screen, then result overlay mounts ── */}
          {/* 'growing': orbit card is FLIP-animating (no overlay yet)               */}
          {/* 'reveal' : result overlay mounts; ProfilePhoto covers orbit card        */}
          {/* 'buttons': profile text + CTAs fade in (1.5 s after reveal)            */}
          {(spinRoomPhase === 'reveal' || spinRoomPhase === 'buttons') && selectedProfile && (
          <IntentResultBoundary
            key={boundaryKey}
            recovering={boundaryRecovering}
            onBackToWheel={() => {
              // This is a real result dismissal, even when the result boundary
              // failed. Reuse the persistence-aware close path so the candidate
              // lock cannot be orphaned and updates cannot revive the result.
              logWheelState({ event: 'back_to_wheel_pressed' });
              closeProfile();
              setBoundaryKey(k => k + 1);
            }}
            onReset={() => {
            logWheelState({
              event: 'retry_result_pressed',
              selectedProfileUserId: selectedProfile?.userId ?? null,
              pendingWinnerUserId: pendingWinnerRef.current?.profile?.userId ?? null,
            });
            setSparkSent(false);
            setBoundaryRecovering(true);
            // ALWAYS fetch fresh from server — never re-use the profile that caused
            // the boundary (it may still have bad data and would throw again on render,
            // causing the stuck-Continue loop).
            // Use apiRequest (not bare fetch) so the Authorization header and
            // X-Session-Id header are included — bare fetch omits them and returns 401.
            // apiRequest prepends API_BASE internally, so pass a plain path.
            const timer = setTimeout(() => {
              setBoundaryRecovering(false);
              logWheelState({ event: 'retry_result_fetch_failed', reason: 'timeout' });
              postWheelDiag('state', { event: 'retry_failed', reason: 'timeout' });
            }, 8000);
            apiRequest('GET', '/api/spin/result')
              .then(r => r.json())
              .then((data: { profile: Profile | null }) => {
                clearTimeout(timer);
                logWheelState({ event: 'retry_result_response', hasProfile: !!data?.profile?.userId });
                postWheelDiag('state', { event: 'retry_response', hasProfile: !!data?.profile?.userId });
                setBoundaryRecovering(false);
                const p = data?.profile;
                if (p?.userId) {
                  // Normalise ALL renderable fields, then bump key to remount the
                  // boundary fresh (hasError=false) with the clean profile data.
                  setSelectedProfile(normaliseProfileForRender(p));
                  setSpinRoomPhase('buttons');
                  setBoundaryKey(k => k + 1);
                  postWheelDiag('state', { event: 'retry_boundary_remount' });
                } else {
                  // No persisted result — close SpinRoom, return to Intent wheel
                  setSelectedProfile(null);
                  setSpinRoomPhase('idle');
                  setShowSpinRoom(false);
                  setBoundaryKey(k => k + 1);
                }
              })
              .catch((err: unknown) => {
                clearTimeout(timer);
                setBoundaryRecovering(false);
                // Network error or auth error — re-enable button so user can retry.
                // Do not close SpinRoom; never trap the user on a blank page.
                const msg = err instanceof Error ? err.message : String(err);
                logWheelState({ event: 'retry_result_fetch_failed', error: msg });
                postWheelDiag('state', { event: 'retry_failed', error: msg });
              });
          }}>
            {/* zIndex:110 puts the overlay above the orbit winner card (zIndex:90 at
                growing phase) so the ProfilePhoto here creates an imperceptible
                handoff: same image, same screen position, carousel parent then fades. */}
            <div style={{
              position: "absolute", inset: 0, zIndex: 300,
              visibility: heroHandoffComplete ? "visible" : "hidden",
            }}>

              {/* ── Photo — appears at reveal; imperceptible handoff from orbit card ── */}
              {/* The orbit card FLIP-grew to full-screen (growing phase, ~2800 ms CSS  */}
              {/* transition).  At 'reveal' we mount this ProfilePhoto at full size here  */}
              {/* so the carousel parent (containing the orbit card) can safely fade to  */}
              {/* opacity:0 without the hero photo disappearing.  Because both images     */}
              {/* show the same userId and are pixel-aligned, the swap is invisible.      */}
              {selectedProfile && (
                <div ref={resultPhotoWrapperRef} style={{ position: "absolute", inset: 0 }}>
                  <ProfilePhoto userId={selectedProfile.userId} className="w-full h-full" />
                </div>
              )}

              {/* ── Top vignette — safe area + close button backdrop ── */}
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0, height: 130,
                  background: "linear-gradient(#171116 0%, rgba(23,17,22,0.42) 52%, transparent 100%)",
                pointerEvents: "none", zIndex: 4,
              }} />

              {/* ── Bottom gradient — protects the lower 42% where all text lives ── */}
              {(spinRoomPhase === 'reveal' || spinRoomPhase === 'buttons') && selectedProfile && (
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0, height: "44%",
                  background: "linear-gradient(transparent 0%, rgba(23,17,22,0.78) 32%, rgba(23,17,22,0.97) 65%, #171116 100%)",
                  pointerEvents: "none", zIndex: 4,
                }} />
              )}

              {/* ── PROFILE TEXT + CTA — bottom 33%, appears at buttons phase ── */}
              {/* Mounts fresh at buttons phase so all animation-delays start from zero */}
              {spinRoomPhase === 'buttons' && selectedProfile && (
                <div style={{
                  position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 6,
                  display: "flex", flexDirection: "column", alignItems: "center",
                  padding: "0 22px",
                  paddingBottom: "max(env(safe-area-inset-bottom,0px), 32px)",
                  textAlign: "center",
                }}>
                  {/* Eyebrow — 0.12 s */}
                  <p style={{
                    fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
                    color: "rgba(255,224,213,0.72)",
                    margin: "0 0 10px",
                    animation: "srTextIn 0.50s 0.12s ease both",
                  }}>
                    {t("spin_room_title")}
                  </p>

                  {/* Name — 0.30 s */}
                  <h2 style={{
                    fontFamily: "'Playfair Display', Georgia, serif",
                    fontSize: "clamp(32px,8vw,44px)", fontWeight: 600,
                    color: "#fff8f4", margin: "0 0 4px", lineHeight: 1.05,
                    textShadow: "0 2px 18px rgba(0,0,0,0.55)",
                    animation: "srTextIn 0.75s 0.30s ease both",
                  }}>
                    {selectedProfile.firstName}
                    {selectedProfile.photoVerified && (
                      <BadgeCheck style={{
                        display: "inline", width: 18, height: 18,
                        color: "#d45c74", marginLeft: 6, verticalAlign: "middle",
                      }} />
                    )}
                  </h2>

                  {/* Age — 0.50 s */}
                  {selectedProfile.age && (
                    <p style={{
                      fontSize: 15, fontWeight: 300,
                      color: "rgba(255,240,233,0.62)", margin: "4px 0 0",
                      animation: "srTextIn 0.50s 0.50s ease both",
                    }}>
                      {selectedProfile.age}
                    </p>
                  )}

                  {/* Signal word — 0.72 s */}
                  {selectedProfile.signals && selectedProfile.signals.length > 0 && renderText(selectedProfile.signals[0]) && (
                    <p style={{
                      fontFamily: "'Playfair Display', Georgia, serif",
                      fontSize: 14, fontStyle: "italic",
                      color: "rgba(255,225,214,0.70)", margin: "7px 0 0",
                      animation: "srTextIn 0.55s 0.72s ease both",
                    }}>
                      "{renderText(selectedProfile.signals[0])}"
                    </p>
                  )}

                  {/* Location — 0.92 s */}
                  {selectedProfile.location && (
                    <p style={{
                      fontSize: 12, color: "rgba(255,235,226,0.54)", margin: "6px 0 0",
                      display: "flex", alignItems: "center",
                      justifyContent: "center", gap: 4,
                      animation: "srTextIn 0.45s 0.92s ease both",
                    }}>
                      <MapPin style={{ width: 11, height: 11 }} />
                      {selectedProfile.location}
                    </p>
                  )}

                  {/* DNA insight — 1.08 s */}
                  <p style={{
                    fontSize: 11, fontStyle: "italic",
                    color: "rgba(255,224,213,0.62)", margin: "10px 0 0",
                    animation: "srTextIn 0.50s 1.08s ease both",
                    lineHeight: 1.55, letterSpacing: "0.01em",
                    maxWidth: 280,
                  }}>
                    {spinRoomInsight}
                  </p>

                  {/* CTA — 1.20 s (or halo-sent state) */}
                  {haloSent ? (
                    <div style={{
                      marginTop: 22, width: "100%",
                      animation: "haloSentPulse 0.50s cubic-bezier(0.34,1.56,0.64,1) forwards",
                    }}>
                      <p style={{
                        fontSize: 19, fontWeight: 700,
                        color: "rgba(212,92,116,1.0)", letterSpacing: "0.08em",
                      }}>Halo sent</p>
                      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.38)", marginTop: 5 }}>
                        We'll let you know if they feel the same.
                      </p>
                    </div>
                  ) : (
                    <div style={{
                      display: "flex", gap: 12, marginTop: 20, width: "100%",
                      animation: "srTextIn 0.60s 1.20s ease both",
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
                        <span>Close</span>
                      </button>
                      <button
                        onClick={handleSendHalo}
                        disabled={sendSpark.isPending || haloSent || haloSendInFlightRef.current}
                        data-testid="button-spin-room-send-halo"
                        style={{
                          flex: 2, padding: "16px 10px", borderRadius: 18,
                          background: sendSpark.isPending
                            ? "rgba(183,106,114,0.38)"
                            : "linear-gradient(135deg,#b76a72 0%,#92515e 100%)",
                          boxShadow: sendSpark.isPending
                            ? "none"
                            : "0 10px 24px rgba(73,32,40,0.30)",
                          border: "none", color: "#fff",
                          fontSize: 13, fontWeight: 700,
                          letterSpacing: "0.02em",
                          cursor: sendSpark.isPending ? "default" : "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                        }}
                      >
                        {sendSpark.isPending
                          ? <Loader2 style={{ width: 15, height: 15, animation: "spinBtn 0.65s linear infinite" }} />
                          : <span style={{ fontSize: 13, lineHeight: 1 }}>Send</span>
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
              ><X style={{ width: 17, height: 17, color: "rgba(255,245,240,0.76)" }} /></button>
            </div>
          </IntentResultBoundary>
          )}

        </div>
      )}

      {/* ── Spin Extras Sheet — slides up after Close or Spark Sent ── */}
      {showSpinExtras && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9500,
            background: `rgba(0,0,0,${Math.max(0.24, 0.70 - haloDragY / 420).toFixed(2)})`,
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            display: "flex", alignItems: "flex-end",
          }}
          onClick={() => { setShowSpinExtras(false); setHaloDragY(0); setHaloDragSnapping(false); }}
        >
          {/* Drag-transform wrapper — handles touch drag; does NOT carry the entry animation */}
          <div
            style={{
              width: "100%",
              transform: `translateY(${haloDragY}px)`,
              transition: haloDragSnapping ? "transform 0.38s cubic-bezier(0.34,1.56,0.64,1)" : "none",
              willChange: "transform",
            }}
            onClick={e => e.stopPropagation()}
            onTouchStart={e => {
              haloDragRef.current = { startY: e.touches[0].clientY, startTime: Date.now(), active: true, currentY: 0 };
              setHaloDragSnapping(false);
            }}
            onTouchMove={e => {
              if (!haloDragRef.current.active) return;
              const delta = Math.max(0, e.touches[0].clientY - haloDragRef.current.startY);
              haloDragRef.current.currentY = delta;
              setHaloDragY(delta);
            }}
            onTouchEnd={() => {
              if (!haloDragRef.current.active) return;
              haloDragRef.current.active = false;
              const elapsed = Math.max(Date.now() - haloDragRef.current.startTime, 1);
              const dragged = haloDragRef.current.currentY;
              const velocity = (dragged / elapsed) * 1000; // px/s
              if (dragged > 140 || velocity > 550) {
                setHaloDragY(0);
                setHaloDragSnapping(false);
                setShowSpinExtras(false);
              } else {
                setHaloDragSnapping(true);
                setHaloDragY(0);
                setTimeout(() => setHaloDragSnapping(false), 400);
              }
            }}
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
                    {spinStatus!.purchasedSpins} Halo{spinStatus!.purchasedSpins === 1 ? "" : "s"} remaining
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
            }}>{t("halo_get_more")}</p>

            {/* Halo packs */}
            <div style={{ padding: "0 20px", display: "flex", flexDirection: "column", gap: 10 }}>
              {(
                [
                  { itemId: "sparks-1", label: t("halo_pkg1_label"), sub: t("halo_pkg1_sub"), price: "$2.99",  highlight: false },
                  { itemId: "sparks-3", label: t("halo_pkg3_label"), sub: t("halo_pkg3_sub"), price: "$6.99",  highlight: true  },
                  { itemId: "sparks-5", label: t("halo_pkg5_label"), sub: t("halo_pkg5_sub"), price: "$9.99",  highlight: false },
                ] as const
              ).map(({ itemId, label, sub, price, highlight }) => (
                <button
                  key={itemId}
                  data-testid={`button-spin-extra-${itemId.split("-")[1]}`}
                  disabled={sparksCheckoutLoading === itemId}
                  onClick={() => {
                    if (sparksCheckoutLoading) return;
                    setSparksCheckoutLoading(itemId);
                    toast({ title: t("checkout_starting"), description: t("checkout_connecting") });
                    void startPurchase({
                      productId: itemId,
                      body: { itemId, returnPath: "/intent" },
                      onError: (msg) => {
                        toast({ title: t("checkout_failed"), description: msg, variant: "destructive" });
                        setSparksCheckoutLoading(null);
                      },
                    });
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

            {/* Checkout telemetry remains in the purchase service. Its raw
                response panel is development-only. */}
            {import.meta.env.DEV && (
              <CheckoutDiagPanel
                diag={checkoutDiag}
                onSubscribe={setCheckoutDiag}
                open={showSpinExtras}
              />
            )}

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
          </div>{/* end drag-transform wrapper */}

          {/* Silent wheel telemetry continues to be recorded and posted. */}
          {import.meta.env.DEV && <WheelDebugPanel />}
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
