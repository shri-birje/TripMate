-- ============================================================================
-- TripMate migration 20261123000000: approval-based joining (M3.5 revision, ADR-059)
--
-- WHAT CHANGES (migration 20261118400000 stays exactly as applied; this only moves forward)
--   1. Using an invitation link NO LONGER makes anyone a member. It creates a
--      PENDING JOIN REQUEST; only an active administrator's approval creates (or
--      restores) a membership. accept_invite() is removed.
--   2. One reusable GENERAL link per trip (no usage limit; 1 hour to 30 days, default
--      7 days). Creating a new one REPLACES the old one (the old one stops working).
--      Guest-claim links stay: one per guest, single use, and their use is also only
--      a request that an administrator must approve (decision A).
--   3. Every invitation made under the old rules is revoked (decision E). People who
--      already joined stay members; nothing about them changes.
--   4. trip_join_requests: who asked, when, for which guest (if a claim), and who
--      decided. Readable and writable ONLY through the functions below.
--   5. New functions: request_to_join(), list_join_requests(), decide_join_request().
--      create_invite() and list_trip_invites() lose their usage-limit parts;
--      preview_invite() keeps its exact shape.
--
-- RULES ENFORCED INSIDE THE DATABASE
--   * A pending person has NO membership row, so every existing security rule keeps
--     hiding the trip, its people and (later) its money from them.
--   * One pending request per account per trip; one pending claim per guest; at most
--     50 pending requests per trip.
--   * Decision B: an account gets ONE request per link. After a rejection (or after an
--     approval, if they later leave) they need the admin's replacement link.
--   * Decision C and the additional rule: expiry, revocation or replacement of a link
--     stops NEW requests only; requests already made stay for an administrator to decide.
--   * Deciding locks the trip (the member-change helper), then the request, and re-checks
--     everything: still pending (two admins at once: the second gets "already_decided"),
--     trip not archived, requester's profile still exists, 50-member cap, and for a claim
--     that the guest is still an unclaimed active guest and the requester has no other row.
--   * Approving a claim turns THAT guest row into the person (same id, name, join date,
--     role, history); approving a general request adds an ordinary member, or restores a
--     returning person's own old row with role reset to member.
--   * Audit: requests are recorded on their own row (created, decided, by whom); link
--     creation/revocation on the invitation row; the membership change in
--     trip_member_events with the APPROVING ADMINISTRATOR as the actor.
--
-- ADR-054 (mandatory before public deployment): edge rate limiting on preview_invite
-- and request_to_join. The database has none.
--
-- REQUIRES: all earlier migrations, including 20261118400000_invitations.sql.
-- Safe to run more than once.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. No more immediate joining.
-- ---------------------------------------------------------------------------
drop function if exists public.accept_invite(text);

-- ---------------------------------------------------------------------------
-- 2. Every invitation made under the old rules stops working (decision E).
--    Memberships and their history are untouched.
-- ---------------------------------------------------------------------------
-- Runs only the FIRST time (while the old usage-limit column still exists), so running this file again
-- never cancels links made under the new rules.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trip_invites' and column_name = 'max_uses') then
    update public.trip_invites set revoked_at = now() where revoked_at is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Usage limits go; one live general link per trip, one live claim link per guest.
-- ---------------------------------------------------------------------------
drop function if exists public.create_invite(uuid, uuid, int, int);
drop function if exists public.list_trip_invites(uuid);

alter table public.trip_invites drop constraint if exists trip_invites_use_count_range;
alter table public.trip_invites drop constraint if exists trip_invites_claim_single_use;
alter table public.trip_invites drop constraint if exists trip_invites_max_uses_range;
alter table public.trip_invites drop column if exists max_uses;
alter table public.trip_invites drop constraint if exists trip_invites_use_count_nonnegative;
alter table public.trip_invites add constraint trip_invites_use_count_nonnegative check (use_count >= 0);

comment on column public.trip_invites.use_count is 'How many join requests were made with this link. A claim link is single use: usable only while this is 0.';

create unique index if not exists trip_invites_one_live_general on public.trip_invites (trip_id)
  where claim_member_id is null and revoked_at is null;
