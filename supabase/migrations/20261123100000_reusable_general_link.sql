-- ============================================================================
-- TripMate migration 20261123100000: a reusable, copyable general link (ADR-061)
--
-- WHAT CHANGES (migrations 1 to 6 stay exactly as applied; this only moves forward)
--   1. The trip's ONE general invitation link can be copied again and again: the
--      SAME token every time. To make that possible the token of the general link
--      (and ONLY the general link) is kept ENCRYPTED in Supabase Vault. Validation
--      still uses the SHA-256 hash exactly as before; nothing about checking a link
--      changes. Guest-claim links stay show-once and hash-only: they never get a secret
--      (a table rule enforces it).
--   2. get_general_invite_link(): an active administrator of the trip gets the current
--      token on demand (to copy it). Nobody else can. The returned token is checked
--      against the stored hash, so a damaged or swapped secret yields nothing.
--   3. Revoking a link deletes its Vault secret, and so does removing the invitation
--      row (for example if a whole trip is ever removed): a revoked link can never be
--      read again, not even by an administrator.
--   4. create_invite(): REFUSES to make a second general link while a valid one exists
--      ("invite_exists"), so a stale screen can never silently kill a link people already
--      received. After revocation, or once a link has expired, a new one can be made. (The
--      "replace" action is gone; friend links still replace the friend's earlier link.)
--   5. list_trip_invites() also says whether a link can be copied. Links made BEFORE this
--      update were never stored, so they cannot be copied; they keep working and can be
--      revoked, then a new (copyable) link can be made.
--
-- SAFETY CHECKS THIS FILE MAKES ON ITSELF
--   * It refuses to run if Supabase Vault is not enabled, and refuses if the signed-in or
--     signed-out roles can read the Vault in any way (a secret store they can read would
--     be worse than no secret store).
--   * Every Vault touch happens inside functions that pin search_path and are closed to
--     signed-out visitors; the only function that returns a token is the admin-only one.
--   * No token or secret is ever written to a log or an error message by anything here.
--
-- REQUIRES: all earlier migrations (1 to 6) and Supabase Vault (extension supabase_vault).
-- Safe to run more than once.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Vault must exist, and must be closed to the app.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('vault.secrets') is null or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault is not enabled on this project. Enable the supabase_vault extension (Dashboard -> Database -> Extensions), then run this file again.';
  end if;
  if has_schema_privilege('anon', 'vault', 'USAGE') or has_schema_privilege('authenticated', 'vault', 'USAGE')
     or has_table_privilege('anon', 'vault.secrets', 'SELECT') or has_table_privilege('authenticated', 'vault.secrets', 'SELECT')
     or has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT') or has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') then
    raise exception 'The Vault can be read by signed-in or signed-out visitors. Refusing to store secrets in it until its permissions are fixed.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Where the secret lives: the invitation row stores only the Vault secret's id.
--    A friend's (claim) link can NEVER have one.
-- ---------------------------------------------------------------------------
alter table public.trip_invites add column if not exists token_secret_id uuid;

comment on column public.trip_invites.token_secret_id is 'Id of the encrypted Vault secret holding the general link''s token, so an admin can copy the same link again. NULL for friend links (hash-only) and for links made before migration 20261123100000.';

alter table public.trip_invites drop constraint if exists trip_invites_claim_hash_only;
alter table public.trip_invites add constraint trip_invites_claim_hash_only check (claim_member_id is null or token_secret_id is null);

-- ---------------------------------------------------------------------------
-- 2. Whenever an invitation row goes (even by the automatic clean-up when a trip is
--    removed), its secret goes with it. Internal: not callable by the app.
-- ---------------------------------------------------------------------------
create or replace function public.trip_invites_remove_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.token_secret_id is not null then
    delete from vault.secrets where id = old.token_secret_id;
  end if;
  return old;
end;
$$;

revoke all on function public.trip_invites_remove_secret() from public, anon, authenticated;

drop trigger if exists trip_invites_remove_secret on public.trip_invites;
create trigger trip_invites_remove_secret
  before delete on public.trip_invites
  for each row execute function public.trip_invites_remove_secret();

