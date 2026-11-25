/**
 * Checks that TripMate is correctly connected to Supabase.
 *
 *   npm run verify:supabase
 *
 * SAFETY: this script only ever uses the PUBLISHABLE key (the same key the
 * app uses). It never prints the key. It refuses to run if it finds a secret
 * key. It makes no changes to your data.
 */
import { readSupabaseConfig } from '../apps/app/src/lib/supabaseConfig';

const TIMEOUT_MS = 10_000;
let failures = 0;
let warnings = 0;

const ok = (msg: string) => console.log(`  OK    ${msg}`);
const warn = (msg: string) => {
  warnings++;
  console.log(`  WARN  ${msg}`);
};
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

async function call(url: string, key: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* some responses have no JSON body */
  }
  return { status: res.status, body: body as Record<string, any> | null };
}

async function main() {
  console.log('\n1. Configuration (apps/app/.env)');
  const cfg = readSupabaseConfig({
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!cfg.ok) {
    fail(cfg.message);
    return;
  }
  ok(`URL looks right: ${new URL(cfg.url).host}`);
  ok(`Key type: ${cfg.keyKind === 'publishable' ? 'publishable (correct)' : 'legacy anon (works, but prefer the new publishable key)'}`);

  console.log('\n2. Reaching Supabase Auth');
  try {
    const health = await call(`${cfg.url}/auth/v1/health`, cfg.key);
    if (health.status === 200) ok('Auth service is up and accepted the key');
    else if (health.status === 401 || health.status === 403) fail(`Auth service rejected the key (HTTP ${health.status}). Check you copied the PUBLISHABLE key from the right project.`);
    else fail(`Auth health returned HTTP ${health.status}`);

    const settings = await call(`${cfg.url}/auth/v1/settings`, cfg.key);
    if (settings.status === 200 && settings.body) {
      const s = settings.body;
      const emailOn = s.external?.email !== false;
      emailOn ? ok('Email sign-up/sign-in is enabled') : fail('Email provider is disabled (Authentication -> Sign In / Providers -> Email)');
      s.disable_signup ? fail('New sign-ups are disabled in your project') : ok('New sign-ups are allowed');
      if (s.mailer_autoconfirm) {
        warn('Email confirmation is OFF: anyone can sign up with any email without proving they own it. Fine for early testing; turn it on before real users.');
      } else {
        ok('Email confirmation is ON (users must click the link in their email)');
      }
      ok(`Google sign-in: ${s.external?.google ? 'enabled' : 'not enabled (not needed for M2)'}`);
    } else {
      warn(`Could not read auth settings (HTTP ${settings.status})`);
    }
  } catch (e) {
    fail(`Could not reach Supabase: ${e instanceof Error ? e.name : 'error'} (check your internet connection and the project URL)`);
    return;
  }

  console.log('\n3. Database: profiles table and its security rules');
  try {
    const read = await call(`${cfg.url}/rest/v1/profiles?select=id&limit=1`, cfg.key);
    const code = (read.body?.code as string | undefined) ?? '';
    if (read.status === 404 || code === 'PGRST205' || code === '42P01') {
      warn('The profiles table does not exist yet. Run supabase/migrations/20261118000000_profiles.sql in the Supabase SQL Editor (see docs).');
      await checkTrips(cfg.url, cfg.key);
      return;
    }
    if (read.status === 200 && Array.isArray(read.body) && read.body.length === 0) {
      ok('profiles exists and a signed-out visitor sees no rows');
    } else if (read.status === 200) {
      fail('A signed-out visitor can READ profile rows. Row-level security is not set up correctly!');
    } else if (read.status === 401 || read.status === 403 || code === '42501') {
      ok('profiles exists and signed-out visitors are denied access');
    } else {
      warn(`Unexpected answer reading profiles (HTTP ${read.status}, code ${code || 'none'})`);
    }

    const write = await call(`${cfg.url}/rest/v1/profiles`, cfg.key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000000', display_name: 'probe' }),
    });
    if (write.status >= 200 && write.status < 300) fail('A signed-out visitor could INSERT a profile row. Security rules are wrong!');
    else ok(`Signed-out visitors cannot create profiles (HTTP ${write.status})`);
    await checkTrips(cfg.url, cfg.key);
  } catch (e) {
    fail(`Database check failed: ${e instanceof Error ? e.name : 'error'}`);
  }
}

