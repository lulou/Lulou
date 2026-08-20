-- ── User account settings (persistent account-level preferences) ─────────────
-- One row per authenticated user. The server is always authoritative for these
-- values — the client must not use unscoped localStorage as the source of truth.
-- Primary key: user_id (UUID from Supabase auth).
--
-- Safe to run where the table already exists: IF NOT EXISTS prevents errors.
-- Does not drop or reset any existing rows.
-- Ensures every environment (development, Railway, future deployments) gets the
-- schema even if the startup auto-creation block ran first.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id              UUID         NOT NULL PRIMARY KEY,
  preferred_language   TEXT         NOT NULL DEFAULT 'English',
  preferred_units      TEXT         NOT NULL DEFAULT 'miles',
  audio_transcripts    BOOLEAN      NOT NULL DEFAULT TRUE,
  push_account_enabled BOOLEAN,
  onboarding_tutorial_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique constraint is already implied by PRIMARY KEY.
-- Comment makes the intent explicit for future maintainers.
COMMENT ON TABLE public.user_settings IS
  'Account-level preferences. One row per authenticated user. Server is authoritative.';

-- Existing accounts should not be prompted with the first-time tutorial.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS onboarding_tutorial_completed BOOLEAN;
UPDATE public.user_settings
  SET onboarding_tutorial_completed = TRUE
  WHERE onboarding_tutorial_completed IS NULL;
ALTER TABLE public.user_settings
  ALTER COLUMN onboarding_tutorial_completed SET DEFAULT FALSE;
ALTER TABLE public.user_settings
  ALTER COLUMN onboarding_tutorial_completed SET NOT NULL;

-- Result interactions are account-private and scoped to a particular profile
-- item. Keep them in the deployment migration path as well as local startup
-- guards so a fresh production database has the full feature schema.
CREATE TABLE IF NOT EXISTS public.profile_photo_reactions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  profile_user_id TEXT NOT NULL,
  photo_url       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, profile_user_id, photo_url)
);
CREATE INDEX IF NOT EXISTS idx_photo_reactions_user
  ON public.profile_photo_reactions(user_id);

CREATE TABLE IF NOT EXISTS public.profile_prompt_replies (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  profile_user_id TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  reply_text      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, profile_user_id, prompt_text)
);
CREATE INDEX IF NOT EXISTS idx_prompt_replies_user_profile
  ON public.profile_prompt_replies(user_id, profile_user_id);
