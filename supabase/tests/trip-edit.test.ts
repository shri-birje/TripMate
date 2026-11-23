import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestUsers, newDatabase } from './harness';

/**
 * Tests update_trip(), set_trip_archived() and the version counter (migration
 * 20261118200000) against a real Postgres engine, as every kind of caller.
 *
 * LIMIT (honest): PGlite is a single connection, so two truly simultaneous
 * sessions cannot be run here. The "two admins" tests replay the SEQUENCE a race
 * produces (both start from version N, one saves first). That the row lock makes
 * a true race behave the same way is Postgres' documented behaviour; the tests
 * also check that the locking and the version-guarded UPDATE are present in the
 * function bodies.
 */
let db: PGlite;
let users: TestUsers;

let asha: string; // creator and admin
let meera: string; // second admin
let ravi: string; // ordinary member
let rahul: string; // removed
let dev: string; // left
let sam: string; // stranger
let trip: string; // a fresh trip for every test

const COLS = `id, name, destination, start_date::text as start_date, end_date::text as end_date, description,
  budget_minor::text as budget_minor, currency, status, created_by, version, updated_at::text as updated_at, created_at::text as created_at`;

interface TripRow {
  id: string; name: string; destination: string; start_date: string; end_date: string; description: string | null;
  budget_minor: string | null; currency: string; status: string; created_by: string; version: number; updated_at: string; created_at: string;
}

type Edit = {
  version?: number | null; name?: string | null; destination?: string | null; start?: string; end?: string;
  description?: string | null; budget?: number | null;
};

/** The values every fresh trip starts with (so tests can reason about "changed" and "unchanged"). */
const ORIGINAL = { name: 'Goa Trip 2026', destination: 'Goa, India', start: '2026-12-27', end: '2026-12-30', description: 'Beach', budget: 6_000_000 };

function update(tripId: string, e: Edit = {}) {
  const has = <K extends keyof Edit>(k: K, d: Edit[K]) => (k in e ? e[k] : d);
  return db.query<TripRow>(`select ${COLS} from public.update_trip($1, $2, $3, $4, $5, $6, $7, $8)`, [
    tripId, has('version', 1), has('name', 'Edited Goa Trip'), has('destination', 'North Goa'), has('start', '2026-12-28'),
    has('end', '2026-12-31'), has('description', 'Edited description'), has('budget', 7_000_000),
  ]);
}

/** Edit that repeats the original values exactly (a no-op). */
const noop = (tripId: string, version = 1) =>
  update(tripId, { version, name: ORIGINAL.name, destination: ORIGINAL.destination, start: ORIGINAL.start, end: ORIGINAL.end, description: ORIGINAL.description, budget: ORIGINAL.budget });

const archive = (tripId: string, archived: boolean | null, version: number | null) =>
  db.query<TripRow>(`select ${COLS} from public.set_trip_archived($1, $2, $3)`, [tripId, archived, version]);

async function read(tripId: string): Promise<TripRow> {
  await users.asAdmin();
  return (await db.query<TripRow>(`select ${COLS} from public.trips where id = $1`, [tripId])).rows[0]!;
}

async function memberCount(tripId: string) {
  await users.asAdmin();
  return Number((await db.query<{ n: string }>(`select count(*)::text as n from public.trip_members where trip_id = $1`, [tripId])).rows[0]!.n);
}

async function addMember(tripId: string, userId: string, name: string, role: string, status = 'active') {
  await users.asAdmin();
  await db.query(`insert into public.trip_members (trip_id, user_id, display_name, role, status) values ($1, $2, $3, $4, $5)`, [tripId, userId, name, role, status]);
}

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  meera = await users.signUp('meera@example.com', 'Meera Nair');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  rahul = await users.signUp('rahul@example.com', 'Removed Rahul');
  dev = await users.signUp('dev@example.com', 'Departed Dev');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
});

beforeEach(async () => {
  await users.asUser(asha);
  const r = await db.query<{ id: string }>(`select id from public.create_trip($1, $2, $3, $4, $5, $6, 'USD')`, [
    ORIGINAL.name, ORIGINAL.destination, ORIGINAL.start, ORIGINAL.end, ORIGINAL.description, ORIGINAL.budget,
  ]);
  trip = r.rows[0]!.id;
  await addMember(trip, meera, 'Meera Nair', 'admin');
  await addMember(trip, ravi, 'Ravi Kumar', 'member');
  await addMember(trip, rahul, 'Removed Rahul', 'member', 'removed');
  await addMember(trip, dev, 'Departed Dev', 'member', 'left');
});

