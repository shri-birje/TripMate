-- ============================================================================
-- TripMate migration 20261125000000: exact, percentage and shares splits (M5, Checkpoint 5, ADR-063)
--
-- Migrations 1 to 10 are applied and NOT changed. This file adds three more ways to split an expense next to "equal":
--
--   exact       each person's amount is typed; the amounts must add up to the total (a person may owe zero)
--   percentage  each person's percentage (whole basis points, 100% = 10000) is typed; they must add up to exactly 100%
--   shares      each person's weight (a whole number, for example 2 : 1 : 1) is typed
--
-- THE DATABASE DERIVES THE SHARES (ADR-063). The app sends only the method and each person's typed value, never a share.
-- Percentage and shares use the SAME approved largest-remainder rule as the TypeScript engine (packages/core allocateByWeights):
--   share_i = floor(total * weight_i / sum(weights)); the leftover paise (total minus what was handed out) go one each to the
--   people with the largest remainder (total * weight_i mod sum(weights)); equal remainders go to the lowest member id, compared
--   as plain text ("C" collation). Equal split is the same rule with every weight 1 (the tests prove it). Percentages use their
--   basis points as weights. Exact amounts are used as typed. The tests compare SQL and TypeScript on hand-verified vectors and on
--   thousands of random cases.
--
-- LIMITS (input limits, not rounding rules): a percentage is 1 to 10000 basis points per person; a shares weight is 1 to
-- 1000000; an exact amount is 0 to 10^12 paise. (The TypeScript engine itself accepts any positive whole weight.)
--
-- WHAT STAYS THE SAME: who may do what, the trip lock then the expense lock, optimistic versions, idempotent create (now also
-- comparing the method and every typed value), former-member rule I-1, ADR-043 and ADR-047, history, and the equal split.
-- A call that sends no inputs and the method "equal" behaves exactly as before.
--
-- FUNCTION SIGNATURES: create_expense and update_expense gain ONE trailing parameter, p_split_inputs jsonb DEFAULT NULL. The two
-- old signatures are dropped (a call with the old arguments still works through the new default). The grants are as before.
--
-- FINAL ENFORCEMENT: a deferred trigger checks, when a change is saved, that the stored shares of every non-equal expense are
-- exactly what the database derives from the stored inputs, whatever path wrote them (the equal-split trigger of migration
-- 20261124000000 keeps covering "equal").
--
-- Safe to run more than once. REQUIRES: migrations 1 to 10.
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.allocate_equal(bigint, uuid[])') is null
     or to_regprocedure('public.expense_rows_member_guard()') is null then
    raise exception 'The expense migrations (20261123200000, 20261124000000) must be applied before this one.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The table accepts the four methods, and a stored typed value is a whole, non-negative number.
-- ---------------------------------------------------------------------------
alter table public.expenses drop constraint if exists expenses_split_method_equal_only;
alter table public.expenses drop constraint if exists expenses_split_method_values;
alter table public.expenses
  add constraint expenses_split_method_values check (split_method in ('equal', 'exact', 'percentage', 'shares'));

alter table public.expense_splits drop constraint if exists expense_splits_input_value_range;
alter table public.expense_splits
  add constraint expense_splits_input_value_range
  check (input_value is null or (input_value >= 0 and input_value = trunc(input_value) and input_value <= 1000000000000));

