import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense } from '../../packages/core/src/balances';
import { computeSplit } from '../../packages/core/src/split';
import { TestUsers, newDatabase } from './harness';

/**
 * M5 Checkpoint 2 (ADR-043, ADR-047, rule I-1): the final database guards, tested against the real Postgres engine.
 *
 * Checkpoint 1 (expenses.test.ts) already proves the functions' own rules. This file proves what must hold even beyond
 * them: the trip's currency is fixed, archived trips, leaving and removal with a balance in every situation (including
 * returning members and claimed guests), who can read history, that the database (not the caller) derives and checks
 * every share, and that a global set of invariants holds over everything the tests have written.
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'not_admin', 'trip_archived', 'expense_not_found', 'not_allowed', 'version_conflict', 'expense_deleted',
  'expense_id_taken', 'invalid_expense', 'payers_total_mismatch', 'shares_total_mismatch', 'shares_not_equal_split', 'participant_not_active',
  'payer_not_active', 'outside_trip_dates', 'category_not_found', 'former_member_balance', 'balance_not_settled', 'expenses_outside_dates',
  'currency_locked', 'last_admin', 'invite_exists', 'invite_invalid',
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

interface Exp { title?: string; amount: number; spentOn?: string; participants: string[]; payers: Record<string, number> }
const payersJson = (p: Record<string, number>) => JSON.stringify(Object.entries(p).map(([member_id, paid_minor]) => ({ member_id, paid_minor })));
const create = (who: string | null, trip: string, id: string, e: Exp) =>
  q<{ expense_id: string; version: number; created: boolean }>(who, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb)', [trip, id, e.title ?? 'Dinner', e.amount, e.spentOn ?? '2026-12-28', 'food', null, 'equal', e.participants, payersJson(e.payers)]);
const update = (who: string | null, trip: string, id: string, version: number, e: Exp) =>
  q<{ version: number; changed: boolean }>(who, 'select * from public.update_expense($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6::date, $7, $8, $9, $10::uuid[], $11::jsonb)', [trip, id, version, e.title ?? 'Dinner', e.amount, e.spentOn ?? '2026-12-28', 'food', null, 'equal', e.participants, payersJson(e.payers)]);
const del = (who: string | null, trip: string, id: string, version: number) => q<{ version: number; changed: boolean }>(who, 'select * from public.delete_expense($1, $2, $3)', [trip, id, version]);
const restore = (who: string | null, trip: string, id: string, version: number) => q<{ version: number; changed: boolean }>(who, 'select * from public.restore_expense($1, $2, $3)', [trip, id, version]);
const balances = (who: string | null, trip: string) => q<{ member_id: string; paid_minor: number; share_minor: number; net_minor: number }>(who, 'select * from public.trip_member_balances($1)', [trip]);
const netOf = async (who: string, trip: string, member: string) => (await balances(who, trip)).rows.find((r) => r.member_id === member)!.net_minor;
const leave = (who: string, trip: string) => q(who, 'select * from public.leave_trip($1)', [trip]);
const remove = (who: string, trip: string, member: string) => q(who, 'select * from public.remove_member($1, $2)', [trip, member]);
const newId = () => randomUUID();

async function makeTrip(creator: string, name: string, currency = 'INR'): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip(p_name => $1, p_destination => 'Somewhere', p_start_date => '2026-12-27', p_end_date => '2026-12-30', p_currency => $2)`, [name, currency])).rows[0]!.id;
}
async function put(trip: string, userId: string | null, name: string, over: { role?: string; status?: string } = {}): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>(
    `insert into public.trip_members (trip_id, user_id, display_name, role, status, left_at)
     values ($1, $2, $3, $4, $5, case when $5 = 'active' then null else now() end) returning id`,
    [trip, userId, name, over.role ?? 'member', over.status ?? 'active'],
  )).rows[0]!.id;
}
async function memberOf(trip: string, userId: string): Promise<string> {
  await admin();
  return (await db.query<{ id: string }>('select id from public.trip_members where trip_id = $1 and user_id = $2', [trip, userId])).rows[0]!.id;
}
async function memberRow(id: string) {
  await admin();
  return (await db.query<{ id: string; status: string; role: string; user_id: string | null }>('select id, status, role, user_id from public.trip_members where id = $1', [id])).rows[0]!;
}
async function setArchived(trip: string, on: boolean) {
  await admin();
  await db.query(`update public.trips set status = $2 where id = $1`, [trip, on ? 'archived' : 'active']);
}
async function expenseRow(id: string) {
  await admin();
  return (await db.query<Record<string, any>>('select * from public.expenses where id = $1', [id])).rows[0]!;
}
async function revisionCount(id: string) {
  await admin();
  return (await db.query<{ n: number }>('select count(*)::int as n from public.expense_revisions where expense_id = $1', [id])).rows[0]!.n;
}

/** A returning person: an administrator makes a fresh link, the person asks, an administrator approves. */
async function rejoin(trip: string, adminUser: string, person: string): Promise<string> {
  const live = (await q<{ invite_id: string; status: string; claim_member_id: string | null }>(adminUser, 'select * from public.list_trip_invites($1)', [trip])).rows.filter((r) => r.status === 'active' && r.claim_member_id === null);
  for (const l of live) await q(adminUser, 'select * from public.revoke_invite($1, $2)', [trip, l.invite_id]);
  const token = (await q<{ token: string }>(adminUser, 'select * from public.create_invite($1, null, 168)', [trip])).rows[0]!.token;
  const req = (await q<{ request_id: string }>(person, 'select * from public.request_to_join($1)', [token])).rows[0]!.request_id;
  const res = (await q<{ member_id: string }>(adminUser, 'select * from public.decide_join_request($1, $2, true)', [trip, req])).rows[0]!;
  return res.member_id;
}

