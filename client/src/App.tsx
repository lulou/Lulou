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
import { useCallSignaling, setCallEndedHandler, clearDedupeForMatch, getPendingCallState, clearPendingCallState, reconcilePendingWithServer } from "@/hooks/use-call-signaling";
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

function clearCallFromCache(qc: ReturnType<typeof useQueryClient>, matchId: string) {
  qc.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, (old) => {
    if (!old) return old;
    return old.map(m => m.id === matchId ? {
      ...m,
      callStartedAt: null,
      callInitiatorId: null,
      callAnswered: false,
      callCompleted: false,
      callSessionId: null,
    } : m);
  });
  qc.invalidateQueries({ queryKey: ["/api/matches"] });
  qc.invalidateQueries({ queryKey: ["/api/matches", matchId] });
}

function CallDetectors({ userId }: { userId: string }) {
  const [dismissedCallKey, setDismissedCallKey] = useState<string | null>(null);
  const endedMatchIdsRef = useRef(new Set<string>());
  const [endedTick, setEndedTick] = useState(0);
  const qc = useQueryClient();

  const { data: matches } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    refetchInterval: 10000,
  });

  const matchIds = (matches || []).map(m => m.id);
  useCallSignaling(matchIds, userId);

  const markCallEnded = useCallback((matchId: string) => {
    endedMatchIdsRef.current.add(matchId);
    setEndedTick(t => t + 1);
    clearCallFromCache(qc, matchId);
  }, [qc]);

  useEffect(() => {
    if (!matches) return;
    for (const mid of endedMatchIdsRef.current) {
      const m = matches.find(x => x.id === mid);
      if (m && !m.callStartedAt && !m.callInitiatorId && !m.callAnswered && !m.callSessionId) {
        endedMatchIdsRef.current.delete(mid);
        clearDedupeForMatch(mid);
      }
    }
    for (const m of matches) {
      reconcilePendingWithServer(m.id, m.callStartedAt, m.callInitiatorId);
    }
  }, [matches]);

  useEffect(() => {
    setCallEndedHandler((matchId: string) => {
      markCallEnded(matchId);
    });
    return () => setCallEndedHandler(null);
  }, [markCallEnded]);

  const isEndedCall = useCallback((m: MatchWithProfile) => {
    return endedMatchIdsRef.current.has(m.id);
  }, [endedTick]);

  const incomingCall = matches?.find(m => {
    if (!m.callStartedAt || m.callAnswered || m.callCompleted) return false;
    if (!m.callSessionId) return false;
    if (!m.callInitiatorId || m.callInitiatorId === userId) return false;
    if (isEndedCall(m)) return false;
    const callKey = `${m.id}:${m.callSessionId}`;
    return callKey !== dismissedCallKey;
  });

  const answeredCall = matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    return !isEndedCall(m);
  });

  const callerRingingCall = matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted &&
      m.callInitiatorId === userId)) return false;
    return !isEndedCall(m);
  });

  const activeCall = answeredCall || callerRingingCall;

  const prevIncomingRef = useRef<string | null>(null);
  const prevActiveRef = useRef<string | null>(null);

  useEffect(() => {
    const incomingKey = incomingCall ? `${incomingCall.id}:${incomingCall.callSessionId}` : null;
    if (incomingKey && incomingKey !== prevIncomingRef.current) {
      console.log("[CALL_UI] INCOMING_CALL_UI_SHOWN", {
        matchId: incomingCall!.id,
        callSessionId: incomingCall!.callSessionId,
        callerId: incomingCall!.callInitiatorId,
        receiverId: userId,
        SESSION_PARTICIPANTS_COUNT: 2,
      });
    }
    prevIncomingRef.current = incomingKey;
  }, [incomingCall?.id, incomingCall?.callSessionId, userId]);

  useEffect(() => {
    const activeKey = activeCall ? `${activeCall.id}:${activeCall.callSessionId}` : null;
    if (activeKey && activeKey !== prevActiveRef.current) {
      const isCaller = activeCall!.callInitiatorId === userId;
      console.log("[CALL_UI] ACTIVE_CALL_UI_SHOWN", {
        matchId: activeCall!.id,
        callSessionId: activeCall!.callSessionId,
        role: isCaller ? "CALLER" : "RECEIVER",
        callerId: activeCall!.callInitiatorId,
        userId,
        isRinging: !activeCall!.callAnswered,
        SESSION_PARTICIPANTS_COUNT: 2,
      });
    }
    prevActiveRef.current = activeKey;
  }, [activeCall?.id, activeCall?.callSessionId, userId]);

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
      setDismissedCallKey(`${incomingCall.id}:${incomingCall.callSessionId}`);
      markCallEnded(incomingCall.id);
    }
  }, [incomingCall, markCallEnded]);

  const handleActiveCallEnd = useCallback(() => {
    if (activeCall) {
      clearPendingCallState(activeCall.id);
      markCallEnded(activeCall.id);
    }
  }, [activeCall?.id, markCallEnded]);

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
  const { user, isLoading: authLoading, profileReady } = useAuth();

  const { data, isLoading: profileLoading } = useQuery<ProfileResult>({
    queryKey: ["/api/profile"],
    queryFn: fetchProfileSafe,
    enabled: !!user && profileReady,
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

  if (profileLoading || !profileReady) {
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