-- ---------------------------------------------------------------------------
-- 2. Largest-remainder allocation by weights (the SQL twin of allocateByWeights). Internal.
-- ---------------------------------------------------------------------------
create or replace function public.allocate_weighted(p_total bigint, p_member_ids uuid[], p_weights bigint[])
returns table (member_id uuid, share_minor bigint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n        int := coalesce(cardinality(p_member_ids), 0);
  v_sum      numeric;
  v_leftover numeric;
begin
  if p_total is null or p_total < 0 or v_n = 0 or cardinality(p_weights) is distinct from v_n then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_member_ids) x where x is null)
     or (select count(distinct x) from unnest(p_member_ids) x) <> v_n then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_weights) w where w is null or w <= 0) then
    raise exception 'invalid_split_value' using errcode = 'P0001';
  end if;
  select sum(w)::numeric into v_sum from unnest(p_weights) w;
  select p_total::numeric - sum(div(p_total::numeric * w, v_sum)) into v_leftover from unnest(p_weights) w;
  return query
    with r as (
      select u.id,
             div(p_total::numeric * u.w, v_sum) as base,
             mod(p_total::numeric * u.w, v_sum) as rem
        from unnest(p_member_ids, p_weights) as u(id, w)
    ), ranked as (
      select r.id, r.base, row_number() over (order by r.rem desc, r.id::text collate "C") as rn from r
    )
    select ranked.id, (ranked.base + case when ranked.rn <= v_leftover then 1 else 0 end)::bigint
      from ranked
     order by ranked.id::text collate "C";
end;
$$;

