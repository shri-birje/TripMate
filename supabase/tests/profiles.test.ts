import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tests the REAL migration SQL against a real Postgres engine (PGlite, running
 * inside Node, no Docker needed).
 *
 * Supabase provides some things we have to imitate here: the `anon` and
 * `authenticated` roles, the auth.users table, auth.uid(), and its habit of
 * granting broad default permissions on new tables (our migration must remove
 * those, so we reproduce them to prove it does).
 *
 * "Acting as" a user = switching to the `authenticated` role and setting the
 * same session value Supabase sets from a login token.
 */
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../migrations/20261118000000_profiles.sql', import.meta.url)),
  'utf8',
);

const SUPABASE_STAND_IN = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  -- Supabase's generous defaults, which the migration has to tighten:
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

let db: PGlite;

const asAdmin = () => db.exec('reset role');
const asAnon = () => db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub', '', false)`);
const asUser = (id: string) =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false)`);

async function signUp(email: string | null, meta: Record<string, unknown> | null = null): Promise<string> {
  await asAdmin();
  const r = await db.query<{ id: string }>(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
    [email, meta === null ? null : JSON.stringify(meta)],
  );
  return r.rows[0]!.id;
}

async function profileOf(id: string) {
  await asAdmin();
  const r = await db.query<Record<string, any>>('select * from public.profiles where id = $1', [id]);
  return r.rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STAND_IN);
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe('migration', () => {
  it('can be run a second time without errors (safe to re-run)', async () => {
    await asAdmin();
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });
});

describe('accounts that existed before the migration', () => {
  it('get a profile from the backfill, and keep an existing one untouched', async () => {
    const old = new PGlite();
    await old.exec(SUPABASE_STAND_IN);
    // Two accounts exist before the profiles table does:
    await old.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('11111111-1111-1111-1111-111111111111', 'early@example.com', '{"display_name":"Early Bird"}'),
        ('22222222-2222-2222-2222-222222222222', 'plain@example.com', null);
    `);
    await old.exec(MIGRATION);
    const rows = (await old.query<{ id: string; display_name: string }>('select id, display_name from public.profiles order by id')).rows;
    expect(rows.map((r) => r.display_name)).toEqual(['Early Bird', 'plain']);

    // Running the migration again must not overwrite or duplicate anything.
    await old.exec(`update public.profiles set display_name = 'Edited' where id = '11111111-1111-1111-1111-111111111111'`);
    await old.exec(MIGRATION);
    const again = (await old.query<{ display_name: string }>('select display_name from public.profiles order by id')).rows;
    expect(again.map((r) => r.display_name)).toEqual(['Edited', 'plain']);
    await old.close();
  });
});

describe('profile creation at sign-up', () => {
  it('creates a profile with the chosen name and safe defaults (theme = light)', async () => {
    const id = await signUp('asha@example.com', { display_name: 'Asha Rao' });
    const p = await profileOf(id);
    expect(p).toMatchObject({
      display_name: 'Asha Rao',
      theme_preference: 'light',
      preferred_currency: 'INR',
      upi_id: null,
      avatar_path: null,
      deleted_at: null,
    });
  });

  it('falls back to the email name when no display name is given', async () => {
    expect((await profileOf(await signUp('ravi.k@example.com', {})))!.display_name).toBe('ravi.k');
    expect((await profileOf(await signUp('meera@example.com', null)))!.display_name).toBe('meera');
    expect((await profileOf(await signUp('kiran@example.com', { display_name: '   ' })))!.display_name).toBe('kiran');
  });

  it('falls back to "Traveller" when there is nothing to use', async () => {
    expect((await profileOf(await signUp(null, null)))!.display_name).toBe('Traveller');
  });

  it('trims over-long names to 60 characters instead of failing the sign-up', async () => {
    const id = await signUp('long@example.com', { display_name: 'x'.repeat(200) });
    expect((await profileOf(id))!.display_name).toHaveLength(60);
  });
});

describe('who can read profiles (row-level security)', () => {
  it('a signed-in user sees their own profile and nobody else\'s', async () => {
    const a = await signUp('a1@example.com', { display_name: 'Alpha' });
    const b = await signUp('b1@example.com', { display_name: 'Bravo' });

    await asUser(a);
    const rows = (await db.query<{ id: string }>('select id from public.profiles where id in ($1, $2)', [a, b])).rows;
    expect(rows.map((r) => r.id)).toEqual([a]);

    await asUser(b);
    const mine = (await db.query<{ display_name: string }>('select display_name from public.profiles where id in ($1, $2)', [a, b])).rows;
    expect(mine).toEqual([{ display_name: 'Bravo' }]);
  });

  it('a signed-in user selecting everything still only gets their own row', async () => {
    const a = await signUp('a2@example.com');
    await signUp('b2@example.com');
    await asUser(a);
    const rows = (await db.query('select id from public.profiles')).rows;
    expect(rows).toHaveLength(1);
  });

  it('a signed-out visitor is denied outright', async () => {
    await asAnon();
    await expect(db.query('select * from public.profiles')).rejects.toThrow(/permission denied/i);
  });
});

