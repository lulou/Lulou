import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Heart, MessageCircle, Phone, Shield, RefreshCw, Loader2, Lock, Eye, EyeOff, AlertCircle, WifiOff, CheckCircle, ChevronDown, ChevronUp } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { supabase, lastAuthFetchDebug, resetAuthFetchDebug } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { writeDebug, pushDebugError } from "@/lib/debug-store";

type AuthMode = "signin" | "signup";
type AuthErrorKind = "credentials" | "already-exists" | "network" | "auth";

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
    err?.status === 422
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
    return { kind: "already-exists", message: msg };
  }
  if (
    lower.includes("invalid login credentials") ||
    lower.includes("invalid_grant") ||
    lower.includes("email not confirmed") ||
    lower.includes("user not found") ||
    lower.includes("wrong password")
  ) {
    return { kind: "credentials", message: msg };
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

// ── BUILD MARKER ─────────────────────────────────────────────────────────────
// Set once when the JS bundle is evaluated. If this timestamp doesn't change
// on reload, the browser is serving a stale bundle.
const BUILD_STAMP = "2026-04-17T13:35:00Z • client/src/pages/landing.tsx";

export default function Landing() {
  // ── RAW INPUT STATE TEST — brand-new isolated state, no custom component ──
  const [debugEmail, setDebugEmail] = useState("");
  const [debugPassword, setDebugPassword] = useState("");
  // Ref to the event-log div — written directly in handlers, bypasses React state
  // so we can prove events fire even if setState is somehow broken.
  const rawEvtRef = useRef<HTMLDivElement>(null);
  const markRawEvt = (label: string) => {
    if (rawEvtRef.current) {
      const ts = new Date().toISOString().slice(11, 23);
      rawEvtRef.current.textContent = `${label} @ ${ts}`;
      rawEvtRef.current.style.color = "#86efac";
    }
  };

  // ── 8-field raw debug panel — direct DOM writes, zero React state ─────────
  const rawDbgRef = useRef<HTMLDivElement>(null);
  const rawDbgVal = useRef({
    rawInputFocused:              false as boolean,
    rawInputClicked:              false as boolean,
    rawInputKeydown:              false as boolean,
    rawInputInputFired:           false as boolean,
    rawInputChangeFired:          false as boolean,
    rawInputDisabled:             false as boolean,
    rawInputReadOnly:             false as boolean,
    topElementOverInput:          "— (focus input to compute)" as string,
    // ── Level-2 diagnostics ──────────────────────────────────────────────────
    documentKeydownSeen:          false as boolean,   // any key reached document at all?
    documentKeydownCount:         0     as number,    // total count so stale=false is obvious
    parentKeydownBlocked:         false as boolean,   // parent div captured + stopped propagation
    nearestBlockingWrapper:       "none" as string,
    activeElementTag:             "—"   as string,   // document.activeElement.tagName after focus
    activeElementClass:           "—"   as string,
  });
  const flushRawDbg = (patch: Partial<typeof rawDbgVal.current>) => {
    Object.assign(rawDbgVal.current, patch);
    if (!rawDbgRef.current) return;
    const s = rawDbgVal.current;
    const b = (v: boolean) =>
      `<span style="color:${v ? "#4ade80" : "#f87171"}">${v}</span>`;
    rawDbgRef.current.innerHTML = [
      `rawInputFocused          : ${b(s.rawInputFocused)}`,
      `rawInputClicked          : ${b(s.rawInputClicked)}`,
      `rawInputKeydown          : ${b(s.rawInputKeydown)}`,
      `rawInputInputFired       : ${b(s.rawInputInputFired)}`,
      `rawInputChangeFired      : ${b(s.rawInputChangeFired)}`,
      `rawInputDisabled         : ${b(s.rawInputDisabled)}`,
      `rawInputReadOnly         : ${b(s.rawInputReadOnly)}`,
      `<span style="color:#fb923c;font-weight:700">TOP ELEMENT OVER INPUT  : ${s.topElementOverInput}</span>`,
      `──────────────────────────────────────────`,
      `documentKeydownSeen      : ${b(s.documentKeydownSeen)} (count: ${s.documentKeydownCount})`,
      `parentKeydownBlocked     : ${b(s.parentKeydownBlocked)}`,
      `nearestBlockingWrapper   : <span style="color:#fb923c">${s.nearestBlockingWrapper}</span>`,
      `activeElementTag         : <span style="color:#93c5fd">${s.activeElementTag}</span>`,
      `activeElementClass       : <span style="color:#93c5fd">${s.activeElementClass}</span>`,
    ].map(line => `<div>${line}</div>`).join("");
  };

  // Attach a document-level keydown listener to detect whether ANY keystroke
  // reaches the page at all.  Runs once on mount; cleans up on unmount.
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => {
      rawDbgVal.current.documentKeydownSeen  = true;
      rawDbgVal.current.documentKeydownCount += 1;
      flushRawDbg({});   // re-render the panel with no patch (values already mutated above)
    };
    document.addEventListener("keydown", onDocKey, true);   // capture phase
    return () => document.removeEventListener("keydown", onDocKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Full keyboard-reach diagnostics ────────────────────────────────────────
  // Attaches listeners at window / document / body covering every keyboard
  // event type.  All writes go directly to the DOM — no React state.
  const kbdPanelRef  = useRef<HTMLDivElement>(null);
  const kbdNoEvtRef  = useRef<HTMLDivElement>(null);   // "not reaching page" message
  const kbdCounters  = useRef({
    windowKeydownSeen:      0,
    documentKeydownSeen:    0,
    bodyKeydownSeen:        0,
    inputKeydownSeen:       0,
    keypressSeen:           0,
    beforeInputSeen:        0,
    compositionStartSeen:   0,
    compositionUpdateSeen:  0,
    compositionEndSeen:     0,
    pasteSeen:              0,
  });
  const flushKbd = () => {
    if (!kbdPanelRef.current) return;
    const c = kbdCounters.current;
    const anyKey = Object.values(c).some(v => v > 0);
    // Show/hide the "not reaching page" banner
    if (kbdNoEvtRef.current) {
      kbdNoEvtRef.current.style.display = anyKey ? "none" : "block";
    }
    const row = (label: string, count: number) =>
      `<div>${label}: <span style="color:${count > 0 ? "#4ade80" : "#f87171"}">${count > 0 ? "true" : "false"}</span> (${count}x)</div>`;
    kbdPanelRef.current.innerHTML = [
      row("windowKeydownSeen",     c.windowKeydownSeen),
      row("documentKeydownSeen",   c.documentKeydownSeen),
      row("bodyKeydownSeen",       c.bodyKeydownSeen),
      row("inputKeydownSeen",      c.inputKeydownSeen),
      row("keypressSeen",          c.keypressSeen),
      row("beforeInputSeen",       c.beforeInputSeen),
      row("compositionStartSeen",  c.compositionStartSeen),
      row("compositionUpdateSeen", c.compositionUpdateSeen),
      row("compositionEndSeen",    c.compositionEndSeen),
      row("pasteSeen",             c.pasteSeen),
    ].join("");
  };

  useEffect(() => {
    const bump = (key: keyof typeof kbdCounters.current) => () => {
      (kbdCounters.current as Record<string, number>)[key]++;
      flushKbd();
    };
    const listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean][] = [
      [window,         "keydown",          bump("windowKeydownSeen"),     true],
      [window,         "keydown",          bump("windowKeydownSeen"),     false],
      [document,       "keydown",          bump("documentKeydownSeen"),   true],
      [document.body,  "keydown",          bump("bodyKeydownSeen"),       true],
      [window,         "keypress",         bump("keypressSeen"),          true],
      [window,         "beforeinput",      bump("beforeInputSeen"),       true],
      [window,         "compositionstart", bump("compositionStartSeen"),  true],
      [window,         "compositionupdate",bump("compositionUpdateSeen"), true],
      [window,         "compositionend",   bump("compositionEndSeen"),    true],
      [window,         "paste",            bump("pasteSeen"),             true],
    ];
    listeners.forEach(([t, ev, fn, cap]) => t.addEventListener(ev, fn, cap));
    return () => listeners.forEach(([t, ev, fn, cap]) => t.removeEventListener(ev, fn, cap));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Portal textarea state ───────────────────────────────────────────────────
  const portalPanelRef = useRef<HTMLDivElement>(null);
  const portalCounters = useRef({ kd: 0, inp: 0, ch: 0, len: 0 });
  const flushPortal = (len?: number) => {
    if (!portalPanelRef.current) return;
    const p = portalCounters.current;
    if (len !== undefined) p.len = len;
    const b = (v: number) => `<span style="color:${v > 0 ? "#4ade80" : "#f87171"}">${v > 0}</span> (${v}x)`;
    portalPanelRef.current.innerHTML =
      `<div>PORTAL TEXT LENGTH : <span style="color:#e2e8f0">${p.len}</span></div>` +
      `<div>portalKeydownSeen  : ${b(p.kd)}</div>` +
      `<div>portalInputSeen    : ${b(p.inp)}</div>` +
      `<div>portalChangeSeen   : ${b(p.ch)}</div>`;
  };

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
  const { toast } = useToast();

  // Refs to the actual DOM inputs — read directly in handleSubmit to cover
  // browser autofill which sets the DOM value without firing React's onChange.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Ref to the <form> — used by the "Try Again" button in the error panel to
  // re-trigger form submission without the user having to scroll to the submit button.
  const formRef = useRef<HTMLFormElement>(null);

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

  function resetForm() {
    setEmail("");
    setPassword("");
    setMode("signin");
    setShowPassword(false);
    setAuthError(null);
    setRawAuthError(null);
    setShowRawError(false);
    setResetSent(false);
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
  }

  async function handlePasswordReset() {
    if (!email.trim()) return;
    setResetLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
      if (error) {
        console.error("[AUTH] RESET_PASSWORD_FAILED", error.message);
        toast({ title: "Reset failed", description: error.message, variant: "destructive" });
      } else {
        setResetSent(true);
        setAuthError(null);
      }
    } catch (err: any) {
      console.error("[AUTH] RESET_PASSWORD_ERROR", err?.message);
      toast({ title: "Reset failed", description: err?.message || "Try again.", variant: "destructive" });
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

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

    const trimmedEmail = effectiveEmail.trim();

    // Show explicit errors for empty fields rather than silently blocking.
    if (!trimmedEmail) {
      console.warn("[AUTH] SUBMIT_BLOCKED: email empty");
      writeDebug({ submitBlockedReason: "email_empty" });
      setAuthError({ kind: "auth", message: "Please enter your email address." });
      return;
    }
    if (!effectivePassword) {
      console.warn("[AUTH] SUBMIT_BLOCKED: password empty");
      writeDebug({ submitBlockedReason: "password_empty" });
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
        writeDebug({ signInCallEntered: true });
        const signUpResult = await Promise.race([
          supabase.auth.signUp({ email: trimmedEmail, password: effectivePassword }),
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
          const raw = makeRaw(error, "signup");
          recordError(raw, "signup");
          const classified = classifyAuthError(error, mode);
          if (classified.kind === "already-exists") {
            setMode("signin");
            setPassword("");
          }
          setAuthError(classified);
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
        writeDebug({ signInReturnedUser: !!data.user, signInReturnedSession: !!data.session });
        console.log("[AUTH] AUTH_REQUEST_SUCCESS", { mode, userId: data.user?.id });
        toast({ title: "Account created", description: "You're now signed in." });

      } else {
        // ── sign-in ───────────────────────────────────────────────────────────
        writeDebug({ signInCallEntered: true });
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
          setAuthError(classifyAuthError(error, mode));
          writeDebug({ submitHandlerReturnedEarly: true });
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
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* ── MARKER 1: Build stamp — fixed top of screen, visible above everything ── */}
      <div
        data-testid="build-marker"
        style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 99998,
          background: "#facc15", color: "#000", fontFamily: "monospace",
          fontWeight: 900, fontSize: 14, padding: "6px 12px",
          textAlign: "center", letterSpacing: 1,
        }}
      >
        🔴 LIVE BUILD MARKER: {BUILD_STAMP}
      </div>

      <nav style={{ marginTop: 34 }} className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-6 h-6 text-primary" />
            <span className="font-serif text-xl font-semibold tracking-tight" data-testid="text-logo">Lulou</span>
          </div>
          <button
            onClick={resetForm}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
            data-testid="link-switch-account"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Switch Account
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
              <p className="text-sm font-medium tracking-wider uppercase text-primary" data-testid="text-tagline">Intentional Dating</p>
              <h1 className="font-serif text-5xl lg:text-6xl font-bold leading-tight tracking-tight" data-testid="text-hero-headline">
                Where real connections
                <span className="text-primary"> flourish</span>
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-lg" data-testid="text-hero-description">
                Move beyond endless swiping. Lulou guides you from matching to meaningful conversations to meeting in real life.
              </p>
            </div>

            {/* ══ KEYBOARD-REACH DIAGNOSTICS ════════════════════════════════════
                All counts go to 0 until a key is pressed.
                documentKeydownSeen staying 0 = page not receiving keyboard events.
                ══════════════════════════════════════════════════════════════════ */}
            <div
              data-testid="kbd-diagnostics"
              style={{
                position: "relative", zIndex: 100003, pointerEvents: "auto",
                border: "3px solid #3b82f6", borderRadius: 8,
                padding: "10px 14px", background: "#0f172a",
                marginBottom: 12, maxWidth: 384, fontFamily: "monospace", fontSize: 11,
              }}
            >
              <div style={{ color: "#60a5fa", fontWeight: 900, fontSize: 12, marginBottom: 6, letterSpacing: 1 }}>
                ⌨ KEYBOARD REACH DIAGNOSTICS — press any key
              </div>
              {/* Banner shown while no key events detected */}
              <div
                ref={kbdNoEvtRef}
                style={{
                  background: "#7f1d1d", color: "#fca5a5", fontWeight: 700,
                  padding: "6px 8px", borderRadius: 4, marginBottom: 6, fontSize: 12,
                }}
              >
                ⚠ Keyboard input is not reaching the page in this browser session.
              </div>
              <div ref={kbdPanelRef} style={{ lineHeight: 1.8, color: "#e2e8f0" }}>
                <div>windowKeydownSeen     : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>documentKeydownSeen   : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>bodyKeydownSeen       : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>inputKeydownSeen      : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>keypressSeen          : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>beforeInputSeen       : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>compositionStartSeen  : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>compositionUpdateSeen : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>compositionEndSeen    : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
                <div>pasteSeen             : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
              </div>
            </div>

            {/* ══════════════════════════════════════════════════════════════════
                RAW INPUT STATE TEST
                rawEvtRef + markRawEvt are defined at component top-level (above).
                The event-log div is updated via direct DOM write — no React state
                involved — so it proves events fire even if setState is broken.
                z-index: 100001 lifts this above the debug overlay (zIndex 99999).
                ══════════════════════════════════════════════════════════════════ */}
            <div
              data-testid="raw-input-test"
              style={{
                position: "relative",
                zIndex: 100001,
                pointerEvents: "auto",
                border: "3px solid #f59e0b",
                borderRadius: 8,
                padding: "12px 14px",
                background: "#1c1917",
                marginBottom: 16,
                maxWidth: 384,
                fontFamily: "monospace",
              }}
            >
              <div style={{ color: "#f59e0b", fontWeight: 900, fontSize: 13, marginBottom: 8, letterSpacing: 1 }}>
                ⚡ RAW INPUT STATE TEST
              </div>

              {/* Ref-based event log — direct DOM mutation, bypasses React state */}
              <div
                ref={rawEvtRef}
                data-testid="raw-event-log"
                style={{ color: "#9ca3af", fontSize: 11, marginBottom: 6, minHeight: 16 }}
              >
                no events yet — click or type below
              </div>

              <input
                type="text"
                placeholder="raw email — type here"
                value={debugEmail}
                data-testid="raw-input-email"
                style={{
                  display: "block", width: "100%", marginBottom: 6,
                  padding: "8px 10px", borderRadius: 4,
                  border: "3px solid #000000",
                  background: "#ffffff", color: "#000000", fontSize: 14,
                  boxSizing: "border-box",
                  position: "relative", zIndex: 100002, pointerEvents: "auto",
                }}
                onFocus={(e) => {
                  const el = e.target as HTMLInputElement;
                  const rect = el.getBoundingClientRect();
                  const cx = rect.left + rect.width / 2;
                  const cy = rect.top + rect.height / 2;
                  el.style.pointerEvents = "none";
                  const beneath = document.elementFromPoint(cx, cy);
                  el.style.pointerEvents = "auto";
                  const topDesc = beneath
                    ? `${beneath.tagName}${beneath.id ? "#" + beneath.id : ""}${beneath.className && typeof beneath.className === "string" ? "." + beneath.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`
                    : "none";
                  // Walk up the DOM to find any parent with a keydown handler
                  let blockingWrapper = "none";
                  let node: HTMLElement | null = el.parentElement;
                  while (node && node !== document.body) {
                    if ((node as any).onkeydown) {
                      blockingWrapper = `${node.tagName}${node.id ? "#" + node.id : ""}${node.className ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
                      break;
                    }
                    node = node.parentElement;
                  }
                  const ae = document.activeElement as HTMLElement | null;
                  flushRawDbg({
                    rawInputFocused:        true,
                    rawInputDisabled:       el.disabled,
                    rawInputReadOnly:       el.readOnly,
                    topElementOverInput:    topDesc,
                    nearestBlockingWrapper: blockingWrapper,
                    activeElementTag:       ae?.tagName ?? "—",
                    activeElementClass:     (ae?.className && typeof ae.className === "string")
                                            ? ae.className.trim().split(/\s+/).slice(0, 4).join(" ") || "(empty)"
                                            : "—",
                  });
                  markRawEvt("FOCUS");
                }}
                onClick={() => { flushRawDbg({ rawInputClicked: true }); markRawEvt("CLICK"); }}
                onKeyDown={() => { flushRawDbg({ rawInputKeydown: true }); markRawEvt("KEYDOWN"); }}
                onInput={(e) => { flushRawDbg({ rawInputInputFired: true }); markRawEvt("INPUT: " + (e.target as HTMLInputElement).value); }}
                onChange={(e) => { flushRawDbg({ rawInputChangeFired: true }); markRawEvt("CHANGE: " + e.target.value); setDebugEmail(e.target.value); }}
              />

              {/* 8-field debug status — direct DOM writes via rawDbgRef */}
              <div
                ref={rawDbgRef}
                data-testid="raw-dbg-fields"
                style={{
                  fontFamily: "monospace", fontSize: 11, lineHeight: 1.7,
                  marginBottom: 8, padding: "6px 8px",
                  background: "#0f172a", borderRadius: 4, color: "#e2e8f0",
                  border: "1px solid #334155",
                }}
              >
                <div>rawInputFocused          : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputClicked          : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputKeydown          : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputInputFired       : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputChangeFired      : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputDisabled         : <span style={{ color: "#f87171" }}>false</span></div>
                <div>rawInputReadOnly         : <span style={{ color: "#f87171" }}>false</span></div>
                <div><span style={{ color: "#fb923c", fontWeight: 700 }}>TOP ELEMENT OVER INPUT  : — (focus input to compute)</span></div>
                <div>──────────────────────────────────────────</div>
                <div>documentKeydownSeen      : <span style={{ color: "#f87171" }}>false</span> (count: 0)</div>
                <div>parentKeydownBlocked     : <span style={{ color: "#f87171" }}>false</span></div>
                <div>nearestBlockingWrapper   : <span style={{ color: "#fb923c" }}>none</span></div>
                <div>activeElementTag         : <span style={{ color: "#93c5fd" }}>—</span></div>
                <div>activeElementClass       : <span style={{ color: "#93c5fd" }}>—</span></div>
              </div>

              <input
                type="password"
                placeholder="raw password — type here"
                value={debugPassword}
                data-testid="raw-input-password"
                style={{
                  display: "block", width: "100%", marginBottom: 8,
                  padding: "8px 10px", borderRadius: 4,
                  border: "2px solid #6b7280",
                  background: "#292524", color: "#f9fafb", fontSize: 14,
                  boxSizing: "border-box",
                  position: "relative", zIndex: 100002, pointerEvents: "auto",
                }}
                onChange={(e) => setDebugPassword(e.target.value)}
              />

              <div style={{ color: debugEmail ? "#86efac" : "#9ca3af", fontWeight: 700, fontSize: 12 }}>
                DEBUG EMAIL: {debugEmail || "empty"}
              </div>
              <div style={{ color: debugPassword ? "#86efac" : "#9ca3af", fontWeight: 700, fontSize: 12 }}>
                DEBUG PASSWORD LENGTH: {debugPassword.length}
              </div>
            </div>

            <form ref={formRef} onSubmit={handleSubmit} className="max-w-sm space-y-3" data-testid="form-login" noValidate>
              {/* ── MARKER 2: Login form version + file path ── */}
              <div
                data-testid="login-form-marker"
                style={{
                  background: "#1e40af", color: "#fff", fontFamily: "monospace",
                  fontSize: 11, padding: "5px 8px", borderRadius: 4,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700 }}>LOGIN FORM VERSION: A</div>
                <div>FILE: client/src/pages/landing.tsx</div>
                <div>BUILD: {BUILD_STAMP}</div>
              </div>

              {/* ── MARKER 3: Live input echo — updates from React state ── */}
              <div
                data-testid="input-echo-marker"
                style={{
                  background: "#1f2937", color: "#e5e7eb",
                  fontFamily: "monospace", fontSize: 12,
                  padding: "6px 8px", borderRadius: 4, lineHeight: 1.7,
                }}
              >
                <div style={{ color: email ? "#86efac" : "#9ca3af", fontWeight: 700 }}>
                  INPUT TEST: {email || "empty — type in email field below"}
                </div>
                <div style={{ color: password ? "#86efac" : "#9ca3af", fontWeight: 700 }}>
                  PASSWORD LENGTH: {password.length}
                </div>
              </div>

              {/* ── Outage banner ────────────────────────────────────────────────────
                  Shown when the auth service is unreachable (timeout or no
                  network). This sits ABOVE the inputs so it is the first thing
                  the user sees — it is clearly not a credentials problem.
                  The inputs remain enabled so the user can retry immediately. */}
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
                          ? "Login server didn't respond"
                          : rawAuthError?.code === "no-session"
                          ? "Login service unavailable"
                          : rawAuthError?.code === "html_response_outage"
                          ? "Login server returned an HTML error page"
                          : rawAuthError?.name === "SyntaxError" || rawAuthError?.message?.toLowerCase().includes("unexpected token")
                          ? "Login server returned an unexpected response"
                          : "Connection problem"}
                      </p>
                      <p className="text-sm text-amber-800 leading-snug" data-testid="text-outage-message">
                        Lulou is having trouble reaching the login service right now. Please try again shortly.
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
                    Try Login Again
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <Input
                  ref={emailRef}
                  type="email"
                  placeholder="Enter your email"
                  value={email}
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
                    placeholder="Password"
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
                    className="h-12 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-toggle-password"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {mode === "signin" && (
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={handlePasswordReset}
                      disabled={resetLoading || !email.trim()}
                      className="text-xs text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid="link-forgot-password"
                    >
                      {resetLoading ? "Sending reset email…" : "Forgot password?"}
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
                    <p className="font-medium leading-tight">Reset email sent</p>
                    <p className="text-xs opacity-80">Check your inbox for a link to reset your password.</p>
                  </div>
                </div>
              )}

              {authError && !resetSent && (
                <div
                  className={`rounded-md border px-3 py-3 text-sm animate-in fade-in slide-in-from-top-1 duration-150 ${
                    authError.kind === "network"
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
                          ? "Account already exists"
                          : authError.kind === "credentials"
                          ? "Incorrect email or password"
                          : authError.kind === "network"
                          ? (rawAuthError?.code === "timeout"
                              ? "Login server didn't respond"
                              : rawAuthError?.code === "no-session"
                              ? "Login service unavailable"
                              : rawAuthError?.code === "html_response_outage"
                              ? "Login server returned an HTML error page"
                              : rawAuthError?.name === "SyntaxError" || rawAuthError?.message?.toLowerCase().includes("unexpected token")
                              ? "Login server returned an unexpected response"
                              : "Connection problem")
                          : authError.kind === "auth"
                          ? "Cannot sign in"
                          : mode === "signup"
                          ? "Sign up failed"
                          : "Sign in failed"}
                      </p>
                      {/* Classified message — friendly, no raw technical strings */}
                      <p className="text-sm leading-snug break-words" data-testid="text-auth-error-detail">
                        {authError.message}
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
                          Try Login Again
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
                            {showRawError ? "Hide" : "Show"} technical details
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
                      {authError.kind === "already-exists" && (
                        <button
                          type="button"
                          onClick={switchToSignIn}
                          className="text-xs font-medium underline underline-offset-2 mt-0.5"
                          data-testid="button-switch-to-signin"
                        >
                          Sign in instead
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
                          {resetLoading ? "Sending…" : "Forgot your password?"}
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
                disabled={loading || !email.trim() || !password}
                data-testid="button-submit-auth"
                onClick={() => writeDebug({ submitButtonClicked: true })}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {mode === "signup" ? "Creating account..." : "Signing in..."}
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 mr-2" />
                    {mode === "signup" ? "Create Account" : "Sign In"}
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
                  {mode === "signup" ? "Already have an account? Sign in" : "New here? Create account"}
                </button>
              </div>
            </form>

            <div className="flex items-center gap-6 flex-wrap text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                <span>Verified profiles</span>
              </div>
              <div className="flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                <span>No games</span>
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
            <p className="text-sm font-medium tracking-wider uppercase text-primary">How It Works</p>
            <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-how-it-works">A journey, not a game</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">Every feature in Lulou is designed to move you toward a real connection, not keep you scrolling.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              icon={<LulouFlowerIcon className="w-5 h-5" />}
              title="Discover with intention"
              description="View one profile at a time. No swiping, no rush. Decide thoughtfully who you want to open up to."
              testId="card-feature-discover"
            />
            <FeatureCard
              icon={<MessageCircle className="w-5 h-5" />}
              title="Conversations that matter"
              description="Limited messages encourage meaningful exchanges. When it's time, Lulou nudges you toward a real call."
              testId="card-feature-message"
            />
            <FeatureCard
              icon={<Phone className="w-5 h-5" />}
              title="From screen to scene"
              description="Your first voice call is always free. Lulou is designed to help you meet, not message forever."
              testId="card-feature-call"
            />
          </div>
        </div>
      </section>

      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-cta-heading">Ready to find something real?</h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Lulou is for people who are done with the noise. Step into a calmer, more intentional way to date.
          </p>
        </div>
      </section>

      <footer className="border-t py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-5 h-5 text-primary" />
            <span className="font-serif font-medium text-foreground">Lulou</span>
          </div>
          <p>Designed for real connection.</p>
        </div>
      </footer>

      {/* ── BODY PORTAL INPUT TEST — rendered directly to document.body ─────────
          Bypasses the entire React component tree and page layout.
          If THIS textarea receives key events but the in-page input does not,
          the in-page layout/wrapper is the blocker.
          If this also receives no key events, the issue is at the browser level.
          ────────────────────────────────────────────────────────────────────── */}
      {createPortal(
        <div
          data-testid="body-portal-container"
          style={{
            position: "fixed", top: 10, left: 10,
            zIndex: 2147483647, pointerEvents: "auto",
            fontFamily: "monospace", fontSize: 12,
          }}
        >
          <div style={{
            background: "#000", color: "#fff", fontWeight: 900, fontSize: 11,
            padding: "2px 6px", borderRadius: "4px 4px 0 0", letterSpacing: 1,
          }}>
            BODY PORTAL INPUT TEST
          </div>
          <textarea
            data-testid="portal-textarea"
            placeholder="type here — portal test"
            rows={2}
            style={{
              display: "block", width: 260,
              padding: "6px 8px",
              background: "#ffffff", color: "#000000",
              border: "3px solid red", borderTop: "none",
              fontSize: 13, resize: "none", outline: "none",
              pointerEvents: "auto",
            }}
            onKeyDown={() => { portalCounters.current.kd++;  flushPortal(); }}
            onInput={(e) => { portalCounters.current.inp++; flushPortal((e.target as HTMLTextAreaElement).value.length); }}
            onChange={(e) => { portalCounters.current.ch++;  flushPortal((e.target as HTMLTextAreaElement).value.length); }}
          />
          <div
            ref={portalPanelRef}
            style={{
              background: "#1e1b4b", color: "#e2e8f0",
              padding: "4px 8px", borderRadius: "0 0 4px 4px",
              border: "1px solid #6366f1", borderTop: "none",
              lineHeight: 1.7,
            }}
          >
            <div>PORTAL TEXT LENGTH : <span style={{ color: "#e2e8f0" }}>0</span></div>
            <div>portalKeydownSeen  : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
            <div>portalInputSeen    : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
            <div>portalChangeSeen   : <span style={{ color: "#f87171" }}>false</span> (0x)</div>
          </div>
        </div>,
        document.body
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
