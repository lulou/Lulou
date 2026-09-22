---
name: Atomic message quota
description: Durable rule for sender-specific stage quotas across text and voice messages.
---

Create the authoritative user message, enforce the sender's current stage limit, record idempotency, and update that sender's quota in one row-locked database transaction.

**Why:** Separate insert and counter operations can consume quota for a failed message, exceed the limit under concurrent sends, or let voice notes bypass text quotas. An HTTP pre-limit rejection also blocks a deterministic retry of the final already-committed message.

**How to apply:** Route every quota-consuming user message type through the same transaction and classifier. Use a stable message ID for retries. Reconcile realtime progression independently from message-ID dedup because WAL can arrive before the richer broadcast.