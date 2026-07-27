import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense, Component, type ReactNode, type ErrorInfo } from "react";
import { queryClient, getAuthHeaders, apiRequest, logLatency, parseServerTiming, PERF_ENABLED, API_BASE, IS_CROSS_ORIGIN_DEPLOY, refreshAuthToken, requireApiBase } from "./lib/queryClient";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { PurchaseDebugPanel } from "@/components/purchase-debug-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth, AuthProvider } from "@/hooks/use-auth";
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
import SettingsPage from "@/pages/settings";
import IntentPage from "@/pages/intent";
import LikesPage from "@/pages/likes";
import ElevateSuccessPage from "@/pages/elevate-success";
import ExtrasSuccessPage from "@/pages/extras-success";
import DragTestPage from "@/pages/drag-test";
import AdminDiagnosticsPage from "@/pages/admin-diagnostics";
import AdminPaymentSimPage from "@/pages/admin-payment-sim";
import AuthCallbackPage from "@/pages/auth-callback";
import DatePlanPage from "@/pages/date-plan";
import ConnectionDnaPage from "@/pages/connection-dna";
import {
  PrivacyPolicyPage,
  TermsOfServicePage,
  CommunityGuidelinesPage,
  SafeDatingPage,
  DataDeletionPage,
  CookiePolicyPage,
  BillingTermsPage,
} from "@/pages/legal";
import { CallDiagnosticsButton } from "@/components/call-diagnostics-button";
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
import { stopAllNonVoiceCallAudio, stopAllCallSounds, registerCallAudioUnlock, unregisterCallAudioUnlock } from "@/lib/call-audio";
import { isArmedSession, armCallSession, disarmCallSession, clearAllArmedSessions, setOnArmChange, isPaidCallSession, isVideoCallSession, armSessionFromPush, isPushArmedSession } from "@/lib/live-call-sessions";
import { markStartupSweepComplete, resetStartupSweep } from "@/lib/startup-sweep";
import { markCallSessionCancelled, markStartupCancelledSession, isCallSessionCancelled, clearCancelledSession, setOnCancelledSessionChange } from "@/lib/cancelled-calls";
import type { Profile, Match } from "@shared/schema";
import { Loader2, Mail, CheckCircle, AlertCircle } from "lucide-react";
import { supabase, supabaseConfigError } from "@/lib/supabase";
import { sendVerificationResend } from "@/lib/auth-helpers";

// ── Global debug store ───────────────────────────────────────────────────────
// Imported from a shared module so landing.tsx and use-auth.ts can also write
// to it without creating circular dependencies.
import { writeDebug, pushDebugError } from "@/lib/debug-store";

// ── Hard startup audio guard ──────────────────────────────────────────────────
// Runs synchronously at module load — before React, before Supabase auth
// resolves, before any component mounts.  Resets the module-level
// _ringtoneActive/_ringbackActive flags so that even if they were left true
// by a previous session crash, no overlay can accidentally start audio.
// Log "[STARTUP_AUDIO] stopped before auth" confirms this guard ran.
if (typeof window !== "undefined") {
  stopAllCallSounds("startup_module_load");
  console.log("[STARTUP_AUDIO] stopped before auth");
}
import { TabActiveContext } from "@/hooks/use-tab-active";
import { LanguageProvider, useLanguageContext } from "@/contexts/language-context";
import { UnitsProvider } from "@/contexts/units-context";

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

// ── Root error boundary ───────────────────────────────────────────────────────
// Catches any React render error that makes it past the per-tab PageErrorBoundary.
// Without this, React 18 in production silently unmounts the entire root → blank.
type RootEBState = { hasError: boolean; error: Error | null };
class AppRootErrorBoundary extends Component<{ children: ReactNode }, RootEBState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): RootEBState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ROOT_ERROR_BOUNDARY] Unhandled render error:", error.message, info.componentStack?.slice(0, 500));
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f5", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
              <svg width="24" height="24" fill="none" stroke="#dc2626" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h1 style={{ fontSize: 18, fontWeight: 600, color: "#1a1a1a", margin: "0 0 12px" }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6, margin: "0 0 8px" }}>
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <p style={{ fontSize: 12, color: "#888", margin: "0 0 20px" }}>
              Open DevTools (F12) → Console for details.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: "10px 24px", borderRadius: 8, background: "#be4b61", color: "white", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 500 }}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Supabase config error screen ──────────────────────────────────────────────
// Shown when VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing.
// Uses inline styles (not Tailwind) so it renders even when CSS vars are absent.
function SupabaseConfigErrorScreen({ message }: { message: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#faf8f5", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 520, width: "100%", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="24" height="24" fill="none" stroke="#dc2626" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: "0 0 12px" }}>Lulou — Configuration Error</h1>
        <p style={{ fontSize: 14, color: "#555", lineHeight: 1.7, margin: "0 0 20px" }}>{message}</p>
        <div style={{ background: "#f3f4f6", borderRadius: 8, padding: "12px 16px", textAlign: "left", fontSize: 13, color: "#374151", lineHeight: 1.7 }}>
          <strong>Fix:</strong> Go to your Vercel project → Settings → Environment Variables and add:<br />
          <code style={{ background: "#e5e7eb", borderRadius: 4, padding: "1px 6px" }}>VITE_SUPABASE_URL</code><br />
          <code style={{ background: "#e5e7eb", borderRadius: 4, padding: "1px 6px" }}>VITE_SUPABASE_ANON_KEY</code><br />
          <code style={{ background: "#e5e7eb", borderRadius: 4, padding: "1px 6px" }}>VITE_API_BASE_URL</code> (Replit backend URL)<br />
          Then redeploy.
        </div>
      </div>
    </div>
  );
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
  const isSubRoute = location.startsWith("/messages/") || location.startsWith("/date-plan/");
  const isSettingsRoute = location === "/settings";

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
      {isSettingsRoute && (
        <PageErrorBoundary name="/settings">
          <SettingsPage />
        </PageErrorBoundary>
      )}
      {isSubRoute && (
        <PageErrorBoundary name="/messages">
          <Switch>
            <Route path="/messages/:matchId" component={Messaging} />
            <Route path="/date-plan/:matchId" component={DatePlanPage} />
          </Switch>
        </PageErrorBoundary>
      )}
      {!isTabRoute && !isSubRoute && !isSettingsRoute && location !== "/" && <NotFound />}
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
  qc.setQueriesData<any>({ queryKey: ["/api/matches", matchId] }, (old: any) => {
    if (!old || Array.isArray(old)) return old;
    return { ...old, ...cleared };
  });
}



