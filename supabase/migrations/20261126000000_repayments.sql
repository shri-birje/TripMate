-- =============================================================================
-- TripMate migration #12: repayments, reversals and the confirmed-repayment ledger (M7 Checkpoint 2).
-- Design: docs/M7_REPAYMENTS_DESIGN.md revision 4.2 and ADR-066 (approved).
--
-- Run this in the Supabase SQL Editor (safe to run again). It only ADDS: it does not change migrations #1 to #11
-- except by `create or replace` of ONE existing function (member_net_minor, same signature, same privileges) and by
-- dropping and recreating trip_member_balances (it gains two columns, so its return type changes).
--
-- WHAT IT BUILDS
--   Tables   repayments, repayment_reversals, repayment_events (append-only history; member ids only)
--   Rules    four states only (pending, confirmed, rejected, cancelled); only CONFIRMED repayments, minus any with an
--            APPLIED reversal, change official balances; pending repayments only RESERVE capacity (payer and receiver)
--   Money    net = expense_net + confirmed_sent - confirmed_received (M1 is not touched and is not used here)
--   People   strict guest-proxy rules R1 to R4b; nobody confirms their own payment; nobody records and decides the same
--            repayment; an admin never acts on both sides; reversal override needs a second independent admin
--   Override ONE executable category only: counterparty_unresponsive (14 days, two reminders). The category
--            counterparty_account_inaccessible is DEFERRED (V1) and deliberately absent from every constraint and function.
--   Guards   leaving or removal is refused while a pending repayment or an open reversal involves the member
--
-- LOCK ORDER (every money-changing function): the trip row first (member_change_context), then the repayment row,
-- then the reversal row. Guards and helpers only READ.
-- =============================================================================

do $$
begin
  if to_regclass('public.expenses') is null
     or to_regprocedure('public.member_net_minor(uuid, uuid)') is null
     or to_regprocedure('public.member_change_context(uuid, uuid, boolean, boolean)') is null
     or to_regprocedure('public.assert_former_members_settled(uuid, uuid[])') is null then
    raise exception 'The earlier migrations (trips, members, invitations, expenses) must be applied before this one.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.repayments (
  id             uuid primary key,
  trip_id        uuid not null references public.trips (id) on delete cascade,
  from_member_id uuid not null,
  to_member_id   uuid not null,
  amount_minor   bigint not null
                   constraint repayments_amount_range check (amount_minor between 1 and 1000000000000),
  method         text not null
                   constraint repayments_method_values check (method in ('upi', 'cash', 'bank', 'other')),
  note           text
                   constraint repayments_note_length check (note is null or char_length(note) between 1 and 200),
  status         text not null default 'pending'
                   constraint repayments_status_values check (status in ('pending', 'confirmed', 'rejected', 'cancelled')),
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text
                   constraint repayments_decision_note_length check (decision_note is null or char_length(decision_note) between 1 and 200),
  version        int not null default 1,
  constraint repayments_id_trip_unique unique (id, trip_id),
  constraint repayments_distinct_members check (from_member_id <> to_member_id),
  constraint repayments_decision_consistent check (
    (status = 'pending' and decided_by is null and decided_at is null and decision_note is null)
    or (status <> 'pending' and decided_by is not null and decided_at is not null)
  ),
  constraint repayments_from_fk foreign key (from_member_id, trip_id) references public.trip_members (id, trip_id),
  constraint repayments_to_fk foreign key (to_member_id, trip_id) references public.trip_members (id, trip_id),
  constraint repayments_creator_fk foreign key (created_by, trip_id) references public.trip_members (id, trip_id),
  constraint repayments_decider_fk foreign key (decided_by, trip_id) references public.trip_members (id, trip_id)
);

comment on table public.repayments is 'Recorded repayments between two members. Always created pending by the payer (or a guest proxy). Only confirmed ones change balances. Never edited or deleted once decided.';

create index if not exists repayments_trip_status_idx on public.repayments (trip_id, status);
create index if not exists repayments_trip_from_idx on public.repayments (trip_id, from_member_id);
create index if not exists repayments_trip_to_idx on public.repayments (trip_id, to_member_id);

create table if not exists public.repayment_reversals (
  id                    uuid primary key,
  trip_id               uuid not null,
  repayment_id          uuid not null,
  status                text not null default 'requested'
                          constraint repayment_reversals_status_values check (
                            status in ('requested', 'override_proposed', 'applied', 'declined', 'withdrawn', 'override_refused')),
  requested_by          uuid not null,
  requested_for         uuid not null,
  requested_at          timestamptz not null default now(),
  reason                text not null
                          constraint repayment_reversals_reason_length check (char_length(reason) between 1 and 200),
  override_proposed_by  uuid,
  -- V1: counterparty_unresponsive is the ONLY executable override category. counterparty_account_inaccessible is deferred
  -- and is deliberately not accepted here.
  override_category     text
                          constraint repayment_reversals_override_category check (override_category is null or override_category = 'counterparty_unresponsive'),
  override_reason       text
                          constraint repayment_reversals_override_reason_length check (override_reason is null or char_length(override_reason) between 20 and 200),
  override_proposed_at  timestamptz,
  decided_by            uuid,
  decided_at            timestamptz,
  decision_note         text
                          constraint repayment_reversals_decision_note_length check (decision_note is null or char_length(decision_note) between 1 and 200),
  is_override           boolean not null default false,
  version               int not null default 1,
  constraint repayment_reversals_id_trip_unique unique (id, trip_id),
  constraint repayment_reversals_override_fields check (
    num_nonnulls(override_proposed_by, override_category, override_reason, override_proposed_at) in (0, 4)),
  constraint repayment_reversals_status_fields check (
    (status = 'requested' and override_proposed_by is null and decided_by is null and decided_at is null and not is_override)
    or (status = 'override_proposed' and override_proposed_by is not null and decided_by is null and decided_at is null and not is_override)
    or (status in ('declined', 'withdrawn') and decided_by is not null and decided_at is not null and not is_override)
    or (status = 'override_refused' and override_proposed_by is not null and decided_by is not null and decided_at is not null and not is_override)
    or (status = 'applied' and decided_by is not null and decided_at is not null
        and (not is_override or override_proposed_by is not null))
  ),
  constraint repayment_reversals_repayment_fk foreign key (repayment_id, trip_id) references public.repayments (id, trip_id) on delete cascade,
  constraint repayment_reversals_requested_by_fk foreign key (requested_by, trip_id) references public.trip_members (id, trip_id),
  constraint repayment_reversals_requested_for_fk foreign key (requested_for, trip_id) references public.trip_members (id, trip_id),
  constraint repayment_reversals_proposer_fk foreign key (override_proposed_by, trip_id) references public.trip_members (id, trip_id),
  constraint repayment_reversals_decider_fk foreign key (decided_by, trip_id) references public.trip_members (id, trip_id)
);

comment on table public.repayment_reversals is 'Audited correction of a CONFIRMED repayment. The original repayment row is never changed; an applied reversal here stops it counting. requested_by is the authenticated actor, requested_for the represented party (one of the two parties), immutable.';

-- At most one OPEN request and at most one APPLIED reversal per repayment, ever.
create unique index if not exists repayment_reversals_one_open
  on public.repayment_reversals (repayment_id) where status in ('requested', 'override_proposed');