describe('who can create or delete profiles', () => {
  it('nobody can insert a profile from the app, not even for themselves', async () => {
    const id = await signUp('c1@example.com');
    await asUser(id);
    await expect(
      db.query(`insert into public.profiles (id, display_name) values (gen_random_uuid(), 'sneaky')`),
    ).rejects.toThrow(/permission denied/i);
    await asAnon();
    await expect(
      db.query(`insert into public.profiles (id, display_name) values (gen_random_uuid(), 'sneaky')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('nobody can delete a profile from the app', async () => {
    const id = await signUp('c2@example.com');
    await asUser(id);
    await expect(db.query('delete from public.profiles where id = $1', [id])).rejects.toThrow(/permission denied/i);
    expect(await profileOf(id)).toBeDefined();
  });

  it('deleting the account removes the profile automatically', async () => {
    const id = await signUp('c3@example.com');
    await asAdmin();
    await db.query('delete from auth.users where id = $1', [id]);
    expect(await profileOf(id)).toBeUndefined();
  });

  it('the sign-up helper functions cannot be called by app users', async () => {
    const id = await signUp('c4@example.com');
    await asUser(id);
    await expect(db.query('select public.handle_new_user()')).rejects.toThrow(/permission denied/i);
    await expect(db.query('select public.set_updated_at()')).rejects.toThrow(/permission denied/i);
  });
});

describe('editing a profile', () => {
  it('a user can edit all their editable fields', async () => {
    const id = await signUp('d1@example.com', { display_name: 'Before' });
    await asUser(id);
    const r = await db.query(
      `update public.profiles
          set display_name = 'After', upi_id = 'shri@okhdfcbank', preferred_currency = 'USD',
              theme_preference = 'dark', avatar_path = 'avatars/x.png'
        where id = $1`,
      [id],
    );
    expect(r.affectedRows).toBe(1);
    expect(await profileOf(id)).toMatchObject({
      display_name: 'After',
      upi_id: 'shri@okhdfcbank',
      preferred_currency: 'USD',
      theme_preference: 'dark',
      avatar_path: 'avatars/x.png',
    });
  });

  it('the database stamps updated_at itself', async () => {
    const id = await signUp('d2@example.com');
    const before = await profileOf(id);
    await new Promise((r) => setTimeout(r, 15));
    await asUser(id);
    await db.query(`update public.profiles set display_name = 'Changed' where id = $1`, [id]);
    const after = await profileOf(id);
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
    expect(after!.created_at.getTime()).toBe(before!.created_at.getTime());
  });

  it('a user cannot edit someone else\'s profile (zero rows change)', async () => {
    const victim = await signUp('d3@example.com', { display_name: 'Victim' });
    const attacker = await signUp('d4@example.com', { display_name: 'Attacker' });
    await asUser(attacker);
    const r = await db.query(`update public.profiles set display_name = 'Hacked' where id = $1`, [victim]);
    expect(r.affectedRows).toBe(0);
    expect((await profileOf(victim))!.display_name).toBe('Victim');
  });

  it('a user cannot hand their own row to someone else or change protected columns', async () => {
    const a = await signUp('d5@example.com');
    const b = await signUp('d6@example.com');
    await asUser(a);
    await expect(db.query(`update public.profiles set id = $2 where id = $1`, [a, b])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update public.profiles set created_at = now() where id = $1`, [a])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update public.profiles set deleted_at = now() where id = $1`, [a])).rejects.toThrow(/permission denied/i);
    await expect(db.query(`update public.profiles set updated_at = '2000-01-01' where id = $1`, [a])).rejects.toThrow(/permission denied/i);
  });

  it('a signed-out visitor cannot edit anything', async () => {
    const id = await signUp('d7@example.com');
    await asAnon();
    await expect(db.query(`update public.profiles set display_name = 'x' where id = $1`, [id])).rejects.toThrow(/permission denied/i);
  });
});

describe('data rules the database enforces on its own', () => {
  async function editAs(id: string, setClause: string) {
    await asUser(id);
    return db.query(`update public.profiles set ${setClause} where id = $1`, [id]);
  }

  it('rejects an unknown theme', async () => {
    const id = await signUp('e1@example.com');
    await expect(editAs(id, `theme_preference = 'neon'`)).rejects.toThrow(/profiles_theme_values/);
  });

  it('accepts each of light, dark and system', async () => {
    const id = await signUp('e2@example.com');
    for (const t of ['dark', 'system', 'light']) {
      await expect(editAs(id, `theme_preference = '${t}'`)).resolves.toBeDefined();
    }
  });

  it('rejects an empty or 61-character name', async () => {
    const id = await signUp('e3@example.com');
    await expect(editAs(id, `display_name = ''`)).rejects.toThrow(/profiles_display_name_length/);
    await expect(editAs(id, `display_name = '${'y'.repeat(61)}'`)).rejects.toThrow(/profiles_display_name_length/);
    await expect(editAs(id, `display_name = '${'y'.repeat(60)}'`)).resolves.toBeDefined();
  });

  it('rejects a malformed currency', async () => {
    const id = await signUp('e4@example.com');
    await expect(editAs(id, `preferred_currency = 'inr'`)).rejects.toThrow(/profiles_currency_format/);
    await expect(editAs(id, `preferred_currency = 'RS'`)).rejects.toThrow();
  });

  it('accepts good UPI IDs and rejects bad ones; null clears it', async () => {
    const id = await signUp('e5@example.com');
    for (const ok of ['shri@okhdfcbank', 'asha.rao-1@ybl', '9876543210@paytm']) {
      await expect(editAs(id, `upi_id = '${ok}'`)).resolves.toBeDefined();
    }
    for (const bad of ['nope', '@ybl', 'a@b', 'has space@ybl', 'x@y@z', 'ab@1bank']) {
      await expect(editAs(id, `upi_id = '${bad}'`)).rejects.toThrow(/profiles_upi_id_format/);
    }
    await expect(editAs(id, `upi_id = null`)).resolves.toBeDefined();
  });
});
