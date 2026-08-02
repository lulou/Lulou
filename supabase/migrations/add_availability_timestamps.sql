-- Availability-timestamp migration
--
-- Purpose: Replace moving-offset text keys ("available_now", "in_30_minutes" …)
-- with absolute UTC timestamps stored at the moment the user makes their selection.
-- An agreed_call_at is computed server-side when both users' timestamps are compatible.
--
-- Old text columns (call_avail_1, call_avail_2) are KEPT for backward compatibility.
-- They continue to receive writes in this release.
-- A follow-up migration will drop them after production is verified.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS call_avail_1_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS call_avail_2_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agreed_call_at  TIMESTAMPTZ;

-- Migrate any rows that already stored a valid ISO timestamp in the old text columns
-- (rows that stored preset keys like "available_now" are left NULL and will be
--  re-selected by the user under the new flow).

UPDATE public.matches
SET call_avail_1_at = call_avail_1::TIMESTAMPTZ
WHERE call_avail_1 IS NOT NULL
  AND call_avail_1 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  AND call_avail_1_at IS NULL;

UPDATE public.matches
SET call_avail_2_at = call_avail_2::TIMESTAMPTZ
WHERE call_avail_2 IS NOT NULL
  AND call_avail_2 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
  AND call_avail_2_at IS NULL;
