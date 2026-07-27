---
name: Session boot race bugs
description: Root causes and fixes for session boot issues; also documents the fail-CLOSED architecture now in force.
---

## Current architecture (fail-CLOSED)

A valid Supabase JWT without a verified active Lulou session NEVER grants access
to any protected endpoint. This is non-negotiable.

### Bootstrap flow (SIGNED_IN / INITIAL_SESSION / PASSWORD_RECOVERY)
1. Auth event fires → `asyncAuthInProgressRef.current = true`, `isLoading = true`
2. Call `POST /api/auth/session-bootstrap` (JWT only, no X-Session-Id required)
3. Server generates session ID, atomically revokes old session, returns `{ sessionId }`
4. Client stores `lulou_session_id` in localStorage
5. `setUser(u)`, `isLoading = false` — queries now enabled
6. If bootstrap fails → `sessionBootstrapFailed = true`, `isLoading = false`, NO `setUser`
   → App shows "Session verification failed" with Retry / Sign out buttons

### Middleware gate
- Missing X-Session-Id: 401 `invalid_session` "Application session is missing."
- Exempt paths: `/api/auth/session-bootstrap`, `/api/auth/session-check`
- No active_sessions row: 401 `invalid_session`
- Row exists, different session: 401 `session_replaced`
- DB error: fail-open (to prevent DB outages from locking everyone out)

### INITIAL_SESSION nuances
- storedSessionId exists → call session-verify
  - 200 valid=true → proceed
  - 200 valid=false reason=invalid_session → bootstrap (session expired, not replaced)
  - 200 valid=false reason=session_replaced → sign out
  - 401 invalid_session → bootstrap
  - 401 session_replaced → sign out
  - 5xx/network → fail-open (DB outage policy)
- No storedSessionId → bootstrap (fail-closed)

### queryClient.ts
- `invalid_session` from a query → dispatch `lulou:session-bootstrap-needed` → retry screen
- `session_replaced` from a query → dispatch `lulou:session-replaced` → forced logout
- No transparent re-registration. `_attemptSessionReregistration` was removed.

---

## Historical root causes (before fail-CLOSED)

### 1. TOKEN_REFRESHED bypasses isLoading gate
Fix: `asyncAuthInProgressRef.current` flag; fall-through guards with `if (asyncAuthInProgressRef.current && event !== "SIGNED_OUT") return;`

### 2. PASSWORD_RECOVERY didn't register a session (fail-open)
Old: fell through to `setUser(u)` without session registration. Now: bootstrap, fail-closed.

### 3. Middleware couldn't distinguish recoverable from non-recoverable 401s
Fixed: `!row` → `invalid_session`; `row.sessionId !== clientSessionId` → `session_replaced`.

**Why:** `invalid_session` is recoverable (no row yet); `session_replaced` is definitive (another device owns it). The client reacts differently to each.
