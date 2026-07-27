---
name: Session boot race bugs
description: Three root causes of "Couldn't load profiles" on sign-in related to session ID registration timing and event ordering.
---

## Root causes

### 1. TOKEN_REFRESHED bypasses isLoading gate
`TOKEN_REFRESHED` falls through to the synchronous `setUser(u); setIsLoading(false)` path at the bottom of `onAuthStateChange`. If it fires while the SIGNED_IN or INITIAL_SESSION async IIFE is still in-flight (registering the session via session-check), `setIsLoading(false)` enables queries before `lulou_session_id` is updated to the new value. Queries then send the OLD (now-revoked) session ID and get 401 `session_replaced` → forced logout on the freshly-logged-in device.

**Fix:** `asyncAuthInProgressRef.current` — set `true` before each async IIFE, `false` inside the IIFE before `setUser`. Fall-through path guards with `if (asyncAuthInProgressRef.current && event !== "SIGNED_OUT") return;`.

### 2. PASSWORD_RECOVERY doesn't register a session
`PASSWORD_RECOVERY` used to set `passwordRecovery = true` and fall through to `setUser(u)` without calling session-check. If `lulou_session_id` was stale in localStorage from a prior login, every API request in the PasswordRecoveryGate got 401 `session_replaced` → forced logout mid-recovery.

**Fix:** PASSWORD_RECOVERY now has its own async IIFE that clears `lulou_session_id`, calls `/api/auth/session-check` to register the recovery session, then calls `setPasswordRecovery(true)` + `setUser(u)`. Fail-open (missing session ID → middleware skips check).

### 3. Middleware couldn't distinguish recoverable from non-recoverable 401s
The middleware returned `session_replaced` for BOTH "no active_sessions row at all" and "row exists but different session ID". The client treated both as forced-logout. After PASSWORD_RECOVERY fix above, `invalid_session` (no row) triggers transparent re-registration in `getQueryFn` and an immediate retry — the caller never sees an error.

**Fix:** Server middleware checks `!row` → `invalid_session`; `row.sessionId !== clientSessionId` → `session_replaced`. Client `getQueryFn` catches `invalid_session`, calls `_attemptSessionReregistration()`, retries the request transparently. Only `session_replaced` triggers forced-logout.

**Why:** The `invalid_session` state is temporary and recoverable (race before session-check, password recovery, password change). `session_replaced` is definitive (another device owns the session).

**How to apply:** Any future changes to `isAuthenticated` middleware or `getQueryFn` must preserve this two-code distinction.
