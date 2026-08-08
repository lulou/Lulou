// Shared module-level debug store — written by AppContent, landing.tsx, and
// use-auth.ts; read by DebugOverlay (which lives outside all those trees).
// Keeping it here avoids circular imports and fixes the Vite HMR warning that
// appeared when pushDebugError was exported directly from App.tsx.

export interface DebugSnapshot {
  // Core app-gate state (written by AppContent)
  userId: string | null;
  authReady: boolean;
  sessionExists: boolean;
  profileExists: boolean;
  effectiveProfileExists: boolean;
  fetchFailed: boolean;
  spinnerTimedOut: boolean;
  forceProceed: boolean;
  onboardingComplete: boolean;
  route: string;
  finalGateDecision: string;
  phase: string;
  // Form-wiring trace (written by onChange + handleSubmit)
  identifierInputState: string | null;
  passwordInputLength: number;
  identifierValuePropName: string;
  passwordValuePropName: string;
  onChangeIdentifierFiring: boolean;
  onChangePasswordFiring: boolean;
  submitButtonClicked: boolean;
  formOnSubmitFired: boolean;
  submitHandlerEntered: boolean;
  submitBlockedReason: string | null;
  renderCount: number;
  // Auth-flow trace (written by landing.tsx + use-auth.ts)
  submittedIdentifier: string | null;
  submittedPasswordPresent: boolean;
  signInStarted: boolean;
  loginStarted: boolean;
  // Per-call trace — written before/after the Supabase await
  signInCallEntered: boolean;
  signInAwaitCompleted: boolean;
  rawSignInResultExists: boolean;
  rawSignInDataExists: boolean;
  rawSignInErrorExists: boolean;
  rawSignInResultString: string | null;
  rawSignInErrorString: string | null;
  submitHandlerReturnedEarly: boolean;
  submitHandlerCatchTriggered: boolean;
  // Post-call results
  signInReturnedUser: boolean;
  signInReturnedSession: boolean;
  signInErrorMessage: string | null;
  signInErrorStatus: string | null;
  signInErrorName: string | null;
  signInErrorCode: string | null;
  exactAuthPayloadUsed: string | null;
  exactAuthError: string | null;
  authEvent: string | null;
  currentSessionUserId: string | null;
  // Signup-specific trace
  signupNoSessionAttemptingAutoSignIn: boolean;
  autoSignInAfterSignup: boolean;
  emailConfirmationRequired: boolean;
  // Explicit signup result trace (separate from sign-in fields)
  signUpStarted: boolean;
  signUpReturnedUser: boolean;
  signUpReturnedSession: boolean;
  signUpErrorMessage: string | null;
  signUpErrorStatus: string | null;
  signUpErrorCode: string | null;
  postSignupNavigateCalled: boolean;
  postSignupProfileCreateStarted: boolean;
  postSignupProfileCreateSucceeded: boolean;
  // Method/endpoint tracing — so it's visible whether the right function was called
  signupMethodUsed: string | null;
  signupEndpointCalled: string | null;
  // In-flight guard — one call per user action
  authRequestInProgress: boolean;
  authCallsThisAttempt: number;
  lastAuthAction: string | null;
  // Unified post-auth result — written for BOTH signup and signin success paths
  authReturnedUser: boolean;
  authReturnedSession: boolean;
  // Post-auth profile check — written by AppContent's checkProfileExists
  postAuthProfileFetchStarted: boolean;
  postAuthProfileFetchSucceeded: boolean;
  // Profile query/save debug — written by checkProfileExists + onboarding createProfile mutation
  profileQueryUserId: string | null;
  profileRowFound: boolean | null;
  profileInsertAttempted: boolean;
  profileInsertSucceeded: boolean;
  profileFetchMethodUsed: string | null;
  profileErrorMessage: string | null;
  // Timing / race debug
  authTimeoutPathEntered: boolean;
  authAbortControllerUsed: boolean;
  authAbortTriggered: boolean;
  authRequestStartedAt: number | null;
  authRequestEndedAt: number | null;
  authElapsedMs: number | null;
  supabaseSignInResolved: boolean;
  supabaseSignInRejected: boolean;
  rawSupabaseAuthError: string | null;
  timeoutMessageSource: string | null;
  // Post-call no-session path
  submitHandlerNoSession: boolean;
  noSessionSilentFailure: boolean;
  // Real input focus tracking
  realEmailInputFocused: boolean;
  realEmailEfp: string | undefined;
  // Auth fetch debug (separate HTTP fetch used in some paths)
  authFetchStarted: boolean;
  authFetchCallCount: number;
  authResponseStatus: number | null;
  authResponseContentType: string | null;
  authParseMode: "text" | "json" | null;
  authReturnedHtml: boolean;
  authUserFacingError: string | null;
  // Error log
  errors: string[];
}

