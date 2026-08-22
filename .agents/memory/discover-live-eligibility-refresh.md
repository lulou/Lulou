---
name: Discover live eligibility refresh
description: The refresh policy that keeps Discover from treating an exhausted candidate list as permanent.
---

Discover must treat its candidate list as a live eligibility feed rather than a permanent snapshot. A prior empty response must be refetched when the user returns to Discover and when the app returns to the foreground.

**Why:** A compatible person may complete onboarding after an existing user exhausts the previously returned stack. Caching an empty response indefinitely prevents the client from requesting that newly eligible profile, even though the server's live eligibility query would return it.

**How to apply:** Keep the Discover query immediately stale, refetch it on mount and foreground, and preserve explicit invalidation after preference updates. Do not compensate by clearing interaction history or weakening compatibility, safety, match, block, or location filters.