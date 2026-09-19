---
name: Call-history idempotency
description: Durable rule for preventing duplicate missed, cancelled, and declined call events.
---

Use a deterministic valid UUID derived from the authoritative call session ID as the call-history message primary key, and insert with conflict-ignore semantics.

**Why:** Time-window deduplication and read-before-write checks race under concurrent cancel, decline, timeout, retry, or process failure. A unique deterministic database key provides atomic per-session idempotency.

**How to apply:** Include the call session ID in the event payload, derive the same message ID on every terminal retry, and send associated push notifications only when the insert actually created the row.