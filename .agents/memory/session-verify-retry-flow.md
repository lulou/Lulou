---
name: Session bootstrap retry flow
description: Full verify-first retry strategy for the session-bootstrap-failed screen, including all diagnostic keys written by use-auth.ts.
---

## The problem this solves

The retry screen was appearing for two reasons:
1. **Race**: SIGNED_IN failed bootstrap → `setSessionBootstrapFailed(true)`. INITIAL_SESSION then succeeded but never cleared the failure flag (fixed by `authAttemptRef` generation counter + `setSessionBootstrapFailed(false)` on all success paths).
2. **isSessionReadyRef stale read**: `useEffect` syncing `isSessionReadyRef` runs *after* paint. A fetch callback arriving between `setIsSessionReady(true)` and the effect execution reads stale `false`, dispatches `lulou:session-bootstrap-needed`, and re-shows the failure screen even though the session was valid.

## Fixes applied

### `callSessionBootstrap(token, deviceId, caller?)`
- Added `caller` param (string tag, e.g. `"INITIAL_SESSION-verify-expired"`, `"retry"`)
- Writes `lulou_diag_bootstrap_http` (HTTP status or `"network-error"`) and `lulou_diag_bootstrap_body` (first 120 chars of error body) at both success and failure paths
- Writes `lulou_diag_bootstrap_caller`

### INITIAL_SESSION IIFE
- Writes `lulou_diag_jwt_exp` (ISO) and `lulou_diag_jwt_sub` (first 8 chars) right after diagnostic snapshot
- Passes caller tag string to every `callSessionBootstrap` call
- Writes `lulou_diag_failure_branch` before each of the 3 `setSessionBootstrapFailed(true)` calls:
  - `init-verify-${d.reason}-bootstrap-fail`
  - `init-401-invalid-bootstrap-fail`
  - `init-no-sid-bootstrap-fail`

### `useLayoutEffect` for `isSessionReadyRef` sync
- Changed `useEffect` → `useLayoutEffect` on the `isSessionReadyRef.current = isSessionReady` sync block
- Runs synchronously after React commit, before browser paint and before macrotask fetch callbacks

### `retrySessionBootstrap` — verify-first strategy
1. Concurrency guard (`asyncAuthInProgressRef.current` check at top)
2. Clears stale retry diag keys
3. Gets fresh Supabase session (auto-refreshes JWT)
4. **Verify-first**: if `lulou_session_id` exists, calls `/api/auth/session-verify` — if `valid:true`, enters app immediately WITHOUT bootstrap
5. Bootstrap only if no session ID or verify returned false
6. `setSessionBootstrapFailed(false)` called BEFORE `setUser(u)` on every success path

Diagnostic keys written by `retrySessionBootstrap`:
- `lulou_diag_retry_start` — ISO timestamp when retry started
- `lulou_diag_retry_jwt_exp` — JWT expiry from `session.expires_at`
- `lulou_diag_retry_has_sid` — first-8-char prefix of existing session ID (or `"(none)"`)
- `lulou_diag_retry_verify` — `"${status}:${valid}:${reason}"` from verify call
- `lulou_diag_retry_outcome` — final outcome string

### App.tsx retry screen panel
- Replaced `<details><pre>` with `<DiagPanelInner lines={_bootDiag} />` (has copy button)
- `_bootDiag` string now includes all diag keys grouped by section:
  `[SESSION_BOOTSTRAP_FAILURE]`, `[JWT]`, `[VERIFY]`, `[BOOTSTRAP]`, `[FAILURE]`, `[SESSION_STATE]`, `[RETRY_ATTEMPT]`

**Why:**
- The isSessionReadyRef stale read was the most likely cause of persistent failures after the `authAttemptRef` fix
- The verify-first strategy means a single Retry tap resolves most race-induced failures without a full bootstrap round-trip

**How to apply:**
- Never change `useLayoutEffect` back to `useEffect` for `isSessionReadyRef` sync
- Any new bootstrap call site must pass a caller string to `callSessionBootstrap`
- All `setSessionBootstrapFailed(true)` calls must write `lulou_diag_failure_branch` immediately before them
- `asyncAuthInProgressRef.current` must be reset to `false` on EVERY exit path of `retrySessionBootstrap`
