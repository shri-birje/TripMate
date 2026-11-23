import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestUsers, newDatabase } from './harness';

/**
 * M3.5 (revised, ADR-059): invitation links and APPROVAL-BASED joining, tested against the real Postgres engine
 * with the project's real migrations (including the forward-only migration that replaced immediate joining).
 *
 * The rule that matters most: using a link only ever creates a PENDING REQUEST. Only an active administrator's
 * approval creates (or restores) a membership, and a pending person can see nothing at all.
 *
 * As in the member tests, truly simultaneous callers cannot be run in this engine; races are covered by
 * "second caller after the first" simulations plus checks that the functions take the trip lock first.
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'not_admin', 'trip_archived', 'member_not_found', 'invalid_request', 'not_a_guest',
  'invite_not_found', 'invite_invalid', 'claim_conflict', 'claim_pending', 'claim_unavailable', 'trip_full', 'profile_missing',
  'request_used', 'too_many_requests', 'request_not_found', 'requester_unavailable', 'invite_exists',
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
async function errorText(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const q = async <T = Record<string, unknown>>(who: string | null, sql: string, args: unknown[] = []) => {
  if (who === null) await users.asAnon();
  else await users.asUser(who);
  return db.query<T>(sql, args);
};
interface Created {
  invite_id: string;
  token: string;
  expires_at: Date;
}
const create = (who: string, trip: string, opts: { claim?: string | null; hours?: number | null } = {}) =>
  q<Created>(who, 'select * from public.create_invite($1, $2, $3)', [trip, opts.claim ?? null, opts.hours === undefined ? 168 : opts.hours]);
const makeInvite = async (who: string, trip: string, opts: Parameters<typeof create>[2] = {}) => (await create(who, trip, opts)).rows[0]!;
/** Makes the trip's general link even if one is live: cancels it first (the way an admin would: revoke, then create). */
const newGeneral = async (who: string, trip: string, opts: Parameters<typeof create>[2] = {}) => {
  const live = (await list(who, trip)).rows.find((r) => r.claim_member_id === null && r.revoked_at === null);
  if (live) await revoke(who, trip, live.invite_id);
  return makeInvite(who, trip, opts);
};
/** The admin-only "Copy link" call: the SAME token every time while the link is live. */
const getLink = (who: string | null, trip: string) => q<{ token: string; expires_at: Date }>(who, 'select * from public.get_general_invite_link($1)', [trip]);
interface Requested {
  trip_id: string;
  request_id: string | null;
  outcome: string;
}
const request = (who: string, token: unknown) => q<Requested>(who, 'select * from public.request_to_join($1)', [token]);
interface Decided {
  request_id: string;
  outcome: string;
  member_id: string | null;
}
const decide = (who: string, trip: string, req: string, approve: boolean | null) => q<Decided>(who, 'select * from public.decide_join_request($1, $2, $3)', [trip, req, approve]);
const pending = (who: string, trip: string) => q<Record<string, any>>(who, 'select * from public.list_join_requests($1)', [trip]);
const preview = (who: string | null, token: unknown) => q<Record<string, unknown>>(who, 'select * from public.preview_invite($1)', [token]);
const list = (who: string, trip: string) => q<Record<string, any>>(who, 'select * from public.list_trip_invites($1)', [trip]);
const revoke = (who: string, trip: string, invite: string) => q<{ invite_id: string; changed: boolean }>(who, 'select * from public.revoke_invite($1, $2)', [trip, invite]);
const addGuest = (who: string, trip: string, name: string) => q<{ member_id: string }>(who, 'select * from public.add_guest_member($1, $2)', [trip, name]);

interface Member {
  id: string;
  user_id: string | null;
  display_name: string;
  role: string;
  status: string;
  joined_at: Date;
  left_at: Date | null;
  invited_by: string | null;
}
async function members(trip: string): Promise<Member[]> {
  await users.asAdmin();
  return (await db.query<Member>('select * from public.trip_members where trip_id = $1 order by joined_at, id', [trip])).rows;
}
const byName = (ms: Member[], name: string) => ms.find((m) => m.display_name === name)!;
const byUser = (ms: Member[], user: string) => ms.find((m) => m.user_id === user);
const active = (ms: Member[]) => ms.filter((m) => m.status === 'active');

