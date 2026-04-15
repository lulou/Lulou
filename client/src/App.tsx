import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { queryClient, getAuthHeaders, apiRequest } from "./lib/queryClient";
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
import ElevateSuccessPage from "@/pages/elevate-success";
import ExtrasSuccessPage from "@/pages/extras-success";
import AppLayout from "@/components/app-layout";
import IncomingCallOverlay from "@/components/incoming-call";
import { ActiveCallOverlay } from "@/components/active-call";
import { useCallSignaling, setCallEndedHandler, clearDedupeForMatch } from "@/hooks/use-call-signaling";
import { markCallSessionCancelled, isCallSessionCancelled, clearCancelledSession } from "@/lib/cancelled-calls";
import type { Profile, Match } from "@shared/schema";
import { Loader2 } from "lucide-react";

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

function clearCallFromCache(
  qc: ReturnType<typeof useQueryClient>,
  matchId: string,
  callSessionId?: string | null,
) {
  console.log("[CALL_SESSION] CACHE_CLEARED", { matchId, callSessionId });
  if (callSessionId) markCallSessionCancelled(matchId, callSessionId);
  const cleared = {
    callStartedAt: null,
    callInitiatorId: null,
    callAnswered: false,
    callCompleted: false,
    callSessionId: null,
  };
  // Update list query — guard against detail query (non-array) being matched by the partial key
  qc.setQueriesData<MatchWithProfile[]>({ queryKey: ["/api/matches"] }, (old) => {
    if (!old || !Array.isArray(old)) return old;
    return old.map(m => m.id === matchId ? { ...m, ...cleared } : m);
  });
  // Also explicitly clear the detail query so the inline call UI resets
  qc.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old) => {
    if (!old || Array.isArray(old)) return old;
    return { ...old, ...cleared };
  });
}