export const _dbg: DebugSnapshot = {
  userId: null, authReady: false, sessionExists: false,
  profileExists: false, effectiveProfileExists: false,
  fetchFailed: false, spinnerTimedOut: false, forceProceed: false,
  onboardingComplete: false, route: "/", finalGateDecision: "init",
  phase: "init",
  identifierInputState: null, passwordInputLength: 0,
  identifierValuePropName: "email", passwordValuePropName: "password",
  onChangeIdentifierFiring: false, onChangePasswordFiring: false,
  submitButtonClicked: false, formOnSubmitFired: false,
  submitHandlerEntered: false, submitBlockedReason: null, renderCount: 0,
  submittedIdentifier: null, submittedPasswordPresent: false,
  signInStarted: false, loginStarted: false,
  signInCallEntered: false, signInAwaitCompleted: false,
  rawSignInResultExists: false, rawSignInDataExists: false, rawSignInErrorExists: false,
  rawSignInResultString: null, rawSignInErrorString: null,
  submitHandlerReturnedEarly: false, submitHandlerCatchTriggered: false,
  signInReturnedUser: false, signInReturnedSession: false,
  signInErrorMessage: null, signInErrorStatus: null,
  signInErrorName: null, signInErrorCode: null,
  exactAuthPayloadUsed: null,
  exactAuthError: null, authEvent: null, currentSessionUserId: null,
  signupNoSessionAttemptingAutoSignIn: false,
  autoSignInAfterSignup: false,
  emailConfirmationRequired: false,
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
  authRequestInProgress: false,
  authCallsThisAttempt: 0,
  lastAuthAction: null,
  authReturnedUser: false,
  authReturnedSession: false,
  postAuthProfileFetchStarted: false,
  postAuthProfileFetchSucceeded: false,
  profileQueryUserId: null,
  profileRowFound: null,
  profileInsertAttempted: false,
  profileInsertSucceeded: false,
  profileFetchMethodUsed: null,
  profileErrorMessage: null,
  authTimeoutPathEntered: false,
  authAbortControllerUsed: false,
  authAbortTriggered: false,
  authRequestStartedAt: null,
  authRequestEndedAt: null,
  authElapsedMs: null,
  supabaseSignInResolved: false,
  supabaseSignInRejected: false,
  rawSupabaseAuthError: null,
  timeoutMessageSource: null,
  submitHandlerNoSession: false,
  noSessionSilentFailure: false,
  realEmailInputFocused: false,
  realEmailEfp: undefined,
  authFetchStarted: false,
  authFetchCallCount: 0,
  authResponseStatus: null,
  authResponseContentType: null,
  authParseMode: null,
  authReturnedHtml: false,
  authUserFacingError: null,
  errors: [],
};

export const _dbgListeners = new Set<() => void>();

export function writeDebug(patch: Partial<DebugSnapshot>): void {
  Object.assign(_dbg, patch);
  // Defer so listeners never fire during a React render (avoids
  // "update during render" React warning from DebugOverlay).
  queueMicrotask(() => _dbgListeners.forEach(fn => fn()));
}

export function pushDebugError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  _dbg.errors = [`${ts} ${msg}`, ..._dbg.errors].slice(0, 12);
  _dbgListeners.forEach(fn => fn());
}

// ── Intention Wheel event log ──────────────────────────────────────────────
// Ring buffer for [INTENTION_WHEEL_STATE] events written by logWheelState()
// in intent.tsx. Read by WheelDebugPanel without going through React props,
// so RAF closures and class methods can write to it at any time.
export interface WheelEntry { event: string; _ts: string; [key: string]: unknown }
const _wheelEntries: WheelEntry[] = [];
const _wheelListeners2 = new Set<() => void>();

export function pushWheelEntry(entry: Record<string, unknown>): void {
  const e = { ...entry, _ts: new Date().toISOString().slice(11, 23) } as WheelEntry;
  _wheelEntries.unshift(e);
  if (_wheelEntries.length > 20) _wheelEntries.length = 20;
  queueMicrotask(() => _wheelListeners2.forEach(fn => fn()));
}

export function getWheelEntries(): WheelEntry[] { return _wheelEntries; }

export function subscribeWheelEntries(fn: () => void): () => void {
  _wheelListeners2.add(fn);
  return () => _wheelListeners2.delete(fn);
}
