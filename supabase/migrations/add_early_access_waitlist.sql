CREATE TABLE IF NOT EXISTS public.early_access_waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  first_name text NOT NULL,
  city text NOT NULL,
  country text NOT NULL DEFAULT 'AU',
  is_18_plus boolean NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','invited','joined','removed')),
  referral_code text NOT NULL UNIQUE,
  referred_by uuid REFERENCES public.early_access_waitlist(id) ON DELETE SET NULL,
  referral_count integer NOT NULL DEFAULT 0,
  email_verification_token_hash text,
  email_verification_expires_at timestamptz,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invited_at timestamptz,
  joined_app_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS early_access_waitlist_email_lower_uq
  ON public.early_access_waitlist (lower(email_normalized));
CREATE INDEX IF NOT EXISTS early_access_waitlist_city_status_idx
  ON public.early_access_waitlist (city, status, created_at);

CREATE TABLE IF NOT EXISTS public.early_access_waitlist_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  waitlist_id uuid REFERENCES public.early_access_waitlist(id) ON DELETE SET NULL,
  event text NOT NULL CHECK (event IN ('submitted','verified','referral_signup','invited','joined_app','view','form_started','referral_copied')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS early_access_waitlist_events_event_idx
  ON public.early_access_waitlist_events (event, created_at);
ALTER TABLE public.early_access_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.early_access_waitlist_events ENABLE ROW LEVEL SECURITY;

-- Verification and referral credit happen in one transaction. A verified
-- replay returns the member but cannot increment referral_count again.
CREATE OR REPLACE FUNCTION public.verify_early_access_waitlist(p_token_hash text)
RETURNS TABLE(ok boolean, referral_link_code text, city_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.early_access_waitlist%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.early_access_waitlist
   WHERE email_verification_token_hash = p_token_hash
     AND email_verification_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::text, NULL::text; RETURN; END IF;
  IF v.email_verified_at IS NULL THEN
    UPDATE public.early_access_waitlist SET email_verified_at=now(), email_verification_token_hash=NULL,
      email_verification_expires_at=NULL, updated_at=now() WHERE id=v.id;
    INSERT INTO public.early_access_waitlist_events(waitlist_id,event) VALUES(v.id,'verified');
    IF v.referred_by IS NOT NULL AND v.referred_by <> v.id THEN
      UPDATE public.early_access_waitlist SET referral_count=referral_count+1, updated_at=now()
       WHERE id=v.referred_by AND email_verified_at IS NOT NULL;
      INSERT INTO public.early_access_waitlist_events(waitlist_id,event)
       SELECT v.referred_by,'referral_signup' WHERE EXISTS
       (SELECT 1 FROM public.early_access_waitlist WHERE id=v.referred_by AND email_verified_at IS NOT NULL);
    END IF;
  END IF;
  RETURN QUERY SELECT true, v.referral_code, v.city;
END $$;
REVOKE ALL ON FUNCTION public.verify_early_access_waitlist(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_early_access_waitlist(text) TO service_role;

CREATE OR REPLACE FUNCTION public.early_access_waitlist_stats()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'totalSignups', count(*),
    'verifiedSignups', count(*) FILTER (WHERE email_verified_at IS NOT NULL),
    'sydneyVerifiedSignups', count(*) FILTER (WHERE email_verified_at IS NOT NULL AND lower(city)='sydney'),
    'signupsToday', count(*) FILTER (WHERE created_at >= ((now() AT TIME ZONE 'Australia/Sydney')::date AT TIME ZONE 'Australia/Sydney')),
    'signupsLast7Days', count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    'referralSignups', coalesce(sum(referral_count),0),
    'topReferralCounts', coalesce((SELECT jsonb_agg(jsonb_build_object('code', referral_code, 'count', referral_count) ORDER BY referral_count DESC)
      FROM (SELECT referral_code, referral_count FROM public.early_access_waitlist WHERE referral_count > 0 ORDER BY referral_count DESC LIMIT 10) t), '[]'::jsonb),
    'waiting', count(*) FILTER (WHERE status='waiting'),
    'invited', count(*) FILTER (WHERE status='invited'),
    'joined', count(*) FILTER (WHERE status='joined')
  ) FROM public.early_access_waitlist;
$$;
REVOKE ALL ON FUNCTION public.early_access_waitlist_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.early_access_waitlist_stats() TO service_role;

CREATE OR REPLACE FUNCTION public.waitlist_request_identity()
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER
SET search_path = pg_catalog, auth AS $$
  SELECT jsonb_build_object('id', auth.uid(), 'email', auth.jwt() ->> 'email');
$$;
REVOKE ALL ON FUNCTION public.waitlist_request_identity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.waitlist_request_identity() TO authenticated;