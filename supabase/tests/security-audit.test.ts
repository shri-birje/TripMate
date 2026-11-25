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
const ALLOWED_CALLABLE_FUNCTIONS = [
  'add_guest_member', 'create_expense', 'create_invite', 'create_trip', 'decide_join_request', 'delete_expense', 'get_general_invite_link', 'is_trip_member', 'leave_trip', 'list_join_requests',
  'list_trip_invites', 'list_trip_members', 'preview_invite', 'remove_member', 'rename_guest_member', 'request_to_join',
  'restore_expense', 'revoke_invite', 'set_member_role', 'set_trip_archived', 'trip_member_balances', 'update_expense', 'update_trip',
]; // set_trip_archived and update_trip reviewed for M3.3; the six member functions for M3.4; the invitation and join-request functions for M3.5 (approval-based, ADR-059); the four expense write functions and trip_member_balances for M5 (ADR-063)

/**
 * Functions that SIGNED-OUT visitors (anon) may run. Until M3.5 this list was empty. preview_invite is the one
 * deliberate exception (a person must be able to see what they are being invited to before they sign in). Add a name
 * here ONLY after a security review; ADR-054 makes edge rate limiting on it mandatory before public deployment.
 */
const ALLOWED_SIGNED_OUT_FUNCTIONS = ['preview_invite'];

/** The only columns the signed-out preview may ever return (no ids, no money, no people, no hashes). */
const PREVIEW_COLUMNS = 'trip_name text, destination text, start_date date, end_date date, inviter_name text, member_count integer, is_claim boolean, claim_name text';

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

describe('invitations table', () => {
  it('trip_invites and trip_join_requests have NO permission for anyone: not signed-out, not signed-in, not even to read', async () => {
    for (const table of ['trip_invites', 'trip_join_requests']) {
      const r = await db.query(
        `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = $1
           and grantee in ('anon', 'authenticated', 'PUBLIC')`, [table],
      );
      expect(r.rows, table).toEqual([]);
      const cols = await db.query(
        `select grantee from information_schema.role_column_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated', 'PUBLIC')`, [table],
      );
      expect(cols.rows, table).toEqual([]);
    }
  });
});

describe('the Vault (where the general link\'s token is kept encrypted)', () => {
  it('is closed to signed-in and signed-out visitors: no schema, table or view access of any kind', async () => {
    const r = await db.query<{ a: boolean; b: boolean; c: boolean; d: boolean; e: boolean; f: boolean }>(
      `select has_schema_privilege('anon', 'vault', 'USAGE') as a, has_schema_privilege('authenticated', 'vault', 'USAGE') as b,
              has_table_privilege('anon', 'vault.secrets', 'SELECT') as c, has_table_privilege('authenticated', 'vault.secrets', 'SELECT') as d,
              has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT') as e, has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') as f`,
    );
    expect(r.rows[0]).toEqual({ a: false, b: false, c: false, d: false, e: false, f: false });
  });

  it('only the reviewed functions touch it, and every one pins its search_path', async () => {
    const r = await db.query<{ name: string; secdef: boolean; config: string[] | null }>(
      `select p.proname as name, p.prosecdef as secdef, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ilike '%vault.%' order by 1`,
    );
    expect(r.rows.map((x) => x.name)).toEqual(['create_invite', 'get_general_invite_link', 'revoke_invite', 'trip_invites_remove_secret']);
    for (const f of r.rows) {
      expect(f.secdef, f.name).toBe(true);
      expect((f.config ?? []).some((c) => c.startsWith('search_path=')), f.name).toBe(true);
    }
  });

  it('only get_general_invite_link ever returns a token from it, and the clean-up trigger is closed to the app', async () => {
    const fns = await functions();
    const touching = fns.filter((f) => /vault\./i.test(f.body));
    const returnsTokens = touching.filter((f) => /decrypted_secret/i.test(f.body)).map((f) => f.name);
    expect(returnsTokens).toEqual(['get_general_invite_link']);
    expect(fns.find((f) => f.name === 'trip_invites_remove_secret')!.authedCanRun).toBe(false);
    expect(fns.find((f) => f.name === 'trip_invites_remove_secret')!.anonCanRun).toBe(false);
  });
});

