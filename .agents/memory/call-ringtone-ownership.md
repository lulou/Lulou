---
name: Call ringtone ownership
description: Durable lifecycle rule for global incoming ringtone and outgoing ringback behavior.
---

Ringtone and ringback state belong to the authoritative server-backed call session, not to the lifecycle of a React overlay, page, cache row, or Realtime event.

**Why:** Overlay remounts, temporary query gaps, startup verification, and tab navigation can run effect cleanup while the same call is still ringing. Realtime events can also be replayed after termination. Async verification creates replacement and terminal races unless ownership stays exact-session scoped.

**How to apply:** Treat Realtime as a prompt, not authority: verify the exact session, callee, caller, unanswered state, and age on the server before arming. Fail silent but retry transient verification failures. Cleanup must stop only the rejected session. A terminal event must promote any startup-only cancellation to permanent so a late verification cannot revive it.