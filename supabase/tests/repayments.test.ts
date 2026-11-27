import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, TestUsers, newDatabase } from './harness';

/**
 * M7 Checkpoint 2 (ADR-066): repayments, reversals and the confirmed-repayment ledger, tested against the real Postgres engine.
 *
 * Proves: the four states and their transitions, who may record, confirm, reject and cancel (including the strict guest-proxy
 * rules R1 to R4b), capacity and global reservations, revalidation at confirmation, archived-trip rules, the guard on leaving and
 * removal, the two-party reversal and the two-admin override (only counterparty_unresponsive is executable), append-only history,
 * balance and zero-sum invariants, Rule I-1, and privileges and row-level security.
 *
 * Time: the database's own clock sets every timestamp, so tests that need "14 days later" move the stored timestamps back with
 * `session_replication_role = replica` (a test-only way past the triggers, never available to the app).
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'not_admin', 'trip_archived', 'not_allowed', 'party_cannot_act', 'repayment_not_found', 'repayment_id_taken',
  'invalid_repayment', 'member_not_active', 'repayment_exceeds_outstanding', 'repayment_not_pending', 'version_conflict', 'repayment_pending',
  'repayment_not_confirmed', 'reversal_not_found', 'reversal_not_open', 'reversal_already_open', 'reversal_already_applied', 'reversal_id_taken',
  'reversal_reason_required', 'reminder_too_soon', 'override_not_eligible', 'override_threshold_not_met', 'override_evidence_missing',
  'override_proposer_cannot_approve', 'repayment_transition_invalid', 'reversal_transition_invalid', 'balance_not_settled', 'former_member_balance',
  'last_admin', 'append-only', 'cannot be deleted',
];
async function outcome(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return TOKENS.find((t) => text.includes(t)) ?? (/permission denied/i.test(text) ? 'permission denied' : /violates check constraint/i.test(text) ? 'check constraint' : text);
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
const newId = () => randomUUID();

// ---- thin callers of the ten functions
const rec = (who: string | null, trip: string, id: string, from: string, to: string, amount: number, method = 'cash', note: string | null = null) =>
  q<{ repayment_id: string; version: number; status: string; created: boolean }>(who, 'select * from public.create_repayment($1, $2, $3, $4, $5, $6, $7)', [trip, id, from, to, amount, method, note]);
const conf = (who: string | null, trip: string, id: string, version: number) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.confirm_repayment($1, $2, $3)', [trip, id, version]);
const rej = (who: string | null, trip: string, id: string, version: number, reason: string | null = null) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.reject_repayment($1, $2, $3, $4)', [trip, id, version, reason]);
const canc = (who: string | null, trip: string, id: string, version: number) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.cancel_repayment($1, $2, $3)', [trip, id, version]);
const reqRev = (who: string | null, trip: string, rid: string, repaymentId: string, reason: string, forMember: string | null = null) =>
  q<{ reversal_id: string; version: number; status: string; created: boolean }>(who, 'select * from public.request_reversal($1, $2, $3, $4, $5)', [trip, rid, repaymentId, reason, forMember]);
const respond = (who: string | null, trip: string, rid: string, version: number, decision: string, note: string | null = null) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.respond_reversal($1, $2, $3, $4, $5)', [trip, rid, version, decision, note]);
const withdraw = (who: string | null, trip: string, rid: string, version: number) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.withdraw_reversal($1, $2, $3)', [trip, rid, version]);
const remind = (who: string | null, trip: string, rid: string) => q<{ version: number; status: string }>(who, 'select * from public.remind_reversal($1, $2)', [trip, rid]);
const propose = (who: string | null, trip: string, rid: string, version: number, category: string, reason: string) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.propose_override($1, $2, $3, $4, $5)', [trip, rid, version, category, reason]);
const decide = (who: string | null, trip: string, rid: string, version: number, decision: string, note: string | null = null) =>
  q<{ version: number; status: string; changed: boolean }>(who, 'select * from public.decide_override($1, $2, $3, $4, $5)', [trip, rid, version, decision, note]);

const balances = (who: string, trip: string) =>
  q<{ member_id: string; paid_minor: number; share_minor: number; sent_minor: number; received_minor: number; net_minor: number }>(who, 'select * from public.trip_member_balances($1)', [trip]);
const netOf = (rows: { member_id: string; net_minor: number }[], member: string) => Number(rows.find((r) => r.member_id === member)!.net_minor);
async function memberNet(trip: string, member: string): Promise<number> {
  await admin();
  return Number((await db.query<{ n: number }>('select public.member_net_minor($1, $2) as n', [trip, member])).rows[0]!.n);
}
const REASON = 'The amount recorded was wrong.';
const OVERRIDE_REASON = 'The counterparty has not answered for weeks.';

// ---- set-up
async function makeTrip(creator: string, name: string): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip(p_name => $1, p_destination => 'Somewhere', p_start_date => '2026-12-27', p_end_date => '2026-12-30', p_currency => 'INR')`, [name])).rows[0]!.id;
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
async function addGuest(trip: string, name: string): Promise<string> {
  return (await q<{ member_id: string }>(asha, 'select * from public.add_guest_member($1, $2)', [trip, name])).rows[0]!.member_id;
}
async function setArchived(trip: string, on: boolean) {
  await admin();
  await db.query(`update public.trips set status = $2 where id = $1`, [trip, on ? 'archived' : 'active']);
}
async function memberRow(id: string) {
  await admin();
  return (await db.query<{ id: string; status: string; user_id: string | null; role: string }>('select id, status, user_id, role from public.trip_members where id = $1', [id])).rows[0]!;
}
async function repaymentRow(id: string) {
  await admin();
  return (await db.query<Record<string, any>>('select * from public.repayments where id = $1', [id])).rows[0]!;
}
async function reversalRow(id: string) {
  await admin();
  return (await db.query<Record<string, any>>('select * from public.repayment_reversals where id = $1', [id])).rows[0]!;
}
async function events(repaymentId: string) {
  await admin();
  return (await db.query<{ action: string; actor_member_id: string; represented_member_id: string; from_status: string | null; to_status: string | null; reversal_id: string | null; reason: string | null }>(
    'select action, actor_member_id, represented_member_id, from_status, to_status, reversal_id, reason from public.repayment_events where repayment_id = $1 order by id', [repaymentId])).rows;
}
/** Runs `sql` with triggers off (test-only). Never reachable from the app. */
async function withoutTriggers(sql: string, args: unknown[] = []) {
  await admin();
  await db.query('set session_replication_role = replica');
  try {
    await db.query(sql, args);
  } finally {
    await db.query('reset session_replication_role');
  }
}

interface S { trip: string; a: string; r: string; n: string; m: string; g: string; g2: string }
/** A trip: Asha (admin, creator), Ravi and Nina (members), Meera (a second admin), and two guests. */
async function setup(name = 'Repayments'): Promise<S> {
  const trip = await makeTrip(asha, name);
  const a = await memberOf(trip, asha);
  const r = await put(trip, ravi, 'Ravi Kumar');
  const n = await put(trip, nina, 'Nina Shah');
  const m = await put(trip, meera, 'Meera Nair', { role: 'admin' });
  const g = await addGuest(trip, 'Gita Guest');
  const g2 = await addGuest(trip, 'Gopal Guest');
  return { trip, a, r, n, m, g, g2 };
}
/** Gives members exact balances (nets must add up to zero): creditors paid one expense that the debtors share exactly. */
async function ledger(s: S, nets: Record<string, number>) {
  const credit = Object.entries(nets).filter(([, v]) => v > 0);
  const debit = Object.entries(nets).filter(([, v]) => v < 0);
  const total = credit.reduce((sum, [, v]) => sum + v, 0);
  expect(debit.reduce((sum, [, v]) => sum - v, 0)).toBe(total);
  const payers = JSON.stringify(credit.map(([member_id, paid_minor]) => ({ member_id, paid_minor })));
  const inputs = JSON.stringify(debit.map(([member_id, v]) => ({ member_id, value: -v })));
  await q(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
    [s.trip, newId(), 'Setup', total, '2026-12-28', 'food', null, 'exact', debit.map(([k]) => k), payers, inputs]);
}
/** A confirmed repayment: payer records, receiver confirms. */
async function confirmed(s: S, payerUser: string, receiverUser: string, from: string, to: string, amount: number): Promise<string> {
  const id = newId();
  await rec(payerUser, s.trip, id, from, to, amount);
  await conf(receiverUser, s.trip, id, 1);
  return id;
}
/** Adds the 14-day evidence to a requested reversal: requested 20 days ago, a reminder on day 8, a reminder now. */
async function makeEvidence(trip: string, rid: string, requester: string) {
  await withoutTriggers(`update public.repayment_reversals set requested_at = now() - interval '20 days' where id = $1`, [rid]);
  await remind(requester, trip, rid);
  await withoutTriggers(`update public.repayment_events set acted_at = now() - interval '12 days' where reversal_id = $1 and action = 'reversal.remind'`, [rid]);
  await remind(requester, trip, rid);
}

let asha: string; // administrator and creator
let ravi: string;
let nina: string;
let meera: string; // a second administrator
let sam: string; // a stranger
let omar: string; // a third administrator

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  nina = await users.signUp('nina@example.com', 'Nina Shah');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
  omar = await users.signUp('omar@example.com', 'Omar Khan');
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('rollback').catch(() => undefined);
});

