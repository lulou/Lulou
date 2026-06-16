-- ── Single-session enforcement ───────────────────────────────────────────────
-- Stores the canonical session ID for each user's currently-active device.
-- Written by POST /api/auth/init on every login.
-- Checked by GET /api/auth/user when the client sends X-Session-ID header.
-- A mismatch means another device has logged in → force-logout the stale device.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_session_id TEXT;

-- Index makes the per-user lookup in GET /api/auth/user fast.
CREATE INDEX IF NOT EXISTS idx_profiles_active_session
  ON public.profiles (user_id, active_session_id);
