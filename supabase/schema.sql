-- ============================================================
-- Lulou Dating App — Supabase schema
-- ============================================================
-- Run this once in Supabase Dashboard → SQL Editor.
-- All tables live in the public schema and are accessed via
-- PostgREST using either the user-scoped JWT or the service
-- role key (which bypasses RLS automatically).
--
-- NOTE: user_elevates and user_benefits live in the separate
-- Replit PostgreSQL database (managed by Drizzle) and are NOT
-- included here.
-- ============================================================

-- ── 1. profiles ─────────────────────────────────────────────
create table if not exists public.profiles (
  id                    text        primary key default gen_random_uuid()::text,
  user_id               text        not null unique,
  first_name            text        not null,
  age                   integer     not null,
  gender                text        not null,
  dating_preference     text        not null,
  location              text        not null,
  height                text,
  photos                text[]      not null default '{}',
  signals               text[]      not null default '{}',
  dating_intent         text        not null,
  green_flags           text[]      not null default '{}',
  connection_style      text        not null,
  conversation_starters text[],
  questions             text[],
  location_radius       integer     default 25,
  preferred_age_min     integer     default 18,
  preferred_age_max     integer     default 45,
  email                 text,
  phone_number          text,
  photo_verified        boolean     default false,
  onboarding_complete   boolean     default false,
  elevate_type          text,
  elevate_expires_at    timestamptz,
  created_at            timestamptz default now()
);

alter table public.profiles enable row level security;

-- Users can always read and write their own profile row.
create policy "profiles: own row full access"
  on public.profiles
  for all
  using  (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- Any authenticated user can read completed profiles (needed for
-- Discover / Spin Wheel, which queries profiles belonging to others).
create policy "profiles: read completed profiles"
  on public.profiles
  for select
  using (onboarding_complete = true);


-- ── 2. interactions ─────────────────────────────────────────
create table if not exists public.interactions (
  id           text        primary key default gen_random_uuid()::text,
  from_user_id text        not null,
  to_user_id   text        not null,
  type         text        not null,
  created_at   timestamptz default now()
);

create index if not exists idx_interactions_from on public.interactions(from_user_id);
create index if not exists idx_interactions_to   on public.interactions(to_user_id);

alter table public.interactions enable row level security;

-- Users can manage interactions where they are the sender or recipient.
create policy "interactions: participants full access"
  on public.interactions
  for all
  using (
    auth.uid()::text = from_user_id
    or auth.uid()::text = to_user_id
  )
  with check (auth.uid()::text = from_user_id);


-- ── 3. matches ──────────────────────────────────────────────
create table if not exists public.matches (
  id                       text        primary key default gen_random_uuid()::text,
  user1_id                 text        not null,
  user2_id                 text        not null,
  message_count_1          integer     default 0,
  message_count_2          integer     default 0,
  call_completed           boolean     default false,
  call_started_at          timestamptz,
  call_answered            boolean     default false,
  call_initiator_id        text,
  call_stage               integer     default 0,
  call_session_id          text,
  face_call_user1_accepted boolean     default false,
  face_call_user2_accepted boolean     default false,
  meet_availability_1      text,
  meet_availability_2      text,
  number_exchanged_1       boolean     default false,
  number_exchanged_2       boolean     default false,
  status                   text        default 'active',
  created_at               timestamptz default now()
);

alter table public.matches enable row level security;

-- Users can access matches where they are user1 or user2.
create policy "matches: participants full access"
  on public.matches
  for all
  using (
    auth.uid()::text = user1_id
    or auth.uid()::text = user2_id
  )
  with check (
    auth.uid()::text = user1_id
    or auth.uid()::text = user2_id
  );


-- ── 4. messages ─────────────────────────────────────────────
create table if not exists public.messages (
  id         text        primary key default gen_random_uuid()::text,
  match_id   text        not null,
  sender_id  text        not null,
  content    text        not null,
  reaction   varchar,
  created_at timestamptz default now()
);

create index if not exists idx_messages_match on public.messages(match_id);

alter table public.messages enable row level security;

-- Users can access messages that belong to one of their matches.
create policy "messages: match participants full access"
  on public.messages
  for all
  using (
    exists (
      select 1 from public.matches m
      where m.id = match_id
        and (m.user1_id = auth.uid()::text or m.user2_id = auth.uid()::text)
    )
  )
  with check (auth.uid()::text = sender_id);


-- ── 5. spin_standouts ───────────────────────────────────────
create table if not exists public.spin_standouts (
  id               text        primary key default gen_random_uuid()::text,
  user_id          text        not null,
  standout_user_id text        not null,
  created_at       timestamptz default now()
);

create index if not exists idx_spin_standouts_user on public.spin_standouts(user_id);

alter table public.spin_standouts enable row level security;

create policy "spin_standouts: own rows full access"
  on public.spin_standouts
  for all
  using  (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);


-- ── 6. spin_usage ───────────────────────────────────────────
create table if not exists public.spin_usage (
  id         text        primary key default gen_random_uuid()::text,
  user_id    text        not null,
  spin_date  text        not null,
  created_at timestamptz default now()
);

create index if not exists idx_spin_usage_user on public.spin_usage(user_id);

alter table public.spin_usage enable row level security;

create policy "spin_usage: own rows full access"
  on public.spin_usage
  for all
  using  (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);


-- ── 7. spin_requests ────────────────────────────────────────
create table if not exists public.spin_requests (
  id           text        primary key default gen_random_uuid()::text,
  from_user_id text        not null,
  to_user_id   text        not null,
  message      text        not null,
  status       text        not null default 'pending',
  created_at   timestamptz default now()
);

create index if not exists idx_spin_requests_from on public.spin_requests(from_user_id);
create index if not exists idx_spin_requests_to   on public.spin_requests(to_user_id);

alter table public.spin_requests enable row level security;

create policy "spin_requests: participants full access"
  on public.spin_requests
  for all
  using (
    auth.uid()::text = from_user_id
    or auth.uid()::text = to_user_id
  )
  with check (auth.uid()::text = from_user_id);
