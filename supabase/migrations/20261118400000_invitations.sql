-- ============================================================================
-- TripMate migration 20261118400000: invitations and guest claiming (M3.5)
--
-- WHAT THIS DOES
--   1. trip_invites: one row per invitation link. Only a SHA-256 HASH of the
--      random token is stored; the token itself is shown to the admin once and
--      never kept. Nobody (not even the admin who made an invite) can read this
--      table directly: it is reached only through the functions below.
--   2. Two more words for the membership audit trail: "joined", "guest_claimed".
--   3. Five functions:
--        create_invite()      an admin makes a link (general, or for one named guest)
--        list_trip_invites()  an admin sees the invitations of the trip (never tokens or hashes)
--        revoke_invite()      an admin cancels an invitation
--        preview_invite()     ANYONE, even signed out, sees the trip's name, place, dates,
--                             who invited them and how many people are on it. THE ONLY
--                             function in the project that signed-out visitors may run.
--        accept_invite()      a signed-in person joins (or claims the guest the link was made for)
--
-- RULES ENFORCED INSIDE THE DATABASE (not just in the screens)
--   * Tokens are 256 bits of cryptographic randomness (three random UUIDs hashed
--     with SHA-256), in lower-case hex. Only the SHA-256 of the token is stored.
--   * An unknown, malformed, expired, revoked, used-up or archived-trip token all
--     give the SAME answer ("invite_invalid" / no preview rows), so nobody can tell
--     them apart or probe which tokens ever existed. No error text contains the token.
--   * Default life 7 days (admin may choose 1 hour to 30 days); single use by
--     default (admin may allow up to 50). A claim invite is always single use.
--   * Only an active ADMINISTRATOR of an ACTIVE trip creates or revokes invites.
--     Anyone else gets the usual existence-hiding answers (trip_not_found / not_admin).
--   * At most 50 invitations may be outstanding per trip.
--   * Accepting takes the trip's row lock (like every membership change), so two
--     people racing for the last use of an invitation cannot both succeed.
--   * Claiming a guest turns THAT row into a signed-up member: same member id, same join
--     date, same name, role stays "member"; nothing is copied or deleted, so any history
--     that points at the member stays intact. The 50-person limit does not apply to a
--     claim (nobody is added).
--   * A returning person (they left or were removed) gets their OLD row back (same id,
--     history kept), with role reset to "member".
--   * Registered accounts are identified by user id, never by display name: a name
--     that matches another member does NOT stop someone joining (ADR-054). Guest-name
--     uniqueness is unchanged.
--   * Being on the trip already is a safe no-op that does not use up the invitation.
--
-- ADR-054 (mandatory before public deployment): rate limiting on preview_invite and
-- accept_invite at the edge. The database itself has none.
--
-- REQUIRES: the profiles, trips, trip-edit and member-management migrations.
-- Safe to run more than once.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The invitations table. Closed to everyone: only the functions below touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.trip_invites (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips (id) on delete cascade,
  token_hash      text not null unique
                    constraint trip_invites_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  claim_member_id uuid references public.trip_members (id),
  created_by      uuid not null references public.trip_members (id),
  expires_at      timestamptz not null,
  max_uses        int not null default 1
                    constraint trip_invites_max_uses_range check (max_uses between 1 and 50),
  use_count       int not null default 0
                    constraint trip_invites_use_count_range check (use_count >= 0 and use_count <= max_uses),
  revoked_at      timestamptz,
  revoked_by      uuid references public.trip_members (id),
  created_at      timestamptz not null default now(),
  constraint trip_invites_claim_single_use check (claim_member_id is null or max_uses = 1),
  constraint trip_invites_expiry_after_creation check (expires_at > created_at)
);

comment on table public.trip_invites is 'Invitation links. Stores only a SHA-256 hash of each random token; never readable directly (functions only).';

create index if not exists trip_invites_trip_idx on public.trip_invites (trip_id, created_at);

alter table public.trip_invites enable row level security;
-- No policy and no grant at all: not even SELECT. (RLS with no policy would already hide every row.)
revoke all on public.trip_invites from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The audit trail learns two more words (every earlier row stays valid).
-- ---------------------------------------------------------------------------
alter table public.trip_member_events drop constraint if exists trip_member_events_action_values;
alter table public.trip_member_events
  add constraint trip_member_events_action_values
  check (action in ('guest_added', 'guest_renamed', 'made_admin', 'removed_admin', 'removed', 'left', 'joined', 'guest_claimed'));

-- ---------------------------------------------------------------------------
-- Internal: the hash that is stored and looked up. Not callable by the app.
-- ---------------------------------------------------------------------------
create or replace function public.invite_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

