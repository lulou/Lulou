import { Switch, Route, useLocation } from "wouter";
import { createContext, useContext, useState, useCallback, useEffect, useRef, useReducer } from "react";
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

// ── Global debug store ───────────────────────────────────────────────────────
// Imported from a shared module so landing.tsx and use-auth.ts can also write
// to it without creating circular dependencies.
import { _dbg, _dbgListeners, writeDebug } from "@/lib/debug-store";
import { TabActiveContext } from "@/hooks/use-tab-active";

function DebugOverlay() {
  const [, tick] = useReducer(n => n + 1, 0);
  const [open, setOpen] = useState(false); // collapsed by default — stops it from covering form inputs

  useEffect(() => {
    _dbgListeners.add(tick);
    return () => { _dbgListeners.delete(tick); };
  }, []);

  const s = _dbg;
  const gateColor = s.finalGateDecision.startsWith("render_main_app") ? "#22c55e" : "#f97316";

  const row = (label: string, value: string | boolean | null, highlight?: boolean) => (
    <div style={{ display: "flex", gap: 4 }}>
      <span style={{ color: "#94a3b8", minWidth: 140 }}>{label}</span>
      <span style={{ color: highlight ? gateColor : typeof value === "boolean" ? (value ? "#86efac" : "#fca5a5") : "#e2e8f0", fontWeight: highlight ? 700 : 400 }}>
        {String(value ?? "null")}
      </span>
    </div>
  );

  return (
    <div
      data-testid="debug-overlay"
      style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999,
        background: "rgba(15,23,42,0.97)", borderTop: "1px solid #334155",
        fontFamily: "monospace", fontSize: 10, color: "#e2e8f0",
        maxHeight: open ? 280 : 22, overflow: "hidden", transition: "max-height 0.2s",
      }}
    >
      {/* Header bar — always visible */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px",
          background: "rgba(30,41,59,0.98)", cursor: "pointer", borderBottom: open ? "1px solid #334155" : "none" }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ color: gateColor, fontWeight: 700 }}>{s.finalGateDecision}</span>
        {s.errors.length > 0 && <span style={{ color: "#f87171", marginLeft: 8 }}>⚠ {s.errors.length} error{s.errors.length > 1 ? "s" : ""}</span>}
        <span style={{ marginLeft: "auto", color: "#64748b" }}>{open ? "▼ hide" : "▲ debug"}</span>
      </div>

      {/* Body */}
      {open && (
        <div style={{ display: "flex", gap: 16, padding: "6px 10px", overflowX: "auto" }}>
          {/* State column */}
          <div style={{ minWidth: 220 }}>
            {row("userId", s.userId ? s.userId.slice(0, 12) + "…" : null)}
            {row("authReady", s.authReady)}
            {row("sessionExists", s.sessionExists)}
            {row("profileExists", s.profileExists)}
            {row("effectiveProfileExists", s.effectiveProfileExists)}
            {row("fetchFailed", s.fetchFailed)}
            {row("spinnerTimedOut", s.spinnerTimedOut)}
            {row("forceProceed", s.forceProceed)}
            {row("onboardingComplete", s.onboardingComplete)}
            {row("route", s.route)}
            {row("phase", s.phase)}
            {row("finalGateDecision", s.finalGateDecision, true)}
            {row("storage[bypass]", sessionStorage.getItem("lulou-bypass") ?? "null")}
          </div>

          {/* Form-wiring column */}
          <div style={{ minWidth: 200 }}>
            <div style={{ color: "#94a3b8", marginBottom: 4 }}>FORM WIRING</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>identifierInputState</span>
              <span style={{ color: s.identifierInputState ? "#4ade80" : "#475569", wordBreak: "break-all" }}>
                {s.identifierInputState ?? "null"}
              </span>
            </div>
            {row("identifierValuePropName", s.identifierValuePropName)}
            {row("passwordValuePropName", s.passwordValuePropName)}
            {row("renderCount", s.renderCount)}
            {row("passwordInputLength", s.passwordInputLength)}
            {row("onChangeIdentifierFiring", s.onChangeIdentifierFiring)}
            {row("onChangePasswordFiring", s.onChangePasswordFiring)}
            {row("submitButtonClicked", s.submitButtonClicked)}
            {row("formOnSubmitFired", s.formOnSubmitFired)}
            {row("submitHandlerEntered", s.submitHandlerEntered)}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>submitBlockedReason</span>
              <span style={{ color: s.submitBlockedReason ? "#f87171" : "#475569" }}>
                {s.submitBlockedReason ?? "null"}
              </span>
            </div>
          </div>

          {/* Auth-flow trace column */}
          <div style={{ minWidth: 220 }}>
            <div style={{ color: "#94a3b8", marginBottom: 4 }}>AUTH FLOW</div>
            {row("submittedIdentifier", s.submittedIdentifier ?? "null")}
            {row("submittedPasswordPresent", s.submittedPasswordPresent)}
            {row("signInStarted", s.signInStarted)}
            {row("signInCallEntered", s.signInCallEntered)}
            {row("signInAwaitCompleted", s.signInAwaitCompleted)}
            {row("rawSignInResultExists", s.rawSignInResultExists)}
            {row("rawSignInDataExists", s.rawSignInDataExists)}
            {row("rawSignInErrorExists", s.rawSignInErrorExists)}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>rawSignInResult</span>
              <span style={{ color: "#e2e8f0", wordBreak: "break-all", fontSize: 9 }}>
                {s.rawSignInResultString ?? "null"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>rawSignInError</span>
              <span style={{ color: s.rawSignInErrorString && s.rawSignInErrorString !== "null" ? "#f87171" : "#475569", wordBreak: "break-all", fontSize: 9 }}>
                {s.rawSignInErrorString ?? "null"}
              </span>
            </div>
            {row("submitHandlerReturnedEarly", s.submitHandlerReturnedEarly)}
            {row("submitHandlerCatchTriggered", s.submitHandlerCatchTriggered)}
            {row("signInReturnedUser", s.signInReturnedUser)}
            {row("signInReturnedSession", s.signInReturnedSession)}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>signInErrorMessage</span>
              <span style={{ color: s.signInErrorMessage ? "#f87171" : "#475569", wordBreak: "break-all" }}>
                {s.signInErrorMessage ?? "null"}
              </span>
            </div>
            {row("signInErrorStatus", s.signInErrorStatus ?? "null")}
            {row("signInErrorName", s.signInErrorName ?? "null")}
            {row("signInErrorCode", s.signInErrorCode ?? "null")}
            {row("authEvent", s.authEvent ?? "null")}
            {row("currentSessionUserId", s.currentSessionUserId
              ? s.currentSessionUserId.slice(0, 12) + "…"
              : "null")}
            {row("noSessionAutoSignIn", s.signupNoSessionAttemptingAutoSignIn)}
            {row("autoSignInAfterSignup", s.autoSignInAfterSignup)}
            {row("emailConfirmRequired", s.emailConfirmationRequired)}
          </div>

          {/* Signup trace column */}
          <div style={{ minWidth: 220 }}>
            <div style={{ color: "#94a3b8", marginBottom: 4 }}>SIGNUP TRACE</div>
            {/* In-flight guard fields */}
            {row("authInProgress", s.authRequestInProgress, true)}
            {row("authCallsThisAttempt", s.authCallsThisAttempt, s.authCallsThisAttempt > 1)}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>lastAuthAction</span>
              <span style={{ color: s.lastAuthAction ? "#4ade80" : "#475569", wordBreak: "break-all", fontSize: 9 }}>
                {s.lastAuthAction ?? "null"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>signupMethodUsed</span>
              <span style={{ color: s.signupMethodUsed ? "#4ade80" : "#475569", wordBreak: "break-all", fontSize: 9 }}>
                {s.signupMethodUsed ?? "null"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>signupEndpoint</span>
              <span style={{ color: s.signupEndpointCalled ? "#4ade80" : "#475569", wordBreak: "break-all", fontSize: 9 }}>
                {s.signupEndpointCalled ?? "null"}
              </span>
            </div>
            {row("signUpStarted", s.signUpStarted)}
            {row("signUpReturnedUser", s.signUpReturnedUser)}
            {row("signUpReturnedSession", s.signUpReturnedSession)}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
              <span style={{ color: "#94a3b8", minWidth: 140 }}>signUpErrMsg</span>
              <span style={{ color: s.signUpErrorMessage ? "#f87171" : "#475569", wordBreak: "break-all", fontSize: 9 }}>
                {s.signUpErrorMessage ?? "null"}
              </span>
            </div>
            {row("signUpErrStatus", s.signUpErrorStatus ?? "null")}
            {row("signUpErrCode", s.signUpErrorCode ?? "null")}
            {row("postSignupNavigate", s.postSignupNavigateCalled)}
            {row("profileCreateStart", s.postSignupProfileCreateStarted)}
            {row("profileCreateOK", s.postSignupProfileCreateSucceeded)}
            {row("authStateChangeEvt", s.authEvent ?? "null")}
            {row("currentSessionUID", s.currentSessionUserId
              ? s.currentSessionUserId.slice(0, 12) + "…"
              : "null")}
            {row("sessionExists", s.sessionExists)}
            {row("finalGateDecision", s.finalGateDecision, true)}
          </div>

          {/* Errors column */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ color: "#94a3b8", marginBottom: 4 }}>ERRORS ({s.errors.length})</div>
            {s.errors.length === 0
              ? <div style={{ color: "#475569" }}>none</div>
              : s.errors.map((e, i) => (
                <div key={i} style={{ color: "#f87171", marginBottom: 2, wordBreak: "break-all" }}>{e}</div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

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

  // Face calls happen at callStage === 3 (after both users accept the face call opt-in).
  // Stage 2 is the post-second-call messaging phase — no calls are allowed there.
  const isFaceCall = incomingCall
    ? (incomingCall.callStage || 0) === 3 &&
      !!incomingCall.faceCallUser1Accepted &&
      !!incomingCall.faceCallUser2Accepted
    : false;

  const isActiveVideo = activeCall
    ? (activeCall.callStage || 0) === 3 &&
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

// How long the "Setting up your experience" spinner is allowed to show before
// we cut it off and display a retry screen.  Covers the worst-case Supabase
// cold-start window (5 retries × 5 s = 25 s) without trapping users forever.
const SPINNER_TIMEOUT_MS = 15_000;

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
      return checkProfileExists().then(result => {
        console.log("[SETUP] PROFILE_FETCH_SUCCESS", { userId: user.id, profileExists: result.exists });
        return result;
      });
    },
    enabled: !!user && profileReady && !clearingCache,
    // 3 retries at 4 s each (12 s total) — enough to survive a Supabase
    // cold-start blip.
    retry: 3,
    retryDelay: 4000,
  });

  const profileExists = data?.exists ?? false;
  // fetchFailed is true only after all retries are exhausted (isError=true).
  const fetchFailed = profileError;

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
    return <Onboarding existingProfile={null} userEmail={user?.email ?? ""} />;
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

function App() {
  useEffect(() => {
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
        <DebugOverlay />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
