import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestUsers, migrationFiles, newDatabase, readMigration } from './harness';

/**
 * Tests the REAL trips migration (run after the profiles one) against a real
 * Postgres engine. See harness.ts for how Supabase is imitated.
 */
let db: PGlite;
let users: TestUsers;

const TRIP_COLUMNS = `id, name, destination, start_date::text as start_date, end_date::text as end_date,
  description, budget_minor::text as budget_minor, currency, status, created_by, version`;

interface TripRow {
  id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  description: string | null;
  budget_minor: string | null;
  currency: string;
  status: string;
  created_by: string;
  version: number;
}

type TripArgs = {
  name?: string | null;
  destination?: string | null;
  start?: string;
  end?: string;
  description?: string | null;
  budget?: number | null;
  currency?: string | null;
};

/** Calls create_trip as whoever is currently signed in (set with users.asUser / asAnon). */
function createTrip(a: TripArgs = {}) {
  const has = <K extends keyof TripArgs>(k: K, fallback: TripArgs[K]) => (k in a ? a[k] : fallback);
  return db.query<TripRow>(
    `select ${TRIP_COLUMNS} from public.create_trip($1, $2, $3, $4, $5, $6, $7)`,
    [
      has('name', 'Goa Trip 2026'),
      has('destination', 'Goa, India'),
      has('start', '2026-12-27'),
      has('end', '2026-12-30'),
      has('description', null),
      has('budget', null),
      has('currency', 'INR'),
    ],
  );
}

async function count(table: 'trips' | 'trip_members') {
  await users.asAdmin();
  return Number((await db.query<{ n: string }>(`select count(*)::text as n from public.${table}`)).rows[0]!.n);
}

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
});
afterAll(async () => {
  await db.close();
});

describe('migration', () => {
  it('runs after the profiles migration, and can be run again safely', async () => {
    await users.asAdmin();
    const trips = migrationFiles().find((f) => f.includes('trips_and_members'))!;
    await expect(db.exec(readMigration(trips))).resolves.toBeDefined();
  });

  it('creates the indexes the app relies on', async () => {
    await users.asAdmin();
    const names = (await db.query<{ indexname: string }>(`select indexname from pg_indexes where schemaname = 'public'`)).rows.map(
      (r) => r.indexname,
    );
    expect(names).toEqual(
      expect.arrayContaining(['trip_members_trip_user_unique', 'trip_members_trip_status_idx', 'trip_members_user_active_idx']),
    );
  });
});

