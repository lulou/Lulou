---
name: Auth callback pattern
description: Canonical production callback and reliable Supabase email-link session restoration.
---

Use `https://www.luloudating.com/auth/callback` as the canonical production email callback. Keep the non-`www` callback temporarily allow-listed only so links issued before the canonical switch still work.

**Why:** The public domain redirects non-`www` to `www`, and an intermediate origin redirect can lose or delay implicit auth-fragment processing in mobile email browsers. A valid Supabase hash also failed to auto-persist in a real callback test, so the callback must explicitly restore sessions from `access_token` and `refresh_token`.

**How to apply:** New signup/resend links should request the canonical `www` callback. On `/auth/callback`, handle PKCE codes explicitly and call Supabase `setSession` when implicit-flow tokens are present; never log token values. For signup confirmations opened in an in-app browser, keep the success state visible until the user chooses to continue.