-- ============================================================================
-- TripMate migration 20261124100000: payer and share row guards also cover UPDATE (M5, Checkpoint 3 prerequisite)
--
-- Migration 20261124000000 (already applied, NOT changed) made the "only active members" guard fire on INSERT and on an
-- UPDATE of trip_member_id. A review found that an UPDATE of ONLY the amount (paid_minor or share_minor) of a row whose member
-- has since left slipped past it: it would change a former member's balance without rule I-1. The app can never do this (it has
-- no write rights, and update_expense deletes and re-inserts rows), but the project owner's direct SQL could.
--
-- This file widens both triggers to BEFORE INSERT OR UPDATE (any column). It does not rewrite any function:
-- expense_rows_member_guard() is the same function as before.
--
-- What is NOT affected: reading, balances, deleting rows, the cascade that removes a whole trip, and the rows already stored for
-- people who later left (they are only refused if somebody tries to CHANGE them in place).
--
-- A note on an earlier comment: migration 20261124000000 says the equal-split check runs "after the sums check (the trigger names
-- sort that way)". That holds only between triggers on the SAME table; checks queued from different tables run in the order their
-- events were queued. Every check still runs when the change is saved and any failure rolls the whole change back, so this only
-- affects WHICH error code a bad save reports, never whether it is refused. (That earlier file is left byte for byte as applied.)
--
-- Safe to run more than once. REQUIRES: migrations 1 to 9.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.expense_rows_member_guard()') is null then
    raise exception 'The expense guards migration (20261124000000) must be applied before this one.';
  end if;
end;
$$;

drop trigger if exists expense_payers_member_guard on public.expense_payers;
create trigger expense_payers_member_guard
  before insert or update on public.expense_payers
  for each row execute function public.expense_rows_member_guard();

drop trigger if exists expense_splits_member_guard on public.expense_splits;
create trigger expense_splits_member_guard
  before insert or update on public.expense_splits
  for each row execute function public.expense_rows_member_guard();
