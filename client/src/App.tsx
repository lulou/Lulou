import { Switch, Route } from "wouter";
import { queryClient, getQueryFn } from "./lib/queryClient";
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
import AppLayout from "@/components/app-layout";
import type { Profile } from "@shared/schema";
import { Flower2 } from "lucide-react";

async function fetchProfileSafe(): Promise<Profile | null> {
  const res = await fetch("/api/profile", { credentials: "include" });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return res.json();
}

function AppContent() {
  const { user, isLoading: authLoading } = useAuth();

  const { data: profile, isLoading: profileLoading } = useQuery<Profile | null>({
    queryKey: ["/api/profile"],
    queryFn: fetchProfileSafe,
    enabled: !!user,
    retry: false,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Flower2 className="w-8 h-8 text-primary animate-pulse" />
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
          <Flower2 className="w-8 h-8 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Setting up your experience...</p>
        </div>
      </div>
    );
  }

  if (!profile || !profile.onboardingComplete) {
    return <Onboarding />;
  }

  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Discover} />
        <Route path="/discover" component={Discover} />
        <Route path="/intent" component={IntentPage} />
        <Route path="/matches" component={Matches} />
        <Route path="/messages/:matchId" component={Messaging} />
        <Route path="/profile" component={ProfilePage} />
        <Route component={NotFound} />
      </Switch>
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
