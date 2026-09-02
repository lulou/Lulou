---
name: Legacy onboarding compatibility
description: Grandfathering rule for established accounts created before tutorial and Connection DNA became mandatory.
---

**Rule:** Treat a user as an established legacy account only when their durable
profile was created before the mandatory onboarding rollout and the profile was
already marked complete. Legacy access bypasses the mandatory tutorial and DNA
router gates, but it does not create DNA answers, dimensions, scores, or completion
rows.

**Why:** Mandatory onboarding was introduced after established users were already
active. Missing newly introduced settings or DNA rows therefore cannot by itself
mean that a pre-rollout completed profile is a new or abandoned account.

**How to apply:** Keep the rollout boundary and classification in shared server/client
logic. Genuinely new accounts at or after the boundary must still complete tutorial
and DNA in order. Backfill only the tutorial completion flag for positively classified
legacy profiles, using an idempotent update; matching must continue using its existing
missing-DNA fallback.