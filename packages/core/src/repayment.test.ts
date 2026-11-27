import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balanceLineFromRow } from './expense';
import {
  OVERRIDE_CATEGORY,
  REPAYMENT_AMOUNT_MAX,
  REPAYMENT_EVENT_ACTIONS,
  cancelRepaymentRpcArgs,
  checkRepaymentInput,
  cleanNote,
  confirmRepaymentRpcArgs,
  counterpartyOf,
  createRepaymentRpcArgs,
  decideOverrideRpcArgs,
  eventActors,
  newRepaymentId,
  newReversalId,
  proposeOverrideRpcArgs,
  rejectRepaymentRpcArgs,
  remindReversalRpcArgs,
  repaymentEventFromRow,
  repaymentFromRow,
  repaymentEventsFromRows,
  repaymentsFromRows,
  requestReversalRpcArgs,
  respondReversalRpcArgs,
  reversalFromRow,
  reversalsFromRows,
  withdrawReversalRpcArgs,
} from './repayment';

const T = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const R = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const V = '11111111-2222-4333-8444-555555555555';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const G = '00000000-0000-4000-8000-0000000000c3';

const row = (over: Record<string, unknown> = {}) => ({
  id: R, trip_id: T, from_member_id: A, to_member_id: B, amount_minor: 30000, method: 'cash', note: null, status: 'pending', created_by: A,
  created_at: '2026-11-26T10:00:00Z', decided_by: null, decided_at: null, decision_note: null, version: 1, ...over,
});
const reversalRow = (over: Record<string, unknown> = {}) => ({
  id: V, trip_id: T, repayment_id: R, status: 'requested', requested_by: B, requested_for: B, requested_at: '2026-11-26T11:00:00Z', reason: 'wrong amount',
  override_proposed_by: null, override_category: null, override_reason: null, override_proposed_at: null, decided_by: null, decided_at: null, decision_note: null,
  is_override: false, version: 1, ...over,
});
const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 1, repayment_id: R, reversal_id: null, action: 'repayment.create', from_status: null, to_status: 'pending', actor_member_id: A, represented_member_id: A, reason: null,
  acted_at: '2026-11-26T10:00:00Z', ...over,
});

describe('reading repayments strictly', () => {
  it('a pending row becomes a domain repayment', () => {
    expect(repaymentFromRow(row())).toEqual({
      id: R, tripId: T, fromMemberId: A, toMemberId: B, amountMinor: 30000, method: 'cash', note: null, status: 'pending', createdBy: A, createdAt: '2026-11-26T10:00:00Z',
      decidedBy: null, decidedAt: null, decisionNote: null, version: 1,
    });
  });

  it('a decided row keeps the authenticated actor who decided it', () => {
    const r = repaymentFromRow(row({ status: 'confirmed', decided_by: B, decided_at: '2026-11-26T12:00:00Z', version: 2 }))!;
    expect(r).toMatchObject({ status: 'confirmed', decidedBy: B, version: 2 });
  });

  it('refuses anything the table could never hold: unknown or old states, bad amounts, bad methods, inconsistent decisions', () => {
    expect(repaymentFromRow(row({ status: 'paid' }))).toBeNull(); // the superseded state
    for (const amount_minor of [0, -1, 1.5, REPAYMENT_AMOUNT_MAX + 1, '5', null, Number.NaN]) expect(repaymentFromRow(row({ amount_minor })), String(amount_minor)).toBeNull();
    expect(repaymentFromRow(row({ method: 'paypal' }))).toBeNull();
    expect(repaymentFromRow(row({ to_member_id: A }))).toBeNull(); // to oneself
    expect(repaymentFromRow(row({ version: 0 }))).toBeNull();
    expect(repaymentFromRow(row({ status: 'confirmed' }))).toBeNull(); // decided without a decider
    expect(repaymentFromRow(row({ decided_by: B, decided_at: '2026-11-26T12:00:00Z' }))).toBeNull(); // pending but decided
    expect(repaymentFromRow(row({ id: '' }))).toBeNull();
    expect(repaymentFromRow(null)).toBeNull();
    expect(repaymentFromRow('x')).toBeNull();
    expect(repaymentFromRow([])).toBeNull();
  });

  it('a list is returned whole or not at all', () => {
    expect(repaymentsFromRows([row(), row({ id: V })])).toHaveLength(2);
    expect(repaymentsFromRows([row(), row({ status: 'paid' })])).toBeNull();
    expect(repaymentsFromRows([])).toEqual([]);
  });
});