// ---------------------------------------------------------------------------------------------------
describe('four states; a pending repayment never changes official balances', () => {
  it('recording gives a pending repayment (version 1) with a create event, and no balance moves', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    expect((await rec(ravi, s.trip, id, s.r, s.a, 600)).rows[0]).toMatchObject({ repayment_id: id, version: 1, status: 'pending', created: true });
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-1000);
    expect(netOf(b, s.a)).toBe(1000);
    expect(b.every((x) => Number(x.sent_minor) === 0 && Number(x.received_minor) === 0)).toBe(true);
    const ev = await events(id);
    expect(ev.map((e) => e.action)).toEqual(['repayment.create']);
    expect(ev[0]).toMatchObject({ actor_member_id: s.r, represented_member_id: s.r, to_status: 'pending' });
  });

  it('confirming counts it: net, sent and received move, the sum stays zero, and the original row is decided exactly once', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 600);
    expect((await conf(asha, s.trip, id, 1)).rows[0]).toMatchObject({ version: 2, status: 'confirmed', changed: true });
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-400);
    expect(netOf(b, s.a)).toBe(400);
    expect(Number(b.find((x) => x.member_id === s.r)!.sent_minor)).toBe(600);
    expect(Number(b.find((x) => x.member_id === s.a)!.received_minor)).toBe(600);
    expect(b.reduce((sum, x) => sum + Number(x.net_minor), 0)).toBe(0);
    expect(await repaymentRow(id)).toMatchObject({ status: 'confirmed', decided_by: s.a, version: 2 });
  });

  it('rejecting and cancelling change no balance and release the reserved capacity', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const one = newId();
    const two = newId();
    await rec(ravi, s.trip, one, s.r, s.a, 1000);
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 1))).toBe('repayment_exceeds_outstanding'); // fully reserved
    expect((await rej(asha, s.trip, one, 1, 'not received')).rows[0]).toMatchObject({ status: 'rejected', changed: true });
    expect((await repaymentRow(one)).decision_note).toBe('not received');
    await rec(ravi, s.trip, two, s.r, s.a, 1000); // the reservation is back
    expect((await canc(ravi, s.trip, two, 1)).rows[0]).toMatchObject({ status: 'cancelled' });
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(-1000);
    await rec(ravi, s.trip, newId(), s.r, s.a, 1000); // and again
  });

  it('only pending can change: confirmed, rejected and cancelled are final, and a safe repeat of the same decision is a no-op', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -3000, [s.a]: 3000 });
    const c = newId();
    const x = newId();
    const k = newId();
    await rec(ravi, s.trip, c, s.r, s.a, 500);
    await rec(ravi, s.trip, x, s.r, s.a, 500);
    await rec(ravi, s.trip, k, s.r, s.a, 500);
    await conf(asha, s.trip, c, 1);
    await rej(asha, s.trip, x, 1);
    await canc(ravi, s.trip, k, 1);
    for (const id of [c, x, k]) {
      expect(await outcome(conf(asha, s.trip, id, 2))).toMatch(/^(repayment_not_pending|ok)$/);
    }
    expect(await outcome(rej(asha, s.trip, c, 2))).toBe('repayment_not_pending');
    expect(await outcome(canc(ravi, s.trip, c, 2))).toBe('repayment_not_pending');
    expect(await outcome(conf(asha, s.trip, x, 2))).toBe('repayment_not_pending');
    expect(await outcome(conf(asha, s.trip, k, 2))).toBe('repayment_not_pending');
    expect(await outcome(canc(ravi, s.trip, x, 2))).toBe('repayment_not_pending');
    // a safe repeat by the same person, with the version they last saw, changes nothing and records nothing
    const before = (await events(c)).length;
    expect((await conf(asha, s.trip, c, 1)).rows[0]).toMatchObject({ status: 'confirmed', changed: false });
    expect((await events(c)).length).toBe(before);
    expect((await rej(asha, s.trip, x, 1)).rows[0]).toMatchObject({ status: 'rejected', changed: false });
    expect((await canc(ravi, s.trip, k, 1)).rows[0]).toMatchObject({ status: 'cancelled', changed: false });
  });

  it('a stale version is refused; a missing repayment is not found', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 100);
    expect(await outcome(conf(asha, s.trip, id, 7))).toBe('version_conflict');
    expect(await outcome(rej(asha, s.trip, id, 0))).toBe('version_conflict');
    expect(await outcome(canc(ravi, s.trip, id, 9))).toBe('version_conflict');
    expect(await outcome(conf(asha, s.trip, newId(), 1))).toBe('repayment_not_found');
  });

  it('recording is idempotent: the same content returns the same repayment, different content under the same id is refused', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 300, 'cash', 'dinner');
    expect((await rec(ravi, s.trip, id, s.r, s.a, 300, 'cash', 'dinner')).rows[0]).toMatchObject({ repayment_id: id, version: 1, created: false });
    expect((await rec(ravi, s.trip, id, s.r, s.a, 300, 'cash', '  dinner  ')).rows[0]).toMatchObject({ created: false }); // the same note after trimming
    await conf(asha, s.trip, id, 1);
    expect((await rec(ravi, s.trip, id, s.r, s.a, 300, 'cash', 'dinner')).rows[0]).toMatchObject({ status: 'confirmed', created: false }); // a late retry
    for (const [amount, method] of [[301, 'cash'], [300, 'upi']] as const) {
      expect(await outcome(rec(ravi, s.trip, id, s.r, s.a, amount, method, 'dinner'))).toBe('repayment_id_taken');
    }
    const other = await setup('Other trip');
    expect(await outcome(rec(ravi, other.trip, id, other.r, other.a, 1))).toBe('repayment_id_taken'); // an id is global
    expect((await admin()) && (await db.query<{ n: number }>('select count(*)::int as n from public.repayments where id = $1', [id])).rows[0]!.n).toBe(1);
  });

  it('the table itself refuses what the functions would never do (any direct write, a fifth state, an edit, a delete)', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 200);
    await admin();
    // the state machine is a trigger, independent of the functions (run as the owner)
    expect(await outcome(db.query(`update public.repayments set status = 'paid' where id = $1`, [id]))).toBe('repayment_transition_invalid');
    expect(await outcome(withoutTriggers(`update public.repayments set status = 'paid' where id = $1`, [id]))).toBe('check constraint'); // and the table's own check agrees: four states only
    expect(await outcome(db.query(`update public.repayments set amount_minor = 300, version = 2 where id = $1`, [id]))).toBe('repayment_transition_invalid');
    expect(await outcome(db.query(`update public.repayments set status = 'confirmed' where id = $1`, [id]))).toBe('repayment_transition_invalid'); // no version bump
    expect(await outcome(db.query(`update public.repayments set status = 'pending', version = 2 where id = $1`, [id]))).toBe('repayment_transition_invalid');
    expect(await outcome(db.query('delete from public.repayments where id = $1', [id]))).toBe('cannot be deleted');
    await conf(asha, s.trip, id, 1);
    await admin();
    expect(await outcome(db.query(`update public.repayments set status = 'pending', version = 3 where id = $1`, [id]))).toBe('repayment_transition_invalid');
    expect(await outcome(db.query(`update public.repayments set status = 'cancelled', version = 3, decided_by = $2 where id = $1`, [id, s.r]))).toBe('repayment_transition_invalid');
    expect(await outcome(db.query(`update public.repayments set note = 'edited', version = 3 where id = $1`, [id]))).toBe('repayment_transition_invalid');
    // nothing can be born confirmed, even by a direct insert
    expect(await outcome(db.query(
      `insert into public.repayments (id, trip_id, from_member_id, to_member_id, amount_minor, method, status, created_by, decided_by, decided_at)
       values ($1, $2, $3, $4, 1, 'cash', 'confirmed', $3, $4, now())`, [newId(), s.trip, s.r, s.a]))).toBe('repayment_transition_invalid');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('who may record, confirm, reject and cancel (D2, D5, D6 R1 to R3)', () => {
  it('the payer records; nobody records as the receiver, for another account holder, or as a stranger', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.n]: -500, [s.a]: 1500 });
    expect(await outcome(rec(asha, s.trip, newId(), s.r, s.a, 100))).toBe('not_allowed'); // the receiver records "Ravi paid me"
    expect(await outcome(rec(nina, s.trip, newId(), s.r, s.a, 100))).toBe('not_allowed'); // a third member
    expect(await outcome(rec(meera, s.trip, newId(), s.r, s.a, 100))).toBe('not_allowed'); // an admin for a signed-in payer
    expect(await outcome(rec(sam, s.trip, newId(), s.r, s.a, 100))).toBe('trip_not_found');
    expect(await outcome(rec(null, s.trip, newId(), s.r, s.a, 100))).toBe('permission denied');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 100))).toBe('ok');
  });

  it('input is validated: amount, method, note, distinct and active members', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    for (const amount of [0, -5, 1_000_000_000_001]) expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, amount))).toBe('invalid_repayment');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 100, 'paypal'))).toBe('invalid_repayment');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.r, 100))).toBe('invalid_repayment');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 100, 'cash', 'x'.repeat(201)))).toBe('invalid_repayment');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 100, 'cash', 'x'.repeat(200)))).toBe('ok');
    const gone = await put(s.trip, null, 'Gone Guest', { status: 'removed' });
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, gone, 100))).toBe('member_not_active');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, newId(), 100))).toBe('member_not_active');
    for (const method of ['upi', 'cash', 'bank', 'other']) expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 1, method))).toBe('ok');
  });

  it('the payer and the recorder can never confirm or reject; a third member and an admin for signed-in people cannot either', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 300);
    expect(await outcome(conf(ravi, s.trip, id, 1))).toBe('party_cannot_act'); // nobody confirms their own payment
    expect(await outcome(rej(ravi, s.trip, id, 1))).toBe('party_cannot_act');
    expect(await outcome(conf(nina, s.trip, id, 1))).toBe('not_allowed');
    expect(await outcome(conf(meera, s.trip, id, 1))).toBe('not_allowed'); // an admin, but the receiver is a signed-in member
    expect(await outcome(rej(meera, s.trip, id, 1))).toBe('not_allowed');
    expect(await outcome(conf(sam, s.trip, id, 1))).toBe('trip_not_found');
    expect(await outcome(conf(asha, s.trip, id, 1))).toBe('ok');
  });

  it('D5: the payer cancels their own; the receiver cannot cancel; an admin cannot cancel between two signed-in members', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 300);
    expect(await outcome(canc(asha, s.trip, id, 1))).toBe('not_allowed'); // the receiver rejects instead
    expect(await outcome(canc(meera, s.trip, id, 1))).toBe('not_allowed'); // an admin has no unilateral cancel here
    expect(await outcome(canc(nina, s.trip, id, 1))).toBe('not_allowed');
    expect(await outcome(canc(ravi, s.trip, id, 1))).toBe('ok');
  });

  it('a pending repayment can always be resolved by one of its two people (the receiver rejects, the payer cancels)', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.a]: 1000 });
    const one = newId();
    const two = newId();
    await rec(ravi, s.trip, one, s.r, s.a, 100);
    await rec(ravi, s.trip, two, s.r, s.a, 100);
    expect(await outcome(rej(asha, s.trip, one, 1))).toBe('ok');
    expect(await outcome(canc(ravi, s.trip, two, 1))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('capacity: overpayment, global reservations and revalidation at confirmation (D3)', () => {
  it('overpayment is refused with the most that is allowed, and nobody can pay someone who is owed nothing', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.a]: 800, [s.n]: -300 });
    const tooMuch = await q(ravi, 'select * from public.create_repayment($1, $2, $3, $4, 600, $5, null)', [s.trip, newId(), s.r, s.a, 'cash']).catch((e: Error) => e);
    expect(String((tooMuch as Error).message)).toMatch(/repayment_exceeds_outstanding/);
    expect(String((tooMuch as { detail?: string }).detail ?? '')).toBe('max_minor=500');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 500))).toBe('ok');
    expect(await outcome(rec(nina, s.trip, newId(), s.n, s.r, 1))).toBe('repayment_exceeds_outstanding'); // Ravi is not owed anything
    expect(await outcome(rec(asha, s.trip, newId(), s.a, s.r, 1))).toBe('repayment_exceeds_outstanding'); // Asha owes nothing
  });

  it('design example 1: reservations are global per payer and per receiver, and cancelling releases them', async () => {
    const s = await setup();
    // A -1000, D -500, B +1000, C +500 (A = Ravi, D = Nina, B = Asha, C = Meera)
    await ledger(s, { [s.r]: -1000, [s.n]: -500, [s.a]: 1000, [s.m]: 500 });
    const first = newId();
    await rec(ravi, s.trip, first, s.r, s.a, 600); // A -> B, 600 pending
    const refusedA = await q(ravi, 'select * from public.create_repayment($1, $2, $3, $4, 500, $5, null)', [s.trip, newId(), s.r, s.m, 'cash']).catch((e: Error) => e);
    expect(String((refusedA as Error).message)).toMatch(/repayment_exceeds_outstanding/); // A has only 400 of debt left, whoever the receiver is
    expect(String((refusedA as { detail?: string }).detail)).toBe('max_minor=400');
    const refusedD = await q(nina, 'select * from public.create_repayment($1, $2, $3, $4, 500, $5, null)', [s.trip, newId(), s.n, s.a, 'cash']).catch((e: Error) => e);
    expect(String((refusedD as Error).message)).toMatch(/repayment_exceeds_outstanding/); // B has only 400 of credit left, whoever the payer is
    expect(String((refusedD as { detail?: string }).detail)).toBe('max_minor=400');
    expect(await outcome(rec(nina, s.trip, newId(), s.n, s.a, 400))).toBe('ok');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.m, 400))).toBe('ok'); // A's remaining 400 to C
    await canc(ravi, s.trip, first, 1); // releases A's 600 and B's 600
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 500))).toBe('ok'); // 1000 - 400 reserved to C = 600 left, B has 600 left
  });

  it('design example 2: an expense edit between recording and confirming makes the confirmation fail safely', async () => {
    const s = await setup();
    const expenseId = newId();
    const payers = JSON.stringify([{ member_id: s.a, paid_minor: 1000 }]);
    const exact = (v: number) => JSON.stringify([{ member_id: s.r, value: v }]);
    await q(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Hotel', 1000, '2026-12-28', 'food', null, 'exact', [s.r], payers, exact(1000)]); // Ravi owes 1000, Asha is owed 1000
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 600);
    // the expense is edited so that Ravi owes only 400 (Asha paid 400)
    await q(asha, 'select * from public.update_expense($1::uuid, $2::uuid, 1, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Hotel', 400, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.a, paid_minor: 400 }]), exact(400)]);
    const failed = await conf(asha, s.trip, id, 1).catch((e: Error) => e);
    expect(String((failed as Error).message)).toMatch(/repayment_exceeds_outstanding/);
    expect(String((failed as { detail?: string }).detail)).toBe('max_minor=400');
    expect(await repaymentRow(id)).toMatchObject({ status: 'pending', version: 1 }); // nothing changed
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-400);
    expect(netOf(b, s.a)).toBe(400);
    // while it is still pending it reserves 600 against a debt of 400: nothing more can be recorded
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 1))).toBe('repayment_exceeds_outstanding');
    // resolution: the receiver rejects (or the payer cancels), and a new repayment within the real debt works
    expect(await outcome(rej(asha, s.trip, id, 1))).toBe('ok');
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 400))).toBe('ok');
  });

  it('confirmations use the balance left by the previous ones (they serialise): two that fit one debt cannot both be confirmed', async () => {
    const s = await setup();
    const expenseId = newId();
    const exact = (v: number) => JSON.stringify([{ member_id: s.r, value: v }]);
    await q(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Rent', 1000, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.a, paid_minor: 600 }, { member_id: s.m, paid_minor: 400 }]), exact(1000)]);
    const toAsha = newId();
    const toMeera = newId();
    await rec(ravi, s.trip, toAsha, s.r, s.a, 600);
    await rec(ravi, s.trip, toMeera, s.r, s.m, 400);
    // the debt drops to 700 (the expense is reduced), so 600 + 400 no longer fit
    await q(asha, 'select * from public.update_expense($1::uuid, $2::uuid, 1, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Rent', 700, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.a, paid_minor: 600 }, { member_id: s.m, paid_minor: 100 }]), exact(700)]);
    expect(await outcome(conf(asha, s.trip, toAsha, 1))).toBe('ok'); // 600 <= 700
    expect(await outcome(conf(meera, s.trip, toMeera, 1))).toBe('repayment_exceeds_outstanding'); // only 100 of debt is left
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(-100);
  });

  it('the capacity rules are enforced by the table too: a direct insert or confirm beyond capacity fails', async () => {
    const s = await setup();
    const expenseId = newId();
    const exact = (v: number) => JSON.stringify([{ member_id: s.r, value: v }]);
    await q(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Hotel', 500, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.a, paid_minor: 500 }]), exact(500)]);
    await admin();
    expect(await outcome(db.query(
      `insert into public.repayments (id, trip_id, from_member_id, to_member_id, amount_minor, method, created_by) values ($1, $2, $3, $4, 501, 'cash', $3)`,
      [newId(), s.trip, s.r, s.a]))).toBe('repayment_exceeds_outstanding');
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 500);
    // the debt falls to 400 through a real expense edit; a direct confirm of 500 is then refused by the trigger as well
    await q(asha, 'select * from public.update_expense($1::uuid, $2::uuid, 1, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Hotel', 400, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.a, paid_minor: 400 }]), exact(400)]);
    await admin();
    expect(await outcome(db.query(
      `update public.repayments set status = 'confirmed', decided_by = $2, decided_at = now(), version = 2 where id = $1`, [id, s.a]))).toBe('repayment_exceeds_outstanding');
    expect(await repaymentRow(id)).toMatchObject({ status: 'pending', version: 1 });
  });

  it('nothing here ever moves a balance by itself: pending, rejected and cancelled repayments leave every net untouched', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.n]: -500, [s.a]: 1500 });
    const before = (await balances(asha, s.trip)).rows.map((x) => [x.member_id, Number(x.net_minor)]);
    const a = newId();
    const b = newId();
    const c = newId();
    await rec(ravi, s.trip, a, s.r, s.a, 400);
    await rec(ravi, s.trip, b, s.r, s.a, 300);
    await rec(nina, s.trip, c, s.n, s.a, 200);
    await rej(asha, s.trip, a, 1);
    await canc(ravi, s.trip, b, 1);
    expect((await balances(asha, s.trip)).rows.map((x) => [x.member_id, Number(x.net_minor)])).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('guests and admin proxies, strictly (D6 R1 to R3)', () => {
  it('R1: an admin records for a GUEST payer, but never for a signed-in payer, never as the receiver, and a member cannot', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -1000, [s.n]: 1000 });
    expect(await outcome(rec(nina, s.trip, newId(), s.g, s.n, 100))).toBe('not_allowed'); // a plain member
    expect(await outcome(rec(ravi, s.trip, newId(), s.g, s.n, 100))).toBe('not_allowed');
    const id = newId();
    expect(await outcome(rec(meera, s.trip, id, s.g, s.n, 400))).toBe('ok'); // an admin who is not the receiver
    const ev = await events(id);
    expect(ev[0]).toMatchObject({ actor_member_id: s.m, represented_member_id: s.g }); // the admin and the guest stay distinguishable
    // an admin who IS the receiver may not record for the guest payer
    await ledger(s, { [s.g2]: -500, [s.m]: 500 });
    expect(await outcome(rec(meera, s.trip, newId(), s.g2, s.m, 100))).toBe('not_allowed');
    expect(await outcome(rec(asha, s.trip, newId(), s.g2, s.m, 100))).toBe('ok'); // another admin can
  });

  it('R2: an admin decides for a GUEST receiver, but never the payer and never the recorder', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -1000, [s.g]: 1000 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.g, 300); // a signed-in payer to a guest receiver
    expect(await outcome(conf(nina, s.trip, id, 1))).toBe('not_allowed'); // a plain member cannot
    expect(await outcome(conf(ravi, s.trip, id, 1))).toBe('party_cannot_act'); // the payer and recorder
    expect(await outcome(conf(asha, s.trip, id, 1))).toBe('ok'); // an admin who is neither
    const ev = await events(id);
    expect(ev.at(-1)).toMatchObject({ action: 'repayment.confirm', actor_member_id: s.a, represented_member_id: s.g });
  });

  it('an ADMIN who is the payer cannot confirm their own payment on behalf of a guest receiver', async () => {
    const s = await setup();
    await ledger(s, { [s.a]: -1000, [s.g]: 1000 });
    const id = newId();
    await rec(asha, s.trip, id, s.a, s.g, 300);
    expect(await outcome(conf(asha, s.trip, id, 1))).toBe('party_cannot_act');
    expect(await outcome(rej(asha, s.trip, id, 1))).toBe('party_cannot_act');
    expect(await outcome(conf(meera, s.trip, id, 1))).toBe('ok'); // another admin can
  });

  it('nobody records and decides the same repayment: a proxy who recorded for a guest payer cannot also confirm for a guest receiver', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -1000, [s.g2]: 1000 });
    const id = newId();
    await rec(meera, s.trip, id, s.g, s.g2, 300); // meera records as the proxy of guest payer g
    expect(await outcome(conf(meera, s.trip, id, 1))).toBe('party_cannot_act'); // the recorder
    expect(await outcome(conf(asha, s.trip, id, 1))).toBe('ok'); // a different admin decides for guest receiver g2
  });

  it('R3: an admin may cancel only a repayment with a guest party, as an eligible proxy', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -1000, [s.n]: 1000 });
    const withGuest = newId();
    await rec(meera, s.trip, withGuest, s.g, s.n, 100);
    expect(await outcome(canc(nina, s.trip, withGuest, 1))).toBe('not_allowed'); // the receiver rejects instead
    expect(await outcome(canc(ravi, s.trip, withGuest, 1))).toBe('not_allowed');
    expect(await outcome(canc(asha, s.trip, withGuest, 1))).toBe('ok'); // an admin who is not the receiver
    const onlySigned = newId();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    await rec(ravi, s.trip, onlySigned, s.r, s.n, 100);
    expect(await outcome(canc(asha, s.trip, onlySigned, 1))).toBe('not_allowed'); // two signed-in members: no admin cancel
    // an admin who is the receiver may not cancel as the proxy of a guest payer
    await ledger(s, { [s.g2]: -400, [s.m]: 400 });
    const toMeera = newId();
    await rec(asha, s.trip, toMeera, s.g2, s.m, 100);
    expect(await outcome(canc(meera, s.trip, toMeera, 1))).toBe('not_allowed');
    expect(await outcome(canc(asha, s.trip, toMeera, 1))).toBe('ok'); // the recorder
  });
});

