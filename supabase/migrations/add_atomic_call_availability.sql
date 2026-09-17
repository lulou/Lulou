ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS availability_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS call_connected_at TIMESTAMPTZ;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS call_is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS call_media_type TEXT NOT NULL DEFAULT 'phone',
  ADD COLUMN IF NOT EXISTS call_payer_id TEXT;

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS last_call_session_id TEXT,
  ADD COLUMN IF NOT EXISTS last_call_counted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_call_stage INTEGER,
  ADD COLUMN IF NOT EXISTS last_call_is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_call_media_type TEXT,
  ADD COLUMN IF NOT EXISTS last_call_payer_id TEXT;

CREATE OR REPLACE FUNCTION public.set_call_availability_atomic(
  p_match_id TEXT,
  p_user_id TEXT,
  p_available_at TIMESTAMPTZ
)
RETURNS SETOF public.matches
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_avail_1 TIMESTAMPTZ;
  v_avail_2 TIMESTAMPTZ;
  v_agreed TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()::TEXT THEN
    RETURN;
  END IF;

  SELECT *
    INTO v_match
    FROM public.matches
   WHERE id = p_match_id
     AND status = 'active'
   FOR UPDATE;

  IF NOT FOUND
     OR (v_match.user1_id::TEXT <> p_user_id AND v_match.user2_id::TEXT <> p_user_id)
     OR COALESCE(v_match.call_stage, 0) <> 0 THEN
    RETURN;
  END IF;

  v_avail_1 := v_match.call_avail_1_at;
  v_avail_2 := v_match.call_avail_2_at;
  IF v_match.user1_id::TEXT = p_user_id THEN
    v_avail_1 := p_available_at;
  ELSE
    v_avail_2 := p_available_at;
  END IF;

  v_agreed := NULL;
  IF v_avail_1 IS NOT NULL
     AND v_avail_2 IS NOT NULL
     AND ABS(EXTRACT(EPOCH FROM (v_avail_1 - v_avail_2))) <= 600 THEN
    v_agreed := GREATEST(v_avail_1, v_avail_2);
  END IF;

  UPDATE public.matches
     SET call_avail_1_at = v_avail_1,
         call_avail_2_at = v_avail_2,
         agreed_call_at = v_agreed,
         availability_revision = availability_revision + 1
   WHERE id = p_match_id
   RETURNING * INTO v_match;

  RETURN NEXT v_match;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_call_availability_atomic(
  p_match_id TEXT,
  p_user_id TEXT,
  p_expected_agreed_at TIMESTAMPTZ
)
RETURNS SETOF public.matches
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid()::TEXT THEN
    RETURN;
  END IF;

  UPDATE public.matches
     SET agreed_call_at = NULL,
         availability_revision = availability_revision + 1
   WHERE id = p_match_id
     AND status = 'active'
     AND agreed_call_at = p_expected_agreed_at
     AND (user1_id::TEXT = p_user_id OR user2_id::TEXT = p_user_id)
   RETURNING * INTO v_match;

  IF FOUND THEN
    RETURN NEXT v_match;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_call_availability_atomic(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_call_availability_atomic(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_call_availability_atomic(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_call_availability_atomic(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;