describe('create_trip', () => {
  it('creates the trip from the product brief and makes the caller its administrator', async () => {
    const asha = await users.signUp('asha@example.com', 'Asha Rao');
    await users.asUser(asha);
    const trip = (await createTrip({ description: 'Beach, food, friends', budget: 6_000_000 })).rows[0]!;
    expect(trip).toMatchObject({
      name: 'Goa Trip 2026',
      destination: 'Goa, India',
      start_date: '2026-12-27',
      end_date: '2026-12-30',
      description: 'Beach, food, friends',
      budget_minor: '6000000',
      currency: 'INR',
      status: 'active',
      created_by: asha,
      version: 1,
    });

    await users.asAdmin();
    const members = (await db.query(`select user_id, display_name, role, status, invited_by from public.trip_members where trip_id = $1`, [trip.id])).rows;
    expect(members).toEqual([{ user_id: asha, display_name: 'Asha Rao', role: 'admin', status: 'active', invited_by: null }]);
  });

  it('trims text and stores a blank description as nothing', async () => {
    const u = await users.signUp('trim@example.com', 'Trim Tester');
    await users.asUser(u);
    const t = (await createTrip({ name: '  Manali  ', destination: '  Himachal ', description: '   ' })).rows[0]!;
    expect(t).toMatchObject({ name: 'Manali', destination: 'Himachal', description: null, budget_minor: null });
  });

  it('keeps the chosen currency, and a one-day trip is allowed', async () => {
    const u = await users.signUp('usd@example.com');
    await users.asUser(u);
    const t = (await createTrip({ currency: 'USD', start: '2026-12-27', end: '2026-12-27' })).rows[0]!;
    expect(t.currency).toBe('USD');
  });

  it('the same person can create several separate trips', async () => {
    const u = await users.signUp('multi@example.com');
    await users.asUser(u);
    const a = (await createTrip({ name: 'One' })).rows[0]!;
    const b = (await createTrip({ name: 'Two' })).rows[0]!;
    expect(a.id).not.toBe(b.id);
    expect([a.created_by, b.created_by]).toEqual([u, u]);
  });

  it('cannot be run by a signed-out visitor', async () => {
    await users.asAnon();
    await expect(createTrip()).rejects.toThrow(/permission denied/i);
  });

  it('refuses a caller that has no valid login even with the right role', async () => {
    await users.asAdmin();
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '', false)`);
    await expect(createTrip()).rejects.toThrow(/not_authenticated/);
  });

  it('refuses an account that somehow has no profile', async () => {
    const u = await users.signUp('noprofile@example.com');
    await users.asAdmin();
    await db.query('delete from public.profiles where id = $1', [u]);
    await users.asUser(u);
    await expect(createTrip()).rejects.toThrow(/profile_missing/);
  });

  it('has no way to name a different creator', async () => {
    const attacker = await users.signUp('attacker@example.com');
    const victim = await users.signUp('victim@example.com');
    await users.asUser(attacker);
    await expect(
      db.query(`select * from public.create_trip(p_name => 'x', p_destination => 'y', p_start_date => '2026-01-01', p_end_date => '2026-01-02', p_created_by => $1)`, [victim]),
    ).rejects.toThrow(/does not exist|p_created_by/i);
  });

  it('saves the trip AND its admin together, or neither (atomic)', async () => {
    const u = await users.signUp('atomic@example.com');
    const tripsBefore = await count('trips');
    const membersBefore = await count('trip_members');

    // Make the SECOND step (adding the admin) fail on purpose.
    await users.asAdmin();
    await db.exec(`alter table public.trip_members add constraint test_force_failure check (false) not valid`);
    try {
      await users.asUser(u);
      await expect(createTrip({ name: 'Should vanish' })).rejects.toThrow(/test_force_failure/);
    } finally {
      await users.asAdmin();
      await db.exec(`alter table public.trip_members drop constraint test_force_failure`);
    }

    expect(await count('trips')).toBe(tripsBefore); // the first step was rolled back too
    expect(await count('trip_members')).toBe(membersBefore);
  });

  describe('rejects invalid data and leaves nothing behind', () => {
    const cases: [string, TripArgs, RegExp][] = [
      ['a blank name', { name: '   ' }, /trips_name_length/],
      ['a 101-character name', { name: 'x'.repeat(101) }, /trips_name_length/],
      ['a missing name', { name: null }, /null value|not-null/i],
      ['a blank destination', { destination: '' }, /trips_destination_length/],
      ['a 101-character destination', { destination: 'y'.repeat(101) }, /trips_destination_length/],
      ['an end date before the start date', { start: '2026-12-30', end: '2026-12-27' }, /trips_dates_order/],
      ['a description over 500 characters', { description: 'z'.repeat(501) }, /trips_description_length/],
      ['a negative budget', { budget: -1 }, /trips_budget_nonnegative/],
      ['a lowercase currency', { currency: 'inr' }, /trips_currency_format/],
      ['a two-letter currency', { currency: 'RS' }, /trips_currency_format/],
    ];

    it.each(cases)('%s', async (_label, args, error) => {
      const u = await users.signUp(`bad-${Math.random().toString(36).slice(2)}@example.com`);
      const tripsBefore = await count('trips');
      const membersBefore = await count('trip_members');
      await users.asUser(u);
      await expect(createTrip(args)).rejects.toThrow(error);
      expect(await count('trips')).toBe(tripsBefore);
      expect(await count('trip_members')).toBe(membersBefore);
    });

    it('accepts the boundary values', async () => {
      const u = await users.signUp('edge@example.com');
      await users.asUser(u);
      await expect(
        createTrip({ name: 'x'.repeat(100), destination: 'y'.repeat(100), description: 'z'.repeat(500), budget: 0 }),
      ).resolves.toBeDefined();
    });
  });
});

describe('who can see trips and members (row-level security)', () => {
  let asha: string;
  let ravi: string;
  let ashasTrip: string;

  beforeAll(async () => {
    asha = await users.signUp('see-asha@example.com', 'Asha');
    ravi = await users.signUp('see-ravi@example.com', 'Ravi');
    await users.asUser(asha);
    ashasTrip = (await createTrip({ name: "Asha's private trip" })).rows[0]!.id;
  });

  it('a member sees their trip and its members', async () => {
    await users.asUser(asha);
    expect((await db.query('select id from public.trips where id = $1', [ashasTrip])).rows).toHaveLength(1);
    expect((await db.query('select id from public.trip_members where trip_id = $1', [ashasTrip])).rows).toHaveLength(1);
  });

  it('someone who is not on the trip sees neither the trip nor its members', async () => {
    await users.asUser(ravi);
    expect((await db.query('select id from public.trips where id = $1', [ashasTrip])).rows).toHaveLength(0);
    expect((await db.query('select id from public.trip_members where trip_id = $1', [ashasTrip])).rows).toHaveLength(0);
    // ...not even by asking for everything
    const all = (await db.query<{ name: string }>('select name from public.trips')).rows.map((r) => r.name);
    expect(all).not.toContain("Asha's private trip");
  });

  it("each person's list contains only their own trips", async () => {
    await users.asUser(ravi);
    const rt = (await createTrip({ name: "Ravi's trip" })).rows[0]!;
    expect((await db.query<{ name: string }>('select name from public.trips order by name')).rows.map((r) => r.name)).toEqual(["Ravi's trip"]);
    await users.asUser(asha);
    const names = (await db.query<{ name: string }>('select name from public.trips')).rows.map((r) => r.name);
    expect(names).toContain("Asha's private trip");
    expect(names).not.toContain("Ravi's trip");
    expect(rt.created_by).toBe(ravi);
  });

  it('a signed-out visitor is denied outright', async () => {
    await users.asAnon();
    await expect(db.query('select * from public.trips')).rejects.toThrow(/permission denied/i);
    await expect(db.query('select * from public.trip_members')).rejects.toThrow(/permission denied/i);
  });

  it('someone who has been removed or has left no longer sees the trip', async () => {
    const leaver = await users.signUp('see-leaver@example.com', 'Leaver');
    await users.asUser(leaver);
    const t = (await createTrip({ name: 'Leaver trip' })).rows[0]!;
    await users.asUser(leaver);
    expect((await db.query('select id from public.trips where id = $1', [t.id])).rows).toHaveLength(1);

    // A second administrator keeps the trip valid (since M3.4 the database refuses to leave a trip with no administrator).
    const other = await users.signUp('see-other-admin@example.com', 'Other Admin');
    await users.asAdmin();
    await db.query(`insert into public.trip_members (trip_id, user_id, display_name, role) values ($1, $2, 'Other Admin', 'admin')`, [t.id, other]);
    for (const status of ['removed', 'left']) {
      await users.asAdmin();
      await db.query(`update public.trip_members set status = $2 where trip_id = $1 and user_id = $3`, [t.id, status, leaver]);
      await users.asUser(leaver);
      expect((await db.query('select id from public.trips where id = $1', [t.id])).rows).toHaveLength(0);
      expect((await db.query('select id from public.trip_members where trip_id = $1', [t.id])).rows).toHaveLength(0);
    }
  });

  it('is_trip_member answers correctly for members and strangers, and is closed to signed-out callers', async () => {
    await users.asUser(asha);
    expect((await db.query<{ r: boolean }>('select public.is_trip_member($1) as r', [ashasTrip])).rows[0]!.r).toBe(true);
    await users.asUser(ravi);
    expect((await db.query<{ r: boolean }>('select public.is_trip_member($1) as r', [ashasTrip])).rows[0]!.r).toBe(false);
    await users.asAnon();
    await expect(db.query('select public.is_trip_member($1)', [ashasTrip])).rejects.toThrow(/permission denied/i);
  });
});

describe('nobody can write trips or members directly', () => {
  let owner: string;
  let tripId: string;
  let memberId: string;

  beforeAll(async () => {
    owner = await users.signUp('direct-owner@example.com', 'Owner');
    await users.asUser(owner);
    tripId = (await createTrip({ name: 'Direct-write target' })).rows[0]!.id;
    await users.asAdmin();
    memberId = (await db.query<{ id: string }>('select id from public.trip_members where trip_id = $1', [tripId])).rows[0]!.id;
  });

  const attempts: [string, string][] = [
    ['insert a trip', `insert into public.trips (name, destination, start_date, end_date, created_by) values ('x','y','2026-01-01','2026-01-02', gen_random_uuid())`],
    ['edit a trip', `update public.trips set name = 'hacked'`],
    ['delete a trip', `delete from public.trips`],
    ['add a member', `insert into public.trip_members (trip_id, user_id, display_name, role) values (gen_random_uuid(), null, 'sneaky', 'admin')`],
    ['promote themselves to admin', `update public.trip_members set role = 'admin'`],
    ['remove a member', `delete from public.trip_members`],
  ];

  it.each(attempts)('a signed-in user cannot %s', async (_what, sql) => {
    await users.asUser(owner); // even the trip's own admin
    await expect(db.query(sql)).rejects.toThrow(/permission denied/i);
  });

  it.each(attempts)('a signed-out visitor cannot %s', async (_what, sql) => {
    await users.asAnon();
    await expect(db.query(sql)).rejects.toThrow(/permission denied/i);
  });

  it('the trip and its admin are still intact afterwards', async () => {
    await users.asAdmin();
    expect((await db.query('select name from public.trips where id = $1', [tripId])).rows).toEqual([{ name: 'Direct-write target' }]);
    expect((await db.query('select role from public.trip_members where id = $1', [memberId])).rows).toEqual([{ role: 'admin' }]);
  });
});

describe('table rules the database enforces on its own', () => {
  let tripId: string;
  let owner: string;

  beforeAll(async () => {
    owner = await users.signUp('rules-owner@example.com', 'Rules Owner');
    await users.asUser(owner);
    tripId = (await createTrip({ name: 'Rules trip' })).rows[0]!.id;
  });

  it('a person can be on a trip only once', async () => {
    await users.asAdmin();
    await expect(
      db.query(`insert into public.trip_members (trip_id, user_id, display_name) values ($1, $2, 'Again')`, [tripId, owner]),
    ).rejects.toThrow(/trip_members_trip_user_unique/);
  });

  it('allows several guest members (no account) on one trip', async () => {
    await users.asAdmin();
    await db.query(`insert into public.trip_members (trip_id, user_id, display_name) values ($1, null, 'Guest A'), ($1, null, 'Guest B')`, [tripId]);
    expect(Number((await db.query<{ n: string }>(`select count(*)::text as n from public.trip_members where trip_id = $1 and user_id is null`, [tripId])).rows[0]!.n)).toBe(2);
  });

  it('only allows the known roles and statuses', async () => {
    await users.asAdmin();
    const named = await users.signUp('role-check@example.com', 'Role Check'); // a real person, so only the role rule is in play (guests have their own rule since M3.4)
    await users.asAdmin();
    await expect(db.query(`insert into public.trip_members (trip_id, user_id, display_name, role) values ($1, $2, 'X', 'owner')`, [tripId, named])).rejects.toThrow(/trip_members_role_values/);
    await expect(db.query(`insert into public.trip_members (trip_id, display_name, status) values ($1, 'X', 'banned')`, [tripId])).rejects.toThrow(/trip_members_status_values/);
    await expect(db.query(`insert into public.trip_members (trip_id, display_name) values ($1, '   ')`, [tripId])).rejects.toThrow(/trip_members_display_name_length/);
  });

  it('only allows the known trip statuses', async () => {
    await users.asAdmin();
    await expect(db.query(`update public.trips set status = 'deleted' where id = $1`, [tripId])).rejects.toThrow(/trips_status_values/);
  });

  it('the database stamps updated_at itself when a trip changes', async () => {
    await users.asAdmin();
    const before = (await db.query<{ updated_at: Date }>('select updated_at from public.trips where id = $1', [tripId])).rows[0]!.updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await db.query(`update public.trips set description = 'edited' where id = $1`, [tripId]);
    const after = (await db.query<{ updated_at: Date }>('select updated_at from public.trips where id = $1', [tripId])).rows[0]!.updated_at;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('deleting a trip removes its members (no orphans)', async () => {
    const u = await users.signUp('cascade@example.com', 'Cascade');
    await users.asUser(u);
    const t = (await createTrip({ name: 'Short-lived' })).rows[0]!;
    await users.asAdmin();
    await db.query('delete from public.trips where id = $1', [t.id]);
    expect((await db.query('select 1 from public.trip_members where trip_id = $1', [t.id])).rows).toHaveLength(0);
  });
});
