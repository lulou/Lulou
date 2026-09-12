---
name: Onboarding revalidation fallback
description: Reliable gating rules for completed users when onboarding status revalidation fails.
---

Once the server has resolved a user to the main app, preserve that last-known-good completion state. A later transient settings or DNA status failure must not replace normal app use with the first-time onboarding recovery screen. Positive incomplete server state still overrides and removes the fallback.

**Why:** TanStack Query can report an error while retaining previously successful data during background revalidation. Treating `isError` alone as fatal caused completed users to be interrupted during normal navigation.

**How to apply:** Gate fresh or genuinely unresolved users strictly. For previously server-confirmed completed or legacy-established users, keep the app visible, retry quietly, refresh authentication once on a real 401, and reserve the recovery screen for users with no trustworthy completion result after bounded retries.