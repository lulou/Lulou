-- increment_message_count: atomically increments message_count_1 or message_count_2
-- for a given match and returns the post-increment values for both columns.
--
-- p_match_id is TEXT (not UUID) because the matches.id column is of type TEXT.
-- Using UUID here would cause "operator does not exist: text = uuid" at runtime.
--
-- Apply this in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/bpphntgdpcsecbvoygzt/sql/new
-- Then reload the PostgREST schema cache so the new function is discoverable:
--   SELECT pg_notify('pgrst', 'reload schema');

DROP FUNCTION IF EXISTS public.increment_message_count(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.increment_message_count(
  p_match_id TEXT,
  p_is_user1 BOOLEAN
)
RETURNS TABLE(out_count1 INTEGER, out_count2 INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count1 INTEGER;
  v_count2 INTEGER;
BEGIN
  IF p_is_user1 THEN
    UPDATE public.matches
       SET message_count_1 = COALESCE(message_count_1, 0) + 1
     WHERE id = p_match_id
    RETURNING message_count_1, message_count_2
      INTO v_count1, v_count2;
  ELSE
    UPDATE public.matches
       SET message_count_2 = COALESCE(message_count_2, 0) + 1
     WHERE id = p_match_id
    RETURNING message_count_1, message_count_2
      INTO v_count1, v_count2;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Match not found: %', p_match_id;
  END IF;

  out_count1 := v_count1;
  out_count2 := v_count2;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_message_count(TEXT, BOOLEAN)
  TO service_role;
