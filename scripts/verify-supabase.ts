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
    const probes: { name: string; args: Record<string, unknown>; mustBeClosed: boolean }[] = [
      { name: 'update_trip', args: { p_trip_id: nobody, p_expected_version: 1, p_name: 'x', p_destination: 'y', p_start_date: '2030-01-01', p_end_date: '2030-01-02' }, mustBeClosed: true },
      { name: 'set_trip_archived', args: { p_trip_id: nobody, p_archived: true, p_expected_version: 1 }, mustBeClosed: true },
      { name: 'trip_role_of', args: { p_trip_id: nobody, p_user_id: nobody }, mustBeClosed: true },
    ];
    for (const probe of probes) {
      const r = await call(`${url}/rest/v1/rpc/${probe.name}`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe.args) });
      const c = (r.body?.code as string | undefined) ?? '';
      if (r.status >= 200 && r.status < 300) fail(`A signed-out visitor could RUN ${probe.name}(). Security rules are wrong!`);
      else if (c === '42501') ok(`${probe.name}() cannot be run by signed-out visitors (permission denied)`);
      else if (r.status === 404 || c === 'PGRST202') warn(`${probe.name}() is not available yet. Run ${EDIT_MIGRATION} in the Supabase SQL Editor (trip editing and archiving need it).`);
      else warn(`${probe.name}() refused a signed-out visitor, but with an unexpected code (HTTP ${r.status}, ${c || 'none'})`);
    }
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
