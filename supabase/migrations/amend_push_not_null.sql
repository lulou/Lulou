-- Make push_account_enabled NOT NULL with an explicit default of false.
--
-- Rationale: null is ambiguous — it blends "user hasn't decided" with
-- "server data hasn't loaded yet".  Loading state must be represented on the
-- client using the query's isPending flag, not a null database value.
--
-- Steps:
--   1. Back-fill any existing NULL rows to false (opt-out is the safe default).
--   2. Set the column DEFAULT so new rows start as false.
--   3. Add NOT NULL constraint (safe once all rows are non-null).
--
-- Backward-compatible: existing true and false values are preserved.

UPDATE public.user_settings
SET    push_account_enabled = false
WHERE  push_account_enabled IS NULL;

ALTER TABLE public.user_settings
  ALTER COLUMN push_account_enabled SET DEFAULT false;

ALTER TABLE public.user_settings
  ALTER COLUMN push_account_enabled SET NOT NULL;
