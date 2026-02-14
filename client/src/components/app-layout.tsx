import { useLocation, Link } from "wouter";
import { Compass, Heart, User, CircleDot } from "lucide-react";

function BloomFlowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 28" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 16 C11 18, 10.5 21, 11 26 Q11.5 27, 12 27 Q12.5 27, 13 26 C13.5 21, 13 18, 12 16Z" fill="currentColor" opacity="0.5" />
      <path d="M11.5 20 C10 19.5, 8 19.5, 6 20.5" stroke="currentColor" strokeWidth="0.6" opacity="0.35" fill="none" strokeLinecap="round" />
      <path d="M12.5 22 C14 21.5, 16 21.5, 17.5 22.5" stroke="currentColor" strokeWidth="0.6" opacity="0.35" fill="none" strokeLinecap="round" />
      <ellipse cx="12" cy="5" rx="2.5" ry="4.2" fill="currentColor" opacity="0.3" />
      <ellipse cx="6.2" cy="10" rx="2.5" ry="4.2" transform="rotate(60 6.2 10)" fill="currentColor" opacity="0.3" />
      <ellipse cx="17.8" cy="10" rx="2.5" ry="4.2" transform="rotate(-60 17.8 10)" fill="currentColor" opacity="0.3" />
      <ellipse cx="8" cy="14" rx="2.5" ry="4.2" transform="rotate(120 8 14)" fill="currentColor" opacity="0.3" />
      <ellipse cx="16" cy="14" rx="2.5" ry="4.2" transform="rotate(-120 16 14)" fill="currentColor" opacity="0.3" />
      <ellipse cx="12" cy="5.5" rx="2" ry="3.4" fill="currentColor" opacity="0.5" />
      <ellipse cx="7" cy="9.5" rx="2" ry="3.4" transform="rotate(60 7 9.5)" fill="currentColor" opacity="0.5" />
      <ellipse cx="17" cy="9.5" rx="2" ry="3.4" transform="rotate(-60 17 9.5)" fill="currentColor" opacity="0.5" />
      <ellipse cx="8.5" cy="13.5" rx="2" ry="3.4" transform="rotate(120 8.5 13.5)" fill="currentColor" opacity="0.5" />
      <ellipse cx="15.5" cy="13.5" rx="2" ry="3.4" transform="rotate(-120 15.5 13.5)" fill="currentColor" opacity="0.5" />
      <ellipse cx="12" cy="6.5" rx="1.4" ry="2.5" fill="currentColor" opacity="0.75" />
      <ellipse cx="8.2" cy="9.2" rx="1.4" ry="2.5" transform="rotate(60 8.2 9.2)" fill="currentColor" opacity="0.75" />
      <ellipse cx="15.8" cy="9.2" rx="1.4" ry="2.5" transform="rotate(-60 15.8 9.2)" fill="currentColor" opacity="0.75" />
      <ellipse cx="9.5" cy="12.8" rx="1.4" ry="2.5" transform="rotate(120 9.5 12.8)" fill="currentColor" opacity="0.75" />
      <ellipse cx="14.5" cy="12.8" rx="1.4" ry="2.5" transform="rotate(-120 14.5 12.8)" fill="currentColor" opacity="0.75" />
      <circle cx="12" cy="10" r="2.2" fill="currentColor" opacity="0.9" />
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
