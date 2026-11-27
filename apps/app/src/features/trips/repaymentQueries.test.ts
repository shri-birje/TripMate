import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { balancesKey } from './expenseQueries';
import { repaymentEventsKey, repaymentMutations, repaymentsKey, reversalsKey, repaymentsQueryOptions, reversalsQueryOptions, repaymentEventsQueryOptions } from './repaymentQueries';
import { RepaymentError, type RepaymentClient, type RepaymentFunction } from './repaymentService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_TRIP = '11111111-2222-4333-8444-555555555555';
const REP = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_REP = '22222222-3333-4444-8555-666666666666';
const REV = '33333333-4444-4555-8666-777777777777';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const USER = 'user-1';

type Reply = { data: unknown; error: { code?: string; message?: string } | null };

/** A fake that answers each call from a list (the last answer repeats), and records every call. */
function fake(replies: Reply[] | ((fn: string, n: number) => Reply)) {
  const calls: { fn: RepaymentFunction; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: (fn: RepaymentFunction, args: Record<string, unknown>) => {
      const n = calls.length;
      calls.push({ fn, args });
      const reply = typeof replies === 'function' ? replies(fn, n) : (replies[Math.min(n, replies.length - 1)] ?? { data: [], error: null });
      return Promise.resolve(reply);
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }), order: () => Promise.resolve({ data: [], error: null }) }) }) }),
  } as unknown as RepaymentClient;
  return { client, calls };
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const run = <TData, TVars>(qc: QueryClient, options: object, vars: TVars) => new MutationObserver(qc, options as never).mutate(vars as never) as Promise<TData>;
const outdated = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)!.isInvalidated;
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as RepaymentError);

/** Every key the screens read, seeded with fresh data, so invalidation can be seen. */
function seed(qc: QueryClient) {
  const keys = [
    repaymentsKey(USER, TRIP), reversalsKey(USER, TRIP), balancesKey(USER, TRIP), repaymentEventsKey(USER, TRIP, REP), repaymentEventsKey(USER, TRIP, OTHER_REP),
    repaymentsKey(USER, OTHER_TRIP), balancesKey(USER, OTHER_TRIP), repaymentsKey('user-2', TRIP), balancesKey('user-2', TRIP),
  ];
  for (const k of keys) qc.setQueryData(k, []);
  return keys;
}
const ok = (data: unknown): Reply => ({ data, error: null });

describe('cache keys: the user and the trip are always part of them', () => {
  it('one account never shares a cached payment with another, nor one trip with another', () => {
    expect(repaymentsKey('u1', TRIP)).not.toEqual(repaymentsKey('u2', TRIP));
    expect(repaymentsKey('u1', TRIP)).not.toEqual(repaymentsKey('u1', OTHER_TRIP));
    expect(reversalsKey('u1', TRIP)).not.toEqual(reversalsKey('u2', TRIP));
    expect(repaymentEventsKey('u1', TRIP, REP)).not.toEqual(repaymentEventsKey('u1', TRIP, OTHER_REP));
    expect(repaymentsKey('u1', TRIP)).not.toEqual(reversalsKey('u1', TRIP));
  });

  it('the read options use those keys and retry a connection problem once only', () => {
    const { client } = fake([]);
    expect(repaymentsQueryOptions(client, USER, TRIP).queryKey).toEqual(repaymentsKey(USER, TRIP));
    expect(reversalsQueryOptions(client, USER, TRIP).queryKey).toEqual(reversalsKey(USER, TRIP));
    expect(repaymentEventsQueryOptions(client, USER, TRIP, REP).queryKey).toEqual(repaymentEventsKey(USER, TRIP, REP));
    const retry = repaymentsQueryOptions(client, USER, TRIP).retry;
    expect(retry(0, new RepaymentError('network', 'x'))).toBe(true);
    expect(retry(1, new RepaymentError('network', 'x'))).toBe(false);
    expect(retry(0, new RepaymentError('setup', 'x'))).toBe(false); // not available: retrying would not help
    expect(retry(0, new Error('x'))).toBe(false);
  });
});

