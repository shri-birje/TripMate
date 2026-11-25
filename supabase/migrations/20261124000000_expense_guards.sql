-- ============================================================================
-- TripMate migration 20261124000000: final database guards for expenses (M5, Checkpoint 2, ADR-063)
--
-- Migration 20261123200000 (expenses) is already applied and is NOT changed. The expense functions already
-- refuse these things with clear errors; this migration adds the independent LAST LINE OF DEFENCE for three
-- rules that were enforced only inside the functions, so that the database is the authority even for a change
-- made by any other path (including direct SQL by the project owner):
--
--   1. ADR-043 (c), the trip's currency is FIXED. Nothing in the app can change it (update_trip has no input
--      for it), and now the table refuses any change of it too ("currency_locked"). Expenses and balances are
--      always in the trip's currency, so a change would silently reinterpret every amount.
--   2. ADR-047, only ACTIVE members of the trip may be payers or share-holders on an expense row that is written.
--      (History keeps pointing at former members' rows: rows already written are never touched by this rule.)
--   3. ADR-063, the shares of an equal-split expense must be exactly what the database derives (largest remainder,
--      lowest id first), checked when the change is saved. Together with the sums check, no path can store
--      an expense whose shares are not the equal split of its amount among its participants.
--
-- None of these rewrites an existing function or changes what the app can do. They only refuse states that the
-- functions never produce. Safe to run more than once.
-- REQUIRES: all earlier migrations (1 to 8).
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

do $$
begin
  if to_regclass('public.expenses') is null or to_regprocedure('public.allocate_equal(bigint, uuid[])') is null then
    raise exception 'The expenses migration (20261123200000) must be applied before this one.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The trip's currency is fixed.
-- ---------------------------------------------------------------------------
create or replace function public.trips_currency_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'currency_locked' using errcode = 'P0001';
end;
$$;

revoke all on function public.trips_currency_guard() from public, anon, authenticated;

drop trigger if exists trips_currency_guard on public.trips;
create trigger trips_currency_guard
  before update of currency on public.trips
  for each row
  when (old.currency is distinct from new.currency)
  execute function public.trips_currency_guard();

-- ---------------------------------------------------------------------------
-- 2. A payer or share-holder row can only be WRITTEN for an active member of the same trip.
--    (Deleting rows, and the rows already stored for people who later left, are not affected.)
-- ---------------------------------------------------------------------------
create or replace function public.expense_rows_member_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.trip_members m
     where m.id = new.trip_member_id and m.trip_id = new.trip_id and m.status = 'active'
  ) then
    raise exception '%', case when tg_table_name = 'expense_payers' then 'payer_not_active' else 'participant_not_active' end
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.expense_rows_member_guard() from public, anon, authenticated;

drop trigger if exists expense_payers_member_guard on public.expense_payers;
create trigger expense_payers_member_guard
  before insert or update of trip_member_id on public.expense_payers
  for each row execute function public.expense_rows_member_guard();

drop trigger if exists expense_splits_member_guard on public.expense_splits;
create trigger expense_splits_member_guard
  before insert or update of trip_member_id on public.expense_splits
  for each row execute function public.expense_rows_member_guard();

-- ---------------------------------------------------------------------------
-- 3. The stored shares of an equal-split expense are exactly the database's own derivation. Checked when the
--    change is saved, AFTER the sums check (the trigger names sort that way), so a wrong total is still reported
--    as such.
-- ---------------------------------------------------------------------------
create or replace function public.check_expense_equal_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_method text;
  v_amount bigint;
  v_ids    uuid[];
begin
  if tg_table_name = 'expenses' then
    v_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    v_id := case when tg_op = 'DELETE' then old.expense_id else new.expense_id end;
  end if;
  select e.split_method, e.amount_minor into v_method, v_amount from public.expenses e where e.id = v_id;
  if not found then
    return null; -- the expense itself is gone (a whole trip was removed)
  end if;
  select array_agg(s.trip_member_id) into v_ids from public.expense_splits s where s.expense_id = v_id;
  if v_ids is null then
    return null; -- no shares at all is reported by the sums check
  end if;
  if v_method = 'equal' and exists (
    select 1
      from public.allocate_equal(v_amount, v_ids) a
      full join (select x.trip_member_id, x.share_minor from public.expense_splits x where x.expense_id = v_id) s on s.trip_member_id = a.member_id
     where a.member_id is null or s.trip_member_id is null or a.share_minor <> s.share_minor
  ) then
    raise exception 'shares_not_equal_split' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

revoke all on function public.check_expense_equal_split() from public, anon, authenticated;

drop trigger if exists expenses_zz_equal_check on public.expenses;
create constraint trigger expenses_zz_equal_check
  after insert or update of amount_minor on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_equal_split();

drop trigger if exists expense_splits_zz_equal_check on public.expense_splits;
create constraint trigger expense_splits_zz_equal_check
  after insert or update or delete on public.expense_splits
  deferrable initially deferred
  for each row execute function public.check_expense_equal_split();
