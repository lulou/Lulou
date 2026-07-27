---
name: Single-session enforcement
description: How Lulou enforces one active session per account — the full architecture and key gotchas.
---

# Single-Session Enforcement Architecture

## Model: REVOKE (newest login always wins)
The spec requires a REVOKE model, not a BLOCK model. When a new device logs in, the old session is revoked atomically and the new login always succeeds. The old device is notified via realtime broadcast and signed out. A "blocked: true" response is NEVER returned.

## The production bug root cause
`INITIAL_SESSION` (page refresh) never called `session-check`. It trusted the stored Supabase token unconditionally. Forgot Password didn't clear the token. So: Forgot Password → refresh → old account silently restored.

## Server (server/routes.ts)

- `active_sessions` table: one row per user (unique on userId), `revoked_at`/`revoked_reason` columns
- `_sessionIdCache`: in-process LRU Map (30s TTL, 1000 entries) keyed by `userId:sessionId`. Immediate event-invalidation on session replacement (no 30s gap — revoked sessions are set to `false` immediately).
- `isAuthenticated` middleware: if `X-Session-Id` header present, checks cache → DB. Returns 401 `{message:"session_replaced"}` on mismatch.
- `session-check` (POST): REVOKE model — always upserts new session, captures old sessionId, marks it `false` in cache immediately, broadcasts `session-replaced` to `private-session:{oldSessionId}` (SESSION-SCOPED, not user-scoped). Returns `{allowed:true, sessionId}` always.
- `session-verify` (POST): INITIAL_SESSION path — validates stored sessionId against DB, touches last_seen_at. Fail-open on DB errors.
- `heartbeat`: conditional UPDATE WHERE session_id matches. Old device heartbeat is a no-op, doesn't re-claim the row.
- `DELETE /api/auth/session`: invalidates session in cache before deleting row.

## Client (use-auth.ts)

- `INITIAL_SESSION` with valid session: async verify via `session-verify`; on failure: clear local Supabase session, remove `lulou_session_id`, set `lulou_forced_logout`, show login.
- Devices with no `lulou_session_id` (legacy): call `session-check` to register; always gets `allowed:true` (REVOKE model never blocks).
- `SIGNED_IN` handler: no `deviceBlocked` state or `isBlocked` flag — session-check always grants the login.
- **`private-session:{mySessionId}`** realtime channel (SESSION-SCOPED): subscribes to OWN session ID so only this device receives its forced-logout broadcast. The new device subscribes to its own different session ID — it never sees the old device's broadcast.
- Broadcast handler: defense-in-depth check `payload.newSessionId !== mySessionId` to prevent acting on stale broadcasts.
- `lulou:session-replaced` event: `queryClient.clear()` FIRST, THEN `setUser(null)` — prevents Account B from briefly seeing Account A's cached data. Then stopAllCallSounds, clearAllArmedSessions, setCachedToken(null), signOut({scope:"local"}).
- Heartbeat: sends `X-Session-Id` header, handles 401 `session_replaced` → dispatches event.
- `deviceBlocked` state REMOVED — REVOKE model makes it impossible to be blocked.

## Client (queryClient.ts)

- `apiRequest` and `getQueryFn`: send `X-Session-Id` on every authenticated request.
- Both intercept 401 `session_replaced` body and dispatch `lulou:session-replaced` event.

## Client (landing.tsx)

- `handlePasswordReset`: pre-checks `supabase.auth.getSession()` first. If a stored session exists, shows `fpSignOutPrompt` dialog: "You're currently signed in as [email]. Sign out first?" with "Keep me signed in" / "Sign out and send reset" buttons.
- `handlePasswordResetConfirmed`: called when user confirms sign-out — clears session + calls `_sendPasswordReset()`.
- `_sendPasswordReset()`: the actual reset email sender — always clears local session first as guard.
- Toast: "You were signed out because this account was opened on another device."

## Fail-open policy
Network errors / 5xx on session-verify → `verified = true` (user stays in app). Only explicit `{valid:false}` or 401 triggers sign-out.

## Key invariant: no 30-second security gap
When session S1 is revoked, `cacheSessionIdValid(userId, S1, false)` is called BEFORE the upsert completes. The old device's next request hits `S1→false` in cache immediately → 401. The 30s TTL only applies to VALID sessions (how long they're cached as valid before re-checking DB). Revoked sessions are immediately `false` and stay `false` until the cache entry expires (at which point the DB query confirms revoked_at IS NOT NULL → false again).
