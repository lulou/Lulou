---
name: Call ringtone ownership
description: Durable lifecycle rule for global incoming ringtone and outgoing ringback behavior.
---

Ringtone and ringback state belong to the authoritative server-backed call session, not to the lifecycle of a React overlay or page.

**Why:** Overlay remounts, temporary query gaps, startup verification, and tab navigation can run effect cleanup while the same call is still ringing. Stopping audio from those transitions produced a single ring or no ring even though the call session remained live.

**How to apply:** Start or retry audio while the exact armed session is ringing. Stop it only when that session answers, declines, cancels, expires, fails, connects, or is replaced. Navigation must not silence a valid global incoming call.