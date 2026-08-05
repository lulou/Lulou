---
name: getMatchMeta Supabase column mismatch
description: call_avail_1 / call_avail_2 TEXT columns absent from Supabase; getMatchMeta SELECT must not include them.
---

# getMatchMeta Supabase column mismatch

## The rule
`getMatchMeta` in storage.ts must NOT select `call_avail_1` or `call_avail_2`. Those two TEXT columns were added to the Neon/Railway DB via Drizzle migration (`add_call_avail_columns.sql`) but **the same SQL was never applied to Supabase**. Selecting absent columns causes PostgREST to return a column-not-found error, which makes `getMatchMeta` return `null`, which the messages route interprets as 404 "Match not found" — blocking every message send.

**Why:** The legacy text columns (`call_avail_1`, `call_avail_2`) are being phased out in favour of `call_avail_1_at`, `call_avail_2_at`, `agreed_call_at` which DO exist in Supabase (added via `add_availability_timestamps.sql`). The replacement columns are in the SELECT and return correctly.

**How to apply:** If future work needs to re-add `call_avail_1` / `call_avail_2` to Supabase, apply `add_call_avail_columns.sql` via the Supabase SQL editor first. Until then, return `null` for `callAvail1` / `callAvail2` in the `getMatchMeta` return object.

## The chain this caused
1. `getMatchMeta` SELECT includes non-existent columns → PostgREST error
2. `if (error || !data) return null` → null returned
3. Route returns 404 "Match not found"
4. Message is never saved, RPC `increment_message_count` never fires
5. Supabase `message_count_1/2` stays at 0 forever
6. "Messages left" countdown never counts down in the UI

## How it was found
- GET /api/matches/:id (uses `getMatch`, different SELECT) worked fine → real JWT was valid
- POST /api/matches/:id/messages returned 404 despite match existing and being "active"
- Admin-scoped Supabase query confirmed match status = "active"
- Column-probe loop revealed `call_avail_1` and `call_avail_2` missing from PostgREST schema
