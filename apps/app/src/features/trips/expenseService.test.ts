import { describe, expect, it } from 'vitest';
import type { ExpenseDraft } from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';
import {
  CATEGORY_COLUMNS,
  EXPENSE_COLUMNS,
  EXPENSE_MESSAGES,
  ExpenseError,
  PAYER_COLUMNS,
  REVISION_COLUMNS,
  SHARE_COLUMNS,
  createExpense,
  deleteExpense,
  getExpense,
  getExpenseHistory,
  getTripBalances,
  listCategories,
  listExpenses,
  restoreExpense,
  updateExpense,
  type ExpenseClient,
  type ExpenseErrorKind,
  type ExpenseFunction,
} from './expenseService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const EXP = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';

type PgReply = { data: unknown; error: { code?: string; message?: string; details?: string } | null; count?: number | null };
interface Tables {
  expenses?: unknown[];
  expense_payers?: unknown[];
  expense_splits?: unknown[];
  categories?: unknown[];
  expense_revisions?: unknown[];
  /** A reply per read, in order, replacing the table's rows (for failures and for changing answers). */
  readReplies?: PgReply[];
}

/** A fake of the slice of Supabase's client the service uses. Records every call. */
function fake(rpcReply: PgReply | (() => PgReply) = { data: [], error: null }, tables: Tables = {}) {
  const rpcCalls: { fn: ExpenseFunction; args: Record<string, unknown> }[] = [];
  const reads: { table: string; columns: string; filters: [string, string][]; orders: [string, boolean][]; ranges: [number, number][]; counted: boolean }[] = [];
  const replies = [...(tables.readReplies ?? [])];
  const client = {
    rpc: (fn: ExpenseFunction, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(typeof rpcReply === 'function' ? rpcReply() : rpcReply);
    },
    from: (table: string) => ({
      select: (columns: string, options?: { count?: string }) => {
        const rec = { table, columns, filters: [] as [string, string][], orders: [] as [string, boolean][], ranges: [] as [number, number][], counted: options?.count === 'exact' };
        reads.push(rec);
        const q = {
          eq: (c: string, v: string) => (rec.filters.push([c, v]), q),
          order: (c: string, o?: { ascending?: boolean }) => (rec.orders.push([c, o?.ascending !== false]), q),
          range: (from: number, to: number) => (rec.ranges.push([from, to]), q),
          then: (ok: (v: PgReply) => unknown, bad?: (e: unknown) => unknown) => {
            const next = replies.shift();
            const rows = (tables as Record<string, unknown[] | undefined>)[table] ?? [];
            // like the real database: the requested slice of the rows, and (when asked) the exact total
            const last = rec.ranges.at(-1);
            const slice = last ? rows.slice(last[0], last[1] + 1) : rows;
            const reply: PgReply = next
              ? 'count' in next || !Array.isArray(next.data) ? next : { ...next, count: next.data.length } // a canned reply counts its own rows unless it says otherwise
              : { data: slice, error: null, count: rows.length };
            return Promise.resolve(reply).then(ok, bad);
          },
        };
        return q;
      },
    }),
  } as unknown as ExpenseClient;
  return { client, rpcCalls, reads };
}
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as ExpenseError);
const err = (message: string, extra: { code?: string; details?: string } = {}): PgReply => ({ data: null, error: { message, ...extra } });

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  title: 'Beach dinner', amountMinor: 1000, spentOn: '2026-12-28', categoryKey: 'food', notes: null, participants: [A, B, C], payers: [{ memberId: A, paidMinor: 1000 }], ...over,
});
const created = { data: [{ expense_id: EXP, version: 1, created: true }], error: null };
const changed = (version = 2, did = true): PgReply => ({ data: [{ expense_id: EXP, version, changed: did }], error: null });