// Captured once at module load. Any call whose callStartedAt predates this
// timestamp is treated as potentially stale and blocked until a live rering
// proves the call is still active.
import { APP_LOAD_TIME } from "@/lib/app-load-time";


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

  // ── Push-notification incoming-call arm ────────────────────────────────────
  // When the user opens the app by tapping an incoming-call push notification,
  // the service worker navigates to /messages/${matchId}?push_call_sid=${sessionId}.
  // We capture the param once at mount (before the URL gets cleaned) and use it
  // in the startup sweep to arm that specific session — bypassing the normal
  // APP_LOAD_TIME guard (which would otherwise block every call that started
  // before the app was opened, including legitimate push-notification rings).
  const pushCallSidRef = useRef<string | null>(
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("push_call_sid")
      : null
  );

  // Clean the URL immediately so the param doesn't persist across navigations.
  useEffect(() => {
    if (pushCallSidRef.current) {
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, "", clean);
      console.log("[CALL_RING] app opened via push notification", { sid: pushCallSidRef.current.slice(0, 8) });
    }
  }, []);

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

  // ── armedTick — React bridge for the live-call-sessions Set ───────────────
  // Mirrors the cancelledTick pattern above. When armCallSession / disarmCallSession
  // is called from anywhere (Realtime signal, startCall success, markCallEnded),
  // armedTick increments and all three call-detection memos re-run immediately
  // so overlay visibility and audio state stay in sync with the arming state.
  const [armedTick, setArmedTick] = useState(0);
  useEffect(() => {
    setOnArmChange(() => setArmedTick(t => t + 1));
    return () => setOnArmChange(null);
  }, []);

  // ── Tab-entry audio stop ───────────────────────────────────────────────────
  // Every tab navigation must stop any stale ringtone/ringback immediately.
  //
  // WHY THIS WAS PREVIOUSLY TOO NARROW:
  //   The guard only fired for /matches and /messages.  That left a critical gap:
  //   PersistentTabs keeps ALL tab pages mounted (display:none when inactive),
  //   so the Matches component's Realtime subscription stays live on every tab.
  //   When a call:ring event arrived (or the 10 s poll returned stale call data)
  //   while the user was on any tab, startIncomingRingtone() set _ringtoneActive=true.
  //   iOS autoplay policy silently blocked rt.play() — no ring yet.
  //   The user's next click (e.g. tapping Discover) triggered _doUnlock() in the
  //   capture phase, which called _warmElements() → rt.play() unmuted → ring
  //   played audibly even though no call was active.  The old guard only ran when
  //   navigating TO /matches, so Discover navigation was entirely unprotected.
  //
  // FIX:
  //   Fire stopAllNonVoiceCallAudio on EVERY location change.
  //   stopAllNonVoiceCallAudio only stops ringtone/ringback — it does NOT touch
  //   the remote-voice <audio> element used during a live WebRTC call.  It is
  //   therefore safe to call unconditionally: if a real voice call is connected,
  //   its audio is unaffected; if a ring was stale, it is silenced.
  //   A full-screen call overlay blocks all navigation during a real incoming ring,
  //   so navigating away always means the ring is stale.
  //
  //   A second, synchronous layer is applied in app-layout.tsx: the nav button
  //   onClick calls stopAllNonVoiceCallAudio before _doUnlock() can warm+play
  //   the ring element (capture-phase _doUnlock fires after synthetic onClick
  //   completes in the same event dispatch).  Both layers together ensure the
  //   ring is cleared before any new audio can start from the warm-up path.
  // hasActiveCallRef: tracks whether any call overlay is currently showing.
  // Updated on every render (before effects run) so the location effect always
  // reads the current value without needing it in the deps array.
  const hasActiveCallRef = useRef(false);

  const [location] = useLocation();
  useEffect(() => {
    stopAllNonVoiceCallAudio("tab_navigation_guard");
    // If no call is currently active, disarm all armed sessions.
    // A full-screen call overlay (position:fixed) blocks navigation while a
    // real call is in progress, so navigating away always means the call has
    // ended or was never live.  Clearing here prevents stale armed sessions
    // from triggering audio when the user opens a cached Matches/Messages tab.
    //
    // Guard also checks hasRingRef.current:
    //   armCallSession() and callRingHandler(true) are called synchronously in
    //   the Realtime signal handler before React re-renders.  If the user taps a
    //   nav button in the ~50 ms gap between "ring signal arrived" and "React
    //   re-rendered with the new incomingCall", hasActiveCallRef.current is still
    //   false (from the last render) but hasRingRef.current is already true.
    //   Without this extra guard, the location effect would fire and disarm the
    //   live session — silently dropping a genuine incoming call.
    if (!hasActiveCallRef.current && !hasRingRef.current) {
      clearAllArmedSessions();
    }
    console.log("[CALL_AUDIO_GUARD] stopped ringtone/ringback on navigation", { location });
  }, [location]);

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

  // On mount: silence any stale audio, then register the iOS audio-unlock
  // listeners so the first user gesture warms the singleton ring elements.
  //
  // WHY registerCallAudioUnlock() is called HERE (not at module load time):
  //   call-audio.ts previously registered click/touchstart at module load, which
  //   meant the warm-up play() could fire on the Landing page for logged-out users.
  //   On some systems, play() — even with muted=true — produces a brief OS-level
  //   audio artifact. Worse: if _ringtoneActive=true survived an overlay crash,
  //   the warm-up would start the ringtone audibly for a user who is not even
  //   logged in. Registering here ensures the listeners only exist while
  //   CallDetectors is mounted (i.e., user is authenticated and a call is possible).
  //
  // On unmount: unregister listeners + stop all audio.
  //   Covers sign-out (AppContent unmounts CallDetectors), session expiry, and
  //   any edge case where the overlay never cleaned up _ringtoneActive properly.
  useEffect(() => {
    // Hard stop ALL call audio (ringtone, ringback, and voice) before registering
    // the unlock listeners.  Covers refresh-during-call, HMR re-mount, and any
    // scenario where _ringtoneActive/_ringbackActive were left true by a crash.
    // Runs before the first /api/matches fetch completes so no overlay can start
    // audio before this sweep.
    //
    // Also clear all armed sessions immediately.  A Realtime call:ring event can
    // arrive before the startup staleness sweep (below) has run.  If it does, it
    // arms the session and startIncomingRingtone() would pass the armed-session
    // guard. Clearing here ensures the armed set is always empty at startup so
    // only events received AFTER auth + startup sweep can trigger audio.
    // The startup sweep re-arms any session that a live rering proves is still
    // active (via clearStartupCancelledSession in use-call-signaling.ts).
    clearAllArmedSessions();
    resetStartupSweep();
    stopAllCallSounds("calldetectors_mount");
    console.log("[STARTUP_AUDIO] stopped before auth", { userId: userId.slice(0, 8) });
    console.log("[CALL_AUDIO_GUARD] stopped audio before auth", { userId: userId.slice(0, 8) });
    console.log("[CALL_BOOT] startup ringtone stopped", { userId: userId.slice(0, 8) });

    // Register iOS audio-unlock listeners now that we know the user is authenticated.
    registerCallAudioUnlock();

    return () => {
      // Sign-out / unmount: unregister listeners, kill all audio, and clear the
      // live-call-sessions arming set so the next login starts with a clean slate.
      unregisterCallAudioUnlock();
      stopAllCallSounds("call_detectors_unmount");
      clearAllArmedSessions();
      resetStartupSweep();
      console.log("[CALL_AUDIO_GUARD] cleared stale call timers on logout", { userId: userId.slice(0, 8) });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── bfcache restore guard ────────────────────────────────────────────────
  // When the browser restores this page from the back-forward cache (back/forward
  // navigation, tab restore), React effects do NOT re-run.  This means:
  //   • _armedSessionIds (module-level Set) retains any sessions that were armed
  //     before the page was hidden — a stale armed session would pass isArmedSession()
  //     and let IncomingCallOverlay mount with ringEnabled=true → ringtone plays.
  //   • startupDoneRef.current remains true → the startup sweep won't re-run.
  //   • startupVerified remains true → forcedIncomingMatch is live immediately.
  // Fixing this requires a window "pageshow" listener (the only event that fires on
  // bfcache restore).  Because this useEffect's closure persists in the bfcache, the
  // registered listener runs on restore even though React effects don't re-run.
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return; // normal load — React effects handle this already
      console.log("[BFCACHE] page restored from bfcache — resetting call state");
      // 1. Disarm all sessions so no overlay can mount until the sweep re-runs.
      clearAllArmedSessions();
      // 2. Stop any audio that was playing before the page was hidden.
      stopAllCallSounds("bfcache_pageshow");
      // 3. Reset startup sweep so re-arming is blocked until next /api/matches sweep.
      resetStartupSweep();
      startupDoneRef.current = false;
      // 4. Hide overlays until sweep confirms which (if any) call is live.
      setStartupVerified(false);
      // 5. Force a fresh /api/matches fetch so the startup sweep re-runs immediately.
      qc.invalidateQueries({ queryKey: ["/api/matches"] });
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [qc]);

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

  const rerMatch = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && !m.callAnswered && !m.callCompleted && m.callInitiatorId === userId)) return false;
    if (new Date(m.callStartedAt!).getTime() < APP_LOAD_TIME) return false;
    // Guard 1: only rering if the session is still armed by startCall.onSuccess.
    // When markCallEnded calls disarmCallSession, isArmedSession returns false and
    // rererings stop immediately — even if the 10 s DB poll returns a stale row.
    if (!isArmedSession(m.callSessionId)) return false;
    // Guard 2: belt-and-suspenders against the endedMatchIds ref set by markCallEnded.
    if (endedMatchIdsRef.current.has(m.id)) return false;
    // Guard 3: match the 90-second stale cutoff used by callerRingingCall so both
    // the caller overlay and the rering mechanism stop at the same boundary.
    if (Date.now() - new Date(m.callStartedAt!).getTime() > 90_000) return false;
    return true;
  }), [matches, userId, armedTick, endedTick]);
  const rerMatchId = rerMatch?.id;
  const rerSessionId = rerMatch?.callSessionId;
  useEffect(() => {
    if (!rerMatchId || !rerSessionId) return;
    // NOTE: do NOT call armCallSession(rerSessionId) here.
    //
    // Why: rerMatch is computed from raw /api/matches DB data. armCallSession here
    // would re-arm a session that markCallEnded already explicitly disarmed. The
    // re-arming happens because the 10 s background poll can return a stale row
    // (call ended, server DB not yet cleared) → rerMatch becomes non-null → re-arm
    // → callerRingingCall memo passes isArmedSession → ActiveCallOverlay mounts →
    // ringback plays even though no call is in progress. This is the exact bug that
    // fires when the user opens Active Chats / Connections/Matches.
    //
    // The CALLER is armed by startCall.onSuccess (matches.tsx) — the explicit user
    // action that initiates the call. If the page is refreshed during an active call,
    // the caller loses the outgoing ring UI (safe), but still reregisters as the
    // caller once the receiver answers via the call:answered Realtime signal which
    // arms the session via armCallSession in use-call-signaling.ts.
    //
    // The rering API call still fires — its purpose is to notify the RECEIVER, not
    // to restore the caller's own call state.
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
    // Disarm the session immediately so no subsequent DB poll can re-trigger the
    // overlay or audio for this dead session. clearCallFromCache (below) also
    // calls markCallSessionCancelled, which is a second line of defence.
    disarmCallSession(callSessionId);
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
        // Intentionally NOT calling clearCancelledSession here.
        // Removing the cancelled-session guard after server confirmation creates a
        // race: the next 10 s poll can return stale DB data (callStartedAt still set)
        // and, with the guard gone, callerRingingCall / forcedIncomingMatch becomes
        // non-null → ActiveCallOverlay mounts → getUserMedia() + ringback fire with
        // no active call.  Keeping the session in cancelledSessions for the whole
        // browser session is safe: each call uses a unique UUID sessionId, so a new
        // call on this match always gets a fresh sessionId that is never blocked.
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
      if (m.callCompleted) continue;
      if (!m.callInitiatorId) continue;
      // Already handled (either startup-cancelled or user-cancelled) — skip.
      if (isCallSessionCancelled(m.id, m.callSessionId)) continue;

      // Only block calls that were ringing BEFORE this browser session started.
      const callStartMs = new Date(m.callStartedAt).getTime();
      if (callStartMs >= APP_LOAD_TIME) continue;

      const ageMs = Date.now() - callStartMs;
      const isCallerSide = m.callInitiatorId === userId;

      // ── Push-notification arm ──────────────────────────────────────────────
      // If this is already push-armed (set on a previous sweep run), preserve
      // it — never startup-cancel a session that was confirmed live by a push tap.
      if (isPushArmedSession(m.callSessionId)) {
        console.log("[CALL_RING] push-armed session preserved in startup sweep", { matchId: m.id, sessionId: m.callSessionId.slice(0, 8), ageMs });
        continue;
      }

      // First-time detection: user just opened the app from a push notification.
      // The push param encodes the expected callSessionId — if it matches this
      // match's session AND the call is still active AND < 90 s old, arm it.
      if (
        pushCallSidRef.current !== null &&
        m.callSessionId === pushCallSidRef.current &&
        !m.callAnswered &&
        !m.callCompleted &&
        !isCallerSide &&      // push ring is only for the RECEIVER
        ageMs < 90_000
      ) {
        console.log("[CALL_RING] app opened with active call — arming session via push", {
          matchId: m.id,
          sessionId: m.callSessionId.slice(0, 8),
          ageMs,
        });
        armSessionFromPush(m.callSessionId);
        hasRingRef.current = true;
        pushCallSidRef.current = null; // consume — only arm once
        continue; // do NOT startup-cancel this session
      }

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

      // Explicitly disarm the session in addition to marking it startup-cancelled.
      // Without this, a call:ring Realtime event that races the startup sweep
      // (arrives before this effect runs) arms the session first, the sweep then
      // marks it startup-cancelled but leaves it armed — so the overlay and audio
      // still fire because isArmedSession() returns true.  Disarming here ensures
      // the armed-session guard in startIncomingRingtone() blocks the stale ring
      // even if the Realtime event beat the sweep.
      disarmCallSession(m.callSessionId);
      stopAllNonVoiceCallAudio("startup_sweep");
      markStartupCancelledSession(m.id, m.callSessionId);
      clearCallFromCache(qc, m.id);
    }

    if (!hadStale && !startupDoneRef.current) {
      console.log("[CALL_STATE_FIX] startup sweep complete — no stale call state found");
    }

    if (!startupDoneRef.current) {
      // ── Cache-vs-network guard ─────────────────────────────────────────────
      // Root cause of "ring on refresh" bug:
      //   TanStack Query can serve cached data instantly while a network fetch
      //   is still in flight. If the previous session called clearCallFromCache
      //   the cache shows callStartedAt=null (clean). The sweep finds nothing
      //   stale and marks itself complete. Then a Realtime call:ring rering
      //   arrives before the network response, passes all guards (sweep says
      //   done, session not previously cancelled), arms the session, and writes
      //   callStartedAt=NOW via optimistic patch — bypassing the APP_LOAD_TIME
      //   guard that would have caught the real (< APP_LOAD_TIME) value. The
      //   ring fires on the user's first gesture via the audio warm-up path.
      //
      // Fix: only mark the sweep complete when no network fetch is pending.
      //   If fetchStatus==="fetching" the cache hit happened; defer to the
      //   next effect run (which fires when the network response arrives and
      //   updates `matches`). Pre-load stale calls are still cancelled in the
      //   loop above — only the sweep-complete signal is held back.
      const qs = qc.getQueryState(["/api/matches"]);
      const networkStillPending = qs?.fetchStatus === "fetching";
      if (networkStillPending) {
        console.log("[CALL_BOOT] startup sweep deferred — network fetch still pending (cache hit)", {
          matchCount: matches.length,
          fetchStatus: qs?.fetchStatus,
        });
        return;
      }
      startupDoneRef.current = true;
      setStartupVerified(true);
      // Allow incoming call:ring events to arm sessions now that we have
      // confirmed the first /api/matches network response. Any pre-load stale
      // calls have been marked startup-cancelled above, so rerings that arrive
      // from this point are safe to process.
      markStartupSweepComplete();
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
    //
    // Push-notification exception: when the user opens the app by tapping an
    // incoming-call push notification, the call necessarily started BEFORE this
    // app session (callStartedAt < APP_LOAD_TIME). The startup sweep detects the
    // ?push_call_sid URL param and arms the session via armSessionFromPush().
    // That session must bypass this guard — it is provably live, not stale.
    if (new Date(m.callStartedAt).getTime() < APP_LOAD_TIME) {
      if (!isPushArmedSession(m.callSessionId)) return false;
      // Push-armed: fall through to isArmedSession + cancelled checks below.
    }
    if (isSelfCall(m)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    // ── Live-session guard ────────────────────────────────────────────────────
    // Only sessions armed by a genuine Realtime call:ring event may reach this
    // point. A stale DB row (callStartedAt > APP_LOAD_TIME but call already ended
    // and server not yet cleared) is blocked here, preventing ringtone from
    // starting when the user opens Connections/Matches and the poll returns
    // stale data.
    if (!isArmedSession(m.callSessionId)) {
      console.log("[LIVE_CALL] STALE_CALL_BLOCKED incomingCall — not armed by Realtime event", { matchId: m.id, sessionId: m.callSessionId?.slice(0, 8) });
      return false;
    }
    // ── Bug 2 fix (part B): cancelledTick in deps ensures this memo re-runs
    // whenever clearStartupCancelledSession() lifts the startup block.
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "incoming_check" });
      return false;
    }
    const callKey = `${m.id}:${m.callSessionId}`;
    return callKey !== dismissedCallKey;
  }), [matches, userId, isEndedCall, dismissedCallKey, cancelledTick, armedTick]);

  const answeredCall = useMemo(() => matches?.find(m => {
    if (!(m.callStartedAt && m.callSessionId && m.callAnswered === true && m.callCompleted === false &&
      (m.user1Id === userId || m.user2Id === userId))) return false;
    // Block answered calls that started before this page load — same guard used by
    // callerRingingCall (line 609) and incomingCall (line 571). Without this,
    // a stale callAnswered=true row mounts ActiveCallOverlay (webrtcEnabled=true)
    // which opens the microphone and causes an OS-level audio click on startup.
    if (new Date(m.callStartedAt).getTime() < APP_LOAD_TIME) return false;
    if (isSelfCall(m)) return false;
    if (isEndedCall(m)) return false;
    if (isStaleCall(m)) return false;
    // Live-session guard: same as incomingCall. Prevents ActiveCallOverlay from
    // mounting (and triggering getUserMedia) from a stale callAnswered=true DB row.
    if (!isArmedSession(m.callSessionId)) {
      console.log("[LIVE_CALL] STALE_CALL_BLOCKED answeredCall — not armed by Realtime event", { matchId: m.id, sessionId: m.callSessionId?.slice(0, 8) });
      return false;
    }
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "answered_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall, cancelledTick, armedTick]);

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
    // Live-session guard: only sessions armed by startCall() or rering can
    // mount ActiveCallOverlay with isRinging=true and start ringback audio.
    if (!isArmedSession(m.callSessionId)) {
      console.log("[LIVE_CALL] STALE_CALL_BLOCKED callerRingingCall — not armed by startCall or rering", { matchId: m.id, sessionId: m.callSessionId?.slice(0, 8) });
      return false;
    }
    if (isCallSessionCancelled(m.id, m.callSessionId)) {
      console.log("[CALL_SESSION] STALE_CALL_SESSION_BLOCKED", { matchId: m.id, callSessionId: m.callSessionId, source: "caller_ringing_check" });
      return false;
    }
    return true;
  }), [matches, userId, isEndedCall, cancelledTick, armedTick]);

  const activeCall = answeredCall || callerRingingCall;

  // Update ref so the location-change effect knows whether a call is live.
  // Must be set during render (not in an effect) so it reflects the current
  // state before the effect runs.
  hasActiveCallRef.current = !!(incomingCall || callerRingingCall || activeCall);

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

  // ── Ring-gate reset: clear hasRingRef when no calls are active ───────────
  // Bug: when isStaleCall() fires (90 s unanswered) the memos return null and
  // the overlays unmount, but hasRingRef.current stays `true` forever because
  // the only place it was reset was inside callEndedCallback (which never fires
  // for a stale timeout — there is no signal).  With hasRingRef=true the
  // refetchInterval gate stays closed, so new data arrives only via Realtime
  // and any subsequent match-list polls are permanently suppressed.
  //
  // Fix: watch the three derived memos; when all become null (normal end OR
  // stale-timeout) reset the ring gate so polling resumes immediately.
  useEffect(() => {
    const hasAnyCall = !!(incomingCall || callerRingingCall || activeCall);
    if (!hasAnyCall && hasRingRef.current) {
      hasRingRef.current = false;
      console.log("[CALL_FIX] ring polling gate reset — no active calls (stale or ended)");
    }
  }, [incomingCall, callerRingingCall, activeCall]);

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
  // isVideoCallSession() also catches paid video-credit calls.
  const isFaceCall = matchForIncoming
    ? isVideoCallSession(matchForIncoming.callSessionId) ||
      (matchForIncoming.callStage || 0) === 1 ||
      ((matchForIncoming.callStage || 0) === 3 &&
        !!matchForIncoming.faceCallUser1Accepted &&
        !!matchForIncoming.faceCallUser2Accepted)
    : false;

  const isActiveVideo = activeCall
    ? isVideoCallSession(activeCall.callSessionId) ||  // paid video-credit call
      (activeCall.callStage || 0) === 1 ||              // second call is always video
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
        // [RING_FIX] forcedIncomingMatch: same guard chain as incomingCall memo so
        // cancelled/stale/ended calls never trigger IncomingCallOverlay or its ringtone.
        // Previously this scan had NO guards — any match with callStartedAt in the DB
        // (including declined/cancelled calls the server hadn't cleared yet) would mount
        // the overlay and play the ringtone the moment a 5 s poll returned stale data.
        const forcedIncomingMatch = (matches ?? []).find(m =>
          !!m.callStartedAt &&
          !!m.callInitiatorId &&            // require a valid initiator (mirrors incomingCall memo)
          m.callCompleted !== true &&
          m.callInitiatorId !== userId &&   // current user is receiver
          m.callAnswered !== true &&        // receiver has not answered yet
          !!m.callSessionId &&
          isArmedSession(m.callSessionId) &&              // MUST be armed by live Realtime call:ring
          !isCallSessionCancelled(m.id, m.callSessionId) &&  // skip declined/cancelled
          !isEndedCall(m) &&                                  // skip locally-ended calls
          !isStaleCall(m) &&                                  // skip >90 s unanswered calls
          // Respect the user's explicit dismiss action (same guard as incomingCall memo).
          // Without this check, pressing Decline sets dismissedCallKey but forcedIncomingMatch
          // ignores it → overlay re-mounts immediately → appears as a random incoming call.
          `${m.id}:${m.callSessionId}` !== dismissedCallKey
        ) ?? null;

        const overlayForActive = activeCall ?? null;

        // ── Priority 1: receiver sees IncomingCallOverlay ───────────────────
        if (forcedIncomingMatch) {
          const forcedIsFaceCall =
            isVideoCallSession(forcedIncomingMatch.callSessionId) ||
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
                  callerName={overlayForActive.profile?.firstName || "Unknown"}
                  callerPhoto={overlayForActive.profile?.photos?.[0] || undefined}
                  callStage={overlayForActive.callStage || 0}
                  isPaidCall={isPaidCallSession(overlayForActive.callSessionId)}
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

// ── Profile-gate diagnostic store ─────────────────────────────────────────────
// Enabled in dev mode OR when localStorage.lulou_diag === "1".
// Set it in DevTools: localStorage.setItem("lulou_diag","1") then refresh.
// Shown on the reconnect screen so the exact failure can be copied without DevTools.
// Always show diagnostics on the reconnect screen until the root cause is confirmed.
// Remove this (restore localStorage gate) once the production issue is resolved.
const DIAG_ENABLED: boolean = true;

interface ProfileDiag {
  timestamp: number;
  hostname: string;
  apiBase: string;
  viteApiBaseUrl: string;
  isCrossOrigin: boolean;
  userId: string | null;
  fullFetchUrl: string;
  // Session state captured before the fetch
  sessionExists: boolean | null;
  accessTokenExists: boolean | null;
  tokenExpiresAt: number | null;
  tokenExpiryReadable: string | null;
  // Auth header state
  hasAuthHeader: boolean | null;
  // Response fields (null = never received a response)
  fetchStatus: number | null;
  contentType: string | null;
  bodyPreview: string | null;
  isHtml: boolean;
  // Error classification
  errorCategory: "401" | "403" | "404" | "timeout" | "cors" | "network" | "html" | "server_error" | null;
  errorMessage: string | null;
}
let _lastProfileDiag: ProfileDiag | null = null;

function DiagPanel() {
  if (!DIAG_ENABLED) return null;
  const d = _lastProfileDiag;
  if (!d) {
    return (
      <div className="mt-4 text-xs text-muted-foreground/60 text-center font-mono">
        No diagnostic data — profile fetch hasn't run yet
      </div>
    );
  }
  const swCtrl = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  const lines = [
    `[RECONNECT_ROOT_CAUSE]`,
    `appCommit=${__COMMIT_HASH__}`,
    `buildTime=${__BUILD_TIME__}`,
    `swVersionBundled=${__SW_VERSION__}`,
    `swControlled=${typeof navigator !== "undefined" ? String(!!navigator.serviceWorker?.controller) : "?"}`,
    `swScriptUrl=${swCtrl?.scriptURL ?? "(none)"}`,
    `swState=${swCtrl?.state ?? "(none)"}`,
    `endpoint=${d.fullFetchUrl}`,
    `status=${d.fetchStatus ?? "(no response — pre-fetch failure)"}`,
    `contentType=${d.contentType ?? "(none)"}`,
    `bodyPreview=${d.bodyPreview ?? "(none)"}`,
    `authState=session=${d.sessionExists} token=${d.accessTokenExists} expiry=${d.tokenExpiryReadable ?? "(unknown)"}`,
    `hasAuthHeader=${d.hasAuthHeader}`,
    `apiBase=${d.apiBase || "(empty — same-origin)"}`,
    `viteApiBaseUrl=${d.viteApiBaseUrl}`,
    `hostname=${d.hostname}`,
    `currentUrl=${typeof window !== "undefined" ? window.location.href : "(server)"}`,
    `isCrossOrigin=${d.isCrossOrigin}`,
    `userId=${d.userId ?? "(unknown)"}`,
    `isHtml=${d.isHtml}`,
    `errorCategory=${d.errorCategory ?? "(none)"}`,
    `error=${d.errorMessage ?? "(none)"}`,
    `capturedAt=${new Date(d.timestamp).toISOString()}`,
  ].join("\n");
  return (
    <div className="mt-6 w-full text-left border-t border-muted-foreground/20 pt-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wide">
          Diagnostic info
        </span>
        <button
          className="text-xs px-2 py-0.5 rounded border border-muted-foreground/30 hover:bg-muted transition-colors font-mono"
          onClick={() => { try { navigator.clipboard.writeText(lines); } catch {} }}
        >
          Copy
        </button>
      </div>
      <pre className="text-xs font-mono bg-black/5 rounded p-2 overflow-auto max-h-52 whitespace-pre-wrap break-all leading-relaxed">
        {lines}
      </pre>
    </div>
  );
}

// Check profile existence via the server's /api/profile endpoint.
// Using the server avoids client-side Supabase auth dependency and keeps
// the single source of truth for profile state on the backend.
async function checkProfileExists(
  userId?: string,
  onProfileData?: (data: unknown) => void,
): Promise<ProfileCheckResult> {
  console.log("[AUTH_FLOW] profile fetch started", { userId });
  writeDebug({
    postAuthProfileFetchStarted: true,
    postAuthProfileFetchSucceeded: false,
    profileFetchMethodUsed: "maybeSingle",
    profileQueryUserId: userId ?? null,
    profileRowFound: null,
    profileErrorMessage: null,
  });

  const fullFetchUrl = API_BASE + "/api/profile";

  // Initialise the diagnostic record — updated incrementally so partial failures
  // still leave useful data. The reconnect screen reads from _lastProfileDiag.
  const diag: ProfileDiag = {
    timestamp: Date.now(),
    hostname: typeof window !== "undefined" ? window.location.hostname : "(server)",
    apiBase: API_BASE,
    viteApiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined) || "(not set)",
    isCrossOrigin: IS_CROSS_ORIGIN_DEPLOY,
    userId: userId ?? null,
    fullFetchUrl,
    sessionExists: null,
    accessTokenExists: null,
    tokenExpiresAt: null,
    tokenExpiryReadable: null,
    hasAuthHeader: null,
    fetchStatus: null,
    contentType: null,
    bodyPreview: null,
    isHtml: false,
    errorCategory: null,
    errorMessage: null,
  };
  _lastProfileDiag = diag;

  // Capture the Supabase session state NOW — before getAuthHeaders() might refresh
  // it — so we see exactly what the client had at the point the fetch started.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    diag.sessionExists = !!session;
    diag.accessTokenExists = !!session?.access_token;
    const exp: number | null = (session as any)?.expires_at ?? null;
    diag.tokenExpiresAt = exp;
    diag.tokenExpiryReadable = exp ? new Date(exp * 1000).toISOString() : null;
  } catch { /* non-fatal — diagnostic only */ }

  // ── STARTUP DIAGNOSTIC: log API routing state ────────────────────────────
  console.log("[STARTUP_DIAG] checkProfileExists", {
    API_BASE: API_BASE || "(empty — same-origin)",
    IS_CROSS_ORIGIN_DEPLOY,
    fullFetchUrl,
    userId,
    sessionExists: diag.sessionExists,
    accessTokenExists: diag.accessTokenExists,
    tokenExpiryReadable: diag.tokenExpiryReadable,
  });

  // 15-second master abort — covers both getAuthHeaders() (up to 5 s internally)
  // and the actual fetch (server has 2.5 s checkEmailVerified + 3 s getProfile timeouts).
  // Must be < SPINNER_TIMEOUT_MS so the query enters error state before the spinner
  // declares timeout and the "Try Again" button handles manual retry.
  let res: Response;
  const controller = new AbortController();
  let _currentStep = "getAuthHeaders";
  const t_total = performance.now();
  const masterTimeoutId = setTimeout(() => {
    controller.abort();
    console.error(`[RECONNECT_ROOT_CAUSE] timeout — master 15s limit hit at step="${_currentStep}"`);
  }, 15_000);
  try {
    console.log("[SETUP] STEP 1/3 getAuthHeaders START", { userId });
    const t0 = performance.now();
    const authHeaders = await getAuthHeaders();
    const headersMs = Math.round(performance.now() - t0);

    // ── DIAGNOSTIC: inspect auth header state ───────────────────────────────
    const hasAuthHeader = !!authHeaders.Authorization;
    const tokenPreview = hasAuthHeader
      ? authHeaders.Authorization.slice(0, 40) + "…"
      : "(none)";
    console.log(`[SETUP] STEP 1/3 getAuthHeaders DONE in ${headersMs}ms`, {
      userId: userId ?? "none",
      hasAuthHeader,
      tokenPreview,
    });
    diag.hasAuthHeader = hasAuthHeader;
    if (!hasAuthHeader) {
      console.error("[RECONNECT_ROOT_CAUSE] auth header missing/expired — getAuthHeaders() returned no token", {
        userId,
        API_BASE: API_BASE || "(empty)",
        fullFetchUrl,
      });
      diag.errorCategory = "401";
      diag.errorMessage = "getAuthHeaders() returned no token — session missing or expired and refresh failed";
    }

    _currentStep = "fetch /api/profile";
    console.log("[SETUP] STEP 2/3 fetch /api/profile START", { fullFetchUrl });
    const t1 = performance.now();
    // Use /api/profile (full profile) — photos are now short Storage URLs (~2–5 kB total)
    // so payload size is negligible. Fetching the full profile here lets us seed the
    // ["/api/profile"] cache on success, so profile.tsx reads from cache on first render
    // instead of issuing a second network request.
    res = await fetch(fullFetchUrl, {
      credentials: "include",
      headers: authHeaders,
      signal: controller.signal,
    });
    clearTimeout(masterTimeoutId);
    const fetchMs = Math.round(performance.now() - t1);
    if (PERF_ENABLED) {
      logLatency("/api/profile", fetchMs, parseServerTiming(res.headers.get("server-timing")), 0);
    }

    // ── DIAGNOSTIC: inspect every response before processing ────────────────
    const contentType = res.headers.get("content-type") ?? "";
    const isHtmlResponse = contentType.includes("text/html") ||
      (!contentType.includes("application/json") && !contentType.includes("text/plain") && res.ok);
    diag.fetchStatus = res.status;
    diag.contentType = contentType || null;
    console.log(`[STARTUP_DIAG] /api/profile response`, {
      status: res.status,
      statusText: res.statusText,
      contentType: contentType || "(none)",
      isHtmlResponse,
      fetchMs,
      fullFetchUrl,
      API_BASE: API_BASE || "(empty)",
    });

    if (isHtmlResponse) {
      // Vercel returns the React index.html for any unmatched /api/* path when
      // VITE_API_BASE_URL is wrong or missing. The response is 200 with text/html —
      // status check alone won't catch it.
      const preview = await res.clone().text()
        .then(t => t.slice(0, 200))
        .catch(() => "(could not read body)");
      console.error("[RECONNECT_ROOT_CAUSE] API returned HTML — backend URL is wrong", {
        API_BASE: API_BASE || "(empty — VITE_API_BASE_URL not set in Vercel)",
        IS_CROSS_ORIGIN_DEPLOY,
        fullFetchUrl,
        contentType,
        responsePreview: preview,
      });
      diag.isHtml = true;
      diag.bodyPreview = preview;
      diag.errorCategory = "html";
      diag.errorMessage = "API returned HTML — wrong backend URL or Vercel serving index.html for /api/* routes";
      throw new Error("API_HTML_RESPONSE");
    }

    console.log(`[SETUP] STEP 2/3 fetch /api/profile DONE in ${fetchMs}ms — status=${res.status} total=${Math.round(performance.now() - t_total)}ms`);
    _currentStep = "response";
  } catch (err: any) {
    clearTimeout(masterTimeoutId);
    const isAbort = err?.name === "AbortError";
    const totalMs = Math.round(performance.now() - t_total);
    if (err?.message === "API_HTML_RESPONSE") {
      // Already logged and diag populated above — just rethrow.
      throw err;
    }
    if (isAbort) {
      console.error(`[RECONNECT_ROOT_CAUSE] timeout — stuck at step="${_currentStep}" after ${totalMs}ms`, {
        fullFetchUrl,
        API_BASE: API_BASE || "(empty)",
      });
      diag.errorCategory = "timeout";
      diag.errorMessage = `timeout at step="${_currentStep}" after ${totalMs}ms`;
    } else {
      const isCors = !!(err?.message?.includes("CORS") || err?.message?.includes("cross-origin") || err?.message?.includes("NetworkError"));
      console.error(`[RECONNECT_ROOT_CAUSE] ${isCors ? "CORS" : "backend unreachable"}`, {
        step: _currentStep,
        error: err?.message,
        totalMs,
        fullFetchUrl,
        API_BASE: API_BASE || "(empty)",
        IS_CROSS_ORIGIN_DEPLOY,
      });
      diag.errorCategory = isCors ? "cors" : "network";
      diag.errorMessage = err?.message ?? "NETWORK_ERROR";
    }
    console.log("[AUTH_FLOW] profile fetch failed — reconnect screen", { userId, reason: isAbort ? "timeout" : "network" });
    writeDebug({ profileErrorMessage: isAbort ? `TIMEOUT_15S:${_currentStep}` : (err?.message ?? "NETWORK_ERROR") });
    throw new Error(isAbort ? `TIMEOUT:${_currentStep}` : "NETWORK_ERROR");
  }

  if (res.status === 404) {
    // Profile row does not exist → user needs to complete onboarding.
    console.log("[AUTH_FLOW] profile missing — route onboarding", { userId });
    console.log("[AUTH] PROFILE_EXISTS_CHECK: no profile found (onboarding needed)");
    writeDebug({ postAuthProfileFetchSucceeded: true, profileRowFound: false });
    return { exists: false, fetchFailed: false };
  }

  if (!res.ok) {
    // 401 = JWT invalid/expired, 503 = Supabase DB unreachable during cold-start,
    // anything else = unexpected server error. All are treated as retryable so
    // TanStack Query's retry loop handles transient failures automatically.
    const text = await res.text().catch(() => res.statusText);
    const trimmed = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    console.error(`[RECONNECT_ROOT_CAUSE] HTTP ${res.status} from /api/profile`, {
      status: res.status,
      fullFetchUrl,
      API_BASE: API_BASE || "(empty)",
      IS_CROSS_ORIGIN_DEPLOY,
      responsePreview: trimmed,
    });
    diag.bodyPreview = text.slice(0, 300);
    diag.errorCategory = res.status === 401 ? "401" : res.status === 403 ? "403" : res.status === 404 ? "404" : "server_error";
    diag.errorMessage = `HTTP_${res.status}: ${trimmed}`;
    console.log("[AUTH_FLOW] profile fetch failed — reconnect screen", { userId, reason: `http_${res.status}` });
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
  console.log("[AUTH_FLOW] profile found — onboarding complete — route main app", { userId });
  console.log("[AUTH] PROFILE_EXISTS_CHECK: profile found");
  writeDebug({ postAuthProfileFetchSucceeded: true, profileRowFound: true });
  return { exists: true, fetchFailed: false };
}

