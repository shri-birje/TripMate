/**
 * Real-browser check of the app's account screens.
 *
 *   npm run ui:check
 *
 * What it does: starts the website, opens it in Microsoft Edge (headless) and
 * clicks through sign-up, sign-in, protected pages, the profile and the
 * Light/Dark/System theme.
 *
 * IMPORTANT - what is real and what is not:
 *   REAL:  the website, the screens, routing and route guards, forms and
 *          validation, theme logic, saving to this device, session persistence
 *          across reloads, and the exact requests the app sends.
 *   FAKED: Supabase's answers. Network calls to supabase.co are intercepted and
 *          answered by this script, so the tests are repeatable and send no
 *          real emails or accounts. Any request this script did NOT expect is
 *          blocked and counts as a failure.
 * It therefore proves the app behaves correctly GIVEN correct Supabase answers.
 * It does not prove your Supabase project is configured correctly - for that,
 * use `npm run verify:supabase` and the manual checklist in the docs.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Request, type Route } from 'playwright-core';
import { formatDateRange } from '../packages/core/src/trip';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const PROJECT_REF = 'uichecktestproject'; // a made-up project: the browser check never touches a real Supabase project
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const DUMMY_PUBLISHABLE_KEY = 'sb_publishable_dummy_key_for_ui_tests_only';
const FAKE_SECRET_KEY = 'sb_secret_FAKE_DO_NOT_USE_0000';
const SHOTS = process.env.UI_CHECK_SHOTS ?? path.join(process.cwd(), 'ui-check-screenshots');

const LIGHT_BG = 'rgb(246, 242, 233)';
const DARK_BG = 'rgb(18, 22, 20)';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

// --------------------------------------------------------------------------
// Start / stop the website
// --------------------------------------------------------------------------
async function startWebsite(env: Record<string, string>): Promise<{ stop: () => void }> {
  const child: ChildProcess = spawn('npx', ['expo', 'start', '--web', '--port', String(PORT), '--clear'], {
    cwd: path.join(process.cwd(), 'apps', 'app'),
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', ...env },
    shell: true,
    stdio: 'ignore',
  });
  const stop = () => {
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  };
  const deadline = Date.now() + 180_000;
  let html = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        html = await res.text();
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!html) {
    stop();
    throw new Error('The website did not start in time');
  }
  // Warm up: the first request makes the bundler compile everything.
  const bundle = /src="([^"]*bundle[^"]*)"/.exec(html)?.[1];
  if (bundle) await fetch(`${BASE}${bundle}`, { signal: AbortSignal.timeout(280_000) }).catch(() => {});
  return { stop };
}

// --------------------------------------------------------------------------
// Fake Supabase
// --------------------------------------------------------------------------
interface FakeBackend {
  profile: Record<string, unknown>;
  requests: { method: string; path: string; body: any; auth: string | undefined }[];
  /** Set to make profile PATCH calls fail like a dropped connection. */
  failProfileWrites: boolean;
  /** What the sign-in endpoint should answer. */
  signIn: 'ok' | 'invalid_credentials';
  unexpected: string[];
  /** The trips this person belongs to (what the trips list returns). */
  trips: Record<string, any>[];
  /** How the create_trip function should behave. */
  createMode: 'ok' | 'slow' | 'dates_error' | 'missing_function';
  /** Set to make the trips list fail like a dropped connection. */
  failTripsList: boolean;
  /** Set to make the single-trip (details) request fail like a dropped connection. */
  failDetails: boolean;
  /** Delay, in ms, before the details request is answered (to see the loading state). */
  slowDetailsMs: number;
  /** Force the edit/archive functions to answer with this database message (or drop the connection). */
  rpcFail: null | 'network' | 'not_admin' | 'trip_not_found' | 'trip_archived' | 'version_conflict';
  /** Delay, in ms, before the edit/archive functions answer (to test double taps). */
  slowRpcMs: number;
  /** Force the member functions (add, rename, role, remove, leave) to answer with this database message (or drop the connection). */
  memberFail: null | string;
  /** Delay, in ms, before the member functions answer (to test double taps). */
  slowMemberMs: number;
}

const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'asha@example.com', aud: 'authenticated', role: 'authenticated' };

function fakeJwt(): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: USER.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function sessionPayload() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { access_token: fakeJwt(), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'fake-refresh', user: USER };
}

function newBackend(): FakeBackend {
  return {
    profile: {
      id: USER.id,
      display_name: 'Asha Rao',
      upi_id: null,
      avatar_path: null,
      preferred_currency: 'INR',
      theme_preference: 'light',
      created_at: '2026-11-18T00:00:00Z',
      updated_at: '2026-11-18T00:00:00Z',
    },
    requests: [],
    failProfileWrites: false,
    signIn: 'ok',
    unexpected: [],
    trips: [],
    createMode: 'ok',
    failTripsList: false,
    failDetails: false,
    slowDetailsMs: 0,
    rpcFail: null,
    slowRpcMs: 0,
    memberFail: null,
    slowMemberMs: 0,
  };
}

/** The same trip id each time, in the strict format real trip ids have. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A member row as the database returns it for the details query. */
function memberRow(over: Record<string, any>): Record<string, any> {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    user_id: null,
    display_name: 'Someone',
    role: 'member',
    status: 'active',
    joined_at: '2026-11-18T10:00:00+00:00',
    left_at: null,
    ...over,
  };
}

/** Today's calendar day in a given time zone, as YYYY-MM-DD (what a person in that zone sees on their calendar). */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Adds days to a YYYY-MM-DD using pure calendar arithmetic. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A trip row exactly as the database would return it, with its member list for the trips query. */
function tripRow(over: Record<string, any>): Record<string, any> {
  return {
    id: `trip-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Trip',
    destination: 'Somewhere',
    start_date: '2030-01-01',
    end_date: '2030-01-03',
    description: null,
    budget_minor: null,
    currency: 'INR',
    cover_image_path: null,
    status: 'active',
    created_by: USER.id,
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
    version: 1,
    members: [{ id: 'member-1', status: 'active' }],
    // Underscore fields are the fake server's own notes and are never sent to the app.
    _members: [memberRow({ id: 'member-1', user_id: USER.id, display_name: 'Asha Rao', role: 'admin' })],
    _hidden: false,
    ...over,
  };
}

/** Removes the fake server's private notes before a row is sent. */
const publicRow = (row: Record<string, any>) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));

/** Calendar day relative to today, as YYYY-MM-DD in the browser's (local) calendar. */
function dayFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The same day written the way people type it in India: DD/MM/YYYY. */
const asDmy = (iso: string) => iso.split('-').reverse().join('/');

/** Counts the friends added through the fake add_guest_member, so each gets its own id. */
let memberSeq = 0;

async function installFakeSupabase(context: BrowserContext, backend: FakeBackend) {
  await context.route(/supabase\.co/, async (route: Route, request: Request) => {
    const url = new URL(request.url());
    const method = request.method();
    let body: any = null;
    try {
      body = request.postDataJSON();
    } catch {
      /* no body */
    }
    backend.requests.push({ method, path: url.pathname + url.search, body, auth: request.headers()['authorization'] });
    const json = (status: number, data: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
        body: JSON.stringify(data),
      });
    if (method === 'OPTIONS') return json(204, {});

    if (url.pathname === '/auth/v1/signup' && method === 'POST') return json(200, { id: USER.id, email: body?.email, aud: 'authenticated', identities: [] });
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      return backend.signIn === 'ok'
        ? json(200, sessionPayload())
        : json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (url.pathname === '/auth/v1/user') return json(200, USER);
    if (url.pathname === '/rest/v1/profiles' && method === 'GET') return json(200, backend.profile); // .maybeSingle() asks for one object
    if (url.pathname === '/rest/v1/profiles' && method === 'PATCH') {
      if (backend.failProfileWrites) return route.abort('connectionfailed');
      backend.profile = { ...backend.profile, ...body, updated_at: new Date().toISOString() };
      return json(200, backend.profile);
    }
    if (url.pathname === '/rest/v1/trips' && method === 'GET') {
      const idFilter = url.searchParams.get('id'); // present when the app asks for ONE trip (details)
      if (idFilter && idFilter.startsWith('eq.')) {
        if (backend.failDetails) return route.abort('connectionfailed');
        if (backend.slowDetailsMs > 0) await new Promise((r) => setTimeout(r, backend.slowDetailsMs));
        const wanted = idFilter.slice(3);
        const found = backend.trips.find((t) => t.id === wanted && !t._hidden);
        if (!found) return json(200, []); // unknown trip, someone else's trip, or removed: the database says nothing
        return json(200, [publicRow(found)]); // the trip alone, as an array exactly as the real server answers (people come from list_trip_members)
      }
      if (backend.failTripsList) return route.abort('connectionfailed');
      return json(200, backend.trips.filter((t) => !t._hidden).map(publicRow));
    }
    if (url.pathname === '/rest/v1/rpc/create_trip' && method === 'POST') {
      if (backend.createMode === 'dates_error') {
        return json(400, { code: '23514', message: 'new row for relation "trips" violates check constraint "trips_dates_order"' });
      }
      if (backend.createMode === 'missing_function') {
        return json(404, { code: 'PGRST202', message: 'Could not find the function public.create_trip(p_name) in the schema cache' });
      }
      if (backend.createMode === 'slow') await new Promise((r) => setTimeout(r, 900));
      const created = tripRow({
        name: body.p_name,
        destination: body.p_destination,
        start_date: body.p_start_date,
        end_date: body.p_end_date,
        description: body.p_description,
        budget_minor: body.p_budget_minor,
        currency: body.p_currency,
      });
      backend.trips.unshift(created);
      const { members: _members, ...plain } = publicRow(created);
      return json(200, plain);
    }
    // ---- list_trip_members: current people in full, former people WITHOUT user id or role; nothing at all for someone not on the trip.
    if (url.pathname === '/rest/v1/rpc/list_trip_members' && method === 'POST') {
      if (backend.failDetails) return route.abort('connectionfailed');
      if (backend.slowDetailsMs > 0) await new Promise((r) => setTimeout(r, backend.slowDetailsMs));
      const t = backend.trips.find((x) => x.id === body.p_trip_id && !x._hidden);
      const ms = ((t?._members ?? []) as Record<string, any>[]);
      if (!t || !ms.some((m) => m.user_id === USER.id && m.status === 'active')) return json(200, []);
      return json(
        200,
        ms.map((m) => ({
          member_id: m.id,
          user_id: m.status === 'active' ? m.user_id : null,
          display_name: m.display_name,
          role: m.status === 'active' ? m.role : null,
          status: m.status,
          joined_at: m.joined_at,
          left_at: m.left_at ?? null,
          is_guest: m.user_id === null,
        })),
      );
    }
    // ---- the five member functions: the fake enforces the SAME rules as the real database functions.
    const memberFn = url.pathname.replace('/rest/v1/rpc/', '');
    if (url.pathname.startsWith('/rest/v1/rpc/') && ['add_guest_member', 'rename_guest_member', 'set_member_role', 'remove_member', 'leave_trip'].includes(memberFn) && method === 'POST') {
      const failWith = (message: string) => json(400, { code: 'P0001', message, details: null, hint: null });
      if (backend.memberFail === 'network') return route.abort('connectionfailed');
      if (backend.slowMemberMs > 0) await new Promise((r) => setTimeout(r, backend.slowMemberMs));
      if (backend.memberFail) return failWith(backend.memberFail);

      const t = backend.trips.find((x) => x.id === body.p_trip_id && !x._hidden);
      const ms = ((t?._members ?? []) as Record<string, any>[]);
      const me = ms.find((m) => m.user_id === USER.id && m.status === 'active');
      if (!t || !me) return failWith('trip_not_found');
      const leaving = memberFn === 'leave_trip';
      if (!leaving && me.role !== 'admin') return failWith('not_admin');
      if (!leaving && t.status === 'archived') return failWith('trip_archived');

      const clean = (v: unknown) => String(v ?? '').replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
      const otherAdmins = (exceptId: string) => ms.some((x) => x.id !== exceptId && x.role === 'admin' && x.status === 'active' && x.user_id !== null);
      const clash = (name: string, exceptId?: string) => ms.some((x) => x.status === 'active' && x.id !== exceptId && clean(x.display_name).toLowerCase() === name.toLowerCase());
      const done = (m: Record<string, any>, changed: boolean) => {
        t.members = ms.map((x) => ({ id: x.id, status: x.status })); // the head-count the trip list shows
        return json(200, [{ member_id: m.id, changed }]);
      };
      const target = ms.find((m) => m.id === body.p_member_id);

      if (memberFn === 'add_guest_member') {
        const name = clean(body.p_display_name);
        if (name.length < 1 || name.length > 60) return failWith('invalid_request');
        if (ms.filter((m) => m.status === 'active').length >= 50) return failWith('trip_full');
        if (clash(name)) return failWith('name_taken');
        const created = memberRow({ id: uuid(9500 + ++memberSeq), user_id: null, display_name: name, role: 'member', status: 'active', joined_at: new Date().toISOString() });
        ms.push(created);
        return done(created, true);
      }
      if (memberFn === 'rename_guest_member') {
        if (!target || target.status !== 'active') return failWith('member_not_found');
        if (target.user_id !== null) return failWith('cannot_rename');
        const name = clean(body.p_display_name);
        if (name.length < 1 || name.length > 60) return failWith('invalid_request');
        if (target.display_name === name) return done(target, false);
        if (clash(name, target.id)) return failWith('name_taken');
        target.display_name = name;
        return done(target, true);
      }
      if (memberFn === 'set_member_role') {
        if (!['admin', 'member'].includes(body.p_role) || !['admin', 'member'].includes(body.p_expected_role)) return failWith('invalid_request');
        if (!target || target.status !== 'active') return failWith('member_not_found');
        if (target.role === body.p_role) return done(target, false);
        if (target.role !== body.p_expected_role) return failWith('member_changed');
        if (body.p_role === 'admin' && target.user_id === null) return failWith('guest_cannot_be_admin');
        if (body.p_role === 'member' && !otherAdmins(target.id)) return failWith('last_admin');
        target.role = body.p_role;
        return done(target, true);
      }
      if (memberFn === 'remove_member') {
        if (!target) return failWith('member_not_found');
        if (target.id === me.id) return failWith('use_leave_instead');
        if (target.status !== 'active') return done(target, false);
        if (target.role === 'admin' && !otherAdmins(target.id)) return failWith('last_admin');
        target.status = 'removed';
        target.left_at = new Date().toISOString();
        return done(target, true);
      }
      // leave_trip
      if (me.role === 'admin' && !otherAdmins(me.id)) return failWith('last_admin');
      me.status = 'left';
      me.left_at = new Date().toISOString();
      t._hidden = true; // the person can no longer see the trip at all
      return done(me, true);
    }
    // ---- update_trip / set_trip_archived: the fake enforces the SAME rules as the real database functions.
    if ((url.pathname === '/rest/v1/rpc/update_trip' || url.pathname === '/rest/v1/rpc/set_trip_archived') && method === 'POST') {
      const failWith = (message: string) => json(400, { code: 'P0001', message, details: null, hint: null });
      if (backend.rpcFail === 'network') return route.abort('connectionfailed');
      if (backend.slowRpcMs > 0) await new Promise((r) => setTimeout(r, backend.slowRpcMs));
      if (backend.rpcFail) return failWith(backend.rpcFail);

      const t = backend.trips.find((x) => x.id === body.p_trip_id && !x._hidden);
      const me = t && (t._members as Record<string, any>[]).find((m) => m.user_id === USER.id && m.status === 'active');
      if (!t || !me) return failWith('trip_not_found'); // same answer for "no such trip" and "not on it"
      if (me.role !== 'admin') return failWith('not_admin');
      const send = () => {
        const { members: _members, ...plain } = publicRow(t);
        return json(200, plain);
      };
      const touch = () => {
        t.version += 1;
        t.updated_at = new Date().toISOString();
      };

      if (url.pathname === '/rest/v1/rpc/set_trip_archived') {
        const target = body.p_archived ? 'archived' : 'active';
        if (t.status === target) return send(); // already there: nothing changes, no new version
        if (t.version !== body.p_expected_version) return failWith('version_conflict');
        t.status = target;
        touch();
        return send();
      }

      if (t.status === 'archived') return failWith('trip_archived');
      if (t.version !== body.p_expected_version) return failWith('version_conflict');
      const name = String(body.p_name).trim();
      const destination = String(body.p_destination).trim();
      const description = body.p_description === null || String(body.p_description).trim() === '' ? null : String(body.p_description).trim();
      const unchanged =
        t.name === name && t.destination === destination && t.start_date === body.p_start_date && t.end_date === body.p_end_date &&
        t.description === description && t.budget_minor === body.p_budget_minor;
      if (unchanged) return send(); // no-op: no new version
      Object.assign(t, { name, destination, start_date: body.p_start_date, end_date: body.p_end_date, description, budget_minor: body.p_budget_minor });
      touch();
      return send();
    }
    backend.unexpected.push(`${method} ${url.pathname}`);
    return route.abort('blockedbyclient');
  });
}

const sessionInStorage = (context: BrowserContext) =>
  context.addInitScript(
    ([key, payload]) => {
      if (!window.localStorage.getItem(key as string)) window.localStorage.setItem(key as string, payload as string);
    },
    [STORAGE_KEY, JSON.stringify(sessionPayload())],
  );

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
/** Finds an element by its testID, only among elements the user can actually see (stacked screens stay mounted but hidden). */
const byId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]:visible`);

/** Finds visible text (same reason as byId). */
const vis = (page: Page, text: string) => page.getByText(text).filter({ visible: true });

/** The colour behind the top-left corner of the screen: walks up from that point to the first element that paints a background. */
const screenBg = (page: Page) =>
  page.evaluate(() => {
    let el: Element | null = document.elementFromPoint(4, 4);
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      el = el.parentElement;
    }
    return '';
  });