/** Section 4: the trips tables and create_trip(), checked from the outside as a signed-out visitor. */
async function checkTrips(url: string, key: string) {
  console.log('\n4. Database: trips, members and create_trip()');
  const MIGRATION = 'supabase/migrations/20261118100000_trips_and_members.sql';
  try {
    for (const table of ['trips', 'trip_members']) {
      const read = await call(`${url}/rest/v1/${table}?select=id&limit=1`, key);
      const code = (read.body?.code as string | undefined) ?? '';
      if (read.status === 404 || code === 'PGRST205' || code === '42P01') {
        warn(`The ${table} table does not exist yet. Run ${MIGRATION} in the Supabase SQL Editor.`);
        return;
      }
      if (read.status === 200 && Array.isArray(read.body) && read.body.length === 0) ok(`${table} exists and a signed-out visitor sees no rows`);
      else if (read.status === 200) fail(`A signed-out visitor can READ ${table} rows. Row-level security is wrong!`);
      else if (read.status === 401 || read.status === 403 || code === '42501') ok(`${table} exists and signed-out visitors are denied access`);
      else warn(`Unexpected answer reading ${table} (HTTP ${read.status}, code ${code || 'none'})`);
    }

    const insert = await call(`${url}/rest/v1/trips`, key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ name: 'probe', destination: 'probe', start_date: '2030-01-01', end_date: '2030-01-02', created_by: '00000000-0000-0000-0000-000000000000' }),
    });
    if (insert.status >= 200 && insert.status < 300) fail('A signed-out visitor could INSERT a trip directly. Security rules are wrong!');
    else ok(`Nobody can insert a trip directly (HTTP ${insert.status})`);

    // The function must refuse a signed-out caller. It cannot create anything even if it ran (no signed-in user),
    // so this probe is safe. The best answer is "permission denied" (42501): the function is not even callable.
    const rpc = await call(`${url}/rest/v1/rpc/create_trip`, key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_name: 'probe', p_destination: 'probe', p_start_date: '2030-01-01', p_end_date: '2030-01-02' }),
    });
    const rpcCode = (rpc.body?.code as string | undefined) ?? '';
    if (rpc.status >= 200 && rpc.status < 300) fail('A signed-out visitor could RUN create_trip. Security rules are wrong!');
    else if (rpc.status === 404 || rpcCode === 'PGRST202') warn(`create_trip() does not exist yet. Run ${MIGRATION} in the Supabase SQL Editor.`);
    else if (rpcCode === '42501') ok('create_trip() cannot be run by signed-out visitors (permission denied)');
    else warn(`create_trip() refused a signed-out visitor, but with an unexpected code (HTTP ${rpc.status}, ${rpcCode || 'none'})`);

    // ---- Milestone M3.3: edit / archive / restore, and the internal helper. None may run for a signed-out visitor.
    // (Nothing can change: with no signed-in user these functions refuse before touching any data.)
    const EDIT_MIGRATION = 'supabase/migrations/20261118200000_trip_edit_archive.sql';
    const nobody = '00000000-0000-4000-8000-000000000000';
    const MEMBER_MIGRATION = 'supabase/migrations/20261118300000_member_management.sql';
    const INVITE_MIGRATION = 'supabase/migrations/20261118400000_invitations.sql';
    const JOIN_MIGRATION = 'supabase/migrations/20261123000000_join_requests.sql';
    const LINK_MIGRATION = 'supabase/migrations/20261123100000_reusable_general_link.sql';
    const EXPENSE_MIGRATION = 'supabase/migrations/20261123200000_expenses.sql';
    const SPLIT_MIGRATION = 'supabase/migrations/20261125000000_expense_split_methods.sql';
    const probes: { name: string; args: Record<string, unknown>; mustBeClosed: boolean; migration?: string }[] = [
      { name: 'update_trip', args: { p_trip_id: nobody, p_expected_version: 1, p_name: 'x', p_destination: 'y', p_start_date: '2030-01-01', p_end_date: '2030-01-02' }, mustBeClosed: true },
      { name: 'set_trip_archived', args: { p_trip_id: nobody, p_archived: true, p_expected_version: 1 }, mustBeClosed: true },
      { name: 'trip_role_of', args: { p_trip_id: nobody, p_user_id: nobody }, mustBeClosed: true },
      // ---- Milestone M3.4: people and roles. The six functions and the internal helpers: none may run for a signed-out visitor.
      { name: 'list_trip_members', args: { p_trip_id: nobody }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'add_guest_member', args: { p_trip_id: nobody, p_display_name: 'x' }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'rename_guest_member', args: { p_trip_id: nobody, p_member_id: nobody, p_display_name: 'x' }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'set_member_role', args: { p_trip_id: nobody, p_member_id: nobody, p_role: 'member', p_expected_role: 'member' }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'remove_member', args: { p_trip_id: nobody, p_member_id: nobody }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'leave_trip', args: { p_trip_id: nobody }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      { name: 'member_change_context', args: { p_trip_id: nobody, p_uid: nobody, p_need_admin: false, p_allow_archived: false }, mustBeClosed: true, migration: MEMBER_MIGRATION },
      // ---- Milestone M3.5: invitations. All closed to signed-out visitors EXCEPT preview_invite (checked separately below).
      { name: 'create_invite', args: { p_trip_id: nobody }, mustBeClosed: true, migration: INVITE_MIGRATION },
      { name: 'list_trip_invites', args: { p_trip_id: nobody }, mustBeClosed: true, migration: INVITE_MIGRATION },
      { name: 'revoke_invite', args: { p_trip_id: nobody, p_invite_id: nobody }, mustBeClosed: true, migration: INVITE_MIGRATION },
      { name: 'invite_token_hash', args: { p_token: 'x' }, mustBeClosed: true, migration: INVITE_MIGRATION },
      // ---- Milestone M3.5 revision: approval-based joining. Closed to signed-out visitors.
      { name: 'request_to_join', args: { p_token: 'f'.repeat(64) }, mustBeClosed: true, migration: JOIN_MIGRATION },
      { name: 'list_join_requests', args: { p_trip_id: nobody }, mustBeClosed: true, migration: JOIN_MIGRATION },
      { name: 'decide_join_request', args: { p_trip_id: nobody, p_request_id: nobody, p_approve: true }, mustBeClosed: true, migration: JOIN_MIGRATION },
      // ---- Milestone M3.5 UX finalisation: Copy link. Closed to signed-out visitors (an administrator's call only).
      { name: 'get_general_invite_link', args: { p_trip_id: nobody }, mustBeClosed: true, migration: LINK_MIGRATION },
      // ---- Milestone M5 (Checkpoint 1): expenses. Every one is closed to signed-out visitors.
      { name: 'create_expense', args: { p_trip_id: nobody, p_expense_id: nobody, p_title: 'x', p_amount_minor: 1, p_spent_on: '2026-01-01', p_category_key: null, p_notes: null, p_split_method: 'equal', p_participants: [], p_payers: [] }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      { name: 'update_expense', args: { p_trip_id: nobody, p_expense_id: nobody, p_expected_version: 1, p_title: 'x', p_amount_minor: 1, p_spent_on: '2026-01-01', p_category_key: null, p_notes: null, p_split_method: 'equal', p_participants: [], p_payers: [] }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      { name: 'delete_expense', args: { p_trip_id: nobody, p_expense_id: nobody, p_expected_version: 1 }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      { name: 'restore_expense', args: { p_trip_id: nobody, p_expense_id: nobody, p_expected_version: 1 }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      { name: 'trip_member_balances', args: { p_trip_id: nobody }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      { name: 'allocate_equal', args: { p_total: 1, p_member_ids: [] }, mustBeClosed: true, migration: EXPENSE_MIGRATION },
      // ---- Milestone M5 (Checkpoint 5): split methods. Internal helpers, closed to everyone.
      { name: 'allocate_weighted', args: { p_total: 1, p_member_ids: [], p_weights: [] }, mustBeClosed: true, migration: SPLIT_MIGRATION },
      { name: 'expense_derive_shares', args: { p_method: 'equal', p_total: 1, p_ids: [], p_values: [] }, mustBeClosed: true, migration: SPLIT_MIGRATION },
      // (The Checkpoint 2 guards, migrations 20261124000000 and 20261124100000, are TRIGGER functions. The API never exposes trigger functions,
      //  so they cannot be probed from outside: they are checked with the read-only SQL in SUPABASE_SETUP.md instead.)
    ];
    for (const probe of probes) {
      const r = await call(`${url}/rest/v1/rpc/${probe.name}`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe.args) });
      const c = (r.body?.code as string | undefined) ?? '';
      if (r.status >= 200 && r.status < 300) fail(`A signed-out visitor could RUN ${probe.name}(). Security rules are wrong!`);
      else if (c === '42501') ok(`${probe.name}() cannot be run by signed-out visitors (permission denied)`);
      else if (r.status === 404 || c === 'PGRST202') warn(`${probe.name}() is not available yet. Run ${probe.migration ?? EDIT_MIGRATION} in the Supabase SQL Editor (${probe.migration === JOIN_MIGRATION ? 'approval-based joining' : probe.migration === INVITE_MIGRATION ? 'invitations' : probe.migration ? 'managing people' : 'trip editing and archiving'} needs it).`);
      else warn(`${probe.name}() refused a signed-out visitor, but with an unexpected code (HTTP ${r.status}, ${c || 'none'})`);
    }

    // ---- The expense tables (Milestone M5): they must exist after migration 20261123200000 and give a signed-out visitor nothing.
    for (const table of ['categories', 'expenses', 'expense_payers', 'expense_splits', 'expense_revisions']) {
      const read = await call(`${url}/rest/v1/${table}?select=*&limit=1`, key);
      const code = (read.body?.code as string | undefined) ?? '';
      if (read.status === 404 || code === 'PGRST205' || code === '42P01') warn(`The ${table} table does not exist yet. Run ${EXPENSE_MIGRATION} in the Supabase SQL Editor.`);
      else if (read.status === 200 && Array.isArray(read.body) && read.body.length === 0) ok(`${table} exists and a signed-out visitor sees no rows`);
      else if (read.status === 200) fail(`A signed-out visitor can READ ${table} rows. Row-level security is wrong!`);
      else if (read.status === 401 || read.status === 403 || code === '42501') ok(`${table} exists and signed-out visitors are denied access`);
      else warn(`Unexpected answer reading ${table} (HTTP ${read.status}, code ${code || 'none'})`);
    }

    // ---- accept_invite() used to let a link make someone a member at once. It must be GONE once migration 20261123000000 is applied.
    const accept = await call(`${url}/rest/v1/rpc/accept_invite`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: 'f'.repeat(64) }) });
    const acceptCode = (accept.body?.code as string | undefined) ?? '';
    if (accept.status >= 200 && accept.status < 300) fail('A signed-out visitor could RUN accept_invite(). Security rules are wrong!');
    else if (accept.status === 404 || acceptCode === 'PGRST202') ok('accept_invite() no longer exists: a link can only make a join request, never a member');
    else warn(`accept_invite() still exists, so a link could still add a member at once. Run ${JOIN_MIGRATION} in the Supabase SQL Editor (approval-based joining needs it).`);

    // ---- preview_invite is the ONE function a signed-out visitor may run. It must work, and must answer an unknown token with an EMPTY list (not an error, not a hint).
    const preview = await call(`${url}/rest/v1/rpc/preview_invite`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: 'f'.repeat(64) }) });
    const previewCode = (preview.body?.code as string | undefined) ?? '';
    if (preview.status === 404 || previewCode === 'PGRST202') warn(`preview_invite() is not available yet. Run ${INVITE_MIGRATION} in the Supabase SQL Editor (invitations need it).`);
    else if (preview.status === 200 && Array.isArray(preview.body) && preview.body.length === 0) ok('preview_invite() is open to signed-out visitors by design, and gives an empty answer for an unknown link');
    else if (preview.status === 200) fail('preview_invite() returned data for a made-up link. Security rules are wrong!');
    else warn(`preview_invite() answered unexpectedly (HTTP ${preview.status}, ${previewCode || 'none'})`);
  } catch (e) {
    fail(`Trips check failed: ${e instanceof Error ? e.name : 'error'}`);
  }
}

main()
  .catch((e) => fail(`Unexpected error: ${e instanceof Error ? e.message : 'unknown'}`))
  .finally(() => {
    console.log(`\nResult: ${failures === 0 ? 'PASSED' : 'FAILED'} (${failures} failure(s), ${warnings} warning(s))\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