// How long the loading spinner is allowed to show before we cut it off and
// display a retry/bypass screen. Must be longer than the total retry window
// (3 attempts × 15 s abort + exponential delays ≈ 55 s). Acts as a last-resort
// backstop for cases where the request stalls without triggering a TCP reset.
const SPINNER_TIMEOUT_MS = 55_000;

// ── Email verification gate ──────────────────────────────────────────────────
// Standalone component so it can use useState without violating the rules
// of hooks (hooks can't be called conditionally inside AppContent).
function VerifyEmailGate({
  email,
  onSignOut,
  otpMode = false,
  onOtpVerified,
}: {
  email: string | undefined;
  onSignOut: () => void;
  otpMode?: boolean;
  onOtpVerified?: () => void;
}) {
  const { t } = useLanguageContext();
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0); // seconds remaining
  const [refreshLoading, setRefreshLoading] = useState(false);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  // OTP verification state (used when otpMode=true)
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpSendLoading, setOtpSendLoading] = useState(false);
  const [otpVerifyLoading, setOtpVerifyLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpVerified, setOtpVerified] = useState(false);

  const handleResend = useCallback(async () => {
    if (!email || resendCooldown > 0) return;
    setResendLoading(true);
    setResendError(null);
    try {
      console.log("[AUTH] VERIFY_GATE_RESEND_START", { email: email.slice(0, 4) + "***" });
      const result = await sendVerificationResend(email);
      if (result.ok) {
        console.log("[AUTH] VERIFY_GATE_RESEND_SUCCESS — Supabase queued the email");
        setResendSent(true);
        setResendCooldown(60);
      } else {
        setResendError(result.message || t("verify_email_resend_err"));
        if (result.rateLimit) setResendCooldown(60);
      }
    } finally {
      setResendLoading(false);
    }
  }, [email, resendCooldown, t]);

  // After clicking the verification link in another tab, the user can tap here
  // to refresh their session.  onAuthStateChange in AuthProvider will pick up
  // the new token and, if email_confirmed_at is set, dismiss this gate.
  const handleRefresh = useCallback(async () => {
    setRefreshLoading(true);
    try {
      await supabase.auth.refreshSession();
    } catch {
      // ignore — sign out + back in remains the fallback
    } finally {
      setRefreshLoading(false);
    }
  }, []);

  const handleSendOtp = useCallback(async () => {
    if (!email) return;
    setOtpSendLoading(true);
    setOtpError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/auth/verify/send-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? t("verify_email_otp_send_err"));
      }
      setOtpSent(true);
    } catch (err: any) {
      setOtpError(err?.message ?? t("verify_email_otp_send_err"));
    } finally {
      setOtpSendLoading(false);
    }
  }, [email, t]);

  const handleVerifyOtp = useCallback(async () => {
    if (!email || !otpCode.trim()) return;
    setOtpVerifyLoading(true);
    setOtpError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/auth/verify/confirm-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ email, code: otpCode.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? t("verify_email_otp_err"));
      }
      setOtpVerified(true);
      onOtpVerified?.();
      setTimeout(() => supabase.auth.refreshSession(), 300);
    } catch (err: any) {
      setOtpError(err?.message ?? t("verify_email_otp_err"));
    } finally {
      setOtpVerifyLoading(false);
    }
  }, [email, otpCode, t, onOtpVerified]);

  // ── OTP mode UI ───────────────────────────────────────────────────────────
  if (otpMode) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 gap-8" data-testid="screen-verify-email-otp">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <Mail className="w-6 h-6 text-primary" />
        </div>
        <div className="w-full max-w-sm space-y-3 text-center">
          <h1 className="font-serif text-2xl font-bold">{t("verify_email_otp_title")}</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t("verify_email_otp_body")}{" "}
            <strong className="text-foreground">{email}</strong>.
          </p>
        </div>
        {otpVerified ? (
          <div className="w-full max-w-sm flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle className="w-5 h-5" />
              {t("verify_email_otp_success")}
            </div>
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
          </div>
        ) : (
          <div className="w-full max-w-sm space-y-3">
            {!otpSent ? (
              <button
                className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                onClick={handleSendOtp}
                disabled={otpSendLoading || !email}
                data-testid="button-send-otp"
              >
                {otpSendLoading
                  ? <><Loader2 className="w-4 h-4 animate-spin" />{t("verify_email_otp_sending")}</>
                  : t("verify_email_otp_send_btn")}
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2 justify-center text-sm text-primary py-1">
                  <CheckCircle className="w-4 h-4" />
                  {t("verify_email_otp_sent")}
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder={t("verify_email_otp_placeholder")}
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full text-center text-2xl tracking-widest py-3 px-4 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  data-testid="input-otp-code"
                  autoComplete="one-time-code"
                />
                <button
                  className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                  onClick={handleVerifyOtp}
                  disabled={otpVerifyLoading || otpCode.length < 6}
                  data-testid="button-verify-otp"
                >
                  {otpVerifyLoading
                    ? <><Loader2 className="w-4 h-4 animate-spin" />{t("verify_email_otp_verifying")}</>
                    : t("verify_email_otp_verify_btn")}
                </button>
                <button
                  className="w-full text-xs text-muted-foreground py-2 hover:text-foreground transition-colors"
                  onClick={() => { setOtpSent(false); setOtpCode(""); setOtpError(null); }}
                  data-testid="button-resend-otp"
                >
                  {t("verify_email_otp_resend")}
                </button>
              </>
            )}
            {otpError && <p className="text-xs text-destructive text-center">{otpError}</p>}
            <button
              className="w-full py-2.5 rounded-md border text-sm font-medium hover:bg-muted transition-colors"
              onClick={onSignOut}
              data-testid="button-signout-otp-gate"
            >
              {t("verify_email_signout")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Email-link mode UI (Supabase "Confirm email" ON) ─────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 gap-8" data-testid="screen-verify-email-gate">
      <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
        <Mail className="w-6 h-6 text-primary" />
      </div>
      <div className="w-full max-w-sm space-y-3 text-center">
        <h1 className="font-serif text-2xl font-bold">{t("verify_email_title")}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t("verify_email_body_pre")}{" "}
          <strong className="text-foreground">{email}</strong>.{" "}
          {t("verify_email_body_post")}
        </p>
        <p className="text-xs text-muted-foreground">{t("verify_email_confirmed_note")}</p>
      </div>
      <div className="w-full max-w-sm space-y-3">
        {resendSent ? (
          <div className="flex items-center gap-2 justify-center text-sm text-primary py-2">
            <CheckCircle className="w-4 h-4" />
            {t("verify_email_resent")}
          </div>
        ) : (
          <button
            className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            onClick={handleResend}
            disabled={resendLoading || !email || resendCooldown > 0}
            data-testid="button-resend-verify-gate"
          >
            {resendLoading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {t("verify_email_resending")}</>
            ) : resendCooldown > 0 ? (
              `Resend in ${resendCooldown}s`
            ) : (
              t("verify_email_resend_btn")
            )}
          </button>
        )}
        {resendError && (
          <p className="text-xs text-destructive text-center">{resendError}</p>
        )}
        <button
          className="w-full py-2.5 rounded-md border text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          onClick={handleRefresh}
          disabled={refreshLoading}
          data-testid="button-refresh-verify-gate"
        >
          {refreshLoading ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> {t("verify_email_checking")}</>
          ) : (
            t("verify_email_refresh_btn")
          )}
        </button>
        <button
          className="w-full py-2.5 rounded-md border text-sm font-medium hover:bg-muted transition-colors"
          onClick={onSignOut}
          data-testid="button-signout-verify-gate"
        >
          {t("verify_email_signout")}
        </button>
      </div>
    </div>
  );
}