const pathOf = (page: Page) => new URL(page.url()).pathname;

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function waitFor(fn: () => Promise<boolean> | boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const authRequests = (b: FakeBackend, p: string) => b.requests.filter((r) => r.path.startsWith(p) && r.method !== 'OPTIONS');

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------
async function setupScreens(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nA. Setup screen when Supabase settings are missing');
  let site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '', EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(BASE);
    const shown = await vis(page, 'Setup needed').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('shows "Setup needed" instead of crashing', shown);
    const msg = await byId(page, 'setup-error').innerText().catch(() => '');
    check('names the missing variable', msg.includes('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), msg);
    await shot(page, 'setup-missing-key');
  } finally {
    site.stop();
  }

  console.log('\nB. A SECRET key in the app settings is refused');
  site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: FAKE_SECRET_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const context = await browser.newContext();
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    const page = await context.newPage();
    await page.goto(BASE);
    const shown = await vis(page, 'Setup needed').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('shows the setup screen', shown);
    const text = await page.locator('body').innerText();
    check('explains a SECRET key was found', /SECRET Supabase key/.test(text));
    check('never prints the key on screen', !text.includes('FAKE_DO_NOT_USE'));
    check('makes no request to Supabase with it', !requests.some((u) => u.includes('supabase.co')));
    await shot(page, 'setup-secret-key');
  } finally {
    site.stop();
  }
}

async function accountFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nC. Signed-out behaviour');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    // ---- signed out
    {
      const context = await browser.newContext();
      const backend = newBackend();
      await installFakeSupabase(context, backend);
      const page = await context.newPage();

      await page.goto(`${BASE}/`);
      await byId(page, 'email').waitFor({ timeout: 20000 });
      check('opening the app signed out lands on sign-in', pathOf(page) === '/sign-in', pathOf(page));
      check('first launch is LIGHT', (await screenBg(page)) === LIGHT_BG, await screenBg(page));
      await shot(page, 'sign-in-light');

      await page.goto(`${BASE}/profile`);
      await byId(page, 'email').waitFor({ timeout: 20000 });
      check('a protected page (/profile) sends a signed-out visitor to sign-in', pathOf(page) === '/sign-in', pathOf(page));

      await byId(page, 'submit').click();
      const emailErr = await vis(page, 'Enter a valid email address').waitFor({ timeout: 5000 }).then(() => true, () => false);
      check('empty sign-in shows field messages', emailErr && (await vis(page, 'Enter your password').isVisible()));
      check('...and sends nothing to the server', authRequests(backend, '/auth/v1/token').length === 0);

      // sign-up validation
      await vis(page, 'Create an account').click();
      await byId(page, 'displayName').waitFor();
      await byId(page, 'email').fill('not-an-email');
      await byId(page, 'password').fill('short');
      await byId(page, 'submit').click();
      const nameErr = await vis(page, 'Enter your name').waitFor({ timeout: 5000 }).then(() => true, () => false);
      check('sign-up shows name, email and password messages', nameErr && (await vis(page, 'Enter a valid email address').isVisible()) && (await vis(page, 'Use at least 8 characters').isVisible()));
      check('...and sends nothing to the server', authRequests(backend, '/auth/v1/signup').length === 0);

      // sign-up success (email confirmation on: no session returned)
      await byId(page, 'displayName').fill('  Asha Rao  ');
      await byId(page, 'email').fill('  Asha@Example.com ');
      await byId(page, 'password').fill('Goa2026trip');
      await byId(page, 'submit').click();
      const sent = await byId(page, 'confirm-sent').waitFor({ timeout: 8000 }).then(() => true, () => false);
      check('valid sign-up shows "Check your email"', sent);
      const signup = authRequests(backend, '/auth/v1/signup')[0];
      check('sent cleaned data (trimmed name, lowercase email)', signup?.body?.email === 'asha@example.com' && signup?.body?.data?.display_name === 'Asha Rao', JSON.stringify(signup?.body && { ...signup.body, password: '***' }));
      check('stays signed out until the email is confirmed', pathOf(page) === '/sign-up');
      await shot(page, 'sign-up-check-email');
      await page.getByRole('button', { name: 'Go to sign in' }).click();
      await byId(page, 'email').waitFor();
      check('"Go to sign in" returns to sign-in', pathOf(page) === '/sign-in');

      // sign-in wrong password
      backend.signIn = 'invalid_credentials';
      await byId(page, 'email').fill('asha@example.com');
      await byId(page, 'password').fill('WrongPass1');
      await byId(page, 'submit').click();
      const bad = await byId(page, 'form-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
      const badText = bad ? await byId(page, 'form-error').innerText() : '';
      check('wrong password shows a friendly message', /don't match/.test(badText), badText);
      check('...which does not say whether the email exists', !/no account|not found|doesn't exist/i.test(badText));
      check('stays on sign-in', pathOf(page) === '/sign-in');
      check('no unexpected network calls so far', backend.unexpected.length === 0, backend.unexpected.join(', '));
      await context.close();
    }
  } finally {
    site.stop();
  }
}

async function signedInFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nD. Sign-in, session, profile, theme, sign-out');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const context = await browser.newContext({ colorScheme: 'dark' }); // device is in dark mode on purpose
    const backend = newBackend();
    await installFakeSupabase(context, backend);
    const page = await context.newPage();

    await page.goto(`${BASE}/sign-in`);
    await byId(page, 'email').waitFor({ timeout: 20000 });
    check('device in dark mode, but first launch is still LIGHT (product rule)', (await screenBg(page)) === LIGHT_BG, await screenBg(page));

    await byId(page, 'email').fill('asha@example.com');
    await byId(page, 'password').fill('Goa2026trip');
    await byId(page, 'submit').click();
    const home = await byId(page, 'greeting').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('valid sign-in reaches the home screen', home && pathOf(page) === '/', pathOf(page));
    check('greets the user by first name', (await byId(page, 'greeting').innerText().catch(() => '')) === 'Hello, Asha');
    const profileCall = authRequests(backend, '/rest/v1/profiles').find((r) => r.method === 'GET');
    check('profile is requested for this user only (filter on id)', !!profileCall && decodeURIComponent(profileCall.path).includes(`id=eq.${USER.id}`), profileCall?.path);
    check('requests carry the user\'s token, not a secret key', !!profileCall?.auth?.startsWith('Bearer ') && !profileCall.auth.includes('sb_secret'));
    await shot(page, 'home-light');

    // Signed in: sign-in page is not reachable
    await page.goto(`${BASE}/sign-in`);
    await byId(page, 'greeting').waitFor({ timeout: 10000 }).catch(() => {});
    check('opening /sign-in while signed in goes home', pathOf(page) === '/', pathOf(page));

    // Session persistence
    await page.reload();
    const stillIn = await byId(page, 'greeting').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('a page reload keeps the user signed in', stillIn);

    // Profile
    await byId(page, 'open-profile').click();
    await byId(page, 'profile-name').waitFor({ timeout: 8000 });
    check('profile form is filled from the account', (await byId(page, 'profile-name').inputValue()) === 'Asha Rao');
    check('shows the signed-in email', (await byId(page, 'account-email').innerText()) === 'asha@example.com');
    check('Save is disabled until something changes (and announced as disabled)', (await byId(page, 'save-profile').getAttribute('aria-disabled')) === 'true');
    check('accessibility: the selected theme is announced as checked', (await byId(page, 'theme-light').getAttribute('aria-checked')) === 'true' && (await byId(page, 'theme-dark').getAttribute('aria-checked')) === 'false');

    await byId(page, 'profile-name').fill('Asha R');
    await byId(page, 'profile-upi').fill('not valid');
    await byId(page, 'save-profile').click();
    const upiErr = await vis(page, 'UPI ID looks like name@bank').waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('an invalid UPI ID is rejected with a clear message', upiErr);
    check('...and nothing was sent to the server', !backend.requests.some((r) => r.method === 'PATCH'));

    await byId(page, 'profile-upi').fill('asha@okhdfcbank');
    await byId(page, 'currency-USD').click();
    await byId(page, 'save-profile').click();
    const ok = await byId(page, 'save-ok').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('valid changes save and show "Saved."', ok);
    const patch = backend.requests.filter((r) => r.method === 'PATCH').at(-1);
    check('only the 3 editable columns are sent', !!patch && JSON.stringify(Object.keys(patch.body).sort()) === JSON.stringify(['display_name', 'preferred_currency', 'upi_id']), JSON.stringify(patch?.body));
    check('values are correct', patch?.body.display_name === 'Asha R' && patch?.body.upi_id === 'asha@okhdfcbank' && patch?.body.preferred_currency === 'USD');
    check('the update is limited to this user\'s row', decodeURIComponent(patch?.path ?? '').includes(`id=eq.${USER.id}`));

    // Theme
    await byId(page, 'theme-dark').click();
    check('choosing Dark switches the whole screen to dark', await waitFor(async () => (await screenBg(page)) === DARK_BG));
    check('accessibility: Dark is now announced as the checked option', (await byId(page, 'theme-dark').getAttribute('aria-checked')) === 'true' && (await byId(page, 'theme-light').getAttribute('aria-checked')) === 'false');
    await shot(page, 'profile-dark');
    const themePatch = await waitFor(() => backend.requests.some((r) => r.method === 'PATCH' && r.body?.theme_preference === 'dark'));
    check('the choice is saved to the account', themePatch);
    await page.reload();
    await byId(page, 'profile-name').waitFor({ timeout: 10000 });
    check('Dark persists after a reload', await waitFor(async () => (await screenBg(page)) === DARK_BG));

    await byId(page, 'theme-light').click();
    check('choosing Light switches back', await waitFor(async () => (await screenBg(page)) === LIGHT_BG));
    await shot(page, 'profile-light');

    // System follows the device
    await byId(page, 'theme-system').click();
    check('System follows a dark device', await waitFor(async () => (await screenBg(page)) === DARK_BG));
    await page.emulateMedia({ colorScheme: 'light' });
    check('...and follows it back to light live', await waitFor(async () => (await screenBg(page)) === LIGHT_BG));

    // Account is source of truth on another device
    await byId(page, 'theme-dark').click();
    await waitFor(() => backend.requests.some((r) => r.method === 'PATCH' && r.body?.theme_preference === 'dark' && r.body !== undefined) && (backend.profile.theme_preference === 'dark'));
    const other = await browser.newContext({ colorScheme: 'light' });
    await installFakeSupabase(other, backend);
    await sessionInStorage(other);
    const otherPage = await other.newPage();
    await otherPage.goto(BASE);
    await byId(otherPage, 'greeting').waitFor({ timeout: 20000 });
    check('a second device (no saved local choice) picks up Dark from the account', await waitFor(async () => (await screenBg(otherPage)) === DARK_BG, 10000));
    await other.close();

    // Failed theme save
    backend.failProfileWrites = true;
    await byId(page, 'theme-light').click();
    const warn = await byId(page, 'theme-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('if the account cannot be updated the user is told it is saved on this device only', warn);
    check('...and the theme still changes on this device', await waitFor(async () => (await screenBg(page)) === LIGHT_BG));
    backend.failProfileWrites = false;

    // Sign out
    await byId(page, 'sign-out').click();
    const out = await byId(page, 'email').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('signing out returns to sign-in', out && pathOf(page) === '/sign-in', pathOf(page));
    check('the saved session is removed from the browser', (await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY)) === null);
    check('the logout request signs out this device only', authRequests(backend, '/auth/v1/logout').some((r) => r.path.includes('scope=local')), JSON.stringify(authRequests(backend, '/auth/v1/logout').map((r) => r.path)));
    await page.goto(`${BASE}/profile`);
    await byId(page, 'email').waitFor({ timeout: 10000 });
    check('after sign-out, /profile is protected again', pathOf(page) === '/sign-in', pathOf(page));
    check('the theme choice still applies on the sign-in screen (device setting)', (await screenBg(page)) === LIGHT_BG);

    check('no unexpected network calls in the whole run', backend.unexpected.length === 0, backend.unexpected.join(', '));
    await context.close();
  } finally {
    site.stop();
  }
}

