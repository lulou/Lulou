-- Discover safety actions are stored in the existing interaction stream:
--   remove = one-way "do not show this profile again"
--   block  = reciprocal candidate-feed exclusion
--
-- Existing likes/passes intentionally remain unconstrained. This partial index
-- only makes safety actions idempotent and lets the API treat a duplicate
-- request (including a concurrent retry) as successful.
CREATE UNIQUE INDEX IF NOT EXISTS interactions_discover_safety_actions_unique
  ON public.interactions (from_user_id, to_user_id, type)
  WHERE type IN ('remove', 'block');