// ── Password Recovery Gate ────────────────────────────────────────────────────
// Shown when the user arrives via a Supabase password-reset email link.
// The PASSWORD_RECOVERY auth event (fired by detectSessionInUrl:true) sets
// passwordRecovery=true in AuthProvider, which causes AppContent to render
// this gate instead of the normal app.  On success the user is signed out so
// they land on the sign-in screen with a fresh session.
function PasswordRecoveryGate({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm)  { setError("Passwords don't match."); return; }
    setLoading(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setDone(true);
      console.log("[AUTH] PASSWORD_RECOVERY_SUCCESS — signing out recovery session");
      // Sign out the temporary recovery session so the user lands on the
      // sign-in screen and logs in fresh with their new password.
      setTimeout(async () => {
        await supabase.auth.signOut();
        onDone();
      }, 2000);
    } catch (err: any) {
      setError(err?.message ?? "Could not update password — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-5">
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Set a new password</h1>
          <p className="text-sm text-muted-foreground">Enter and confirm your new password below.</p>
        </div>

        {done ? (
          <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-3 text-sm text-green-800">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>Password updated! Signing you out…</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="New password"
                autoComplete="new-password"
                className="w-full rounded-md border border-input bg-background px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                data-testid="input-new-password"
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
            <input
              type={showPw ? "text" : "password"}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Confirm password"
              autoComplete="new-password"
              className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="input-confirm-password"
              disabled={loading}
            />

            {error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <Mail className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              data-testid="button-set-password"
            >
              {loading ? "Setting password…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function AppContent() {
  const [location] = useLocation();

  // ── Unauthenticated test route ────────────────────────────────────────────
  if (location === "/drag-test") return <DragTestPage />;

  // ── Public legal pages — no auth required ─────────────────────────────────
  const LEGAL_MAP: Record<string, () => JSX.Element> = {
    "/privacy":              PrivacyPolicyPage,
    "/terms":                TermsOfServicePage,
    "/community-guidelines": CommunityGuidelinesPage,
    "/safe-dating":          SafeDatingPage,
    "/data-deletion":        DataDeletionPage,
    "/cookie-policy":        CookiePolicyPage,
    "/billing-terms":        BillingTermsPage,
  };
  if (location in LEGAL_MAP) {
    const LegalComponent = LEGAL_MAP[location];
    return <LegalComponent />;
  }

  const { user, isLoading: authLoading, profileReady, clearingCache, logout, passwordRecovery, clearPasswordRecovery, sessionBootstrapFailed, retrySessionBootstrap } = useAuth();

  // ── Push subscription auto-reregistration ────────────────────────────────
  // Fires once per login session (when user id becomes available).
  // If the browser has a push subscription, silently re-POSTs it under the
  // current authenticated user's ID. The server uses DELETE+INSERT so any
  // stale userId→endpoint mapping (caused by account-switching on the same
  // device) is corrected immediately without the user visiting Settings.
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const sw  = await navigator.serviceWorker.ready.catch(() => null);
        if (!sw) return;
        const sub = await sw.pushManager.getSubscription().catch(() => null);
        if (!sub) return;
        const p256 = sub.getKey("p256dh");
        const auth = sub.getKey("auth");
        if (!p256 || !auth) return;
        const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
        await fetch("/api/push/subscribe", {
          method:      "POST",
          credentials: "include",
          headers:     { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint:  sub.endpoint,
            p256dh:    toB64(p256),
            auth:      toB64(auth),
            userAgent: navigator.userAgent.slice(0, 200),
          }),
        }).catch(() => {});
        console.log("[PUSH] AppContent: auto-reregistered subscription for userId=", user.id.slice(0, 8));
      } catch {}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // ── Server-side email verification gate ──────────────────────────────────
  // Catches auto-confirmed accounts when Supabase "Confirm email" is OFF.
  // In that mode signUp() immediately sets email_confirmed_at≈created_at, so
  // the !email_confirmed_at frontend check never fires for new fake accounts.
  // The server detects the auto-confirmation via the timestamp heuristic and
  // returns 403 EMAIL_NOT_VERIFIED.  We show the OTP gate in that case.
  const [serverEmailGate, setServerEmailGate] = useState<"checking" | "ok" | "required">("checking");
  useEffect(() => {
    if (authLoading || !user) { setServerEmailGate("checking"); return; }
    // If Supabase confirms email client-side, skip server check entirely.
    if (!user.email_confirmed_at) { setServerEmailGate("ok"); return; }
    let cancelled = false;
    const abortCtrl = new AbortController();
    // Hard 5 s timeout: checkEmailVerified has a 2.5 s server-side timeout,
    // so 5 s is plenty.  Fail-open so a slow server never blocks app startup.
    const gateTimeoutId = setTimeout(() => {
      console.warn("[SETUP] serverEmailGate: 5 s timeout — failing open");
      abortCtrl.abort();
      if (!cancelled) setServerEmailGate("ok");
    }, 5_000);
    (async () => {
      try {
        console.log(`[SETUP] serverEmailGate: getSession start — userId=${user.id.slice(0, 8)}`);
        const t0 = performance.now();
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        console.log(`[SETUP] serverEmailGate: getSession done in ${Math.round(performance.now() - t0)}ms — hasToken=${!!token}`);
        if (!token) { clearTimeout(gateTimeoutId); if (!cancelled) setServerEmailGate("ok"); return; }
        console.log("[SETUP] serverEmailGate: calling /api/auth/verify/status");
        const t1 = performance.now();
        const res = await fetch(API_BASE + "/api/auth/verify/status", {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortCtrl.signal,
        });
        clearTimeout(gateTimeoutId);
        console.log(`[SETUP] serverEmailGate: verify/status responded in ${Math.round(performance.now() - t1)}ms — status=${res.status}`);
        if (cancelled) return;
        if (res.status === 403) {
          const body = await res.json().catch(() => ({})) as { code?: string };
          if (body.code === "EMAIL_NOT_VERIFIED") { setServerEmailGate("required"); return; }
        }
        setServerEmailGate("ok");
      } catch (e: any) {
        clearTimeout(gateTimeoutId);
        const isAbort = e?.name === "AbortError";
        console.warn(`[SETUP] serverEmailGate: ${isAbort ? "aborted (timeout)" : `error: ${e?.message}`} — failing open`);
        if (!cancelled) setServerEmailGate("ok");
      }
    })();
    return () => { cancelled = true; abortCtrl.abort(); clearTimeout(gateTimeoutId); };
  }, [authLoading, user?.id]);

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
  // ── Startup health check ─────────────────────────────────────────────────
  // Runs once when the user first authenticates. Probes /api/health (Supabase
  // PostgREST) and logs results to the console. Non-blocking — result is only
  // used for diagnostics, never gates app flow.
  const healthCheckedRef = useRef(false);
  useEffect(() => {
    if (!user || healthCheckedRef.current) return;
    healthCheckedRef.current = true;
    const t0 = performance.now();
    console.log("[SETUP] HEALTH_CHECK start — userId =", user.id.slice(0, 8));
    fetch(API_BASE + "/api/health")
      .then(r => r.json())
      .then(data => {
        const ms = Math.round(performance.now() - t0);
        const supaOk = data?.supabase?.ok;
        const supaMs = data?.supabase?.ms;
        const supaErr = data?.supabase?.error;
        if (supaOk) {
          console.log(`[SETUP] HEALTH_CHECK ✓ supabase PostgREST ok in ${supaMs}ms (round-trip ${ms}ms)`);
        } else {
          console.error(`[SETUP] HEALTH_CHECK ✗ supabase PostgREST FAILED in ${supaMs}ms — ${supaErr} (round-trip ${ms}ms)`);
        }
      })
      .catch(err => {
        console.error("[SETUP] HEALTH_CHECK: fetch failed —", err?.message);
      });
  }, [user?.id]);

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
    // Auto-retry twice (3 attempts total) before surfacing the error screen.
    // Each attempt has a 15 s AbortController abort in checkProfileExists().
    // SPINNER_TIMEOUT_MS is set to 55 s to give all 3 attempts room to breathe
    // (3 × 15 s + exponential delays ≈ 55 s) before the spinner-timeout fires.
    retry: 2,
    // Exponential back-off: 2 s → 8 s between attempts (capped at 8 s).
    // Gives transient network blips and Supabase cold-starts time to recover
    // without burning through all retries in under 2 seconds.
    retryDelay: (attempt: number) => Math.min(2000 * 2 ** attempt, 8000),
    staleTime: Infinity,
  });

  // profileHasData is true once the query has settled with a real result (success or error).
  // Used to prevent the onboarding guard from firing during the brief window where
  // isPending transitions to false but data hasn't arrived yet (e.g., after cache clear).
  const profileHasData = data !== undefined;
  const profileExists = data?.exists ?? false;
  // fetchFailed is true only after all retries are exhausted (isError=true).
  const fetchFailed = profileError;

  // ── Call-audio guard for logged-out state ────────────────────────────────────
  // Whenever user becomes null (sign-out, session expiry, or auth error), stop
  // all call audio immediately. This covers the edge case where an overlay crash
  // left _ringtoneActive=true in the module-level state — without this, the next
  // user gesture on the Landing page would trigger _warmElements() which would
  // start the ringtone audibly (warm-up skips muted=true when _ringtoneActive=true).
  // CallDetectors also stops audio on unmount, but this effect adds belt-and-suspenders
  // coverage for any rendering path that doesn't go through CallDetectors.
  useEffect(() => {
    if (!user) {
      stopAllCallSounds("no_auth_user_null");
      console.log("[CALL_AUDIO_GUARD] blocked call audio because user is logged out");
    }
  }, [user]);

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
    queryClient.prefetchQuery({ queryKey: ["/api/popular"] });
    queryClient.prefetchQuery({ queryKey: ["/api/spin-status"] });
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

  // ── Connection DNA gate ──────────────────────────────────────────────────────
  // Checks whether the current user has completed the Connection DNA questionnaire.
  // Enabled only after profile is confirmed (effectiveProfileExists).
  // Fail-open: if the query errors, dnaComplete defaults to true so existing
  // users are never blocked by a transient Railway failure.
  const { data: dnaData, isPending: dnaIsPending, isError: dnaIsError } = useQuery<{ completed: boolean; hasDna: boolean }>({
    queryKey: ["dna-status-check"],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/dna/status`, { headers });
      if (!res.ok) return { completed: true, hasDna: false }; // fail-open on server error
      return res.json();
    },
    enabled: !!user && profileReady && !clearingCache && effectiveProfileExists && !forceProceed,
    staleTime: Infinity,
    retry: 1,
    retryDelay: 1000,
  });
  // fail-open: missing/errored data → assume complete so existing users aren't blocked
  const dnaComplete: boolean = dnaData?.completed ?? true;

  // profilePending = query has no data yet (covers the gap between "enabled"
  // and "fetch started" that caused isLoading to briefly be false).
  // forceProceed collapses the spinner immediately when the user bypasses.
  // !fetchFailed && !profileHasData: extra guard for the rare window where isPending
  // is briefly false but data hasn't arrived yet (e.g., after queryClient.clear()),
  // preventing a momentary flash of the onboarding screen for existing users.
  const isSpinning = !forceProceed && !authLoading && !!user &&
    (clearingCache || profilePending || !profileReady || (!fetchFailed && !profileHasData));

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

  // ── Fetch failure log + online auto-retry ───────────────────────────────────
  // Log when all TanStack Query retries are exhausted.  No manual auto-retry loop
  // here because it creates an infinite spinner cycle: after 12 s of retries the
  // spinner stops (isError=true → isPending=false), which cancels the 15 s
  // timeout timer before it can set spinnerTimedOut=true, so the circuit
  // breaker never engages and the loop repeats forever.
  // The "Try Again" button on the error screen lets the user retry manually.
  // Exception: when the browser goes back online we auto-retry once silently.
  useEffect(() => {
    if (!fetchFailed) return;
    console.error("[SETUP] FETCH_FAILED: all retries exhausted — showing error screen", {
      userId: user?.id,
    });
    console.log("[AUTH_FLOW] profile fetch failed — reconnect screen shown to user", { userId: user?.id });
    // Auto-retry whenever the device comes back online (e.g., lost Wi-Fi, airplane mode).
    // This means the reconnect screen dismisses itself without the user tapping "Try Again".
    const onOnline = () => {
      console.log("[AUTH_FLOW] network back online — auto-retrying profile fetch", { userId: user?.id });
      queryClient.resetQueries({ queryKey: ["profile-exists-check"] });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
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
    ? "reconnecting…"
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

  // ── Auth callback route ────────────────────────────────────────────────────
  // Must sit BEFORE every auth gate (authLoading, !user, email gates) because
  // the user is in the process of becoming authenticated when they land here.
  // All hooks above are still called unconditionally — this is a safe early
  // return that doesn't violate React rules.
  if (location === "/auth/callback") {
    return <AuthCallbackPage />;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  // ── Session bootstrap failure gate ───────────────────────────────────────
  // Shown after any auth event (SIGNED_IN, INITIAL_SESSION, PASSWORD_RECOVERY)
  // when the application-level session could not be registered (server error or
  // network failure).  Protected queries stay blocked until the user retries or
  // signs out.  A valid Supabase JWT alone never grants access to protected APIs.
  if (sessionBootstrapFailed) {
    console.log("[SETUP] FINAL_APP_GATE: session_bootstrap_failed — showing retry screen");
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-5 max-w-sm px-6 text-center">
          <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="w-7 h-7 text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Session verification failed</h2>
            <p className="text-sm text-muted-foreground">
              We couldn't verify your session with the server. This may be a temporary issue.
            </p>
          </div>
          <div className="flex flex-col gap-2 w-full">
            <button
              onClick={() => retrySessionBootstrap()}
              className="w-full py-2.5 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => logout()}
              className="w-full py-2.5 px-4 rounded-lg border border-border bg-background text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    console.log("[AUTH_FLOW] no session — showing landing");
    console.log("[SETUP] FINAL_APP_GATE: no_user — showing landing");
    return <Landing />;
  }

  // ── Password recovery gate ────────────────────────────────────────────────
  // Fires when the user arrives via a password-reset email link.
  // detectSessionInUrl:true reads the #access_token=...&type=recovery hash and
  // fires onAuthStateChange(PASSWORD_RECOVERY), which sets passwordRecovery=true.
  // Show the reset form immediately — before any other gate — so the user can
  // set their new password without being sent to the verification or onboarding
  // flow first.
  if (passwordRecovery) {
    console.log("[SETUP] FINAL_APP_GATE: password_recovery — showing PasswordRecoveryGate", { userId: user.id });
    return <PasswordRecoveryGate onDone={clearPasswordRecovery} />;
  }

  // ── Email verification gate ───────────────────────────────────────────────
  // If the user has a session but hasn't confirmed their email, block access
  // to the app and prompt them to verify. email_confirmed_at is null until
  // the user clicks the confirmation link sent by Supabase on sign-up.
  if (!user.email_confirmed_at) {
    console.log("[SETUP] FINAL_APP_GATE: email_not_confirmed — showing verification screen", { userId: user.id });
    return <VerifyEmailGate email={user.email ?? undefined} onSignOut={logout} />;
  }

  // ── Server-side email gate (auto-confirmed accounts) ─────────────────────
  // Handles the case where Supabase "Confirm email" is OFF: signUp() auto-sets
  // email_confirmed_at=created_at, so the check above never fires.  Our server
  // detects this via the timestamp heuristic and returns 403 EMAIL_NOT_VERIFIED.
  if (serverEmailGate === "required") {
    console.log("[SETUP] FINAL_APP_GATE: server_email_gate_required — OTP needed", { userId: user.id });
    return (
      <VerifyEmailGate
        email={user.email ?? undefined}
        onSignOut={logout}
        otpMode
        onOtpVerified={() => setServerEmailGate("ok")}
      />
    );
  }
  if (serverEmailGate === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  // ── Stripe success page bypass ────────────────────────────────────────────
  // /extras/success and /elevate/success must render immediately after auth is
  // confirmed — they must NOT be gated behind the profile-exists check.
  // If the profile check fails transiently on the Stripe return (race condition
  // or network blip), the app would show a "Taking a little longer" error screen
  // and the session_id URL param — which is required to activate the purchase —
  // would be silently lost when the user taps "Try Again" or navigates away.
  // Auth (user non-null, email confirmed) is already verified above this point.
  if (
    window.location.pathname === "/extras/success" ||
    window.location.pathname === "/elevate/success"
  ) {
    return (
      <Switch>
        <Route path="/elevate/success" component={ElevateSuccessPage} />
        <Route path="/extras/success" component={ExtrasSuccessPage} />
      </Switch>
    );
  }

  // ── EARLY BYPASS EXIT ─────────────────────────────────────────────────────
  // forceProceed=true means the user explicitly tapped "Continue to App" on a
  // blocked screen.  This guard is placed BEFORE every other intermediate gate
  // (spinner, fetchFailed, onboarding) so that no TanStack Query state flip,
  // retry cycle, or effect batching can prevent the main app from rendering.
  // Auth is already confirmed above (user is non-null, authLoading=false).
  if (forceProceed) {
    console.warn("[SETUP] FINAL_APP_GATE: render_main_app (force_proceed_early_exit)", {
      userId: user.id, profileExists, fetchFailed, isSpinning,
      spinnerTimedOut, profilePending, clearingCache, profileReady,
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

  if (isSpinning) {
    if (spinnerTimedOut) {
      // The spinner ran past SPINNER_TIMEOUT_MS — all retries exhausted; show recovery screen.
      const _errDetail = (profileFetchError as Error | null)?.message ?? null;
      console.warn("[SETUP] FINAL_APP_GATE: blocked_by_loading_state (spinner_timeout)", {
        userId: user.id, clearingCache, profilePending, profileReady, spinnerTimedOut, errDetail: _errDetail,
      });
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4 text-center px-6 max-w-sm w-full">
            <p className="text-2xl font-serif font-semibold" data-testid="text-timeout-title">Taking a little longer than usual.</p>
            <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-timeout-body">
              Your account is safe. We're reconnecting you to Lulou.
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <button
                className="px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
                onClick={async () => {
                  console.warn("[SETUP] RETRY: user tapped Try Again on timeout screen", { userId: user?.id });
                  // Force a Supabase session refresh before retrying — if the token
                  // expired while the spinner was running, resetQueries would just
                  // fetch with the same stale JWT and get another 401.
                  const refreshed = await refreshAuthToken();
                  console.log("[SETUP] RETRY: token refresh result", { refreshed, userId: user?.id });
                  setSpinnerTimedOut(false);
                  spinnerStartRef.current = null;
                  queryClient.resetQueries({ queryKey: ["profile-exists-check"] });
                }}
                data-testid="button-retry-setup"
              >
                Try Again
              </button>
              <button
                className="px-5 py-2.5 rounded-full border text-sm font-medium hover:bg-muted transition-all"
                onClick={logout}
                data-testid="button-signout-setup"
              >
                Sign Out
              </button>
            </div>
            <p className="text-xs text-muted-foreground/60 mt-1">
              If this keeps happening, close and reopen the app.
            </p>
            <DiagPanel />
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
    console.log("[AUTH_FLOW] profile fetch failed — reconnect screen", { userId: user.id });
    console.warn("[SETUP] FINAL_APP_GATE: blocked_by_profile_gate", {
      userId: user.id, fetchFailed, profileExists, effectiveProfileExists, forceProceed,
    });
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center px-6 max-w-sm w-full">
          <p className="text-2xl font-serif font-semibold" data-testid="text-fetch-failed-title">Taking a little longer than usual.</p>
          <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-fetch-failed-body">
            Your account is safe. We're reconnecting you to Lulou.
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              className="px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:brightness-110 transition-all"
              onClick={async () => {
                console.warn("[SETUP] RETRY: user tapped Try Again on fetch-failed screen", { userId: user?.id });
                // Force a Supabase session refresh before retrying — without this,
                // if the root cause was an expired JWT, getAuthHeaders() returns
                // the same stale token → server returns 401 → reconnect screen stays.
                const refreshed = await refreshAuthToken();
                console.log("[SETUP] RETRY: token refresh result", { refreshed, userId: user?.id });
                queryClient.resetQueries({ queryKey: ["profile-exists-check"] });
              }}
              data-testid="button-retry-profile"
            >
              Try Again
            </button>
            <button
              className="px-5 py-2.5 rounded-full border text-sm font-medium hover:bg-muted transition-all"
              onClick={logout}
              data-testid="button-signout-profile"
            >
              Sign Out
            </button>
          </div>
          <p className="text-xs text-muted-foreground/60 mt-1">
            If this keeps happening, close and reopen the app.
          </p>
          <DiagPanel />
        </div>
      </div>
    );
  }

  if (!effectiveProfileExists) {
    console.log("[AUTH_FLOW] profile missing — route onboarding", { userId: user.id, profileHasData, profileExists });
    console.log("[SETUP] FINAL_APP_GATE: blocked_by_onboarding_guard", {
      userId: user.id, profileExists, effectiveProfileExists, fetchFailed, profilePending, profileHasData,
    });
    return (
      <Onboarding existingProfile={null} userEmail={user?.email ?? ""} />
    );
  }

  // ── Connection DNA gate ──────────────────────────────────────────────────────
  // Profile exists but DNA quiz not yet completed → show the quiz.
  // Show a brief spinner while the status is loading.
  // Skip entirely for force-proceed bypasses (support tool for stuck users).
  if (!forceProceed && dnaIsPending && !dnaIsError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (!forceProceed && !dnaComplete) {
    console.log("[AUTH_FLOW] dna incomplete — route connection-dna", { userId: user.id });
    return <ConnectionDnaPage />;
  }

  console.log("[AUTH_FLOW] session restored — route main app", { userId: user.id });
  return (
    <Switch>
      <Route path="/elevate/success" component={ElevateSuccessPage} />
      <Route path="/extras/success" component={ExtrasSuccessPage} />
      <Route path="/admin/diagnostics" component={AdminDiagnosticsPage} />
      <Route path="/admin/payment-sim" component={AdminPaymentSimPage} />
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
  // Register Service Worker for push notifications (once, at root level).
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(reg => console.log("[SW] Registered:", reg.scope))
        .catch(err => console.warn("[SW] Registration failed:", err?.message));
    }
  }, []);

  // useEffect must be called unconditionally (Rules of Hooks).
  // The supabaseConfigError guard comes AFTER the hook.
  useEffect(() => {
    if (supabaseConfigError) return; // no perf tracking needed on config error

    // First-paint timing — fires after React mounts the root for the first time.
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

  // ── Supabase config guard — after all hooks ────────────────────────────────
  // If VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY are missing (Vercel env
  // vars not set), show a clear actionable error instead of a blank page.
  if (supabaseConfigError) {
    return <SupabaseConfigErrorScreen message={supabaseConfigError} />;
  }

  return (
    <AppRootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <UnitsProvider>
            <AuthProvider>
              <TooltipProvider>
                <Toaster />
                <AppContent />
                <CallDiagnosticsButton />
                <PurchaseDebugPanel />
                {import.meta.env.DEV && PerfOverlayLazy && (
                  <Suspense fallback={null}>
                    <PerfOverlayLazy />
                  </Suspense>
                )}
              </TooltipProvider>
            </AuthProvider>
          </UnitsProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </AppRootErrorBoundary>
  );
}

export default App;
