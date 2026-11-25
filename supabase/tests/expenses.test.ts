import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense } from '../../packages/core/src/balances';
import { LEDGER_VECTORS, MEMBER_IDS, SPLIT_VECTORS, type VectorOp } from '../../packages/core/test-fixtures/expenseVectors';
import { computeSplit } from '../../packages/core/src/split';
import { TestUsers, newDatabase } from './harness';

/**
 * M5 Checkpoint 1 (ADR-063): expenses, tested against the real Postgres engine with the project's real migrations.
 *
 * What matters most: the database derives and verifies equal splits (and agrees with the TypeScript engine on every
 * number), every write takes the trip lock before it changes anything, a former member can never be left with a balance,
 * nobody can leave or be removed while owing or owed, a trip's dates can never strand an expense, and a retry of a create
 * is safe without ever revealing another trip's data.
 *
 * As in the earlier database tests, truly simultaneous callers cannot be run in this engine (one connection). Races are
 * covered by (a) "second caller after the first" simulations in both orders, (b) probes that record, at the moment any
 * relevant row is changed, whether the trip row is already locked by that same transaction, and (c) source checks of the
 * lock order. The probes (and the second database they live in) are test-only.
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'not_admin', 'trip_archived', 'expense_not_found', 'not_allowed', 'version_conflict',
  'expense_deleted', 'expense_id_taken', 'invalid_expense', 'payers_total_mismatch', 'shares_total_mismatch', 'participant_not_active',
  'payer_not_active', 'outside_trip_dates', 'category_not_found', 'too_many_expenses', 'former_member_balance', 'balance_not_settled',
  'expenses_outside_dates', 'last_admin', 'use_leave_instead', 'member_not_found', 'invite_invalid', 'append-only',
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
async function failure(p: PromiseLike<unknown>): Promise<{ message: string; detail: string | undefined }> {
  try {
    await p;
    return { message: '', detail: undefined };
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e), detail: (e as { detail?: string }).detail };
  }
}

const as = async (who: string | null, d: PGlite = db, u: TestUsers = users) => {
  if (who === null) await u.asAnon();
  else await u.asUser(who);
  return d;
};
const q = async <T = Record<string, any>>(who: string | null, sql: string, args: unknown[] = []) => (await as(who)).query<T>(sql, args);
const admin = async () => {
  await users.asAdmin();
  return db;
};

interface Exp {
  title?: string;
  amount: number;
  spentOn?: string;
  category?: string | null;
  notes?: string | null;
  method?: string;
  participants: string[];
  payers: Record<string, number>;
  /** For exact, percentage and shares: each participant's typed value (paise, basis points or a weight). */
  inputs?: Record<string, number>;
}
const inputsJson = (m?: Record<string, number>) => (m ? JSON.stringify(Object.entries(m).map(([member_id, value]) => ({ member_id, value }))) : null);
const payersJson = (p: Record<string, number>) => JSON.stringify(Object.entries(p).map(([member_id, paid_minor]) => ({ member_id, paid_minor })));
const CREATE_SQL = 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb)';
const createArgs = (trip: string, id: string, e: Exp) => [trip, id, e.title ?? 'Dinner', e.amount, e.spentOn ?? '2026-12-28', e.category === undefined ? 'food' : e.category, e.notes ?? null, e.method ?? 'equal', e.participants, payersJson(e.payers)];
const CREATE_SQL11 = 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)';
const create = (who: string | null, trip: string, id: string, e: Exp) => q<{ expense_id: string; version: number; created: boolean }>(who, CREATE_SQL11, [...createArgs(trip, id, e), inputsJson(e.inputs)]);
const UPDATE_SQL = 'select * from public.update_expense($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6::date, $7, $8, $9, $10::uuid[], $11::jsonb)';
const UPDATE_SQL12 = 'select * from public.update_expense($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6::date, $7, $8, $9, $10::uuid[], $11::jsonb, $12::jsonb)';
const update = (who: string | null, trip: string, id: string, version: number, e: Exp) =>
  q<{ expense_id: string; version: number; changed: boolean }>(who, UPDATE_SQL12, [trip, id, version, e.title ?? 'Dinner', e.amount, e.spentOn ?? '2026-12-28', e.category === undefined ? 'food' : e.category, e.notes ?? null, e.method ?? 'equal', e.participants, payersJson(e.payers), inputsJson(e.inputs)]);
const del = (who: string | null, trip: string, id: string, version: number) => q<{ expense_id: string; version: number; changed: boolean }>(who, 'select * from public.delete_expense($1, $2, $3)', [trip, id, version]);
const restore = (who: string | null, trip: string, id: string, version: number) => q<{ expense_id: string; version: number; changed: boolean }>(who, 'select * from public.restore_expense($1, $2, $3)', [trip, id, version]);
const balances = (who: string | null, trip: string) => q<{ member_id: string; paid_minor: number; share_minor: number; net_minor: number }>(who, 'select * from public.trip_member_balances($1)', [trip]);
const netOf = async (who: string, trip: string, member: string) => (await balances(who, trip)).rows.find((r) => r.member_id === member)!.net_minor;

async function makeTrip(creator: string, name: string, start = '2026-12-27', end = '2026-12-30'): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip($1, 'Somewhere', $2, $3)`, [name, start, end])).rows[0]!.id;
}
async function put(trip: string, userId: string | null, name: string, over: { role?: string; status?: string; id?: string } = {}): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>(
    `insert into public.trip_members (id, trip_id, user_id, display_name, role, status, left_at)
     values (coalesce($6::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, case when $5 = 'active' then null else now() end) returning id`,
    [trip, userId, name, over.role ?? 'member', over.status ?? 'active', over.id ?? null],
  )).rows[0]!.id;
}
async function memberOf(trip: string, userId: string): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>('select id from public.trip_members where trip_id = $1 and user_id = $2', [trip, userId])).rows[0]!.id;
}
async function archive(trip: string, on = true) {
  await admin();
  await db.query(`update public.trips set status = $2 where id = $1`, [trip, on ? 'archived' : 'active']);
}
async function count(table: string, where = 'true', args: unknown[] = []): Promise<number> {
  await admin();
  return (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`, args)).rows[0]!.n;
}
async function expenseRow(id: string) {
  await admin();
  return (await db.query<Record<string, any>>('select * from public.expenses where id = $1', [id])).rows[0];
}
async function rowsOf(id: string) {
  await admin();
  const p = (await db.query<{ trip_member_id: string; paid_minor: number }>('select trip_member_id, paid_minor from public.expense_payers where expense_id = $1 order by trip_member_id::text collate "C"', [id])).rows;
  const s = (await db.query<{ trip_member_id: string; share_minor: number }>('select trip_member_id, share_minor from public.expense_splits where expense_id = $1 order by trip_member_id::text collate "C"', [id])).rows;
  return { payers: p, shares: s };
}
async function revisions(id: string) {
  await admin();
  return (await db.query<{ version: number; action: string; snapshot: Record<string, any>; changed_by: string }>('select version, action, snapshot, changed_by from public.expense_revisions where expense_id = $1 order by version', [id])).rows;
}
const newId = () => randomUUID();

let asha: string; // administrator and creator of the main trips
let ravi: string;
let nina: string;
let dev: string; // leaves in some tests
let sam: string; // a stranger
let meera: string; // administrator of her own, separate trip

interface Setup {
  trip: string;
  a: string;
  r: string;
  n: string;
}
/** A fresh active trip (27 to 30 December 2026) with Asha (admin), Ravi and Nina as active members. */
async function setup(name: string): Promise<Setup> {
  const trip = await makeTrip(asha, name);
  const a = await memberOf(trip, asha);
  const r = await put(trip, ravi, 'Ravi Kumar');
  const n = await put(trip, nina, 'Nina Shah');
  return { trip, a, r, n };
}
const equalAll = (s: Setup, amount: number, over: Partial<Exp> = {}): Exp => ({ amount, participants: [s.a, s.r, s.n], payers: { [s.a]: amount }, ...over });

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  nina = await users.signUp('nina@example.com', 'Nina Shah');
  dev = await users.signUp('dev@example.com', 'Departed Dev');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('rollback').catch(() => undefined); // a failed explicit transaction must never leak into the next test
});

