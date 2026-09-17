---
name: Cross-database call settlement
description: Durable rules for coordinating authoritative Supabase call state with local Postgres entitlements.
---

Paid call credit and voice-note side effects must use a durable per-session terminal settlement row. Reserve paid credit atomically before creating the Supabase call session. Write the terminal settlement row before the session-qualified terminal transition, then reconcile its outcome from the authoritative terminal record.

**Why:** Supabase owns active call state while local Postgres owns credits and voice-note unlocks. A process failure between those stores can otherwise lose a refund/unlock or allow concurrent credit overspending.

**How to apply:** Credit reservation, terminal transitions, stale cleanup, and duplicate terminal requests must remain session-scoped and idempotent. Block a newer call while an earlier settlement is pending, and retry pending settlements at startup and periodically.