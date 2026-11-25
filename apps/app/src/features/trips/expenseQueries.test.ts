import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ExpenseDraft } from '@tripmate/core';
import { ExpenseError, type ExpenseClient, type ExpenseFunction } from './expenseService';
import { balancesKey, balancesQueryOptions, categoriesKey, categoriesQueryOptions, expenseMutations, expensesKey, expensesQueryOptions, historyKey, historyQueryOptions, retryRead } from './expenseQueries';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_TRIP = '11111111-2222-4333-8444-555555555555';
const EXP = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const USER = 'user-1';

type Reply = { data: unknown; error: { code?: string; message?: string } | null };

function fake(rpcReplies: Reply[] | ((fn: string, n: number) => Reply)) {
  const calls: { fn: ExpenseFunction; args: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  const client = {
    rpc: (fn: ExpenseFunction, args: Record<string, unknown>) => {
      const n = calls.length;
      calls.push({ fn, args });
      const reply = typeof rpcReplies === 'function' ? rpcReplies(fn, n) : (rpcReplies[Math.min(n, rpcReplies.length - 1)] ?? { data: [], error: null });
      return Promise.resolve(reply);
    },
    from: (table: string) => ({
      select: () => {
        reads.push(table);
        const q = { eq: () => q, order: () => q, then: (ok: (v: Reply) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) };
        return q;
      },
    }),
  } as unknown as ExpenseClient;
  return { client, calls, reads };
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({ title: 'Dinner', amountMinor: 900, spentOn: '2026-12-28', categoryKey: 'food', notes: null, participants: [A, B], payers: [{ memberId: A, paidMinor: 900 }], ...over });
const run = <TData, TVars>(qc: QueryClient, options: object, vars: TVars) => new MutationObserver(qc, options as never).mutate(vars as never) as Promise<TData>;
const outdated = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)!.isInvalidated;
const seed = (qc: QueryClient) => {
  qc.setQueryData(expensesKey(USER, TRIP), []);
  qc.setQueryData(balancesKey(USER, TRIP), []);
  qc.setQueryData(expensesKey(USER, OTHER_TRIP), []);
  qc.setQueryData(historyKey(USER, TRIP, EXP), []);
  qc.setQueryData(historyKey(USER, OTHER_TRIP, EXP), []);
};
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as ExpenseError);

