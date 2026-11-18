-- ============================================================================
-- TripMate migration 20261118200000: edit, archive and restore a trip (M3.3)
--
-- WHAT THIS DOES
--   1. A version counter: every REAL change to a trip adds 1 to trips.version.
--      A change that alters nothing does not.
--   2. update_trip():       an administrator edits a trip's details.
--   3. set_trip_archived(): an administrator archives or restores a trip.
--   4. trip_role_of():      internal helper used by the functions above. It is
--                           NOT callable by the app.
--
-- RULES ENFORCED INSIDE THE DATABASE (not just in the screens)
--   * The caller is identified with auth.uid(); signed-out callers cannot run
--     either function.
--   * Only an ACTIVE ADMINISTRATOR of the trip may edit, archive or restore.
--     Everyone else is refused. Someone who is not on the trip (or the trip does
--     not exist) gets "trip_not_found" - the same answer in every such case, so
--     the existence of a trip is never revealed. A member who is not an admin
--     gets "not_admin".
--   * An ARCHIVED trip is read-only: edits are refused until it is restored.
--   * Concurrency: the trip row is LOCKED, the version is compared with the one
--     the caller started from, and the change is made, all in one transaction.
--     A stale version changes nothing ("version_conflict"), so a newer edit can
--     never be overwritten.
--   * Currency, status (except via set_trip_archived), creator and id cannot be
--     changed by update_trip: it has no input for them.
--
-- REQUIRES: the profiles and trips migrations. Safe to run more than once.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Version counter. Runs on every UPDATE of a trip, whoever makes it.
--   * If the row really changed (ignoring version and updated_at themselves),
--     version becomes old version + 1.
--   * If nothing changed, version stays the same.
--   * Whatever value a writer tries to set for version is overridden here.
-- ---------------------------------------------------------------------------
create or replace function public.bump_trip_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'version' - 'updated_at') is distinct from (to_jsonb(old) - 'version' - 'updated_at') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

drop trigger if exists trips_bump_version on public.trips;
create trigger trips_bump_version
  before update on public.trips
  for each row execute function public.bump_trip_version();

revoke all on function public.bump_trip_version() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helper: the role of a person on a trip, but ONLY if they are an
-- active member; otherwise nothing. Not callable by the app: only the functions
-- below (which run with the owner's rights) can use it.
-- ---------------------------------------------------------------------------
create or replace function public.trip_role_of(p_trip_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
    from public.trip_members m
   where m.trip_id = p_trip_id
     and m.user_id = p_user_id
     and m.status = 'active'
   limit 1;
$$;

revoke all on function public.trip_role_of(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- update_trip(): edit a trip's details.
-- ---------------------------------------------------------------------------
create or replace function public.update_trip(
  p_trip_id          uuid,
  p_expected_version int,
  p_name             text,
  p_destination      text,
  p_start_date       date,
  p_end_date         date,
  p_description      text   default null,
  p_budget_minor     bigint default null
)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_role        text;
  v_trip        public.trips;
  v_name        text := btrim(p_name);
  v_destination text := btrim(p_destination);
  v_description text := nullif(btrim(p_description), '');
begin
  -- 1. Who is calling?
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- 2. Are they an active member? (Not a member / no such trip: one identical answer.)
  v_role := public.trip_role_of(p_trip_id, v_uid);
  if v_role is null then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;

  -- 3. Are they an administrator?
  if v_role <> 'admin' then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  -- 4. Lock the row: nobody else can change it until this transaction ends, so
  --    the checks below and the update cannot be interleaved with another writer.
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;

  -- 5. Archived trips are read-only.
  if v_trip.status = 'archived' then
    raise exception 'trip_archived' using errcode = 'P0001';
  end if;

  -- 6. Is the caller working from the latest version?
  if v_trip.version is distinct from p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001', detail = v_trip.version::text;
  end if;

  -- 7. Nothing to change? Return the trip as it is (no new version).
  if v_trip.name = v_name
     and v_trip.destination = v_destination
     and v_trip.start_date = p_start_date
     and v_trip.end_date = p_end_date
     and v_trip.description is not distinct from v_description
     and v_trip.budget_minor is not distinct from p_budget_minor then
    return v_trip;
  end if;

  -- 8. Make the change. The version test is repeated in the UPDATE itself as a
  --    second guard. The table's own rules (lengths, dates, budget) validate the
  --    new values; if they fail, nothing is saved.
  update public.trips
     set name = v_name,
         destination = v_destination,
         start_date = p_start_date,
         end_date = p_end_date,
         description = v_description,
         budget_minor = p_budget_minor
   where id = p_trip_id
     and version = p_expected_version
  returning * into v_trip;
  if not found then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  return v_trip;
end;
$$;

revoke all on function public.update_trip(uuid, int, text, text, date, date, text, bigint) from public, anon;
grant execute on function public.update_trip(uuid, int, text, text, date, date, text, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- set_trip_archived(): archive (p_archived = true) or restore (false) a trip.
--   * Same identity, membership and administrator checks as update_trip().
--   * Changes ONLY the status; nothing else about the trip is touched.
--   * Repeating it is safe: asking for the state the trip is already in changes
--     nothing and does not add a version.
--   * Uses the same lock and version protection as update_trip().
-- ---------------------------------------------------------------------------
create or replace function public.set_trip_archived(
  p_trip_id          uuid,
  p_archived         boolean,
  p_expected_version int
)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_role   text;
  v_trip   public.trips;
  v_target text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_role := public.trip_role_of(p_trip_id, v_uid);
  if v_role is null then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;
  if v_role <> 'admin' then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  if p_archived is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  v_target := case when p_archived then 'archived' else 'active' end;

  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;

  -- Already in the requested state: nothing to do (safe to repeat, no new version).
  if v_trip.status = v_target then
    return v_trip;
  end if;

  if v_trip.version is distinct from p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001', detail = v_trip.version::text;
  end if;

  update public.trips
     set status = v_target
   where id = p_trip_id
     and version = p_expected_version
  returning * into v_trip;
  if not found then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  return v_trip;
end;
$$;

revoke all on function public.set_trip_archived(uuid, boolean, int) from public, anon;
grant execute on function public.set_trip_archived(uuid, boolean, int) to authenticated;
