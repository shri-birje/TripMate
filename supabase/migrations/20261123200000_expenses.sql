-- ============================================================================
-- TripMate migration 20261123200000: expenses (M5, Checkpoint 1, ADR-063)
--
-- WHAT THIS DOES
--   1. A unique index on trip_members (id, trip_id) so other tables can use composite
--      foreign keys ("this member belongs to THIS trip" becomes impossible to get wrong).
--   2. categories (system categories seeded; trip-specific ones are a later feature but the
--      ownership rule is enforced from day one), expenses, expense_payers, expense_splits and
--      expense_revisions. Everyone can only READ them (members of the trip, under row-level
--      security); nobody can write them directly.
--   3. Five functions the app may run:
--        create_expense()        any active member records a shared expense (idempotent by id)
--        update_expense()        an admin (any) or the creator (own) replaces it
--        delete_expense()        soft delete (the row is kept; balances stop counting it)
--        restore_expense()       undo a delete
--        trip_member_balances()  what each member paid, owes and nets (every member, including former ones)
--      plus internal helpers and three triggers (none callable by the app).
--
-- RULES ENFORCED INSIDE THE DATABASE (not just in the screens)
--   * The caller is identified with auth.uid(). Signed-out callers cannot run anything here.
--   * Strangers, former members and pending requesters get "trip_not_found" (the same answer as for
--     a trip that does not exist). Archived trips refuse every expense change (ADR-043 b).
--   * EQUAL SPLITS ARE DERIVED BY THE DATABASE: the caller sends only the participants. Shares use
--     the largest-remainder method with equal weights: everyone gets floor(amount / n) and the first
--     (amount mod n) participants, ordered by id as plain text in the "C" collation, get one extra paisa.
--     This is exactly what packages/core computeSplit does; the tests prove they agree (parity).
--   * Several payers are allowed; their amounts must add up exactly to the total.
--   * Money is whole paise (bigint), 1 to 10^12 per expense, at most 2000 expenses per trip.
--   * An expense date must lie inside the trip's dates (spent_on is a calendar date).
--   * Only ACTIVE members may be payers or participants on a new or edited expense. History keeps
--     pointing at former members' rows (rows are never deleted).
--   * LOCK ORDER (every write function): the trip row is locked FIRST (member_change_context), then the
--     expense row, never the reverse. The guard triggers below only READ, so they add no lock.
--   * Edit, delete and restore need the version the caller started from (version_conflict if stale).
--   * ADR-047 (trigger on trip_members): a person with a non-zero balance cannot become "left" or
--     "removed". ADR-043 (a) (trigger on trips): a date change that would leave an existing, non-deleted
--     expense outside the trip is refused. Restoring an expense re-checks the current trip dates.
--   * Rule I-1: after any create, edit, delete or restore, every FORMER member touched by the old or new
--     rows must have a balance of exactly zero over the COMPLETE resulting ledger of the trip, or the
--     whole change is refused ("former_member_balance").
--   * Retrying a create with the same id and the same complete content (title, amount, date, category,
--     notes, participants, payers and shares) is safe and changes nothing. The same id with different
--     content, or an id that belongs to another trip, answers "expense_id_taken" and reveals nothing.
--   * History (expense_revisions) is append-only and readable only by ACTIVE members of the trip. It holds
--     member ids and amounts, never user ids, emails or display names.
--
-- REQUIRES: all earlier migrations (1 to 7). Safe to run more than once.
-- It does NOT change migrations 1 to 7 or the existing functions (remove_member, leave_trip, update_trip).
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. The earlier migrations must be in place.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.trips') is null or to_regclass('public.trip_members') is null
     or to_regprocedure('public.member_change_context(uuid, uuid, boolean, boolean)') is null
     or to_regprocedure('public.trip_role_of(uuid, uuid)') is null
     or to_regprocedure('public.is_trip_member(uuid)') is null
     or to_regprocedure('public.set_updated_at()') is null then
    raise exception 'The earlier migrations (trips, members, invitations) must be applied before this one.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Composite foreign keys need a unique (id, trip_id) on the members table (additive; id is already the primary key).
-- ---------------------------------------------------------------------------
create unique index if not exists trip_members_id_trip_unique on public.trip_members (id, trip_id);

-- ---------------------------------------------------------------------------
-- 2. Categories. trip_id NULL = a system category (shared by every trip). A trip-specific category (a later
--    feature) has its trip_id set and may only be used by that trip's expenses (enforced below).
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references public.trips (id) on delete cascade,
  key         text not null
                constraint categories_key_format check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name        text not null
                constraint categories_name_length check (char_length(btrim(name)) between 1 and 60),
  icon        text not null,
  sort_order  int not null default 0,
  archived_at timestamptz
);

comment on table public.categories is 'Expense categories. trip_id NULL = system category; a trip-specific category may only be used inside its own trip.';

