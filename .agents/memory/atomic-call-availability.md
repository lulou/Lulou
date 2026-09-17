---
name: Atomic call availability
description: Concurrency and cache-ordering rules for first-call availability.
---

First-call availability selection must atomically update the acting user's timestamp, recompute the shared agreement, and increment a persisted row revision. Realtime and HTTP snapshots are accepted only in revision order. Call creation must be conditional on both the validated agreement and its revision; expiry clearing must also be conditional and revisioned.

**Why:** Separate timestamp/agreement writes expose stale agreements during concurrent changes, and process-local timestamps or counters cannot reliably order delayed responses across requests, instances, or restarts.

**How to apply:** Any future availability mutation belongs in the authenticated, row-locked database operation. Do not reintroduce client-only ordering or a read/compute/write sequence in application code.