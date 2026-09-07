-- One authoritative production-feed flag for real, test, demo, QA, deactivated,
-- and otherwise non-discoverable profiles.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_discoverable boolean NOT NULL DEFAULT true;

-- Legacy seed accounts use this reserved UUID namespace.
UPDATE public.profiles
SET is_discoverable = false
WHERE user_id LIKE '10000000-0000-4000-a000-0000000000%';

CREATE INDEX IF NOT EXISTS idx_profiles_discoverable
  ON public.profiles (is_discoverable)
  WHERE is_discoverable = true;