async function tripFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nE. Trips: your list and creating a trip');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const context = await browser.newContext();
    const backend = newBackend();
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();
    const rpcCalls = () => backend.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/rest/v1/rpc/create_trip'));

    // ---- empty state
    await page.goto(BASE);
    const empty = await byId(page, 'empty-title').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('a person with no trips sees "Your next adventure starts here."', empty);
    check('...with a "Create a trip" button', await byId(page, 'create-trip').isVisible());
    const listReq = backend.requests.find((r) => r.method === 'GET' && r.path.startsWith('/rest/v1/trips'));
    check('the trip list is requested together with each trip\'s members', !!listReq && decodeURIComponent(listReq.path).includes('trip_members'), listReq?.path);
    await shot(page, 'home-empty');

    // ---- form validation
    await byId(page, 'create-trip').click();
    await byId(page, 'trip-name').waitFor({ timeout: 8000 });
    check('"Create a trip" opens the form', pathOf(page) === '/trips/new', pathOf(page));
    await byId(page, 'create-trip-submit').click();
    const nameErr = await vis(page, 'Enter a trip name').waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('an empty form lists every missing field', nameErr && (await vis(page, 'Enter a destination').isVisible()) && (await vis(page, 'Enter the start date like 27/12/2026').isVisible()) && (await vis(page, 'Enter the end date like 27/12/2026').isVisible()));
    check('...and sends nothing to the server', rpcCalls().length === 0);

    await byId(page, 'trip-name').fill('Goa Trip 2026');
    await byId(page, 'trip-destination').fill('Goa, India');
    await byId(page, 'trip-start').fill(asDmy(dayFromToday(10)));
    await byId(page, 'trip-end').fill(asDmy(dayFromToday(5)));
    await byId(page, 'trip-budget').fill('lots');
    await byId(page, 'create-trip-submit').click();
    const orderErr = await vis(page, 'The end date must be on or after the start date').waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('an end date before the start date is rejected', orderErr);
    check('a nonsense budget is rejected', await vis(page, 'Enter a budget like 60000').isVisible());
    await byId(page, 'trip-start').fill('30/02/2026');
    await byId(page, 'create-trip-submit').click();
    check('an impossible date (30 February) is rejected', await vis(page, 'Enter the start date like 27/12/2026').waitFor({ timeout: 5000 }).then(() => true, () => false));
    check('nothing was sent while the form was invalid', rpcCalls().length === 0);
    check('the person\'s typing is kept after errors', (await byId(page, 'trip-name').inputValue()) === 'Goa Trip 2026');

    // ---- currency defaults to the profile's
    check('currency starts as INR (from the profile)', (await byId(page, 'trip-currency-INR').getAttribute('aria-checked')) === 'true');

    // ---- successful create; also seed other trips so grouping is exercised
    backend.trips = [
      tripRow({ id: 'trip-ongoing', name: 'Ongoing Manali', destination: 'Manali', start_date: dayFromToday(-1), end_date: dayFromToday(2), members: [{ id: 'a', status: 'active' }, { id: 'b', status: 'active' }, { id: 'c', status: 'removed' }] }),
      tripRow({ id: 'trip-old', name: 'Old Jaipur', destination: 'Jaipur', start_date: dayFromToday(-60), end_date: dayFromToday(-57) }),
      tripRow({ id: 'trip-archived', name: 'Archived Secret', destination: 'Nowhere', start_date: dayFromToday(-1), end_date: dayFromToday(2), status: 'archived' }),
    ];
    const startIso = dayFromToday(30);
    const endIso = dayFromToday(33);
    await byId(page, 'trip-start').fill(asDmy(startIso));
    await byId(page, 'trip-end').fill(asDmy(endIso));
    await byId(page, 'trip-budget').fill('60,000');
    await byId(page, 'create-trip-submit').click();
    const home = await byId(page, 'greeting').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('a valid trip is created and the person returns to Home', home && pathOf(page) === '/', pathOf(page));
    const call = rpcCalls().at(-1);
    check('exactly one create request was sent', rpcCalls().length === 1, String(rpcCalls().length));
    check('it carries cleaned values: ISO dates, budget in paise, no description', !!call && call.body.p_name === 'Goa Trip 2026' && call.body.p_destination === 'Goa, India' && call.body.p_start_date === startIso && call.body.p_end_date === endIso && call.body.p_budget_minor === 6_000_000 && call.body.p_description === null && call.body.p_currency === 'INR', JSON.stringify(call?.body));
    check('...and nothing that could set the creator, id or status', !!call && JSON.stringify(Object.keys(call.body).sort()) === JSON.stringify(['p_budget_minor', 'p_currency', 'p_description', 'p_destination', 'p_end_date', 'p_name', 'p_start_date']), JSON.stringify(Object.keys(call?.body ?? {})));
    check('the request carries the user\'s login, not a secret key', !!call?.auth?.startsWith('Bearer ') && !call.auth.includes('sb_secret'));

    await byId(page, 'section-upcoming').waitFor({ timeout: 8000 });
    const text = async (id: string) => (await byId(page, id).innerText().catch(() => ''));
    check('the new trip appears under Upcoming', (await text('section-upcoming')).includes('Goa Trip 2026'));
    check('a trip happening today is under Ongoing', (await text('section-ongoing')).includes('Ongoing Manali'));
    check('a finished trip is under Completed', (await text('section-completed')).includes('Old Jaipur'));
    check('an archived trip is not shown', !(await page.locator('body').innerText()).includes('Archived Secret'));
    const goa = await text(`trip-card-${backend.trips[0]!.id}`);
    check('the card shows place, dates and budget', goa.includes('Goa, India') && goa.includes(formatDateRange(startIso, endIso)) && goa.includes('Budget ₹60,000'), goa.replace(/\n/g, ' | '));
    check('the card counts only people still on the trip', (await text('trip-card-trip-ongoing')).includes('2 people'));
    check('a single member reads "1 person"', goa.includes('1 person'));
    await shot(page, 'home-trips-light');

    // ---- double tap while saving
    backend.createMode = 'slow';
    const before = rpcCalls().length;
    await byId(page, 'create-trip').click();
    await byId(page, 'trip-name').waitFor();
    await byId(page, 'trip-name').fill('Double Tap Trip');
    await byId(page, 'trip-destination').fill('Gokarna');
    await byId(page, 'trip-start').fill(asDmy(dayFromToday(40)));
    await byId(page, 'trip-end').fill(asDmy(dayFromToday(42)));
    await byId(page, 'create-trip-submit').click();
    await byId(page, 'create-trip-submit').click({ timeout: 800, force: true }).catch(() => {});
    await byId(page, 'greeting').waitFor({ timeout: 10000 });
    check('tapping Create twice sends only one request', rpcCalls().length === before + 1, `${rpcCalls().length - before} sent`);
    backend.createMode = 'ok';

    // ---- server rejects (rule the form could not catch)
    backend.createMode = 'dates_error';
    await byId(page, 'create-trip').click();
    await byId(page, 'trip-name').waitFor();
    await byId(page, 'trip-name').fill('Rejected Trip');
    await byId(page, 'trip-destination').fill('Somewhere');
    await byId(page, 'trip-start').fill(asDmy(dayFromToday(50)));
    await byId(page, 'trip-end').fill(asDmy(dayFromToday(52)));
    await byId(page, 'create-trip-submit').click();
    const serverMsg = await vis(page, 'The end date must be on or after the start date').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('a rule the server enforces is shown next to the right field in plain words', serverMsg && !(await page.locator('body').innerText()).includes('violates check constraint'));
    check('the form stays open with the typing kept', pathOf(page) === '/trips/new' && (await byId(page, 'trip-name').inputValue()) === 'Rejected Trip');

    // ---- database update not applied yet
    backend.createMode = 'missing_function';
    await byId(page, 'create-trip-submit').click();
    const setup = await byId(page, 'form-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('if the database update is missing, the person is told clearly', setup && /database update/.test(await byId(page, 'form-error').innerText()));
    backend.createMode = 'ok';

    // ---- currency follows the profile
    backend.profile = { ...backend.profile, preferred_currency: 'USD' };
    await page.goto(`${BASE}/trips/new`);
    await byId(page, 'trip-name').waitFor({ timeout: 15000 });
    check('a USD profile starts the form on USD', await waitFor(async () => (await byId(page, 'trip-currency-USD').getAttribute('aria-checked')) === 'true'));
    backend.profile = { ...backend.profile, preferred_currency: 'INR' };

    // ---- the list fails to load, then recovers
    backend.failTripsList = true;
    const failCtx = await browser.newContext();
    await installFakeSupabase(failCtx, backend);
    await sessionInStorage(failCtx);
    const failPage = await failCtx.newPage();
    await failPage.goto(BASE);
    const errShown = await byId(failPage, 'trips-error').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('if trips cannot be loaded the person sees a clear message and a retry button', errShown && (await byId(failPage, 'trips-retry').isVisible()));
    backend.failTripsList = false;
    await byId(failPage, 'trips-retry').click();
    check('"Try again" recovers and shows the trips', await byId(failPage, 'section-upcoming').waitFor({ timeout: 10000 }).then(() => true, () => false));
    await failCtx.close();

    check('no unexpected network calls in the trips run', backend.unexpected.length === 0, backend.unexpected.join(', '));
    await context.close();
  } finally {
    site.stop();
  }
}

