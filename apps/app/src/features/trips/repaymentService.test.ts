import { describe, expect, it } from 'vitest';
import { REPAYMENT_COLUMNS, REVERSAL_COLUMNS, REPAYMENT_EVENT_COLUMNS, REPAYMENT_MESSAGES, RepaymentError, cancelRepayment, confirmRepayment, decideOverride, getRepaymentEvents, listRepayments, listReversals, proposeOverride, recordRepayment, rejectRepayment, remindAboutReversal, requestReversal, respondToReversal, withdrawReversal, type RepaymentClient, type RepaymentFunction, type RepaymentErrorKind } from './repaymentService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const REP = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const REV = '11111111-2222-4333-8444-555555555555';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const G = '00000000-0000-4000-8000-0000000000c3';
const UPPER = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';

type PgReply = { data: unknown; error: { code?: string; message?: string; details?: string } | null };
interface Tables {
  repayments?: unknown[];
  repayment_reversals?: unknown[];
  repayment_events?: unknown[];
  readError?: { code?: string; message?: string };
}

/** A fake of the slice of the client the service uses. Records every call; never writes a table. */
function fake(rpcReply: PgReply | (() => PgReply) = { data: [], error: null }, tables: Tables = {}) {
  const rpcCalls: { fn: RepaymentFunction; args: Record<string, unknown> }[] = [];
  const reads: { table: string; columns: string }[] = [];
  const client = {
    rpc: (fn: RepaymentFunction, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(typeof rpcReply === 'function' ? rpcReply() : rpcReply);
    },
    from: (table: string) => ({
      select: (columns: string) => {
        reads.push({ table, columns });
        const rows = (table === 'repayments' ? tables.repayments : table === 'repayment_reversals' ? tables.repayment_reversals : tables.repayment_events) ?? [];
        const q = {
          eq: () => q,
          order: () => q,
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(tables.readError ? { data: null, error: tables.readError } : { data: rows, error: null }).then(ok, bad),
        };
        return q;
      },
    }),
  } as unknown as RepaymentClient;
  return { client, rpcCalls, reads };
}
const ok = (data: unknown): PgReply => ({ data, error: null });
const err = (message: string, extra: { code?: string; details?: string } = {}): PgReply => ({ data: null, error: { message, ...extra } });
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as RepaymentError);

const recorded = (over: Record<string, unknown> = {}) => ({ repayment_id: REP, version: 1, status: 'pending', created: true, ...over });
const decided = (over: Record<string, unknown> = {}) => ({ repayment_id: REP, version: 2, status: 'confirmed', changed: true, ...over });
const reversed = (over: Record<string, unknown> = {}) => ({ reversal_id: REV, version: 2, status: 'applied', changed: true, ...over });
const requested = (over: Record<string, unknown> = {}) => ({ reversal_id: REV, version: 1, status: 'requested', created: true, ...over });
const repaymentRow = (over: Record<string, unknown> = {}) => ({
  id: REP, trip_id: TRIP, from_member_id: A, to_member_id: B, amount_minor: 30000, method: 'cash', note: null, status: 'pending', created_by: A,
  created_at: '2026-11-26T10:00:00Z', decided_by: null, decided_at: null, decision_note: null, version: 1, ...over,
});
const reversalRow = (over: Record<string, unknown> = {}) => ({
  id: REV, trip_id: TRIP, repayment_id: REP, status: 'requested', requested_by: B, requested_for: B, requested_at: '2026-11-26T11:00:00Z', reason: 'wrong amount',
  override_proposed_by: null, override_category: null, override_reason: null, override_proposed_at: null, decided_by: null, decided_at: null, decision_note: null,
  is_override: false, version: 1, ...over,
});

const base = { tripId: TRIP, repaymentId: REP, fromMemberId: A, toMemberId: B, amountMinor: 30000, method: 'cash' as const };