describe('createExpense', () => {
  it('sends exactly the trip, the app-chosen id, the fields, the participants and the payers (never a share) and returns what the database answered', async () => {
    const { client, rpcCalls } = fake(created);
    const r = await createExpense(client, { tripId: TRIP, expenseId: EXP, draft: draft({ title: '  Beach dinner  ' }) });
    expect(r).toEqual({ expenseId: EXP, version: 1, created: true });
    expect(rpcCalls).toEqual([{ fn: 'create_expense', args: {
      p_trip_id: TRIP, p_expense_id: EXP, p_title: 'Beach dinner', p_amount_minor: 1000, p_spent_on: '2026-12-28', p_category_key: 'food', p_notes: null,
      p_split_method: 'equal', p_participants: [A, B, C], p_payers: [{ member_id: A, paid_minor: 1000 }], p_split_inputs: null } }]);
    expect(Object.keys(rpcCalls[0]!.args).join()).not.toMatch(/share|user|uid|actor/i);
  });

  it('a retry with the same expense id sends the identical request, and "already saved" is a success, not an error', async () => {
    const replies = [{ data: [{ expense_id: EXP, version: 1, created: true }], error: null }, { data: [{ expense_id: EXP, version: 1, created: false }], error: null }];
    let n = 0;
    const { client, rpcCalls } = fake(() => replies[n++]!);
    const vars = { tripId: TRIP, expenseId: EXP, draft: draft() };
    const first = await createExpense(client, vars);
    const second = await createExpense(client, vars);
    expect(first.created).toBe(true);
    expect(second).toEqual({ expenseId: EXP, version: 1, created: false });
    expect(rpcCalls[1]).toEqual(rpcCalls[0]);
  });

  it('an unknown result after a connection failure can be retried with the same id (the failure says so)', async () => {
    let n = 0;
    const { client, rpcCalls } = fake(() => (n++ === 0 ? err('TypeError: Failed to fetch') : created));
    const vars = { tripId: TRIP, expenseId: EXP, draft: draft() };
    const e = await rejection(createExpense(client, vars));
    expect(e.kind).toBe('network');
    expect(e.outcomeUnknown).toBe(true);
    expect((await createExpense(client, vars)).created).toBe(true);
    expect(rpcCalls[0]!.args.p_expense_id).toBe(rpcCalls[1]!.args.p_expense_id);
  });

  it('refuses bad details with a specific sentence BEFORE anything is sent', async () => {
    const { client, rpcCalls } = fake(created);
    const bad = async (over: Partial<ExpenseDraft>) => rejection(createExpense(client, { tripId: TRIP, expenseId: EXP, draft: draft(over) }));
    expect((await bad({ title: '  ' })).message).toMatch(/name/);
    expect((await bad({ amountMinor: 0 })).message).toMatch(/amount/i);
    expect((await bad({ payers: [{ memberId: A, paidMinor: 999 }] })).message).toMatch(/add up/);
    expect((await bad({ participants: [] })).message).toMatch(/at least one/);
    expect((await bad({ spentOn: '2026-02-30' })).kind).toBe('invalid');
    expect((await rejection(createExpense(client, { tripId: 'nope', expenseId: EXP, draft: draft() }))).kind).toBe('unavailable');
    expect((await rejection(createExpense(client, { tripId: TRIP, expenseId: 'nope', draft: draft() }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });

  it('with the current members known, a former member is stopped before sending (the database would refuse too)', async () => {
    const { client, rpcCalls } = fake(created);
    const e = await rejection(createExpense(client, { tripId: TRIP, expenseId: EXP, draft: draft(), context: { activeMemberIds: [A, B] } }));
    expect(e.kind).toBe('invalid');
    expect(e.message).toMatch(/on the trip/);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses an answer that is not what the database promises (it would be shown as a saved expense)', async () => {
    for (const data of [null, [], [{ expense_id: EXP }], [{ expense_id: EXP, version: 0, created: true }], [{ expense_id: EXP, version: 1.5, created: true }], [{ expense_id: EXP, version: 1, created: 'yes' }], [{ version: 1, created: true }]]) {
      expect((await rejection(createExpense(fake({ data, error: null }).client, { tripId: TRIP, expenseId: EXP, draft: draft() }))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });

  it('upper-case ids are sent in lower case', async () => {
    const { client, rpcCalls } = fake(created);
    await createExpense(client, { tripId: TRIP, expenseId: EXP.toUpperCase(), draft: draft() });
    expect(rpcCalls[0]!.args.p_expense_id).toBe(EXP);
  });
});

describe('every database answer becomes ONE fixed, plain sentence (never raw text, an id or an amount)', () => {
  const CASES: [string, ExpenseErrorKind, { code?: string; details?: string }?][] = [
    ['trip_not_found', 'unavailable'], ['trip_archived', 'archived'], ['not_allowed', 'not_allowed'], ['expense_not_found', 'not_found'],
    ['version_conflict', 'conflict'], ['expense_deleted', 'deleted'], ['expense_id_taken', 'taken'], ['participant_not_active', 'participant_inactive'],
    ['payer_not_active', 'payer_inactive'], ['outside_trip_dates', 'outside_dates'], ['category_not_found', 'category'], ['too_many_expenses', 'too_many'],
    ['payers_total_mismatch', 'amounts'], ['shares_total_mismatch', 'amounts'], ['shares_not_equal_split', 'invalid'], ['invalid_expense', 'invalid'],
    ['split_total_mismatch', 'split_total'], ['invalid_split_value', 'split_value'], ['split_not_derived', 'invalid'],
    ['former_member_balance', 'former_member', { details: 'net_minor=-300' }], ['not_authenticated', 'auth'], ['whatever', 'auth', { code: '42501' }],
    ['whatever', 'auth', { code: '28000' }], ['x', 'invalid', { code: '23514' }], ['x', 'invalid', { code: '22P02' }], ['x', 'setup', { code: 'PGRST202' }],
    ['x', 'setup', { code: '42883' }], ['x', 'setup', { code: 'PGRST205' }], ['Failed to fetch', 'network'], ['Network request failed', 'network'],
    ['something odd', 'unknown'],
  ];
  for (const [text, kind, extra] of CASES) {
    it(`${text} ${extra?.code ? `(${extra.code}) ` : ''}-> ${kind}`, async () => {
      // the database text is mixed with an id, an amount and a name to prove none of it can reach the message
      const polluted = `${text} ${EXP} 123456 Asha Rao secret-note`;
      for (const run of [
        () => createExpense(fake(err(polluted, extra)).client, { tripId: TRIP, expenseId: EXP, draft: draft() }),
        () => updateExpense(fake(err(polluted, extra)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }),
        () => deleteExpense(fake(err(polluted, extra)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }),
        () => restoreExpense(fake(err(polluted, extra)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }),
        () => getTripBalances(fake(err(polluted, extra)).client, TRIP),
      ]) {
        const e = await rejection(run());
        expect(e).toBeInstanceOf(ExpenseError);
        expect(e.kind).toBe(kind);
        expect(e.message).toBe(EXPENSE_MESSAGES[kind]);
        expect(e.message + JSON.stringify(e)).not.toMatch(/123456|Asha|secret-note|7c9e6679/);
      }
    });
  }

  it('the single "no such trip / not a member" answer is the same sentence the trip screens use', () => {
    expect(EXPENSE_MESSAGES.unavailable).toBe(UNAVAILABLE_MESSAGE);
  });

  it('a former-member refusal carries the balance it would have left (for a helpful screen), only when the database said so', async () => {
    const e = await rejection(deleteExpense(fake(err('former_member_balance', { details: 'net_minor=-300' })).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }));
    expect(e.kind).toBe('former_member');
    expect(e.netMinor).toBe(-300);
    expect(e.message).toMatch(/left the trip/);
    expect((await rejection(deleteExpense(fake(err('former_member_balance')).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }))).netMinor).toBeNull();
    expect((await rejection(deleteExpense(fake(err('former_member_balance', { details: 'net_minor=abc' })).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }))).netMinor).toBeNull();
  });

  it('only a connection problem or an unknown failure of a write is flagged "outcome unknown"; a clear refusal never is', () => {
    const unknownKinds = (Object.keys(EXPENSE_MESSAGES) as ExpenseErrorKind[]).filter((k) => new ExpenseError(k, 'm').outcomeUnknown);
    expect(unknownKinds.sort()).toEqual(['network', 'unknown']);
  });

  it('a thrown failure from the client (no reply at all) is mapped the same way', async () => {
    const client = { rpc: () => { throw new Error('Failed to fetch'); } } as unknown as ExpenseClient;
    expect((await rejection(createExpense(client, { tripId: TRIP, expenseId: EXP, draft: draft() }))).kind).toBe('network');
  });
});

describe('updateExpense: stale versions', () => {
  it('sends the trip, the expense, the version the person was looking at and the replacement, and returns the new version', async () => {
    const { client, rpcCalls } = fake(changed(3));
    const r = await updateExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 2, draft: draft({ amountMinor: 1200, payers: [{ memberId: A, paidMinor: 1200 }] }) });
    expect(r).toEqual({ expenseId: EXP, version: 3, changed: true });
    expect(rpcCalls[0]!.fn).toBe('update_expense');
    expect(rpcCalls[0]!.args).toMatchObject({ p_trip_id: TRIP, p_expense_id: EXP, p_expected_version: 2, p_amount_minor: 1200, p_split_method: 'equal' });
  });

  it('a stale version is a clear "someone else changed it" refusal, and an unchanged edit is reported as not changed', async () => {
    const e = await rejection(updateExpense(fake(err('version_conflict')).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }));
    expect(e.kind).toBe('conflict');
    expect(e.message).toMatch(/Reload/);
    expect(e.outcomeUnknown).toBe(false);
    expect(await updateExpense(fake(changed(2, false)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 2, draft: draft() })).toEqual({ expenseId: EXP, version: 2, changed: false });
  });

  it('refuses a missing, zero, fractional or negative version and bad ids before sending', async () => {
    const { client, rpcCalls } = fake(changed());
    for (const expectedVersion of [0, -1, 1.5, Number.NaN, undefined as unknown as number]) expect((await rejection(updateExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion, draft: draft() }))).kind, String(expectedVersion)).toBe('invalid');
    expect((await rejection(updateExpense(client, { tripId: 'x', expenseId: EXP, expectedVersion: 1, draft: draft() }))).kind).toBe('unavailable');
    expect((await rejection(updateExpense(client, { tripId: TRIP, expenseId: 'x', expectedVersion: 1, draft: draft() }))).kind).toBe('not_found');
    expect((await rejection(updateExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft({ title: '' }) }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });

  it('permission, archived-trip, deleted-expense and former-member refusals each get their own sentence', async () => {
    for (const [text, kind] of [['not_allowed', 'not_allowed'], ['trip_archived', 'archived'], ['expense_deleted', 'deleted'], ['former_member_balance', 'former_member'], ['participant_not_active', 'participant_inactive']] as const) {
      expect((await rejection(updateExpense(fake(err(text)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() }))).kind).toBe(kind);
    }
  });
});

describe('deleteExpense and restoreExpense', () => {
  it('send only the trip, the expense and the version; repeating either is a safe "not changed"', async () => {
    const del = fake(changed(2));
    expect(await deleteExpense(del.client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 })).toEqual({ expenseId: EXP, version: 2, changed: true });
    expect(del.rpcCalls).toEqual([{ fn: 'delete_expense', args: { p_trip_id: TRIP, p_expense_id: EXP, p_expected_version: 1 } }]);
    const res = fake(changed(3));
    expect((await restoreExpense(res.client, { tripId: TRIP, expenseId: EXP, expectedVersion: 2 })).version).toBe(3);
    expect(res.rpcCalls).toEqual([{ fn: 'restore_expense', args: { p_trip_id: TRIP, p_expense_id: EXP, p_expected_version: 2 } }]);
    expect((await deleteExpense(fake(changed(2, false)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 2 })).changed).toBe(false);
  });

  it('stale version, archived trip, not allowed and the former-member rule are all clear refusals; bad input never reaches the server', async () => {
    for (const [text, kind] of [['version_conflict', 'conflict'], ['trip_archived', 'archived'], ['not_allowed', 'not_allowed'], ['former_member_balance', 'former_member'], ['outside_trip_dates', 'outside_dates'], ['expense_not_found', 'not_found']] as const) {
      expect((await rejection(deleteExpense(fake(err(text)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }))).kind).toBe(kind);
      expect((await rejection(restoreExpense(fake(err(text)).client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1 }))).kind).toBe(kind);
    }
    const { client, rpcCalls } = fake(changed());
    expect((await rejection(deleteExpense(client, { tripId: 'x', expenseId: EXP, expectedVersion: 1 }))).kind).toBe('unavailable');
    expect((await rejection(restoreExpense(client, { tripId: TRIP, expenseId: 'x', expectedVersion: 1 }))).kind).toBe('not_found');
    expect((await rejection(deleteExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 0 }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });
});

describe('reading expenses (direct reads under row-level security)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: EXP, trip_id: TRIP, title: 'Taxi', amount_minor: 600, category_id: 'cat1', spent_on: '2026-12-28', notes: null, split_method: 'equal', created_by: A, updated_by: null,
    created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-24T10:00:00Z', version: 1, deleted_at: null, deleted_by: null, ...over,
  });
  const payers = [{ expense_id: EXP, trip_member_id: A, paid_minor: 600 }];
  const shares = [{ expense_id: EXP, trip_member_id: B, share_minor: 300 }, { expense_id: EXP, trip_member_id: A, share_minor: 300 }];

  it('asks for named columns only (never "*"), filtered to this trip, newest day first, and joins the three reads', async () => {
    const { client, reads } = fake(undefined, { expenses: [row()], expense_payers: payers, expense_splits: shares });
    const list = await listExpenses(client, TRIP);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: EXP, amountMinor: 600, version: 1, deleted: false });
    expect(list[0]!.shares.map((s) => s.memberId)).toEqual([A, B]);
    expect(reads.map((r) => r.table)).toEqual(['expenses', 'expense_payers', 'expense_splits']);
    expect(reads[1]!.orders).toEqual([['expense_id', true], ['trip_member_id', true]]);
    expect(reads.map((r) => r.columns)).toEqual([EXPENSE_COLUMNS, PAYER_COLUMNS, SHARE_COLUMNS]);
    for (const r of reads) {
      expect(r.columns).not.toContain('*');
      expect(r.filters).toEqual([['trip_id', TRIP]]);
    }
    expect(reads[0]!.orders).toEqual([['spent_on', false], ['created_at', false], ['id', false]]); // unique tie-breaker last
    expect(reads.every((r) => r.counted && r.ranges.length === 1 && r.ranges[0]![0] === 0)).toBe(true);
  });

  it('never asks for another person\'s identity: no user id, email or name column is requested', () => {
    for (const columns of [EXPENSE_COLUMNS, PAYER_COLUMNS, SHARE_COLUMNS, CATEGORY_COLUMNS, REVISION_COLUMNS]) expect(columns).not.toMatch(/user_id|email|display_name|upi/i);
  });

  it('shows deleted expenses flagged (so they can be restored) and an empty trip as an empty list', async () => {
    const del = fake(undefined, { expenses: [row({ deleted_at: '2026-11-24T11:00:00Z', deleted_by: A })], expense_payers: payers, expense_splits: shares });
    expect((await listExpenses(del.client, TRIP))[0]!.deleted).toBe(true);
    expect(await listExpenses(fake().client, TRIP)).toEqual([]);
  });

  it('when the three reads disagree (a change landed between them) it reads again once and then succeeds', async () => {
    const { client, reads } = fake(undefined, {
      readReplies: [
        { data: [row()], error: null }, { data: [], error: null }, { data: shares, error: null }, // first round: no payers
        { data: [row()], error: null }, { data: payers, error: null }, { data: shares, error: null }, // second round: consistent
      ],
    });
    expect(await listExpenses(client, TRIP)).toHaveLength(1);
    expect(reads).toHaveLength(6);
  });

  it('gives up with "unknown" if they still disagree on the third try (never shows half an expense)', async () => {
    const bad = { readReplies: Array.from({ length: 3 }, () => [{ data: [row()], error: null }, { data: [] as unknown[], error: null }, { data: shares, error: null }]).flat() };
    expect((await rejection(listExpenses(fake(undefined, bad).client, TRIP))).kind).toBe('unknown');
  });

  describe('paging (a trip holds up to 2,000 expenses; one response holds at most 1,000 rows)', () => {
    const PAGE = 1000;
    const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    /** n expenses, each paid and shared by A alone, on days that repeat so ordering has to use the tie-breakers. */
    const world = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => {
      const expenses = Array.from({ length: n }, (_, i) => row({ id: id(i + 1), title: `E${i}`, amount_minor: 100 + (i % 7), spent_on: `2026-12-${String(1 + (i % 28)).padStart(2, '0')}`, created_at: `2026-11-24T10:${String(i % 60).padStart(2, '0')}:00Z`, ...over(i) }));
      const payersFor = expenses.map((e) => ({ expense_id: e.id, trip_member_id: A, paid_minor: e.amount_minor }));
      const sharesFor = expenses.map((e) => ({ expense_id: e.id, trip_member_id: A, share_minor: e.amount_minor }));
      return { expenses, expense_payers: payersFor, expense_splits: sharesFor };
    };
    const sum = (list: { amountMinor: number; deleted: boolean }[]) => list.filter((e) => !e.deleted).reduce((a, e) => a + e.amountMinor, 0);

    it('an empty trip is an empty list from one page of each table', async () => {
      const { client, reads } = fake(undefined, world(0));
      expect(await listExpenses(client, TRIP)).toEqual([]);
      expect(reads).toHaveLength(3);
    });

    it('one expense', async () => {
      expect(await listExpenses(fake(undefined, world(1)).client, TRIP)).toHaveLength(1);
    });

    it('exactly one page (1,000) needs no second request per table when the total is reached', async () => {
      const { client, reads } = fake(undefined, world(PAGE));
      expect(await listExpenses(client, TRIP)).toHaveLength(PAGE);
      expect(reads).toHaveLength(3);
    });

    it('one more than a page (1,001) takes a second page and loses nothing', async () => {
      const w = world(PAGE + 1);
      const { client, reads } = fake(undefined, w);
      const list = await listExpenses(client, TRIP);
      expect(list).toHaveLength(PAGE + 1);
      expect(new Set(list.map((e) => e.id)).size).toBe(PAGE + 1);
      expect(reads.filter((r) => r.table === 'expenses').map((r) => r.ranges[0])).toEqual([[0, 999], [1000, 1999]]);
    });

    it('the supported maximum of 2,000 expenses is complete, unique and its totals are exact', async () => {
      const w = world(2000);
      const { client, reads } = fake(undefined, w);
      const list = await listExpenses(client, TRIP);
      expect(list).toHaveLength(2000);
      expect(new Set(list.map((e) => e.id)).size).toBe(2000);
      expect(sum(list)).toBe(w.expenses.reduce((a, e) => a + (e.amount_minor as number), 0));
      expect(reads.filter((r) => r.table === 'expenses')).toHaveLength(2);
      expect(reads.filter((r) => r.table === 'expense_payers')).toHaveLength(2);
    });

    it('payers and shares from several pages are joined to the right expenses', async () => {
      const list = await listExpenses(fake(undefined, world(1200)).client, TRIP);
      for (const e of list) {
        expect(e.payers.map((p) => p.paidMinor)).toEqual([e.amountMinor]);
        expect(e.shares.map((s) => s.shareMinor)).toEqual([e.amountMinor]);
      }
    });

    it('a server that returns fewer rows per page than asked is still read to the end (paging follows the total, not the page length)', async () => {
      const w = world(250);
      const { client } = fake(undefined, w);
      type Q = Record<string, (...a: unknown[]) => Q>;
      const wrap = (inner: Q): Q => ({
        ...inner,
        eq: (...a: unknown[]) => wrap(inner.eq!(...a)),
        order: (...a: unknown[]) => wrap(inner.order!(...a)),
        range: (from: unknown, to: unknown) => wrap(inner.range!(from, Math.min(to as number, (from as number) + 99))), // never more than 100 rows
      });
      const capped = {
        ...client,
        from: (table: string) => ({ select: (columns: string, options?: unknown) => wrap((client.from as unknown as (t: string) => { select: (c: string, o?: unknown) => Q })(table).select(columns, options)) }),
      } as unknown as ExpenseClient;
      expect(await listExpenses(capped, TRIP)).toHaveLength(250);
    });

    it('the pages meet without overlap or gap', async () => {
      const list = await listExpenses(fake(undefined, world(1500)).client, TRIP);
      expect(new Set(list.map((e) => e.id)).size).toBe(1500);
    });

    it('a failure while fetching a LATER page fails the whole read (no partial list), with the same error kinds as before', async () => {
      const w = world(1500);
      const firstPage: PgReply = { data: w.expenses.slice(0, PAGE), error: null, count: 1500 };
      expect((await rejection(listExpenses(fake(undefined, { ...w, readReplies: [firstPage, err('Failed to fetch')] }).client, TRIP))).kind).toBe('network');
      expect((await rejection(listExpenses(fake(undefined, { ...w, readReplies: [firstPage, err('x', { code: '42501' })] }).client, TRIP))).kind).toBe('auth');
    });

    it('if the total changes between pages the read starts again and then succeeds with the complete data', async () => {
      const w = world(1500);
      const first: PgReply = { data: w.expenses.slice(0, PAGE), error: null, count: 1500 };
      const moved: PgReply = { data: w.expenses.slice(PAGE, 1501), error: null, count: 1501 }; // someone added an expense meanwhile
      expect(await listExpenses(fake(undefined, { ...w, readReplies: [first, moved] }).client, TRIP)).toHaveLength(1500);
    });

    it('a row that appears on two pages (the data shifted under the pages) is never returned twice: the read starts again', async () => {
      const w = world(1500);
      const first: PgReply = { data: w.expenses.slice(0, PAGE), error: null, count: 1500 };
      const overlapping: PgReply = { data: w.expenses.slice(PAGE - 1, 1500), error: null, count: 1500 }; // starts one row early
      const list = await listExpenses(fake(undefined, { ...w, readReplies: [first, overlapping] }).client, TRIP);
      expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
      expect(list).toHaveLength(1500);
    });

    it('a short page before the total is reached (a row went missing) is never accepted as complete', async () => {
      const w = world(1500);
      const first: PgReply = { data: w.expenses.slice(0, PAGE), error: null, count: 1500 };
      const empty: PgReply = { data: [], error: null, count: 1500 };
      const stuck = Array.from({ length: 3 }, () => [first, empty]).flat();
      expect((await rejection(listExpenses(fake(undefined, { ...w, readReplies: stuck }).client, TRIP))).kind).toBe('unknown');
    });

    it('without an exact total the read cannot prove it is complete, so it fails instead of guessing', async () => {
      const w = world(3);
      const noCount: PgReply = { data: w.expenses, error: null, count: null };
      expect((await rejection(listExpenses(fake(undefined, { ...w, readReplies: [noCount] }).client, TRIP))).kind).toBe('unknown');
    });

    it('deleted expenses stay in the list (flagged) but are not in the active total', async () => {
      const w = world(1200, (i) => (i % 10 === 0 ? { deleted_at: '2026-11-25T10:00:00Z', deleted_by: A } : {}));
      const list = await listExpenses(fake(undefined, w).client, TRIP);
      expect(list).toHaveLength(1200);
      expect(list.filter((e) => e.deleted)).toHaveLength(120);
      expect(sum(list)).toBe(w.expenses.filter((e) => !e.deleted_at).reduce((a, e) => a + (e.amount_minor as number), 0));
    });
  });

  it('maps read failures like write failures, and a trip the database hides as the single "unavailable" answer', async () => {
    expect((await rejection(listExpenses(fake(undefined, { readReplies: [err('Failed to fetch')] }).client, TRIP))).kind).toBe('network');
    expect((await rejection(listExpenses(fake(undefined, { readReplies: [err('x', { code: 'PGRST205' })] }).client, TRIP))).kind).toBe('setup');
    expect((await rejection(listExpenses(fake(undefined, { readReplies: [err('x', { code: '42501' })] }).client, TRIP))).kind).toBe('auth');
    expect((await rejection(listExpenses(fake().client, 'not-a-trip'))).kind).toBe('unavailable');
    expect((await rejection(listExpenses(fake().client, 'not-a-trip'))).message).toBe(UNAVAILABLE_MESSAGE);
  });

  it('getExpense finds one expense of the trip (any letter case) and answers "not found" the same way for anything else', async () => {
    const { client } = fake(undefined, { expenses: [row()], expense_payers: payers, expense_splits: shares });
    expect((await getExpense(client, TRIP, EXP.toUpperCase())).id).toBe(EXP);
    const other = '11111111-2222-4333-8444-555555555555';
    const miss = await rejection(getExpense(client, TRIP, other));
    expect(miss.kind).toBe('not_found');
    expect((await rejection(getExpense(client, TRIP, 'x'))).message).toBe(miss.message);
    expect((await rejection(getExpense(client, 'x', EXP))).kind).toBe('unavailable');
  });

  it('lists the system categories in display order, with named columns', async () => {
    const { client, reads } = fake(undefined, { categories: [{ id: 'c1', key: 'food', name: 'Food', icon: 'utensils', sort_order: 30 }] });
    expect(await listCategories(client)).toEqual([{ id: 'c1', key: 'food', name: 'Food', icon: 'utensils' }]);
    expect(reads[0]).toMatchObject({ table: 'categories', columns: CATEGORY_COLUMNS, orders: [['sort_order', true]] });
  });
});

