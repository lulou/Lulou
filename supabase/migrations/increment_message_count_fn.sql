-- increment_message_count_fn.sql
-- Atomic message counter increment for the message-send route.
--
-- WHY THIS EXISTS
-- The message-send route previously used a Drizzle ORM UPDATE against
-- DATABASE_URL (Railway PostgreSQL).  All reads (getMatchMeta, getMatch,
-- getMatchesForUser) use supabaseAdmin, which connects to Supabase's own
-- PostgreSQL via PostgREST.  These are two physically separate databases.
-- Every counter increment was written to the Railway DB and was therefore
-- invisible to every subsequent Supabase read — the match-detail refetch
-- always returned message_count_1/2 = 0, overwriting the client cache and
-- snapping the "messages left" badge back to 15 after each send.
--
-- This function runs entirely inside a single Postgres UPDATE statement on
-- the Supabase database, so the incremented value is immediately visible to
-- every subsequent PostgREST read.  The service-role key used by the backend
-- has EXECUTE permission granted below.
--
-- To apply: paste into the Supabase SQL editor (dashboard → SQL → New query)
-- and click Run.

CREATE OR REPLACE FUNCTION public.increment_message_count(
  p_match_id UUID,
  p_is_user1  BOOLEAN
)
RETURNS TABLE (out_count1 INTEGER, out_count2 INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count1 INTEGER;
  v_count2 INTEGER;
BEGIN
  IF p_is_user1 THEN
    UPDATE matches
       SET message_count_1 = COALESCE(message_count_1, 0) + 1
     WHERE id = p_match_id
    RETURNING message_count_1, message_count_2
      INTO v_count1, v_count2;
  ELSE
    UPDATE matches
       SET message_count_2 = COALESCE(message_count_2, 0) + 1
     WHERE id = p_match_id
    RETURNING message_count_1, message_count_2
      INTO v_count1, v_count2;
  END IF;

  out_count1 := v_count1;
  out_count2 := v_count2;
  RETURN NEXT;
END;
$$;

-- Allow the service-role key (used by the Railway backend) to call this function.
GRANT EXECUTE ON FUNCTION public.increment_message_count(UUID, BOOLEAN)
  TO service_role;
