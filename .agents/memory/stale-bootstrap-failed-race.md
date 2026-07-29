---
name: Stale sessionBootstrapFailed race
description: SIGNED_IN fails first, sets sessionBootstrapFailed=true; INITIAL_SESSION succeeds but never cleared it — app stuck on retry screen with valid session.
---

## Root cause

When Supabase fires SIGNED_IN before INITIAL_SESSION (can happen on page load), both compete
for `asyncAuthInProgressRef.current`. If SIGNED_IN acquires the lock first and its bootstrap
fails, it sets `sessionBootstrapFailed(true)` and releases the lock. INITIAL_SESSION then runs,
verifies OK, calls `setUser(u)` and `setIsSessionReady(true)` — but **never called
`setSessionBootstrapFailed(false)`**. The app renders the "Session verification failed" retry
screen even though the session is completely valid.

**Diagnostic fingerprint:**
```
authEvent: INITIAL_SESSION
sessionIdPrefix: (none)
verifyResult: ok:true:none
bootstrap: failed-SIGNED_IN     ← the SIGNED_IN failure
verifyEnd: {verified:true, bootstrapCalled:false, finalLogoutReason:null}
```

## Three-layer fix

### Layer 1 — `authAttemptRef` generation counter
`const authAttemptRef = useRef(0)` declared after `bootstrapInProgressForUserRef`.

At the start of every SIGNED_IN and INITIAL_SESSION async flow (synchronously, before the IIFE):
```javascript
authAttemptRef.current += 1;
const myAttemptId = authAttemptRef.current;
```

In every **failure path** before calling `setSessionBootstrapFailed(true)`:
```javascript
if (authAttemptRef.current !== myAttemptId) {
  // Newer attempt already ran; discard stale failure
  try { localStorage.setItem("lulou_diag_ignored_stale_result", "true"); } catch {}
  return;
}
setSessionBootstrapFailed(true);
```

Success paths do NOT check — a success always wins.

Covered failure sites: SIGNED_IN `!grantedSessionId`, INITIAL_SESSION three bootstrap-fail paths
(verify expired, 401 invalid, no session ID).

### Layer 2 — `setSessionBootstrapFailed(false)` on every success path
Previously only `retrySessionBootstrap` cleared the flag. Added to:
- INITIAL_SESSION `if (verified)` path — **the exact missing call in the observed bug**
- SIGNED_IN success path
- PASSWORD_RECOVERY bootstrap success
- Stripe-return fast-path (setIsSessionReady block)
- TOKEN_REFRESHED / generic path (guarded `event !== "SIGNED_OUT"`)

Also: on INITIAL_SESSION success, overwrite `lulou_diag_bootstrap_status` so the debug panel
no longer shows the old "failed-SIGNED_IN" text after recovery.

### Layer 3 — `isSessionReadyRef` guard on `session-bootstrap-needed` event
`const isSessionReadyRef = useRef(false)` synced by:
```javascript
useEffect(() => { isSessionReadyRef.current = isSessionReady; }, [isSessionReady]);
```

The event handler (stable `useEffect([], [])` closure) checks before showing retry screen:
```javascript
if (isSessionReadyRef.current) {
  console.warn("[AUTH] lulou:session-bootstrap-needed IGNORED — session already ready");
  return;
}
```

**Why:** A stale in-flight request sent before bootstrap completed can arrive AFTER bootstrap
succeeds and dispatch this event. Without the guard, it would flip `sessionBootstrapFailed=true`
even though the session is valid.

## Diagnostics additions
- `lulou_diag_auth_attempt_id` — generation counter value at start of each SIGNED_IN/INITIAL_SESSION
- `lulou_diag_ignored_stale_result` — "true" when a failure was suppressed; "false" on success

**Why:** Without these, it was impossible to tell from the debug panel whether a failure was the
current attempt or a stale one from a concurrent flow.

## How to apply
- Any new bootstrap failure path in use-auth.ts must include the `authAttemptRef.current !== myAttemptId` guard before calling `setSessionBootstrapFailed(true)`.
- Any new auth success path must call `setSessionBootstrapFailed(false)` before `setUser(u)`.
- The `isSessionReadyRef` sync pattern (useEffect + ref) is the correct approach for stable
  event-handler closures that need to read React state — do not pass `isSessionReady` as a
  dependency to the event-listener useEffect (that would re-register the listener on every change).