create unique index if not exists trip_invites_one_live_claim on public.trip_invites (claim_member_id)
  where claim_member_id is not null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- 4. Join requests. Closed to everyone: only the functions below touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.trip_join_requests (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips (id) on delete cascade,
  invite_id       uuid not null references public.trip_invites (id) on delete cascade,
  user_id         uuid not null references public.profiles (id),
  requester_name  text not null
                    constraint trip_join_requests_name_length check (char_length(requester_name) between 1 and 60),
  claim_member_id uuid references public.trip_members (id),
  status          text not null default 'pending'
                    constraint trip_join_requests_status_values check (status in ('pending', 'approved', 'rejected')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references public.trip_members (id),
  member_id       uuid references public.trip_members (id),
  constraint trip_join_requests_decided_consistently check (
    (status = 'pending' and decided_at is null and decided_by is null and member_id is null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null and member_id is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null and member_id is not null)
  )
);

comment on table public.trip_join_requests is 'Requests to join a trip (or claim a guest place) made with an invitation link. A request is never a membership; only an administrator''s approval creates one. Never readable directly (functions only).';

create unique index if not exists trip_join_requests_one_pending_per_person on public.trip_join_requests (trip_id, user_id) where status = 'pending';
create unique index if not exists trip_join_requests_one_pending_claim on public.trip_join_requests (claim_member_id) where status = 'pending' and claim_member_id is not null;
create unique index if not exists trip_join_requests_one_per_link on public.trip_join_requests (invite_id, user_id);
create index if not exists trip_join_requests_trip_idx on public.trip_join_requests (trip_id, status, created_at);

alter table public.trip_join_requests enable row level security;
revoke all on public.trip_join_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5a. create_invite(): an administrator makes (or REPLACES) the trip's general link,
--     or a single-use claim link for one guest. Returns the raw token ONCE.
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(
  p_trip_id          uuid,
  p_claim_member_id  uuid default null,
  p_expires_in_hours int  default 168
)
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_target  public.trip_members;
  v_token   text;
  v_id      uuid;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  if p_expires_in_hours is null or p_expires_in_hours not between 1 and 720 then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  if p_claim_member_id is not null then
    select * into v_target from public.trip_members m
     where m.id = p_claim_member_id and m.trip_id = p_trip_id and m.status = 'active';
    if not found then
      raise exception 'member_not_found' using errcode = 'P0001';
    end if;
    if v_target.user_id is not null then
      raise exception 'not_a_guest' using errcode = 'P0001';
    end if;
    -- one live claim link per guest: the previous one stops working
    update public.trip_invites
       set revoked_at = now(), revoked_by = v_ctx.caller_member_id
     where claim_member_id = p_claim_member_id and revoked_at is null;
  else
    -- one live general link per trip: the previous one stops working (requests already made stay)
    update public.trip_invites
       set revoked_at = now(), revoked_by = v_ctx.caller_member_id
     where trip_id = p_trip_id and claim_member_id is null and revoked_at is null;
  end if;

  -- 256 bits: three random UUIDs (366 bits of strong randomness) reduced by SHA-256, as lower-case hex.
  v_token := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_expires := now() + make_interval(hours => p_expires_in_hours);

  insert into public.trip_invites (trip_id, token_hash, claim_member_id, created_by, expires_at)
  values (p_trip_id, public.invite_token_hash(v_token), p_claim_member_id, v_ctx.caller_member_id, v_expires)
  returning id into v_id;

  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_invite(uuid, uuid, int) from public, anon;
grant execute on function public.create_invite(uuid, uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. list_trip_invites(): an administrator sees the trip's links. Never tokens or hashes.
-- ---------------------------------------------------------------------------
create or replace function public.list_trip_invites(p_trip_id uuid)
returns table (
  invite_id       uuid,
  claim_member_id uuid,
  claim_name      text,
  created_by_name text,
  expires_at      timestamptz,
  use_count       int,
  revoked_at      timestamptz,
  created_at      timestamptz,
  status          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role text;
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

  return query
    select i.id,
           i.claim_member_id,
           cm.display_name,
           cb.display_name,
           i.expires_at,
           i.use_count,
           i.revoked_at,
           i.created_at,
           case when i.revoked_at is not null then 'revoked'
                when i.claim_member_id is not null and i.use_count > 0 then 'used'
                when i.expires_at <= now() then 'expired'
                else 'active' end
      from public.trip_invites i
      join public.trip_members cb on cb.id = i.created_by
      left join public.trip_members cm on cm.id = i.claim_member_id
     where i.trip_id = p_trip_id
     order by i.created_at desc, i.id
     limit 100;
end;
$$;

revoke all on function public.list_trip_invites(uuid) from public, anon;
grant execute on function public.list_trip_invites(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5c. preview_invite(): same shape and the same narrow facts as before; a claim link is
--     usable only until one request has been made with it. Still the ONLY function
--     signed-out visitors may run, and still one identical empty answer for any
--     unusable token.
-- ---------------------------------------------------------------------------
create or replace function public.preview_invite(p_token text)
returns table (
  trip_name    text,
  destination  text,
  start_date   date,
  end_date     date,
  inviter_name text,
  member_count int,
  is_claim     boolean,
  claim_name   text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.name,
         t.destination,
         t.start_date,
         t.end_date,
         cb.display_name,
         (select count(*)::int from public.trip_members m where m.trip_id = t.id and m.status = 'active'),
         i.claim_member_id is not null,
         cm.display_name
    from public.trip_invites i
    join public.trips t on t.id = i.trip_id
    join public.trip_members cb on cb.id = i.created_by
    left join public.trip_members cm on cm.id = i.claim_member_id
   where p_token ~ '^[0-9a-f]{64}$'
     and i.token_hash = public.invite_token_hash(p_token)
     and i.revoked_at is null
     and i.expires_at > now()
     and t.status = 'active'
     and (i.claim_member_id is null or (i.use_count = 0 and cm.status = 'active' and cm.user_id is null));
$$;

revoke all on function public.preview_invite(text) from public;
grant execute on function public.preview_invite(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5d. request_to_join(): a signed-in person asks to join (or to claim the guest the
--     link was made for). NEVER creates a membership.
--     outcome: 'requested' | 'already_requested' | 'already_member'
-- ---------------------------------------------------------------------------
create or replace function public.request_to_join(p_token text)
returns table (trip_id uuid, request_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_inv     public.trip_invites;
  v_trip    public.trips;
  v_name    text;
  v_own     public.trip_members;
  v_has_own boolean;
  v_prev    public.trip_join_requests;
  v_target  public.trip_members;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  select i.* into v_inv from public.trip_invites i where i.token_hash = public.invite_token_hash(p_token);
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  -- Same lock order as every administrator function: the trip first, then the invitation.
  select t.* into v_trip from public.trips t where t.id = v_inv.trip_id for update;
  select i.* into v_inv from public.trip_invites i where i.id = v_inv.id for update;
  if v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_trip.status <> 'active'
     or (v_inv.claim_member_id is not null and v_inv.use_count > 0) then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  select p.display_name into v_name from public.profiles p where p.id = v_uid and p.deleted_at is null;
  if v_name is null then
    raise exception 'profile_missing' using errcode = 'P0001';
  end if;

  select * into v_own from public.trip_members m where m.trip_id = v_trip.id and m.user_id = v_uid;
  v_has_own := found;
  if v_has_own and v_own.status = 'active' then
    return query select v_trip.id, null::uuid, 'already_member'::text;
    return;
  end if;

  -- One request per account per link (decision B).
  select r.* into v_prev from public.trip_join_requests r where r.invite_id = v_inv.id and r.user_id = v_uid;
  if found then
    if v_prev.status = 'pending' then
      return query select v_trip.id, v_prev.id, 'already_requested'::text;
      return;
    end if;
    raise exception 'request_used' using errcode = 'P0001'; -- rejected, or approved and left since: a replacement link is needed
  end if;

  -- Already waiting through an earlier link: the same request, not a second one.
  select r.* into v_prev from public.trip_join_requests r where r.trip_id = v_trip.id and r.user_id = v_uid and r.status = 'pending';
  if found then
    return query select v_trip.id, v_prev.id, 'already_requested'::text;
    return;
  end if;

  if v_inv.claim_member_id is not null then
    select * into v_target from public.trip_members m
     where m.id = v_inv.claim_member_id and m.trip_id = v_trip.id and m.status = 'active' and m.user_id is null;
    if not found then
      raise exception 'invite_invalid' using errcode = 'P0001';
    end if;
    if v_has_own then -- they were on this trip before: two rows cannot be merged
      raise exception 'claim_conflict' using errcode = 'P0001';
    end if;
  end if;

  if v_inv.claim_member_id is not null and exists (
    select 1 from public.trip_join_requests r where r.claim_member_id = v_inv.claim_member_id and r.status = 'pending'
  ) then -- somebody else is already waiting to take this place
    raise exception 'claim_pending' using errcode = 'P0001';
  end if;

  if (select count(*) from public.trip_join_requests r where r.trip_id = v_trip.id and r.status = 'pending') >= 50 then
    raise exception 'too_many_requests' using errcode = 'P0001';
  end if;

  insert into public.trip_join_requests (trip_id, invite_id, user_id, requester_name, claim_member_id)
  values (v_trip.id, v_inv.id, v_uid, v_name, v_inv.claim_member_id)
  returning id into v_id;

  update public.trip_invites set use_count = use_count + 1 where id = v_inv.id;
  return query select v_trip.id, v_id, 'requested'::text;
end;
$$;

revoke all on function public.request_to_join(text) from public, anon;
grant execute on function public.request_to_join(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5e. list_join_requests(): an administrator sees the PENDING requests, oldest first.
--     Name and time only (never a user id); for a claim, which guest it is for.
-- ---------------------------------------------------------------------------
create or replace function public.list_join_requests(p_trip_id uuid)
returns table (request_id uuid, requester_name text, claim_member_id uuid, claim_name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_role text;
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

  return query
    select r.id, r.requester_name, r.claim_member_id, cm.display_name, r.created_at
      from public.trip_join_requests r
      left join public.trip_members cm on cm.id = r.claim_member_id
     where r.trip_id = p_trip_id and r.status = 'pending'
     order by r.created_at, r.id
     limit 100;
end;
$$;

revoke all on function public.list_join_requests(uuid) from public, anon;
grant execute on function public.list_join_requests(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5f. decide_join_request(): an administrator approves or rejects a pending request.
--     outcome: 'approved' | 'rejected' | 'already_decided' | 'already_member'
-- ---------------------------------------------------------------------------
create or replace function public.decide_join_request(p_trip_id uuid, p_request_id uuid, p_approve boolean)
returns table (request_id uuid, outcome text, member_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_req     public.trip_join_requests;
  v_inv     public.trip_invites;
  v_name    text;
  v_own     public.trip_members;
  v_has_own boolean;
  v_target  public.trip_members;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- an active administrator of an active trip; the trip row is now locked
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  if p_approve is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;

  select r.* into v_req from public.trip_join_requests r where r.id = p_request_id and r.trip_id = p_trip_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;
  if v_req.status <> 'pending' then -- another administrator got there first
    return query select v_req.id, 'already_decided'::text, v_req.member_id;
    return;
  end if;

  if not p_approve then
    update public.trip_join_requests
       set status = 'rejected', decided_at = now(), decided_by = v_ctx.caller_member_id
     where id = v_req.id;
    return query select v_req.id, 'rejected'::text, null::uuid;
    return;
  end if;

  select p.display_name into v_name from public.profiles p where p.id = v_req.user_id and p.deleted_at is null;
  if v_name is null then
    raise exception 'requester_unavailable' using errcode = 'P0001';
  end if;

  select * into v_own from public.trip_members m where m.trip_id = p_trip_id and m.user_id = v_req.user_id;
  v_has_own := found;

  if v_has_own and v_own.status = 'active' then -- they are already on the trip: nothing to add
    update public.trip_join_requests
       set status = 'approved', decided_at = now(), decided_by = v_ctx.caller_member_id, member_id = v_own.id
     where id = v_req.id;
    return query select v_req.id, 'already_member'::text, v_own.id;
    return;
  end if;

  if v_req.claim_member_id is not null then
    select * into v_target from public.trip_members m
     where m.id = v_req.claim_member_id and m.trip_id = p_trip_id and m.status = 'active' and m.user_id is null;
    if not found then
      raise exception 'claim_unavailable' using errcode = 'P0001';
    end if;
    if v_has_own then
      raise exception 'claim_conflict' using errcode = 'P0001';
    end if;
    update public.trip_members set user_id = v_req.user_id where id = v_target.id;
    v_id := v_target.id;
    insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, new_value)
    values (p_trip_id, v_ctx.caller_member_id, v_id, 'guest_claimed', v_req.id::text);
  else
    if (select count(*) from public.trip_members m where m.trip_id = p_trip_id and m.status = 'active') >= 50 then
      raise exception 'trip_full' using errcode = 'P0001';
    end if;
    if v_has_own then -- a returning person gets their old row back, as an ordinary member
      update public.trip_members
         set status = 'active', role = 'member', left_at = null, display_name = v_name
       where id = v_own.id;
      v_id := v_own.id;
      insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, old_value, new_value)
      values (p_trip_id, v_ctx.caller_member_id, v_id, 'joined', v_own.status, v_req.id::text);
    else
      select i.* into v_inv from public.trip_invites i where i.id = v_req.invite_id;
      insert into public.trip_members (trip_id, user_id, display_name, role, status, invited_by)
      values (p_trip_id, v_req.user_id, v_name, 'member', 'active', v_inv.created_by)
      returning id into v_id;
      insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, new_value)
      values (p_trip_id, v_ctx.caller_member_id, v_id, 'joined', v_req.id::text);
    end if;
  end if;

  update public.trip_join_requests
     set status = 'approved', decided_at = now(), decided_by = v_ctx.caller_member_id, member_id = v_id
   where id = v_req.id;
  return query select v_req.id, 'approved'::text, v_id;
end;
$$;

revoke all on function public.decide_join_request(uuid, uuid, boolean) from public, anon;
grant execute on function public.decide_join_request(uuid, uuid, boolean) to authenticated;