describe('getTripBalances', () => {
  it('asks only for this trip and returns what the database computed, former members included', async () => {
    const { client, rpcCalls } = fake({ data: [{ member_id: A, paid_minor: 1000, share_minor: 334, net_minor: 666 }, { member_id: B, paid_minor: 0, share_minor: 333, net_minor: -333 }], error: null });
    const lines = await getTripBalances(client, TRIP);
    expect(lines).toEqual([{ memberId: A, paidMinor: 1000, shareMinor: 334, netMinor: 666 }, { memberId: B, paidMinor: 0, shareMinor: 333, netMinor: -333 }]);
    expect(rpcCalls).toEqual([{ fn: 'trip_member_balances', args: { p_trip_id: TRIP } }]);
  });

  it('a stranger, a former member or a signed-out caller gets the single unavailable or sign-in answer; an empty answer is an empty list', async () => {
    expect((await rejection(getTripBalances(fake(err('trip_not_found')).client, TRIP))).kind).toBe('unavailable');
    expect((await rejection(getTripBalances(fake(err('permission denied', { code: '42501' })).client, TRIP))).kind).toBe('auth');
    expect(await getTripBalances(fake({ data: [], error: null }).client, TRIP)).toEqual([]);
    expect((await rejection(getTripBalances(fake().client, 'x'))).kind).toBe('unavailable');
  });

  it('refuses rows that are not real numbers (never shows a made-up balance)', async () => {
    for (const data of [[{ member_id: A, paid_minor: '1', share_minor: 0, net_minor: 1 }], [{ member_id: A, paid_minor: 1.5, share_minor: 0, net_minor: 1 }], [{ paid_minor: 1, share_minor: 0, net_minor: 1 }], [null]]) {
      expect((await rejection(getTripBalances(fake({ data, error: null }).client, TRIP))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });
});

describe('split methods through the service', () => {
  const exactDraft = draft({ splitMethod: 'exact', splitInputs: [{ memberId: A, value: 0 }, { memberId: B, value: 700 }, { memberId: C, value: 300 }] });

  it('create and update send the method and the typed values (never a share) and nothing else new', async () => {
    const c = fake(created);
    await createExpense(c.client, { tripId: TRIP, expenseId: EXP, draft: exactDraft });
    expect(c.rpcCalls[0]!.args).toMatchObject({ p_split_method: 'exact', p_split_inputs: [{ member_id: A, value: 0 }, { member_id: B, value: 700 }, { member_id: C, value: 300 }] });
    expect(Object.keys(c.rpcCalls[0]!.args).join()).not.toMatch(/share/i);
    const u = fake(changed(2));
    await updateExpense(u.client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 2 }, { memberId: B, value: 1 }, { memberId: C, value: 1 }] }) });
    expect(u.rpcCalls[0]!.args).toMatchObject({ p_split_method: 'shares', p_expected_version: 1 });
    expect((u.rpcCalls[0]!.args.p_split_inputs as unknown[]).length).toBe(3);
  });

  it('a split that does not add up is stopped with its own sentence BEFORE anything is sent', async () => {
    const { client, rpcCalls } = fake(created);
    const bad = (d: ExpenseDraft) => rejection(createExpense(client, { tripId: TRIP, expenseId: EXP, draft: d }));
    expect((await bad(draft({ splitMethod: 'exact', splitInputs: [{ memberId: A, value: 500 }, { memberId: B, value: 400 }, { memberId: C, value: 0 }] }))).message).toMatch(/add up to the total/);
    expect((await bad(draft({ splitMethod: 'percentage', splitInputs: [{ memberId: A, value: 5000 }, { memberId: B, value: 4000 }, { memberId: C, value: 999 }] }))).message).toBe('The percentages have to add up to 100%.');
    expect((await bad(draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 0 }, { memberId: B, value: 1 }, { memberId: C, value: 1 }] }))).message).toMatch(/whole number/);
    expect((await bad(draft({ splitMethod: 'shares' }))).kind).toBe('invalid');
    expect(rpcCalls).toEqual([]);
  });

  it('the database\'s own split refusals read plainly, and the typed sentences are fixed (never raw text)', async () => {
    for (const [text, kind] of [['split_total_mismatch', 'split_total'], ['invalid_split_value', 'split_value']] as const) {
      const e = await rejection(createExpense(fake(err(`${text} ${EXP} 5000`)).client, { tripId: TRIP, expenseId: EXP, draft: exactDraft }));
      expect(e.kind).toBe(kind);
      expect(e.message).toBe(EXPENSE_MESSAGES[kind]);
      expect(e.message).not.toMatch(/5000|7c9e6679/);
    }
  });

  it('stored expenses come back with their method and the typed value of each person', async () => {
    const rows = [{ id: EXP, trip_id: TRIP, title: 'Rent', amount_minor: 1000, category_id: null, spent_on: '2026-12-28', notes: null, split_method: 'percentage', created_by: A, updated_by: null, created_at: '2026-11-25T10:00:00Z', updated_at: '2026-11-25T10:00:00Z', version: 1, deleted_at: null, deleted_by: null }];
    const { client, reads } = fake(undefined, {
      expenses: rows,
      expense_payers: [{ expense_id: EXP, trip_member_id: A, paid_minor: 1000 }],
      expense_splits: [{ expense_id: EXP, trip_member_id: A, share_minor: 600, input_value: 6000 }, { expense_id: EXP, trip_member_id: B, share_minor: 400, input_value: 4000 }],
    });
    const [e] = await listExpenses(client, TRIP);
    expect(e).toMatchObject({ splitMethod: 'percentage' });
    expect(e!.shares).toEqual([{ memberId: A, shareMinor: 600, inputValue: 6000 }, { memberId: B, shareMinor: 400, inputValue: 4000 }]);
    expect(reads[2]!.columns).toContain('input_value');
  });
});

