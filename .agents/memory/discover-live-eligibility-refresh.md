---
name: Discover live eligibility refresh
description: The refresh policy that keeps Discover from treating an exhausted candidate list as permanent.
---

Discover and the Intention Wheel must treat candidate lists as live eligibility feeds rather than permanent snapshots. A prior empty response must be refetched when the user returns to the relevant persistent tab and when the app returns to the foreground.

**Why:** A compatible person may complete onboarding after an existing user exhausts the previously returned stack. Caching an empty response indefinitely prevents the client from requesting that newly eligible profile, even though the server's live eligibility query would return it.

**How to apply:** Keep candidate queries immediately stale and use one guarded lifecycle path for persistent-tab entry, foreground, and bfcache restoration. Do not enable automatic focus/reconnect refetches on the shared candidate query: hidden persistent Wheel tabs remain subscribed, so they can otherwise receive new candidates during a spin. Freeze the Wheel presentation at spin start and only release it after a successful result dismissal. Preserve explicit invalidation after preference updates. Do not compensate by clearing interaction history or weakening compatibility, safety, match, block, or location filters.