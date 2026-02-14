import { useLocation, Link } from "wouter";
import { Compass, Heart, User, CircleDot } from "lucide-react";

function DahliaIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="12" cy="5.5" rx="2.2" ry="4.5" fill="currentColor" opacity="0.35" />
      <ellipse cx="12" cy="18.5" rx="2.2" ry="4.5" fill="currentColor" opacity="0.35" />
      <ellipse cx="5.5" cy="12" rx="4.5" ry="2.2" fill="currentColor" opacity="0.35" />
      <ellipse cx="18.5" cy="12" rx="4.5" ry="2.2" fill="currentColor" opacity="0.35" />
      <ellipse cx="7.4" cy="7.4" rx="2.2" ry="4.5" transform="rotate(45 7.4 7.4)" fill="currentColor" opacity="0.45" />
      <ellipse cx="16.6" cy="16.6" rx="2.2" ry="4.5" transform="rotate(45 16.6 16.6)" fill="currentColor" opacity="0.45" />
      <ellipse cx="16.6" cy="7.4" rx="2.2" ry="4.5" transform="rotate(-45 16.6 7.4)" fill="currentColor" opacity="0.45" />
      <ellipse cx="7.4" cy="16.6" rx="2.2" ry="4.5" transform="rotate(-45 7.4 16.6)" fill="currentColor" opacity="0.45" />
      <ellipse cx="12" cy="8" rx="1.6" ry="3.5" fill="currentColor" opacity="0.6" />
      <ellipse cx="12" cy="16" rx="1.6" ry="3.5" fill="currentColor" opacity="0.6" />
      <ellipse cx="8" cy="12" rx="3.5" ry="1.6" fill="currentColor" opacity="0.6" />
      <ellipse cx="16" cy="12" rx="3.5" ry="1.6" fill="currentColor" opacity="0.6" />
      <ellipse cx="9" cy="9" rx="1.6" ry="3.5" transform="rotate(45 9 9)" fill="currentColor" opacity="0.7" />
      <ellipse cx="15" cy="15" rx="1.6" ry="3.5" transform="rotate(45 15 15)" fill="currentColor" opacity="0.7" />
      <ellipse cx="15" cy="9" rx="1.6" ry="3.5" transform="rotate(-45 15 9)" fill="currentColor" opacity="0.7" />
      <ellipse cx="9" cy="15" rx="1.6" ry="3.5" transform="rotate(-45 9 15)" fill="currentColor" opacity="0.7" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" opacity="0.9" />
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
            <DahliaIcon className="w-5 h-5 text-primary" />
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