/** Facts that must be true of EVERYTHING in the database, whatever tests ran before. Returns the number of violations of each. */
async function invariants() {
  await admin();
  const one = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0]!.n;
  return {
    paymentsNotAmount: await one(`select count(*)::int as n from public.expenses e where e.amount_minor <> (select coalesce(sum(paid_minor), 0) from public.expense_payers p where p.expense_id = e.id)`),
    sharesNotAmount: await one(`select count(*)::int as n from public.expenses e where e.amount_minor <> (select coalesce(sum(share_minor), 0) from public.expense_splits s where s.expense_id = e.id)`),
    sharesNotDerived: await one(`
      select count(*)::int as n from public.expenses e
       where e.split_method = 'equal' and exists (
         select 1 from public.allocate_equal(e.amount_minor, (select array_agg(s.trip_member_id) from public.expense_splits s where s.expense_id = e.id)) a
           full join (select x.trip_member_id, x.share_minor from public.expense_splits x where x.expense_id = e.id) s2 on s2.trip_member_id = a.member_id
          where a.member_id is null or s2.trip_member_id is null or a.share_minor <> s2.share_minor)`),
    tripsNotZeroSum: await one(`
      select count(*)::int as n from public.trips t
       where (select coalesce(sum(public.member_net_minor(t.id, m.id)), 0) from public.trip_members m where m.trip_id = t.id) <> 0`),
    formerMembersWithBalance: await one(`
      select count(*)::int as n from public.trip_members m where m.status <> 'active' and public.member_net_minor(m.trip_id, m.id) <> 0`),
  };
}
const CLEAN = { paymentsNotAmount: 0, sharesNotAmount: 0, sharesNotDerived: 0, tripsNotZeroSum: 0, formerMembersWithBalance: 0 };

let asha: string; // administrator and creator
let ravi: string;
let nina: string;
let dev: string;
let sam: string; // a stranger
let meera: string; // administrator of her own trip

