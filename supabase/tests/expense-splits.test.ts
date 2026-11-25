import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense } from '../../packages/core/src/balances';
import { computeSplit, type SplitSpec } from '../../packages/core/src/split';
import { BAD_SPLIT_VECTORS, SPLIT_VECTORS, type SplitMethodName } from '../../packages/core/test-fixtures/expenseVectors';
import { TestUsers, newDatabase } from './harness';

/**
 * M5 Checkpoint 5 (ADR-063): exact, percentage and shares splits, derived and checked by the database.
 *
 * The rules under test (migration 20261125000000):
 *   exact       typed amounts, which must add up to the total (a person may owe zero)
 *   percentage  typed basis points (100% = 10000), 1 to 10000 each, adding up to exactly 10000
 *   shares      typed whole weights, 1 to 1000000 each
 *   percentage and shares use the approved largest-remainder rule (weights; biggest remainder first; the lowest member id on a tie),
 *   which is the SAME rule as the equal split and as the TypeScript engine; the vectors and random cases below prove the agreement.
 * The app never sends a share: only the method and each person's typed value.
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'trip_archived', 'expense_not_found', 'not_allowed', 'version_conflict', 'expense_deleted', 'expense_id_taken',
  'invalid_expense', 'payers_total_mismatch', 'split_total_mismatch', 'invalid_split_value', 'split_not_derived', 'shares_not_equal_split', 'participant_not_active',
  'payer_not_active', 'former_member_balance', 'balance_not_settled',
];
async function outcome(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return TOKENS.find((t) => text.includes(t)) ?? (/permission denied/i.test(text) ? 'permission denied' : text);
  }
}
const q = async <T = Record<string, any>>(who: string | null, sql: string, args: unknown[] = []) => {
  if (who === null) await users.asAnon();
  else await users.asUser(who);
  return db.query<T>(sql, args);
};
const admin = async () => {
  await users.asAdmin();
  return db;
};

type Method = SplitMethodName;
interface Exp {
  title?: string;
  amount: number;
  participants: string[];
  payers: Record<string, number>;
  method?: Method;
  inputs?: Record<string, number> | unknown;
}
const payersJson = (p: Record<string, number>) => JSON.stringify(Object.entries(p).map(([member_id, paid_minor]) => ({ member_id, paid_minor })));
const inputsJson = (m: unknown) => {
  if (m === undefined || m === null) return null;
  if (typeof m === 'object' && !Array.isArray(m)) return JSON.stringify(Object.entries(m as Record<string, number>).map(([member_id, value]) => ({ member_id, value })));
  return JSON.stringify(m); // a deliberately malformed value, sent as is
};
const CREATE = 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)';
const UPDATE = 'select * from public.update_expense($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6::date, $7, $8, $9, $10::uuid[], $11::jsonb, $12::jsonb)';
const create = (who: string | null, trip: string, id: string, e: Exp) =>
  q<{ expense_id: string; version: number; created: boolean }>(who, CREATE, [trip, id, e.title ?? 'Dinner', e.amount, '2026-12-28', 'food', null, e.method ?? 'equal', e.participants, payersJson(e.payers), inputsJson(e.inputs)]);
const update = (who: string | null, trip: string, id: string, version: number, e: Exp) =>
  q<{ expense_id: string; version: number; changed: boolean }>(who, UPDATE, [trip, id, version, e.title ?? 'Dinner', e.amount, '2026-12-28', 'food', null, e.method ?? 'equal', e.participants, payersJson(e.payers), inputsJson(e.inputs)]);
const del = (who: string, trip: string, id: string, version: number) => q<{ version: number }>(who, 'select * from public.delete_expense($1, $2, $3)', [trip, id, version]);
const restore = (who: string, trip: string, id: string, version: number) => q<{ version: number }>(who, 'select * from public.restore_expense($1, $2, $3)', [trip, id, version]);
const balances = (who: string, trip: string) => q<{ member_id: string; net_minor: number }>(who, 'select * from public.trip_member_balances($1)', [trip]);
const newId = () => randomUUID();

async function makeTrip(creator: string, name: string): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip($1, 'Somewhere', '2026-12-27', '2026-12-30')`, [name])).rows[0]!.id;
}
async function put(trip: string, userId: string | null, name: string, over: { status?: string } = {}): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>(
    `insert into public.trip_members (trip_id, user_id, display_name, role, status, left_at) values ($1, $2, $3, 'member', $4, case when $4 = 'active' then null else now() end) returning id`,
    [trip, userId, name, over.status ?? 'active'],
  )).rows[0]!.id;
}
async function memberOf(trip: string, userId: string): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>('select id from public.trip_members where trip_id = $1 and user_id = $2', [trip, userId])).rows[0]!.id;
}
async function stored(id: string) {
  await admin();
  const e = (await db.query<Record<string, any>>('select * from public.expenses where id = $1', [id])).rows[0]!;
  const sp = (await db.query<{ trip_member_id: string; share_minor: number; input_value: number | null }>('select trip_member_id, share_minor, input_value from public.expense_splits where expense_id = $1 order by trip_member_id::text collate "C"', [id])).rows;
  return { expense: e, splits: sp };
}
async function revisions(id: string) {
  await admin();
  return (await db.query<{ version: number; action: string; snapshot: Record<string, any> }>('select version, action, snapshot from public.expense_revisions where expense_id = $1 order by version', [id])).rows;
}
const specFor = (method: Method, participants: readonly string[], inputs: Record<string, number> | undefined): SplitSpec => {
  if (method === 'equal') return { method, participants };
  const v = (id: string) => inputs![id]!;
  if (method === 'percentage') return { method, inputs: participants.map((memberId) => ({ memberId, basisPoints: v(memberId) })) };
  if (method === 'exact') return { method, inputs: participants.map((memberId) => ({ memberId, amountMinor: v(memberId) })) };
  return { method, inputs: participants.map((memberId) => ({ memberId, weight: v(memberId) })) };
};
const byC = (ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** What the database derives, straight from the internal function (as the owner). */
async function derive(method: string, amount: number, inputs: Record<string, number>) {
  await admin();
  const ids = byC(Object.keys(inputs));
  const r = await db.query<{ member_id: string; share_minor: number; input_value: number | null }>(
    'select * from public.expense_derive_shares($1, $2::bigint, $3::uuid[], $4::bigint[])', [method, amount, ids, ids.map((i) => inputs[i]!)]);
  return r.rows;
}