function CallDetectors({ userId }: { userId: string }) {
  const [dismissedCallKey, setDismissedCallKey] = useState<string | null>(null);
  const endedMatchIdsRef = useRef(new Set<string>());
  const [endedTick, setEndedTick] = useState(0);
  const qc = useQueryClient();

  const { data: matches } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    refetchInterval: 3000,
  });

  const matchIds = (matches || []).map(m => m.id);
  useCallSignaling(matchIds, userId);

  const rerMatch = matches?.find(m =>
    !!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted && m.callInitiatorId === userId)
  );
  const rerMatchId = rerMatch?.id;
  const rerSessionId = rerMatch?.callSessionId;
  useEffect(() => {
    if (!rerMatchId || !rerSessionId) return;
    const send = () => {
      apiRequest("POST", `/api/matches/${rerMatchId}/call/rering`)
        .then(() => console.log("[CALL_UI] RERING_SENT", { matchId: rerMatchId, callSessionId: rerSessionId }))
        .catch(() => console.warn("[CALL_UI] RERING_FAILED", { matchId: rerMatchId }));
    };
    const interval = setInterval(send, 5000);
    return () => clearInterval(interval);
  }, [rerMatchId, rerSessionId]);

  const markCallEnded = useCallback((matchId: string, callSessionId?: string | null, reason?: string) => {
    console.log("[CALL_SESSION] CALL_SESSION_CLEANUP_REASON", { matchId, callSessionId, reason: reason || "signal_or_hangup" });
    endedMatchIdsRef.current.add(matchId);
    setEndedTick(t => t + 1);
    clearCallFromCache(qc, matchId, callSessionId);
  }, [qc]);

  useEffect(() => {
    if (!matches) return;
    for (const mid of endedMatchIdsRef.current) {
      const m = matches.find(x => x.id === mid);
      if (m && !m.callStartedAt && !m.callInitiatorId && !m.callAnswered && !m.callSessionId) {
        endedMatchIdsRef.current.delete(mid);
        clearCancelledSession(mid);
        clearDedupeForMatch(mid);
        console.log("[CALL_SESSION] CALL_SUBSCRIPTION_REMOVED", { matchId: mid, reason: "server_confirmed_cleared" });
      }
    }
  }, [matches]);

  useEffect(() => {
    setCallEndedHandler((matchId: string, callSessionId?: string | null) => {
      markCallEnded(matchId, callSessionId, "realtime_end_signal");
    });
    return () => setCallEndedHandler(null);
  }, [markCallEnded]);

  const isEndedCall = useCallback((m: MatchWithProfile) => {
    return endedMatchIdsRef.current.has(m.id);
  }, [endedTick]);

  const STALE_RINGING_MS = 120_000;
  const STALE_ANSWERED_MS = 5 * 60_000;

  function isStaleCall(m: MatchWithProfile): boolean {
    if (!m.callStartedAt) return false;
    const age = Date.now() - new Date(m.callStartedAt).getTime();
    if (!m.callAnswered && age > STALE_RINGING_MS) {
      console.log("[CALL_SESSION] STALE_SESSION_CHECK", { matchId: m.id, callSessionId: m.callSessionId, ageMs: age, answered: false, verdict: "stale_ringing" });
      return true;
    }
    if (m.callAnswered && age > STALE_ANSWERED_MS) {
      console.log("[CALL_SESSION] STALE_SESSION_CHECK", { matchId: m.id, callSessionId: m.callSessionId, ageMs: age, answered: true, verdict: "stale_answered" });
      return true;
    }
    return false;
  }

  const incomingCall = matches?.find(m => {
    if (!m.callStartedAt || m.callAnswered || m.callCompleted) return false;
    if (!m.callSessionId) return false;
    if (!m.callInitiatorId || m.callInitiatorId === userId) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "incoming_check" });
      return false;
    }
    const callKey = `${m.id}:${m.callSessionId}`;
    return callKey !== dismissedCallKey;
  });

  const answeredCall = matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "answered_check" });
      return false;
    }
    return true;
  });

  const callerRingingCall = matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted &&
      m.callInitiatorId === userId)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "caller_ringing_check" });
      return false;
    }
    return true;
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
      const isAnswered = activeCall!.callAnswered;
      console.log("[CALL_SESSION] CALL_SESSION_ACTIVE", {
        matchId: activeCall!.id,
        callSessionId: activeCall!.callSessionId,
        role: isCaller ? "CALLER" : "RECEIVER",
        callerId: activeCall!.callInitiatorId,
        userId,
        isRinging: !isAnswered,
        isAnswered,
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
      console.log("[CALL_SESSION] INCOMING_OVERLAY_DISMISSED", { matchId: incomingCall.id, callSessionId: incomingCall.callSessionId, reason: "overlay_dismissed" });
      setDismissedCallKey(`${incomingCall.id}:${incomingCall.callSessionId}`);
    }
  }, [incomingCall]);

  const handleActiveCallEnd = useCallback(() => {
    if (activeCall) {
      const { id: matchId, callSessionId } = activeCall;
      const role = activeCall.callInitiatorId === userId ? "caller" : "receiver";
      console.log("[CALL_UI] CALL_HUNG_UP", { matchId, callSessionId, role, source: "fullscreen_overlay" });
      console.log("[CALL_SESSION] CALL_STAGE_EXITED", { matchId, callSessionId, reason: "user_hangup_overlay" });
      console.log("[CALL_SESSION] CHAT_STATE_PRESERVED", { matchId, callSessionId, note: "overlay ended — chat intact" });
      markCallEnded(matchId, callSessionId, "user_hangup");
    }
  }, [activeCall?.id, activeCall?.callSessionId, activeCall?.callInitiatorId, userId, markCallEnded]);

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

type ProfileCheckResult = { exists: boolean; fetchFailed: boolean };

