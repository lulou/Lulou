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
