import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestUsers, newDatabase } from './harness';

/**
 * Proves that the Trip Details read is protected BY THE DATABASE, for every kind of caller.
 *
 * The app reads one trip together with its current members. In SQL that is this join (what
 * PostgREST produces for the app's request); row-level security applies to BOTH tables, so we
 * run exactly this as each kind of caller and look at what comes back.
 *
 * Also proves the privacy requirement: reading a trip's members does not open up other
 * people's profiles (UPI IDs, avatars) or email addresses.
 */
let db: PGlite;
let users: TestUsers;

const DETAILS_SQL = `
  select t.id as trip_id, t.name, t.created_by, t.status as trip_status,
         m.id as member_id, m.user_id, m.display_name, m.role, m.status as member_status
    from public.trips t
    left join public.trip_members m on m.trip_id = t.id and m.status = 'active'
   where t.id = $1
   order by m.joined_at, m.display_name`;

interface Row {
  trip_id: string;
  name: string;
  created_by: string;
  trip_status: string;
  member_id: string | null;
  user_id: string | null;
  display_name: string | null;
  role: string | null;
  member_status: string | null;
}

const details = async (tripId: string) => (await db.query<Row>(DETAILS_SQL, [tripId])).rows;
const names = (rows: Row[]) => rows.map((r) => r.display_name);

let asha: string; // creator and admin of Goa
let ravi: string; // ordinary member of Goa
let rahul: string; // was removed from Goa
let dev: string; // left Goa
let sam: string; // never on any trip
let meera: string; // admin of her own, separate trip
let goa: string;
let manali: string;
let archived: string;

async function createTrip(creator: string, name: string): Promise<string> {
  await users.asUser(creator);
  const r = await db.query<{ id: string }>(`select id from public.create_trip($1, 'Somewhere', '2026-12-27', '2026-12-30')`, [name]);
  return r.rows[0]!.id;
}

async function addMember(tripId: string, userId: string | null, displayName: string, status = 'active') {
  await users.asAdmin();
  await db.query(`insert into public.trip_members (trip_id, user_id, display_name, status) values ($1, $2, $3, $4)`, [
    tripId, userId, displayName, status,
  ]);
}

beforeAll(async () => {
  db = await newDatabase();
  users = new TestUsers(db);
  asha = await users.signUp('asha@example.com', 'Asha Rao');
  ravi = await users.signUp('ravi@example.com', 'Ravi Kumar');
  rahul = await users.signUp('rahul@example.com', 'Removed Rahul');
  dev = await users.signUp('dev@example.com', 'Departed Dev');
  sam = await users.signUp('sam@example.com', 'Stranger Sam');
  meera = await users.signUp('meera@example.com', 'Meera Nair');

  goa = await createTrip(asha, 'Goa Trip 2026');
  await addMember(goa, ravi, 'Ravi Kumar');
  await addMember(goa, null, 'Guest Gita'); // a friend without an account
  await addMember(goa, rahul, 'Removed Rahul', 'removed');
  await addMember(goa, dev, 'Departed Dev', 'left');

  manali = await createTrip(meera, 'Meera Manali');
  await addMember(manali, null, 'Meera Guest');

  archived = await createTrip(asha, 'Archived Trip');
  await users.asAdmin();
  await db.query(`update public.trips set status = 'archived' where id = $1`, [archived]);

  // Give people private profile data that must never leak through a trip.
  await db.query(`update public.profiles set upi_id = 'ravi@okhdfcbank' where id = $1`, [ravi]);
  await db.query(`update public.profiles set upi_id = 'meera@ybl' where id = $1`, [meera]);
});

afterAll(async () => {
  await db.close();
});

describe('a member reading their own trip', () => {
  it('sees the trip and every CURRENT member (including a guest), and nobody who left or was removed', async () => {
    await users.asUser(asha);
    const rows = await details(goa);
    expect(names(rows).sort()).toEqual(['Asha Rao', 'Guest Gita', 'Ravi Kumar']);
    expect(rows.every((r) => r.trip_id === goa && r.name === 'Goa Trip 2026')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Rahul|Dev/);
  });

  it('an ordinary (non-admin) member sees the same details', async () => {
    await users.asUser(ravi);
    expect(names(await details(goa)).sort()).toEqual(['Asha Rao', 'Guest Gita', 'Ravi Kumar']);
  });

  it('can find the creator among the members, and who the administrators are', async () => {
    await users.asUser(ravi);
    const rows = await details(goa);
    const creator = rows.find((r) => r.user_id === rows[0]!.created_by);
    expect(creator?.display_name).toBe('Asha Rao');
    expect(rows.filter((r) => r.role === 'admin').map((r) => r.display_name)).toEqual(['Asha Rao']);
  });

  it('can open an ARCHIVED trip; it is marked as archived', async () => {
    await users.asUser(asha);
    const rows = await details(archived);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Archived Trip', trip_status: 'archived' });
  });

  it('reading one trip never returns another trip\'s data', async () => {
    await users.asUser(asha);
    for (const r of await details(goa)) expect(r.trip_id).toBe(goa);
    const all = (await db.query<{ trip_id: string }>('select trip_id from public.trip_members')).rows.map((r) => r.trip_id);
    expect(all).not.toContain(manali);
  });
});

