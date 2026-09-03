import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Heart, MessageCircle, Phone, Shield, RefreshCw, Loader2, Lock, Eye, EyeOff, AlertCircle, WifiOff, CheckCircle, ChevronDown, ChevronUp, Clock, Mic, Video, X, ArrowRight, Users, Calendar, Dna } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { supabase, lastAuthFetchDebug, resetAuthFetchDebug, SUPABASE_URL, SUPABASE_KEY_LEN, AUTH_ENDPOINT } from "@/lib/supabase";
import {
  classifyVerificationDeliveryError,
  getApprovedCallbackUrl,
  sendVerificationResend,
} from "@/lib/auth-helpers";
import { useToast } from "@/hooks/use-toast";
import { writeDebug, pushDebugError } from "@/lib/debug-store";
import { useLanguageContext } from "@/contexts/language-context";
import { useAuth } from "@/hooks/use-auth";

type AuthMode = "signin" | "signup";
type AuthErrorKind = "credentials" | "already-exists" | "network" | "rate-limit" | "delivery" | "auth";

interface AuthError {
  kind: AuthErrorKind;
  message: string;
}

function isAlreadyExists(err: any): boolean {
  const msg: string = (err?.message || "").toLowerCase();
  return (
    msg.includes("user already registered") ||
    msg.includes("already registered") ||
    msg.includes("already been registered") ||
    msg.includes("email address is already taken") ||
    msg.includes("already exists") ||
    err?.status === 422 ||
    // When Supabase email confirmation is ON, signUp() with an already-confirmed
    // email returns invalid_credentials (400) instead of "user already registered"
    // to prevent email enumeration. This only reaches isAlreadyExists() during
    // signup mode — during sign-in, credentials errors are handled separately.
    err?.code === "invalid_credentials" ||
    (err?.status === 400 && msg.includes("invalid login credentials"))
  );
}

function classifyAuthError(err: any, mode: AuthMode): AuthError {
  // ── Timeout: the 30s Promise.race fired — Supabase never answered ─────────
  // Detected by the explicit code set on the timeout Error object.
  // Always treated as a connection problem, never as a credentials error.
  if (err?.code === "timeout") {
    return {
      kind: "network",
      message: "Lulou is having trouble reaching the login service right now. Please try again shortly.",
    };
  }

  // ── HTML / non-JSON response intercepted by safeFetch ────────────────────
  // When safeFetch detects a non-JSON body from /auth/v1/, it returns a
  // synthetic JSON response containing code "html_response_outage" so the SDK
  // surfaces a clean AuthApiError instead of a SyntaxError.
  if (err?.code === "html_response_outage") {
    return {
      kind: "network",
      message: "Lulou is having trouble reaching the login service right now. Please try again shortly.",
    };
  }

  // ── HTML / non-JSON response from Supabase or a proxy ──────────────────────
  // When the Supabase auth server is degraded, Cloudflare (or the server) can
  // return an HTML error page instead of JSON. The Supabase JS SDK internally
  // calls response.json(), fails, and surfaces the error as:
  //   "Failed to create user: unexpected token '<', "<!DOCTYPE"... is not valid JSON"
  //   "unexpected token '<' at position 0"
  // These do NOT match credentials keywords, so without this check they fall
  // through to kind:"auth" and show a raw parse-error string to the user.
  // Detect the HTML/parse-error signature and reclassify as a network outage.
  const _rawMsg: string = (err?.message ?? "").toLowerCase();
  if (
    _rawMsg.includes("unexpected token") ||
    _rawMsg.includes("not valid json") ||
    _rawMsg.includes("<!doctype") ||
    _rawMsg.includes("<html") ||
    _rawMsg.includes("failed to create user") ||
    _rawMsg.includes("failed to sign up") ||
    _rawMsg.includes("failed to sign in") ||
    _rawMsg.includes("json.parse") ||
    _rawMsg.includes("syntaxerror")
  ) {
    return {
      kind: "network",
      message: "Lulou is having trouble reaching the login service right now. Please try again shortly.",
    };
  }

  // ── Email rate limit (429) ────────────────────────────────────────────────
  // Supabase returns status 429 with code "over_email_send_rate_limit" when too
  // many signup/magic-link emails have been sent in a short window. This is NOT
  // a credentials error — classify it separately so the UI shows a calm, clear
  // message and never triggers credential-error styling.
  if (
    err?.status === 429 ||
    err?.code === "over_email_send_rate_limit" ||
    err?.code === "too_many_requests" ||
    (err?.message ?? "").toLowerCase().includes("email rate limit") ||
    (err?.message ?? "").toLowerCase().includes("over_email_send_rate_limit") ||
    (err?.message ?? "").toLowerCase().includes("too many requests") ||
    (err?.message ?? "").toLowerCase().includes("too many emails")
  ) {
    return {
      kind: "rate-limit",
      message: "Too many verification emails were requested. Please wait before trying again.",
    };
  }

  // ── Supabase sometimes returns {} or a raw JSON string as the error body ──
  let raw: string = err?.message ?? "";
  if (!raw || raw === "{}" || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      const parsed = JSON.parse(raw);
      raw =
        parsed?.error_description ||
        parsed?.message ||
        parsed?.msg ||
        parsed?.error ||
        "";
    } catch { /* raw stays as-is */ }
  }
  const msg: string = raw || "Something went wrong. Please try again.";
  const lower = msg.toLowerCase();

  if (mode === "signup" && isAlreadyExists(err)) {
    return { kind: "already-exists", message: "An account with this email already exists. Please sign in instead." };
  }

  // ── Email not confirmed ───────────────────────────────────────────────────
  // Supabase returns "Email not confirmed" when the user signed up with email
  // confirmation ON but hasn't clicked the link yet.
  // This is NOT a credentials error — the password is correct.  Showing
  // "Incorrect email or password" would completely mislead the user.
  // Must be checked BEFORE the generic credentials block below.
  if (lower.includes("email not confirmed")) {
    return {
      kind: "auth",
      message: "Your email hasn't been confirmed yet. Check your inbox for the confirmation link, then try signing in again.",
    };
  }

  if (
    lower.includes("invalid login credentials") ||
    lower.includes("invalid_grant") ||
    lower.includes("user not found") ||
    lower.includes("wrong password") ||
    (err as any)?.code === "invalid_credentials"
  ) {
    return {
      kind: "credentials",
      message: "Email or password is incorrect. Use 'Forgot password?' if you haven't set one or have forgotten it.",
    };
  }
  if (
    err instanceof TypeError ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("load failed") ||       // Safari equivalent of "Failed to fetch"
    lower.includes("networkerror") ||
    lower.includes("connection") ||
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    const detail =
      msg === "Load failed" || msg === "Failed to fetch"
        ? "Lulou couldn't reach the login server. Check your internet connection and try again."
        : "Lulou couldn't reach the login server. Please try again.";
    return { kind: "network", message: detail };
  }
  return { kind: "auth", message: msg };
}

// Raw error detail captured directly from the Supabase error/exception object.
// Shown verbatim in the UI so the user can see exactly what came back.
interface RawAuthError {
  message: string;
  status: string;
  name: string;
  code: string;
}