describe('the expense tables (M5, ADR-063)', () => {
  const EXPENSE_TABLES = ['categories', 'expenses', 'expense_payers', 'expense_splits', 'expense_revisions'];

  it('exist, have row-level security, and signed-in users may only READ them (no write right and no write policy)', async () => {
    const t = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) order by 1`, [EXPENSE_TABLES]);
    expect(t.rows.map((r) => r.relname).sort()).toEqual([...EXPENSE_TABLES].sort());
    expect(t.rows.every((r) => r.relrowsecurity)).toBe(true);
    const grants = await db.query<{ table_name: string; privilege_type: string; grantee: string }>(
      `select table_name, privilege_type, grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1, 2, 3`, [EXPENSE_TABLES]);
    expect(grants.rows.every((g) => g.grantee === 'authenticated' && g.privilege_type === 'SELECT')).toBe(true);
    expect(new Set(grants.rows.map((g) => g.table_name))).toEqual(new Set(EXPENSE_TABLES));
    const policies = await db.query<{ tablename: string; cmd: string }>(`select tablename, cmd from pg_policies where schemaname = 'public' and tablename = any($1)`, [EXPENSE_TABLES]);
    expect(policies.rows.every((p) => p.cmd === 'SELECT')).toBe(true);
  });

  it('only the reviewed functions write them, and only the four expense functions are callable', async () => {
    const fns = await functions();
    const writers = fns.filter((f) => /\b(insert\s+into|update|delete\s+from)\s+public\.(expenses|expense_payers|expense_splits|expense_revisions)\b/i.test(f.body)).map((f) => f.name).sort();
    expect(writers).toEqual(['create_expense', 'delete_expense', 'expense_record_revision', 'restore_expense', 'update_expense']);
    const callable = fns.filter((f) => f.authedCanRun && /expense/.test(f.name)).map((f) => f.name).sort();
    expect(callable).toEqual(['create_expense', 'delete_expense', 'restore_expense', 'update_expense']);
  });

  it('every internal helper and trigger function is closed to signed-in and signed-out callers', async () => {
    const internal = [
      'allocate_equal', 'member_net_minor', 'assert_member_settled', 'assert_expenses_within_dates', 'assert_former_members_settled',
      'trip_members_balance_guard', 'trips_dates_guard', 'expenses_check_category', 'check_expense_sums', 'expense_revisions_append_only',
      'expense_parse_payers', 'expense_check_shape', 'expense_check_state', 'expense_payers_json', 'expense_splits_json',
      'expense_canonical', 'expense_stored_canonical', 'expense_record_revision',
      'trips_currency_guard', 'expense_rows_member_guard', 'check_expense_equal_split',
      'allocate_weighted', 'expense_parse_split_inputs', 'expense_derive_shares', 'expense_derive_from_request', 'expense_splits_json_v2', 'check_expense_split_inputs',
    ];
    const fns = await functions();
    for (const name of internal) {
      const f = fns.find((x) => x.name === name);
      expect(f, name).toBeDefined();
      expect(f!.authedCanRun, name).toBe(false);
      expect(f!.anonCanRun, name).toBe(false);
    }
  });

  it('trip_member_balances identifies the caller and checks active membership of the REQUESTED trip itself (not row-level security alone)', async () => {
    const f = (await functions()).find((x) => x.name === 'trip_member_balances')!;
    expect(f.secdef).toBe(true);
    expect(f.body).toContain('auth.uid()');
    expect(f.body).toContain('trip_role_of(p_trip_id, v_uid)');
    expect(f.anonCanRun).toBe(false);
    expect(f.authedCanRun).toBe(true);
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

  it('5. no function can be run by signed-out visitors or by PUBLIC, except the reviewed signed-out allow-list', async () => {
    const fns = await functions();
    expect(fns.filter((f) => f.anonCanRun).map((f) => f.name)).toEqual(ALLOWED_SIGNED_OUT_FUNCTIONS);
    // A NULL permission list means "default", which includes PUBLIC. An entry starting with "=" is PUBLIC.
    expect(fns.filter((f) => f.acl === null || /(^|[{,])=X\//.test(f.acl)).map((f) => f.name)).toEqual([]);
  });

  it('6. every SECURITY DEFINER function a signed-in user can run identifies the caller with auth.uid()', async () => {
    const missing = (await functions())
      .filter((f) => f.secdef && f.authedCanRun && !ALLOWED_SIGNED_OUT_FUNCTIONS.includes(f.name) && !/auth\.uid\(\)/.test(f.body))
      .map((f) => f.name);
    expect(missing).toEqual([]);
  });

  it('6b. each signed-out function is held to its own stricter rules: validated token, fixed public columns, nothing else', async () => {
    for (const name of ALLOWED_SIGNED_OUT_FUNCTIONS) {
      const fn = (await functions()).find((f) => f.name === name)!;
      expect(fn.secdef).toBe(true);
      // it must check the token's hash, expiry, revocation and use count, and the trip's state
      for (const needle of ['token_hash', 'revoked_at is null', 'expires_at > now()', 'i.use_count = 0', "t.status = 'active'", '^[0-9a-f]{64}$']) {
        expect(fn.body, `${name} must contain: ${needle}`).toContain(needle);
      }
      // it must never reach for money, ids of people, or anything about accounts
      for (const forbidden of ['budget', 'auth.users', 'upi', 'email', 'profiles']) {
        expect(fn.body.toLowerCase(), `${name} must not touch: ${forbidden}`).not.toContain(forbidden);
      }
      const shape = (await db.query<{ r: string }>(`select pg_get_function_result(p.oid) as r from pg_proc p where p.proname = $1`, [name])).rows[0]!.r;
      expect(shape).toBe(`TABLE(${PREVIEW_COLUMNS})`);
    }
  });

  it('7. the functions a signed-in user can run are exactly the reviewed allow-list', async () => {
    const callable = (await functions()).filter((f) => f.authedCanRun).map((f) => f.name);
    expect(callable.sort()).toEqual([...ALLOWED_CALLABLE_FUNCTIONS].sort());
  });

  it('internal helper functions cannot be run by signed-in users either', async () => {
    const fns = await functions();
    for (const name of ['handle_new_user', 'set_updated_at', 'invite_token_hash']) {
      expect(fns.find((f) => f.name === name)!.authedCanRun).toBe(false);
    }
  });
});