describe('everyone else gets NOTHING, and cannot tell why', () => {
  it('a signed-in stranger gets no rows for someone else\'s trip', async () => {
    await users.asUser(sam);
    expect(await details(goa)).toEqual([]);
  });

  it('a member of a different trip gets no rows for this one', async () => {
    await users.asUser(meera);
    expect(await details(goa)).toEqual([]);
    await users.asUser(asha);
    expect(await details(manali)).toEqual([]);
  });

  it('a person who was removed from the trip gets no rows', async () => {
    await users.asUser(rahul);
    expect(await details(goa)).toEqual([]);
  });

  it('a person who left the trip gets no rows', async () => {
    await users.asUser(dev);
    expect(await details(goa)).toEqual([]);
  });

  it('an archived trip is hidden from non-members too', async () => {
    await users.asUser(ravi);
    expect(await details(archived)).toEqual([]);
  });

  it('a trip that does not exist looks EXACTLY like a trip you may not see (existence cannot be probed)', async () => {
    await users.asUser(sam);
    const unknown = await details('00000000-0000-4000-8000-000000000000');
    const hidden = await details(goa);
    expect(unknown).toEqual([]);
    expect(hidden).toEqual(unknown);
  });

  it('a signed-out visitor is denied outright', async () => {
    await users.asAnon();
    await expect(details(goa)).rejects.toThrow(/permission denied/i);
  });

  it('a malformed id is an error from the database, which the app turns into the same combined message', async () => {
    await users.asUser(sam);
    await expect(db.query(DETAILS_SQL, ['not-a-uuid'])).rejects.toThrow(/invalid input syntax for type uuid/i);
  });
});

describe('member privacy: reading a trip does not open up anyone\'s profile or email', () => {
  it('a member cannot read a co-member\'s profile (so no UPI ID or avatar)', async () => {
    await users.asUser(asha);
    const r = await db.query('select id, upi_id from public.profiles where id = $1', [ravi]);
    expect(r.rows).toEqual([]);
    const all = (await db.query<{ id: string }>('select id from public.profiles')).rows.map((x) => x.id);
    expect(all).toEqual([asha]); // only their own profile
  });

  it('nobody can read email addresses (the sign-in table is closed to app users)', async () => {
    for (const who of [asha, sam]) {
      await users.asUser(who);
      await expect(db.query('select email from auth.users')).rejects.toThrow(/permission denied/i);
    }
    await users.asAnon();
    await expect(db.query('select email from auth.users')).rejects.toThrow(/permission denied/i);
  });

  it('the trip and member tables themselves hold no email, UPI, phone or password columns', async () => {
    await users.asAdmin();
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name in ('trips', 'trip_members')`,
    );
    for (const c of r.rows.map((x) => x.column_name.toLowerCase())) {
      expect(c).not.toMatch(/email|upi|phone|password|token|secret/);
    }
  });

  it('the profile permissions are exactly as approved in M2 (still own-row only)', async () => {
    await users.asUser(ravi);
    expect((await db.query('select id from public.profiles')).rows).toHaveLength(1);
    await expect(db.query(`update public.profiles set display_name = 'x' where id = $1`, [asha])).resolves.toMatchObject({ affectedRows: 0 });
  });
});

describe('the read adds no new way in', () => {
  it('no database function or permission was added for it: reads rely on the existing rules only', async () => {
    await users.asAdmin();
    const fns = (await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`,
    )).rows.map((r) => r.proname);
    // M3.1 had create_trip + is_trip_member. M3.3 deliberately added exactly update_trip + set_trip_archived
    // (reviewed in security-audit.test.ts). Reading a trip still uses none of them.
    expect(fns).toEqual(['create_trip', 'is_trip_member', 'set_trip_archived', 'update_trip']);
  });

  it('the details read still cannot be used to change anything', async () => {
    await users.asUser(asha);
    await expect(db.query(`update public.trips set name = 'hacked' where id = $1`, [goa])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update public.trip_members set role = 'admin' where trip_id = $1`, [goa])).rejects.toThrow(/permission denied/i);
  });
});