revoke all on function public.invite_token_hash(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3a. create_invite(): an administrator makes an invitation. Returns the raw token
--     ONCE; only its hash is stored.
-- ---------------------------------------------------------------------------
create or replace function public.create_invite(
  p_trip_id          uuid,
  p_claim_member_id  uuid default null,
  p_expires_in_hours int  default 168,
  p_max_uses         int  default 1
)
returns table (invite_id uuid, token text, expires_at timestamptz, max_uses int)
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

  if p_expires_in_hours is null or p_expires_in_hours not between 1 and 720
     or p_max_uses is null or p_max_uses not between 1 and 50 then
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
    if p_max_uses <> 1 then
      raise exception 'invalid_request' using errcode = 'P0001';
    end if;
  end if;

  if (select count(*) from public.trip_invites i
       where i.trip_id = p_trip_id and i.revoked_at is null and i.expires_at > now() and i.use_count < i.max_uses) >= 50 then
    raise exception 'invite_limit' using errcode = 'P0001';
  end if;

  -- 256 bits: three random UUIDs (366 bits of strong randomness) reduced by SHA-256, as lower-case hex.
  v_token := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_expires := now() + make_interval(hours => p_expires_in_hours);

  insert into public.trip_invites (trip_id, token_hash, claim_member_id, created_by, expires_at, max_uses)
  values (p_trip_id, public.invite_token_hash(v_token), p_claim_member_id, v_ctx.caller_member_id, v_expires, p_max_uses)
  returning id into v_id;

  return query select v_id, v_token, v_expires, p_max_uses;
end;
$$;

revoke all on function public.create_invite(uuid, uuid, int, int) from public, anon;
grant execute on function public.create_invite(uuid, uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3b. list_trip_invites(): an administrator sees the trip's invitations. Never
--     tokens, never hashes.
-- ---------------------------------------------------------------------------
create or replace function public.list_trip_invites(p_trip_id uuid)
returns table (
  invite_id       uuid,
  claim_member_id uuid,
  claim_name      text,
  created_by_name text,
  expires_at      timestamptz,
  max_uses        int,
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
           i.max_uses,
           i.use_count,
           i.revoked_at,
           i.created_at,
           case when i.revoked_at is not null then 'revoked'
                when i.use_count >= i.max_uses then 'used'
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
-- 3c. revoke_invite(): any administrator cancels an invitation. Safe to repeat.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invite(p_trip_id uuid, p_invite_id uuid)
returns table (invite_id uuid, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ctx record;
  v_inv public.trip_invites;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false);

  select * into v_inv from public.trip_invites i
   where i.id = p_invite_id and i.trip_id = p_trip_id for update;
  if not found then
    raise exception 'invite_not_found' using errcode = 'P0001';
  end if;
  if v_inv.revoked_at is not null then
    return query select v_inv.id, false;
    return;
  end if;

  update public.trip_invites set revoked_at = now(), revoked_by = v_ctx.caller_member_id where id = v_inv.id;
  return query select v_inv.id, true;
end;
$$;

revoke all on function public.revoke_invite(uuid, uuid) from public, anon;
grant execute on function public.revoke_invite(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3d. preview_invite(): what a person may see BEFORE signing in. The ONLY function
--     in the project that signed-out visitors may run. It returns at most one row
--     with a short, fixed list of public facts, and nothing at all (not an error)
--     for any token that is not currently usable, whatever the reason.
--     Never returned: any invitation record, any id, the token hash, budget, money,
--     the list of people, anyone's account or user id.
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
     and i.use_count < i.max_uses
     and t.status = 'active'
     and (i.claim_member_id is null or (cm.status = 'active' and cm.user_id is null));
$$;

revoke all on function public.preview_invite(text) from public;
grant execute on function public.preview_invite(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3e. accept_invite(): a signed-in person joins the trip, or claims the guest the
--     invitation was made for.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invite(p_token text)
returns table (trip_id uuid, member_id uuid, outcome text)
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
  v_target  public.trip_members;
  v_id      uuid;
  v_out     text;
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

  -- Same order as every administrator function: the trip first, then the invitation.
  select t.* into v_trip from public.trips t where t.id = v_inv.trip_id for update;
  select i.* into v_inv from public.trip_invites i where i.id = v_inv.id for update;
  if v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.use_count >= v_inv.max_uses or v_trip.status <> 'active' then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  select p.display_name into v_name from public.profiles p where p.id = v_uid and p.deleted_at is null;
  if v_name is null then
    raise exception 'profile_missing' using errcode = 'P0001';
  end if;

  select * into v_own from public.trip_members m where m.trip_id = v_trip.id and m.user_id = v_uid;
  v_has_own := found;
  if v_has_own and v_own.status = 'active' then -- already on the trip: nothing to do, the invitation is not used up
    return query select v_trip.id, v_own.id, 'already_member'::text;
    return;
  end if;

  if v_inv.claim_member_id is not null then
    select * into v_target from public.trip_members m
     where m.id = v_inv.claim_member_id and m.trip_id = v_trip.id and m.status = 'active' and m.user_id is null;
    if not found then
      raise exception 'invite_invalid' using errcode = 'P0001';
    end if;
    if v_has_own then -- they were on this trip before: two rows cannot be merged, so ask for a general invitation
      raise exception 'claim_conflict' using errcode = 'P0001';
    end if;
    update public.trip_members set user_id = v_uid where id = v_target.id;
    v_id := v_target.id;
    v_out := 'claimed';
    insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, new_value)
    values (v_trip.id, v_id, v_id, 'guest_claimed', v_inv.id::text);
  else
    if (select count(*) from public.trip_members m where m.trip_id = v_trip.id and m.status = 'active') >= 50 then
      raise exception 'trip_full' using errcode = 'P0001';
    end if;
    if v_has_own then -- a returning person gets their old row back (history kept), as an ordinary member
      update public.trip_members
         set status = 'active', role = 'member', left_at = null, display_name = v_name
       where id = v_own.id;
      v_id := v_own.id;
      v_out := 'rejoined';
      insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, old_value, new_value)
      values (v_trip.id, v_id, v_id, 'joined', v_own.status, v_inv.id::text);
    else
      insert into public.trip_members (trip_id, user_id, display_name, role, status, invited_by)
      values (v_trip.id, v_uid, v_name, 'member', 'active', v_inv.created_by)
      returning id into v_id;
      v_out := 'joined';
      insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action, new_value)
      values (v_trip.id, v_id, v_id, 'joined', v_inv.id::text);
    end if;
  end if;

  update public.trip_invites set use_count = use_count + 1 where id = v_inv.id;
  return query select v_trip.id, v_id, v_out;
end;
$$;

revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