describe('invalidation after every write (successful or not)', () => {
  it('recording a repayment refreshes the repayments, reversals, every history of the trip, and the BALANCES', async () => {
    const qc = newClient();
    const keys = seed(qc);
    const { client } = fake([ok([{ repayment_id: REP, version: 1, status: 'pending', created: true }])]);
    await run(qc, repaymentMutations(client, qc, USER, TRIP).record, { repaymentId: REP, fromMemberId: A, toMemberId: B, amountMinor: 100, method: 'cash' });
    expect(outdated(qc, repaymentsKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, reversalsKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, balancesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, repaymentEventsKey(USER, TRIP, REP))).toBe(true);
    expect(outdated(qc, repaymentEventsKey(USER, TRIP, OTHER_REP))).toBe(true);
    // another trip and another person are untouched
    expect(outdated(qc, repaymentsKey(USER, OTHER_TRIP))).toBe(false);
    expect(outdated(qc, balancesKey(USER, OTHER_TRIP))).toBe(false);
    expect(outdated(qc, repaymentsKey('user-2', TRIP))).toBe(false);
    expect(outdated(qc, balancesKey('user-2', TRIP))).toBe(false);
    expect(keys.length).toBeGreaterThan(5);
  });

  it('a confirmation refreshes the balances (the settlement suggestions follow them) and this repayment\'s history only', async () => {
    const qc = newClient();
    seed(qc);
    const { client } = fake([ok([{ repayment_id: REP, version: 2, status: 'confirmed', changed: true }])]);
    await run(qc, repaymentMutations(client, qc, USER, TRIP).confirm, { repaymentId: REP, expectedVersion: 1 });
    expect(outdated(qc, balancesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, repaymentEventsKey(USER, TRIP, REP))).toBe(true);
    expect(outdated(qc, repaymentEventsKey(USER, TRIP, OTHER_REP))).toBe(false);
  });

  it('a REFUSED write still refreshes everything: the screen shows the truth after a refusal too', async () => {
    const qc = newClient();
    seed(qc);
    const { client } = fake([{ data: null, error: { message: 'version_conflict' } }]);
    const e = await rejection(run(qc, repaymentMutations(client, qc, USER, TRIP).confirm, { repaymentId: REP, expectedVersion: 1 }));
    expect(e.kind).toBe('conflict');
    expect(outdated(qc, balancesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, repaymentsKey(USER, TRIP))).toBe(true);
  });

  it('every reversal action refreshes the reversals, the balances (an applied one moves them) and the repayments', async () => {
    const actions: [string, (m: ReturnType<typeof repaymentMutations>) => { options: object; vars: object }, Reply][] = [
      ['requestReversal', (m) => ({ options: m.requestReversal, vars: { reversalId: REV, repaymentId: REP, reason: 'wrong' } }), ok([{ reversal_id: REV, version: 1, status: 'requested', created: true }])],
      ['respond', (m) => ({ options: m.respond, vars: { reversalId: REV, expectedVersion: 1, decision: 'acknowledge' } }), ok([{ reversal_id: REV, version: 2, status: 'applied', changed: true }])],
      ['withdraw', (m) => ({ options: m.withdraw, vars: { reversalId: REV, expectedVersion: 1 } }), ok([{ reversal_id: REV, version: 2, status: 'withdrawn', changed: true }])],
      ['propose', (m) => ({ options: m.propose, vars: { reversalId: REV, expectedVersion: 1, reason: 'twenty characters long!' } }), ok([{ reversal_id: REV, version: 2, status: 'override_proposed', changed: true }])],
      ['decide', (m) => ({ options: m.decide, vars: { reversalId: REV, expectedVersion: 2, decision: 'approve' } }), ok([{ reversal_id: REV, version: 3, status: 'applied', changed: true }])],
    ];
    for (const [name, pick, reply] of actions) {
      const qc = newClient();
      seed(qc);
      const { client } = fake([reply]);
      const m = repaymentMutations(client, qc, USER, TRIP);
      const { options, vars } = pick(m);
      await run(qc, options, vars);
      expect(outdated(qc, reversalsKey(USER, TRIP)), name).toBe(true);
      expect(outdated(qc, balancesKey(USER, TRIP)), name).toBe(true);
      expect(outdated(qc, repaymentsKey(USER, TRIP)), name).toBe(true);
      expect(outdated(qc, repaymentsKey(USER, OTHER_TRIP)), name).toBe(false);
    }
  });

  it('a reminder changes no state, but still refreshes the reversal it belongs to', async () => {
    const qc = newClient();
    seed(qc);
    const { client } = fake([ok([{ reversal_id: REV, version: 1, status: 'requested', reminded_at: '2026-12-01T09:00:00Z' }])]);
    await run(qc, repaymentMutations(client, qc, USER, TRIP).remind, { reversalId: REV });
    expect(outdated(qc, reversalsKey(USER, TRIP))).toBe(true);
  });
});