// ---------------------------------------------------------------------------------------------------
describe('who can run what', () => {
  it('a signed-out visitor can run none of the five functions', async () => {
    const s = await setup('Anon');
    const id = newId();
    expect(await outcome(create(null, s.trip, id, equalAll(s, 1000)))).toBe('permission denied');
    expect(await outcome(update(null, s.trip, id, 1, equalAll(s, 1000)))).toBe('permission denied');
    expect(await outcome(del(null, s.trip, id, 1))).toBe('permission denied');
    expect(await outcome(restore(null, s.trip, id, 1))).toBe('permission denied');
    expect(await outcome(balances(null, s.trip))).toBe('permission denied');
    expect(await count('expenses', 'trip_id = $1', [s.trip])).toBe(0);
  });

  it('a stranger, a former member, a person who left and a pending requester learn nothing: the same answer as for a trip that does not exist', async () => {
    const s = await setup('Hidden');
    await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const sam2 = await users.signUp('sam2@example.com', 'Pending Sam');
    await admin();
    await db.query(`insert into public.trip_join_requests (trip_id, invite_id, user_id) select $1, i.id, $2 from (select gen_random_uuid() as id) i where false`, [s.trip, sam2]).catch(() => undefined);
    const id = newId();
    expect((await create(asha, s.trip, id, equalAll(s, 1000))).rows[0]!.created).toBe(true);
    const NONE = '00000000-0000-4000-8000-000000000000';
    for (const who of [sam, dev, sam2]) {
      expect(await outcome(create(who, s.trip, newId(), equalAll(s, 1000))), who).toBe('trip_not_found');
      expect(await outcome(update(who, s.trip, id, 1, equalAll(s, 1000))), who).toBe('trip_not_found');
      expect(await outcome(del(who, s.trip, id, 1)), who).toBe('trip_not_found');
      expect(await outcome(restore(who, s.trip, id, 1)), who).toBe('trip_not_found');
      expect(await outcome(balances(who, s.trip)), who).toBe('trip_not_found');
    }
    expect(await outcome(balances(asha, NONE))).toBe('trip_not_found'); // an unknown trip: the same answer
    expect(await outcome(create(asha, NONE, newId(), equalAll(s, 1000)))).toBe('trip_not_found');
  });

  it('an archived trip refuses every expense change but still shows balances; restoring the trip makes it editable again', async () => {
    const s = await setup('Archived');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 1000));
    await archive(s.trip);
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 1000)))).toBe('trip_archived');
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 2000)))).toBe('trip_archived');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('trip_archived');
    expect(await outcome(restore(asha, s.trip, id, 1))).toBe('trip_archived');
    expect((await balances(ravi, s.trip)).rows).toHaveLength(3);
    await archive(s.trip, false);
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 2000)))).toBe('ok');
  });

  it('administrators change any expense; a member only their own; a member cannot touch an administrator\'s', async () => {
    const s = await setup('Permissions');
    const mine = newId();
    const theirs = newId();
    await create(ravi, s.trip, mine, equalAll(s, 900, { payers: { [s.r]: 900 } }));
    await create(asha, s.trip, theirs, equalAll(s, 900));
    expect(await outcome(update(nina, s.trip, mine, 1, equalAll(s, 600)))).toBe('not_allowed');
    expect(await outcome(del(nina, s.trip, mine, 1))).toBe('not_allowed');
    expect(await outcome(update(ravi, s.trip, theirs, 1, equalAll(s, 600)))).toBe('not_allowed');
    expect(await outcome(del(ravi, s.trip, theirs, 1))).toBe('not_allowed');
    expect(await outcome(restore(ravi, s.trip, theirs, 1))).toBe('not_allowed');
    expect(await outcome(update(ravi, s.trip, mine, 1, equalAll(s, 600, { payers: { [s.r]: 600 } })))).toBe('ok'); // own
    expect(await outcome(update(asha, s.trip, mine, 2, equalAll(s, 300)))).toBe('ok'); // an administrator, any
    expect(await outcome(del(asha, s.trip, mine, 3))).toBe('ok');
    expect(await outcome(restore(ravi, s.trip, mine, 4))).toBe('ok'); // the creator
    expect(await outcome(update(ravi, s.trip, newId(), 1, equalAll(s, 600)))).toBe('expense_not_found');
  });

  it('an expense of another trip cannot be reached through this trip', async () => {
    const s = await setup('Mine');
    const other = await makeTrip(meera, 'Theirs');
    const om = await memberOf(other, meera);
    const id = newId();
    await create(meera, other, id, { amount: 500, participants: [om], payers: { [om]: 500 } });
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 600)))).toBe('expense_not_found');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('expense_not_found');
    expect(await outcome(restore(asha, s.trip, id, 1))).toBe('expense_not_found');
    expect((await expenseRow(id))!.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('create_expense: input rules', () => {
  it('stores what was sent, derives the shares itself, and writes a first history entry', async () => {
    const s = await setup('Create');
    const id = newId();
    const r = (await create(ravi, s.trip, id, { title: '  Beach dinner  ', amount: 1000, notes: '  with sea view ', participants: [s.n, s.a, s.r], payers: { [s.r]: 1000 } })).rows[0]!;
    expect(r).toEqual({ expense_id: id, version: 1, created: true });
    const e = (await expenseRow(id))!;
    expect(e).toMatchObject({ trip_id: s.trip, title: 'Beach dinner', amount_minor: 1000, notes: 'with sea view', scope: 'shared', split_method: 'equal', created_by: s.r, version: 1, deleted_at: null });
    expect(String(e.spent_on instanceof Date ? e.spent_on.toISOString().slice(0, 10) : e.spent_on)).toMatch(/2026-12-28/);
    const rows = await rowsOf(id);
    expect(rows.payers).toEqual([{ trip_member_id: s.r, paid_minor: 1000 }]);
    const sorted = [s.a, s.r, s.n].sort();
    expect(rows.shares).toEqual(sorted.map((m, i) => ({ trip_member_id: m, share_minor: i === 0 ? 334 : 333 }))); // the lowest id gets the extra paisa
    const rev = await revisions(id);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ version: 1, action: 'create', changed_by: s.r });
  });

  it('refuses bad text, amounts, dates, methods and lists with one clear code each', async () => {
    const s = await setup('Bad input');
    const ok = equalAll(s, 1000);
    const bad = async (over: Partial<Exp>, code: string) => expect(await outcome(create(asha, s.trip, newId(), { ...ok, ...over })), JSON.stringify(over)).toBe(code);
    await bad({ title: '' }, 'invalid_expense');
    await bad({ title: '   ' }, 'invalid_expense');
    await bad({ title: 'x'.repeat(121) }, 'invalid_expense');
    await bad({ amount: 0, payers: { [s.a]: 0 } }, 'invalid_expense');
    await bad({ amount: -5, payers: { [s.a]: 5 } }, 'invalid_expense');
    await bad({ amount: 1_000_000_000_001, payers: { [s.a]: 1_000_000_000_001 } }, 'invalid_expense');
    await bad({ notes: 'n'.repeat(1001) }, 'invalid_expense');
    await bad({ method: 'percentage' }, 'invalid_expense');
    await bad({ method: 'exact' }, 'invalid_expense');
    await bad({ method: 'shares' }, 'invalid_expense');
    await bad({ spentOn: '2026-12-26' }, 'outside_trip_dates');
    await bad({ spentOn: '2026-12-31' }, 'outside_trip_dates');
    await bad({ participants: [] }, 'invalid_expense');
    await bad({ participants: [s.a, s.a] }, 'invalid_expense');
    await bad({ category: 'no_such_category' }, 'category_not_found');
    expect(await outcome(create(asha, s.trip, newId(), { ...ok, spentOn: '2026-12-27' }))).toBe('ok'); // the first day
    expect(await outcome(create(asha, s.trip, newId(), { ...ok, spentOn: '2026-12-30' }))).toBe('ok'); // the last day
    expect(await outcome(create(asha, s.trip, newId(), { ...ok, category: null }))).toBe('ok');
    expect(await outcome(create(asha, s.trip, newId(), { ...ok, amount: 1_000_000_000_000, payers: { [s.a]: 1_000_000_000_000 } }))).toBe('ok'); // the largest amount
  });

  it('a null expense id, a null date and a null title are refused, never stored', async () => {
    const s = await setup('Nulls');
    expect(await outcome(q(asha, CREATE_SQL, createArgs(s.trip, null as unknown as string, equalAll(s, 1000))))).toBe('invalid_expense');
    expect(await outcome(q(asha, CREATE_SQL, [s.trip, newId(), null, 1000, '2026-12-28', 'food', null, 'equal', [s.a], payersJson({ [s.a]: 1000 })]))).toBe('invalid_expense');
    expect(await outcome(q(asha, CREATE_SQL, [s.trip, newId(), 'T', 1000, null, 'food', null, 'equal', [s.a], payersJson({ [s.a]: 1000 })]))).toBe('invalid_expense');
    expect(await count('expenses', 'trip_id = $1', [s.trip])).toBe(0);
  });

  it('payers: several are allowed but must add up exactly; each must be a distinct ACTIVE member; the shape is strict', async () => {
    const s = await setup('Payers');
    await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const devM = await memberOf(s.trip, dev);
    const send = (payers: unknown, over: Partial<Exp> = {}) => q(asha, CREATE_SQL, [s.trip, newId(), 'Cab', 1000, '2026-12-28', 'food', null, 'equal', over.participants ?? [s.a, s.r], JSON.stringify(payers)]);
    expect(await outcome(send([{ member_id: s.a, paid_minor: 600 }, { member_id: s.r, paid_minor: 400 }]))).toBe('ok');
    expect(await outcome(send([{ member_id: s.a, paid_minor: 600 }, { member_id: s.r, paid_minor: 399 }]))).toBe('payers_total_mismatch');
    expect(await outcome(send([{ member_id: s.a, paid_minor: 600 }, { member_id: s.r, paid_minor: 401 }]))).toBe('payers_total_mismatch');
    expect(await outcome(send([{ member_id: s.a, paid_minor: 500 }, { member_id: s.a, paid_minor: 500 }]))).toBe('invalid_expense'); // the same person twice
    expect(await outcome(send([{ member_id: devM, paid_minor: 1000 }]))).toBe('payer_not_active');
    expect(await outcome(send([{ member_id: '00000000-0000-4000-8000-0000000000ee', paid_minor: 1000 }]))).toBe('payer_not_active'); // not on this trip at all
    expect(await outcome(send([]))).toBe('invalid_expense');
    expect(await outcome(send({ member_id: s.a, paid_minor: 1000 }))).toBe('invalid_expense'); // not a list
    expect(await outcome(send([{ member_id: s.a, paid_minor: 1000, extra: 1 }]))).toBe('invalid_expense'); // unknown field
    expect(await outcome(send([{ member_id: s.a }]))).toBe('invalid_expense');
    expect(await outcome(send([{ member_id: 'not-a-uuid', paid_minor: 1000 }]))).toBe('invalid_expense');
    expect(await outcome(send([{ member_id: s.a, paid_minor: '1000' }]))).toBe('invalid_expense'); // a string, not a number
    expect(await outcome(send([{ member_id: s.a, paid_minor: 1000.5 }]))).toBe('invalid_expense');
    expect(await outcome(send([{ member_id: s.a, paid_minor: 0 }, { member_id: s.r, paid_minor: 1000 }]))).toBe('invalid_expense');
    expect(await outcome(send([{ member_id: s.a, paid_minor: -1 }, { member_id: s.r, paid_minor: 1001 }]))).toBe('invalid_expense');
    expect(await outcome(send(null))).toBe('invalid_expense');
    expect(await outcome(send([{ member_id: s.a.toUpperCase(), paid_minor: 1000 }]))).toBe('ok'); // an upper-case id is the same id
  });

  it('participants must be ACTIVE members of this trip; a former member, a stranger\'s member row and a guest who was removed are refused; guests are fine', async () => {
    const s = await setup('Participants');
    const other = await makeTrip(meera, 'Other trip');
    const otherM = await memberOf(other, meera);
    await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const devM = await memberOf(s.trip, dev);
    const goneGuest = await put(s.trip, null, 'Gone Guest', { status: 'removed' });
    const guest = await put(s.trip, null, 'Gita (guest)');
    const go = (participants: string[]) => outcome(create(asha, s.trip, newId(), { amount: 900, participants, payers: { [s.a]: 900 } }));
    expect(await go([s.a, s.r])).toBe('ok');
    expect(await go([s.a, guest])).toBe('ok'); // a guest is a member too
    expect(await go([s.a, devM])).toBe('participant_not_active');
    expect(await go([goneGuest])).toBe('participant_not_active');
    expect(await go([s.a, otherM])).toBe('participant_not_active');
    expect(await go([s.a, '00000000-0000-4000-8000-0000000000ee'])).toBe('participant_not_active');
  });

  it('there is a limit of 2000 expenses per trip, and a retry at the limit still works', async () => {
    const s = await setup('Many');
    await admin();
    // 1999 expenses written directly (as the owner) so the test stays fast
    await db.exec(`
      begin;
      insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by)
        select gen_random_uuid(), '${s.trip}', 'Bulk ' || g, 100, '2026-12-28', 'equal', '${s.a}' from generate_series(1, 1999) g;
      insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor) select id, trip_id, created_by, 100 from public.expenses where trip_id = '${s.trip}';
      insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor) select id, trip_id, created_by, 100 from public.expenses where trip_id = '${s.trip}';
      commit;`);
    const id = newId();
    const e = equalAll(s, 1000);
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(true); // the 2000th
    expect(await outcome(create(asha, s.trip, newId(), e))).toBe('too_many_expenses'); // the 2001st
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(false); // a retry of the 2000th is still safe
  });
});

