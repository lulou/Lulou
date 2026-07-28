---
name: False iPhone auto-logout race
description: Root cause and fix for users being randomly signed out on iPhone with no second device involved.
---

## The bug

On iOS bfcache restore (app reopen after ~15 min background), three things fire simultaneously:

1. **React Query** auto-refetches with the OLD session ID (from localStorage)
2. **Heartbeat** fires immediately on `visibilitychange` with the OLD session ID
3. **INITIAL_SESSION** starts the verify + bootstrap async IIFE

Bootstrap completes ~300–500 ms later and calls `cacheSessionIdValid(userId, OLD_SESSION_ID, false)` on the server.

Any React Query or heartbeat request that was **already in-flight** with the old session ID now arrives **after** bootstrap has run. The server's middleware fast-reject path had `cached === false` → always returned `message: "session_replaced"` — even though the replacement was the same device re-logging in.

`queryClient.ts` saw `session_replaced` → dispatched `lulou:session-replaced` → forced signout.  
Heartbeat handler saw `session_replaced` → dispatched `lulou:session-replaced` → forced signout.

No second device involved.

## The fix (commit 2ee0cc8)

### Server (`server/routes.ts`)
- `_sessionIdCache` now stores a `reason` field: `"session_replaced"` | `"invalid_session"`
- `cacheSessionIdValid()` accepts optional `reason` parameter
- `lookupSessionIdCacheReason()` helper reads the cached reason
- **Middleware fast-reject** now uses the cached reason, defaulting to `"invalid_session"` when no reason is stored (safe default)
- `session-check` and `session-bootstrap`: pass `oldSessionWasDifferentDevice ? "session_replaced" : "invalid_session"` — this is the KEY fix; same-device bootstrap no longer poisons the cache with `session_replaced`
- `session-verify`: maps DB-determined reason to the correct cache reason

### Client stale-request guard

**Pattern**: capture `sessionId` from localStorage *before* the fetch; after getting `401 session_replaced`, compare against `localStorage.getItem("lulou_session_id")` again. If they differ, bootstrap completed mid-flight → skip the `lulou:session-replaced` dispatch.

Applied to three places:
- `throwIfResNotOk` in `queryClient.ts` (accepts `sentSessionId` param; `apiRequest` passes `sessionId`)
- `getQueryFn` 401 handler (uses `sessionId` already captured at line 348)
- `sendHeartbeat` in `use-auth.ts` (compares captured `sessionId` vs post-response localStorage)

**Why:** `sentSessionId !== currentSessionId` → bootstrap already completed with a new ID → this is a stale in-flight request, NOT a genuine second-device replacement. `sentSessionId === currentSessionId` → session hasn't changed on this device → replacement is genuine.

## What still triggers forced logout (correct)
- Realtime `private-session:{sessionId}` broadcast from Device B's bootstrap → `lulou:session-replaced` ✓
- Heartbeat 401 `session_replaced` with the CURRENT (non-stale) session ID → stale guard passes, event dispatched ✓
- React Query 401 `session_replaced` with the CURRENT session ID → same ✓

**Why:** In genuine replacement, `currentSessionId` hasn't changed on Device A (no bootstrap ran). In false-positive race, `currentSessionId` has changed (bootstrap already stored the new ID).