describe('duplicate submissions and retries', () => {
  it('a retry with the same id reaches the database with the same id (safe: the database answers "already saved")', async () => {
    const qc = newClient();
    const { client, calls } = fake((_fn, n) => (n === 0 ? { data: null, error: { message: 'Failed to fetch' } } : ok([{ repayment_id: REP, version: 1, status: 'pending', created: false }])));
    const m = repaymentMutations(client, qc, USER, TRIP);
    const first = await rejection(run(qc, m.record, { repaymentId: REP, fromMemberId: A, toMemberId: B, amountMinor: 100, method: 'cash' }));
    expect(first.outcomeUnknown).toBe(true);
    const second = await run<{ created: boolean }, object>(qc, m.record, { repaymentId: REP, fromMemberId: A, toMemberId: B, amountMinor: 100, method: 'cash' });
    expect(second).toMatchObject({ created: false });
    expect(calls.map((c) => c.args.p_repayment_id)).toEqual([REP, REP]);
  });

  it('a double confirmation is a safe no-op the second time, and both answers are readable', async () => {
    const qc = newClient();
    const { client, calls } = fake((_fn, n) => (n === 0 ? ok([{ repayment_id: REP, version: 2, status: 'confirmed', changed: true }]) : ok([{ repayment_id: REP, version: 2, status: 'confirmed', changed: false }])));
    const m = repaymentMutations(client, qc, USER, TRIP);
    expect(await run(qc, m.confirm, { repaymentId: REP, expectedVersion: 1 })).toMatchObject({ changed: true });
    expect(await run(qc, m.confirm, { repaymentId: REP, expectedVersion: 1 })).toMatchObject({ changed: false });
    expect(calls.every((c) => c.args.p_expected_version === 1)).toBe(true);
  });

  it('a second submission against a repayment that was already answered is refused with a clear sentence, not applied twice', async () => {
    const qc = newClient();
    const { client } = fake([{ data: null, error: { message: 'repayment_not_pending' } }]);
    const e = await rejection(run(qc, repaymentMutations(client, qc, USER, TRIP).cancel, { repaymentId: REP, expectedVersion: 2 }));
    expect(e.kind).toBe('not_pending');
    expect(e.message).toMatch(/already been answered/);
  });

  it('a stale second submission on another device is refused as a conflict, and nothing is sent twice', async () => {
    const qc = newClient();
    const { client, calls } = fake([{ data: null, error: { message: 'version_conflict' } }]);
    const e = await rejection(run(qc, repaymentMutations(client, qc, USER, TRIP).reject, { repaymentId: REP, expectedVersion: 1, reason: null }));
    expect(e.kind).toBe('conflict');
    expect(calls).toHaveLength(1);
  });

  it('the trip is fixed by the hook: a mutation can never be sent to another trip', async () => {
    const qc = newClient();
    const { client, calls } = fake([ok([{ repayment_id: REP, version: 2, status: 'confirmed', changed: true }])]);
    await run(qc, repaymentMutations(client, qc, USER, TRIP).confirm, { repaymentId: REP, expectedVersion: 1, tripId: OTHER_TRIP } as never);
    expect(calls[0]!.args.p_trip_id).toBe(TRIP);
  });

  it('a pending record and a balances refresh are independent: refreshing the balances does not refresh the repayments list', async () => {
    const qc = newClient();
    seed(qc);
    qc.setQueryData(repaymentsKey(USER, TRIP), []);
    await qc.invalidateQueries({ queryKey: balancesKey(USER, TRIP), refetchType: 'none' });
    expect(outdated(qc, repaymentsKey(USER, TRIP))).toBe(false);
  });
});
