---
name: Session bootstrap retry flow
description: Verify-first strategy for SIGNED_IN, INITIAL_SESSION reverse dedup, atomic run record, and all diagnostic keys written by use-auth.ts.
---

## The problem this solves

The retry screen was appearing for two reasons:
1. **Race**: SIGNED_IN failed bootstrap → `setSessionBootstrapFailed(true)`. INITIAL_SESSION then succeeded but never cleared the failure flag (fixed by `authAttemptRef` generation counter + `setSessionBootstrapFailed(false)` on all success paths).
2. **isSessionReadyRef stale read**: `useEffect` syncing `isSessionReadyRef` runs *after* paint. A fetch callback arriving between `setIsSessionReady(true)` and the effect execution reads stale `false`, dispatches `lulou:session-bootstrap-needed`, and re-shows the failure screen even though the session was valid.
3. **iOS PWA page-restore block**: SIGNED_IN fires before INITIAL_SESSION on iOS PWA restores. Old code always bootstrapped on SIGNED_IN — if bootstrap failed transiently (cold-start, JWT timing) the user was blocked even though their existing session was valid.

## Fixes applied

### Stale diagnostic key cleanup
Both SIGNED_IN and INITIAL_SESSION handlers clear all `lulou_diag_*` keys (including `lulou_diag_run`) at the very start of their handling, before the async IIFE. Prevents any cross-run mixing of diagnostic values in the debug panel.

### SIGNED_IN IIFE — verify-first strategy (replaces bootstrap-first)
1. Cleanup all diag keys
2. Read `lulou_session_id` from localStorage
3. **If exists**: call `/api/auth/session-verify` with stored session ID
   - If `valid:true` → enter app immediately (`setUser`, `setIsSessionReady(true)`) WITHOUT bootstrap
   - If `valid:false` or network error → fall through to bootstrap
4. **Bootstrap** only when: no session ID, or verify returned false
5. Wrapped in outer `try/catch` — uncaught errors never leave user spinning
6. `_rr` object + `_wr()` function write `lulou_diag_run` incrementally throughout

**Why:** On iOS PWA page restores, the existing session is valid but bootstrap failed transiently. Verify is a read-only check; it doesn't create or revoke sessions, so it's safe to call first.

### INITIAL_SESSION — reverse dedup
Before setting `bootstrapInProgressForUserRef.current = newUserId`, check:
```javascript
if (bootstrapInProgressForUserRef.current === newUserId) {
  // SIGNED_IN already in-flight for this user — bail out
  asyncAuthInProgressRef.current = false;
  return;
}
```
**Why:** SIGNED_IN fires synchronously first and holds the lock. INITIAL_SESSION starting its own verify/bootstrap would cause double-bootstrap (two sessions, one immediately revoked) and `setIsSessionReady(false)` would flicker the app even if SIGNED_IN already succeeded.

### `callSessionBootstrap(token, deviceId, caller?)`
- `caller` param (string tag, e.g. `"INITIAL_SESSION-verify-expired"`, `"retry"`, `"SIGNED_IN"`)
- Writes `lulou_diag_bootstrap_http`, `lulou_diag_bootstrap_body`, `lulou_diag_bootstrap_caller`

### INITIAL_SESSION IIFE
- Writes `lulou_diag_jwt_exp` and `lulou_diag_jwt_sub` after diagnostic snapshot
- Passes caller tag string to every `callSessionBootstrap` call
- Writes `lulou_diag_failure_branch` and `lulou_diag_run` before each of the 3 `setSessionBootstrapFailed(true)` calls:
  - `init-verify-${d.reason}-bootstrap-fail`
  - `init-401-invalid-bootstrap-fail`
  - `init-no-sid-bootstrap-fail`
- Writes `lulou_diag_run` in the summary block (all success/non-early-exit paths)

### Atomic run record — `lulou_diag_run`
Written as a single `JSON.stringify` with these fields:
```
event, authAttemptId, jwtPresent,
storedSessionIdBefore, verifyCalled, verifyStatus,
bootstrapCalled, bootstrapStatus,
returnedSessionIdPresent, storedSessionIdAfter,
finalState, branch, ignoredStaleResult
```
`finalState` values: `"ready"`, `"retry"`, `"replaced"`, `"deduped"`, `"stale-discarded"`, `"(in-flight)"`
`branch` values: `"SIGNED_IN-verify-ok"`, `"SIGNED_IN-bootstrap-ok"`, `"SIGNED_IN-bootstrap-failed"`,
  `"INITIAL_SESSION-verify-ok"`, `"INITIAL_SESSION-bootstrap-ok"`, `"INITIAL_SESSION-deduped-SIGNED_IN-in-flight"`, etc.

### `useLayoutEffect` for `isSessionReadyRef` sync
Changed `useEffect` → `useLayoutEffect` on `isSessionReadyRef.current = isSessionReady`.
Runs synchronously after React commit, before browser paint and before macrotask fetch callbacks.

### `retrySessionBootstrap` — verify-first strategy
1. Concurrency guard (`asyncAuthInProgressRef.current` check at top)
2. Clears stale retry diag keys
3. Gets fresh Supabase session (auto-refreshes JWT)
4. Verify-first: if `lulou_session_id` exists, calls `/api/auth/session-verify` — if `valid:true`, enters app WITHOUT bootstrap
5. Bootstrap only if no session ID or verify returned false
6. `setSessionBootstrapFailed(false)` before `setUser(u)` on every success path

Diagnostic keys: `lulou_diag_retry_start`, `lulou_diag_retry_jwt_exp`, `lulou_diag_retry_has_sid`, `lulou_diag_retry_verify`, `lulou_diag_retry_outcome`

### App.tsx retry screen panel — `lulou_diag_run` first
- Parses `lulou_diag_run` as PRIMARY section `[CURRENT_RUN]` (all fields from one run, guaranteed no cross-run mixing)
- Individual legacy keys shown in secondary `[CONTEXT]` section for cross-check
- Shows `(no run record)` when running pre-update code

**Why:**
- The isSessionReadyRef stale read was the most likely cause of persistent failures
- Verify-first means iOS PWA page-restore users enter the app if their session is valid, even when bootstrap would have failed transiently

**How to apply:**
- Never change `useLayoutEffect` back to `useEffect` for `isSessionReadyRef` sync
- Any new bootstrap call site must pass a caller string to `callSessionBootstrap`
- All `setSessionBootstrapFailed(true)` calls must write `lulou_diag_failure_branch` and `lulou_diag_run` immediately before them
- `asyncAuthInProgressRef.current` must be reset to `false` on EVERY exit path
- Clear all `lulou_diag_*` keys at the start of each SIGNED_IN / INITIAL_SESSION handler
