import { useLocation, Link } from "wouter";
import { Leaf, Compass, Heart, User, CircleDot } from "lucide-react";

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
            <Leaf className="w-5 h-5 text-primary" />
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
