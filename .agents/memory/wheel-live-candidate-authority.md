---
name: Wheel live candidate authority
description: How the Intention Wheel reconciles live API candidate updates with its protected spin presentation.
---

**Rule:** Freeze the current candidate order only while a spin or result presentation
is active. Once that lock is released, every successful candidate response is
authoritative, including an empty array; never substitute a previous non-empty pool.

**Why:** Reusing the last non-empty pool can show profiles that no longer satisfy the
current radius, preferences, or interaction exclusions while Discover correctly shows
an empty live feed.

**How to apply:** Protect the in-flight winner and card order with the presentation
lock. After dismissal, release the lock, refetch, and replace or clear the resting
cards from the response. Loading placeholders must not survive a completed empty
response.