interface Setup { trip: string; a: string; r: string; n: string }
async function setup(name: string, currency = 'INR'): Promise<Setup> {
  const trip = await makeTrip(asha, name, currency);
  return { trip, a: await memberOf(trip, asha), r: await put(trip, ravi, 'Ravi Kumar'), n: await put(trip, nina, 'Nina Shah') };
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
  await db.exec('rollback').catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------------
describe('ADR-043 (c): the trip currency is fixed', () => {
  it('no function can change it: update_trip has no currency input, and editing, archiving and restoring keep it', async () => {
    const s = await setup('Rupees');
    const usd = await setup('Dollars', 'USD');
    await admin();
    const args = (await db.query<{ a: string }>(`select pg_get_function_arguments(p.oid) as a from pg_proc p where p.proname = 'update_trip'`)).rows[0]!.a;
    expect(args).not.toMatch(/currency/i);
    for (const [t, c] of [[s.trip, 'INR'], [usd.trip, 'USD']] as const) {
      await create(asha, t, newId(), { amount: 900, participants: [t === s.trip ? s.a : usd.a], payers: { [t === s.trip ? s.a : usd.a]: 900 } });
      await q(asha, `select * from public.update_trip($1, 1, 'Renamed', 'Elsewhere', '2026-12-27', '2026-12-30')`, [t]);
      await q(asha, 'select * from public.set_trip_archived($1, true, 2)', [t]);
      await q(asha, 'select * from public.set_trip_archived($1, false, 3)', [t]);
      await admin();
      expect((await db.query<{ currency: string }>('select currency from public.trips where id = $1', [t])).rows[0]!.currency).toBe(c);
    }
  });

  it('the table itself refuses any change of currency, before and after expenses exist, even a deleted one; other columns are unaffected', async () => {
    const s = await setup('Locked');
    await admin();
    await expect(db.query(`update public.trips set currency = 'USD' where id = $1`, [s.trip])).rejects.toThrow(/currency_locked/); // no expense yet
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`update public.trips set currency = 'EUR' where id = $1`, [s.trip])).rejects.toThrow(/currency_locked/);
    await del(asha, s.trip, id, 1);
    await admin();
    await expect(db.query(`update public.trips set currency = 'EUR' where id = $1`, [s.trip])).rejects.toThrow(/currency_locked/);
    await db.query(`update public.trips set currency = 'INR', budget_minor = 5000, description = 'ok' where id = $1`, [s.trip]); // the same value is not a change
    expect((await db.query<{ currency: string }>('select currency from public.trips where id = $1', [s.trip])).rows[0]!.currency).toBe('INR');
  });

  it('amounts are plain minor units of the trip\'s currency: a non-rupee trip works and balances need no conversion; the expense tables hold no currency of their own', async () => {
    const usd = await setup('Dollar trip', 'USD');
    await create(asha, usd.trip, newId(), equalAll(usd, 1000));
    const rows = (await balances(asha, usd.trip)).rows;
    expect(rows.reduce((a, r) => a + r.paid_minor, 0)).toBe(1000);
    expect(rows.reduce((a, r) => a + r.share_minor, 0)).toBe(1000);
    await admin();
    const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'public' and table_name in ('expenses', 'expense_payers', 'expense_splits', 'expense_revisions')`)).rows.map((r) => r.column_name);
    expect(cols.filter((c) => /curr/i.test(c))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('ADR-043 (b) and the archive: an archived trip is read-only for money', () => {
  it('refuses every expense write, still shows balances and history, and archiving then restoring changes nothing', async () => {
    const s = await setup('Archive A');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    const before = JSON.stringify((await balances(asha, s.trip)).rows);
    const version = (await expenseRow(id)).version;
    await setArchived(s.trip, true);
    expect(await outcome(create(asha, s.trip, newId(), equalAll(s, 600)))).toBe('trip_archived');
    expect(await outcome(update(asha, s.trip, id, version, equalAll(s, 600)))).toBe('trip_archived');
    expect(await outcome(del(asha, s.trip, id, version))).toBe('trip_archived');
    expect(await outcome(restore(asha, s.trip, id, version))).toBe('trip_archived');
    expect(JSON.stringify((await balances(ravi, s.trip)).rows)).toBe(before);
    expect((await q(ravi, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows).toHaveLength(1);
    await setArchived(s.trip, false);
    expect(JSON.stringify((await balances(ravi, s.trip)).rows)).toBe(before);
    expect((await expenseRow(id)).version).toBe(version);
    expect(await outcome(update(asha, s.trip, id, version, equalAll(s, 600)))).toBe('ok');
  });

  it('the dates of an archived trip cannot be changed (update_trip) and the trigger still protects them against direct changes', async () => {
    const s = await setup('Archive B');
    await create(asha, s.trip, newId(), equalAll(s, 900, { spentOn: '2026-12-30' }));
    await setArchived(s.trip, true);
    expect(await outcome(q(asha, `select * from public.update_trip($1, 1, 'T', 'S', '2026-12-27', '2026-12-28')`, [s.trip]))).toBe('trip_archived');
    await admin();
    await expect(db.query(`update public.trips set end_date = '2026-12-29' where id = $1`, [s.trip])).rejects.toThrow(/expenses_outside_dates/);
    await db.query(`update public.trips set end_date = '2027-01-02' where id = $1`, [s.trip]); // widening is fine
  });

  it('leaving an archived trip is allowed at a zero balance and refused with one; removal needs an active trip', async () => {
    const s = await setup('Archive C');
    await create(asha, s.trip, newId(), equalAll(s, 900, { participants: [s.a, s.r], payers: { [s.a]: 900 } })); // Ravi owes 450, Nina is at zero
    await setArchived(s.trip, true);
    expect(await outcome(leave(ravi, s.trip))).toBe('balance_not_settled');
    expect(await outcome(leave(nina, s.trip))).toBe('ok');
    expect(await outcome(remove(asha, s.trip, s.r))).toBe('trip_archived');
    expect((await memberRow(s.r)).status).toBe('active');
    expect((await memberRow(s.n)).status).toBe('left');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('ADR-047: leaving and removal, situation by situation', () => {
  it('a debtor and a creditor are both held; a person whose several expenses net to exactly zero may go', async () => {
    const s = await setup('Net zero');
    const guest = await put(s.trip, null, 'Gita (guest)');
    await create(asha, s.trip, newId(), { amount: 600, participants: [s.a, s.r], payers: { [s.r]: 600 } }); // Ravi +300, Asha -300
    await create(asha, s.trip, newId(), { amount: 600, participants: [s.r, guest], payers: { [guest]: 600 } }); // Ravi -300, Gita +300
    expect(await netOf(asha, s.trip, s.r)).toBe(0);
    expect(await outcome(remove(asha, s.trip, guest))).toBe('balance_not_settled'); // Gita is owed 300
    expect(await outcome(leave(ravi, s.trip))).toBe('ok'); // Ravi nets to zero across two expenses
    expect(await outcome(remove(asha, s.trip, guest))).toBe('balance_not_settled');
  });

  it('a friend added by name (add_guest_member): removable at once, held while sharing an expense, removable once settled, history and audit kept', async () => {
    const s = await setup('Manual guest');
    const guest = (await q<{ member_id: string }>(asha, 'select * from public.add_guest_member($1, $2)', [s.trip, 'Manual Friend'])).rows[0]!.member_id;
    const lone = (await q<{ member_id: string }>(asha, 'select * from public.add_guest_member($1, $2)', [s.trip, 'Lone Friend'])).rows[0]!.member_id;
    expect(await outcome(remove(asha, s.trip, lone))).toBe('ok'); // no expense: balance zero, removal works normally
    const id = newId();
    await create(asha, s.trip, id, { amount: 600, participants: [s.a, guest], payers: { [s.a]: 600 } }); // the friend owes 300
    expect(await netOf(asha, s.trip, guest)).toBe(-300);
    expect(await outcome(remove(asha, s.trip, guest))).toBe('balance_not_settled'); // ADR-047: the code the app now explains
    expect((await memberRow(guest)).status).toBe('active'); // nothing half-done
    await update(asha, s.trip, id, 1, { amount: 600, participants: [s.a], payers: { [s.a]: 600 } }); // settled by editing: the friend no longer shares it
    expect(await outcome(remove(asha, s.trip, guest))).toBe('ok');
    expect((await memberRow(guest)).status).toBe('removed');
    const d = await admin();
    const revs = (await d.query<{ action: string }>('select action from public.expense_revisions where expense_id = $1 order by version', [id])).rows.map((r) => r.action);
    expect(revs).toEqual(['create', 'update']); // history kept
    const events = (await d.query<{ action: string }>('select action from public.trip_member_events where trip_id = $1 and target_member_id = $2 order by seq', [s.trip, guest])).rows.map((r) => r.action);
    expect(events).toContain('removed'); // audit kept
  });

  it('several payers: each payer\'s own part counts; settling by an edit lets the person go', async () => {
    const s = await setup('Several payers');
    const id = newId();
    await create(asha, s.trip, id, { amount: 900, participants: [s.a, s.r, s.n], payers: { [s.a]: 500, [s.r]: 400 } }); // each owes 300: Asha +200, Ravi +100, Nina -300
    expect(await netOf(asha, s.trip, s.a)).toBe(200);
    expect(await netOf(asha, s.trip, s.r)).toBe(100);
    expect(await netOf(asha, s.trip, s.n)).toBe(-300);
    expect(await outcome(leave(ravi, s.trip))).toBe('balance_not_settled');
    expect(await outcome(leave(nina, s.trip))).toBe('balance_not_settled');
    // edit: Ravi pays nothing, Nina is not part of it: both are now at zero
    expect(await outcome(update(asha, s.trip, id, 1, { amount: 900, participants: [s.a, s.r], payers: { [s.a]: 450, [s.r]: 450 } }))).toBe('ok');
    expect(await outcome(leave(nina, s.trip))).toBe('ok');
    expect(await outcome(leave(ravi, s.trip))).toBe('ok'); // Ravi paid 450 and owes 450
  });

  it('a deleted expense does not hold anyone, and bringing it back later is judged by rule I-1', async () => {
    const s = await setup('Deleted holds none');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await del(asha, s.trip, id, 1);
    expect(await outcome(leave(nina, s.trip))).toBe('ok');
    expect(await outcome(restore(asha, s.trip, id, 2))).toBe('former_member_balance'); // Nina would owe 300 as a former member
    expect(await netOf(asha, s.trip, s.n)).toBe(0);
    expect((await expenseRow(id)).deleted_at).not.toBeNull();
  });

  it('an admin removal and a member leaving are held by exactly the same rule, with the same detail', async () => {
    const s = await setup('Same rule');
    await create(asha, s.trip, newId(), equalAll(s, 900));
    const detail = async (p: PromiseLike<unknown>) => { try { await p; return ''; } catch (e) { return (e as { detail?: string }).detail ?? ''; } };
    expect(await detail(leave(nina, s.trip))).toBe('net_minor=-300');
    expect(await detail(remove(asha, s.trip, s.n))).toBe('net_minor=-300');
    expect(await detail(leave(ravi, s.trip))).toBe('net_minor=-300');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('former members, returning members and claimed guests', () => {
  it('a returning member gets the SAME member row back, their history still counts, and access to expenses and history returns', async () => {
    const s = await setup('Returning');
    const own = newId();
    const shared = newId();
    await create(asha, s.trip, own, { amount: 900, participants: [s.r], payers: { [s.r]: 900 } }); // Ravi pays for himself: zero
    await create(asha, s.trip, shared, { amount: 600, participants: [s.a, s.n], payers: { [s.a]: 600 } });
    await update(asha, s.trip, shared, 1, { amount: 600, participants: [s.a, s.n], payers: { [s.a]: 600 }, title: 'Taxi' });
    expect(await outcome(leave(ravi, s.trip))).toBe('ok');
    // while away: cannot see anything, cannot be asked about; the others still see everything
    for (const t of ['expenses', 'expense_payers', 'expense_splits', 'expense_revisions']) expect((await q(ravi, `select * from public.${t} where trip_id = $1`, [s.trip])).rows, t).toEqual([]);
    expect(await outcome(balances(ravi, s.trip))).toBe('trip_not_found');
    expect((await q(nina, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows.length).toBe(3);
    expect((await balances(nina, s.trip)).rows.find((r) => r.member_id === s.r)).toMatchObject({ paid_minor: 900, share_minor: 900, net_minor: 0 }); // history still counts
    // he cannot be chosen while he is away
    expect(await outcome(create(asha, s.trip, newId(), { amount: 300, participants: [s.a, s.r], payers: { [s.a]: 300 } }))).toBe('participant_not_active');
    // return
    expect(await rejoin(s.trip, asha, ravi)).toBe(s.r);
    expect((await memberRow(s.r)).status).toBe('active');
    expect((await q(ravi, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows.length).toBe(3);
    expect((await q(ravi, 'select * from public.expenses where trip_id = $1', [s.trip])).rows.length).toBe(2);
    expect((await balances(ravi, s.trip)).rows.find((r) => r.member_id === s.r)).toMatchObject({ paid_minor: 900, share_minor: 900, net_minor: 0 });
    expect(await outcome(create(asha, s.trip, newId(), { amount: 300, participants: [s.a, s.r], payers: { [s.a]: 300 } }))).toBe('ok'); // chosen again
    expect(await invariants()).toEqual(CLEAN);
  });

  it('a removed member returns the same way, and the balance rule applies again from then on', async () => {
    const s = await setup('Removed returns');
    expect(await outcome(remove(asha, s.trip, s.n))).toBe('ok');
    await rejoin(s.trip, asha, nina);
    await create(asha, s.trip, newId(), equalAll(s, 900));
    expect(await outcome(leave(nina, s.trip))).toBe('balance_not_settled');
  });

  it('a claimed guest keeps every expense and balance on the same member row; the account can read the history, and a stranger cannot', async () => {
    const s = await setup('Claimed');
    const gita = await put(s.trip, null, 'Gita (guest)');
    const e1 = newId();
    await create(asha, s.trip, e1, { amount: 900, participants: [s.a, gita], payers: { [gita]: 900 } }); // Gita +450
    await update(asha, s.trip, e1, 1, { amount: 1000, participants: [s.a, gita], payers: { [gita]: 1000 } }); // two history entries
    const claimer = await users.signUp('claimer@example.com', 'Gita Claimer');
    const token = (await q<{ token: string }>(asha, 'select * from public.create_invite($1, $2, 168)', [s.trip, gita])).rows[0]!.token;
    const req = (await q<{ request_id: string }>(claimer, 'select * from public.request_to_join($1)', [token])).rows[0]!.request_id;
    expect((await q<{ member_id: string }>(asha, 'select * from public.decide_join_request($1, $2, true)', [s.trip, req])).rows[0]!.member_id).toBe(gita);
    const g = await memberRow(gita);
    expect(g).toMatchObject({ status: 'active', user_id: claimer });
    expect(await netOf(claimer, s.trip, gita)).toBe(500);
    expect((await q(claimer, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows).toHaveLength(2);
    expect((await q(sam, 'select * from public.expense_revisions where trip_id = $1', [s.trip])).rows).toEqual([]);
    expect(await outcome(leave(claimer, s.trip))).toBe('balance_not_settled'); // the guest's credit is now theirs
    expect(await invariants()).toEqual(CLEAN);
  });

  it('current members keep full access to expenses and history while a former member has none, for every table', async () => {
    const s = await setup('Access');
    await put(s.trip, dev, 'Departed Dev');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900, { participants: [s.a, s.r, s.n] }));
    await update(asha, s.trip, id, 1, equalAll(s, 1200));
    expect(await outcome(leave(dev, s.trip))).toBe('ok');
    for (const t of ['expenses', 'expense_payers', 'expense_splits', 'expense_revisions']) {
      for (const who of [asha, ravi, nina]) expect((await q(who, `select * from public.${t} where trip_id = $1`, [s.trip])).rows.length, `${t} for a current member`).toBeGreaterThan(0);
      expect((await q(dev, `select * from public.${t} where trip_id = $1`, [s.trip])).rows, `${t} for a former member`).toEqual([]);
    }
    for (const who of [asha, ravi, nina]) expect((await balances(who, s.trip)).rows.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the database is the authority: it derives every share and checks every row, whatever path is used', () => {
  it('no function accepts shares from the caller: there is no share parameter anywhere', async () => {
    await admin();
    const sigs = (await db.query<{ n: string; a: string }>(
      `select p.proname as n, pg_get_function_arguments(p.oid) as a from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname = 'public' and p.proname in ('create_expense', 'update_expense')`)).rows;
    expect(sigs.map((x) => x.n).sort()).toEqual(['create_expense', 'update_expense']);
    for (const x of sigs) expect(x.a, x.n).not.toMatch(/share/i);
  });

  it('an equal-split expense stored with shares that are not the derived split is refused when saved (direct write by the owner)', async () => {
    const s = await setup('Not equal');
    await admin();
    const ids = [s.a, s.r, s.n].sort();
    const write = (shares: number[], id = newId(), members = ids) => db.exec(`
      begin;
      insert into public.expenses (id, trip_id, title, amount_minor, spent_on, split_method, created_by) values ('${id}', '${s.trip}', 'T', 1000, '2026-12-28', 'equal', '${s.a}');
      insert into public.expense_payers values ('${id}', '${s.trip}', '${s.a}', 1000);
      ${members.map((m, i) => `insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor) values ('${id}', '${s.trip}', '${m}', ${shares[i]});`).join('\n')}
      commit;`);
    await expect(write([333, 334, 333])).rejects.toThrow(/shares_not_equal_split/); // the extra paisa must go to the LOWEST id
    await expect(write([334, 333, 333]).then(() => 'ok')).resolves.toBe('ok'); // the derived split is accepted
    await expect(write([500, 500, 0])).rejects.toThrow(/shares_not_equal_split/); // adds up, but is not equal
    await expect(write([1000, 0, 0], newId(), [ids[0]!, ids[1]!, ids[2]!])).rejects.toThrow(/shares_not_equal_split/);
    await expect(write([500, 500], newId(), ids.slice(0, 2))).resolves.toBeDefined(); // two participants, equal
    // tampering with a stored share afterwards is refused too
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`update public.expense_splits set share_minor = share_minor + 1 where expense_id = $1 and trip_member_id = $2`, [id, s.a])).rejects.toThrow(/shares_(not_equal_split|total_mismatch)/);
    await expect(db.exec(`begin; update public.expense_splits set share_minor = share_minor + 100 where expense_id = '${id}' and trip_member_id = '${s.a}'; update public.expense_splits set share_minor = share_minor - 100 where expense_id = '${id}' and trip_member_id = '${s.r}'; commit;`)).rejects.toThrow(/shares_not_equal_split/);
    expect(await invariants()).toEqual(CLEAN);
  });

  it('a payer or share-holder row cannot be WRITTEN for a former member or for a member of another trip, even by the owner; stored history is untouched', async () => {
    const s = await setup('Row guard');
    const other = await setup('Row guard other');
    const gone = await put(s.trip, dev, 'Departed Dev', { status: 'left' });
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor) values ($1, $2, $3, 1)`, [id, s.trip, gone])).rejects.toThrow(/payer_not_active/);
    await expect(db.query(`insert into public.expense_splits (expense_id, trip_id, trip_member_id, share_minor) values ($1, $2, $3, 0)`, [id, s.trip, gone])).rejects.toThrow(/participant_not_active/);
    await expect(db.query(`insert into public.expense_payers (expense_id, trip_id, trip_member_id, paid_minor) values ($1, $2, $3, 1)`, [id, s.trip, other.r])).rejects.toThrow(/payer_not_active/);
    await expect(db.query(`update public.expense_payers set trip_member_id = $2 where expense_id = $1`, [id, gone])).rejects.toThrow(/payer_not_active/);
    // a member who LATER leaves keeps their stored rows, and balances still count them
    await del(asha, s.trip, id, 1); // (the shared expense would otherwise hold Ravi)
    const keep = newId();
    await create(asha, s.trip, keep, { amount: 600, participants: [s.r], payers: { [s.r]: 600 } }); // Ravi, zero
    expect(await outcome(leave(ravi, s.trip))).toBe('ok');
    expect((await balances(asha, s.trip)).rows.find((r) => r.member_id === s.r)).toMatchObject({ paid_minor: 600, share_minor: 600 });
    expect(await invariants()).toEqual(CLEAN);
  });

  it('an UPDATE of only the amount of a row whose member has left is refused (payers and shares), and the stored row and balances stay exactly as they were', async () => {
    const s = await setup('Amount-only update');
    await put(s.trip, dev, 'Departed Dev');
    const devM = await memberOf(s.trip, dev);
    const id = newId();
    await create(asha, s.trip, id, { amount: 600, participants: [devM], payers: { [devM]: 600 } }); // Dev paid 600 and owes 600: zero
    expect(await outcome(leave(dev, s.trip))).toBe('ok');
    await admin();
    const before = JSON.stringify((await db.query('select trip_member_id, paid_minor from public.expense_payers where expense_id = $1', [id])).rows) +
      JSON.stringify((await db.query('select trip_member_id, share_minor from public.expense_splits where expense_id = $1', [id])).rows);
    await expect(db.query(`update public.expense_payers set paid_minor = paid_minor + 1 where expense_id = $1`, [id])).rejects.toThrow(/payer_not_active/);
    await expect(db.query(`update public.expense_splits set share_minor = share_minor + 1 where expense_id = $1`, [id])).rejects.toThrow(/participant_not_active/);
    await expect(db.exec(`begin; update public.expense_payers set paid_minor = 700 where expense_id = '${id}'; update public.expenses set amount_minor = 700 where id = '${id}'; update public.expense_splits set share_minor = 700 where expense_id = '${id}'; commit;`)).rejects.toThrow(/payer_not_active|participant_not_active/);
    await db.exec('rollback').catch(() => undefined);
    await admin();
    const after = JSON.stringify((await db.query('select trip_member_id, paid_minor from public.expense_payers where expense_id = $1', [id])).rows) +
      JSON.stringify((await db.query('select trip_member_id, share_minor from public.expense_splits where expense_id = $1', [id])).rows);
    expect(after).toBe(before);
    expect((await balances(asha, s.trip)).rows.find((r) => r.member_id === devM)).toMatchObject({ paid_minor: 600, share_minor: 600, net_minor: 0 });
    expect(await invariants()).toEqual(CLEAN);
  });

  it('an amount-only UPDATE for an ACTIVE member passes the membership guard but is still stopped by the sums and derivation checks when saved', async () => {
    const s = await setup('Amount-only active');
    const id = newId();
    await create(asha, s.trip, id, equalAll(s, 900));
    await admin();
    await expect(db.query(`update public.expense_payers set paid_minor = paid_minor + 1 where expense_id = $1`, [id])).rejects.toThrow(/payers_total_mismatch/);
    await expect(db.query(`update public.expense_splits set share_minor = share_minor + 1 where expense_id = $1 and trip_member_id = $2`, [id, s.a])).rejects.toThrow(/shares_(total_mismatch|not_equal_split)/);
    expect(await invariants()).toEqual(CLEAN);
  });

  it('legitimate history keeps working: an expense that involves a former member at zero can still be edited (dropping them), deleted, restored and read', async () => {
    const s = await setup('History works');
    await put(s.trip, dev, 'Departed Dev');
    const devM = await memberOf(s.trip, dev);
    const id = newId();
    await create(asha, s.trip, id, { amount: 600, participants: [devM], payers: { [devM]: 600 } });
    expect(await outcome(leave(dev, s.trip))).toBe('ok');
    expect(await outcome(del(asha, s.trip, id, 1))).toBe('ok');
    expect(await outcome(restore(asha, s.trip, id, 2))).toBe('ok');
    expect((await q(asha, 'select * from public.expense_payers where expense_id = $1', [id])).rows).toHaveLength(1); // the row of the former member is still there
    expect(await outcome(update(asha, s.trip, id, 3, { amount: 600, participants: [s.a], payers: { [s.a]: 600 } }))).toBe('ok'); // Dev is dropped (a zero contribution)
    expect((await q(asha, 'select * from public.expense_payers where expense_id = $1', [id])).rows.map((r) => r.trip_member_id)).toEqual([s.a]);
    expect(await invariants()).toEqual(CLEAN);
  });

  it('both row guards now fire on INSERT and on UPDATE of ANY column (not only the member column), and it is the same function as before', async () => {
    await admin();
    const defs = (await db.query<{ tgname: string; def: string }>(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgname in ('expense_payers_member_guard', 'expense_splits_member_guard') order by 1`)).rows;
    expect(defs).toHaveLength(2);
    for (const d of defs) {
      expect(d.def, d.tgname).toMatch(/BEFORE INSERT OR UPDATE ON public\.expense_(payers|splits) FOR EACH ROW/);
      expect(d.def, d.tgname).not.toMatch(/UPDATE OF/);
      expect(d.def, d.tgname).toContain('expense_rows_member_guard');
    }
  });

  it('the guards are triggers and no existing function was rewritten: the three new guard functions are closed to the app', async () => {
    await admin();
    const fns = (await db.query<{ proname: string; a: boolean; b: boolean }>(
      `select proname, has_function_privilege('authenticated', oid, 'EXECUTE') as a, has_function_privilege('anon', oid, 'EXECUTE') as b
         from pg_proc where proname in ('trips_currency_guard', 'expense_rows_member_guard', 'check_expense_equal_split') order by 1`)).rows;
    expect(fns.map((f) => f.proname)).toEqual(['check_expense_equal_split', 'expense_rows_member_guard', 'trips_currency_guard']);
    expect(fns.every((f) => !f.a && !f.b)).toBe(true);
    const trg = (await db.query<{ tgname: string }>(`select tgname from pg_trigger where not tgisinternal and tgname in
      ('trips_currency_guard', 'expense_payers_member_guard', 'expense_splits_member_guard', 'expenses_zz_equal_check', 'expense_splits_zz_equal_check') order by 1`)).rows.map((r) => r.tgname);
    expect(trg).toHaveLength(5);
    // none of the guards takes a lock of its own
    const src = (await db.query<{ prosrc: string }>(`select prosrc from pg_proc where proname in ('trips_currency_guard', 'expense_rows_member_guard', 'check_expense_equal_split')`)).rows;
    for (const f of src) expect(f.prosrc).not.toMatch(/for\s+(update|share)\b|\block\s+table\b/i);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('parity with the TypeScript engine, with leaving AND returning', () => {
  it('random ledgers where members leave, are removed and RETURN through the real approval flow: balances equal the TypeScript engine after every step, and every global invariant holds', async () => {
    for (const seed of [11, 12]) {
      let state = seed * 104729;
      const rand = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const trip = await makeTrip(asha, `Return model ${seed}`);
      const adminM = await memberOf(trip, asha);
      const people: { id: string; user: string }[] = [{ id: adminM, user: asha }];
      for (let i = 0; i < 4; i++) {
        const user = await users.signUp(`rm${seed}-${i}@example.com`, `Return ${seed}.${i}`);
        people.push({ id: await put(trip, user, `Return ${seed}.${i}`), user });
      }
      const status = new Map(people.map((p) => [p.id, 'active']));
      interface ME { id: string; version: number; deleted: boolean; amount: number; participants: string[]; payers: Record<string, number> }
      const model: ME[] = [];
      const active = () => people.filter((p) => status.get(p.id) === 'active').map((p) => p.id);
      const ledger = (ms: ME[]): LedgerExpense[] => ms.map((e) => ({
        id: e.id, deleted: e.deleted,
        payers: Object.entries(e.payers).map(([memberId, paidMinor]) => ({ memberId, paidMinor })),
        splits: computeSplit(e.amount, { method: 'equal', participants: e.participants }).map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor })),
      }));
      const nets = (ms: ME[]) => new Map(computeBalances(people.map((p) => p.id), ledger(ms), []).map((b) => [b.memberId, b.netConfirmedMinor]));
      const content = () => {
        const act = active();
        const participants = act.filter(() => rand() < 0.6);
        if (participants.length === 0) participants.push(pick(act));
        const amount = 1 + Math.floor(rand() * 20000);
        const payerIds = [...act].sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * Math.min(3, act.length)));
        const payers: Record<string, number> = {};
        let left = amount;
        payerIds.forEach((p, i) => { const part = i === payerIds.length - 1 ? left : Math.floor(rand() * left); payers[p] = part; left -= part; });
        for (const k of Object.keys(payers)) if (payers[k] === 0) delete payers[k];
        return { amount, participants, payers };
      };
      const involves = (e: ME) => new Set([...e.participants, ...Object.keys(e.payers)]);
      const check = async () => {
        const got = Object.fromEntries((await balances(asha, trip)).rows.map((r) => [r.member_id, r.net_minor]));
        const ts = nets(model);
        for (const p of people) expect(got[p.id], `seed ${seed} net of ${p.id}`).toBe(ts.get(p.id));
      };
      let returns = 0;
      for (let step = 0; step < 80; step++) {
        const kind = pick(['create', 'create', 'edit', 'delete', 'restore', 'leave', 'remove', 'return', 'return']);
        let expected = 'ok';
        let run: PromiseLike<unknown> | undefined;
        let apply: (() => void) | undefined;
        if (kind === 'return') {
          const away = people.filter((p) => status.get(p.id) !== 'active');
          if (away.length === 0) continue;
          const p = pick(away);
          run = rejoin(trip, asha, p.user);
          apply = () => { status.set(p.id, 'active'); returns++; };
        } else if (kind === 'create' || model.length === 0) {
          const c = content();
          const id = newId();
          run = create(asha, trip, id, { title: `E${step}`, ...c });
          apply = () => model.push({ id, version: 1, deleted: false, ...c });
        } else if (kind === 'edit') {
          const live = model.filter((e) => !e.deleted);
          if (live.length === 0) continue;
          const e = pick(live);
          const c = content();
          const touched = new Set([...involves(e), ...Object.keys(c.payers), ...c.participants]);
          const after = nets(model.map((m) => (m === e ? { ...m, ...c } : m)));
          if ([...touched].some((id) => status.get(id) !== 'active' && after.get(id) !== 0)) expected = 'former_member_balance';
          run = update(asha, trip, e.id, e.version, { title: `E${step}`, ...c });
          apply = () => { Object.assign(e, c, { version: e.version + 1 }); };
        } else if (kind === 'delete' || kind === 'restore') {
          const pool = model.filter((e) => (kind === 'delete' ? !e.deleted : e.deleted));
          if (pool.length === 0) continue;
          const e = pick(pool);
          const after = nets(model.map((m) => (m === e ? { ...m, deleted: kind === 'delete' } : m)));
          if ([...involves(e)].some((id) => status.get(id) !== 'active' && after.get(id) !== 0)) expected = 'former_member_balance';
          run = kind === 'delete' ? del(asha, trip, e.id, e.version) : restore(asha, trip, e.id, e.version);
          apply = () => { e.deleted = kind === 'delete'; e.version += 1; };
        } else {
          const candidates = people.filter((p) => p.id !== adminM && status.get(p.id) === 'active');
          if (candidates.length === 0) continue;
          const p = pick(candidates);
          if (nets(model).get(p.id) !== 0) expected = 'balance_not_settled';
          run = kind === 'leave' ? leave(p.user, trip) : remove(asha, trip, p.id);
          apply = () => status.set(p.id, kind === 'leave' ? 'left' : 'removed');
        }
        const got = await outcome(run!);
        expect(got, `seed ${seed} step ${step} (${kind})`).toBe(expected);
        if (got === 'ok') apply!();
        await check();
        for (const p of people) expect((await memberRow(p.id)).status, `status of ${p.id}`).toBe(status.get(p.id));
      }
      expect(returns, `seed ${seed} exercised returning members`).toBeGreaterThan(0);
      expect(await invariants()).toEqual(CLEAN);
    }
  }, 240_000);

  it('after everything the tests wrote, every global invariant still holds (payments and shares add up, shares are the derived split, every trip sums to zero, no former member has a balance)', async () => {
    expect(await invariants()).toEqual(CLEAN);
  });
});