describe('reading reversals and events', () => {
  it('a request keeps the actor and the represented participant apart', () => {
    const personally = reversalFromRow(reversalRow())!;
    expect(personally.requestedBy).toBe(B);
    expect(personally.requestedFor).toBe(B);
    const proxy = reversalFromRow(reversalRow({ requested_by: A, requested_for: G }))!; // an admin acting for a guest
    expect(proxy.requestedBy).toBe(A);
    expect(proxy.requestedFor).toBe(G);
  });

  it('an override keeps its category, and only counterparty_unresponsive can exist', () => {
    const o = reversalFromRow(reversalRow({ status: 'override_proposed', override_proposed_by: A, override_category: OVERRIDE_CATEGORY, override_reason: 'x'.repeat(20), override_proposed_at: '2026-12-10T00:00:00Z', version: 2 }))!;
    expect(o.overrideCategory).toBe('counterparty_unresponsive');
    expect(reversalFromRow(reversalRow({ override_category: 'counterparty_account_inaccessible' }))).toBeNull(); // deferred: cannot exist
    expect(reversalFromRow(reversalRow({ override_category: 'anything' }))).toBeNull();
  });

  it('refuses unknown states and malformed rows', () => {
    expect(reversalFromRow(reversalRow({ status: 'open' }))).toBeNull();
    expect(reversalFromRow(reversalRow({ is_override: 'no' }))).toBeNull();
    expect(reversalFromRow(reversalRow({ reason: '' }))).toBeNull();
    expect(reversalFromRow(reversalRow({ version: 0 }))).toBeNull();
    expect(reversalFromRow(null)).toBeNull();
    expect(reversalsFromRows([reversalRow(), reversalRow({ status: 'open' })])).toBeNull();
    expect(reversalsFromRows([reversalRow({ id: V }), reversalRow({ id: R })])).toHaveLength(2);
  });

  it('every event action in the database is known, with the actor and the represented participant both kept', () => {
    expect(REPAYMENT_EVENT_ACTIONS).toHaveLength(13);
    const e = repaymentEventFromRow(eventRow({ action: 'reversal.request', actor_member_id: A, represented_member_id: G, reversal_id: V }))!;
    expect(e).toMatchObject({ actorMemberId: A, representedMemberId: G, reversalId: V });
    expect(eventActors(e)).toEqual({ actorMemberId: A, representedMemberId: G, isProxy: true });
    expect(eventActors(repaymentEventFromRow(eventRow())!)).toEqual({ actorMemberId: A, representedMemberId: A, isProxy: false });
    expect(repaymentEventFromRow(eventRow({ action: 'repayment.refund' }))).toBeNull();
    expect(repaymentEventFromRow(eventRow({ id: 1.5 }))).toBeNull();
    expect(repaymentEventFromRow(eventRow({ actor_member_id: '' }))).toBeNull();
    expect(repaymentEventsFromRows([eventRow(), eventRow({ action: 'nope' })])).toBeNull();
    for (const action of REPAYMENT_EVENT_ACTIONS) expect(repaymentEventFromRow(eventRow({ action }))).not.toBeNull();
  });

  it('counterpartyOf is derived, never supplied, and refuses a third member', () => {
    const r = { fromMemberId: A, toMemberId: B };
    expect(counterpartyOf(r, A)).toBe(B);
    expect(counterpartyOf(r, B)).toBe(A);
    expect(counterpartyOf(r, G)).toBeNull();
  });
});