// ---------------------------------------------------------------------------------------------------
describe('archived trips (D4, ADR-043(b) refined)', () => {
  it('recording, requesting a reversal, reminding and proposing an override are refused; resolving open items is allowed', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -3000, [s.a]: 3000 });
    const toConfirm = newId();
    const toReject = newId();
    const toCancel = newId();
    for (const id of [toConfirm, toReject, toCancel]) await rec(ravi, s.trip, id, s.r, s.a, 500);
    const old = await confirmed(s, ravi, asha, s.r, s.a, 100); // for the reversal part
    const rid = newId();
    await reqRev(ravi, s.trip, rid, old, REASON); // an open reversal request made before archiving
    await setArchived(s.trip, true);
    expect(await outcome(rec(ravi, s.trip, newId(), s.r, s.a, 1))).toBe('trip_archived');
    expect(await outcome(reqRev(asha, s.trip, newId(), toConfirm, REASON))).toBe('trip_archived');
    expect(await outcome(remind(ravi, s.trip, rid))).toBe('trip_archived');
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('trip_archived');
    // resolving what is already open stays possible
    expect(await outcome(conf(asha, s.trip, toConfirm, 1))).toBe('ok');
    expect(await outcome(rej(asha, s.trip, toReject, 1))).toBe('ok');
    expect(await outcome(canc(ravi, s.trip, toCancel, 1))).toBe('ok');
    expect(await outcome(respond(asha, s.trip, rid, 1, 'decline'))).toBe('ok');
    // and a withdrawal too (a second request, made before archiving, then withdrawn after)
    await setArchived(s.trip, false);
    const rid2 = newId();
    await reqRev(ravi, s.trip, rid2, old, REASON);
    await setArchived(s.trip, true);
    expect(await outcome(withdraw(ravi, s.trip, rid2, 1))).toBe('ok');
  });

  it('the table refuses a new repayment or reversal on an archived trip even without the functions', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.a]: 500 });
    const old = await confirmed(s, ravi, asha, s.r, s.a, 100);
    await setArchived(s.trip, true);
    await admin();
    expect(await outcome(db.query(
      `insert into public.repayments (id, trip_id, from_member_id, to_member_id, amount_minor, method, created_by) values ($1, $2, $3, $4, 1, 'cash', $3)`,
      [newId(), s.trip, s.r, s.a]))).toBe('trip_archived');
    expect(await outcome(db.query(
      `insert into public.repayment_reversals (id, trip_id, repayment_id, requested_by, requested_for, reason) values ($1, $2, $3, $4, $4, 'x')`,
      [newId(), s.trip, old, s.r]))).toBe('trip_archived');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('leaving and removal (D5) and ADR-047', () => {
  it('a pending repayment blocks leaving and removal for the payer and the receiver; resolving it unblocks them', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.n, 500);
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('repayment_pending');
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [s.trip]))).toBe('repayment_pending');
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.r]))).toBe('repayment_pending');
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.n]))).toBe('repayment_pending');
    await rej(nina, s.trip, id, 1);
    // resolved: the ordinary ADR-047 balance rule decides now (both still carry a balance)
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('balance_not_settled');
    expect((await memberRow(s.r)).status).toBe('active');
  });

  it('after the repayment is confirmed and the balance is zero, the member may leave, and the history stays', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
    expect((await memberRow(s.r)).status).toBe('left');
    expect((await repaymentRow(id)).status).toBe('confirmed');
    expect((await events(id)).map((e) => e.action)).toEqual(['repayment.create', 'repayment.confirm']);
    const rows = (await balances(asha, s.trip)).rows; // the former member is still in the balances, at zero
    expect(netOf(rows, s.r)).toBe(0);
    expect((await q(asha, 'select count(*)::int as n from public.repayments where id = $1', [id])).rows[0]!.n).toBe(1);
  });

  it('an open reversal request also blocks leaving and removal', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('repayment_pending');
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.r]))).toBe('repayment_pending');
    await respond(ravi, s.trip, rid, 1, 'decline');
    expect(await outcome(q(ravi, 'select * from public.leave_trip($1)', [s.trip]))).toBe('ok');
  });

  it('the guard watches every active-to-inactive change, even a direct update; other members and reactivation are unaffected', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    await rec(ravi, s.trip, newId(), s.r, s.n, 100);
    await admin();
    expect(await outcome(db.query(`update public.trip_members set status = 'removed', left_at = now() where id = $1`, [s.r]))).toBe('repayment_pending');
    expect(await outcome(db.query(`update public.trip_members set status = 'left', left_at = now() where id = $1`, [s.n]))).toBe('repayment_pending');
    expect(await outcome(db.query(`update public.trip_members set status = 'removed', left_at = now() where id = $1`, [s.g]))).toBe('ok'); // a guest with nothing pending
    expect(await outcome(db.query(`update public.trip_members set status = 'active', left_at = null where id = $1`, [s.g]))).toBe('ok'); // reactivation is not blocked
  });

  it('a guest with a pending repayment cannot be removed; an admin cannot clear it unilaterally when signed-in members are involved', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.g]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.g, 500);
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.g]))).toBe('repayment_pending');
    expect(await outcome(canc(asha, s.trip, id, 1))).toBe('ok'); // R3: a guest party, an admin who is neither the payer nor the recorder
    expect(await outcome(q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.g]))).toBe('balance_not_settled'); // ADR-047 still applies
  });
});