afterAll(async () => {
  await db.close();
});

describe('update_trip: who may edit', () => {
  it('an administrator can edit every editable field; the version goes 1 -> 2', async () => {
    await users.asUser(asha);
    const t = (await update(trip)).rows[0]!;
    expect(t).toMatchObject({
      name: 'Edited Goa Trip', destination: 'North Goa', start_date: '2026-12-28', end_date: '2026-12-31',
      description: 'Edited description', budget_minor: '7000000', version: 2,
    });
  });

  it('changes nothing else: currency, status, creator, id and creation time stay as they were', async () => {
    const before = await read(trip);
    await users.asUser(asha);
    await update(trip);
    const after = await read(trip);
    for (const k of ['id', 'currency', 'status', 'created_by', 'created_at'] as const) expect(after[k]).toBe(before[k]);
    expect(after.currency).toBe('USD');
  });

  it('a second administrator (not the creator) can edit too', async () => {
    await users.asUser(meera);
    expect((await update(trip)).rows[0]!.name).toBe('Edited Goa Trip');
  });

  it('an ordinary member cannot: "not_admin", and nothing changes', async () => {
    const before = await read(trip);
    await users.asUser(ravi);
    await expect(update(trip)).rejects.toThrow(/not_admin/);
    expect(await read(trip)).toEqual(before);
  });

  it.each([
    ['a stranger', () => sam],
    ['a removed member', () => rahul],
    ['a member who left', () => dev],
  ])('%s gets "trip_not_found" and nothing changes', async (_who, who) => {
    const before = await read(trip);
    await users.asUser(who());
    await expect(update(trip)).rejects.toThrow(/trip_not_found/);
    expect(await read(trip)).toEqual(before);
  });

  it('a trip that does not exist gets the IDENTICAL answer, so existence cannot be probed', async () => {
    await users.asUser(sam);
    const hidden = await update(trip).catch((e) => e as Error);
    const missing = await update('00000000-0000-4000-8000-000000000000').catch((e) => e as Error);
    expect((missing as Error).message).toBe((hidden as Error).message);
    expect((hidden as Error).message).toMatch(/trip_not_found/);
  });

  it('a signed-out visitor cannot run it at all', async () => {
    await users.asAnon();
    await expect(update(trip)).rejects.toThrow(/permission denied/i);
  });

  it('refuses a caller with the right role but no valid login', async () => {
    await users.asAdmin();
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '', false)`);
    await expect(update(trip)).rejects.toThrow(/not_authenticated/);
  });

  it('has no way to change the currency, status or creator (no such inputs)', async () => {
    await users.asUser(asha);
    for (const extra of ['p_currency', 'p_status', 'p_created_by']) {
      await expect(
        db.query(`select * from public.update_trip(p_trip_id => $1, p_expected_version => 1, p_name => 'x', p_destination => 'y', p_start_date => '2026-01-01', p_end_date => '2026-01-02', ${extra} => 'x')`, [trip]),
      ).rejects.toThrow(/does not exist|${extra}/i);
    }
  });
});

describe('update_trip: values', () => {
  it('trims text, stores a blank description as nothing, and can remove the budget', async () => {
    await users.asUser(asha);
    const t = (await update(trip, { name: '  Spaced  ', destination: '  Place ', description: '   ', budget: null })).rows[0]!;
    expect(t).toMatchObject({ name: 'Spaced', destination: 'Place', description: null, budget_minor: null });
  });

  it('accepts the boundary values', async () => {
    await users.asUser(asha);
    await expect(update(trip, { name: 'x'.repeat(100), destination: 'y'.repeat(100), description: 'z'.repeat(500), budget: 0, start: '2026-12-27', end: '2026-12-27' })).resolves.toBeDefined();
  });

  describe('invalid data is refused, leaves the trip exactly as it was, and does not use up a version', () => {
    const cases: [string, Edit, RegExp][] = [
      ['a blank name', { name: '   ' }, /trips_name_length/],
      ['a 101-character name', { name: 'x'.repeat(101) }, /trips_name_length/],
      ['a missing name', { name: null }, /null value|not-null/i],
      ['a blank destination', { destination: '' }, /trips_destination_length/],
      ['an end date before the start date', { start: '2026-12-31', end: '2026-12-28' }, /trips_dates_order/],
      ['a description over 500 characters', { description: 'z'.repeat(501) }, /trips_description_length/],
      ['a negative budget', { budget: -1 }, /trips_budget_nonnegative/],
    ];
    it.each(cases)('%s', async (_label, edit, error) => {
      const before = await read(trip);
      await users.asUser(asha);
      await expect(update(trip, edit)).rejects.toThrow(error);
      expect(await read(trip)).toEqual(before);
    });
  });
});

describe('concurrency: a newer edit can never be overwritten', () => {
  it('two administrators start from version 1; the first save wins and the second is refused untouched', async () => {
    await users.asUser(asha);
    const first = (await update(trip, { version: 1, name: 'Asha edit', description: 'by Asha' })).rows[0]!;
    expect(first.version).toBe(2);

    await users.asUser(meera); // still working from version 1
    await expect(update(trip, { version: 1, name: 'Meera edit', description: 'by Meera' })).rejects.toThrow(/version_conflict/);

    const now = await read(trip);
    expect(now).toMatchObject({ name: 'Asha edit', description: 'by Asha', version: 2 }); // Asha's newer edit survived
  });

  it('after a conflict, retrying from the latest version succeeds and builds on the newer data', async () => {
    await users.asUser(asha);
    await update(trip, { version: 1, name: 'Asha edit', description: 'by Asha' });
    await users.asUser(meera);
    await expect(update(trip, { version: 1, name: 'Meera edit' })).rejects.toThrow(/version_conflict/);
    const latest = await read(trip);
    const retried = (await update(trip, { version: latest.version, name: 'Meera edit', description: latest.description })).rows[0]!;
    expect(retried).toMatchObject({ name: 'Meera edit', description: 'by Asha', version: 3 });
  });

  it('every real change adds exactly one version', async () => {
    await users.asUser(asha);
    const versions: number[] = [];
    let v = 1;
    for (const name of ['One', 'Two', 'Three']) {
      const t = (await update(trip, { version: v, name })).rows[0]!;
      versions.push(t.version);
      v = t.version;
    }
    expect(versions).toEqual([2, 3, 4]);
  });

  it('a missing or wrong version is a conflict, never a silent overwrite', async () => {
    await users.asUser(asha);
    for (const bad of [null, 0, 2, 99, -1]) {
      const before = await read(trip);
      await expect(update(trip, { version: bad })).rejects.toThrow(/version_conflict/);
      expect(await read(trip)).toEqual(before);
    }
  });

  it('the conflict is detected BEFORE any change, so nothing is half-applied', async () => {
    await users.asUser(asha);
    await update(trip, { version: 1, name: 'Newer' });
    const before = await read(trip);
    await users.asUser(meera);
    await expect(update(trip, { version: 1, destination: 'Stale destination', budget: 1 })).rejects.toThrow(/version_conflict/);
    expect(await read(trip)).toEqual(before);
  });

  it('structure: both functions lock the row and guard the UPDATE with the version', async () => {
    await users.asAdmin();
    const r = await db.query<{ proname: string; prosrc: string }>(
      `select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('update_trip', 'set_trip_archived')`,
    );
    expect(r.rows).toHaveLength(2);
    for (const fn of r.rows) {
      expect(fn.prosrc).toMatch(/for update/i);
      expect(fn.prosrc).toMatch(/version = p_expected_version/i);
    }
  });
});

describe('no-op edits do not use up a version', () => {
  it('saving the same values returns the trip unchanged: same version, same updated_at', async () => {
    const before = await read(trip);
    await users.asUser(asha);
    const t = (await noop(trip)).rows[0]!;
    expect(t.version).toBe(1);
    expect(await read(trip)).toEqual(before);
  });

  it('a no-op with a stale version is still a conflict (someone else changed the trip)', async () => {
    await users.asUser(asha);
    await update(trip, { version: 1, name: 'Newer' });
    await expect(noop(trip, 1)).rejects.toThrow(/version_conflict/);
  });

  it('whitespace-only differences count as no change', async () => {
    await users.asUser(asha);
    const t = (await update(trip, { version: 1, name: `  ${ORIGINAL.name}  `, destination: ORIGINAL.destination, start: ORIGINAL.start, end: ORIGINAL.end, description: ORIGINAL.description, budget: ORIGINAL.budget })).rows[0]!;
    expect(t.version).toBe(1);
  });
});

describe('archived trips are read-only', () => {
  it('an archived trip refuses edits, even from an admin with the right version', async () => {
    await users.asUser(asha);
    const archived = (await archive(trip, true, 1)).rows[0]!;
    const before = await read(trip);
    await expect(update(trip, { version: archived.version })).rejects.toThrow(/trip_archived/);
    expect(await read(trip)).toEqual(before);
  });

  it('after restoring, edits work again', async () => {
    await users.asUser(asha);
    const a = (await archive(trip, true, 1)).rows[0]!;
    const r = (await archive(trip, false, a.version)).rows[0]!;
    expect((await update(trip, { version: r.version })).rows[0]!.name).toBe('Edited Goa Trip');
  });
});

describe('set_trip_archived: who may archive and restore', () => {
  it('an administrator archives: only the status changes, version +1', async () => {
    const before = await read(trip);
    await users.asUser(asha);
    const t = (await archive(trip, true, 1)).rows[0]!;
    expect(t).toMatchObject({ status: 'archived', version: 2 });
    const after = await read(trip);
    for (const k of ['id', 'name', 'destination', 'start_date', 'end_date', 'description', 'budget_minor', 'currency', 'created_by', 'created_at'] as const) {
      expect(after[k]).toBe(before[k]); // nothing else about the trip changed
    }
  });

  it('a second administrator can archive and restore', async () => {
    await users.asUser(meera);
    const a = (await archive(trip, true, 1)).rows[0]!;
    expect((await archive(trip, false, a.version)).rows[0]!.status).toBe('active');
  });

  it('an ordinary member cannot archive or restore', async () => {
    await users.asUser(ravi);
    await expect(archive(trip, true, 1)).rejects.toThrow(/not_admin/);
    await users.asUser(asha);
    const a = (await archive(trip, true, 1)).rows[0]!;
    await users.asUser(ravi);
    await expect(archive(trip, false, a.version)).rejects.toThrow(/not_admin/);
    expect((await read(trip)).status).toBe('archived');
  });

  it.each([
    ['a stranger', () => sam],
    ['a removed member', () => rahul],
    ['a member who left', () => dev],
  ])('%s gets "trip_not_found" for archive and for restore', async (_who, who) => {
    await users.asUser(who());
    await expect(archive(trip, true, 1)).rejects.toThrow(/trip_not_found/);
    await expect(archive(trip, false, 1)).rejects.toThrow(/trip_not_found/);
    expect((await read(trip)).status).toBe('active');
  });

  it('a signed-out visitor cannot run it', async () => {
    await users.asAnon();
    await expect(archive(trip, true, 1)).rejects.toThrow(/permission denied/i);
  });

  it('a missing yes/no answer is rejected', async () => {
    await users.asUser(asha);
    await expect(archive(trip, null, 1)).rejects.toThrow(/invalid_request/);
  });
});

describe('set_trip_archived: restore, repeats and concurrency', () => {
  it('restore changes ONLY the status; every other field and the members are untouched', async () => {
    await users.asUser(asha);
    const a = (await archive(trip, true, 1)).rows[0]!;
    const archivedState = await read(trip);
    const members = await memberCount(trip);
    await users.asUser(asha);
    const r = (await archive(trip, false, a.version)).rows[0]!;
    expect(r).toMatchObject({ status: 'active', version: 3 });
    const after = await read(trip);
    for (const k of ['name', 'destination', 'start_date', 'end_date', 'description', 'budget_minor', 'currency', 'created_by'] as const) {
      expect(after[k]).toBe(archivedState[k]);
    }
    expect(await memberCount(trip)).toBe(members);
  });

  it('repeating archive is safe: no second version, same result', async () => {
    await users.asUser(asha);
    const first = (await archive(trip, true, 1)).rows[0]!;
    const again = (await archive(trip, true, 1)).rows[0]!; // even with the old version (a retry after a lost reply)
    expect(again).toMatchObject({ status: 'archived', version: first.version });
    expect((await read(trip)).version).toBe(first.version);
  });

  it('repeating restore on an active trip is safe and changes nothing', async () => {
    const before = await read(trip);
    await users.asUser(asha);
    const t = (await archive(trip, false, 1)).rows[0]!;
    expect(t.status).toBe('active');
    expect(await read(trip)).toEqual(before);
  });

  it('archive, restore, archive again: three real changes, three versions', async () => {
    await users.asUser(asha);
    const a = (await archive(trip, true, 1)).rows[0]!;
    const r = (await archive(trip, false, a.version)).rows[0]!;
    const b = (await archive(trip, true, r.version)).rows[0]!;
    expect([a.version, r.version, b.version]).toEqual([2, 3, 4]);
  });

  it('a stale version is refused when it would change something, and nothing changes', async () => {
    await users.asUser(asha);
    await update(trip, { version: 1, name: 'Newer' }); // version is now 2
    await users.asUser(meera);
    const before = await read(trip);
    await expect(archive(trip, true, 1)).rejects.toThrow(/version_conflict/);
    expect(await read(trip)).toEqual(before);
    expect((await archive(trip, true, 2)).rows[0]!.status).toBe('archived');
  });

  it('archiving does not delete anything: the trip and its members are all still there', async () => {
    const members = await memberCount(trip);
    await users.asUser(asha);
    await archive(trip, true, 1);
    expect(await memberCount(trip)).toBe(members);
    expect((await read(trip)).name).toBe(ORIGINAL.name);
  });

  it('members can still READ an archived trip; strangers still cannot', async () => {
    await users.asUser(asha);
    await archive(trip, true, 1);
    await users.asUser(ravi);
    expect((await db.query<{ status: string }>('select status from public.trips where id = $1', [trip])).rows).toEqual([{ status: 'archived' }]);
    await users.asUser(sam);
    expect((await db.query('select 1 from public.trips where id = $1', [trip])).rows).toHaveLength(0);
  });
});

describe('the version counter itself', () => {
  it('a direct change by the database owner adds a version; a direct no-op does not', async () => {
    await users.asAdmin();
    await db.query(`update public.trips set name = name where id = $1`, [trip]);
    expect((await read(trip)).version).toBe(1);
    await db.query(`update public.trips set description = 'direct' where id = $1`, [trip]);
    expect((await read(trip)).version).toBe(2);
  });

  it('nobody can set the version themselves', async () => {
    await users.asAdmin();
    await db.query(`update public.trips set version = 99, description = 'x' where id = $1`, [trip]);
    expect((await read(trip)).version).toBe(2); // old + 1, not 99
    await db.query(`update public.trips set version = 50 where id = $1`, [trip]);
    expect((await read(trip)).version).toBe(2); // nothing else changed, so it stays
  });

  it('a brand new trip is version 1', async () => {
    expect((await read(trip)).version).toBe(1);
  });
});

describe('the helper and the trigger function are closed to the app', () => {
  it.each([
    ['trip_role_of', `select public.trip_role_of($1, $2)`],
    ['bump_trip_version', `select public.bump_trip_version()`],
  ])('%s cannot be run by signed-in or signed-out callers', async (_name, sql) => {
    for (const as of ['user', 'anon'] as const) {
      if (as === 'user') await users.asUser(asha);
      else await users.asAnon();
      await expect(db.query(sql, sql.includes('$2') ? [trip, asha] : [])).rejects.toThrow(/permission denied/i);
    }
  });

  it('the callable functions are exactly the reviewed ones (M3.3 added two; M3.4 six, which tell a role only to members of that trip; M3.5 five invitation functions)', async () => {
    await users.asAdmin();
    const fns = (await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`,
    )).rows.map((r) => r.proname);
    expect(fns).toEqual(['add_guest_member', 'create_invite', 'create_trip', 'decide_join_request', 'get_general_invite_link', 'is_trip_member', 'leave_trip', 'list_join_requests', 'list_trip_invites', 'list_trip_members', 'preview_invite', 'remove_member', 'rename_guest_member', 'request_to_join', 'revoke_invite', 'set_member_role', 'set_trip_archived', 'update_trip']);
  });

  it('direct writes to trips are still denied for everyone, including administrators', async () => {
    await users.asUser(asha);
    await expect(db.query(`update public.trips set name = 'hacked' where id = $1`, [trip])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update public.trips set status = 'archived' where id = $1`, [trip])).rejects.toThrow(/permission denied/i);
  });
});

describe('the migration', () => {
  it('can be run again safely', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { MIGRATIONS_DIR } = await import('./harness');
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f.includes('trip_edit_archive'))!;
    await users.asAdmin();
    await expect(db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))).resolves.toBeDefined();
  });
});
