---
name: Post-call meet availability
description: Durable rules for the post-call availability agreement state machine and acceptance behavior.
---

Post-call meet availability is a separate domain from pre-first-call scheduling. Resolve it as `none_submitted`, `self_only`, `other_only`, `both_match`, or `both_mismatch`. Offer Accept only for `other_only`; accepting must copy the counterpart's persisted canonical value rather than rebuilding it from display text, and must reject a stale or already-answered write.

**Why:** A previous implementation added acceptance to first-call scheduling, leaving the actual post-call flow without Accept or realtime updates. The corrected five-state flow and immediate two-device updates were confirmed in production.

**How to apply:** Preserve participant-relative labels, show Ready to Meet only for `both_match`, and broadcast every post-call availability save or acceptance to both active chat clients.