// ---------------------------------------------------------------------------------------------------
describe('two-party reversal of a confirmed repayment (D13 Option B)', () => {
  async function confirmedPair() {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    return { s, id };
  }

  it('a party requests, the counterparty acknowledges: the repayment stops counting and the original row never changes', async () => {
    const { s, id } = await confirmedPair();
    const original = await repaymentRow(id);
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0);
    const rid = newId();
    expect((await reqRev(nina, s.trip, rid, id, REASON)).rows[0]).toMatchObject({ reversal_id: rid, version: 1, status: 'requested', created: true });
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0); // a request changes nothing
    expect((await respond(ravi, s.trip, rid, 1, 'acknowledge')).rows[0]).toMatchObject({ status: 'applied', changed: true });
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-500);
    expect(netOf(b, s.n)).toBe(500);
    expect(Number(b.find((x) => x.member_id === s.r)!.sent_minor)).toBe(0);
    expect(b.reduce((sum, x) => sum + Number(x.net_minor), 0)).toBe(0);
    expect(await repaymentRow(id)).toEqual(original); // the confirmed repayment is untouched, byte for byte
    expect(await reversalRow(rid)).toMatchObject({ status: 'applied', is_override: false, decided_by: s.r, requested_by: s.n, requested_for: s.n });
    expect((await events(id)).map((e) => e.action)).toEqual(['repayment.create', 'repayment.confirm', 'reversal.request', 'reversal.acknowledge', 'reversal.apply']);
  });

  it('after a reversal the payer can record the real, smaller amount (capacity is restored)', async () => {
    const { s, id } = await confirmedPair();
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    await respond(ravi, s.trip, rid, 1, 'acknowledge');
    const real = newId();
    await rec(ravi, s.trip, real, s.r, s.n, 50);
    await conf(nina, s.trip, real, 1);
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-450);
    expect(netOf(b, s.n)).toBe(450);
  });

  it('declining and withdrawing change nothing; a new request may follow; only one is open and only one is ever applied', async () => {
    const { s, id } = await confirmedPair();
    const one = newId();
    await reqRev(nina, s.trip, one, id, REASON);
    expect(await outcome(reqRev(ravi, s.trip, newId(), id, REASON))).toBe('reversal_already_open');
    expect((await respond(ravi, s.trip, one, 1, 'decline', 'it was right')).rows[0]).toMatchObject({ status: 'declined' });
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0);
    const two = newId();
    await reqRev(nina, s.trip, two, id, REASON);
    expect((await withdraw(nina, s.trip, two, 1)).rows[0]).toMatchObject({ status: 'withdrawn' });
    const three = newId();
    await reqRev(ravi, s.trip, three, id, REASON); // the payer may ask as well
    await respond(nina, s.trip, three, 1, 'acknowledge');
    expect(await outcome(reqRev(nina, s.trip, newId(), id, REASON))).toBe('reversal_already_applied');
    // every closed request is final
    for (const closed of [one, two, three]) {
      expect(await outcome(respond(ravi, s.trip, closed, 2, 'acknowledge'))).toMatch(/reversal_not_open|party_cannot_act/);
    }
    expect((await withdraw(nina, s.trip, two, 1)).rows[0]).toMatchObject({ status: 'withdrawn', changed: false }); // a safe repeat of the same withdrawal
  });

  it('who may answer: the requester never; a third member never; the counterparty yes; the request needs a reason and a confirmed repayment', async () => {
    const { s, id } = await confirmedPair();
    expect(await outcome(reqRev(asha, s.trip, newId(), id, REASON))).toBe('not_allowed'); // a third member
    expect(await outcome(reqRev(nina, s.trip, newId(), id, '   '))).toBe('reversal_reason_required');
    expect(await outcome(reqRev(nina, s.trip, newId(), id, 'x'.repeat(201)))).toBe('reversal_reason_required');
    const pending = newId();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    await rec(ravi, s.trip, pending, s.r, s.n, 100);
    expect(await outcome(reqRev(nina, s.trip, newId(), pending, REASON))).toBe('repayment_not_confirmed');
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    expect(await outcome(respond(nina, s.trip, rid, 1, 'acknowledge'))).toBe('party_cannot_act'); // the requester
    expect(await outcome(respond(asha, s.trip, rid, 1, 'acknowledge'))).toBe('not_allowed'); // an admin, but the counterparty is signed in
    expect(await outcome(respond(meera, s.trip, rid, 1, 'decline'))).toBe('not_allowed');
    expect(await outcome(respond(sam, s.trip, rid, 1, 'acknowledge'))).toBe('trip_not_found');
    expect(await outcome(withdraw(ravi, s.trip, rid, 1))).toBe('not_allowed'); // only the requester withdraws
    expect(await outcome(respond(ravi, s.trip, rid, 9, 'acknowledge'))).toBe('version_conflict');
    expect(await outcome(respond(ravi, s.trip, rid, 1, 'maybe'))).toBe('invalid_repayment');
  });

  it('a safe repeat of an acknowledgement changes nothing; a retry of a request returns the same one', async () => {
    const { s, id } = await confirmedPair();
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    expect((await reqRev(nina, s.trip, rid, id, REASON)).rows[0]).toMatchObject({ reversal_id: rid, created: false });
    expect(await outcome(reqRev(nina, s.trip, rid, id, 'a different reason'))).toBe('reversal_id_taken');
    await respond(ravi, s.trip, rid, 1, 'acknowledge');
    const count = (await events(id)).length;
    expect((await respond(ravi, s.trip, rid, 1, 'acknowledge')).rows[0]).toMatchObject({ status: 'applied', changed: false });
    expect((await events(id)).length).toBe(count);
  });

  it('requested_for: one of the two parties, never a third member, and never changed afterwards', async () => {
    const { s, id } = await confirmedPair();
    expect(await outcome(reqRev(meera, s.trip, newId(), id, REASON, s.a))).toBe('not_allowed'); // a third member as the represented party
    expect(await outcome(reqRev(asha, s.trip, newId(), id, REASON, s.m))).toBe('not_allowed');
    expect(await outcome(reqRev(asha, s.trip, newId(), id, REASON, s.r))).toBe('not_allowed'); // admins cannot stand in for a signed-in party
    await admin();
    expect(await outcome(db.query(
      `insert into public.repayment_reversals (id, trip_id, repayment_id, requested_by, requested_for, reason) values ($1, $2, $3, $4, $4, 'x')`,
      [newId(), s.trip, id, s.a]))).toBe('not_allowed'); // the table agrees: a non-party cannot be requested_for
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    await admin();
    expect(await outcome(db.query(`update public.repayment_reversals set requested_for = $2, version = 2 where id = $1`, [rid, s.r]))).toBe('reversal_transition_invalid');
    expect(await outcome(db.query(`update public.repayment_reversals set requested_by = $2, version = 2 where id = $1`, [rid, s.r]))).toBe('reversal_transition_invalid');
    expect(await outcome(db.query(`update public.repayment_reversals set reason = 'other', version = 2 where id = $1`, [rid]))).toBe('reversal_transition_invalid');
    // a change that rides on a perfectly legal transition (a withdrawal by the requester) is refused too
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'withdrawn', decided_by = requested_by, decided_at = now(), requested_for = $2, version = 2 where id = $1`, [rid, s.r]))).toBe('reversal_transition_invalid');
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'withdrawn', decided_by = requested_by, decided_at = now(), requested_by = $2, version = 2 where id = $1`, [rid, s.r]))).toBe('reversal_transition_invalid');
    expect((await reversalRow(rid)).requested_for).toBe(s.n);
    expect((await reversalRow(rid)).status).toBe('requested');
  });

  it('R4a and R4b: an admin represents a guest PARTY when requesting, and a guest COUNTERPARTY when answering, never on both sides', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -500, [s.r]: 500 });
    const id = newId();
    await rec(meera, s.trip, id, s.g, s.r, 500); // guest payer g, recorded by proxy meera; receiver ravi (signed in)
    await conf(ravi, s.trip, id, 1);
    // R4a: asha (not a party, not the recorder) requests FOR the guest payer
    expect(await outcome(reqRev(meera, s.trip, newId(), id, REASON, s.g))).toBe('not_allowed'); // the recorder cannot
    const rid = newId();
    expect(await outcome(reqRev(asha, s.trip, rid, id, REASON, s.g))).toBe('ok');
    expect(await reversalRow(rid)).toMatchObject({ requested_by: s.a, requested_for: s.g }); // actor and represented are distinguishable
    expect((await events(id)).at(-1)).toMatchObject({ action: 'reversal.request', actor_member_id: s.a, represented_member_id: s.g });
    // the counterparty is ravi (signed in): only ravi answers; nobody can answer for him
    expect(await outcome(respond(asha, s.trip, rid, 1, 'acknowledge'))).toBe('party_cannot_act'); // the requester, never
    expect(await outcome(respond(meera, s.trip, rid, 1, 'acknowledge'))).toBe('not_allowed');
    expect(await outcome(respond(ravi, s.trip, rid, 1, 'acknowledge'))).toBe('ok');
  });

  it('R4b: for a guest counterparty only an eligible admin answers: not the recorder, not the requester, not a party', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.g]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.g, 500);
    await conf(asha, s.trip, id, 1); // asha confirmed for guest receiver g
    const rid = newId();
    await reqRev(ravi, s.trip, rid, id, REASON); // ravi (payer) requests; the counterparty is guest g
    expect(await outcome(respond(ravi, s.trip, rid, 1, 'acknowledge'))).toBe('party_cannot_act'); // the requester
    expect(await outcome(respond(nina, s.trip, rid, 1, 'acknowledge'))).toBe('not_allowed'); // a plain member
    expect(await outcome(respond(meera, s.trip, rid, 1, 'decline', 'proxy'))).toBe('ok'); // an eligible admin: not a party, not the recorder, not the requester
  });

  it('a guest counterparty with NO eligible proxy cannot be answered by an ineligible admin: the request just stays open', async () => {
    const trip = await makeTrip(asha, 'Single admin'); // asha is the only admin
    const a = await memberOf(trip, asha);
    const r = await put(trip, ravi, 'Ravi Kumar');
    const g = await addGuest(trip, 'Gita Guest');
    const fake: S = { trip, a, r, n: a, m: a, g, g2: g };
    await ledger(fake, { [g]: -500, [r]: 500 });
    const id = newId();
    await rec(asha, trip, id, g, r, 500); // asha records as the proxy of the guest payer (R1)
    await conf(ravi, trip, id, 1);
    const rid = newId();
    await reqRev(ravi, trip, rid, id, REASON); // ravi asks; the counterparty is the guest g
    expect(await outcome(respond(asha, trip, rid, 1, 'acknowledge'))).toBe('not_allowed'); // asha recorded it: not an eligible R4b proxy, and there is no other admin
    expect(await outcome(respond(asha, trip, rid, 1, 'decline'))).toBe('not_allowed');
    expect(await outcome(respond(ravi, trip, rid, 1, 'acknowledge'))).toBe('party_cannot_act');
    expect((await reversalRow(rid)).status).toBe('requested'); // unresolved, exactly as accepted: no other resolution path exists
    expect(netOf((await balances(asha, trip)).rows, r)).toBe(0);
    expect(await outcome(withdraw(ravi, trip, rid, 1))).toBe('ok'); // the requester can still withdraw
  });
});