// Check profile existence via the server's /api/profile endpoint.
// Using the server avoids client-side Supabase auth dependency and keeps
// the single source of truth for profile state on the backend.
async function checkProfileExists(): Promise<ProfileCheckResult> {
  // Separate fetch from response handling so network errors are clearly retryable.
  let res: Response;
  try {
    const authHeaders = await getAuthHeaders();
    res = await fetch("/api/profile", { credentials: "include", headers: authHeaders });
  } catch (err: any) {
    // fetch() itself threw — network unreachable, DNS failure, etc.
    console.error("[AUTH] PROFILE_LOAD_FAILED: network error —", err?.message);
    throw new Error("NETWORK_ERROR");
  }

  if (res.status === 404) {
    // Profile row does not exist → user needs to complete onboarding.
    console.log("[AUTH] PROFILE_EXISTS_CHECK: no profile found (onboarding needed)");
    return { exists: false, fetchFailed: false };
  }

  if (!res.ok) {
    // 401 = JWT invalid/expired, 503 = Supabase DB unreachable during cold-start,
    // anything else = unexpected server error. All are treated as retryable so
    // TanStack Query's retry loop handles transient failures automatically.
    const text = await res.text().catch(() => res.statusText);
    const trimmed = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    console.error(`[AUTH] PROFILE_LOAD_FAILED: HTTP ${res.status} — root cause: ${trimmed}`);
    throw new Error(`HTTP_${res.status}`);
  }

  console.log("[AUTH] PROFILE_EXISTS_CHECK: profile found");
  return { exists: true, fetchFailed: false };
}

function AppContent() {
  const { user, isLoading: authLoading, profileReady } = useAuth();

  // IMPORTANT: This query uses a dedicated key "profile-exists-check" that is intentionally
  // separate from the "/api/profile" key used by ProfilePage for data.
  // Sharing the same key caused cache contamination: ProfilePage's default fetcher would
  // write a real Profile object into the cache, this component would read it as
  // ProfileCheckResult and see exists=undefined (falsy) → routing to onboarding.
  // Never invalidate "profile-exists-check" from within the authenticated app — it only
  // needs to run once on login. Profile edits should invalidate "/api/profile" only.
  const { data, isLoading: profileLoading, isError: profileError } = useQuery<ProfileCheckResult>({
    queryKey: ["profile-exists-check"],
    queryFn: () => {
      if (!user) return Promise.resolve({ exists: false, fetchFailed: false });
      console.log("[ROUTING] Checking profile existence (dedicated key)");
      return checkProfileExists();
    },
    enabled: !!user && profileReady,
    // 5 retries at 5 s each (25 s total) covers the typical Supabase cold-start
    // window where the DB returns 522/503 before becoming available.
    retry: 5,
    retryDelay: 5000,
  });

  const profileExists = data?.exists ?? false;
  // fetchFailed is true only after all 5 retries are exhausted (isError=true).
  // checkProfileExists no longer returns fetchFailed:true — it always throws so
  // TanStack Query's retry loop runs before we give up.
  const fetchFailed = profileError;

  // When all retries are exhausted, auto-retry every 10 s so the user doesn't
  // have to manually click "Try Again" while Supabase is starting up.
  useEffect(() => {
    if (!fetchFailed) return;
    const timer = setTimeout(() => {
      queryClient.resetQueries({ queryKey: ["profile-exists-check"] });
    }, 10_000);
    return () => clearTimeout(timer);
  }, [fetchFailed]);

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

  if (fetchFailed && !profileExists) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center px-6">
          <p className="text-lg font-serif font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground">We couldn't load your profile right now. You're still signed in — this is just a temporary issue.</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["profile-exists-check"] })}
            data-testid="button-retry-profile"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!profileExists) {
    console.log("[ROUTING] Rendering Onboarding — profileExists=false, fetchFailed=", fetchFailed, "profileLoading=", profileLoading);
    return <Onboarding existingProfile={null} userEmail={user?.email ?? ""} />;
  }

  console.log("[ROUTING] Rendering app tabs — profile confirmed to exist");

  return (
    <Switch>
      <Route path="/elevate/success" component={ElevateSuccessPage} />
      <Route path="/extras/success" component={ExtrasSuccessPage} />
      <Route>
        <AppLayout>
          <PersistentTabs />
          <CallDetectors userId={user.id} />
        </AppLayout>
      </Route>
    </Switch>
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
