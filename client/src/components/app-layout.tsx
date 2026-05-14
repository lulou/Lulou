import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { Compass, Heart, MessageCircle, User, CircleDot, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTabActive } from "@/hooks/use-tab-active";
import { decodedPhotos } from "@/lib/image-utils";

interface IncomingOpen {
  id: string;
  fromUserId: string;
}

interface MatchItem {
  id: string;
  lastMessage?: string | null;
}

export function LulouFlowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 44" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M20 28 Q19.6 32, 19.2 38 Q19.6 40, 20 40 Q20.4 40, 20.8 38 Q20.4 32, 20 28Z" fill="hsl(155 30% 40%)" opacity="0.75" />
      <path d="M20 30 Q17 28.5, 12 31 Q11.2 31.8, 12 32.5 Q15 31.5, 20 30Z" fill="hsl(155 35% 45%)" opacity="0.7" />
      <path d="M20 30 Q23 28.5, 28 31 Q28.8 31.8, 28 32.5 Q25 31.5, 20 30Z" fill="hsl(155 28% 38%)" opacity="0.7" />

      <path d="M20 8 Q14 5, 10 8 Q8 11, 12 15 Q15 18, 20 20 Q18 14, 20 8Z" fill="hsl(350 45% 72%)" opacity="0.5" />
      <path d="M20 8 Q26 5, 30 8 Q32 11, 28 15 Q25 18, 20 20 Q22 14, 20 8Z" fill="hsl(350 42% 70%)" opacity="0.45" />
      <path d="M20 6 Q16 2, 12 4 Q9 7, 11 11 Q14 16, 20 19 Q17 12, 20 6Z" fill="hsl(350 48% 68%)" opacity="0.6" />
      <path d="M20 6 Q24 2, 28 4 Q31 7, 29 11 Q26 16, 20 19 Q23 12, 20 6Z" fill="hsl(350 44% 66%)" opacity="0.55" />

      <path d="M20 4 Q17 1, 14 3 Q12 6, 14 10 Q16 14, 20 18 Q18 10, 20 4Z" fill="hsl(350 50% 76%)" opacity="0.7" />
      <path d="M20 4 Q23 1, 26 3 Q28 6, 26 10 Q24 14, 20 18 Q22 10, 20 4Z" fill="hsl(350 46% 74%)" opacity="0.65" />

      <path d="M20 5 Q18.5 3, 17 5 Q16 8, 18 12 Q19 15, 20 17 Q19 10, 20 5Z" fill="hsl(350 52% 82%)" opacity="0.8" />
      <path d="M20 5 Q21.5 3, 23 5 Q24 8, 22 12 Q21 15, 20 17 Q21 10, 20 5Z" fill="hsl(350 48% 80%)" opacity="0.75" />

      <circle cx="20" cy="12" r="3" fill="hsl(40 55% 65%)" opacity="0.9" />
      <circle cx="20" cy="12" r="1.5" fill="hsl(40 60% 72%)" opacity="0.7" />
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
  // Gate background polling on tab visibility — stops network + GC pressure
  // when the user has the app open in a background tab.
  const isTabActive = useTabActive();

  // Hide navigation when inside a chat room — focus mode
  const isChatRoom = location.startsWith("/messages/");

  const { data: likes } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: isTabActive ? 30000 : false,
  });

  const { data: matchesData } = useQuery<MatchItem[]>({
    queryKey: ["/api/matches"],
    refetchInterval: isTabActive ? 30000 : false,
  });

  const likesCount = likes?.length ?? 0;

  // New connections = matches with no messages yet
  const newConnectionsCount = (matchesData ?? []).filter(m => !m.lastMessage).length;

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

  // ── Visual viewport height tracker ──────────────────────────────────────────
  // iOS Safari does NOT resize 100vh when the software keyboard opens — the
  // bottom of the flex column slides behind the keyboard, hiding the input bar.
  // Fix: listen to visualViewport.resize (fires on keyboard open/close) and
  // update a CSS custom property --vvh directly on <html>.  Pure DOM mutation =
  // zero React re-renders = zero animation jank during the 300 ms keyboard slide.
  // The root div (and the fixed chat overlay in matches.tsx) use
  // height: var(--vvh, 100dvh) so they shrink exactly to the visible area.
  useEffect(() => {
    const setVvh = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--vvh", `${h}px`);
    };
    setVvh();
    window.visualViewport?.addEventListener("resize", setVvh);
    return () => window.visualViewport?.removeEventListener("resize", setVvh);
  }, []);

  const navItems = [
    { path: "/discover", icon: Compass, label: "Discover" },
    { path: "/intent", icon: CircleDot, label: "Intent" },
    { path: "/likes", icon: Heart, label: "Likes" },
    { path: "/matches", icon: MessageCircle, label: "Connections" },
    { path: "/profile", icon: User, label: "Profile" },
  ];

  return (
    <div className="flex flex-col w-full bg-background" style={{ height: "var(--vvh, 100dvh)" }}>
      {!isChatRoom && (
        <header className="flex items-center justify-between gap-4 px-5 py-3 border-b bg-background/80 backdrop-blur-md z-30 flex-wrap">
          <Link href="/discover">
            <div className="flex items-center gap-2 cursor-pointer">
              <LulouFlowerIcon className="w-6 h-6 text-primary" />
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
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </header>
      )}

      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>

      {!isChatRoom && (
      <nav className="border-t bg-background/95 backdrop-blur-md z-30" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
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
                >
                  <div className="relative">
                    <item.icon className="w-5 h-5" />
                    {isLikes && likesCount > 0 && (
                      <span
                        className="absolute -top-1.5 -right-3.5 flex items-center gap-px bg-primary text-primary-foreground text-[9px] font-bold rounded-full px-1 min-w-[16px] h-4 justify-center leading-none"
                        data-testid="badge-likes-count"
                      >
                        +{likesCount}
                      </span>
                    )}
                    {isConnections && newConnectionsBadge > 0 && (
                      <span
                        className="absolute -top-1.5 -right-3.5 flex items-center gap-px bg-primary text-primary-foreground text-[9px] font-bold rounded-full px-1 min-w-[16px] h-4 justify-center leading-none"
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
      )}
    </div>
  );
}
