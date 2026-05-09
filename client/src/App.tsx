import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from "react";
import { queryClient, getAuthHeaders, apiRequest, logLatency, parseServerTiming, PERF_ENABLED, API_BASE, requireApiBase } from "./lib/queryClient";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import AppLayout from "@/components/app-layout";

// Route-level code splitting — each page downloads only when first needed.
// Landing, AppLayout, and the call overlays stay eager (needed on first render).
const PerfOverlayLazy = import.meta.env.DEV
  ? lazy(() => import("@/components/perf-overlay").then(m => ({ default: m.PerfOverlay })))
  : null;
const Onboarding       = lazy(() => import("@/pages/onboarding"));
const Discover         = lazy(() => import("@/pages/discover"));
const Matches          = lazy(() => import("@/pages/matches"));
const Messaging        = lazy(() => import("@/pages/messaging"));
const ProfilePage      = lazy(() => import("@/pages/profile"));
const IntentPage       = lazy(() => import("@/pages/intent"));
const LikesPage        = lazy(() => import("@/pages/likes"));
const ElevateSuccessPage = lazy(() => import("@/pages/elevate-success"));
const ExtrasSuccessPage  = lazy(() => import("@/pages/extras-success"));
// Call overlays lazy-loaded — only needed when a call is active.
// useCallSignaling (below) still detects calls eagerly; the overlay chunk
// loads in the background once the app is idle, well before any call arrives.
const IncomingCallOverlay = lazy(() => import("@/components/incoming-call"));
const ActiveCallOverlay   = lazy(() =>
  import("@/components/active-call").then(m => ({ default: m.ActiveCallOverlay }))
);
import { useCallSignaling, setCallEndedHandler, clearDedupeForMatch } from "@/hooks/use-call-signaling";
import { markCallSessionCancelled, isCallSessionCancelled, clearCancelledSession } from "@/lib/cancelled-calls";
import type { Profile, Match } from "@shared/schema";
import { Loader2 } from "lucide-react";

// ── Global debug store ───────────────────────────────────────────────────────
// Imported from a shared module so landing.tsx and use-auth.ts can also write
// to it without creating circular dependencies.
import { writeDebug, pushDebugError } from "@/lib/debug-store";
import { TabActiveContext } from "@/hooks/use-tab-active";