export default function Landing() {
  const { forcedLogoutNotice, dismissForcedLogoutNotice } = useAuth();
  const { t } = useLanguageContext();
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [rawAuthError, setRawAuthError] = useState<RawAuthError | null>(null);
  const [showRawError, setShowRawError] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0); // seconds remaining
  const [rateLimitCooldown, setRateLimitCooldown] = useState(0); // signup rate-limit countdown
  const [rateLimitEmail, setRateLimitEmail] = useState<string | null>(null); // email that hit rate-limit
  // Forgot-password pre-check: set to the stored session's email when a live
  // session is detected so the user can choose to sign out first or keep it.
  const [fpSignOutPrompt, setFpSignOutPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  useEffect(() => {
    if (rateLimitCooldown <= 0) return;
    const id = setInterval(() => setRateLimitCooldown(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [rateLimitCooldown]);
  const { toast } = useToast();

  // Refs to the actual DOM inputs — read directly in handleSubmit to cover
  // browser autofill which sets the DOM value without firing React's onChange.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Ref to the <form> — used by the "Try Again" button in the error panel to
  // re-trigger form submission without the user having to scroll to the submit button.
  const formRef = useRef<HTMLFormElement>(null);

  // In-flight guard — prevents duplicate auth calls from double-clicks or
  // rapid "Try Again" presses.  useRef so the check is synchronous (React
  // state updates are async and can't be read back in the same event tick).
  const authInProgressRef = useRef(false);
  // Counter for how many auth SDK calls fire per user action — shown in overlay.
  const authCallCountRef = useRef(0);

  // Track render count to detect unexpected remounts/re-renders.
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    writeDebug({
      renderCount: renderCountRef.current,
      identifierValuePropName: "email",
      passwordValuePropName: "password",
    });
  });

  // Show the current runtime's scoped notice once. It is intentionally not kept
  // in browser storage, so it cannot survive a PWA restart or leak to another user.
  useEffect(() => {
    if (forcedLogoutNotice?.reason === "session_replaced") {
      toast({
        title: "You've been signed out",
        description: "You were signed out because this account was opened on another device.",
        variant: "destructive",
      });
      dismissForcedLogoutNotice();
    }
  }, [forcedLogoutNotice, dismissForcedLogoutNotice, toast]);

  // ── Supabase reachability test ────────────────────────────────────────────
  type ReachResult = {
    running:     boolean;
    resolved:    boolean | null;
    timedOut:    boolean;
    status:      number | null;
    contentType: string | null;
    body:        string;
    error:       string | null;
    endpointHit: string;
  };
  const [reachResult, setReachResult] = useState<ReachResult>({
    running: false, resolved: null, timedOut: false,
    status: null, contentType: null, body: "", error: null, endpointHit: "",
  });

  async function runReachabilityTest() {
    const endpoint = `${SUPABASE_URL}/auth/v1/health`;
    setReachResult(r => ({ ...r, running: true, resolved: null, timedOut: false,
      status: null, contentType: null, body: "", error: null, endpointHit: endpoint }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const resp = await window.fetch(endpoint, {
        method: "GET",
        headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ct = resp.headers.get("content-type") ?? "(none)";
      let body = "";
      try { body = (await resp.text()).slice(0, 300); } catch { body = "(body read failed)"; }
      setReachResult({ running: false, resolved: true, timedOut: false,
        status: resp.status, contentType: ct, body, error: null, endpointHit: endpoint });
    } catch (err: any) {
      clearTimeout(timer);
      const isAbort = err?.name === "AbortError";
      setReachResult({ running: false, resolved: false, timedOut: isAbort,
        status: null, contentType: null, body: "",
        error: `${err?.name}: ${err?.message}`, endpointHit: endpoint });
    }
  }

  function cancelRateLimit(reason: "use-different-email" | "sign-in-instead") {
    console.log("[VERIFY] PENDING_SIGNUP_CANCELLED", { reason });
    sessionStorage.removeItem("lulou_pending_verification_email");
    sessionStorage.removeItem("lulou_rate_limit_pending");
    setRateLimitEmail(null);
    setRateLimitCooldown(0);
    setAuthError(null);
    setRawAuthError(null);
  }

  function resetForm() {
    setEmail("");
    setPassword("");
    setMode("signin");
    setShowPassword(false);
    setAuthError(null);
    setRawAuthError(null);
    setShowRawError(false);
    setResetSent(false);
    setResetError(null);
    setRateLimitEmail(null);
    setRateLimitCooldown(0);
    sessionStorage.removeItem("lulou_rate_limit_pending");
  }

  function clearError() {
    if (authError) setAuthError(null);
    if (rawAuthError) setRawAuthError(null);
    setResetSent(false);
  }

  function switchToSignIn() {
    setMode("signin");
    setAuthError(null);
    setPassword("");
    setResetSent(false);
    setRateLimitEmail(null);
    setRateLimitCooldown(0);
    sessionStorage.removeItem("lulou_rate_limit_pending");
  }

  async function handlePasswordReset() {
    if (!email.trim()) return;

    // ── Pre-check: is there a stored Supabase session? ───────────────────────
    // Spec requirement: do not silently sign out a stored session; show the user
    // an explicit choice so they understand what is happening and can opt out.
    // The session may belong to a DIFFERENT account than the email typed in the
    // form, so we always ask rather than assuming it's safe to auto-clear.
    try {
      const { data: { session: storedSession } } = await supabase.auth.getSession();
      if (storedSession?.user) {
        const storedEmail = storedSession.user.email ?? "your current account";
        console.log("[AUTH] RESET_PASSWORD_STORED_SESSION_FOUND — showing sign-out prompt", { stored: storedEmail.slice(0, 4) + "***" });
        setFpSignOutPrompt(storedEmail);
        return; // wait for user confirmation — see fpSignOutPrompt UI + handlePasswordResetConfirmed
      }
    } catch {
      // getSession() failure is non-fatal — proceed without the pre-check
    }

    await _sendPasswordReset();
  }

  async function handlePasswordResetConfirmed() {
    // User chose "Sign out and send reset" in the fpSignOutPrompt dialog.
    setFpSignOutPrompt(null);
    // Sign out the stored session explicitly so INITIAL_SESSION never restores it.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    localStorage.removeItem("lulou_session_id");
    console.log("[AUTH] RESET_PASSWORD_SIGN_OUT_CONFIRMED — stored session cleared");
    await _sendPasswordReset();
  }

  async function _sendPasswordReset() {
    setResetLoading(true);
    setResetError(null);
    try {
      // Guard: always clear any local session before sending the reset link.
      // (handlePasswordResetConfirmed may have already done this — idempotent.)
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
      localStorage.removeItem("lulou_session_id");
      console.log("[AUTH] RESET_PASSWORD_START — cleared local session to prevent INITIAL_SESSION restore", { email: email.trim().slice(0, 4) + "***", redirectTo: window.location.origin + "/auth/callback" });
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        // Point to /auth/callback so password recovery links land on the
        // dedicated callback page which shows a loading state and then
        // triggers the PasswordRecoveryGate in the main app.
        redirectTo: window.location.origin + "/auth/callback",
      });
      if (error) {
        console.error("[AUTH] RESET_PASSWORD_FAILED", { message: error.message, status: (error as any).status, code: (error as any).code });
        setResetError(error.message);
      } else {
        console.log("[AUTH] RESET_PASSWORD_SUCCESS — Supabase queued the reset email");
        setResetSent(true);
        setResetError(null);
        setAuthError(null);
      }
    } catch (err: any) {
      const msg = err?.message ?? "Could not send reset email — please try again.";
      console.error("[AUTH] RESET_PASSWORD_ERROR", msg);
      setResetError(msg);
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // ── In-flight guard ───────────────────────────────────────────────────────
    // Synchronous ref check — blocks duplicate calls from double-clicks or rapid
    // "Try Again" button presses that fire before React re-renders the disabled
    // state.  Must be the very first thing in the handler.
    if (authInProgressRef.current) {
      const ts = new Date().toISOString().slice(11, 23);
      console.warn(`[AUTH] DUPLICATE_SUBMIT_BLOCKED at ${ts} — authInProgressRef already true`);
      writeDebug({ authRequestInProgress: true });
      return;
    }
    authInProgressRef.current = true;
    // A deliberate new auth attempt starts a fresh UI lifecycle. The previous
    // account's already-shown conflict notice must never accompany this attempt.
    dismissForcedLogoutNotice();
    authCallCountRef.current  = 0;          // reset per-attempt call counter
    writeDebug({ authRequestInProgress: true, authCallsThisAttempt: 0 });

    // ── FORM WIRING TRACE — written before any validation or early return ─────
    // Read the actual DOM values as fallback: browser autofill populates the DOM
    // input value without always triggering React's synthetic onChange, leaving
    // React state at "" even though the field visually shows text. The ref gives
    // us the ground-truth value the user sees.
    const domEmail = emailRef.current?.value ?? "";
    const domPassword = passwordRef.current?.value ?? "";
    const effectiveEmail = email || domEmail;
    const effectivePassword = password || domPassword;
    if (domEmail && !email) { setEmail(domEmail); }
    if (domPassword && !password) { setPassword(domPassword); }

    writeDebug({
      formOnSubmitFired: true, submitHandlerEntered: true, submitBlockedReason: null,
      identifierInputState: effectiveEmail || null,
      passwordInputLength: effectivePassword.length,
    });
    console.log("[AUTH] SUBMIT_HANDLER_ENTERED", {
      emailState: email.length, emailDOM: domEmail.length,
      passwordState: password.length, passwordDOM: domPassword.length,
    });

    const trimmedEmail = effectiveEmail.trim().toLowerCase();

    // Show explicit errors for empty fields rather than silently blocking.
    // Reset the in-flight guard before each early return so future clicks work.
    if (!trimmedEmail) {
      authInProgressRef.current = false;
      writeDebug({ authRequestInProgress: false, submitBlockedReason: "email_empty" });
      console.warn("[AUTH] SUBMIT_BLOCKED: email empty");
      setAuthError({ kind: "auth", message: "Please enter your email address." });
      return;
    }
    if (!effectivePassword) {
      authInProgressRef.current = false;
      writeDebug({ authRequestInProgress: false, submitBlockedReason: "password_empty" });
      console.warn("[AUTH] SUBMIT_BLOCKED: password empty");
      setAuthError({ kind: "auth", message: "Please enter your password." });
      return;
    }

    setAuthError(null);
    setRawAuthError(null);
    setShowRawError(false);
    setResetSent(false);
    setLoading(true);

    // ── Write pre-call debug state (reset all per-attempt fields) ─────────────
    const payloadDesc = `email="${trimmedEmail}" password=${effectivePassword ? "present(" + effectivePassword.length + "chars)" : "EMPTY"}`;
    console.log("[AUTH] AUTH_REQUEST_STARTED", { mode, email: trimmedEmail, payloadDesc });
    writeDebug({
      loginStarted: true,
      signInStarted: true,
      submittedIdentifier: trimmedEmail,
      submittedPasswordPresent: !!effectivePassword,
      exactAuthPayloadUsed: payloadDesc,
      // Per-call trace — reset so old values from a previous attempt don't persist
      signInCallEntered: false,
      signInAwaitCompleted: false,
      rawSignInResultExists: false,
      rawSignInDataExists: false,
      rawSignInErrorExists: false,
      rawSignInResultString: null,
      rawSignInErrorString: null,
      submitHandlerReturnedEarly: false,
      submitHandlerCatchTriggered: false,
      // Timing / race debug — reset before each attempt
      authTimeoutPathEntered:  false,
      authAbortControllerUsed: false,   // always false — we use Promise.race, not AbortController
      authAbortTriggered:      false,   // always false — we use Promise.race, not AbortController
      authRequestStartedAt:    null,
      authRequestEndedAt:      null,
      authElapsedMs:           null,
      supabaseSignInResolved:  false,
      supabaseSignInRejected:  false,
      rawSupabaseAuthError:    null,
      timeoutMessageSource:    null,
      // Post-call results — reset
      signInReturnedUser: false,
      signInReturnedSession: false,
      signInErrorMessage: null,
      signInErrorStatus: null,
      signInErrorName: null,
      signInErrorCode: null,
      exactAuthError: null,
      // Signup-specific fields — reset
      signUpStarted: false,
      signUpReturnedUser: false,
      signUpReturnedSession: false,
      signUpErrorMessage: null,
      signUpErrorStatus: null,
      signUpErrorCode: null,
      postSignupNavigateCalled: false,
      postSignupProfileCreateStarted: false,
      postSignupProfileCreateSucceeded: false,
      signupMethodUsed: null,
      signupEndpointCalled: null,
      authCallsThisAttempt: 0,
      lastAuthAction: null,
      authReturnedUser: false,
      authReturnedSession: false,
      postAuthProfileFetchStarted: false,
      postAuthProfileFetchSucceeded: false,
      // safeFetch debug fields — reset before each attempt
      authResponseStatus:      null,
      authResponseContentType: null,
      authParseMode:           null,
      authReturnedHtml:        false,
      authUserFacingError:     null,
    });

    // Reset the safeFetch debug capture so we see fresh values for this attempt
    resetAuthFetchDebug();

    // Helper: build a RawAuthError from any error-like object.
    function makeRaw(err: any, prefix: string): RawAuthError {
      return {
        message: err?.message ?? "(none)",
        status:  String(err?.status ?? err?.statusCode ?? "?"),
        name:    err?.name ?? "(none)",
        code:    err?.code ?? "(none)",
      };
    }

    // Helper: write error fields + push to overlay ERRORS column.
    function recordError(raw: RawAuthError, prefix: string) {
      const errMsg = `${prefix}: ${raw.message} (status=${raw.status} code=${raw.code} name=${raw.name})`;
      writeDebug({
        signInReturnedUser: false,
        signInReturnedSession: false,
        signInErrorMessage: raw.message,
        signInErrorStatus:  raw.status,
        signInErrorName:    raw.name,
        signInErrorCode:    raw.code,
        exactAuthError: errMsg,
      });
      pushDebugError(errMsg);
      setRawAuthError(raw);
      console.error(`[AUTH] AUTH_REQUEST_FAILED (${prefix})`, raw);
      return errMsg;
    }

    // 30-second timeout: if Supabase auth server never responds, the await
    // hangs indefinitely. Promise.race surfaces the hang as an explicit error.
    // 30 s (previously 15 s) — gives Supabase more room when the service is
    // slow but not fully down.  Not an AbortController: the fetch continues
    // running in the background after the race is lost.
    const SIGNIN_TIMEOUT_MS = 30_000;
    const timeoutPromise: Promise<never> = new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error(`Supabase auth server did not respond after ${SIGNIN_TIMEOUT_MS / 1000}s — possible 522/network outage`);
        (e as any).code    = "timeout";
        (e as any).source  = "Promise.race setTimeout in landing.tsx handleSubmit";
        reject(e);
      }, SIGNIN_TIMEOUT_MS)
    );

    // ── Start-of-request timing stamp ──────────────────────────────────────────
    const authRequestStartedAt = Date.now();
    writeDebug({
      authRequestStartedAt,
      authAbortControllerUsed: false,
      authAbortTriggered:      false,
      timeoutMessageSource:    `Promise.race with ${SIGNIN_TIMEOUT_MS / 1000}s setTimeout (landing.tsx handleSubmit)`,
    });

    try {
      if (mode === "signup") {
        // ── Clear any existing session BEFORE signUp ──────────────────────────
        // If Account A is already logged in its session lives in Supabase's
        // localStorage.  Without this, when the app is backgrounded and resumed
        // INITIAL_SESSION fires with A's token → setUser(A) → landing.tsx
        // unmounts → the pending-verification state is silently lost and the
        // user finds themselves inside Account A's profile.
        console.log("[VERIFY] SIGNUP_START_CLEAR_SESSION");
        await supabase.auth.signOut({ scope: "local" }).catch(() => {});

        // signUp → /auth/v1/signup  (NOT /auth/v1/token?grant_type=password)
        authCallCountRef.current += 1;
        const _signUpTs = new Date().toISOString().slice(11, 23);
        const _cbUrl = getApprovedCallbackUrl();
        console.log(`[AUTH] CALL#${authCallCountRef.current} supabase.auth.signUp at ${_signUpTs}`);
        console.log(`[VERIFY] SIGNUP_INITIATED`, {
          email: trimmedEmail.slice(0, 4) + "***",
          emailRedirectTo: _cbUrl,
        });
        writeDebug({
          signInCallEntered: true,
          signUpStarted: true,
          signupMethodUsed: "supabase.auth.signUp",
          signupEndpointCalled: "/auth/v1/signup",
          lastAuthAction: "signup",
          authCallsThisAttempt: authCallCountRef.current,
        });
        const signUpResult = await Promise.race([
          supabase.auth.signUp({
            email: trimmedEmail,
            password: effectivePassword,
            options: {
              // Fixed application-controlled URL — never read from user input, form
              // fields, query params or Origin header.  getApprovedCallbackUrl()
              // returns the production URL in prod and window.location.origin/auth/callback
              // only in dev (controlled by the developer's own local server).
              emailRedirectTo: _cbUrl,
            },
          }),
          timeoutPromise,
        ]);
        const { data, error } = signUpResult;
        writeDebug({
          signInAwaitCompleted: true,
          rawSignInResultExists: signUpResult != null,
          rawSignInDataExists: data != null,
          rawSignInErrorExists: error != null,
          rawSignInResultString: JSON.stringify({ hasUser: !!data?.user, hasSession: !!data?.session, hasError: !!error }),
          rawSignInErrorString: error ? JSON.stringify({ msg: error.message, status: error.status, code: (error as any).code }) : "null",
          signUpReturnedUser: !!data?.user,
          signUpReturnedSession: !!data?.session,
          signUpErrorMessage: error ? (error.message ?? null) : null,
          signUpErrorStatus: error ? String((error as any).status ?? "?") : null,
          signUpErrorCode: error ? ((error as any).code ?? null) : null,
        });
        setLoading(false);
        writeDebug({ ...lastAuthFetchDebug });
        {
          const _end = Date.now();
          writeDebug({
            authRequestEndedAt:    _end,
            authElapsedMs:         _end - authRequestStartedAt,
            supabaseSignInResolved: true,
            supabaseSignInRejected: false,
            rawSupabaseAuthError:  error ? `${error.message} (code=${(error as any).code})` : null,
          });
        }
        if (error) {
          const deliveryFailure = classifyVerificationDeliveryError(error, "signup");
          console.error("[VERIFY] SIGNUP_DELIVERY_FAILURE", {
            kind: deliveryFailure.kind,
            status: deliveryFailure.status,
            code: deliveryFailure.code,
            detail: deliveryFailure.safeDetail,
          });
          writeDebug({
            verificationFailureKind: deliveryFailure.kind,
            verificationFailureStatus: deliveryFailure.status === null ? null : String(deliveryFailure.status),
            verificationFailureCode: deliveryFailure.code,
            verificationFailureDetail: deliveryFailure.safeDetail,
          });
          const raw = makeRaw(error, "signup");
          recordError(raw, "signup");
          const classified = classifyAuthError(error, mode);
          // A signup error can be a user-creation failure or a verification
          // delivery failure. Keep those paths distinct so a provider/SMTP
          // problem is never presented as a generic sign-up failure.
          const deliveryKinds = new Set([
            "rate_limited",
            "smtp_failure",
            "invalid_email",
            "confirmation_send_failure",
            "redirect_configuration",
            "provider_error",
            "unknown",
          ]);
          const displayError: AuthError =
            classified.kind !== "already-exists" &&
            classified.kind !== "credentials" &&
            deliveryFailure.kind !== "auth_user_creation_failure" &&
            deliveryKinds.has(deliveryFailure.kind)
            ? {
                kind: deliveryFailure.kind === "rate_limited" ? "rate-limit" : "delivery",
                message: deliveryFailure.userMessage,
              }
            : classified;
          if (classified.kind === "already-exists") {
            setMode("signin");
            setPassword("");
          }
          if (classified.kind === "rate-limit") {
            console.log("[VERIFY] RATE_LIMITED", { email: trimmedEmail.slice(0, 4) + "***", code: (error as any)?.code, status: (error as any)?.status });
            // Block any old session from restoring while the user is stuck on this screen.
            // We set the same key used by the normal verification pending guard so use-auth.ts
            // knows to drop any non-matching INITIAL_SESSION / SIGNED_IN event.
            sessionStorage.setItem("lulou_pending_verification_email", trimmedEmail);
            sessionStorage.setItem("lulou_rate_limit_pending", "1");
            console.log("[VERIFY] OLD_SESSION_BLOCKED_DURING_RATE_LIMIT", { email: trimmedEmail.slice(0, 4) + "***" });
            setRateLimitEmail(trimmedEmail);
            setRateLimitCooldown(60);
            console.log("[VERIFY] COOLDOWN_STARTED", { seconds: 60, email: trimmedEmail.slice(0, 4) + "***" });
          }
          setAuthError(displayError);
          writeDebug({ submitHandlerReturnedEarly: true });
          return;
        }
        // ── No-session silent failure (signup) ────────────────────────────────
        // During an outage Supabase can return no error but also no user/session.
        // Catch it explicitly so the outage banner fires instead of a silent hang.
        if (!data.user && !data.session) {
          const syntheticErr = new Error("Auth service returned no session and no error (signup) — possible outage");
          (syntheticErr as any).code = "no-session";
          const raw = makeRaw(syntheticErr, "no-session");
          recordError(raw, "no-session");
          setAuthError({
            kind: "network",
            message: "Lulou is having trouble reaching the login service right now. Please try again shortly.",
          });
          writeDebug({ submitHandlerNoSession: true, noSessionSilentFailure: true });
          console.error("[AUTH] NO_SESSION_SILENT_FAILURE (signup) — treating as outage");
          return;
        }

        // ── User returned but no session (email confirmation is ON) ─────────
        // Supabase returns {user, session:null} when "Confirm email" is enabled.
        // We do NOT call signInWithPassword here — that would wrongly hit
        // /auth/v1/token?grant_type=password, trigger rate limits, and fail
        // with "Email not confirmed".  The only correct action is to tell
        // the user to check their inbox.
        if (data.user && !data.session) {
          writeDebug({
            signInReturnedUser: true,
            signInReturnedSession: false,
            signupNoSessionAttemptingAutoSignIn: false,
            emailConfirmationRequired: true,
            authReturnedUser: true,
            authReturnedSession: false,
          });

          // ── Already-registered email detection ──────────────────────────────
          // When Supabase "Confirm email" is ON and you call signUp() with an
          // email that already belongs to a confirmed account, it returns
          // {user (with email_confirmed_at set), session: null, error: null}.
          // This looks identical to a successful new-user signup.  We detect it
          // here by checking email_confirmed_at — if it's already set the
          // account exists and no new email was sent.
          if (data.user.email_confirmed_at) {
            console.warn("[VERIFY] EMAIL_ALREADY_REGISTERED — signUp returned confirmed user, no email sent", {
              userId: data.user.id.slice(0, 8) + "…",
              email: trimmedEmail.slice(0, 4) + "***",
              confirmedAt: data.user.email_confirmed_at,
            });
            setMode("signin");
            setPassword("");
            setAuthError({
              kind: "already-exists",
              message: "An account with this email already exists. Please sign in instead.",
            });
            setLoading(false);
            return;
          }

          console.warn("[AUTH] SIGNUP_NO_SESSION: email confirmation required", { userId: data.user.id });
          console.log("[VERIFY] VERIFICATION_EMAIL_SENT", {
            userId: data.user.id.slice(0, 8) + "…",
            email:  trimmedEmail.slice(0, 4) + "***",
            emailConfirmedAt: data.user.email_confirmed_at ?? null,
            redirectTo: window.location.origin + "/auth/callback",
            note: "User must click the link in the email to confirm. email_confirmed_at will be null until then.",
          });
          // ── Persist pending email in sessionStorage ──────────────────────────
          // verificationEmail is local state — it's lost if landing.tsx unmounts
          // (e.g. if an old session restores while the app is backgrounded).
          // Storing it here lets use-auth.ts block any old session from slipping
          // through while verification is still pending.
          sessionStorage.setItem("lulou_pending_verification_email", trimmedEmail);
          console.log("[VERIFY] PENDING_EMAIL_SET", { email: trimmedEmail.slice(0, 4) + "***" });
          setVerificationEmail(trimmedEmail);
          setLoading(false);
          return;
        }

        // ── Session returned directly from signUp (confirm email is OFF) ──────
        // The Supabase SDK already stored the session and fired onAuthStateChange
        // (SIGNED_IN) internally when signUp resolved.  No extra setSession call
        // is needed — that would hit the auth API a second time and risk 429s.
        writeDebug({
          signInReturnedUser: !!data.user,
          signInReturnedSession: !!data.session,
          postSignupNavigateCalled: true,
          postSignupProfileCreateStarted: true,
          postSignupProfileCreateSucceeded: true,
          authReturnedUser: !!data.user,
          authReturnedSession: !!data.session,
        });
        console.log("[AUTH] SIGNUP_DIRECT_SESSION_SUCCESS", { userId: data.user?.id, authCalls: authCallCountRef.current });
        toast({ title: "Account created", description: "You're now signed in." });

      } else {
        // ── sign-in ───────────────────────────────────────────────────────────
        authCallCountRef.current += 1;
        const _signInTs = new Date().toISOString().slice(11, 23);
        console.log(`[AUTH] CALL#${authCallCountRef.current} supabase.auth.signInWithPassword at ${_signInTs}`);
        writeDebug({
          signInCallEntered: true,
          lastAuthAction: "signin",
          authCallsThisAttempt: authCallCountRef.current,
        });
        const signInResult = await Promise.race([
          supabase.auth.signInWithPassword({ email: trimmedEmail, password: effectivePassword }),
          timeoutPromise,
        ]);

        // ── Immediately capture raw result shape ──────────────────────────────
        const { data, error } = signInResult;
        writeDebug({
          signInAwaitCompleted: true,
          rawSignInResultExists: signInResult != null,
          rawSignInDataExists: data != null,
          rawSignInErrorExists: error != null,
          rawSignInResultString: JSON.stringify({
            hasUser: !!data?.user,
            hasSession: !!data?.session,
            hasError: !!error,
          }),
          rawSignInErrorString: error
            ? JSON.stringify({ msg: error.message, status: error.status, code: (error as any).code, name: (error as any).name })
            : "null",
        });

        setLoading(false);
        writeDebug({ ...lastAuthFetchDebug });
        {
          const _end = Date.now();
          writeDebug({
            authRequestEndedAt:     _end,
            authElapsedMs:          _end - authRequestStartedAt,
            supabaseSignInResolved:  true,
            supabaseSignInRejected:  false,
            rawSupabaseAuthError:   error ? `${error.message} (code=${(error as any).code})` : null,
          });
        }

        if (error) {
          const raw = makeRaw(error, "signIn");
          recordError(raw, "signIn");
          // Write the error fields to the overlay BEFORE classifying/returning
          // so the operator can see the raw Supabase error reason immediately.
          writeDebug({
            signInErrorMessage: error.message ?? null,
            signInErrorStatus:  String((error as any).status ?? "?"),
            signInErrorName:    (error as any).name ?? null,
            signInErrorCode:    (error as any).code ?? null,
            exactAuthError:     error.message ?? null,
            signInReturnedUser: false,
            signInReturnedSession: false,
            authReturnedUser: false,
            authReturnedSession: false,
            submitHandlerReturnedEarly: true,
          });
          console.warn("[AUTH] SIGNIN_ERROR", {
            message: error.message,
            status: (error as any).status,
            code: (error as any).code,
          });
          setAuthError(classifyAuthError(error, mode));
          return;
        }

        // ── No-session silent failure ──────────────────────────────────────────
        // Supabase can return { data: { user: null, session: null }, error: null }
        // during an auth-service outage or degraded path. There is no thrown error
        // and no error object, so the code would fall through and leave the user
        // on the landing page with nothing visible. Treat this explicitly as a
        // network/outage failure so the outage banner is shown.
        if (!data.session && !data.user) {
          const syntheticErr = new Error("Auth service returned no session and no error — possible outage");
          (syntheticErr as any).code = "no-session";
          const raw = makeRaw(syntheticErr, "no-session");
          recordError(raw, "no-session");
          setAuthError({
            kind: "network",
            message: "Lulou is having trouble reaching the login service right now. Please try again shortly.",
          });
          writeDebug({ submitHandlerNoSession: true, noSessionSilentFailure: true });
          console.error("[AUTH] NO_SESSION_SILENT_FAILURE — treating as outage");
          return;
        }

        writeDebug({
          signInReturnedUser: !!data.user,
          signInReturnedSession: !!data.session,
          exactAuthError: null,
          signInErrorMessage: null,
          signInErrorStatus: null,
          signInErrorName: null,
          signInErrorCode: null,
          authReturnedUser: !!data.user,
          authReturnedSession: !!data.session,
        });
        console.log("[AUTH] AUTH_REQUEST_SUCCESS", { mode, userId: data.user?.id });

      }

    } catch (err: any) {
      const _catchEnd = Date.now();
      setLoading(false);
      writeDebug({ ...lastAuthFetchDebug });
      const isTimeout = err?.code === "timeout";
      writeDebug({
        authRequestEndedAt:     _catchEnd,
        authElapsedMs:          _catchEnd - authRequestStartedAt,
        supabaseSignInResolved: false,
        supabaseSignInRejected: true,
        authTimeoutPathEntered: isTimeout,
        authAbortTriggered:     false,   // Promise.race never aborts the fetch
        rawSupabaseAuthError:   `${err?.message ?? "(none)"} (code=${err?.code ?? "(none)"})`,
        timeoutMessageSource:   isTimeout
          ? `Promise.race setTimeout fired after ${SIGNIN_TIMEOUT_MS / 1000}s — landing.tsx handleSubmit line ~${365}`
          : `Supabase SDK threw: ${err?.name ?? "Error"}`,
      });
      const raw = makeRaw(err, "throw");
      const errMsg = recordError(raw, isTimeout ? "timeout" : "throw");
      writeDebug({
        signInAwaitCompleted: false,
        submitHandlerCatchTriggered: true,
      });
      console.error("[AUTH] AUTH_ERROR_MESSAGE", { mode, error: raw.message, stack: err?.stack });
      setAuthError(classifyAuthError(err, mode));
    } finally {
      // Always release the in-flight guard so the next user action is accepted.
      authInProgressRef.current = false;
      writeDebug({ authRequestInProgress: false, authCallsThisAttempt: authCallCountRef.current });
    }
  }

  async function handleResendVerification() {
    if (!verificationEmail || resendCooldown > 0) return;
    setResendLoading(true);
    setResendError(null);
    setResendSent(false);
    try {
      console.log("[AUTH] RESEND_VERIFICATION_START", { email: verificationEmail.slice(0, 4) + "***" });
      const result = await sendVerificationResend(verificationEmail);
      if (result.ok) {
        console.log("[AUTH] RESEND_VERIFICATION_SUCCESS — Supabase queued the email");
        setResendSent(true);
        setResendCooldown(60);
      } else {
        console.error("[VERIFY] RESEND_DELIVERY_FAILURE", {
          kind: result.failure.kind,
          status: result.failure.status,
          code: result.failure.code,
          detail: result.failure.safeDetail,
        });
        writeDebug({
          verificationFailureKind: result.failure.kind,
          verificationFailureStatus: result.failure.status === null ? null : String(result.failure.status),
          verificationFailureCode: result.failure.code,
          verificationFailureDetail: result.failure.safeDetail,
        });
        pushDebugError(
          `[VERIFY] resend ${result.failure.kind} status=${result.failure.status ?? "none"} code=${result.failure.code ?? "none"}: ${result.failure.safeDetail}`,
        );
        setResendError(result.message);
        setResendCooldown(result.rateLimit ? 60 : 10);
      }
    } finally {
      setResendLoading(false);
    }
  }

  if (verificationEmail) {
    return (
      <div
        className="min-h-[100dvh] bg-background flex flex-col items-center justify-center px-6 gap-8"
        style={{
          paddingInlineStart: "max(1.5rem, env(safe-area-inset-left, 0px))",
          paddingInlineEnd: "max(1.5rem, env(safe-area-inset-right, 0px))",
          paddingTop: "max(1.5rem, env(safe-area-inset-top, 0px))",
          paddingBottom: "max(1.5rem, env(safe-area-inset-bottom, 0px))",
        }}
        data-testid="screen-email-verification"
      >
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
          <LulouFlowerIcon className="w-9 h-9 text-primary" />
        </div>
        <div className="w-full max-w-sm space-y-3 text-center">
          <h1 className="font-serif text-2xl font-bold">{t("landing_check_your_email")}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("conf_link_sent_to")}{" "}
            <strong className="text-foreground">{verificationEmail}</strong>.{" "}
            {t("conf_link_click_to_activate")}
          </p>
        </div>
        <div className="w-full max-w-sm space-y-3">
          {resendSent ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 justify-center text-sm text-primary py-2" data-testid="text-resend-success">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                {t("landing_conf_resent")}
              </div>
              <button
                onClick={handleResendVerification}
                disabled={resendLoading || resendCooldown > 0}
                className="w-full text-xs text-muted-foreground hover:text-primary transition-colors py-1 disabled:opacity-50"
                data-testid="button-resend-again"
              >
                {resendLoading
                  ? t("landing_resending")
                  : resendCooldown > 0
                  ? `Resend in ${resendCooldown}s`
                  : t("landing_resend_conf_email")}
              </button>
            </div>
          ) : (
            <Button
              className="w-full"
              disabled={resendLoading || resendCooldown > 0}
              onClick={handleResendVerification}
              data-testid="button-resend-verification"
            >
              {resendLoading ? (
                <><Loader2 className="w-4 h-4 me-2 animate-spin" /> {t("landing_resending")}</>
              ) : resendCooldown > 0 ? (
                `Resend in ${resendCooldown}s`
              ) : (
                t("landing_resend_conf_email")
              )}
            </Button>
          )}
          {resendError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2" data-testid="text-resend-error">
              <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-xs text-destructive leading-snug">{resendError}</p>
            </div>
          )}
          <div className="pt-2 border-t border-border/40 flex flex-col gap-1">
            <p className="text-center text-xs text-muted-foreground pb-1">
              Finish verifying your email to continue.
            </p>
            <button
              onClick={() => {
                console.log("[VERIFY] PENDING_SIGNUP_CANCELLED", { reason: "use-different-email" });
                sessionStorage.removeItem("lulou_pending_verification_email");
                sessionStorage.removeItem("lulou_rate_limit_pending");
                setVerificationEmail(null);
                setRateLimitEmail(null);
                setRateLimitCooldown(0);
                setMode("signup");
                setEmail("");
                setPassword("");
                setResendSent(false);
                setResendError(null);
              }}
              className="w-full text-sm text-muted-foreground hover:text-primary transition-colors py-2"
              data-testid="button-use-different-email"
            >
              Use a different email
            </button>
            <button
              onClick={() => {
                console.log("[VERIFY] PENDING_SIGNUP_CANCELLED", { reason: "sign-in-instead" });
                sessionStorage.removeItem("lulou_pending_verification_email");
                sessionStorage.removeItem("lulou_rate_limit_pending");
                setVerificationEmail(null);
                setRateLimitEmail(null);
                setRateLimitCooldown(0);
                setMode("signin");
                setResendSent(false);
                setResendError(null);
              }}
              className="w-full text-sm text-muted-foreground hover:text-primary transition-colors py-2"
              data-testid="button-back-to-signin"
            >
              Sign in instead
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <nav
        className="fixed top-0 inset-x-0 z-50 backdrop-blur-md bg-background/80 border-b"
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingInlineStart: "env(safe-area-inset-left, 0px)",
          paddingInlineEnd: "env(safe-area-inset-right, 0px)",
        }}
      >
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-8 h-8 text-primary" />
            <span className="font-serif text-xl font-semibold tracking-tight" data-testid="text-logo">Lulou</span>
          </div>
          <button
            onClick={resetForm}
            className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-primary"
            data-testid="link-switch-account"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t("landing_switch_account")}
          </button>
        </div>
      </nav>

      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, hsl(350 45% 52%) 0%, transparent 50%), radial-gradient(circle at 80% 50%, hsl(155 25% 45%) 0%, transparent 50%)'
        }} />
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8">
            <div className="space-y-4">
              <p className="text-sm font-medium tracking-wider uppercase text-primary" data-testid="text-tagline">{t("landing_intentional_dating")}</p>
              <h1 className="font-serif text-5xl lg:text-6xl font-bold leading-tight tracking-tight -mb-2" data-testid="text-hero-headline">
                {t("landing_hero_1")}
                <span className="text-primary">
                  {" "}
                  {(() => {
                    const word = t("landing_hero_flourish");
                    if (word.startsWith("fl")) {
                      return (
                        <span className="flourish-word">
                          <span className="flourish-f">{word[0]}</span>
                          <span className="flourish-rest">{word.slice(1)}</span>
                        </span>
                      );
                    }
                    return word;
                  })()}
                </span>
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-lg" data-testid="text-hero-description">
                {t("landing_hero_desc")}
              </p>
              <p className="text-sm font-medium text-primary/80 tracking-wide" data-testid="text-algo-statement">
                Matched by how you connect — not just how you look.
              </p>
              <button
                type="button"
                onClick={() => setShowHowItWorks(true)}
                className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
                data-testid="button-how-lulou-works"
              >
                How Lulou works <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* ── Improved form card ──────────────────────────────────────────── */}
            <div className="max-w-sm rounded-2xl bg-card border border-border/50 shadow-lg shadow-rose-100/10 p-6 space-y-4">

            <form ref={formRef} onSubmit={handleSubmit} className="max-w-sm space-y-3" data-testid="form-login" noValidate>
              {/* ── Outage banner ────────────────────────────────────────────────────
                  Shown when the auth service is unreachable (timeout or no
                  network). This sits ABOVE the inputs so it is the first thing
                  the user sees — it is clearly not a credentials problem.
                  The inputs remain enabled so the user can retry immediately. */}
              {fpSignOutPrompt !== null && (
                <div
                  role="alert"
                  data-testid="banner-fp-sign-out-prompt"
                  className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200"
                >
                  <div className="flex items-start gap-2">
                    <Lock className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
                    <div className="space-y-1 flex-1 min-w-0">
                      <p className="font-semibold text-amber-900 text-sm leading-snug">
                        You're currently signed in
                      </p>
                      <p className="text-sm text-amber-800 leading-snug">
                        To send a reset link{email.trim() && ` to ${email.trim().slice(0, 4)}***`}, we need to sign you out of{" "}
                        <span className="font-medium">{fpSignOutPrompt}</span> first.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-0.5">
                    <button
                      type="button"
                      data-testid="button-fp-keep-signed-in"
                      onClick={() => setFpSignOutPrompt(null)}
                      className="flex-1 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 transition-colors"
                    >
                      Keep me signed in
                    </button>
                    <button
                      type="button"
                      data-testid="button-fp-sign-out-and-reset"
                      onClick={handlePasswordResetConfirmed}
                      disabled={resetLoading}
                      className="flex-1 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50 transition-colors"
                    >
                      {resetLoading ? "Signing out…" : "Sign out and send reset"}
                    </button>
                  </div>
                </div>
              )}

              {authError?.kind === "network" && (
                <div
                  role="alert"
                  data-testid="banner-auth-outage"
                  className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200"
                >
                  <div className="flex items-start gap-2">
                    <WifiOff className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
                    <div className="space-y-1">
                      <p className="font-semibold text-amber-900 text-sm leading-snug" data-testid="text-outage-heading">
                        {rawAuthError?.code === "timeout"
                          ? t("landing_server_no_respond")
                          : rawAuthError?.code === "no-session"
                          ? t("landing_service_unavailable")
                          : rawAuthError?.code === "html_response_outage"
                          ? t("landing_html_error_page")
                          : rawAuthError?.name === "SyntaxError" || rawAuthError?.message?.toLowerCase().includes("unexpected token")
                          ? t("landing_unexpected_response")
                          : t("landing_conn_problem")}
                      </p>
                      <p className="text-sm text-amber-800 leading-snug" data-testid="text-outage-message">
                        {t("network_error_retry")}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="button-try-login-again-banner"
                    onClick={() => {
                      setAuthError(null);
                      setRawAuthError(null);
                      formRef.current?.requestSubmit();
                    }}
                    className="self-start inline-flex items-center gap-1.5 rounded-md bg-amber-700 hover:bg-amber-800 text-white px-4 py-2 text-xs font-semibold transition-colors"
                  >
                    {t("landing_try_login_again")}
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <Input
                  ref={emailRef}
                  type="email"
                  placeholder={t("landing_email_ph")}
                  value={email}
                  onFocus={(e) => {
                    // Capture what element is at the input's center — confirms
                    // whether any overlay is blocking the input in the form.
                    const el   = e.target as HTMLInputElement;
                    const rect = el.getBoundingClientRect();
                    el.style.pointerEvents = "none";
                    const hit = document.elementFromPoint(
                      rect.left + rect.width  / 2,
                      rect.top  + rect.height / 2,
                    );
                    el.style.pointerEvents = "";
                    const desc = hit
                      ? `${hit.tagName}${hit.id ? "#" + hit.id : ""}${hit.className && typeof hit.className === "string" && hit.className.trim() ? " [" + hit.className.trim().slice(0, 80) + "]" : ""}`
                      : "none";
                    writeDebug({ realEmailInputFocused: true, realEmailEfp: desc });
                  }}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEmail(v);
                    clearError();
                    writeDebug({ onChangeIdentifierFiring: true, identifierInputState: v });
                  }}
                  required
                  autoComplete="email"
                  data-testid="input-email"
                  className="h-12"
                />
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    type={showPassword ? "text" : "password"}
                    placeholder={t("landing_password_ph")}
                    value={password}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPassword(v);
                      clearError();
                      writeDebug({ onChangePasswordFiring: true, passwordInputLength: v.length });
                    }}
                    required
                    autoComplete="current-password"
                    data-testid="input-password"
                    className="h-12 pe-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-toggle-password"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {mode === "signin" && (
                  <div className="text-end">
                    <button
                      type="button"
                      onClick={handlePasswordReset}
                      disabled={resetLoading || !email.trim()}
                      className="text-xs text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid="link-forgot-password"
                    >
                      {resetLoading ? t("landing_sending_reset") : t("landing_forgot_password")}
                    </button>
                  </div>
                )}
              </div>

              {resetSent && (
                <div
                  className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800"
                  data-testid="text-reset-sent"
                  role="alert"
                >
                  <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="font-medium leading-tight">{t("landing_reset_sent_title")}</p>
                    <p className="text-xs opacity-80">{t("landing_reset_sent_desc")}</p>
                  </div>
                </div>
              )}

              {resetError && !resetSent && (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                  data-testid="text-reset-error"
                  role="alert"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="font-medium leading-tight">Reset email failed</p>
                    <p className="text-xs opacity-80">{resetError}</p>
                  </div>
                </div>
              )}

              {authError && !resetSent && (
                <div
                  className={`rounded-md border px-3 py-3 text-sm animate-in fade-in slide-in-from-top-1 duration-150 ${
                    authError.kind === "network" || authError.kind === "rate-limit" || authError.kind === "delivery"
                      ? "bg-amber-50 border-amber-200 text-amber-900"
                      : "bg-destructive/10 border-destructive/30 text-destructive"
                  }`}
                  data-testid="text-auth-error"
                  role="alert"
                >
                  <div className="flex items-start gap-2">
                    {authError.kind === "network" ? (
                      <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    )}
                    <div className="space-y-1 flex-1 min-w-0">
                      {/* Human-readable heading
                          ── network/timeout → amber box, WifiOff icon
                          ── credentials     → red box, AlertCircle icon
                          ── auth/other      → red box, AlertCircle icon       */}
                      <p className="font-semibold leading-tight" data-testid="text-auth-error-heading">
                        {authError.kind === "already-exists"
                          ? t("landing_account_exists")
                          : authError.kind === "credentials"
                          ? t("landing_wrong_credentials")
                          : authError.kind === "rate-limit"
                          ? t("landing_too_many_attempts")
                          : authError.kind === "network"
                          ? (rawAuthError?.code === "timeout"
                              ? t("landing_server_no_respond")
                              : rawAuthError?.code === "no-session"
                              ? t("landing_service_unavailable")
                              : rawAuthError?.code === "html_response_outage"
                              ? t("landing_html_error_page")
                              : rawAuthError?.name === "SyntaxError" || rawAuthError?.message?.toLowerCase().includes("unexpected token")
                              ? t("landing_unexpected_response")
                              : t("landing_conn_problem"))
                           : authError.kind === "delivery"
                           ? (mode === "signup" ? t("landing_sign_up_failed") : t("landing_sign_in_failed"))
                          : authError.kind === "auth"
                          ? t("landing_cannot_sign_in")
                          : mode === "signup"
                          ? t("landing_sign_up_failed")
                          : t("landing_sign_in_failed")}
                      </p>
                      {/* Classified message — friendly, no raw technical strings */}
                      <p className="text-sm leading-snug break-words" data-testid="text-auth-error-detail">
                        {authError.kind === "auth" ? t("email_not_confirmed_msg") : authError.message}
                      </p>
                      {/* Try Again button — only for network/timeout failures.
                          Uses formRef.requestSubmit() so it re-runs the full
                          handleSubmit (including DOM-value fallback, validation,
                          and the 15s timeout race) without the user having to
                          scroll down to the main Sign In button.               */}
                      {authError.kind === "network" && (
                        <button
                          type="button"
                          data-testid="button-try-again"
                          onClick={() => {
                            setAuthError(null);
                            setRawAuthError(null);
                            formRef.current?.requestSubmit();
                          }}
                          className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-amber-800/20 hover:bg-amber-800/30 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors"
                        >
                          {t("landing_try_login_again")}
                        </button>
                      )}
                      {/* Raw error details — collapsible, keeps exact Supabase
                          error visible for debugging without cluttering UI     */}
                      {rawAuthError && (
                        <div className="mt-1.5">
                          <button
                            type="button"
                            onClick={() => setShowRawError(v => !v)}
                            className="flex items-center gap-1 text-xs font-medium opacity-70 hover:opacity-100"
                            data-testid="button-toggle-raw-error"
                          >
                            {showRawError ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {showRawError ? t("landing_hide") : t("landing_show")} {t("landing_technical_details")}
                          </button>
                          {showRawError && (
                            <pre
                              className="mt-1 text-[10px] leading-relaxed font-mono opacity-80 whitespace-pre-wrap break-all bg-black/10 rounded px-2 py-1.5"
                              data-testid="text-raw-auth-error"
                            >
{`message: ${rawAuthError.message}
status:  ${rawAuthError.status}
name:    ${rawAuthError.name}
code:    ${rawAuthError.code}`}
                            </pre>
                          )}
                        </div>
                      )}
                      {/* Credentials action: offer password reset */}
                      {authError.kind === "rate-limit" && mode === "signup" && (
                        <div className="flex flex-col gap-1 mt-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              cancelRateLimit("sign-in-instead");
                              setMode("signin");
                            }}
                            className="text-xs font-medium underline underline-offset-2"
                            data-testid="button-rate-limit-signin"
                          >
                            {t("landing_sign_in_instead")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              cancelRateLimit("use-different-email");
                              setEmail("");
                              setPassword("");
                            }}
                            className="text-xs font-medium underline underline-offset-2"
                            data-testid="button-rate-limit-different-email"
                          >
                            Use a different email
                          </button>
                        </div>
                      )}
                      {authError.kind === "already-exists" && (
                        <button
                          type="button"
                          onClick={switchToSignIn}
                          className="text-xs font-medium underline underline-offset-2 mt-0.5"
                          data-testid="button-switch-to-signin"
                        >
                          {t("landing_sign_in_instead")}
                        </button>
                      )}
                      {authError.kind === "credentials" && mode === "signin" && (
                        <button
                          type="button"
                          onClick={handlePasswordReset}
                          disabled={resetLoading || !email.trim()}
                          className="text-xs font-medium underline underline-offset-2 mt-0.5 disabled:opacity-50"
                          data-testid="button-reset-password"
                        >
                          {resetLoading ? t("landing_sending_reset") : t("landing_forgot_your_password")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full text-base"
                disabled={loading || !email.trim() || !password || (mode === "signup" && rateLimitCooldown > 0)}
                data-testid="button-submit-auth"
                onClick={() => writeDebug({ submitButtonClicked: true })}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {mode === "signup" ? t("landing_creating") : t("landing_signing_in")}
                  </>
                ) : mode === "signup" && rateLimitCooldown > 0 ? (
                  <>
                    <Clock className="w-4 h-4 me-2" />
                    Try again in {rateLimitCooldown}s
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 me-2" />
                    {mode === "signup" ? t("landing_create_account") : t("landing_sign_in")}
                  </>
                )}
              </Button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setAuthError(null); }}
                  className="text-sm text-primary hover:underline"
                  data-testid="link-toggle-auth-mode"
                >
                  {mode === "signup" ? t("landing_have_account") : t("landing_new_here")}
                </button>
              </div>
            </form>
            </div>{/* end form card */}

            {/* Trust strip */}
            <div className="flex items-center gap-5 flex-wrap text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-primary" />
                <span>{t("landing_verified_profiles")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5 text-primary" />
                <span>{t("landing_no_games")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-primary" />
                <span>Built for real dates</span>
              </div>
            </div>
          </div>

          <div className="relative hidden lg:block">
            <div className="relative rounded-md overflow-hidden aspect-[4/3]">
              <img
                src="/images/bloom-hero.png"
                alt="Lulou - Intentional Dating"
                className="w-full h-full object-cover"
                data-testid="img-hero"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background/20 to-transparent" />
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 px-6 bg-card/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16 space-y-3">
            <p className="text-sm font-medium tracking-wider uppercase text-primary">{t("landing_how_it_works")}</p>
            <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-how-it-works">{t("landing_journey_title")}</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">{t("landing_journey_desc")}</p>
          </div>

          {/* 4-step journey progression */}
          <div className="relative" data-testid="section-journey-steps">
            {/* Connecting line (desktop) */}
            <div className="hidden md:block absolute top-8 left-[12.5%] right-[12.5%] h-px bg-border/60" aria-hidden="true" />
            <div className="grid md:grid-cols-4 gap-8">
              {[
                { icon: <MessageCircle className="w-5 h-5" />, step: "01", label: "Meaningful messages", desc: "Limited messages encourage you to say something real." },
                { icon: <Mic className="w-5 h-5" />, step: "02", label: "Voice notes", desc: "Unlocked through genuine engagement — hear each other's real voice." },
                { icon: <Phone className="w-5 h-5" />, step: "03", label: "Guided calls", desc: "A structured first call, then a second. No pressure, just connection." },
                { icon: <Calendar className="w-5 h-5" />, step: "04", label: "Meet in person", desc: "When both of you are ready — Lulou helps you take the step." },
              ].map((item, i) => (
                <div key={i} className="flex flex-col items-center text-center gap-3" data-testid={`card-step-${i + 1}`}>
                  <div className="relative w-16 h-16 rounded-full bg-background border border-border/60 flex items-center justify-center text-primary shadow-sm z-10">
                    {item.icon}
                    <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">{item.step}</span>
                  </div>
                  <p className="font-semibold text-sm">{item.label}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Connection DNA callout */}
          <div className="mt-12 rounded-2xl border border-primary/20 bg-primary/[0.03] p-6 flex flex-col md:flex-row items-center gap-4" data-testid="card-dna-callout">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Dna className="w-6 h-6 text-primary" />
            </div>
            <div className="space-y-1 text-center md:text-left">
              <p className="font-semibold text-sm">Connection DNA — a different kind of matching</p>
              <p className="text-xs text-muted-foreground leading-relaxed max-w-lg">
                Other apps learn who you swipe on. Lulou learns who you genuinely connect with. After joining, a short quiz helps us understand how you build real relationships — not just what you look like.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Testimonial */}
      <section className="py-20 px-6" data-testid="section-testimonial">
        <div className="max-w-3xl mx-auto">
          <div className="rounded-2xl bg-card border border-border/50 p-8 md:p-12 text-center shadow-sm space-y-6">
            <div className="flex justify-center gap-1">
              {[0,1,2,3,4].map(i => (
                <Heart key={i} className="w-4 h-4 fill-primary text-primary" />
              ))}
            </div>
            <blockquote className="font-serif text-xl md:text-2xl text-foreground leading-relaxed">
              "We spoke for three days, completed our first call and met that weekend. I've never felt so prepared for a first date."
            </blockquote>
            <p className="text-sm text-muted-foreground italic">
              — Early Lulou member
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-5 h-5 text-primary" />
            <span className="font-serif font-medium text-foreground">Lulou</span>
          </div>
          <p>{t("landing_designed_for")}</p>
        </div>
      </footer>

      {/* ── How Lulou Works modal ─────────────────────────────────────── */}
      {showHowItWorks && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="How Lulou works"
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowHowItWorks(false)}
          />
          <div className="relative z-10 w-full sm:max-w-lg bg-background rounded-t-2xl sm:rounded-2xl border border-border/50 shadow-2xl overflow-y-auto max-h-[85dvh] p-6 sm:p-8 space-y-6" data-testid="modal-how-it-works">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-2xl font-bold">How Lulou works</h2>
              <button
                onClick={() => setShowHowItWorks(false)}
                className="p-2 rounded-full hover:bg-muted transition-colors"
                aria-label="Close"
                data-testid="button-close-how-it-works"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Lulou is designed to move you from a first message to a real meeting — with every feature built to deepen connection, not prolong scrolling.
            </p>
            <div className="space-y-5">
              {[
                {
                  icon: <MessageCircle className="w-5 h-5" />,
                  title: "Start with meaningful messages",
                  desc: "A limit on messages encourages you to make every word count. No small talk for weeks — real conversations from the start.",
                },
                {
                  icon: <Mic className="w-5 h-5" />,
                  title: "Unlock voice notes through genuine engagement",
                  desc: "Voice notes open up once both people have genuinely engaged in conversation. Hearing someone's real voice before meeting matters.",
                },
                {
                  icon: <Phone className="w-5 h-5" />,
                  title: "Complete a guided call",
                  desc: "A short first voice call, then a second. Structured but natural. Lulou guides you toward it at the right moment.",
                },
                {
                  icon: <Calendar className="w-5 h-5" />,
                  title: "Decide whether to meet",
                  desc: "After your calls, both of you choose whether to exchange numbers and meet in real life. No pressure — just a clear, intentional step.",
                },
                {
                  icon: <Dna className="w-5 h-5" />,
                  title: "Connection DNA — matched by how you connect",
                  desc: "A short quiz helps Lulou understand your communication style, emotional openness, and relationship intentions — so introductions are based on genuine compatibility, not just photos.",
                },
              ].map((item, i) => (
                <div key={i} className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary flex-shrink-0">
                    {item.icon}
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-sm">{item.title}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function FeatureCard({ icon, title, description, testId }: { icon: React.ReactNode; title: string; description: string; testId: string }) {
  return (
    <div className="p-6 rounded-md bg-background border space-y-4" data-testid={testId}>
      <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center text-primary">
        {icon}
      </div>
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </div>
  );
}
