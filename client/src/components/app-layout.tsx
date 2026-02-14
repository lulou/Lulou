import { useLocation, Link } from "wouter";
import { Compass, Heart, User, CircleDot } from "lucide-react";

export function BloomFlowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 32" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 17 Q11.6 20, 11.2 25 Q11.8 26.5, 12 26.5 Q12.2 26.5, 12.8 25 Q12.4 20, 12 17Z" fill="currentColor" opacity="0.4" />
      <path d="M11.6 21 Q10 20.2, 7.5 20.8" stroke="currentColor" strokeWidth="0.45" opacity="0.25" fill="none" strokeLinecap="round" />
      <path d="M12.4 23 Q14 22.2, 16 22.8" stroke="currentColor" strokeWidth="0.45" opacity="0.25" fill="none" strokeLinecap="round" />

      <path d="M12 3.5 Q13.8 5.5, 13.5 9 Q12.2 10.5, 12 10.5 Q11.8 10.5, 10.5 9 Q10.2 5.5, 12 3.5Z" fill="currentColor" opacity="0.18" />
      <path d="M5.8 7 Q8 7.2, 10 9.5 Q10.2 11, 10 11.2 Q9.6 11.2, 8 10.2 Q5.5 8.8, 5.8 7Z" fill="currentColor" opacity="0.18" />
      <path d="M18.2 7 Q16 7.2, 14 9.5 Q13.8 11, 14 11.2 Q14.4 11.2, 16 10.2 Q18.5 8.8, 18.2 7Z" fill="currentColor" opacity="0.18" />
      <path d="M7 14.5 Q8 12.5, 10.2 11.5 Q11 11.8, 11 12 Q10.8 12.5, 9.5 14 Q7.8 15.8, 7 14.5Z" fill="currentColor" opacity="0.18" />
      <path d="M17 14.5 Q16 12.5, 13.8 11.5 Q13 11.8, 13 12 Q13.2 12.5, 14.5 14 Q16.2 15.8, 17 14.5Z" fill="currentColor" opacity="0.18" />

      <path d="M12 5 Q13.2 6.8, 13 9.5 Q12.2 10.8, 12 10.8 Q11.8 10.8, 11 9.5 Q10.8 6.8, 12 5Z" fill="currentColor" opacity="0.35" />
      <path d="M7.2 8 Q8.8 8, 10.3 10 Q10.3 11, 10.1 11.2 Q9.8 11.1, 8.6 10 Q6.8 9.2, 7.2 8Z" fill="currentColor" opacity="0.35" />
      <path d="M16.8 8 Q15.2 8, 13.7 10 Q13.7 11, 13.9 11.2 Q14.2 11.1, 15.4 10 Q17.2 9.2, 16.8 8Z" fill="currentColor" opacity="0.35" />
      <path d="M8 13.5 Q9 12, 10.5 11.5 Q11 11.8, 10.9 12 Q10.6 12.6, 9.8 13.5 Q8.5 14.8, 8 13.5Z" fill="currentColor" opacity="0.35" />
      <path d="M16 13.5 Q15 12, 13.5 11.5 Q13 11.8, 13.1 12 Q13.4 12.6, 14.2 13.5 Q15.5 14.8, 16 13.5Z" fill="currentColor" opacity="0.35" />

      <path d="M12 6.5 Q12.8 8, 12.6 9.8 Q12.1 10.5, 12 10.5 Q11.9 10.5, 11.4 9.8 Q11.2 8, 12 6.5Z" fill="currentColor" opacity="0.6" />
      <path d="M8.5 9 Q9.5 9, 10.5 10.2 Q10.5 10.8, 10.4 11 Q10.2 10.9, 9.4 10.2 Q8.2 9.6, 8.5 9Z" fill="currentColor" opacity="0.6" />
      <path d="M15.5 9 Q14.5 9, 13.5 10.2 Q13.5 10.8, 13.6 11 Q13.8 10.9, 14.6 10.2 Q15.8 9.6, 15.5 9Z" fill="currentColor" opacity="0.6" />
      <path d="M9.2 12.8 Q9.8 12, 10.8 11.5 Q11 11.7, 11 11.8 Q10.8 12.2, 10.2 12.8 Q9.5 13.6, 9.2 12.8Z" fill="currentColor" opacity="0.6" />
      <path d="M14.8 12.8 Q14.2 12, 13.2 11.5 Q13 11.7, 13 11.8 Q13.2 12.2, 13.8 12.8 Q14.5 13.6, 14.8 12.8Z" fill="currentColor" opacity="0.6" />

      <circle cx="12" cy="10.8" r="1.6" fill="currentColor" opacity="0.85" />
      <circle cx="12" cy="10.8" r="0.7" fill="currentColor" opacity="0.15" />
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