// ── Per-tab error boundary ────────────────────────────────────────────────────
// Wraps each persistent tab so a crash in one tab does not kill the others.
// Without this, React propagates the error up the tree and ALL tabs go blank.
type EBState = { hasError: boolean; error: Error | null };
class PageErrorBoundary extends Component<{ name: string; children: ReactNode }, EBState> {
  constructor(props: { name: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PAGE_ERROR_BOUNDARY] crash in tab "${this.props.name}":`, error.message, info.componentStack?.slice(0, 300));
    pushDebugError(`tab:${this.props.name} — ${error.message}`);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-serif font-semibold">Something went wrong</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            This page crashed. Your other tabs are still working.
          </p>
          <p className="text-xs text-muted-foreground/60 font-mono">{this.state.error?.message}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Shared fallback for all lazy-loaded pages
function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
}

const TAB_PAGES = [
  { path: "/discover", Component: Discover },
  { path: "/intent", Component: IntentPage },
  { path: "/likes", Component: LikesPage },
  { path: "/matches", Component: Matches },
  { path: "/profile", Component: ProfilePage },
];

function PersistentTabs() {
  const [location] = useLocation();

  const activeTab = location === "/" ? "/discover" : location;
  const isTabRoute = TAB_PAGES.some(t => activeTab.startsWith(t.path));
  const isSubRoute = location.startsWith("/messages/");

  // Navigation trace — logs every time the active tab changes so we can pinpoint
  // which tab is shown and confirm the display switch is happening.
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const current = isSubRoute ? "/messages" : activeTab;
    if (current !== prevActiveRef.current) {
      const navMs = Math.round(performance.now());
      console.log("[PERF] NAV_TAB_CHANGED", {
        from: prevActiveRef.current,
        to: current,
        location,
        isTabRoute,
        isSubRoute,
        navMs,
      });
      prevActiveRef.current = current;
    }
  });

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
              <PageErrorBoundary name={path}>
                <Suspense fallback={<PageLoader />}>
                  <Component />
                </Suspense>
              </PageErrorBoundary>
            </TabActiveContext.Provider>
          </div>
        );
      })}
      {isSubRoute && (
        <PageErrorBoundary name="/messages">
          <Suspense fallback={<PageLoader />}>
            <Switch>
              <Route path="/messages/:matchId" component={Messaging} />
            </Switch>
          </Suspense>
        </PageErrorBoundary>
      )}
      {!isTabRoute && !isSubRoute && location !== "/" && <NotFound />}
    </>
  );
}

type MatchWithProfile = Match & { profile: Profile };

// Error boundary specifically for call overlay components.
// If ActiveCallOverlay or IncomingCallOverlay crash, this catches the error,
// logs it, calls onError() to clean up server/cache state, and renders nothing
// instead of propagating the crash to the app root (which would white-screen).
type CallEBState = { crashed: boolean };
class CallOverlayErrorBoundary extends Component<
  { matchId?: string; callSessionId?: string | null; onError: (matchId?: string, sessionId?: string | null) => void; children: ReactNode },
  CallEBState
> {
  constructor(props: any) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError(): CallEBState {
    return { crashed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[CALL_OVERLAY_BOUNDARY] crash caught — dismissing overlay:", error.message, info.componentStack?.slice(0, 200));
    this.props.onError(this.props.matchId, this.props.callSessionId);
  }
  render() {
    if (this.state.crashed) return null;
    return this.props.children;
  }
}

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
    // Realtime call signals (useCallSignaling) handle call detection instantly.
    // This poll is only a safety net for missed signals — 30s is fine.
    refetchInterval: 30000,
  });

  const matchIds = useMemo(() => (matches || []).map(m => m.id), [matches]);
  useCallSignaling(matchIds, userId);

  const rerMatch = useMemo(() => matches?.find(m =>
    !!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted && m.callInitiatorId === userId)
  ), [matches, userId]);
  const rerMatchId = rerMatch?.id;
  const rerSessionId = rerMatch?.callSessionId;
  useEffect(() => {
    if (!rerMatchId || !rerSessionId) return;
    const send = () => {
      const ts = new Date().toISOString();
      console.log("[CALL_TIMING] RERING_ATTEMPT", { matchId: rerMatchId, callSessionId: rerSessionId, ts });
      apiRequest("POST", `/api/matches/${rerMatchId}/call/rering`)
        .then(() => console.log("[CALL_TIMING] RERING_SENT", { matchId: rerMatchId, callSessionId: rerSessionId, ts: new Date().toISOString() }))
        .catch(() => console.warn("[CALL_UI] RERING_FAILED", { matchId: rerMatchId }));
    };
    send();
    const interval = setInterval(send, 2000);
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

  const incomingCall = useMemo(() => matches?.find(m => {
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
  }), [matches, userId, isEndedCall, dismissedCallKey]);

  const answeredCall = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "answered_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall]);

  const callerRingingCall = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted &&
      m.callInitiatorId === userId)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "caller_ringing_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall]);

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

  // Stage 1 = second call = video (camera + audio, 15 min).
  // Stage 3 = face call = video (requires both-user opt-in).
  // Stage 2 is post-second-call messaging — no calls allowed there.
  const isFaceCall = incomingCall
    ? (incomingCall.callStage || 0) === 1 ||   // second call is always video
      ((incomingCall.callStage || 0) === 3 &&
        !!incomingCall.faceCallUser1Accepted &&
        !!incomingCall.faceCallUser2Accepted)
    : false;

  const isActiveVideo = activeCall
    ? (activeCall.callStage || 0) === 1 ||   // second call is always video
      ((activeCall.callStage || 0) === 3 &&
        !!activeCall.faceCallUser1Accepted &&
        !!activeCall.faceCallUser2Accepted)
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

  const handleOverlayError = useCallback((matchId?: string, sessionId?: string | null) => {
    console.error("[CALL_OVERLAY_BOUNDARY] overlay_crash — clearing call state", { matchId, sessionId });
    if (matchId) {
      markCallEnded(matchId, sessionId, "overlay_crash");
    }
  }, [markCallEnded]);

  return (
    <>
      {incomingCall && !activeCall && (
        <Suspense fallback={null}>
          <CallOverlayErrorBoundary
            matchId={incomingCall.id}
            callSessionId={incomingCall.callSessionId}
            onError={handleOverlayError}
          >
            <IncomingCallOverlay
              match={incomingCall}
              isFaceCall={isFaceCall}
              onDismiss={handleDismiss}
            />
          </CallOverlayErrorBoundary>
        </Suspense>
      )}
      {activeCall && (
        <Suspense fallback={null}>
          <CallOverlayErrorBoundary
            matchId={activeCall.id}
            callSessionId={activeCall.callSessionId}
            onError={handleOverlayError}
          >
          <ActiveCallOverlay
            matchId={activeCall.id}
            callSessionId={activeCall.callSessionId || ""}
            userId={userId}
            isCaller={activeCall.callInitiatorId === userId}
            isVideo={isActiveVideo}
            isRinging={!activeCall.callAnswered}
            callerName={activeCall.profile?.name || activeCall.profile?.firstName || "Unknown"}
            callerPhoto={activeCall.profile?.photos?.[0] || undefined}
            callStage={activeCall.callStage || 0}
            onCallEnd={handleActiveCallEnd}
          />
          </CallOverlayErrorBoundary>
        </Suspense>
      )}
    </>
  );
}

type ProfileCheckResult = { exists: boolean; fetchFailed: boolean };

// Check profile existence via the server's /api/profile endpoint.
// Using the server avoids client-side Supabase auth dependency and keeps
// the single source of truth for profile state on the backend.
async function checkProfileExists(
  userId?: string,
  onProfileData?: (data: unknown) => void,
): Promise<ProfileCheckResult> {
  writeDebug({
    postAuthProfileFetchStarted: true,
    postAuthProfileFetchSucceeded: false,
    profileFetchMethodUsed: "maybeSingle",
    profileQueryUserId: userId ?? null,
    profileRowFound: null,
    profileErrorMessage: null,
  });
  // Separate fetch from response handling so network errors are clearly retryable.
  // 4-second abort — must be shorter than SPINNER_TIMEOUT_MS (12 s) so the
  // request fails cleanly and the query enters error state before the spinner
  // declares a timeout.  The "Try Again" button handles manual retry.
  let res: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.error("[AUTH] PROFILE_LOAD_FAILED: network timeout after 4 s");
  }, 4_000);
  try {
    console.log("[SETUP] PROFILE_FETCH_NETWORK_START", { userId });
    const t0 = performance.now();
    const authHeaders = await getAuthHeaders();
    // Use /api/profile (full profile) — photos are now short Storage URLs (~2–5 kB total)
    // so payload size is negligible. Fetching the full profile here lets us seed the
    // ["/api/profile"] cache on success, so profile.tsx reads from cache on first render
    // instead of issuing a second network request.
    res = await fetch(API_BASE + "/api/profile", {
      credentials: "include",
      headers: authHeaders,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    // TEMP: latency debugging — remove before production release
    if (PERF_ENABLED) {
      logLatency("/api/profile", Math.round(performance.now() - t0), parseServerTiming(res.headers.get("server-timing")), 0);
    }
    console.log("[SETUP] PROFILE_FETCH_NETWORK_DONE", { status: res.status, userId, ms: Math.round(performance.now() - t0) });
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === "AbortError";
    console.error("[AUTH] PROFILE_LOAD_FAILED:", isTimeout ? "timeout" : "network error", "—", err?.message);
    writeDebug({ profileErrorMessage: isTimeout ? "TIMEOUT_6S" : (err?.message ?? "NETWORK_ERROR") });
    throw new Error(isTimeout ? "TIMEOUT" : "NETWORK_ERROR");
  }

  if (res.status === 404) {
    // Profile row does not exist → user needs to complete onboarding.
    console.log("[AUTH] PROFILE_EXISTS_CHECK: no profile found (onboarding needed)");
    writeDebug({ postAuthProfileFetchSucceeded: true, profileRowFound: false });
    return { exists: false, fetchFailed: false };
  }

  if (!res.ok) {
    // 401 = JWT invalid/expired, 503 = Supabase DB unreachable during cold-start,
    // anything else = unexpected server error. All are treated as retryable so
    // TanStack Query's retry loop handles transient failures automatically.
    const text = await res.text().catch(() => res.statusText);
    const trimmed = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    console.error(`[AUTH] PROFILE_LOAD_FAILED: HTTP ${res.status} — root cause: ${trimmed}`);
    writeDebug({ profileErrorMessage: `HTTP_${res.status}: ${trimmed}` });
    throw new Error(`HTTP_${res.status}`);
  }

  // Seed the ["/api/profile"] cache so profile.tsx's useQuery reads from cache
  // immediately instead of issuing a second /api/profile network request.
  // The spinner blocks PersistentTabs from mounting until this completes, so
  // the cache is always warm before ProfilePage's useQuery first runs.
  try {
    const profileData = await res.json();
    queryClient.setQueryData(["/api/profile"], profileData);
  } catch {
    // Body parse failure is non-fatal — profile.tsx will fetch on its own.
  }
  console.log("[AUTH] PROFILE_EXISTS_CHECK: profile found");
  writeDebug({ postAuthProfileFetchSucceeded: true, profileRowFound: true });
  return { exists: true, fetchFailed: false };
}

// How long the loading spinner is allowed to show before we cut it off and
// display a retry/bypass screen.  Must be longer than the network abort inside
// checkProfileExists (4 s) so the fetch has time to fail cleanly before the
// spinner declares a timeout.  Acts only as a last-resort backstop for cases
// where the request stalls without triggering a TCP reset.
const SPINNER_TIMEOUT_MS = 12_000;

function AppContent() {
  const [location] = useLocation();
  const { user, isLoading: authLoading, profileReady, clearingCache, logout } = useAuth();

  // IMPORTANT: This query uses a dedicated key "profile-exists-check" that is intentionally
  // separate from the "/api/profile" key used by ProfilePage for data.
  // Sharing the same key caused cache contamination: ProfilePage's default fetcher would
  // write a real Profile object into the cache, this component would read it as
  // ProfileCheckResult and see exists=undefined (falsy) → routing to onboarding.
  // Never invalidate "profile-exists-check" from within the authenticated app — it only
  // needs to run once on login. Profile edits should invalidate "/api/profile" only.
  //
  // clearingCache blocks the query while queryClient.clear() is pending (the
  // setTimeout in use-auth.ts).  Without this guard the fetch starts, clear()
  // destroys it mid-flight, and isLoading resets to true — causing the spinner
  // to restart from zero every time the user logs in.
  // isPending is true whenever the query has no data yet — including the brief
  // window between the query being enabled and the fetch actually starting.
  // isLoading (isPending && isFetching) would be false on that first render
  // because isFetching hasn't flipped to true yet, causing the app to fall
  // through to `if (!profileExists)` and briefly flash the Onboarding screen.
  const { data, isPending: profilePending, isError: profileError, error: profileFetchError } = useQuery<ProfileCheckResult>({
    queryKey: ["profile-exists-check"],
    queryFn: () => {
      if (!user) return Promise.resolve({ exists: false, fetchFailed: false });
      console.log("[SETUP] PROFILE_FETCH_START", { userId: user.id });
      return checkProfileExists(user.id).then(result => {
        console.log("[SETUP] PROFILE_FETCH_SUCCESS", { userId: user.id, profileExists: result.exists });
        return result;
      });
    },
    enabled: !!user && profileReady && !clearingCache,
    // No auto-retry — the fetch has a 4 s AbortController abort so failures
    // surface quickly.  The "Try Again" button on the error screen handles
    // manual retry.  Auto-retry caused a second 5 s spinner cycle that produced
    // the duplicate "Taking longer than expected" message.
    retry: 0,
    staleTime: Infinity,
  });

  const profileExists = data?.exists ?? false;
  // fetchFailed is true only after all retries are exhausted (isError=true).
  const fetchFailed = profileError;

  // ── Early parallel prefetch ──────────────────────────────────────────────────
  // Fire these queries the instant auth resolves — before PersistentTabs mounts —
  // so every tab's cache is warm on first render.  prefetchQuery is a no-op when
  // staleTime:Infinity data is already present (fires at most once per login).
  // NOTE: /api/profile is intentionally omitted — checkProfileExists() fetches
  // /api/profile and seeds that cache entry, so no second round trip is needed.
  useEffect(() => {
    if (!user || !profileReady || clearingCache) return;
    queryClient.prefetchQuery({ queryKey: ["/api/discover"] });
    queryClient.prefetchQuery({ queryKey: ["/api/matches"] });
    queryClient.prefetchQuery({ queryKey: ["/api/who-liked-you"] });
    queryClient.prefetchQuery({ queryKey: ["/api/spin-requests"] });
    queryClient.prefetchQuery({ queryKey: ["/api/elevate/status"] });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, profileReady, clearingCache]);

  // ── Spinner timeout safeguard ────────────────────────────────────────────────
  // If the spinner has been visible for longer than SPINNER_TIMEOUT_MS, stop it
  // and show an error/retry screen so the user is never trapped indefinitely.
  // This covers the case where the fetch hangs without timing out (e.g. a long
  // network stall that doesn't trigger a TCP reset within the retry window).
  const [spinnerTimedOut, setSpinnerTimedOut] = useState(false);
  // forceProceed=true: user tapped "Continue to App" on a blocked screen.
  // Backed by sessionStorage so it survives AppContent remounts (which reset
  // plain useState to false) and auth-event cycles triggered by Supabase when
  // the DB is down.  Cleared on logout so each new login starts clean.
  const [forceProceed, setForceProceedState] = useState(
    () => sessionStorage.getItem("lulou-bypass") === "1"
  );
  const setForceProceed = (v: boolean) => {
    if (v) sessionStorage.setItem("lulou-bypass", "1");
    else sessionStorage.removeItem("lulou-bypass");
    setForceProceedState(v);
  };
  const spinnerStartRef = useRef<number | null>(null);

  // effectiveProfileExists: either confirmed by the server, or the user
  // chose to bypass a failed/stuck profile fetch via "Continue to App".
  // Declared after forceProceed useState to avoid TDZ reference error.
  const effectiveProfileExists = profileExists || forceProceed;

  // profilePending = query has no data yet (covers the gap between "enabled"
  // and "fetch started" that caused isLoading to briefly be false).
  // forceProceed collapses the spinner immediately when the user bypasses.
  const isSpinning = !forceProceed && !authLoading && !!user && (clearingCache || profilePending || !profileReady);

  useEffect(() => {
    if (!isSpinning) {
      if (spinnerStartRef.current !== null) {
        console.log("[SETUP] SPINNER_STOP", {
          userId: user?.id,
          elapsedMs: Date.now() - spinnerStartRef.current,
          clearingCache,
          profilePending,
          profileReady,
        });
      }
      spinnerStartRef.current = null;
      setSpinnerTimedOut(false);
      return;
    }

    // Spinner just turned on — start the clock.
    if (spinnerStartRef.current === null) {
      spinnerStartRef.current = Date.now();
      console.log("[SETUP] SPINNER_START", {
        userId: user?.id,
        clearingCache,
        profilePending,
        profileReady,
      });
    }

    const timer = setTimeout(() => {
      const elapsed = Date.now() - (spinnerStartRef.current ?? 0);
      const reason = clearingCache
        ? "cache_still_clearing"
        : !profileReady
          ? "auth_not_ready"
          : "profile_fetch_pending";
      console.error("[SETUP] SPINNER_TIMEOUT", {
        userId: user?.id,
        elapsedMs: elapsed,
        reason,
        clearingCache,
        profilePending,
        profileReady,
      });
      setSpinnerTimedOut(true);
    }, SPINNER_TIMEOUT_MS);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpinning]);

  // ── Fetch failure log ────────────────────────────────────────────────────────
  // Log when all TanStack Query retries are exhausted.  No auto-retry loop here
  // because it creates an infinite spinner cycle: after 12 s of retries the
  // spinner stops (isError=true → isPending=false), which cancels the 15 s
  // timeout timer before it can set spinnerTimedOut=true, so the circuit
  // breaker never engages and the loop repeats forever.
  // The "Try Again" button on the error screen lets the user retry manually.
  useEffect(() => {
    if (!fetchFailed) return;
    console.error("[SETUP] FETCH_FAILED: all retries exhausted — showing error screen", {
      userId: user?.id,
    });
  }, [fetchFailed, user?.id]);

  // ── Pre-gate: compute phase/decision and write to debug store ────────────
  // This runs on EVERY render before any early return so the DebugOverlay
  // always shows the current live state, regardless of which screen is shown.
  const phaseLabel = authLoading
    ? "auth loading…"
    : !user
    ? "no session"
    : clearingCache
    ? "switching accounts…"
    : !profileReady
    ? "verifying session…"
    : profilePending
    ? "loading profile…"
    : profileError
    ? `error: ${(profileFetchError as Error | null)?.message ?? "unknown"}`
    : "ready";

  const finalGateDecision = authLoading
    ? "blocked_auth_loading"
    : !user
      ? "blocked_missing_session"
      : forceProceed
        ? "render_main_app (force_proceed)"
        : isSpinning
          ? (spinnerTimedOut ? "blocked_spinner_timeout" : "blocked_spinner_running")
          : (fetchFailed && !effectiveProfileExists)
            ? "blocked_profile_gate"
            : !effectiveProfileExists
              ? "blocked_onboarding_guard"
              : "render_main_app";

  writeDebug({
    userId: user?.id ?? null,
    authReady: !authLoading,
    sessionExists: !!user,
    profileExists,
    effectiveProfileExists,
    fetchFailed,
    spinnerTimedOut,
    forceProceed,
    onboardingComplete: profileExists,
    route: location,
    finalGateDecision,
    phase: phaseLabel,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
          <p className="text-xs text-muted-foreground font-mono">FINAL_APP_GATE: blocked_auth_loading</p>
        </div>
      </div>
    );
  }

  if (!user) {
    console.log("[SETUP] FINAL_APP_GATE: no_user — showing landing");
    return <Landing />;
  }

  // ── EARLY BYPASS EXIT ─────────────────────────────────────────────────────
  // forceProceed=true means the user explicitly tapped "Continue to App" on a
  // blocked screen.  This guard is placed BEFORE every other intermediate gate
  // (spinner, fetchFailed, onboarding) so that no TanStack Query state flip,
  // retry cycle, or effect batching can prevent the main app from rendering.
  // Auth is already confirmed above (user is non-null, authLoading=false).
  if (forceProceed) {
    console.warn("[SETUP] FINAL_APP_GATE: render_main_app (force_proceed_early_exit)", {
      userId: user.id,
      profileExists,
      fetchFailed,
      isSpinning,
      spinnerTimedOut,
      profilePending,
      clearingCache,
      profileReady,
      sessionStorage: sessionStorage.getItem("lulou-bypass"),
    });
    return (
      <>
        <div
          data-testid="bypass-banner"
          style={{
            position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
            background: "#fef3c7", borderBottom: "1px solid #f59e0b",
            padding: "4px 12px", fontSize: 11, fontFamily: "monospace",
            display: "flex", gap: 8, alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 700 }}>BYPASS ACTIVE</span>
          <span>user:{user.id.slice(0,8)}</span>
          <span>profile:{String(profileExists)}</span>
          <span>fetchFailed:{String(fetchFailed)}</span>
          <span>storage:{sessionStorage.getItem("lulou-bypass") ?? "null"}</span>
          <button
            style={{ marginLeft: "auto", fontSize: 11, cursor: "pointer" }}
            onClick={() => setForceProceed(false)}
          >
            clear bypass
          </button>
        </div>
        <div style={{ paddingTop: 24 }}>
          <Suspense fallback={<PageLoader />}>
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
          </Suspense>
        </div>
      </>
    );
  }

  const statusPanel = (
    <div className="w-full max-w-xs text-left bg-muted/40 border border-muted rounded-md p-3 space-y-1 text-xs text-muted-foreground font-mono mt-2">
      <p data-testid="debug-user">user: {user.id.slice(0, 8)}…</p>
      <p data-testid="debug-auth">authReady: {authLoading ? "no" : "yes"}</p>
      <p data-testid="debug-session">sessionExists: {user ? "yes" : "no"}</p>
      <p data-testid="debug-profile-exists">profileExists: {String(profileExists)}</p>
      <p data-testid="debug-effective">effectiveProfileExists: {String(effectiveProfileExists)}</p>
      <p data-testid="debug-fetch-failed">fetchFailed: {String(fetchFailed)}</p>
      <p data-testid="debug-spinner-timed-out">spinnerTimedOut: {String(spinnerTimedOut)}</p>
      <p data-testid="debug-force-proceed">forceProceed: {String(forceProceed)}</p>
      <p data-testid="debug-onboarding-complete">onboardingComplete: {String(profileExists)}</p>
      <p data-testid="debug-route">route: {location}</p>
      <p data-testid="debug-final-gate">finalGateDecision: {finalGateDecision}</p>
      <p data-testid="debug-phase">phase: {phaseLabel}</p>
      <p data-testid="debug-storage">storage[lulou-bypass]: {sessionStorage.getItem("lulou-bypass") ?? "null"}</p>
    </div>
  );

  if (isSpinning) {
    if (spinnerTimedOut) {
      // The spinner ran past SPINNER_TIMEOUT_MS — abort and show retry screen.
      console.warn("[SETUP] FINAL_APP_GATE: blocked_by_loading_state (spinner_timeout)", {
        userId: user.id, clearingCache, profilePending, profileReady, spinnerTimedOut,
      });
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4 text-center px-6 max-w-sm w-full">
            <p className="text-lg font-serif font-semibold">Taking longer than expected</p>
            <p className="text-sm text-muted-foreground">We couldn't finish loading your profile. You're still signed in — this is usually a temporary server issue.</p>
            {statusPanel}
            <div className="flex flex-wrap justify-center gap-3 pt-1">
              <button
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
                onClick={() => {
                  setSpinnerTimedOut(false);
                  spinnerStartRef.current = null;
                  queryClient.resetQueries({ queryKey: ["profile-exists-check"] });
                }}
                data-testid="button-retry-setup"
              >
                Try Again
              </button>
              <button
                className="px-4 py-2 rounded-md bg-primary/80 text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
                onClick={() => {
                  console.warn("[SETUP] FORCE_PROCEED: user bypassed timeout screen", { userId: user?.id });
                  setForceProceed(true);
                }}
                data-testid="button-continue-app-timeout"
              >
                Continue to App
              </button>
              <button
                className="px-4 py-2 rounded-md border text-sm font-medium hover:bg-muted transition-all"
                onClick={logout}
                data-testid="button-signout-setup"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      );
    }
    const spinnerMsg = clearingCache
      ? "Switching accounts…"
      : !profileReady
      ? "Verifying session…"
      : "Loading your profile…";
    console.log("[SETUP] FINAL_APP_GATE: blocked_by_loading_state (spinner_running)", {
      userId: user.id, clearingCache, profilePending, profileReady,
    });
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground" data-testid="text-spinner-phase">{spinnerMsg}</p>
        </div>
      </div>
    );
  }

  if (fetchFailed && !effectiveProfileExists) {
    console.warn("[SETUP] FINAL_APP_GATE: blocked_by_profile_gate", {
      userId: user.id, fetchFailed, profileExists, effectiveProfileExists, forceProceed,
    });
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center px-6 max-w-sm w-full">
          <p className="text-lg font-serif font-semibold">Couldn't load your profile</p>
          <p className="text-sm text-muted-foreground">Your account is fine — the server returned an error when fetching your profile. This is temporary.</p>
          {statusPanel}
          <div className="flex flex-wrap justify-center gap-3 pt-1">
            <button
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["profile-exists-check"] })}
              data-testid="button-retry-profile"
            >
              Try Again
            </button>
            <button
              className="px-4 py-2 rounded-md bg-primary/80 text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
              onClick={() => {
                console.warn("[SETUP] FORCE_PROCEED: user bypassed profile-fetch-failed screen", { userId: user?.id });
                setForceProceed(true);
              }}
              data-testid="button-continue-app-error"
            >
              Continue to App
            </button>
            <button
              className="px-4 py-2 rounded-md border text-sm font-medium hover:bg-muted transition-all"
              onClick={logout}
              data-testid="button-signout-profile"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!effectiveProfileExists) {
    console.log("[SETUP] FINAL_APP_GATE: blocked_by_onboarding_guard", {
      userId: user.id, profileExists, effectiveProfileExists, fetchFailed, profilePending,
    });
    return (
      <Suspense fallback={<PageLoader />}>
        <Onboarding existingProfile={null} userEmail={user?.email ?? ""} />
      </Suspense>
    );
  }

  console.log("[SETUP] FINAL_APP_GATE: render_main_app", {
    userId: user.id, profileExists, fetchFailed, forceProceed,
  });

  return (
    <Suspense fallback={<PageLoader />}>
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
    </Suspense>
  );
}

// Module-level startup mark — records the moment this bundle starts executing.
const _appStartMs = performance.now();
console.log("[PERF] APP_BUNDLE_EXECUTED", { ms: Math.round(_appStartMs) });

function App() {
  useEffect(() => {
    // First-paint timing — this fires after React mounts the root for the first time.
    const mountMs = Math.round(performance.now());
    console.log("[PERF] APP_FIRST_MOUNT", { mountMs, sinceStartMs: Math.round(performance.now() - _appStartMs) });

    const onError = (e: ErrorEvent) => {
      pushDebugError(`onerror: ${e.message} (${e.filename?.split("/").pop() ?? "?"}:${e.lineno})`);
    };
    const onUnhandled = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
      pushDebugError(`unhandled: ${msg}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
        {import.meta.env.DEV && PerfOverlayLazy && (
          <Suspense fallback={null}>
            <PerfOverlayLazy />
          </Suspense>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
