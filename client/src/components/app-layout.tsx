import { useLocation, Link } from "wouter";
import { Compass, Heart, User, CircleDot } from "lucide-react";

export function BloomFlowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 48" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M20 30 Q19.4 34, 18.8 40 Q19.5 42, 20 42 Q20.5 42, 21.2 40 Q20.6 34, 20 30Z" fill="hsl(150 25% 42%)" opacity="0.7" />

      <path d="M20 32 Q16 30, 8 33 Q7 34, 8 35 Q12 34, 20 32Z" fill="hsl(150 30% 48%)" opacity="0.65" />
      <path d="M20 32 Q24 30, 32 33 Q33 34, 32 35 Q28 34, 20 32Z" fill="hsl(150 25% 42%)" opacity="0.65" />

      <path d="M20 26 Q14 23, 6 24 Q4 25.5, 5 27 Q6 28, 12 27 Q17 26, 20 26Z" fill="hsl(150 30% 48%)" opacity="0.8" />
      <path d="M20 26 Q26 23, 34 24 Q36 25.5, 35 27 Q34 28, 28 27 Q23 26, 20 26Z" fill="hsl(150 25% 38%)" opacity="0.8" />

      <path d="M13 11 Q12 6, 15 4 Q18 2.5, 20 5 Q20 8, 18 12 Q16 16, 15 18 Q13 16, 13 11Z" fill="hsl(350 45% 78%)" opacity="0.7" />
      <path d="M27 11 Q28 6, 25 4 Q22 2.5, 20 5 Q20 8, 22 12 Q24 16, 25 18 Q27 16, 27 11Z" fill="hsl(350 40% 72%)" opacity="0.6" />

      <path d="M15.5 12 Q14.5 7.5, 17 5.5 Q19 4, 20 6.5 Q20 9, 18.5 13 Q17 17, 16 19 Q14.5 17, 15.5 12Z" fill="hsl(350 50% 82%)" opacity="0.55" />
      <path d="M24.5 12 Q25.5 7.5, 23 5.5 Q21 4, 20 6.5 Q20 9, 21.5 13 Q23 17, 24 19 Q25.5 17, 24.5 12Z" fill="hsl(350 45% 76%)" opacity="0.45" />

      <circle cx="20" cy="4" r="2.2" fill="hsl(40 55% 62%)" opacity="0.85" />
    </svg>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { path: "/discover", icon: Compass, label: "Discover" },
    { path: "/intent", icon: CircleDot, label: "Intent" },
    { path: "/matches", icon: Heart, label: "Connections" },
    { path: "/profile", icon: User, label: "Profile" },
  ];

  return (
    <div className="flex flex-col h-screen w-full bg-background">
      <header className="flex items-center justify-between gap-4 px-5 py-3 border-b bg-background/80 backdrop-blur-md z-30 flex-wrap">
        <Link href="/discover">
          <div className="flex items-center gap-2 cursor-pointer">
            <BloomFlowerIcon className="w-6 h-6 text-primary" />
            <span className="font-serif text-lg font-semibold tracking-tight" data-testid="text-app-logo">Bloom</span>
          </div>
        </Link>
      </header>

      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>

      <nav className="border-t bg-background/95 backdrop-blur-md z-30">
        <div className="flex items-center justify-around py-2">
          {navItems.map(item => {
            const isActive = location.startsWith(item.path);
            return (
              <Link key={item.path} href={item.path}>
                <button
                  className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-md transition-colors ${
                    isActive ? "text-primary" : "text-muted-foreground"
                  }`}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                >
                  <item.icon className="w-5 h-5" />
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
