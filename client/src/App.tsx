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

// Main app pages — static imports so Vercel never needs to serve lazy chunks.
// All pages land in the main bundle; no separate chunk files are requested at runtime.
import Onboarding from "@/pages/onboarding";
import Discover from "@/pages/discover";
import Matches from "@/pages/matches";
import Messaging from "@/pages/messaging";
import ProfilePage from "@/pages/profile";
import IntentPage from "@/pages/intent";
import LikesPage from "@/pages/likes";
import ElevateSuccessPage from "@/pages/elevate-success";
import ExtrasSuccessPage from "@/pages/extras-success";
// Dev-only perf overlay stays lazy — never adds to production bundle.
const PerfOverlayLazy = import.meta.env.DEV
  ? lazy(() => import("@/components/perf-overlay").then(m => ({ default: m.PerfOverlay })))
  : null;
// Call overlays lazy-loaded — only needed when a call is active.
// useCallSignaling still detects calls eagerly; both chunks are preloaded at
// idle so the overlay is ready before any call arrives.
const IncomingCallOverlay = lazy(() => import("@/components/incoming-call"));
const ActiveCallOverlay   = lazy(() =>
  import("@/components/active-call").then(m => ({ default: m.ActiveCallOverlay }))
);

// Eagerly preload both call-overlay chunks so they are already in the browser
// module cache when the first incoming call arrives.
if (typeof window !== "undefined") {
  const preloadCallChunks = () => {
    import("@/components/incoming-call").catch(() => {});
    import("@/components/active-call").catch(() => {});
    console.log("[CALL_DEBUG] PRELOAD: call overlay chunks requested");
  };
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(preloadCallChunks, { timeout: 5000 });
  } else {
    setTimeout(preloadCallChunks, 2000);
  }
}
import { useCallSignaling, setCallEndedHandler, setCallRingHandler, clearDedupeForMatch } from "@/hooks/use-call-signaling";
import { stopAllNonVoiceCallAudio } from "@/lib/call-audio";
import { markCallSessionCancelled, markStartupCancelledSession, isCallSessionCancelled, clearCancelledSession, setOnCancelledSessionChange } from "@/lib/cancelled-calls";
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
                <Component />
              </PageErrorBoundary>
            </TabActiveContext.Provider>
          </div>
        );
      })}
      {isSubRoute && (
        <PageErrorBoundary name="/messages">
          <Switch>
            <Route path="/messages/:matchId" component={Messaging} />
          </Switch>
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



// Captured once at module load. Any call whose callStartedAt predates this
// timestamp is treated as potentially stale and blocked until a live rering
// proves the call is still active.
const APP_LOAD_TIME = Date.now();


function CallDetectors({ userId }: { userId: string }) {
  const [dismissedCallKey, setDismissedCallKey] = useState<string | null>(null);
  // Maps matchId → the callSessionId that ended, so isEndedCall can distinguish
  // "same call still ending" from "new call starting on same match".
  const endedMatchIdsRef = useRef(new Map<string, string | null>());
  const [endedTick, setEndedTick] = useState(0);
  const qc = useQueryClient();

  // ── Startup verification ───────────────────────────────────────────────────
  // On page refresh, cancelledSessions (in-memory) is wiped. The fresh
  // /api/matches fetch can return a match with callStartedAt still set because
  // the server DB was not yet updated when the previous session ended (cancelled
  // call, network drop, caller-side-only cancel, etc.).
  // startupVerified gates IncomingCallOverlay so it never mounts before the
  // first-load staleness sweep has run and cleared any ghost call state.
  const [startupVerified, setStartupVerified] = useState(false);
  const startupDoneRef = useRef(false);

  // ── cancelledTick — React bridge for the cancelled-calls Set ─────────────
  // cancelled-calls.ts holds a plain module-level Set that React cannot observe.
  // Whenever any entry is added or removed (mark/clear/startup), the Set calls
  // setOnCancelledSessionChange (registered below) which increments this counter.
  // All three call-detection memos include cancelledTick in their dep arrays so
  // they re-run immediately when clearStartupCancelledSession() is called on
  // rering receipt — without this, the memos would stay stale (deps unchanged)
  // and incomingCall would remain null even after the startup block is lifted.
  const [cancelledTick, setCancelledTick] = useState(0);
  useEffect(() => {
    setOnCancelledSessionChange(() => setCancelledTick(t => t + 1));
    return () => setOnCancelledSessionChange(null);
  }, []);
  // hasRingRef: true while an incoming ring is active. Used by refetchInterval
  // to pause the 5-second poll so optimistic call state cannot be overwritten
  // by a network response that lags behind the Realtime broadcast.
  const hasRingRef = useRef(false);

  // locallyAnsweredKey: tracks which call session the receiver explicitly pressed
  // Answer on THIS device in THIS browser session.  We use this instead of
  // relying solely on callAnswered (a DB field) to determine when to swap from
  // IncomingCallOverlay to ActiveCallOverlay.
  //
  // Why: callAnswered=true in the DB could be zombie state from a prior session
  // that crashed before completing. Without locallyAnsweredKey, the receiver
  // would land directly in ActiveCallOverlay (one red button) with no way to
  // accept or decline — the original Bug 1.
  //
  // With locallyAnsweredKey: IncomingCallOverlay is shown for any unanswered
  // receiver-role call until the receiver explicitly presses Answer on this device.
  const [locallyAnsweredKey, setLocallyAnsweredKey] = useState<string | null>(null);

  // Immediately silence any ringtone that might have survived (impossible on a
  // cold start, but belt-and-suspenders in case of fast HMR or component re-mount).
  useEffect(() => {
    // Stop both ringtone and ringback — covers refresh-during-call (caller side)
    // as well as the stale-DB incoming call case on the receiver side.
    // Clear all ringtone/ringback audio state at startup — prevents stale audio
    // from a previous session playing on refresh or HMR re-mount.
    stopAllNonVoiceCallAudio("app_startup");
    console.log("[CALL_BOOT] startup ringtone stopped", { userId: userId.slice(0, 8) });
    console.log("[CALL_RESET] app startup: all call audio stopped", { userId: userId.slice(0, 8) });
    console.log("[CALL_STATE_FIX] app startup stop ringtone", { userId: userId.slice(0, 8) });
  }, []);

  // Register ring-state handler: pauses polling while ring is active (Bug 2 fix).
  // Uses a ref so the interval function always reads the current value without
  // needing to be recreated on every render.
  useEffect(() => {
    setCallRingHandler((active: boolean) => {
      hasRingRef.current = active;
      console.log("[CALL_FIX] ring polling gate changed", { active });
    });
    return () => setCallRingHandler(null);
  }, []);

  const { data: matches } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
    // Realtime call signals (useCallSignaling) handle call detection instantly.
    // 5 s poll ensures missed "cancel/end" signals resolve within 5 s instead
    // of the previous 30 s, preventing long "stuck call in progress" states.
    // When a ring is active (hasRingRef=true), polling is paused so the 5 s
    // network response cannot overwrite the optimistic incoming-call patch
    // before the DB write is visible to PostgREST (Realtime broadcast arrives
    // before the DB row is readable). Polling resumes when the call ends.
    refetchInterval: () => hasRingRef.current ? false : 5000,
  });

  // Reference-stable match IDs: only creates a new array when the set of IDs
  // actually changes. Without this, the 5 s refetchInterval produces a new
  // `matches` reference every tick → a new `matchIds` array every tick →
  // useCallSignaling tears down and rebuilds all Supabase channels every 5 s,
  // leaving a brief subscription gap during which a call:ring rering is missed
  // and the incoming-call overlay flickers off momentarily.
  const matchIdsStableRef = useRef<string[]>([]);
  const matchIds = useMemo(() => {
    const newIds = (matches || []).map(m => m.id).sort();
    if (newIds.join(",") !== matchIdsStableRef.current.join(",")) {
      matchIdsStableRef.current = newIds;
    }
    return matchIdsStableRef.current;
  }, [matches]);
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
    // Resume 5 s polling now that the ring/call is over (Bug 2 fix).
    hasRingRef.current = false;
    endedMatchIdsRef.current.set(matchId, callSessionId ?? null);
    setEndedTick(t => t + 1);
    clearCallFromCache(qc, matchId, callSessionId);
  }, [qc]);

  useEffect(() => {
    if (!matches) return;
    for (const [mid] of endedMatchIdsRef.current) {
      const m = matches.find(x => x.id === mid);
      if (m && !m.callStartedAt && !m.callInitiatorId && !m.callAnswered && !m.callSessionId) {
        endedMatchIdsRef.current.delete(mid);
        clearCancelledSession(mid);
        clearDedupeForMatch(mid);
        console.log("[CALL_STATE] stale state cleared", { matchId: mid, reason: "server_confirmed_cleared" });
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

  // ── Startup staleness sweep ───────────────────────────────────────────────
  // Runs on EVERY /api/matches response until the call ends, but only acts on
  // calls whose callStartedAt predates this browser session (< APP_LOAD_TIME).
  //
  // WHY NOT startupDoneRef (run-once)?
  // The first /api/matches response may come from TanStack Query's cache (clean
  // data, because the previous session called clearCallFromCache). The sweep
  // would find nothing and set startupVerified=true. Then the next 5 s network
  // poll returns stale DB data (server DB not yet cleared) — callStartedAt is
  // non-null, the session is not in cancelledSessions, startupVerified is true →
  // IncomingCallOverlay mounts and the ringtone plays for a dead call.
  //
  // FIX: compare callStartedAt against APP_LOAD_TIME (captured at module load).
  // Any pre-load call is marked startup-cancelled-only on EVERY poll until a
  // live rering arrives and calls clearStartupCancelledSession. This is safe
  // because: (a) isCallSessionCancelled short-circuits already-marked sessions,
  // (b) calls that started AFTER APP_LOAD_TIME (callStartedAt >= APP_LOAD_TIME)
  // are never touched — they proceed normally.
  useEffect(() => {
    if (!matches) return;

    let hadStale = false;

    for (const m of matches) {
      if (!m.callStartedAt || !m.callSessionId) continue;
      if (m.callAnswered || m.callCompleted) continue;
      if (!m.callInitiatorId) continue;
      // Already handled (either startup-cancelled or user-cancelled) — skip.
      if (isCallSessionCancelled(m.id, m.callSessionId)) continue;

      // Only block calls that were ringing BEFORE this browser session started.
      const callStartMs = new Date(m.callStartedAt).getTime();
      if (callStartMs >= APP_LOAD_TIME) continue;

      const ageMs = Date.now() - callStartMs;
      const isCallerSide = m.callInitiatorId === userId;

      hadStale = true;
      console.warn("[CALL_RESET] startup sweep — pre-load call blocked until rering confirms live", {
        matchId: m.id,
        callSessionId: m.callSessionId,
        ageMs,
        isCallerSide,
      });
      console.log("[CALL_BOOT] stale call state cleared", {
        matchId: m.id,
        callSessionId: m.callSessionId,
        ageMs,
        note: isCallerSide
          ? "caller-side: cache cleared — ringback resumes after 5 s poll if call still live"
          : "callee-side: blocked until live rering lifts the hold",
      });

      markStartupCancelledSession(m.id, m.callSessionId);
      clearCallFromCache(qc, m.id);
    }

    if (!hadStale && !startupDoneRef.current) {
      console.log("[CALL_STATE_FIX] startup sweep complete — no stale call state found");
    }

    if (!startupDoneRef.current) {
      startupDoneRef.current = true;
      setStartupVerified(true);
    }
  }, [matches, userId, qc]);

  // ── Null-initiator recovery ───────────────────────────────────────────────
  // When the startup sweep clears callInitiatorId to null (or it's missing for
  // any other reason) but callStartedAt is still set, the receiver detection
  // comparison String("").trim() !== meStr evaluates correctly (isReceiver=true)
  // BUT the IncomingCallOverlay/incomingCall memo REQUIRES !!callInitiatorId.
  // This effect detects those matches and fetches fresh data from the API to
  // restore callInitiatorId so ALL detection paths work consistently.
  const recoveryInFlightRef = useRef(new Set<string>());
  useEffect(() => {
    if (!matches) return;
    for (const m of matches) {
      // Match has an active call timestamp but no initiator — needs recovery.
      if (!m.callStartedAt || m.callInitiatorId || m.callCompleted) continue;
      // Avoid duplicate in-flight requests for the same match.
      if (recoveryInFlightRef.current.has(m.id)) continue;
      recoveryInFlightRef.current.add(m.id);
      console.log("[RECV_DETECT] null-initiator recovery fetch", { matchId: m.id });
      apiRequest("GET", `/api/matches/${m.id}`)
        .then(r => r.json())
        .then((fresh: any) => {
          recoveryInFlightRef.current.delete(m.id);
          if (!fresh?.callInitiatorId) {
            console.log("[RECV_DETECT] recovery fetch: still no callInitiatorId", { matchId: m.id, fresh });
            return;
          }
          console.log("[RECV_DETECT] recovery fetch: restoring callInitiatorId", {
            matchId: m.id,
            callInitiatorId: fresh.callInitiatorId,
            callStartedAt: fresh.callStartedAt,
          });
          qc.setQueriesData<any[]>({ queryKey: ["/api/matches"] }, old => {
            if (!old || !Array.isArray(old)) return old;
            return old.map(om => om.id === m.id
              ? {
                  ...om,
                  callInitiatorId: fresh.callInitiatorId,
                  callStartedAt: om.callStartedAt || fresh.callStartedAt,
                  callSessionId: om.callSessionId || fresh.callSessionId,
                }
              : om);
          });
        })
        .catch((err: unknown) => {
          recoveryInFlightRef.current.delete(m.id);
          console.warn("[RECV_DETECT] recovery fetch failed", { matchId: m.id, err });
        });
    }
  }, [matches, qc]);

  const isEndedCall = useCallback((m: MatchWithProfile) => {
    if (!endedMatchIdsRef.current.has(m.id)) return false;
    const endedSessionId = endedMatchIdsRef.current.get(m.id);
    // If the match now shows a DIFFERENT non-null callSessionId, a brand-new call
    // has started on this match. Lift the ended-block immediately so the new call
    // can proceed — without this, the new call's answeredCall/callerRingingCall
    // would be permanently blocked ("stuck call in progress" bug).
    if (endedSessionId && m.callSessionId && m.callSessionId !== endedSessionId) {
      console.log("[CALL_STATE] stale state cleared", {
        matchId: m.id,
        reason: "new_session_started",
        endedSessionId,
        newSessionId: m.callSessionId,
      });
      endedMatchIdsRef.current.delete(m.id);
      return false;
    }
    return true;
  }, [endedTick]);

  // 90 s: callers typically wait 45–60 s before cancelling. The previous 30 s
  // threshold caused the incoming-call overlay to vanish mid-ring because
  // isStaleCall fired on the 5 s poll, incomingCall became undefined, and the
  // overlay unmounted — resetting ringEnabled and re-triggering the ringtone.
  const STALE_RINGING_MS = 90_000;
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

  // Self-call guard: returns true if a match's call would connect a user to themselves.
  // This is impossible with valid DB data (user1Id !== user2Id) but is checked at the
  // UI layer as belt-and-suspenders protection against corrupted cache or testing artefacts.
  const isSelfCall = (m: MatchWithProfile): boolean => {
    const callerId = m.callInitiatorId;
    if (!callerId) return false;
    const calleeId = m.user1Id === callerId ? m.user2Id : m.user1Id;
    if (callerId === calleeId) {
      console.error("[CALL_ID_AUDIT] blocked self-call — callerId equals calleeId, suppressing overlay", {
        callerId: callerId.slice(0, 8),
        calleeId: calleeId?.slice(0, 8) ?? "none",
        matchId: m.id,
      });
      return true;
    }
    return false;
  };

  const incomingCall = useMemo(() => matches?.find(m => {
    if (!m.callStartedAt || m.callAnswered || m.callCompleted) return false;
    if (!m.callSessionId) return false;
    if (!m.callInitiatorId || m.callInitiatorId === userId) return false;
    // ── Bug 2 fix (part A): block calls that started before this page load.
    // The rering mechanism in use-call-signaling will call clearStartupCancelledSession
    // once a live rering arrives, which increments cancelledTick and re-runs this memo.
    // Without callStartedAt >= APP_LOAD_TIME the memo would pass stale DB data through
    // before the startup sweep (a useEffect) has a chance to mark it as cancelled.
    if (new Date(m.callStartedAt).getTime() < APP_LOAD_TIME) {
      if (!isCallSessionCancelled(m.id, m.callSessionId)) return false;
      return false; // always false for pre-load calls until rering re-stamps callStartedAt
    }
    if (isSelfCall(m)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    // ── Bug 2 fix (part B): cancelledTick in deps ensures this memo re-runs
    // whenever clearStartupCancelledSession() lifts the startup block.
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "incoming_check" });
      return false;
    }
    const callKey = `${m.id}:${m.callSessionId}`;
    return callKey !== dismissedCallKey;
  }), [matches, userId, isEndedCall, dismissedCallKey, cancelledTick]);

  const answeredCall = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    if (isSelfCall(m)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "answered_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall, cancelledTick]);

  const callerRingingCall = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted &&
      m.callInitiatorId === userId)) return false;
    // ── Bug 1 fix: block stale pre-load calls SYNCHRONOUSLY during render.
    // The startup sweep (useEffect) runs AFTER render, so without this check
    // callerRingingCall would briefly return the stale match, ActiveCallOverlay
    // would mount, and useCallRingtone("outgoing", true) would fire — causing
    // the laptop to play the ringback tone on app open before the effect runs.
    if (new Date(m.callStartedAt).getTime() < APP_LOAD_TIME) return false;
    if (isSelfCall(m)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "caller_ringing_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall, cancelledTick]);

  const activeCall = answeredCall || callerRingingCall;

  // ── [CALL_ROLE] Role detection log ─────────────────────────────────────────
  // Fires whenever role-relevant state changes so call logs can confirm which
  // overlay will mount and why.  Kept in a ref-guarded effect so it only logs
  // on real changes, not every render.
  const prevRoleKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!matches?.length) return;
    const ringingMatch = incomingCall || callerRingingCall;
    if (!ringingMatch) return;
    const roleKey = `${ringingMatch.id}:${ringingMatch.callSessionId}:${userId}`;
    if (roleKey === prevRoleKeyRef.current) return;
    prevRoleKeyRef.current = roleKey;
    const isCallerComputed = ringingMatch.callInitiatorId === userId;
    const isReceiverComputed = !isCallerComputed;
    console.log("[CALL_ROLE] currentUserId", userId?.slice(0, 8) ?? "undefined");
    console.log("[CALL_ROLE] callInitiatorId", ringingMatch.callInitiatorId?.slice(0, 8) ?? "undefined");
    console.log("[CALL_ROLE] isCaller", isCallerComputed);
    console.log("[CALL_ROLE] isReceiver", isReceiverComputed);
    console.log("[CALL_ROLE] incomingCallSet", !!incomingCall);
    console.log("[CALL_ROLE] activeCallSet", !!activeCall);
    console.log("[CALL_ROLE] overlayWillShow", incomingCall
      ? "IncomingCallOverlay (decline+answer)"
      : activeCall
        ? `ActiveCallOverlay isCaller=${isCallerComputed} isRinging=${!activeCall.callAnswered}`
        : "none");
  }, [incomingCall?.id, callerRingingCall?.id, activeCall?.id, userId]);

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
      const callerId = activeCall!.callInitiatorId;
      const calleeId = activeCall!.user1Id === callerId
        ? activeCall!.user2Id
        : activeCall!.user1Id;

      console.log("[CALL_ID_AUDIT] currentUserId callerId calleeId", {
        currentUserId: userId.slice(0, 8),
        callerId: callerId?.slice(0, 8) ?? "none",
        calleeId: calleeId?.slice(0, 8) ?? "none",
        matchId: activeCall!.id,
        role: isCaller ? "CALLER" : "RECEIVER",
      });

      if (callerId && callerId === calleeId) {
        console.error("[CALL_ID_AUDIT] blocked self-call — callerId equals calleeId!", {
          callerId: callerId.slice(0, 8),
          matchId: activeCall!.id,
        });
      }

      console.log("[CALL_SESSION] CALL_SESSION_ACTIVE", {
        matchId: activeCall!.id,
        callSessionId: activeCall!.callSessionId,
        role: isCaller ? "CALLER" : "RECEIVER",
        callerId: callerId,
        userId,
        isRinging: !isAnswered,
        isAnswered,
        SESSION_PARTICIPANTS_COUNT: 2,
      });
    }
    prevActiveRef.current = activeKey;
  }, [activeCall?.id, activeCall?.callSessionId, userId]);

  // ── incomingMatchForUI ────────────────────────────────────────────────────
  // The match the receiver needs to answer.  Two sources:
  //   1. incomingCall — the normal path (callInitiatorId !== userId, callAnswered=false)
  //   2. Fallback: activeCall when the current user is NOT the initiator and
  //      the call is not yet answered.  This covers the race condition where
  //      callAnswered prematurely becomes truthy in the cache (or a stale
  //      callerRingingCall on a different match drives activeCall non-null),
  //      which would normally suppress incomingCall and leave the receiver
  //      stranded in ActiveCallOverlay with only the single red "End call" button.
  //
  //      isReceiver = callInitiatorId !== userId  (simple, unambiguous)
  //
  const receiverActiveCall = activeCall &&
    activeCall.callInitiatorId !== userId &&
    !activeCall.callAnswered
    ? activeCall : null;

  const incomingMatchForUI = incomingCall ?? receiverActiveCall ?? null;

  // matchForIncoming: definitive match to render in IncomingCallOverlay.
  //
  // Rule: show IncomingCallOverlay (green+red) whenever:
  //   1. The current user is the receiver (callInitiatorId !== userId), AND
  //   2. They have NOT pressed Answer on THIS device in THIS session
  //      (locallyAnsweredKey !== matchId:sessionId)
  //
  // This replaces the old callAnswered !== true check, which failed for zombie
  // calls where the DB had callAnswered=true but the receiver never actually
  // answered on this device — they would fall through to ActiveCallOverlay
  // (one red button only, the original Bug 1).
  //
  // When the receiver presses Answer, IncomingCallOverlay calls onAnswer() which
  // sets locallyAnsweredKey = "matchId:sessionId". On the next render:
  //   - matchForIncoming becomes null (locallyAnsweredKey matches) → overlay unmounts
  //   - answeredCall becomes non-null (callAnswered=true in cache) → activeCall is set
  //   - ActiveCallOverlay mounts with webrtcEnabled=true ✓
  const matchForIncoming = (() => {
    if (incomingMatchForUI) return incomingMatchForUI;
    if (!activeCall) return null;
    if (activeCall.callInitiatorId === userId) return null; // caller, not receiver
    const sessionKey = `${activeCall.id}:${activeCall.callSessionId}`;
    if (locallyAnsweredKey === sessionKey) return null; // receiver pressed Answer here
    // Receiver hasn't pressed Answer on this device — show green+red buttons
    return activeCall;
  })();

  // Stage 1 = second call = video (camera + audio, 15 min).
  // Stage 3 = face call = video (requires both-user opt-in).
  // Stage 2 is post-second-call messaging — no calls allowed there.
  const isFaceCall = matchForIncoming
    ? (matchForIncoming.callStage || 0) === 1 ||
      ((matchForIncoming.callStage || 0) === 3 &&
        !!matchForIncoming.faceCallUser1Accepted &&
        !!matchForIncoming.faceCallUser2Accepted)
    : false;

  const isActiveVideo = activeCall
    ? (activeCall.callStage || 0) === 1 ||   // second call is always video
      ((activeCall.callStage || 0) === 3 &&
        !!activeCall.faceCallUser1Accepted &&
        !!activeCall.faceCallUser2Accepted)
    : false;

  const handleDismiss = useCallback(() => {
    const m = matchForIncoming;
    if (m) {
      console.log("[CALL_SESSION] INCOMING_OVERLAY_DISMISSED", { matchId: m.id, callSessionId: m.callSessionId, reason: "overlay_dismissed" });
      setDismissedCallKey(`${m.id}:${m.callSessionId}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchForIncoming?.id, matchForIncoming?.callSessionId]);

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
      {/* ── OVERLAY ROUTING ────────────────────────────────────────────────────
          Priority order (highest first):
            1. FORCED INCOMING: any match in `matches` where the current user is
               the receiver (callInitiatorId !== userId), the call is started
               (callStartedAt exists), not yet answered by receiver, and not
               completed. Scans `matches` RAW — bypasses all timing/stale/cancelled
               guards that can silently drop `incomingCall` to null.
            2. ActiveCallOverlay: answered call or caller-outgoing call (activeCall).
            3. Nothing. */}
      {startupVerified && (() => {
        // ── Priority 1: forced incoming receiver check ──────────────────────
        // Scan matches directly. No APP_LOAD_TIME guard, no cancelledTick guard,
        // no dismissedCallKey. If this user is the receiver and the call is live
        // they must see IncomingCallOverlay regardless of how the derived memos
        // classified the call.
        const forcedIncomingMatch = (matches ?? []).find(m =>
          !!m.callStartedAt &&
          m.callCompleted !== true &&
          m.callInitiatorId !== userId &&   // current user is receiver
          m.callAnswered !== true           // receiver has not answered yet
        ) ?? null;

        const overlayForActive = activeCall ?? null;

        const whichOverlay = forcedIncomingMatch
          ? "IncomingCallOverlay (FORCED)"
          : overlayForActive
            ? "ActiveCallOverlay"
            : "none";

        console.log("[CALL_UI_ROUTING]", {
          whichOverlay,
          forcedIncomingMatchId: forcedIncomingMatch?.id,
          activeCallId: overlayForActive?.id,
          callInitiatorId: (forcedIncomingMatch ?? overlayForActive)?.callInitiatorId,
          userId,
          callAnswered: (forcedIncomingMatch ?? overlayForActive)?.callAnswered,
          callCompleted: (forcedIncomingMatch ?? overlayForActive)?.callCompleted,
        });

        // ── Priority 1: receiver sees IncomingCallOverlay ───────────────────
        if (forcedIncomingMatch) {
          const forcedIsFaceCall =
            (forcedIncomingMatch.callStage || 0) === 1 ||
            ((forcedIncomingMatch.callStage || 0) === 3 &&
              !!forcedIncomingMatch.faceCallUser1Accepted &&
              !!forcedIncomingMatch.faceCallUser2Accepted);

          return (
            <Suspense fallback={null}>
                <CallOverlayErrorBoundary
                  key={`forced-incoming:${forcedIncomingMatch.id}:${forcedIncomingMatch.callSessionId}`}
                  matchId={forcedIncomingMatch.id}
                  callSessionId={forcedIncomingMatch.callSessionId}
                  onError={handleOverlayError}
                >
                  <IncomingCallOverlay
                    match={forcedIncomingMatch}
                    isFaceCall={forcedIsFaceCall}
                    onDismiss={handleDismiss}
                    onAnswer={(matchId, sessionId) => {
                      console.log("[CALLEE_FIX] onAnswer fired (forced path)", { matchId, sessionId });
                      setLocallyAnsweredKey(`${matchId}:${sessionId}`);
                    }}
                  />
                </CallOverlayErrorBoundary>
            </Suspense>
          );
        }

        // ── Priority 2: answered call or caller outgoing call ───────────────
        if (overlayForActive) {
          return (
            <Suspense fallback={null}>
              <CallOverlayErrorBoundary
                matchId={overlayForActive.id}
                callSessionId={overlayForActive.callSessionId}
                onError={handleOverlayError}
              >
                <ActiveCallOverlay
                  matchId={overlayForActive.id}
                  callSessionId={overlayForActive.callSessionId || ""}
                  userId={userId}
                  isCaller={overlayForActive.callInitiatorId === userId}
                  isVideo={isActiveVideo}
                  isRinging={!overlayForActive.callAnswered}
                  callerName={overlayForActive.profile?.name || overlayForActive.profile?.firstName || "Unknown"}
                  callerPhoto={overlayForActive.profile?.photos?.[0] || undefined}
                  callStage={overlayForActive.callStage || 0}
                  onCallEnd={handleActiveCallEnd}
                />
              </CallOverlayErrorBoundary>
            </Suspense>
          );
        }

        return null;
      })()}


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
      <Onboarding existingProfile={null} userEmail={user?.email ?? ""} />
    );
  }

  console.log("[SETUP] FINAL_APP_GATE: render_main_app", {
    userId: user.id, profileExists, fetchFailed, forceProceed,
  });

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
