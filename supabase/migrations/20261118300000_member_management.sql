-- ============================================================================
-- TripMate migration 20261118300000: members and roles (M3.4 step b)
--
-- WHAT THIS DOES
--   1. A guest (no account) can never be an administrator (table rule).
--   2. trip_member_events: an APPEND-ONLY record of every change to who is on a
--      trip and in what role. Nobody can edit or delete it (not even by mistake).
--   3. A safety net: after any change to a trip's members, the trip must still
--      have at least one active, signed-up administrator.
--   4. member_change_context(): internal helper shared by the functions below
--      (identity, membership, role, row lock, archived check). NOT callable by the app.
--   5. Six functions the app can run:
--        list_trip_members()     who is on the trip (current and former), minimal data
--        add_guest_member()      admin adds a friend by name
--        rename_guest_member()   admin renames a guest
--        set_member_role()       admin makes someone an admin / ordinary member
--        remove_member()         admin removes someone
--        leave_trip()            a member leaves
--
-- RULES ENFORCED INSIDE THE DATABASE (not just in the screens)
--   * Names are trimmed of ALL surrounding whitespace; a blank name is refused.
--   * The caller is identified with auth.uid(); signed-out callers cannot run anything.
--   * Someone who is not an active member of the trip (or the trip does not exist)
--     always gets "trip_not_found": the same answer in every such case, so the
--     existence of a trip is never revealed. A member who is not an admin gets
--     "not_admin" for admin-only actions.
--   * The trip row is LOCKED while a membership change runs, so changes to one
--     trip happen one at a time. Two admins demoting or removing each other at the
--     same moment cannot both succeed and leave the trip with no admin.
--   * At least one active, signed-up administrator always remains ("last_admin"),
--     enforced twice: by the functions and by a deferred trigger.
--   * Archived trips are read-only, EXCEPT that a member may leave ("trip_archived").
--   * A member id from another trip is refused ("member_not_found").
--   * Guests are never admins; guest names are unique among active people
--     (ignoring case and surrounding spaces); at most 50 active people per trip.
--   * Nothing is ever deleted: removing or leaving only changes status and left_at,
--     so anything that refers to a person (expenses, shares, repayments later)
--     stays intact. Every change writes one row to trip_member_events.
--   * Repeating an action that is already true changes nothing and records nothing.
--   * The list function returns a former member's name and dates but NOT their
--     user id or role.
--
-- ADR-047 (mandatory for M5): when expenses exist, remove_member() and leave_trip()
-- MUST refuse while the person has a non-zero outstanding balance.
--
-- REQUIRES: the profiles, trips and trip-edit migrations. Safe to run more than once.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Guests are never administrators (a guest cannot sign in, so an admin who is
--    a guest could never act and the trip could end up unmanageable).
-- ---------------------------------------------------------------------------
alter table public.trip_members drop constraint if exists trip_members_guest_is_member;
alter table public.trip_members
  add constraint trip_members_guest_is_member check (user_id is not null or role = 'member');

-- ---------------------------------------------------------------------------
-- 2. The audit trail: append-only.
-- ---------------------------------------------------------------------------
create table if not exists public.trip_member_events (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity, -- strict order of events (timestamps can tie)
  trip_id          uuid not null references public.trips (id) on delete cascade,
  actor_member_id  uuid not null references public.trip_members (id),
  target_member_id uuid not null references public.trip_members (id),
  action           text not null
                     constraint trip_member_events_action_values
                     check (action in ('guest_added', 'guest_renamed', 'made_admin', 'removed_admin', 'removed', 'left')),
  old_value        text,
  new_value        text,
  created_at       timestamptz not null default now()
);

comment on table public.trip_member_events is 'Append-only record of changes to trip membership and roles. Written only by the member functions; never edited or deleted.';

create index if not exists trip_member_events_trip_idx on public.trip_member_events (trip_id, seq);

alter table public.trip_member_events enable row level security;

