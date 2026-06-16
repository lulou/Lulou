import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { Compass, Heart, MessageCircle, User, CircleDot, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/hooks/use-tab-active";
import { decodedPhotos } from "@/lib/image-utils";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { useLanguageContext } from "@/contexts/language-context";

interface IncomingOpen {
  id: string;
  fromUserId: string;
}

interface MatchItem {
  id: string;
  lastMessage?: string | null;
}

/**
 * LulouFlowerIcon — the approved Lulou LL heart monogram.
 *
 * Design: two mirrored capital L's drawn as thin, elegant stroked lines
 * (serif-capped, meeting at the base) with a delicate filled heart that
 * emerges naturally in the space between the two vertical stems.
 *
 * Uses `currentColor` so Tailwind text-* classes (text-primary, etc.)
 * set the colour automatically. Works cleanly from 16 px upward.
 */
export function LulouFlowerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Lulou"
    >
      {/* ── Left L — thin elegant serif letterform ─────────────────────
           Horizontal serif at the top; vertical stroke flowing down to a
           horizontal foot that reaches the centre.                       */}
      <path
        d="M9,8 L13,8  M11,8 L11,33 L20,33"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* ── Right L — mirror image ─────────────────────────────────────
           Serif at top-right; vertical stroke mirrored; foot meets the
           left L's foot at centre-bottom creating the LL monogram base. */}
      <path
        d="M31,8 L27,8  M29,8 L29,33 L20,33"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* ── Heart — the romantic symbol between the stems ──────────────
           ~12 % larger than before: outer edges pushed to 11/29 and tip
           dropped to y=22, keeping the elegant proportions.              */}
      <path
        d="M20,22 C15.5,18 11,14 11,10 C11,6 14,5.5 20,11 C26,5.5 29,6 29,10 C29,14 24.5,18 20,22Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * ProfileAvatar — pop-in-free avatar for profile photos.
 *
 * Uses the module-level `decodedPhotos` bitmap cache to determine initial
 * opacity: if the browser has already decoded the image (via preloadPhoto /
 * batchPrefetchPhotos) it renders at opacity:1 immediately.  Otherwise it
 * starts at 0 and transitions to 1 over 80ms — imperceptible to the user
 * yet still prevents a hard, jarring pop.
 *
 * Replaces shadcn Avatar + AvatarImage which shows the letter fallback first,
 * then pops to the photo with no transition.  Here the background is always a
 * neutral muted circle so there is no letter flash.
 */