async function detailFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nF. Trip details');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const GOA = uuid(1);
    const MINIMAL = uuid(2);
    const USD = uuid(3);
    const CREATOR_LEFT = uuid(4);
    const ARCHIVED = uuid(5);
    const HIDDEN = uuid(6); // exists, but belongs to someone else
    const PLAIN = uuid(7); // you are an ordinary member here, and someone left
    const UNKNOWN = uuid(999); // does not exist at all
    const startIso = dayFromToday(30);
    const endIso = dayFromToday(33);
    const OTHER = '99999999-9999-4999-8999-999999999999'; // another person's user id

    const context = await browser.newContext();
    const backend = newBackend();
    backend.trips = [
      tripRow({
        id: GOA, name: 'Goa Trip 2026', destination: 'Goa, India', start_date: startIso, end_date: endIso,
        description: 'Beach, food and friends', budget_minor: 6_000_000,
        members: [{ id: 'g1', status: 'active' }, { id: 'g2', status: 'active' }, { id: 'g3', status: 'active' }],
        _members: [
          memberRow({ id: 'g2', user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ravi Kumar', joined_at: '2026-11-18T11:00:00+00:00' }),
          memberRow({ id: 'g1', user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T10:00:00+00:00' }),
          memberRow({ id: 'g3', user_id: null, display_name: 'Gita (guest)', joined_at: '2026-11-18T12:00:00+00:00' }),
          memberRow({ id: 'g4', user_id: '44444444-4444-4444-8444-444444444444', display_name: 'Removed Rahul', role: 'admin', status: 'removed', left_at: '2026-11-20T10:00:00+00:00' }),
          memberRow({ id: 'g5', user_id: '55555555-5555-4555-8555-555555555555', display_name: 'Departed Dev', status: 'left', left_at: '2026-11-21T10:00:00+00:00' }),
          memberRow({ id: 'g6', user_id: null, display_name: 'Departed Guest Gopal', status: 'removed', left_at: '2026-11-19T10:00:00+00:00' }),
        ],
      }),
      tripRow({
        id: PLAIN, name: 'Plain Member Trip', destination: 'Udaipur', start_date: startIso, end_date: endIso,
        members: [{ id: 'p1', status: 'active' }, { id: 'p2', status: 'active' }],
        _members: [
          memberRow({ id: 'p1', user_id: OTHER, display_name: 'Boss Bhavna', role: 'admin' }),
          memberRow({ id: 'p2', user_id: USER.id, display_name: 'Asha Rao' }),
          memberRow({ id: 'p3', user_id: '66666666-6666-4666-8666-666666666666', display_name: 'A Former Friend With An Extremely Long Name That Must Wrap Neatly On A Phone Screen', status: 'left', left_at: '2026-11-22T10:00:00+00:00' }),
        ],
      }),
      tripRow({ id: MINIMAL, name: 'Minimal Trip', destination: 'Lonavala', start_date: startIso, end_date: startIso }),
      tripRow({ id: USD, name: 'Dubai Break', destination: 'Dubai', start_date: startIso, end_date: endIso, budget_minor: 150_000, currency: 'USD' }),
      tripRow({
        id: CREATOR_LEFT, name: 'Creator Left', destination: 'Jaipur', start_date: startIso, end_date: endIso, created_by: OTHER,
        _members: [memberRow({ id: 'c1', user_id: USER.id, display_name: 'Asha Rao', role: 'admin' })],
      }),
      tripRow({ id: ARCHIVED, name: 'Archived Trip', destination: 'Hampi', start_date: dayFromToday(-90), end_date: dayFromToday(-88), status: 'archived' }),
      tripRow({ id: HIDDEN, name: 'Someone Elses Secret Trip', destination: 'Nowhere Private', start_date: startIso, end_date: endIso, _hidden: true }),
    ];
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();
    const detailRequests = (id: string) => backend.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/rest/v1/trips') && r.path.includes(`id=eq.${id}`));
    const body = () => page.locator('body').innerText();
    const textOf = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const open = async (id: string, waitFor: string = 'trip-title') => {
      await page.goto(`${BASE}/trips/${id}`);
      return byId(page, waitFor).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const exists = async (id: string) => (await byId(page, id).count()) > 0;

    // ---- open from Home
    await page.goto(BASE);
    await byId(page, `trip-card-${GOA}`).waitFor({ timeout: 20000 });
    const label = (await byId(page, `trip-card-${GOA}`).getAttribute('aria-label')) ?? '';
    check('accessibility: the trip card is a button that names the trip', label.startsWith('Open trip Goa Trip 2026, Goa, India'), label);
    await byId(page, `trip-card-${GOA}`).click();
    const opened = await byId(page, 'trip-title').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('tapping a trip card opens its details page', opened && pathOf(page) === `/trips/${GOA}`, pathOf(page));

    // ---- what the page shows
    check('shows the trip name and destination', (await textOf('trip-title')) === 'Goa Trip 2026' && (await textOf('trip-destination')) === 'Goa, India');
    check('shows the phase (starts in 30 days = Upcoming)', (await textOf('trip-phase')) === 'Upcoming');
    check('shows the date range and the length in days', (await textOf('trip-dates')) === formatDateRange(startIso, endIso) && (await textOf('trip-length')) === '4 days', `${await textOf('trip-dates')} / ${await textOf('trip-length')}`);
    check('shows the description', (await textOf('trip-description')) === 'Beach, food and friends');
    check('shows the budget and the currency', (await textOf('trip-budget')) === '₹60,000' && (await textOf('trip-currency')) === 'INR');
    check('says who created the trip ("you" for the creator)', (await textOf('trip-creator')) === 'Created by you');
    check('counts only current people in the heading', await vis(page, 'People (3)').isVisible());
    const people = await textOf('trip-people');
    check('lists current people, administrators first', people.indexOf('Asha Rao') < people.indexOf('Ravi Kumar') && people.indexOf('Ravi Kumar') < people.indexOf('Gita (guest)'), people);
    check('marks the administrator, yourself and a guest', (await textOf('member-g1')).includes('Admin') && (await textOf('member-g1')).includes('You') && !(await textOf('member-g2')).includes('Admin') && (await textOf('member-g3')).includes('Guest'));
    const all = await body();
    check('former members are not in the people list or its count', !/Removed Rahul|Departed Dev|Departed Guest/.test(people) && !/Admin/.test(await textOf('trip-people').then((t) => t.replace(/Asha Rao Admin You/, ''))));
    check('says what your role is (administrator)', (await textOf('trip-my-role')) === 'You are an admin of this trip.');
    check('the former members list is collapsed at first: no former name is visible', (await byId(page, 'former-toggle').isVisible()) && !/Removed Rahul|Departed Dev|Departed Guest/.test(all));
    check('privacy: no email addresses or UPI IDs anywhere on the page', !/@|example\.com|okhdfcbank|upi/i.test(all.replace(/\bTripMate\b/g, '')), all.slice(0, 200));
    const req = detailRequests(GOA)[0];
    const decoded = decodeURIComponent(req?.path ?? '').replace(/\+/g, ' ');
    check('the request names its columns (no "select everything") and asks the trips table for no members', !!req && !decoded.includes('select=*') && decoded.includes('destination') && !decoded.includes('trip_members'), decoded.slice(0, 160));
    const listReqs = backend.requests.filter((r) => r.method === 'POST' && r.path === '/rest/v1/rpc/list_trip_members' && r.body?.p_trip_id === GOA);
    check('the people come from list_trip_members, which is sent only the trip id', listReqs.length >= 1 && JSON.stringify(listReqs[0]!.body) === JSON.stringify({ p_trip_id: GOA }), JSON.stringify(listReqs[0]?.body));
    check('the request never touches profiles or emails', !/profiles|email|upi/i.test(decoded));
    check('it carries the user\'s login, not a secret key', !!req?.auth?.startsWith('Bearer ') && !req.auth.includes('sb_secret'));
    await shot(page, 'details-light');

    // ---- former members (read-only list)
    const dmy = (iso: string) => { const d = new Date(iso); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return formatDateRange(day, day); };
    check('the toggle names the count and is collapsed', (await textOf('former-toggle')).includes('Former members (3)') && (await byId(page, 'former-toggle').getAttribute('aria-expanded')) === 'false');
    await byId(page, 'former-toggle').click();
    check('opening it expands (aria-expanded) and shows the former members', (await byId(page, 'former-toggle').getAttribute('aria-expanded')) === 'true' && (await byId(page, 'former-members').isVisible()));
    const former = await textOf('former-members');
    check('lists most recent first: Dev, Rahul, then the guest', former.indexOf('Departed Dev') < former.indexOf('Removed Rahul') && former.indexOf('Removed Rahul') < former.indexOf('Departed Guest Gopal'), former);
    check('each says how and when they left, in the viewer\'s day', (await textOf('former-note-g5')) === `Left ${dmy('2026-11-21T10:00:00+00:00')}` && (await textOf('former-note-g4')) === `Removed ${dmy('2026-11-20T10:00:00+00:00')}` && (await textOf('former-note-g6')) === `Removed ${dmy('2026-11-19T10:00:00+00:00')}`);
    check('a former guest is marked Guest; a former admin shows no Admin/You tag', (await textOf('former-g6')).includes('Guest') && !/Admin|You/.test(await textOf('former-g4')));
    check('the former members are not counted in "People (3)", and still no one gets a role from this list', await vis(page, 'People (3)').isVisible());
    check('privacy: the list shows no email, UPI or user ids', !/@|upi|okhdfcbank|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(former), former);
    await shot(page, 'details-former-light');
    await byId(page, 'former-toggle').click();
    check('closing it hides them again', !/Removed Rahul|Departed Dev/.test(await body()) && (await byId(page, 'former-toggle').getAttribute('aria-expanded')) === 'false');

    // ---- back, deep link, reload
    await byId(page, 'trip-back-home').click();
    check('"← Home" goes back to the trip list', await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false) && pathOf(page) === '/');
    check('opening the trip address directly works', await open(GOA) && (await textOf('trip-title')) === 'Goa Trip 2026');
    await page.reload();
    check('reloading the page keeps the trip open', await byId(page, 'trip-title').waitFor({ timeout: 20000 }).then(() => true, () => false));

    // ---- other kinds of trip
    await open(MINIMAL);
    check('no description and no budget read clearly', (await textOf('trip-description')) === 'No description' && (await textOf('trip-budget')) === 'No budget set');
    check('a one-day trip says "1 day"; one person on it', (await textOf('trip-length')) === '1 day' && (await vis(page, 'People (1)').isVisible()));
    await open(USD);
    check('other currencies show their code', (await textOf('trip-budget')) === 'USD 1,500' && (await textOf('trip-currency')) === 'USD');
    await open(CREATOR_LEFT);
    check('if the creator is no longer on the trip: "a former member"', (await textOf('trip-creator')) === 'Created by a former member');
    await open(ARCHIVED);
    check('a member can open an archived trip, with a clear notice', (await textOf('trip-archived')) === 'This trip is archived.' && (await textOf('trip-phase')) === 'Completed');

    // ---- not available: ONE message for every cause
    const message = async () => (await textOf('trip-unavailable'));
    await open(HIDDEN, 'trip-unavailable');
    const hiddenMsg = await message();
    check('someone else\'s trip shows the combined "not available" message', hiddenMsg === "We couldn't open this trip. It may have been removed, or you may not be a member.", hiddenMsg);
    const hiddenPage = await body();
    check('...and reveals nothing about that trip', !/Someone Elses Secret Trip|Nowhere Private|People \(|Budget|Created by/.test(hiddenPage));
    await shot(page, 'details-unavailable');
    await open(UNKNOWN, 'trip-unavailable');
    check('a trip that does not exist shows the IDENTICAL message', (await message()) === hiddenMsg);
    const before = detailRequests('not-a-uuid').length;
    await open('not-a-uuid', 'trip-unavailable');
    check('a malformed address shows the IDENTICAL message', (await message()) === hiddenMsg);
    check('...without asking the server at all', detailRequests('not-a-uuid').length === before);
    check('the page gives no hint about why (no "denied", "forbidden", "private")', !/denied|forbidden|private|permission/i.test(hiddenMsg + (await textOf('trip-unavailable-title'))));
    await byId(page, 'trip-unavailable-home').click();
    check('"Back to Home" works from the not-available page', await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false) && pathOf(page) === '/');

    // ---- connection trouble is different, and recoverable
    backend.failDetails = true;
    await open(GOA, 'trip-error');
    check('a connection failure is a separate message with "Try again"', (await byId(page, 'trip-error').isVisible()) && (await byId(page, 'trip-retry').isVisible()) && !(await byId(page, 'trip-unavailable').isVisible().catch(() => false)));
    backend.failDetails = false;
    await byId(page, 'trip-retry').click();
    check('"Try again" recovers and shows the trip', await byId(page, 'trip-title').waitFor({ timeout: 10000 }).then(() => true, () => false));

    // ---- loading state
    backend.slowDetailsMs = 1500;
    await page.goto(`${BASE}/trips/${MINIMAL}`);
    check('a loading message shows while the trip is being fetched', await byId(page, 'trip-loading').waitFor({ timeout: 8000 }).then(() => true, () => false));
    check('...then the trip appears', await byId(page, 'trip-title').waitFor({ timeout: 10000 }).then(() => true, () => false));
    backend.slowDetailsMs = 0;

    // ---- an ordinary member sees their role and the same former-member list, and no admin controls
    await open(PLAIN);
    check('an ordinary member is told they are a member (not an admin) and sees no admin controls', (await textOf('trip-my-role')) === 'You are a member of this trip.' && !(await exists('trip-edit')) && !(await exists('trip-archive')));
    check('the administrator is tagged; you are tagged You; the heading counts the two current people', (await textOf('member-p1')).includes('Admin') && (await textOf('member-p2')).includes('You') && (await vis(page, 'People (2)').isVisible()));
    await byId(page, 'former-toggle').click();
    check('a member sees the former members too, with their note', (await textOf('former-p3')).includes('A Former Friend') && (await textOf('former-note-p3')).startsWith('Left '));
    await page.setViewportSize({ width: 360, height: 780 });
    check('phone width: a very long former name wraps; no sideways scrolling', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check('phone width: the toggle is a comfortable touch target (44 px)', ((await byId(page, 'former-toggle').boundingBox())?.height ?? 0) >= 44);
    await shot(page, 'details-former-phone');
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(MINIMAL);
    check('a trip nobody has left shows no "Former members" section', !(await exists('section-former')));


    check('no unexpected network calls on the details pages', backend.unexpected.length === 0, backend.unexpected.join(', '));
    await context.close();

    // ---- signed out: sent to sign-in, and no trip data is requested
    {
      const anon = await browser.newContext();
      const anonBackend = newBackend();
      anonBackend.trips = backend.trips;
      await installFakeSupabase(anon, anonBackend);
      const p = await anon.newPage();
      await p.goto(`${BASE}/trips/${GOA}`);
      await byId(p, 'email').waitFor({ timeout: 20000 });
      check('opening a trip address while signed out goes to sign-in', pathOf(p) === '/sign-in', pathOf(p));
      check('...and no trip data is requested', !anonBackend.requests.some((r) => r.path.startsWith('/rest/v1/trips')));
      await anon.close();
    }

    // ---- dark theme
    {
      const dark = await browser.newContext();
      const darkBackend = newBackend();
      darkBackend.trips = backend.trips;
      // The account's saved theme wins after sign-in (by design), so this account must have Dark saved too.
      darkBackend.profile = { ...darkBackend.profile, theme_preference: 'dark' };
      await installFakeSupabase(dark, darkBackend);
      await sessionInStorage(dark);
      await dark.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      const p = await dark.newPage();
      await p.goto(`${BASE}/trips/${GOA}`);
      await byId(p, 'trip-title').waitFor({ timeout: 20000 });
      check('the details page follows the Dark theme', await waitFor(async () => (await screenBg(p)) === DARK_BG));
      await shot(p, 'details-dark');
      await byId(p, 'former-toggle').click();
      check('Dark theme: the former members list opens and is readable', (await byId(p, 'former-members').isVisible()) && (await byId(p, 'former-note-g5').innerText()).startsWith('Left '));
      await shot(p, 'details-former-dark');
      await dark.close();
    }

    // ---- calendar-date boundaries, in time zones far apart, on the REAL browser clock
    console.log('\nG. Trip status and length at date boundaries, in different time zones');
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
      const ctx = await browser.newContext({ timezoneId: zone });
      const b = newBackend();
      const today = todayIn(zone);
      const cases = [
        { id: uuid(101), name: 'Starts today', start: today, end: addDays(today, 3), phase: 'Ongoing', days: '4 days' },
        { id: uuid(102), name: 'Ends today', start: addDays(today, -3), end: today, phase: 'Ongoing', days: '4 days' },
        { id: uuid(103), name: 'Starts tomorrow', start: addDays(today, 1), end: addDays(today, 4), phase: 'Upcoming', days: '4 days' },
        { id: uuid(104), name: 'Ended yesterday', start: addDays(today, -4), end: addDays(today, -1), phase: 'Completed', days: '4 days' },
        { id: uuid(105), name: 'One day today', start: today, end: today, phase: 'Ongoing', days: '1 day' },
      ];
      b.trips = cases.map((c) => tripRow({ id: c.id, name: c.name, destination: 'Test', start_date: c.start, end_date: c.end }));
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      const results: string[] = [];
      let allGood = true;
      for (const c of cases) {
        await p.goto(`${BASE}/trips/${c.id}`);
        await byId(p, 'trip-title').waitFor({ timeout: 20000 });
        const phase = (await byId(p, 'trip-phase').innerText()).trim();
        const days = (await byId(p, 'trip-length').innerText()).trim();
        if (phase !== c.phase || days !== c.days) allGood = false;
        results.push(`${c.name}: ${phase}, ${days}`);
      }
      check(`${zone} (today is ${today}): starts-today and ends-today are Ongoing, tomorrow Upcoming, yesterday Completed, lengths right`, allGood, results.join(' | '));
      await p.goto(BASE);
      await byId(p, 'section-ongoing').waitFor({ timeout: 20000 });
      const ongoing = (await byId(p, 'section-ongoing').innerText()).replace(/\s+/g, ' ');
      const upcoming = (await byId(p, 'section-upcoming').innerText()).replace(/\s+/g, ' ');
      const completed = (await byId(p, 'section-completed').innerText()).replace(/\s+/g, ' ');
      check(`${zone}: the Home list agrees with the details page`, ongoing.includes('Starts today') && ongoing.includes('Ends today') && ongoing.includes('One day today') && upcoming.includes('Starts tomorrow') && completed.includes('Ended yesterday') && !ongoing.includes('Starts tomorrow'), ongoing.slice(0, 120));
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function editFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nH. Edit, archive and restore');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const OTHER_ADMIN = '88888888-8888-4888-8888-888888888888';
    const me = (role: string) => memberRow({ id: `me-${role}-${Math.random().toString(36).slice(2, 6)}`, user_id: USER.id, display_name: 'Asha Rao', role });
    const other = memberRow({ id: 'other-admin', user_id: OTHER_ADMIN, display_name: 'Meera Nair', role: 'admin' });
    const trip = (id: string, name: string, start: number, end: number, over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Place', start_date: dayFromToday(start), end_date: dayFromToday(end), _members: [me('admin')], ...over });

    const T = {
      EDIT: uuid(201), MEMBER: uuid(202), ARCH_UP: uuid(203), HIDDEN_ARCH: uuid(204), ONGOING: uuid(205), CONFLICT: uuid(207),
      ARCH_ONG: uuid(208), ARCH_PAST: uuid(209), CONFLICT2: uuid(210), DOUBLE: uuid(211), FAIL: uuid(212), ARCH_MEMBER: uuid(213), STALE_ARCH: uuid(214),
    };
    const backend = newBackend();
    backend.trips = [
      trip(T.EDIT, 'Edit Me', 30, 33, { description: 'Original', budget_minor: 6_000_000 }),
      trip(T.MEMBER, 'Member Trip', 30, 33, { _members: [me('member'), other] }),
      trip(T.ARCH_UP, 'Archived Upcoming', 10, 12, { status: 'archived' }),
      trip(T.ARCH_ONG, 'Archived Ongoing', -1, 2, { status: 'archived' }),
      trip(T.ARCH_PAST, 'Archived Past', -60, -57, { status: 'archived' }),
      trip(T.ARCH_MEMBER, 'Archived Member Trip', -90, -88, { status: 'archived', _members: [me('member'), other] }),
      trip(T.HIDDEN_ARCH, 'Hidden Archived', 5, 6, { status: 'archived', _hidden: true }),
      trip(T.ONGOING, 'Ongoing Trip', -1, 2),
      trip(T.CONFLICT, 'Conflict Trip', 40, 42, { description: 'Before' }),
      trip(T.CONFLICT2, 'Conflict Two', 45, 47),
      trip(T.DOUBLE, 'Double Tap', 50, 52),
      trip(T.FAIL, 'Failure Trip', 55, 57),
      trip(T.STALE_ARCH, 'Stale Archive', 60, 62),
    ];
    const row = (id: string) => backend.trips.find((t) => t.id === id)!;
    const context = await browser.newContext();
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();

    const rpc = (fn: string, id?: string) => backend.requests.filter((r) => r.method === 'POST' && r.path.startsWith(`/rest/v1/rpc/${fn}`) && (!id || r.body?.p_trip_id === id));
    const updates = (id?: string) => rpc('update_trip', id);
    const archives = (id?: string) => rpc('set_trip_archived', id);
    const text = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const go = async (path: string, waitFor: string) => {
      await page.goto(`${BASE}${path}`);
      return byId(page, waitFor).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const exists = async (id: string) => (await byId(page, id).count()) > 0;
    const archivedExpected = () => backend.trips.filter((t) => t.status === 'archived' && !t._hidden).length;

    // ============ who sees the buttons ============
    await go(`/trips/${T.EDIT}`, 'trip-title');
    check('an administrator sees Edit and Archive on the trip page', (await exists('trip-edit')) && (await exists('trip-archive')) && !(await exists('trip-restore')));
    check('...and not the "only admins" note', !(await exists('trip-members-note')));
    await go(`/trips/${T.MEMBER}`, 'trip-title');
    check('an ordinary member sees neither Edit nor Archive', !(await exists('trip-edit')) && !(await exists('trip-archive')) && !(await exists('trip-restore')));
    check('...and is told only admins can', (await text('trip-members-note')) === 'Only trip admins can edit, archive or restore this trip.');

    // ============ the edit form ============
    await byId(page, 'trip-back-home').click();
    await go(`/trips/${T.EDIT}`, 'trip-edit');
    await byId(page, 'trip-edit').click();
    const formOpened = await byId(page, 'trip-name').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('Edit trip opens /trips/<id>/edit', formOpened && pathOf(page) === `/trips/${T.EDIT}/edit`, pathOf(page));
    const startDmy = asDmy(dayFromToday(30));
    const endDmy = asDmy(dayFromToday(33));
    check('the form is pre-filled (dates as DD/MM/YYYY, budget as typed rupees)',
      (await byId(page, 'trip-name').inputValue()) === 'Edit Me' && (await byId(page, 'trip-destination').inputValue()) === 'Place' &&
      (await byId(page, 'trip-start').inputValue()) === startDmy && (await byId(page, 'trip-end').inputValue()) === endDmy &&
      (await byId(page, 'trip-description').inputValue()) === 'Original' && (await byId(page, 'trip-budget').inputValue()) === '60000');
    check('the currency is shown but not editable, with the reason', (await text('edit-currency')) === 'INR' && (await exists('trip-currency-INR')) === false && (await vis(page, 'Fixed when the trip is created').isVisible()));
    check('Save is disabled until something changes', (await byId(page, 'edit-save').getAttribute('aria-disabled')) === 'true');
    await page.reload();
    check('reloading the edit address keeps the form', await byId(page, 'trip-name').waitFor({ timeout: 20000 }).then(() => true, () => false) && (await byId(page, 'trip-name').inputValue()) === 'Edit Me');

    // typing and reverting is "no change"
    await byId(page, 'trip-name').fill('Edit Me!');
    // An enabled button simply has no "disabled" marker (the attribute is absent or "false"); a disabled one says "true".
    check('changing something enables Save', (await byId(page, 'edit-save').getAttribute('aria-disabled')) !== 'true');
    await byId(page, 'trip-name').fill('Edit Me');
    check('putting it back disables Save again (no change = nothing to save)', (await byId(page, 'edit-save').getAttribute('aria-disabled')) === 'true');

    // validation: same rules and words as Create
    await byId(page, 'trip-name').fill('');
    await byId(page, 'trip-start').fill(asDmy(dayFromToday(10)));
    await byId(page, 'trip-end').fill(asDmy(dayFromToday(5)));
    await byId(page, 'trip-budget').fill('lots');
    await byId(page, 'edit-save').click();
    const msgs = await vis(page, 'Enter a trip name').waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('invalid edits show the same messages as Create', msgs && (await vis(page, 'The end date must be on or after the start date').isVisible()) && (await vis(page, 'Enter a budget like 60000').isVisible()));
    check('...and nothing is sent', updates().length === 0);

    // a valid edit
    const newStart = dayFromToday(31);
    const newEnd = dayFromToday(34);
    await byId(page, 'trip-name').fill('  Edited Trip  ');
    await byId(page, 'trip-destination').fill('New Place');
    await byId(page, 'trip-start').fill(asDmy(newStart));
    await byId(page, 'trip-end').fill(asDmy(newEnd));
    await byId(page, 'trip-description').fill('');
    await byId(page, 'trip-budget').fill('75,000.50');
    await byId(page, 'edit-save').click();
    const back = await byId(page, 'trip-title').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('saving returns to the trip page', back && pathOf(page) === `/trips/${T.EDIT}`, pathOf(page));
    const u1 = updates(T.EDIT)[0];
    check('the request has exactly the approved fields, cleaned, with the starting version',
      !!u1 && JSON.stringify(u1.body) === JSON.stringify({
        p_trip_id: T.EDIT, p_expected_version: 1, p_name: 'Edited Trip', p_destination: 'New Place', p_start_date: newStart, p_end_date: newEnd, p_description: null, p_budget_minor: 7_500_050,
      }), JSON.stringify(u1?.body));
    check('...never currency, status or creator', !!u1 && !/currency|status|created_by/.test(Object.keys(u1.body).join(',')));
    check('the request carries the user\'s login, not a secret key', !!u1?.auth?.startsWith('Bearer ') && !u1.auth.includes('sb_secret'));
    check('the trip page shows the new details', (await text('trip-title')) === 'Edited Trip' && (await text('trip-destination')) === 'New Place' && (await text('trip-budget')) === '₹75,000.50' && (await text('trip-description')) === 'No description' && (await text('trip-dates')) === formatDateRange(newStart, newEnd));
    await byId(page, 'trip-back-home').click();
    await byId(page, 'section-upcoming').waitFor({ timeout: 10000 });
    check('Home shows the new name', (await text('section-upcoming')).includes('Edited Trip') && !(await text('section-upcoming')).includes('Edit Me'));

    // the second edit starts from the NEW version
    await go(`/trips/${T.EDIT}/edit`, 'trip-name');
    await byId(page, 'trip-name').fill('Edited Twice');
    await byId(page, 'edit-save').click();
    await byId(page, 'trip-title').waitFor({ timeout: 10000 });
    check('a second edit starts from the new version (2)', updates(T.EDIT)[1]?.body.p_expected_version === 2, String(updates(T.EDIT)[1]?.body.p_expected_version));

    // clearing the budget
    await go(`/trips/${T.EDIT}/edit`, 'trip-name');
    await byId(page, 'trip-budget').fill('');
    await byId(page, 'edit-save').click();
    await byId(page, 'trip-title').waitFor({ timeout: 10000 });
    check('a budget can be removed', updates(T.EDIT)[2]?.body.p_budget_minor === null && (await text('trip-budget')) === 'No budget set');

    // ============ another admin changes the trip first (concurrency) ============
    await go(`/trips/${T.CONFLICT}/edit`, 'trip-name');
    const vBefore = row(T.CONFLICT).version;
    Object.assign(row(T.CONFLICT), { name: 'Changed by Meera', description: 'Meera note', version: vBefore + 1 }); // someone else saves while this form is open
    await byId(page, 'trip-destination').fill('Mine');
    await byId(page, 'edit-save').click();
    const conflictMsg = await byId(page, 'form-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('if someone else changed the trip first, the save is refused with a clear message', conflictMsg && (await text('form-error')) === 'This trip was changed by someone else. Reload to see the latest, then try again.', await text('form-error'));
    check('...nothing of theirs was overwritten', row(T.CONFLICT).name === 'Changed by Meera' && row(T.CONFLICT).description === 'Meera note' && row(T.CONFLICT).destination === 'Place' && row(T.CONFLICT).version === vBefore + 1);
    check('...and a Reload button is offered', await byId(page, 'edit-reload').isVisible());
    await byId(page, 'edit-reload').click();
    check('Reload shows the latest saved version', await waitFor(async () => (await byId(page, 'trip-name').inputValue()) === 'Changed by Meera') && (await byId(page, 'trip-description').inputValue()) === 'Meera note');
    await byId(page, 'trip-destination').fill('Mine');
    await byId(page, 'edit-save').click();
    await byId(page, 'trip-title').waitFor({ timeout: 10000 });
    const retry = updates(T.CONFLICT).at(-1)!;
    check('retrying works from the latest version and keeps the other admin\'s changes', retry.body.p_expected_version === vBefore + 1 && retry.body.p_name === 'Changed by Meera' && retry.body.p_description === 'Meera note' && row(T.CONFLICT).destination === 'Mine' && row(T.CONFLICT).name === 'Changed by Meera');

    // ============ what the database can answer ============
    await go(`/trips/${T.FAIL}/edit`, 'trip-name');
    const tryFail = async (mode: typeof backend.rpcFail) => {
      backend.rpcFail = mode;
      await byId(page, 'trip-name').fill(`Fail ${mode} ${Math.random().toString(36).slice(2, 5)}`);
      await byId(page, 'edit-save').click();
      await byId(page, 'form-error').waitFor({ timeout: 8000 }).catch(() => {});
      return text('form-error');
    };
    check('a refusal "not an admin" is explained', (await tryFail('not_admin')) === 'Only trip admins can do that.');
    check('"trip not found" gives the same combined message as the details page', (await tryFail('trip_not_found')) === "We couldn't open this trip. It may have been removed, or you may not be a member.");
    check('"archived" is explained', (await tryFail('trip_archived')) === 'This trip is archived. Restore it to make changes.');
    check('a connection failure is explained', /Can't reach the server/.test(await tryFail('network')));
    check('the form is still open with the typing kept after failures', pathOf(page) === `/trips/${T.FAIL}/edit` && /^Fail network/.test(await byId(page, 'trip-name').inputValue()));
    backend.rpcFail = null;
    await byId(page, 'edit-save').click();
    check('after the connection returns, Save works', await byId(page, 'trip-title').waitFor({ timeout: 10000 }).then(() => true, () => false));

    // double tap
    await go(`/trips/${T.DOUBLE}/edit`, 'trip-name');
    backend.slowRpcMs = 1200;
    await byId(page, 'trip-name').fill('Double Tapped');
    await byId(page, 'edit-save').click();
    await byId(page, 'edit-save').click({ timeout: 800, force: true }).catch(() => {});
    await byId(page, 'trip-title').waitFor({ timeout: 10000 });
    backend.slowRpcMs = 0;
    check('tapping Save twice sends only one request', updates(T.DOUBLE).length === 1, String(updates(T.DOUBLE).length));

    // ============ direct addresses ============
    const before = updates().length;
    await go(`/trips/${T.MEMBER}/edit`, 'edit-not-admin');
    check('an ordinary member opening the edit address sees "only admins" and no form', (await exists('edit-not-admin')) && !(await exists('trip-name')));
    await go(`/trips/${T.HIDDEN_ARCH}/edit`, 'trip-unavailable');
    check('a trip you are not on shows the combined message on the edit address too', (await text('trip-unavailable')) === "We couldn't open this trip. It may have been removed, or you may not be a member." && !(await exists('trip-name')));
    await go(`/trips/not-a-uuid/edit`, 'trip-unavailable');
    check('a malformed edit address shows the same message', (await exists('trip-unavailable')) && !(await exists('trip-name')));
    await go(`/trips/${T.ARCH_UP}/edit`, 'edit-archived');
    check('an archived trip cannot be edited: "restore it first", no form', (await exists('edit-archived')) && !(await exists('trip-name')));
    check('none of those attempts sent an edit', updates().length === before);
    {
      const anon = await browser.newContext();
      const anonBackend = newBackend();
      anonBackend.trips = backend.trips;
      await installFakeSupabase(anon, anonBackend);
      const p = await anon.newPage();
      await p.goto(`${BASE}/trips/${T.EDIT}/edit`);
      await byId(p, 'email').waitFor({ timeout: 20000 });
      check('signed out, the edit address goes to sign-in and requests nothing', pathOf(p) === '/sign-in' && !anonBackend.requests.some((r) => r.path.startsWith('/rest/v1/trips') || r.path.startsWith('/rest/v1/rpc')));
      await anon.close();
    }

    // ============ Home: archived section ============
    await go('/', 'greeting');
    await byId(page, 'section-archived').waitFor({ timeout: 10000 });
    check('Home shows an "Archived (n)" section counting only trips this person can access', (await text('archived-toggle')).includes(`Archived (${archivedExpected()})`) && !(await page.locator('body').innerText()).includes('Hidden Archived'), await text('archived-toggle'));
    check('it is collapsed by default (no archived card showing)', !(await exists(`trip-card-${T.ARCH_UP}`)));
    check('archived trips are not in Ongoing, Upcoming or Completed', !/Archived/.test((await text('section-ongoing')) + (await text('section-upcoming')) + (await text('section-completed'))));
    check('accessibility: the toggle says it is collapsed', (await byId(page, 'archived-toggle').getAttribute('aria-expanded')) === 'false');
    await byId(page, 'archived-toggle').click();
    await byId(page, `trip-card-${T.ARCH_UP}`).waitFor({ timeout: 5000 });
    check('expanding shows the archived trips, each tagged "Archived"', (await exists(`archived-tag-${T.ARCH_UP}`)) && (await exists(`archived-tag-${T.ARCH_PAST}`)) && (await byId(page, 'archived-toggle').getAttribute('aria-expanded')) === 'true');
    await shot(page, 'home-archived');
    await byId(page, `trip-card-${T.ARCH_UP}`).click();
    check('an archived trip opens its page, with the Archived notice', await byId(page, 'trip-archived').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // ============ archive ============
    await go(`/trips/${T.ONGOING}`, 'trip-archive');
    await byId(page, 'trip-archive').click();
    const dialog = await byId(page, 'confirm-dialog').waitFor({ timeout: 5000 }).then(() => true, () => false);
    check('Archive asks for confirmation first', dialog && (await text('confirm-title')) === 'Archive this trip?');
    check('the confirmation names the trip and says nothing is deleted', /Ongoing Trip/.test(await text('confirm-message')) && /Nothing is deleted/.test(await text('confirm-message')));
    check('accessibility: the dialog is announced as an alert dialog', (await byId(page, 'confirm-dialog').getAttribute('role')) === 'alertdialog' && !!(await byId(page, 'confirm-dialog').getAttribute('aria-label')));
    await page.waitForTimeout(800); // let the fade-in finish so the screenshot shows the finished dialog
    await shot(page, 'archive-dialog');
    await page.keyboard.press('Escape');
    check('the Escape key closes the archive dialog without archiving', (await waitFor(async () => !(await exists('confirm-dialog')))) && archives(T.ONGOING).length === 0 && (await exists('trip-archive')));
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-dialog').waitFor({ timeout: 5000 });
    await byId(page, 'confirm-cancel').click();
    await waitFor(async () => !(await exists('confirm-dialog')));
    check('Cancel closes it, sends nothing and leaves the trip active', !(await exists('confirm-dialog')) && archives(T.ONGOING).length === 0 && (await exists('trip-archive')) && !(await exists('trip-archived')));
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    const archivedShown = await byId(page, 'trip-archived').waitFor({ timeout: 8000 }).then(() => true, () => false);
    const a1 = archives(T.ONGOING)[0];
    check('confirming archives the trip', archivedShown && (await text('trip-notice')) === 'Trip archived.');
    check('the request is exactly: this trip, archive, the current version', !!a1 && JSON.stringify(a1.body) === JSON.stringify({ p_trip_id: T.ONGOING, p_archived: true, p_expected_version: 1 }), JSON.stringify(a1?.body));
    check('an archived trip offers Restore and no longer offers Edit or Archive', (await exists('trip-restore')) && !(await exists('trip-edit')) && !(await exists('trip-archive')));
    await byId(page, 'trip-back-home').click();
    await byId(page, 'section-archived').waitFor({ timeout: 10000 });
    check('on Home it left Ongoing and the Archived count went up by one', !(await text('section-ongoing').catch(() => '')).includes('Ongoing Trip') && (await text('archived-toggle')).includes(`Archived (${archivedExpected()})`), await text('archived-toggle'));

    // archived by someone else behind the page's back: archiving again is safe, not an error
    await go(`/trips/${T.STALE_ARCH}`, 'trip-archive');
    Object.assign(row(T.STALE_ARCH), { status: 'archived', version: row(T.STALE_ARCH).version + 1 });
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    check('archiving a trip that is already archived is safe (no error, no second version)', await byId(page, 'trip-notice').waitFor({ timeout: 8000 }).then(() => true, () => false) && row(T.STALE_ARCH).version === 2 && !(await exists('trip-action-error')));

    // conflict on archive
    await go(`/trips/${T.CONFLICT2}`, 'trip-archive');
    row(T.CONFLICT2).version += 1;
    row(T.CONFLICT2).description = 'Changed meanwhile';
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    const archConflict = await byId(page, 'trip-action-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('archiving from an outdated page is refused with the "changed by someone else" message', archConflict && (await text('trip-action-error')) === 'This trip was changed by someone else. Reload to see the latest, then try again.' && row(T.CONFLICT2).status === 'active');
    // (The dialog fades out, so give it a moment before checking that it is gone.)
    check('...the dialog closes and Reload latest is offered', (await waitFor(async () => !(await exists('confirm-dialog')))) && (await exists('trip-reload')));
    await byId(page, 'trip-reload').click();
    await waitFor(async () => !(await exists('trip-action-error')));
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    check('after reloading, archiving works', await byId(page, 'trip-archived').waitFor({ timeout: 8000 }).then(() => true, () => false) && row(T.CONFLICT2).status === 'archived');

    // errors inside the dialog
    await go(`/trips/${T.DOUBLE}`, 'trip-archive');
    backend.rpcFail = 'network';
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    const netInDialog = await byId(page, 'confirm-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('a connection failure keeps the dialog open with a message, so it can simply be retried', netInDialog && /Can't reach the server/.test(await text('confirm-error')) && (await exists('confirm-dialog')));
    backend.rpcFail = null;
    await byId(page, 'confirm-confirm').click();
    check('retrying from the same dialog works', await byId(page, 'trip-archived').waitFor({ timeout: 8000 }).then(() => true, () => false));
    await go(`/trips/${T.FAIL}`, 'trip-archive');
    backend.rpcFail = 'not_admin';
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    check('if your admin rights were removed meanwhile, the page says only admins can', await byId(page, 'trip-action-error').waitFor({ timeout: 8000 }).then(() => true, () => false) && (await text('trip-action-error')) === 'Only trip admins can do that.');
    backend.rpcFail = null;

    // double tap on confirm
    await go(`/trips/${T.EDIT}`, 'trip-archive');
    backend.slowRpcMs = 1200;
    await byId(page, 'trip-archive').click();
    await byId(page, 'confirm-confirm').click();
    await byId(page, 'confirm-confirm').click({ timeout: 800, force: true }).catch(() => {});
    await byId(page, 'trip-archived').waitFor({ timeout: 10000 });
    backend.slowRpcMs = 0;
    check('tapping Archive twice sends only one request', archives(T.EDIT).length === 1, String(archives(T.EDIT).length));

    // ============ restore ============
    const restoreAndCheck = async (id: string, name: string, section: string, label: string) => {
      const beforeRow = { ...row(id) };
      await go(`/trips/${id}`, 'trip-restore');
      await byId(page, 'trip-restore').click();
      const t = await text('confirm-title');
      await byId(page, 'confirm-confirm').click();
      const ok = await byId(page, 'trip-notice').waitFor({ timeout: 8000 }).then(() => true, () => false);
      const req = archives(id).at(-1);
      check(`${label}: Restore asks first, then restores`, t === 'Restore this trip?' && ok && (await text('trip-notice')) === 'Trip restored.' && !(await exists('trip-archived')) && (await exists('trip-edit')));
      check(`${label}: the request is "restore" with the current version only`, !!req && JSON.stringify(req.body) === JSON.stringify({ p_trip_id: id, p_archived: false, p_expected_version: beforeRow.version }), JSON.stringify(req?.body));
      const after = row(id);
      check(`${label}: nothing else about the trip changed`, (['name', 'destination', 'start_date', 'end_date', 'description', 'budget_minor', 'currency', 'created_by'] as const).every((k) => after[k] === beforeRow[k]) && after.status === 'active');
      await byId(page, 'trip-back-home').click();
      await byId(page, `section-${section}`).waitFor({ timeout: 10000 });
      check(`${label}: it returns to the "${section}" group on Home`, (await text(`section-${section}`)).includes(name));
    };
    await restoreAndCheck(T.ARCH_ONG, 'Archived Ongoing', 'ongoing', 'restoring a trip whose dates are happening now');
    await restoreAndCheck(T.ARCH_UP, 'Archived Upcoming', 'upcoming', 'restoring a future trip');
    await restoreAndCheck(T.ARCH_PAST, 'Archived Past', 'completed', 'restoring a finished trip');
    await go('/', 'greeting');
    check('the Archived count always equals the archived trips this person can access', (await text('archived-toggle')).includes(`Archived (${archivedExpected()})`), await text('archived-toggle'));

    // members cannot restore
    await go(`/trips/${T.ARCH_MEMBER}`, 'trip-archived');
    check('an ordinary member of an archived trip sees the notice but no Restore button', !(await exists('trip-restore')) && (await exists('trip-members-note')));

    check('no unexpected network calls in the edit/archive run', backend.unexpected.length === 0, backend.unexpected.join(', '));
    await context.close();

    // ============ dark theme ============
    {
      const dark = await browser.newContext();
      const b = newBackend();
      b.trips = backend.trips;
      b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(dark, b);
      await sessionInStorage(dark);
      await dark.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      const p = await dark.newPage();
      await p.goto(`${BASE}/trips/${T.DOUBLE}/edit`);
      await byId(p, 'trip-name').waitFor({ timeout: 20000 }).catch(() => {});
      await p.goto(`${BASE}/trips/${T.FAIL}/edit`);
      await byId(p, 'trip-name').waitFor({ timeout: 20000 });
      check('the edit page follows the Dark theme', await waitFor(async () => (await screenBg(p)) === DARK_BG));
      await shot(p, 'edit-dark');
      await p.goto(`${BASE}/trips/${T.FAIL}`);
      await byId(p, 'trip-archive').waitFor({ timeout: 20000 });
      await byId(p, 'trip-archive').click();
      await byId(p, 'confirm-dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(800); // let the fade-in finish
      await shot(p, 'archive-dialog-dark');
      await dark.close();
    }

    // ============ dates and categories in different time zones ============
    console.log('\nI. Editing dates moves a trip between groups, in different time zones');
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
      const ctx = await browser.newContext({ timezoneId: zone });
      const zb = newBackend();
      const today = todayIn(zone);
      const Z = uuid(301);
      zb.trips = [tripRow({ id: Z, name: 'Zone Trip', destination: 'Test', start_date: addDays(today, 10), end_date: addDays(today, 12), _members: [me('admin')] })];
      await installFakeSupabase(ctx, zb);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      const edit = async (start: string, end: string) => {
        await p.goto(`${BASE}/trips/${Z}/edit`);
        await byId(p, 'trip-name').waitFor({ timeout: 20000 });
        await byId(p, 'trip-start').fill(asDmy(start));
        await byId(p, 'trip-end').fill(asDmy(end));
        await byId(p, 'edit-save').click();
        await byId(p, 'trip-title').waitFor({ timeout: 10000 });
        return (await byId(p, 'trip-phase').innerText()).trim();
      };
      const homeHas = async (section: string) => {
        await p.goto(BASE);
        await byId(p, `section-${section}`).waitFor({ timeout: 20000 }).catch(() => {});
        return (await byId(p, `section-${section}`).innerText().catch(() => '')).includes('Zone Trip');
      };
      const startsToday = await edit(today, addDays(today, 2));
      const h1 = await homeHas('ongoing');
      check(`${zone} (today ${today}): editing a trip to START TODAY makes it Ongoing, on the page and on Home`, startsToday === 'Ongoing' && h1, startsToday);
      const endsToday = await edit(addDays(today, -3), today);
      const h2 = await homeHas('ongoing');
      check(`${zone}: editing a trip to END TODAY keeps it Ongoing`, endsToday === 'Ongoing' && h2, endsToday);
      const past = await edit(addDays(today, -5), addDays(today, -1));
      const h3 = await homeHas('completed');
      check(`${zone}: editing a trip to END YESTERDAY makes it Completed`, past === 'Completed' && h3, past);
      const future = await edit(addDays(today, 1), addDays(today, 3));
      const h4 = await homeHas('upcoming');
      check(`${zone}: editing a trip to START TOMORROW makes it Upcoming`, future === 'Upcoming' && h4, future);
      // archive, then restore: back in the group its dates say
      await p.goto(`${BASE}/trips/${Z}`);
      await byId(p, 'trip-archive').click();
      await byId(p, 'confirm-confirm').click();
      await byId(p, 'trip-archived').waitFor({ timeout: 8000 });
      await p.goto(BASE);
      await byId(p, 'section-archived').waitFor({ timeout: 20000 });
      const gone = !(await byId(p, 'section-upcoming').innerText().catch(() => '')).includes('Zone Trip');
      await p.goto(`${BASE}/trips/${Z}`);
      await byId(p, 'trip-restore').click();
      await byId(p, 'confirm-confirm').click();
      await byId(p, 'trip-notice').waitFor({ timeout: 8000 });
      const h5 = await homeHas('upcoming');
      check(`${zone}: archived trips leave the groups, and a restored trip returns to the right one`, gone && h5);
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function dateFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nJ. Date input and calendar (Create and Edit share one field)');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const TRIP = uuid(401);
    const seed = () => [
      tripRow({ id: TRIP, name: 'Date Trip', destination: 'Place', start_date: '2026-12-27', end_date: '2026-12-30', _members: [memberRow({ id: 'dm', user_id: USER.id, display_name: 'Asha Rao', role: 'admin' })] }),
    ];
    const newContext = async (opts: Parameters<typeof browser.newContext>[0] = {}, mutate?: (b: FakeBackend) => void) => {
      const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...opts });
      const b = newBackend();
      b.trips = seed();
      mutate?.(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      return { ctx, b, page: await ctx.newPage() };
    };

    /** The same battery of checks, run on the Create form and then on the Edit form. */
    async function battery(page: Page, backend: FakeBackend, form: 'Create' | 'Edit') {
      const S = 'trip-start';
      const E = 'trip-end';
      const submit = form === 'Create' ? 'create-trip-submit' : 'edit-save';
      const rpcName = form === 'Create' ? 'create_trip' : 'update_trip';
      const rpcCalls = () => backend.requests.filter((r) => r.method === 'POST' && r.path.startsWith(`/rest/v1/rpc/${rpcName}`));
      const val = (id: string) => byId(page, id).inputValue();
      const caret = (id: string) => byId(page, id).evaluate((e) => [(e as HTMLInputElement).selectionStart, (e as HTMLInputElement).selectionEnd]);
      const typeKeys = async (id: string, text: string) => {
        const el = byId(page, id);
        await el.click();
        await el.fill('');
        await el.pressSequentially(text);
      };
      const paste = async (id: string, text: string) => {
        const el = byId(page, id);
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
        await el.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Control+V');
      };
      const setCaret = (id: string, pos: number) => byId(page, id).evaluate((e, p) => { (e as HTMLInputElement).focus(); (e as HTMLInputElement).setSelectionRange(p, p); }, pos);
      const pickerOpen = async () => (await page.locator('[data-testid="date-picker"]:visible').count()) > 0;
      const closed = () => waitFor(async () => !(await pickerOpen()));
      const day = (iso: string) => byId(page, `date-picker-day-${iso}`);
      const startErr = () => vis(page, 'Enter the start date like 27/12/2026');
      const P = `${form}:`;

      // ---------- automatic formatting while typing ----------
      await typeKeys(S, '27122026');
      check(`${P} typing 27122026 gives 27/12/2026`, (await val(S)) === '27/12/2026', await val(S));
      await typeKeys(S, '05012027');
      check(`${P} 05012027 gives 05/01/2027`, (await val(S)) === '05/01/2027', await val(S));
      await typeKeys(S, '01012027');
      check(`${P} 01012027 gives 01/01/2027`, (await val(S)) === '01/01/2027', await val(S));
      await typeKeys(S, '271');
      check(`${P} the slash appears when the third digit is typed (27/1)`, (await val(S)) === '27/1', await val(S));
      await typeKeys(S, '2712');
      check(`${P} partial input is kept as typed (27/12)`, (await val(S)) === '27/12', await val(S));
      await typeKeys(S, '27/12/2026');
      check(`${P} correctly formatted dates typed with slashes are accepted unchanged`, (await val(S)) === '27/12/2026', await val(S));
      await typeKeys(S, '5/1/2027');
      check(`${P} single-digit day and month typed with slashes are padded (5/1/2027 -> 05/01/2027)`, (await val(S)) === '05/01/2027', await val(S));
      check(`${P} the caret ends up at the end after typing`, (await caret(S)).join() === '10,10', (await caret(S)).join());

      // ---------- restrictions ----------
      await typeKeys(S, 'ab27xy12!@#2026');
      check(`${P} letters and symbols are rejected while typing`, (await val(S)) === '27/12/2026', await val(S));
      await typeKeys(S, 'abc');
      check(`${P} letters alone leave the box empty`, (await val(S)) === '', await val(S));
      await typeKeys(S, '27-12-2026');
      check(`${P} dashes typed one at a time are rejected (only digits and automatic slashes remain)`, (await val(S)) === '27/12/2026', await val(S));
      await typeKeys(S, '271220269999');
      check(`${P} nothing beyond DD/MM/YYYY is accepted`, (await val(S)) === '27/12/2026', await val(S));
      const attr = await byId(page, S).getAttribute('inputmode');
      check(`${P} phones get the number keypad (inputmode numeric)`, attr === 'numeric', String(attr));

      // ---------- paste (real clipboard) ----------
      await paste(S, '27122026');
      check(`${P} pasting 27122026 gives 27/12/2026`, (await val(S)) === '27/12/2026', await val(S));
      await paste(S, '05/01/2027');
      check(`${P} pasting 05/01/2027 keeps it`, (await val(S)) === '05/01/2027', await val(S));
      await paste(S, '2026-12-27');
      check(`${P} pasting an ISO date (2026-12-27) gives 27/12/2026`, (await val(S)) === '27/12/2026', await val(S));
      await paste(S, '27-12-2026');
      check(`${P} pasting 27-12-2026 gives 27/12/2026`, (await val(S)) === '27/12/2026', await val(S));
      await paste(S, 'abc27122026xyz');
      check(`${P} pasting text with letters keeps only the digits`, (await val(S)) === '27/12/2026', await val(S));
      check(`${P} after a paste the caret is at the end`, (await caret(S)).join() === '10,10', (await caret(S)).join());
      await paste(S, '!!!');
      check(`${P} pasting only symbols leaves the box empty`, (await val(S)) === '', await val(S));

      // ---------- backspace and the caret ----------
      await typeKeys(S, '27122026');
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Backspace');
        seen.push(await val(S));
      }
      check(`${P} backspace removes one thing at a time, stepping over automatic slashes`, JSON.stringify(seen) === JSON.stringify(['27/12/202', '27/12/20', '27/12/2', '27/12', '27/1', '27', '2', '']), seen.join(' | '));
      await typeKeys(S, '27122026');
      await setCaret(S, 3);
      await page.keyboard.press('Backspace');
      check(`${P} backspace right after an automatic slash moves over it without losing a digit`, (await val(S)) === '27/12/2026' && (await caret(S)).join() === '2,2', `${await val(S)} caret ${(await caret(S)).join()}`);
      await setCaret(S, 4);
      await page.keyboard.press('Backspace');
      check(`${P} deleting a digit in the middle keeps the date tidy and the caret in place`, (await val(S)) === '27/02/2026' && (await caret(S)).join() === '3,3', `${await val(S)} caret ${(await caret(S)).join()}`);
      await typeKeys(S, '27122026');
      await setCaret(S, 2);
      await page.keyboard.type('5');
      check(`${P} typing a digit in the middle shifts the rest and keeps the caret just after it`, (await val(S)) === '27/51/2202' && (await caret(S)).join() === '4,4', `${await val(S)} caret ${(await caret(S)).join()}`);
      await typeKeys(S, '27122026');
      await setCaret(S, 10);
      for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('2027');
      check(`${P} editing an existing date: delete the year and type a new one`, (await val(S)) === '27/12/2027', await val(S));

      // ---------- invalid dates never pass validation ----------
      await typeKeys(E, '30122026');
      const before = rpcCalls().length;
      for (const bad of ['31022026', '29022027', '30022026', '31042026', '00012026', '32012026', '15132026', '15002026', '01011999', '01012101', '29022100']) {
        await typeKeys(S, bad);
        const shown = await val(S);
        await byId(page, submit).click();
        const rejected = await startErr().waitFor({ timeout: 4000 }).then(() => true, () => false);
        check(`${P} ${shown} is not accepted (it is shown as typed, never "corrected")`, rejected && shown === `${bad.slice(0, 2)}/${bad.slice(2, 4)}/${bad.slice(4)}`, shown);
      }
      check(`${P} none of the invalid dates reached the server`, rpcCalls().length === before);
      await typeKeys(S, '2712');
      await byId(page, submit).click();
      check(`${P} a partial date (27/12) is rejected`, await startErr().waitFor({ timeout: 4000 }).then(() => true, () => false));
      await typeKeys(S, '');
      await byId(page, 'trip-end').fill('');
      await byId(page, submit).click();
      check(`${P} empty dates are rejected (both fields)`, (await startErr().waitFor({ timeout: 4000 }).then(() => true, () => false)) && (await vis(page, 'Enter the end date like 27/12/2026').isVisible()));

      // ---------- calendar ----------
      const calBtn = byId(page, `${S}-calendar`);
      check(`${P} accessibility: the calendar button is named`, (await calBtn.getAttribute('aria-label')) === 'Choose start date from a calendar');
      await typeKeys(S, '27122026');
      await calBtn.click();
      const opened = await byId(page, 'date-picker').waitFor({ timeout: 5000 }).then(() => true, () => false);
      check(`${P} the calendar button opens a calendar`, opened);
      check(`${P} accessibility: it is a dialog named "Start date"`, (await byId(page, 'date-picker').getAttribute('role')) === 'dialog' && (await byId(page, 'date-picker').getAttribute('aria-label')) === 'Start date');
      check(`${P} it opens on the month of the typed date, with that day selected`, (await byId(page, 'date-picker-month').innerText()) === 'December 2026' && (await day('2026-12-27').getAttribute('aria-pressed')) === 'true');
      check(`${P} accessibility: each day is named in full (27 December 2026)`, (await day('2026-12-27').getAttribute('aria-label')) === '27 December 2026');
      await day('2026-12-15').click();
      check(`${P} choosing a day fills the box (15/12/2026) and closes the calendar`, (await closed()) && (await val(S)) === '15/12/2026', await val(S));
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} reopening shows the newly chosen day selected`, (await day('2026-12-15').getAttribute('aria-pressed')) === 'true');
      await byId(page, 'date-picker-next-month').click();
      check(`${P} next month moves to January 2027`, (await byId(page, 'date-picker-month').innerText()) === 'January 2027');
      await day('2027-01-05').click();
      check(`${P} a single-digit day from the calendar is written with a zero (05/01/2027)`, (await closed()) && (await val(S)) === '05/01/2027', await val(S));
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await byId(page, 'date-picker-next-year').click();
      check(`${P} next year keeps the month (January 2028)`, (await byId(page, 'date-picker-month').innerText()) === 'January 2028');
      await byId(page, 'date-picker-prev-year').click();
      await byId(page, 'date-picker-prev-month').click();
      check(`${P} previous year and previous month work (December 2026)`, (await byId(page, 'date-picker-month').innerText()) === 'December 2026');
      await byId(page, 'date-picker-close').click();
      check(`${P} Close leaves the date unchanged`, (await closed()) && (await val(S)) === '05/01/2027');
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await page.waitForTimeout(800); // the web dialog starts listening for Escape once its fade-in has finished
      await page.keyboard.press('Escape');
      check(`${P} the Escape key closes the calendar without changing anything`, (await closed()) && (await val(S)) === '05/01/2027');
      await calBtn.focus();
      await page.keyboard.press('Enter');
      check(`${P} the calendar can be opened from the keyboard (Enter)`, await byId(page, 'date-picker').waitFor({ timeout: 5000 }).then(() => true, () => false));
      await byId(page, 'date-picker-today').click();
      check(`${P} "Today" chooses today's date`, (await closed()) && (await val(S)) === asDmy(dayFromToday(0)), await val(S));

      // switching between typing and the calendar, both ways
      await typeKeys(S, '29122026');
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} typing then opening the calendar: it shows the typed date`, (await byId(page, 'date-picker-month').innerText()) === 'December 2026' && (await day('2026-12-29').getAttribute('aria-pressed')) === 'true');
      await day('2026-12-30').click();
      await closed();
      check(`${P} choosing in the calendar updates the box (30/12/2026)`, (await val(S)) === '30/12/2026');
      await byId(page, S).click();
      await setCaret(S, 10);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      check(`${P} then editing by hand works (30/12/20)`, (await val(S)) === '30/12/20', await val(S));
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} a half-typed date selects nothing in the calendar`, (await page.locator('[data-testid^="date-picker-day-"][aria-pressed="true"]:visible').count()) === 0);
      await byId(page, 'date-picker-close').click();
      await closed();
      await byId(page, S).click();
      await setCaret(S, 8);
      await page.keyboard.type('27');
      check(`${P} finishing it by hand makes a real date again (30/12/2027)`, (await val(S)) === '30/12/2027', await val(S));
      await calBtn.click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} the calendar then shows December 2027 with the 30th selected`, (await byId(page, 'date-picker-month').innerText()) === 'December 2027' && (await day('2027-12-30').getAttribute('aria-pressed')) === 'true');
      await byId(page, 'date-picker-close').click();
      await closed();

      // the End date calendar: opens on the start date's month, and will not offer earlier days
      await typeKeys(S, '27122026');
      await typeKeys(E, '');
      await byId(page, `${E}-calendar`).click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} the End calendar opens on the Start date's month`, (await byId(page, 'date-picker-month').innerText()) === 'December 2026' && (await byId(page, 'date-picker-title').innerText()) === 'End date');
      check(`${P} days before the start date cannot be chosen`, (await day('2026-12-26').getAttribute('aria-disabled')) === 'true' && (await day('2026-12-27').getAttribute('aria-disabled')) !== 'true');
      await day('2026-12-26').click({ force: true }).catch(() => {});
      check(`${P} clicking a blocked day does nothing`, (await pickerOpen()) && (await val(E)) === '');
      await day('2026-12-31').click();
      check(`${P} choosing the end date fills it (31/12/2026)`, (await closed()) && (await val(E)) === '31/12/2026', await val(E));
      await typeKeys(S, '27122040'); // a start date far in the future makes "Today" unavailable for the End calendar
      await typeKeys(E, '');
      await byId(page, `${E}-calendar`).click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${P} the End calendar's "Today" is unavailable when today is before the start date`, (await byId(page, 'date-picker-today').getAttribute('aria-disabled')) === 'true');
      await byId(page, 'date-picker-close').click();
      await closed();

      // ---------- a real, valid, leap-day trip goes all the way through ----------
      if (form === 'Create') {
        await byId(page, 'trip-name').fill('Leap Trip');
        await byId(page, 'trip-destination').fill('Leap Place');
      } else {
        await byId(page, 'trip-name').fill('Leap Trip');
      }
      await typeKeys(S, '29022028');
      await typeKeys(E, '01032028');
      await byId(page, submit).click();
      await waitFor(() => rpcCalls().length > before);
      const sent = rpcCalls().at(-1);
      check(`${P} 29 February 2028 (a leap day) is accepted and sent as 2028-02-29 to 2028-03-01`, sent?.body.p_start_date === '2028-02-29' && sent?.body.p_end_date === '2028-03-01', JSON.stringify(sent?.body));
    }

    // ---------- Create form ----------
    {
      const { ctx, b, page } = await newContext();
      await page.goto(`${BASE}/trips/new`);
      await byId(page, 'trip-start').waitFor({ timeout: 20000 });
      await battery(page, b, 'Create');
      check('Create: no unexpected network calls', b.unexpected.length === 0, b.unexpected.join(', '));
      await ctx.close();
    }

    // ---------- Edit form ----------
    {
      const { ctx, b, page } = await newContext();
      await page.goto(`${BASE}/trips/${TRIP}/edit`);
      await byId(page, 'trip-start').waitFor({ timeout: 20000 });
      check('Edit: the saved dates appear unchanged in the new field', (await byId(page, 'trip-start').inputValue()) === '27/12/2026' && (await byId(page, 'trip-end').inputValue()) === '30/12/2026');
      await byId(page, 'trip-start').click();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await byId(page, 'trip-end').click();
      check('Edit: merely focusing and moving around the date fields does not make the form "changed"', (await byId(page, 'edit-save').getAttribute('aria-disabled')) === 'true');
      await byId(page, 'trip-start-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check('Edit: the calendar opens on the saved start date', (await byId(page, 'date-picker-month').innerText()) === 'December 2026' && (await byId(page, 'date-picker-day-2026-12-27').getAttribute('aria-pressed')) === 'true');
      await byId(page, 'date-picker-close').click();
      await waitFor(async () => (await page.locator('[data-testid="date-picker"]:visible').count()) === 0);
      check('Edit: opening and closing the calendar without choosing leaves the form unchanged', (await byId(page, 'edit-save').getAttribute('aria-disabled')) === 'true');
      await byId(page, 'trip-end-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await byId(page, 'date-picker-day-2026-12-31').click();
      await waitFor(async () => (await page.locator('[data-testid="date-picker"]:visible').count()) === 0);
      check('Edit: choosing a date in the calendar makes the form "changed" (Save enabled)', (await byId(page, 'edit-save').getAttribute('aria-disabled')) !== 'true' && (await byId(page, 'trip-end').inputValue()) === '31/12/2026');
      await byId(page, 'edit-save').click();
      await byId(page, 'trip-title').waitFor({ timeout: 10000 });
      const saved = b.requests.filter((r) => r.path.startsWith('/rest/v1/rpc/update_trip')).at(-1);
      check('Edit: the date chosen in the calendar is saved as an ISO date, nothing else changed', saved?.body.p_end_date === '2026-12-31' && saved?.body.p_start_date === '2026-12-27' && saved?.body.p_name === 'Date Trip', JSON.stringify(saved?.body));
      await page.goto(`${BASE}/trips/${TRIP}/edit`);
      await byId(page, 'trip-start').waitFor({ timeout: 20000 });
      await battery(page, b, 'Edit');
      check('Edit: no unexpected network calls', b.unexpected.length === 0, b.unexpected.join(', '));
      await ctx.close();
    }

    // ---------- Light and Dark ----------
    for (const theme of ['light', 'dark'] as const) {
      const { ctx, page } = await newContext(theme === 'dark' ? {} : {}, (b) => {
        b.profile = { ...b.profile, theme_preference: theme };
      });
      if (theme === 'dark') await ctx.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      await page.goto(`${BASE}/trips/new`);
      await byId(page, 'trip-start').waitFor({ timeout: 20000 });
      await byId(page, 'trip-start').fill('27122026');
      await byId(page, 'trip-start-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await page.waitForTimeout(800); // let the fade-in finish
      const bg = (id: string) => byId(page, id).evaluate((e) => getComputedStyle(e).backgroundColor);
      const wantSelected = theme === 'dark' ? 'rgb(127, 176, 143)' : 'rgb(31, 77, 58)';
      const wantSurface = theme === 'dark' ? 'rgb(27, 37, 32)' : 'rgb(252, 250, 245)';
      check(`${theme} theme: the calendar uses the theme's surface and its selected-day colour`, (await bg('date-picker')) === wantSurface && (await bg('date-picker-day-2026-12-27')) === wantSelected, `${await bg('date-picker')} / ${await bg('date-picker-day-2026-12-27')}`);
      await shot(page, `calendar-${theme}`);
      await ctx.close();
    }

    // ---------- phone-sized touch screen ----------
    {
      const { ctx, page } = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.goto(`${BASE}/trips/new`);
      await byId(page, 'trip-start').waitFor({ timeout: 20000 });
      check('Phone: no sideways scrolling on the form', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await byId(page, 'trip-start').tap();
      await byId(page, 'trip-start').pressSequentially('27122026');
      check('Phone: typing digits builds the date (27/12/2026)', (await byId(page, 'trip-start').inputValue()) === '27/12/2026');
      check('Phone: the date boxes ask for the number keypad', (await byId(page, 'trip-start').getAttribute('inputmode')) === 'numeric' && (await byId(page, 'trip-end').getAttribute('inputmode')) === 'numeric');
      const calBox = await byId(page, 'trip-start-calendar').boundingBox();
      check('Phone: the calendar button is a comfortable touch target (at least 44 px)', !!calBox && calBox.width >= 44 && calBox.height >= 44, JSON.stringify(calBox));
      await byId(page, 'trip-start-calendar').tap();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await page.waitForTimeout(800);
      const box = await byId(page, 'date-picker').boundingBox();
      check('Phone: the calendar fits inside the screen', !!box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box));
      const cell = await byId(page, 'date-picker-day-2026-12-15').boundingBox();
      check('Phone: day buttons are at least 44 px tall', !!cell && cell.height >= 44, JSON.stringify(cell));
      await shot(page, 'calendar-phone');
      await byId(page, 'date-picker-day-2026-12-15').tap();
      await waitFor(async () => (await page.locator('[data-testid="date-picker"]:visible').count()) === 0);
      check('Phone: tapping a day fills the box', (await byId(page, 'trip-start').inputValue()) === '15/12/2026', await byId(page, 'trip-start').inputValue());
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function memberFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nK. People: add a friend, rename, roles, remove, leave');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9001), ravi: uuid(9002), priya: uuid(9003), gita: uuid(9004), boss: uuid(9005), dev: uuid(9006), gopal: uuid(9007), longg: uuid(9008), ila: uuid(9009) } as const;
    const T = {
      A: uuid(501), MEM: uuid(502), ARCH: uuid(503), FULL: uuid(504), LEAVE: uuid(505), LEAVEARCH: uuid(506),
      FAIL: uuid(507), STALE: uuid(508), DOUBLE: uuid(509), PHONE: uuid(510), DARK: uuid(511),
    };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const BOSS = '88888888-8888-4888-8888-888888888888';
    const DEV = '55555555-5555-4555-8555-555555555555';
    const mine = (id: string, role = 'admin') => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role, joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = (id: string = ID.ravi) => memberRow({ id, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = (id: string = ID.priya) => memberRow({ id, user_id: PRIYA, display_name: 'Priya Shah', role: 'admin', joined_at: '2026-11-18T10:30:00+00:00' });
    const gita = (id: string = ID.gita) => memberRow({ id, user_id: null, display_name: 'Gita', joined_at: '2026-11-18T11:00:00+00:00' });
    const boss = (id: string = ID.boss) => memberRow({ id, user_id: BOSS, display_name: 'Boss Bhavna', role: 'admin', joined_at: '2026-11-18T08:00:00+00:00' });
    const dev = () => memberRow({ id: ID.dev, user_id: DEV, display_name: 'Departed Dev', role: 'admin', status: 'left', left_at: '2026-11-15T10:00:00+00:00' });
    const start = dayFromToday(20);
    const end = dayFromToday(23);
    const trip = (id: string, name: string, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Place', start_date: start, end_date: end, members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });

    const seed = () => [
      trip(T.A, 'People Trip', [mine(ID.me), ravi(), priya(), gita(), dev()]),
      trip(T.MEM, 'Member View Trip', [mine(ID.me, 'member'), boss(), memberRow({ id: ID.gopal, user_id: null, display_name: 'Gopal' })]),
      trip(T.ARCH, 'Archived People', [mine(ID.me), ravi(), priya()], { status: 'archived' }),
      trip(T.FULL, 'Full Trip', [mine(ID.me), ...Array.from({ length: 49 }, (_, i) => memberRow({ id: uuid(9100 + i), user_id: null, display_name: `Guest ${i + 2}` }))]),
      trip(T.LEAVE, 'Leave Trip', [mine(ID.me, 'member'), boss(), ravi()]),
      trip(T.LEAVEARCH, 'Leave Archived', [mine(ID.me, 'member'), boss()], { status: 'archived' }),
      trip(T.FAIL, 'Failure Trip', [mine(ID.me), ravi(), priya(), gita()]),
      trip(T.STALE, 'Stale Trip', [mine(ID.me), priya()]),
      trip(T.DOUBLE, 'Double Tap Trip', [mine(ID.me), ravi(), gita()]),
      trip(T.PHONE, 'Phone Trip', [mine(ID.me), ravi(), memberRow({ id: ID.longg, user_id: null, display_name: 'A Friend With An Extremely Long Name That Must Wrap Neatly On A Phone Screen' })]),
      trip(T.DARK, 'Dark Trip', [mine(ID.me), ravi(), priya(), dev()]),
    ];

    const context = await browser.newContext();
    const backend = newBackend();
    backend.trips = seed();
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();
    let lastList = null as any[] | null;
    page.on('response', async (r) => {
      if (r.url().includes('/rpc/list_trip_members')) lastList = await r.json().catch(() => null);
    });

    const row = (trip: string) => backend.trips.find((t) => t.id === trip)!;
    const people = (trip: string) => row(trip)._members as Record<string, any>[];
    const calls = (fn: string) => backend.requests.filter((r) => r.method === 'POST' && r.path === `/rest/v1/rpc/${fn}`);
    const allMemberCalls = () => ['add_guest_member', 'rename_guest_member', 'set_member_role', 'remove_member', 'leave_trip'].flatMap(calls);
    const text = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const exists = async (id: string) => (await byId(page, id).count()) > 0;
    const go = async (id: string, wait = 'trip-people') => {
      await page.goto(`${BASE}/trips/${id}`);
      return byId(page, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
    const dialogGone = () => waitFor(async () => !(await exists('confirm-dialog')));
    const isoToday = dayFromToday(0);
    const todayNote = formatDateRange(isoToday, isoToday);
    /** Opens a person's actions (and closes anyone else's); leaves them open if they already are. */
    const manage = async (id: string) => {
      if (!(await exists(`member-actions-${id}`))) await byId(page, `member-manage-${id}`).click();
      await byId(page, `member-actions-${id}`).waitFor({ timeout: 5000 });
    };
    const confirmDialog = () => byId(page, 'confirm-dialog').waitFor({ timeout: 5000 });

    // =============== an administrator's view ===============
    check('opens a trip as an administrator', await go(T.A));
    check('the heading counts only current people (4)', await vis(page, 'People (4)').isVisible());
    check('says you are an admin', (await text('trip-my-role')) === 'You are an admin of this trip.');
    for (const name of ['ravi', 'priya', 'gita', 'me'] as const) check(`a Manage button is offered for ${name}`, await exists(`member-manage-${ID[name]}`));
    check('accessibility: Manage buttons name the person and report expanded/collapsed', (await byId(page, `member-manage-${ID.ravi}`).getAttribute('aria-label')) === 'Manage Ravi Kumar' && (await byId(page, `member-manage-${ID.ravi}`).getAttribute('aria-expanded')) === 'false');
    await manage(ID.ravi);
    check('for an ordinary member: Make admin and Remove only (no rename, no admin rights)', (await exists(`member-make-admin-${ID.ravi}`)) && (await exists(`member-remove-${ID.ravi}`)) && !(await exists(`member-rename-${ID.ravi}`)) && !(await exists(`member-remove-admin-${ID.ravi}`)));
    check('...and Manage reports expanded', (await byId(page, `member-manage-${ID.ravi}`).getAttribute('aria-expanded')) === 'true');
    await manage(ID.priya);
    check('for another admin: Remove admin rights and Remove (no Make admin)', (await exists(`member-remove-admin-${ID.priya}`)) && (await exists(`member-remove-${ID.priya}`)) && !(await exists(`member-make-admin-${ID.priya}`)));
    await manage(ID.gita);
    check('for a guest: Rename and Remove, never Make admin', (await exists(`member-rename-${ID.gita}`)) && (await exists(`member-remove-${ID.gita}`)) && !(await exists(`member-make-admin-${ID.gita}`)));
    await manage(ID.me);
    check('for yourself: only Remove admin rights (another admin exists); you cannot remove yourself', (await exists(`member-remove-admin-${ID.me}`)) && !(await exists(`member-remove-${ID.me}`)) && !(await exists(`member-make-admin-${ID.me}`)));
    await byId(page, `member-manage-${ID.me}`).click();
    check('the add-a-friend box and an enabled Leave trip are offered', (await exists('add-guest-name')) && (await byId(page, 'leave-trip').getAttribute('aria-disabled')) !== 'true');
    await shot(page, 'people-admin-light');

    // =============== add a friend ===============
    const sentBefore = calls('add_guest_member').length;
    await byId(page, 'add-guest-submit').click();
    check('an empty name is refused on the spot, with no request', (await vis(page, 'Enter a name').isVisible()) && calls('add_guest_member').length === sentBefore);
    await byId(page, 'add-guest-name').fill('RAVI KUMAR');
    await byId(page, 'add-guest-submit').click();
    check('a name someone already has (any case) is refused on the spot, with no request', (await vis(page, 'Someone on this trip already has that name. Use a different name.').isVisible()) && calls('add_guest_member').length === sentBefore);
    await byId(page, 'add-guest-name').fill('  Hari  ');
    await byId(page, 'add-guest-submit').click();
    check('adding a friend sends exactly the trip and the trimmed name (no user id)', await settle(() => calls('add_guest_member').length === sentBefore + 1) && JSON.stringify(calls('add_guest_member').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_display_name: 'Hari' }), JSON.stringify(calls('add_guest_member').at(-1)?.body));
    check('the friend appears (tagged Guest), the count goes up and the box is cleared', (await vis(page, 'People (5)').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await text('trip-people')).includes('Hari') && (await text(`member-${uuid(9501)}`)).includes('Guest') && (await byId(page, 'add-guest-name').inputValue()) === '');
    check('a confirmation is shown', (await text('people-notice')) === 'Added to the trip.');

    // someone else added "Ila" meanwhile: this screen does not know yet, the database refuses, and the list refreshes
    people(T.A).push(memberRow({ id: ID.ila, user_id: null, display_name: 'Ila' }));
    await byId(page, 'add-guest-name').fill('ila');
    await byId(page, 'add-guest-submit').click();
    check('if the database refuses a duplicate the screen did not know about, the message sits by the box', await byId(page, 'add-guest-name').waitFor().then(async () => (await vis(page, 'Someone on this trip already has that name. Use a different name.').waitFor({ timeout: 8000 }).then(() => true, () => false))));
    check('...and the list refreshes to show the newcomer', (await vis(page, 'People (6)').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await text('trip-people')).includes('Ila'));
    await byId(page, 'add-guest-name').fill('');

    // =============== rename a friend ===============
    await manage(ID.gita);
    await byId(page, `member-rename-${ID.gita}`).click();
    check('Rename opens a box with the current name', (await byId(page, `rename-input-${ID.gita}`).inputValue()) === 'Gita');
    const renamesBefore = calls('rename_guest_member').length;
    await byId(page, `rename-cancel-${ID.gita}`).click();
    check('Cancel changes nothing and sends nothing', !(await exists(`rename-input-${ID.gita}`)) && calls('rename_guest_member').length === renamesBefore && (await text(`member-${ID.gita}`)).includes('Gita'));
    await manage(ID.gita);
    await byId(page, `member-rename-${ID.gita}`).click();
    await byId(page, `rename-input-${ID.gita}`).fill('ravi kumar');
    await byId(page, `rename-save-${ID.gita}`).click();
    check('a name someone else has is refused on the spot, with no request', (await vis(page, 'Someone on this trip already has that name. Use a different name.').isVisible()) && calls('rename_guest_member').length === renamesBefore);
    await byId(page, `rename-input-${ID.gita}`).fill('Geeta');
    await byId(page, `rename-save-${ID.gita}`).click();
    check('renaming sends exactly the trip, the person and the new name', await settle(() => calls('rename_guest_member').length === renamesBefore + 1) && JSON.stringify(calls('rename_guest_member').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_member_id: ID.gita, p_display_name: 'Geeta' }), JSON.stringify(calls('rename_guest_member').at(-1)?.body));
    check('the new name shows and a confirmation appears', (await settle(async () => (await text(`member-${ID.gita}`)).includes('Geeta'))) && (await text('people-notice')) === 'Name changed.');
    check('signed-up people cannot be renamed: no Rename button for them', await (async () => { await manage(ID.ravi); return !(await exists(`member-rename-${ID.ravi}`)); })());
    await byId(page, `member-manage-${ID.ravi}`).click();

    // =============== make admin / remove admin rights ===============
    await manage(ID.ravi);
    await byId(page, `member-make-admin-${ID.ravi}`).click();
    await confirmDialog();
    check('Make admin asks first, in plain words', (await text('confirm-title')) === 'Make Ravi Kumar an admin?' && /edit and archive this trip, add and remove people/.test(await text('confirm-message')));
    const rolesBefore = calls('set_member_role').length;
    await byId(page, 'confirm-cancel').click();
    check('Cancel makes no change and sends nothing', (await dialogGone()) && calls('set_member_role').length === rolesBefore && !(await text(`member-${ID.ravi}`)).includes('Admin'));
    await manage(ID.ravi);
    await byId(page, `member-make-admin-${ID.ravi}`).click();
    await byId(page, 'confirm-confirm').click();
    check('confirming sends the role asked for AND the role the person was seen in', await settle(() => calls('set_member_role').length === rolesBefore + 1) && JSON.stringify(calls('set_member_role').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_member_id: ID.ravi, p_role: 'admin', p_expected_role: 'member' }), JSON.stringify(calls('set_member_role').at(-1)?.body));
    check('the Admin tag appears, the dialog closes and a confirmation shows', (await settle(async () => (await text(`member-${ID.ravi}`)).includes('Admin'))) && (await dialogGone()) && (await text('people-notice')) === 'Ravi Kumar is now an admin.');

    await manage(ID.priya);
    await byId(page, `member-remove-admin-${ID.priya}`).click();
    check('Remove admin rights asks first', (await text('confirm-title')) === 'Remove Priya Shah as admin?');
    await byId(page, 'confirm-confirm').click();
    check('...and sends the member role, having seen an admin', await settle(() => calls('set_member_role').length === rolesBefore + 2) && JSON.stringify(calls('set_member_role').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_member_id: ID.priya, p_role: 'member', p_expected_role: 'admin' }));
    check('the Admin tag goes away', await settle(async () => !(await text(`member-${ID.priya}`)).includes('Admin')));

    // =============== remove someone ===============
    await manage(ID.ravi);
    await byId(page, `member-remove-${ID.ravi}`).click();
    check('Remove explains that history is kept and that they will be listed as a former member', (await text('confirm-title')) === 'Remove Ravi Kumar from this trip?' && /Former members/.test(await text('confirm-message')) && /stays in the trip's history/.test(await text('confirm-message')));
    const removesBefore = calls('remove_member').length;
    await byId(page, 'confirm-confirm').click();
    check('confirming sends exactly the trip and the person', await settle(() => calls('remove_member').length === removesBefore + 1) && JSON.stringify(calls('remove_member').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_member_id: ID.ravi }));
    check('they leave the people list and the count drops', (await vis(page, 'People (5)').waitFor({ timeout: 8000 }).then(() => true, () => false)) && !(await text('trip-people')).includes('Ravi Kumar'));
    check('they appear under Former members (now 2) as "Removed" today', (await text('former-toggle')).includes('Former members (2)'));
    await byId(page, 'former-toggle').click();
    check('...with the removal day', (await text(`former-note-${ID.ravi}`)) === `Removed ${todayNote}`, await text(`former-note-${ID.ravi}`));
    await page.waitForTimeout(300);
    check('privacy: the list the server sent has no user id or role for any former member', Array.isArray(lastList) && lastList!.filter((r: any) => r.status !== 'active').length === 2 && lastList!.filter((r: any) => r.status !== 'active').every((r: any) => r.user_id === null && r.role === null), JSON.stringify(lastList?.filter((r: any) => r.status !== 'active')));
    check('privacy: no user id of a former member is anywhere on the page', !(await page.locator('body').innerHTML()).includes(RAVI) && !(await page.locator('body').innerHTML()).includes(DEV));
    await byId(page, 'former-toggle').click();

    // =============== the only admin ===============
    // Active now: me (admin), priya (member), gita, hari, ila.  Only I am an admin.
    check('as the only admin, nothing at all is offered on me (no Manage button: I cannot step down, remove or promote myself)', !(await exists(`member-manage-${ID.me}`)));
    check('Leave trip is disabled, with the reason', ((await byId(page, 'leave-trip').getAttribute('aria-disabled')) === 'true') && (await text('leave-blocked')) === 'You are the only admin, so you cannot leave yet. Make someone else an admin first.');
    const leavesBefore = calls('leave_trip').length;
    await byId(page, 'leave-trip').click({ force: true, timeout: 1500 }).catch(() => {});
    check('pressing the disabled button sends nothing and opens nothing', calls('leave_trip').length === leavesBefore && !(await exists('confirm-dialog')));
    await manage(ID.priya);
    await byId(page, `member-make-admin-${ID.priya}`).click();
    await byId(page, 'confirm-confirm').click();
    check('after naming a second admin, the first may step down', await settle(async () => (await text(`member-${ID.priya}`)).includes('Admin')) && (await exists(`member-manage-${ID.me}`)));
    await manage(ID.me);
    await byId(page, `member-remove-admin-${ID.me}`).click();
    check('stepping down is explained (you lose the ability to manage)', (await text('confirm-title')) === 'Step down as admin?' && /no longer be able to manage/.test(await text('confirm-message')));
    await byId(page, 'confirm-confirm').click();
    check('afterwards you are an ordinary member: role line changes and all admin controls disappear', (await settle(async () => (await text('trip-my-role')) === 'You are a member of this trip.')) && !(await exists('add-guest-name')) && !(await exists(`member-manage-${ID.priya}`)) && !(await exists(`member-manage-${ID.me}`)));
    await shot(page, 'people-member-light');

    // =============== leaving (an administrator who is no longer needed, now an ordinary member) ===============
    await byId(page, 'leave-trip').click();
    check('Leave asks first and says what is kept', (await text('confirm-title')) === 'Leave this trip?' && /stays in the trip's history/.test(await text('confirm-message')));
    await byId(page, 'confirm-cancel').click();
    check('Cancel keeps you on the trip and sends nothing', (await dialogGone()) && calls('leave_trip').length === leavesBefore && pathOf(page) === `/trips/${T.A}`);
    await byId(page, 'leave-trip').click();
    await byId(page, 'confirm-confirm').click();
    check('confirming sends only the trip', await settle(() => calls('leave_trip').length === leavesBefore + 1) && JSON.stringify(calls('leave_trip').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A }));
    check('you land on Home, and the trip is no longer in your list', (await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false)) && pathOf(page) === '/' && !(await exists(`trip-card-${T.A}`)));
    check('opening that trip again gives the single "not available" message', await go(T.A, 'trip-unavailable'));

    // =============== an ordinary member ===============
    check('opens a trip as an ordinary member', await go(T.MEM));
    check('a member sees their role and no management controls at all', (await text('trip-my-role')) === 'You are a member of this trip.' && !(await exists('add-guest-name')) && !(await page.locator('[data-testid^="member-manage-"]').count()));
    check('...but can leave', (await byId(page, 'leave-trip').getAttribute('aria-disabled')) !== 'true');
    await go(T.LEAVE);
    await byId(page, 'leave-trip').click();
    await byId(page, 'confirm-confirm').click();
    check('an ordinary member can leave, and goes Home', (await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false)) && people(T.LEAVE).find((m) => m.id === ID.me)!.status === 'left');

    // =============== archived trips ===============
    await go(T.ARCH);
    check('on an archived trip an admin sees no management controls, only the reason', !(await exists('add-guest-name')) && !(await page.locator('[data-testid^="member-manage-"]').count()) && /archived, so people can't be changed/.test(await text('people-archived-note')));
    check('...and can still leave (the one exception to read-only)', (await byId(page, 'leave-trip').getAttribute('aria-disabled')) !== 'true');
    await go(T.LEAVEARCH);
    await byId(page, 'leave-trip').click();
    await byId(page, 'confirm-confirm').click();
    check('a member can leave an archived trip', (await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false)) && people(T.LEAVEARCH).find((m) => m.id === ID.me)!.status === 'left');

    // =============== the 50-person limit ===============
    await go(T.FULL);
    check('at 50 people the add box is replaced by a note', !(await exists('add-guest-name')) && (await text('add-guest-full')).includes('50 people'));

    // =============== failures are explained, and recoverable ===============
    await go(T.FAIL);
    backend.memberFail = 'network';
    await manage(ID.ravi);
    await byId(page, `member-make-admin-${ID.ravi}`).click();
    await byId(page, 'confirm-confirm').click();
    check('a connection failure keeps the dialog open with a message, so it can simply be retried', (await byId(page, 'confirm-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Can't reach the server/.test(await text('confirm-error')) && (await exists('confirm-dialog')));
    backend.memberFail = null;
    await byId(page, 'confirm-confirm').click();
    check('retrying from the same dialog works', await settle(async () => (await text(`member-${ID.ravi}`)).includes('Admin')) && (await dialogGone()));

    backend.memberFail = 'not_admin';
    await manage(ID.gita);
    await byId(page, `member-remove-${ID.gita}`).click();
    await byId(page, 'confirm-confirm').click();
    check('if your admin rights were removed meanwhile: the dialog closes and the card explains', (await byId(page, 'people-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await text('people-error')) === 'Only trip admins can do that.' && (await dialogGone()));
    backend.memberFail = null;
    await byId(page, 'people-reload').click();
    check('"Reload latest" clears the message and re-reads the trip', await settle(async () => !(await exists('people-error'))));

    const failures = [
      ['trip_archived', /archived, so people can't be changed/],
      ['member_not_found', /no longer on this trip/],
      ['member_changed', /Someone else changed this person first/],
      ['guest_cannot_be_admin', /without an account can't be an admin/],
      ['trip_not_found', /couldn't open this trip/],
    ] as const;
    for (const [token, pattern] of failures) {
      backend.memberFail = token;
      await go(T.FAIL);
      await manage(ID.gita);
      await byId(page, `member-remove-${ID.gita}`).click();
      await byId(page, 'confirm-confirm').click();
      check(`the database answer "${token}" is explained in plain words`, (await byId(page, 'people-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && pattern.test(await text('people-error')), await text('people-error'));
      check(`...and offers Reload latest (${token})`, await exists('people-reload'));
      backend.memberFail = null;
    }
    backend.memberFail = 'last_admin';
    await go(T.FAIL);
    await byId(page, 'leave-trip').click();
    await byId(page, 'confirm-confirm').click();
    check('"last_admin" when leaving says you are the only admin', (await byId(page, 'people-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /only admin, so you cannot leave/.test(await text('people-error')));
    backend.memberFail = null;
    backend.memberFail = 'network';
    await go(T.FAIL);
    await manage(ID.gita);
    await byId(page, `member-rename-${ID.gita}`).click();
    await byId(page, `rename-input-${ID.gita}`).fill('Geeta');
    await byId(page, `rename-save-${ID.gita}`).click();
    check('a connection failure while renaming keeps the box and message, so it can be retried', (await vis(page, "Can't reach the server. Check your internet connection and try again.").waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await byId(page, `rename-input-${ID.gita}`).inputValue()) === 'Geeta');
    backend.memberFail = null;
    await byId(page, `rename-save-${ID.gita}`).click();
    check('retrying works', await settle(async () => (await text(`member-${ID.gita}`)).includes('Geeta')));

    // stale screen: two admins on screen, but the other was demoted meanwhile, so stepping down would leave none
    await go(T.STALE);
    people(T.STALE).find((m) => m.id === ID.priya)!.role = 'member';
    await manage(ID.me);
    await byId(page, `member-remove-admin-${ID.me}`).click();
    await byId(page, 'confirm-confirm').click();
    check('stepping down as the last admin is refused by the database even though the screen offered it', (await byId(page, 'people-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /at least one admin/.test(await text('people-error')) && people(T.STALE).find((m) => m.id === ID.me)!.role === 'admin');
    await byId(page, 'people-reload').click();
    check('after reloading, the screen shows you as the only admin (no step-down, Leave disabled)', (await settle(async () => (await exists('leave-blocked')))) && !(await exists(`member-remove-admin-${ID.me}`)));

    // =============== double taps ===============
    await go(T.DOUBLE);
    backend.slowMemberMs = 1200;
    await byId(page, 'add-guest-name').fill('Quick');
    const addsBefore = calls('add_guest_member').length;
    await byId(page, 'add-guest-submit').click();
    await byId(page, 'add-guest-submit').click({ timeout: 800, force: true }).catch(() => {});
    await settle(() => calls('add_guest_member').length >= addsBefore + 1);
    await page.waitForTimeout(1500);
    check('tapping Add twice sends only one request', calls('add_guest_member').length === addsBefore + 1, String(calls('add_guest_member').length - addsBefore));
    await manage(ID.ravi);
    await byId(page, `member-remove-${ID.ravi}`).click();
    const rmBefore = calls('remove_member').length;
    await byId(page, 'confirm-confirm').click();
    await byId(page, 'confirm-confirm').click({ timeout: 800, force: true }).catch(() => {});
    await page.waitForTimeout(1800);
    check('tapping Remove twice sends only one request', calls('remove_member').length === rmBefore + 1, String(calls('remove_member').length - rmBefore));
    backend.slowMemberMs = 0;

    // =============== what is (never) sent ===============
    const ids = [USER.id, RAVI, PRIYA, BOSS, DEV];
    check('no request to a member function ever carries a user id', allMemberCalls().every((r) => !ids.some((id) => JSON.stringify(r.body).includes(id))));
    check('every member request carries the login, not a secret key', allMemberCalls().every((r) => !!r.auth?.startsWith('Bearer ') && !r.auth.includes('sb_secret')));
    check('the people are read through list_trip_members (never the members table directly)', backend.requests.some((r) => r.path === '/rest/v1/rpc/list_trip_members') && !backend.requests.some((r) => r.path.startsWith('/rest/v1/trip_members')));
    check('no unexpected network calls', backend.unexpected.length === 0, backend.unexpected.join(', '));
    await context.close();

    // =============== phone-sized touch screen ===============
    {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      b.trips = seed();
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.PHONE}`);
      await byId(p, 'trip-people').waitFor({ timeout: 20000 });
      check('Phone: no sideways scrolling with a very long name on the trip', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      const manageBox = await byId(p, `member-manage-${ID.ravi}`).boundingBox();
      check('Phone: Manage is a comfortable touch target (44 px)', !!manageBox && manageBox.height >= 44 && manageBox.width >= 44, JSON.stringify(manageBox));
      await byId(p, `member-manage-${ID.ravi}`).tap();
      await byId(p, `member-remove-${ID.ravi}`).tap();
      await byId(p, 'confirm-dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(800);
      const box = await byId(p, 'confirm-dialog').boundingBox();
      check('Phone: the confirmation fits inside the screen', !!box && box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 780, JSON.stringify(box));
      await shot(p, 'people-confirm-phone');
      await byId(p, 'confirm-cancel').tap();
      await ctx.close();
    }

    // =============== Dark theme ===============
    {
      const dark = await browser.newContext();
      const b = newBackend();
      b.trips = seed();
      b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(dark, b);
      await sessionInStorage(dark);
      await dark.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      const p = await dark.newPage();
      await p.goto(`${BASE}/trips/${T.DARK}`);
      await byId(p, 'trip-people').waitFor({ timeout: 20000 });
      await byId(p, `member-manage-${ID.ravi}`).click();
      await byId(p, `member-remove-${ID.ravi}`).click();
      await byId(p, 'confirm-dialog').waitFor({ timeout: 5000 });
      await p.waitForTimeout(800);
      const surface = await byId(p, 'confirm-dialog').evaluate((e) => getComputedStyle(e).backgroundColor);
      check('Dark theme: the confirmation uses the dark surface', surface === 'rgb(27, 37, 32)', surface);
      await shot(p, 'people-confirm-dark');
      await dark.close();
    }
  } finally {
    site.stop();
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    if (process.env.UI_ONLY === 'K') {
      await memberFlows(browser); // quick re-run of the people scenario alone while developing
    } else {
      await setupScreens(browser);
      await accountFlows(browser);
      await signedInFlows(browser);
      await tripFlows(browser);
      await detailFlows(browser);
      await editFlows(browser);
      await dateFlows(browser);
      await memberFlows(browser);
    }
  } finally {
    await browser.close();
  }
  console.log(`\nResult: ${failures.length === 0 ? 'PASSED' : 'FAILED'}  (${passed} passed, ${failures.length} failed)`);
  if (failures.length) console.log('Failed checks:\n - ' + failures.join('\n - '));
  console.log(`Screenshots: ${SHOTS}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ui-check crashed:', e instanceof Error ? e.message : e);
  process.exit(2);
});
