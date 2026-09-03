---
name: Call availability vs voice-note completion
description: Keeps the first-call message milestone separate from the authoritative voice-note unlock.
---

The first-call message threshold makes the included audio control available. It does not unlock voice notes. Voice notes become available only from the persisted post-call unlock written after the server accepts a valid completed included audio call.

**Why:** Treating an advanced call stage or a first-call-unlocked message event as proof of completion made the mic appear available before Call 1 had happened. Failed, declined, cancelled, unanswered, and too-short calls must leave it locked.

**How to apply:** Never infer voice-note access from message counts, call-stage availability, or `callStage > 0`. Persist and enforce explicit `post_call` provenance from the server’s valid-call completion result; legacy threshold rows must not authorize UI or uploads.