create unique index if not exists categories_system_key_unique on public.categories (key) where trip_id is null;
create unique index if not exists categories_trip_key_unique on public.categories (trip_id, key) where trip_id is not null;

insert into public.categories (key, name, icon, sort_order) values
  ('transportation', 'Transportation', 'bus',          10),
  ('accommodation',  'Accommodation',  'bed',          20),
  ('food',           'Food',           'utensils',     30),
  ('shopping',       'Shopping',       'shopping-bag', 40),
  ('activities',     'Activities',     'ticket',       50),
  ('fuel_tolls',     'Fuel and tolls', 'fuel',         60),
  ('other',          'Other',          'dots',         70)
on conflict (key) where trip_id is null do nothing;

-- ---------------------------------------------------------------------------
-- 3. Expenses. The id is global (primary key) and chosen by the app so a retry is safe; (id, trip_id) is also
--    unique so the child tables can prove they belong to the same trip.
--    The keys that point at trip_members are checked when the change is SAVED (deferrable initially deferred), so
--    removing a whole trip, which removes its members and its expenses in one cascade, works in any order. They are
--    still enforced at that moment: a member row cannot disappear while an expense still refers to it.
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id           uuid primary key,
  trip_id      uuid not null references public.trips (id) on delete cascade,
  title        text not null
                 constraint expenses_title_length check (char_length(title) between 1 and 120 and title = btrim(title)),
  amount_minor bigint not null
                 constraint expenses_amount_range check (amount_minor between 1 and 1000000000000),
  category_id  uuid references public.categories (id),
  spent_on     date not null,
  notes        text
                 constraint expenses_notes_length check (notes is null or char_length(notes) between 1 and 1000),
  scope        text not null default 'shared'
                 constraint expenses_scope_shared_only check (scope = 'shared'),
  split_method text not null
                 constraint expenses_split_method_equal_only check (split_method = 'equal'),
  created_by   uuid not null,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      int not null default 1
                 constraint expenses_version_positive check (version >= 1),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint expenses_id_trip_unique unique (id, trip_id),
  constraint expenses_creator_fk foreign key (created_by, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred,
  constraint expenses_updater_fk foreign key (updated_by, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred,
  constraint expenses_deleter_fk foreign key (deleted_by, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred,
  constraint expenses_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);

comment on table public.expenses is 'Shared expenses. Written only by create_expense, update_expense, delete_expense and restore_expense.';

create index if not exists expenses_trip_date_idx on public.expenses (trip_id, spent_on desc) where deleted_at is null;
create index if not exists expenses_trip_category_idx on public.expenses (trip_id, category_id) where deleted_at is null;
create index if not exists expenses_trip_creator_idx on public.expenses (trip_id, created_by);

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

-- A category may only be a system category or one that belongs to the SAME trip as the expense.
create or replace function public.expenses_check_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.category_id is not null and not exists (
    select 1 from public.categories c
     where c.id = new.category_id and (c.trip_id is null or c.trip_id = new.trip_id)
  ) then
    raise exception 'category_not_found' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.expenses_check_category() from public, anon, authenticated;

drop trigger if exists expenses_category_owner on public.expenses;
create trigger expenses_category_owner
  before insert or update of category_id, trip_id on public.expenses
  for each row execute function public.expenses_check_category();

-- ---------------------------------------------------------------------------
-- 4. Who paid and who shares. Composite keys make "same trip" a hard database rule.
-- ---------------------------------------------------------------------------
create table if not exists public.expense_payers (
  expense_id     uuid not null,
  trip_id        uuid not null,
  trip_member_id uuid not null,
  paid_minor     bigint not null
                   constraint expense_payers_paid_range check (paid_minor between 1 and 1000000000000),
  primary key (expense_id, trip_member_id),
  constraint expense_payers_expense_fk foreign key (expense_id, trip_id) references public.expenses (id, trip_id) on delete cascade,
  constraint expense_payers_member_fk foreign key (trip_member_id, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred
);

create table if not exists public.expense_splits (
  expense_id     uuid not null,
  trip_id        uuid not null,
  trip_member_id uuid not null,
  share_minor    bigint not null
                   constraint expense_splits_share_range check (share_minor between 0 and 1000000000000),
  input_value    numeric,
  primary key (expense_id, trip_member_id),
  constraint expense_splits_expense_fk foreign key (expense_id, trip_id) references public.expenses (id, trip_id) on delete cascade,
  constraint expense_splits_member_fk foreign key (trip_member_id, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred
);

create index if not exists expense_payers_member_idx on public.expense_payers (trip_member_id);
create index if not exists expense_splits_member_idx on public.expense_splits (trip_member_id);
create index if not exists expense_payers_trip_idx on public.expense_payers (trip_id);
create index if not exists expense_splits_trip_idx on public.expense_splits (trip_id);

-- Checked when the change is saved: payments and shares each add up to the amount, and there is at least one of each.
create or replace function public.check_expense_sums()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_amount bigint;
  v_paid   bigint;
  v_share  bigint;
  v_np     int;
  v_ns     int;
begin
  if tg_table_name = 'expenses' then
    v_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    v_id := case when tg_op = 'DELETE' then old.expense_id else new.expense_id end;
  end if;
  select e.amount_minor into v_amount from public.expenses e where e.id = v_id;
  if not found then
    return null; -- the expense itself is gone (a whole trip was removed)
  end if;
  select coalesce(sum(p.paid_minor), 0), count(*) into v_paid, v_np from public.expense_payers p where p.expense_id = v_id;
  select coalesce(sum(s.share_minor), 0), count(*) into v_share, v_ns from public.expense_splits s where s.expense_id = v_id;
  if v_np = 0 or v_ns = 0 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if v_paid <> v_amount then
    raise exception 'payers_total_mismatch' using errcode = 'P0001';
  end if;
  if v_share <> v_amount then
    raise exception 'shares_total_mismatch' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

revoke all on function public.check_expense_sums() from public, anon, authenticated;

drop trigger if exists expenses_sums_check on public.expenses;
create constraint trigger expenses_sums_check
  after insert or update of amount_minor on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_sums();

drop trigger if exists expense_payers_sums_check on public.expense_payers;
create constraint trigger expense_payers_sums_check
  after insert or update or delete on public.expense_payers
  deferrable initially deferred
  for each row execute function public.check_expense_sums();

drop trigger if exists expense_splits_sums_check on public.expense_splits;
create constraint trigger expense_splits_sums_check
  after insert or update or delete on public.expense_splits
  deferrable initially deferred
  for each row execute function public.check_expense_sums();

-- ---------------------------------------------------------------------------
-- 5. History. Append-only, readable by active members only, holds member ids and amounts (never names or user ids).
-- ---------------------------------------------------------------------------
create table if not exists public.expense_revisions (
  id         bigint generated always as identity primary key,
  expense_id uuid not null,
  trip_id    uuid not null,
  version    int not null,
  action     text not null
               constraint expense_revisions_action_values check (action in ('create', 'update', 'delete', 'restore')),
  snapshot   jsonb not null,
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  constraint expense_revisions_version_unique unique (expense_id, version),
  constraint expense_revisions_expense_fk foreign key (expense_id, trip_id) references public.expenses (id, trip_id) on delete cascade,
  constraint expense_revisions_changer_fk foreign key (changed_by, trip_id) references public.trip_members (id, trip_id) deferrable initially deferred
);

comment on table public.expense_revisions is 'Append-only history of every expense change. Member ids and amounts only; never names, user ids or emails.';

create index if not exists expense_revisions_trip_idx on public.expense_revisions (trip_id);

create or replace function public.expense_revisions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old; -- the automatic cascade when an expense or a whole trip is removed
  end if;
  raise exception 'expense_revisions is append-only' using errcode = '42501';
end;
$$;

revoke all on function public.expense_revisions_append_only() from public, anon, authenticated;

drop trigger if exists expense_revisions_no_change on public.expense_revisions;
create trigger expense_revisions_no_change
  before update or delete on public.expense_revisions
  for each row execute function public.expense_revisions_append_only();

drop trigger if exists expense_revisions_no_truncate on public.expense_revisions;
create trigger expense_revisions_no_truncate
  before truncate on public.expense_revisions
  for each statement execute function public.expense_revisions_append_only();

-- ---------------------------------------------------------------------------
-- 6. Security rules: ACTIVE members of the trip may READ; nobody may write directly.
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_payers enable row level security;
alter table public.expense_splits enable row level security;
alter table public.expense_revisions enable row level security;

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (trip_id is null or public.is_trip_member(trip_id));

drop policy if exists expenses_select_members on public.expenses;
create policy expenses_select_members on public.expenses
  for select to authenticated
  using (public.is_trip_member(trip_id));

drop policy if exists expense_payers_select_members on public.expense_payers;
create policy expense_payers_select_members on public.expense_payers
  for select to authenticated
  using (public.is_trip_member(trip_id));

drop policy if exists expense_splits_select_members on public.expense_splits;
create policy expense_splits_select_members on public.expense_splits
  for select to authenticated
  using (public.is_trip_member(trip_id));

drop policy if exists expense_revisions_select_members on public.expense_revisions;
create policy expense_revisions_select_members on public.expense_revisions
  for select to authenticated
  using (public.is_trip_member(trip_id));

revoke all on public.categories, public.expenses, public.expense_payers, public.expense_splits, public.expense_revisions
  from public, anon, authenticated;
grant select on public.categories, public.expenses, public.expense_payers, public.expense_splits, public.expense_revisions
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Internal helpers. NONE of these can be run by the app (revoked below); the functions that can run them
--    do so with the owner's rights.
-- ---------------------------------------------------------------------------

-- Equal split with largest remainder. Equal weights give every participant the same remainder, so the extra
-- paise (amount mod n) go to the lowest ids. "C" collation = byte order of the lowercase hex text, which is
-- what the TypeScript engine's plain string comparison gives too.
create or replace function public.allocate_equal(p_total bigint, p_member_ids uuid[])
returns table (member_id uuid, share_minor bigint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n    int := coalesce(cardinality(p_member_ids), 0);
  v_base bigint;
  v_rem  bigint;
begin
  if p_total is null or p_total < 0 or v_n = 0 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_member_ids) x where x is null)
     or (select count(distinct x) from unnest(p_member_ids) x) <> v_n then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  v_base := p_total / v_n;
  v_rem := p_total % v_n;
  return query
    select u.id, v_base + case when u.rn <= v_rem then 1 else 0 end
      from (select x as id, row_number() over (order by x::text collate "C") as rn from unnest(p_member_ids) x) u
     order by u.id::text collate "C";
end;
$$;

revoke all on function public.allocate_equal(bigint, uuid[]) from public, anon, authenticated;

-- paid - owed of one member over the trip's NON-DELETED shared expenses (former members included).
create or replace function public.member_net_minor(p_trip_id uuid, p_member_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (
    coalesce((select sum(p.paid_minor) from public.expense_payers p
               join public.expenses e on e.id = p.expense_id and e.trip_id = p.trip_id
              where e.trip_id = p_trip_id and e.deleted_at is null and p.trip_member_id = p_member_id), 0)
    -
    coalesce((select sum(s.share_minor) from public.expense_splits s
               join public.expenses e on e.id = s.expense_id and e.trip_id = s.trip_id
              where e.trip_id = p_trip_id and e.deleted_at is null and s.trip_member_id = p_member_id), 0)
  )::bigint;
$$;

revoke all on function public.member_net_minor(uuid, uuid) from public, anon, authenticated;

-- ADR-047: a member with a non-zero balance cannot leave or be removed. The signed amount (paise) travels in the error detail.
create or replace function public.assert_member_settled(p_trip_id uuid, p_member_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_net bigint := public.member_net_minor(p_trip_id, p_member_id);
begin
  if v_net <> 0 then
    raise exception 'balance_not_settled' using errcode = 'P0001', detail = 'net_minor=' || v_net::text;
  end if;
end;
$$;

revoke all on function public.assert_member_settled(uuid, uuid) from public, anon, authenticated;

-- ADR-043 (a): no non-deleted expense may lie outside the trip's dates.
create or replace function public.assert_expenses_within_dates(p_trip_id uuid, p_start date, p_end date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.expenses e
     where e.trip_id = p_trip_id and e.deleted_at is null and (e.spent_on < p_start or e.spent_on > p_end)
  ) then
    raise exception 'expenses_outside_dates' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_expenses_within_dates(uuid, date, date) from public, anon, authenticated;

-- Rule I-1: every FORMER member in the list must have a balance of exactly zero over the complete ledger of the trip.
create or replace function public.assert_former_members_settled(p_trip_id uuid, p_member_ids uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_net bigint;
begin
  select public.member_net_minor(p_trip_id, m.id) into v_net
    from public.trip_members m
   where m.trip_id = p_trip_id and m.status <> 'active' and m.id = any(coalesce(p_member_ids, '{}'::uuid[]))
     and public.member_net_minor(p_trip_id, m.id) <> 0
   limit 1;
  if found then
    raise exception 'former_member_balance' using errcode = 'P0001', detail = 'net_minor=' || v_net::text;
  end if;
end;
$$;

revoke all on function public.assert_former_members_settled(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. The final guards, as triggers on the EXISTING tables. They only READ (no lock of their own): every path that
--    changes these rows (remove_member, leave_trip, update_trip, ...) already holds the trip lock.
-- ---------------------------------------------------------------------------
create or replace function public.trip_members_balance_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_member_settled(new.trip_id, new.id);
  return new;
end;
$$;

revoke all on function public.trip_members_balance_guard() from public, anon, authenticated;

drop trigger if exists trip_members_balance_guard on public.trip_members;
create trigger trip_members_balance_guard
  before update of status on public.trip_members
  for each row
  when (old.status = 'active' and new.status <> 'active')
  execute function public.trip_members_balance_guard();

create or replace function public.trips_dates_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_expenses_within_dates(new.id, new.start_date, new.end_date);
  return new;
end;
$$;

revoke all on function public.trips_dates_guard() from public, anon, authenticated;

drop trigger if exists trips_dates_guard on public.trips;
create trigger trips_dates_guard
  before update of start_date, end_date on public.trips
  for each row
  when (old.start_date is distinct from new.start_date or old.end_date is distinct from new.end_date)
  execute function public.trips_dates_guard();

-- ---------------------------------------------------------------------------
-- 9. Input checks and the canonical form of an expense (used for idempotent retries and for history).
-- ---------------------------------------------------------------------------

-- The payers, as sent by the app: [{"member_id": "...", "paid_minor": 1234}, ...]. Strictly shaped; anything else is refused.
create or replace function public.expense_parse_payers(p_payers jsonb)
returns table (member_id uuid, paid_minor bigint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  e     jsonb;
  v_id  uuid;
  v_ids uuid[] := '{}';
  v_amt bigint;
begin
  if p_payers is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_payers) <> 'array' then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_payers) < 1 or jsonb_array_length(p_payers) > 50 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  for e in select x.value from jsonb_array_elements(p_payers) as x loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if (select count(*) from jsonb_object_keys(e)) <> 2 or not (e ? 'member_id') or not (e ? 'paid_minor') then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if jsonb_typeof(e -> 'member_id') <> 'string' or (e ->> 'member_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if jsonb_typeof(e -> 'paid_minor') <> 'number' or (e ->> 'paid_minor') !~ '^[1-9][0-9]{0,12}$' then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    v_id := (e ->> 'member_id')::uuid;
    v_amt := (e ->> 'paid_minor')::bigint;
    if v_amt > 1000000000000 or v_id = any(v_ids) then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_id;
    member_id := v_id;
    paid_minor := v_amt;
    return next;
  end loop;
end;
$$;

revoke all on function public.expense_parse_payers(jsonb) from public, anon, authenticated;

-- Checks that need no database state: trims and validates the text fields, the amount, the method and the people lists.
create or replace function public.expense_check_shape(
  p_title text, p_amount_minor bigint, p_spent_on date, p_notes text, p_split_method text, p_participants uuid[], p_payers jsonb,
  out o_title text, out o_notes text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n    int;
  v_paid bigint;
begin
  o_title := btrim(p_title);
  if o_title is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if char_length(o_title) < 1 or char_length(o_title) > 120 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 1000000000000 or p_spent_on is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  o_notes := nullif(btrim(p_notes), '');
  if o_notes is not null and char_length(o_notes) > 1000 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if p_split_method is distinct from 'equal' then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if p_participants is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  v_n := cardinality(p_participants);
  if v_n < 1 or v_n > 50
     or exists (select 1 from unnest(p_participants) x where x is null)
     or (select count(distinct x) from unnest(p_participants) x) <> v_n then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  select coalesce(sum(p.paid_minor), 0) into v_paid from public.expense_parse_payers(p_payers) p;
  if v_paid <> p_amount_minor then
    raise exception 'payers_total_mismatch' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.expense_check_shape(text, bigint, date, text, text, uuid[], jsonb) from public, anon, authenticated;

-- Checks against the (locked) state of the trip: dates, who is active, the category. Returns the category id (or NULL).
create or replace function public.expense_check_state(
  p_trip_id uuid, p_spent_on date, p_category_key text, p_participants uuid[], p_payers jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
  v_cat  uuid;
begin
  select t.* into v_trip from public.trips t where t.id = p_trip_id;
  if not found then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;
  if p_spent_on < v_trip.start_date or p_spent_on > v_trip.end_date then
    raise exception 'outside_trip_dates' using errcode = 'P0001';
  end if;
  if (select count(*) from public.trip_members m
       where m.trip_id = p_trip_id and m.status = 'active' and m.id = any(p_participants)) <> cardinality(p_participants) then
    raise exception 'participant_not_active' using errcode = 'P0001';
  end if;
  if (select count(*) from public.trip_members m
       where m.trip_id = p_trip_id and m.status = 'active' and m.id in (select p.member_id from public.expense_parse_payers(p_payers) p))
     <> (select count(*) from public.expense_parse_payers(p_payers)) then
    raise exception 'payer_not_active' using errcode = 'P0001';
  end if;
  if p_category_key is not null then
    select c.id into v_cat from public.categories c where c.key = p_category_key and c.trip_id is null and c.archived_at is null;
    if not found then
      raise exception 'category_not_found' using errcode = 'P0001';
    end if;
  end if;
  return v_cat;
end;
$$;

revoke all on function public.expense_check_state(uuid, date, text, uuid[], jsonb) from public, anon, authenticated;

-- The canonical form of an expense: what is compared for idempotent retries, and what history stores. Member ids and amounts only.
create or replace function public.expense_payers_json(p_payers jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('member_id', p.member_id, 'paid_minor', p.paid_minor) order by p.member_id::text collate "C"), '[]'::jsonb)
    from public.expense_parse_payers(p_payers) p;
$$;

create or replace function public.expense_splits_json(p_amount bigint, p_participants uuid[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('member_id', a.member_id, 'share_minor', a.share_minor) order by a.member_id::text collate "C"), '[]'::jsonb)
    from public.allocate_equal(p_amount, p_participants) a;
$$;

create or replace function public.expense_canonical(
  p_title text, p_amount bigint, p_spent_on date, p_category_key text, p_notes text, p_method text, p_payers jsonb, p_splits jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'title', p_title, 'amount_minor', p_amount, 'spent_on', p_spent_on, 'category_key', p_category_key,
    'notes', p_notes, 'split_method', p_method, 'payers', p_payers, 'splits', p_splits);
$$;

create or replace function public.expense_stored_canonical(p_expense_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.expense_canonical(
    e.title, e.amount_minor, e.spent_on, c.key, e.notes, e.split_method,
    coalesce((select jsonb_agg(jsonb_build_object('member_id', p.trip_member_id, 'paid_minor', p.paid_minor) order by p.trip_member_id::text collate "C")
                from public.expense_payers p where p.expense_id = e.id), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('member_id', s.trip_member_id, 'share_minor', s.share_minor) order by s.trip_member_id::text collate "C")
                from public.expense_splits s where s.expense_id = e.id), '[]'::jsonb))
    from public.expenses e
    left join public.categories c on c.id = e.category_id
   where e.id = p_expense_id;
$$;

-- Records one history row for the expense as it is NOW (its current version).
create or replace function public.expense_record_revision(p_expense_id uuid, p_action text, p_changed_by uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_revisions (expense_id, trip_id, version, action, snapshot, changed_by)
  select e.id, e.trip_id, e.version, p_action,
         public.expense_stored_canonical(e.id) || jsonb_build_object('deleted', e.deleted_at is not null),
         p_changed_by
    from public.expenses e where e.id = p_expense_id;
end;
$$;

revoke all on function public.expense_payers_json(jsonb), public.expense_splits_json(bigint, uuid[]),
  public.expense_canonical(text, bigint, date, text, text, text, jsonb, jsonb), public.expense_stored_canonical(uuid),
  public.expense_record_revision(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10a. create_expense(): any active member records a shared, equally split expense.
--      Idempotent: the same id with the same complete content changes nothing.
-- ---------------------------------------------------------------------------
create or replace function public.create_expense(
  p_trip_id        uuid,
  p_expense_id     uuid,
  p_title          text,
  p_amount_minor   bigint,
  p_spent_on       date,
  p_category_key   text,
  p_notes          text,
  p_split_method   text,
  p_participants   uuid[],
  p_payers         jsonb
)
returns table (expense_id uuid, version int, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_in      record;
  v_cat     uuid;
  v_request jsonb;
  v_ex      public.expenses;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- 1. Who is calling? Active member of an ACTIVE trip; the trip row is LOCKED from here on.
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false);
  if p_expense_id is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;

  -- 2. Input that needs no database state.
  select * into v_in from public.expense_check_shape(p_title, p_amount_minor, p_spent_on, p_notes, p_split_method, p_participants, p_payers);
  v_request := public.expense_canonical(
    v_in.o_title, p_amount_minor, p_spent_on, p_category_key, v_in.o_notes, 'equal',
    public.expense_payers_json(p_payers), public.expense_splits_json(p_amount_minor, p_participants));

  -- 3. Retry of an earlier create? Same trip, same creator, not deleted and the COMPLETE content is identical: nothing changes.
  --    Anything else on an id that is already used (another trip, different content) is the same fixed answer.
  select e.* into v_ex from public.expenses e where e.id = p_expense_id;
  if found then
    if v_ex.trip_id = p_trip_id and v_ex.created_by = v_ctx.caller_member_id and v_ex.deleted_at is null
       and public.expense_stored_canonical(v_ex.id) = v_request then
      return query select v_ex.id, v_ex.version, false;
      return;
    end if;
    raise exception 'expense_id_taken' using errcode = 'P0001';
  end if;

  -- 4. State of the (locked) trip: dates, active people, category, the size limit.
  v_cat := public.expense_check_state(p_trip_id, p_spent_on, p_category_key, p_participants, p_payers);
  if (select count(*) from public.expenses e where e.trip_id = p_trip_id) >= 2000 then
    raise exception 'too_many_expenses' using errcode = 'P0001';
  end if;

  -- 5. Write. A concurrent create of the same id elsewhere is the same "taken" answer.
  insert into public.expenses (id, trip_id, title, amount_minor, category_id, spent_on, notes, split_method, created_by)
  values (p_expense_id, p_trip_id, v_in.o_title, p_amount_minor, v_cat, p_spent_on, v_in.o_notes, 'equal', v_ctx.caller_member_id)
  on conflict (id) do nothing;
  if not found then
    raise exception 'expense_id_taken' using errcode = 'P0001';
  end if;
  insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor)
  select p_expense_id, p_trip_id, p.member_id, p.paid_minor from public.expense_parse_payers(p_payers) p;
  insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor)
  select p_expense_id, p_trip_id, a.member_id, a.share_minor from public.allocate_equal(p_amount_minor, p_participants) a;
  perform public.expense_record_revision(p_expense_id, 'create', v_ctx.caller_member_id);
  -- (Rule I-1 cannot be affected by a create: only ACTIVE members may be payers or participants.)

  return query select p_expense_id, 1, true;
end;
$$;

revoke all on function public.create_expense(uuid, uuid, text, bigint, date, text, text, text, uuid[], jsonb) from public, anon;
grant execute on function public.create_expense(uuid, uuid, text, bigint, date, text, text, text, uuid[], jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 10b. update_expense(): replaces an expense's details, payers and participants in one transaction.
--      An administrator may edit any expense; a member only their own.
-- ---------------------------------------------------------------------------
create or replace function public.update_expense(
  p_trip_id          uuid,
  p_expense_id       uuid,
  p_expected_version int,
  p_title            text,
  p_amount_minor     bigint,
  p_spent_on         date,
  p_category_key     text,
  p_notes            text,
  p_split_method     text,
  p_participants     uuid[],
  p_payers           jsonb
)
returns table (expense_id uuid, version int, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_ex      public.expenses;
  v_in      record;
  v_cat     uuid;
  v_key     text;
  v_new     jsonb;
  v_touched uuid[];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- 1. Trip first (caller checks, trip row locked, archived refused), then the expense row. Never the reverse.
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false);
  select e.* into v_ex from public.expenses e where e.id = p_expense_id and e.trip_id = p_trip_id for update;
  if not found then
    raise exception 'expense_not_found' using errcode = 'P0001';
  end if;
  if not (v_ctx.caller_role = 'admin' or v_ex.created_by = v_ctx.caller_member_id) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ex.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_ex.deleted_at is not null then
    raise exception 'expense_deleted' using errcode = 'P0001';
  end if;

  -- 2. Preflight: clear errors before anything is written.
  select * into v_in from public.expense_check_shape(p_title, p_amount_minor, p_spent_on, p_notes, p_split_method, p_participants, p_payers);
  v_cat := public.expense_check_state(p_trip_id, p_spent_on, p_category_key, p_participants, p_payers);
  v_key := case when v_cat is null then null else p_category_key end;
  v_new := public.expense_canonical(
    v_in.o_title, p_amount_minor, p_spent_on, v_key, v_in.o_notes, 'equal',
    public.expense_payers_json(p_payers), public.expense_splits_json(p_amount_minor, p_participants));

  -- 3. Nothing really changed: nothing is written, no version, no history.
  if public.expense_stored_canonical(v_ex.id) = v_new then
    return query select v_ex.id, v_ex.version, false;
    return;
  end if;

  -- 4. Replace everything, remember who was on the OLD rows (for rule I-1).
  select coalesce(array_agg(distinct m), '{}'::uuid[]) into v_touched
    from (select p.trip_member_id as m from public.expense_payers p where p.expense_id = v_ex.id
          union select s.trip_member_id from public.expense_splits s where s.expense_id = v_ex.id) x;
  delete from public.expense_payers where expense_id = v_ex.id;
  delete from public.expense_splits where expense_id = v_ex.id;
  insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor)
  select v_ex.id, p_trip_id, p.member_id, p.paid_minor from public.expense_parse_payers(p_payers) p;
  insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor)
  select v_ex.id, p_trip_id, a.member_id, a.share_minor from public.allocate_equal(p_amount_minor, p_participants) a;
  update public.expenses e
     set title = v_in.o_title, amount_minor = p_amount_minor, category_id = v_cat, spent_on = p_spent_on, notes = v_in.o_notes,
         updated_by = v_ctx.caller_member_id, version = e.version + 1
   where e.id = v_ex.id;
  perform public.expense_record_revision(v_ex.id, 'update', v_ctx.caller_member_id);

  -- 5. Rule I-1 over the COMPLETE resulting ledger. A refusal rolls back everything above.
  perform public.assert_former_members_settled(p_trip_id, v_touched);

  return query select v_ex.id, v_ex.version + 1, true;
end;
$$;

revoke all on function public.update_expense(uuid, uuid, int, text, bigint, date, text, text, text, uuid[], jsonb) from public, anon;
grant execute on function public.update_expense(uuid, uuid, int, text, bigint, date, text, text, text, uuid[], jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 10c. delete_expense(): soft delete. The row and its history stay; balances stop counting it.
-- ---------------------------------------------------------------------------
create or replace function public.delete_expense(p_trip_id uuid, p_expense_id uuid, p_expected_version int)
returns table (expense_id uuid, version int, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_ex      public.expenses;
  v_touched uuid[];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false);
  select e.* into v_ex from public.expenses e where e.id = p_expense_id and e.trip_id = p_trip_id for update;
  if not found then
    raise exception 'expense_not_found' using errcode = 'P0001';
  end if;
  if not (v_ctx.caller_role = 'admin' or v_ex.created_by = v_ctx.caller_member_id) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ex.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_ex.deleted_at is not null then
    return query select v_ex.id, v_ex.version, false; -- already deleted: safe to repeat
    return;
  end if;

  select coalesce(array_agg(distinct m), '{}'::uuid[]) into v_touched
    from (select p.trip_member_id as m from public.expense_payers p where p.expense_id = v_ex.id
          union select s.trip_member_id from public.expense_splits s where s.expense_id = v_ex.id) x;
  update public.expenses e
     set deleted_at = now(), deleted_by = v_ctx.caller_member_id, updated_by = v_ctx.caller_member_id, version = e.version + 1
   where e.id = v_ex.id;
  perform public.expense_record_revision(v_ex.id, 'delete', v_ctx.caller_member_id);
  perform public.assert_former_members_settled(p_trip_id, v_touched);

  return query select v_ex.id, v_ex.version + 1, true;
end;
$$;

revoke all on function public.delete_expense(uuid, uuid, int) from public, anon;
grant execute on function public.delete_expense(uuid, uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 10d. restore_expense(): undo a delete. The trip's CURRENT dates are re-checked, and rule I-1 applies.
-- ---------------------------------------------------------------------------
create or replace function public.restore_expense(p_trip_id uuid, p_expense_id uuid, p_expected_version int)
returns table (expense_id uuid, version int, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_ex      public.expenses;
  v_trip    public.trips;
  v_touched uuid[];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false);
  select e.* into v_ex from public.expenses e where e.id = p_expense_id and e.trip_id = p_trip_id for update;
  if not found then
    raise exception 'expense_not_found' using errcode = 'P0001';
  end if;
  if not (v_ctx.caller_role = 'admin' or v_ex.created_by = v_ctx.caller_member_id) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_expected_version is null or v_ex.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_ex.deleted_at is null then
    return query select v_ex.id, v_ex.version, false; -- not deleted: safe to repeat
    return;
  end if;

  select t.* into v_trip from public.trips t where t.id = p_trip_id;
  if v_ex.spent_on < v_trip.start_date or v_ex.spent_on > v_trip.end_date then
    raise exception 'outside_trip_dates' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct m), '{}'::uuid[]) into v_touched
    from (select p.trip_member_id as m from public.expense_payers p where p.expense_id = v_ex.id
          union select s.trip_member_id from public.expense_splits s where s.expense_id = v_ex.id) x;
  update public.expenses e
     set deleted_at = null, deleted_by = null, updated_by = v_ctx.caller_member_id, version = e.version + 1
   where e.id = v_ex.id;
  perform public.expense_record_revision(v_ex.id, 'restore', v_ctx.caller_member_id);
  perform public.assert_former_members_settled(p_trip_id, v_touched);

  return query select v_ex.id, v_ex.version + 1, true;
end;
$$;

revoke all on function public.restore_expense(uuid, uuid, int) from public, anon;
grant execute on function public.restore_expense(uuid, uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. trip_member_balances(): what every member of the trip paid, owes and nets, from the ledger (never stored).
--     The function itself checks the caller is an ACTIVE member of THIS trip; it never relies on row-level security.
--     Former members are included (their history still counts). Allowed on archived trips (read only).
-- ---------------------------------------------------------------------------
create or replace function public.trip_member_balances(p_trip_id uuid)
returns table (member_id uuid, paid_minor bigint, share_minor bigint, net_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if public.trip_role_of(p_trip_id, v_uid) is null then
    raise exception 'trip_not_found' using errcode = 'P0001';
  end if;
  return query
    select m.id,
           coalesce((select sum(p.paid_minor) from public.expense_payers p join public.expenses e on e.id = p.expense_id and e.trip_id = p.trip_id
                      where e.trip_id = p_trip_id and e.deleted_at is null and p.trip_member_id = m.id), 0)::bigint,
           coalesce((select sum(s.share_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id and e.trip_id = s.trip_id
                      where e.trip_id = p_trip_id and e.deleted_at is null and s.trip_member_id = m.id), 0)::bigint,
           public.member_net_minor(p_trip_id, m.id)
      from public.trip_members m
     where m.trip_id = p_trip_id
     order by m.id::text collate "C";
end;
$$;

revoke all on function public.trip_member_balances(uuid) from public, anon;
grant execute on function public.trip_member_balances(uuid) to authenticated;