async function events(trip: string) {
  await users.asAdmin();
  return (await db.query<{ action: string; actor_member_id: string; target_member_id: string; old_value: string | null; new_value: string | null }>(
    'select action, actor_member_id, target_member_id, old_value, new_value from public.trip_member_events where trip_id = $1 order by seq', [trip],
  )).rows;
}
async function inviteRow(id: string) {
  await users.asAdmin();
  return (await db.query<Record<string, any>>('select * from public.trip_invites where id = $1', [id])).rows[0]!;
}
async function requestRow(id: string) {
  await users.asAdmin();
  return (await db.query<Record<string, any>>('select * from public.trip_join_requests where id = $1', [id])).rows[0]!;
}
async function makeTrip(creator: string, name: string): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip($1, 'Somewhere', '2026-12-27', '2026-12-30')`, [name])).rows[0]!.id;
}
async function put(trip: string, userId: string | null, displayName: string, over: { role?: string; status?: string } = {}): Promise<string> {
  await users.asAdmin();
  return (await db.query<{ id: string }>(
    `insert into public.trip_members (trip_id, user_id, display_name, role, status, left_at)
     values ($1, $2, $3, $4, $5, case when $5 = 'active' then null else now() end) returning id`,
    [trip, userId, displayName, over.role ?? 'member', over.status ?? 'active'],
  )).rows[0]!.id;
}
async function archive(trip: string, on = true) {
  await users.asAdmin();
  await db.query(`update public.trips set status = $2 where id = $1`, [trip, on ? 'archived' : 'active']);
}
async function expire(invite: string) {
  await users.asAdmin();
  await db.query(`update public.trip_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`, [invite]);
}
const NOBODY = '00000000-0000-4000-8000-000000000000';

let asha: string; // administrator and creator
let ravi: string;
let nina: string;
let sam: string; // never on any trip
let dev: string;
let meera: string; // administrator of her own, separate trip

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  nina = await users.signUp('nina@example.com', 'Nina Shah');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
  dev = await users.signUp('dev@example.com', 'Departed Dev');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
});
afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------------------------------
describe('who can run what', () => {
  it('a signed-out visitor can run preview_invite and NOTHING else', async () => {
    const trip = await makeTrip(asha, 'Anon');
    expect(await outcome(preview(null, 'f'.repeat(64)))).toBe('ok');
    expect(await outcome(q(null, 'select * from public.create_invite($1, null, 168)', [trip]))).toBe('permission denied');
    expect(await outcome(q(null, 'select * from public.list_trip_invites($1)', [trip]))).toBe('permission denied');
    expect(await outcome(q(null, 'select * from public.revoke_invite($1, $2)', [trip, NOBODY]))).toBe('permission denied');
    expect(await outcome(q(null, 'select * from public.request_to_join($1)', ['f'.repeat(64)]))).toBe('permission denied');
    expect(await outcome(q(null, 'select * from public.list_join_requests($1)', [trip]))).toBe('permission denied');
    expect(await outcome(q(null, 'select * from public.decide_join_request($1, $2, true)', [trip, NOBODY]))).toBe('permission denied');
    await users.asAdmin();
    const anon = (await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`,
    )).rows.map((r) => r.proname);
    expect(anon).toEqual(['preview_invite']);
  });

  it('immediate joining is gone: accept_invite no longer exists, nor does the old usage-limit signature', async () => {
    await users.asAdmin();
    const names = (await db.query<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('accept_invite', 'create_invite')`,
    )).rows;
    expect(names.map((n) => n.proname)).toEqual(['create_invite']);
    expect(names[0]!.args).toBe('p_trip_id uuid, p_claim_member_id uuid, p_expires_in_hours integer');
    const col = await db.query(`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trip_invites' and column_name = 'max_uses'`);
    expect(col.rows).toEqual([]);
  });

  it('nobody can read or write the invitations or the requests directly, not even an administrator', async () => {
    const trip = await makeTrip(asha, 'Closed');
    await makeInvite(asha, trip);
    for (const who of [asha, ravi, sam, null]) {
      for (const table of ['trip_invites', 'trip_join_requests']) {
        expect(await outcome(q(who, `select * from public.${table}`)), `${who}/${table}`).toBe('permission denied');
      }
    }
    for (const sql of [
      `update public.trip_invites set revoked_at = null`, `delete from public.trip_invites`,
      `insert into public.trip_join_requests (trip_id, invite_id, user_id, requester_name) values ('${trip}', '${NOBODY}', '${asha}', 'x')`,
      `update public.trip_join_requests set status = 'approved'`, `delete from public.trip_join_requests`,
    ]) expect(await outcome(q(asha, sql)), sql).toBe('permission denied');
  });

  it('every write takes the trip lock first, and a decision re-checks under it', async () => {
    await users.asAdmin();
    const src = async (fn: string) => (await db.query<{ prosrc: string }>(`select prosrc from pg_proc where proname = $1`, [fn])).rows[0]!.prosrc;
    for (const fn of ['create_invite', 'revoke_invite', 'decide_join_request']) expect(await src(fn), fn).toMatch(/member_change_context\(/);
    const req = await src('request_to_join');
    expect(req).toMatch(/from public\.trips t where t\.id = v_inv\.trip_id for update/);
    expect(req).toMatch(/from public\.trip_invites i where i\.id = v_inv\.id for update/);
    expect(req.indexOf('for update')).toBeLessThan(req.indexOf('insert into public.trip_join_requests'));
    const dec = await src('decide_join_request');
    expect(dec).toMatch(/from public\.trip_join_requests r where r\.id = p_request_id and r\.trip_id = p_trip_id for update/);
    expect(dec.indexOf('member_change_context')).toBeLessThan(dec.indexOf('for update')); // trip locked before the request row
    for (const fn of ['create_invite', 'list_trip_invites', 'revoke_invite', 'request_to_join', 'list_join_requests', 'decide_join_request']) {
      expect(await src(fn), fn).toMatch(/auth\.uid\(\)/);
      expect(await src(fn), fn).not.toMatch(/\bdelete\s+from\s+public\./i); // no invitation, request or member row is ever deleted (only a link's Vault secret)
      expect(await src(fn), fn).not.toMatch(/raise\s+(notice|warning|info|log)/i); // nothing is ever written to the logs
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('tokens', () => {
  it('are 64 lower-case hex characters, and only their SHA-256 hash is stored', async () => {
    const trip = await makeTrip(asha, 'Tokens');
    const inv = await makeInvite(asha, trip);
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    const row = await inviteRow(inv.invite_id);
    await users.asAdmin();
    const expected = (await db.query<{ h: string }>(`select encode(sha256(convert_to($1, 'UTF8')), 'hex') as h`, [inv.token])).rows[0]!.h;
    expect(row.token_hash).toBe(expected);
    expect(row.token_hash).not.toBe(inv.token);
  });

  it('appear nowhere in the database: not in the invitation, the requests, the audit trail, or any member row', async () => {
    const trip = await makeTrip(asha, 'NoRaw');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await decide(asha, trip, r.request_id!, true);
    await users.asAdmin();
    const dump = JSON.stringify([
      (await db.query('select * from public.trip_invites')).rows,
      (await db.query('select * from public.trip_join_requests')).rows,
      (await db.query('select * from public.trip_member_events')).rows,
      (await db.query('select * from public.trip_members')).rows,
      (await db.query('select * from public.trips')).rows,
    ]);
    expect(dump).not.toContain(inv.token);
  });

  it('are never the same twice: 150 links give 150 different tokens', async () => {
    const trip = await makeTrip(asha, 'Many');
    const seen = new Set<string>();
    for (let i = 0; i < 150; i++) seen.add((await newGeneral(asha, trip)).token); // revoke the last one, then create
    expect(seen.size).toBe(150);
    const joined = [...seen].join('');
    expect(new Set(joined).size).toBe(16);
    expect(new Set([...seen].map((t) => t.slice(0, 4))).size).toBeGreaterThan(120);
  });

  it('are shown ONLY when the link is created: the list has no token and no hash', async () => {
    const trip = await makeTrip(asha, 'Once');
    const inv = await makeInvite(asha, trip);
    const rows = (await list(asha, trip)).rows;
    expect(JSON.stringify(rows)).not.toContain(inv.token);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['claim_member_id', 'claim_name', 'copyable', 'created_at', 'created_by_name', 'expires_at', 'invite_id', 'revoked_at', 'status', 'use_count']);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('create_invite: one reusable general link per trip', () => {
  it('an administrator creates it: 7 days by default, no usage limit', async () => {
    const trip = await makeTrip(asha, 'Create');
    const before = Date.now();
    const inv = (await q<Created>(asha, 'select * from public.create_invite($1)', [trip])).rows[0]!;
    const days = (new Date(inv.expires_at).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(await inviteRow(inv.invite_id)).toMatchObject({ trip_id: trip, use_count: 0, revoked_at: null, claim_member_id: null, created_by: byUser(await members(trip), asha)!.id });
    expect(Object.keys(await inviteRow(inv.invite_id))).not.toContain('max_uses');
  });

  it('may last 1 hour to 30 days, and nothing outside that', async () => {
    const trip = await makeTrip(asha, 'Limits');
    for (const hours of [1, 24, 168, 720]) expect(await outcome(newGeneral(asha, trip, { hours })), String(hours)).toBe('ok');
    for (const hours of [0, 721, -5, null]) expect(await outcome(create(asha, trip, { hours })), String(hours)).toBe('invalid_request');
  });

  it('creating another is REFUSED while a valid one exists, so nobody can kill a link people already received', async () => {
    const trip = await makeTrip(asha, 'OneLink');
    const first = await makeInvite(asha, trip);
    expect(await outcome(create(asha, trip))).toBe('invite_exists');
    expect(await outcome(create(asha, trip, { hours: 24 }))).toBe('invite_exists');
    expect((await preview(null, first.token)).rows).toHaveLength(1); // still works
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(first.token);
    await users.asAdmin();
    expect((await db.query<{ n: number }>(`select count(*)::int as n from public.trip_invites where trip_id = $1 and claim_member_id is null and revoked_at is null`, [trip])).rows[0]!.n).toBe(1);
    // the database itself refuses a second live general link, whoever writes it
    await expect(db.query(`insert into public.trip_invites (trip_id, token_hash, created_by, expires_at) select trip_id, repeat('b', 64), created_by, now() + interval '1 day' from public.trip_invites where id = $1`, [first.invite_id])).rejects.toThrow(/trip_invites_one_live_general|duplicate key/);
  });

  it('after revoking, or once a link has expired, a new one can be made; the old one stays dead', async () => {
    const trip = await makeTrip(asha, 'AfterRevoke');
    const first = await makeInvite(asha, trip);
    await revoke(asha, trip, first.invite_id);
    const second = await makeInvite(asha, trip);
    expect(second.token).not.toBe(first.token);
    expect((await preview(null, first.token)).rows).toEqual([]);
    expect((await preview(null, second.token)).rows).toHaveLength(1);
    await expire(second.invite_id); // expired, never revoked
    const third = await makeInvite(asha, trip);
    expect((await preview(null, second.token)).rows).toEqual([]);
    expect((await preview(null, third.token)).rows).toHaveLength(1);
    expect((await inviteRow(second.invite_id)).revoked_at).not.toBeNull(); // cleared away when the new one was made
  });

  it('a link for another trip is never touched by this trip\'s refusal, revocation or new link', async () => {
    const a = await makeTrip(asha, 'OtherA');
    const b = await makeTrip(meera, 'OtherB');
    const theirs = await makeInvite(meera, b);
    const mine = await makeInvite(asha, a);
    expect(await outcome(create(asha, a))).toBe('invite_exists');
    await revoke(asha, a, mine.invite_id);
    await makeInvite(asha, a);
    expect((await preview(null, theirs.token)).rows).toHaveLength(1);
    expect((await getLink(meera, b)).rows[0]!.token).toBe(theirs.token);
  });

  it('an ordinary member, a stranger, a removed person and a person who left are refused (and learn nothing)', async () => {
    const trip = await makeTrip(asha, 'Deny');
    await put(trip, ravi, 'Ravi Kumar');
    await put(trip, nina, 'Nina Shah', { status: 'removed' });
    await put(trip, dev, 'Departed Dev', { status: 'left' });
    expect(await outcome(create(ravi, trip))).toBe('not_admin');
    for (const who of [sam, nina, dev, meera]) expect(await outcome(create(who, trip)), who).toBe('trip_not_found');
    expect(await outcome(create(sam, NOBODY))).toBe('trip_not_found');
    await users.asAdmin();
    expect((await db.query('select 1 from public.trip_invites where trip_id = $1', [trip])).rows).toEqual([]);
  });

  it('an archived trip cannot get links until it is restored', async () => {
    const trip = await makeTrip(asha, 'Arch');
    await archive(trip);
    expect(await outcome(create(asha, trip))).toBe('trip_archived');
    await archive(trip, false);
    expect(await outcome(create(asha, trip))).toBe('ok');
  });

  it('a claim link must name an ACTIVE GUEST of THIS trip; each guest has one live claim link', async () => {
    const trip = await makeTrip(asha, 'Claim');
    const raviId = await put(trip, ravi, 'Ravi Kumar');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const gone = (await addGuest(asha, trip, 'Gone')).rows[0]!.member_id;
    await q(asha, 'select * from public.remove_member($1, $2)', [trip, gone]);
    const other = await makeTrip(meera, 'ClaimOther');
    const theirs = (await addGuest(meera, other, 'Theirs')).rows[0]!.member_id;
    const first = await makeInvite(asha, trip, { claim: gita });
    expect(await outcome(create(asha, trip, { claim: raviId }))).toBe('not_a_guest');
    expect(await outcome(create(asha, trip, { claim: gone }))).toBe('member_not_found');
    expect(await outcome(create(asha, trip, { claim: theirs }))).toBe('member_not_found');
    expect(await outcome(create(asha, trip, { claim: NOBODY }))).toBe('member_not_found');
    const second = await makeInvite(asha, trip, { claim: gita }); // replaces the first
    expect((await preview(null, first.token)).rows).toEqual([]);
    expect((await preview(null, second.token)).rows).toHaveLength(1);
  });

  it('a general link and a claim link live side by side: making one does not cancel the other', async () => {
    const trip = await makeTrip(asha, 'Side');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const general = await makeInvite(asha, trip);
    const claim = await makeInvite(asha, trip, { claim: gita });
    expect((await preview(null, general.token)).rows).toHaveLength(1);
    expect((await preview(null, claim.token)).rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('list_trip_invites and revoke_invite', () => {
  it('only administrators of the trip can list; the list says what each link is for and its state', async () => {
    const trip = await makeTrip(asha, 'List');
    await put(trip, ravi, 'Ravi Kumar');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const general = await makeInvite(asha, trip);
    const claim = await makeInvite(asha, trip, { claim: gita });
    const used = await makeInvite(asha, trip, { claim: (await addGuest(asha, trip, 'Hari')).rows[0]!.member_id });
    await request(nina, used.token);
    const rows = (await list(asha, trip)).rows;
    const state = (id: string) => rows.find((r) => r.invite_id === id)!;
    expect(state(general.invite_id)).toMatchObject({ status: 'active', use_count: 0, claim_name: null, created_by_name: 'Asha Rao' });
    expect(state(claim.invite_id)).toMatchObject({ status: 'active', claim_name: 'Gita', claim_member_id: gita });
    expect(state(used.invite_id)).toMatchObject({ status: 'used', use_count: 1, claim_name: 'Hari' });
    expect(await outcome(list(ravi, trip))).toBe('not_admin');
    for (const who of [sam, meera]) expect(await outcome(list(who, trip)), who).toBe('trip_not_found');
    expect(await outcome(list(sam, NOBODY))).toBe('trip_not_found');
  });

  it('a revoked link shows as cancelled, an expired one as expired, and only this trip\'s links are listed', async () => {
    const a = await makeTrip(asha, 'ListA');
    const b = await makeTrip(meera, 'ListB');
    await makeInvite(meera, b);
    const old = await makeInvite(asha, a);
    await revoke(asha, a, old.invite_id);
    const current = await makeInvite(asha, a);
    await expire(current.invite_id);
    const rows = (await list(asha, a)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.invite_id === old.invite_id)!.status).toBe('revoked');
    expect(rows.find((r) => r.invite_id === current.invite_id)!.status).toBe('expired');
    expect((await list(meera, b)).rows).toHaveLength(1);
  });
  it('any administrator can revoke the link (peers); it stops new requests; repeating is safe', async () => {
    const trip = await makeTrip(asha, 'Revoke');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const inv = await makeInvite(asha, trip);
    expect((await revoke(ravi, trip, inv.invite_id)).rows[0]).toMatchObject({ changed: true });
    const row = await inviteRow(inv.invite_id);
    expect(row.revoked_by).toBe(byUser(await members(trip), ravi)!.id);
    expect((await preview(null, inv.token)).rows).toEqual([]);
    expect(await outcome(request(nina, inv.token))).toBe('invite_invalid');
    const when = row.revoked_at;
    expect((await revoke(asha, trip, inv.invite_id)).rows[0]!.changed).toBe(false);
    expect((await inviteRow(inv.invite_id)).revoked_at).toEqual(when);
  });

  it('refuses ordinary members, strangers, other trips\' links and archived trips', async () => {
    const trip = await makeTrip(asha, 'RevokeDeny');
    await put(trip, ravi, 'Ravi Kumar');
    const inv = await makeInvite(asha, trip);
    const other = await makeTrip(meera, 'RevokeOther');
    const theirs = await makeInvite(meera, other);
    expect(await outcome(revoke(ravi, trip, inv.invite_id))).toBe('not_admin');
    expect(await outcome(revoke(sam, trip, inv.invite_id))).toBe('trip_not_found');
    expect(await outcome(revoke(asha, trip, theirs.invite_id))).toBe('invite_not_found');
    expect(await outcome(revoke(asha, trip, NOBODY))).toBe('invite_not_found');
    await archive(trip);
    expect(await outcome(revoke(asha, trip, inv.invite_id))).toBe('trip_archived');
    expect((await inviteRow(inv.invite_id)).revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('preview_invite (the one function open to signed-out visitors)', () => {
  it('shows exactly these facts and nothing else, to a signed-out visitor and to a signed-in one', async () => {
    const trip = await makeTrip(asha, 'Goa Trip 2026');
    await put(trip, ravi, 'Ravi Kumar');
    await put(trip, dev, 'Departed Dev', { status: 'left' });
    await addGuest(asha, trip, 'Gita');
    const inv = await makeInvite(asha, trip);
    for (const who of [null, sam, asha]) {
      const rows = (await preview(who, inv.token)).rows;
      expect(rows, String(who)).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(['claim_name', 'destination', 'end_date', 'inviter_name', 'is_claim', 'member_count', 'start_date', 'trip_name']);
      expect(rows[0]).toMatchObject({ trip_name: 'Goa Trip 2026', destination: 'Somewhere', inviter_name: 'Asha Rao', member_count: 3, is_claim: false, claim_name: null });
    }
    const text = JSON.stringify((await preview(null, inv.token)).rows);
    for (const forbidden of [trip, asha, ravi, inv.invite_id, 'budget', 'Departed Dev', 'Ravi', 'Gita', 'token', 'hash']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('for a claim link also names the friend, and the link works only until a request has been made with it', async () => {
    const trip = await makeTrip(asha, 'PreviewClaim');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const inv = await makeInvite(asha, trip, { claim: gita });
    expect((await preview(null, inv.token)).rows[0]).toMatchObject({ is_claim: true, claim_name: 'Gita' });
    await request(nina, inv.token);
    expect((await preview(null, inv.token)).rows).toEqual([]);
  });

  it('gives the SAME empty answer for every kind of unusable token, and never an error', async () => {
    const trip = await makeTrip(asha, 'PreviewBad');
    const replaced = await makeInvite(asha, trip);
    await revoke(asha, trip, replaced.invite_id);
    const expired = await makeInvite(meera, await makeTrip(meera, 'PreviewExp'));
    await expire(expired.invite_id);
    const archivedTrip = await makeTrip(asha, 'PreviewArch');
    const onArchived = await makeInvite(asha, archivedTrip);
    await archive(archivedTrip);
    const gitaTrip = await makeTrip(asha, 'PreviewGuest');
    const gita = (await addGuest(asha, gitaTrip, 'Gita')).rows[0]!.member_id;
    const claim = await makeInvite(asha, gitaTrip, { claim: gita });
    await q(asha, 'select * from public.remove_member($1, $2)', [gitaTrip, gita]);
    const bad: unknown[] = [
      replaced.token, expired.token, onArchived.token, claim.token,
      'f'.repeat(64), '0'.repeat(64),
      '', ' ', 'abc', 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'g'.repeat(64), `${'f'.repeat(63)}'`, "' or 1=1 --", '../../etc/passwd', null,
    ];
    const answers: string[] = [];
    for (const t of bad) answers.push(await preview(null, t as string).then((x) => JSON.stringify(x.rows), (e) => `ERROR ${e}`));
    expect(new Set(answers)).toEqual(new Set(['[]']));
  });

  it('works again if an archived trip is restored, and viewing never changes anything', async () => {
    const trip = await makeTrip(asha, 'PreviewRestore');
    const inv = await makeInvite(asha, trip);
    await archive(trip);
    expect((await preview(null, inv.token)).rows).toEqual([]);
    await archive(trip, false);
    expect((await preview(null, inv.token)).rows).toHaveLength(1);
    const before = JSON.stringify(await inviteRow(inv.invite_id));
    await preview(null, inv.token);
    expect(JSON.stringify(await inviteRow(inv.invite_id))).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('request_to_join: a request is NEVER a membership', () => {
  it('creates one pending request and no membership; the requester stays a stranger', async () => {
    const trip = await makeTrip(asha, 'Request');
    const inv = await makeInvite(asha, trip);
    const before = JSON.stringify(await members(trip));
    const r = (await request(nina, inv.token)).rows[0]!;
    expect(r).toMatchObject({ trip_id: trip, outcome: 'requested' });
    expect(JSON.stringify(await members(trip))).toBe(before); // not a single member row changed or was added
    expect(await events(trip)).toEqual([]);
    expect(await requestRow(r.request_id!)).toMatchObject({ trip_id: trip, invite_id: inv.invite_id, user_id: nina, requester_name: 'Nina Shah', status: 'pending', claim_member_id: null, decided_at: null, decided_by: null, member_id: null });
    expect((await inviteRow(inv.invite_id)).use_count).toBe(1);
  });

  it('a pending person can see NOTHING about the trip: not the trip, its people, its links, its requests or its audit trail', async () => {
    const trip = await makeTrip(asha, 'PendingSeesNothing');
    await put(trip, ravi, 'Ravi Kumar');
    await addGuest(asha, trip, 'Gita');
    const inv = await makeInvite(asha, trip);
    await request(nina, inv.token);
    await q(asha, 'select * from public.remove_member($1, $2)', [trip, byName(await members(trip), 'Gita').id]);
    expect((await q(nina, 'select id from public.trips where id = $1', [trip])).rows).toEqual([]);
    expect((await q<{ id: string }>(nina, 'select id from public.trips')).rows.map((r) => r.id)).not.toContain(trip); // (she may be on other trips)
    expect((await q(nina, 'select id from public.trip_members where trip_id = $1', [trip])).rows).toEqual([]);
    expect((await q(nina, 'select id from public.trip_member_events where trip_id = $1', [trip])).rows).toEqual([]);
    expect((await q(nina, 'select * from public.list_trip_members($1)', [trip])).rows).toEqual([]);
    expect(await outcome(list(nina, trip))).toBe('trip_not_found');
    expect(await outcome(pending(nina, trip))).toBe('trip_not_found');
    expect(await outcome(create(nina, trip))).toBe('trip_not_found');
    expect(await outcome(q(nina, 'select * from public.add_guest_member($1, $2)', [trip, 'X']))).toBe('trip_not_found');
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [trip]))).toBe('trip_not_found');
    expect(await outcome(q(nina, 'select * from public.update_trip($1, 1, $2, $3, $4, $5)', [trip, 'Hacked', 'x', '2026-12-27', '2026-12-30']))).toBe('trip_not_found');
    expect(await outcome(q(nina, 'select * from public.set_trip_archived($1, true, 1)', [trip]))).toBe('trip_not_found');
    expect(await outcome(q(nina, 'select * from public.trip_role_of($1, $2)', [trip, nina]))).toBe('permission denied');
    expect(await outcome(decide(nina, trip, NOBODY, true))).toBe('trip_not_found'); // and cannot approve herself
  });

  it('a pending person cannot approve their own request or anyone\'s', async () => {
    const trip = await makeTrip(asha, 'NoSelfApproval');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    expect(await outcome(decide(nina, trip, r.request_id!, true))).toBe('trip_not_found');
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    expect(byUser(await members(trip), nina)).toBeUndefined();
  });

  it('asking twice returns the same request: no duplicate', async () => {
    const trip = await makeTrip(asha, 'Duplicate');
    const inv = await makeInvite(asha, trip);
    const a = (await request(nina, inv.token)).rows[0]!;
    const b = (await request(nina, inv.token)).rows[0]!;
    expect(b).toMatchObject({ outcome: 'already_requested', request_id: a.request_id });
    await users.asAdmin();
    expect((await db.query<{ n: number }>(`select count(*)::int as n from public.trip_join_requests where trip_id = $1`, [trip])).rows[0]!.n).toBe(1);
    expect((await inviteRow(inv.invite_id)).use_count).toBe(1); // the second ask did not count
  });

  it('asking through a replacement link while one request is waiting is the same request, not a second', async () => {
    const trip = await makeTrip(asha, 'WaitingReplaced');
    const first = await makeInvite(asha, trip);
    const a = (await request(nina, first.token)).rows[0]!;
    await revoke(asha, trip, first.invite_id);
    const second = await makeInvite(asha, trip);
    const b = (await request(nina, second.token)).rows[0]!;
    expect(b).toMatchObject({ outcome: 'already_requested', request_id: a.request_id });
    expect((await pending(asha, trip)).rows).toHaveLength(1);
  });

  it('someone already on the trip is a safe no-op: no request is made', async () => {
    const trip = await makeTrip(asha, 'AlreadyIn');
    await put(trip, ravi, 'Ravi Kumar');
    const inv = await makeInvite(asha, trip);
    expect((await request(ravi, inv.token)).rows[0]).toMatchObject({ outcome: 'already_member', request_id: null });
    expect((await request(asha, inv.token)).rows[0]!.outcome).toBe('already_member');
    expect((await pending(asha, trip)).rows).toEqual([]);
    expect((await inviteRow(inv.invite_id)).use_count).toBe(0);
  });

  it('every unusable token gets the same refusal, and no error text ever contains the token', async () => {
    const trip = await makeTrip(asha, 'RequestBad');
    const replaced = await makeInvite(asha, trip);
    await revoke(asha, trip, replaced.invite_id);
    const expired = await makeInvite(meera, await makeTrip(meera, 'RequestExp'));
    await expire(expired.invite_id);
    const archivedTrip = await makeTrip(asha, 'RequestArch');
    const onArchived = await makeInvite(asha, archivedTrip);
    await archive(archivedTrip);
    const tokens: unknown[] = [replaced.token, expired.token, onArchived.token, 'f'.repeat(64), '', 'abc', 'F'.repeat(64), "' or 1=1 --", null];
    for (const t of tokens) {
      const text = await errorText(request(sam, t));
      expect(text, String(t)).toContain('invite_invalid');
      if (typeof t === 'string' && t.length > 3) expect(text, String(t)).not.toContain(t);
    }
    await users.asAdmin();
    expect((await db.query<{ n: number }>(`select count(*)::int as n from public.trip_join_requests where user_id = $1`, [sam])).rows[0]!.n).toBe(0);
  });

  it('expiry, revocation or replacement stop NEW requests but never touch requests already made', async () => {
    const trip = await makeTrip(asha, 'LinkEnds');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await expire(inv.invite_id);
    await revoke(asha, trip, inv.invite_id);
    await makeInvite(asha, trip); // and replaced
    expect(await outcome(request(ravi, inv.token))).toBe('invite_invalid');
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    expect((await pending(asha, trip)).rows.map((x) => x.requester_name)).toEqual(['Nina Shah']);
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok'); // and an administrator can still approve it
    expect(byUser(await members(trip), nina)!.status).toBe('active');
  });

  it('an archived trip accepts no requests until it is restored', async () => {
    const trip = await makeTrip(asha, 'RequestArchived');
    const inv = await makeInvite(asha, trip);
    await archive(trip);
    expect(await outcome(request(nina, inv.token))).toBe('invite_invalid');
    await archive(trip, false);
    expect(await outcome(request(nina, inv.token))).toBe('ok');
  });

  it('after a REJECTION the same account cannot ask again with the same link (decision B); a replacement link lets them', async () => {
    const trip = await makeTrip(asha, 'Rejected');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await decide(asha, trip, r.request_id!, false);
    expect(await outcome(request(nina, inv.token))).toBe('request_used');
    expect(await outcome(request(ravi, inv.token))).toBe('ok'); // other people are not affected
    await revoke(asha, trip, inv.invite_id);
    const fresh = await makeInvite(asha, trip);
    const again = (await request(nina, fresh.token)).rows[0]!;
    expect(again.outcome).toBe('requested');
    expect(again.request_id).not.toBe(r.request_id);
    expect((await requestRow(r.request_id!)).status).toBe('rejected'); // the history stays
  });

  it('after approval and later leaving, the same link cannot be used again; a replacement link can', async () => {
    const trip = await makeTrip(asha, 'ApprovedThenLeft');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await decide(asha, trip, r.request_id!, true);
    await q(nina, 'select * from public.leave_trip($1)', [trip]);
    expect(await outcome(request(nina, inv.token))).toBe('request_used');
    await revoke(asha, trip, inv.invite_id);
    expect(await outcome(request(nina, (await makeInvite(asha, trip)).token))).toBe('ok');
  });

  it('at most 50 requests can wait on one trip', async () => {
    const trip = await makeTrip(asha, 'TooMany');
    const inv = await makeInvite(asha, trip);
    const people: string[] = [];
    for (let i = 0; i < 51; i++) people.push(await users.signUp(`wait${i}@example.com`, `Waiter ${i}`));
    for (let i = 0; i < 50; i++) expect(await outcome(request(people[i]!, inv.token)), String(i)).toBe('ok');
    expect(await outcome(request(people[50]!, inv.token))).toBe('too_many_requests');
    const first = (await pending(asha, trip)).rows[0]!;
    await decide(asha, trip, first.request_id, false);
    expect(await outcome(request(people[50]!, inv.token))).toBe('ok');
  });

  it('a person whose profile is gone cannot ask', async () => {
    const trip = await makeTrip(asha, 'NoProfile');
    const inv = await makeInvite(asha, trip);
    const ghost = await users.signUp('ghost@example.com', 'Ghost');
    await users.asAdmin();
    await db.query(`update public.profiles set deleted_at = now() where id = $1`, [ghost]);
    expect(await outcome(request(ghost, inv.token))).toBe('profile_missing');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('list_join_requests', () => {
  it('shows only PENDING requests, oldest first, with a name and time but never a user id or token', async () => {
    const trip = await makeTrip(asha, 'ListRequests');
    const inv = await makeInvite(asha, trip);
    const a = (await request(nina, inv.token)).rows[0]!;
    await request(ravi, inv.token);
    await request(sam, inv.token);
    await decide(asha, trip, a.request_id!, true);
    // requests can land in the same millisecond: give them distinct, known times so "oldest first" is testable
    await users.asAdmin();
    await db.query(`update public.trip_join_requests r set created_at = now() - interval '2 hours' from public.profiles p where p.id = r.user_id and p.display_name = 'Ravi Kumar' and r.trip_id = $1`, [trip]);
    await db.query(`update public.trip_join_requests r set created_at = now() - interval '1 hour' from public.profiles p where p.id = r.user_id and p.display_name = 'Stranger Sam' and r.trip_id = $1`, [trip]);
    const rows = (await pending(asha, trip)).rows;
    expect(rows.map((r) => r.requester_name)).toEqual(['Ravi Kumar', 'Stranger Sam']);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['claim_member_id', 'claim_name', 'created_at', 'request_id', 'requester_name']);
    const text = JSON.stringify(rows);
    for (const secret of [nina, ravi, sam, inv.token]) expect(text).not.toContain(secret);
  });

  it('only administrators of the trip may look, and each trip shows only its own', async () => {
    const trip = await makeTrip(asha, 'ListWho');
    await put(trip, ravi, 'Ravi Kumar');
    const other = await makeTrip(meera, 'ListOther');
    await request(nina, (await makeInvite(asha, trip)).token);
    await request(sam, (await makeInvite(meera, other)).token);
    expect(await outcome(pending(ravi, trip))).toBe('not_admin');
    for (const who of [sam, nina, meera]) expect(await outcome(pending(who, trip)), who).toBe('trip_not_found');
    expect((await pending(asha, trip)).rows.map((r) => r.requester_name)).toEqual(['Nina Shah']);
    expect((await pending(meera, other)).rows.map((r) => r.requester_name)).toEqual(['Stranger Sam']);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('decide_join_request: approving', () => {
  it('only an administrator of the trip can decide (peers); everyone else is refused', async () => {
    const trip = await makeTrip(asha, 'DecideWho');
    await put(trip, ravi, 'Ravi Kumar');
    await put(trip, dev, 'Departed Dev', { status: 'left' });
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    expect(await outcome(decide(ravi, trip, r.request_id!, true))).toBe('not_admin');
    for (const who of [sam, dev, meera]) expect(await outcome(decide(who, trip, r.request_id!, true)), who).toBe('trip_not_found');
    expect(await outcome(q(null, 'select * from public.decide_join_request($1, $2, true)', [trip, r.request_id]))).toBe('permission denied');
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    const second = await put(trip, sam, 'Stranger Sam', { role: 'admin' });
    expect(second).toBeTruthy();
    expect(await outcome(decide(sam, trip, r.request_id!, true))).toBe('ok'); // any active administrator
  });

  it('approving adds an ordinary member under their profile name, invited by the link\'s creator, with the APPROVING admin as the actor', async () => {
    const trip = await makeTrip(asha, 'Approve');
    const second = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    const d = (await decide(ravi, trip, r.request_id!, true)).rows[0]!;
    expect(d).toMatchObject({ request_id: r.request_id, outcome: 'approved' });
    const ms = await members(trip);
    const n = byUser(ms, nina)!;
    expect(n).toMatchObject({ id: d.member_id, display_name: 'Nina Shah', role: 'member', status: 'active', left_at: null, invited_by: byUser(ms, asha)!.id });
    expect(await events(trip)).toEqual([{ action: 'joined', actor_member_id: second, target_member_id: n.id, old_value: null, new_value: r.request_id }]);
    expect(await requestRow(r.request_id!)).toMatchObject({ status: 'approved', decided_by: second, member_id: n.id });
    expect((await requestRow(r.request_id!)).decided_at).not.toBeNull();
    // and only now can she see and use the trip
    expect((await q(nina, 'select * from public.list_trip_members($1)', [trip])).rows.length).toBe(3);
    expect(await outcome(create(nina, trip))).toBe('not_admin');
    expect((await pending(asha, trip)).rows).toEqual([]);
  });

  it('uses the profile name as it is at the moment of approval', async () => {
    const trip = await makeTrip(asha, 'NameLater');
    const renamer = await users.signUp('renamer@example.com', 'Before Name');
    const r = (await request(renamer, (await makeInvite(asha, trip)).token)).rows[0]!;
    await users.asAdmin();
    await db.query(`update public.profiles set display_name = 'After Name' where id = $1`, [renamer]);
    await decide(asha, trip, r.request_id!, true);
    expect(byUser(await members(trip), renamer)!.display_name).toBe('After Name');
  });

  it('a registered account whose name matches another member is approved all the same (identity is the user id)', async () => {
    const trip = await makeTrip(asha, 'SameName');
    await addGuest(asha, trip, 'Nina Shah');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok');
    expect(active(await members(trip)).filter((m) => m.display_name === 'Nina Shah')).toHaveLength(2);
    expect(await outcome(addGuest(asha, trip, 'nina shah'))).toBe('name_taken'); // guest-name uniqueness is unchanged
  });

  it('a returning person gets their OLD row back: same id and join date, role reset to member', async () => {
    const trip = await makeTrip(asha, 'Rejoin');
    const oldAdmin = await put(trip, nina, 'Old Nina', { role: 'admin', status: 'removed' });
    const before = (await members(trip)).find((m) => m.id === oldAdmin)!;
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    const d = (await decide(asha, trip, r.request_id!, true)).rows[0]!;
    expect(d.member_id).toBe(oldAdmin);
    const after = (await members(trip)).find((m) => m.id === oldAdmin)!;
    expect(after).toMatchObject({ status: 'active', role: 'member', left_at: null, user_id: nina, display_name: 'Nina Shah' });
    expect(after.joined_at).toEqual(before.joined_at);
    expect((await members(trip)).filter((m) => m.user_id === nina)).toHaveLength(1);
    expect((await events(trip)).at(-1)).toMatchObject({ action: 'joined', old_value: 'removed', new_value: r.request_id });
  });

  it('a requester who has become a member another way is approved with no change', async () => {
    const trip = await makeTrip(asha, 'BecameMember');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    const id = await put(trip, nina, 'Nina Shah');
    const before = JSON.stringify(await members(trip));
    expect((await decide(asha, trip, r.request_id!, true)).rows[0]).toMatchObject({ outcome: 'already_member', member_id: id });
    expect(JSON.stringify(await members(trip))).toBe(before);
    expect(await events(trip)).toEqual([]);
    expect((await requestRow(r.request_id!)).status).toBe('approved');
  });

  it('the 50-member limit is re-checked at approval: a full trip refuses, the request stays pending, and a free place makes it work', async () => {
    const trip = await makeTrip(asha, 'FullAtApproval');
    const link = await makeInvite(asha, trip);
    const r = (await request(nina, link.token)).rows[0]!;
    for (let i = 2; i <= 50; i++) await addGuest(asha, trip, `Guest ${i}`); // filled up AFTER she asked
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('trip_full');
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    expect(byUser(await members(trip), nina)).toBeUndefined();
    await q(asha, 'select * from public.remove_member($1, $2)', [trip, byName(await members(trip), 'Guest 2').id]);
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok');
    expect(active(await members(trip))).toHaveLength(50);
    // rejecting never needs room
    const other = (await request(ravi, link.token)).rows[0]!;
    expect((await decide(asha, trip, other.request_id!, false)).rows[0]!.outcome).toBe('rejected');
  });

  it('an archived trip decides nothing until it is restored; the request waits', async () => {
    const trip = await makeTrip(asha, 'DecideArchived');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    await archive(trip);
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('trip_archived');
    expect(await outcome(decide(asha, trip, r.request_id!, false))).toBe('trip_archived');
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    await archive(trip, false);
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok');
  });

  it('a requester whose profile has gone cannot be approved (but can be rejected)', async () => {
    const trip = await makeTrip(asha, 'Unavailable');
    const ghost = await users.signUp('ghost2@example.com', 'Ghost Two');
    const r = (await request(ghost, (await makeInvite(asha, trip)).token)).rows[0]!;
    await users.asAdmin();
    await db.query(`update public.profiles set deleted_at = now() where id = $1`, [ghost]);
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('requester_unavailable');
    expect(await outcome(decide(asha, trip, r.request_id!, false))).toBe('ok');
  });

  it('refuses unknown requests, another trip\'s requests, and an undecided answer', async () => {
    const trip = await makeTrip(asha, 'DecideBad');
    const other = await makeTrip(meera, 'DecideBadOther');
    const theirs = (await request(sam, (await makeInvite(meera, other)).token)).rows[0]!;
    const mine = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    expect(await outcome(decide(asha, trip, NOBODY, true))).toBe('request_not_found');
    expect(await outcome(decide(asha, trip, theirs.request_id!, true))).toBe('request_not_found'); // a request of another trip
    expect(await outcome(decide(asha, trip, mine.request_id!, null))).toBe('invalid_request');
    expect((await requestRow(theirs.request_id!)).status).toBe('pending');
    expect((await requestRow(mine.request_id!)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('decide_join_request: rejecting, and two administrators', () => {
  it('rejecting adds nobody, records who and when, and keeps the history', async () => {
    const trip = await makeTrip(asha, 'Reject');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    const d = (await decide(asha, trip, r.request_id!, false)).rows[0]!;
    expect(d).toMatchObject({ outcome: 'rejected', member_id: null });
    expect(byUser(await members(trip), nina)).toBeUndefined();
    expect(await events(trip)).toEqual([]);
    const row = await requestRow(r.request_id!);
    expect(row).toMatchObject({ status: 'rejected', decided_by: byUser(await members(trip), asha)!.id, member_id: null });
    expect(row.decided_at).not.toBeNull();
    expect((await pending(asha, trip)).rows).toEqual([]);
    expect(await outcome(q(nina, 'select * from public.list_trip_members($1)', [trip]))).toBe('ok'); // still a stranger: an empty list
    expect((await q(nina, 'select * from public.list_trip_members($1)', [trip])).rows).toEqual([]);
  });

  it('two administrators on the same request: the second is told it was already decided and nothing happens twice', async () => {
    const trip = await makeTrip(asha, 'TwoAdmins');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    expect((await decide(asha, trip, r.request_id!, true)).rows[0]!.outcome).toBe('approved');
    const second = (await decide(ravi, trip, r.request_id!, true)).rows[0]!;
    expect(second.outcome).toBe('already_decided');
    expect((await decide(ravi, trip, r.request_id!, false)).rows[0]!.outcome).toBe('already_decided'); // and cannot flip it
    expect((await members(trip)).filter((m) => m.user_id === nina)).toHaveLength(1);
    expect((await events(trip)).filter((e) => e.action === 'joined')).toHaveLength(1);
    expect((await requestRow(r.request_id!)).decided_by).toBe(byUser(await members(trip), asha)!.id);
  });

  it('a rejected request cannot be approved afterwards', async () => {
    const trip = await makeTrip(asha, 'RejectThenApprove');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    await decide(asha, trip, r.request_id!, false);
    expect((await decide(asha, trip, r.request_id!, true)).rows[0]!.outcome).toBe('already_decided');
    expect(byUser(await members(trip), nina)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('guest claiming: also by request and approval, and history is kept', () => {
  it('a claim link makes a CLAIM request: the guest row is not touched until an administrator approves', async () => {
    const trip = await makeTrip(asha, 'ClaimRequest');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const inv = await makeInvite(asha, trip, { claim: gita });
    const before = JSON.stringify(await members(trip));
    const r = (await request(nina, inv.token)).rows[0]!;
    expect(r.outcome).toBe('requested');
    expect(JSON.stringify(await members(trip))).toBe(before);
    expect(await requestRow(r.request_id!)).toMatchObject({ claim_member_id: gita, status: 'pending', requester_name: 'Nina Shah' });
    expect((await pending(asha, trip)).rows[0]).toMatchObject({ requester_name: 'Nina Shah', claim_member_id: gita, claim_name: 'Gita' });
    expect((await q(nina, 'select * from public.list_trip_members($1)', [trip])).rows).toEqual([]); // she sees nothing yet
  });

  it('approving turns the SAME row into the person: same member id, name, join date and role; nobody is added', async () => {
    const trip = await makeTrip(asha, 'ClaimApprove');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const before = (await members(trip)).find((m) => m.id === gita)!;
    const r = (await request(nina, (await makeInvite(asha, trip, { claim: gita })).token)).rows[0]!;
    const d = (await decide(asha, trip, r.request_id!, true)).rows[0]!;
    expect(d).toMatchObject({ outcome: 'approved', member_id: gita });
    const ms = await members(trip);
    const after = ms.find((m) => m.id === gita)!;
    expect(after).toMatchObject({ user_id: nina, display_name: 'Gita', role: 'member', status: 'active', left_at: null, invited_by: before.invited_by });
    expect(after.joined_at).toEqual(before.joined_at);
    expect(ms.length).toBe(2);
    const adminId = byUser(ms, asha)!.id;
    expect(await events(trip)).toEqual([
      { action: 'guest_added', actor_member_id: adminId, target_member_id: gita, old_value: null, new_value: 'Gita' },
      { action: 'guest_claimed', actor_member_id: adminId, target_member_id: gita, old_value: null, new_value: r.request_id }, // the APPROVING admin is the actor
    ]);
    expect(await requestRow(r.request_id!)).toMatchObject({ status: 'approved', member_id: gita });
    expect((await q(nina, 'select * from public.list_trip_members($1)', [trip])).rows.length).toBe(2); // now she sees the trip
    expect(await outcome(q(nina, 'select * from public.leave_trip($1)', [trip]))).toBe('ok');
  });

  it('a stand-in ledger pointing at the guest stays valid: nothing moves, nothing is copied, nothing is deleted', async () => {
    const trip = await makeTrip(asha, 'ClaimLedger');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    await users.asAdmin();
    await db.exec(`create table public.ledger_probe3 (member_id uuid not null references public.trip_members (id) on delete restrict)`);
    await db.query('insert into public.ledger_probe3 values ($1), ($1)', [gita]);
    const before = await members(trip);
    const r = (await request(nina, (await makeInvite(asha, trip, { claim: gita })).token)).rows[0]!;
    await decide(asha, trip, r.request_id!, true);
    const after = await members(trip);
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());
    await users.asAdmin();
    expect((await db.query<{ n: number }>('select count(*)::int as n from public.ledger_probe3 l join public.trip_members m on m.id = l.member_id where m.user_id is not null')).rows[0]!.n).toBe(2);
    await expect(db.query('delete from public.trip_members where id = $1', [gita])).rejects.toThrow(/ledger_probe3|foreign key/);
    await db.exec('drop table public.ledger_probe3');
  });

  it('a claim link is single use: the next person cannot use it, and a leaked copy cannot claim the same place twice', async () => {
    const trip = await makeTrip(asha, 'ClaimSingle');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const inv = await makeInvite(asha, trip, { claim: gita });
    expect(await outcome(request(nina, inv.token))).toBe('ok');
    expect(await outcome(request(ravi, inv.token))).toBe('invite_invalid');
    expect((await pending(asha, trip)).rows).toHaveLength(1);
  });

  it('a replacement claim link cannot be used to put a second person in the queue for the same place', async () => {
    const trip = await makeTrip(asha, 'ClaimPending');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    await request(nina, (await makeInvite(asha, trip, { claim: gita })).token);
    const fresh = await makeInvite(asha, trip, { claim: gita });
    expect(await outcome(request(ravi, fresh.token))).toBe('claim_pending');
    expect((await pending(asha, trip)).rows).toHaveLength(1);
    // once the first is rejected, the replacement works for someone else
    await decide(asha, trip, (await pending(asha, trip)).rows[0]!.request_id, false);
    expect(await outcome(request(ravi, fresh.token))).toBe('ok');
  });

  it('a claim fails cleanly when the guest is gone, claimed another way, or the requester has an older row', async () => {
    const trip = await makeTrip(asha, 'ClaimGone');
    const g1 = (await addGuest(asha, trip, 'One')).rows[0]!.member_id;
    const g2 = (await addGuest(asha, trip, 'Two')).rows[0]!.member_id;
    const g3 = (await addGuest(asha, trip, 'Three')).rows[0]!.member_id;
    await put(trip, dev, 'Departed Dev', { status: 'left' });
    const l1 = await makeInvite(asha, trip, { claim: g1 });
    const l2 = await makeInvite(asha, trip, { claim: g2 });
    const l3 = await makeInvite(asha, trip, { claim: g3 });
    // before asking: a removed guest makes the link unusable
    await q(asha, 'select * from public.remove_member($1, $2)', [trip, g1]);
    expect(await outcome(request(nina, l1.token))).toBe('invite_invalid');
    // someone with an older row on the trip cannot claim a guest
    expect(await outcome(request(dev, l3.token))).toBe('claim_conflict');
    // asked, then the guest is removed before approval: the approval is refused, the request stays pending
    const r2 = (await request(nina, l2.token)).rows[0]!;
    await q(asha, 'select * from public.remove_member($1, $2)', [trip, g2]);
    expect(await outcome(decide(asha, trip, r2.request_id!, true))).toBe('claim_unavailable');
    expect((await requestRow(r2.request_id!)).status).toBe('pending');
    expect((await decide(asha, trip, r2.request_id!, false)).rows[0]!.outcome).toBe('rejected'); // and it can be rejected
    expect(byUser(await members(trip), nina)).toBeUndefined();
  });

  it('an approval can never take over a person who already has an account, even if the guest row was linked some other way', async () => {
    const trip = await makeTrip(asha, 'ClaimTaken');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const r = (await request(nina, (await makeInvite(asha, trip, { claim: gita })).token)).rows[0]!;
    await users.asAdmin();
    await db.query(`update public.trip_members set user_id = $2 where id = $1`, [gita, ravi]); // linked to someone else by a direct write
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('claim_unavailable');
    expect((await members(trip)).find((m) => m.id === gita)!.user_id).toBe(ravi); // not taken over
    expect(byUser(await members(trip), nina)).toBeUndefined();
    expect((await requestRow(r.request_id!)).status).toBe('pending');
  });

  it('a claim whose requester gained an older row before approval is refused (two rows cannot be merged)', async () => {
    const trip = await makeTrip(asha, 'ClaimConflictLater');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const r = (await request(nina, (await makeInvite(asha, trip, { claim: gita })).token)).rows[0]!;
    await put(trip, nina, 'Nina Shah', { status: 'left' });
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('claim_conflict');
    expect((await members(trip)).find((m) => m.id === gita)!.user_id).toBeNull();
  });

  it('someone already on the trip who opens a claim link makes no request, and the guest stays claimable', async () => {
    const trip = await makeTrip(asha, 'ClaimMember');
    await put(trip, ravi, 'Ravi Kumar');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const inv = await makeInvite(asha, trip, { claim: gita });
    expect((await request(ravi, inv.token)).rows[0]!.outcome).toBe('already_member');
    expect((await pending(asha, trip)).rows).toEqual([]);
    expect(await outcome(request(nina, inv.token))).toBe('ok');
  });

  it('claiming works on a full trip (nobody is added), and the claimed person can never become an administrator that way', async () => {
    const trip = await makeTrip(asha, 'ClaimFull');
    for (let i = 2; i <= 50; i++) await addGuest(asha, trip, `Guest ${i}`);
    const g = byName(await members(trip), 'Guest 7').id;
    const r = (await request(nina, (await makeInvite(asha, trip, { claim: g })).token)).rows[0]!;
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok');
    expect(active(await members(trip))).toHaveLength(50);
    expect(byUser(await members(trip), nina)).toMatchObject({ id: g, role: 'member' });
    expect(await outcome(q(asha, 'select * from public.leave_trip($1)', [trip]))).toBe('last_admin'); // the administrator rule is untouched
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the reusable link and its encrypted secret (Supabase Vault)', () => {
  const secretsFor = async (inviteId: string) => {
    await users.asAdmin();
    return (await db.query<{ id: string; name: string; secret: string }>(`select id, name, secret from vault.secrets where name = $1`, [`trip-invite-${inviteId}`])).rows;
  };
  const allInviteSecrets = async () => {
    await users.asAdmin();
    return (await db.query<{ name: string }>(`select name from vault.secrets where name like 'trip-invite-%'`)).rows;
  };

  it('the general link is kept encrypted in the Vault under a name that carries no secret; the invitation row holds only the secret\'s id and the hash', async () => {
    const trip = await makeTrip(asha, 'VaultStore');
    const inv = await makeInvite(asha, trip);
    const secrets = await secretsFor(inv.invite_id);
    expect(secrets).toHaveLength(1);
    const row = await inviteRow(inv.invite_id);
    expect(row.token_secret_id).toBe(secrets[0]!.id);
    expect(JSON.stringify(row)).not.toContain(inv.token); // the invitation row never holds the token
    expect(secrets[0]!.name).not.toContain(inv.token);
    expect(secrets[0]!.secret).not.toBe(inv.token); // (the local stand-in only encodes it; real encryption is checked live)
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); // validation still uses the hash, unchanged
  });

  it('a friend\'s link is show-once and hash-only: no secret is made for it, and the database refuses to attach one', async () => {
    const trip = await makeTrip(asha, 'VaultClaim');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    await makeInvite(asha, trip);
    const claim = await makeInvite(asha, trip, { claim: gita });
    expect(await secretsFor(claim.invite_id)).toEqual([]);
    expect((await inviteRow(claim.invite_id)).token_secret_id).toBeNull();
    expect((await getLink(asha, trip)).rows[0]!.token).not.toBe(claim.token); // Copy link only ever returns the general link
    await users.asAdmin();
    await expect(db.query(`update public.trip_invites set token_secret_id = gen_random_uuid() where id = $1`, [claim.invite_id])).rejects.toThrow(/trip_invites_claim_hash_only/);
  });

  it('copying again and again returns EXACTLY the same link, the one that was created, and it works', async () => {
    const trip = await makeTrip(asha, 'VaultRepeat');
    const inv = await makeInvite(asha, trip);
    for (let i = 0; i < 6; i++) {
      const row = (await getLink(asha, trip)).rows[0]!;
      expect(row.token, `copy ${i}`).toBe(inv.token);
      expect(new Date(row.expires_at).getTime()).toBe(new Date(inv.expires_at).getTime());
    }
    expect((await preview(null, inv.token)).rows).toHaveLength(1);
    expect(await outcome(request(nina, inv.token))).toBe('ok');
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(inv.token); // asking does not change it
    expect(await allInviteSecrets().then((r) => r.filter((x) => x.name === `trip-invite-${inv.invite_id}`))).toHaveLength(1); // and no extra secret was made
  });

  it('two administrators get the same link', async () => {
    const trip = await makeTrip(asha, 'VaultTwoAdmins');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const inv = await makeInvite(asha, trip);
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(inv.token);
    expect((await getLink(ravi, trip)).rows[0]!.token).toBe(inv.token);
  });

  it('only an active administrator of the trip can get it: members, strangers, removed, departed, pending and signed-out callers cannot, and learn nothing', async () => {
    const trip = await makeTrip(asha, 'VaultWho');
    await put(trip, ravi, 'Ravi Kumar');
    await put(trip, dev, 'Departed Dev', { status: 'left' });
    await put(trip, sam, 'Removed Sam', { status: 'removed' });
    const inv = await makeInvite(asha, trip);
    await request(nina, inv.token); // a pending requester
    expect(await outcome(getLink(ravi, trip))).toBe('not_admin');
    for (const who of [dev, sam, nina, meera]) expect(await outcome(getLink(who, trip)), who).toBe('trip_not_found');
    expect(await outcome(getLink(meera, NOBODY))).toBe('trip_not_found'); // an unknown trip: the same answer
    expect(await outcome(getLink(null, trip))).toBe('permission denied');
    for (const who of [ravi, dev, sam, nina, meera]) expect(await errorText(getLink(who, trip)), who).not.toContain(inv.token);
    // another trip's administrator cannot read this trip's link even by asking about their own trip
    const other = await makeTrip(meera, 'VaultOther');
    expect((await getLink(meera, other)).rows).toEqual([]);
  });

  it('revoking invalidates the link AND deletes its Vault secret; nobody can read it afterwards', async () => {
    const trip = await makeTrip(asha, 'VaultRevoke');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const inv = await makeInvite(asha, trip);
    expect(await secretsFor(inv.invite_id)).toHaveLength(1);
    await revoke(ravi, trip, inv.invite_id);
    expect(await secretsFor(inv.invite_id)).toEqual([]);
    expect((await inviteRow(inv.invite_id)).token_secret_id).toBeNull();
    expect((await getLink(asha, trip)).rows).toEqual([]);
    expect((await getLink(ravi, trip)).rows).toEqual([]);
    expect((await preview(null, inv.token)).rows).toEqual([]);
    expect(await outcome(request(nina, inv.token))).toBe('invite_invalid');
    expect((await revoke(asha, trip, inv.invite_id)).rows[0]!.changed).toBe(false); // safe to repeat
    expect(await secretsFor(inv.invite_id)).toEqual([]);
  });

  it('an expired link cannot be retrieved or used for new requests; making a new link clears the old secret away', async () => {
    const trip = await makeTrip(asha, 'VaultExpire');
    const inv = await makeInvite(asha, trip);
    await expire(inv.invite_id);
    expect((await getLink(asha, trip)).rows).toEqual([]);
    expect((await preview(null, inv.token)).rows).toEqual([]);
    expect(await outcome(request(nina, inv.token))).toBe('invite_invalid');
    const fresh = await makeInvite(asha, trip);
    expect(await secretsFor(inv.invite_id)).toEqual([]); // the expired link's secret is gone
    expect(await secretsFor(fresh.invite_id)).toHaveLength(1);
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(fresh.token);
    expect(fresh.token).not.toBe(inv.token);
  });

  it('a requester who asked before the link was revoked or expired is untouched, and an admin can still approve them', async () => {
    const trip = await makeTrip(asha, 'VaultRequestsSurvive');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await revoke(asha, trip, inv.invite_id);
    expect((await requestRow(r.request_id!)).status).toBe('pending');
    expect(await outcome(decide(asha, trip, r.request_id!, true))).toBe('ok');
    expect(byUser(await members(trip), nina)!.status).toBe('active');
  });

  it('an archived trip returns nothing (the link is not usable there) and works again when restored', async () => {
    const trip = await makeTrip(asha, 'VaultArchived');
    const inv = await makeInvite(asha, trip);
    await archive(trip);
    expect((await getLink(asha, trip)).rows).toEqual([]);
    await archive(trip, false);
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(inv.token);
  });

  it('a link made before this update (no stored secret) cannot be copied, still works, can be revoked, and a new one is then copyable', async () => {
    const trip = await makeTrip(asha, 'VaultLegacy');
    const inv = await makeInvite(asha, trip);
    await users.asAdmin();
    await db.query(`delete from vault.secrets where name = $1`, [`trip-invite-${inv.invite_id}`]);
    await db.query(`update public.trip_invites set token_secret_id = null where id = $1`, [inv.invite_id]);
    expect((await list(asha, trip)).rows.find((r) => r.invite_id === inv.invite_id)).toMatchObject({ status: 'active', copyable: false });
    expect((await getLink(asha, trip)).rows).toEqual([]);
    expect((await preview(null, inv.token)).rows).toHaveLength(1);
    expect(await outcome(request(nina, inv.token))).toBe('ok');
    expect(await outcome(create(asha, trip))).toBe('invite_exists'); // it is still the live link
    await revoke(asha, trip, inv.invite_id);
    const fresh = await makeInvite(asha, trip);
    expect((await list(asha, trip)).rows.find((r) => r.invite_id === fresh.invite_id)).toMatchObject({ copyable: true });
    expect((await getLink(asha, trip)).rows[0]!.token).toBe(fresh.token);
  });

  it('the list says which links can be copied: the live general link only', async () => {
    const trip = await makeTrip(asha, 'VaultCopyable');
    const gita = (await addGuest(asha, trip, 'Gita')).rows[0]!.member_id;
    const old = await makeInvite(asha, trip);
    await revoke(asha, trip, old.invite_id);
    const general = await makeInvite(asha, trip);
    const claim = await makeInvite(asha, trip, { claim: gita });
    const rows = (await list(asha, trip)).rows;
    expect(rows.find((r) => r.invite_id === general.invite_id)!.copyable).toBe(true);
    expect(rows.find((r) => r.invite_id === claim.invite_id)!.copyable).toBe(false);
    expect(rows.find((r) => r.invite_id === old.invite_id)!.copyable).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(general.token);
  });

  it('even if a secret were somehow left attached to a revoked link, nothing is returned (defence in depth)', async () => {
    const trip = await makeTrip(asha, 'VaultRevokedKept');
    const inv = await makeInvite(asha, trip);
    await users.asAdmin();
    await db.query(`update public.trip_invites set revoked_at = now() where id = $1`, [inv.invite_id]); // revoked WITHOUT the function: the secret is still there
    expect(await secretsFor(inv.invite_id)).toHaveLength(1);
    expect((await getLink(asha, trip)).rows).toEqual([]);
    await users.asAdmin(); // tidy up: this row was made inconsistent on purpose
    await db.query(`delete from vault.secrets where name = $1`, [`trip-invite-${inv.invite_id}`]);
    await db.query(`update public.trip_invites set token_secret_id = null where id = $1`, [inv.invite_id]);
  });

  it('a damaged or swapped secret yields nothing (it must match the link\'s hash)', async () => {
    const trip = await makeTrip(asha, 'VaultSwap');
    const inv = await makeInvite(asha, trip);
    await users.asAdmin();
    const other = (await db.query<{ id: string }>(`select vault.create_secret($1, 'unrelated-secret') as id`, ['f'.repeat(64)])).rows[0]!.id;
    await db.query(`update public.trip_invites set token_secret_id = $2 where id = $1`, [inv.invite_id, other]);
    expect((await getLink(asha, trip)).rows).toEqual([]);
  });

  it('removing a whole trip removes its secrets too (nothing is left behind in the Vault)', async () => {
    const trip = await makeTrip(asha, 'VaultCascade');
    const inv = await makeInvite(asha, trip);
    expect(await secretsFor(inv.invite_id)).toHaveLength(1);
    await users.asAdmin();
    await db.query('delete from public.trips where id = $1', [trip]);
    expect(await secretsFor(inv.invite_id)).toEqual([]);
  });

  it('there is never more than one secret per trip, and none for a trip without a live general link', async () => {
    const trip = await makeTrip(asha, 'VaultCount');
    const names = async () => (await allInviteSecrets()).map((r) => r.name);
    const a = await makeInvite(asha, trip);
    await create(asha, trip).catch(() => undefined);
    expect((await names()).filter((n) => n === `trip-invite-${a.invite_id}`)).toHaveLength(1);
    await revoke(asha, trip, a.invite_id);
    expect(await names()).not.toContain(`trip-invite-${a.invite_id}`);
    await users.asAdmin();
    const live = (await db.query<{ n: number }>(`select count(*)::int as n from public.trip_invites where token_secret_id is not null and (revoked_at is not null)`)).rows[0]!.n;
    expect(live).toBe(0); // a revoked link never keeps a secret
  });

  it('the Vault is closed to the app: signed-in and signed-out callers cannot read or write it directly', async () => {
    for (const who of [asha, null]) {
      expect(await outcome(q(who, 'select * from vault.decrypted_secrets')), String(who)).toBe('permission denied');
      expect(await outcome(q(who, 'select * from vault.secrets')), String(who)).toBe('permission denied');
      expect(await outcome(q(who, `select vault.create_secret('x')`)), String(who)).toBe('permission denied');
    }
  });

  it('no function that touches the Vault can log: nothing is ever written to a log or an error', async () => {
    await users.asAdmin();
    for (const fn of ['create_invite', 'get_general_invite_link', 'revoke_invite', 'trip_invites_remove_secret']) {
      const src = (await db.query<{ prosrc: string }>(`select prosrc from pg_proc where proname = $1`, [fn])).rows[0]!.prosrc;
      expect(src, fn).not.toMatch(/raise\s+(notice|warning|info|log|debug)/i);
      expect(src, fn).not.toMatch(/raise exception[^;]*(v_token|decrypted|token)/i); // an error never carries a token
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('earlier features are unaffected', () => {
  it('the audit trail still only accepts the known actions, and cannot be edited', async () => {
    const trip = await makeTrip(asha, 'AuditStill');
    await decide(asha, trip, (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!.request_id!, true);
    await users.asAdmin();
    await expect(db.query(`update public.trip_member_events set action = 'left'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action) select trip_id, actor_member_id, target_member_id, 'hacked' from public.trip_member_events limit 1`))
      .rejects.toThrow(/trip_member_events_action_values/);
  });

  it('requests and approvals never change the trip itself (version and details are untouched)', async () => {
    const trip = await makeTrip(asha, 'TripUntouched');
    await users.asAdmin();
    const before = (await db.query('select version, name, status from public.trips where id = $1', [trip])).rows[0];
    await decide(asha, trip, (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!.request_id!, true);
    await users.asAdmin();
    expect((await db.query('select version, name, status from public.trips where id = $1', [trip])).rows[0]).toEqual(before);
  });

  it('removing a whole trip cleans up its links and requests too', async () => {
    const trip = await makeTrip(asha, 'Cascade');
    const inv = await makeInvite(asha, trip);
    const r = (await request(nina, inv.token)).rows[0]!;
    await users.asAdmin();
    await db.query('delete from public.trips where id = $1', [trip]);
    expect((await db.query('select 1 from public.trip_invites where id = $1', [inv.invite_id])).rows).toEqual([]);
    expect((await db.query('select 1 from public.trip_join_requests where id = $1', [r.request_id])).rows).toEqual([]);
  });

  it('the database refuses an inconsistent request record, whoever writes it', async () => {
    const trip = await makeTrip(asha, 'Constraint');
    const r = (await request(nina, (await makeInvite(asha, trip)).token)).rows[0]!;
    await users.asAdmin();
    await expect(db.query(`update public.trip_join_requests set status = 'approved' where id = $1`, [r.request_id])).rejects.toThrow(/trip_join_requests_decided_consistently/);
    await expect(db.query(`update public.trip_join_requests set status = 'weird' where id = $1`, [r.request_id])).rejects.toThrow(/trip_join_requests_(status_values|decided_consistently)/);
    await expect(db.query(`insert into public.trip_join_requests (trip_id, invite_id, user_id, requester_name) select trip_id, invite_id, user_id, 'dup' from public.trip_join_requests where id = $1`, [r.request_id])).rejects.toThrow(/duplicate key|trip_join_requests_one/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('random sequences follow an independent model', () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  interface Link {
    token: string;
    id: string;
    revoked: boolean;
    expired: boolean;
  }
  interface Req {
    id: string;
    user: string;
    link: Link;
    status: 'pending' | 'approved' | 'rejected';
  }

  it('random create / revoke / expire / request / approve / reject / leave actions behave exactly as the rules say', async () => {
    const actors = [ravi, nina, sam, dev];
    let steps = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed * 104729);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const trip = await makeTrip(asha, `RequestModel ${seed}`);
      const onTrip = new Set<string>([asha]);
      const links: Link[] = [];
      const reqs: Req[] = [];
      const usable = (l: Link) => !l.revoked && !l.expired;

      for (let step = 0; step < 40; step++) {
        const kind = pick(['create', 'request', 'request', 'request', 'approve', 'approve', 'reject', 'revoke', 'expire', 'leave']);
        let want: string;
        let got: string;
        const actor = pick(actors);
        if (kind === 'create') {
          let made: Created | undefined;
          got = await outcome(create(asha, trip).then((r) => { made = r.rows[0]; }));
          want = links.some(usable) ? 'invite_exists' : 'ok';
          if (got === 'ok') {
            for (const l of links) if (!l.revoked) l.revoked = true;
            links.push({ token: made!.token, id: made!.invite_id, revoked: false, expired: false });
          }
        } else if (kind === 'request' && links.length) {
          const link = pick(links);
          const mine = reqs.filter((r) => r.user === actor);
          const sameLink = mine.find((r) => r.link === link);
          const anyPending = mine.find((r) => r.status === 'pending');
          want = !usable(link) ? 'invite_invalid' : onTrip.has(actor) ? 'ok' : sameLink && sameLink.status !== 'pending' ? 'request_used' : 'ok';
          let row: Requested | undefined;
          got = await outcome(request(actor, link.token).then((r) => { row = r.rows[0]; }));
          if (got === 'ok' && !onTrip.has(actor)) {
            if (sameLink) expect(row!.request_id).toBe(sameLink.id);
            else if (anyPending) expect(row!.request_id).toBe(anyPending.id);
            else reqs.push({ id: row!.request_id!, user: actor, link, status: 'pending' });
            expect(row!.outcome).toBe(sameLink || anyPending ? 'already_requested' : 'requested');
          } else if (got === 'ok') expect(row!.outcome).toBe('already_member');
        } else if ((kind === 'approve' || kind === 'reject') && reqs.length) {
          const r = pick(reqs);
          want = 'ok';
          let row: Decided | undefined;
          got = await outcome(decide(asha, trip, r.id, kind === 'approve').then((x) => { row = x.rows[0]; }));
          if (got === 'ok') {
            if (r.status !== 'pending') expect(row!.outcome).toBe('already_decided');
            else if (kind === 'approve') {
              r.status = 'approved';
              onTrip.add(r.user);
            } else r.status = 'rejected';
          }
        } else if (kind === 'revoke' && links.length) {
          const link = pick(links);
          want = 'ok';
          got = await outcome(revoke(asha, trip, link.id));
          if (got === 'ok') link.revoked = true;
        } else if (kind === 'expire' && links.length) {
          const link = pick(links);
          await expire(link.id);
          link.expired = true;
          continue;
        } else if (kind === 'leave') {
          want = !onTrip.has(actor) ? 'trip_not_found' : 'ok';
          got = await outcome(q(actor, 'select * from public.leave_trip($1)', [trip]));
          if (got === 'ok') onTrip.delete(actor);
        } else continue;
        expect(got, `seed ${seed} step ${step}: ${kind} by ${actor.slice(0, 4)}`).toBe(want);
        steps++;

        // invariants, from the database itself
        const ms = await members(trip);
        expect(new Set(active(ms).map((m) => m.user_id)), 'who is on the trip').toEqual(onTrip);
        expect(ms.filter((m) => m.user_id !== null).length, 'one row per person').toBe(new Set(ms.map((m) => m.user_id).filter(Boolean)).size);
        expect(ms.some((m) => m.status === 'active' && m.role === 'admin' && m.user_id !== null), 'always an administrator').toBe(true);
        await users.asAdmin();
        const rows = (await db.query<{ id: string; user_id: string; status: string }>('select id, user_id, status from public.trip_join_requests where trip_id = $1', [trip])).rows;
        expect(rows.length, 'every request is recorded once').toBe(reqs.length);
        for (const r of reqs) expect(rows.find((x) => x.id === r.id)!.status, 'request state').toBe(r.status);
        expect(new Set(rows.filter((r) => r.status === 'pending').map((r) => r.user_id)).size, 'one pending request per person').toBe(rows.filter((r) => r.status === 'pending').length);
        for (const r of rows.filter((x) => x.status === 'pending')) expect(onTrip.has(r.user_id), 'a pending person is not on the trip').toBe(false);
      }
    }
    expect(steps).toBeGreaterThan(500);
  }, 300_000);
});
