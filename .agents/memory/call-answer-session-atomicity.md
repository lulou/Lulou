---
name: Call answer session atomicity
description: Rules for safely transitioning an incoming call into the active WebRTC experience.
---

An answer request must identify the exact call session it received. The database update must atomically require that session ID, an active start time and initiator, and unanswered/uncompleted state. Only an updated row may trigger the answered broadcast.

**Why:** Match-level answer updates can race with cancellation or a replacement call. A pre-read is insufficient: cancellation can clear the active fields after the read but before the update, producing an answered flag on a dead session.

**How to apply:** Every answer UI must send its current armed session ID and validate that the response still represents the same live, uncancelled session. Use that authoritative response to bridge immediately into the active overlay, and ignore stale null/unanswered query responses until an explicit end, cancel, disarm, or replacement session arrives.