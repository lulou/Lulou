import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
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
import IncomingCallOverlay from "@/components/incoming-call";
import { ActiveCallOverlay } from "@/components/active-call";
import { useCallSignaling, setCallEndedHandler, clearDedupeForMatch } from "@/hooks/use-call-signaling";
import type { Profile, Match } from "@shared/schema";
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

type MatchWithProfile = Match & { profile: Profile };

function CallDetectors({ userId }: { userId: string }) {
  const [dismissedCallKey, setDismissedCallKey] = useState<string | null>(null);
  const endedSessionsRef = useRef(new Set<string>());
  const endedMatchIdsRef = useRef(new Set<string>());
  const [endedTick, setEndedTick] = useState(0);
  const qc = useQueryClient();

  const { data: matches } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    refetchInterval: 10000,
  });

  const matchIds = (matches || []).map(m => m.id);
  useCallSignaling(matchIds, userId);

  const markCallEnded = useCallback((matchId: string, sessionId?: string) => {
    endedMatchIdsRef.current.add(matchId);
    if (sessionId) endedSessionsRef.current.add(sessionId);
    console.log("[CallDetectors] CALL_STATE_CLEARED", { matchId, sessionId, endedMatches: [...endedMatchIdsRef.current], endedSessions: [...endedSessionsRef.current] });
    setEndedTick(t => t + 1);
    qc.invalidateQueries({ queryKey: ["/api/matches"] });
    qc.invalidateQueries({ queryKey: ["/api/matches", matchId] });
  }, [qc]);

  useEffect(() => {
    if (!matches) return;
    const toRemove: string[] = [];
    for (const mid of endedMatchIdsRef.current) {
      const m = matches.find(x => x.id === mid);
      if (m && !m.callStartedAt && !m.callInitiatorId && !m.callAnswered && !m.callSessionId) {
        toRemove.push(mid);
      }
    }
    if (toRemove.length > 0) {
      for (const mid of toRemove) {
        endedMatchIdsRef.current.delete(mid);
        clearDedupeForMatch(mid);
        console.log("[CallDetectors] CALL_LISTENER_REMOVED - match confirmed cleared:", mid);
      }
      setEndedTick(t => t + 1);
    }
  }, [matches]);

  useEffect(() => {
    setCallEndedHandler((matchId: string) => {
      console.log("[CallDetectors] CALL_END_RECEIVED - forcing call end for matchId:", matchId);
      const m = matches?.find(x => x.id === matchId);
      markCallEnded(matchId, m?.callSessionId || undefined);
    });
    return () => setCallEndedHandler(null);
  }, [qc, matches, markCallEnded]);

  const isEndedCall = useCallback((m: MatchWithProfile) => {
    if (endedMatchIdsRef.current.has(m.id)) return true;
    if (m.callSessionId && endedSessionsRef.current.has(m.callSessionId)) return true;
    return false;
  }, [endedTick]);

  const incomingCall = matches?.find(m => {
    if (!m.callStartedAt || m.callAnswered || m.callCompleted) return false;
    if (!m.callSessionId) return false;
    if (!m.callInitiatorId || m.callInitiatorId === userId) return false;
    if (isEndedCall(m)) {
      console.log("[CallDetectors] INCOMING_CALL_RESET - suppressed ended call:", m.id, m.callSessionId);
      return false;
    }
    const callKey = `${m.id}:${m.callSessionId}`;
    return callKey !== dismissedCallKey;
  });

  const answeredCall = matches?.find(m => {
    if (!(!!m.callStartedAt && !!m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    if (isEndedCall(m)) {
      console.log("[CallDetectors] OUTGOING_CALL_RESET - suppressed ended answered call:", m.id, m.callSessionId);
      return false;
    }
    return true;
  });

  const callerRingingCall = matches?.find(m => {
    if (!(!!m.callStartedAt && !!m.callSessionId && !m.callAnswered && !m.callCompleted &&
      m.callInitiatorId === userId)) return false;
    if (isEndedCall(m)) {
      console.log("[CallDetectors] OUTGOING_CALL_RESET - suppressed ended ringing call:", m.id, m.callSessionId);
      return false;
    }
    return true;
  });

  const activeCall = answeredCall || callerRingingCall;

  useEffect(() => {
    if (incomingCall) {
      console.log("[CallDetectors] INCOMING_CALL_DETECTED", {
        matchId: incomingCall.id,
        callSessionId: incomingCall.callSessionId,
        callerId: incomingCall.callInitiatorId,
        callerName: incomingCall.profile?.firstName,
      });
    }
  }, [incomingCall?.id, incomingCall?.callSessionId]);

  useEffect(() => {
    if (activeCall) {
      console.log("[CallDetectors] CALL_SESSION_LOADED", {
        matchId: activeCall.id,
        callSessionId: activeCall.callSessionId,
        isCaller: activeCall.callInitiatorId === userId,
        answered: activeCall.callAnswered,
      });
    }
  }, [activeCall?.id, activeCall?.callSessionId, activeCall?.callAnswered, userId]);

  const isFaceCall = incomingCall
    ? (incomingCall.callStage || 0) === 2 &&
      !!incomingCall.faceCallUser1Accepted &&
      !!incomingCall.faceCallUser2Accepted
    : false;

  const isActiveVideo = activeCall
    ? (activeCall.callStage || 0) === 2 &&
      !!activeCall.faceCallUser1Accepted &&
      !!activeCall.faceCallUser2Accepted
    : false;

  const handleDismiss = useCallback(() => {
    if (incomingCall) {
      console.log("[CallDetectors] INCOMING_CALL_RESET - dismissing:", incomingCall.id);
      setDismissedCallKey(`${incomingCall.id}:${incomingCall.callSessionId}`);
      markCallEnded(incomingCall.id, incomingCall.callSessionId || undefined);
    }
  }, [incomingCall, markCallEnded]);

  const handleActiveCallEnd = useCallback(() => {
    console.log("[CallDetectors] CALL_SESSION_CLOSED", { matchId: activeCall?.id, callSessionId: activeCall?.callSessionId });
    if (activeCall) {
      markCallEnded(activeCall.id, activeCall.callSessionId || undefined);
    }
  }, [activeCall?.id, activeCall?.callSessionId, markCallEnded]);

  return (
    <>
      {incomingCall && !activeCall && (
        <IncomingCallOverlay
          match={incomingCall}
          isFaceCall={isFaceCall}
          onDismiss={handleDismiss}
        />
      )}
      {activeCall && (
        <ActiveCallOverlay
          matchId={activeCall.id}
          callSessionId={activeCall.callSessionId || ""}
          userId={userId}
          isCaller={activeCall.callInitiatorId === userId}
          isVideo={isActiveVideo}
          isRinging={!activeCall.callAnswered}
          callerName={activeCall.profile?.name || activeCall.profile?.firstName || "Unknown"}
          callerPhoto={activeCall.profile?.photos?.[0] || undefined}
          onCallEnd={handleActiveCallEnd}
        />
      )}
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
      <CallDetectors userId={user.id} />
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
