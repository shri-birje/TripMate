import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestUsers, newDatabase } from './harness';

/**
 * M3.4 step (b): members and roles, tested against the real Postgres engine with the project's real
 * migrations. Every rule is checked as each kind of caller (admin, ordinary member, guest row, stranger,
 * removed, left, signed out), plus the invariants that must hold after ANY sequence of actions.
 *
 * What this engine cannot do is run two callers truly at the same moment. Concurrency is therefore covered
 * three ways: stale-screen simulations (the second caller acts on what the first already changed), the
 * deferred "always an administrator" trigger tested directly, and source checks that every write takes the
 * trip's row lock. Real interleaving is covered by the lock itself, which Postgres guarantees.
 */
let db: PGlite;
let users: TestUsers;

const TOKENS = [
  'not_authenticated', 'trip_not_found', 'not_admin', 'trip_archived', 'member_not_found', 'member_changed', 'last_admin',
  'guest_cannot_be_admin', 'name_taken', 'trip_full', 'invalid_request', 'use_leave_instead', 'cannot_rename',
];

/** What a call did: "ok", one of our error words, or the database's own wording (e.g. "permission denied"). */
async function outcome(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    return TOKENS.find((t) => text.includes(t)) ?? (/permission denied/i.test(text) ? 'permission denied' : text);
  }
}

interface Fn {
  member_id: string;
  changed: boolean;
}
const sqlCall = (fn: string, n: number) => `select * from public.${fn}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')})`;
const run = async (who: string | null, fn: string, args: unknown[]) => {
  if (who === null) await users.asAnon();
  else await users.asUser(who);
  return db.query<Fn>(sqlCall(fn, args.length), args);
};
const add = (who: string, trip: string, name: unknown) => run(who, 'add_guest_member', [trip, name]);
const rename = (who: string, trip: string, member: string, name: unknown) => run(who, 'rename_guest_member', [trip, member, name]);
const role = (who: string, trip: string, member: string, to: string, expected: string) => run(who, 'set_member_role', [trip, member, to, expected]);
const remove = (who: string, trip: string, member: string) => run(who, 'remove_member', [trip, member]);
const leave = (who: string, trip: string) => run(who, 'leave_trip', [trip]);

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
const active = (ms: Member[]) => ms.filter((m) => m.status === 'active');

async function events(trip: string) {
  await users.asAdmin();
  return (await db.query<{ action: string; actor_member_id: string; target_member_id: string; old_value: string | null; new_value: string | null }>(
    'select action, actor_member_id, target_member_id, old_value, new_value from public.trip_member_events where trip_id = $1 order by seq',
    [trip],
  )).rows;
}

async function makeTrip(creator: string, name: string): Promise<string> {
  await users.asUser(creator);
  return (await db.query<{ id: string }>(`select id from public.create_trip($1, 'Somewhere', '2026-12-27', '2026-12-30')`, [name])).rows[0]!.id;
}

/** Puts a person on a trip directly (until invitations exist, M3.5). */
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

