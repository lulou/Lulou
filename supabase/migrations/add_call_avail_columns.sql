-- ── Pre-first-call availability columns ─────────────────────────────────────
-- call_avail_1 / call_avail_2 store each user's self-reported availability for
-- the guided first call.  Accepted values are one of the normalised keys:
--   available_now | in_30_minutes | in_1_hour | in_2_hours
-- …or an ISO-8601 timestamp when the user picks a specific time.
--
-- Both columns must be non-null AND have overlapping time windows before the
-- POST /api/matches/:id/call/start endpoint will allow a call to be placed.
--
-- Safe to run where columns already exist: IF NOT EXISTS prevents duplicates.
-- Does not reset or truncate the matches table.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS call_avail_1 TEXT;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS call_avail_2 TEXT;
