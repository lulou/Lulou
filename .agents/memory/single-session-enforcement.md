---
name: Single-session enforcement
description: How Lulou enforces one active session per account — the full architecture and key gotchas.
---

# Single-Session Enforcement Architecture

## The production bug root cause
`INITIAL_SESSION` (page refresh) never called `session-check`. It trusted the stored Supabase token unconditionally. Forgot Password didn't clear the token. So: Forgot Password → refresh → old account silently restored.

## What was built (all in one task)

### Server
- `active_sessions` table: one row per user (unique on userId), `revoked_at`/`revoked_reason` columns
- `_sessionIdCache`: in-process LRU Map (30s TTL, 1000 entries) keyed by `userId:sessionId`. Avoids DB on every request.
- `isAuthenticated` middleware: if `X-Session-Id` header present, checks cache → DB. Returns 401 `{message:"session_replaced"}` on mismatch.
- `session-check` (POST): on new login, captures old sessionId, broadcasts `session-replaced` to `private-user:{userId}` realtime channel, marks old ID as `false` in cache.
- `session-verify` (POST): INITIAL_SESSION path — validates stored sessionId against DB, touches last_seen_at. Fail-open on DB errors.
- `heartbeat`: changed from UPSERT to conditional UPDATE WHERE session_id matches. Old device heartbeat is a no-op, doesn't re-claim the row.
- `DELETE /api/auth/session`: invalidates session in cache before deleting row.

### Client (use-auth.ts)
- `INITIAL_SESSION` with valid session: async verify via `session-verify`; on failure: clear local Supabase session, remove `lulou_session_id`, set `lulou_forced_logout`, show login.
- Devices with no `lulou_session_id` (legacy): call `session-check` to register, enter app normally.
- `private-user:{userId}` realtime channel: on `session-replaced` broadcast → dispatch `lulou:session-replaced` window event.
- `lulou:session-replaced` event listener: stopAllCallSounds, clearAllArmedSessions, setCachedToken(null), setUser(null), queryClient.clear(), signOut({scope:"local"}).
- Heartbeat: sends `X-Session-Id` header, handles 401 `session_replaced` → dispatches event.

### Client (queryClient.ts)
- `apiRequest` and `getQueryFn`: send `X-Session-Id: localStorage.getItem("lulou_session_id")` on every authenticated request.
- Both intercept 401 `session_replaced` body and dispatch `lulou:session-replaced` event.

### Client (landing.tsx)
- `handlePasswordReset`: calls `supabase.auth.signOut({scope:"local"})` + removes `lulou_session_id` BEFORE sending the reset email. This is the direct fix for the reported bug.

## Fail-open policy
Network errors / 5xx on session-verify → `verified = true` (user stays in app). Only explicit `{valid:false}` or 401 triggers sign-out. Same policy as the existing session-check path.

## Session toast
`lulou_forced_logout` sessionStorage key → landing.tsx reads it on mount and shows "You've been signed out — account opened on another device."

**Why:** Consistent with the existing toast infrastructure; avoids needing React state to survive a page reload.