create unique index if not exists repayment_reversals_one_applied
  on public.repayment_reversals (repayment_id) where status = 'applied';
create index if not exists repayment_reversals_trip_idx on public.repayment_reversals (trip_id, status);

create table if not exists public.repayment_events (
  id                    bigint generated always as identity primary key,
  trip_id               uuid not null,
  repayment_id          uuid not null,
  reversal_id           uuid,
  action                text not null
                          constraint repayment_events_action_values check (action in (
                            'repayment.create', 'repayment.confirm', 'repayment.reject', 'repayment.cancel',
                            'reversal.request', 'reversal.remind', 'reversal.acknowledge', 'reversal.decline', 'reversal.withdraw',
                            'reversal.override_propose', 'reversal.override_approve', 'reversal.override_refuse', 'reversal.apply')),
  from_status           text,
  to_status             text,
  actor_member_id       uuid not null,
  represented_member_id uuid not null,
  reason                text
                          constraint repayment_events_reason_length check (reason is null or char_length(reason) between 1 and 200),
  acted_at              timestamptz not null default now(),
  constraint repayment_events_repayment_fk foreign key (repayment_id, trip_id) references public.repayments (id, trip_id) on delete cascade,
  constraint repayment_events_reversal_fk foreign key (reversal_id, trip_id) references public.repayment_reversals (id, trip_id) on delete cascade,
  constraint repayment_events_actor_fk foreign key (actor_member_id, trip_id) references public.trip_members (id, trip_id),
  constraint repayment_events_represented_fk foreign key (represented_member_id, trip_id) references public.trip_members (id, trip_id)
);

comment on table public.repayment_events is 'Append-only history of every repayment and reversal step. Member ids only (never names, user ids or e-mails): actor_member_id is the authenticated actor, represented_member_id the participant the action was made for.';

create index if not exists repayment_events_repayment_idx on public.repayment_events (repayment_id, id);
create index if not exists repayment_events_reversal_idx on public.repayment_events (reversal_id, action, acted_at);

-- ---------------------------------------------------------------------------
-- 2. Security: ACTIVE members of the trip may READ; nobody may write directly (D8).
-- ---------------------------------------------------------------------------
alter table public.repayments enable row level security;
alter table public.repayment_reversals enable row level security;
alter table public.repayment_events enable row level security;

drop policy if exists repayments_select_members on public.repayments;
create policy repayments_select_members on public.repayments for select to authenticated using (public.is_trip_member(trip_id));
drop policy if exists repayment_reversals_select_members on public.repayment_reversals;
create policy repayment_reversals_select_members on public.repayment_reversals for select to authenticated using (public.is_trip_member(trip_id));
drop policy if exists repayment_events_select_members on public.repayment_events;
create policy repayment_events_select_members on public.repayment_events for select to authenticated using (public.is_trip_member(trip_id));

revoke all on public.repayments, public.repayment_reversals, public.repayment_events from public, anon, authenticated;
grant select on public.repayments, public.repayment_reversals, public.repayment_events to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The balance: expense net (the M5 body, moved UNCHANGED) plus the confirmed-repayment adjustment.
-- ---------------------------------------------------------------------------
create or replace function public.member_expense_net_minor(p_trip_id uuid, p_member_id uuid)
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

revoke all on function public.member_expense_net_minor(uuid, uuid) from public, anon, authenticated;