let asha: string; // administrator and creator of most trips
let ravi: string;
let nina: string;
let sam: string; // never on any trip
let meera: string; // administrator of her own, separate trip

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  nina = await users.signUp('nina@example.com', 'Nina Shah');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
});
afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------------------------------
describe('who can run what', () => {
  const six = [
    ['list_trip_members', 1], ['add_guest_member', 2], ['rename_guest_member', 3], ['set_member_role', 4], ['remove_member', 2], ['leave_trip', 1],
  ] as const;

  it('signed-out visitors are refused outright, for all six functions', async () => {
    const trip = await makeTrip(asha, 'Anon');
    for (const [fn, n] of six) {
      const args = [trip, trip, trip, 'member'].slice(0, n);
      expect(await outcome(run(null, fn, args)), fn).toBe('permission denied');
    }
  });

  it('signed-in users can run exactly the reviewed functions (the six member ones plus the later invitation ones), and the helpers and triggers stay closed', async () => {
    await users.asAdmin();
    const callable = (await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`,
    )).rows.map((r) => r.proname);
    expect(callable).toEqual(['add_guest_member', 'create_expense', 'create_invite', 'create_trip', 'decide_join_request', 'delete_expense', 'get_general_invite_link', 'is_trip_member', 'leave_trip', 'list_join_requests', 'list_trip_invites', 'list_trip_members', 'preview_invite', 'remove_member', 'rename_guest_member', 'request_to_join', 'restore_expense', 'revoke_invite', 'set_member_role', 'set_trip_archived', 'trip_member_balances', 'update_expense', 'update_trip']);
    for (const closed of ['member_change_context', 'check_trip_has_admin', 'trip_member_events_append_only', 'trip_role_of', 'bump_trip_version']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE') as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
        [closed],
      );
      expect(r.rows[0]!.ok, closed).toBe(false);
    }
  });

  it('no function takes a user id from the caller: identity comes only from the login', async () => {
    await users.asAdmin();
    const r = await db.query<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)`,
      [six.map(([f]) => f)],
    );
    expect(r.rows).toHaveLength(6);
    for (const f of r.rows) expect(f.args, f.proname).not.toMatch(/user_id|\buid\b|actor/i);
  });

  it('every write takes the trip\'s row lock first, and takes it only after strangers have been refused', async () => {
    await users.asAdmin();
    const ctx = (await db.query<{ prosrc: string }>(`select prosrc from pg_proc where proname = 'member_change_context'`)).rows[0]!.prosrc;
    const lock = ctx.search(/from public\.trips t where t\.id = p_trip_id for update/);
    const firstRefusal = ctx.search(/raise exception 'trip_not_found'/);
    expect(lock).toBeGreaterThan(-1);
    expect(firstRefusal).toBeGreaterThan(-1);
    expect(firstRefusal).toBeLessThan(lock); // strangers never reach the lock
    expect(ctx.indexOf('trip_not_found', lock)).toBeGreaterThan(-1); // membership is re-checked under the lock
    for (const fn of ['add_guest_member', 'rename_guest_member', 'set_member_role', 'remove_member', 'leave_trip']) {
      const src = (await db.query<{ prosrc: string }>(`select prosrc from pg_proc where proname = $1`, [fn])).rows[0]!.prosrc;
      expect(src, fn).toMatch(/public\.member_change_context\(/);
      expect(src, fn).toMatch(/auth\.uid\(\)/);
      expect(src, fn).not.toMatch(/\bdelete\s+from\b/i); // nothing is ever deleted
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('list_trip_members: the least data needed', () => {
  let trip: string;
  let raviId: string;
  let goneId: string;
  let guestGoneId: string;
  beforeAll(async () => {
    trip = await makeTrip(asha, 'List');
    raviId = await put(trip, ravi, 'Ravi Kumar');
    await put(trip, null, 'Gita');
    goneId = await put(trip, nina, 'Nina Shah', { role: 'admin', status: 'removed' });
    guestGoneId = await put(trip, null, 'Gopal', { status: 'left' });
  });

  it('a member sees current people with user id and role, and former people with neither', async () => {
    const rows = (await run(ravi, 'list_trip_members', [trip])).rows as unknown as Record<string, unknown>[];
    expect(rows.map((r) => `${r.display_name}:${r.status}`).sort()).toEqual(['Asha Rao:active', 'Gita:active', 'Gopal:left', 'Nina Shah:removed', 'Ravi Kumar:active']);
    for (const r of rows) {
      if (r.status === 'active') expect(r.role).not.toBeNull();
      else {
        expect(r.user_id, String(r.display_name)).toBeNull();
        expect(r.role, String(r.display_name)).toBeNull();
        expect(r.left_at).not.toBeNull();
      }
    }
    expect(rows.find((r) => r.member_id === goneId)!.is_guest).toBe(false); // knows she had an account without revealing which
    expect(rows.find((r) => r.member_id === guestGoneId)!.is_guest).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(nina); // the removed person's user id is nowhere in the answer
  });

  it('an administrator and an ordinary member see the same list', async () => {
    const a = (await run(asha, 'list_trip_members', [trip])).rows.map((r) => (r as unknown as { member_id: string }).member_id);
    const b = (await run(ravi, 'list_trip_members', [trip])).rows.map((r) => (r as unknown as { member_id: string }).member_id);
    expect(a).toEqual(b);
    expect(a).toContain(raviId);
  });

  it('strangers, other trips\' members, removed and departed people get nothing, exactly like an unknown trip', async () => {
    const other = await makeTrip(meera, 'Other');
    for (const who of [sam, meera, nina]) expect((await run(who, 'list_trip_members', [trip])).rows, who).toEqual([]);
    expect((await run(sam, 'list_trip_members', ['00000000-0000-4000-8000-000000000000'])).rows).toEqual([]);
    expect((await run(asha, 'list_trip_members', [other])).rows).toEqual([]);
  });

  it('is read-only: it changes nothing', async () => {
    const before = JSON.stringify(await members(trip));
    await run(asha, 'list_trip_members', [trip]);
    expect(JSON.stringify(await members(trip))).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('add_guest_member', () => {
  it('an administrator adds a guest: a name-only, ordinary member, with who added them, and one audit record', async () => {
    const trip = await makeTrip(asha, 'Add');
    const r = (await add(asha, trip, '  Gita  ')).rows[0]!;
    expect(r.changed).toBe(true);
    const ms = await members(trip);
    const g = byName(ms, 'Gita');
    expect(g).toMatchObject({ id: r.member_id, user_id: null, role: 'member', status: 'active', left_at: null, invited_by: byName(ms, 'Asha Rao').id });
    expect(await events(trip)).toEqual([{ action: 'guest_added', actor_member_id: byName(ms, 'Asha Rao').id, target_member_id: g.id, old_value: null, new_value: 'Gita' }]);
  });

  it('an ordinary member, a stranger, a removed member and a person who left are all refused (and learn nothing)', async () => {
    const trip = await makeTrip(asha, 'AddDeny');
    await put(trip, ravi, 'Ravi Kumar');
    await put(trip, nina, 'Nina Shah', { status: 'removed' });
    expect(await outcome(add(ravi, trip, 'X'))).toBe('not_admin');
    expect(await outcome(add(sam, trip, 'X'))).toBe('trip_not_found');
    expect(await outcome(add(nina, trip, 'X'))).toBe('trip_not_found');
    expect(await outcome(add(sam, '00000000-0000-4000-8000-000000000000', 'X'))).toBe('trip_not_found'); // unknown trip: same answer
    expect(await outcome(add(meera, trip, 'X'))).toBe('trip_not_found');
    expect(await events(trip)).toEqual([]);
    expect(active(await members(trip))).toHaveLength(2);
  });

  it('an archived trip is read-only', async () => {
    const trip = await makeTrip(asha, 'AddArch');
    await archive(trip);
    expect(await outcome(add(asha, trip, 'Gita'))).toBe('trip_archived');
    await archive(trip, false);
    expect(await outcome(add(asha, trip, 'Gita'))).toBe('ok');
  });

  it('refuses empty, blank, too long and missing names, and trims the rest', async () => {
    const trip = await makeTrip(asha, 'AddNames');
    for (const bad of ['', '   ', '\t\n', '\u00a0 \r\n', 'x'.repeat(61), null]) expect(await outcome(add(asha, trip, bad)), JSON.stringify(bad)).toBe('invalid_request');
    expect(await outcome(add(asha, trip, 'y'.repeat(60)))).toBe('ok');
    expect(await outcome(add(asha, trip, '\t Hari \n'))).toBe('ok'); // all surrounding whitespace is trimmed
    expect(byName(await members(trip), 'Hari')).toBeTruthy();
  });

  it('names are unique among ACTIVE people, ignoring case and surrounding spaces (including real members)', async () => {
    const trip = await makeTrip(asha, 'AddDup');
    await add(asha, trip, 'Gita');
    for (const dup of ['Gita', 'gita', '  GITA ', 'gItA', 'asha rao', 'ASHA RAO']) expect(await outcome(add(asha, trip, dup)), dup).toBe('name_taken');
    expect(await outcome(add(asha, trip, 'Gita 2'))).toBe('ok'); // different name
  });

  it('a name frees up once its owner is gone', async () => {
    const trip = await makeTrip(asha, 'AddFree');
    const gita = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    expect(await outcome(add(asha, trip, 'gita'))).toBe('name_taken');
    await remove(asha, trip, gita);
    expect(await outcome(add(asha, trip, 'Gita'))).toBe('ok');
    expect(active(await members(trip)).filter((m) => m.display_name === 'Gita')).toHaveLength(1);
  });

  it('allows at most 50 active people; one leaving makes room', async () => {
    const trip = await makeTrip(asha, 'Full');
    for (let i = 2; i <= 50; i++) expect(await outcome(add(asha, trip, `Guest ${i}`))).toBe('ok');
    expect(active(await members(trip))).toHaveLength(50);
    expect(await outcome(add(asha, trip, 'Guest 51'))).toBe('trip_full');
    const first = byName(await members(trip), 'Guest 2').id;
    await remove(asha, trip, first);
    expect(await outcome(add(asha, trip, 'Guest 51'))).toBe('ok');
    expect(await outcome(add(asha, trip, 'Guest 52'))).toBe('trip_full');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('rename_guest_member', () => {
  let trip: string;
  let gita: string;
  let raviId: string;
  beforeAll(async () => {
    trip = await makeTrip(asha, 'Rename');
    raviId = await put(trip, ravi, 'Ravi Kumar');
    gita = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    await add(asha, trip, 'Hari');
  });

  it('an administrator renames a guest; the old and new names are recorded', async () => {
    const r = (await rename(asha, trip, gita, '  Geeta  ')).rows[0]!;
    expect(r).toMatchObject({ member_id: gita, changed: true });
    expect(byName(await members(trip), 'Geeta').id).toBe(gita);
    const last = (await events(trip)).at(-1)!;
    expect(last).toMatchObject({ action: 'guest_renamed', old_value: 'Gita', new_value: 'Geeta', target_member_id: gita });
  });

  it('renaming to the same name is a safe repeat: nothing changes and nothing is recorded', async () => {
    const before = (await events(trip)).length;
    expect((await rename(asha, trip, gita, 'Geeta')).rows[0]).toMatchObject({ changed: false });
    expect((await events(trip)).length).toBe(before);
  });

  it('only a change of letter case on the same guest is allowed (it is not a duplicate of itself)', async () => {
    expect(await outcome(rename(asha, trip, gita, 'GEETA'))).toBe('ok');
    expect(byName(await members(trip), 'GEETA').id).toBe(gita);
  });

  it('refuses a name another active person already has, and invalid names', async () => {
    expect(await outcome(rename(asha, trip, gita, 'hari'))).toBe('name_taken');
    expect(await outcome(rename(asha, trip, gita, 'ravi kumar'))).toBe('name_taken');
    for (const bad of ['', '  ', '\t\n', 'z'.repeat(61), null]) expect(await outcome(rename(asha, trip, gita, bad)), JSON.stringify(bad)).toBe('invalid_request');
  });

  it('people with an account cannot be renamed by anyone', async () => {
    expect(await outcome(rename(asha, trip, raviId, 'Ravi 2'))).toBe('cannot_rename');
    expect(await outcome(rename(ravi, trip, raviId, 'Ravi 2'))).toBe('not_admin');
  });

  it('refuses ordinary members, strangers, other trips\' people, former guests and archived trips', async () => {
    expect(await outcome(rename(ravi, trip, gita, 'X'))).toBe('not_admin');
    expect(await outcome(rename(sam, trip, gita, 'X'))).toBe('trip_not_found');
    const otherTrip = await makeTrip(meera, 'RenameOther');
    const strangerGuest = (await add(meera, otherTrip, 'Meera Guest')).rows[0]!.member_id;
    expect(await outcome(rename(asha, trip, strangerGuest, 'X'))).toBe('member_not_found'); // another trip's member id
    const gone = (await add(asha, trip, 'Gone')).rows[0]!.member_id;
    await remove(asha, trip, gone);
    expect(await outcome(rename(asha, trip, gone, 'Back'))).toBe('member_not_found');
    expect(await outcome(rename(asha, trip, '00000000-0000-4000-8000-000000000000', 'X'))).toBe('member_not_found');
    await archive(trip);
    expect(await outcome(rename(asha, trip, gita, 'Later'))).toBe('trip_archived');
    await archive(trip, false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('set_member_role', () => {
  let trip: string;
  let raviId: string;
  let ninaId: string;
  let ashaId: string;
  let guestId: string;
  beforeAll(async () => {
    trip = await makeTrip(asha, 'Roles');
    raviId = await put(trip, ravi, 'Ravi Kumar');
    ninaId = await put(trip, nina, 'Nina Shah');
    ashaId = byName(await members(trip), 'Asha Rao').id;
    guestId = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
  });

  it('an administrator makes a member an administrator, recorded as made_admin', async () => {
    expect((await role(asha, trip, raviId, 'admin', 'member')).rows[0]).toMatchObject({ member_id: raviId, changed: true });
    expect(byName(await members(trip), 'Ravi Kumar').role).toBe('admin');
    expect((await events(trip)).at(-1)).toMatchObject({ action: 'made_admin', actor_member_id: ashaId, target_member_id: raviId, old_value: 'member', new_value: 'admin' });
  });

  it('admins are equal peers: the new administrator can demote the creator (recorded as removed_admin) and back', async () => {
    expect((await role(ravi, trip, ashaId, 'member', 'admin')).rows[0]!.changed).toBe(true);
    expect((await events(trip)).at(-1)).toMatchObject({ action: 'removed_admin', actor_member_id: byName(await members(trip), 'Ravi Kumar').id, target_member_id: ashaId });
    expect(await outcome(role(asha, trip, raviId, 'member', 'admin'))).toBe('not_admin'); // asha is now an ordinary member
    expect((await role(ravi, trip, ashaId, 'admin', 'member')).rows[0]!.changed).toBe(true);
  });

  it('asking for the role someone already has is a safe repeat: nothing changes, nothing is recorded', async () => {
    const before = (await events(trip)).length;
    expect((await role(asha, trip, raviId, 'admin', 'member')).rows[0]!.changed).toBe(false); // already an admin
    expect((await role(asha, trip, ninaId, 'member', 'member')).rows[0]!.changed).toBe(false);
    expect((await events(trip)).length).toBe(before);
  });

  it('a stale screen cannot overwrite a newer change (member_changed)', async () => {
    // The screen saw Nina as an admin, but she is a member: demoting her as "admin -> member" is already true, promoting on a wrong belief is refused.
    expect(await outcome(role(asha, trip, ninaId, 'admin', 'admin'))).toBe('member_changed');
    expect(byName(await members(trip), 'Nina Shah').role).toBe('member');
  });

  it('a guest can never be an administrator', async () => {
    expect(await outcome(role(asha, trip, guestId, 'admin', 'member'))).toBe('guest_cannot_be_admin');
    expect(byName(await members(trip), 'Gita').role).toBe('member');
  });

  it('refuses invalid role words, other trips\' people, former people, and non-administrators', async () => {
    for (const [to, expected] of [['owner', 'member'], ['admin', 'owner'], ['', 'member'], ['admin', ''], [null, 'member'], ['admin', null]] as const) {
      expect(await outcome(role(asha, trip, ninaId, to as string, expected as string)), `${to}/${expected}`).toBe('invalid_request');
    }
    const otherTrip = await makeTrip(meera, 'RolesOther');
    const theirGuest = (await add(meera, otherTrip, 'Theirs')).rows[0]!.member_id;
    expect(await outcome(role(asha, trip, theirGuest, 'admin', 'member'))).toBe('member_not_found');
    const gone = await put(trip, null, 'Departed', { status: 'left' });
    expect(await outcome(role(asha, trip, gone, 'admin', 'member'))).toBe('member_not_found');
    expect(await outcome(role(nina, trip, ninaId, 'admin', 'member'))).toBe('not_admin'); // nobody can promote themselves
    expect(await outcome(role(sam, trip, ninaId, 'admin', 'member'))).toBe('trip_not_found');
    expect(byName(await members(trip), 'Nina Shah').role).toBe('member');
  });

  it('the last administrator cannot be demoted, not even by themselves; with another admin an admin may step down', async () => {
    const t = await makeTrip(asha, 'RolesLast');
    const aId = byName(await members(t), 'Asha Rao').id;
    const rId = await put(t, ravi, 'Ravi Kumar');
    expect(await outcome(role(asha, t, aId, 'member', 'admin'))).toBe('last_admin');
    expect(byName(await members(t), 'Asha Rao').role).toBe('admin');
    await role(asha, t, rId, 'admin', 'member');
    expect(await outcome(role(asha, t, aId, 'member', 'admin'))).toBe('ok'); // another admin exists now
    expect(await outcome(role(ravi, t, rId, 'member', 'admin'))).toBe('last_admin'); // ...and Ravi is now the last one
  });

  it('a guest-only remainder cannot count as administrators: demoting the last SIGNED-UP admin is refused even if others exist', async () => {
    const t = await makeTrip(asha, 'RolesGuests');
    await add(asha, t, 'Gita');
    await add(asha, t, 'Hari');
    expect(await outcome(role(asha, t, byName(await members(t), 'Asha Rao').id, 'member', 'admin'))).toBe('last_admin');
  });

  it('an archived trip is read-only', async () => {
    await archive(trip);
    expect(await outcome(role(asha, trip, ninaId, 'admin', 'member'))).toBe('trip_archived');
    await archive(trip, false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('remove_member', () => {
  it('an administrator removes someone: the row is KEPT as "removed" with a date, one audit record, and they lose access', async () => {
    const trip = await makeTrip(asha, 'Remove');
    const raviId = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    const before = byName(await members(trip), 'Ravi Kumar');
    expect((await remove(asha, trip, raviId)).rows[0]).toMatchObject({ member_id: raviId, changed: true });
    const after = byName(await members(trip), 'Ravi Kumar');
    expect(after).toMatchObject({ id: raviId, user_id: ravi, status: 'removed', role: 'admin', joined_at: before.joined_at });
    expect(after.left_at).not.toBeNull();
    expect((await events(trip)).at(-1)).toMatchObject({ action: 'removed', target_member_id: raviId, actor_member_id: byName(await members(trip), 'Asha Rao').id });
    // access is gone: the trip, its members and every function treat them as a stranger
    await users.asUser(ravi);
    expect((await db.query('select id from public.trips where id = $1', [trip])).rows).toEqual([]);
    expect((await db.query('select id from public.trip_members where trip_id = $1', [trip])).rows).toEqual([]);
    expect(await outcome(add(ravi, trip, 'X'))).toBe('trip_not_found');
    expect(await outcome(leave(ravi, trip))).toBe('trip_not_found');
    expect((await run(ravi, 'list_trip_members', [trip])).rows).toEqual([]);
  });

  it('a guest can be removed too', async () => {
    const trip = await makeTrip(asha, 'RemoveGuest');
    const g = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    expect((await remove(asha, trip, g)).rows[0]!.changed).toBe(true);
    expect(byName(await members(trip), 'Gita').status).toBe('removed');
  });

  it('removing someone who is already gone is a safe repeat: nothing changes, nothing is recorded', async () => {
    const trip = await makeTrip(asha, 'RemoveTwice');
    const g = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    await remove(asha, trip, g);
    const left = byName(await members(trip), 'Gita').left_at;
    const n = (await events(trip)).length;
    expect((await remove(asha, trip, g)).rows[0]).toMatchObject({ changed: false });
    expect((await events(trip)).length).toBe(n);
    expect(byName(await members(trip), 'Gita').left_at).toEqual(left); // the date is not overwritten
    const gone = await put(trip, nina, 'Nina Shah', { status: 'left' });
    expect((await remove(asha, trip, gone)).rows[0]!.changed).toBe(false);
    expect(byName(await members(trip), 'Nina Shah').status).toBe('left'); // a person who left is not "removed" afterwards
  });

  it('administrators are peers: one can remove another; nobody can remove themselves (they leave instead)', async () => {
    const trip = await makeTrip(asha, 'RemovePeers');
    const aId = byName(await members(trip), 'Asha Rao').id;
    const rId = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    expect(await outcome(remove(asha, trip, aId))).toBe('use_leave_instead');
    expect(await outcome(remove(ravi, trip, rId))).toBe('use_leave_instead');
    expect(byName(await members(trip), 'Asha Rao').status).toBe('active');
    expect(await outcome(remove(ravi, trip, aId))).toBe('ok');
    expect(active(await members(trip)).map((m) => m.display_name)).toEqual(['Ravi Kumar']);
  });

  it('refuses ordinary members, strangers, archived trips and other trips\' people', async () => {
    const trip = await makeTrip(asha, 'RemoveDeny');
    const rId = await put(trip, ravi, 'Ravi Kumar');
    const nId = await put(trip, nina, 'Nina Shah');
    expect(await outcome(remove(ravi, trip, nId))).toBe('not_admin');
    expect(await outcome(remove(sam, trip, nId))).toBe('trip_not_found');
    const other = await makeTrip(meera, 'RemoveOther');
    const theirs = (await add(meera, other, 'Theirs')).rows[0]!.member_id;
    expect(await outcome(remove(asha, trip, theirs))).toBe('member_not_found');
    expect(await outcome(remove(asha, trip, '00000000-0000-4000-8000-000000000000'))).toBe('member_not_found');
    await archive(trip);
    expect(await outcome(remove(asha, trip, rId))).toBe('trip_archived');
    expect(byName(await members(trip), 'Ravi Kumar').status).toBe('active');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('leave_trip', () => {
  it('a member leaves: the row is KEPT as "left" with a date, one audit record, and access ends', async () => {
    const trip = await makeTrip(asha, 'Leave');
    const rId = await put(trip, ravi, 'Ravi Kumar');
    expect((await leave(ravi, trip)).rows[0]).toMatchObject({ member_id: rId, changed: true });
    const r = byName(await members(trip), 'Ravi Kumar');
    expect(r).toMatchObject({ id: rId, status: 'left', user_id: ravi });
    expect(r.left_at).not.toBeNull();
    expect((await events(trip)).at(-1)).toMatchObject({ action: 'left', actor_member_id: rId, target_member_id: rId });
    expect(await outcome(leave(ravi, trip))).toBe('trip_not_found'); // a second attempt: they are no longer on the trip
    await users.asUser(ravi);
    expect((await db.query('select id from public.trips where id = $1', [trip])).rows).toEqual([]);
  });

  it('an administrator may leave when another administrator exists', async () => {
    const trip = await makeTrip(asha, 'LeaveAdmin');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    expect(await outcome(leave(asha, trip))).toBe('ok');
    expect(active(await members(trip)).map((m) => m.display_name)).toEqual(['Ravi Kumar']);
  });

  it('the only administrator cannot leave, whoever else is on the trip', async () => {
    const trip = await makeTrip(asha, 'LeaveSole');
    await put(trip, ravi, 'Ravi Kumar');
    await add(asha, trip, 'Gita'); // a guest is not an administrator
    expect(await outcome(leave(asha, trip))).toBe('last_admin');
    expect(byName(await members(trip), 'Asha Rao').status).toBe('active');
    await role(asha, trip, byName(await members(trip), 'Ravi Kumar').id, 'admin', 'member'); // hand over administration first
    expect(await outcome(leave(asha, trip))).toBe('ok');
  });

  it('the only person on a trip cannot leave it either (the trip would be abandoned)', async () => {
    const trip = await makeTrip(asha, 'LeaveAlone');
    expect(await outcome(leave(asha, trip))).toBe('last_admin');
  });

  it('is allowed on an ARCHIVED trip (the one exception to read-only), but not for strangers', async () => {
    const trip = await makeTrip(asha, 'LeaveArch');
    await put(trip, ravi, 'Ravi Kumar');
    await archive(trip);
    expect(await outcome(leave(sam, trip))).toBe('trip_not_found');
    expect(await outcome(leave(ravi, trip))).toBe('ok');
    expect(byName(await members(trip), 'Ravi Kumar').status).toBe('left');
    expect((await run(asha, 'list_trip_members', [trip])).rows.length).toBe(2); // the archived trip is otherwise unchanged
  });

  it('refuses unknown trips and other trips\' members with the same answer', async () => {
    expect(await outcome(leave(sam, '00000000-0000-4000-8000-000000000000'))).toBe('trip_not_found');
    const trip = await makeTrip(asha, 'LeaveOther');
    expect(await outcome(leave(meera, trip))).toBe('trip_not_found');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('there is always an administrator, even when callers act on stale information', () => {
  it('two administrators acting on each other one after the other: the second is refused', async () => {
    const trip = await makeTrip(asha, 'Race');
    const aId = byName(await members(trip), 'Asha Rao').id;
    const rId = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    expect(await outcome(role(asha, trip, rId, 'member', 'admin'))).toBe('ok'); // Asha demotes Ravi first...
    expect(await outcome(role(ravi, trip, aId, 'member', 'admin'))).toBe('not_admin'); // ...so Ravi's demotion of Asha fails
    expect(active(await members(trip)).filter((m) => m.role === 'admin').map((m) => m.display_name)).toEqual(['Asha Rao']);
  });

  it('both administrators trying to leave: only the first can', async () => {
    const trip = await makeTrip(asha, 'RaceLeave');
    await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    expect(await outcome(leave(asha, trip))).toBe('ok');
    expect(await outcome(leave(ravi, trip))).toBe('last_admin');
  });

  it('removing and demoting in turn can never strip the last administrator', async () => {
    const trip = await makeTrip(asha, 'RaceMix');
    const aId = byName(await members(trip), 'Asha Rao').id;
    const rId = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    expect(await outcome(remove(asha, trip, rId))).toBe('ok');
    expect(await outcome(role(asha, trip, aId, 'member', 'admin'))).toBe('last_admin');
    expect(await outcome(leave(asha, trip))).toBe('last_admin');
  });

  it('the safety net refuses ANY direct change that would leave a trip without a signed-up administrator', async () => {
    const trip = await makeTrip(asha, 'Net');
    const aId = byName(await members(trip), 'Asha Rao').id;
    await put(trip, ravi, 'Ravi Kumar');
    await users.asAdmin();
    await expect(db.query(`update public.trip_members set role = 'member' where id = $1`, [aId])).rejects.toThrow(/last_admin/);
    await expect(db.query(`update public.trip_members set status = 'removed' where id = $1`, [aId])).rejects.toThrow(/last_admin/);
    await expect(db.query(`update public.trip_members set status = 'left' where id = $1`, [aId])).rejects.toThrow(/last_admin/);
    await expect(db.query(`delete from public.trip_members where id = $1`, [aId])).rejects.toThrow(/last_admin/);
    await expect(db.query(`update public.trip_members set user_id = null where id = $1`, [aId])).rejects.toThrow(/guest_is_member|last_admin/);
    expect(byName(await members(trip), 'Asha Rao')).toMatchObject({ role: 'admin', status: 'active' });
  });

  it('each function refuses on its own, even with the safety net switched off (two independent defences)', async () => {
    await users.asAdmin();
    await db.exec('alter table public.trip_members disable trigger trip_members_keep_admin');
    try {
      const trip = await makeTrip(asha, 'OwnCheck');
      const aId = byName(await members(trip), 'Asha Rao').id;
      await put(trip, ravi, 'Ravi Kumar');
      expect(await outcome(leave(asha, trip))).toBe('last_admin'); // the function's own check, not the trigger
      expect(await outcome(role(asha, trip, aId, 'member', 'admin'))).toBe('last_admin');
      expect(byName(await members(trip), 'Asha Rao')).toMatchObject({ role: 'admin', status: 'active' });
      expect(await events(trip)).toEqual([]);
      // and the switched-off trigger really is the only thing that would have stopped a direct write
      await users.asAdmin();
      await expect(db.query(`update public.trip_members set role = 'member' where id = $1`, [aId])).resolves.toBeTruthy();
      await db.query(`update public.trip_members set role = 'admin' where id = $1`, [aId]);
    } finally {
      await users.asAdmin();
      await db.exec('alter table public.trip_members enable trigger trip_members_keep_admin');
    }
  });

  it('...but allows changes that keep one, and creating a trip (the trip and its first administrator together)', async () => {
    const trip = await makeTrip(asha, 'NetOk');
    const rId = await put(trip, ravi, 'Ravi Kumar', { role: 'admin' });
    await users.asAdmin();
    await expect(db.query(`update public.trip_members set role = 'member' where id = $1`, [rId])).resolves.toBeTruthy();
  });

  it('a guest can never be made an administrator, even by a direct write', async () => {
    const trip = await makeTrip(asha, 'NetGuest');
    const g = await put(trip, null, 'Gita');
    await users.asAdmin();
    await expect(db.query(`update public.trip_members set role = 'admin' where id = $1`, [g])).rejects.toThrow(/trip_members_guest_is_member/);
    await expect(db.query(`insert into public.trip_members (trip_id, user_id, display_name, role) values ($1, null, 'Boss', 'admin')`, [trip])).rejects.toThrow(/trip_members_guest_is_member/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the audit trail is append-only and protected', () => {
  let trip: string;
  let aId: string;
  beforeAll(async () => {
    trip = await makeTrip(asha, 'Audit');
    aId = byName(await members(trip), 'Asha Rao').id;
    await put(trip, ravi, 'Ravi Kumar');
    await add(asha, trip, 'Gita');
  });

  it('signed-in users can read their trip\'s trail but cannot write, change, delete or empty it', async () => {
    await users.asUser(ravi);
    expect((await db.query('select id from public.trip_member_events where trip_id = $1', [trip])).rows).toHaveLength(1);
    for (const sql of [
      `insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action) values ('${trip}', '${aId}', '${aId}', 'left')`,
      `update public.trip_member_events set action = 'left'`,
      `delete from public.trip_member_events`,
      `truncate public.trip_member_events`,
    ]) {
      await users.asUser(asha);
      expect(await outcome(db.query(sql)), sql).toBe('permission denied');
    }
    await users.asAnon();
    expect(await outcome(db.query('select * from public.trip_member_events'))).toBe('permission denied');
  });

  it('only members of the trip can read its trail: not strangers, other trips\' members, removed or departed people', async () => {
    const gone = await put(trip, nina, 'Nina Shah', { status: 'removed' });
    expect(gone).toBeTruthy();
    for (const who of [sam, meera, nina]) {
      await users.asUser(who);
      expect((await db.query('select id from public.trip_member_events where trip_id = $1', [trip])).rows, who).toEqual([]);
    }
  });

  it('even the database owner cannot edit, delete or empty a record', async () => {
    await users.asAdmin();
    await expect(db.query(`update public.trip_member_events set new_value = 'forged'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from public.trip_member_events where trip_id = $1`, [trip])).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate public.trip_member_events`)).rejects.toThrow(/append-only/);
    expect(await events(trip)).toHaveLength(1);
  });

  it('only the known actions are allowed', async () => {
    await users.asAdmin();
    await expect(db.query(`insert into public.trip_member_events (trip_id, actor_member_id, target_member_id, action) values ($1, $2, $2, 'hacked')`, [trip, aId])).rejects.toThrow(/trip_member_events_action_values/);
  });

  it('every kind of change leaves exactly one record, with the right actor, target and values; refusals and repeats leave none', async () => {
    const t = await makeTrip(asha, 'AuditAll');
    const a = byName(await members(t), 'Asha Rao').id;
    const r = await put(t, ravi, 'Ravi Kumar');
    const g = (await add(asha, t, 'Gita')).rows[0]!.member_id;
    await rename(asha, t, g, 'Geeta');
    await role(asha, t, r, 'admin', 'member');
    await role(asha, t, r, 'member', 'admin');
    await remove(asha, t, g);
    await leave(ravi, t);
    // refused or repeated calls
    await outcome(add(sam, t, 'X'));
    await outcome(role(asha, t, r, 'admin', 'member'));
    await outcome(remove(asha, t, g));
    await outcome(rename(asha, t, g, 'Geeta'));
    expect(await events(t)).toEqual([
      { action: 'guest_added', actor_member_id: a, target_member_id: g, old_value: null, new_value: 'Gita' },
      { action: 'guest_renamed', actor_member_id: a, target_member_id: g, old_value: 'Gita', new_value: 'Geeta' },
      { action: 'made_admin', actor_member_id: a, target_member_id: r, old_value: 'member', new_value: 'admin' },
      { action: 'removed_admin', actor_member_id: a, target_member_id: r, old_value: 'admin', new_value: 'member' },
      { action: 'removed', actor_member_id: a, target_member_id: g, old_value: null, new_value: null },
      { action: 'left', actor_member_id: r, target_member_id: r, old_value: null, new_value: null },
    ]);
  });

  it('the trail holds only member ids and words: no user ids, emails or profile data', async () => {
    await users.asAdmin();
    const cols = (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'trip_member_events'`,
    )).rows.map((c) => c.column_name);
    expect(cols.sort()).toEqual(['action', 'actor_member_id', 'created_at', 'id', 'new_value', 'old_value', 'seq', 'target_member_id', 'trip_id']);
  });

  it('removing a whole trip (which does not exist as a feature) would still clean up after itself', async () => {
    const t = await makeTrip(asha, 'AuditCascade');
    await add(asha, t, 'Gita');
    await users.asAdmin();
    await db.query('delete from public.trips where id = $1', [t]);
    expect((await db.query('select 1 from public.trip_member_events where trip_id = $1', [t])).rows).toEqual([]);
    expect((await db.query('select 1 from public.trip_members where trip_id = $1', [t])).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('history is preserved (what later expenses, shares and repayments will rely on)', () => {
  it('no action deletes a member row, changes an id, or changes when someone joined; a stand-in ledger pointing at members stays valid', async () => {
    const trip = await makeTrip(asha, 'History');
    const aId = byName(await members(trip), 'Asha Rao').id;
    const r = await put(trip, ravi, 'Ravi Kumar');
    const n = await put(trip, nina, 'Nina Shah');
    const g = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    await users.asAdmin();
    await db.exec(`create table public.ledger_probe (member_id uuid not null references public.trip_members (id) on delete restrict)`);
    for (const id of [aId, r, n, g]) await db.query('insert into public.ledger_probe values ($1)', [id]);
    const before = await members(trip);

    await remove(asha, trip, r);
    await leave(nina, trip);
    await remove(asha, trip, g);
    await role(asha, trip, aId, 'admin', 'admin'); // repeat

    const after = await members(trip);
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort()); // nobody deleted, nothing added
    for (const b of before) {
      const a = after.find((m) => m.id === b.id)!;
      expect(a.joined_at).toEqual(b.joined_at);
      expect(a.display_name).toBe(b.display_name);
      expect(a.user_id).toBe(b.user_id);
      expect(a.role).toBe(b.role); // a former administrator's last role stays on record
    }
    await users.asAdmin();
    expect((await db.query('select count(*)::int as n from public.ledger_probe')).rows[0]).toEqual({ n: 4 });
    await expect(db.query('delete from public.trip_members where id = $1', [r])).rejects.toThrow(/ledger_probe|violates foreign key/); // history blocks any deletion
    await db.exec('drop table public.ledger_probe');
  });

  it('the app has no way to delete or rewrite membership: no table write rights at all', async () => {
    const trip = await makeTrip(asha, 'NoWrite');
    await users.asUser(asha);
    for (const sql of [
      `delete from public.trip_members where trip_id = '${trip}'`,
      `update public.trip_members set status = 'removed' where trip_id = '${trip}'`,
      `update public.trip_members set role = 'admin' where trip_id = '${trip}'`,
      `insert into public.trip_members (trip_id, display_name) values ('${trip}', 'Sneaky')`,
    ]) expect(await outcome(db.query(sql)), sql).toBe('permission denied');
  });

  it('membership changes never touch the trip itself: its version and details are unchanged', async () => {
    const trip = await makeTrip(asha, 'Untouched');
    await users.asAdmin();
    const before = (await db.query('select version, name, status, budget_minor from public.trips where id = $1', [trip])).rows[0];
    const g = (await add(asha, trip, 'Gita')).rows[0]!.member_id;
    await rename(asha, trip, g, 'Geeta');
    await remove(asha, trip, g);
    await users.asAdmin();
    expect((await db.query('select version, name, status, budget_minor from public.trips where id = $1', [trip])).rows[0]).toEqual(before);
  });

  it('earlier trip functions are unaffected: an administrator can still edit and archive after membership changes', async () => {
    const trip = await makeTrip(asha, 'StillWorks');
    await put(trip, ravi, 'Ravi Kumar');
    await remove(asha, trip, byName(await members(trip), 'Ravi Kumar').id);
    await users.asUser(asha);
    const upd = await db.query<{ version: number }>(`select version from public.update_trip($1, 1, 'Renamed', 'Somewhere', '2026-12-27', '2026-12-30')`, [trip]);
    expect(upd.rows[0]!.version).toBe(2);
    await expect(db.query(`select * from public.set_trip_archived($1, true, 2)`, [trip])).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('random sequences of actions follow an independent model, and the invariants always hold', () => {
  /** A small, repeatable random-number generator. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  interface M {
    id: string;
    userId: string | null;
    name: string;
    role: 'admin' | 'member';
    status: 'active' | 'removed' | 'left';
  }
  const norm = (s: string) => s.trim().toLowerCase();

  /** The rules written out again, independently of the SQL, to compare against. */
  function expected(model: M[], archivedNow: boolean, actor: string, op: { kind: string; target?: M | string; name?: string; to?: string }): string {
    const me = model.find((m) => m.userId === actor && m.status === 'active');
    if (!me) return 'trip_not_found';
    if (op.kind !== 'leave' && me.role !== 'admin') return 'not_admin';
    if (archivedNow && op.kind !== 'leave') return 'trip_archived';
    const others = (except: M) => model.some((m) => m.id !== except.id && m.role === 'admin' && m.status === 'active' && m.userId !== null);
    const target = typeof op.target === 'string' ? undefined : op.target;
    const nameClash = (except?: M) => model.some((m) => m.status === 'active' && m !== except && norm(m.name) === norm(op.name ?? ''));
    const nameBad = (op.name ?? '').trim().length < 1 || (op.name ?? '').trim().length > 60;
    switch (op.kind) {
      case 'add':
        if (nameBad) return 'invalid_request';
        if (model.filter((m) => m.status === 'active').length >= 50) return 'trip_full';
        return nameClash() ? 'name_taken' : 'ok';
      case 'rename':
        if (!target || target.status !== 'active') return 'member_not_found';
        if (target.userId !== null) return 'cannot_rename';
        if (nameBad) return 'invalid_request';
        if (target.name === (op.name ?? '').trim()) return 'ok';
        return nameClash(target) ? 'name_taken' : 'ok';
      case 'role': {
        if (!target || target.status !== 'active') return 'member_not_found';
        if (target.role === op.to) return 'ok';
        if (target.role !== op.name) return 'member_changed';
        if (op.to === 'admin') return target.userId === null ? 'guest_cannot_be_admin' : 'ok';
        return others(target) ? 'ok' : 'last_admin';
      }
      case 'remove':
        if (!target) return 'member_not_found';
        if (target.id === me.id) return 'use_leave_instead';
        if (target.status !== 'active') return 'ok';
        if (target.role === 'admin' && !others(target)) return 'last_admin';
        return 'ok';
      case 'leave':
        return me.role === 'admin' && !others(me) ? 'last_admin' : 'ok';
    }
    return 'unreachable';
  }

  function apply(model: M[], actor: string, op: { kind: string; target?: M | string; name?: string; to?: string }, newId?: string) {
    const me = model.find((m) => m.userId === actor && m.status === 'active')!;
    const target = typeof op.target === 'string' ? undefined : op.target;
    if (op.kind === 'add') model.push({ id: newId!, userId: null, name: (op.name ?? '').trim(), role: 'member', status: 'active' });
    else if (op.kind === 'rename') target!.name = (op.name ?? '').trim();
    else if (op.kind === 'role') target!.role = op.to as 'admin' | 'member';
    else if (op.kind === 'remove') {
      if (target!.status === 'active') target!.status = 'removed';
    } else if (op.kind === 'leave') me.status = 'left';
  }

  it('1,500 random actions by admins, members and strangers behave exactly as the rules say, and every invariant holds after each one', async () => {
    const names = ['Gita', 'gita', ' GITA ', 'Hari', 'Ila', 'Ravi Kumar', 'ravi kumar', '', '   ', 'Zoya'];
    const people = [asha, ravi, nina, sam]; // sam never joins
    let steps = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed * 7919);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const trip = await makeTrip(asha, `Model ${seed}`);
      const start = await members(trip);
      const model: M[] = start.map((m) => ({ id: m.id, userId: m.user_id, name: m.display_name, role: m.role as 'admin' | 'member', status: m.status as 'active' }));
      for (const [u, n] of [[ravi, 'Ravi Kumar'], [nina, 'Nina Shah']] as const) {
        const id = await put(trip, u, n, { role: rand() < 0.3 ? 'admin' : 'member' });
        const row = (await members(trip)).find((m) => m.id === id)!;
        model.push({ id, userId: u, name: n, role: row.role as 'admin' | 'member', status: 'active' });
      }
      const foreign = await put(await makeTrip(meera, `Foreign ${seed}`), null, 'Foreign Guest'); // a member id from another trip
      let archivedNow = false;
      const ids = () => [...model.map((m) => m.id), foreign, '00000000-0000-4000-8000-000000000000'];

      for (let step = 0; step < 60; step++) {
        if (rand() < 0.05) {
          archivedNow = !archivedNow;
          await archive(trip, archivedNow);
        }
        const actor = pick(people);
        const kind = pick(['add', 'rename', 'role', 'remove', 'leave', 'add', 'role', 'remove']);
        const targetId = pick(ids());
        const target = model.find((m) => m.id === targetId);
        const op = { kind, target: target ?? targetId, name: pick(names), to: pick(['admin', 'member']) };
        if (kind === 'role') op.name = target ? pick(['admin', 'member', target.role, target.role]) : 'member'; // the role the actor believes (often right)
        const want = expected(model, archivedNow, actor, op);
        let got: string;
        let newId: string | undefined;
        try {
          const rows =
            kind === 'add' ? await add(actor, trip, op.name)
            : kind === 'rename' ? await rename(actor, trip, targetId, op.name)
            : kind === 'role' ? await role(actor, trip, targetId, op.to, op.name)
            : kind === 'remove' ? await remove(actor, trip, targetId)
            : await leave(actor, trip);
          got = 'ok';
          newId = rows.rows[0]!.member_id;
        } catch (e) {
          got = await outcome(Promise.reject(e));
        }
        expect(got, `seed ${seed} step ${step}: ${kind} by ${actor.slice(0, 4)} on ${targetId.slice(0, 4)} name=${JSON.stringify(op.name)} to=${op.to} archived=${archivedNow}`).toBe(want);
        if (got === 'ok') apply(model, actor, op, newId);
        steps++;

        // invariants, from the database itself
        const rows = await members(trip);
        expect(rows.map((m) => m.id).sort(), 'nobody is ever deleted').toEqual([...model.map((m) => m.id)].sort());
        expect(rows.some((m) => m.status === 'active' && m.role === 'admin' && m.user_id !== null), 'always a signed-up administrator').toBe(true);
        expect(rows.filter((m) => m.user_id === null && m.role !== 'member'), 'guests are never admins').toEqual([]);
        const activeNames = rows.filter((m) => m.status === 'active').map((m) => norm(m.display_name));
        expect(new Set(activeNames).size, 'active names are unique').toBe(activeNames.length);
        for (const m of rows) {
          const mm = model.find((x) => x.id === m.id)!;
          expect({ name: m.display_name, role: m.role, status: m.status }).toEqual({ name: mm.name, role: mm.role, status: mm.status });
          expect(m.left_at === null, 'left_at is set exactly when someone is gone').toBe(m.status === 'active');
        }
      }
      // the audit trail has one record per successful change and is in step with the model
      const trail = await events(trip);
      for (const e of trail) expect(['guest_added', 'guest_renamed', 'made_admin', 'removed_admin', 'removed', 'left']).toContain(e.action);
    }
    expect(steps).toBe(1500);
  }, 180_000);
});