-- ---------------------------------------------------------------------------
-- 3. create_invite(): the general link is made ONCE and reused; a friend's link is
--    still show-once. Returns the raw token (the screen only keeps it for a friend's link).
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
  v_secret  uuid;
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
    -- one live claim link per guest: the previous one stops working (friend links have no secret to remove)
    update public.trip_invites
       set revoked_at = now(), revoked_by = v_ctx.caller_member_id
     where claim_member_id = p_claim_member_id and revoked_at is null;
  else
    -- a valid general link already exists: refuse, so a stale screen cannot kill a link people already received
    if exists (
      select 1 from public.trip_invites i
       where i.trip_id = p_trip_id and i.claim_member_id is null and i.revoked_at is null and i.expires_at > now()
    ) then
      raise exception 'invite_exists' using errcode = 'P0001';
    end if;
    -- an expired link that was never revoked is cleared away (and its secret removed) so a new one can be made
    delete from vault.secrets where id in (
      select i.token_secret_id from public.trip_invites i
       where i.trip_id = p_trip_id and i.claim_member_id is null and i.revoked_at is null and i.token_secret_id is not null
    );
    update public.trip_invites
       set revoked_at = now(), revoked_by = v_ctx.caller_member_id, token_secret_id = null
     where trip_id = p_trip_id and claim_member_id is null and revoked_at is null;
  end if;

  -- 256 bits: three random UUIDs (366 bits of strong randomness) reduced by SHA-256, as lower-case hex.
  v_token := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  v_expires := now() + make_interval(hours => p_expires_in_hours);

  insert into public.trip_invites (trip_id, token_hash, claim_member_id, created_by, expires_at)
  values (p_trip_id, public.invite_token_hash(v_token), p_claim_member_id, v_ctx.caller_member_id, v_expires)
  returning id into v_id;

  if p_claim_member_id is null then
    -- the general link only: keep its token encrypted so it can be copied again (the name carries no secret)
    v_secret := vault.create_secret(v_token, 'trip-invite-' || v_id::text, 'general invitation link of a trip');
    update public.trip_invites set token_secret_id = v_secret where id = v_id;
  end if;

  return query select v_id, v_token, v_expires;
end;
$$;

revoke all on function public.create_invite(uuid, uuid, int) from public, anon;
grant execute on function public.create_invite(uuid, uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_general_invite_link(): an active administrator of the trip gets the SAME token
--    again, to copy it. Nothing for anyone else, for a revoked or expired link, for an
--    archived trip, or if the stored secret does not match the link's hash.
-- ---------------------------------------------------------------------------
create or replace function public.get_general_invite_link(p_trip_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql
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
    select s.decrypted_secret, i.expires_at
      from public.trip_invites i
      join public.trips t on t.id = i.trip_id
      join vault.decrypted_secrets s on s.id = i.token_secret_id
     where i.trip_id = p_trip_id
       and i.claim_member_id is null
       and i.revoked_at is null
       and i.expires_at > now()
       and t.status = 'active'
       and public.invite_token_hash(s.decrypted_secret) = i.token_hash;
end;
$$;

revoke all on function public.get_general_invite_link(uuid) from public, anon;
grant execute on function public.get_general_invite_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. revoke_invite(): invalidates the link AND removes its Vault secret. Safe to repeat.
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

  if v_inv.token_secret_id is not null then
    delete from vault.secrets where id = v_inv.token_secret_id;
  end if;
  update public.trip_invites
     set revoked_at = now(), revoked_by = v_ctx.caller_member_id, token_secret_id = null
   where id = v_inv.id;
  return query select v_inv.id, true;
end;
$$;

revoke all on function public.revoke_invite(uuid, uuid) from public, anon;
grant execute on function public.revoke_invite(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. list_trip_invites(): also says whether a link can be copied. Never tokens or hashes.
-- ---------------------------------------------------------------------------
drop function if exists public.list_trip_invites(uuid);

create function public.list_trip_invites(p_trip_id uuid)
returns table (
  invite_id       uuid,
  claim_member_id uuid,
  claim_name      text,
  created_by_name text,
  expires_at      timestamptz,
  use_count       int,
  revoked_at      timestamptz,
  created_at      timestamptz,
  status          text,
  copyable        boolean
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
                else 'active' end,
           (i.token_secret_id is not null and i.revoked_at is null and i.expires_at > now())
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
