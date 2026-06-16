-- ============================================================
-- Lulou Dating — Additional RLS policies & security hardening
-- ============================================================
-- Run in Supabase Dashboard → SQL Editor.
-- These complement supabase/schema.sql with additional policies
-- and security best-practices for all tables.
-- ============================================================

-- ── profiles: extra protections ─────────────────────────────
-- Prevent users from reading each other's raw coordinates.
-- (coordinates are used server-side only for distance filtering)
-- The app server returns sanitized profiles without lat/lng.
-- If you ever query profiles directly from the client, ensure
-- latitude/longitude are excluded from the SELECT columns.

-- Prevent users from marking their own profile as photo_verified.
-- Photo verification should only be done by admins via service role.
-- CREATE POLICY "profiles: no self-verification"
--   ON public.profiles
--   FOR UPDATE
--   USING (auth.uid()::text = user_id)
--   WITH CHECK (
--     auth.uid()::text = user_id
--     AND (photo_verified IS NULL OR photo_verified = (SELECT photo_verified FROM public.profiles WHERE user_id = auth.uid()::text))
--   );

-- ── messages: enforce sender_id integrity ───────────────────
-- Already enforced: INSERT with check (auth.uid()::text = sender_id)
-- The existing policy covers this correctly.

-- ── Ensure RLS is enabled on all tables ─────────────────────
-- These are idempotent and safe to run even if already enabled.
ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spin_standouts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spin_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spin_requests     ENABLE ROW LEVEL SECURITY;

-- ── Force RLS even for table owners ─────────────────────────
-- Prevents accidental admin bypass if the postgres role is used.
ALTER TABLE public.profiles          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.interactions      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.matches           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.messages          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.spin_standouts    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.spin_usage        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.spin_requests     FORCE ROW LEVEL SECURITY;

-- ── Storage bucket security ──────────────────────────────────
-- Ensure the profile-photos bucket is NOT public at the bucket level.
-- Individual objects should use signed URLs or be accessible only
-- via the public URL (which requires the bucket to be public for photos).
-- RLS policies already restrict writes to userId/ prefix — see schema.sql.

-- ── Confirm anon role has no direct table access ────────────
-- PostgREST uses either the anon key (unauthenticated) or the user's JWT.
-- With RLS enabled, anon users cannot read any rows (no policy permits it).
-- Verify by running: SELECT * FROM public.profiles LIMIT 1;
-- as the anon role — it should return 0 rows.

-- ── Index for performance with RLS ──────────────────────────
-- RLS policies do sub-selects on matches for messages.
-- These indexes ensure those sub-selects are fast.
CREATE INDEX IF NOT EXISTS idx_matches_user1 ON public.matches(user1_id);
CREATE INDEX IF NOT EXISTS idx_matches_user2 ON public.matches(user2_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON public.messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON public.interactions(type);
