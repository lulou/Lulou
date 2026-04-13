import { useLocation, Link } from "wouter";
import { Compass, Heart, User, CircleDot, Eye, LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";

interface IncomingOpen {
  id: string;
  fromUserId: string;
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

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout, isLoggingOut } = useAuth();

  // Hide navigation when inside a chat room — focus mode
  const isChatRoom = location.startsWith("/messages/");

  const { data: likes } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: 15000,
  });

  const likesCount = likes?.length ?? 0;

  const navItems = [
    { path: "/discover", icon: Compass, label: "Discover" },
    { path: "/intent", icon: CircleDot, label: "Intent" },
    { path: "/likes", icon: Eye, label: "Likes" },
    { path: "/matches", icon: Heart, label: "Connections" },
    { path: "/profile", icon: User, label: "Profile" },
  ];

  return (
    <div className="flex flex-col h-screen w-full bg-background">
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
      <nav className="border-t bg-background/95 backdrop-blur-md z-30">
        <div className="flex items-center justify-around py-2">
          {navItems.map(item => {
            const isActive = location.startsWith(item.path);
            const isLikes = item.path === "/likes";
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
