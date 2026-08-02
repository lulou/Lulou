---
name: Call availability data format
description: What values are stored in call_avail_1/call_avail_2, how compatibility is computed, and the seed-auto-set removal.
---

## Stored values

`call_avail_1` / `call_avail_2` columns (TEXT) accept:
- Normalized keys: `available_now`, `in_30_minutes`, `in_1_hour`, `in_2_hours`
- ISO timestamp string (for "Pick a specific time")
- NULL (not yet set)

Old shorthand keys ("now", "30m", "1h", "2h", "later") and translated labels are **rejected** by server validation.

## Compatibility rule

Both server (`areAvailabilitiesCompatible` in routes.ts) and client (matches.tsx `availCompatible`) use the same logic:
- Each normalized key maps to an approximate offset in minutes from "now": `available_now=0`, `in_30_minutes=30`, `in_1_hour=60`, `in_2_hours=120`
- ISO timestamps: offset = (timestamp − Date.now()) / 60_000
- Compatible when `|offsetA − offsetB| ≤ 45` minutes
- Result: "now" + "30m" → compatible; "now" + "2h" → NOT compatible

**Why:** The spec requires the server to check that selections actually overlap, not merely that both fields are non-null.

## Client state machine (matches.tsx)

Four states + one new state:
1. `CALL_STAGE_UNLOCKED` — firstCallPromptSeen=false
2. `CHOOSING_AVAILABILITY` — user hasn't picked yet (or showAvailPicker=true)
3. `WAITING_FOR_OTHER_USER` — I've picked, they haven't
4. `INCOMPATIBLE_AVAILABILITY` — both picked, but windows don't overlap → amber warning card with "Change availability" button
5. `READY_TO_CALL` — both picked, windows compatible → green "Start First Call" card

## "Pick a specific time" (specific_time option)

Clicking this option opens an inline `datetime-local` input (state: `showSpecificTimePicker`). On confirm, the ISO timestamp (not the key "specific_time") is sent to the server via `setCallAvailMutation.mutate(isoTimestamp)`.

**Why:** The string "specific_time" must never be stored; the value stored must be the actual timestamp.

## Seed auto-availability removed

`server/routes.ts` set-availability handler previously ran a `setTimeout` to auto-set the partner's availability if they were a seed user. This block was removed entirely. Testing must use two real accounts.

## Migration

`supabase/migrations/add_call_avail_columns.sql` — uses `ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS call_avail_1 TEXT` (safe to run where columns already exist). Confirmed safe on Neon (both `NOTICE: already exists, skipping`).

## Gate 3b (server, call/start route)

Added compatibility gate: after the existing "both must be non-null" check, `areAvailabilitiesCompatible(avail1, avail2)` is also checked. Returns 403 `BLOCKED_AVAILABILITY_INCOMPATIBLE` if incompatible.