// ---------------------------------------------------------------------------------------------------
describe('reminders and the 14-day override: counterparty_unresponsive is the only executable category', () => {
  async function requested() {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON); // nina asks, the counterparty ravi is a signed-in account holder
    return { s, id, rid };
  }

  it('only the requester reminds; at most one per 24 hours; a reminder changes no state', async () => {
    const { s, rid } = await requested();
    expect(await outcome(remind(ravi, s.trip, rid))).toBe('not_allowed'); // the counterparty
    expect(await outcome(remind(asha, s.trip, rid))).toBe('not_allowed'); // an admin
    expect(await outcome(remind(nina, s.trip, rid))).toBe('ok');
    expect(await outcome(remind(nina, s.trip, rid))).toBe('reminder_too_soon');
    expect((await reversalRow(rid)).version).toBe(1);
    expect((await reversalRow(rid)).status).toBe('requested');
    await withoutTriggers(`update public.repayment_events set acted_at = now() - interval '25 hours' where reversal_id = $1 and action = 'reversal.remind'`, [rid]);
    expect(await outcome(remind(nina, s.trip, rid))).toBe('ok');
  });

  it('an R4a proxy who made the request may remind; nobody else for a guest requester', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -500, [s.n]: 500 });
    const id = newId();
    await rec(meera, s.trip, id, s.g, s.n, 500);
    await conf(nina, s.trip, id, 1);
    const rid = newId();
    await reqRev(asha, s.trip, rid, id, REASON, s.g); // asha for the guest payer
    expect(await outcome(remind(meera, s.trip, rid))).toBe('not_allowed');
    expect(await outcome(remind(nina, s.trip, rid))).toBe('not_allowed'); // the counterparty
    expect(await outcome(remind(asha, s.trip, rid))).toBe('ok');
    expect((await events(id)).at(-1)).toMatchObject({ action: 'reversal.remind', actor_member_id: s.a, represented_member_id: s.g });
  });

  it('no override before 14 days, or without two reminders (the first on or after day 7, 24 hours apart)', async () => {
    const { s, rid } = await requested();
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_threshold_not_met');
    await withoutTriggers(`update public.repayment_reversals set requested_at = now() - interval '13 days 23 hours' where id = $1`, [rid]);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_threshold_not_met'); // one hour short
    await withoutTriggers(`update public.repayment_reversals set requested_at = now() - interval '20 days' where id = $1`, [rid]);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_evidence_missing'); // no reminders at all
    await remind(nina, s.trip, rid);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_evidence_missing'); // one is not two
    await withoutTriggers(`update public.repayment_events set acted_at = now() - interval '14 days' where reversal_id = $1 and action = 'reversal.remind'`, [rid]);
    await remind(nina, s.trip, rid);
    // the first reminder (on day 6) is too early to count: the evidence is still missing
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_evidence_missing');
    await withoutTriggers(`update public.repayment_events set acted_at = now() - interval '12 days' where id = (select min(id) from public.repayment_events where reversal_id = $1 and action = 'reversal.remind')`, [rid]);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('ok'); // day 8 and now
  });

  it('an override needs a reason of at least 20 characters, the only executable category, and an admin who took no part', async () => {
    const { s, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', 'too short'))).toBe('reversal_reason_required');
    expect(await outcome(propose(ravi, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('not_admin'); // not an admin
    expect(await outcome(propose(nina, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('not_admin');
    expect(await outcome(propose(meera, s.trip, rid, 5, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('version_conflict');
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('ok');
    expect(await reversalRow(rid)).toMatchObject({ status: 'override_proposed', override_proposed_by: s.m, override_category: 'counterparty_unresponsive', version: 2 });
    expect(await outcome(propose(asha, s.trip, rid, 2, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('reversal_not_open'); // already proposed
  });

  it('counterparty_account_inaccessible is NOT an executable reason: refused by the function, the table and the migration text', async () => {
    const { s, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    for (const category of ['counterparty_account_inaccessible', 'anything_else', '']) {
      expect(await outcome(propose(meera, s.trip, rid, 1, category, OVERRIDE_REASON))).toBe('override_not_eligible');
    }
    expect(await outcome(propose(meera, s.trip, rid, 1, null as unknown as string, OVERRIDE_REASON))).toBe('override_not_eligible');
    await admin();
    expect(await outcome(withoutTriggers(
      `update public.repayment_reversals set override_proposed_by = $2, override_category = 'counterparty_account_inaccessible', override_reason = $3,
              override_proposed_at = now() where id = $1`, [rid, s.m, OVERRIDE_REASON]))).toBe('check constraint'); // the table's own check, with triggers off
    const sql = readFileSync(`${MIGRATIONS_DIR}20261126000000_repayments.sql`, 'utf8');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/counterparty_account_inaccessible/); // not in any constraint, function or trigger
    expect((await reversalRow(rid)).status).toBe('requested');
  });

  it('an admin who took part in the repayment can never propose or approve an override on it', async () => {
    const s = await setup();
    await ledger(s, { [s.a]: -500, [s.n]: 500 }); // asha (an admin) is the payer
    const id = await confirmed(s, asha, nina, s.a, s.n, 500);
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    await makeEvidence(s.trip, rid, nina);
    expect(await outcome(propose(asha, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('party_cannot_act'); // the payer
    // asha is the counterparty (she must answer); meera, who took no part, may propose
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('ok');
    expect(await outcome(decide(asha, s.trip, rid, 2, 'approve'))).toBe('party_cannot_act'); // a participant cannot approve
    expect(await outcome(decide(meera, s.trip, rid, 2, 'approve'))).toBe('override_proposer_cannot_approve');
    expect((await reversalRow(rid)).status).toBe('override_proposed');
  });

  it('two independent admins: one proposes, a different one approves; the original stays untouched and the effect equals an acknowledgement', async () => {
    const { s, id, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    const original = await repaymentRow(id);
    await propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0); // a proposal changes nothing
    expect(await outcome(decide(ravi, s.trip, rid, 2, 'approve'))).toBe('not_admin'); // the counterparty is not an admin
    expect(await outcome(decide(meera, s.trip, rid, 2, 'approve'))).toBe('override_proposer_cannot_approve'); // one admin never approves their own proposal
    expect(await outcome(decide(asha, s.trip, rid, 7, 'approve'))).toBe('version_conflict');
    expect((await decide(asha, s.trip, rid, 2, 'approve', 'verified')).rows[0]).toMatchObject({ status: 'applied', changed: true });
    expect(await reversalRow(rid)).toMatchObject({ status: 'applied', is_override: true, decided_by: s.a, override_proposed_by: s.m });
    const b = (await balances(asha, s.trip)).rows;
    expect(netOf(b, s.r)).toBe(-500);
    expect(netOf(b, s.n)).toBe(500);
    expect(await repaymentRow(id)).toEqual(original);
    const actions = (await events(id)).map((e) => e.action);
    expect(actions.slice(-3)).toEqual(['reversal.override_propose', 'reversal.override_approve', 'reversal.apply']);
    expect((await decide(asha, s.trip, rid, 2, 'approve')).rows[0]).toMatchObject({ changed: false }); // a safe repeat
  });

  it('a second admin may refuse, which ends the request without any balance change', async () => {
    const { s, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    await propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    expect((await decide(asha, s.trip, rid, 2, 'refuse', 'not convinced')).rows[0]).toMatchObject({ status: 'override_refused' });
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0);
    expect(await outcome(decide(asha, s.trip, rid, 3, 'approve'))).toBe('reversal_not_open');
  });

  it('NO second independent admin: the override stays pending, nobody can approve it, and no balance changes; a new independent admin unblocks it', async () => {
    const s = await setup(); // the trip's admins: asha and meera
    await ledger(s, { [s.a]: -500, [s.n]: 500 });
    const id = await confirmed(s, asha, nina, s.a, s.n, 500); // asha, an admin, is the payer: a participant
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON); // the counterparty is asha, who does not answer
    await makeEvidence(s.trip, rid, nina);
    expect(await outcome(propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('ok'); // meera is the only independent admin
    const before = (await balances(asha, s.trip)).rows.map((x) => [x.member_id, Number(x.net_minor)]);
    expect(await outcome(decide(meera, s.trip, rid, 2, 'approve'))).toBe('override_proposer_cannot_approve'); // one admin never approves their own proposal
    expect(await outcome(decide(asha, s.trip, rid, 2, 'approve'))).toBe('party_cannot_act'); // asha took part
    expect(await outcome(decide(ravi, s.trip, rid, 2, 'approve'))).toBe('not_admin');
    expect(await outcome(decide(nina, s.trip, rid, 2, 'approve'))).toBe('not_admin'); // the requester is not an admin either
    expect((await reversalRow(rid)).status).toBe('override_proposed'); // still pending
    expect((await balances(asha, s.trip)).rows.map((x) => [x.member_id, Number(x.net_minor)])).toEqual(before); // no balance change
    // the trip adds a third, independent admin: only then can the override be approved
    const third = await put(s.trip, omar, 'Omar Khan', { role: 'admin' });
    expect(await outcome(decide(omar, s.trip, rid, 2, 'approve'))).toBe('ok');
    expect((await reversalRow(rid)).decided_by).toBe(third);
    expect(netOf((await balances(asha, s.trip)).rows, s.a)).toBe(-500);
  });

  it('while an override is proposed the counterparty can still acknowledge or decline, and the requester can withdraw', async () => {
    const { s, id, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    await propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    expect((await respond(ravi, s.trip, rid, 2, 'acknowledge')).rows[0]).toMatchObject({ status: 'applied' });
    expect(await reversalRow(rid)).toMatchObject({ is_override: false, decided_by: s.r }); // a normal acknowledgement, not an override
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(-500);
    // another case: decline, and a withdrawal
    const s2 = await setup('Second');
    await ledger(s2, { [s2.r]: -500, [s2.n]: 500 });
    const id2 = await confirmed(s2, ravi, nina, s2.r, s2.n, 500);
    const rid2 = newId();
    await reqRev(nina, s2.trip, rid2, id2, REASON);
    await makeEvidence(s2.trip, rid2, nina);
    await propose(meera, s2.trip, rid2, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    expect((await withdraw(nina, s2.trip, rid2, 2)).rows[0]).toMatchObject({ status: 'withdrawn' });
    expect(id).toBeTruthy();
  });

  it('the override is re-evaluated at approval: if the counterparty stops being an account holder the guest-proxy route applies and approval is refused', async () => {
    const { s, rid } = await requested();
    await makeEvidence(s.trip, rid, nina);
    await propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    // SIMULATION (owner-only): the counterparty has no linked account any more, so the proxy process must be used instead
    await withoutTriggers(`update public.trip_members set user_id = null where id = $1`, [s.r]);
    expect(await outcome(decide(asha, s.trip, rid, 2, 'approve'))).toBe('override_not_eligible');
    expect((await reversalRow(rid)).status).toBe('override_proposed');
    expect(netOf((await balances(asha, s.trip)).rows, s.r)).toBe(0);
  });

  it('a guest counterparty is never eligible for the override (the proxy route applies)', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.g]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.g, 500);
    await conf(meera, s.trip, id, 1);
    const rid = newId();
    await reqRev(ravi, s.trip, rid, id, REASON); // counterparty: the guest
    await makeEvidence(s.trip, rid, ravi);
    expect(await outcome(propose(asha, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('override_not_eligible');
  });

  it('the table enforces the participant, proposer and evidence rules even for a direct update', async () => {
    const { s, rid } = await requested();
    await admin();
    // no evidence yet
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'override_proposed', override_proposed_by = $2, override_category = 'counterparty_unresponsive',
              override_reason = $3, override_proposed_at = now(), version = 2 where id = $1`, [rid, s.m, OVERRIDE_REASON]))).toBe('override_threshold_not_met');
    await makeEvidence(s.trip, rid, nina);
    await admin();
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'override_proposed', override_proposed_by = $2, override_category = 'counterparty_unresponsive',
              override_reason = $3, override_proposed_at = now(), version = 2 where id = $1`, [rid, s.n, OVERRIDE_REASON]))).toBe('party_cannot_act'); // a participant
    await propose(meera, s.trip, rid, 1, 'counterparty_unresponsive', OVERRIDE_REASON);
    await admin();
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'applied', is_override = true, decided_by = $2, decided_at = now(), version = 3 where id = $1`, [rid, s.m]))).toBe('override_proposer_cannot_approve');
    expect(await outcome(db.query(
      `update public.repayment_reversals set status = 'applied', is_override = true, decided_by = $2, decided_at = now(), version = 3 where id = $1`, [rid, s.n]))).toBe('not_admin');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('append-only history and balance invariants', () => {
  it('events and finished repayments cannot be changed or deleted, even by the owner with triggers on', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    await admin();
    expect(await outcome(db.query('update public.repayment_events set reason = $2 where repayment_id = $1', [id, 'edited']))).toBe('append-only');
    expect(await outcome(db.query('delete from public.repayment_events where repayment_id = $1', [id]))).toBe('append-only');
    expect(await outcome(db.query('truncate public.repayment_events'))).toBe('append-only');
    expect(await outcome(db.query('delete from public.repayments where id = $1', [id]))).toBe('cannot be deleted');
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    await admin();
    expect(await outcome(db.query('delete from public.repayment_reversals where id = $1', [rid]))).toBe('cannot be deleted');
  });

  it('actor and represented participant stay consistent: only an admin for a guest can differ', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 100);
    await admin();
    expect(await outcome(db.query(
      `insert into public.repayment_events (trip_id, repayment_id, action, actor_member_id, represented_member_id) values ($1, $2, 'repayment.cancel', $3, $4)`,
      [s.trip, id, s.r, s.n]))).toBe('not_allowed'); // a member claiming to act for another signed-in member
    expect(await outcome(db.query(
      `insert into public.repayment_events (trip_id, repayment_id, action, actor_member_id, represented_member_id) values ($1, $2, 'repayment.cancel', $3, $4)`,
      [s.trip, id, s.m, s.g]))).toBe('ok'); // an admin for a guest
  });

  it('history carries member ids only (no user id, e-mail or name column anywhere in it)', async () => {
    await admin();
    const cols = (await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('repayments', 'repayment_reversals', 'repayment_events')`)).rows;
    for (const c of cols) expect(c.column_name, `${c.table_name}.${c.column_name}`).not.toMatch(/user_id|email|display_name|name$/);
  });

  it('former members stay at zero: an applied reversal that would leave one non-zero is refused (Rule I-1)', async () => {
    const s = await setup();
    await ledger(s, { [s.g]: -500, [s.n]: 500 });
    const id = newId();
    await rec(meera, s.trip, id, s.g, s.n, 500); // guest payer, recorded by a proxy
    await conf(nina, s.trip, id, 1);
    expect(await memberNet(s.trip, s.g)).toBe(0);
    await q(asha, 'select * from public.remove_member($1, $2)', [s.trip, s.g]); // the guest leaves at zero
    expect((await memberRow(s.g)).status).toBe('removed');
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON); // nina asks; the counterparty is the former guest
    // an eligible R4b admin could acknowledge for the guest, but applying would make a former member non-zero
    expect(await outcome(respond(asha, s.trip, rid, 1, 'acknowledge'))).toBe('former_member_balance');
    expect((await reversalRow(rid)).status).toBe('requested');
    expect(await memberNet(s.trip, s.g)).toBe(0);
  });

  it('expense changes that would break a former member after a repayment are still refused', async () => {
    const s = await setup();
    const expenseId = newId();
    await q(asha, 'select * from public.create_expense($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6, $7, $8, $9::uuid[], $10::jsonb, $11::jsonb)',
      [s.trip, expenseId, 'Dinner', 1000, '2026-12-28', 'food', null, 'exact', [s.r], JSON.stringify([{ member_id: s.n, paid_minor: 1000 }]), JSON.stringify([{ member_id: s.r, value: 1000 }])]);
    await confirmed(s, ravi, nina, s.r, s.n, 1000); // ravi settles fully
    expect(await memberNet(s.trip, s.r)).toBe(0);
    await q(ravi, 'select * from public.leave_trip($1)', [s.trip]);
    // deleting the expense would leave the former member Ravi at -1000 + ... = +1000 of confirmed repayment: refused by Rule I-1
    expect(await outcome(q(asha, 'select * from public.delete_expense($1, $2, 1)', [s.trip, expenseId]))).toBe('former_member_balance');
  });

  it('balance: expense net plus confirmed repayments, summing to zero; nothing else counts', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -800, [s.n]: -200, [s.a]: 600, [s.m]: 400 });
    const a = await confirmed(s, ravi, asha, s.r, s.a, 300);
    const b = newId();
    await rec(nina, s.trip, b, s.n, s.m, 100); // pending: no effect
    const rows = (await balances(asha, s.trip)).rows;
    expect(netOf(rows, s.r)).toBe(-500);
    expect(netOf(rows, s.a)).toBe(300);
    expect(netOf(rows, s.n)).toBe(-200);
    expect(netOf(rows, s.m)).toBe(400);
    expect(rows.reduce((sum, x) => sum + Number(x.net_minor), 0)).toBe(0);
    expect(Number(rows.find((x) => x.member_id === s.r)!.paid_minor)).toBe(0); // paid and share stay the expense figures
    expect(a).toBeTruthy();
  });

  it('a global check over everything the tests wrote: zero-sum trips, former members at zero, no state outside the four', async () => {
    await admin();
    const one = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0]!.n;
    expect(await one(`select count(*)::int as n from public.trips t where (select coalesce(sum(public.member_net_minor(t.id, m.id)), 0) from public.trip_members m where m.trip_id = t.id) <> 0`)).toBe(0);
    expect(await one(`select count(*)::int as n from public.trip_members m where m.status <> 'active' and public.member_net_minor(m.trip_id, m.id) <> 0`)).toBe(0);
    expect(await one(`select count(*)::int as n from public.repayments where status not in ('pending', 'confirmed', 'rejected', 'cancelled')`)).toBe(0);
    expect(await one(`select count(*)::int as n from public.repayments where status <> 'pending' and (decided_by is null or decided_at is null)`)).toBe(0);
    expect(await one(`select count(*)::int as n from public.repayments r where r.status = 'confirmed' and not exists (select 1 from public.repayment_events e where e.repayment_id = r.id and e.action = 'repayment.confirm')`)).toBe(0);
    expect(await one(`select count(*)::int as n from (select repayment_id from public.repayment_reversals where status = 'applied' group by repayment_id having count(*) > 1) x`)).toBe(0);
    expect(await one(`select count(*)::int as n from public.repayment_reversals v where v.status = 'applied' and not exists (select 1 from public.repayment_events e where e.reversal_id = v.id and e.action = 'reversal.apply')`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('privileges, row-level security and function hygiene', () => {
  const TEN = ['create_repayment', 'confirm_repayment', 'reject_repayment', 'cancel_repayment', 'request_reversal', 'respond_reversal', 'withdraw_reversal', 'remind_reversal', 'propose_override', 'decide_override'];
  const HELPERS = ['member_expense_net_minor', 'member_repayment_adjustment_minor', 'member_is_active_admin', 'repayment_capacity', 'repayment_participants', 'repayment_decide_problem',
    'repayment_cancel_problem', 'reversal_request_problem', 'reversal_respond_problem', 'repayment_override_problem', 'repayments_guard', 'repayment_reversals_guard', 'repayments_i1_after',
    'repayment_events_append_only', 'repayment_events_check', 'trip_members_repayment_pending_guard'];

  it('signed-in users can run the ten functions and no helper; signed-out visitors can run none of them', async () => {
    await admin();
    for (const name of TEN) {
      const r = (await db.query<{ a: boolean; n: boolean }>(`select has_function_privilege('authenticated', p.oid, 'EXECUTE') as a, has_function_privilege('anon', p.oid, 'EXECUTE') as n
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name])).rows;
      expect(r.length, name).toBe(1); // exactly one overload
      expect(r[0]!.a, name).toBe(true);
      expect(r[0]!.n, name).toBe(false);
    }
    for (const name of HELPERS) {
      const r = (await db.query<{ a: boolean; n: boolean }>(`select has_function_privilege('authenticated', p.oid, 'EXECUTE') as a, has_function_privilege('anon', p.oid, 'EXECUTE') as n
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name])).rows;
      expect(r.length, name).toBe(1);
      expect(r[0]!.a, name).toBe(false);
      expect(r[0]!.n, name).toBe(false);
    }
  });

  it('every function and helper is security definer with the search_path pinned empty; the callable ones start from auth.uid()', async () => {
    await admin();
    const rows = (await db.query<{ proname: string; secdef: boolean; cfg: string[] | null; src: string }>(
      `select p.proname, p.prosecdef as secdef, p.proconfig as cfg, p.prosrc as src from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [[...TEN, ...HELPERS.filter((h) => !h.endsWith('append_only'))]])).rows;
    for (const r of rows) {
      expect(r.secdef, r.proname).toBe(true);
      expect((r.cfg ?? []).join(','), r.proname).toMatch(/search_path=""/);
    }
    for (const name of TEN) expect(rows.find((r) => r.proname === name)!.src, name).toMatch(/auth\.uid\(\)/);
  });

  it('lock order in every write function: member_change_context (the trip row) comes before any repayment or reversal lock', async () => {
    await admin();
    for (const name of TEN) {
      const src = (await db.query<{ src: string }>(`select prosrc as src from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [name])).rows[0]!.src;
      const code = src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      const trip = code.indexOf('member_change_context');
      expect(trip, name).toBeGreaterThanOrEqual(0);
      for (const lock of code.matchAll(/for update/gi)) expect(lock.index!, name).toBeGreaterThan(trip);
      // the repayment row is locked before the reversal row, never the other way round
      const firstReversalLock = code.search(/repayment_reversals x where[^;]*for update/i);
      const firstRepaymentLock = code.search(/from public\.repayments r where[^;]*for update|perform 1 from public\.repayments r where[^;]*for update/i);
      if (firstReversalLock >= 0 && firstRepaymentLock >= 0) expect(firstRepaymentLock, name).toBeLessThan(firstReversalLock);
    }
    for (const helper of ['repayment_capacity', 'repayment_override_problem', 'repayments_guard', 'repayment_reversals_guard', 'trip_members_repayment_pending_guard']) {
      const src = (await db.query<{ src: string }>(`select prosrc as src from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [helper])).rows[0]!.src;
      expect(src.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'), helper).not.toMatch(/for\s+(update|share|no key update|key share)\b|\block\s+table\b|pg_advisory/i); // guards only read
    }
  });

  it('the app has no direct write on any of the three tables, and anon has no access at all', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.a]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 100);
    for (const table of ['repayments', 'repayment_reversals', 'repayment_events']) {
      expect(await outcome(q(ravi, `delete from public.${table}`))).toBe('permission denied');
      expect(await outcome(q(ravi, `update public.${table} set trip_id = trip_id`))).toBe('permission denied');
      expect(await outcome(q(null, `select * from public.${table}`))).toBe('permission denied');
    }
    expect(await outcome(q(ravi, `insert into public.repayments (id, trip_id, from_member_id, to_member_id, amount_minor, method, created_by) values ($1, $2, $3, $4, 1, 'cash', $3)`, [newId(), s.trip, s.r, s.a]))).toBe('permission denied');
    expect(await outcome(q(ravi, `insert into public.repayment_events (trip_id, repayment_id, action, actor_member_id, represented_member_id) values ($1, $2, 'repayment.cancel', $3, $3)`, [s.trip, id, s.r]))).toBe('permission denied');
  });

  it('every ACTIVE member reads repayments, reversals and events of their trip; strangers and former members read nothing', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.n]: 500 });
    const id = await confirmed(s, ravi, nina, s.r, s.n, 500);
    const rid = newId();
    await reqRev(nina, s.trip, rid, id, REASON);
    for (const who of [asha, ravi, nina, meera]) {
      expect((await q(who, 'select count(*)::int as n from public.repayments where trip_id = $1', [s.trip])).rows[0]!.n).toBe(1);
      expect((await q(who, 'select count(*)::int as n from public.repayment_reversals where trip_id = $1', [s.trip])).rows[0]!.n).toBe(1);
      expect((await q(who, 'select count(*)::int as n from public.repayment_events where trip_id = $1', [s.trip])).rows[0]!.n).toBeGreaterThanOrEqual(3);
    }
    for (const t of ['repayments', 'repayment_reversals', 'repayment_events']) {
      expect((await q(sam, `select count(*)::int as n from public.${t} where trip_id = $1`, [s.trip])).rows[0]!.n).toBe(0);
    }
    await respond(ravi, s.trip, rid, 1, 'decline'); // nothing open now, so ravi can leave if his balance is zero (it is, the repayment still counts)
    await q(ravi, 'select * from public.leave_trip($1)', [s.trip]);
    expect((await q(ravi, 'select count(*)::int as n from public.repayments where trip_id = $1', [s.trip])).rows[0]!.n).toBe(0); // a former member gets no new access
    expect((await q(ravi, 'select count(*)::int as n from public.repayment_events where trip_id = $1', [s.trip])).rows[0]!.n).toBe(0);
    expect(await outcome(q(ravi, 'select * from public.trip_member_balances($1)', [s.trip]))).toBe('trip_not_found');
  });

  it('strangers and signed-out callers cannot run any repayment function', async () => {
    const s = await setup();
    await ledger(s, { [s.r]: -500, [s.a]: 500 });
    const id = newId();
    await rec(ravi, s.trip, id, s.r, s.a, 100);
    expect(await outcome(conf(sam, s.trip, id, 1))).toBe('trip_not_found');
    expect(await outcome(rej(sam, s.trip, id, 1))).toBe('trip_not_found');
    expect(await outcome(canc(sam, s.trip, id, 1))).toBe('trip_not_found');
    expect(await outcome(remind(sam, s.trip, newId()))).toBe('trip_not_found');
    expect(await outcome(propose(sam, s.trip, newId(), 1, 'counterparty_unresponsive', OVERRIDE_REASON))).toBe('trip_not_found');
    expect(await outcome(decide(sam, s.trip, newId(), 1, 'approve'))).toBe('trip_not_found');
    for (const call of [
      () => conf(null, s.trip, id, 1), () => rej(null, s.trip, id, 1), () => canc(null, s.trip, id, 1), () => rec(null, s.trip, newId(), s.r, s.a, 1),
      () => reqRev(null, s.trip, newId(), id, REASON), () => respond(null, s.trip, newId(), 1, 'decline'), () => withdraw(null, s.trip, newId(), 1),
      () => remind(null, s.trip, newId()), () => propose(null, s.trip, newId(), 1, 'counterparty_unresponsive', OVERRIDE_REASON), () => decide(null, s.trip, newId(), 1, 'approve'),
    ]) expect(await outcome(call())).toBe('permission denied');
  });
});
