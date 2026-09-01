---
name: Auth callback pattern
description: Canonical production callback and reliable Supabase email-link session restoration.
---

Use `https://www.luloudating.com/auth/callback` as the canonical production email callback. Keep the non-`www` callback temporarily allow-listed only so links issued before the canonical switch still work.

**Why:** The public domain redirects non-`www` to `www`, and an intermediate origin redirect can lose or delay implicit auth-fragment processing in mobile email browsers. A valid Supabase hash also failed to auto-persist in a real callback test, so the callback must explicitly restore sessions from `access_token` and `refresh_token`. Supabase `/auth/v1/user` can transiently return truncated JSON while still claiming `application/json`; blindly passing it to the SDK surfaces a raw `JSON.parse` SyntaxError. The full app can also start protected prefetches while callback restoration is still underway.

**How to apply:** New signup/resend links should request the canonical `www` callback. On `/auth/callback`, disable Supabase's automatic URL detection, handle PKCE codes explicitly, and call `setSession` when implicit tokens are present; never log token values. Mount the callback outside normal app providers so protected queries cannot start early. Validate auth response JSON before the SDK parses it; retry only idempotent user lookup once and otherwise show a controlled retry state. If production frontend and API origins differ, the API CORS allowlist must include `X-Session-Id`. Keep signup success visible until the user chooses to continue.