-- confirmed_sent - confirmed_received over CONFIRMED repayments that have NO applied reversal.
create or replace function public.member_repayment_adjustment_minor(p_trip_id uuid, p_member_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (
    coalesce((select sum(r.amount_minor) from public.repayments r
               where r.trip_id = p_trip_id and r.status = 'confirmed' and r.from_member_id = p_member_id
                 and not exists (select 1 from public.repayment_reversals v where v.repayment_id = r.id and v.status = 'applied')), 0)
    -
    coalesce((select sum(r.amount_minor) from public.repayments r
               where r.trip_id = p_trip_id and r.status = 'confirmed' and r.to_member_id = p_member_id
                 and not exists (select 1 from public.repayment_reversals v where v.repayment_id = r.id and v.status = 'applied')), 0)
  )::bigint;
$$;

revoke all on function public.member_repayment_adjustment_minor(uuid, uuid) from public, anon, authenticated;

-- ONE existing function is replaced (same signature, same return type, same privileges): the single source of a member's net.
create or replace function public.member_net_minor(p_trip_id uuid, p_member_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (public.member_expense_net_minor(p_trip_id, p_member_id) + public.member_repayment_adjustment_minor(p_trip_id, p_member_id))::bigint;
$$;

revoke all on function public.member_net_minor(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Internal helpers (NONE can be run by the app).
-- ---------------------------------------------------------------------------
create or replace function public.member_is_active_admin(p_trip_id uuid, p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.trip_members m
                  where m.id = p_member_id and m.trip_id = p_trip_id and m.status = 'active' and m.role = 'admin' and m.user_id is not null);
$$;

revoke all on function public.member_is_active_admin(uuid, uuid) from public, anon, authenticated;

-- Capacity of a new repayment p -> q: the payer's debt not already reserved by ANY of their pending repayments (to anyone),
-- limited by the receiver's credit not already reserved by ANY pending repayment addressed to them (from anyone).
create or replace function public.repayment_capacity(p_trip_id uuid, p_from uuid, p_to uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, least(
    greatest(0, greatest(0, -public.member_net_minor(p_trip_id, p_from))
                - coalesce((select sum(r.amount_minor) from public.repayments r
                             where r.trip_id = p_trip_id and r.status = 'pending' and r.from_member_id = p_from), 0)),
    greatest(0, greatest(0, public.member_net_minor(p_trip_id, p_to))
                - coalesce((select sum(r.amount_minor) from public.repayments r
                             where r.trip_id = p_trip_id and r.status = 'pending' and r.to_member_id = p_to), 0))
  ))::bigint;
$$;

revoke all on function public.repayment_capacity(uuid, uuid, uuid) from public, anon, authenticated;

-- Participants of a repayment: payer, receiver, recorder, and every member who appears in its history in any role
-- (actor or represented participant). Computed from the events, so it cannot be manipulated.
create or replace function public.repayment_participants(p_repayment_id uuid)
returns table (member_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select r.from_member_id from public.repayments r where r.id = p_repayment_id
  union select r.to_member_id from public.repayments r where r.id = p_repayment_id
  union select r.created_by from public.repayments r where r.id = p_repayment_id
  union select e.actor_member_id from public.repayment_events e where e.repayment_id = p_repayment_id
  union select e.represented_member_id from public.repayment_events e where e.repayment_id = p_repayment_id
  union select v.requested_by from public.repayment_reversals v where v.repayment_id = p_repayment_id
  union select v.requested_for from public.repayment_reversals v where v.repayment_id = p_repayment_id;
$$;

revoke all on function public.repayment_participants(uuid) from public, anon, authenticated;

-- D5 / R2: who may confirm or reject a pending repayment. Returns NULL when allowed, else the error code.
create or replace function public.repayment_decide_problem(p_trip_id uuid, p_from uuid, p_to uuid, p_created_by uuid, p_caller uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_caller = p_from or p_caller = p_created_by then
    return 'party_cannot_act'; -- nobody decides a repayment they paid or recorded
  end if;
  if p_caller = p_to then
    return null; -- the receiver, acting personally
  end if;
  if exists (select 1 from public.trip_members m where m.id = p_to and m.trip_id = p_trip_id and m.user_id is null)
     and public.member_is_active_admin(p_trip_id, p_caller) then
    return null; -- R2: a guest receiver is represented by an admin who is neither the payer nor the recorder (checked above)
  end if;
  return 'not_allowed';
end;
$$;

revoke all on function public.repayment_decide_problem(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- D5 / R3: who may cancel a pending repayment.
create or replace function public.repayment_cancel_problem(p_trip_id uuid, p_from uuid, p_to uuid, p_created_by uuid, p_caller uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from_guest boolean := exists (select 1 from public.trip_members m where m.id = p_from and m.trip_id = p_trip_id and m.user_id is null);
  v_to_guest   boolean := exists (select 1 from public.trip_members m where m.id = p_to and m.trip_id = p_trip_id and m.user_id is null);
begin
  if p_caller = p_from or p_caller = p_created_by then
    return null; -- the payer (their own) or the recorder
  end if;
  if public.member_is_active_admin(p_trip_id, p_caller)
     and ((v_from_guest and p_caller <> p_to)
          or (v_to_guest and p_caller <> p_from and p_caller <> p_created_by)) then
    return null; -- R3: only for a repayment with a guest party, as an eligible proxy; never between two signed-in members
  end if;
  return 'not_allowed';
end;
$$;

revoke all on function public.repayment_cancel_problem(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- R4a: who may request a reversal (and remind and withdraw, through requested_by). requested_for is the represented party.
create or replace function public.reversal_request_problem(p_trip_id uuid, p_from uuid, p_to uuid, p_created_by uuid, p_caller uuid, p_for uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_for is distinct from p_from and p_for is distinct from p_to then
    return 'not_allowed'; -- requested_for must be one of the two parties, never a third member
  end if;
  if p_caller = p_for then
    return null; -- an ordinary party acting personally
  end if;
  if exists (select 1 from public.trip_members m where m.id = p_for and m.trip_id = p_trip_id and m.user_id is null)
     and public.member_is_active_admin(p_trip_id, p_caller)
     and p_caller <> p_from and p_caller <> p_to and p_caller <> p_created_by then
    return null; -- R4a: an admin who is not a party and not the recorder, for a guest party
  end if;
  return 'not_allowed';
end;
$$;

revoke all on function public.reversal_request_problem(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- R4b: who may acknowledge or decline a reversal request.
create or replace function public.reversal_respond_problem(p_trip_id uuid, p_from uuid, p_to uuid, p_created_by uuid, p_requested_by uuid, p_requested_for uuid, p_caller uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counterparty uuid := case when p_requested_for = p_from then p_to else p_from end;
begin
  if p_caller = p_requested_by then
    return 'party_cannot_act'; -- never the requester, nobody on the requesting side
  end if;
  if p_caller = v_counterparty then
    return null; -- the counterparty, acting personally
  end if;
  if exists (select 1 from public.trip_members m where m.id = v_counterparty and m.trip_id = p_trip_id and m.user_id is null)
     and public.member_is_active_admin(p_trip_id, p_caller)
     and p_caller <> p_from and p_caller <> p_to and p_caller <> p_created_by and p_caller <> p_requested_by then
    return null; -- R4b: an eligible admin for a guest counterparty (not a party, not the recorder, not the requester)
  end if;
  return 'not_allowed';
end;
$$;

revoke all on function public.reversal_respond_problem(uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- The override evidence, evaluated NOW from the database's own clock and events. NULL = fine; otherwise the error code.
-- counterparty_unresponsive: the counterparty has a linked account, 14 full days since the request, and two reminders
-- (the first on or after day 7, the second at least 24 hours after the first).
create or replace function public.repayment_override_problem(p_reversal_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rev          public.repayment_reversals;
  v_rep          public.repayments;
  v_counterparty uuid;
  v_first        timestamptz;
begin
  select * into v_rev from public.repayment_reversals v where v.id = p_reversal_id;
  if not found then
    return 'reversal_not_open';
  end if;
  select * into v_rep from public.repayments r where r.id = v_rev.repayment_id;
  v_counterparty := case when v_rev.requested_for = v_rep.from_member_id then v_rep.to_member_id else v_rep.from_member_id end;
  if exists (select 1 from public.trip_members m where m.id = v_counterparty and m.user_id is null) then
    return 'override_not_eligible'; -- no linked account: the guest-proxy route applies instead
  end if;
  if now() < v_rev.requested_at + interval '14 days' then
    return 'override_threshold_not_met';
  end if;
  select min(e.acted_at) into v_first
    from public.repayment_events e
   where e.reversal_id = p_reversal_id and e.action = 'reversal.remind'
     and e.acted_at >= v_rev.requested_at + interval '7 days' and e.acted_at <= now();
  if v_first is null
     or not exists (select 1 from public.repayment_events e
                     where e.reversal_id = p_reversal_id and e.action = 'reversal.remind'
                       and e.acted_at >= v_first + interval '24 hours' and e.acted_at <= now()) then
    return 'override_evidence_missing';
  end if;
  return null;
end;
$$;

revoke all on function public.repayment_override_problem(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Triggers: the independent second layer (they enforce the invariants even if a function is bypassed).
-- ---------------------------------------------------------------------------
create or replace function public.repayments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problem  text;
  v_capacity bigint;
  v_status   text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old; -- the automatic cascade when a whole trip is removed
    end if;
    raise exception 'repayments cannot be deleted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.version <> 1 then
      raise exception 'repayment_transition_invalid' using errcode = 'P0001';
    end if;
    select t.status into v_status from public.trips t where t.id = new.trip_id;
    if v_status = 'archived' then
      raise exception 'trip_archived' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.trip_members m
                where m.trip_id = new.trip_id and m.id in (new.from_member_id, new.to_member_id, new.created_by) and m.status <> 'active') then
      raise exception 'member_not_active' using errcode = 'P0001';
    end if;
    -- R1: the recorder is the payer, or an admin for a guest payer who is not the receiver.
    if new.created_by <> new.from_member_id then
      if not (exists (select 1 from public.trip_members m where m.id = new.from_member_id and m.user_id is null)
              and public.member_is_active_admin(new.trip_id, new.created_by)
              and new.created_by <> new.to_member_id) then
        raise exception 'not_allowed' using errcode = 'P0001';
      end if;
    end if;
    v_capacity := public.repayment_capacity(new.trip_id, new.from_member_id, new.to_member_id);
    if new.amount_minor > v_capacity then
      raise exception 'repayment_exceeds_outstanding' using errcode = 'P0001', detail = 'max_minor=' || v_capacity::text;
    end if;
    new.created_at := now(); -- the database's clock, never the caller's
    return new;
  end if;

  -- UPDATE: only pending -> confirmed | rejected | cancelled, once, with nothing else changed.
  if old.status <> 'pending' then
    raise exception 'repayment_transition_invalid' using errcode = 'P0001';
  end if;
  if new.status not in ('confirmed', 'rejected', 'cancelled')
     or new.id <> old.id or new.trip_id <> old.trip_id or new.from_member_id <> old.from_member_id
     or new.to_member_id <> old.to_member_id or new.amount_minor <> old.amount_minor or new.method <> old.method
     or new.note is distinct from old.note or new.created_by <> old.created_by or new.created_at <> old.created_at
     or new.version <> old.version + 1 then
    raise exception 'repayment_transition_invalid' using errcode = 'P0001';
  end if;

  if new.status in ('confirmed', 'rejected') then
    v_problem := public.repayment_decide_problem(old.trip_id, old.from_member_id, old.to_member_id, old.created_by, new.decided_by);
  else
    v_problem := public.repayment_cancel_problem(old.trip_id, old.from_member_id, old.to_member_id, old.created_by, new.decided_by);
  end if;
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;

  if new.status = 'confirmed' then
    if exists (select 1 from public.trip_members m
                where m.trip_id = old.trip_id and m.id in (old.from_member_id, old.to_member_id) and m.status <> 'active') then
      raise exception 'member_not_active' using errcode = 'P0001';
    end if;
    -- Revalidation against the REAL confirmed balances now (this row is still pending, so it is not in them yet).
    if new.amount_minor > greatest(0, -public.member_net_minor(old.trip_id, old.from_member_id))
       or new.amount_minor > greatest(0, public.member_net_minor(old.trip_id, old.to_member_id)) then
      raise exception 'repayment_exceeds_outstanding' using errcode = 'P0001',
        detail = 'max_minor=' || least(greatest(0, -public.member_net_minor(old.trip_id, old.from_member_id)),
                                         greatest(0, public.member_net_minor(old.trip_id, old.to_member_id)))::text;
    end if;
  end if;
  new.decided_at := now();
  return new;
end;
$$;

revoke all on function public.repayments_guard() from public, anon, authenticated;

drop trigger if exists repayments_zz_guard on public.repayments;
create trigger repayments_zz_guard
  before insert or update or delete on public.repayments
  for each row execute function public.repayments_guard();

create or replace function public.repayment_reversals_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rep       public.repayments;
  v_problem   text;
  v_status    text;
  v_counter   uuid;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'repayment_reversals cannot be deleted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select * into v_rep from public.repayments r where r.id = new.repayment_id and r.trip_id = new.trip_id;
    if not found or v_rep.status <> 'confirmed' then
      raise exception 'repayment_not_confirmed' using errcode = 'P0001';
    end if;
    if new.status <> 'requested' or new.version <> 1 or new.is_override then
      raise exception 'reversal_transition_invalid' using errcode = 'P0001';
    end if;
    select t.status into v_status from public.trips t where t.id = new.trip_id;
    if v_status = 'archived' then
      raise exception 'trip_archived' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.repayment_reversals v where v.repayment_id = new.repayment_id and v.status = 'applied') then
      raise exception 'reversal_already_applied' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.repayment_reversals v where v.repayment_id = new.repayment_id and v.status in ('requested', 'override_proposed')) then
      raise exception 'reversal_already_open' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.trip_members m where m.trip_id = new.trip_id and m.id in (new.requested_by, new.requested_for) and m.status <> 'active') then
      raise exception 'member_not_active' using errcode = 'P0001';
    end if;
    v_problem := public.reversal_request_problem(new.trip_id, v_rep.from_member_id, v_rep.to_member_id, v_rep.created_by, new.requested_by, new.requested_for);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
    new.requested_at := now();
    return new;
  end if;

  -- UPDATE
  if old.status not in ('requested', 'override_proposed') then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if new.id <> old.id or new.trip_id <> old.trip_id or new.repayment_id <> old.repayment_id
     or new.requested_by <> old.requested_by or new.requested_for <> old.requested_for
     or new.requested_at <> old.requested_at or new.reason <> old.reason
     or new.version <> old.version + 1 then
    raise exception 'reversal_transition_invalid' using errcode = 'P0001'; -- requested_for in particular can never change
  end if;
  select * into v_rep from public.repayments r where r.id = old.repayment_id;
  v_counter := case when old.requested_for = v_rep.from_member_id then v_rep.to_member_id else v_rep.from_member_id end;

  if new.status = 'override_proposed' then
    if old.status <> 'requested' then
      raise exception 'reversal_transition_invalid' using errcode = 'P0001';
    end if;
    if not public.member_is_active_admin(old.trip_id, new.override_proposed_by)
       or exists (select 1 from public.repayment_participants(old.repayment_id) p where p.member_id = new.override_proposed_by) then
      raise exception 'party_cannot_act' using errcode = 'P0001'; -- an admin who took part may never override
    end if;
    v_problem := public.repayment_override_problem(old.id);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
    new.override_proposed_at := now();
  elsif new.status in ('applied', 'declined') and not new.is_override then
    -- acknowledgement or decline: the counterparty, or an R4b proxy for a guest counterparty
    v_problem := public.reversal_respond_problem(old.trip_id, v_rep.from_member_id, v_rep.to_member_id, v_rep.created_by, old.requested_by, old.requested_for, new.decided_by);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
    new.decided_at := now();
  elsif new.status = 'withdrawn' then
    if new.decided_by <> old.requested_by then
      raise exception 'not_allowed' using errcode = 'P0001';
    end if;
    new.decided_at := now();
  elsif new.status in ('applied', 'override_refused') then
    -- override approval or refusal: a SECOND independent admin, never the proposer, never a participant
    if old.status <> 'override_proposed' or (new.status = 'applied' and not new.is_override) then
      raise exception 'reversal_transition_invalid' using errcode = 'P0001';
    end if;
    if new.decided_by = old.override_proposed_by then
      raise exception 'override_proposer_cannot_approve' using errcode = 'P0001';
    end if;
    if not public.member_is_active_admin(old.trip_id, new.decided_by) then
      raise exception 'not_admin' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.repayment_participants(old.repayment_id) p where p.member_id = new.decided_by) then
      raise exception 'party_cannot_act' using errcode = 'P0001';
    end if;
    if new.status = 'applied' then
      v_problem := public.repayment_override_problem(old.id); -- evaluated AGAIN at approval
      if v_problem is not null then
        raise exception '%', v_problem using errcode = 'P0001';
      end if;
    end if;
    new.decided_at := now();
  else
    raise exception 'reversal_transition_invalid' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.repayment_reversals_guard() from public, anon, authenticated;

drop trigger if exists repayment_reversals_zz_guard on public.repayment_reversals;
create trigger repayment_reversals_zz_guard
  before insert or update or delete on public.repayment_reversals
  for each row execute function public.repayment_reversals_guard();

-- Rule I-1 after the fact: once a reversal is applied (or a repayment is confirmed), every FORMER member of that repayment must
-- still net to exactly zero; otherwise the whole transaction rolls back.
create or replace function public.repayments_i1_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from uuid;
  v_to   uuid;
  v_trip uuid;
begin
  if tg_table_name = 'repayments' then
    v_from := new.from_member_id; v_to := new.to_member_id; v_trip := new.trip_id;
  else
    select r.from_member_id, r.to_member_id, r.trip_id into v_from, v_to, v_trip from public.repayments r where r.id = new.repayment_id;
  end if;
  perform public.assert_former_members_settled(v_trip, array[v_from, v_to]);
  return new;
end;
$$;

revoke all on function public.repayments_i1_after() from public, anon, authenticated;

drop trigger if exists repayments_zz_i1 on public.repayments;
create trigger repayments_zz_i1
  after update on public.repayments
  for each row when (new.status = 'confirmed' and old.status = 'pending')
  execute function public.repayments_i1_after();

drop trigger if exists repayment_reversals_zz_i1 on public.repayment_reversals;
create trigger repayment_reversals_zz_i1
  after update on public.repayment_reversals
  for each row when (new.status = 'applied' and old.status <> 'applied')
  execute function public.repayments_i1_after();

-- The audit table is append-only; the actor and the represented participant must be consistent.
create or replace function public.repayment_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old; -- the automatic cascade when a repayment or a whole trip is removed
  end if;
  raise exception 'repayment_events is append-only' using errcode = '42501';
end;
$$;

revoke all on function public.repayment_events_append_only() from public, anon, authenticated;

drop trigger if exists repayment_events_no_change on public.repayment_events;
create trigger repayment_events_no_change
  before update or delete on public.repayment_events
  for each row execute function public.repayment_events_append_only();

drop trigger if exists repayment_events_no_truncate on public.repayment_events;
create trigger repayment_events_no_truncate
  before truncate on public.repayment_events
  for each statement execute function public.repayment_events_append_only();

create or replace function public.repayment_events_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An ordinary person acts personally; only an admin may act for someone else, and only for a guest.
  if new.actor_member_id <> new.represented_member_id then
    if not (exists (select 1 from public.trip_members m where m.id = new.represented_member_id and m.trip_id = new.trip_id and m.user_id is null)
            and public.member_is_active_admin(new.trip_id, new.actor_member_id)) then
      raise exception 'not_allowed' using errcode = 'P0001';
    end if;
  end if;
  new.acted_at := now(); -- the database's clock, never the caller's
  return new;
end;
$$;

revoke all on function public.repayment_events_check() from public, anon, authenticated;

drop trigger if exists repayment_events_zz_check on public.repayment_events;
create trigger repayment_events_zz_check
  before insert on public.repayment_events
  for each row execute function public.repayment_events_check();

-- D5: leaving or removal is refused while a pending repayment or an open reversal involves the member. It watches every
-- active -> not-active change of a member (whatever function or path makes it) and only READS. It sorts BEFORE the ADR-047
-- balance guard so that the clearer reason is reported first.
create or replace function public.trip_members_repayment_pending_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.repayments r
              where r.trip_id = new.trip_id and r.status = 'pending' and new.id in (r.from_member_id, r.to_member_id))
     or exists (select 1 from public.repayment_reversals v
                  join public.repayments r on r.id = v.repayment_id
                 where v.trip_id = new.trip_id and v.status in ('requested', 'override_proposed') and new.id in (r.from_member_id, r.to_member_id)) then
    raise exception 'repayment_pending' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.trip_members_repayment_pending_guard() from public, anon, authenticated;

drop trigger if exists trip_members_a_repayment_pending_guard on public.trip_members;
create trigger trip_members_a_repayment_pending_guard
  before update of status on public.trip_members
  for each row
  when (old.status = 'active' and new.status <> 'active')
  execute function public.trip_members_repayment_pending_guard();

-- ---------------------------------------------------------------------------
-- 6. The ten callable functions. Order of locks: trip row, repayment row, reversal row.
-- ---------------------------------------------------------------------------

-- 6.1 create_repayment: the payer (or an R1 proxy for a guest payer) records a repayment. Always created pending.
create or replace function public.create_repayment(
  p_trip_id        uuid,
  p_repayment_id   uuid,
  p_from_member_id uuid,
  p_to_member_id   uuid,
  p_amount_minor   bigint,
  p_method         text,
  p_note           text default null
)
returns table (repayment_id uuid, version int, status text, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid      uuid := (select auth.uid());
  v_ctx      record;
  v_existing public.repayments;
  v_from     public.trip_members;
  v_to       public.trip_members;
  v_note     text;
  v_capacity bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false); -- trip lock; archived refused

  -- A retry: look the id up WITHOUT a lock first, and lock only a row of THIS trip (the trip row is already locked).
  select * into v_existing from public.repayments r where r.id = p_repayment_id;
  if found and v_existing.trip_id = p_trip_id then
    select * into v_existing from public.repayments r where r.id = p_repayment_id and r.trip_id = p_trip_id for update;
  end if;
  if found then
    if v_existing.trip_id = p_trip_id and v_existing.from_member_id = p_from_member_id and v_existing.to_member_id = p_to_member_id
       and v_existing.amount_minor = p_amount_minor and v_existing.method = p_method
       and v_existing.note is not distinct from nullif(btrim(coalesce(p_note, '')), '')
       and v_existing.created_by = v_ctx.caller_member_id then
      return query select v_existing.id, v_existing.version, v_existing.status, false; -- a retry: the same repayment, whatever its status now is
      return;
    end if;
    raise exception 'repayment_id_taken' using errcode = 'P0001';
  end if;

  if p_from_member_id is null or p_to_member_id is null or p_from_member_id = p_to_member_id
     or p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 1000000000000
     or p_method is null or p_method not in ('upi', 'cash', 'bank', 'other') then
    raise exception 'invalid_repayment' using errcode = 'P0001';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'invalid_repayment' using errcode = 'P0001';
  end if;

  select * into v_from from public.trip_members m where m.id = p_from_member_id and m.trip_id = p_trip_id;
  if not found or v_from.status <> 'active' then
    raise exception 'member_not_active' using errcode = 'P0001';
  end if;
  select * into v_to from public.trip_members m where m.id = p_to_member_id and m.trip_id = p_trip_id;
  if not found or v_to.status <> 'active' then
    raise exception 'member_not_active' using errcode = 'P0001';
  end if;

  -- R1: the payer themselves, or an admin for a guest payer who is not the receiver.
  if p_from_member_id <> v_ctx.caller_member_id then
    if not (v_from.user_id is null and v_ctx.caller_role = 'admin' and v_ctx.caller_member_id <> p_to_member_id) then
      raise exception 'not_allowed' using errcode = 'P0001';
    end if;
  end if;

  v_capacity := public.repayment_capacity(p_trip_id, p_from_member_id, p_to_member_id);
  if p_amount_minor > v_capacity then
    raise exception 'repayment_exceeds_outstanding' using errcode = 'P0001', detail = 'max_minor=' || v_capacity::text;
  end if;

  insert into public.repayments (id, trip_id, from_member_id, to_member_id, amount_minor, method, note, created_by)
  values (p_repayment_id, p_trip_id, p_from_member_id, p_to_member_id, p_amount_minor, p_method, v_note, v_ctx.caller_member_id);
  insert into public.repayment_events (trip_id, repayment_id, action, from_status, to_status, actor_member_id, represented_member_id)
  values (p_trip_id, p_repayment_id, 'repayment.create', null, 'pending', v_ctx.caller_member_id, p_from_member_id);

  return query select p_repayment_id, 1, 'pending'::text, true;
end;
$$;

revoke all on function public.create_repayment(uuid, uuid, uuid, uuid, bigint, text, text) from public, anon;
grant execute on function public.create_repayment(uuid, uuid, uuid, uuid, bigint, text, text) to authenticated;

-- 6.2 confirm_repayment: the receiver (or an R2 proxy for a guest receiver). Revalidates against the real balances now.
create or replace function public.confirm_repayment(p_trip_id uuid, p_repayment_id uuid, p_expected_version int)
returns table (repayment_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_r       public.repayments;
  v_problem text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true); -- trip lock; allowed on archived trips (D4)

  select * into v_r from public.repayments r where r.id = p_repayment_id and r.trip_id = p_trip_id for update;
  if not found then
    raise exception 'repayment_not_found' using errcode = 'P0001';
  end if;
  if v_r.status = 'confirmed' and v_r.decided_by = v_ctx.caller_member_id and v_r.version = p_expected_version + 1 then
    return query select v_r.id, v_r.version, v_r.status, false; -- a safe repeat of the same confirmation
    return;
  end if;
  if v_r.status <> 'pending' then
    raise exception 'repayment_not_pending' using errcode = 'P0001';
  end if;
  if v_r.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  v_problem := public.repayment_decide_problem(p_trip_id, v_r.from_member_id, v_r.to_member_id, v_r.created_by, v_ctx.caller_member_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;
  if v_r.amount_minor > greatest(0, -public.member_net_minor(p_trip_id, v_r.from_member_id))
     or v_r.amount_minor > greatest(0, public.member_net_minor(p_trip_id, v_r.to_member_id)) then
    raise exception 'repayment_exceeds_outstanding' using errcode = 'P0001',
      detail = 'max_minor=' || least(greatest(0, -public.member_net_minor(p_trip_id, v_r.from_member_id)),
                                       greatest(0, public.member_net_minor(p_trip_id, v_r.to_member_id)))::text;
  end if;

  update public.repayments r
     set status = 'confirmed', decided_by = v_ctx.caller_member_id, decided_at = now(), version = r.version + 1
   where r.id = p_repayment_id;
  insert into public.repayment_events (trip_id, repayment_id, action, from_status, to_status, actor_member_id, represented_member_id)
  values (p_trip_id, p_repayment_id, 'repayment.confirm', 'pending', 'confirmed', v_ctx.caller_member_id, v_r.to_member_id);

  return query select p_repayment_id, v_r.version + 1, 'confirmed'::text, true;
end;
$$;

revoke all on function public.confirm_repayment(uuid, uuid, int) from public, anon;
grant execute on function public.confirm_repayment(uuid, uuid, int) to authenticated;

-- 6.3 reject_repayment: the receiver (or an R2 proxy). Releases the reservation.
create or replace function public.reject_repayment(p_trip_id uuid, p_repayment_id uuid, p_expected_version int, p_reason text default null)
returns table (repayment_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_r       public.repayments;
  v_problem text;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true);

  select * into v_r from public.repayments r where r.id = p_repayment_id and r.trip_id = p_trip_id for update;
  if not found then
    raise exception 'repayment_not_found' using errcode = 'P0001';
  end if;
  if v_r.status = 'rejected' and v_r.decided_by = v_ctx.caller_member_id and v_r.version = p_expected_version + 1 then
    return query select v_r.id, v_r.version, v_r.status, false;
    return;
  end if;
  if v_r.status <> 'pending' then
    raise exception 'repayment_not_pending' using errcode = 'P0001';
  end if;
  if v_r.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'invalid_repayment' using errcode = 'P0001';
  end if;
  v_problem := public.repayment_decide_problem(p_trip_id, v_r.from_member_id, v_r.to_member_id, v_r.created_by, v_ctx.caller_member_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;

  update public.repayments r
     set status = 'rejected', decided_by = v_ctx.caller_member_id, decided_at = now(), decision_note = v_reason, version = r.version + 1
   where r.id = p_repayment_id;
  insert into public.repayment_events (trip_id, repayment_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
  values (p_trip_id, p_repayment_id, 'repayment.reject', 'pending', 'rejected', v_ctx.caller_member_id, v_r.to_member_id, v_reason);

  return query select p_repayment_id, v_r.version + 1, 'rejected'::text, true;
end;
$$;

revoke all on function public.reject_repayment(uuid, uuid, int, text) from public, anon;
grant execute on function public.reject_repayment(uuid, uuid, int, text) to authenticated;

-- 6.4 cancel_repayment: the payer (own), the recorder, or an R3 admin for a repayment with a guest party. Releases the reservation.
create or replace function public.cancel_repayment(p_trip_id uuid, p_repayment_id uuid, p_expected_version int)
returns table (repayment_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid         uuid := (select auth.uid());
  v_ctx         record;
  v_r           public.repayments;
  v_problem     text;
  v_represented uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true);

  select * into v_r from public.repayments r where r.id = p_repayment_id and r.trip_id = p_trip_id for update;
  if not found then
    raise exception 'repayment_not_found' using errcode = 'P0001';
  end if;
  if v_r.status = 'cancelled' and v_r.decided_by = v_ctx.caller_member_id and v_r.version = p_expected_version + 1 then
    return query select v_r.id, v_r.version, v_r.status, false;
    return;
  end if;
  if v_r.status <> 'pending' then
    raise exception 'repayment_not_pending' using errcode = 'P0001';
  end if;
  if v_r.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  v_problem := public.repayment_cancel_problem(p_trip_id, v_r.from_member_id, v_r.to_member_id, v_r.created_by, v_ctx.caller_member_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;
  -- the party the actor stands for: the payer for the payer and the recorder; otherwise the guest the admin represents
  v_represented := case
    when v_ctx.caller_member_id = v_r.from_member_id or v_ctx.caller_member_id = v_r.created_by then v_r.from_member_id
    when exists (select 1 from public.trip_members m where m.id = v_r.from_member_id and m.user_id is null) and v_ctx.caller_member_id <> v_r.to_member_id then v_r.from_member_id
    else v_r.to_member_id end;

  update public.repayments r
     set status = 'cancelled', decided_by = v_ctx.caller_member_id, decided_at = now(), version = r.version + 1
   where r.id = p_repayment_id;
  insert into public.repayment_events (trip_id, repayment_id, action, from_status, to_status, actor_member_id, represented_member_id)
  values (p_trip_id, p_repayment_id, 'repayment.cancel', 'pending', 'cancelled', v_ctx.caller_member_id, v_represented);

  return query select p_repayment_id, v_r.version + 1, 'cancelled'::text, true;
end;
$$;

revoke all on function public.cancel_repayment(uuid, uuid, int) from public, anon;
grant execute on function public.cancel_repayment(uuid, uuid, int) to authenticated;

-- 6.5 request_reversal: a party (or an R4a proxy for a guest party) asks to reverse a CONFIRMED repayment.
create or replace function public.request_reversal(
  p_trip_id       uuid,
  p_reversal_id   uuid,
  p_repayment_id  uuid,
  p_reason        text,
  p_requested_for uuid default null
)
returns table (reversal_id uuid, version int, status text, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_r       public.repayments;
  v_v       public.repayment_reversals;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_for     uuid;
  v_problem text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false); -- trip lock; archived refused
  v_for := coalesce(p_requested_for, v_ctx.caller_member_id);

  select * into v_r from public.repayments r where r.id = p_repayment_id and r.trip_id = p_trip_id for update;
  if not found then
    raise exception 'repayment_not_found' using errcode = 'P0001';
  end if;

  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id;
  if found and v_v.trip_id = p_trip_id then
    select * into v_v from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id for update;
  end if;
  if found then
    if v_v.repayment_id = p_repayment_id and v_v.trip_id = p_trip_id and v_v.requested_by = v_ctx.caller_member_id
       and v_v.requested_for = v_for and v_v.reason = v_reason then
      return query select v_v.id, v_v.version, v_v.status, false;
      return;
    end if;
    raise exception 'reversal_id_taken' using errcode = 'P0001';
  end if;

  if char_length(v_reason) not between 1 and 200 then
    raise exception 'reversal_reason_required' using errcode = 'P0001';
  end if;
  if v_r.status <> 'confirmed' then
    raise exception 'repayment_not_confirmed' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repayment_reversals x where x.repayment_id = p_repayment_id and x.status = 'applied') then
    raise exception 'reversal_already_applied' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repayment_reversals x where x.repayment_id = p_repayment_id and x.status in ('requested', 'override_proposed')) then
    raise exception 'reversal_already_open' using errcode = 'P0001';
  end if;
  v_problem := public.reversal_request_problem(p_trip_id, v_r.from_member_id, v_r.to_member_id, v_r.created_by, v_ctx.caller_member_id, v_for);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;

  insert into public.repayment_reversals (id, trip_id, repayment_id, requested_by, requested_for, reason)
  values (p_reversal_id, p_trip_id, p_repayment_id, v_ctx.caller_member_id, v_for, v_reason);
  insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
  values (p_trip_id, p_repayment_id, p_reversal_id, 'reversal.request', null, 'requested', v_ctx.caller_member_id, v_for, v_reason);

  return query select p_reversal_id, 1, 'requested'::text, true;
end;
$$;

revoke all on function public.request_reversal(uuid, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.request_reversal(uuid, uuid, uuid, text, uuid) to authenticated;

-- 6.6 respond_reversal: the counterparty (or an R4b proxy for a guest counterparty) acknowledges or declines.
create or replace function public.respond_reversal(p_trip_id uuid, p_reversal_id uuid, p_expected_version int, p_decision text, p_note text default null)
returns table (reversal_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_rid     uuid;
  v_r       public.repayments;
  v_v       public.repayment_reversals;
  v_problem text;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_counter uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true); -- trip lock; resolving is allowed on archived trips (D4)
  if p_decision is null or p_decision not in ('acknowledge', 'decline') or (v_note is not null and char_length(v_note) > 200) then
    raise exception 'invalid_repayment' using errcode = 'P0001';
  end if;

  select x.repayment_id into v_rid from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id;
  if not found then
    raise exception 'reversal_not_found' using errcode = 'P0001';
  end if;
  select * into v_r from public.repayments r where r.id = v_rid for update;
  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id for update;

  if ((v_v.status = 'applied' and not v_v.is_override and p_decision = 'acknowledge') or (v_v.status = 'declined' and p_decision = 'decline'))
     and v_v.decided_by = v_ctx.caller_member_id and v_v.version = p_expected_version + 1 then
    return query select v_v.id, v_v.version, v_v.status, false; -- a safe repeat
    return;
  end if;
  if v_v.status not in ('requested', 'override_proposed') then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if v_v.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  v_problem := public.reversal_respond_problem(p_trip_id, v_r.from_member_id, v_r.to_member_id, v_r.created_by, v_v.requested_by, v_v.requested_for, v_ctx.caller_member_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;
  v_counter := case when v_v.requested_for = v_r.from_member_id then v_r.to_member_id else v_r.from_member_id end;

  if p_decision = 'acknowledge' then
    update public.repayment_reversals x
       set status = 'applied', is_override = false, decided_by = v_ctx.caller_member_id, decided_at = now(),
           decision_note = v_note, version = x.version + 1
     where x.id = p_reversal_id;
    insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
    values (p_trip_id, v_rid, p_reversal_id, 'reversal.acknowledge', v_v.status, 'applied', v_ctx.caller_member_id, v_counter, v_note),
           (p_trip_id, v_rid, p_reversal_id, 'reversal.apply', 'applied', 'applied', v_ctx.caller_member_id, v_counter, null);
    perform public.assert_former_members_settled(p_trip_id, array[v_r.from_member_id, v_r.to_member_id]); -- Rule I-1
    return query select p_reversal_id, v_v.version + 1, 'applied'::text, true;
  else
    update public.repayment_reversals x
       set status = 'declined', decided_by = v_ctx.caller_member_id, decided_at = now(), decision_note = v_note, version = x.version + 1
     where x.id = p_reversal_id;
    insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
    values (p_trip_id, v_rid, p_reversal_id, 'reversal.decline', v_v.status, 'declined', v_ctx.caller_member_id, v_counter, v_note);
    return query select p_reversal_id, v_v.version + 1, 'declined'::text, true;
  end if;
end;
$$;

revoke all on function public.respond_reversal(uuid, uuid, int, text, text) from public, anon;
grant execute on function public.respond_reversal(uuid, uuid, int, text, text) to authenticated;

-- 6.7 withdraw_reversal: the requester only, from requested or override_proposed.
create or replace function public.withdraw_reversal(p_trip_id uuid, p_reversal_id uuid, p_expected_version int)
returns table (reversal_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_ctx record;
  v_rid uuid;
  v_v   public.repayment_reversals;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, true);

  select x.repayment_id into v_rid from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id;
  if not found then
    raise exception 'reversal_not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.repayments r where r.id = v_rid for update;
  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id for update;

  if v_v.status = 'withdrawn' and v_v.decided_by = v_ctx.caller_member_id and v_v.version = p_expected_version + 1 then
    return query select v_v.id, v_v.version, v_v.status, false;
    return;
  end if;
  if v_v.status not in ('requested', 'override_proposed') then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if v_v.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_v.requested_by <> v_ctx.caller_member_id then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;

  update public.repayment_reversals x
     set status = 'withdrawn', decided_by = v_ctx.caller_member_id, decided_at = now(), version = x.version + 1
   where x.id = p_reversal_id;
  insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id)
  values (p_trip_id, v_rid, p_reversal_id, 'reversal.withdraw', v_v.status, 'withdrawn', v_ctx.caller_member_id, v_v.requested_for);

  return query select p_reversal_id, v_v.version + 1, 'withdrawn'::text, true;
end;
$$;

revoke all on function public.withdraw_reversal(uuid, uuid, int) from public, anon;
grant execute on function public.withdraw_reversal(uuid, uuid, int) to authenticated;

-- 6.8 remind_reversal: the requester (including an R4a proxy who made the request) records a reminder. No state change.
create or replace function public.remind_reversal(p_trip_id uuid, p_reversal_id uuid)
returns table (reversal_id uuid, version int, status text, reminded_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_ctx record;
  v_rid uuid;
  v_v   public.repayment_reversals;
  v_at  timestamptz := now();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, false, false); -- trip lock; archived refused

  select x.repayment_id into v_rid from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id;
  if not found then
    raise exception 'reversal_not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.repayments r where r.id = v_rid for update;
  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id for update;

  if v_v.status <> 'requested' then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if v_v.requested_by <> v_ctx.caller_member_id then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if v_v.requested_by <> v_v.requested_for and v_ctx.caller_role <> 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001'; -- a proxy must still be an admin
  end if;
  if exists (select 1 from public.repayment_events e
              where e.reversal_id = p_reversal_id and e.action = 'reversal.remind' and e.acted_at > v_at - interval '24 hours') then
    raise exception 'reminder_too_soon' using errcode = 'P0001';
  end if;

  insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id)
  values (p_trip_id, v_rid, p_reversal_id, 'reversal.remind', 'requested', 'requested', v_ctx.caller_member_id, v_v.requested_for);

  return query select p_reversal_id, v_v.version, v_v.status, v_at;
end;
$$;

revoke all on function public.remind_reversal(uuid, uuid) from public, anon;
grant execute on function public.remind_reversal(uuid, uuid) to authenticated;

-- 6.9 propose_override: an admin who took no part proposes the override. ONLY counterparty_unresponsive is executable.
create or replace function public.propose_override(p_trip_id uuid, p_reversal_id uuid, p_expected_version int, p_category text, p_reason text)
returns table (reversal_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_rid     uuid;
  v_v       public.repayment_reversals;
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_problem text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, false); -- an admin; trip lock; archived refused
  if p_category is distinct from 'counterparty_unresponsive' then
    raise exception 'override_not_eligible' using errcode = 'P0001'; -- the only executable category (V1)
  end if;

  select x.repayment_id into v_rid from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id;
  if not found then
    raise exception 'reversal_not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.repayments r where r.id = v_rid for update;
  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id for update;

  if v_v.status <> 'requested' then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if v_v.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 20 and 200 then
    raise exception 'reversal_reason_required' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.repayment_participants(v_rid) p where p.member_id = v_ctx.caller_member_id) then
    raise exception 'party_cannot_act' using errcode = 'P0001'; -- an admin who took part may never override
  end if;
  v_problem := public.repayment_override_problem(p_reversal_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'P0001';
  end if;

  update public.repayment_reversals x
     set status = 'override_proposed', override_proposed_by = v_ctx.caller_member_id, override_category = p_category,
         override_reason = v_reason, override_proposed_at = now(), version = x.version + 1
   where x.id = p_reversal_id;
  insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
  values (p_trip_id, v_rid, p_reversal_id, 'reversal.override_propose', 'requested', 'override_proposed', v_ctx.caller_member_id, v_ctx.caller_member_id, v_reason);

  return query select p_reversal_id, v_v.version + 1, 'override_proposed'::text, true;
end;
$$;

revoke all on function public.propose_override(uuid, uuid, int, text, text) from public, anon;
grant execute on function public.propose_override(uuid, uuid, int, text, text) to authenticated;

-- 6.10 decide_override: a SECOND independent admin approves or refuses. Evidence is evaluated again now.
create or replace function public.decide_override(p_trip_id uuid, p_reversal_id uuid, p_expected_version int, p_decision text, p_note text default null)
returns table (reversal_id uuid, version int, status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_ctx     record;
  v_rid     uuid;
  v_r       public.repayments;
  v_v       public.repayment_reversals;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_problem text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select * into v_ctx from public.member_change_context(p_trip_id, v_uid, true, true); -- an admin; trip lock; resolving allowed on archived trips
  if p_decision is null or p_decision not in ('approve', 'refuse') or (v_note is not null and char_length(v_note) > 200) then
    raise exception 'invalid_repayment' using errcode = 'P0001';
  end if;

  select x.repayment_id into v_rid from public.repayment_reversals x where x.id = p_reversal_id and x.trip_id = p_trip_id;
  if not found then
    raise exception 'reversal_not_found' using errcode = 'P0001';
  end if;
  select * into v_r from public.repayments r where r.id = v_rid for update;
  select * into v_v from public.repayment_reversals x where x.id = p_reversal_id for update;

  if ((v_v.status = 'applied' and v_v.is_override and p_decision = 'approve') or (v_v.status = 'override_refused' and p_decision = 'refuse'))
     and v_v.decided_by = v_ctx.caller_member_id and v_v.version = p_expected_version + 1 then
    return query select v_v.id, v_v.version, v_v.status, false;
    return;
  end if;
  if v_v.status <> 'override_proposed' then
    raise exception 'reversal_not_open' using errcode = 'P0001';
  end if;
  if v_v.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;
  if v_ctx.caller_member_id = v_v.override_proposed_by then
    raise exception 'override_proposer_cannot_approve' using errcode = 'P0001'; -- one admin never approves their own proposal
  end if;
  if exists (select 1 from public.repayment_participants(v_rid) p where p.member_id = v_ctx.caller_member_id) then
    raise exception 'party_cannot_act' using errcode = 'P0001';
  end if;

  if p_decision = 'approve' then
    v_problem := public.repayment_override_problem(p_reversal_id); -- the category and evidence, re-evaluated NOW
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
    update public.repayment_reversals x
       set status = 'applied', is_override = true, decided_by = v_ctx.caller_member_id, decided_at = now(),
           decision_note = v_note, version = x.version + 1
     where x.id = p_reversal_id;
    insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
    values (p_trip_id, v_rid, p_reversal_id, 'reversal.override_approve', 'override_proposed', 'applied', v_ctx.caller_member_id, v_ctx.caller_member_id, v_note),
           (p_trip_id, v_rid, p_reversal_id, 'reversal.apply', 'applied', 'applied', v_ctx.caller_member_id, v_ctx.caller_member_id, null);
    perform public.assert_former_members_settled(p_trip_id, array[v_r.from_member_id, v_r.to_member_id]); -- Rule I-1
    return query select p_reversal_id, v_v.version + 1, 'applied'::text, true;
  else
    update public.repayment_reversals x
       set status = 'override_refused', decided_by = v_ctx.caller_member_id, decided_at = now(), decision_note = v_note, version = x.version + 1
     where x.id = p_reversal_id;
    insert into public.repayment_events (trip_id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason)
    values (p_trip_id, v_rid, p_reversal_id, 'reversal.override_refuse', 'override_proposed', 'override_refused', v_ctx.caller_member_id, v_ctx.caller_member_id, v_note);
    return query select p_reversal_id, v_v.version + 1, 'override_refused'::text, true;
  end if;
end;
$$;

revoke all on function public.decide_override(uuid, uuid, int, text, text) from public, anon;
grant execute on function public.decide_override(uuid, uuid, int, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. trip_member_balances: recreated with sent_minor and received_minor (the return type changes, so it is dropped first).
--    Same caller checks (active members only), same grants. net_minor now includes confirmed, unreversed repayments.
-- ---------------------------------------------------------------------------
drop function if exists public.trip_member_balances(uuid);

create function public.trip_member_balances(p_trip_id uuid)
returns table (member_id uuid, paid_minor bigint, share_minor bigint, sent_minor bigint, received_minor bigint, net_minor bigint)
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
           coalesce((select sum(r.amount_minor) from public.repayments r
                      where r.trip_id = p_trip_id and r.status = 'confirmed' and r.from_member_id = m.id
                        and not exists (select 1 from public.repayment_reversals v where v.repayment_id = r.id and v.status = 'applied')), 0)::bigint,
           coalesce((select sum(r.amount_minor) from public.repayments r
                      where r.trip_id = p_trip_id and r.status = 'confirmed' and r.to_member_id = m.id
                        and not exists (select 1 from public.repayment_reversals v where v.repayment_id = r.id and v.status = 'applied')), 0)::bigint,
           public.member_net_minor(p_trip_id, m.id)
      from public.trip_members m
     where m.trip_id = p_trip_id
     order by m.id::text collate "C";
end;
$$;

revoke all on function public.trip_member_balances(uuid) from public, anon;
grant execute on function public.trip_member_balances(uuid) to authenticated;
