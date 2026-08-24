import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { Compass, Heart, MessageCircle, User, CircleDot, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/hooks/use-tab-active";
import { decodedPhotos } from "@/lib/image-utils";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { getAppLayoutScrollPolicy } from "@/lib/app-layout-scroll-policy";
import { useLanguageContext } from "@/contexts/language-context";
import { LulouOnboardingTour } from "@/components/lulou-onboarding-tour";

interface IncomingOpen {
  id: string;
  fromUserId: string;
}

interface MatchItem {
  id: string;
  lastMessage?: string | null;
}

/**
 * LulouFlowerIcon — renders the approved Lulou dark-plum LL heart monogram.
 *
 * Delegates to the canonical LulouLogo component so all logo renders
 * come from a single authoritative source file (lulou-logo-master.png).
 *
 * className controls size (w-*, h-*) and opacity only.
 */
export function LulouFlowerIcon({ className }: { className?: string }) {
  return (
    <img
      src="/lulou-logo-master.png"
      alt="Lulou"
      draggable={false}
      className={className}
      style={{ objectFit: "contain" }}
    />
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

  // Keep the shell's route interpretation aligned with PersistentTabs, which
  // renders Discover at "/" during an installed PWA's first load.
  const { isChatRoom, usesHeaderScrollOwner: isScrollWithHeaderPage } =
    getAppLayoutScrollPolicy(location);

  // Chat rooms manage their own keyboard-avoidance via keyboardHeight tracked
  // inside messaging.tsx. AppLayout simply pins the container to full screen.

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

  const appHeader = (
    <header
      className="flex items-center justify-between gap-4 px-5 py-3 border-b bg-background/80 backdrop-blur-md z-30 flex-wrap"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))",
        paddingInlineStart: "max(1.25rem, env(safe-area-inset-left, 0px))",
        paddingInlineEnd: "max(1.25rem, env(safe-area-inset-right, 0px))",
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
  );

  return (
    // Chat rooms render their own fixed layers (header, messages, composer) via messaging.tsx.
    // AppLayout provides a full-screen stacking context and hides its own chrome so there is
    // no overlap and no containing-block interference.
    <div className="flex flex-col w-full bg-background" data-app-layout style={isChatRoom ? { position: "fixed", top: 0, left: 0, right: 0, bottom: 0 } : { height: "100dvh" }}>
      {/* App-level header — hidden completely for chat rooms to avoid any backdrop-filter
          containment that would re-anchor fixed children from messaging.tsx */}
      {!isChatRoom && !isScrollWithHeaderPage && appHeader}

      <main data-scroll-owner="app-layout-main" className={
        isChatRoom
          ? "flex-1"
          : isScrollWithHeaderPage
            ? "flex-1 min-h-0 overflow-y-auto flex flex-col"
            : "flex-1 overflow-hidden flex flex-col"
      }>
        {!isChatRoom && isScrollWithHeaderPage && appHeader}
        {children}
      </main>

      {!isChatRoom && <nav
        data-bottom-navigation
        className="border-t bg-background/95 backdrop-blur-md z-30"
        style={{
          paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))",
          paddingInlineStart: "env(safe-area-inset-left, 0px)",
          paddingInlineEnd: "env(safe-area-inset-right, 0px)",
        }}
      >
        {/* Equal-width slots: each Link gets flex-1 so all five tabs share
            identical space regardless of label length.  The button fills its
            slot and centres the icon independently of the label text.       */}
        <div className="flex items-stretch py-1.5">
          {navItems.map(item => {
            const isActive = location.startsWith(item.path);
            const isLikes = item.path === "/likes";
            const isConnections = item.path === "/matches";
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground/70 hover:text-muted-foreground"
                }`}
                aria-current={isActive ? "page" : undefined}
                data-testid={`nav-${item.label.toLowerCase()}`}
                onClick={() => stopAllNonVoiceCallAudio("nav_tab_click")}
              >
                {/* Icon wrapper: fixed size so badges never shift the baseline */}
                <div className="relative flex items-center justify-center w-[22px] h-[22px]">
                  <item.icon className="w-[22px] h-[22px]" strokeWidth={isActive ? 2.2 : 1.8} />
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
                <span className="text-[10px] font-medium leading-none">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>}
      {!isChatRoom && <LulouOnboardingTour />}
    </div>
  );
}