drop policy if exists trip_member_events_select_members on public.trip_member_events;
create policy trip_member_events_select_members on public.trip_member_events
  for select to authenticated
  using (public.is_trip_member(trip_id));

-- Read only, for members of the trip. No role can insert, update, delete or truncate directly.
revoke all on public.trip_member_events from public, anon, authenticated;
grant select on public.trip_member_events to authenticated;

-- Even a role that DOES have write rights (the database owner) cannot edit or remove a record:
-- the only exception is the automatic clean-up when a whole trip is removed (a cascade).
create or replace function public.trip_member_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old; -- the automatic cascade when a trip itself is removed
  end if;
  raise exception 'trip_member_events is append-only' using errcode = '42501';
end;
$$;

revoke all on function public.trip_member_events_append_only() from public, anon, authenticated;

drop trigger if exists trip_member_events_no_change on public.trip_member_events;
create trigger trip_member_events_no_change
  before update or delete on public.trip_member_events
  for each row execute function public.trip_member_events_append_only();

drop trigger if exists trip_member_events_no_truncate on public.trip_member_events;
create trigger trip_member_events_no_truncate
  before truncate on public.trip_member_events
  for each statement execute function public.trip_member_events_append_only();

-- ---------------------------------------------------------------------------
-- 3. Safety net: whatever changes the members of a trip, by the time the change is
--    saved the trip must still have an active, signed-up administrator.
--    (Checked when the change is committed, so creating a trip and its first
--    administrator together is fine. A trip that no longer exists is skipped.)
-- ---------------------------------------------------------------------------
create or replace function public.check_trip_has_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_trip uuid := case when tg_op = 'DELETE' then old.trip_id else new.trip_id end;
begin
  if exists (select 1 from public.trips t where t.id = v_trip)
     and not exists (
       select 1 from public.trip_members m
        where m.trip_id = v_trip and m.role = 'admin' and m.status = 'active' and m.user_id is not null
     ) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

revoke all on function public.check_trip_has_admin() from public, anon, authenticated;

drop trigger if exists trip_members_keep_admin on public.trip_members;
create constraint trigger trip_members_keep_admin
  after insert or update or delete on public.trip_members
  deferrable initially deferred
  for each row execute function public.check_trip_has_admin();

-- ---------------------------------------------------------------------------
-- Name trimming that removes ALL surrounding whitespace (tabs, new lines, non-breaking
-- spaces), not just spaces, so a name made only of invisible characters is refused.
-- Internal: not callable by the app.
-- ---------------------------------------------------------------------------
create or replace function public.name_trim(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_name, '^[[:space:]\u00a0]+|[[:space:]\u00a0]+$', '', 'g');
$$;