describe('expense history', () => {
  const rev = (version: number, action: string, changedBy = A) => ({
    version, action, changed_by: changedBy, changed_at: '2026-11-25T10:15:00Z',
    snapshot: { title: 'Dinner', amount_minor: 1000, spent_on: '2026-12-28', category_key: 'food', notes: null, split_method: 'equal', payers: [{ member_id: A, paid_minor: 1000 }], splits: [{ member_id: A, share_minor: 500 }, { member_id: B, share_minor: 500 }], deleted: action === 'delete' },
  });

  it('asks only for the named history columns of THIS expense in THIS trip, oldest first, and reads them', async () => {
    const { client, reads } = fake(undefined, { expense_revisions: [rev(1, 'create'), rev(2, 'update', B)] });
    const list = await getExpenseHistory(client, TRIP, EXP.toUpperCase());
    expect(list.map((r) => [r.version, r.action, r.changedBy])).toEqual([[1, 'create', A], [2, 'update', B]]);
    expect(list[0]!.snapshot?.title).toBe('Dinner');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ table: 'expense_revisions', columns: REVISION_COLUMNS, orders: [['version', true]] });
    expect(reads[0]!.filters).toEqual([['trip_id', TRIP], ['expense_id', EXP]]);
    expect(reads[0]!.columns).not.toContain('*');
  });

  it('a stranger, a former member or an expense with no history gets an empty list, never an error that reveals anything', async () => {
    expect(await getExpenseHistory(fake().client, TRIP, EXP)).toEqual([]);
  });

  it('refuses bad ids before asking, and maps read failures like the other reads', async () => {
    const { client, reads } = fake();
    expect((await rejection(getExpenseHistory(client, 'x', EXP))).kind).toBe('unavailable');
    expect((await rejection(getExpenseHistory(client, TRIP, 'x'))).kind).toBe('not_found');
    expect(reads).toEqual([]);
    expect((await rejection(getExpenseHistory(fake(undefined, { readReplies: [err('Failed to fetch')] }).client, TRIP, EXP))).kind).toBe('network');
    expect((await rejection(getExpenseHistory(fake(undefined, { readReplies: [err('x', { code: '42501' })] }).client, TRIP, EXP))).kind).toBe('auth');
  });

  it('the app has no way to change or delete a revision: the table handle it uses offers only select, and no history function exists', async () => {
    const { client } = fake(undefined, { expense_revisions: [] });
    const handle = (client as unknown as { from: (t: string) => object }).from('expense_revisions');
    expect(Object.keys(handle)).toEqual(['select']);
    const src = (await import('./expenseService')) as Record<string, unknown>;
    expect(Object.keys(src).filter((k) => /revision|history/i.test(k)).sort()).toEqual(['REVISION_COLUMNS', 'getExpenseHistory']);
  });
});

