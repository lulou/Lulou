---
name: checkEmailVerified admin API timeout
description: supabaseAdmin.auth.admin.getUserById() hangs in Replit network; must have a hard timeout or the isAuthenticated middleware blocks every request on cache miss.
---

## Rule

`checkEmailVerified()` in `server/routes.ts` wraps `supabaseAdmin.auth.admin.getUserById(userId)` in a `Promise.race` with a **2500ms timeout** (`EMAIL_VERIFIED_TIMEOUT_MS`). On timeout it fails-open (returns `true`) and logs `[AUTH] checkEmailVerified TIMEOUT`.

**Why:** Supabase admin API calls (auth.admin.getUserById, auth.getUser, etc.) hang indefinitely in Replit's network environment with UND_ERR_HEADERS_TIMEOUT. This is the same root cause that forced `isAuthenticated` to switch from `supabase.auth.getUser()` to local JWT decode. Without the timeout, every request where the `_emailVerifiedCache` has no entry (first request after restart, or every 5 minutes for verified users) blocks until the client's 4-second AbortController fires → 3 retries → `fetchFailed=true` → "Taking a little longer. We're reconnecting you to Lulou." screen.

**How to apply:** Any time you add a Supabase admin API call (`supabaseAdmin.auth.admin.*`) inside a synchronous request handler or middleware, always wrap it in `Promise.race([actualCall, timeoutPromise])` with a timeout of 2000–2500ms. Never assume admin API calls will be fast in Replit's network.

**Cache TTL:** Verified users cached for 5 min (`EMAIL_VERIFIED_CACHE_TTL_MS`), unverified for 60 s (`EMAIL_VERIFIED_UNVERIFIED_TTL_MS`). The timeout only fires on cache miss.

**Timing logs added:**
- `isAuthenticated` now logs `checkEmailVerified` duration and warns if >500ms
- `checkEmailVerified` logs the admin API response time on success and explicitly names TIMEOUT vs other errors