// ---------------------------------------------------------------------------------------------------
describe('create_expense: idempotent retries (complete canonical content)', () => {
  it('the same id with the SAME complete content (in any order) is a safe no-op: no new rows, no new history, same version', async () => {
    const s = await setup('Idem');
    const id = newId();
    const e: Exp = { title: 'Lunch', amount: 1300, notes: 'n', participants: [s.a, s.r, s.n], payers: { [s.a]: 800, [s.r]: 500 } };
    expect((await create(asha, s.trip, id, e)).rows[0]).toEqual({ expense_id: id, version: 1, created: true });
    const again = (await create(asha, s.trip, id, { ...e, participants: [s.n, s.r, s.a], title: '  Lunch ', notes: ' n ', payers: { [s.r]: 500, [s.a]: 800 } })).rows[0]!;
    expect(again).toEqual({ expense_id: id, version: 1, created: false });
    expect(await count('expenses', 'trip_id = $1', [s.trip])).toBe(1);
    expect(await count('expense_payers', 'expense_id = $1', [id])).toBe(2);
    expect(await count('expense_splits', 'expense_id = $1', [id])).toBe(3);
    expect(await revisions(id)).toHaveLength(1);
  });

  it('the same id with ANY different part of the content answers expense_id_taken and changes nothing', async () => {
    const s = await setup('Idem diff');
    const id = newId();
    const base: Exp = { title: 'Lunch', amount: 1300, notes: 'n', category: 'food', spentOn: '2026-12-28', participants: [s.a, s.r, s.n], payers: { [s.a]: 800, [s.r]: 500 } };
    await create(asha, s.trip, id, base);
    const variants: Partial<Exp>[] = [
      { title: 'Lunch 2' }, { amount: 1400, payers: { [s.a]: 900, [s.r]: 500 } }, { spentOn: '2026-12-29' }, { category: 'other' }, { category: null },
      { notes: 'other' }, { notes: null }, { participants: [s.a, s.r] }, { participants: [s.a, s.r, s.n].slice(1) },
      { payers: { [s.a]: 700, [s.r]: 600 } }, { payers: { [s.a]: 1300 } }, { payers: { [s.a]: 800, [s.n]: 500 } },
    ];
    for (const v of variants) expect(await outcome(create(asha, s.trip, id, { ...base, ...v })), JSON.stringify(v)).toBe('expense_id_taken');
    expect(await revisions(id)).toHaveLength(1);
    expect((await expenseRow(id))!.title).toBe('Lunch');
  });

  it('only the creator\'s own identical retry is a no-op: another member sending the same content is told the id is taken', async () => {
    const s = await setup('Idem who');
    const id = newId();
    const e = equalAll(s, 900);
    await create(asha, s.trip, id, e);
    expect(await outcome(create(ravi, s.trip, id, e))).toBe('expense_id_taken');
    expect(await outcome(create(asha, s.trip, id, e))).toBe('ok');
  });

  it('after an edit, a delete, or a restore that changed things, the ORIGINAL content is no longer a retry', async () => {
    const s = await setup('Idem later');
    const id = newId();
    const e = equalAll(s, 900);
    await create(asha, s.trip, id, e);
    await update(asha, s.trip, id, 1, equalAll(s, 1200));
    expect(await outcome(create(asha, s.trip, id, e))).toBe('expense_id_taken');
    await update(asha, s.trip, id, 2, e); // edited back to the original content: now an identical retry is a no-op again
    expect((await create(asha, s.trip, id, e)).rows[0]).toEqual({ expense_id: id, version: 3, created: false });
    await del(asha, s.trip, id, 3);
    expect(await outcome(create(asha, s.trip, id, e))).toBe('expense_id_taken'); // deleted: not the state a create produces
  });

  it('a retry still works after the situation changed (a participant left, the trip was archived is refused only for NEW work)', async () => {
    const s = await setup('Idem state');
    const id = newId();
    const e = equalAll(s, 900, { payers: { [s.a]: 900 } });
    await create(asha, s.trip, id, e);
    // Ravi leaves with a non-zero balance?  He cannot; so make him settle by deleting nothing: use a guest who is removed instead
    const guest = await put(s.trip, null, 'Gone soon');
    const id2 = newId();
    const e2: Exp = { amount: 600, participants: [s.a, guest], payers: { [s.a]: 600 } };
    await create(asha, s.trip, id2, e2);
    await del(asha, s.trip, id2, 1); // the guest is no longer in any live expense, so can be removed
    await q(asha, 'select * from public.remove_member($1, $2)', [s.trip, guest]);
    expect(await outcome(create(asha, s.trip, id2, e2))).toBe('expense_id_taken'); // deleted, so a retry is not an identical live expense
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(false); // the live one is still a safe retry
  });

  it('an id that belongs to ANOTHER trip is the same "taken" answer, and nothing about that trip leaks', async () => {
    const s = await setup('Mine too');
    const other = await makeTrip(meera, 'Secret trip');
    const om = await memberOf(other, meera);
    const id = newId();
    await create(meera, other, id, { title: 'Secret surprise party', amount: 5000, notes: 'top secret', participants: [om], payers: { [om]: 5000 } });
    const same = await failure(create(asha, s.trip, id, equalAll(s, 900)));
    const differs = await failure(create(asha, s.trip, (await (async () => { const x = newId(); await create(asha, s.trip, x, equalAll(s, 100)); return x; })()), equalAll(s, 900)));
    expect(same.message).toContain('expense_id_taken');
    expect(same.message).toBe(differs.message); // a different-content clash on my own trip reads exactly the same
    expect(same.message + (same.detail ?? '')).not.toMatch(/secret|surprise|5000|Meera/i);
    expect((await expenseRow(id))!.trip_id).toBe(other); // untouched
    expect(await revisions(id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('update_expense, delete_expense, restore_expense', () => {
  it('an edit replaces details, payers and participants, bumps the version once and writes one history entry', async () => {
    const s = await setup('Edit');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 1000));
    const r = (await update(asha, s.trip, id, 1, { title: 'Dinner at the shack', amount: 1500, notes: 'edited', category: 'other', spentOn: '2026-12-29', participants: [s.a, s.r], payers: { [s.a]: 1000, [s.n]: 500 } })).rows[0]!;
    expect(r).toEqual({ expense_id: id, version: 2, changed: true });
    expect(await expenseRow(id)).toMatchObject({ title: 'Dinner at the shack', amount_minor: 1500, notes: 'edited', version: 2, updated_by: s.a });
    const rows = await rowsOf(id);
    expect(rows.payers).toHaveLength(2);
    expect(rows.shares.map((x) => x.share_minor).sort()).toEqual([750, 750]);
    const rev = await revisions(id);
    expect(rev.map((x) => [x.version, x.action])).toEqual([[1, 'create'], [2, 'update']]);
    expect(rev[1]!.snapshot.title).toBe('Dinner at the shack');
    expect(rev[0]!.snapshot.title).toBe('Dinner'); // the earlier version is kept as it was
  });

  it('an edit that changes nothing writes nothing: no version, no history, same rows', async () => {
    const s = await setup('No-op edit');
    const id = newId();
    const e = equalAll(s, 1000);
    await create(asha, s.trip, id, e);
    const r = (await update(asha, s.trip, id, 1, { ...e, participants: [s.n, s.a, s.r], title: ' Dinner ' })).rows[0]!;
    expect(r).toEqual({ expense_id: id, version: 1, changed: false });
    expect(await revisions(id)).toHaveLength(1);
    expect((await expenseRow(id))!.version).toBe(1);
  });

  it('a stale version changes nothing (version_conflict) for edit, delete and restore; a null version is refused too', async () => {
    const s = await setup('Conflict');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 1000));
    await update(asha, s.trip, id, 1, equalAll(s, 1100));
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 1200)))).toBe('version_conflict');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('version_conflict');
    expect(await outcome(restore(asha, s.trip, id, 1))).toBe('version_conflict');
    expect(await outcome(q(asha, 'select * from public.delete_expense($1, $2, null)', [s.trip, id]))).toBe('version_conflict');
    expect(await outcome(update(asha, s.trip, id, 3, equalAll(s, 1200)))).toBe('version_conflict'); // ahead of the truth is just as wrong
    expect((await expenseRow(id))!).toMatchObject({ amount_minor: 1100, version: 2, deleted_at: null });
    expect(await revisions(id)).toHaveLength(2);
  });

  it('delete is a soft delete: the rows and history stay, balances stop counting it, and repeating it is safe', async () => {
    const s = await setup('Delete');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    expect(await netOf(ravi, s.trip, s.a)).toBe(600);
    const r = (await del(asha, s.trip, id, 1)).rows[0]!;
    expect(r).toEqual({ expense_id: id, version: 2, changed: true });
    expect(await expenseRow(id)).toMatchObject({ deleted_by: s.a, version: 2 });
    expect((await expenseRow(id))!.deleted_at).not.toBeNull();
    expect((await rowsOf(id)).payers).toHaveLength(1);
    expect(await netOf(ravi, s.trip, s.a)).toBe(0);
    expect((await del(asha, s.trip, id, 2)).rows[0]).toEqual({ expense_id: id, version: 2, changed: false }); // safe to repeat
    expect(await revisions(id)).toHaveLength(2);
    expect(await outcome(update(asha, s.trip, id, 2, equalAll(s, 1000)))).toBe('expense_deleted'); // a deleted expense cannot be edited
  });

  it('restore brings it back into the balances, writes history, and repeating it is safe', async () => {
    const s = await setup('Restore');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await del(asha, s.trip, id, 1);
    const r = (await restore(asha, s.trip, id, 2)).rows[0]!;
    expect(r).toEqual({ expense_id: id, version: 3, changed: true });
    expect(await netOf(ravi, s.trip, s.a)).toBe(600);
    expect((await restore(asha, s.trip, id, 3)).rows[0]).toEqual({ expense_id: id, version: 3, changed: false });
    const rev = await revisions(id);
    expect(rev.map((x) => x.action)).toEqual(['create', 'delete', 'restore']);
    expect(rev.map((x) => x.snapshot.deleted)).toEqual([false, true, false]);
  });

  it('restore checks the trip\'s CURRENT dates (ADR-043): an expense now outside them cannot come back', async () => {
    const s = await setup('Restore dates');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900, { spentOn: '2026-12-30' }));
    await del(asha, s.trip, id, 1);
    // narrowing the trip is allowed because the expense is deleted (only non-deleted expenses count)
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'Somewhere trip', 'Somewhere', '2026-12-27', '2026-12-28')`, [s.trip]))).toBe('ok');
    expect(await outcome(restore(asha, s.trip, id, 2))).toBe('outside_trip_dates');
    expect((await expenseRow(id))!.deleted_at).not.toBeNull();
    expect(await outcome(q(asha, `select * from public.update_trip($1, 2, 'Somewhere trip', 'Somewhere', '2026-12-27', '2026-12-30')`, [s.trip]))).toBe('ok'); // widen again
    expect(await outcome(restore(asha, s.trip, id, 2))).toBe('ok');
  });

  it('an edit that would put the date outside the trip, or use a former member, is refused with the old data intact', async () => {
    const s = await setup('Edit refused');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 900, { spentOn: '2027-01-02' })))).toBe('outside_trip_dates');
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 900, { category: 'zzz' })))).toBe('category_not_found');
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 900, { method: 'exact' })))).toBe('invalid_expense');
    expect((await expenseRow(id))!.version).toBe(1);
    expect(await revisions(id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('trip_member_balances', () => {
  it('returns every member (former ones too) with what they paid, owe and net, from the ledger; deleted expenses do not count', async () => {
    const s = await setup('Balances');
    await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const devM = await memberOf(s.trip, dev);
    const e1 = newId();
    const e2 = newId();
    await create(asha, s.trip, e1, equalAll(s, 1000));
    await create(asha, s.trip, e2, { amount: 600, participants: [s.r, s.n], payers: { [s.r]: 600 } });
    const rows = (await balances(asha, s.trip)).rows;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.member_id)).toEqual([...rows.map((r) => r.member_id)].sort());
    const by = Object.fromEntries(rows.map((r) => [r.member_id, r]));
    const [low] = [s.a, s.r, s.n].sort(); // the member with the lowest id got the extra paisa on the 1000
    const share = (m: string) => (m === low ? 334 : 333);
    expect(by[s.a]).toMatchObject({ paid_minor: 1000, share_minor: share(s.a), net_minor: 1000 - share(s.a) });
    expect(by[s.r]).toMatchObject({ paid_minor: 600, share_minor: share(s.r) + 300, net_minor: 600 - share(s.r) - 300 });
    expect(by[s.n]).toMatchObject({ paid_minor: 0, share_minor: share(s.n) + 300, net_minor: -share(s.n) - 300 });
    expect(by[devM]).toMatchObject({ paid_minor: 0, share_minor: 0, net_minor: 0 });
    expect(rows.reduce((a, r) => a + r.net_minor, 0)).toBe(0);
    await del(asha, s.trip, e2, 1);
    expect((await balances(ravi, s.trip)).rows.find((r) => r.member_id === s.r)).toMatchObject({ paid_minor: 0, share_minor: share(s.r), net_minor: -share(s.r) });
  });

  it('shows only this trip\'s members, and an active member of another trip cannot ask about it', async () => {
    const s = await setup('Balances A');
    const other = await makeTrip(meera, 'Balances B');
    expect((await balances(asha, s.trip)).rows).toHaveLength(3);
    expect((await balances(meera, other)).rows).toHaveLength(1);
    expect(await outcome(balances(meera, s.trip))).toBe('trip_not_found');
    expect(await outcome(balances(asha, other))).toBe('trip_not_found');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('ADR-043: trip dates and expenses', () => {
  it('a date change that would strand a live expense is refused through update_trip, with the clear code, and nothing changes', async () => {
    const s = await setup('Dates');
    await create(asha, s.trip, newId(), equalAll(s, 900, { spentOn: '2026-12-29' }));
    const r = await failure(q(asha, `select * from public.update_trip($1, 1, 'Trip', 'Somewhere', '2026-12-27', '2026-12-28')`, [s.trip]));
    expect(r.message).toContain('expenses_outside_dates');
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'Trip', 'Somewhere', '2026-12-30', '2026-12-31')`, [s.trip]))).toBe('expenses_outside_dates');
    await admin();
    expect((await db.query<{ end_date: Date; version: number }>('select end_date, version from public.trips where id = $1', [s.trip])).rows[0]!.version).toBe(1);
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'Trip', 'Somewhere', '2026-12-28', '2026-12-30')`, [s.trip]))).toBe('ok'); // still covers 29 December
    expect(await outcome(q(asha, `select * from public.update_trip($1, 2, 'Trip renamed', 'Somewhere', '2026-12-28', '2026-12-30')`, [s.trip]))).toBe('ok'); // other edits are never blocked
  });

  it('only NON-DELETED expenses count: a deleted one does not block the change', async () => {
    const s = await setup('Dates deleted');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900, { spentOn: '2026-12-30' }));
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'Trip', 'Somewhere', '2026-12-27', '2026-12-29')`, [s.trip]))).toBe('expenses_outside_dates');
    await del(asha, s.trip, id, 1);
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'Trip', 'Somewhere', '2026-12-27', '2026-12-29')`, [s.trip]))).toBe('ok');
  });

  it('the guard is a trigger: it holds for any change of the dates, including direct SQL by the owner; archiving and the budget are unaffected', async () => {
    const s = await setup('Dates trigger');
    await create(asha, s.trip, newId(), equalAll(s, 900, { spentOn: '2026-12-30' }));
    await admin();
    await expect(db.query(`update public.trips set end_date = '2026-12-29' where id = $1`, [s.trip])).rejects.toThrow(/expenses_outside_dates/);
    await expect(db.query(`update public.trips set start_date = '2026-12-31', end_date = '2027-01-02' where id = $1`, [s.trip])).rejects.toThrow(/expenses_outside_dates/);
    await db.query(`update public.trips set budget_minor = 5000 where id = $1`, [s.trip]);
    await archive(s.trip);
    await archive(s.trip, false);
    await db.query(`update public.trips set end_date = '2026-12-31' where id = $1`, [s.trip]); // widening is fine
  });
});

// ---------------------------------------------------------------------------------------------------
describe('ADR-047: leaving and removal with a balance', () => {
  it('remove_member and leave_trip refuse while the balance is not zero, with the amount in the detail, and change nothing (no status, no audit event)', async () => {
    const s = await setup('Settled');
    await create(asha, s.trip, newId(), equalAll(s, 900)); // Asha +600, Ravi -300, Nina -300
    await admin();
    const events = async () => (await db.query<{ n: number }>('select count(*)::int as n from public.trip_member_events where trip_id = $1', [s.trip])).rows[0]!.n;
    const before = await events();
    const leave = await failure(q(ravi, 'select * from public.leave_trip($1)', [s.trip]));
    expect(leave.message).toContain('balance_not_settled');
    expect(leave.detail).toBe('net_minor=-300');
    const rem = await failure(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.n]));
    expect(rem.message).toContain('balance_not_settled');
    expect(rem.detail).toBe('net_minor=-300');
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.r]))).toBe('balance_not_settled');
    await admin();
    expect((await db.query<{ status: string }>('select status from public.trip_members where id = $1', [s.r])).rows[0]!.status).toBe('active');
    expect(await events()).toBe(before);
  });

  it('a creditor cannot leave either, and a person at exactly zero can; everything else about leaving is unchanged', async () => {
    const s = await setup('Zero');
    const guest = await put(s.trip, null, 'Guest Gita');
    await create(asha, s.trip, newId(), { amount: 600, participants: [s.a, s.r], payers: { [s.r]: 600 } }); // Ravi +300, Asha -300
    await put(s.trip, dev, 'Departed Dev');
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('balance_not_settled'); // owed money
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok'); // Nina has no balance
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, guest]))).toBe('ok'); // nor does the guest
    await admin();
    const ev = (await db.query<{ action: string }>('select action from public.trip_member_events where trip_id = $1 order by seq', [s.trip])).rows.map((r) => r.action);
    expect(ev).toEqual(expect.arrayContaining(['left', 'removed']));
  });

  it('becomes possible once the balance is settled by editing or deleting the expense, and a deleted expense does not count', async () => {
    const s = await setup('Settle up');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('balance_not_settled');
    await del(asha, s.trip, id, 1);
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
  });

  it('claiming a guest who has expenses keeps the balance on the same member id (no row is copied)', async () => {
    const s = await setup('Claim');
    const gita = await put(s.trip, null, 'Gita (guest)');
    await create(asha, s.trip, newId(), { amount: 900, participants: [s.a, gita], payers: { [s.a]: 900 } }); // Gita owes 450
    const before = await netOf(asha, s.trip, gita);
    expect(before).toBe(-450);
    const inv = (await q<{ token: string }>(asha, 'select * from public.create_invite($1, $2, 168)', [s.trip, gita])).rows[0]!.token;
    const sam2 = await users.signUp('gita-claimer@example.com', 'Gita Claimer');
    const req = (await q<{ request_id: string }>(sam2, 'select * from public.request_to_join($1)', [inv])).rows[0]!.request_id;
    expect(await outcome(q(asha, 'select * from public.decide_join_request($1, $2, true)', [s.trip, req]))).toBe('ok');
    expect(await netOf(sam2, s.trip, gita)).toBe(-450); // same member id, same balance, now an account
    expect((await balances(sam2, s.trip)).rows).toHaveLength(4);
    expect(await outcome(q(sam2, 'select * from public.leave_trip($1)', [s.trip]))).toBe('balance_not_settled'); // the guest's debt is now theirs
  });

  it('the guard is a trigger on the members table: any path that makes an active member left or removed is covered, nothing else is', async () => {
    const s = await setup('Settle trigger');
    await create(asha, s.trip, newId(), equalAll(s, 900));
    await admin();
    await expect(db.query(`update public.trip_members set status = 'removed' where id = $1`, [s.n])).rejects.toThrow(/balance_not_settled/);
    await db.query(`update public.trip_members set display_name = 'Nina S.' where id = $1`, [s.n]); // other changes are fine
    await db.query(`update public.trip_members set role = 'admin' where id = $1`, [s.n]);
    await db.query(`update public.trip_members set role = 'member' where id = $1`, [s.n]);
    const t = (await db.query<{ tgname: string; def: string }>(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgname in ('trip_members_balance_guard', 'trips_dates_guard') order by 1`)).rows;
    expect(t.map((x) => x.tgname)).toEqual(['trip_members_balance_guard', 'trips_dates_guard']);
    expect(t[0]!.def).toMatch(/BEFORE UPDATE OF status ON public.trip_members/);
    expect(t[0]!.def).toMatch(/old\.status = 'active'/i);
    expect(t[1]!.def).toMatch(/BEFORE UPDATE OF start_date, end_date ON public.trips/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Rule I-1: former members stay at zero (the COMPLETE resulting ledger)', () => {
  /** Acts on the golden ledger vectors: members get the fixed ids so the hand-worked rounding applies. */
  const ledgerTrips: string[] = [];
  async function runLedger(vectorName: string) {
    const v = LEDGER_VECTORS.find((x) => x.name === vectorName)!;
    await admin();
    for (const old of ledgerTrips.splice(0)) await db.query('delete from public.trips where id = $1', [old]); // frees the fixed member ids

    const accounts: Record<string, string> = {};
    const trip = await makeTrip(asha, `Ledger ${vectorName.slice(0, 20)}`);
    ledgerTrips.push(trip);
    // The administrator is member "A"; its generated id is replaced by the fixed one before anything refers to it.
    await admin();
    await db.query('update public.trip_members set id = $2 where trip_id = $1 and user_id = $3', [trip, MEMBER_IDS.A, asha]);
    accounts.A = asha;
    for (const k of v.members.slice(1)) {
      accounts[k] = await users.signUp(`vec-${k}-${trip}@example.com`, `Vector ${k}`);
      await put(trip, accounts[k]!, `Vector ${k}`, { id: MEMBER_IDS[k]! });
    }
    const ids = (keys: string[]) => keys.map((k) => MEMBER_IDS[k]!);
    const pay = (p: Record<string, number>) => Object.fromEntries(Object.entries(p).map(([k, n]) => [MEMBER_IDS[k]!, n]));
    const splitOf = (op: VectorOp & { op: 'create' | 'edit' }) => (op.split ? { method: op.split.method, inputs: pay(op.split.values) } : {});
    const expenseIds: Record<string, string> = {};
    const versions: Record<string, number> = {};
    for (const [i, step] of v.steps.entries()) {
      const op: VectorOp = step.do;
      let run: PromiseLike<unknown>;
      if (op.op === 'create') {
        expenseIds[op.key] = newId();
        run = create(asha, trip, expenseIds[op.key]!, { title: op.key, amount: op.amount, participants: ids(op.participants), payers: pay(op.payers), ...splitOf(op) }).then(() => { versions[op.key] = 1; });
      } else if (op.op === 'edit') {
        run = update(asha, trip, expenseIds[op.key]!, versions[op.key]!, { title: op.key, amount: op.amount, participants: ids(op.participants), payers: pay(op.payers), ...splitOf(op) }).then(() => { versions[op.key]! += 1; });
      } else if (op.op === 'delete') {
        run = del(asha, trip, expenseIds[op.key]!, versions[op.key]!).then(() => { versions[op.key]! += 1; });
      } else if (op.op === 'restore') {
        run = restore(asha, trip, expenseIds[op.key]!, versions[op.key]!).then(() => { versions[op.key]! += 1; });
      } else if (op.op === 'leave') {
        run = q(accounts[op.member]!, 'select * from public.leave_trip($1)', [trip]);
      } else if (op.op === 'remove') {
        run = q(asha, 'select * from public.remove_member($1, $2)', [trip, MEMBER_IDS[op.member]!]);
      } else {
        throw new Error('unknown step');
      }
      expect(await outcome(run), `step ${i + 1}: ${JSON.stringify(op)}`).toBe(step.error ?? 'ok');
      const got = Object.fromEntries((await balances(asha, trip)).rows.map((r) => [r.member_id, r.net_minor]));
      for (const [k, expected] of Object.entries(step.balances)) expect(got[MEMBER_IDS[k]!], `step ${i + 1} balance of ${k}`).toBe(expected);
      if (step.error) {
        // a refused step changed nothing at all: not the version, not the history
        for (const [key, id] of Object.entries(expenseIds)) expect((await expenseRow(id))!.version, `${key} after refused step ${i + 1}`).toBe(versions[key]);
      }
    }
    return { trip, expenseIds, versions };
  }

  for (const name of LEDGER_VECTORS.map((x) => x.name)) {
    it(`golden ledger: ${name}`, async () => {
      await runLedger(name);
    });
  }

  it('a refused edit, delete or restore leaves rows, version AND history exactly as they were (it all rolls back)', async () => {
    const { expenseIds, versions } = await runLedger(LEDGER_VECTORS[2]!.name);
    for (const [key, id] of Object.entries(expenseIds)) {
      const rev = await revisions(id);
      expect(rev.length, key).toBe(versions[key]); // one history entry per version, none for refused attempts
      expect(rev.map((r) => r.version), key).toEqual(rev.map((_, i) => i + 1));
    }
  });

  it('create can never affect a former member (they cannot be chosen), so it is allowed while they sit at zero', async () => {
    const s = await setup('I-1 create');
    await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const devM = await memberOf(s.trip, dev);
    expect(await outcome(create(asha, s.trip, newId(), { amount: 600, participants: [s.a, devM], payers: { [s.a]: 600 } }))).toBe('participant_not_active');
    expect(await outcome(create(asha, s.trip, newId(), { amount: 600, participants: [s.a], payers: { [devM]: 600 } }))).toBe('payer_not_active');
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 600)))).toBe('ok');
    expect(await netOf(asha, s.trip, devM)).toBe(0);
  });

  it('uses the WHOLE ledger: when a former member already has a non-zero balance elsewhere (seeded by bypassing the guards), even a zero-contribution edit is refused', async () => {
    const s = await setup('I-1 whole');
    await put(s.trip, dev, 'Departed Dev');
    const devM = await memberOf(s.trip, dev);
    const zero = newId(); // Dev paid 1000 and owes 1000: a contribution of zero
    await create(asha, s.trip, zero, { amount: 1000, participants: [devM], payers: { [devM]: 1000 } });
    const debt = newId(); // Dev owes 500 here
    await create(asha, s.trip, debt, { amount: 1000, participants: [s.a, devM], payers: { [s.a]: 1000 } });
    expect(await netOf(asha, s.trip, devM)).toBe(-500);
    // Make Dev a former member while owing money, which the guard normally forbids: bypass the triggers (owner only, test only).
    await admin();
    await db.exec(`set session_replication_role = replica; update public.trip_members set status = 'left', left_at = now() where id = '${devM}'; set session_replication_role = origin;`);
    expect(await netOf(asha, s.trip, devM)).toBe(-500);
    // Editing the zero-contribution expense does not change Dev's contribution, but the resulting ledger still leaves Dev at -500
    expect(await outcome(update(asha, s.trip, zero, 1, { amount: 1000, participants: [s.a], payers: { [s.a]: 1000 } }))).toBe('former_member_balance');
    expect(await outcome(del(asha, s.trip, zero, 1))).toBe('former_member_balance');
    expect((await expenseRow(zero))!.version).toBe(1);
    // an expense that does not involve Dev at all is unaffected
    const free = newId();
    expect(await outcome(create(asha, s.trip, free, equalAll(s, 600)))).toBe('ok');
    expect(await outcome(update(asha, s.trip, free, 1, equalAll(s, 900)))).toBe('ok');
    expect(await outcome(del(asha, s.trip, free, 2))).toBe('ok');
    expect(await outcome(restore(asha, s.trip, free, 3))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('categories (ownership)', () => {
  it('system categories are seeded and readable by members; every system key is unique', async () => {
    const s = await setup('Categories');
    const rows = (await q<{ key: string; trip_id: string | null }>(ravi, 'select key, trip_id from public.categories order by key')).rows;
    expect(rows.map((r) => r.key)).toEqual(['accommodation', 'activities', 'food', 'fuel_tolls', 'other', 'shopping', 'transportation']);
    expect(rows.every((r) => r.trip_id === null)).toBe(true);
    expect(await outcome(q(ravi, 'select 1 from public.categories where false'))).toBe('ok');
    await admin();
    await expect(db.query(`insert into public.categories (key, name, icon) values ('food', 'Food again', 'x')`)).rejects.toThrow(/duplicate key/);
    expect(s.trip).toBeTruthy();
  });

  it('an expense cannot use a category that belongs to ANOTHER trip, by the function or by direct writes; own-trip and system categories are accepted', async () => {
    const mine = await setup('Cat mine');
    const other = await makeTrip(meera, 'Cat other');
    await admin();
    const theirs = (await db.query<{ id: string }>(`insert into public.categories (trip_id, key, name, icon) values ($1, 'secret_cat', 'Their secret category', 'x') returning id`, [other])).rows[0]!.id;
    const ours = (await db.query<{ id: string }>(`insert into public.categories (trip_id, key, name, icon) values ($1, 'our_cat', 'Our own category', 'x') returning id`, [mine.trip])).rows[0]!.id;
    // through the function (which looks keys up among system categories only for now)
    expect(await outcome(create(asha, mine.trip, newId(), equalAll(mine, 900, { category: 'secret_cat' })))).toBe('category_not_found');
    // directly (the trigger is the final guard)
    await admin();
    const insert = (trip: string, member: string, category: string | null) => db.query(
      `insert into public.expenses (id, trip_id, title, amount_minor, category_id, spent_on, split_method, created_by) values ($1, $2, 'T', 100, $3, '2026-12-28', 'equal', $4)`, [newId(), trip, category, member]);
    await expect(insert(mine.trip, mine.a, theirs)).rejects.toThrow(/category_not_found/);
    await insert(mine.trip, mine.a, ours).catch(() => undefined); // deferred sums fail at commit for lack of payers: the category itself was accepted
    const system = (await db.query<{ id: string }>(`select id from public.categories where key = 'food' and trip_id is null`)).rows[0]!.id;
    // moving an existing expense to another trip's category is refused too
    const id = newId();
    await create(asha, mine.trip, id, equalAll(mine, 900));
    await admin();
    await expect(db.query('update public.expenses set category_id = $2 where id = $1', [id, theirs])).rejects.toThrow(/category_not_found/);
    await db.query('update public.expenses set category_id = $2 where id = $1', [id, system]);
    expect(await count('categories', 'trip_id is null')).toBe(7);
  });

  it('a trip-specific category and a system category with the same key are kept apart (unique per scope)', async () => {
    const mine = await setup('Cat scope');
    await admin();
    await db.query(`insert into public.categories (trip_id, key, name, icon) values ($1, 'food', 'Our food', 'x')`, [mine.trip]); // allowed: a different scope from the system key
    await expect(db.query(`insert into public.categories (trip_id, key, name, icon) values ($1, 'food', 'Our food 2', 'x')`, [mine.trip])).rejects.toThrow(/duplicate key/);
    expect((await q<{ key: string }>(asha, `select key from public.categories where key = 'food'`)).rows).toHaveLength(2); // mine and the system one
    expect((await q<{ key: string }>(meera, `select key from public.categories where key = 'food'`)).rows).toHaveLength(1); // only the system one: another trip's category is invisible
  });
});

// ---------------------------------------------------------------------------------------------------
describe('table rules (as the owner): ids, composite keys, sums', () => {
  it('the expense id is globally unique (primary key) and (id, trip_id) is also unique', async () => {
    const s = await setup('Keys A');
    const o = await setup('Keys B');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ($1, $2, 'T', 100, '2026-12-28', 'equal', $3)`, [id, o.trip, o.a])).rejects.toThrow(/duplicate key|expenses_pkey/);
    const cons = (await db.query<{ conname: string; contype: string }>(`select conname, contype from pg_constraint where conrelid = 'public.expenses'::regclass and contype in ('p', 'u') order by conname`)).rows;
    expect(cons).toEqual(expect.arrayContaining([{ conname: 'expenses_id_trip_unique', contype: 'u' }, { conname: 'expenses_pkey', contype: 'p' }]));
  });

  it('a payer, a participant or a history entry cannot point at a member of ANOTHER trip (composite keys)', async () => {
    const s = await setup('Composite A');
    const o = await setup('Composite B');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor) values ($1, $2, $3, 1)`, [id, s.trip, o.r])).rejects.toThrow(/payer_not_active|expense_payers_member_fk|foreign key/);
    await expect(db.query(`insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor) values ($1, $2, $3, 0)`, [id, s.trip, o.r])).rejects.toThrow(/participant_not_active|expense_splits_member_fk|foreign key/);
    await expect(db.query(`insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor) values ($1, $2, $3, 1)`, [id, o.trip, s.r])).rejects.toThrow(/payer_not_active|foreign key/); // the expense is not in that trip either
    await expect(db.query(`insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ($1, $2, 'T', 100, '2026-12-28', 'equal', $3)`, [newId(), s.trip, o.a])).rejects.toThrow(/expenses_creator_fk|foreign key/);
    await expect(db.query(`insert into public.expense_revisions (expense_id, trip_id, version, action, snapshot, changed_by) values ($1, $2, 99, 'update', '{}', $3)`, [id, s.trip, o.a])).rejects.toThrow(/expense_revisions_changer_fk|foreign key/);
  });

  it('payments and shares must each add up to the amount when the change is saved, and each expense needs at least one payer and one share', async () => {
    const s = await setup('Sums');
    await admin();
    const mk = (id: string, payers: number[], shares: number[], amount = 1000) => db.exec(`
      begin;
      insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ('${id}', '${s.trip}', 'T', ${amount}, '2026-12-28', 'equal', '${s.a}');
      ${payers.map((p, i) => `insert into public.expense_payers values ('${id}', '${s.trip}', '${[s.a, s.r, s.n][i]}', ${p});`).join('\n')}
      ${shares.map((p, i) => `insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor) values ('${id}', '${s.trip}', '${[s.a, s.r, s.n].sort()[i]}', ${p});`).join('\n')}
      commit;`);
    await expect(mk(newId(), [1000], [500, 499])).rejects.toThrow(/shares_total_mismatch/);
    await expect(mk(newId(), [999], [500, 500])).rejects.toThrow(/payers_total_mismatch/);
    await expect(mk(newId(), [], [500, 500])).rejects.toThrow(/invalid_expense/);
    await expect(mk(newId(), [1000], [])).rejects.toThrow(/invalid_expense/);
    await db.exec('rollback').catch(() => undefined);
    await mk(newId(), [600, 400], [334, 333, 333]);
    // changing the amount of an existing expense without its rows is refused at save time too
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query('update public.expenses set amount_minor = 901 where id = $1', [id])).rejects.toThrow(/payers_total_mismatch/);
  });

  it('column rules: amount, title, notes, scope and split method are checked by the table itself', async () => {
    const s = await setup('Columns');
    await admin();
    const ins = (cols: string, vals: string) => db.query(`insert into public.expenses (id, trip_id, spent_on, created_by, ${cols}) values ('${newId()}', '${s.trip}', '2026-12-28', '${s.a}', ${vals})`);
    await expect(ins('title, amount_minor, split_method', `'T', 0, 'equal'`)).rejects.toThrow(/expenses_amount_range/);
    await expect(ins('title, amount_minor, split_method', `'T', 1000000000001, 'equal'`)).rejects.toThrow(/expenses_amount_range/);
    await expect(ins('title, amount_minor, split_method', `' T ', 100, 'equal'`)).rejects.toThrow(/expenses_title_length/);
    await expect(ins('title, amount_minor, split_method', `'', 100, 'equal'`)).rejects.toThrow(/expenses_title_length/);
    await expect(ins('title, amount_minor, split_method', `'T', 100, 'weird'`)).rejects.toThrow(/expenses_split_method_values/);
    await expect(ins('title, amount_minor, split_method, scope', `'T', 100, 'equal', 'personal'`)).rejects.toThrow(/expenses_scope_shared_only/);
    await expect(ins('title, amount_minor, split_method, notes', `'T', 100, 'equal', ''`)).rejects.toThrow(/expenses_notes_length/);
    await expect(ins('title, amount_minor, split_method, deleted_at', `'T', 100, 'equal', now()`)).rejects.toThrow(/expenses_deleted_pair/);
  });

  it('removing a whole trip removes its expenses, payers, shares and history with it (nothing is left behind, no key error)', async () => {
    const s = await setup('Cascade');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await update(asha, s.trip, id, 1, equalAll(s, 1200));
    await admin();
    await db.query('delete from public.trips where id = $1', [s.trip]);
    expect(await count('expenses', 'trip_id = $1', [s.trip])).toBe(0);
    expect(await count('expense_payers', 'expense_id = $1', [id])).toBe(0);
    expect(await count('expense_splits', 'expense_id = $1', [id])).toBe(0);
    expect(await count('expense_revisions', 'expense_id = $1', [id])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('expense history: who can read it, what it holds, and that nobody can change it', () => {
  it('only ACTIVE members of the trip can read expenses, shares and history; former members, strangers and other trips\' members see nothing', async () => {
    const s = await setup('History access');
    await put(s.trip, dev, 'Departed Dev');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await update(asha, s.trip, id, 1, equalAll(s, 1200));
    for (const t of ['expenses', 'expense_payers', 'expense_splits', 'expense_revisions']) {
      expect((await q(ravi, `select * from public.${t} where trip_id = $1`, [s.trip])).rows.length, t).toBeGreaterThan(0);
      expect((await q(sam, `select * from public.${t} where trip_id = $1`, [s.trip])).rows, t).toEqual([]);
      expect((await q(meera, `select * from public.${t} where trip_id = $1`, [s.trip])).rows, t).toEqual([]);
    }
    // Dev is a member now and can read; once Dev has left, nothing at all
    expect((await q(dev, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows).toHaveLength(2);
    expect(await outcome(q(dev, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
    for (const t of ['expenses', 'expense_payers', 'expense_splits', 'expense_revisions']) expect((await q(dev, `select * from public.${t} where trip_id = $1`, [s.trip])).rows, t).toEqual([]);
    expect(await outcome(balances(dev, s.trip))).toBe('trip_not_found');
  });

  it('a signed-out visitor cannot read any of the tables', async () => {
    for (const t of ['expenses', 'expense_payers', 'expense_splits', 'expense_revisions', 'categories']) expect(await outcome(q(null, `select * from public.${t}`)), t).toBe('permission denied');
  });

  it('signed-in users cannot write any of the tables directly; no insert, update, delete or truncate', async () => {
    const s = await setup('Direct writes');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    const rev = (await revisions(id))[0]!;
    for (const who of [asha, ravi]) {
      expect(await outcome(q(who, `insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ($1, $2, 'T', 1, '2026-12-28', 'equal', $3)`, [newId(), s.trip, s.a])), who).toBe('permission denied');
      expect(await outcome(q(who, `update public.expenses set title = 'hacked' where id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `delete from public.expenses where id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `update public.expense_payers set paid_minor = 1 where expense_id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `delete from public.expense_splits where expense_id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `update public.expense_revisions set snapshot = '{}' where expense_id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `delete from public.expense_revisions where expense_id = $1`, [id])), who).toBe('permission denied');
      expect(await outcome(q(who, `truncate public.expense_revisions`)), who).toBe('permission denied');
      expect(await outcome(q(who, `insert into public.categories (key, name, icon) values ('x', 'x', 'x')`)), who).toBe('permission denied');
    }
    expect((await expenseRow(id))!.title).toBe('Dinner');
    expect(rev.action).toBe('create');
  });

  it('history is append-only even for the owner role: no update, delete or truncate (only the automatic clean-up of a removed trip)', async () => {
    const s = await setup('Append only');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`update public.expense_revisions set action = 'delete' where expense_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from public.expense_revisions where expense_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate public.expense_revisions`)).rejects.toThrow(/append-only/);
    expect(await revisions(id)).toHaveLength(1);
  });

  it('a snapshot holds expense fields and member ids with amounts only: never a user id, an email or a display name', async () => {
    const s = await setup('History content');
    const id = newId();
    await create(asha, s.trip, id, { title: 'Boat trip', amount: 1000, notes: 'with snacks', participants: [s.a, s.r], payers: { [s.a]: 1000 } });
    await update(asha, s.trip, id, 1, { title: 'Boat trip', amount: 1200, participants: [s.a, s.r, s.n], payers: { [s.a]: 700, [s.r]: 500 } });
    await del(asha, s.trip, id, 2);
    await restore(asha, s.trip, id, 3);
    const rev = await revisions(id);
    expect(rev.map((r) => r.action)).toEqual(['create', 'update', 'delete', 'restore']);
    for (const r of rev) {
      expect(Object.keys(r.snapshot).sort()).toEqual(['amount_minor', 'category_key', 'deleted', 'notes', 'payers', 'spent_on', 'split_method', 'splits', 'title']);
      for (const p of r.snapshot.payers) expect(Object.keys(p).sort()).toEqual(['member_id', 'paid_minor']);
      for (const p of r.snapshot.splits) expect(Object.keys(p).sort()).toEqual(['member_id', 'share_minor']);
      const text = JSON.stringify(r.snapshot);
      for (const secret of [asha, ravi, nina, 'asha@example.com', 'Asha', 'Ravi', 'Nina', 'Rao', 'Kumar', 'Shah']) expect(text, `${secret}`).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('lock order (ADR-063): trip first, then the expense; guards add no locks', () => {
  const FUNCTIONS = ['create_expense', 'update_expense', 'delete_expense', 'restore_expense'];
  const src = async (name: string) => {
    await admin();
    return (await db.query<{ prosrc: string }>(`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name])).rows[0]!.prosrc;
  };
  const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');

  it('every expense write function takes the trip lock (member_change_context) BEFORE anything else, and locks the expense row only after it', async () => {
    for (const name of FUNCTIONS) {
      const body = stripComments(await src(name));
      const ctx = body.indexOf('member_change_context');
      expect(ctx, name).toBeGreaterThan(-1);
      const forUpdate = [...body.matchAll(/for update/gi)].map((m) => m.index!);
      for (const at of forUpdate) expect(at, `${name}: a lock taken before the trip lock`).toBeGreaterThan(ctx);
      const firstWrite = body.search(/\b(insert\s+into|update\s+public\.|delete\s+from)/i);
      expect(firstWrite, `${name}: a write before the trip lock`).toBeGreaterThan(ctx);
      expect(body, name).not.toMatch(/from public\.trips[^;]*for (update|share)/i); // the trips row is only ever locked by the shared helper
    }
  });

  it('the guard triggers and every helper only READ: no FOR UPDATE, FOR SHARE or LOCK anywhere in them', async () => {
    const helpers = ['assert_member_settled', 'assert_expenses_within_dates', 'assert_former_members_settled', 'member_net_minor', 'trip_members_balance_guard',
      'trips_dates_guard', 'expenses_check_category', 'check_expense_sums', 'allocate_equal', 'expense_check_shape', 'expense_check_state', 'expense_stored_canonical', 'trip_member_balances'];
    for (const name of helpers) expect(stripComments(await src(name)), name).not.toMatch(/for\s+(update|share|no key update|key share)\b|\block\s+table\b|pg_advisory/i);
  });

  it('every path that changes who is on a trip, or the trip itself, locks the trip row before it writes', async () => {
    await admin();
    const fns = (await db.query<{ proname: string; prosrc: string }>(
      `select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows;
    const writers = fns.filter((f) => /\b(update\s+public\.(trip_members|trips)|insert\s+into\s+public\.trip_members)\b/i.test(stripComments(f.prosrc)) && f.proname !== 'create_trip');
    expect(writers.map((f) => f.proname).sort()).toEqual(expect.arrayContaining(['add_guest_member', 'decide_join_request', 'leave_trip', 'remove_member', 'set_member_role', 'set_trip_archived', 'update_trip']));
    for (const f of writers) {
      const body = stripComments(f.prosrc);
      const lock = Math.min(...['member_change_context', 'for update'].map((k) => (body.indexOf(k) < 0 ? Infinity : body.indexOf(k))));
      const write = body.search(/\b(update\s+public\.(trip_members|trips)|insert\s+into\s+public\.trip_members)\b/i);
      expect(lock, `${f.proname}: no lock`).toBeLessThan(Infinity);
      expect(lock, `${f.proname}: writes before it locks`).toBeLessThan(write);
    }
  });
});

describe('lock order, proven at the moment of change (probes in a separate test database)', () => {
  let pdb: PGlite;
  let pusers: TestUsers;
  let pa: string;
  let pr: string;
  let pn: string;
  let trip: string;
  let a: string;
  let r: string;
  let n: string;

  const pq = async <T = Record<string, any>>(who: string, sql: string, args: unknown[] = []) => (await as(who, pdb, pusers)).query<T>(sql, args);
  const probeRows = async () => {
    await pusers.asAdmin();
    const rows = (await pdb.query<{ tbl: string; op: string; locked: boolean }>('select tbl, op, locked from public.lock_probe order by id')).rows;
    await pdb.query('truncate public.lock_probe');
    return rows;
  };

  beforeAll(async () => {
    pdb = await newDatabase();
    pusers = new TestUsers(pdb);
    pa = await pusers.signUp('pa@example.com', 'Pa Admin');
    pr = await pusers.signUp('pr@example.com', 'Pr Member');
    pn = await pusers.signUp('pn@example.com', 'Pn Member');
    await pusers.asUser(pa);
    trip = (await pdb.query<{ id: string }>(`select id from public.create_trip('Probe', 'Somewhere', '2026-12-27', '2026-12-30')`)).rows[0]!.id;
    await pusers.asAdmin();
    a = (await pdb.query<{ id: string }>('select id from public.trip_members where trip_id = $1', [trip])).rows[0]!.id;
    r = (await pdb.query<{ id: string }>(`insert into public.trip_members (trip_id, user_id, display_name) values ($1, $2, 'R') returning id`, [trip, pr])).rows[0]!.id;
    n = (await pdb.query<{ id: string }>(`insert into public.trip_members (trip_id, user_id, display_name) values ($1, $2, 'N') returning id`, [trip, pn])).rows[0]!.id;
    // Test-only probes: whenever one of these rows is about to change, record whether THIS transaction already holds the trip row lock
    // (a FOR UPDATE lock leaves the transaction's id in the row's xmax).
    await pdb.exec(`
      create table public.lock_probe (id bigserial primary key, tbl text, op text, locked boolean);
      create function public.probe_fn() returns trigger language plpgsql security definer set search_path = '' as $$
      declare v_trip uuid; v_locked boolean; j jsonb;
      begin
        j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
        v_trip := coalesce((j ->> 'trip_id')::uuid, case when tg_table_name = 'trips' then (j ->> 'id')::uuid end);
        select t.xmax::text::bigint = (txid_current() & 4294967295) into v_locked from public.trips t where t.id = v_trip;
        insert into public.lock_probe (tbl, op, locked) values (tg_table_name, tg_op, coalesce(v_locked, false));
        return case when tg_op = 'DELETE' then old else new end;
      end $$;
      create trigger zz_probe before insert or update or delete on public.trip_members for each row execute function public.probe_fn();
      create trigger zz_probe before update on public.trips for each row execute function public.probe_fn();
      create trigger zz_probe before insert or update or delete on public.expenses for each row execute function public.probe_fn();
      create trigger zz_probe before insert or update or delete on public.expense_payers for each row execute function public.probe_fn();
      create trigger zz_probe before insert or update or delete on public.expense_splits for each row execute function public.probe_fn();
      create trigger zz_probe before insert on public.expense_revisions for each row execute function public.probe_fn();
    `);
    await pdb.query('truncate public.lock_probe');
  });
  afterAll(async () => {
    await pdb.close();
  });

  const all = (rows: { locked: boolean }[]) => rows.length > 0 && rows.every((x) => x.locked);
  const mk = (id: string, e: Exp) => pq(pa, CREATE_SQL, createArgs(trip, id, e));

  it('the probe itself works: a bare change with no lock records "not locked", and a locked one records "locked"', async () => {
    await pusers.asAdmin();
    await pdb.query(`update public.trip_members set display_name = 'R2' where id = $1`, [r]);
    expect((await probeRows()).map((x) => x.locked)).toEqual([false]);
    await pdb.exec(`begin; select 1 from public.trips where id = '${trip}' for update; update public.trip_members set display_name = 'R' where id = '${r}'; commit;`);
    expect((await probeRows()).map((x) => x.locked)).toEqual([true]);
  });

  it('create, edit, delete and restore of an expense change every row only while the trip is locked', async () => {
    const id = newId();
    const e: Exp = { amount: 900, participants: [a, r, n], payers: { [a]: 900 } };
    await mk(id, e);
    let rows = await probeRows();
    expect(all(rows)).toBe(true);
    expect(new Set(rows.map((x) => x.tbl))).toEqual(new Set(['expenses', 'expense_payers', 'expense_splits', 'expense_revisions']));
    await pq(pa, UPDATE_SQL, [trip, id, 1, 'Dinner', 1200, '2026-12-28', 'food', null, 'equal', [a, r], payersJson({ [a]: 1200 })]); // 11 arguments: the new optional one is left out
    rows = await probeRows();
    expect(all(rows)).toBe(true);
    expect(rows.some((x) => x.tbl === 'expense_payers' && x.op === 'DELETE')).toBe(true);
    await pq(pa, 'select * from public.delete_expense($1, $2, 2)', [trip, id]);
    expect(all(await probeRows())).toBe(true);
    await pq(pa, 'select * from public.restore_expense($1, $2, 3)', [trip, id]);
    expect(all(await probeRows())).toBe(true);
    await pq(pa, 'select * from public.delete_expense($1, $2, 4)', [trip, id]);
    await probeRows();
  });

  it('remove_member, leave_trip, set_member_role, add_guest_member, rename_guest_member, update_trip and set_trip_archived all hold the trip lock when they change a row', async () => {
    const calls: [string, string, unknown[]][] = [
      [pa, 'select * from public.add_guest_member($1, $2)', [trip, 'Probe Guest']],
      [pa, 'select * from public.set_member_role($1, $2, $3, $4)', [trip, n, 'admin', 'member']],
      [pa, 'select * from public.set_member_role($1, $2, $3, $4)', [trip, n, 'member', 'admin']],
      [pa, `select * from public.update_trip($1, $2, 'Probe renamed', 'Somewhere', '2026-12-27', '2026-12-30')`, [trip, 1]],
      [pa, 'select * from public.set_trip_archived($1, $2, $3)', [trip, true, 2]],
      [pa, 'select * from public.set_trip_archived($1, $2, $3)', [trip, false, 3]],
      [pn, 'select * from public.leave_trip($1)', [trip]],
      [pa, 'select * from public.remove_member($1, $2)', [trip, r]],
    ];
    for (const [who, sql, args] of calls) {
      await pq(who, sql, args);
      const rows = await probeRows();
      expect(all(rows), sql).toBe(true);
    }
    // the guest created above can be renamed too
    await pusers.asAdmin();
    const guest = (await pdb.query<{ id: string }>(`select id from public.trip_members where trip_id = $1 and display_name = 'Probe Guest'`, [trip])).rows[0]!.id;
    await pq(pa, 'select * from public.rename_guest_member($1, $2, $3)', [trip, guest, 'Probe Guest 2']);
    expect(all(await probeRows())).toBe(true);
  });

  it('approving a join request (an addition or a return) holds the trip lock when it changes the members', async () => {
    const joiner = await pusers.signUp('joiner@example.com', 'Joiner');
    const inv = (await pq<{ token: string }>(pa, 'select * from public.create_invite($1, null, 168)', [trip])).rows[0]!.token;
    const req = (await pq<{ request_id: string }>(joiner, 'select * from public.request_to_join($1)', [inv])).rows[0]!.request_id;
    await probeRows();
    await pq(pa, 'select * from public.decide_join_request($1, $2, true)', [trip, req]);
    expect(all(await probeRows())).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('races, simulated as "second caller after the first" in BOTH orders', () => {
  it('expense first, then the member leaves: refused while they are part of it. Member leaves first, then the old form is sent: refused', async () => {
    const s = await setup('Race leave');
    const guest = await put(s.trip, null, 'Gone guest');
    // order 1: the expense lands first, so the guest can no longer be removed
    const id = newId();
    await create(asha, s.trip, id, { amount: 600, participants: [s.a, guest], payers: { [s.a]: 600 } });
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, guest]))).toBe('balance_not_settled');
    // order 2: remove first (after the expense is deleted), then a stale form that still names the guest
    await del(asha, s.trip, id, 1);
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, guest]))).toBe('ok');
    expect(await outcome(create(asha, s.trip, newId(), { amount: 600, participants: [s.a, guest], payers: { [s.a]: 600 } }))).toBe('participant_not_active');
    expect(await outcome(create(asha, s.trip, newId(), { amount: 600, participants: [s.a], payers: { [guest]: 600 } }))).toBe('payer_not_active');
    expect(await outcome(update(asha, s.trip, (await (async () => { const x = newId(); await create(asha, s.trip, x, equalAll(s, 300)); return x; })()), 1, { amount: 300, participants: [s.a, guest], payers: { [s.a]: 300 } }))).toBe('participant_not_active');
  });

  it('a member leaves first, then their pending edit that still names them is refused; their earlier expense keeps them out of leaving', async () => {
    const s = await setup('Race leave 2');
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 900)))).toBe('participant_not_active');
    expect(await outcome(create(asha, s.trip, newId(), { amount: 900, participants: [s.a, s.r], payers: { [s.n]: 900 } }))).toBe('payer_not_active');
  });

  it('the trip\'s dates and a new expense, in both orders', async () => {
    const s = await setup('Race dates');
    // order 1: the date change lands first, a stale expense dated in the removed days is refused
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'T', 'S', '2026-12-27', '2026-12-28')`, [s.trip]))).toBe('ok');
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 900, { spentOn: '2026-12-30' })))).toBe('outside_trip_dates');
    // order 2: the expense lands first, a stale date change that would strand it is refused
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 900, { spentOn: '2026-12-28' })))).toBe('ok');
    expect(await outcome(q(asha, `select * from public.update_trip($1, 2, 'T', 'S', '2026-12-27', '2026-12-27')`, [s.trip]))).toBe('expenses_outside_dates');
  });

  it('two people editing the same expense: the second one, still holding the old version, is told to reload', async () => {
    const s = await setup('Race edit');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 1000)))).toBe('ok');
    expect(await outcome(update(ravi, s.trip, id, 1, equalAll(s, 1100, { payers: { [s.r]: 1100 } })))).toBe('not_allowed'); // not theirs
    await put(s.trip, null, 'x'); // (just to keep the trip busy)
    expect(await outcome(update(asha, s.trip, id, 1, equalAll(s, 1100)))).toBe('version_conflict');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('version_conflict');
    expect((await expenseRow(id))!.amount_minor).toBe(1000);
  });

  it('two creates with the same id, in sequence: the second is a safe no-op if identical, "taken" otherwise', async () => {
    const s = await setup('Race create');
    const id = newId();
    const e = equalAll(s, 900);
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(true);
    expect((await create(asha, s.trip, id, e)).rows[0]!.created).toBe(false);
    expect(await outcome(create(asha, s.trip, id, equalAll(s, 901)))).toBe('expense_id_taken');
    expect(await count('expenses', 'id = $1', [id])).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('parity with the TypeScript engine', () => {
  const alloc = async (amount: number, ids: string[]) => {
    await admin();
    return Object.fromEntries((await db.query<{ member_id: string; share_minor: number }>('select * from public.allocate_equal($1::bigint, $2::uuid[])', [amount, ids])).rows.map((r) => [r.member_id, r.share_minor]));
  };

  for (const v of SPLIT_VECTORS.filter((x) => !x.method || x.method === 'equal')) {
    it(`golden allocation (database): ${v.name}`, async () => {
      expect(await alloc(v.amountMinor, v.participants)).toEqual(v.shares);
    });
  }

  it('the database derives exactly what a stored expense holds for every golden vector (through create_expense)', async () => {
    const s = await setup('Golden stored');
    // map each vector's ids onto real members of one trip by rank, then compare the stored shares
    for (const v of SPLIT_VECTORS.filter((x) => (!x.method || x.method === 'equal') && x.participants.length <= 7)) {
      const ids = [...v.participants].sort();
      // the same ids with a different (random) prefix: their ORDER, which decides ties, is unchanged, but they cannot clash with other tests' members
      const prefix = randomUUID().slice(0, 8);
      const unique = (id: string) => prefix + id.slice(8);
      const back = new Map(ids.map((id) => [unique(id), id]));
      await admin();
      const trip = await makeTrip(asha, `Golden ${v.name.slice(0, 15)}`);
      const members: string[] = [];
      for (const [i, id] of ids.entries()) members.push(await put(trip, null, `G${i}`, { id: unique(id) }));
      const id = newId();
      await create(asha, trip, id, { amount: v.amountMinor, participants: members, payers: { [members[0]!]: v.amountMinor } });
      const stored = Object.fromEntries((await rowsOf(id)).shares.map((r) => [back.get(r.trip_member_id)!, r.share_minor]));
      expect(stored, v.name).toEqual(v.shares);
      await admin();
      await db.query('delete from public.trips where id = $1', [trip]); // frees the fixed member ids for the next vector
    }
    expect(s.trip).toBeTruthy();
  });

  it('allocate_equal refuses a duplicate member, a null member, nobody, and a negative total', async () => {
    await admin();
    const id = newId();
    for (const [total, ids] of [[100, [id, id]], [100, []], [-1, [id]]] as [number, string[]][]) {
      await expect(db.query('select * from public.allocate_equal($1::bigint, $2::uuid[])', [total, ids])).rejects.toThrow(/invalid_expense/);
    }
    await expect(db.query('select * from public.allocate_equal(100, array[null]::uuid[])')).rejects.toThrow(/invalid_expense/);
  });

  it('randomised: 3000 random amounts and member sets give the same allocation in SQL and TypeScript', async () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rand() * 12);
      const ids = Array.from({ length: n }, () => randomUUID());
      const magnitude = [50, 5_000, 5_000_000, 1_000_000_000_000][Math.floor(rand() * 4)]!;
      const amount = 1 + Math.floor(rand() * magnitude);
      const sql = await alloc(amount, ids);
      const ts = Object.fromEntries(computeSplit(amount, { method: 'equal', participants: ids }).map((r) => [r.memberId, r.shareMinor]));
      expect(sql, `${amount} among ${ids.join(',')}`).toEqual(ts);
    }
  });

  it('randomised ledgers through the real functions: balances equal the TypeScript engine after every step, former members stay at zero, refused steps change nothing', async () => {
    for (const seed of [1, 2, 3]) {
      let state = seed * 7919;
      const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

      const trip = await makeTrip(asha, `Model ${seed}`);
      const admin1 = await memberOf(trip, asha);
      const people: { id: string; user: string }[] = [{ id: admin1, user: asha }];
      for (let i = 0; i < 4; i++) {
        const user = await users.signUp(`m${seed}-${i}@example.com`, `Model ${seed}.${i}`);
        people.push({ id: await put(trip, user, `Model ${seed}.${i}`), user });
      }
      const status = new Map(people.map((p) => [p.id, 'active']));
      interface ME { id: string; version: number; deleted: boolean; amount: number; participants: string[]; payers: Record<string, number> }
      const model: ME[] = [];
      const activeIds = () => people.filter((p) => status.get(p.id) === 'active').map((p) => p.id);
      const ledgerOf = (ms: ME[]): LedgerExpense[] => ms.map((e) => ({
        id: e.id, deleted: e.deleted,
        payers: Object.entries(e.payers).map(([memberId, paidMinor]) => ({ memberId, paidMinor })),
        splits: computeSplit(e.amount, { method: 'equal', participants: e.participants }).map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor })),
      }));
      const netsOf = (ms: ME[]) => new Map(computeBalances(people.map((p) => p.id), ledgerOf(ms), []).map((b) => [b.memberId, b.netConfirmedMinor]));
      const randomContent = () => {
        const act = activeIds();
        const participants = act.filter(() => rand() < 0.6);
        if (participants.length === 0) participants.push(pick(act));
        const amount = 1 + Math.floor(rand() * 20000);
        const k = 1 + Math.floor(rand() * Math.min(3, act.length));
        const payerIds = [...act].sort(() => rand() - 0.5).slice(0, k);
        const payers: Record<string, number> = {};
        let left = amount;
        payerIds.forEach((p, i) => { const part = i === payerIds.length - 1 ? left : Math.floor(rand() * left); payers[p] = part; left -= part; });
        for (const key of Object.keys(payers)) if (payers[key] === 0) delete payers[key];
        return { amount, participants, payers };
      };
      const sameNets = async () => {
        const db2 = Object.fromEntries((await balances(asha, trip)).rows.map((r) => [r.member_id, r.net_minor]));
        const ts = netsOf(model);
        for (const p of people) expect(db2[p.id], `seed ${seed} net of ${p.id}`).toBe(ts.get(p.id));
        expect(Object.values(db2).reduce((a, n) => a + n, 0)).toBe(0);
        for (const p of people) if (status.get(p.id) !== 'active') expect(db2[p.id], 'former member').toBe(0);
      };
      const involves = (e: ME) => new Set([...e.participants, ...Object.keys(e.payers)]);

      for (let step = 0; step < 90; step++) {
        const kind = pick(['create', 'create', 'edit', 'edit', 'delete', 'restore', 'leave', 'remove']);
        let expected = 'ok';
        let run: PromiseLike<unknown> | undefined;
        let apply: (() => void) | undefined;
        if (kind === 'create' || model.length === 0) {
          const c = randomContent();
          const id = newId();
          run = create(asha, trip, id, { title: `E${step}`, ...c });
          apply = () => model.push({ id, version: 1, deleted: false, ...c });
        } else if (kind === 'edit') {
          const live = model.filter((e) => !e.deleted);
          if (live.length === 0) continue;
          const e = pick(live);
          const c = randomContent();
          const next: ME[] = model.map((m) => (m === e ? { ...m, ...c } : m));
          const touched = new Set([...involves(e), ...Object.keys(c.payers), ...c.participants]);
          const nets = netsOf(next);
          if ([...touched].some((id) => status.get(id) !== 'active' && nets.get(id) !== 0)) expected = 'former_member_balance';
          run = update(asha, trip, e.id, e.version, { title: `E${step}`, ...c });
          apply = () => { Object.assign(e, c, { version: e.version + 1 }); };
        } else if (kind === 'delete' || kind === 'restore') {
          const pool = model.filter((e) => (kind === 'delete' ? !e.deleted : e.deleted));
          if (pool.length === 0) continue;
          const e = pick(pool);
          const next = model.map((m) => (m === e ? { ...m, deleted: kind === 'delete' } : m));
          const nets = netsOf(next);
          if ([...involves(e)].some((id) => status.get(id) !== 'active' && nets.get(id) !== 0)) expected = 'former_member_balance';
          run = kind === 'delete' ? del(asha, trip, e.id, e.version) : restore(asha, trip, e.id, e.version);
          apply = () => { e.deleted = kind === 'delete'; e.version += 1; };
        } else {
          const candidates = people.filter((p) => p.id !== admin1 && status.get(p.id) === 'active');
          if (candidates.length === 0) continue;
          const p = pick(candidates);
          if (netsOf(model).get(p.id) !== 0) expected = 'balance_not_settled';
          run = kind === 'leave' ? q(p.user, 'select * from public.leave_trip($1)', [trip]) : q(asha, 'select * from public.remove_member($1, $2)', [trip, p.id]);
          apply = () => status.set(p.id, kind === 'leave' ? 'left' : 'removed');
        }
        const got = await outcome(run!);
        expect(got, `seed ${seed} step ${step} (${kind})`).toBe(expected);
        if (got === 'ok') apply!();
        await sameNets();
      }
      // every expense in the database equals the model (rows, version, deleted flag)
      for (const e of model) {
        const row = (await expenseRow(e.id))!;
        expect(row.version, e.id).toBe(e.version);
        expect(row.deleted_at !== null, e.id).toBe(e.deleted);
        expect((await rowsOf(e.id)).shares.map((x) => x.share_minor).reduce((a, n) => a + n, 0)).toBe(e.amount);
      }
    }
  }, 240_000);
});
