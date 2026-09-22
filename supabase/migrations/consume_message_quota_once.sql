CREATE TABLE IF NOT EXISTS public.message_quota_consumptions (
  message_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_quota_consumptions_match
  ON public.message_quota_consumptions(match_id);

ALTER TABLE public.message_quota_consumptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_quota_consumptions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_message_quota_once(
  p_match_id TEXT,
  p_sender_id TEXT,
  p_message_id TEXT
)
RETURNS TABLE (
  out_applied BOOLEAN,
  out_count1 INTEGER,
  out_count2 INTEGER,
  out_call_stage INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_applied BOOLEAN := FALSE;
  v_inserted_rows INTEGER := 0;
BEGIN
  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF NOT FOUND OR p_sender_id NOT IN (v_match.user1_id, v_match.user2_id) THEN
    RAISE EXCEPTION 'match or sender not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.messages
    WHERE id = p_message_id
      AND match_id = p_match_id
      AND sender_id = p_sender_id
  ) THEN
    RAISE EXCEPTION 'authoritative message not found';
  END IF;

  IF COALESCE(v_match.call_stage, 0) IN (0, 1) THEN
    INSERT INTO public.message_quota_consumptions(message_id, match_id, sender_id)
    VALUES (p_message_id, p_match_id, p_sender_id)
    ON CONFLICT (message_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted_rows = ROW_COUNT;
    v_applied := v_inserted_rows = 1;

    IF v_applied THEN
      UPDATE public.matches
      SET message_count_1 = COALESCE(message_count_1, 0)
          + CASE WHEN user1_id = p_sender_id THEN 1 ELSE 0 END,
          message_count_2 = COALESCE(message_count_2, 0)
          + CASE WHEN user2_id = p_sender_id THEN 1 ELSE 0 END
      WHERE id = p_match_id
      RETURNING * INTO v_match;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_applied,
    COALESCE(v_match.message_count_1, 0),
    COALESCE(v_match.message_count_2, 0),
    COALESCE(v_match.call_stage, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_message_quota_once(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_message_quota_once(TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.create_user_message_with_quota(
  p_match_id TEXT,
  p_sender_id TEXT,
  p_message_id TEXT,
  p_content TEXT,
  p_consumes_quota BOOLEAN,
  p_stage0_limit INTEGER
)
RETURNS TABLE (
  out_inserted BOOLEAN,
  out_quota_applied BOOLEAN,
  out_id TEXT,
  out_match_id TEXT,
  out_sender_id TEXT,
  out_content TEXT,
  out_reaction TEXT,
  out_created_at TIMESTAMPTZ,
  out_count1 INTEGER,
  out_count2 INTEGER,
  out_call_stage INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match public.matches%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_message_id TEXT := COALESCE(NULLIF(p_message_id, ''), gen_random_uuid()::TEXT);
  v_inserted BOOLEAN := FALSE;
  v_quota_applied BOOLEAN := FALSE;
  v_should_count BOOLEAN := FALSE;
  v_my_count INTEGER;
  v_their_count INTEGER;
BEGIN
  SELECT * INTO v_match
  FROM public.matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF NOT FOUND OR p_sender_id NOT IN (v_match.user1_id, v_match.user2_id) THEN
    RAISE EXCEPTION 'MATCH_OR_SENDER_NOT_FOUND';
  END IF;

  SELECT * INTO v_message
  FROM public.messages
  WHERE id = v_message_id;

  IF FOUND THEN
    IF v_message.match_id <> p_match_id
       OR v_message.sender_id <> p_sender_id
       OR v_message.content <> p_content THEN
      RAISE EXCEPTION 'MESSAGE_ID_CONFLICT';
    END IF;
  ELSE
    v_my_count := CASE
      WHEN v_match.user1_id = p_sender_id THEN COALESCE(v_match.message_count_1, 0)
      ELSE COALESCE(v_match.message_count_2, 0)
    END;
    v_their_count := CASE
      WHEN v_match.user1_id = p_sender_id THEN COALESCE(v_match.message_count_2, 0)
      ELSE COALESCE(v_match.message_count_1, 0)
    END;

    IF p_consumes_quota AND COALESCE(v_match.call_stage, 0) = 0 THEN
      IF v_my_count >= p_stage0_limit THEN
        RAISE EXCEPTION 'MESSAGE_QUOTA_REACHED_CALL';
      END IF;
      v_should_count := TRUE;
    ELSIF p_consumes_quota AND COALESCE(v_match.call_stage, 0) = 1 THEN
      IF v_my_count >= 12 AND v_their_count < 12 THEN
        RAISE EXCEPTION 'MESSAGE_QUOTA_REACHED_DATE';
      END IF;
      -- Once both participants have reached 12, this stage is in its existing
      -- free-messaging state and counters remain at the completed threshold.
      v_should_count := v_my_count < 12;
    END IF;

    INSERT INTO public.messages(id, match_id, sender_id, content)
    VALUES (v_message_id, p_match_id, p_sender_id, p_content)
    RETURNING * INTO v_message;
    v_inserted := TRUE;

    IF v_should_count THEN
      INSERT INTO public.message_quota_consumptions(message_id, match_id, sender_id)
      VALUES (v_message.id, p_match_id, p_sender_id);

      UPDATE public.matches
      SET message_count_1 = COALESCE(message_count_1, 0)
          + CASE WHEN user1_id = p_sender_id THEN 1 ELSE 0 END,
          message_count_2 = COALESCE(message_count_2, 0)
          + CASE WHEN user2_id = p_sender_id THEN 1 ELSE 0 END
      WHERE id = p_match_id
      RETURNING * INTO v_match;
      v_quota_applied := TRUE;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_inserted,
    v_quota_applied,
    v_message.id::TEXT,
    v_message.match_id::TEXT,
    v_message.sender_id::TEXT,
    v_message.content,
    v_message.reaction::TEXT,
    v_message.created_at::TIMESTAMPTZ,
    COALESCE(v_match.message_count_1, 0),
    COALESCE(v_match.message_count_2, 0),
    COALESCE(v_match.call_stage, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.create_user_message_with_quota(TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_user_message_with_quota(TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER)
  TO service_role;

-- Voice notes unlock only after stage 0 completes. Therefore, voice notes on
-- currently active stage-1 matches all belong to that current quota window.
WITH current_stage_voice AS (
  SELECT
    m.id AS message_id,
    m.match_id,
    m.sender_id
  FROM public.messages m
  JOIN public.matches mt ON mt.id = m.match_id
  WHERE COALESCE(mt.call_stage, 0) = 1
    AND m.content LIKE '__VOICE__:%'
),
new_consumptions AS (
  INSERT INTO public.message_quota_consumptions(message_id, match_id, sender_id)
  SELECT message_id, match_id, sender_id
  FROM current_stage_voice
  ON CONFLICT (message_id) DO NOTHING
  RETURNING match_id, sender_id
),
voice_counts AS (
  SELECT match_id, sender_id, COUNT(*)::INTEGER AS count
  FROM new_consumptions
  GROUP BY match_id, sender_id
)
UPDATE public.matches mt
SET message_count_1 = LEAST(
      12,
      COALESCE(mt.message_count_1, 0)
      + COALESCE((SELECT count FROM voice_counts WHERE match_id = mt.id AND sender_id = mt.user1_id), 0)
    ),
    message_count_2 = LEAST(
      12,
      COALESCE(mt.message_count_2, 0)
      + COALESCE((SELECT count FROM voice_counts WHERE match_id = mt.id AND sender_id = mt.user2_id), 0)
    )
WHERE COALESCE(mt.call_stage, 0) = 1
  AND EXISTS (SELECT 1 FROM voice_counts WHERE match_id = mt.id);
