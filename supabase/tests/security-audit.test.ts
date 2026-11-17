import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDatabase } from './harness';

/**
 * SECURITY AUDIT of the whole database, run against ALL migrations.
 *
 * These tests turn the approved rules of ADR-032 into automatic checks, so that
 * every migration added in the future is held to them too. If a future change
 * breaks one of these rules, this file fails and the change cannot be approved
 * by accident.
 *
 *  1. Row-Level Security is on for every table.
 *  2. Signed-out visitors (anon / PUBLIC) have no table permissions at all.
 *  3. Signed-in users have no table-level write permissions. Changes happen
 *     only through database functions (or a few named, harmless columns).
 *  4. Every SECURITY DEFINER function pins its search_path.
 *  5. No function is runnable by signed-out visitors or by "everyone" (PUBLIC).
 *  6. Every SECURITY DEFINER function that a signed-in user can run identifies
 *     the caller with auth.uid().
 *  7. The list of functions a signed-in user can run is an explicit allow-list:
 *     adding a new one forces a conscious update here (a security review).
 */
let db: PGlite;

/** Functions that signed-in users are allowed to run. Add a name here ONLY after reviewing the function. */
const ALLOWED_CALLABLE_FUNCTIONS = ['create_trip', 'is_trip_member'];

/** Column-level UPDATE rights a signed-in user may have (table -> columns). */
const ALLOWED_COLUMN_UPDATES: Record<string, string[]> = {
  profiles: ['avatar_path', 'display_name', 'preferred_currency', 'theme_preference', 'upi_id'],
};

interface Fn {
  name: string;
  secdef: boolean;
  config: string[] | null;
  acl: string | null;
  body: string;
  anonCanRun: boolean;
  authedCanRun: boolean;
}

async function functions(): Promise<Fn[]> {
  const r = await db.query<{
    name: string;
    secdef: boolean;
    config: string[] | null;
    acl: string | null;
    body: string;
    anon_can_run: boolean;
    authed_can_run: boolean;
  }>(`
    select p.proname as name,
           p.prosecdef as secdef,
           p.proconfig as config,
           p.proacl::text as acl,
           p.prosrc as body,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_run,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed_can_run
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     order by p.proname`);
  return r.rows.map((x) => ({
    name: x.name,
    secdef: x.secdef,
    config: x.config,
    acl: x.acl,
    body: x.body,
    anonCanRun: x.anon_can_run,
    authedCanRun: x.authed_can_run,
  }));
}

beforeAll(async () => {
  db = await newDatabase();
});
afterAll(async () => {
  await db.close();
});

describe('tables', () => {
  it('has at least the expected tables (so the audit is not passing on an empty database)', async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(expect.arrayContaining(['profiles', 'trips', 'trip_members']));
  });

  it('1. Row-Level Security is switched on for every table', async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });

  it('2. signed-out visitors have no permission on any table', async () => {
    const r = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'PUBLIC')`,
    );
    expect(r.rows).toEqual([]);
    const cols = await db.query(
      `select table_name, column_name from information_schema.role_column_grants where table_schema = 'public' and grantee in ('anon', 'PUBLIC')`,
    );
    expect(cols.rows).toEqual([]);
  });

  it('3. signed-in users cannot insert, delete or truncate anywhere, nor update a whole table', async () => {
    const r = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'`,
    );
    expect(r.rows).toEqual([]);
  });

  it('3b. signed-in users can update only the named, harmless columns', async () => {
    const r = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.role_column_grants
        where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'UPDATE'
        order by 1, 2`,
    );
    const actual: Record<string, string[]> = {};
    for (const row of r.rows) (actual[row.table_name] ??= []).push(row.column_name);
    expect(actual).toEqual(ALLOWED_COLUMN_UPDATES);
  });
});

describe('functions', () => {
  it('finds the functions it is meant to audit', async () => {
    const names = (await functions()).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['create_trip', 'is_trip_member', 'handle_new_user', 'set_updated_at']));
  });

  it('4. every SECURITY DEFINER function pins its search_path', async () => {
    const unsafe = (await functions()).filter((f) => f.secdef && !(f.config ?? []).some((c) => c.startsWith('search_path=')));
    expect(unsafe.map((f) => f.name)).toEqual([]);
  });

  it('4b. every function (definer or not) pins its search_path', async () => {
    const loose = (await functions()).filter((f) => !(f.config ?? []).some((c) => c.startsWith('search_path=')));
    expect(loose.map((f) => f.name)).toEqual([]);
  });

  it('5. no function can be run by signed-out visitors or by PUBLIC', async () => {
    const fns = await functions();
    expect(fns.filter((f) => f.anonCanRun).map((f) => f.name)).toEqual([]);
    // A NULL permission list means "default", which includes PUBLIC. An entry starting with "=" is PUBLIC.
    expect(fns.filter((f) => f.acl === null || /(^|[{,])=X\//.test(f.acl)).map((f) => f.name)).toEqual([]);
  });

  it('6. every SECURITY DEFINER function a signed-in user can run identifies the caller with auth.uid()', async () => {
    const missing = (await functions())
      .filter((f) => f.secdef && f.authedCanRun && !/auth\.uid\(\)/.test(f.body))
      .map((f) => f.name);
    expect(missing).toEqual([]);
  });

  it('7. the functions a signed-in user can run are exactly the reviewed allow-list', async () => {
    const callable = (await functions()).filter((f) => f.authedCanRun).map((f) => f.name);
    expect(callable.sort()).toEqual([...ALLOWED_CALLABLE_FUNCTIONS].sort());
  });

  it('internal helper functions cannot be run by signed-in users either', async () => {
    const fns = await functions();
    for (const name of ['handle_new_user', 'set_updated_at']) {
      expect(fns.find((f) => f.name === name)!.authedCanRun).toBe(false);
    }
  });
});