revoke all on function public.allocate_weighted(bigint, uuid[], bigint[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The typed values, strictly shaped: [{"member_id": "...", "value": 1234}, ...]. For "equal" there are none.
--    The people listed must be exactly the participants.
-- ---------------------------------------------------------------------------
create or replace function public.expense_parse_split_inputs(p_method text, p_participants uuid[], p_inputs jsonb)
returns table (member_id uuid, value bigint)
language plpgsql
immutable
set search_path = ''
as $$
declare
  e     jsonb;
  v_id  uuid;
  v_ids uuid[] := '{}';
begin
  if p_method = 'equal' then
    if p_inputs is not null and p_inputs <> 'null'::jsonb then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    return query select u.id, null::bigint from unnest(p_participants) as u(id);
    return;
  end if;
  if p_inputs is null or jsonb_typeof(p_inputs) <> 'array' then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_inputs) < 1 or jsonb_array_length(p_inputs) > 50 then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
  for e in select x.value from jsonb_array_elements(p_inputs) as x loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if (select count(*) from jsonb_object_keys(e)) <> 2 or not (e ? 'member_id') or not (e ? 'value') then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if jsonb_typeof(e -> 'member_id') <> 'string' or (e ->> 'member_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    if jsonb_typeof(e -> 'value') <> 'number' or (e ->> 'value') !~ '^(0|[1-9][0-9]{0,12})$' then
      raise exception 'invalid_split_value' using errcode = 'P0001';
    end if;
    v_id := (e ->> 'member_id')::uuid;
    if v_id = any(v_ids) or not (v_id = any(p_participants)) then
      raise exception 'invalid_expense' using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_id;
    member_id := v_id;
    value := (e ->> 'value')::bigint;
    return next;
  end loop;
  if cardinality(v_ids) <> cardinality(p_participants) then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.expense_parse_split_inputs(text, uuid[], jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The shares of one expense, derived from the method and the typed values. Internal.
--    split_total_mismatch: exact amounts do not add up to the total, or percentages do not add up to 100%.
--    invalid_split_value:  a typed value is outside its allowed range.
-- ---------------------------------------------------------------------------
create or replace function public.expense_derive_shares(p_method text, p_total bigint, p_ids uuid[], p_values bigint[])
returns table (member_id uuid, share_minor bigint, input_value bigint)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_method = 'equal' then
    return query select a.member_id, a.share_minor, null::bigint from public.allocate_equal(p_total, p_ids) a;
  elsif p_method = 'exact' then
    if exists (select 1 from unnest(p_values) v where v is null or v < 0 or v > 1000000000000) then
      raise exception 'invalid_split_value' using errcode = 'P0001';
    end if;
    if (select coalesce(sum(v), 0) from unnest(p_values) v) <> p_total then
      raise exception 'split_total_mismatch' using errcode = 'P0001';
    end if;
    return query select u.id, u.v, u.v from unnest(p_ids, p_values) as u(id, v) order by u.id::text collate "C";
  elsif p_method = 'percentage' then
    if exists (select 1 from unnest(p_values) v where v is null or v < 1 or v > 10000) then
      raise exception 'invalid_split_value' using errcode = 'P0001';
    end if;
    if (select coalesce(sum(v), 0) from unnest(p_values) v) <> 10000 then
      raise exception 'split_total_mismatch' using errcode = 'P0001';
    end if;
    return query
      select a.member_id, a.share_minor, u.v
        from public.allocate_weighted(p_total, p_ids, p_values) a
        join unnest(p_ids, p_values) as u(id, v) on u.id = a.member_id
       order by a.member_id::text collate "C";
  elsif p_method = 'shares' then
    if exists (select 1 from unnest(p_values) v where v is null or v < 1 or v > 1000000) then
      raise exception 'invalid_split_value' using errcode = 'P0001';
    end if;
    return query
      select a.member_id, a.share_minor, u.v
        from public.allocate_weighted(p_total, p_ids, p_values) a
        join unnest(p_ids, p_values) as u(id, v) on u.id = a.member_id
       order by a.member_id::text collate "C";
  else
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.expense_derive_shares(text, bigint, uuid[], bigint[]) from public, anon, authenticated;

-- The request's participants and typed values, parsed and turned into shares (one step). Internal.
create or replace function public.expense_derive_from_request(p_method text, p_total bigint, p_participants uuid[], p_inputs jsonb)
returns table (member_id uuid, share_minor bigint, input_value bigint)
language sql
immutable
set search_path = ''
as $$
  with parsed as (select r.member_id, r.value from public.expense_parse_split_inputs(p_method, p_participants, p_inputs) r)
  select d.member_id, d.share_minor, d.input_value
    from public.expense_derive_shares(
           p_method, p_total,
           (select array_agg(p.member_id order by p.member_id::text collate "C") from parsed p),
           (select array_agg(p.value order by p.member_id::text collate "C") from parsed p)) d;
$$;

revoke all on function public.expense_derive_from_request(text, bigint, uuid[], jsonb) from public, anon, authenticated;

-- The shares in the canonical form used for retries and history: member id and share, plus the typed value when there is one.
create or replace function public.expense_splits_json_v2(p_method text, p_total bigint, p_participants uuid[], p_inputs jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object('member_id', d.member_id, 'share_minor', d.share_minor)
             || case when d.input_value is null then '{}'::jsonb else jsonb_build_object('input_value', d.input_value) end
           order by d.member_id::text collate "C"), '[]'::jsonb)
    from public.expense_derive_from_request(p_method, p_total, p_participants, p_inputs) d;
$$;

revoke all on function public.expense_splits_json_v2(text, bigint, uuid[], jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The stored form now carries the typed values too (so a retry and a history entry see them). For "equal" nothing changes.
-- ---------------------------------------------------------------------------
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
    coalesce((select jsonb_agg(
                jsonb_build_object('member_id', s.trip_member_id, 'share_minor', s.share_minor)
                  || case when s.input_value is null then '{}'::jsonb else jsonb_build_object('input_value', s.input_value::bigint) end
                order by s.trip_member_id::text collate "C")
                from public.expense_splits s where s.expense_id = e.id), '[]'::jsonb))
    from public.expenses e
    left join public.categories c on c.id = e.category_id
   where e.id = p_expense_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. Input checks, now with the method and the typed values (same checks as before for "equal").
-- ---------------------------------------------------------------------------
create or replace function public.expense_check_shape(
  p_title text, p_amount_minor bigint, p_spent_on date, p_notes text, p_split_method text, p_participants uuid[], p_payers jsonb, p_split_inputs jsonb,
  out o_title text, out o_notes text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n    int;
  v_paid bigint;
  v_ids  uuid[];
  v_vals bigint[];
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
  if p_split_method is null or p_split_method not in ('equal', 'exact', 'percentage', 'shares') then
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
  -- the typed split values: strictly shaped, in range, adding up; this derives the shares once, only to refuse a bad split early
  perform 1 from public.expense_derive_from_request(p_split_method, p_amount_minor, p_participants, p_split_inputs) limit 1;
end;
$$;

revoke all on function public.expense_check_shape(text, bigint, date, text, text, uuid[], jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. create_expense(): as before, with the method and typed values. Idempotent: the same id with the same COMPLETE content
--    (now including the method and every typed value) changes nothing.
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
  p_payers         jsonb,
  p_split_inputs   jsonb default null
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
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false);
  if p_expense_id is null then
    raise exception 'invalid_expense' using errcode = 'P0001';
  end if;

  select * into v_in from public.expense_check_shape(p_title, p_amount_minor, p_spent_on, p_notes, p_split_method, p_participants, p_payers, p_split_inputs);
  v_request := public.expense_canonical(
    v_in.o_title, p_amount_minor, p_spent_on, p_category_key, v_in.o_notes, p_split_method,
    public.expense_payers_json(p_payers), public.expense_splits_json_v2(p_split_method, p_amount_minor, p_participants, p_split_inputs));

  select e.* into v_ex from public.expenses e where e.id = p_expense_id;
  if found then
    if v_ex.trip_id = p_trip_id and v_ex.created_by = v_ctx.caller_member_id and v_ex.deleted_at is null
       and public.expense_stored_canonical(v_ex.id) = v_request then
      return query select v_ex.id, v_ex.version, false;
      return;
    end if;
    raise exception 'expense_id_taken' using errcode = 'P0001';
  end if;

  v_cat := public.expense_check_state(p_trip_id, p_spent_on, p_category_key, p_participants, p_payers);
  if (select count(*) from public.expenses e where e.trip_id = p_trip_id) >= 2000 then
    raise exception 'too_many_expenses' using errcode = 'P0001';
  end if;

  insert into public.expenses (id, trip_id, title, amount_minor, category_id, spent_on, notes, split_method, created_by)
  values (p_expense_id, p_trip_id, v_in.o_title, p_amount_minor, v_cat, p_spent_on, v_in.o_notes, p_split_method, v_ctx.caller_member_id)
  on conflict (id) do nothing;
  if not found then
    raise exception 'expense_id_taken' using errcode = 'P0001';
  end if;
  insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor)
  select p_expense_id, p_trip_id, p.member_id, p.paid_minor from public.expense_parse_payers(p_payers) p;
  insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor, input_value)
  select p_expense_id, p_trip_id, d.member_id, d.share_minor, d.input_value
    from public.expense_derive_from_request(p_split_method, p_amount_minor, p_participants, p_split_inputs) d;
  perform public.expense_record_revision(p_expense_id, 'create', v_ctx.caller_member_id);

  return query select p_expense_id, 1, true;
end;
$$;

revoke all on function public.create_expense(uuid, uuid, text, bigint, date, text, text, text, uuid[], jsonb, jsonb) from public, anon;
grant execute on function public.create_expense(uuid, uuid, text, bigint, date, text, text, text, uuid[], jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. update_expense(): as before; the method may change (equal to percentage, and so on) and everything is replaced together.
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
  p_payers           jsonb,
  p_split_inputs     jsonb default null
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

  select * into v_in from public.expense_check_shape(p_title, p_amount_minor, p_spent_on, p_notes, p_split_method, p_participants, p_payers, p_split_inputs);
  v_cat := public.expense_check_state(p_trip_id, p_spent_on, p_category_key, p_participants, p_payers);
  v_key := case when v_cat is null then null else p_category_key end;
  v_new := public.expense_canonical(
    v_in.o_title, p_amount_minor, p_spent_on, v_key, v_in.o_notes, p_split_method,
    public.expense_payers_json(p_payers), public.expense_splits_json_v2(p_split_method, p_amount_minor, p_participants, p_split_inputs));

  if public.expense_stored_canonical(v_ex.id) = v_new then
    return query select v_ex.id, v_ex.version, false;
    return;
  end if;

  select coalesce(array_agg(distinct m), '{}'::uuid[]) into v_touched
    from (select p.trip_member_id as m from public.expense_payers p where p.expense_id = v_ex.id
          union select s.trip_member_id from public.expense_splits s where s.expense_id = v_ex.id) x;
  delete from public.expense_payers where expense_id = v_ex.id;
  delete from public.expense_splits where expense_id = v_ex.id;
  insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor)
  select v_ex.id, p_trip_id, p.member_id, p.paid_minor from public.expense_parse_payers(p_payers) p;
  insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor, input_value)
  select v_ex.id, p_trip_id, d.member_id, d.share_minor, d.input_value
    from public.expense_derive_from_request(p_split_method, p_amount_minor, p_participants, p_split_inputs) d;
  update public.expenses e
     set title = v_in.o_title, amount_minor = p_amount_minor, category_id = v_cat, spent_on = p_spent_on, notes = v_in.o_notes,
         split_method = p_split_method, updated_by = v_ctx.caller_member_id, version = e.version + 1
   where e.id = v_ex.id;
  perform public.expense_record_revision(v_ex.id, 'update', v_ctx.caller_member_id);

  perform public.assert_former_members_settled(p_trip_id, v_touched);

  return query select v_ex.id, v_ex.version + 1, true;
