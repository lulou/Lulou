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
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique constraint is already implied by PRIMARY KEY.
-- Comment makes the intent explicit for future maintainers.
COMMENT ON TABLE public.user_settings IS
  'Account-level preferences. One row per authenticated user. Server is authoritative.';