export function ProfileAvatar({
  src,
  name,
  className,
}: {
  src?: string;
  name?: string;
  className?: string;
}) {
  return (
    <div
      className={`relative rounded-full overflow-hidden bg-primary/10 flex items-center justify-center flex-shrink-0 ${className ?? ""}`}
    >
      {/* Letter initial — visible only when no photo src is provided */}
      {!src && name?.[0] && (
        <span className="text-primary font-semibold text-sm select-none" aria-hidden="true">
          {name[0].toUpperCase()}
        </span>
      )}
      {src && (
        <img
          src={src}
          alt={name ?? ""}
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover object-top"
          style={{
            opacity: decodedPhotos.has(src) ? 1 : 0,
            transition: decodedPhotos.has(src) ? "none" : "opacity 0.08s ease",
          }}
          onLoad={(e) => {
            decodedPhotos.add(src);
            const el = e.currentTarget as HTMLImageElement;
            el.style.transition = "none";
            el.style.opacity = "1";
          }}
        />
      )}
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout, isLoggingOut } = useAuth();
  const { t } = useLanguageContext();
  // Gate background polling on tab visibility — stops network + GC pressure
  // when the user has the app open in a background tab.
  const isTabActive = useTabActive();

  // Hide navigation when inside a chat room — focus mode
  const isChatRoom = location.startsWith("/messages/");

  // [PERF_FIX] Use `select` on both queries so AppLayout only re-renders when
  // a badge COUNT changes — not on every poll response when the underlying
  // array reference changes but the count stays the same.
  const { data: likesCount = 0 } = useQuery<IncomingOpen[], Error, number>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: isTabActive ? 10000 : false,
    select: (data) => data.length,
  });

  const { data: newConnectionsCount = 0 } = useQuery<MatchItem[], Error, number>({
    queryKey: ["/api/matches"],
    select: (data) => data.filter(m => !m.lastMessage).length,
  });

  // Track how many new connections the user has acknowledged (persisted across refresh)
  const [seenConnectionsCount, setSeenConnectionsCount] = useState<number>(() => {
    try { return parseInt(localStorage.getItem("lulou_seen_connections") ?? "0", 10) || 0; } catch { return 0; }
  });

  // When user visits /matches, mark all current new connections as seen
  useEffect(() => {
    if (!location.startsWith("/matches")) return;
    try { localStorage.setItem("lulou_seen_connections", String(newConnectionsCount)); } catch { /* noop */ }
    setSeenConnectionsCount(newConnectionsCount);
  }, [location, newConnectionsCount]);

  // Badge count = how many new connections appeared since user last visited
  const newConnectionsBadge = Math.max(0, newConnectionsCount - seenConnectionsCount);

  const navItems = [
    { path: "/discover", icon: Compass, label: t("discover") },
    { path: "/intent", icon: CircleDot, label: t("intent") },
    { path: "/likes", icon: Heart, label: t("likes") },
    { path: "/matches", icon: MessageCircle, label: t("connections") },
    { path: "/profile", icon: User, label: t("profile") },
  ];

  return (
    <div className="flex flex-col w-full bg-background" style={isChatRoom ? { position: "fixed", inset: "0" } : { height: "100dvh" }}>
      <header
        className="flex items-center justify-between gap-4 px-5 py-3 border-b bg-background/80 backdrop-blur-md z-30 flex-wrap"
        aria-hidden={isChatRoom}
        style={{
          overflow: "hidden",
          maxHeight: isChatRoom ? 0 : "80px",
          opacity: isChatRoom ? 0 : 1,
          borderBottomWidth: isChatRoom ? 0 : undefined,
          transition: "max-height 0.13s ease, opacity 0.1s ease",
          pointerEvents: isChatRoom ? "none" : "auto",
        }}
      >
        <Link href="/discover">
          <div className="flex items-center gap-2 cursor-pointer">
            <LulouFlowerIcon className="w-8 h-8 text-primary" />
            <span className="font-serif text-lg font-semibold tracking-tight" data-testid="text-app-logo">Lulou</span>
          </div>
        </Link>
        <button
          onClick={() => logout()}
          disabled={isLoggingOut}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive transition-colors px-2 py-1.5 rounded-md"
          data-testid="button-header-logout"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden sm:inline">{t("sign_out")}</span>
        </button>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>

      <nav
        className="border-t bg-background/95 backdrop-blur-md z-30"
        aria-hidden={isChatRoom}
        style={{
          overflow: "hidden",
          maxHeight: isChatRoom ? 0 : "80px",
          opacity: isChatRoom ? 0 : 1,
          borderTopWidth: isChatRoom ? 0 : undefined,
          transition: "max-height 0.13s ease, opacity 0.1s ease",
          pointerEvents: isChatRoom ? "none" : "auto",
          paddingBottom: isChatRoom ? 0 : "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <div className="flex items-center justify-around py-2">
          {navItems.map(item => {
            const isActive = location.startsWith(item.path);
            const isLikes = item.path === "/likes";
            const isConnections = item.path === "/matches";
            return (
              <Link key={item.path} href={item.path}>
                <button
                  className={`relative flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-md transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground"
                  }`}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                  onClick={() => stopAllNonVoiceCallAudio("nav_tab_click")}
                >
                  <div className="relative">
                    <item.icon className="w-5 h-5" />
                    {isLikes && likesCount > 0 && (
                      <span
                        className="absolute -top-1.5 -right-3.5 rtl:right-auto rtl:-left-3.5 flex items-center gap-px bg-primary text-primary-foreground text-[9px] font-bold rounded-full px-1 min-w-[16px] h-4 justify-center leading-none"
                        data-testid="badge-likes-count"
                      >
                        +{likesCount}
                      </span>
                    )}
                    {isConnections && newConnectionsBadge > 0 && (
                      <span
                        className="absolute -top-1.5 -right-3.5 rtl:right-auto rtl:-left-3.5 flex items-center gap-px bg-primary text-primary-foreground text-[9px] font-bold rounded-full px-1 min-w-[16px] h-4 justify-center leading-none"
                        data-testid="badge-connections-count"
                      >
                        +{newConnectionsBadge}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-medium">{item.label}</span>
                </button>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
