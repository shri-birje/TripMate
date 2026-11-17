-- ============================================================================
-- TripMate migration 20261118100000: trips and trip members (Milestone M3.1)
--
-- WHAT THIS DOES
--   1. public.trips         one row per trip (name, destination, dates, budget...)
--   2. public.trip_members  who is on each trip, and as what (admin / member)
--   3. Row-Level Security   you can see a trip and its members ONLY if you are
--                           an active member of it
--   4. create_trip()        the ONLY way to create a trip. It creates the trip
--                           and makes the caller its administrator in a single
--                           step, so a trip can never exist without an admin.
--
-- REQUIRES: the profiles migration (20261118000000_profiles.sql) to be run first.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Trips
-- ---------------------------------------------------------------------------
create table if not exists public.trips (
  id               uuid primary key default gen_random_uuid(),
  name             text not null
                     constraint trips_name_length check (char_length(btrim(name)) between 1 and 100),
  destination      text not null
                     constraint trips_destination_length check (char_length(btrim(destination)) between 1 and 100),
  start_date       date not null,
  end_date         date not null,
  description      text
                     constraint trips_description_length check (description is null or char_length(description) <= 500),
  -- Amounts are whole paise (Rs 1 = 100). Optional overall budget.
  budget_minor     bigint
                     constraint trips_budget_nonnegative check (budget_minor is null or budget_minor >= 0),
  currency         char(3) not null default 'INR'
                     constraint trips_currency_format check (currency ~ '^[A-Z]{3}$'),
  cover_image_path text,
  status           text not null default 'active'
                     constraint trips_status_values check (status in ('active', 'archived')),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  constraint trips_dates_order check (end_date >= start_date)
);

comment on table public.trips is 'A group trip. Created only through create_trip().';
comment on column public.trips.budget_minor is 'Overall trip budget in paise (minor units). NULL = no budget set.';

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Trip members. Expenses and repayments will refer to a member row (not directly
-- to a user), so history survives people leaving. user_id is empty for "guest"
-- members (friends who have not signed up) - used by a later feature.
-- ---------------------------------------------------------------------------
create table if not exists public.trip_members (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  user_id      uuid references public.profiles (id),
  display_name text not null
                 constraint trip_members_display_name_length check (char_length(btrim(display_name)) between 1 and 60),
  role         text not null default 'member'
                 constraint trip_members_role_values check (role in ('admin', 'member')),
  status       text not null default 'active'
                 constraint trip_members_status_values check (status in ('active', 'removed', 'left')),
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  invited_by   uuid references public.trip_members (id)
);

comment on table public.trip_members is 'Membership and identity inside a trip. Rows are kept (status changes) when someone leaves.';

-- A person can be on a trip only once (rejoining re-activates the same row).
create unique index if not exists trip_members_trip_user_unique
  on public.trip_members (trip_id, user_id) where user_id is not null;
create index if not exists trip_members_trip_status_idx on public.trip_members (trip_id, status);
create index if not exists trip_members_user_active_idx on public.trip_members (user_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- "Is the signed-in person an active member of this trip?"
-- Used by the security rules below. SECURITY DEFINER lets it look at
-- trip_members without triggering those same rules again (which would loop).
-- ---------------------------------------------------------------------------
create or replace function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.trip_members m
     where m.trip_id = p_trip_id
       and m.user_id = (select auth.uid())
       and m.status = 'active'
  );
$$;

revoke all on function public.is_trip_member(uuid) from public, anon;
grant execute on function public.is_trip_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Security rules: members see their trips; nobody can write directly.
-- ---------------------------------------------------------------------------
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;

drop policy if exists trips_select_members on public.trips;
create policy trips_select_members on public.trips
  for select to authenticated
  using (public.is_trip_member(id));

drop policy if exists trip_members_select_members on public.trip_members;
create policy trip_members_select_members on public.trip_members
  for select to authenticated
  using (public.is_trip_member(trip_id));

-- Remove Supabase's broad default permissions; allow READING only.
-- All changes go through functions such as create_trip() below.
revoke all on public.trips, public.trip_members from public, anon, authenticated;
grant select on public.trips, public.trip_members to authenticated;

-- ---------------------------------------------------------------------------
-- create_trip(): the one way to start a trip.
--   * Needs a signed-in user (auth.uid()); signed-out callers cannot run it.
--   * The creator is taken from the login, never from a parameter, so nobody
--     can create a trip "as" someone else.
--   * Creates the trip AND the creator's admin membership together. If either
--     step fails, neither is saved.
--   * Data rules (lengths, dates, currency, budget) are enforced by the table
--     constraints above.
-- SECURITY DEFINER because callers have no direct permission to insert.
-- ---------------------------------------------------------------------------
create or replace function public.create_trip(
  p_name         text,
  p_destination  text,
  p_start_date   date,
  p_end_date     date,
  p_description  text   default null,
  p_budget_minor bigint default null,
  p_currency     text   default 'INR'
)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_name text;
  v_trip public.trips;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select p.display_name into v_name
    from public.profiles p
   where p.id = v_uid and p.deleted_at is null;
  if v_name is null then
    raise exception 'profile_missing' using errcode = 'P0001';
  end if;

  insert into public.trips (name, destination, start_date, end_date, description, budget_minor, currency, created_by)
  values (
    btrim(p_name),
    btrim(p_destination),
    p_start_date,
    p_end_date,
    nullif(btrim(p_description), ''),
    p_budget_minor,
    coalesce(p_currency, 'INR'),
    v_uid
  )
  returning * into v_trip;

  insert into public.trip_members (trip_id, user_id, display_name, role)
  values (v_trip.id, v_uid, v_name, 'admin');

  return v_trip;
end;
$$;

revoke all on function public.create_trip(text, text, date, date, text, bigint, text) from public, anon;
grant execute on function public.create_trip(text, text, date, date, text, bigint, text) to authenticated;