describe('queries', () => {
  it('cache keys name the signed-in user and the trip, so one account never sees another\'s cached expenses', () => {
    expect(expensesKey('u1', TRIP)).not.toEqual(expensesKey('u2', TRIP));
    expect(expensesKey('u1', TRIP)).not.toEqual(expensesKey('u1', OTHER_TRIP));
    expect(balancesKey('u1', TRIP)).not.toEqual(balancesKey('u2', TRIP));
    expect(categoriesKey('u1')).not.toEqual(categoriesKey('u2'));
    expect(expensesKey('u1', TRIP)).not.toEqual(balancesKey('u1', TRIP));
  });

  it('fetching expenses, balances and categories goes through the service (reads for expenses, one function for balances)', async () => {
    const f = fake([{ data: [{ member_id: A, paid_minor: 0, share_minor: 0, net_minor: 0 }], error: null }]);
    const qc = newClient();
    expect(await qc.fetchQuery(expensesQueryOptions(f.client, USER, TRIP))).toEqual([]);
    expect(await qc.fetchQuery(balancesQueryOptions(f.client, USER, TRIP))).toEqual([{ memberId: A, paidMinor: 0, shareMinor: 0, netMinor: 0 }]);
    expect(await qc.fetchQuery(categoriesQueryOptions(f.client, USER))).toEqual([]);
    expect(f.reads).toEqual(['expenses', 'expense_payers', 'expense_splits', 'categories']);
    expect(f.calls.map((c) => c.fn)).toEqual(['trip_member_balances']);
    expect(qc.getQueryData(expensesKey(USER, TRIP))).toEqual([]);
  });

  it('history is keyed by user, trip and expense, and is fetched through the service', async () => {
    expect(historyKey('u1', TRIP, EXP)).not.toEqual(historyKey('u2', TRIP, EXP));
    expect(historyKey('u1', TRIP, EXP)).not.toEqual(historyKey('u1', OTHER_TRIP, EXP));
    expect(historyKey('u1', TRIP, EXP).slice(0, 3)).toEqual(['expense-history', 'u1', TRIP]); // the prefix a write refreshes
    const f = fake([]);
    const qc = newClient();
    expect(await qc.fetchQuery(historyQueryOptions(f.client, USER, TRIP, EXP))).toEqual([]);
    expect(f.reads).toEqual(['expense_revisions']);
  });

  it('a read is retried once for a connection hiccup only', () => {
    const net = new ExpenseError('network', 'x');
    expect(retryRead(0, net)).toBe(true);
    expect(retryRead(1, net)).toBe(false);
    for (const kind of ['unavailable', 'setup', 'auth', 'unknown', 'not_found'] as const) expect(retryRead(0, new ExpenseError(kind, 'x')), kind).toBe(false);
    expect(retryRead(0, new Error('other'))).toBe(false);
  });

  it('a read the database refuses (a stranger, a former member) surfaces the single unavailable error and is not retried', async () => {
    const client = { from: () => ({ select: () => { const q = { eq: () => q, order: () => q, then: (ok: (v: Reply) => unknown) => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied' } }).then(ok) }; return q; } }), rpc: () => Promise.resolve({ data: null, error: { message: 'trip_not_found' } }) } as unknown as ExpenseClient;
    const qc = newClient();
    expect((await rejection(qc.fetchQuery(balancesQueryOptions(client, USER, TRIP)))).kind).toBe('unavailable');
    expect((await rejection(qc.fetchQuery(expensesQueryOptions(client, USER, TRIP)))).kind).toBe('auth');
  });
});

describe('mutations: success', () => {
  it('create sends the app-chosen id, and afterwards BOTH this trip\'s expenses and balances are marked out of date (another trip\'s are not)', async () => {
    const f = fake([{ data: [{ expense_id: EXP, version: 1, created: true }], error: null }]);
    const qc = newClient();
    seed(qc);
    const m = expenseMutations(f.client, qc, USER, TRIP);
    const r = await run(qc, m.create, { tripId: TRIP, expenseId: EXP, draft: draft() });
    expect(r).toEqual({ expenseId: EXP, version: 1, created: true });
    expect(f.calls[0]).toMatchObject({ fn: 'create_expense', args: { p_trip_id: TRIP, p_expense_id: EXP } });
    expect(outdated(qc, expensesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, balancesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, expensesKey(USER, OTHER_TRIP))).toBe(false);
    expect(outdated(qc, historyKey(USER, TRIP, EXP))).toBe(true); // a write adds a history entry
    expect(outdated(qc, historyKey(USER, OTHER_TRIP, EXP))).toBe(false);
  });

  it('update, delete and restore each refresh the same two lists', async () => {
    for (const [name, vars, fn] of [
      ['update', { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }, 'update_expense'],
      ['remove', { tripId: TRIP, expenseId: EXP, expectedVersion: 2 }, 'delete_expense'],
      ['restore', { tripId: TRIP, expenseId: EXP, expectedVersion: 3 }, 'restore_expense'],
    ] as const) {
      const f = fake([{ data: [{ expense_id: EXP, version: 9, changed: true }], error: null }]);
      const qc = newClient();
      seed(qc);
      const r = await run<{ version: number }, unknown>(qc, expenseMutations(f.client, qc, USER, TRIP)[name], vars);
      expect(r.version, name).toBe(9);
      expect(f.calls.map((c) => c.fn), name).toEqual([fn]);
      expect(outdated(qc, expensesKey(USER, TRIP)), name).toBe(true);
      expect(outdated(qc, balancesKey(USER, TRIP)), name).toBe(true);
    }
  });

  it('the trip is fixed by the hook: a request naming another trip still goes to THIS trip (one hook can never write elsewhere)', async () => {
    const f = fake([{ data: [{ expense_id: EXP, version: 1, created: true }], error: null }]);
    const qc = newClient();
    const m = expenseMutations(f.client, qc, USER, TRIP);
    await run(qc, m.create, { tripId: OTHER_TRIP, expenseId: EXP, draft: draft() });
    await run(qc, m.remove, { tripId: OTHER_TRIP, expenseId: EXP, expectedVersion: 1 }).catch(() => undefined);
    expect(f.calls.map((c) => c.args.p_trip_id)).toEqual([TRIP, TRIP]);
  });
});

describe('mutations: failures (the screens are refreshed with the truth either way)', () => {
  it('a stale version is refused, nothing is patched by guesswork, and the lists are re-read', async () => {
    const f = fake([{ data: null, error: { message: 'version_conflict' } }]);
    const qc = newClient();
    seed(qc);
    const e = await rejection(run(qc, expenseMutations(f.client, qc, USER, TRIP).update, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }));
    expect(e.kind).toBe('conflict');
    expect(outdated(qc, expensesKey(USER, TRIP))).toBe(true);
    expect(outdated(qc, balancesKey(USER, TRIP))).toBe(true);
  });

  it('archived trip, not allowed, former member and a deleted expense are refused with their own kinds, and still refresh', async () => {
    for (const [text, kind] of [['trip_archived', 'archived'], ['not_allowed', 'not_allowed'], ['former_member_balance', 'former_member'], ['expense_deleted', 'deleted'], ['trip_not_found', 'unavailable']] as const) {
      const qc = newClient();
      seed(qc);
      const e = await rejection(run(qc, expenseMutations(fake([{ data: null, error: { message: text } }]).client, qc, USER, TRIP).update, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }));
      expect(e.kind, text).toBe(kind);
      expect(outdated(qc, expensesKey(USER, TRIP)), text).toBe(true);
    }
  });

  it('bad details are refused before anything is sent, and the lists are still re-read (cheap, and always safe)', async () => {
    const f = fake([{ data: [], error: null }]);
    const qc = newClient();
    seed(qc);
    const e = await rejection(run(qc, expenseMutations(f.client, qc, USER, TRIP).create, { tripId: TRIP, expenseId: EXP, draft: draft({ title: '' }) }));
    expect(e.kind).toBe('invalid');
    expect(f.calls).toEqual([]);
  });
});

describe('duplicate create retries', () => {
  it('after a connection failure the SAME id is sent again and the database\'s "already saved" answer is a success; the lists refresh both times', async () => {
    const replies: Reply[] = [{ data: null, error: { message: 'Failed to fetch' } }, { data: [{ expense_id: EXP, version: 1, created: false }], error: null }];
    const f = fake((_fn, n) => replies[n]!);
    const qc = newClient();
    seed(qc);
    const m = expenseMutations(f.client, qc, USER, TRIP);
    const vars = { tripId: TRIP, expenseId: EXP, draft: draft() };
    const first = await rejection(run(qc, m.create, vars));
    expect(first.kind).toBe('network');
    expect(first.outcomeUnknown).toBe(true);
    expect(outdated(qc, expensesKey(USER, TRIP))).toBe(true);
    const second = await run<{ created: boolean }, unknown>(qc, m.create, vars);
    expect(second.created).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.args).toEqual(f.calls[0]!.args);
  });

  it('a different expense on a used id is refused as "taken" (the screen starts a new expense with a new id)', async () => {
    const f = fake([{ data: null, error: { message: 'expense_id_taken' } }]);
    const qc = newClient();
    const e = await rejection(run(qc, expenseMutations(f.client, qc, USER, TRIP).create, { tripId: TRIP, expenseId: EXP, draft: draft() }));
    expect(e.kind).toBe('taken');
    expect(e.message).toMatch(/Start a new expense/);
  });
});
