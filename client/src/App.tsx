import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Onboarding from "@/pages/onboarding";
import Discover from "@/pages/discover";
import Matches from "@/pages/matches";
import Messaging from "@/pages/messaging";
import ProfilePage from "@/pages/profile";
import IntentPage from "@/pages/intent";
import LikesPage from "@/pages/likes";
import AppLayout from "@/components/app-layout";
import type { Profile } from "@shared/schema";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

const TabActiveContext = createContext(true);
export function useTabActive() { return useContext(TabActiveContext); }

const TAB_PAGES = [
  { path: "/discover", Component: Discover },
  { path: "/intent", Component: IntentPage },
  { path: "/likes", Component: LikesPage },
  { path: "/matches", Component: Matches },
  { path: "/profile", Component: ProfilePage },
] as const;

function PersistentTabs() {
  const [location] = useLocation();

  const activeTab = location === "/" ? "/discover" : location;
  const isTabRoute = TAB_PAGES.some(t => activeTab.startsWith(t.path));
  const isSubRoute = location.startsWith("/messages/");

  return (
    <>
      {TAB_PAGES.map(({ path, Component }) => {
        const isActive = activeTab.startsWith(path) && !isSubRoute;
        return (
          <div
            key={path}
            style={{
              display: isActive ? "contents" : "none",
            }}
          >
            <TabActiveContext.Provider value={isActive}>
              <Component />
            </TabActiveContext.Provider>
          </div>
        );
      })}
      {isSubRoute && (
        <Switch>
          <Route path="/messages/:matchId" component={Messaging} />
        </Switch>
      )}
      {!isTabRoute && !isSubRoute && location !== "/" && <NotFound />}
    </>
  );
}

type ProfileResult = { profile: Profile | null; fetchFailed: boolean };

async function fetchProfileSafe(): Promise<ProfileResult> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }
    const res = await fetch("/api/profile", { credentials: "include", headers });
    if (res.status === 401 || res.status === 404) return { profile: null, fetchFailed: false };
    if (!res.ok) {
      console.error("PROFILE_FETCH_ERROR", res.status, res.statusText);
      return { profile: null, fetchFailed: true };
    }
    const data = await res.json();
    return { profile: data, fetchFailed: false };
  } catch (err) {
    console.error("PROFILE_FETCH_ERROR", err);
    return { profile: null, fetchFailed: true };
  }
}

function AppContent() {
  const { user, isLoading: authLoading } = useAuth();

  const { data, isLoading: profileLoading } = useQuery<ProfileResult>({
    queryKey: ["/api/profile"],
    queryFn: fetchProfileSafe,
    enabled: !!user,
    retry: false,
  });

  const profile = data?.profile ?? null;
  const fetchFailed = data?.fetchFailed ?? false;

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Landing />;
  }

  if (profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Setting up your experience...</p>
        </div>
      </div>
    );
  }

  if (fetchFailed && !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <p className="text-lg font-serif font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground">We couldn't load your profile right now. You're still signed in — this is just a temporary issue.</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/profile"] })}
            data-testid="button-retry-profile"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!profile || !profile.onboardingComplete) {
    return <Onboarding />;
  }

  return (
    <AppLayout>
      <PersistentTabs />
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
