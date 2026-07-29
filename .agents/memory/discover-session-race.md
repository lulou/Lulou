---
name: Discover session race — isSessionReady + stale invalid_session guard
description: Root cause and fix for "Couldn't load profiles" after bfcache restore / app reopen on iPhone.
---

## Root cause

On bfcache restore, the INITIAL_SESSION event fires and sets `isSessionReady = false` while it
re-verifies the session. During that window (200–500 ms), the prefetch effect in App.tsx was gated
on `user && profileReady && !clearingCache` — but NOT on whether the session ID was valid. Any
prefetch that fired in that window sent the OLD `lulou_session_id` and received `401 invalid_session`
from the server. Before this fix, that immediately dispatched `lulou:session-bootstrap-needed` →
`setSessionBootstrapFailed(true)` → retry screen OR Discover stayed in permanent error state.

## Fix (commit c92dcb6)

### Stale-request guard for `invalid_session` (queryClient.ts `getQueryFn`)
Same pattern as the `session_replaced` guard added earlier. Captures `sessionId` before the fetch;
after a 401 `invalid_session`, compares to current `getAppSessionId()`. If they differ → bootstrap
ran mid-flight → suppress `lulou:session-bootstrap-needed` dispatch and let React Query retry
silently with the new ID.

Also writes diagnostic JSON to `sessionStorage.lulou_diag_discover_error` whenever `/api/discover`
returns `invalid_session` — consumed by the Discover error screen's collapsible debug panel.

### `isSessionReady` state in `use-auth.ts`
- Starts `false`.
- Set to `false` again at the START of the INITIAL_SESSION block (synchronous, before async IIFE).
- Set to `true` in every success exit:
  - SIGNED_IN bootstrap ok
  - PASSWORD_RECOVERY bootstrap ok
  - Stripe-return fast-path
  - INITIAL_SESSION IIFE — both verify-ok (no bootstrap) and bootstrap-ok paths
  - TOKEN_REFRESHED / generic path (guarded `event !== "SIGNED_OUT"`)
  - `retrySessionBootstrap` ok
- Set to `false` in `logout`.

### Query reset after bootstrap
After `localStorage.setItem("lulou_session_id", ...)` in the INITIAL_SESSION IIFE, SIGNED_IN
bootstrap, and `retrySessionBootstrap`: iterate `[["/api/discover"], ["/api/matches"], ["/api/who-liked-you"]]`
and call `queryClient.resetQueries({ queryKey: _k })` for any that are in error state. This clears
the stale error so the query refetches cleanly when the component mounts.

### App.tsx prefetch gate
Added `isSessionReady` to the guard (`!isSessionReady → return`) and to the deps array. This means
the prefetch fires only AFTER INITIAL_SESSION verify/bootstrap completes, ensuring the new session
ID is in localStorage when the prefetch request is made.

### Discover error screen (discover.tsx)
Added `DiscoverDiagPanel` component: collapsible "Debug info" button that renders a table of auth +
session diagnostics (commit hash, last auth event, session verify result, bootstrap status, fetch
HTTP status, server reason, sent vs current session ID prefix, stale-request flag). All reads are
synchronous (localStorage + sessionStorage); no async work at render time.

**Why:** Without the `isSessionReady` gate, any bfcache restore where the prefetch fired before
INITIAL_SESSION completed produced a permanent Discover error. Without the stale guard, even a
single in-flight request with the old ID could show the retry screen despite the bootstrap
succeeding.

**How to apply:** If a new protected query is added to App.tsx's prefetch list, it will
automatically benefit from the `isSessionReady` gate. The stale guard in `getQueryFn` is
query-agnostic. The diagnostic capture currently only fires for `/api/discover` — extend the
`_diagKey` logic if other queries need their own sessionStorage key.