end;
$$;

revoke all on function public.update_expense(uuid, uuid, int, text, bigint, date, text, text, text, uuid[], jsonb, jsonb) from public, anon;
grant execute on function public.update_expense(uuid, uuid, int, text, bigint, date, text, text, text, uuid[], jsonb, jsonb) to authenticated;

-- The old signatures are replaced by the ones above (a call with the old arguments still works through the new default).
drop function if exists public.create_expense(uuid, uuid, text, bigint, date, text, text, text, uuid[], jsonb);
drop function if exists public.update_expense(uuid, uuid, int, text, bigint, date, text, text, text, uuid[], jsonb);
drop function if exists public.expense_check_shape(text, bigint, date, text, text, uuid[], jsonb);

-- ---------------------------------------------------------------------------
-- 9. Final enforcement for the new methods: when a change is saved, the stored shares are exactly what the database derives
--    from the stored typed values. (Equal is covered by check_expense_equal_split; here an equal expense must hold no typed values.)
-- ---------------------------------------------------------------------------
create or replace function public.check_expense_split_inputs()
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
  v_vals   bigint[];
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
  select array_agg(s.trip_member_id order by s.trip_member_id::text collate "C"),
         array_agg(s.input_value::bigint order by s.trip_member_id::text collate "C")
    into v_ids, v_vals
    from public.expense_splits s where s.expense_id = v_id;
  if v_ids is null then
    return null; -- no shares at all is reported by the sums check
  end if;
  if v_method = 'equal' then
    if exists (select 1 from unnest(v_vals) v where v is not null) then
      raise exception 'shares_not_equal_split' using errcode = 'P0001';
    end if;
    return null;
  end if;
  if exists (select 1 from unnest(v_vals) v where v is null) then
    raise exception 'invalid_split_value' using errcode = 'P0001';
  end if;
  if exists (
    select 1
      from public.expense_derive_shares(v_method, v_amount, v_ids, v_vals) d
      full join (select x.trip_member_id, x.share_minor from public.expense_splits x where x.expense_id = v_id) s on s.trip_member_id = d.member_id
     where d.member_id is null or s.trip_member_id is null or d.share_minor <> s.share_minor
  ) then
    raise exception 'split_not_derived' using errcode = 'P0001';
  end if;
  return null;
end;
$$;

revoke all on function public.check_expense_split_inputs() from public, anon, authenticated;

drop trigger if exists expenses_zz_split_inputs_check on public.expenses;
create constraint trigger expenses_zz_split_inputs_check
  after insert or update of amount_minor, split_method on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_split_inputs();

drop trigger if exists expense_splits_zz_split_inputs_check on public.expense_splits;
create constraint trigger expense_splits_zz_split_inputs_check
  after insert or update or delete on public.expense_splits
  deferrable initially deferred
  for each row execute function public.check_expense_split_inputs();