let asha: string;
let ravi: string;
let nina: string;
let dev: string;
let meera: string;
interface Setup { trip: string; a: string; r: string; n: string }
async function setup(name: string): Promise<Setup> {
  const trip = await makeTrip(asha, name);
  return { trip, a: await memberOf(trip, asha), r: await put(trip, ravi, 'Ravi Kumar'), n: await put(trip, nina, 'Nina Shah') };
}
const all = (s: Setup) => [s.a, s.r, s.n];

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  nina = await users.signUp('nina@example.com', 'Nina Shah');
  dev = await users.signUp('dev@example.com', 'Departed Dev');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('rollback').catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------------
describe('derivation: the hand-verified golden vectors (database side)', () => {
  for (const v of SPLIT_VECTORS.filter((x) => x.method && x.method !== 'equal')) {
    it(v.name, async () => {
      const rows = await derive(v.method!, v.amountMinor, v.inputs!);
      expect(Object.fromEntries(rows.map((r) => [r.member_id, r.share_minor]))).toEqual(v.shares);
      expect(Object.fromEntries(rows.map((r) => [r.member_id, r.input_value]))).toEqual(v.inputs); // the typed value is kept as typed
    });
  }

  for (const v of BAD_SPLIT_VECTORS) {
    it(`refuses: ${v.name}`, async () => {
      expect(await outcome(derive(v.method, v.amountMinor, v.inputs))).toBe(v.code);
    });
  }

  it('the equal split is the same rule as shares 1 : 1 : ... (so one allocation serves both)', async () => {
    await admin();
    for (const amount of [1, 2, 7, 99, 100, 1001, 123_456_789, 1_000_000_000_000]) {
      for (const n of [1, 2, 3, 4, 7, 11]) {
        const ids = Array.from({ length: n }, () => randomUUID());
        const eq = (await db.query('select * from public.allocate_equal($1::bigint, $2::uuid[])', [amount, ids])).rows;
        const wt = (await db.query('select * from public.allocate_weighted($1::bigint, $2::uuid[], $3::bigint[])', [amount, ids, ids.map(() => 1)])).rows;
        expect(wt, `${amount} among ${n}`).toEqual(eq);
      }
    }
  });

  it('allocate_weighted refuses a missing weight, a zero weight, duplicates, nobody, a mismatched list and a negative total', async () => {
    await admin();
    const id = randomUUID();
    const id2 = randomUUID();
    const call = (total: number, ids: string[], w: (number | null)[]) => outcome(db.query('select * from public.allocate_weighted($1::bigint, $2::uuid[], $3::bigint[])', [total, ids, w]));
    expect(await call(100, [id, id2], [1, 0])).toBe('invalid_split_value');
    expect(await call(100, [id, id2], [1, null])).toBe('invalid_split_value');
    expect(await call(100, [id, id], [1, 1])).toBe('invalid_expense');
    expect(await call(100, [], [])).toBe('invalid_expense');
    expect(await call(100, [id, id2], [1])).toBe('invalid_expense');
    expect(await call(-1, [id], [1])).toBe('invalid_expense');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('parity: SQL and TypeScript agree on thousands of random cases', () => {
  const lcg = (seed: number) => {
    let state = seed;
    return () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };

  it('percentage: 1500 random splits of random amounts', async () => {
    const rand = lcg(101);
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(rand() * 9);
      const ids = Array.from({ length: n }, () => randomUUID());
      // random basis points that add up to exactly 10000, each at least 1
      const cuts = new Set<number>();
      while (cuts.size < n - 1) cuts.add(1 + Math.floor(rand() * 9999));
      const edges = [0, ...[...cuts].sort((a, b) => a - b), 10000];
      const inputs = Object.fromEntries(ids.map((id, k) => [id, edges[k + 1]! - edges[k]!]));
      const amount = 1 + Math.floor(rand() * [50, 5000, 5_000_000, 1_000_000_000_000][Math.floor(rand() * 4)]!);
      const sql = Object.fromEntries((await derive('percentage', amount, inputs)).map((r) => [r.member_id, r.share_minor]));
      const ts = Object.fromEntries(computeSplit(amount, specFor('percentage', ids, inputs)).map((r) => [r.memberId, r.shareMinor]));
      expect(sql, `${amount} ${JSON.stringify(inputs)}`).toEqual(ts);
    }
  });

  it('shares: 1500 random weights (1 to 1,000,000) and amounts', async () => {
    const rand = lcg(202);
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(rand() * 9);
      const ids = Array.from({ length: n }, () => randomUUID());
      const inputs = Object.fromEntries(ids.map((id) => [id, 1 + Math.floor(rand() * [3, 10, 1000, 1_000_000][Math.floor(rand() * 4)]!)]));
      const amount = 1 + Math.floor(rand() * [50, 5000, 5_000_000, 1_000_000_000_000][Math.floor(rand() * 4)]!);
      const sql = Object.fromEntries((await derive('shares', amount, inputs)).map((r) => [r.member_id, r.share_minor]));
      const ts = Object.fromEntries(computeSplit(amount, specFor('shares', ids, inputs)).map((r) => [r.memberId, r.shareMinor]));
      expect(sql, `${amount} ${JSON.stringify(inputs)}`).toEqual(ts);
    }
  });

  it('exact: 500 random splits that add up (zeros allowed)', async () => {
    const rand = lcg(303);
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(rand() * 9);
      const ids = Array.from({ length: n }, () => randomUUID());
      const amount = 1 + Math.floor(rand() * 1_000_000);
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * (amount + 1))).sort((a, b) => a - b);
      const edges = [0, ...cuts, amount];
      const inputs = Object.fromEntries(ids.map((id, k) => [id, edges[k + 1]! - edges[k]!]));
      const sql = Object.fromEntries((await derive('exact', amount, inputs)).map((r) => [r.member_id, r.share_minor]));
      const ts = Object.fromEntries(computeSplit(amount, specFor('exact', ids, inputs)).map((r) => [r.memberId, r.shareMinor]));
      expect(sql).toEqual(ts);
      expect(Object.values(sql).reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('create_expense with each method', () => {
  it('stores the method, the typed values and the shares the database derived; the history snapshot holds them too', async () => {
    const s = await setup('Create methods');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const cases: [Method, Record<string, number> | undefined, number, number[]][] = [
      ['equal', undefined, 1000, [334, 333, 333]],
      ['exact', { [lo]: 0, [mid]: 700, [hi]: 300 }, 1000, [0, 700, 300]],
      ['percentage', { [lo]: 3333, [mid]: 3333, [hi]: 3334 }, 1000, [333, 333, 334]],
      ['shares', { [lo]: 2, [mid]: 1, [hi]: 1 }, 1000, [500, 250, 250]],
    ];
    for (const [method, inputs, amount, expected] of cases) {
      const id = newId();
      expect((await create(asha, s.trip, id, { amount, participants: all(s), payers: { [s.a]: amount }, method, inputs })).rows[0]).toEqual({ expense_id: id, version: 1, created: true });
      const { expense, splits } = await stored(id);
      expect(expense.split_method, method).toBe(method);
      expect(splits.map((x) => x.share_minor), method).toEqual(expected);
      expect(splits.map((x) => (x.input_value === null ? null : Number(x.input_value))), method).toEqual(method === 'equal' ? [null, null, null] : byC(Object.keys(inputs!)).map((k) => inputs![k]));
      const snap = (await revisions(id))[0]!.snapshot;
      expect(snap.split_method).toBe(method);
      expect(snap.splits.map((x: any) => x.share_minor)).toEqual(expected);
      if (method !== 'equal') expect(snap.splits.map((x: any) => x.input_value)).toEqual(byC(Object.keys(inputs!)).map((k) => inputs![k]));
      else expect(snap.splits.every((x: any) => !('input_value' in x))).toBe(true);
    }
  });

  it('a subset of the trip can share, and several payers still work with every method', async () => {
    const s = await setup('Subset');
    const [lo, hi] = byC([s.a, s.r]) as [string, string];
    const id = newId();
    await create(asha, s.trip, id, { amount: 999, participants: [s.a, s.r], payers: { [s.a]: 500, [s.n]: 499 }, method: 'percentage', inputs: { [lo]: 6000, [hi]: 4000 } });
    const { splits } = await stored(id);
    expect(splits.map((x) => x.trip_member_id)).toEqual([lo, hi]);
    expect(splits.reduce((a, x) => a + x.share_minor, 0)).toBe(999);
    expect((await balances(asha, s.trip)).rows.reduce((a, r) => a + r.net_minor, 0)).toBe(0);
  });

  it('refuses typed values the database cannot accept, each with a clear code, and writes nothing', async () => {
    const s = await setup('Refusals');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const send = (method: Method, inputs: unknown, over: Partial<Exp> = {}) => outcome(create(asha, s.trip, newId(), { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method, inputs, ...over }));
    expect(await send('exact', { [lo]: 500, [mid]: 499, [hi]: 0 })).toBe('split_total_mismatch');
    expect(await send('exact', { [lo]: 500, [mid]: 501, [hi]: 1 })).toBe('split_total_mismatch');
    expect(await send('exact', { [lo]: -1, [mid]: 1001, [hi]: 0 })).toBe('invalid_split_value');
    expect(await send('percentage', { [lo]: 5000, [mid]: 4000, [hi]: 999 })).toBe('split_total_mismatch');
    expect(await send('percentage', { [lo]: 10000, [mid]: 0, [hi]: 0 })).toBe('invalid_split_value');
    expect(await send('percentage', { [lo]: 10001, [mid]: 1, [hi]: 1 })).toBe('invalid_split_value');
    expect(await send('shares', { [lo]: 1, [mid]: 0, [hi]: 1 })).toBe('invalid_split_value');
    expect(await send('shares', { [lo]: 1, [mid]: 1_000_001, [hi]: 1 })).toBe('invalid_split_value');
    expect(await send('weird' as Method, { [lo]: 1, [mid]: 1, [hi]: 1 })).toBe('invalid_expense');
    // shape
    expect(await send('shares', undefined)).toBe('invalid_expense'); // a typed method needs its values
    expect(await send('equal', { [lo]: 1, [mid]: 1, [hi]: 1 })).toBe('invalid_expense'); // equal takes none
    expect(await send('shares', { [lo]: 1, [mid]: 1 })).toBe('invalid_expense'); // someone sharing has no value
    expect(await send('shares', { [lo]: 1, [mid]: 1, [hi]: 1, [randomUUID()]: 1 })).toBe('invalid_expense'); // a value for someone not sharing
    expect(await send('shares', [{ member_id: lo, value: 1 }, { member_id: lo, value: 1 }, { member_id: mid, value: 1 }])).toBe('invalid_expense'); // the same person twice
    // the same NUMBER of values, but for someone who is not sharing: that person must never be handed a share in place of a participant
    expect(await send('shares', { [s.a]: 1, [s.n]: 1 }, { participants: [s.a, s.r] })).toBe('invalid_expense');
    expect(await send('percentage', { [s.a]: 5000, [s.n]: 5000 }, { participants: [s.a, s.r] })).toBe('invalid_expense');
    expect(await send('exact', { [s.a]: 500, [s.n]: 500 }, { participants: [s.a, s.r] })).toBe('invalid_expense');
    expect(await send('shares', { x: 1 })).toBe('invalid_expense');
    expect(await send('shares', 'not a list')).toBe('invalid_expense');
    expect(await send('shares', [{ member_id: lo, value: 1, extra: 1 }, { member_id: mid, value: 1 }, { member_id: hi, value: 1 }])).toBe('invalid_expense');
    expect(await send('shares', [{ member_id: lo, value: '1' }, { member_id: mid, value: 1 }, { member_id: hi, value: 1 }])).toBe('invalid_split_value');
    expect(await send('shares', [{ member_id: lo, value: 1.5 }, { member_id: mid, value: 1 }, { member_id: hi, value: 1 }])).toBe('invalid_split_value');
    expect(await send('shares', [{ member_id: 'nope', value: 1 }, { member_id: mid, value: 1 }, { member_id: hi, value: 1 }])).toBe('invalid_expense');
    await admin();
    expect((await db.query<{ n: number }>('select count(*)::int as n from public.expenses where trip_id = $1', [s.trip])).rows[0]!.n).toBe(0);
  });

  it('only ACTIVE members can share, whatever the method; payers must still add up', async () => {
    const s = await setup('Active only');
    const gone = await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    for (const [method, inputs] of [['exact', { [s.a]: 500, [gone]: 500 }], ['percentage', { [s.a]: 5000, [gone]: 5000 }], ['shares', { [s.a]: 1, [gone]: 1 }]] as [Method, Record<string, number>][]) {
      expect(await outcome(create(asha, s.trip, newId(), { amount: 1000, participants: [s.a, gone], payers: { [s.a]: 1000 }, method, inputs })), method).toBe('participant_not_active');
    }
    expect(await outcome(create(asha, s.trip, newId(), { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 999 }, method: 'shares', inputs: { [s.a]: 1, [s.r]: 1 } }))).toBe('payers_total_mismatch');
  });

  it('an archived trip refuses every method', async () => {
    const s = await setup('Archived splits');
    const id = newId();
    await create(asha, s.trip, id, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'shares', inputs: { [s.a]: 1, [s.r]: 1 } });
    await admin();
    await db.query(`update public.trips set status = 'archived' where id = $1`, [s.trip]);
    expect(await outcome(create(asha, s.trip, newId(), { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [s.a]: 5000, [s.r]: 5000 } }))).toBe('trip_archived');
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'exact', inputs: { [s.a]: 1, [s.r]: 999 } }))).toBe('trip_archived');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('idempotent create compares the method and every typed value', () => {
  it('the same id with the same method and values is a safe no-op (values in any order); any difference is "taken"', async () => {
    const s = await setup('Idem splits');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    const e: Exp = { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [lo]: 5000, [mid]: 3000, [hi]: 2000 } };
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(true);
    const reordered = [{ member_id: hi, value: 2000 }, { member_id: lo, value: 5000 }, { member_id: mid, value: 3000 }];
    expect((await create(asha, s.trip, id, { ...e, participants: [hi, mid, lo], inputs: reordered })).rows[0]).toEqual({ expense_id: id, version: 1, created: false });
    expect(await outcome(create(asha, s.trip, id, { ...e, inputs: { [lo]: 5001, [mid]: 2999, [hi]: 2000 } }))).toBe('expense_id_taken'); // one typed value differs
    expect(await outcome(create(asha, s.trip, id, { ...e, method: 'shares', inputs: { [lo]: 5, [mid]: 3, [hi]: 2 } }))).toBe('expense_id_taken'); // same shares, a different method
    expect(await outcome(create(asha, s.trip, id, { ...e, method: 'equal', inputs: undefined }))).toBe('expense_id_taken');
    expect(await revisions(id)).toHaveLength(1);
  });

  it('weights 5:3:2 and percentages 50:30:20 produce the same shares yet are different expenses', async () => {
    const s = await setup('Same shares');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const a = newId();
    const b = newId();
    await create(asha, s.trip, a, { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [lo]: 5000, [mid]: 3000, [hi]: 2000 } });
    await create(asha, s.trip, b, { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'shares', inputs: { [lo]: 5, [mid]: 3, [hi]: 2 } });
    expect((await stored(a)).splits.map((x) => x.share_minor)).toEqual((await stored(b)).splits.map((x) => x.share_minor));
    expect((await stored(a)).expense.split_method).not.toBe((await stored(b)).expense.split_method);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('editing: the method and values can change; versions, history and no-ops', () => {
  it('equal -> percentage -> shares -> exact -> equal: every step is one version and one history entry holding the method and values', async () => {
    const s = await setup('Method changes');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    const base = { amount: 1000, participants: all(s), payers: { [s.a]: 1000 } };
    await create(asha, s.trip, id, base);
    const steps: [Method, Record<string, number> | undefined, number[]][] = [
      ['percentage', { [lo]: 5000, [mid]: 3000, [hi]: 2000 }, [500, 300, 200]],
      ['shares', { [lo]: 1, [mid]: 1, [hi]: 2 }, [250, 250, 500]],
      ['exact', { [lo]: 0, [mid]: 1000, [hi]: 0 }, [0, 1000, 0]],
      ['equal', undefined, [334, 333, 333]],
    ];
    let version = 1;
    for (const [method, inputs, expected] of steps) {
      expect((await update(asha, s.trip, id, version, { ...base, method, inputs })).rows[0], method).toEqual({ expense_id: id, version: version + 1, changed: true });
      version += 1;
      const { expense, splits } = await stored(id);
      expect(expense.split_method).toBe(method);
      expect(splits.map((x) => x.share_minor)).toEqual(expected);
      expect(splits.map((x) => x.input_value === null)).toEqual(method === 'equal' ? [true, true, true] : [false, false, false]); // a typed value never lingers after switching to equal
    }
    const rev = await revisions(id);
    expect(rev.map((r) => r.action)).toEqual(['create', 'update', 'update', 'update', 'update']);
    expect(rev.map((r) => r.snapshot.split_method)).toEqual(['equal', 'percentage', 'shares', 'exact', 'equal']);
    expect(rev[1]!.snapshot.splits.map((x: any) => x.input_value)).toEqual([5000, 3000, 2000]);
  });

  it('an edit that changes nothing (same method, same values, any order) writes nothing; changing one typed value is a new version', async () => {
    const s = await setup('No-op splits');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    const e: Exp = { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'shares', inputs: { [lo]: 2, [mid]: 1, [hi]: 1 } };
    await create(asha, s.trip, id, e);
    expect((await update(asha, s.trip, id, 1, { ...e, participants: [hi, lo, mid], inputs: [{ member_id: hi, value: 1 }, { member_id: mid, value: 1 }, { member_id: lo, value: 2 }] })).rows[0]).toEqual({ expense_id: id, version: 1, changed: false });
    expect(await revisions(id)).toHaveLength(1);
    expect((await update(asha, s.trip, id, 1, { ...e, inputs: { [lo]: 3, [mid]: 1, [hi]: 1 } })).rows[0]).toMatchObject({ version: 2, changed: true });
    // same SHARES from different typed values still counts as a change (the typed values are part of what was saved)
    expect((await update(asha, s.trip, id, 2, { ...e, inputs: { [lo]: 6, [mid]: 2, [hi]: 2 } })).rows[0]).toMatchObject({ version: 3, changed: true });
  });

  it('a stale version is refused, and permissions are unchanged: a member edits only their own, an administrator any', async () => {
    const s = await setup('Edit rules');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    const e: Exp = { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [lo]: 4000, [mid]: 3000, [hi]: 3000 } };
    await create(asha, s.trip, id, e);
    expect(await outcome(update(asha, s.trip, id, 9, { ...e, method: 'equal', inputs: undefined }))).toBe('version_conflict');
    expect(await outcome(update(ravi, s.trip, id, 1, { ...e, method: 'equal', inputs: undefined }))).toBe('not_allowed');
    expect(await outcome(update(asha, s.trip, id, 1, { ...e, method: 'equal', inputs: undefined }))).toBe('ok');
    const mine = newId();
    await create(ravi, s.trip, mine, { amount: 600, participants: [s.r, s.n], payers: { [s.r]: 600 }, method: 'exact', inputs: { [s.r]: 100, [s.n]: 500 } });
    expect(await outcome(update(ravi, s.trip, mine, 1, { amount: 600, participants: [s.r, s.n], payers: { [s.r]: 600 }, method: 'exact', inputs: { [s.r]: 300, [s.n]: 300 } }))).toBe('ok');
    expect(await outcome(del(ravi, s.trip, mine, 2))).toBe('ok');
    expect(await outcome(restore(ravi, s.trip, mine, 3))).toBe('ok');
    expect((await revisions(mine)).map((r) => r.action)).toEqual(['create', 'update', 'delete', 'restore']);
  });

  it('an edit that names a former member, or breaks the total, is refused and nothing changes', async () => {
    const s = await setup('Edit refusals');
    const gone = await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const id = newId();
    await create(asha, s.trip, id, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'shares', inputs: { [s.a]: 1, [s.r]: 1 } });
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 1000, participants: [s.a, gone], payers: { [s.a]: 1000 }, method: 'shares', inputs: { [s.a]: 1, [gone]: 1 } }))).toBe('participant_not_active');
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'exact', inputs: { [s.a]: 500, [s.r]: 400 } }))).toBe('split_total_mismatch');
    const { expense, splits } = await stored(id);
    expect(expense.version).toBe(1);
    expect(expense.split_method).toBe('shares');
    expect(splits.map((x) => x.share_minor)).toEqual(byC([s.a, s.r]).map(() => 500));
    expect(await revisions(id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('former members (rule I-1) with the new methods, over the complete ledger', () => {
  it('a person with a zero share or a zero-contribution split can leave; the rule judges the whole ledger', async () => {
    const s = await setup('I-1 methods');
    const id = newId();
    // Nina owes exactly zero (an exact share of 0) and paid nothing: she is at zero and may leave
    await create(asha, s.trip, id, { amount: 1000, participants: [s.a, s.r, s.n], payers: { [s.a]: 1000 }, method: 'exact', inputs: { [s.a]: 600, [s.r]: 400, [s.n]: 0 } });
    expect((await balances(asha, s.trip)).rows.find((r) => r.member_id === s.n)!.net_minor).toBe(0);
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
    // she is a former member whose row still sits in the expense with a zero share. Editing the expense to drop her is allowed (zero contribution)...
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [s.a]: 6000, [s.r]: 4000 } }))).toBe('ok');
    // ...and so is deleting and restoring it
    expect(await outcome(del(asha, s.trip, id, 2))).toBe('ok');
    expect(await outcome(restore(asha, s.trip, id, 3))).toBe('ok');
  });

  it('a person who owes under a percentage or shares split cannot leave, and their rows cannot be changed away while they are a former member', async () => {
    const s = await setup('I-1 owes');
    const id = newId();
    await create(asha, s.trip, id, { amount: 1000, participants: [s.a, s.r], payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [s.a]: 7000, [s.r]: 3000 } });
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('balance_not_settled'); // owes 300
    await create(asha, s.trip, newId(), { amount: 600, participants: [s.a, s.r], payers: { [s.r]: 600 }, method: 'shares', inputs: { [s.a]: 1, [s.r]: 1 } }); // Ravi +300, Asha -300: nets to zero for Ravi
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 1000, participants: [s.a], payers: { [s.a]: 1000 }, method: 'exact', inputs: { [s.a]: 1000 } }))).toBe('former_member_balance');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('former_member_balance');
    expect((await stored(id)).expense.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the database is the last authority: no path can store shares it did not derive', () => {
  const write = async (s: Setup, method: string, amount: number, rows: { member: string; share: number; input: number | null }[], payer?: string) => {
    await admin();
    const id = newId();
    await db.exec(`
      begin;
      insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ('${id}', '${s.trip}', 'T', ${amount}, '2026-12-28', '${method}', '${s.a}');
      insert into public.expense_payers values ('${id}', '${s.trip}', '${payer ?? s.a}', ${amount});
      ${rows.map((r) => `insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor, input_value) values ('${id}', '${s.trip}', '${r.member}', ${r.share}, ${r.input === null ? 'null' : r.input});`).join('\n')}
      commit;`);
    return id;
  };

  it('percentage and shares: stored shares that are not the derived split are refused when saved; the derived ones are accepted', async () => {
    const s = await setup('Final guard');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const good = (m: string) => ({ member: m });
    // 1000 at 50/30/20 -> 500/300/200
    await expect(write(s, 'percentage', 1000, [{ member: lo, share: 400, input: 5000 }, { member: mid, share: 400, input: 3000 }, { member: hi, share: 200, input: 2000 }])).rejects.toThrow(/split_not_derived/);
    await write(s, 'percentage', 1000, [{ member: lo, share: 500, input: 5000 }, { member: mid, share: 300, input: 3000 }, { member: hi, share: 200, input: 2000 }]);
    await expect(write(s, 'shares', 1000, [{ member: lo, share: 500, input: 2 }, { member: mid, share: 500, input: 1 }, { member: hi, share: 0, input: 1 }])).rejects.toThrow(/split_not_derived/);
    await write(s, 'shares', 1000, [{ member: lo, share: 500, input: 2 }, { member: mid, share: 250, input: 1 }, { member: hi, share: 250, input: 1 }]);
    void good;
  });

  it('exact: shares must equal the typed amounts; an invalid typed value, a missing one and a lingering one on an equal expense are all refused', async () => {
    const s = await setup('Final guard 2');
    const [lo, mid] = byC(all(s)) as [string, string];
    await expect(write(s, 'exact', 1000, [{ member: lo, share: 600, input: 500 }, { member: mid, share: 400, input: 500 }])).rejects.toThrow(/split_not_derived/);
    await write(s, 'exact', 1000, [{ member: lo, share: 600, input: 600 }, { member: mid, share: 400, input: 400 }]);
    await expect(write(s, 'exact', 1000, [{ member: lo, share: 600, input: null }, { member: mid, share: 400, input: null }])).rejects.toThrow(/invalid_split_value/);
    await expect(write(s, 'percentage', 1000, [{ member: lo, share: 500, input: 4000 }, { member: mid, share: 500, input: 4000 }])).rejects.toThrow(/split_total_mismatch/);
    await expect(write(s, 'equal', 1000, [{ member: lo, share: 500, input: 1 }, { member: mid, share: 500, input: null }])).rejects.toThrow(/shares_not_equal_split/);
  });

  it('tampering with a stored typed value or share afterwards is refused, as is switching the method in place to one the stored values do not fit', async () => {
    const s = await setup('Tamper');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    await create(asha, s.trip, id, { amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [lo]: 5000, [mid]: 3000, [hi]: 2000 } });
    await admin();
    await expect(db.query(`update public.expense_splits set input_value = 4000 where expense_id = $1 and trip_member_id = $2`, [id, lo])).rejects.toThrow(/split_total_mismatch/);
    await expect(db.exec(`begin; update public.expense_splits set input_value = 6000 where expense_id = '${id}' and trip_member_id = '${lo}'; update public.expense_splits set input_value = 2000 where expense_id = '${id}' and trip_member_id = '${mid}'; update public.expense_splits set input_value = 2000 where expense_id = '${id}' and trip_member_id = '${hi}'; commit;`)).rejects.toThrow(/split_not_derived/);
    await db.exec('rollback').catch(() => undefined);
    await expect(db.query(`update public.expenses set split_method = 'exact' where id = $1`, [id])).rejects.toThrow(/split_total_mismatch/); // 5000 + 3000 + 2000 is not the amount
    await expect(db.query(`update public.expenses set split_method = 'equal' where id = $1`, [id])).rejects.toThrow(/shares_not_equal_split/); // typed values must not linger on an equal expense
    await expect(db.query(`update public.expenses set split_method = 'weird' where id = $1`, [id])).rejects.toThrow(/expenses_split_method_values/);
    expect((await stored(id)).splits.map((x) => x.share_minor)).toEqual([500, 300, 200]);
  });

  it('every stored expense in the database satisfies the derivation (a global check over everything these tests wrote)', async () => {
    await admin();
    const bad = await db.query<{ id: string }>(`
      select e.id from public.expenses e
       where exists (
         select 1
           from public.expense_derive_shares(
                  e.split_method, e.amount_minor,
                  (select array_agg(s.trip_member_id order by s.trip_member_id::text collate "C") from public.expense_splits s where s.expense_id = e.id),
                  (select array_agg(s.input_value::bigint order by s.trip_member_id::text collate "C") from public.expense_splits s where s.expense_id = e.id)) d
           full join (select x.trip_member_id, x.share_minor from public.expense_splits x where x.expense_id = e.id) st on st.trip_member_id = d.member_id
          where d.member_id is null or st.trip_member_id is null or d.share_minor <> st.share_minor)`);
    expect(bad.rows).toEqual([]);
    const sums = await db.query<{ n: number }>(`select count(*)::int as n from public.expenses e where e.amount_minor <> (select coalesce(sum(share_minor), 0) from public.expense_splits s where s.expense_id = e.id) or e.amount_minor <> (select coalesce(sum(paid_minor), 0) from public.expense_payers p where p.expense_id = e.id)`);
    expect(sums.rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('access and exposure', () => {
  it('the new internal functions cannot be run by the app, signed in or out; the two public ones keep their grants (signed in only)', async () => {
    await admin();
    const fns = (await db.query<{ proname: string; a: boolean; b: boolean }>(
      `select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') as a, has_function_privilege('anon', p.oid, 'EXECUTE') as b from pg_proc p
        where p.proname in ('allocate_weighted', 'expense_parse_split_inputs', 'expense_derive_shares', 'expense_derive_from_request', 'expense_splits_json_v2', 'check_expense_split_inputs', 'create_expense', 'update_expense') order by 1`)).rows;
    for (const f of fns) {
      if (f.proname === 'create_expense' || f.proname === 'update_expense') expect([f.proname, f.a, f.b]).toEqual([f.proname, true, false]);
      else expect([f.proname, f.a, f.b]).toEqual([f.proname, false, false]);
    }
    // exactly one of each public function (the old signatures were replaced, so a call can never be ambiguous)
    expect(fns.filter((f) => f.proname === 'create_expense')).toHaveLength(1);
    expect(fns.filter((f) => f.proname === 'update_expense')).toHaveLength(1);
    const s = await setup('Anon splits');
    expect(await outcome(q(null, CREATE, [s.trip, newId(), 'x', 1000, '2026-12-28', 'food', null, 'shares', [s.a], payersJson({ [s.a]: 1000 }), inputsJson({ [s.a]: 1 })]))).toBe('permission denied');
    expect(await outcome(q(meera, CREATE, [s.trip, newId(), 'x', 1000, '2026-12-28', 'food', null, 'shares', [s.a], payersJson({ [s.a]: 1000 }), inputsJson({ [s.a]: 1 })]))).toBe('trip_not_found');
  });

  it('the app\'s old ten-argument call still works (the new parameter is optional), and no function takes a share from the caller', async () => {
    const s = await setup('Old call');
    const id = newId();
    const r = await q<{ created: boolean }>(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb)', [s.trip, id, 'Old style', 900, '2026-12-28', 'food', null, 'equal', all(s), payersJson({ [s.a]: 900 })]);
    expect(r.rows[0]!.created).toBe(true);
    await admin();
    const sigs = (await db.query<{ a: string }>(`select pg_get_function_arguments(p.oid) as a from pg_proc p where p.proname in ('create_expense', 'update_expense')`)).rows;
    for (const x of sigs) expect(x.a).not.toMatch(/share/i);
  });

  it('history is still readable by active members only and still holds no user id, email or name, with the typed values included', async () => {
    const s = await setup('History splits');
    const [lo, mid, hi] = byC(all(s)) as [string, string, string];
    const id = newId();
    await create(asha, s.trip, id, { title: 'Sharing', amount: 1000, participants: all(s), payers: { [s.a]: 1000 }, method: 'percentage', inputs: { [lo]: 5000, [mid]: 3000, [hi]: 2000 } });
    expect((await q(ravi, 'select * from public.expense_revisions where expense_id = $1', [id])).rows).toHaveLength(1);
    expect((await q(meera, 'select * from public.expense_revisions where expense_id = $1', [id])).rows).toEqual([]);
    const text = JSON.stringify((await revisions(id))[0]!.snapshot);
    for (const secret of [asha, ravi, nina, 'asha@example.com', 'Asha', 'Ravi', 'Nina']) expect(text).not.toContain(secret);
    await admin();
    await expect(db.query(`update public.expense_revisions set snapshot = '{}' where expense_id = $1`, [id])).rejects.toThrow(/append-only/);
    expect(await outcome(q(asha, `update public.expense_revisions set snapshot = '{}' where expense_id = $1`, [id]))).toBe('permission denied');
    expect(await outcome(q(asha, `delete from public.expense_revisions where expense_id = $1`, [id]))).toBe('permission denied');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('random ledgers with mixed methods: balances equal the TypeScript engine after every step', () => {
  it('create, edit (including changing the method), delete and restore with random methods; every expense is a derived split; balances match computeBalances', async () => {
    for (const seed of [21, 22]) {
      let state = seed * 6700417;
      const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const trip = await makeTrip(asha, `Mixed ${seed}`);
      const people = [await memberOf(trip, asha)];
      for (let i = 0; i < 4; i++) people.push(await put(trip, await users.signUp(`mix${seed}-${i}@example.com`, `Mix ${seed}.${i}`), `Mix ${seed}.${i}`));
      interface ME { id: string; version: number; deleted: boolean; amount: number; payers: Record<string, number>; method: Method; participants: string[]; inputs: Record<string, number> | undefined }
      const model: ME[] = [];
      const content = (): Omit<ME, 'id' | 'version' | 'deleted'> => {
        const participants = people.filter(() => rand() < 0.6);
        if (participants.length === 0) participants.push(pick(people));
        const amount = 1 + Math.floor(rand() * 50000);
        const method = pick<Method>(['equal', 'exact', 'percentage', 'shares']);
        let inputs: Record<string, number> | undefined;
        if (method === 'exact') {
          const cuts = Array.from({ length: participants.length - 1 }, () => Math.floor(rand() * (amount + 1))).sort((a, b) => a - b);
          const edges = [0, ...cuts, amount];
          inputs = Object.fromEntries(participants.map((id, k) => [id, edges[k + 1]! - edges[k]!]));
        } else if (method === 'percentage') {
          const cuts = new Set<number>();
          while (cuts.size < participants.length - 1) cuts.add(1 + Math.floor(rand() * 9999));
          const edges = [0, ...[...cuts].sort((a, b) => a - b), 10000];
          inputs = Object.fromEntries(participants.map((id, k) => [id, edges[k + 1]! - edges[k]!]));
        } else if (method === 'shares') {
          inputs = Object.fromEntries(participants.map((id) => [id, 1 + Math.floor(rand() * 20)]));
        }
        const payer = pick(people);
        return { amount, payers: { [payer]: amount }, method, participants, inputs };
      };
      const ledger = (): LedgerExpense[] => model.map((e) => ({
        id: e.id, deleted: e.deleted,
        payers: Object.entries(e.payers).map(([memberId, paidMinor]) => ({ memberId, paidMinor })),
        splits: computeSplit(e.amount, specFor(e.method, e.participants, e.inputs)).map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor })),
      }));
      const check = async () => {
        const got = Object.fromEntries((await balances(asha, trip)).rows.map((r) => [r.member_id, r.net_minor]));
        const ts = new Map(computeBalances(people, ledger(), []).map((b) => [b.memberId, b.netConfirmedMinor]));
        for (const p of people) expect(got[p], `seed ${seed} net of ${p}`).toBe(ts.get(p));
      };
      for (let step = 0; step < 70; step++) {
        const kind = pick(['create', 'create', 'edit', 'edit', 'delete', 'restore']);
        if (kind === 'create' || model.length === 0) {
          const c = content();
          const id = newId();
          expect(await outcome(create(asha, trip, id, { title: `E${step}`, ...c })), `step ${step} create ${c.method}`).toBe('ok');
          model.push({ id, version: 1, deleted: false, ...c });
        } else if (kind === 'edit') {
          const live = model.filter((e) => !e.deleted);
          if (live.length === 0) continue;
          const e = pick(live);
          const c = content();
          expect(await outcome(update(asha, trip, e.id, e.version, { title: `E${step}`, ...c })), `step ${step} edit to ${c.method}`).toBe('ok');
          Object.assign(e, c, { version: e.version + 1 });
        } else {
          const pool = model.filter((e) => (kind === 'delete' ? !e.deleted : e.deleted));
          if (pool.length === 0) continue;
          const e = pick(pool);
          expect(await outcome(kind === 'delete' ? del(asha, trip, e.id, e.version) : restore(asha, trip, e.id, e.version)), `step ${step} ${kind}`).toBe('ok');
          e.deleted = kind === 'delete';
          e.version += 1;
        }
        await check();
      }
      for (const e of model) {
        const { expense, splits } = await stored(e.id);
        expect(expense.version).toBe(e.version);
        expect(expense.split_method).toBe(e.method);
        expect(splits.reduce((a, x) => a + x.share_minor, 0)).toBe(e.amount);
      }
    }
  }, 240_000);
});
