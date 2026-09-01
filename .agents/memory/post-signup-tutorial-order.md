---
name: Post-signup tutorial ordering
description: Required relationship between profile onboarding, Connection DNA, and the one-time Lulou tour.
---

The required account journey is: sign up → email verification → profile onboarding → required one-time Lulou tutorial → Connection DNA questionnaire and completion explanation → normal app.

**Why:** Both the introduction and DNA are mandatory account setup. Previously, the tutorial was mounted inside the already-unlocked app and DNA status failed open, so new users could bypass one or both through timing, deep links, or a cached session.

**How to apply:** Resolve all stages centrally before the main layout using server-backed profile, tutorial, and DNA state. Never fail open or use browser-storage overrides. Mark the profile's overall onboarding flag only after DNA completion.