describe('recording a repayment: arguments, mapping and the friendly checks', () => {
  it('sends exactly the declared arguments: the trip, the id, the payer, the receiver, the amount, the method and the note; never a balance, a capacity or an identity of the actor', async () => {
    const { client, rpcCalls } = fake(ok([recorded()]));
    await recordRepayment(client, { ...base, note: '  dinner  ' });
    expect(rpcCalls).toEqual([{ fn: 'create_repayment', args: { p_trip_id: TRIP, p_repayment_id: REP, p_from_member_id: A, p_to_member_id: B, p_amount_minor: 30000, p_method: 'cash', p_note: 'dinner' } }]);
    expect(Object.keys(rpcCalls[0]!.args).some((k) => /balance|capacity|share|actor|user|me$/i.test(k))).toBe(false);
  });

  it('maps the database answer, and a created=false retry is reported as such', async () => {
    expect(await recordRepayment(fake(ok([recorded()])).client, base)).toEqual({ repaymentId: REP, version: 1, status: 'pending', created: true });
    expect(await recordRepayment(fake(ok([recorded({ created: false })])).client, base)).toMatchObject({ created: false });
  });

  it('lowercases ids before sending, so one expense-style id can never reach the database in two spellings', async () => {
    const { client, rpcCalls } = fake(ok([recorded()]));
    await recordRepayment(client, { ...base, repaymentId: UPPER, fromMemberId: A.toUpperCase() });
    expect(rpcCalls[0]!.args).toMatchObject({ p_repayment_id: REP, p_from_member_id: A });
  });

  it('refuses a bad amount, method, note or pair before anything is sent', async () => {
    for (const bad of [{ amountMinor: 0 }, { amountMinor: 1.5 }, { amountMinor: 1_000_000_000_001 }, { method: 'paypal' as never }, { toMemberId: A }, { note: 'x'.repeat(201) }]) {
      const { client, rpcCalls } = fake(ok([recorded()]));
      const e = await rejection(recordRepayment(client, { ...base, ...bad }));
      expect(e).toBeInstanceOf(RepaymentError);
      expect(e.kind, JSON.stringify(bad)).toBe('invalid');
      expect(rpcCalls, JSON.stringify(bad)).toEqual([]);
    }
  });

  it('a bad id or trip is refused without sending anything', async () => {
    const { client, rpcCalls } = fake(ok([recorded()]));
    expect((await rejection(recordRepayment(client, { ...base, repaymentId: 'nope' }))).kind).toBe('invalid');
    expect((await rejection(recordRepayment(client, { ...base, tripId: 'x' }))).kind).toBe('unavailable');
    expect(rpcCalls).toEqual([]);
  });

  it('an unreadable database answer is "unknown", never a guessed payment', async () => {
    for (const data of [[{ repayment_id: REP, version: 1, status: 'paid', created: true }], [{ repayment_id: REP, version: 0, status: 'pending', created: true }], [{ repayment_id: REP, version: 1, status: 'pending' }], []]) {
      expect((await rejection(recordRepayment(fake(ok(data)).client, base))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });
});

describe('typed error mapping (the database\'s words first; fixed sentences only)', () => {
  const cases: [string, RepaymentErrorKind, Record<string, string> | undefined][] = [
    ['trip_not_found', 'unavailable', undefined],
    ['trip_archived', 'archived', undefined],
    ['party_cannot_act', 'party_cannot_act', undefined],
    ['not_admin', 'not_admin', undefined],
    ['not_allowed', 'not_allowed', undefined],
    ['repayment_not_found', 'not_found', undefined],
    ['reversal_not_found', 'reversal_not_found', undefined],
    ['repayment_id_taken', 'taken', undefined],
    ['reversal_id_taken', 'taken', undefined],
    ['member_not_active', 'member_inactive', undefined],
    ['version_conflict', 'conflict', undefined],
    ['repayment_not_pending', 'not_pending', undefined],
    ['repayment_not_confirmed', 'not_confirmed', undefined],
    ['reversal_not_open', 'reversal_not_open', undefined],
    ['reversal_already_open', 'reversal_open', undefined],
    ['reversal_already_applied', 'reversal_applied', undefined],
    ['reversal_reason_required', 'reason_required', undefined],
    ['reminder_too_soon', 'reminder_too_soon', undefined],
    ['override_not_eligible', 'override_not_eligible', undefined],
    ['override_threshold_not_met', 'override_too_early', undefined],
    ['override_evidence_missing', 'override_no_evidence', undefined],
    ['override_proposer_cannot_approve', 'proposer_cannot_approve', undefined],
    ['former_member_balance', 'former_member', undefined],
    ['balance_not_settled', 'former_member', undefined],
    ['repayment_transition_invalid', 'state', undefined],
    ['reversal_transition_invalid', 'state', undefined],
    ['invalid_repayment', 'invalid', undefined],
    ['not_authenticated', 'auth', { code: '28000' }],
    ['whatever', 'auth', { code: '42501' }],
    ['Could not find the function create_repayment', 'setup', { code: 'PGRST202' }],
    ['relation "repayments" does not exist', 'setup', { code: '42P01' }],
    ['Failed to fetch', 'network', undefined],
    ['Something odd: secret-token-xyz', 'unknown', undefined],
  ];
  for (const [text, kind, extra] of cases) {
    it(`"${text}" becomes ${kind}, with the fixed sentence and no raw text`, async () => {
      const e = await rejection(recordRepayment(fake(err(text, extra)).client, base));
      expect(e.kind).toBe(kind);
      expect(e.message).toBe(REPAYMENT_MESSAGES[kind]);
      expect(e.message).not.toContain('secret-token');
      expect(e.message).not.toContain('secret-token');
      expect(e.message).not.toContain('odd:');
    });
  }

  it('an "exceeds" refusal carries the most that could be recorded, read from the detail', async () => {
    const e = await rejection(recordRepayment(fake(err('repayment_exceeds_outstanding', { details: 'max_minor=40000' })).client, base));
    expect(e.kind).toBe('exceeds');
    expect(e.maxMinor).toBe(40000);
    expect((await rejection(recordRepayment(fake(err('repayment_exceeds_outstanding')).client, base))).maxMinor).toBeNull();
    expect((await rejection(recordRepayment(fake(err('repayment_exceeds_outstanding', { details: 'max_minor=-5' })).client, base))).maxMinor).toBeNull();
  });

  it('only a connection problem or an unknown failure means the outcome is UNKNOWN', async () => {
    expect((await rejection(recordRepayment(fake(err('Failed to fetch')).client, base))).outcomeUnknown).toBe(true);
    expect((await rejection(recordRepayment(fake(err('version_conflict')).client, base))).outcomeUnknown).toBe(false);
    expect((await rejection(recordRepayment(fake(err('repayment_exceeds_outstanding')).client, base))).outcomeUnknown).toBe(false);
  });

  it('a thrown client exception is mapped, never leaked', async () => {
    const throwing = { rpc: () => { throw new Error('boom token-abc'); } } as unknown as RepaymentClient;
    const e = await rejection(recordRepayment(throwing, base));
    expect(e.kind).toBe('unknown');
    expect(e.message).not.toContain('token-abc');
  });
});

describe('the state-changing calls: arguments, identities and versions', () => {
  it('confirm, reject and cancel send the trip, the repayment, the expected version and (for reject) a trimmed reason; nothing else', async () => {
    const c = fake(ok([decided()]));
    expect(await confirmRepayment(c.client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1 })).toEqual({ repaymentId: REP, version: 2, status: 'confirmed', changed: true });
    expect(c.rpcCalls[0]).toEqual({ fn: 'confirm_repayment', args: { p_trip_id: TRIP, p_repayment_id: REP, p_expected_version: 1 } });

    const r = fake(ok([decided({ status: 'rejected' })]));
    await rejectRepayment(r.client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1, reason: '  not received  ' });
    expect(r.rpcCalls[0]).toEqual({ fn: 'reject_repayment', args: { p_trip_id: TRIP, p_repayment_id: REP, p_expected_version: 1, p_reason: 'not received' } });
    await rejectRepayment(r.client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1 });
    expect(r.rpcCalls[1]!.args.p_reason).toBeNull();

    const c2 = fake(ok([decided({ status: 'cancelled' })]));
    expect(await cancelRepayment(c2.client, { tripId: TRIP, repaymentId: REP, expectedVersion: 3 })).toMatchObject({ status: 'cancelled' });
    expect(c2.rpcCalls[0]).toEqual({ fn: 'cancel_repayment', args: { p_trip_id: TRIP, p_repayment_id: REP, p_expected_version: 3 } });
  });

  it('a safe repeat (changed=false) is reported as no change, not as an error', async () => {
    expect(await confirmRepayment(fake(ok([decided({ changed: false })])).client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1 })).toMatchObject({ changed: false });
  });

  it('a stale version is refused before the database is asked, if it is not a positive whole number', async () => {
    const { client, rpcCalls } = fake(ok([decided()]));
    for (const v of [0, -1, 1.5, Number.NaN]) expect((await rejection(confirmRepayment(client, { tripId: TRIP, repaymentId: REP, expectedVersion: v }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });

  it('a stale version from the database is a conflict, and the database is the one that decides it', async () => {
    expect((await rejection(confirmRepayment(fake(err('version_conflict')).client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1 }))).kind).toBe('conflict');
  });

  it('a long note or reason is refused early', async () => {
    const { client, rpcCalls } = fake(ok([decided()]));
    expect((await rejection(rejectRepayment(client, { tripId: TRIP, repaymentId: REP, expectedVersion: 1, reason: 'x'.repeat(201) }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });
});

describe('reversals and the override: the actor, the represented participant and the counterparty stay apart', () => {
  it('a party requests for themselves: nothing is sent for the represented participant', async () => {
    const { client, rpcCalls } = fake(ok([requested()]));
    expect(await requestReversal(client, { tripId: TRIP, reversalId: REV, repaymentId: REP, reason: '  wrong amount  ' })).toEqual({ reversalId: REV, version: 1, status: 'requested', created: true });
    expect(rpcCalls[0]).toEqual({ fn: 'request_reversal', args: { p_trip_id: TRIP, p_reversal_id: REV, p_repayment_id: REP, p_reason: 'wrong amount', p_requested_for: null } });
  });

  it('an admin acting for a guest names the guest as the represented participant; the actor is never sent', async () => {
    const { client, rpcCalls } = fake(ok([requested()]));
    await requestReversal(client, { tripId: TRIP, reversalId: REV, repaymentId: REP, reason: 'wrong amount', requestedFor: G });
    expect(rpcCalls[0]!.args.p_requested_for).toBe(G);
    expect(Object.keys(rpcCalls[0]!.args)).not.toContain('p_requested_by');
  });

  it('the reason must be 1 to 200 characters, after trimming', async () => {
    const { client, rpcCalls } = fake(ok([requested()]));
    for (const reason of ['', '   ', 'x'.repeat(201)]) expect((await rejection(requestReversal(client, { tripId: TRIP, reversalId: REV, repaymentId: REP, reason }))).kind).toBe('reason_required');
    expect(rpcCalls).toEqual([]);
  });

  it('the counterparty acknowledges or declines; anything else is refused early', async () => {
    const { client, rpcCalls } = fake(ok([reversed()]));
    expect(await respondToReversal(client, { tripId: TRIP, reversalId: REV, expectedVersion: 1, decision: 'acknowledge' })).toMatchObject({ status: 'applied', changed: true });
    expect(rpcCalls[0]).toEqual({ fn: 'respond_reversal', args: { p_trip_id: TRIP, p_reversal_id: REV, p_expected_version: 1, p_decision: 'acknowledge', p_note: null } });
    expect((await rejection(respondToReversal(client, { tripId: TRIP, reversalId: REV, expectedVersion: 1, decision: 'maybe' as never }))).kind).toBe('invalid');
    expect(rpcCalls).toHaveLength(1);
  });

  it('withdraw sends only the version; the reminder sends only the ids and maps the reminder time', async () => {
    const w = fake(ok([{ reversal_id: REV, version: 2, status: 'withdrawn', changed: true }]));
    await withdrawReversal(w.client, { tripId: TRIP, reversalId: REV, expectedVersion: 1 });
    expect(w.rpcCalls[0]).toEqual({ fn: 'withdraw_reversal', args: { p_trip_id: TRIP, p_reversal_id: REV, p_expected_version: 1 } });

    const r = fake(ok([{ reversal_id: REV, version: 1, status: 'requested', reminded_at: '2026-12-01T09:00:00Z' }]));
    expect(await remindAboutReversal(r.client, { tripId: TRIP, reversalId: REV })).toEqual({ reversalId: REV, version: 1, status: 'requested', remindedAt: '2026-12-01T09:00:00Z' });
    expect(r.rpcCalls[0]).toEqual({ fn: 'remind_reversal', args: { p_trip_id: TRIP, p_reversal_id: REV } });
  });

  it('the override category is fixed to counterparty_unresponsive; the reason must be at least 20 characters', async () => {
    const { client, rpcCalls } = fake(ok([{ reversal_id: REV, version: 2, status: 'override_proposed', changed: true }]));
    await proposeOverride(client, { tripId: TRIP, reversalId: REV, expectedVersion: 1, reason: 'twenty characters long!' });
    expect(rpcCalls[0]!.args.p_category).toBe('counterparty_unresponsive');
    expect((await rejection(proposeOverride(client, { tripId: TRIP, reversalId: REV, expectedVersion: 1, reason: 'too short' }))).kind).toBe('reason_required');
    expect(rpcCalls).toHaveLength(1);
  });

  it('a second admin approves or refuses; anything else is refused early', async () => {
    const { client, rpcCalls } = fake(ok([reversed({ status: 'override_refused', changed: true })]));
    expect(await decideOverride(client, { tripId: TRIP, reversalId: REV, expectedVersion: 2, decision: 'refuse', note: 'not convinced' })).toMatchObject({ status: 'override_refused' });
    expect(rpcCalls[0]).toEqual({ fn: 'decide_override', args: { p_trip_id: TRIP, p_reversal_id: REV, p_expected_version: 2, p_decision: 'refuse', p_note: 'not convinced' } });
    expect((await rejection(decideOverride(client, { tripId: TRIP, reversalId: REV, expectedVersion: 2, decision: 'skip' as never }))).kind).toBe('invalid');
  });

  it('a proposer approving their own override gets a clear, fixed answer', async () => {
    const e = await rejection(decideOverride(fake(err('override_proposer_cannot_approve')).client, { tripId: TRIP, reversalId: REV, expectedVersion: 2, decision: 'approve' }));
    expect(e.kind).toBe('proposer_cannot_approve');
    expect(e.message).toMatch(/different admin/);
  });
});

describe('reads: the columns are named, every row is checked, and a partly readable list is never shown', () => {
  it('reads name their columns (no wildcard) and filter by the trip', async () => {
    const { client, reads } = fake(undefined, { repayments: [repaymentRow()], repayment_reversals: [reversalRow()], repayment_events: [] });
    expect(await listRepayments(client, TRIP)).toHaveLength(1);
    expect(await listReversals(client, TRIP)).toHaveLength(1);
    await getRepaymentEvents(client, TRIP, REP);
    expect(reads.map((r) => r.columns)).toEqual([REPAYMENT_COLUMNS, REVERSAL_COLUMNS, REPAYMENT_EVENT_COLUMNS]);
    for (const r of reads) expect(r.columns).not.toMatch(/\*/);
    expect(REPAYMENT_COLUMNS).not.toMatch(/user_id|email/);
  });

  it('a list with one unreadable row is refused as a whole (never a partial list)', async () => {
    const { client } = fake(undefined, { repayments: [repaymentRow(), repaymentRow({ status: 'paid' })] });
    expect((await rejection(listRepayments(client, TRIP))).kind).toBe('unknown');
  });

  it('a read failure is mapped, and a bad trip is refused without reading', async () => {
    expect((await rejection(listRepayments(fake(undefined, { readError: { message: 'Failed to fetch' } }).client, TRIP))).kind).toBe('network');
    const { client, reads } = fake();
    expect((await rejection(listRepayments(client, 'nope'))).kind).toBe('unavailable');
    expect(reads).toEqual([]);
  });

  it('the history comes back as domain events, with the actor and the represented participant kept apart', async () => {
    const { client } = fake(undefined, {
      repayment_events: [{ id: 1, repayment_id: REP, reversal_id: null, action: 'repayment.create', from_status: null, to_status: 'pending', actor_member_id: A, represented_member_id: A, reason: null, acted_at: '2026-11-26T10:00:00Z' }],
    });
    const events = await getRepaymentEvents(client, TRIP, REP);
    expect(events[0]).toMatchObject({ actorMemberId: A, representedMemberId: A, action: 'repayment.create' });
  });
});