revoke all on function public.name_trim(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Internal helper shared by the member functions. Not callable by the app.
--    Order matters: strangers are refused BEFORE the lock is taken (so they cannot
--    hold it up), and the caller's membership is checked AGAIN under the lock (it
--    may have changed while waiting).
-- ---------------------------------------------------------------------------
create or replace function public.member_change_context(
  p_trip_id        uuid,
  p_uid            uuid,
  p_need_admin     boolean,
  p_allow_archived boolean
)
returns table (caller_member_id uuid, caller_role text, trip_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   text;
  v_status text;
  v_member uuid;
begin
  v_role := public.trip_role_of(p_trip_id, p_uid);
  if v_role is null then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;
  if p_need_admin and v_role <> 'admin' then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  select t.status into v_status from public.trips t where t.id = p_trip_id for update;
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;

  select m.id, m.role into v_member, v_role
    from public.trip_members m
   where m.trip_id = p_trip_id and m.user_id = p_uid and m.status = 'active';
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;
  if p_need_admin and v_role <> 'admin' then
    raise exception 'not_admin' using errcode = 'P0001';
  end if;

  if v_status = 'archived' and not p_allow_archived then
    raise exception 'trip_archived' using errcode = 'P0001';
  end if;

  return query select v_member, v_role, v_status;
end;
$$;

revoke all on function public.member_change_context(uuid, uuid, boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5a. list_trip_members(): everyone who is or was on the trip, with the least
--     data needed. Current members: id, user id, name, role, dates. Former members
--     (left/removed): id, name, status, dates and whether they were a guest, with
--     user id and role left EMPTY. Someone who is not an active member of the trip
--     gets no rows at all (the same as for a trip that does not exist).
-- ---------------------------------------------------------------------------
create or replace function public.list_trip_members(p_trip_id uuid)
returns table (
  member_id    uuid,
  user_id      uuid,
  display_name text,
  role         text,
  status       text,
  joined_at    timestamptz,
  left_at      timestamptz,
  is_guest     boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if public.trip_role_of(p_trip_id, v_uid) is null then
    return;
  end if;
  return query
    select m.id,
           case when m.status = 'active' then m.user_id end,
           m.display_name,
           case when m.status = 'active' then m.role end,
           m.status,
           m.joined_at,
           m.left_at,
           (m.user_id is null)
      from public.trip_members m
     where m.trip_id = p_trip_id
     order by m.joined_at, m.display_name, m.id;
end;
$$;

revoke all on function public.list_trip_members(uuid) from public, anon;
grant execute on function public.list_trip_members(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. add_guest_member(): an administrator adds a friend who has no account yet.
-- ---------------------------------------------------------------------------
create or replace function public.add_guest_member(p_trip_id uuid, p_display_name text)
returns table (member_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_ctx  record;
  v_name text := public.name_trim(p_display_name);
  v_new  uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  if coalesce(char_length(v_name), 0) not between 1 and 60 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if (select count(*) from public.trip_members m where m.trip_id = p_trip_id and m.status = 'active') >= 50 then
    raise exception 'trip_full' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.trip_members m
     where m.trip_id = p_trip_id and m.status = 'active' and lower(public.name_trim(m.display_name)) = lower(v_name)
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  insert into public.trip_members (trip_id, user_id, display_name, role, status, invited_by)
  values (p_trip_id, null, v_name, 'member', 'active', v_ctx.caller_member_id)
  returning id into v_new;

  insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, new_value)
  values (p_trip_id, v_ctx.caller_member_id, v_new, 'guest_added', v_name);

  return query select v_new, true;
end;
$$;

revoke all on function public.add_guest_member(uuid, text) from public, anon;
grant execute on function public.add_guest_member(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5c. rename_guest_member(): an administrator fixes a guest's name. People with an
--     account cannot be renamed by anyone (their name comes from their profile).
-- ---------------------------------------------------------------------------
create or replace function public.rename_guest_member(p_trip_id uuid, p_member_id uuid, p_display_name text)
returns table (member_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_ctx    record;
  v_name   text := public.name_trim(p_display_name);
  v_target public.trip_members;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  select * into v_target from public.trip_members m
   where m.id = p_member_id and m.trip_id = p_trip_id and m.status = 'active';
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;
  if v_target.user_id is not null then
    raise exception 'cannot_rename' using errcode = 'P0001';
  end if;
  if coalesce(char_length(v_name), 0) not between 1 and 60 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  if v_target.display_name = v_name then
    return query select v_target.id, false;
    return;
  end if;
  if exists (
    select 1 from public.trip_members m
     where m.trip_id = p_trip_id and m.status = 'active' and m.id <> v_target.id
       and lower(public.name_trim(m.display_name)) = lower(v_name)
  ) then
    raise exception 'name_taken' using errcode = 'P0001';
  end if;

  update public.trip_members set display_name = v_name where id = v_target.id;
  insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, old_value, new_value)
  values (p_trip_id, v_ctx.caller_member_id, v_target.id, 'guest_renamed', v_target.display_name, v_name);

  return query select v_target.id, true;
end;
$$;

revoke all on function public.rename_guest_member(uuid, uuid, text) from public, anon;
grant execute on function public.rename_guest_member(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5d. set_member_role(): an administrator makes someone an admin or an ordinary
--     member. The caller says which role they SAW the person in (p_expected_role),
--     so a stale screen cannot overwrite a newer change.
-- ---------------------------------------------------------------------------
create or replace function public.set_member_role(p_trip_id uuid, p_member_id uuid, p_role text, p_expected_role text)
returns table (member_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_ctx    record;
  v_target public.trip_members;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  if p_role is null or p_role not in ('admin', 'member') or p_expected_role is null or p_expected_role not in ('admin', 'member') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  select * into v_target from public.trip_members m
   where m.id = p_member_id and m.trip_id = p_trip_id and m.status = 'active';
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;

  if v_target.role = p_role then -- already as asked: nothing to do, nothing recorded
    return query select v_target.id, false;
    return;
  end if;
  if v_target.role <> p_expected_role then
    raise exception 'member_changed' using errcode = 'P0001';
  end if;

  if p_role = 'admin' then
    if v_target.user_id is null then
      raise exception 'guest_cannot_be_admin' using errcode = 'P0001';
    end if;
  else
    if not exists (
      select 1 from public.trip_members m
       where m.trip_id = p_trip_id and m.id <> v_target.id and m.role = 'admin' and m.status = 'active' and m.user_id is not null
    ) then
      raise exception 'last_admin' using errcode = 'P0001';
    end if;
  end if;

  update public.trip_members set role = p_role where id = v_target.id;
  insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, old_value, new_value)
  values (p_trip_id, v_ctx.caller_member_id, v_target.id,
          case when p_role = 'admin' then 'made_admin' else 'removed_admin' end,
          v_target.role, p_role);

  return query select v_target.id, true;
end;
$$;

revoke all on function public.set_member_role(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_member_role(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5e. remove_member(): an administrator removes someone else. The person's row is
--     KEPT (status "removed" and the date); everything that refers to them stays.
--     Removing yourself is not allowed here (use leave_trip()), so the caller is
--     always still an admin afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(p_trip_id uuid, p_member_id uuid)
returns table (member_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_ctx    record;
  v_target public.trip_members;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  select * into v_target from public.trip_members m
   where m.id = p_member_id and m.trip_id = p_trip_id;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0001';
  end if;
  if v_target.id = v_ctx.caller_member_id then
    raise exception 'use_leave_instead' using errcode = 'P0001';
  end if;

  if v_target.status <> 'active' then -- already gone: nothing to do, nothing recorded
    return query select v_target.id, false;
    return;
  end if;

  if v_target.role = 'admin' and not exists (
    select 1 from public.trip_members m
     where m.trip_id = p_trip_id and m.id <> v_target.id and m.role = 'admin' and m.status = 'active' and m.user_id is not null
  ) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;

  update public.trip_members set status = 'removed', left_at = now() where id = v_target.id;
  insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action)
  values (p_trip_id, v_ctx.caller_member_id, v_target.id, 'removed');

  return query select v_target.id, true;
end;
$$;

revoke all on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5f. leave_trip(): any active member leaves. The only administrator cannot leave
--     (they must make someone else an administrator first). Allowed on archived
--     trips. The row is KEPT (status "left" and the date). After leaving, the
--     person is no longer a member, so a second call answers "trip_not_found".
-- ---------------------------------------------------------------------------
create or replace function public.leave_trip(p_trip_id uuid)
returns table (member_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ctx record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true);

  if v_ctx.caller_role = 'admin' and not exists (
    select 1 from public.trip_members m
     where m.trip_id = p_trip_id and m.id <> v_ctx.caller_member_id and m.role = 'admin' and m.status = 'active' and m.user_id is not null
  ) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;

  update public.trip_members set status = 'left', left_at = now() where id = v_ctx.caller_member_id;
  insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action)
  values (p_trip_id, v_ctx.caller_member_id, v_ctx.caller_member_id, 'left');

  return query select v_ctx.caller_member_id, true;
end;
$$;

revoke all on function public.leave_trip(uuid) from public, anon;
grant execute on function public.leave_trip(uuid) to authenticated;