describe('early friendly checks (the database checks again)', () => {
  const good = { amountMinor: 100, method: 'cash', note: 'dinner', fromMemberId: A, toMemberId: B };
  it('accepts a good request and refuses what the database would', () => {
    expect(checkRepaymentInput(good)).toBeNull();
    expect(checkRepaymentInput({ ...good, note: undefined })).toBeNull();
    expect(checkRepaymentInput({ ...good, amountMinor: 0 })).toMatch(/greater than zero/);
    expect(checkRepaymentInput({ ...good, amountMinor: -3 })).toMatch(/greater than zero/);
    expect(checkRepaymentInput({ ...good, amountMinor: 1.5 })).toMatch(/greater than zero/);
    expect(checkRepaymentInput({ ...good, amountMinor: REPAYMENT_AMOUNT_MAX + 1 })).toMatch(/too large/);
    expect(checkRepaymentInput({ ...good, amountMinor: REPAYMENT_AMOUNT_MAX })).toBeNull();
    expect(checkRepaymentInput({ ...good, method: 'paypal' })).toMatch(/how it was paid/);
    expect(checkRepaymentInput({ ...good, toMemberId: A })).toMatch(/two different people/);
    expect(checkRepaymentInput({ ...good, fromMemberId: '' })).toMatch(/two different people/);
    expect(checkRepaymentInput({ ...good, note: 'x'.repeat(201) })).toMatch(/at most 200/);
    expect(checkRepaymentInput({ ...good, note: 'x'.repeat(200) })).toBeNull();
    expect(checkRepaymentInput({ ...good, note: `  ${'x'.repeat(200)}  ` })).toBeNull(); // the trimmed text counts
  });

  it('notes are trimmed and an empty note is none', () => {
    expect(cleanNote('  hi  ')).toBe('hi');
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote('')).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });

  it('new ids are fresh, lowercase and valid', () => {
    const ids = new Set([newRepaymentId(), newRepaymentId(), newReversalId(), newReversalId()]);
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('argument builders: the names must match the database functions exactly', () => {
  it('each builder sends exactly the declared arguments and never an identity, a balance, a capacity or a share', () => {
    expect(createRepaymentRpcArgs(T, R, A, B, 500, 'upi', 'ref 1')).toEqual({ p_trip_id: T, p_repayment_id: R, p_from_member_id: A, p_to_member_id: B, p_amount_minor: 500, p_method: 'upi', p_note: 'ref 1' });
    expect(confirmRepaymentRpcArgs(T, R, 3)).toEqual({ p_trip_id: T, p_repayment_id: R, p_expected_version: 3 });
    expect(cancelRepaymentRpcArgs(T, R, 3)).toEqual({ p_trip_id: T, p_repayment_id: R, p_expected_version: 3 });
    expect(rejectRepaymentRpcArgs(T, R, 3, 'not received')).toEqual({ p_trip_id: T, p_repayment_id: R, p_expected_version: 3, p_reason: 'not received' });
    expect(requestReversalRpcArgs(T, V, R, 'wrong', null)).toEqual({ p_trip_id: T, p_reversal_id: V, p_repayment_id: R, p_reason: 'wrong', p_requested_for: null });
    expect(requestReversalRpcArgs(T, V, R, 'wrong', G)).toEqual({ p_trip_id: T, p_reversal_id: V, p_repayment_id: R, p_reason: 'wrong', p_requested_for: G });
    expect(respondReversalRpcArgs(T, V, 1, 'acknowledge', null)).toEqual({ p_trip_id: T, p_reversal_id: V, p_expected_version: 1, p_decision: 'acknowledge', p_note: null });
    expect(withdrawReversalRpcArgs(T, V, 2)).toEqual({ p_trip_id: T, p_reversal_id: V, p_expected_version: 2 });
    expect(remindReversalRpcArgs(T, V)).toEqual({ p_trip_id: T, p_reversal_id: V });
    expect(proposeOverrideRpcArgs(T, V, 1, 'twenty characters long!')).toEqual({ p_trip_id: T, p_reversal_id: V, p_expected_version: 1, p_category: 'counterparty_unresponsive', p_reason: 'twenty characters long!' });
    expect(decideOverrideRpcArgs(T, V, 2, 'approve', 'verified')).toEqual({ p_trip_id: T, p_reversal_id: V, p_expected_version: 2, p_decision: 'approve', p_note: 'verified' });
  });

  it('the override category is fixed by the builder: the deferred one can never be sent', () => {
    expect(proposeOverrideRpcArgs(T, V, 1, 'x'.repeat(25)).p_category).toBe('counterparty_unresponsive');
  });

  it('every argument name exists in the migration, and every function parameter is covered (no drift)', () => {
    const sql = readFileSync(new URL('../../../supabase/migrations/20261126000000_repayments.sql', import.meta.url), 'utf8');
    const signature = (name: string): string[] => {
      const m = new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)`, 's').exec(sql);
      expect(m, name).not.toBeNull();
      return [...m![1]!.matchAll(/\bp_[a-z_]+/g)].map((x) => x[0]);
    };
    const sent: Record<string, string[]> = {
      create_repayment: Object.keys(createRepaymentRpcArgs(T, R, A, B, 1, 'cash', null)),
      confirm_repayment: Object.keys(confirmRepaymentRpcArgs(T, R, 1)),
      reject_repayment: Object.keys(rejectRepaymentRpcArgs(T, R, 1, null)),
      cancel_repayment: Object.keys(cancelRepaymentRpcArgs(T, R, 1)),
      request_reversal: Object.keys(requestReversalRpcArgs(T, V, R, 'x', null)),
      respond_reversal: Object.keys(respondReversalRpcArgs(T, V, 1, 'decline', null)),
      withdraw_reversal: Object.keys(withdrawReversalRpcArgs(T, V, 1)),
      remind_reversal: Object.keys(remindReversalRpcArgs(T, V)),
      propose_override: Object.keys(proposeOverrideRpcArgs(T, V, 1, 'x'.repeat(20))),
      decide_override: Object.keys(decideOverrideRpcArgs(T, V, 1, 'refuse', null)),
    };
    for (const [fn, keys] of Object.entries(sent)) expect([...keys].sort(), fn).toEqual([...signature(fn)].sort());
  });
});

describe('balance lines: sent and received are added without disturbing the M5 shape', () => {
  it('a row without them (before migration #12) maps exactly as in M5', () => {
    expect(balanceLineFromRow({ member_id: A, paid_minor: 1000, share_minor: 334, net_minor: 666 })).toEqual({ memberId: A, paidMinor: 1000, shareMinor: 334, netMinor: 666 });
  });
  it('a row with them keeps them', () => {
    expect(balanceLineFromRow({ member_id: A, paid_minor: 1000, share_minor: 334, sent_minor: 100, received_minor: 25, net_minor: 691 })).toEqual({
      memberId: A, paidMinor: 1000, shareMinor: 334, sentMinor: 100, receivedMinor: 25, netMinor: 691,
    });
  });
});