describe('what this layer never does', () => {
  it('writes only through the four database functions: with a client whose table access explodes, every write and the balances still work', async () => {
    const calls: string[] = [];
    const client = {
      rpc: (fn: string) => { calls.push(fn); return Promise.resolve(fn === 'create_expense' ? created : fn === 'trip_member_balances' ? { data: [], error: null } : changed()); },
      from: () => { throw new Error('a write must never touch a table directly'); },
    } as unknown as ExpenseClient;
    await createExpense(client, { tripId: TRIP, expenseId: EXP, draft: draft() });
    await updateExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 1, draft: draft() });
    await deleteExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 2 });
    await restoreExpense(client, { tripId: TRIP, expenseId: EXP, expectedVersion: 3 });
    await getTripBalances(client, TRIP);
    expect(calls).toEqual(['create_expense', 'update_expense', 'delete_expense', 'restore_expense', 'trip_member_balances']);
  });

  it('reads only ever select: the table handle it is given offers no write method to call, and the reads work without one', async () => {
    const { client } = fake(undefined, { expenses: [], expense_payers: [], expense_splits: [] });
    const handle = (client as unknown as { from: (t: string) => object }).from('expenses');
    expect(Object.keys(handle)).toEqual(['select']);
    expect(await listExpenses(client, TRIP)).toEqual([]);
  });
});
