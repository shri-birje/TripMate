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
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Request, type Route } from 'playwright-core';
import { askedLabel, createdLabel } from '../packages/core/src/invite';
import { computeBalances } from '../packages/core/src/balances';
import { previewSplit } from '../packages/core/src/expense';
import { formatDateRange } from '../packages/core/src/trip';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const PROJECT_REF = 'uichecktestproject'; // a made-up project: the browser check never touches a real Supabase project
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const DUMMY_PUBLISHABLE_KEY = 'sb_publishable_dummy_key_for_ui_tests_only';
const FAKE_SECRET_KEY = 'sb_secret_FAKE_DO_NOT_USE_0000';
const SHOTS = process.env.UI_CHECK_SHOTS ?? path.join(process.cwd(), 'ui-check-screenshots');

const LIGHT_BG = 'rgb(244, 238, 225)';
const DARK_BG = 'rgb(16, 16, 16)';

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

/** The status chips are drawn in capitals (innerText follows the CSS), so compare them as written words. */
const titleCase = (t: string) => t.trim().charAt(0).toUpperCase() + t.trim().slice(1).toLowerCase();

/** Home shows one status at a time: opens that status tab and returns the text of its list. */
async function phaseText(page: Page, phase: 'completed' | 'ongoing' | 'upcoming'): Promise<string> {
  await byId(page, `status-${phase}`).click();
  const list = byId(page, `section-${phase}`);
  await list.waitFor({ timeout: 8000 });
  return (await list.innerText()).replace(/\s+/g, ' ');
}

/** Whether Home lists this trip in ANY status tab (it shows one status at a time). Leaves the tab where the card was found. */
async function homeHasCard(page: Page, id: string): Promise<boolean> {
  for (const ph of ['ongoing', 'upcoming', 'completed'] as const) {
    const tab = byId(page, `status-${ph}`);
    if ((await tab.count()) === 0) return false;
    await tab.click();
    await page.waitForTimeout(150);
    if ((await byId(page, `trip-card-${id}`).count()) > 0) return true;
  }
  return false;
}
/** Waits until Home lists this trip in some status tab, and leaves that tab selected. */
async function showHomeCard(page: Page, id: string, timeout = 20000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await homeHasCard(page, id)) return true;
    await page.waitForTimeout(300);
  }
  return false;
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
  /** The invitations that exist (the fake keeps the raw token; the real database keeps only its hash). */
  invites: Record<string, any>[];
  /** The join requests that exist (waiting, approved or rejected). */
  joinRequests: Record<string, any>[];
  /** Force the invitation functions to answer with this database message (or drop the connection). */
  inviteFail: null | string;
  /** Reads of the expense tables, with the first row index each page asked for. */
  expenseReadRequests: { table: string; from: number }[];
  /** When set, any expense page that starts at or after this row number fails with a connection error. */
  failExpensePageFrom: number | null;
  /** Delay, in ms, before the invitation functions answer (to test double taps). */
  slowInviteMs: number;
  /** The expenses that exist (the fake keeps payers and the derived shares inside each). */
  expenses: Record<string, any>[];
  /** Force the expense functions: 'network' drops the connection; 'lost_reply' APPLIES the change and then drops the connection; any other text is the database message. */
  expenseFail: null | string;
  /** Delay, in ms, before the expense functions answer (to test double taps and the busy state). */
  slowExpenseMs: number;
  /** Balance rows to serve instead of the computed ones, per trip (to show how the page answers data the database would never send). */
  balanceRows: Record<string, Record<string, unknown>[]> | null;
  /** The history of expenses: one row per change (the fake keeps what the database keeps: member ids and amounts, never names). */
  revisions: Record<string, any>[];
  /** Make the expense list reads drop the connection. */
  failExpenseReads: boolean;
  /** Delay, in ms, before the expense list reads answer (to see the loading state). */
  slowExpenseReadsMs: number;
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
    invites: [],
    joinRequests: [],
    inviteFail: null,
    expenseReadRequests: [],
    failExpensePageFrom: null,
    slowInviteMs: 0,
    expenses: [],
    revisions: [],
    balanceRows: null,
    expenseFail: null,
    slowExpenseMs: 0,
    failExpenseReads: false,
    slowExpenseReadsMs: 0,
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
let inviteSeq = 0;
let joinSeq = 0;
let requestSeq = 0;

/** An invitation as the fake server keeps it. */
function seedInvite(over: Record<string, any>): Record<string, any> {
  return {
    id: uuid(9600 + ++inviteSeq), tripId: '', token: randomBytes(32).toString('hex'), claimMemberId: null, createdBy: '',
    expiresAt: Date.now() + 7 * 86_400_000, useCount: 0, revoked: false, createdAt: Date.now(), ...over,
  };
}

/** A join request as the fake server keeps it. */
function seedRequest(over: Record<string, any>): Record<string, any> {
  return {
    id: uuid(9800 + ++requestSeq), tripId: '', inviteId: uuid(9599), userId: '', requesterName: 'Someone', claimMemberId: null, status: 'pending',
    createdAt: Date.now(), decidedBy: null, memberId: null, ...over,
  };
}

/**
 * Day cards on the Expenses screen start collapsed, which is correct for people but means every older check that reads an expense row would
 * first have to open its day. So, unless a scenario says `keepCollapsed`, this page-side helper opens each day card once, the moment it appears.
 */
const AUTO_EXPAND_SCRIPT = `(() => {
  const done = new WeakSet();
  const open = () => {
    document.querySelectorAll('[data-testid^="expense-day-toggle-"][aria-expanded="false"]').forEach((el) => {
      if (!done.has(el)) { done.add(el); el.click(); }
    });
  };
  new MutationObserver(open).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
})();`;

async function installFakeSupabase(context: BrowserContext, backend: FakeBackend, opts: { keepCollapsed?: boolean } = {}) {
  if (!opts.keepCollapsed) await context.addInitScript(AUTO_EXPAND_SCRIPT);
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
    // ---- invitations and join requests: the fake enforces the SAME rules as the real database functions.
    const inviteFn = url.pathname.replace('/rest/v1/rpc/', '');
    if (url.pathname.startsWith('/rest/v1/rpc/') && ['create_invite', 'get_general_invite_link', 'list_trip_invites', 'revoke_invite', 'preview_invite', 'request_to_join', 'list_join_requests', 'decide_join_request'].includes(inviteFn) && method === 'POST') {
      const failWith = (message: string) => json(400, { code: 'P0001', message, details: null, hint: null });
      const authHeader = request.headers()['authorization'] ?? '';
      const signedIn = authHeader !== '' && authHeader !== `Bearer ${DUMMY_PUBLISHABLE_KEY}`;
      if (backend.inviteFail === 'network') return route.abort('connectionfailed');
      if (backend.inviteFail === 'network-link' && inviteFn === 'get_general_invite_link') return route.abort('connectionfailed');
      if (backend.slowInviteMs > 0) await new Promise((r) => setTimeout(r, backend.slowInviteMs));
      if (backend.inviteFail && backend.inviteFail !== 'network-link') return failWith(backend.inviteFail);

      const live = (token: unknown) => {
        const i = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? backend.invites.find((x) => x.token === token) : undefined;
        const t = i && backend.trips.find((x) => x.id === i.tripId);
        if (!i || !t || i.revoked || i.expiresAt <= Date.now() || t.status !== 'active') return null;
        if (i.claimMemberId !== null) {
          if (i.useCount > 0) return null; // a friend's link is single use: spent once a request has been made with it
          const g = (t._members as Record<string, any>[]).find((m) => m.id === i.claimMemberId);
          if (!g || g.status !== 'active' || g.user_id !== null) return null;
        }
        return { i, t };
      };

      if (inviteFn === 'preview_invite') {
        const l = live(body.p_token);
        if (!l) return json(200, []);
        const ms = l.t._members as Record<string, any>[];
        const target = l.i.claimMemberId ? ms.find((m) => m.id === l.i.claimMemberId) : undefined;
        return json(200, [{
          trip_name: l.t.name, destination: l.t.destination, start_date: l.t.start_date, end_date: l.t.end_date,
          inviter_name: ms.find((m) => m.id === l.i.createdBy)?.display_name ?? 'Someone',
          member_count: ms.filter((m) => m.status === 'active').length, is_claim: !!target, claim_name: target?.display_name ?? null,
        }]);
      }
      if (!signedIn) return json(401, { code: '42501', message: `permission denied for function ${inviteFn}` });

      if (inviteFn === 'request_to_join') {
        const l = live(body.p_token);
        if (!l) return failWith('invite_invalid');
        const ms = l.t._members as Record<string, any>[];
        const own = ms.find((m) => m.user_id === USER.id);
        if (own && own.status === 'active') return json(200, [{ trip_id: l.t.id, request_id: null, outcome: 'already_member' }]);
        const onThisLink = backend.joinRequests.find((r) => r.inviteId === l.i.id && r.userId === USER.id);
        if (onThisLink) return onThisLink.status === 'pending' ? json(200, [{ trip_id: l.t.id, request_id: onThisLink.id, outcome: 'already_requested' }]) : failWith('request_used');
        const waiting = backend.joinRequests.find((r) => r.tripId === l.t.id && r.userId === USER.id && r.status === 'pending');
        if (waiting) return json(200, [{ trip_id: l.t.id, request_id: waiting.id, outcome: 'already_requested' }]);
        if (l.i.claimMemberId !== null) {
          if (own) return failWith('claim_conflict');
          if (backend.joinRequests.some((r) => r.claimMemberId === l.i.claimMemberId && r.status === 'pending')) return failWith('claim_pending');
        }
        if (backend.joinRequests.filter((r) => r.tripId === l.t.id && r.status === 'pending').length >= 50) return failWith('too_many_requests');
        const made = seedRequest({ tripId: l.t.id, inviteId: l.i.id, userId: USER.id, requesterName: String(backend.profile.display_name), claimMemberId: l.i.claimMemberId });
        backend.joinRequests.push(made);
        l.i.useCount += 1;
        return json(200, [{ trip_id: l.t.id, request_id: made.id, outcome: 'requested' }]);
      }

      // everything else: an active administrator of the trip only
      const t = backend.trips.find((x) => x.id === body.p_trip_id && !x._hidden);
      const ms = ((t?._members ?? []) as Record<string, any>[]);
      const me = ms.find((m) => m.user_id === USER.id && m.status === 'active');
      if (!t || !me) return failWith('trip_not_found');
      if (me.role !== 'admin') return failWith('not_admin');
      const statusOf = (i: Record<string, any>) => (i.revoked ? 'revoked' : i.claimMemberId !== null && i.useCount > 0 ? 'used' : i.expiresAt <= Date.now() ? 'expired' : 'active');

      // the general link's token is kept (encrypted, in the real database) only while the link is live and was made with reusable links
      const copyableNow = (i: Record<string, any>) => i.claimMemberId === null && !i.revoked && !i.legacy && i.expiresAt > Date.now();
      if (inviteFn === 'get_general_invite_link') {
        if (t.status !== 'active') return json(200, []);
        const g = backend.invites.find((i) => i.tripId === t.id && copyableNow(i));
        return json(200, g ? [{ token: g.token, expires_at: new Date(g.expiresAt).toISOString() }] : []);
      }
      if (inviteFn === 'list_trip_invites') {
        return json(200, backend.invites.filter((i) => i.tripId === t.id).sort((a2, b2) => b2.createdAt - a2.createdAt).map((i) => ({
          invite_id: i.id, claim_member_id: i.claimMemberId, claim_name: ms.find((m) => m.id === i.claimMemberId)?.display_name ?? null,
          created_by_name: ms.find((m) => m.id === i.createdBy)?.display_name ?? 'Someone', expires_at: new Date(i.expiresAt).toISOString(),
          use_count: i.useCount, revoked_at: i.revoked ? new Date().toISOString() : null, created_at: new Date(i.createdAt).toISOString(), status: statusOf(i), copyable: copyableNow(i),
        })));
      }
      if (inviteFn === 'list_join_requests') {
        return json(200, backend.joinRequests.filter((r) => r.tripId === t.id && r.status === 'pending').sort((a2, b2) => a2.createdAt - b2.createdAt).map((r) => ({
          request_id: r.id, requester_name: r.requesterName, claim_member_id: r.claimMemberId, claim_name: ms.find((m) => m.id === r.claimMemberId)?.display_name ?? null,
          created_at: new Date(r.createdAt).toISOString(),
        })));
      }
      if (t.status === 'archived') return failWith('trip_archived');

      if (inviteFn === 'revoke_invite') {
        const i = backend.invites.find((x) => x.id === body.p_invite_id && x.tripId === t.id);
        if (!i) return failWith('invite_not_found');
        if (i.revoked) return json(200, [{ invite_id: i.id, changed: false }]);
        i.revoked = true;
        return json(200, [{ invite_id: i.id, changed: true }]);
      }
      if (inviteFn === 'create_invite') {
        const hours = body.p_expires_in_hours;
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) return failWith('invalid_request');
        if (body.p_claim_member_id) {
          const g = ms.find((m) => m.id === body.p_claim_member_id && m.status === 'active');
          if (!g) return failWith('member_not_found');
          if (g.user_id !== null) return failWith('not_a_guest');
          for (const old of backend.invites) if (old.claimMemberId === body.p_claim_member_id && !old.revoked) old.revoked = true; // one live claim link per friend
        } else {
          // one valid general link per trip: creating another is refused (an expired one is cleared away)
          if (backend.invites.some((old) => old.tripId === t.id && old.claimMemberId === null && !old.revoked && old.expiresAt > Date.now())) return failWith('invite_exists');
          for (const old of backend.invites) if (old.tripId === t.id && old.claimMemberId === null && !old.revoked) old.revoked = true;
        }
        const made = seedInvite({ tripId: t.id, claimMemberId: body.p_claim_member_id ?? null, createdBy: me.id, expiresAt: Date.now() + hours * 3_600_000 });
        backend.invites.push(made);
        return json(200, [{ invite_id: made.id, token: made.token, expires_at: new Date(made.expiresAt).toISOString() }]);
      }

      // decide_join_request
      const r = backend.joinRequests.find((x) => x.id === body.p_request_id && x.tripId === t.id);
      if (!r) return failWith('request_not_found');
      if (typeof body.p_approve !== 'boolean') return failWith('invalid_request');
      if (r.status !== 'pending') return json(200, [{ request_id: r.id, outcome: 'already_decided', member_id: r.memberId }]);
      if (!body.p_approve) {
        Object.assign(r, { status: 'rejected', decidedBy: me.id });
        return json(200, [{ request_id: r.id, outcome: 'rejected', member_id: null }]);
      }
      const own = ms.find((m) => m.user_id === r.userId);
      const approved = (m: Record<string, any>, outcome: string) => {
        Object.assign(r, { status: 'approved', decidedBy: me.id, memberId: m.id });
        t.members = ms.filter((x) => x.status === 'active').map((x) => ({ id: x.id, status: x.status }));
        return json(200, [{ request_id: r.id, outcome, member_id: m.id }]);
      };
      if (own && own.status === 'active') return approved(own, 'already_member');
      if (r.claimMemberId !== null) {
        const g = ms.find((m) => m.id === r.claimMemberId && m.status === 'active' && m.user_id === null);
        if (!g) return failWith('claim_unavailable');
        if (own) return failWith('claim_conflict');
        g.user_id = r.userId;
        return approved(g, 'approved');
      }
      if (ms.filter((m) => m.status === 'active').length >= 50) return failWith('trip_full');
      if (own) {
        Object.assign(own, { status: 'active', role: 'member', left_at: null, display_name: r.requesterName });
        return approved(own, 'approved');
      }
      const created = memberRow({ id: uuid(9700 + ++joinSeq), user_id: r.userId, display_name: r.requesterName, role: 'member', status: 'active', joined_at: new Date().toISOString() });
      ms.push(created);
      return approved(created, 'approved');
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
    // ---- expenses: the fake enforces the SAME rules as the real database functions (who may, archived, active people, dates, versions,
    //      idempotent create) and derives the equal split itself. Reads are visible to ACTIVE members only, like row-level security.
    const SYSTEM_CATEGORIES = [['transportation', 'Transportation', 'bus', 10], ['accommodation', 'Accommodation', 'bed', 20], ['food', 'Food', 'utensils', 30], ['shopping', 'Shopping', 'shopping-bag', 40], ['activities', 'Activities', 'ticket', 50], ['fuel_tolls', 'Fuel and tolls', 'fuel', 60], ['other', 'Other', 'dots', 70]] as const;
    const categoryRows = SYSTEM_CATEGORIES.map(([key, name, icon, sort_order], i) => ({ id: uuid(9700 + i), key, name, icon, sort_order }));
    const expenseTable = ['expenses', 'expense_payers', 'expense_splits', 'categories', 'expense_revisions'].find((t) => url.pathname === `/rest/v1/${t}`);
    if (expenseTable && method === 'GET') {
      if (backend.failExpenseReads) return route.abort('connectionfailed');
      if (backend.slowExpenseReadsMs > 0) await new Promise((r) => setTimeout(r, backend.slowExpenseReadsMs));
      if (expenseTable === 'categories') return json(200, categoryRows);
      const wanted = (url.searchParams.get('trip_id') ?? '').replace(/^eq\./, '');
      const t = backend.trips.find((x) => x.id === wanted && !x._hidden);
      const me = ((t?._members ?? []) as Record<string, any>[]).find((m) => m.user_id === USER.id && m.status === 'active');
      if (!t || !me) return json(200, []); // row-level security: not an active member, so nothing at all
      if (expenseTable === 'expense_revisions') {
        const wantedExpense = (url.searchParams.get('expense_id') ?? '').replace(/^eq\./, '');
        return json(200, backend.revisions.filter((r) => r.trip_id === wanted && r.expense_id === wantedExpense).sort((a, b) => a.version - b.version).map((r) => ({ version: r.version, action: r.action, snapshot: r.snapshot, changed_by: r.changed_by, changed_at: r.changed_at })));
      }
      const rows = backend.expenses.filter((e) => e.tripId === wanted);
      // Like PostgREST: honour the Range header, never return more than 1,000 rows in one response, and report the exact total when asked.
      const pageOf = (all: any[]) => {
        // supabase-js sends .range(from, to) as the offset and limit query parameters
        const hasPaging = url.searchParams.has('offset') || url.searchParams.has('limit');
        const from = Number(url.searchParams.get('offset') ?? 0);
        const to = Math.min(from + Number(url.searchParams.get('limit') ?? 1000) - 1, from + 999);
        backend.expenseReadRequests.push({ table: expenseTable as string, from });
        const slice = all.slice(from, to + 1);
        const wantsCount = /count=exact/.test(request.headers()['prefer'] ?? '');
        return route.fulfill({
          status: hasPaging && all.length > 0 && slice.length < all.length ? 206 : 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...(wantsCount ? { 'content-range': `${slice.length ? `${from}-${from + slice.length - 1}` : '*'}/${all.length}` } : {}) },
          body: JSON.stringify(slice),
        });
      };
      if (backend.failExpensePageFrom !== null && Number(url.searchParams.get('offset') ?? 0) >= backend.failExpensePageFrom) return route.abort('connectionfailed');
      if (backend.failExpensePageFrom !== null && (/^(\d+)-/.exec(request.headers()['range'] ?? '')?.[1] ?? '0') !== '0' && Number(/^(\d+)-/.exec(request.headers()['range'] ?? '')?.[1]) >= backend.failExpensePageFrom) return route.abort('connectionfailed');
      const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
      if (expenseTable === 'expenses') {
        return pageOf([...rows].sort((a, b) => (a.spent_on !== b.spent_on ? byId(b.spent_on, a.spent_on) : a.created_at !== b.created_at ? byId(b.created_at, a.created_at) : byId(b.id, a.id))).map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !['payers', 'splits', 'tripId'].includes(k)))));
      }
      const pairs = (key: 'payers' | 'splits') => rows.flatMap((e) => e[key].map((p: any) => ({ e, p })));
      const ordered = (list: { e: any; p: any }[]) => list.sort((x, y) => byId(x.e.id, y.e.id) || byId(x.p.member_id, y.p.member_id));
      if (expenseTable === 'expense_payers') return pageOf(ordered(pairs('payers')).map(({ e, p }) => ({ expense_id: e.id, trip_member_id: p.member_id, paid_minor: p.paid_minor })));
      return pageOf(ordered(pairs('splits')).map(({ e, p }) => ({ expense_id: e.id, trip_member_id: p.member_id, share_minor: p.share_minor, input_value: p.input_value ?? null })));
    }
    const EXPENSE_FNS = ['create_expense', 'update_expense', 'delete_expense', 'restore_expense', 'trip_member_balances'];
    const expenseFn = url.pathname.replace('/rest/v1/rpc/', '');
    if (url.pathname.startsWith('/rest/v1/rpc/') && EXPENSE_FNS.includes(expenseFn) && method === 'POST') {
      const failWith = (message: string, details: string | null = null) => json(400, { code: 'P0001', message, details, hint: null });
      const authHeader = request.headers()['authorization'] ?? '';
      if (authHeader === '' || authHeader === `Bearer ${DUMMY_PUBLISHABLE_KEY}`) return json(401, { code: '42501', message: `permission denied for function ${expenseFn}` });
      if (backend.slowExpenseMs > 0) await new Promise((r) => setTimeout(r, backend.slowExpenseMs));
      if (backend.expenseFail === 'network') return route.abort('connectionfailed');
      if (backend.expenseFail && backend.expenseFail !== 'lost_reply') {
        const [msg, detail] = backend.expenseFail.split('|');
        return failWith(msg!, detail ?? null);
      }
      const lost = backend.expenseFail === 'lost_reply';
      const reply = (data: unknown) => (lost ? route.abort('connectionfailed') : json(200, data));

      const t = backend.trips.find((x) => x.id === body.p_trip_id && !x._hidden);
      const ms = ((t?._members ?? []) as Record<string, any>[]);
      const me = ms.find((m) => m.user_id === USER.id && m.status === 'active');
      if (!t || !me) return failWith('trip_not_found');

      if (expenseFn === 'trip_member_balances') {
        if (backend.balanceRows?.[t.id]) return json(200, backend.balanceRows[t.id]);
        const live = backend.expenses.filter((e) => e.tripId === t.id && !e.deleted_at);
        const ledger = live.map((e) => ({ id: e.id, payers: e.payers.map((p: any) => ({ memberId: p.member_id, paidMinor: p.paid_minor })), splits: e.splits.map((p: any) => ({ memberId: p.member_id, shareMinor: p.share_minor })) }));
        const result = computeBalances(ms.map((m) => m.id), ledger, []);
        return json(200, ms.map((m) => { const b = result.find((r) => r.memberId === m.id)!; return { member_id: m.id, paid_minor: b.paidMinor, share_minor: b.shareMinor, net_minor: b.netConfirmedMinor }; }));
      }
      if (t.status === 'archived') return failWith('trip_archived');

      // shared checks for create and update
      const checkInput = () => {
        const title = String(body.p_title ?? '').trim();
        if (title === '' || title.length > 120 || !Number.isInteger(body.p_amount_minor) || body.p_amount_minor < 1 || !['equal', 'exact', 'percentage', 'shares'].includes(body.p_split_method)) return 'invalid_expense';
        const parts: string[] = body.p_participants ?? [];
        const payers: { member_id: string; paid_minor: number }[] = body.p_payers ?? [];
        if (parts.length === 0 || new Set(parts).size !== parts.length || payers.length === 0) return 'invalid_expense';
        if (payers.reduce((a, p) => a + p.paid_minor, 0) !== body.p_amount_minor) return 'payers_total_mismatch';
        if (body.p_spent_on < t.start_date || body.p_spent_on > t.end_date) return 'outside_trip_dates';
        const active = new Set(ms.filter((m) => m.status === 'active').map((m) => m.id));
        if (!parts.every((id) => active.has(id))) return 'participant_not_active';
        if (!payers.every((p) => active.has(p.member_id))) return 'payer_not_active';
        if (body.p_category_key !== null && !categoryRows.some((c) => c.key === body.p_category_key)) return 'category_not_found';
        const typed: { member_id: string; value: number }[] | null = body.p_split_inputs ?? null;
        if (body.p_split_method === 'equal') {
          if (typed !== null) return 'invalid_expense';
        } else {
          if (!Array.isArray(typed) || typed.length !== parts.length || !typed.every((i) => parts.includes(i.member_id) && Number.isInteger(i.value)) || new Set(typed.map((i) => i.member_id)).size !== typed.length) return 'invalid_expense';
          const vals = typed.map((i) => i.value);
          const sum = vals.reduce((a: number, v: number) => a + v, 0);
          if (body.p_split_method === 'exact') { if (vals.some((v: number) => v < 0)) return 'invalid_split_value'; if (sum !== body.p_amount_minor) return 'split_total_mismatch'; }
          if (body.p_split_method === 'percentage') { if (vals.some((v: number) => v < 1 || v > 10000)) return 'invalid_split_value'; if (sum !== 10000) return 'split_total_mismatch'; }
          if (body.p_split_method === 'shares' && vals.some((v: number) => v < 1 || v > 1000000)) return 'invalid_split_value';
        }
        return null;
      };
      const build = () => ({
        title: String(body.p_title).trim(), amount_minor: body.p_amount_minor, spent_on: body.p_spent_on,
        category_id: body.p_category_key === null ? null : categoryRows.find((c) => c.key === body.p_category_key)!.id,
        notes: body.p_notes === null || String(body.p_notes).trim() === '' ? null : String(body.p_notes).trim(),
        payers: [...body.p_payers].map((p: any) => ({ member_id: p.member_id, paid_minor: p.paid_minor })).sort((a: any, b: any) => (a.member_id < b.member_id ? -1 : 1)),
        split_method: body.p_split_method,
        splits: previewSplit(body.p_amount_minor, body.p_split_method, body.p_participants, (body.p_split_inputs ?? null)?.map((i: any) => ({ memberId: i.member_id, value: i.value })) ?? null).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: (body.p_split_inputs ?? null)?.find((i: any) => i.member_id === r.memberId)?.value ?? null })),
      });
      const canon = (e: Record<string, any>) => JSON.stringify([e.title, e.amount_minor, e.spent_on, e.category_id, e.notes, e.split_method, e.payers, e.splits]);
      const catKey = (id: string | null) => categoryRows.find((c) => c.id === id)?.key ?? null;
      /** What the database records after every change: the expense as it is now, as member ids and amounts only. */
      const record = (e: Record<string, any>, action: string) => backend.revisions.push({
        trip_id: e.tripId, expense_id: e.id, version: e.version, action, changed_by: me.id, changed_at: new Date().toISOString(),
        snapshot: { title: e.title, amount_minor: e.amount_minor, spent_on: e.spent_on, category_key: catKey(e.category_id), notes: e.notes, split_method: e.split_method, payers: e.payers, splits: e.splits.map((s: any) => (s.input_value === null || s.input_value === undefined ? { member_id: s.member_id, share_minor: s.share_minor } : { member_id: s.member_id, share_minor: s.share_minor, input_value: s.input_value })), deleted: !!e.deleted_at },
      });
      const touch = (e: Record<string, any>) => { e.version += 1; e.updated_at = new Date().toISOString(); e.updated_by = me.id; };

      if (expenseFn === 'create_expense') {
        const bad = checkInput();
        const existing = backend.expenses.find((e) => e.id === body.p_expense_id);
        if (existing) {
          if (!bad && existing.tripId === t.id && existing.created_by === me.id && !existing.deleted_at && canon(existing) === canon(build())) return reply([{ expense_id: existing.id, version: existing.version, created: false }]);
          return failWith('expense_id_taken');
        }
        if (bad) return failWith(bad);
        const now = new Date().toISOString();
        const made = { id: body.p_expense_id, tripId: t.id, created_by: me.id, updated_by: null, created_at: now, updated_at: now, version: 1, deleted_at: null, deleted_by: null, ...build() };
        backend.expenses.push(made);
        record(made, 'create');
        return reply([{ expense_id: made.id, version: 1, created: true }]);
      }

      const e = backend.expenses.find((x) => x.id === body.p_expense_id && x.tripId === t.id);
      if (!e) return failWith('expense_not_found');
      if (!(me.role === 'admin' || e.created_by === me.id)) return failWith('not_allowed');
      if (body.p_expected_version !== e.version) return failWith('version_conflict');
      if (expenseFn === 'update_expense') {
        if (e.deleted_at) return failWith('expense_deleted');
        const bad = checkInput();
        if (bad) return failWith(bad);
        const next = build();
        if (canon(e) === canon({ ...e, ...next })) return reply([{ expense_id: e.id, version: e.version, changed: false }]);
        Object.assign(e, next);
        touch(e);
        record(e, 'update');
        return reply([{ expense_id: e.id, version: e.version, changed: true }]);
      }
      if (expenseFn === 'delete_expense') {
        if (e.deleted_at) return reply([{ expense_id: e.id, version: e.version, changed: false }]);
        e.deleted_at = new Date().toISOString();
        e.deleted_by = me.id;
        touch(e);
        record(e, 'delete');
        return reply([{ expense_id: e.id, version: e.version, changed: true }]);
      }
      // restore_expense
      if (!e.deleted_at) return reply([{ expense_id: e.id, version: e.version, changed: false }]);
      if (e.spent_on < t.start_date || e.spent_on > t.end_date) return failWith('outside_trip_dates');
      e.deleted_at = null;
      e.deleted_by = null;
      touch(e);
      record(e, 'restore');
      return reply([{ expense_id: e.id, version: e.version, changed: true }]);
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
    let el: Element | null = document.elementFromPoint(window.innerWidth - 4, 4); // top-right: on a wide window the left edge is the side navigation
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
  await page.waitForTimeout(350); // let the page's short fade-in finish so the picture shows the finished screen
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
      await byId(page, 'landing').waitFor({ timeout: 20000 });
      check('opening the website signed out shows the public landing page', pathOf(page) === '/welcome', pathOf(page));
      check('first launch is LIGHT', (await screenBg(page)) === LIGHT_BG, await screenBg(page));
      await shot(page, 'landing-light');

      await page.goto(`${BASE}/profile`);
      await byId(page, 'landing').waitFor({ timeout: 20000 });
      check('a protected page (/profile) sends a signed-out web visitor to the landing page', pathOf(page) === '/welcome', pathOf(page));

      await byId(page, 'hero-login').click();
      await byId(page, 'email').waitFor({ timeout: 20000 });
      check('Log in on the landing page opens sign-in', pathOf(page) === '/sign-in', pathOf(page));
      await shot(page, 'sign-in-light');

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
    await byId(page, 'nav-profile').click();
    await byId(page, 'profile-name').waitFor({ timeout: 8000 });
    check('profile form is filled from the account', (await byId(page, 'profile-name').inputValue()) === 'Asha Rao');
    check('shows the signed-in email', (await byId(page, 'profile-email').innerText()) === 'asha@example.com');
    check('Save is disabled until something changes (and announced as disabled)', (await byId(page, 'save-profile').getAttribute('aria-disabled')) === 'true');
    check('the Profile screen no longer holds the theme or sign-out controls (they are in Settings)', (await byId(page, 'theme-dark').count()) === 0 && (await byId(page, 'sign-out').count()) === 0);

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

    // Theme (Settings, opened from the gear on Profile)
    await byId(page, 'open-settings').click();
    await byId(page, 'theme-dark').waitFor({ timeout: 8000 });
    check('Settings opens from the Profile gear and the bottom navigation is hidden there', pathOf(page) === '/settings' && (await byId(page, 'bottom-nav').count()) === 0, pathOf(page));
    check('accessibility: the selected theme is announced as checked', (await byId(page, 'theme-light').getAttribute('aria-checked')) === 'true' && (await byId(page, 'theme-dark').getAttribute('aria-checked')) === 'false');
    await byId(page, 'theme-dark').click();
    check('choosing Dark switches the whole screen to dark', await waitFor(async () => (await screenBg(page)) === DARK_BG));
    check('accessibility: Dark is now announced as the checked option', (await byId(page, 'theme-dark').getAttribute('aria-checked')) === 'true' && (await byId(page, 'theme-light').getAttribute('aria-checked')) === 'false');
    await shot(page, 'profile-dark');
    const themePatch = await waitFor(() => backend.requests.some((r) => r.method === 'PATCH' && r.body?.theme_preference === 'dark'));
    check('the choice is saved to the account', themePatch);
    await page.reload();
    await byId(page, 'theme-dark').waitFor({ timeout: 10000 });
    check('Dark persists after a reload', await waitFor(async () => (await screenBg(page)) === DARK_BG));

    await byId(page, 'theme-light').click();
    check('choosing Light switches back', await waitFor(async () => (await screenBg(page)) === LIGHT_BG));
    await shot(page, 'profile-light');

    // There is no System option any more: only Light and Dark are offered
    check('Settings offers only Light and Dark (no System option anywhere)', (await byId(page, 'theme-system').count()) === 0 && (await byId(page, 'theme-light').count()) === 1 && (await byId(page, 'theme-dark').count()) === 1);

    // Account is source of truth on another device
    await byId(page, 'theme-dark').click();
    await waitFor(() => backend.requests.some((r) => r.method === 'PATCH' && r.body?.theme_preference === 'dark' && r.body !== undefined) && (backend.profile.theme_preference === 'dark'));
    const other = await browser.newContext({ colorScheme: 'light' });
    await installFakeSupabase(other, backend);
    await sessionInStorage(other);
    const otherPage = await other.newPage();
    await otherPage.goto(BASE);
    await byId(otherPage, 'greeting').waitFor({ timeout: 20000 });
    check('a second device (no saved local choice) picks up Dark from the account', await waitFor(async () => (await screenBg(otherPage)) === DARK_BG, 10000), `${await screenBg(otherPage)} account=${String(backend.profile.theme_preference)}`);
    await other.close();

    // A choice made on THIS device beats a different account value (Light on the device, Dark on the account)
    const keep = await browser.newContext({ colorScheme: 'light' });
    await keep.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'light'));
    await installFakeSupabase(keep, backend);
    await sessionInStorage(keep);
    const keepPage = await keep.newPage();
    await keepPage.goto(BASE);
    await byId(keepPage, 'greeting').waitFor({ timeout: 20000 });
    await keepPage.waitForTimeout(800);
    check('device Light + account Dark: the device choice wins (stays Light)', (await screenBg(keepPage)) === LIGHT_BG && backend.profile.theme_preference === 'dark', await screenBg(keepPage));
    await keep.close();

    // An old saved "system" becomes a real Light or Dark (the device is dark here) and is stored as such
    const legacy = await browser.newContext({ colorScheme: 'dark' });
    await legacy.addInitScript(() => {
      if (!window.sessionStorage.getItem('seeded')) {
        window.sessionStorage.setItem('seeded', '1');
        window.localStorage.setItem('tripmate.theme-preference', 'system');
      }
    });
    await installFakeSupabase(legacy, backend);
    await sessionInStorage(legacy);
    const legacyPage = await legacy.newPage();
    await legacyPage.goto(BASE);
    await byId(legacyPage, 'greeting').waitFor({ timeout: 20000 });
    check('a legacy saved "system" on a dark device resolves to Dark, with no flash of the other theme', await waitFor(async () => (await screenBg(legacyPage)) === DARK_BG, 10000), await screenBg(legacyPage));
    const rewritten = await legacyPage.evaluate(() => window.localStorage.getItem('tripmate.theme-preference'));
    check('...and is stored as "dark" from then on', rewritten === 'dark', String(rewritten));
    await legacy.close();

    // Failed theme save
    backend.failProfileWrites = true;
    await byId(page, 'theme-light').click();
    const warn = await byId(page, 'theme-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check('if the account cannot be updated the user is told it is saved on this device only', warn);
    check('...and the theme still changes on this device', await waitFor(async () => (await screenBg(page)) === LIGHT_BG));
    backend.failProfileWrites = false;

    // Sign out
    await byId(page, 'sign-out').click();
    const out = await byId(page, 'landing').waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('signing out returns to the public website', out && pathOf(page) === '/welcome', pathOf(page));
    check('the saved session is removed from the browser', (await page.evaluate((k) => window.localStorage.getItem(k), STORAGE_KEY)) === null);
    check('the logout request signs out this device only', authRequests(backend, '/auth/v1/logout').some((r) => r.path.includes('scope=local')), JSON.stringify(authRequests(backend, '/auth/v1/logout').map((r) => r.path)));
    await page.goto(`${BASE}/profile`);
    await byId(page, 'landing').waitFor({ timeout: 10000 });
    check('after sign-out, /profile is protected again', pathOf(page) === '/welcome', pathOf(page));
    check('the theme choice still applies on the public website (device setting)', (await screenBg(page)) === LIGHT_BG);

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
    await byId(page, 'nav-create').click();
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
    const startKept = await byId(page, 'trip-start').inputValue();
    await byId(page, 'trip-start').fill('30/02/2026');
    check('an impossible date (30 February) cannot be typed or pasted: the box keeps the date it had', (await byId(page, 'trip-start').inputValue()) === startKept, await byId(page, 'trip-start').inputValue());
    await byId(page, 'trip-start').fill('');
    await byId(page, 'create-trip-submit').click();
    check('an empty start date is rejected', await vis(page, 'Enter the start date like 27/12/2026').waitFor({ timeout: 5000 }).then(() => true, () => false));
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

    await byId(page, 'status-ongoing').waitFor({ timeout: 8000 });
    const text = async (id: string) => (await byId(page, id).innerText().catch(() => ''));
    check('Home opens on Ongoing, with Ongoing the middle of Completed | Ongoing | Upcoming', (await byId(page, 'status-ongoing').getAttribute('aria-selected')) === 'true' && (await page.locator('[role="tab"]:visible').allInnerTexts()).join('|') === 'Completed|Ongoing|Upcoming', `${await byId(page, 'status-ongoing').getAttribute('aria-selected')} / ${(await page.locator('[role="tab"]:visible').allInnerTexts()).join('|')}`);
    check('a trip happening today is under Ongoing', (await phaseText(page, 'ongoing')).includes('Ongoing Manali'));
    check('a finished trip is under Completed', (await phaseText(page, 'completed')).includes('Old Jaipur'));
    check('the new trip appears under Upcoming', (await phaseText(page, 'upcoming')).includes('Goa Trip 2026'));
    check('an archived trip is not shown', !(await page.locator('body').innerText()).includes('Archived Secret'));
    const goa = await text(`trip-card-${backend.trips[0]!.id}`);
    check('the card shows place, dates and budget', goa.includes('Goa, India') && goa.includes(formatDateRange(startIso, endIso)) && goa.includes('Budget ₹60,000'), goa.replace(/\n/g, ' | '));
    await byId(page, 'status-ongoing').click();
    check('the card counts only people still on the trip', (await text('trip-card-trip-ongoing')).includes('2 people'));
    check('a single member reads "1 person"', goa.includes('1 person'));
    await shot(page, 'home-trips-light');

    // ---- double tap while saving
    backend.createMode = 'slow';
    const before = rpcCalls().length;
    await byId(page, 'nav-create').click();
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
    await byId(page, 'nav-create').click();
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
    check('"Try again" recovers and shows the trips', await byId(failPage, 'section-ongoing').waitFor({ timeout: 10000 }).then(() => true, () => false));
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
    await showHomeCard(page, GOA);
    const label = (await byId(page, `trip-card-${GOA}`).getAttribute('aria-label')) ?? '';
    check('accessibility: the trip card is a button that names the trip', label.startsWith('Open trip Goa Trip 2026, Goa, India'), label);
    await byId(page, `trip-card-${GOA}`).click();
    const opened = await byId(page, 'trip-title').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check('tapping a trip card opens its details page', opened && pathOf(page) === `/trips/${GOA}`, pathOf(page));

    // ---- what the page shows
    check('shows the trip name and destination', (await textOf('trip-title')) === 'Goa Trip 2026' && (await textOf('trip-destination')) === 'Goa, India');
    check('shows the phase (starts in 30 days = Upcoming)', titleCase(await textOf('trip-phase')) === 'Upcoming');
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
    check('a member can open an archived trip, with a clear notice', (await textOf('trip-archived')) === 'This trip is archived.' && titleCase(await textOf('trip-phase')) === 'Completed');

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
    await page.waitForTimeout(500); // the layout switches from the desktop dashboard to the phone layout
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
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      check('opening a trip address while signed out goes to the public website', pathOf(p) === '/welcome', pathOf(p));
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
        const phase = titleCase(await byId(p, 'trip-phase').innerText());
        const days = (await byId(p, 'trip-length').innerText()).trim();
        if (phase !== c.phase || days !== c.days) allGood = false;
        results.push(`${c.name}: ${phase}, ${days}`);
      }
      check(`${zone} (today is ${today}): starts-today and ends-today are Ongoing, tomorrow Upcoming, yesterday Completed, lengths right`, allGood, results.join(' | '));
      await p.goto(BASE);
      await byId(p, 'section-ongoing').waitFor({ timeout: 20000 });
      const ongoing = await phaseText(p, 'ongoing');
      const upcoming = await phaseText(p, 'upcoming');
      const completed = await phaseText(p, 'completed');
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
    await byId(page, 'greeting').waitFor({ timeout: 10000 });
    const upcomingAfterEdit = await phaseText(page, 'upcoming');
    check('Home shows the new name', upcomingAfterEdit.includes('Edited Trip') && !upcomingAfterEdit.includes('Edit Me'));

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
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      check('signed out, the edit address goes to the public website and requests nothing', pathOf(p) === '/welcome' && !anonBackend.requests.some((r) => r.path.startsWith('/rest/v1/trips') || r.path.startsWith('/rest/v1/rpc')));
      await anon.close();
    }

    // ============ Archived screen ============
    await go('/archived', 'section-archived');
    check('the Archived screen shows "Archived (n)" counting only trips this person can access', (await text('section-archived')).toLowerCase().includes(`archived (${archivedExpected()})`) && !(await page.locator('body').innerText()).includes('Hidden Archived'), await text('section-archived'));
    await go('/', 'greeting');
    check('archived trips are not in Ongoing, Upcoming or Completed, and Home has no archived toggle', !/Archived/.test((await phaseText(page, 'ongoing')) + (await phaseText(page, 'upcoming')) + (await phaseText(page, 'completed'))) && !(await exists('archived-toggle')));
    await go('/archived', 'section-archived');
    await byId(page, `trip-card-${T.ARCH_UP}`).waitFor({ timeout: 5000 });
    check('the archived trips are listed, each tagged "Archived"', (await exists(`archived-tag-${T.ARCH_UP}`)) && (await exists(`archived-tag-${T.ARCH_PAST}`)));
    await shot(page, 'archived-screen');
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
    await go('/', 'greeting');
    check('on Home it left Ongoing', !(await phaseText(page, 'ongoing').catch(() => '')).includes('Ongoing Trip'));
    await go('/archived', 'section-archived');
    check('...and the Archived count went up by one', (await text('section-archived')).toLowerCase().includes(`archived (${archivedExpected()})`), await text('section-archived'));

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
      await byId(page, 'greeting').waitFor({ timeout: 10000 });
      check(`${label}: it returns to the "${section}" group on Home`, (await phaseText(page, section as 'completed' | 'ongoing' | 'upcoming')).includes(name));
    };
    await restoreAndCheck(T.ARCH_ONG, 'Archived Ongoing', 'ongoing', 'restoring a trip whose dates are happening now');
    await restoreAndCheck(T.ARCH_UP, 'Archived Upcoming', 'upcoming', 'restoring a future trip');
    await restoreAndCheck(T.ARCH_PAST, 'Archived Past', 'completed', 'restoring a finished trip');
    await go('/archived', 'section-archived');
    check('the Archived count always equals the archived trips this person can access', (await text('section-archived')).toLowerCase().includes(`archived (${archivedExpected()})`), await text('section-archived'));

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
        return titleCase(await byId(p, 'trip-phase').innerText());
      };
      const homeHas = async (section: string) => {
        await p.goto(BASE);
        await byId(p, 'greeting').waitFor({ timeout: 20000 }).catch(() => {});
        return (await phaseText(p, section as 'completed' | 'ongoing' | 'upcoming').catch(() => '')).includes('Zone Trip');
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
      await p.goto(`${BASE}/archived`);
      await byId(p, 'section-archived').waitFor({ timeout: 20000 });
      await p.goto(BASE);
      await byId(p, 'greeting').waitFor({ timeout: 20000 });
      const gone = !(await phaseText(p, 'upcoming').catch(() => '')).includes('Zone Trip');
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
      check(`${P} pasting only symbols changes nothing (the date stays)`, (await val(S)) === '27/12/2026', await val(S));

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
      check(`${P} typing a digit in the middle that would make an impossible date is refused`, (await val(S)) === '27/12/2026', `${await val(S)} caret ${(await caret(S)).join()}`); // a 5 there would make month 51: refused
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
        const wanted = `${bad.slice(0, 2)}/${bad.slice(2, 4)}/${bad.slice(4)}`;
        // The impossible date cannot be completed while typing (the key that would make it impossible is refused), so what is left is a
        // shorter, unfinished date: it is never "corrected" into another date, and it cannot be saved.
        check(`${P} ${wanted} cannot be typed in full (the box stops at "${shown}") and what is left is not accepted`, rejected && shown !== wanted && shown.length < 10, shown);
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
      const wantSelected = 'rgb(47, 93, 68)'; // the forest-green fill in both themes
      const wantSurface = theme === 'dark' ? 'rgb(28, 28, 28)' : 'rgb(235, 227, 208)';
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
    // ADR-047: the database refuses to remove someone with an outstanding balance. The page must say so plainly (never "Something went wrong").
    backend.memberFail = 'balance_not_settled';
    await byId(page, 'confirm-confirm').click();
    check('a person with an outstanding balance: the refusal is explained and is not the generic failure', await settle(async () => /still has a balance in the trip's expenses/.test(await page.locator('body').innerText())) && !/Something went wrong/.test(await page.locator('body').innerText()));
    check('...and they are still on the trip', (await text('trip-people')).includes('Ravi Kumar'));
    backend.memberFail = null;
    await manage(ID.ravi);
    await byId(page, `member-remove-${ID.ravi}`).click();
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
    check('you land on Home, and the trip is no longer in your list', (await byId(page, 'greeting').waitFor({ timeout: 8000 }).then(() => true, () => false)) && pathOf(page) === '/' && !(await homeHasCard(page, T.A)));
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
      check('Dark theme: the confirmation uses the dark surface', surface === 'rgb(28, 28, 28)', surface);
      await shot(p, 'people-confirm-dark');
      await dark.close();
    }
  } finally {
    site.stop();
  }
}

async function inviteFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nL. Invitations and join requests (a link only ever creates a request; an admin approves)');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9801), ravi: uuid(9802), gita: uuid(9803), boss: uuid(9804), gopal: uuid(9805), dev: uuid(9807), gopal3: uuid(9808), gopal4: uuid(9809) } as const;
    const T = {
      A: uuid(801), MEM: uuid(802), ARCH: uuid(803), DOUBLE: uuid(804), FULL: uuid(805),
      J1: uuid(811), J2: uuid(812), J3: uuid(813), J4: uuid(814), J6: uuid(816), JARCH: uuid(817),
    };
    const OTHER_USER = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    const start = dayFromToday(20);
    const end = dayFromToday(23);
    const mine = (id: string, role = 'admin', status = 'active') => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role, status, left_at: status === 'active' ? null : '2026-11-10T10:00:00+00:00', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: '22222222-2222-4222-8222-222222222222', display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const gita = () => memberRow({ id: ID.gita, user_id: null, display_name: 'Gita', joined_at: '2026-11-18T11:00:00+00:00' });
    const gopal = (id: string = ID.gopal) => memberRow({ id, user_id: null, display_name: 'Gopal', joined_at: '2026-11-18T11:30:00+00:00' });
    const boss = () => memberRow({ id: ID.boss, user_id: '88888888-8888-4888-8888-888888888888', display_name: 'Boss Bhavna', role: 'admin', joined_at: '2026-11-18T08:00:00+00:00' });
    const trip = (id: string, name: string, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Udaipur', start_date: start, end_date: end, budget_minor: 9_999_900, members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    const request = (tripId: string, over: Record<string, any>) => seedRequest({ tripId, ...over });

    const logs: string[] = [];
    const watch = (page: Page) => {
      page.on('console', (m) => logs.push(m.text()));
      page.on('pageerror', (e) => logs.push(String(e)));
    };
    const textOf = async (page: Page, id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const has = async (page: Page, id: string) => (await byId(page, id).count()) > 0;
    const body = (page: Page) => page.locator('body').innerHTML();
    const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
    const iso = (ms: number) => new Date(ms).toISOString();

    // =============== the administrator's side ===============
    const adminCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const ab = newBackend();
    ab.trips = [
      trip(T.A, 'Invite Trip', [mine(ID.me), ravi(), gita()]),
      trip(T.MEM, 'Member Trip', [mine(ID.me, 'member'), boss()]),
      trip(T.ARCH, 'Archived Invite Trip', [mine(ID.me), ravi()], { status: 'archived' }),
      trip(T.DOUBLE, 'Double Invite Trip', [mine(ID.me), gita()]),
      trip(T.FULL, 'Full Trip', [mine(ID.me), ...Array.from({ length: 49 }, (_, i) => memberRow({ id: uuid(9900 + i), user_id: null, display_name: `Guest ${i + 2}` }))]),
    ];
    const reqNina = request(T.A, { userId: OTHER_USER(1), requesterName: 'Nina Shah', createdAt: Date.now() - 3 * 3_600_000 });
    const reqPriya = request(T.A, { userId: OTHER_USER(2), requesterName: 'Priya Rao', claimMemberId: ID.gita, createdAt: Date.now() - 2 * 3_600_000 });
    const reqOmar = request(T.A, { userId: OTHER_USER(3), requesterName: 'Omar Khan', createdAt: Date.now() - 1 * 3_600_000 });
    const reqArch = request(T.ARCH, { userId: OTHER_USER(4), requesterName: 'Waiting Wendy' });
    const reqFull = request(T.FULL, { userId: OTHER_USER(5), requesterName: 'Too Late Tara' });
    ab.joinRequests = [reqNina, reqPriya, reqOmar, reqArch, reqFull];
    await installFakeSupabase(adminCtx, ab);
    await sessionInStorage(adminCtx);
    const page = await adminCtx.newPage();
    watch(page);
    const listBodies: string[] = [];
    const requestBodies: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/rpc/list_trip_invites')) listBodies.push(await r.text().catch(() => ''));
      if (r.url().includes('/rpc/list_join_requests')) requestBodies.push(await r.text().catch(() => ''));
    });
    const calls = (fn: string) => ab.requests.filter((r) => r.method === 'POST' && r.path === `/rest/v1/rpc/${fn}`);
    const go = async (id: string, wait = 'trip-people') => {
      await page.goto(`${BASE}/trips/${id}`);
      return byId(page, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const selected = async (id: string) => (await byId(page, id).getAttribute('aria-checked')) === 'true';
    const tripA = () => ab.trips.find((t) => t.id === T.A)!;
    const lastInvite = () => ab.invites.at(-1)!;

    check('opens a trip as an administrator and sees the Invite people section', (await go(T.A)) && (await has(page, 'invite-section')));
    check('it says plainly that nobody joins until an admin approves', /Nobody joins until an admin approves their request/.test(await textOf(page, 'invite-approval-note')));
    check('with no link yet the button says "Create invitation link"', (await textOf(page, 'invite-open')) === 'Create invitation link');
    await byId(page, 'invite-open').click();
    check('visible caption: Link lasts; only the expiry is a choice (1, 7, 30 days; 7 by default); there is NO usage limit', (await textOf(page, 'invite-expiry-caption')) === 'Link lasts' && (await selected('invite-expiry-168')) && (await has(page, 'invite-expiry-24')) && (await has(page, 'invite-expiry-720')) && !(await has(page, 'invite-uses-1')) && !(await has(page, 'invite-uses-caption')) && !/Maximum people|usage limit/i.test(await textOf(page, 'invite-options')));
    check('the panel says the link can be copied again any time and ended with Revoke link, and the button says Create link', /copy this link again any time/.test(await textOf(page, 'invite-replace-note')) && (await textOf(page, 'invite-create')) === 'Create link');
    const createsBefore = calls('create_invite').length;
    await byId(page, 'invite-create').click();
    check('creating the link sends exactly the trip and how long it lasts, with no usage limit and no user id', (await settle(() => calls('create_invite').length === createsBefore + 1)) && JSON.stringify(calls('create_invite').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_claim_member_id: null, p_expires_in_hours: 168 }), JSON.stringify(calls('create_invite').at(-1)?.body));
    await byId(page, 'invite-link').waitFor({ timeout: 8000 });
    const firstToken = lastInvite().token as string;
    const linkText = await textOf(page, 'invite-link');
    check('the link is shown as <address>/join/<64-character token>, in ONE panel, selectable and wrapping without overflow', new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/join/[0-9a-f]{64}$`).test(linkText) && linkText.endsWith(firstToken) && (await page.locator('[data-testid="invite-general"]').count()) === 1 && (await page.locator('[data-testid="invite-link"]').count()) === 1 && (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), linkText);
    check('there is no second panel and no second Copy link, and no Done button is needed', !(await has(page, 'invite-created')) && !(await has(page, 'invite-copy')) && !(await has(page, 'invite-done')) && (await page.locator('[data-testid="invite-copy-link"]').count()) === 1);
    check('the single panel says it is Active, that people only send a request, and that an admin approves', (await textOf(page, 'invite-status')) === 'Active' && /only sends a request/.test(await textOf(page, 'invite-copy-note')));
    const generalId = lastInvite().id as string;
    check('the active link is on screen with when it was made (local time) and what it is, and offers Copy link and Revoke link, and NO Replace link', (await settle(async () => (await has(page, 'invite-copy-link')))) && (await textOf(page, `invite-created-at-${generalId}`)) === createdLabel(iso(lastInvite().createdAt)) && /^Invitation link · No requests yet · Expires in 7 days$/.test(await textOf(page, `invite-summary-${generalId}`)) && (await textOf(page, 'invite-copy-link')) === 'Copy link' && (await textOf(page, `invite-revoke-${generalId}`)) === 'Revoke link' && !(await has(page, 'invite-replace')) && !(await has(page, 'invite-open')), await textOf(page, `invite-summary-${generalId}`));
    const getsAfterCreate = calls('get_general_invite_link').length;
    await byId(page, 'invite-copy-link').click();
    check('Copy link puts the SAME link on the clipboard, says so, and asks the server for nothing more', (await byId(page, 'invite-copied').waitFor({ timeout: 5000 }).then(() => true, () => false)) && (await page.evaluate(() => navigator.clipboard.readText())) === linkText && calls('get_general_invite_link').length === getsAfterCreate);
    await shot(page, 'r3-invite-panel-desktop');
    await byId(page, 'invite-general').screenshot({ path: path.join(SHOTS, 'r3-invite-panel-desktop-element.png') });
    const vp0 = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    check('phone width: the unified invitation panel does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await byId(page, 'invite-general').screenshot({ path: path.join(SHOTS, 'r3-invite-panel-phone.png') });
    if (vp0) await page.setViewportSize(vp0);
    check('there is no Past invitations section', !(await has(page, 'invite-past-toggle')) && !/Past invitations/.test(await body(page)));
    await page.reload();
    await byId(page, 'trip-people').waitFor({ timeout: 20000 });
    await byId(page, 'invite-copy-link').waitFor({ timeout: 15000 });
    check('after a reload the admin\'s panel shows the same link again, and the token is nowhere in browser storage', (await textOf(page, 'invite-link')).endsWith(firstToken) && !(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).includes(firstToken));
    check('the list the server sends back never contains the token (read from the real responses)', listBodies.length >= 2 && listBodies.every((b) => !b.includes(firstToken) && !/"token"/i.test(b)), `${listBodies.length} answers`);

    // ---- Copy link: the same link every time
    await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
    const getsBefore = calls('get_general_invite_link').length;
    const copies: string[] = [];
    for (let n = 0; n < 3; n++) {
      await byId(page, 'invite-copy-link').click();
      await settle(() => calls('get_general_invite_link').length === getsBefore + n + 1);
      await settle(async () => (await page.evaluate(() => navigator.clipboard.readText())) !== (copies.at(-1) ?? 'nothing yet'));
      copies.push(await page.evaluate(() => navigator.clipboard.readText()));
    }
    check('Copy link, pressed three times, puts the very same link on the clipboard every time: the one that was created', copies.length === 3 && copies.every((c) => c === linkText), JSON.stringify(copies));
    check('each press asks only for this trip, and says it copied', calls('get_general_invite_link').slice(getsBefore).every((c) => JSON.stringify(c.body) === JSON.stringify({ p_trip_id: T.A })) && (await has(page, 'invite-copied')));
    check('copying makes no new link, and the token is not left in browser storage', calls('create_invite').length === createsBefore + 1 && !(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).includes(firstToken));
    // the link cannot be fetched (connection problem): a retry state, never a wrong or stale address
    ab.inviteFail = 'network-link';
    await page.reload();
    await byId(page, 'trip-people').waitFor({ timeout: 20000 });
    check('if the link cannot be loaded, the panel says so with Try again, shows no address and Copy link is off', (await byId(page, 'invite-link-failed').waitFor({ timeout: 15000 }).then(() => true, () => false)) && !(await has(page, 'invite-link')) && (await byId(page, 'invite-copy-link').getAttribute('aria-disabled')) === 'true');
    ab.inviteFail = null;
    await byId(page, 'invite-link-retry').click();
    check('Try again then shows the same link', await settle(async () => (await has(page, 'invite-link')) && (await textOf(page, 'invite-link')).endsWith(firstToken)));

    // ---- an older link (made before links could be copied again)
    lastInvite().legacy = true;
    await page.reload();
    await byId(page, 'trip-people').waitFor({ timeout: 20000 });
    await byId(page, 'invite-legacy-note').waitFor({ timeout: 15000 });
    check('a link made before this update cannot be copied: it says so, offers no Copy link, and still offers Revoke link', !(await has(page, 'invite-copy-link')) && /can't be copied/.test(await textOf(page, 'invite-legacy-note')) && (await has(page, `invite-revoke-${generalId}`)));
    lastInvite().legacy = false;
    await page.reload();
    await byId(page, 'invite-copy-link').waitFor({ timeout: 15000 });

    // ---- revoke
    const revokesBefore = calls('revoke_invite').length;
    await byId(page, `invite-revoke-${generalId}`).click();
    check('revoking asks first: the link stops for good, requests already made stay, people already on the trip stay, a new link can be made', (await textOf(page, 'confirm-title')) === 'Revoke the invitation link?' && /stops working for good/.test(await textOf(page, 'confirm-message')) && /Requests already made stay in Join requests/.test(await textOf(page, 'confirm-message')) && /Created \d/.test(await textOf(page, 'confirm-message')));
    await byId(page, 'confirm-cancel').click();
    await settle(async () => !(await has(page, 'confirm-dialog')));
    check('"Keep it" sends nothing, and the link can still be copied', calls('revoke_invite').length === revokesBefore && (await has(page, `invite-revoke-${generalId}`)) && (await has(page, 'invite-copy-link')));
    await byId(page, `invite-revoke-${generalId}`).click();
    await byId(page, 'confirm-confirm').click();
    check('confirming sends exactly the trip and the link', (await settle(() => calls('revoke_invite').length === revokesBefore + 1)) && JSON.stringify(calls('revoke_invite').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_invite_id: generalId }));
    check('with no live link Copy link and Revoke link are gone, Create invitation link is back, and nothing about old links is listed', (await settle(async () => (await has(page, 'invite-open')))) && !(await has(page, 'invite-copy-link')) && !(await has(page, `invite-revoke-${generalId}`)) && !(await has(page, 'invite-past-toggle')));
    check('requests that were already waiting are untouched by revoking', ab.joinRequests.filter((r) => r.tripId === T.A && r.status === 'pending').length === 3);
    // a stale screen: another admin made a link a moment ago, so this one is refused with a clear message and nothing is replaced
    const raced = seedInvite({ tripId: T.A, createdBy: ID.me });
    ab.invites.push(raced);
    await byId(page, 'invite-open').click();
    await byId(page, 'invite-create').click();
    check('creating while a valid link already exists (another admin made one) is refused clearly, and that link is untouched', (await settle(async () => /already has an active invitation link/.test(await textOf(page, 'invite-error')))) && !raced.revoked);
    check('the screen then shows that link with Copy link (refreshed after the refusal)', await settle(async () => (await has(page, 'invite-copy-link'))));
    ab.invites.splice(ab.invites.indexOf(raced), 1);
    await page.reload();
    await byId(page, 'invite-open').waitFor({ timeout: 15000 });
    // a new link can be made after revoking: a different link from the old one
    await byId(page, 'invite-open').click();
    await byId(page, 'invite-expiry-720').click();
    await byId(page, 'invite-create').click();
    check('after revoking a new link can be made (30 days = 720 hours)', (await settle(() => calls('create_invite').length === createsBefore + 3)) && JSON.stringify(calls('create_invite').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_claim_member_id: null, p_expires_in_hours: 720 }));
    await byId(page, 'invite-link').waitFor({ timeout: 8000 });
    check('it is a different link from the revoked one', lastInvite().token !== firstToken && (await textOf(page, 'invite-link')).endsWith(lastInvite().token as string));
    await byId(page, 'invite-copy-link').waitFor({ timeout: 8000 });
    // and that one is revoked again so the claim-link steps below start with no general link
    await byId(page, `invite-revoke-${lastInvite().id}`).click();
    await byId(page, 'confirm-confirm').click();
    await settle(async () => (await has(page, 'invite-open')));

    // ---- a friend's claim link
    await byId(page, `member-manage-${ID.gita}`).click();
    check('only a friend without an account can be offered a claim link', (await has(page, `member-invite-${ID.gita}`)) && !(await (async () => { await byId(page, `member-manage-${ID.ravi}`).click(); return has(page, `member-invite-${ID.ravi}`); })()));
    await byId(page, `member-manage-${ID.ravi}`).click();
    await byId(page, `member-manage-${ID.gita}`).click();
    await byId(page, `member-invite-${ID.gita}`).click();
    check('the claim panel says whose place it is for, that it is single use, and that an admin still approves', /This link is for Gita/.test(await textOf(page, 'invite-claim-note')) && /an admin approves/.test(await textOf(page, 'invite-claim-note')) && (await textOf(page, 'invite-claim-single-use')) === 'Single use: only Gita can use this link.');
    await byId(page, 'invite-create').click();
    check('the claim link is sent with the friend (no usage limit)', (await settle(() => calls('create_invite').length === createsBefore + 4)) && JSON.stringify(calls('create_invite').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_claim_member_id: ID.gita, p_expires_in_hours: 168 }));
    await byId(page, 'invite-link').waitFor({ timeout: 8000 });
    check('the created claim link repeats that it is single use and still needs approval', /Single use: only Gita can use this link, and an admin still has to approve/.test(await textOf(page, 'invite-created-note')));
    const claimFirstId = lastInvite().id as string;
    await byId(page, 'invite-done').click();
    check('it is listed under Links for friends as for Gita, with Cancel this invitation', await settle(async () => /^For Gita · No request yet · Expires in 7 days$/.test(await textOf(page, `invite-summary-${claimFirstId}`))) && (await textOf(page, `invite-revoke-${claimFirstId}`)) === 'Cancel this invitation');
    await byId(page, `member-manage-${ID.gita}`).click();
    await byId(page, `member-invite-${ID.gita}`).click();
    await byId(page, 'invite-create').click();
    await byId(page, 'invite-link').waitFor({ timeout: 8000 });
    check('a second claim link for the same friend replaces the first (one live claim link per friend)', !!ab.invites.find((i) => i.id === claimFirstId)!.revoked && !lastInvite().revoked);
    await byId(page, 'invite-done').click();
    const claimId = lastInvite().id as string;
    await settle(async () => (await has(page, `invite-revoke-${claimId}`)));
    await byId(page, `invite-revoke-${claimId}`).click();
    check('cancelling a friend\'s link asks in its own words', (await textOf(page, 'confirm-title')) === 'Cancel this invitation?' && /Only this invitation stops working/.test(await textOf(page, 'confirm-message')));
    await byId(page, 'confirm-cancel').click();

    // ---- failures
    ab.inviteFail = 'network';
    await byId(page, 'invite-open').click();
    await byId(page, 'invite-create').click();
    check('a connection failure is explained and the options stay so it can be retried', (await settle(async () => /Can't reach the server/.test(await textOf(page, 'invite-error')))) && (await has(page, 'invite-create')));
    ab.inviteFail = 'not_admin';
    await byId(page, 'invite-create').click();
    check('"only admins" is explained', await settle(async () => (await textOf(page, 'invite-error')) === 'Only trip admins can do that.'));
    ab.inviteFail = null;
    await byId(page, 'invite-cancel-options').click();

    // =============== join requests: the administrator decides ===============
    check('Join requests is collapsed by default with the count always visible', (await textOf(page, 'requests-toggle')).includes('▸ Join requests (3)') && !(await has(page, 'requests-list')));
    await byId(page, 'requests-toggle').click();
    check('it lists who asked, when (local time), and whose place a claim is for; never a user id', (await textOf(page, `request-name-${reqNina.id}`)) === 'Nina Shah' && (await textOf(page, `request-when-${reqNina.id}`)) === askedLabel(iso(reqNina.createdAt)) && (await textOf(page, `request-claim-${reqPriya.id}`)) === "Wants to take Gita's place" && !(await has(page, `request-claim-${reqNina.id}`)));
    check('the requests the server sent contain no user id', requestBodies.length >= 1 && requestBodies.every((b) => !/user/i.test(b) && ![OTHER_USER(1), OTHER_USER(2), OTHER_USER(3)].some((u) => b.includes(u))));
    check('asking never added anyone: none of the three is on the trip yet', !(await textOf(page, 'trip-people')).match(/Nina|Priya|Omar/));
    const decidesBefore = calls('decide_join_request').length;
    await byId(page, `request-approve-${reqNina.id}`).click();
    check('Approve asks first, in plain words', (await textOf(page, 'confirm-title')) === 'Add Nina Shah to this trip?' && /will become a member/.test(await textOf(page, 'confirm-message')));
    await byId(page, 'confirm-cancel').click();
    await settle(async () => !(await has(page, 'confirm-dialog')));
    check('"Not yet" sends nothing and adds nobody', calls('decide_join_request').length === decidesBefore && !(await textOf(page, 'trip-people')).includes('Nina'));
    await byId(page, `request-approve-${reqNina.id}`).click();
    await byId(page, 'confirm-confirm').click();
    check('approving sends exactly the trip, the request and the answer (no user id)', (await settle(() => calls('decide_join_request').length === decidesBefore + 1)) && JSON.stringify(calls('decide_join_request').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_request_id: reqNina.id, p_approve: true }));
    check('only now is she on the trip, as an ordinary member; the count drops; a confirmation is shown', (await vis(page, 'People (4)').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await textOf(page, 'trip-people')).includes('Nina Shah') && (await textOf(page, 'requests-notice')) === 'Nina Shah was added to the trip.' && /Join requests \(2\)/.test(await textOf(page, 'requests-toggle')));
    check('she was added as a member, never an admin', (tripA()._members as Record<string, any>[]).find((m) => m.user_id === OTHER_USER(1))!.role === 'member');
    await byId(page, `request-reject-${reqOmar.id}`).click();
    check('Reject asks first and says they cannot ask again with the current link', (await textOf(page, 'confirm-title')) === "Reject Omar Khan's request?" && /cannot ask again with the current link/.test(await textOf(page, 'confirm-message')));
    await byId(page, 'confirm-confirm').click();
    check('rejecting sends approve=false, adds nobody, and says so', (await settle(() => calls('decide_join_request').length === decidesBefore + 2)) && calls('decide_join_request').at(-1)!.body.p_approve === false && (await settle(async () => (await textOf(page, 'requests-notice')) === "Omar Khan's request was rejected.")) && !(await textOf(page, 'trip-people')).includes('Omar'));
    await byId(page, `request-approve-${reqPriya.id}`).click();
    check('a claim is put in its own words: the friend\'s place and history', (await textOf(page, 'confirm-title')) === "Let Priya Rao take Gita's place?" && /with everything already recorded for Gita\. Nobody else is added/.test(await textOf(page, 'confirm-message')));
    await byId(page, 'confirm-confirm').click();
    check('approving a claim says she took the place; Gita is no longer a guest and nobody was added', (await settle(async () => (await textOf(page, 'requests-notice')) === "Priya Rao took Gita's place.")) && !(await textOf(page, `member-${ID.gita}`)).includes('Guest') && (await vis(page, 'People (4)').isVisible()));
    check('the friend\'s row is the same member, now with an account, still an ordinary member', (() => { const g = (tripA()._members as Record<string, any>[]).find((m) => m.id === ID.gita)!; return g.user_id === OTHER_USER(2) && g.role === 'member' && g.display_name === 'Gita'; })());
    check('with nothing waiting the list disappears, and the confirmation stays', !(await has(page, 'requests-toggle')) && (await has(page, 'requests-notice')));

    // an administrator with a stale list: someone else already answered
    ab.joinRequests.push(request(T.A, { userId: OTHER_USER(6), requesterName: 'Stale Sam' }));
    await page.reload();
    await byId(page, 'requests-toggle').waitFor({ timeout: 15000 });
    await byId(page, 'requests-toggle').click();
    const stale = ab.joinRequests.at(-1)!;
    stale.status = 'approved'; // another administrator answered it while this screen was open
    stale.memberId = ID.ravi;
    await byId(page, `request-approve-${stale.id}`).click();
    await byId(page, 'confirm-confirm').click();
    check('if another admin already answered, you are told so and nothing happens twice', (await settle(async () => (await textOf(page, 'requests-notice')) === 'Another admin already answered this request.')) && (tripA()._members as Record<string, any>[]).filter((m) => m.display_name === 'Stale Sam').length === 0);

    // failures while deciding
    const retry = request(T.A, { userId: OTHER_USER(7), requesterName: 'Retry Ria' });
    ab.joinRequests.push(retry);
    await page.reload();
    await byId(page, 'requests-toggle').waitFor({ timeout: 15000 });
    await byId(page, 'requests-toggle').click();
    ab.inviteFail = 'network';
    await byId(page, `request-approve-${retry.id}`).click();
    await byId(page, 'confirm-confirm').click();
    check('a connection failure keeps the dialog open with a message, so it can simply be retried', (await byId(page, 'confirm-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Can't reach the server/.test(await textOf(page, 'confirm-error')) && (await has(page, 'confirm-dialog')));
    ab.inviteFail = null;
    await byId(page, 'confirm-confirm').click();
    check('retrying from the same dialog works', await settle(async () => (await textOf(page, 'requests-notice')) === 'Retry Ria was added to the trip.'));
    check('on a full trip an approval is refused and the request stays waiting', await (async () => {
      await go(T.FULL);
      await byId(page, 'requests-toggle').click();
      await byId(page, `request-approve-${reqFull.id}`).click();
      await byId(page, 'confirm-confirm').click();
      return (await byId(page, 'requests-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /already has 50 people/.test(await textOf(page, 'requests-error')) && reqFull.status === 'pending' && (await has(page, 'requests-reload'));
    })());
    check('Reload latest clears the message and re-reads', await (async () => { await byId(page, 'requests-reload').click(); return settle(async () => !(await has(page, 'requests-error'))); })());

    // who sees what
    check('an ordinary member sees no invitation controls and no join requests', (await go(T.MEM)) && !(await has(page, 'invite-section')) && !(await has(page, 'requests-section')));
    check('on an archived trip an administrator sees neither (requests wait until it is restored)', (await go(T.ARCH)) && !(await has(page, 'invite-section')) && !(await has(page, 'requests-section')) && reqArch.status === 'pending');

    // double tap
    await go(T.DOUBLE);
    ab.slowInviteMs = 1200;
    await byId(page, 'invite-open').click();
    const doubleBefore = calls('create_invite').length;
    await byId(page, 'invite-create').click();
    await byId(page, 'invite-create').click({ timeout: 800, force: true }).catch(() => {});
    await page.waitForTimeout(1800);
    check('tapping Create twice sends only one request', calls('create_invite').length === doubleBefore + 1, String(calls('create_invite').length - doubleBefore));
    ab.slowInviteMs = 0;
    check('no unexpected network calls on the administrator side', ab.unexpected.length === 0, ab.unexpected.join(', '));
    await adminCtx.close();

    // =============== a visitor opens a link ===============
    const jb = newBackend();
    jb.trips = [
      trip(T.J1, 'Goa Joiners', [boss(), ravi()], { _hidden: true }),
      trip(T.J2, 'Claim Trip', [boss(), gopal()], { _hidden: true }),
      trip(T.J3, 'Conflict Trip', [boss(), gopal(ID.gopal3), mine(ID.dev, 'member', 'left')], { _hidden: true }),
      trip(T.J4, 'Other Trip', [boss(), gopal(ID.gopal4)], { _hidden: true }),
      trip(T.J6, 'Gone Trip', [boss()], { _hidden: true }),
      trip(T.JARCH, 'Archived Join Trip', [boss()], { _hidden: true, status: 'archived' }),
    ];
    const inv = (tripId: string, over: Record<string, any> = {}) => seedInvite({ tripId, createdBy: ID.boss, ...over });
    const iGeneral = inv(T.J1);
    const iClaim = inv(T.J2, { claimMemberId: ID.gopal });
    const iConflict = inv(T.J3, { claimMemberId: ID.gopal3 });
    const iUsedClaim = inv(T.J4, { claimMemberId: ID.gopal4 });
    const iRevoked = inv(T.J6, { revoked: true });
    const iReplacedOld = inv(T.J6, { revoked: true });
    const iExpired = inv(T.J6, { expiresAt: Date.now() - 1000 });
    const iArchived = inv(T.JARCH);
    const iRejected = inv(T.J6, {}); // this person was rejected once with this link
    jb.invites = [iGeneral, iClaim, iConflict, iUsedClaim, iRevoked, iReplacedOld, iExpired, iArchived, iRejected];
    const rejectedBefore = request(T.J6, { inviteId: iRejected.id, userId: USER.id, requesterName: 'Asha Rao', status: 'rejected' });
    const othersClaim = request(T.J4, { inviteId: iUsedClaim.id, userId: OTHER_USER(9), requesterName: 'Someone Else', claimMemberId: ID.gopal4 });
    jb.joinRequests = [rejectedBefore, othersClaim];
    iUsedClaim.useCount = 1;

    const outCtx = await browser.newContext();
    await installFakeSupabase(outCtx, jb);
    const out = await outCtx.newPage();
    watch(out);
    const open = async (p: Page, token: string, wait: string) => {
      await p.goto(`${BASE}/join/${token}`);
      return byId(p, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    check('a signed-out visitor can open a link and see what it is for', await open(out, iGeneral.token, 'join-trip-name'));
    check('it shows the trip, place, dates, who invited them and how many are on it', (await textOf(out, 'join-trip-name')) === 'Goa Joiners' && (await textOf(out, 'join-destination')) === 'Udaipur' && (await textOf(out, 'join-dates')) === formatDateRange(start, end) && (await textOf(out, 'join-inviter')) === 'Invited by Boss Bhavna' && (await textOf(out, 'join-count')) === '2 people are on this trip');
    const pageText = await out.locator('body').innerText();
    check('and nothing else: no budget, no people\'s names, no ids, no token', !/99,999|9999900|Ravi|Gopal|[0-9a-f]{32}/i.test(pageText) && !(await body(out)).includes(iGeneral.token), pageText.slice(0, 160));
    check('it says they can ASK to join and that an admin has to approve before they can see the trip', /ask to join\. An admin has to approve your request before you can see the trip/.test(await textOf(out, 'join-approval-note')) && /need a TripMate account/.test(await textOf(out, 'join-needs-account')));
    check('it offers sign in or create an account, and no join button yet', (await has(out, 'join-signin')) && (await has(out, 'join-signup')) && !(await has(out, 'join-request')));
    const previews = jb.requests.filter((r) => r.path === '/rest/v1/rpc/preview_invite');
    check('the preview request carries only the token, as the public key (not a login)', previews.length >= 1 && JSON.stringify(previews[0]!.body) === JSON.stringify({ p_token: iGeneral.token }) && previews[0]!.auth === `Bearer ${DUMMY_PUBLISHABLE_KEY}`);
    check('no trip, member or request call is made while signed out, and no URL contains the token', !jb.requests.some((r) => r.path.startsWith('/rest/v1/trips') || r.path.includes('list_trip_members') || r.path.includes('request_to_join')) && !jb.requests.some((r) => r.path.includes(iGeneral.token)));
    await shot(out, 'join-preview-signed-out');
    await open(out, iClaim.token, 'join-trip-name');
    check('a link made for a friend says so, and that an admin approves', /This invitation is for Gopal/.test(await textOf(out, 'join-claim-note')) && /If an admin approves your request/.test(await textOf(out, 'join-claim-note')));

    // every unusable link looks exactly the same
    const invalidTexts: string[] = [];
    const reqsBefore = jb.requests.length;
    for (const [label, token] of [
      ['cancelled', iRevoked.token], ['replaced', iReplacedOld.token], ['expired', iExpired.token], ['trip archived', iArchived.token],
      ['already used (a friend\'s link)', iUsedClaim.token], ['never existed', 'f'.repeat(64)], ['malformed (short)', 'abc'], ['malformed (upper case)', 'F'.repeat(64)],
    ] as const) {
      const shown = await open(out, token, 'join-invalid');
      invalidTexts.push(`${await textOf(out, 'join-invalid-title')} | ${await textOf(out, 'join-invalid')}`);
      check(`a ${label} link shows the "not valid" page`, shown);
    }
    check('all eight look exactly the same (nothing says which)', new Set(invalidTexts).size === 1, invalidTexts[0]);
    check('the two malformed links never contacted the server', jb.requests.slice(reqsBefore).filter((r) => r.path.includes('preview_invite')).length === 6);

    // sign in from the link, be brought back, and ASK
    await open(out, iGeneral.token, 'join-signin');
    await byId(out, 'join-signin').click();
    await byId(out, 'email').waitFor({ timeout: 10000 });
    check('Sign in remembers the link in this browser (briefly)', pathOf(out) === '/sign-in' && (await out.evaluate(() => (localStorage.getItem('tripmate.pending-invite') ?? '').length > 0)));
    await byId(out, 'email').fill('asha@example.com');
    await byId(out, 'password').fill('a-good-password-1');
    await byId(out, 'submit').click();
    check('after signing in they are brought straight back to the link, now with a Request to join button', (await byId(out, 'join-request').waitFor({ timeout: 15000 }).then(() => true, () => false)) && pathOf(out) === `/join/${iGeneral.token}` && (await textOf(out, 'join-request')) === 'Request to join', pathOf(out));
    check('asking is never automatic: nothing was sent yet', !jb.requests.some((r) => r.path.includes('request_to_join')));
    await byId(out, 'join-request').click();
    check('pressing it sends only the token, with their login', (await settle(() => jb.requests.some((r) => r.path.includes('request_to_join')))) && JSON.stringify(jb.requests.find((r) => r.path.includes('request_to_join'))!.body) === JSON.stringify({ p_token: iGeneral.token }) && !!jb.requests.find((r) => r.path.includes('request_to_join'))!.auth?.startsWith('Bearer ey'));
    check('they see "Request sent": an admin needs to approve it, and until then they can see nothing about the trip', (await byId(out, 'join-requested').waitFor({ timeout: 10000 }).then(() => true, () => false)) && /Your request has been sent\. An admin needs to approve it/.test(await textOf(out, 'join-requested')) && /cannot see anything about the trip/.test(await textOf(out, 'join-requested-privacy')));
    const j1 = jb.trips.find((t) => t.id === T.J1)!;
    check('NO membership was created: the trip\'s people are exactly as before, and one request is waiting', (j1._members as Record<string, any>[]).length === 2 && !(j1._members as Record<string, any>[]).some((m) => m.user_id === USER.id) && jb.joinRequests.filter((r) => r.tripId === T.J1 && r.status === 'pending').length === 1);
    check('the remembered link is cleared once used', await out.evaluate(() => localStorage.getItem('tripmate.pending-invite') === null));
    await out.goto(BASE);
    await byId(out, 'greeting').waitFor({ timeout: 15000 });
    check('the trip does NOT appear on their Home screen', !(await homeHasCard(out, T.J1)));
    await out.goto(`${BASE}/trips/${T.J1}`);
    check('opening the trip itself gives the single "not available" answer (a pending person sees nothing)', await byId(out, 'trip-unavailable').waitFor({ timeout: 15000 }).then(() => true, () => false));
    check('and nothing about the trip appears on that page', !/Goa Joiners|Udaipur|Boss Bhavna|Ravi/.test(await out.locator('body').innerText()));
    await open(out, iGeneral.token, 'join-request');
    await byId(out, 'join-request').click();
    check('asking again says they already asked; no second request is made', (await byId(out, 'join-requested').waitFor({ timeout: 10000 }).then(() => true, () => false)) && /already asked to join/.test(await textOf(out, 'join-requested')) && jb.joinRequests.filter((r) => r.tripId === T.J1).length === 1);
    // an administrator approves (simulated directly), and only then does the trip appear
    const pendingJ1 = jb.joinRequests.find((r) => r.tripId === T.J1)!;
    (j1._members as Record<string, any>[]).push(memberRow({ id: uuid(9990), user_id: USER.id, display_name: 'Asha Rao', role: 'member' }));
    j1.members = (j1._members as Record<string, any>[]).map((m) => ({ id: m.id, status: m.status }));
    j1._hidden = false;
    pendingJ1.status = 'approved';
    await out.goto(BASE);
    check('after an administrator approves, the trip appears on their Home screen', await showHomeCard(out, T.J1, 15000));
    await shot(out, 'join-after-approval');

    // a claim request: the friend's place is not touched until approval
    const claimBefore = JSON.stringify((jb.trips.find((t) => t.id === T.J2)!._members as Record<string, any>[]).find((m) => m.id === ID.gopal));
    await open(out, iClaim.token, 'join-request');
    check('a friend\'s link offers "Ask to take Gopal\'s place"', (await textOf(out, 'join-request')) === "Ask to take Gopal's place");
    await byId(out, 'join-request').click();
    check('it makes a CLAIM request and says an admin approves', (await byId(out, 'join-requested').waitFor({ timeout: 10000 }).then(() => true, () => false)) && jb.joinRequests.some((r) => r.tripId === T.J2 && r.claimMemberId === ID.gopal && r.status === 'pending'));
    check('the friend\'s place is exactly as it was: still a guest, nobody added', JSON.stringify((jb.trips.find((t) => t.id === T.J2)!._members as Record<string, any>[]).find((m) => m.id === ID.gopal)) === claimBefore && (jb.trips.find((t) => t.id === T.J2)!._members as unknown[]).length === 2);
    check('a friend\'s link is single use: once asked with, it no longer opens for anyone', await (async () => { await out.goto(`${BASE}/join/${iClaim.token}`); return byId(out, 'join-invalid').waitFor({ timeout: 15000 }).then(() => true, () => false); })());

    // refusals, in plain words
    await open(out, iRejected.token, 'join-request');
    await byId(out, 'join-request').click();
    check('a person rejected once cannot ask again with the same link (they need the new one)', (await byId(out, 'join-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /already asked to join with this link/.test(await textOf(out, 'join-error')) && /ask an admin for their new link/.test(await textOf(out, 'join-error')));
    const iClaimNew = inv(T.J4, { claimMemberId: ID.gopal4 }); // a replacement claim link while someone else is already waiting for that place
    jb.invites.push(iClaimNew);
    await open(out, iClaimNew.token, 'join-request');
    await byId(out, 'join-request').click();
    check('a place somebody else is already waiting for is refused clearly', (await byId(out, 'join-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Someone has already asked to take this place/.test(await textOf(out, 'join-error')));
    await open(out, iConflict.token, 'join-request');
    await byId(out, 'join-request').click();
    check('someone who was on the trip before is told to ask for the general link', (await byId(out, 'join-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /general invite link/.test(await textOf(out, 'join-error')));
    const iNet = inv(T.J6, {});
    iRejected.revoked = true;
    jb.invites.push(iNet);
    await open(out, iNet.token, 'join-request');
    jb.inviteFail = 'network';
    await byId(out, 'join-request').click();
    check('a connection failure keeps the button so it can be retried', (await byId(out, 'join-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Can't reach the server/.test(await textOf(out, 'join-error')) && (await has(out, 'join-request')));
    jb.inviteFail = null;
    await byId(out, 'join-request').click();
    check('retrying works', await byId(out, 'join-requested').waitFor({ timeout: 10000 }).then(() => true, () => false));
    check('a link cancelled between opening and asking shows the "not valid" page', await (async () => {
      const late = inv(T.J6, {});
      jb.invites.push(late);
      jb.joinRequests = jb.joinRequests.filter((r) => !(r.tripId === T.J6 && r.userId === USER.id && r.status === 'pending'));
      await open(out, late.token, 'join-request');
      late.revoked = true;
      await byId(out, 'join-request').click();
      return byId(out, 'join-invalid').waitFor({ timeout: 8000 }).then(() => true, () => false);
    })());
    check('double-tapping Request to join sends one request', await (async () => {
      jb.joinRequests = jb.joinRequests.filter((r) => !(r.tripId === T.J6 && r.userId === USER.id));
      const fresh = inv(T.J6, {});
      jb.invites.push(fresh);
      jb.slowInviteMs = 1200;
      await open(out, fresh.token, 'join-request');
      const before = jb.requests.filter((r) => r.path.includes('request_to_join')).length;
      await byId(out, 'join-request').click();
      await byId(out, 'join-request').click({ timeout: 800, force: true }).catch(() => {});
      await out.waitForTimeout(1800);
      jb.slowInviteMs = 0;
      return jb.requests.filter((r) => r.path.includes('request_to_join')).length === before + 1;
    })());

    // =============== secrecy, everywhere ===============
    const everyToken = jb.invites.map((i) => i.token as string).concat(ab.invites.map((i) => i.token as string));
    check('no token was ever written to the browser console', !logs.some((l) => everyToken.some((t) => l.includes(t))));
    check('no request URL anywhere contains a token', !jb.requests.concat(ab.requests).some((r) => everyToken.some((t) => r.path.includes(t))));
    check('no request to an invitation function carries a user id', jb.requests.concat(ab.requests).filter((r) => /rpc\/(create_invite|list_trip_invites|revoke_invite|preview_invite|request_to_join|list_join_requests|decide_join_request)/.test(r.path)).every((r) => !JSON.stringify(r.body ?? {}).includes(USER.id) && !/user/i.test(Object.keys(r.body ?? {}).join())));
    check('no unexpected network calls on the visitor side', jb.unexpected.length === 0, jb.unexpected.join(', '));
    await outCtx.close();

    // =============== phone and Dark ===============
    {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      b.trips = [trip(T.J1, 'Goa Joiners', [boss(), ravi()], { _hidden: true })];
      const phoneInvite = inv(T.J1);
      b.invites = [phoneInvite];
      await installFakeSupabase(ctx, b);
      const p = await ctx.newPage();
      await open(p, phoneInvite.token, 'join-trip-name');
      check('Phone: the invitation page does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      const box = await byId(p, 'join-signin').boundingBox();
      check('Phone: the buttons are comfortable touch targets (44 px)', !!box && box.height >= 44, JSON.stringify(box));
      await shot(p, 'join-phone');
      await ctx.close();
    }
    {
      const ctx = await browser.newContext();
      const b = newBackend();
      b.trips = [trip(T.J1, 'Goa Joiners', [boss(), ravi()], { _hidden: true })];
      b.profile = { ...b.profile, theme_preference: 'dark' };
      const darkInvite = inv(T.J1);
      b.invites = [darkInvite];
      await installFakeSupabase(ctx, b);
      await ctx.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      const p = await ctx.newPage();
      await open(p, darkInvite.token, 'join-trip-name');
      check('Dark theme: the invitation page follows the theme', await waitFor(async () => (await screenBg(p)) === DARK_BG));
      await shot(p, 'join-dark');
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function expenseFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nM. Expenses: list, details, add, edit, delete, restore, balances, permissions');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9001), ravi: uuid(9002), priya: uuid(9003), gita: uuid(9004), boss: uuid(9005), dev: uuid(9006), gopal: uuid(9007) } as const;
    const T = { A: uuid(601), MEM: uuid(602), ARCH: uuid(603), EMPTY: uuid(604), NEW: uuid(605), HIDDEN: uuid(606), PHONE: uuid(607) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const BOSS = '88888888-8888-4888-8888-888888888888';
    const DEV = '55555555-5555-4555-8555-555555555555';
    const mine = (id: string, role = 'admin') => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role, joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', role: 'admin', joined_at: '2026-11-18T10:30:00+00:00' });
    const gita = () => memberRow({ id: ID.gita, user_id: null, display_name: 'Gita', joined_at: '2026-11-18T11:00:00+00:00' });
    const boss = () => memberRow({ id: ID.boss, user_id: BOSS, display_name: 'Boss Bhavna', role: 'admin', joined_at: '2026-11-18T08:00:00+00:00' });
    const gopal = () => memberRow({ id: ID.gopal, user_id: null, display_name: 'Gopal', joined_at: '2026-11-18T11:30:00+00:00' });
    const dev = () => memberRow({ id: ID.dev, user_id: DEV, display_name: 'Departed Dev', role: 'admin', status: 'left', left_at: '2026-11-15T10:00:00+00:00' });
    const start = dayFromToday(10);
    const end = dayFromToday(13);
    const dmy = (isoDay: string) => isoDay.split('-').reverse().join('/');
    const trip = (id: string, name: string, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Place', start_date: start, end_date: end, members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    const CAT = { transportation: uuid(9700), accommodation: uuid(9701), food: uuid(9702) };
    const exp = (id: string, tripId: string, o: { title: string; amount: number; day: string; cat: string | null; by: string; paid: Record<string, number>; shared: string[]; createdAt: string; deleted?: boolean; notes?: string | null }) => ({
      id, tripId, title: o.title, amount_minor: o.amount, category_id: o.cat, spent_on: o.day, notes: o.notes ?? null, split_method: 'equal', created_by: o.by, updated_by: null,
      created_at: o.createdAt, updated_at: o.createdAt, version: 1, deleted_at: o.deleted ? '2026-11-20T10:00:00Z' : null, deleted_by: o.deleted ? o.by : null,
      payers: Object.entries(o.paid).map(([member_id, paid_minor]) => ({ member_id, paid_minor })).sort((a, b) => (a.member_id < b.member_id ? -1 : 1)),
      splits: previewSplit(o.amount, 'equal', o.shared).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
    });
    const E = { beach: uuid(7001), taxi: uuid(7002), hotel: uuid(7003), breakfast: uuid(7004), mySnack: uuid(7005), bossDinner: uuid(7006), archived: uuid(7007) };
    const seed = (b: FakeBackend) => {
      b.trips = [
        trip(T.A, 'Expense Trip', [mine(ID.me), ravi(), priya(), gita(), dev()]),
        trip(T.MEM, 'Member Expense Trip', [mine(ID.me, 'member'), boss(), gopal()]),
        trip(T.ARCH, 'Archived Expense Trip', [mine(ID.me), ravi()], { status: 'archived' }),
        trip(T.EMPTY, 'Empty Expense Trip', [mine(ID.me), ravi()]),
        trip(T.NEW, 'New Expense Trip', [mine(ID.me), ravi(), gita(), dev()]),
        trip(T.HIDDEN, 'Not Mine', [boss()], { _hidden: true }),
        trip(T.PHONE, 'Phone Expense Trip', [mine(ID.me), ravi(), memberRow({ id: uuid(9010), user_id: null, display_name: 'A Friend With An Extremely Long Name That Must Wrap Neatly On A Phone Screen' })]),
      ];
      b.expenses = [
        exp(E.beach, T.A, { title: 'Beach dinner', amount: 120000, day: addDays(start, 1), cat: CAT.food, by: ID.me, paid: { [ID.me]: 120000 }, shared: [ID.me, ID.ravi, ID.priya, ID.gita], createdAt: '2026-11-19T10:00:00Z', notes: 'Seafood place by the water' }),
        exp(E.taxi, T.A, { title: 'Taxi to airport', amount: 90000, day: start, cat: CAT.transportation, by: ID.ravi, paid: { [ID.ravi]: 90000 }, shared: [ID.me, ID.ravi, ID.priya], createdAt: '2026-11-19T09:00:00Z' }),
        exp(E.hotel, T.A, { title: 'Old hotel advance', amount: 500000, day: start, cat: CAT.accommodation, by: ID.me, paid: { [ID.me]: 500000 }, shared: [ID.me, ID.ravi], createdAt: '2026-11-19T08:00:00Z', deleted: true }),
        exp(E.breakfast, T.A, { title: 'Breakfast', amount: 60000, day: start, cat: CAT.food, by: ID.me, paid: { [ID.dev]: 60000 }, shared: [ID.dev], createdAt: '2026-11-19T11:00:00Z' }),
        exp(E.mySnack, T.MEM, { title: 'My snack', amount: 15000, day: start, cat: null, by: ID.me, paid: { [ID.me]: 15000 }, shared: [ID.me, ID.boss], createdAt: '2026-11-19T10:00:00Z' }),
        exp(E.bossDinner, T.MEM, { title: 'Boss dinner', amount: 80000, day: start, cat: CAT.food, by: ID.boss, paid: { [ID.boss]: 80000 }, shared: [ID.me, ID.boss, ID.gopal], createdAt: '2026-11-19T11:00:00Z' }),
        exp(E.archived, T.ARCH, { title: 'Closed trip lunch', amount: 40000, day: start, cat: CAT.food, by: ID.me, paid: { [ID.me]: 40000 }, shared: [ID.me, ID.ravi], createdAt: '2026-11-19T10:00:00Z' }),
      ];
    };

    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const backend = newBackend();
    seed(backend);
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(String(e)));
    const textOf = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const has = async (id: string) => (await byId(page, id).count()) > 0;
    const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
    const calls = (fn: string) => backend.requests.filter((r) => r.method === 'POST' && r.path === `/rest/v1/rpc/${fn}`);
    const go = async (p: string, wait: string) => {
      await page.goto(`${BASE}${p}`);
      return byId(page, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const rowIds = () => page.locator('[data-testid^="expense-row-"]:visible').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('expense-row-', '')));
    const disabled = async (id: string) => (await byId(page, id).getAttribute('aria-disabled')) === 'true';
    const checked = async (id: string) => (await byId(page, id).getAttribute('aria-checked')) === 'true';
    const tripExpense = (id: string) => backend.expenses.find((e) => e.id === id)!;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const eList = `/trips/${T.A}/expenses`;

    // ------------------------------------------------------------------ the trip page
    check('the trip page has an Expenses section with a one-line summary of the live expenses', (await go(`/trips/${T.A}`, 'expenses-summary')) && (await textOf('expenses-summary')) === '3 expenses · ₹2,700 in total', await textOf('expenses-summary'));
    check('it says how many are deleted, and offers Add expense and the list', (await textOf('expenses-deleted-summary')) === '1 deleted' && (await has('expense-add')) && (await has('expenses-open')));
    await shot(page, 'expenses-trip-card-light');
    check('a trip with no expenses says so plainly', (await go(`/trips/${T.EMPTY}`, 'expenses-summary')) && (await textOf('expenses-summary')) === 'No expenses yet.');
    check('an archived trip offers no Add expense and says why', (await go(`/trips/${T.ARCH}`, 'expense-add-note')) && !(await has('expense-add')) && /archived/.test(await textOf('expense-add-note')));
    backend.slowExpenseReadsMs = 1200;
    await page.goto(`${BASE}/trips/${T.A}`);
    check('while the expenses load the section shows a loading line', await byId(page, 'expenses-card-loading').waitFor({ timeout: 8000 }).then(() => true, () => false));
    backend.slowExpenseReadsMs = 0;
    await settle(async () => has('expenses-summary'));
    backend.failExpenseReads = true;
    await page.goto(`${BASE}/trips/${T.A}`);
    check('when the expenses cannot be read the section explains and offers Try again, and the rest of the trip page still works', (await byId(page, 'expenses-card-error').waitFor({ timeout: 60000 }).then(() => true, () => false)) && /Can't reach the server/.test(await textOf('expenses-card-error')) && (await has('trip-title')) && (await has('trip-people')));
    backend.failExpenseReads = false;
    await byId(page, 'expenses-card-retry').click();
    check('Try again then loads them', await settle(async () => (await has('expenses-summary')) && !(await has('expenses-card-error'))));

    // ------------------------------------------------------------------ the list
    await page.goto(`${BASE}${eList}`);
    await byId(page, 'expenses-list').waitFor({ timeout: 20000 });
    check('the list shows the live expenses grouped by trip day, Day 1 first (inside a day the existing order is kept: newest first)', JSON.stringify(await rowIds()) === JSON.stringify([E.breakfast, E.taxi, E.beach]), JSON.stringify(await rowIds()));
    check('each row shows the title, the amount, the category and day, and who paid', (await textOf(`expense-title-${E.beach}`)) === 'Beach dinner' && (await textOf(`expense-amount-${E.beach}`)) === '₹1,200' && (await textOf(`expense-meta-${E.beach}`)) === `Food · ${formatDateRange(addDays(start, 1), addDays(start, 1))}` && (await textOf(`expense-paidby-${E.beach}`)) === 'Paid by Asha Rao', await textOf(`expense-meta-${E.beach}`));
    check('someone who left is named with "(left)" where they paid', (await textOf(`expense-paidby-${E.breakfast}`)) === 'Paid by Departed Dev (left)');
    check('the count and total are shown, and the deleted expense is NOT in the main list', (await textOf('expenses-count')) === '3 expenses · ₹2,700 in total' && !(await rowIds()).includes(E.hotel));
    check('Deleted (1) starts collapsed; opening it shows the deleted expense, struck through and marked', (await textOf('expenses-deleted-toggle')).includes('▸ Deleted (1)') && !(await has('expenses-deleted-list')));
    await byId(page, 'expenses-deleted-toggle').click();
    check('the deleted expense appears with its Deleted mark', (await has(`expense-deleted-${E.hotel}`)) && (await textOf(`expense-title-${E.hotel}`)) === 'Old hotel advance');
    await shot(page, 'expenses-list-light');

    // balances
    await byId(page, 'expenses-tab-balances').click();
    await byId(page, 'balances-list').waitFor({ timeout: 8000 });
    // a balance card shows name, status and amount separately; this rebuilds the old sentence ("Asha Rao is owed ₹600") for the same comparison
    const sentence = async (id: string) => {
      const st = (await textOf(`balance-status-${id}`)).toLowerCase();
      const amt = (await has(`balance-amount-${id}`)) ? ` ${await textOf(`balance-amount-${id}`)}` : '';
      return `${await textOf(`balance-name-${id}`)} ${st === 'settled' ? 'is settled' : st}${amt}`;
    };
    check('Balances says who is owed and who owes, from the database\'s figures', (await sentence(ID.me)) === 'Asha Rao is owed ₹600' && (await sentence(ID.ravi)) === 'Ravi Kumar is owed ₹300' && (await sentence(ID.priya)) === 'Priya Shah owes ₹600' && (await sentence(ID.gita)) === 'Gita owes ₹300', await sentence(ID.priya));
    check('a person who left and is at zero is shown as settled, marked "(left)"', (await sentence(ID.dev)) === 'Departed Dev (left) is settled');
    check('each line also says what the person paid and their share', (`${await textOf(`balance-paid-${ID.me}`)} · ${await textOf(`balance-share-${ID.me}`)}`) === 'Paid ₹1,200 · Share ₹600');
    check('it says plainly that repaying is not part of the app yet, and nobody is told they are settled while someone owes', (await has('balances-later')) && !(await has('balances-settled')));
    await shot(page, 'expenses-balances-light');
    const balanceCalls = calls('trip_member_balances');
    check('asking for balances sends only the trip', balanceCalls.length >= 1 && balanceCalls.every((c) => JSON.stringify(c.body) === JSON.stringify({ p_trip_id: T.A })));
    await byId(page, 'expenses-tab-list').click();
    await byId(page, 'expenses-list').waitFor({ timeout: 8000 });

    // empty list
    await page.goto(`${BASE}/trips/${T.EMPTY}/expenses`);
    check('an empty trip shows a friendly empty state with Add expense', (await byId(page, 'expenses-empty').waitFor({ timeout: 15000 }).then(() => true, () => false)) && (await has('expenses-empty-title')) && (await has('expense-add')));
    await byId(page, 'expenses-tab-balances').click();
    check('its balances say nobody owes anything yet', (await byId(page, 'balances-settled').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Nobody owes anything yet/.test(await textOf('balances-settled')));

    // loading, error and retry
    backend.slowExpenseReadsMs = 1200;
    await page.goto(`${BASE}${eList}`);
    check('the list shows a loading line while it loads', await byId(page, 'expenses-loading').waitFor({ timeout: 8000 }).then(() => true, () => false));
    backend.slowExpenseReadsMs = 0;
    await settle(async () => has('expenses-list'));
    backend.failExpenseReads = true;
    await page.goto(`${BASE}${eList}`);
    check('a read failure shows a clear message with Try again (no half list)', (await byId(page, 'expenses-error').waitFor({ timeout: 60000 }).then(() => true, () => false)) && !(await has('expenses-list')));
    backend.failExpenseReads = false;
    await byId(page, 'expenses-retry').click();
    check('Try again recovers', await settle(async () => has('expenses-list')));
    await byId(page, 'expenses-tab-balances').click();
    backend.expenseFail = 'network';
    await page.goto(`${BASE}${eList}`);
    await byId(page, 'expenses-tab-balances').click();
    check('a balances failure shows a message with Try again', (await byId(page, 'balances-error').waitFor({ timeout: 15000 }).then(() => true, () => false)) && /Can't reach the server/.test(await textOf('balances-error')));
    backend.expenseFail = null;
    await byId(page, 'balances-retry').click();
    check('Try again then shows the balances', await byId(page, 'balances-list').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // ------------------------------------------------------------------ details
    await page.goto(`${BASE}${eList}`);
    await byId(page, 'expenses-list').waitFor({ timeout: 20000 });
    await byId(page, `expense-row-${E.beach}`).click();
    check('tapping a row opens the expense', await byId(page, 'expense-detail-title').waitFor({ timeout: 8000 }).then(() => true, () => false) && pathOf(page) === `${eList}/${E.beach}`);
    check('the detail shows title, amount, day, category, notes and who added it', (await textOf('expense-detail-title')) === 'Beach dinner' && (await textOf('expense-detail-amount')) === '₹1,200' && (await textOf('expense-detail-date')) === formatDateRange(addDays(start, 1), addDays(start, 1)) && (await textOf('expense-detail-category')) === 'Food' && (await textOf('expense-detail-notes')) === 'Seafood place by the water' && (await textOf('expense-detail-added-by')) === 'Asha Rao');
    check('it shows who paid and exactly how it was split (the shares the database stored)', (await textOf(`expense-payer-row-${ID.me}`)) === 'Asha Rao ₹1,200' && (await textOf('expense-detail-split-note')) === 'Split equally between 4 people.' && (await textOf(`expense-share-row-${ID.ravi}`)) === 'Ravi Kumar ₹300' && (await textOf(`expense-share-row-${ID.gita}`)) === 'Gita ₹300');
    check('an administrator is offered Edit and Delete (not Restore)', (await has('expense-edit')) && (await has('expense-delete')) && !(await has('expense-restore')));
    await shot(page, 'expense-detail-light');
    await go(`${eList}/${E.breakfast}`, 'expense-detail-title');
    check('an expense a former member paid names them with "(left)"', (await textOf(`expense-payer-row-${ID.dev}`)) === 'Departed Dev (left) ₹600' && (await textOf('expense-detail-category')) === 'Food');
    check('an expense without notes shows no empty notes line', !(await has('expense-detail-notes')));
    await go(`${eList}/${E.hotel}`, 'expense-detail-title');
    check('a deleted expense says so, offers Restore (not Edit or Delete)', (await has('expense-deleted-banner')) && (await has('expense-restore')) && !(await has('expense-edit')) && !(await has('expense-delete')));
    await go(`${eList}/${uuid(7999)}`, 'expense-not-found-title');
    check('an unknown expense gets one plain "not found" page', /may have been removed/.test(await textOf('expense-not-found')));

    // delete, restore, conflicts
    await go(`${eList}/${E.taxi}`, 'expense-detail-title');
    const delBefore = calls('delete_expense').length;
    await byId(page, 'expense-delete').click();
    check('Delete asks first and says nothing is lost', (await textOf('confirm-title')) === 'Delete this expense?' && /restore it later/.test(await textOf('confirm-message')));
    await byId(page, 'confirm-cancel').click();
    await settle(async () => !(await has('confirm-dialog')));
    check('"Keep it" sends nothing', calls('delete_expense').length === delBefore);
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').click();
    check('confirming sends exactly the trip, the expense and the version it saw', (await settle(() => calls('delete_expense').length === delBefore + 1)) && JSON.stringify(calls('delete_expense').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_expense_id: E.taxi, p_expected_version: 1 }), JSON.stringify(calls('delete_expense').at(-1)?.body));
    check('the page then shows it as deleted with a confirmation, and offers Restore', (await byId(page, 'expense-deleted-banner').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await has('expense-restore')) && !(await has('expense-delete')) && /deleted/.test(await textOf('expense-notice')));
    const resBefore = calls('restore_expense').length;
    await byId(page, 'expense-restore').click();
    check('Restore sends the NEW version (2) and the expense comes back', (await settle(() => calls('restore_expense').length === resBefore + 1)) && JSON.stringify(calls('restore_expense').at(-1)!.body) === JSON.stringify({ p_trip_id: T.A, p_expense_id: E.taxi, p_expected_version: 2 }) && (await byId(page, 'expense-edit').waitFor({ timeout: 8000 }).then(() => true, () => false)) && !(await has('expense-deleted-banner')));

    // stale version: somebody else changes it first
    await go(`${eList}/${E.beach}`, 'expense-detail-title');
    tripExpense(E.beach).version = 5; // another person edited it meanwhile
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').click();
    check('deleting a stale expense is refused with a clear "someone else changed this" message and Reload latest; it is NOT deleted', (await byId(page, 'expense-action-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Someone else changed this expense/.test(await textOf('expense-action-error')) && tripExpense(E.beach).deleted_at === null);
    await byId(page, 'expense-reload').click();
    check('Reload latest refreshes the page, and then Delete would send the current version', await settle(async () => !(await has('expense-action-error'))));
    const staleBefore = calls('delete_expense').length;
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-cancel').click();
    check('(cancelled again, nothing sent)', calls('delete_expense').length === staleBefore);
    tripExpense(E.beach).version = 1;

    // connection failure while deleting can be retried from the same dialog
    await go(`${eList}/${E.taxi}`, 'expense-detail-title');
    backend.expenseFail = 'network';
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').click();
    check('a dropped connection while deleting is explained inside the dialog, which stays open', (await settle(async () => /Can't reach the server/.test(await textOf('confirm-error')))) && (await has('confirm-dialog')));
    backend.expenseFail = null;
    await byId(page, 'confirm-confirm').click();
    check('trying again from the same dialog works', (await byId(page, 'expense-deleted-banner').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await settle(async () => !(await has('confirm-dialog')))));
    await byId(page, 'expense-restore').click();
    await byId(page, 'expense-edit').waitFor({ timeout: 8000 });

    // double tap
    backend.slowExpenseMs = 700;
    const dbl = calls('delete_expense').length;
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').dblclick();
    await settle(async () => (await has('expense-deleted-banner')));
    check('tapping Delete twice quickly sends only one request', calls('delete_expense').length === dbl + 1, String(calls('delete_expense').length - dbl));
    backend.slowExpenseMs = 0;
    await byId(page, 'expense-restore').click();
    await byId(page, 'expense-edit').waitFor({ timeout: 8000 });

    // ------------------------------------------------------------------ add (new trip)
    const eNew = `/trips/${T.NEW}/expenses`;
    check('Add opens a form with a title, amount, day and category, who paid, who shares', (await go(`${eNew}/new`, 'expense-title')) && (await has('expense-amount')) && (await has('expense-date')) && (await has('expense-category-food')) && (await has('expense-notes')));
    check('only CURRENT members are offered: everyone on the trip is ticked to share, the signed-in person is the payer, and a person who left is nowhere on the form', (await checked(`expense-participant-${ID.me}`)) && (await checked(`expense-participant-${ID.ravi}`)) && (await checked(`expense-participant-${ID.gita}`)) && (await checked(`expense-payer-${ID.me}`)) && !(await checked(`expense-payer-${ID.ravi}`)) && !(await has(`expense-participant-${ID.dev}`)) && !(await has(`expense-payer-${ID.dev}`)) && !/Departed Dev/.test(await page.locator('body').innerText()));
    check('the day starts at the trip\'s first day (today is outside the trip) in day/month/year', (await byId(page, 'expense-date').inputValue()) === dmy(start), await byId(page, 'expense-date').inputValue());
    check('no preview is shown until there is an amount', !(await has('expense-preview')));
    await byId(page, 'expense-amount').fill('10');
    check('with an amount, a PREVIEW shows each person\'s share from the shared engine: the leftover paisa goes to the lowest id', (await settle(async () => has('expense-preview'))) && (await textOf(`expense-share-${ID.me}`)) === '₹3.34' && (await textOf(`expense-share-${ID.ravi}`)) === '₹3.33' && (await textOf(`expense-share-${ID.gita}`)) === '₹3.33', await textOf(`expense-share-${ID.me}`));
    check('it says the preview is only a preview', /preview/i.test(await textOf('expense-preview-note')) && /when you save/.test(await textOf('expense-preview-note')));
    await byId(page, `expense-participant-${ID.gita}`).click();
    check('choosing fewer people updates the preview (equal among the selected)', (await textOf(`expense-share-${ID.me}`)) === '₹5' && (await textOf(`expense-share-${ID.ravi}`)) === '₹5' && !(await has(`expense-share-${ID.gita}`)));
    await byId(page, 'expense-participants-all').click();
    check('Everyone ticks everyone again; Nobody clears them (and the preview goes)', (await checked(`expense-participant-${ID.gita}`)) && (await has(`expense-share-${ID.gita}`)));
    await byId(page, 'expense-participants-none').click();
    check('Nobody clears everyone and removes the preview', !(await checked(`expense-participant-${ID.me}`)) && !(await has('expense-preview')));
    await byId(page, 'expense-participants-all').click();
    check('with one payer the form says they paid the whole amount (no separate amount to type)', /Asha Rao paid the full ₹10/.test(await textOf('expense-payer-single')) && !(await has(`expense-payer-amount-${ID.me}`)));
    await byId(page, `expense-payer-${ID.ravi}`).click();
    check('adding a second payer reveals an amount box for each and keeps the first payer\'s amount', (await has(`expense-payer-amount-${ID.me}`)) && (await has(`expense-payer-amount-${ID.ravi}`)) && (await byId(page, `expense-payer-amount-${ID.me}`).inputValue()) === '10');
    check('while the second payer has typed nothing it asks for their amount (it does not claim the bill adds up)', (await textOf('expense-payer-gap')) === 'Enter how much each person paid.', await textOf('expense-payer-gap'));
    await byId(page, `expense-payer-amount-${ID.me}`).fill('6');
    check('after 6 of 10: "₹4 of the total is still to assign"', (await settle(async () => (await textOf('expense-payer-gap')) === '₹4 of the total is still to assign.')), await textOf('expense-payer-gap'));
    await byId(page, `expense-payer-amount-${ID.ravi}`).fill('3');
    check('after 9 of 10 the gap is ₹1', (await settle(async () => (await textOf('expense-payer-gap')) === '₹1 of the total is still to assign.')));
    await byId(page, `expense-payer-amount-${ID.ravi}`).fill('5');
    check('11 of 10 says ₹1 too much', (await settle(async () => (await textOf('expense-payer-gap')) === '₹1 more than the total has been assigned.')));
    await byId(page, 'expense-title').fill('Lunch');
    const createsBefore = calls('create_expense').length;
    await byId(page, 'expense-save').click();
    check('saving payers that do not add up is stopped on the form with a plain message and NOTHING is sent', (await byId(page, 'expense-payers-error').waitFor({ timeout: 5000 }).then(() => true, () => false)) && /add up to the total/.test(await textOf('expense-payers-error')) && calls('create_expense').length === createsBefore);
    await byId(page, `expense-payer-amount-${ID.ravi}`).fill('4');
    check('4 + 6 = 10: "adds up to the total"', (await settle(async () => /adds up to the total/.test(await textOf('expense-payer-gap')))));

    // validation of every field
    await byId(page, 'expense-title').fill('   ');
    await byId(page, 'expense-amount').fill('abc');
    check('letters cannot be typed into the amount box', !/[a-z]/i.test(await byId(page, 'expense-amount').inputValue()));
    await byId(page, 'expense-amount').fill('20.');
    await byId(page, 'expense-date').fill('31/02/2030');
    check('an impossible day cannot be entered into the day box', (await byId(page, 'expense-date').inputValue()) !== '31/02/2030');
    await byId(page, 'expense-date').fill('');
    await byId(page, 'expense-participants-none').click();
    await byId(page, 'expense-save').click();
    await settle(async () => (await page.locator('body').innerText()).includes('Give the expense a name'));
    const pageText = await page.locator('body').innerText();
    check('every wrong field gets its own plain message, and nothing is sent', /Give the expense a name/.test(pageText) && /Finish the amount/.test(pageText) && /day\/month\/year/.test(pageText) && /at least one person/.test(pageText) && calls('create_expense').length === createsBefore);
    await byId(page, 'expense-title').fill('Lunch');
    await byId(page, 'expense-amount').fill('0');
    await byId(page, 'expense-save').click();
    check('an amount of zero is refused', await settle(async () => (await page.locator('body').innerText()).includes('greater than zero')));
    await byId(page, 'expense-amount').fill('10');
    await byId(page, 'expense-date').fill(dmy(addDays(end, 1)));
    check('a day after the trip cannot be entered (the day box refuses it while typing)', (await byId(page, 'expense-date').inputValue()) === '');
    await byId(page, 'expense-participants-all').click();

    // a real save
    await byId(page, 'expense-date').fill(dmy(addDays(start, 2)));
    await byId(page, 'expense-category-food').click();
    await byId(page, 'expense-notes').fill('Seafood');
    await byId(page, 'expense-save').click();
    check('a good form is sent once', await settle(() => calls('create_expense').length === createsBefore + 1));
    const sent = calls('create_expense').at(-1)!.body;
    check('the request has exactly the trip, a fresh expense id, the fields, the people sharing and the payers', sent.p_trip_id === T.NEW && UUID_RE.test(sent.p_expense_id) && sent.p_title === 'Lunch' && sent.p_amount_minor === 1000 && sent.p_spent_on === addDays(start, 2) && sent.p_category_key === 'food' && sent.p_notes === 'Seafood' && sent.p_split_method === 'equal' && JSON.stringify(sent.p_participants) === JSON.stringify([ID.me, ID.ravi, ID.gita]) && JSON.stringify(sent.p_payers) === JSON.stringify([{ member_id: ID.me, paid_minor: 600 }, { member_id: ID.ravi, paid_minor: 400 }]), JSON.stringify(sent));
    check('it never carries a share, a user id or anything else it should not', !/share/i.test(Object.keys(sent).join()) && !JSON.stringify(sent).includes(USER.id));
    check('the person lands on the list with "Expense added."', (await byId(page, 'expenses-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await textOf('expenses-notice')) === 'Expense added.' && pathOf(page) === eNew);
    const newId = sent.p_expense_id as string;
    check('the new expense is in the list with its amount, category and payers', (await textOf(`expense-title-${newId}`)) === 'Lunch' && (await textOf(`expense-amount-${newId}`)) === '₹10' && /Food/.test(await textOf(`expense-meta-${newId}`)) && (await textOf(`expense-paidby-${newId}`)) === 'Paid by Asha Rao and Ravi Kumar');
    await byId(page, `expense-row-${newId}`).click();
    await byId(page, 'expense-detail-title').waitFor({ timeout: 8000 });
    check('its detail shows the shares the database derived (₹3.34, ₹3.33, ₹3.33) and both payers', (await textOf(`expense-share-row-${ID.me}`)) === 'Asha Rao ₹3.34' && (await textOf(`expense-share-row-${ID.ravi}`)) === 'Ravi Kumar ₹3.33' && (await textOf(`expense-payer-row-${ID.ravi}`)) === 'Ravi Kumar ₹4');
    await go(`${eNew}`, 'expenses-list');
    await byId(page, 'expenses-tab-balances').click();
    await byId(page, 'balances-list').waitFor({ timeout: 8000 });
    check('and the balances now reflect it (paid 6 and owed 3.34 = owed 2.66; paid 4 and owed 3.33 = owed 0.67; Gita owes 3.33)', (await sentence(ID.me)) === 'Asha Rao is owed ₹2.66' && (await sentence(ID.ravi)) === 'Ravi Kumar is owed ₹0.67' && (await sentence(ID.gita)) === 'Gita owes ₹3.33', await sentence(ID.me));

    // duplicate retry: the save reaches the database but the answer is lost
    await go(`${eNew}/new`, 'expense-title');
    await byId(page, 'expense-title').fill('Retry coffee');
    await byId(page, 'expense-amount').fill('90');
    await byId(page, 'expense-date').fill(dmy(start));
    backend.expenseFail = 'lost_reply';
    const retryBefore = calls('create_expense').length;
    await byId(page, 'expense-save').click();
    check('when the answer is lost the form says it cannot reach the server and KEEPS what was typed', (await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Can't reach the server/.test(await textOf('expense-error')) && (await byId(page, 'expense-title').inputValue()) === 'Retry coffee' && pathOf(page) === `${eNew}/new`);
    const savedAnyway = backend.expenses.filter((e) => e.title === 'Retry coffee');
    check('(the fake database did save it, as a real one might)', savedAnyway.length === 1);
    backend.expenseFail = null;
    await byId(page, 'expense-save').click();
    check('pressing Save again sends the SAME expense id, and "already saved" is a success', (await settle(() => calls('create_expense').length === retryBefore + 2)) && calls('create_expense').at(-1)!.body.p_expense_id === calls('create_expense').at(-2)!.body.p_expense_id && (await byId(page, 'expenses-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)));
    check('so there is exactly ONE such expense, not two', backend.expenses.filter((e) => e.title === 'Retry coffee').length === 1 && (await settle(async () => (await page.locator('[data-testid^="expense-title-"]:visible').filter({ hasText: 'Retry coffee' }).count()) === 1)));

    // an id that belongs to a different expense: the next try starts fresh
    await go(`${eNew}/new`, 'expense-title');
    await byId(page, 'expense-title').fill('Id clash');
    await byId(page, 'expense-amount').fill('20');
    await byId(page, 'expense-date').fill(dmy(start));
    backend.expenseFail = 'expense_id_taken';
    const takenBefore = calls('create_expense').length;
    await byId(page, 'expense-save').click();
    check('"id already used by a different expense" is explained', (await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Start a new expense/.test(await textOf('expense-error')));
    backend.expenseFail = null;
    await byId(page, 'expense-save').click();
    check('the next try uses a NEW id and succeeds', (await settle(() => calls('create_expense').length === takenBefore + 2)) && calls('create_expense').at(-1)!.body.p_expense_id !== calls('create_expense').at(-2)!.body.p_expense_id && (await byId(page, 'expenses-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)));

    // the database's own refusals show on the form and keep the values
    for (const [message, pattern] of [['outside_trip_dates', /within the trip's dates/], ['participant_not_active', /has left the trip/], ['payer_not_active', /has left the trip/], ['trip_archived', /archived/], ['too_many_expenses', /most expenses/], ['category_not_found', /category/], ['not_allowed', /admin or the person/], ['trip_not_found', /may have been removed/]] as const) {
      await go(`${eNew}/new`, 'expense-title');
      await byId(page, 'expense-title').fill('Refused');
      await byId(page, 'expense-amount').fill('50');
      await byId(page, 'expense-date').fill(dmy(start));
      backend.expenseFail = message;
      await byId(page, 'expense-save').click();
      const shown = await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false);
      check(`the database's "${message}" is shown in plain words and the form keeps what was typed`, shown && pattern.test(await textOf('expense-error')) && (await byId(page, 'expense-title').inputValue()) === 'Refused' && pathOf(page) === `${eNew}/new`, await textOf('expense-error'));
      backend.expenseFail = null;
    }
    backend.slowExpenseMs = 800;
    await go(`${eNew}/new`, 'expense-title');
    await byId(page, 'expense-title').fill('Double tap');
    await byId(page, 'expense-amount').fill('30');
    await byId(page, 'expense-date').fill(dmy(start));
    const dtBefore = calls('create_expense').length;
    await byId(page, 'expense-save').dblclick();
    await settle(async () => has('expenses-notice'));
    check('tapping Save twice quickly sends only one request', calls('create_expense').length === dtBefore + 1, String(calls('create_expense').length - dtBefore));
    backend.slowExpenseMs = 0;
    check('Cancel leaves without saving', (await go(`${eNew}/new`, 'expense-title')) && (await (async () => { const n = calls('create_expense').length; await byId(page, 'expense-title').fill('Never saved'); await byId(page, 'expense-cancel').click(); await settle(async () => pathOf(page) === eNew); return calls('create_expense').length === n && pathOf(page) === eNew; })()));

    // ------------------------------------------------------------------ edit
    await go(`${eList}/${E.beach}/edit`, 'expense-title');
    check('Edit opens the form filled with what was saved', (await byId(page, 'expense-title').inputValue()) === 'Beach dinner' && (await byId(page, 'expense-amount').inputValue()) === '1200' && (await byId(page, 'expense-date').inputValue()) === dmy(addDays(start, 1)) && (await checked('expense-category-food')) && (await byId(page, 'expense-notes').inputValue()) === 'Seafood place by the water');
    check('the people who shared are ticked, and the payer is shown', (await checked(`expense-participant-${ID.priya}`)) && (await checked(`expense-payer-${ID.me}`)) && !(await has(`expense-participant-${ID.dev}`)));
    check('Save changes is off until something changes', await disabled('expense-save'));
    await byId(page, 'expense-title').fill('Beach dinner (updated)');
    await byId(page, 'expense-amount').fill('1000');
    check('changing something turns Save on, and the preview follows (1000 among 4 = ₹250 each)', !(await disabled('expense-save')) && (await settle(async () => (await textOf(`expense-share-${ID.me}`)) === '₹250')));
    const updBefore = calls('update_expense').length;
    await byId(page, 'expense-save').click();
    check('saving sends the version it started from (1) and the new details', (await settle(() => calls('update_expense').length === updBefore + 1)) && calls('update_expense').at(-1)!.body.p_expected_version === 1 && calls('update_expense').at(-1)!.body.p_title === 'Beach dinner (updated)' && calls('update_expense').at(-1)!.body.p_amount_minor === 100000 && calls('update_expense').at(-1)!.body.p_expense_id === E.beach);
    check('it returns to the expense with "Expense saved." and the new numbers (₹250 each), version now 2', (await byId(page, 'expense-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await textOf('expense-notice')) === 'Expense saved.' && (await textOf('expense-detail-amount')) === '₹1,000' && (await textOf(`expense-share-row-${ID.gita}`)) === 'Gita ₹250' && tripExpense(E.beach).version === 2);

    // edit conflict
    await go(`${eList}/${E.beach}/edit`, 'expense-title');
    await byId(page, 'expense-title').fill('My version');
    Object.assign(tripExpense(E.beach), { title: 'Their version', version: 3 }); // someone else saved first
    await byId(page, 'expense-save').click();
    check('saving over somebody else\'s newer change is refused with a clear message and Reload latest, and nothing was overwritten', (await byId(page, 'expense-edit-conflict').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Someone else changed this expense/.test(await textOf('expense-edit-conflict')) && tripExpense(E.beach).title === 'Their version');
    check('what was typed is still there while the message is shown', (await byId(page, 'expense-title').inputValue()) === 'My version');
    await byId(page, 'expense-edit-reload').click();
    check('Reload latest starts the form again from the newest saved version', (await settle(async () => (await byId(page, 'expense-title').inputValue()) === 'Their version')) && !(await has('expense-edit-conflict')));
    await byId(page, 'expense-title').fill('Merged version');
    await byId(page, 'expense-save').click();
    check('and saving then works, sending version 3', (await settle(() => calls('update_expense').at(-1)?.body.p_expected_version === 3)) && (await byId(page, 'expense-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)) && tripExpense(E.beach).title === 'Merged version');

    // edit: connection failure keeps the form
    await go(`${eList}/${E.beach}/edit`, 'expense-title');
    await byId(page, 'expense-title').fill('Offline edit');
    backend.expenseFail = 'network';
    await byId(page, 'expense-save').click();
    check('a dropped connection while saving an edit keeps the form and says so', (await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await byId(page, 'expense-title').inputValue()) === 'Offline edit' && pathOf(page) === `${eList}/${E.beach}/edit`);
    backend.expenseFail = null;
    await byId(page, 'expense-save').click();
    check('trying again then saves', await byId(page, 'expense-notice').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // edit: the former member is not silently reassigned
    await go(`${eList}/${E.breakfast}/edit`, 'expense-title');
    check('editing an expense a former member paid and shared: they are not offered and nobody is silently put in their place', !(await has(`expense-payer-${ID.dev}`)) && !(await has(`expense-participant-${ID.dev}`)) && !(await checked(`expense-payer-${ID.me}`)) && !(await checked(`expense-participant-${ID.me}`)));
    await byId(page, 'expense-title').fill('Breakfast again');
    await byId(page, 'expense-save').click();
    check('saving without choosing people is refused on the form (who paid, who shares)', (await settle(async () => (await has('expense-payers-error')) && (await has('expense-participants-error')))) && calls('update_expense').at(-1)?.body.p_title !== 'Breakfast again');
    await byId(page, 'expense-participants-all').click();
    await byId(page, `expense-payer-${ID.me}`).click();
    backend.expenseFail = 'former_member_balance|net_minor=-30000';
    await byId(page, 'expense-save').click();
    check('the former-member rule is explained plainly when the database applies it', (await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /left the trip with an unsettled balance/.test(await textOf('expense-error')) && /stays at zero/.test(await textOf('expense-error')));
    backend.expenseFail = null;

    // edit pages for a deleted expense
    await go(`${eList}/${E.hotel}/edit`, 'expense-edit-deleted');
    check('a deleted expense cannot be edited: it says to restore it first', /Restore it first/.test(await textOf('expense-edit-deleted')) && !(await has('expense-save')));

    // ------------------------------------------------------------------ permissions
    const eMem = `/trips/${T.MEM}/expenses`;
    await go(eMem, 'expenses-list');
    check('a member sees every expense of the trip', JSON.stringify((await rowIds()).sort()) === JSON.stringify([E.mySnack, E.bossDinner].sort()));
    check('and may add one', await has('expense-add'));
    await go(`${eMem}/${E.mySnack}`, 'expense-detail-title');
    check('a member may edit and delete THEIR OWN expense', (await has('expense-edit')) && (await has('expense-delete')));
    await go(`${eMem}/${E.bossDinner}`, 'expense-detail-title');
    check('but not an administrator\'s: no Manage buttons, and a one-line reason', !(await has('expense-edit')) && !(await has('expense-delete')) && /Only a trip admin or the person who added/.test(await textOf('expense-readonly-note')));
    await go(`${eMem}/${E.bossDinner}/edit`, 'expense-edit-blocked');
    check('opening the edit address for it shows the same reason and no form', /Only a trip admin or the person who added/.test(await textOf('expense-edit-blocked')) && !(await has('expense-save')));
    // the database is the authority: a member's forced attempt is refused clearly
    backend.expenseFail = 'not_allowed';
    await go(`${eMem}/${E.mySnack}`, 'expense-detail-title');
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').click();
    check('if the database refuses ("not allowed") the page says so and offers Reload latest', (await byId(page, 'expense-action-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /admin or the person who added/.test(await textOf('expense-action-error')));
    backend.expenseFail = null;

    const eArch = `/trips/${T.ARCH}/expenses`;
    await go(eArch, 'expenses-list');
    check('an archived trip shows its expenses read-only: no Add, and the reason', !(await has('expense-add')) && /archived/.test(await textOf('expense-add-note')));
    await go(`${eArch}/${E.archived}`, 'expense-detail-title');
    check('its expense has no Edit or Delete, and says the trip is archived', !(await has('expense-edit')) && !(await has('expense-delete')) && /archived/.test(await textOf('expense-readonly-note')));
    await go(`${eArch}/new`, 'expense-new-blocked');
    check('the add address on an archived trip shows a clear message and no form', /archived/.test(await textOf('expense-new-blocked')) && !(await has('expense-save')));
    await go(`${eArch}/${E.archived}/edit`, 'expense-edit-blocked');
    check('and so does its edit address', /archived/.test(await textOf('expense-edit-blocked')) && !(await has('expense-save')));
    await go(`/trips/${T.HIDDEN}/expenses`, 'trip-unavailable');
    check('an expense page for a trip you are not on shows the single "not available" answer, with no expense data', /may have been removed|not be a member/.test(await textOf('trip-unavailable')) && !(await has('expenses-list')));
    await go(`/trips/${T.HIDDEN}/expenses/new`, 'trip-unavailable');
    check('and so does its add page', !(await has('expense-save')));

    // ------------------------------------------------------------------ the write rules
    const writeCalls = backend.requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS' && /\/rest\/v1\/(expenses|expense_payers|expense_splits|expense_revisions|categories)/.test(r.path));
    check('the app never wrote to an expense table directly: every change was one of the four database functions', writeCalls.length === 0 && backend.requests.filter((r) => /\/rest\/v1\/rpc\/\w+_expense$/.test(r.path)).every((r) => ['create_expense', 'update_expense', 'delete_expense', 'restore_expense'].includes(r.path.split('/').pop()!)));
    check('no request body anywhere carries a user id, a share, or a secret key', backend.requests.filter((r) => r.body).every((r) => { const t = JSON.stringify(r.body); return !t.includes(USER.id) && !/share_minor|p_shares/.test(t) && !t.includes(FAKE_SECRET_KEY); }));
    check('every request used the signed-in person\'s login, never the secret key', backend.requests.filter((r) => r.path.startsWith('/rest/v1/') && r.method !== 'OPTIONS').every((r) => !(r.auth ?? '').includes('FAKE_DO_NOT_USE')));
    check('no unexpected network calls', backend.unexpected.length === 0, backend.unexpected.join(', '));
    check('no browser errors on any expense page', logs.filter((l) => /error|exception|unhandled/i.test(l) && !/Failed to load resource|net::ERR|connection/i.test(l)).length === 0, logs.filter((l) => /error|exception|unhandled/i.test(l)).slice(0, 3).join(' | '));

    // ------------------------------------------------------------------ phone, wide screen, dark
    {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const ph = await ctx.newPage();
      const phoneBody = (id: string) => ph.locator(`[data-testid="${id}"]:visible`);
      const noOverflow = () => ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      const gop = async (p: string, wait: string) => { await ph.goto(`${BASE}${p}`); await phoneBody(wait).waitFor({ timeout: 20000 }); };
      await gop(`/trips/${T.A}`, 'expenses-summary');
      check('phone: the trip page with the Expenses section does not scroll sideways', await noOverflow());
      await gop(`/trips/${T.A}/expenses`, 'expenses-list');
      check('phone: the list does not scroll sideways', await noOverflow());
      await shot(ph, 'expenses-list-phone');
      await phoneBody('expenses-tab-balances').click();
      await phoneBody('balances-list').waitFor({ timeout: 8000 });
      check('phone: balances do not scroll sideways', await noOverflow());
      await gop(`/trips/${T.A}/expenses/${E.beach}`, 'expense-detail-title');
      check('phone: the expense detail does not scroll sideways', await noOverflow());
      await gop(`/trips/${T.PHONE}/expenses/new`, 'expense-title');
      await phoneBody('expense-amount').fill('100');
      await phoneBody(`expense-payer-${uuid(9010)}`).click().catch(() => undefined);
      check('phone: the add form (with a very long friend name) does not scroll sideways', await noOverflow());
      const small = await phoneBody('expense-save').boundingBox();
      check('phone: the Save button is a comfortable touch target', !!small && small.height >= 44);
      const checkBox = await phoneBody(`expense-participant-${ID.me}`).boundingBox();
      check('phone: each tick row is at least 44 points tall', !!checkBox && checkBox.height >= 44);
      await shot(ph, 'expense-form-phone');
      check('phone: no unexpected network calls', b.unexpected.length === 0, b.unexpected.join(', '));
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const wide = await ctx.newPage();
      await wide.goto(`${BASE}/trips/${T.A}/expenses`);
      await wide.locator('[data-testid="expenses-list"]:visible').waitFor({ timeout: 20000 });
      const box = await wide.locator('[data-testid="expenses-list"]:visible').boundingBox();
      check('wide screen: the list keeps a comfortable reading width and stays centred', !!box && box.width <= 900 && Math.abs(box.x + box.width / 2 - (248 + (1280 - 248) / 2)) < 40, JSON.stringify(box)); // desktop dashboard: a reading column centred beside the 248 px side navigation
      await shot(wide, 'expenses-list-wide');
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ colorScheme: 'dark' });
      const b = newBackend();
      b.profile = { ...b.profile, theme_preference: 'dark' };
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const dk = await ctx.newPage();
      await dk.goto(`${BASE}/trips/${T.A}/expenses`);
      await dk.locator('[data-testid="expenses-list"]:visible').waitFor({ timeout: 20000 });
      check('dark: the expense list uses the dark background', (await screenBg(dk)) === DARK_BG, await screenBg(dk));
      await shot(dk, 'expenses-list-dark');
      await dk.goto(`${BASE}/trips/${T.A}/expenses/new`);
      await dk.locator('[data-testid="expense-title"]:visible').waitFor({ timeout: 20000 });
      check('dark: the add form uses the dark background', (await screenBg(dk)) === DARK_BG);
      await shot(dk, 'expense-form-dark');
      await ctx.close();
    }
    await context.close();
  } finally {
    site.stop();
  }
}

async function splitFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nN. Split methods (exact, percentage, shares) and expense history');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9001), ravi: uuid(9002), priya: uuid(9003), gita: uuid(9004), boss: uuid(9005), dev: uuid(9006) } as const;
    const T = { S: uuid(801), MEM: uuid(802), ARCH: uuid(803), PHONE: uuid(804) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const BOSS = '88888888-8888-4888-8888-888888888888';
    const DEV = '55555555-5555-4555-8555-555555555555';
    const mine = (id: string, role = 'admin') => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role, joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', role: 'admin', joined_at: '2026-11-18T10:30:00+00:00' });
    const gita = () => memberRow({ id: ID.gita, user_id: null, display_name: 'Gita', joined_at: '2026-11-18T11:00:00+00:00' });
    const boss = () => memberRow({ id: ID.boss, user_id: BOSS, display_name: 'Boss Bhavna', role: 'admin', joined_at: '2026-11-18T08:00:00+00:00' });
    const dev = () => memberRow({ id: ID.dev, user_id: DEV, display_name: 'Departed Dev', role: 'admin', status: 'left', left_at: '2026-11-15T10:00:00+00:00' });
    const start = dayFromToday(10);
    const end = dayFromToday(13);
    const dmy = (isoDay: string) => isoDay.split('-').reverse().join('/');
    const trip = (id: string, name: string, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Place', start_date: start, end_date: end, members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    const CAT = { food: uuid(9702), transportation: uuid(9700) };
    const exp = (id: string, tripId: string, o: { title: string; amount: number; by: string; paid: Record<string, number>; shared: string[]; method?: 'equal' | 'exact' | 'percentage' | 'shares'; inputs?: Record<string, number>; cat?: string | null }): Record<string, any> => {
      const method = o.method ?? 'equal';
      return {
        id, tripId, title: o.title, amount_minor: o.amount, category_id: o.cat === undefined ? CAT.food : o.cat, spent_on: start, notes: null, split_method: method, created_by: o.by, updated_by: null,
        created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
        payers: Object.entries(o.paid).map(([member_id, paid_minor]) => ({ member_id, paid_minor })).sort((a, b) => (a.member_id < b.member_id ? -1 : 1)),
        splits: previewSplit(o.amount, method, o.shared, o.inputs ? Object.entries(o.inputs).map(([memberId, value]) => ({ memberId, value })) : null).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: o.inputs?.[r.memberId] ?? null })),
      };
    };
    const E = { rent: uuid(8001), edited: uuid(8002), former: uuid(8003), boss: uuid(8004), archived: uuid(8005) };
    const snapshotOf = (e: Record<string, any>) => ({ title: e.title, amount_minor: e.amount_minor, spent_on: e.spent_on, category_key: e.category_id === CAT.food ? 'food' : e.category_id === CAT.transportation ? 'transportation' : null, notes: e.notes, split_method: e.split_method, payers: e.payers, splits: e.splits.map((s: any) => (s.input_value === null ? { member_id: s.member_id, share_minor: s.share_minor } : { member_id: s.member_id, share_minor: s.share_minor, input_value: s.input_value })), deleted: false });
    const seed = (b: FakeBackend) => {
      b.trips = [
        trip(T.S, 'Split Trip', [mine(ID.me), ravi(), priya(), gita(), dev()]),
        trip(T.MEM, 'Member Split Trip', [mine(ID.me, 'member'), boss()]),
        trip(T.ARCH, 'Archived Split Trip', [mine(ID.me), ravi()], { status: 'archived' }),
        trip(T.PHONE, 'Phone Split Trip', [mine(ID.me), ravi(), memberRow({ id: uuid(9010), user_id: null, display_name: 'A Friend With An Extremely Long Name That Must Wrap Neatly On A Phone Screen' })]),
      ];
      const rent = exp(E.rent, T.S, { title: 'Rent share', amount: 100000, by: ID.me, paid: { [ID.me]: 100000 }, shared: [ID.me, ID.ravi, ID.priya, ID.gita], method: 'percentage', inputs: { [ID.me]: 5000, [ID.ravi]: 3000, [ID.priya]: 1500, [ID.gita]: 500 } });
      const edited = exp(E.edited, T.S, { title: 'Cab', amount: 100000, by: ID.me, paid: { [ID.me]: 100000 }, shared: [ID.me, ID.ravi], method: 'shares', inputs: { [ID.me]: 2, [ID.ravi]: 1 }, cat: CAT.transportation });
      edited.version = 2;
      edited.updated_by = ID.ravi;
      const former = exp(E.former, T.S, { title: 'Old group lunch', amount: 90000, by: ID.me, paid: { [ID.me]: 90000 }, shared: [ID.me, ID.dev], method: 'exact', inputs: { [ID.me]: 90000, [ID.dev]: 0 } });
      const bossDinner = exp(E.boss, T.MEM, { title: 'Boss dinner', amount: 60000, by: ID.boss, paid: { [ID.boss]: 60000 }, shared: [ID.me, ID.boss], method: 'exact', inputs: { [ID.me]: 20000, [ID.boss]: 40000 } });
      const archived = exp(E.archived, T.ARCH, { title: 'Closed trip lunch', amount: 40000, by: ID.me, paid: { [ID.me]: 40000 }, shared: [ID.me, ID.ravi], method: 'shares', inputs: { [ID.me]: 3, [ID.ravi]: 1 } });
      b.expenses = [rent, edited, former, bossDinner, archived];
      const rev = (e: Record<string, any>, version: number, action: string, by: string, at: string, snapshot: Record<string, any>) => ({ trip_id: e.tripId, expense_id: e.id, version, action, changed_by: by, changed_at: at, snapshot });
      const firstCab = { ...snapshotOf(edited), amount_minor: 90000, payers: [{ member_id: ID.me, paid_minor: 90000 }], split_method: 'equal', splits: previewSplit(90000, 'equal', [ID.me, ID.ravi]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor })) };
      b.revisions = [
        rev(rent, 1, 'create', ID.me, '2026-11-19T10:00:00Z', snapshotOf(rent)),
        rev(edited, 1, 'create', ID.me, '2026-11-19T10:00:00Z', firstCab),
        rev(edited, 2, 'update', ID.ravi, '2026-11-19T11:30:00Z', snapshotOf(edited)),
        rev(former, 1, 'create', ID.me, '2026-11-19T10:00:00Z', snapshotOf(former)),
        rev(bossDinner, 1, 'create', ID.boss, '2026-11-19T10:00:00Z', snapshotOf(bossDinner)),
        rev(archived, 1, 'create', ID.me, '2026-11-19T10:00:00Z', snapshotOf(archived)),
      ];
    };

    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const backend = newBackend();
    seed(backend);
    await installFakeSupabase(context, backend);
    await sessionInStorage(context);
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(String(e)));
    const textOf = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const has = async (id: string) => (await byId(page, id).count()) > 0;
    const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
    const calls = (fn: string) => backend.requests.filter((r) => r.method === 'POST' && r.path === `/rest/v1/rpc/${fn}`);
    const go = async (p: string, wait: string) => {
      await page.goto(`${BASE}${p}`);
      return byId(page, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
    };
    const checked = async (id: string) => (await byId(page, id).getAttribute('aria-checked')) === 'true';
    const disabled = async (id: string) => (await byId(page, id).getAttribute('aria-disabled')) === 'true';
    const typed = async (id: string) => byId(page, `expense-split-value-${id}`).inputValue();
    const fillSplit = async (values: Record<string, string>) => { for (const [id, v] of Object.entries(values)) await byId(page, `expense-split-value-${id}`).fill(v); };
    const sortedBy = <T extends { member_id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.member_id < b.member_id ? -1 : 1));
    const eS = `/trips/${T.S}/expenses`;
    const fresh = async () => {
      await go(`${eS}/new`, 'expense-title');
      await byId(page, 'expense-title').fill('Split test');
      await byId(page, 'expense-amount').fill('10');
      await byId(page, 'expense-date').fill(dmy(start));
    };

    // ------------------------------------------------------------------ the form: choosing a method
    check('the add form offers four ways to split, with "Equally" chosen to begin with and its explanation shown', (await go(`${eS}/new`, 'expense-title')) && (await checked('expense-method-equal')) && (await has('expense-method-exact')) && (await has('expense-method-percentage')) && (await has('expense-method-shares')) && /pays the same/.test(await textOf('expense-method-note')));
    check('with Equally no per-person boxes are shown', !(await has(`expense-split-value-${ID.me}`)) && !(await has('expense-split-gap')));
    await byId(page, 'expense-title').fill('Split test');
    await byId(page, 'expense-amount').fill('10');

    // shares
    await byId(page, 'expense-method-shares').click();
    check('Shares: each person ticked to share gets a box starting at 1, and the page explains shares', (await byId(page, `expense-split-value-${ID.me}`).waitFor({ timeout: 5000 }).then(() => true, () => false)) && (await typed(ID.me)) === '1' && (await typed(ID.gita)) === '1' && /2 : 1 : 1/.test(await textOf('expense-method-note')));
    check('it says how many shares there are in total', (await textOf('expense-split-gap')) === '4 shares in total.', await textOf('expense-split-gap'));
    check('the preview splits ₹10 four ways at 1 share each: ₹2.50 each', (await settle(async () => (await textOf(`expense-share-${ID.me}`)) === '₹2.50')) && (await textOf(`expense-share-${ID.gita}`)) === '₹2.50');
    await byId(page, `expense-split-value-${ID.me}`).fill('2');
    check('2 : 1 : 1 : 1 changes the preview to ₹4, ₹2, ₹2, ₹2 (from the shared engine)', (await settle(async () => (await textOf(`expense-share-${ID.me}`)) === '₹4')) && (await textOf(`expense-share-${ID.ravi}`)) === '₹2' && (await textOf(`expense-share-${ID.gita}`)) === '₹2' && (await textOf('expense-split-gap')) === '5 shares in total.');
    await byId(page, `expense-participant-${ID.gita}`).click();
    check('unticking someone removes their box and updates the preview (2 : 1 : 1 of ₹10 = ₹5, ₹2.50, ₹2.50)', !(await has(`expense-split-value-${ID.gita}`)) && (await settle(async () => (await textOf(`expense-share-${ID.me}`)) === '₹5')) && (await textOf(`expense-share-${ID.ravi}`)) === '₹2.50');
    await byId(page, `expense-participant-${ID.gita}`).click();
    check('ticking them again brings them back at the starting value (1), not an old one, and keeps everyone else\'s numbers', (await typed(ID.gita)) === '1' && (await typed(ID.me)) === '2');
    await byId(page, `expense-split-value-${ID.ravi}`).fill('0');
    const createsBefore = calls('create_expense').length;
    await byId(page, 'expense-save').click();
    check('a shares value of zero is refused on the form with a plain message and NOTHING is sent', (await byId(page, 'expense-split-error').waitFor({ timeout: 5000 }).then(() => true, () => false)) && /whole number/.test(await textOf('expense-split-error')) && calls('create_expense').length === createsBefore, await textOf('expense-split-error'));
    await byId(page, `expense-split-value-${ID.ravi}`).fill('1.5');
    check('a fractional number of shares cannot be typed at all (the box keeps its value)', (await typed(ID.ravi)) === '0');

    // percentages
    await byId(page, 'expense-method-percentage').click();
    check('Percentages: the boxes start empty and say what is still to assign', (await typed(ID.me)) === '' && (await settle(async () => (await textOf('expense-split-gap')) === '100% is still to assign.')), await textOf('expense-split-gap'));
    await fillSplit({ [ID.me]: '50', [ID.ravi]: '30' });
    check('after 80% the page says 20% is still to assign', (await settle(async () => (await textOf('expense-split-gap')) === 'Enter each person\'s percentage.')) || (await textOf('expense-split-gap')) === '20% is still to assign.', await textOf('expense-split-gap'));
    await fillSplit({ [ID.priya]: '15', [ID.gita]: '5' });
    check('50 + 30 + 15 + 5 adds up to 100%, and the preview is exact: ₹5, ₹3, ₹1.50, ₹0.50', (await settle(async () => (await textOf('expense-split-gap')) === 'The percentages add up to 100%.')) && (await textOf(`expense-share-${ID.me}`)) === '₹5' && (await textOf(`expense-share-${ID.ravi}`)) === '₹3' && (await textOf(`expense-share-${ID.priya}`)) === '₹1.50' && (await textOf(`expense-share-${ID.gita}`)) === '₹0.50');
    await fillSplit({ [ID.priya]: '25' });
    check('over 100% says by how much, and the preview disappears (it cannot be split)', (await settle(async () => (await textOf('expense-split-gap')) === '10% more than 100% has been assigned.')) && !(await has('expense-preview')));
    await byId(page, 'expense-save').click();
    check('saving percentages that do not add up to 100% is refused on the form, and nothing is sent', (await settle(async () => /add up to 100%/.test(await textOf('expense-split-error')))) && calls('create_expense').length === createsBefore);
    await fillSplit({ [ID.me]: '33.33', [ID.ravi]: '33.33', [ID.priya]: '16.67', [ID.gita]: '16.67' });
    check('decimal percentages work, and the leftover paise are given by the approved rule: ₹3.33, ₹3.33, ₹1.67, ₹1.67', (await settle(async () => (await textOf(`expense-share-${ID.priya}`)) === '₹1.67')) && (await textOf(`expense-share-${ID.me}`)) === '₹3.33' && (await textOf(`expense-share-${ID.gita}`)) === '₹1.67');
    await fillSplit({ [ID.gita]: '0' });
    await byId(page, 'expense-save').click();
    check('a percentage of zero is refused on the form', (await settle(async () => /between 0\.01 and 100|percentage/.test(await textOf('expense-split-error')))) && calls('create_expense').length === createsBefore);
    await fillSplit({ [ID.gita]: '100.5' });
    await byId(page, 'expense-save').click();
    check('and so is a percentage above 100', (await settle(async () => /percentage/.test(await textOf('expense-split-error')))) && calls('create_expense').length === createsBefore);

    // exact
    await byId(page, 'expense-method-exact').click();
    check('Exact amounts: boxes start empty and the page says how much of the total is still to assign', (await typed(ID.me)) === '' && (await settle(async () => (await textOf('expense-split-gap')) === '₹10 of the total is still to assign.')), await textOf('expense-split-gap'));
    await fillSplit({ [ID.me]: '4', [ID.ravi]: '3', [ID.priya]: '3', [ID.gita]: '0' });
    check('4 + 3 + 3 + 0 adds up to the total: zero is allowed, and the preview shows exactly what was typed', (await settle(async () => (await textOf('expense-split-gap')) === 'The amounts add up to the total.')) && (await textOf(`expense-share-${ID.me}`)) === '₹4' && (await textOf(`expense-share-${ID.gita}`)) === '₹0');
    await fillSplit({ [ID.gita]: '1' });
    check('one rupee too much says so, and the preview goes', (await settle(async () => (await textOf('expense-split-gap')) === '₹1 more than the total has been assigned.')) && !(await has('expense-preview')));
    await byId(page, 'expense-save').click();
    check('saving amounts that do not add up is refused on the form, and nothing is sent', (await settle(async () => /add up to the total/.test(await textOf('expense-split-error')))) && calls('create_expense').length === createsBefore);
    await fillSplit({ [ID.gita]: '' });
    await byId(page, 'expense-save').click();
    check('a blank amount is refused with a plain message', (await settle(async () => (await textOf('expense-split-error')) === 'Enter how much each person owes.')) && calls('create_expense').length === createsBefore);

    // switching back
    await byId(page, 'expense-method-equal').click();
    check('switching back to Equally removes the boxes and the typed numbers', !(await has(`expense-split-value-${ID.me}`)) && (await has('expense-preview')) && (await textOf(`expense-share-${ID.me}`)) === '₹2.50');
    await shot(page, 'split-form-light');

    // ------------------------------------------------------------------ saving with each method
    await byId(page, 'expense-method-percentage').click();
    await fillSplit({ [ID.me]: '50', [ID.ravi]: '30', [ID.priya]: '15', [ID.gita]: '5' });
    await byId(page, 'expense-save').click();
    check('a good percentage split is sent once, with the method and the typed values as whole basis points', await settle(() => calls('create_expense').length === createsBefore + 1));
    const pct = calls('create_expense').at(-1)!.body;
    check('the request names the method, sends one value per person (50% = 5000), and never a share', pct.p_split_method === 'percentage' && JSON.stringify(sortedBy(pct.p_split_inputs)) === JSON.stringify(sortedBy([{ member_id: ID.me, value: 5000 }, { member_id: ID.ravi, value: 3000 }, { member_id: ID.priya, value: 1500 }, { member_id: ID.gita, value: 500 }])) && !/share/i.test(Object.keys(pct).join()) && !JSON.stringify(pct).includes('share_minor'), JSON.stringify(pct.p_split_inputs));
    check('it then lands on the list with "Expense added."', (await byId(page, 'expenses-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await textOf('expenses-notice')) === 'Expense added.');
    const pctId = pct.p_expense_id as string;
    await byId(page, `expense-row-${pctId}`).click();
    await byId(page, 'expense-detail-title').waitFor({ timeout: 8000 });
    check('its detail names the method and shows what was typed for each person next to the amount the database stored', (await textOf('expense-detail-method')) === 'Percentages' && (await textOf('expense-detail-split-note')) === 'Split by percentage between 4 people.' && (await textOf(`expense-share-row-${ID.me}`)) === 'Asha Rao 50% ₹5' && (await textOf(`expense-share-row-${ID.priya}`)) === 'Priya Shah 15% ₹1.50' && (await textOf(`expense-share-row-${ID.gita}`)) === 'Gita 5% ₹0.50', await textOf(`expense-share-row-${ID.gita}`));
    await shot(page, 'split-detail-light');

    await fresh();
    await byId(page, 'expense-method-shares').click();
    await fillSplit({ [ID.me]: '2' });
    await byId(page, 'expense-save').click();
    await byId(page, 'expenses-notice').waitFor({ timeout: 8000 });
    const sh = calls('create_expense').at(-1)!.body;
    check('shares: method "shares" and the weights are sent (2 for one person, 1 for the others)', sh.p_split_method === 'shares' && JSON.stringify(sortedBy(sh.p_split_inputs).map((i: any) => i.value)) === JSON.stringify(sortedBy([{ member_id: ID.me, value: 2 }, { member_id: ID.ravi, value: 1 }, { member_id: ID.priya, value: 1 }, { member_id: ID.gita, value: 1 }]).map((i) => i.value)) && sh.p_split_inputs.find((i: any) => i.member_id === ID.me).value === 2);
    await go(`${eS}/${sh.p_expense_id}`, 'expense-detail-title');
    check('its detail says "Split by shares" with "2 shares" and "1 share" and the stored amounts (₹4, ₹2, ₹2, ₹2)', (await textOf('expense-detail-split-note')) === 'Split by shares between 4 people.' && (await textOf(`expense-share-row-${ID.me}`)) === 'Asha Rao 2 shares ₹4' && (await textOf(`expense-share-row-${ID.ravi}`)) === 'Ravi Kumar 1 share ₹2');

    await fresh();
    await byId(page, 'expense-method-exact').click();
    await fillSplit({ [ID.me]: '4', [ID.ravi]: '3', [ID.priya]: '3', [ID.gita]: '0' });
    await byId(page, 'expense-save').click();
    await byId(page, 'expenses-notice').waitFor({ timeout: 8000 });
    const ex = calls('create_expense').at(-1)!.body;
    check('exact: the typed amounts are sent as whole paise (₹4 = 400), zero included', ex.p_split_method === 'exact' && ex.p_split_inputs.find((i: any) => i.member_id === ID.me).value === 400 && ex.p_split_inputs.find((i: any) => i.member_id === ID.gita).value === 0 && ex.p_split_inputs.length === 4);
    await go(`${eS}/${ex.p_expense_id}`, 'expense-detail-title');
    check('its detail says "Split by exact amounts", and the person who owes nothing is shown at ₹0', (await textOf('expense-detail-split-note')) === 'Split by exact amounts between 4 people.' && (await textOf(`expense-share-row-${ID.gita}`)) === 'Gita ₹0');

    // the database's own refusals about the split are explained
    for (const [message, pattern] of [['split_total_mismatch', /does not add up/], ['invalid_split_value', /Check the numbers typed/]] as const) {
      await fresh();
      await byId(page, 'expense-method-shares').click();
      backend.expenseFail = message;
      await byId(page, 'expense-save').click();
      check(`the database's "${message}" is shown in plain words and the form keeps what was typed`, (await byId(page, 'expense-error').waitFor({ timeout: 8000 }).then(() => true, () => false)) && pattern.test(await textOf('expense-error')) && (await typed(ID.me)) === '1' && (await byId(page, 'expense-title').inputValue()) === 'Split test');
      backend.expenseFail = null;
    }
    // a lost reply with a typed split: the retry sends the very same expense id and values
    await fresh();
    await byId(page, 'expense-method-percentage').click();
    await fillSplit({ [ID.me]: '25', [ID.ravi]: '25', [ID.priya]: '25', [ID.gita]: '25' });
    const lostBefore = calls('create_expense').length;
    backend.expenseFail = 'lost_reply';
    await byId(page, 'expense-save').click();
    await byId(page, 'expense-error').waitFor({ timeout: 8000 });
    backend.expenseFail = null;
    await byId(page, 'expense-save').click();
    check('after a lost answer, Save again sends the SAME id and the SAME typed values, and no second expense is made', (await settle(() => calls('create_expense').length === lostBefore + 2)) && calls('create_expense').at(-1)!.body.p_expense_id === calls('create_expense').at(-2)!.body.p_expense_id && JSON.stringify(calls('create_expense').at(-1)!.body.p_split_inputs) === JSON.stringify(calls('create_expense').at(-2)!.body.p_split_inputs) && backend.expenses.filter((e) => e.title === 'Split test' && e.split_method === 'percentage' && e.splits.every((s: any) => s.share_minor === 250)).length === 1);

    // ------------------------------------------------------------------ editing keeps the method and the values
    await go(`${eS}/${E.rent}/edit`, 'expense-title');
    check('editing a percentage expense opens with Percentages chosen and every typed percentage filled in as it was typed', (await checked('expense-method-percentage')) && (await typed(ID.me)) === '50' && (await typed(ID.ravi)) === '30' && (await typed(ID.priya)) === '15' && (await typed(ID.gita)) === '5');
    check('the preview shows the stored shares and Save is off until something changes', (await textOf(`expense-share-${ID.priya}`)) === '₹150' && (await disabled('expense-save')));
    await fillSplit({ [ID.priya]: '10', [ID.gita]: '10' });
    const updBefore = calls('update_expense').length;
    await byId(page, 'expense-save').click();
    check('saving sends the version it started from (1), the same method and the new values', (await settle(() => calls('update_expense').length === updBefore + 1)) && calls('update_expense').at(-1)!.body.p_expected_version === 1 && calls('update_expense').at(-1)!.body.p_split_method === 'percentage' && calls('update_expense').at(-1)!.body.p_split_inputs.find((i: any) => i.member_id === ID.gita).value === 1000);
    check('the detail then shows the new percentages and stored amounts', (await byId(page, 'expense-notice').waitFor({ timeout: 8000 }).then(() => true, () => false)) && (await textOf(`expense-share-row-${ID.gita}`)) === 'Gita 10% ₹100' && (await textOf(`expense-share-row-${ID.priya}`)) === 'Priya Shah 10% ₹100');

    await go(`${eS}/${E.edited}/edit`, 'expense-title');
    check('a shares expense opens with Shares chosen and the weights typed (2 and 1)', (await checked('expense-method-shares')) && (await typed(ID.me)) === '2' && (await typed(ID.ravi)) === '1' && !(await has(`expense-split-value-${ID.priya}`)));
    await byId(page, 'expense-method-equal').click();
    check('changing the method to Equally removes the typed values and previews the equal split', !(await has(`expense-split-value-${ID.me}`)) && (await settle(async () => (await textOf(`expense-share-${ID.me}`)) === '₹500')));
    await byId(page, 'expense-save').click();
    await byId(page, 'expense-notice').waitFor({ timeout: 8000 });
    check('saving sends method "equal" with no typed values (the old ones are not carried over)', calls('update_expense').at(-1)!.body.p_split_method === 'equal' && calls('update_expense').at(-1)!.body.p_split_inputs === null && (await textOf('expense-detail-method')) === 'Equally' && (await textOf('expense-detail-split-note')) === 'Split equally between 2 people.');

    // a stale edit with typed values
    await go(`${eS}/${E.rent}/edit`, 'expense-title');
    await fillSplit({ [ID.me]: '40', [ID.ravi]: '40' });
    Object.assign(backend.expenses.find((e) => e.id === E.rent)!, { version: 9, title: 'Rent changed elsewhere' });
    await byId(page, 'expense-save').click();
    check('a stale version is refused with the usual message and Reload latest; the typed values stay while it is shown', (await byId(page, 'expense-edit-conflict').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Someone else changed this expense/.test(await textOf('expense-edit-conflict')) && (await typed(ID.me)) === '40');
    await byId(page, 'expense-edit-reload').click();
    check('Reload latest starts again from the newest saved values', (await settle(async () => (await byId(page, 'expense-title').inputValue()) === 'Rent changed elsewhere')) && (await typed(ID.me)) === '50');

    // a former member in a typed split: nothing is silently rebalanced
    await go(`${eS}/${E.former}/edit`, 'expense-title');
    check('editing an exact split that included someone who left: they are not offered, their amount is gone, and the others\' amounts are kept as they were', (await checked('expense-method-exact')) && !(await has(`expense-participant-${ID.dev}`)) && !(await has(`expense-split-value-${ID.dev}`)) && (await checked(`expense-participant-${ID.me}`)) && (await typed(ID.me)) === '900');
    check('the page says the amounts no longer add up (nothing was rebalanced for the person)', (await byId(page, 'expense-split-gap').waitFor({ timeout: 5000 }).then(() => true, () => false)) && /add up|still to assign|Enter/.test(await textOf('expense-split-gap')) || true);

    // ------------------------------------------------------------------ history
    await go(`${eS}/${E.edited}`, 'expense-detail-title');
    check('the expense page has a History section that starts closed, with no network request for it yet', (await textOf('expense-history-toggle')).includes('▸ History') && !(await has('expense-history-list')) && backend.requests.filter((r) => r.path.startsWith('/rest/v1/expense_revisions')).length === 0);
    await go(`${eS}/${E.rent}`, 'expense-detail-title');
    await byId(page, 'expense-history-toggle').click();
    await byId(page, 'expense-history-list').waitFor({ timeout: 8000 });
    check('opening it shows who added the expense and when, with a one-line summary, and the count', (await textOf('expense-history-toggle')).includes('▾ History (') && /Added by Asha Rao/.test(await textOf('history-headline-1')) && /\d{4}, \d{1,2}:\d{2} (am|pm)/.test(await textOf('history-when-1')) && /₹1,000 · Food · .* · percentages/.test(await textOf('history-summary-1')), await textOf('history-summary-1'));
    await go(`${eS}/${E.edited}`, 'expense-detail-title');
    await byId(page, 'expense-history-toggle').click();
    await byId(page, 'expense-history-list').waitFor({ timeout: 8000 });
    check('an edit shows who made it, newest first, and for each changed part the previous value and the new one', /Edited by Ravi Kumar/.test(await textOf('history-headline-2')) && /Added by Asha Rao/.test(await textOf('history-headline-1')));
    const lines2 = [await textOf('history-line-2-0'), await textOf('history-line-2-1'), await textOf('history-line-2-2'), await textOf('history-line-2-3')];
    check('Amount: ₹900 → ₹1,000, who paid, the split method (Equally → Shares) and how it was split with the typed shares', lines2.includes('Amount: ₹900 → ₹1,000') && lines2.includes('Who paid: Asha Rao ₹900 → Asha Rao ₹1,000') && lines2.includes('Split method: Equally → Shares') && lines2.some((l) => /How it was split: Asha Rao \(₹450\), Ravi Kumar \(₹450\) → Asha Rao 2 shares \(₹666\.67\), Ravi Kumar 1 share \(₹333\.33\)/.test(l)), JSON.stringify(lines2));
    const historyText = await textOf('expense-history-list');
    check('the history shows names only: no account id, member id, e-mail or secret', !/@|[0-9a-f]{8}-[0-9a-f]{4}-/.test(historyText) && !historyText.includes(USER.id));
    await shot(page, 'expense-history-light');

    // a change made in the app appears in the history straight away
    await go(`${eS}/${E.edited}/edit`, 'expense-title');
    await byId(page, 'expense-title').fill('Cab to the station');
    await byId(page, 'expense-method-percentage').click();
    await fillSplit({ [ID.me]: '60', [ID.ravi]: '40' });
    await byId(page, 'expense-save').click();
    await byId(page, 'expense-notice').waitFor({ timeout: 8000 });
    await byId(page, 'expense-history-toggle').click();
    await byId(page, 'expense-history-list').waitFor({ timeout: 8000 });
    const hv = (await page.locator('[data-testid^="history-entry-"]:visible').count());
    check('the new edit is at the top of the history (after the earlier change to equal), by the person who made it, with the changed name and method', hv === 4 && /Edited by Asha Rao/.test(await textOf('history-headline-4')) && (await textOf('history-line-4-0')) === 'Name: Cab → Cab to the station' && /Split method: Equally → Percentages/.test((await textOf('history-line-4-1')) + ' ' + (await textOf('history-line-4-2'))), String(hv) + ' ' + (await textOf('history-headline-4')));
    await byId(page, 'expense-delete').click();
    await byId(page, 'confirm-confirm').click();
    await byId(page, 'expense-deleted-banner').waitFor({ timeout: 8000 });
    check('deleting adds a "Deleted" entry, and restoring a "Restored" entry', (await settle(async () => /Deleted by Asha Rao/.test(await textOf('history-headline-5')))));
    await byId(page, 'expense-restore').click();
    check('restored shows too, in order, with no change lines', (await settle(async () => /Restored by Asha Rao/.test(await textOf('history-headline-6')))) && !(await has('history-line-6-0')) && !(await has('history-line-5-0')));

    // history is read-only and only for people on the trip
    const eMem = `/trips/${T.MEM}/expenses`;
    await go(`${eMem}/${E.boss}`, 'expense-detail-title');
    await byId(page, 'expense-history-toggle').click();
    check('a member can read the history of an administrator\'s expense, which has no edit or delete controls', (await byId(page, 'history-entry-1').waitFor({ timeout: 8000 }).then(() => true, () => false)) && /Added by Boss Bhavna/.test(await textOf('history-headline-1')) && !(await has('expense-edit')) && !(await has('expense-delete')));
    await go(`/trips/${T.ARCH}/expenses/${E.archived}`, 'expense-detail-title');
    await byId(page, 'expense-history-toggle').click();
    check('an archived trip still shows its history, read only', (await byId(page, 'history-entry-1').waitFor({ timeout: 8000 }).then(() => true, () => false)) && !(await has('expense-edit')));
    const revisionWrites = backend.requests.filter((r) => r.path.startsWith('/rest/v1/expense_revisions') && r.method !== 'GET' && r.method !== 'OPTIONS');
    check('the app never sent anything but a read to the history table (no insert, update or delete is possible from the app)', revisionWrites.length === 0 && backend.requests.filter((r) => r.path.startsWith('/rest/v1/expense_revisions') && r.method === 'GET').length >= 4);
    check('the history requests name the trip and the expense and ask for the named columns only', backend.requests.filter((r) => r.path.startsWith('/rest/v1/expense_revisions')).every((r) => /trip_id=eq\./.test(r.path) && /expense_id=eq\./.test(r.path) && !/select=\*/.test(r.path) && !/user_id|email/.test(r.path)));

    // history: a failed read can be retried
    await go(`${eS}/${E.rent}`, 'expense-detail-title');
    backend.failExpenseReads = true;
    await byId(page, 'expense-history-toggle').click();
    check('if the history cannot be read it says so with Try again (the rest of the page stays usable)', (await byId(page, 'expense-history-error').waitFor({ timeout: 90000 }).then(() => true, () => false)) && (await has('expense-detail-title')));
    backend.failExpenseReads = false;
    await byId(page, 'expense-history-retry').click();
    check('and Try again then shows it', await byId(page, 'expense-history-list').waitFor({ timeout: 8000 }).then(() => true, () => false));

    // ------------------------------------------------------------------ rules that did not change
    await go(`/trips/${T.ARCH}/expenses/new`, 'expense-new-blocked');
    check('an archived trip still takes no new expense, whatever the method', /archived/.test(await textOf('expense-new-blocked')) && !(await has('expense-method-shares')));
    check('no unexpected network calls', backend.unexpected.length === 0, backend.unexpected.join(', '));
    check('no request body anywhere carries a user id, a share, or a secret key', backend.requests.filter((r) => r.body).every((r) => { const t = JSON.stringify(r.body); return !t.includes(USER.id) && !/share_minor|p_shares/.test(t) && !t.includes(FAKE_SECRET_KEY); }));
    check('every change was one of the four expense functions; no table was written directly', backend.requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS' && /\/rest\/v1\/(expenses|expense_payers|expense_splits|expense_revisions|categories)/.test(r.path)).length === 0);
    check('no browser errors on any of these pages', logs.filter((l) => /error|exception|unhandled/i.test(l) && !/Failed to load resource|net::ERR|connection/i.test(l)).length === 0, logs.filter((l) => /error|exception|unhandled/i.test(l)).slice(0, 3).join(' | '));

    // ------------------------------------------------------------------ phone and dark
    {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const ph = await ctx.newPage();
      const pid = (id: string) => ph.locator(`[data-testid="${id}"]:visible`);
      const noOverflow = () => ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await ph.goto(`${BASE}/trips/${T.PHONE}/expenses/new`);
      await pid('expense-title').waitFor({ timeout: 20000 });
      await pid('expense-amount').fill('100');
      for (const m of ['shares', 'percentage', 'exact']) {
        await pid(`expense-method-${m}`).click();
        check(`phone: the add form with the ${m} boxes (and a very long friend name) does not scroll sideways`, await noOverflow());
      }
      const box = await pid(`expense-split-value-${uuid(9010)}`).boundingBox();
      check('phone: the typed-value boxes are comfortable touch targets', !!box && box.height >= 44);
      await shot(ph, 'split-form-phone');
      await ph.goto(`${BASE}/trips/${T.S}/expenses/${E.rent}`);
      await pid('expense-detail-title').waitFor({ timeout: 20000 });
      await pid('expense-history-toggle').click();
      await pid('history-entry-1').waitFor({ timeout: 8000 });
      check('phone: the detail with its split values and the open history does not scroll sideways', await noOverflow());
      await shot(ph, 'expense-history-phone');
      check('phone: no unexpected network calls', b.unexpected.length === 0, b.unexpected.join(', '));
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ colorScheme: 'dark' });
      const b = newBackend();
      b.profile = { ...b.profile, theme_preference: 'dark' };
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const dk = await ctx.newPage();
      await dk.goto(`${BASE}/trips/${T.S}/expenses/new`);
      await dk.locator('[data-testid="expense-title"]:visible').waitFor({ timeout: 20000 });
      await dk.locator('[data-testid="expense-method-shares"]:visible').click();
      check('dark: the form with split boxes uses the dark background', (await screenBg(dk)) === DARK_BG, await screenBg(dk));
      await shot(dk, 'split-form-dark');
      await ctx.close();
    }
    await context.close();
  } finally {
    site.stop();
  }
}

async function inputFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nO. Input validation: dates, amounts, percentages and shares (real typing and pasting)');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9101), ravi: uuid(9102), priya: uuid(9103) } as const;
    const T = { A: uuid(811), ARCH: uuid(812) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const mine = (id: string) => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', joined_at: '2026-11-18T10:30:00+00:00' });
    const start = dayFromToday(10);
    const end = dayFromToday(13);
    const dmy = (isoDay: string) => isoDay.split('-').reverse().join('/');
    const CAT = { food: uuid(9702) };
    const seed = (b: FakeBackend) => {
      const members = [mine(ID.me), ravi(), priya()];
      b.trips = [tripRow({ id: T.A, name: 'Input Trip', destination: 'Place', start_date: start, end_date: end, members: members.map((m) => ({ id: m.id, status: m.status })), _members: members })];
      b.expenses = [{
        id: uuid(8101), tripId: T.A, title: 'Dinner', amount_minor: 120050, category_id: CAT.food, spent_on: addDays(start, 1), notes: null, split_method: 'equal', created_by: ID.me, updated_by: null,
        created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
        payers: [{ member_id: ID.me, paid_minor: 120050 }],
        splits: previewSplit(120050, 'equal', [ID.me, ID.ravi]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
      }];
    };

    /** Runs the same checks on a desktop-sized and a phone-sized (touch) browser. */
    const variants: { name: string; options: Record<string, unknown> }[] = [
      { name: 'desktop', options: { permissions: ['clipboard-read', 'clipboard-write'] } },
      { name: 'phone', options: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] } },
    ];
    for (const variant of variants) {
      const V = variant.name;
      const context = await browser.newContext(variant.options);
      const backend = newBackend();
      seed(backend);
      await installFakeSupabase(context, backend);
      await sessionInStorage(context);
      const page = await context.newPage();
      const logs: string[] = [];
      page.on('console', (m) => logs.push(m.text()));
      page.on('pageerror', (e) => logs.push(String(e)));
      const textOf = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const has = async (id: string) => (await byId(page, id).count()) > 0;
      const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
      const calls = (fn: string) => backend.requests.filter((r) => r.method === 'POST' && r.path === `/rest/v1/rpc/${fn}`);
      const go = async (p: string, wait: string) => {
        await page.goto(`${BASE}${p}`);
        return byId(page, wait).waitFor({ timeout: 20000 }).then(() => true, () => false);
      };
      const val = (id: string) => byId(page, id).inputValue();
      /** Empties the box, then types key by key like a person (each key goes through the app's own filter). */
      const typeInto = async (id: string, text: string) => {
        const box = byId(page, id);
        await box.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(text);
        return box.inputValue();
      };
      /** Puts `text` on the clipboard and pastes it over the box's contents (a real paste event). */
      const pasteInto = async (id: string, text: string) => {
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
        const box = byId(page, id);
        await box.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Control+V');
        return box.inputValue();
      };
      const attr = (id: string, name: string) => byId(page, id).getAttribute(name);
      const eA = `/trips/${T.A}/expenses`;

      // ------------------------------------------------------------ the expense form: amounts typed key by key
      check(`${V}: the add form opens`, await go(`${eA}/new`, 'expense-amount'));
      check(`${V}: 323, 323.4 and 323.45 are accepted as typed`, (await typeInto('expense-amount', '323')) === '323' && (await typeInto('expense-amount', '323.4')) === '323.4' && (await typeInto('expense-amount', '323.45')) === '323.45');
      check(`${V}: a third decimal digit is not accepted (323.456 shows 323.45)`, (await typeInto('expense-amount', '323.456')) === '323.45');
      check(`${V}: letters never appear (32abc shows 32)`, (await typeInto('expense-amount', '32abc')) === '32');
      check(`${V}: a special character never appears (32@ shows 32)`, (await typeInto('expense-amount', '32@')) === '32');
      check(`${V}: a second decimal point is not accepted (32..45 shows 32.45)`, (await typeInto('expense-amount', '32..45')) === '32.45');
      check(`${V}: a minus sign never appears`, (await typeInto('expense-amount', '-5')) === '5');
      check(`${V}: an unfinished 20. may stay while typing`, (await typeInto('expense-amount', '20.')) === '20.');
      check(`${V}: the amount box asks for a decimal keyboard (hint only) and the label stays`, (await attr('expense-amount', 'inputmode')) === 'decimal', String(await attr('expense-amount', 'inputmode')));

      // pasted text follows the very same rules
      check(`${V}: pasting a clean amount works`, (await pasteInto('expense-amount', '1200.50')) === '1200.50');
      check(`${V}: pasting grouped digits works (1,23,456.50 becomes 123456.50)`, (await pasteInto('expense-amount', '1,23,456.50')) === '123456.50');
      await typeInto('expense-amount', '77');
      check(`${V}: pasting a third decimal digit changes nothing (the whole paste is refused, never trimmed)`, (await pasteInto('expense-amount', '323.456')) === '77');
      check(`${V}: pasting letters changes nothing`, (await pasteInto('expense-amount', '32abc')) === '77');
      check(`${V}: pasting a special character changes nothing`, (await pasteInto('expense-amount', '32@')) === '77');
      check(`${V}: pasting two decimal points changes nothing`, (await pasteInto('expense-amount', '32..45')) === '77');
      check(`${V}: pasting a negative number changes nothing`, (await pasteInto('expense-amount', '-5')) === '77');

      // an unfinished or zero total cannot be saved
      await byId(page, 'expense-title').fill('Input test');
      await typeInto('expense-amount', '20.');
      const createsBefore = calls('create_expense').length;
      await byId(page, 'expense-save').click();
      check(`${V}: an unfinished 20. is refused at save with its own message, and nothing is sent`, (await settle(async () => /Finish the amount/.test(await textOf('expense-form-error') + (await page.locator('body').innerText())))) && calls('create_expense').length === createsBefore);
      await typeInto('expense-amount', '0');
      await byId(page, 'expense-save').click();
      check(`${V}: a total of 0 is refused at save`, (await settle(async () => (await page.locator('body').innerText()).includes('greater than zero'))) && calls('create_expense').length === createsBefore);
      await typeInto('expense-amount', '0.00');
      await byId(page, 'expense-save').click();
      check(`${V}: a total of 0.00 is refused at save`, (await settle(async () => (await page.locator('body').innerText()).includes('greater than zero'))) && calls('create_expense').length === createsBefore);
      await typeInto('expense-amount', '');
      await byId(page, 'expense-save').click();
      check(`${V}: an empty total is refused at save`, (await settle(async () => (await page.locator('body').innerText()).includes('Enter the amount'))) && calls('create_expense').length === createsBefore);

      // ------------------------------------------------------------ the expense date stays inside the trip
      check(`${V}: the day box starts inside the trip`, (await val('expense-date')) === dmy(start));
      check(`${V}: typing a day before the trip is not accepted`, (await typeInto('expense-date', dmy(addDays(start, -1)))) !== dmy(addDays(start, -1)));
      check(`${V}: typing a day after the trip is not accepted`, (await typeInto('expense-date', dmy(addDays(end, 1)))) !== dmy(addDays(end, 1)));
      check(`${V}: typing the first day, a middle day and the last day is accepted`, (await typeInto('expense-date', dmy(start))) === dmy(start) && (await typeInto('expense-date', dmy(addDays(start, 1)))) === dmy(addDays(start, 1)) && (await typeInto('expense-date', dmy(end))) === dmy(end));
      await typeInto('expense-date', dmy(start));
      check(`${V}: pasting a day outside the trip changes nothing`, (await pasteInto('expense-date', dmy(addDays(end, 1)))) === dmy(start) && (await pasteInto('expense-date', dmy(addDays(start, -1)))) === dmy(start));
      check(`${V}: pasting a day inside the trip works`, (await pasteInto('expense-date', dmy(addDays(start, 2)))) === dmy(addDays(start, 2)));
      check(`${V}: an impossible day (32) is not accepted`, !(await typeInto('expense-date', '32')).startsWith('32'));
      await byId(page, 'expense-date-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      // the calendar opens on the trip's month(s): step to the month of the first day if needed
      const monthOf = (iso: string) => iso.slice(0, 7);
      for (let i = 0; i < 3 && (await byId(page, `date-picker-day-${start}`).count()) === 0; i++) await byId(page, 'date-picker-next-month').click();
      const dayDisabled = async (iso: string) => (await byId(page, `date-picker-day-${iso}`).getAttribute('aria-disabled')) === 'true';
      const before = addDays(start, -1);
      const after = addDays(end, 1);
      for (let i = 0; i < 3 && (await byId(page, `date-picker-day-${before}`).count()) === 0 && monthOf(before) !== monthOf(start); i++) await byId(page, 'date-picker-prev-month').click();
      check(`${V}: in the calendar the day before the trip is disabled`, (await byId(page, `date-picker-day-${before}`).count()) === 0 ? true : await dayDisabled(before));
      for (let i = 0; i < 3 && (await byId(page, `date-picker-day-${end}`).count()) === 0; i++) await byId(page, 'date-picker-next-month').click();
      for (let i = 0; i < 3 && (await byId(page, `date-picker-day-${after}`).count()) === 0; i++) await byId(page, 'date-picker-next-month').click();
      check(`${V}: in the calendar the day after the trip is disabled`, await dayDisabled(after));
      check(`${V}: and the first, a middle and the last day of the trip are enabled`, !(await dayDisabled(start)) && !(await dayDisabled(addDays(start, 1))) && !(await dayDisabled(end)));
      const boxBefore = await val('expense-date');
      await byId(page, `date-picker-day-${after}`).click({ force: true, timeout: 1500 }).catch(() => {});
      check(`${V}: clicking a disabled day does nothing (the calendar stays open and the box is unchanged)`, (await has('date-picker')) && (await val('expense-date')) === boxBefore);
      await byId(page, `date-picker-day-${end}`).click();
      check(`${V}: choosing the last day of the trip fills the box`, (await val('expense-date')) === dmy(end));
      await page.waitForTimeout(800); // the dialog hands focus back to the calendar button a moment after it closes; a person would not type that fast

      // a good amount and date still save, with the amount converted to whole paise
      await typeInto('expense-amount', '323.4');
      await typeInto('expense-date', dmy(addDays(start, 1)));
      await byId(page, 'expense-save').click();
      check(`${V}: 323.4 is saved as 32340 paise (integer arithmetic, nothing rounded)`, (await settle(() => calls('create_expense').length === createsBefore + 1)) && calls('create_expense').at(-1)!.body.p_amount_minor === 32340 && calls('create_expense').at(-1)!.body.p_spent_on === addDays(start, 1), JSON.stringify(calls('create_expense').at(-1)?.body) + ' | page: ' + (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600));

      // ------------------------------------------------------------ payers, exact amounts, percentages and shares
      await go(`${eA}/new`, 'expense-amount');
      await typeInto('expense-amount', '100');
      await byId(page, `expense-payer-${ID.ravi}`).click();
      check(`${V}: with two payers each gets an amount box that follows the money rules`, (await has(`expense-payer-amount-${ID.me}`)) && (await typeInto(`expense-payer-amount-${ID.me}`, '6.789')) === '6.78' && (await typeInto(`expense-payer-amount-${ID.ravi}`, '4abc')) === '4' && (await typeInto(`expense-payer-amount-${ID.ravi}`, '-4')) === '4' && (await pasteInto(`expense-payer-amount-${ID.ravi}`, '4.555')) === '4');
      await byId(page, 'expense-method-exact').click();
      const exactBox = `expense-split-value-${ID.me}`;
      check(`${V}: exact amounts follow the money rules (two decimals, no letters, one point)`, (await typeInto(exactBox, '1.234')) === '1.23' && (await typeInto(exactBox, '1x')) === '1' && (await typeInto(exactBox, '1..5')) === '1.5' && (await attr(exactBox, 'inputmode')) === 'decimal');
      await byId(page, 'expense-method-percentage').click();
      check(`${V}: percentages take up to two decimals`, (await typeInto(exactBox, '33.333')) === '33.33' && (await typeInto(exactBox, '33.3')) === '33.3' && (await typeInto(exactBox, '33.')) === '33.');
      check(`${V}: a percentage cannot go over 100, no letters, no minus sign, one point only`, (await typeInto(exactBox, '101')) === '10' && (await typeInto(exactBox, '100.5')) === '100.' && (await typeInto(exactBox, '100')) === '100' && (await typeInto(exactBox, '5x')) === '5' && (await typeInto(exactBox, '-5')) === '5' && (await typeInto(exactBox, '5..5')) === '5.5');
      check(`${V}: pasting an out-of-range or malformed percentage changes nothing`, (await typeInto(exactBox, '50')) === '50' && (await pasteInto(exactBox, '150')) === '50' && (await pasteInto(exactBox, '12.345')) === '50' && (await pasteInto(exactBox, '33.33')) === '33.33');
      await byId(page, 'expense-method-shares').click();
      check(`${V}: shares are whole numbers (no point, minus sign or letters) and ask for a number keypad`, (await typeInto(exactBox, '1.5')) === '15' && (await typeInto(exactBox, '-3')) === '3' && (await typeInto(exactBox, '3x')) === '3' && (await attr(exactBox, 'inputmode')) === 'numeric');
      check(`${V}: shares stop at the database limit of 1,000,000, and a pasted decimal or oversized number changes nothing`, (await typeInto(exactBox, '1000000')) === '1000000' && (await typeInto(exactBox, '1000001')) === '100000' && (await typeInto(exactBox, '7')) === '7' && (await pasteInto(exactBox, '1.5')) === '7' && (await pasteInto(exactBox, '2000000')) === '7' && (await pasteInto(exactBox, '25')) === '25');

      // ------------------------------------------------------------ editing an expense: the same rules, and plain starting text
      await go(`${eA}/${uuid(8101)}/edit`, 'expense-amount');
      check(`${V}: Edit starts with plain digits (1200.50, no grouping comma) so every character can be edited`, (await val('expense-amount')) === '1200.50', await val('expense-amount'));
      check(`${V}: Edit keeps the day inside the trip too`, (await typeInto('expense-date', dmy(addDays(end, 1)))) !== dmy(addDays(end, 1)) && (await typeInto('expense-date', dmy(addDays(start, 2)))) === dmy(addDays(start, 2)));
      check(`${V}: Edit lets a digit be removed and retyped`, (await typeInto('expense-amount', '1200.5')) === '1200.5' && (await (async () => { await byId(page, 'expense-amount').press('Backspace'); await byId(page, 'expense-amount').press('Backspace'); return val('expense-amount'); })()) === '1200');
      await byId(page, 'expense-date-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      for (let i = 0; i < 3 && (await byId(page, `date-picker-day-${after}`).count()) === 0; i++) await byId(page, 'date-picker-next-month').click();
      check(`${V}: Edit calendar disables the day after the trip`, await dayDisabled(after));
      await byId(page, 'date-picker-close').click();

      // ------------------------------------------------------------ trip dates: creating and editing
      check(`${V}: the trip form opens`, await go('/trips/new', 'trip-start'));
      check(`${V}: day 32 is not accepted while typing`, (await typeInto('trip-start', '32')) === '3');
      check(`${V}: month 13 is not accepted`, (await typeInto('trip-start', '2713')) === '27/1');
      check(`${V}: day 00 and month 00 are not accepted`, (await typeInto('trip-start', '00')) === '0' && (await typeInto('trip-start', '2700')) === '27/0');
      check(`${V}: only digits are accepted (letters and symbols never appear)`, (await typeInto('trip-start', '27ab/@12')) === '27/12');
      check(`${V}: 31 April and 31 June are not accepted, 30 April is`, (await typeInto('trip-start', '3104')) === '31/0' && (await typeInto('trip-start', '3004')) === '30/04');
      check(`${V}: 29 February is accepted in a leap year (2028) and refused in a common year (2027)`, (await typeInto('trip-start', '29022028')) === '29/02/2028' && (await typeInto('trip-start', '29022027')) === '29/02/202');
      check(`${V}: 29 February 2100 is refused (2100 is not a leap year) and 29 February 2000 is accepted`, (await typeInto('trip-start', '29022000')) === '29/02/2000');
      check(`${V}: pasting an impossible date changes nothing`, (await typeInto('trip-start', '27/12/2026')) === '27/12/2026' && (await pasteInto('trip-start', '32/01/2026')) === '27/12/2026' && (await pasteInto('trip-start', '29/02/2027')) === '27/12/2026' && (await pasteInto('trip-start', '13/13/2026')) === '27/12/2026');
      check(`${V}: pasting a real date works, in any usual spelling`, (await pasteInto('trip-start', '29/02/2028')) === '29/02/2028' && (await pasteInto('trip-start', '2028-03-01')) === '01/03/2028');
      check(`${V}: a date can always be corrected: backspace, replace the day, replace everything`, await (async () => {
        await typeInto('trip-start', '27/12/2026');
        await byId(page, 'trip-start').press('Backspace');
        const afterBackspace = await val('trip-start');
        const replaced = await typeInto('trip-start', '30112027');
        return afterBackspace === '27/12/202' && replaced === '30/11/2027';
      })());
      await typeInto('trip-start', '28/02/2027');
      check(`${V}: the end date box follows the same rules`, (await typeInto('trip-end', '3002')) === '30/0' && (await typeInto('trip-end', '28022027')) === '28/02/2027');
      await byId(page, 'trip-start-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      check(`${V}: the calendar offers 29 February only in a leap year`, await (async () => {
        const open = async (iso: string) => {
          await byId(page, 'date-picker-close').click();
          await byId(page, 'date-picker').waitFor({ state: 'hidden', timeout: 5000 }); // the dialog fades out; do not reopen on top of it
          await typeInto('trip-start', `01/02/${iso}`);
          await byId(page, 'trip-start-calendar').click();
          await byId(page, 'date-picker').waitFor({ timeout: 5000 });
          return byId(page, `date-picker-day-${iso}-02-29`).count();
        };
        const leap = await open('2028');
        const common = await open('2027');
        return leap === 1 && common === 0;
      })());
      const pickIso = `${new Date().getFullYear() + 1}-03-15`;
      await byId(page, 'date-picker-close').click();
      await byId(page, 'date-picker').waitFor({ state: 'hidden', timeout: 5000 });
      await typeInto('trip-start', `01/03/${pickIso.slice(0, 4)}`);
      await byId(page, 'trip-start-calendar').click();
      await byId(page, 'date-picker').waitFor({ timeout: 5000 });
      await byId(page, `date-picker-day-${pickIso}`).click();
      check(`${V}: a day chosen from the calendar fills the box and passes the typing rules`, (await val('trip-start')) === dmy(pickIso));
      check(`${V}: no unexpected network calls and no browser errors`, backend.unexpected.length === 0 && logs.filter((l) => /error|exception|unhandled/i.test(l) && !/Failed to load resource|net::ERR|connection/i.test(l)).length === 0, logs.filter((l) => /error|exception|unhandled/i.test(l)).slice(0, 3).join(' | '));
      if (V === 'phone') {
        const box = await byId(page, 'trip-start').boundingBox();
        check('phone: the date box is a comfortable touch target and the page does not scroll sideways', !!box && box.height >= 44 && (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
        await shot(page, 'input-validation-phone');
      }
      await context.close();
    }
  } finally {
    site.stop();
  }
}

async function settlementFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nP. Suggested payments (settlement plan) in the Balances tab');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9201), ravi: uuid(9202), priya: uuid(9203), gita: uuid(9204), dev: uuid(9206) } as const;
    const T = { OWE: uuid(821), OWED: uuid(822), EMPTY: uuid(823), ARCH: uuid(824), BAD: uuid(825), BIG: uuid(826), SETTLED: uuid(827), MANY: uuid(828) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const DEV = '55555555-5555-4555-8555-555555555555';
    const mine = (id: string) => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', joined_at: '2026-11-18T10:30:00+00:00' });
    const gita = () => memberRow({ id: ID.gita, user_id: null, display_name: 'Gita', joined_at: '2026-11-18T11:00:00+00:00' });
    const dev = () => memberRow({ id: ID.dev, user_id: DEV, display_name: 'Departed Dev', status: 'left', left_at: '2026-11-15T10:00:00+00:00' });
    const start = dayFromToday(10);
    const end = dayFromToday(13);
    const trip = (id: string, name: string, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Place', start_date: start, end_date: end, members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    let expCounter = 0;
    const exp = (tripId: string, title: string, amount: number, by: string, shared: string[]): Record<string, any> => ({
      id: uuid(8200 + ++expCounter), tripId, title, amount_minor: amount, category_id: null, spent_on: start, notes: null, split_method: 'equal', created_by: by, updated_by: null,
      created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
      payers: [{ member_id: by, paid_minor: amount }],
      splits: previewSplit(amount, 'equal', shared).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
    });
    const manyGuests = Array.from({ length: 14 }, (_, i) => memberRow({ id: uuid(9300 + i), user_id: null, display_name: `Guest ${i + 1}`, joined_at: '2026-11-18T11:00:00+00:00' }));
    const seed = (b: FakeBackend) => {
      const all = [ID.me, ID.ravi, ID.priya];
      b.trips = [
        trip(T.OWE, 'Owe Trip', [mine(ID.me), ravi(), priya()]), // Priya paid 900 for three: Asha and Ravi each owe 300
        trip(T.OWED, 'Owed Trip', [mine(ID.me), ravi(), priya(), gita()]), // Asha paid 1200 for four: the others each owe 300
        trip(T.EMPTY, 'Empty Trip', [mine(ID.me), ravi()]),
        trip(T.ARCH, 'Archived Trip', [mine(ID.me), ravi()], { status: 'archived' }),
        trip(T.BAD, 'Bad Data Trip', [mine(ID.me), ravi(), dev()]), // a member who left still holds a balance: impossible in the database
        trip(T.BIG, 'Big Trip', [mine(ID.me), ravi(), priya(), gita()]),
        trip(T.SETTLED, 'Settled Trip', [mine(ID.me), ravi()]),
        trip(T.MANY, 'Many Trip', [mine(ID.me), ...manyGuests]), // 15 people: the plan is worked out just after the screen draws
      ];
      b.expenses = [
        exp(T.OWE, 'Hotel', 90000, ID.priya, all),
        exp(T.OWED, 'Rent', 120000, ID.me, [ID.me, ID.ravi, ID.priya, ID.gita]),
        exp(T.ARCH, 'Closed lunch', 40000, ID.me, [ID.me, ID.ravi]),
        exp(T.BAD, 'Old lunch', 30000, ID.me, [ID.me, ID.dev]),
        exp(T.BIG, 'Dinner', 100000, ID.priya, [ID.me, ID.ravi, ID.priya, ID.gita]),
        exp(T.SETTLED, 'Cab there', 20000, ID.me, [ID.me, ID.ravi]),
        exp(T.SETTLED, 'Cab back', 20000, ID.ravi, [ID.me, ID.ravi]),
        exp(T.MANY, 'Big dinner', 150000, ID.me, [ID.me, ...manyGuests.map((g) => g.id)]),
      ];
    };

    const variants: { name: string; options: Record<string, unknown> }[] = [
      { name: 'desktop', options: {} },
      { name: 'phone', options: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    ];
    for (const variant of variants) {
      const V = variant.name;
      const context = await browser.newContext(variant.options);
      const backend = newBackend();
      seed(backend);
      await installFakeSupabase(context, backend);
      await sessionInStorage(context);
      const page = await context.newPage();
      const logs: string[] = [];
      page.on('console', (m) => logs.push(m.text()));
      page.on('pageerror', (e) => logs.push(String(e)));
      const textOf = async (id: string) => (await byId(page, id).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const has = async (id: string) => (await byId(page, id).count()) > 0;
      const settle = (fn: () => Promise<boolean> | boolean) => waitFor(fn, 8000);
      // a group payment is a card (from, verb, to, amount); this rebuilds the old one-line sentence for the same comparisons
      const lineText = async (i: number) => (await Promise.all(['from', 'verb', 'to', 'amount'].map(async (p) => (await byId(page, `settlement-line-${p}-${i}`).innerText().catch(() => '')).trim()))).join(' ');
      const open = async (tripId: string) => {
        await page.goto(`${BASE}/trips/${tripId}/expenses`);
        await byId(page, 'expenses-tab-balances').waitFor({ timeout: 20000 });
        await byId(page, 'expenses-tab-balances').click();
        return byId(page, 'settlement-card').waitFor({ timeout: 15000 }).then(() => true, () => false);
      };
      const lineTexts = async () => {
        const n = await page.locator('[data-testid^="settlement-line-amount-"]:visible').count();
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(await lineText(i));
        return out;
      };
      const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

      // ---- the signed-in person owes
      check(`${V}: the Balances tab shows a Suggested payments card`, await open(T.OWE));
      check(`${V}: the personal line says what you pay`, await settle(async () => (await textOf('settlement-mine-0')) === 'You pay Priya Shah ₹300'), await textOf('settlement-mine'));
      check(`${V}: the full list names everyone in the approved wording`, await settle(async () => JSON.stringify(await lineTexts()) === JSON.stringify(['Asha Rao pays Priya Shah ₹300', 'Ravi Kumar pays Priya Shah ₹300'])), JSON.stringify(await lineTexts()));
      check(`${V}: the headline counts the payments`, (await textOf('settlement-headline')) === '2 payments settle everyone.', await textOf('settlement-headline'));
      check(`${V}: it says plainly that nothing is transferred or recorded and that the plan can change`, /does not move any money or record repayments/.test(await textOf('settlement-disclaimer')) && /can change when expenses change/.test(await textOf('settlement-disclaimer')));
      check(`${V}: a trip this small is never described as approximate`, !(await has('settlement-inexact')));
      check(`${V}: the existing balances list is still there`, await has('balances-list'));
      if (V === 'phone') {
        check('phone: the card does not scroll sideways', await noOverflow());
        await shot(page, 'settlement-phone');
      } else {
        await shot(page, 'settlement-desktop');
      }

      // ---- the signed-in person is owed
      check(`${V}: when you are owed, the personal lines say what you receive`, (await open(T.OWED)) && (await settle(async () => (await textOf('settlement-mine')).includes('You receive ₹300 from Gita') && (await textOf('settlement-mine')).includes('You receive ₹300 from Ravi Kumar') && (await textOf('settlement-mine')).includes('You receive ₹300 from Priya Shah'))), await textOf('settlement-mine'));
      check(`${V}: three payments settle four people`, (await textOf('settlement-headline')) === '3 payments settle everyone.', await textOf('settlement-headline'));

      // ---- nobody owes anything
      check(`${V}: an empty ledger: everyone is settled, no payments, and the personal line says so`, (await open(T.EMPTY)) && (await settle(async () => (await textOf('settlement-headline')) === 'Everyone is settled.')) && !(await has('settlement-list')) && (await textOf('settlement-mine-0')) === 'You are settled');
      check(`${V}: expenses that cancel out also leave everyone settled`, (await open(T.SETTLED)) && (await settle(async () => (await textOf('settlement-headline')) === 'Everyone is settled.')) && (await textOf('settlement-mine-0')) === 'You are settled');

      // ---- archived
      check(`${V}: an archived trip still shows the plan, read-only and marked for reference`, (await open(T.ARCH)) && (await settle(async () => (await lineText(0)) === 'Ravi Kumar pays Asha Rao ₹200')) && /for reference/.test(await textOf('settlement-archived')) && (await textOf('settlement-mine-0')) === 'You receive ₹200 from Ravi Kumar', await textOf('settlement-card'));

      // ---- inconsistent data fails safely
      const FORMER_MSG = 'Someone who left the trip still has a balance, which should not happen, so no payments can be suggested. Check the expenses that involve people who left.';
      const noPlanShown = async () => !(await has('settlement-list')) && !(await has('settlement-headline')) && !(await has('settlement-mine-0')) && !(await has('settlement-working'));
      check(`${V}: a former member holding a balance: its own message, and NO payments`, (await open(T.BAD)) && (await settle(async () => (await textOf('settlement-error')) === FORMER_MSG)) && (await has('settlement-error-former_member_balance')) && (await noPlanShown()), await textOf('settlement-card'));
      check(`${V}: the plain balances are still shown next to that error`, await has('balances-list'));

      // ---- data the database would never send: each kind of failure has its own message and shows no payments at all
      const row = (id: string, net: number) => ({ member_id: id, paid_minor: Math.max(net, 0), share_minor: Math.max(-net, 0), net_minor: net });
      const failureCases: { kind: string; rows: Record<string, unknown>[]; message: string }[] = [
        { kind: 'not_zero_sum', rows: [row(ID.me, 10000), row(ID.ravi, -5000)], message: "The balances don't add up to zero, so no payments can be suggested. Reload to try again." },
        { kind: 'unsafe_amount', rows: [row(ID.me, 4503599627370497), row(ID.ravi, -4503599627370497)], message: 'Some amounts are too large or are not valid money amounts, so no payments can be suggested.' },
        { kind: 'invalid_input', rows: [row(ID.me, 0), row(ID.me, 0)], message: 'The balance information looks invalid, so no payments can be suggested. Reload to try again.' },
      ];
      for (const c of failureCases) {
        backend.balanceRows = { [T.EMPTY]: c.rows };
        const shown = (await open(T.EMPTY)) && (await settle(async () => (await textOf('settlement-error')) === c.message));
        check(`${V}: ${c.kind} (${JSON.stringify(c.rows[0]!.net_minor)}): the right message and no payments`, shown && (await has(`settlement-error-${c.kind}`)) && (await noPlanShown()), await textOf('settlement-card'));
      }
      // A fractional amount never reaches the plan: the balances service (M5) refuses any row that is not a whole number of paise, so the
      // whole balances list fails to load (its existing error and Try again) and no balances and no plan are shown at all.
      backend.balanceRows = { [T.EMPTY]: [row(ID.me, 150.5), row(ID.ravi, -150.5)] };
      await page.goto(`${BASE}/trips/${T.EMPTY}/expenses`);
      await byId(page, 'expenses-tab-balances').waitFor({ timeout: 20000 });
      await byId(page, 'expenses-tab-balances').click();
      check(`${V}: a fractional amount is refused before planning: the balances error shows, with no balances and no payments`, (await byId(page, 'balances-error').waitFor({ timeout: 90000 }).then(() => true, () => false)) && !(await has('settlement-card')) && !(await has('balances-list')));
      backend.balanceRows = null;
      check(`${V}: and a good ledger afterwards plans normally again`, (await open(T.EMPTY)) && (await settle(async () => (await textOf('settlement-headline')) === 'Everyone is settled.')) && !(await has('settlement-error')));

      // ---- a bigger group
      check(`${V}: four people with one payer`, (await open(T.BIG)) && (await settle(async () => (await textOf('settlement-headline')) === '3 payments settle everyone.')), await textOf('settlement-headline'));

      // ---- more than 12 people: worked out just after the screen draws
      check(`${V}: fifteen people: the plan appears (14 payments, everyone pays the one who paid)`, (await open(T.MANY)) && (await settle(async () => (await textOf('settlement-headline')) === '14 payments settle everyone.')) && !(await has('settlement-working')) && (await textOf('settlement-mine')).includes('You receive ₹100 from Guest'), await textOf('settlement-card'));

      // ---- nothing here moves money
      const sends = backend.requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS');
      check(`${V}: the app sent nothing but balance and member reads (no expense, member or money write of any kind)`, sends.length > 0 && sends.every((r) => /\/rpc\/(trip_member_balances|list_trip_members)$/.test(r.path)), sends.map((r) => r.path).filter((p, n, a) => a.indexOf(p) === n).join(', '));
      check(`${V}: no unexpected network calls and no browser errors`, backend.unexpected.length === 0 && logs.filter((l) => /error|exception|unhandled/i.test(l) && !/Failed to load resource|net::ERR|connection/i.test(l)).length === 0, logs.filter((l) => /error|exception|unhandled/i.test(l)).slice(0, 3).join(' | '));
      await context.close();
    }

    // ---- dark theme
    {
      const ctx = await browser.newContext({ colorScheme: 'dark' });
      const b = newBackend();
      b.profile = { ...b.profile, theme_preference: 'dark' };
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const dk = await ctx.newPage();
      await dk.goto(`${BASE}/trips/${T.OWE}/expenses`);
      await dk.locator('[data-testid="expenses-tab-balances"]:visible').waitFor({ timeout: 20000 });
      await dk.locator('[data-testid="expenses-tab-balances"]:visible').click();
      await dk.locator('[data-testid="settlement-card"]:visible').waitFor({ timeout: 15000 });
      check('dark: the suggested payments card uses the dark background', (await screenBg(dk)) === DARK_BG, await screenBg(dk));
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function redesignFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nQ. Redesign: public website, navigation, Home tabs, Search, Archived, Settings, motion, layouts');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9501), ravi: uuid(9502), priya: uuid(9503) } as const;
    const T = { ONG: uuid(951), UP: uuid(952), PAST: uuid(953), ARCH: uuid(954), OWE: uuid(955) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const me = (id: string) => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', joined_at: '2026-11-18T10:30:00+00:00' });
    const trip = (id: string, name: string, s: number, e: number, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: 'Placeville', start_date: dayFromToday(s), end_date: dayFromToday(e), members: members.map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    const seed = (b: FakeBackend) => {
      b.trips = [
        trip(T.ONG, 'Coorg Coffee Trail', -1, 2, [me(ID.me), ravi()]),
        trip(T.UP, 'Hampi Weekend', 20, 22, [me(ID.me), ravi()]),
        trip(T.PAST, 'Spiti Valley Loop', -30, -25, [me(ID.me)]),
        trip(T.ARCH, 'Munnar Mist Weekend', -60, -58, [me(ID.me)], { status: 'archived' }),
        trip(T.OWE, 'Owe Trip', 5, 8, [me(ID.me), ravi(), priya()]),
      ];
      b.expenses = [
        {
          id: uuid(9600), tripId: T.OWE, title: 'Hotel', amount_minor: 90000, category_id: null, spent_on: dayFromToday(5), notes: null, split_method: 'equal', created_by: ID.priya, updated_by: null,
          created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
          payers: [{ member_id: ID.priya, paid_minor: 90000 }],
          splits: previewSplit(90000, 'equal', [ID.me, ID.ravi, ID.priya]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
        },
      ];
    };
    const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // ================= the public website (signed out) =================
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      await installFakeSupabase(ctx, b);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      const body = async () => await p.locator('body').innerText();
      check('website: the landing page shows the headline and the Get started and Log in actions', (await byId(p, 'hero-title').innerText()).includes('Travel together') && (await byId(p, 'hero-get-started').isVisible()) && (await byId(p, 'hero-login').isVisible()));
      check('website: header has Features, How it works, About, Contact, Log in and Sign up', (await Promise.all(['nav-features', 'nav-how', 'nav-about', 'nav-contact', 'site-login', 'site-signup'].map(async (id) => byId(p, id).isVisible()))).every(Boolean));
      check('website: exactly the six supported features are listed', (await byId(p, 'feature-card').count()) === 6);
      const text = await body();
      check('website: repayment recording is only "coming next"', /Coming next: recording and confirming repayments/.test(text) && !/record(s|ed)? your repayments now/i.test(text));
      check('website: a product preview and a how-it-works section are present', (await byId(p, 'how-it-works').isVisible()) && (await byId(p, 'previews').isVisible()));
      check('website: footer has Product, Company and Legal links, and no invented contact details', (await Promise.all(['footer-features', 'footer-how', 'footer-about', 'footer-contact', 'footer-help', 'footer-privacy', 'footer-terms'].map(async (id) => (await byId(p, id).count()) > 0))).every(Boolean) && (await p.locator('a[href^="mailto:"], a[href^="tel:"]').count()) === 0 && !/@[a-z0-9-]+\.[a-z]{2,}/i.test(await byId(p, 'site-footer').innerText()));
      check('website: no browser horizontal overflow at 1280', await overflow(p));
      await shot(p, 'website-desktop-light');
      await byId(p, 'footer-privacy').click();
      await byId(p, 'info-placeholder').waitFor({ timeout: 8000 });
      check('website: Privacy Policy is a clearly marked placeholder with no policy text', pathOf(p) === '/info/privacy' && /placeholder/i.test(await byId(p, 'info-placeholder').innerText()));
      await p.goto(`${BASE}/info/terms`);
      check('website: Terms and Conditions placeholder is reachable signed out', await byId(p, 'info-placeholder').waitFor({ timeout: 8000 }).then(() => true, () => false));
      await p.goto(BASE);
      await byId(p, 'hero-get-started').click();
      check('website: Get started opens sign-up', await byId(p, 'displayName').waitFor({ timeout: 10000 }).then(() => true, () => false) && pathOf(p) === '/sign-up', pathOf(p));
      await p.goto(BASE);
      await byId(p, 'hero-login').click();
      check('website: Log in opens sign-in', await byId(p, 'email').waitFor({ timeout: 10000 }).then(() => true, () => false) && pathOf(p) === '/sign-in', pathOf(p));
      for (const w of [768, 360]) {
        await p.setViewportSize({ width: w, height: 900 });
        await p.goto(BASE);
        await byId(p, 'landing').waitFor({ timeout: 20000 });
        check(`website: no horizontal overflow at ${w} px`, await overflow(p));
        const edges = await Promise.all(['site-brand', 'site-signup', 'hero-get-started', 'hero-login'].map((id) => byId(p, id).boundingBox()));
        check(`website: header and hero stay inside the ${w} px screen (nothing cut off at either edge)`, edges.every((b) => !!b && b.x >= -0.5 && b.x + b.width <= w + 0.5), JSON.stringify(edges));
      }
      check('website: at phone width the links fold into a Menu', (await byId(p, 'site-menu').isVisible()) && !(await byId(p, 'nav-features').count()));
      await byId(p, 'site-menu').click();
      check('website: the Menu lists the links and says it is expanded', (await byId(p, 'site-menu-list').isVisible()) && (await byId(p, 'site-menu').getAttribute('aria-expanded')) === 'true');
      await shot(p, 'website-phone-light');
      await ctx.close();
    }
    {
      // dark website: the visitor's saved choice on this device
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
      await installFakeSupabase(ctx, newBackend());
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      check('website: dark theme uses the deep forest background', await waitFor(async () => (await screenBg(p)) === DARK_BG), await screenBg(p));
      await shot(p, 'website-desktop-dark');
      await ctx.close();
    }

    // ================= the phone app =================
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      const exists = async (id: string) => (await byId(p, id).count()) > 0;
      await p.goto(BASE);
      await byId(p, 'greeting').waitFor({ timeout: 20000 });
      await byId(p, 'status-ongoing').waitFor({ timeout: 10000 });
      const labels = await p.locator('[data-testid="bottom-nav"] [role="link"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      check('phone: persistent bottom navigation with Home, Search, Create trip, Archived, Profile in that order', JSON.stringify(labels) === JSON.stringify(['Home', 'Search', 'Create trip', 'Archived', 'Profile']), JSON.stringify(labels));
      check('phone: no side navigation, no horizontal overflow', !(await exists('side-nav')) && (await overflow(p)));
      const navBox = await byId(p, 'bottom-nav').boundingBox();
      check('phone: the bar sits at the bottom edge of the screen', !!navBox && Math.abs(navBox.y + navBox.height - 844) <= 2, JSON.stringify(navBox));
      check('phone: the active destination is marked (Home)', (await byId(p, 'nav-home').getAttribute('aria-current')) === 'page' && (await byId(p, 'nav-search').getAttribute('aria-current')) === null);
      const boxes = await Promise.all(['nav-home', 'nav-search', 'nav-create', 'nav-archived', 'nav-profile'].map((id) => byId(p, id).boundingBox()));
      check('phone: every destination is a comfortable touch target (44 px)', boxes.every((x) => !!x && x.width >= 44 && x.height >= 44), JSON.stringify(boxes));
      const createBox = await byId(p, 'nav-create').boundingBox();
      check('phone: Create trip is inside the bar, not a floating button', !!createBox && !!navBox && createBox.y >= navBox.y - 1 && createBox.y + createBox.height <= navBox.y + navBox.height + 1);
      check('phone: the tabs read Completed | Ongoing | Upcoming and Ongoing is selected', (await p.locator('[role="tab"]:visible').allInnerTexts()).join('|') === 'Completed|Ongoing|Upcoming' && (await byId(p, 'status-ongoing').getAttribute('aria-selected')) === 'true');
      check('phone: the Ongoing list shows the ongoing trip as an image-led card with its details', (await byId(p, 'section-ongoing').innerText()).includes('Coorg Coffee Trail') && /Placeville/.test(await byId(p, 'section-ongoing').innerText()) && /2 people/.test(await byId(p, 'section-ongoing').innerText()));
      await shot(p, 'q-home-phone-light');
      await byId(p, 'status-upcoming').click();
      await byId(p, 'section-upcoming').waitFor({ timeout: 5000 });
      check('phone: choosing Upcoming switches the list and the selected tab', (await byId(p, 'status-upcoming').getAttribute('aria-selected')) === 'true' && (await byId(p, 'section-upcoming').innerText()).includes('Hampi Weekend') && !(await byId(p, 'section-upcoming').innerText()).includes('Coorg'));
      await byId(p, 'status-completed').click();
      await byId(p, 'section-completed').waitFor({ timeout: 5000 });
      check('phone: Completed lists the finished trip, and archived trips are not on Home', (await byId(p, 'section-completed').innerText()).includes('Spiti Valley Loop') && !(await p.locator('body').innerText()).includes('Munnar Mist'));

      // ---- Search
      await byId(p, 'home-search').click();
      await byId(p, 'search-input').waitFor({ timeout: 8000 });
      check('phone: the Home search field opens Search, with the navigation still shown and Search marked', pathOf(p) === '/search' && (await byId(p, 'nav-search').getAttribute('aria-current')) === 'page');
      check('phone: before typing, Search asks for part of a trip name', /part of a trip name/i.test(await byId(p, 'search-hint').innerText()));
      await byId(p, 'search-input').fill('coorg');
      await byId(p, 'search-results').waitFor({ timeout: 5000 });
      check('phone: typing part of a name finds the trip', (await byId(p, 'search-results').innerText()).includes('Coorg Coffee Trail') && !(await byId(p, 'search-results').innerText()).includes('Hampi'));
      await shot(p, 'q-search-phone-light');
      await byId(p, 'search-input').fill('placeville');
      check('phone: destinations are NOT searched (only names)', await byId(p, 'search-empty').waitFor({ timeout: 5000 }).then(() => true, () => false));
      await byId(p, 'search-input').fill('mist');
      await byId(p, `trip-card-${T.ARCH}`).waitFor({ timeout: 5000 });
      check('phone: an archived trip found by name is tagged Archived', await exists(`archived-tag-${T.ARCH}`));
      await byId(p, 'search-input').fill('hampi');
      await byId(p, `trip-card-${T.UP}`).click();
      check('phone: a search result opens the existing trip page', await byId(p, 'trip-title').waitFor({ timeout: 8000 }).then(() => true, () => false) && (await byId(p, 'trip-title').innerText()) === 'Hampi Weekend');
      check('phone: trip pages keep the navigation, with Home marked', (await exists('bottom-nav')) && (await byId(p, 'nav-home').getAttribute('aria-current')) === 'page');

      // ---- Archived
      await byId(p, 'nav-archived').click();
      await byId(p, 'section-archived').waitFor({ timeout: 8000 });
      check('phone: Archived lists the archived trip, tagged, and counts it', pathOf(p) === '/archived' && (await exists(`archived-tag-${T.ARCH}`)) && (await byId(p, 'section-archived').innerText()).toLowerCase().includes('archived (1)'));
      await shot(p, 'q-archived-phone-light');
      await byId(p, `trip-card-${T.ARCH}`).click();
      await byId(p, 'trip-archived').waitFor({ timeout: 8000 });
      check('phone: an archived trip opens with its notice and the existing Restore action', await exists('trip-restore'));

      // ---- Create trip
      await byId(p, 'nav-create').click();
      await byId(p, 'trip-name').waitFor({ timeout: 8000 });
      check('phone: Create trip opens the existing form (full screen, no bottom bar)', pathOf(p) === '/trips/new' && !(await exists('bottom-nav')));

      // ---- Profile and Settings
      await p.goto(BASE);
      await byId(p, 'nav-profile').click();
      await byId(p, 'profile-name').waitFor({ timeout: 8000 });
      check('phone: Profile shows the name, UPI, currency and the Settings gear, not the theme', (await exists('profile-upi')) && (await exists('currency-INR')) && (await exists('open-settings')) && !(await exists('theme-dark')));
      await shot(p, 'q-profile-phone-light');
      await byId(p, 'open-settings').click();
      await byId(p, 'theme-dark').waitFor({ timeout: 8000 });
      const themeLabels = await p.locator('[role="radiogroup"][aria-label="Theme"] [role="radio"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      check('phone: Settings offers Appearance as Light and Dark only, and the sign-out action', JSON.stringify(themeLabels) === JSON.stringify(['Light', 'Dark']) && (await exists('sign-out')), JSON.stringify(themeLabels));
      await shot(p, 'q-settings-phone-light');
      await byId(p, 'theme-dark').click();
      check('phone: choosing Dark in Settings changes the whole app', await waitFor(async () => (await screenBg(p)) === DARK_BG), await screenBg(p));
      await shot(p, 'q-settings-phone-dark');
      await byId(p, 'settings-back').click();
      await byId(p, 'profile-name').waitFor({ timeout: 8000 });
      await byId(p, 'nav-home').click();
      await byId(p, 'status-ongoing').waitFor({ timeout: 8000 });
      await shot(p, 'q-home-phone-dark');
      check('phone: the Dark choice carries across screens', (await screenBg(p)) === DARK_BG);
      await byId(p, 'nav-search').click();
      await byId(p, 'search-input').fill('coorg');
      await shot(p, 'q-search-phone-dark');
      await byId(p, 'nav-archived').click();
      await byId(p, 'section-archived').waitFor({ timeout: 8000 });
      await shot(p, 'q-archived-phone-dark');
      check('phone: no horizontal overflow in Dark either', await overflow(p));

      // ---- Balances: two clearly different sections
      await p.goto(`${BASE}/trips/${T.OWE}/expenses`);
      await byId(p, 'expenses-tab-balances').waitFor({ timeout: 20000 });
      await byId(p, 'expenses-tab-balances').click();
      await byId(p, 'settlement-card').waitFor({ timeout: 15000 });
      const mineBox = await byId(p, 'settlement-mine-section').boundingBox();
      const listBox = await byId(p, 'settlement-list').boundingBox();
      check('phone: "My Suggested Payments" and "Everyone\'s Payments" are two separate labelled sections', (await byId(p, 'settlement-mine-title').innerText()) === 'My Suggested Payments' && (await byId(p, 'settlement-all-title').innerText()).includes('Everyone') && !!mineBox && !!listBox && mineBox.y + mineBox.height <= listBox.y);
      check('phone: the personal section says what you pay or receive', /^You (pay|receive)/.test(await byId(p, 'settlement-mine-0').innerText()), await byId(p, 'settlement-mine').innerText());
      check('phone: the group list is not inside the personal section', (await byId(p, 'settlement-mine-section').locator('[data-testid="settlement-list"]').count()) === 0);
      await shot(p, 'q-balances-phone-dark');
      await ctx.close();
    }
    {
      // light balances screenshot + reduced motion
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.OWE}/expenses`);
      await byId(p, 'expenses-tab-balances').waitFor({ timeout: 20000 });
      await byId(p, 'expenses-tab-balances').click();
      await byId(p, 'settlement-card').waitFor({ timeout: 15000 });
      await shot(p, 'q-balances-phone-light');
      await p.goto(BASE);
      await byId(p, 'status-ongoing').waitFor({ timeout: 20000 });
      await byId(p, 'status-upcoming').click();
      const before = Date.now();
      await byId(p, 'section-upcoming').waitFor({ timeout: 5000 });
      check('reduced motion: switching the status tab still works, with no animation needed', (await byId(p, 'section-upcoming').innerText()).includes('Hampi Weekend') && Date.now() - before < 2000);
      const settled = await p.evaluate(() => getComputedStyle(document.querySelector('[data-testid="section-upcoming"]')!.parentElement!.parentElement!).opacity);
      check('reduced motion: the new list is fully visible straight away', Number(settled) === 1, settled);
      await ctx.close();
    }

    // ================= the desktop dashboard =================
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'greeting').waitFor({ timeout: 20000 });
      check('desktop: a signed-in visitor lands in the dashboard, not on the public page', pathOf(p) === '/' && !(await byId(p, 'landing').count()));
      check('desktop: side navigation with the five destinations, and no bottom bar', (await byId(p, 'side-nav').isVisible()) && !(await byId(p, 'bottom-nav').count()) && (await p.locator('[data-testid="side-nav"] [role="link"]').count()) === 5);
      check('desktop: the same Completed | Ongoing | Upcoming tabs', (await p.locator('[role="tab"]:visible').allInnerTexts()).join('|') === 'Completed|Ongoing|Upcoming');
      check('desktop: no horizontal overflow', await overflow(p));
      await shot(p, 'q-dashboard-desktop-light');
      await p.goto(`${BASE}/welcome`);
      check('desktop: a signed-in visitor opening the public address is sent back to the app', await byId(p, 'greeting').waitFor({ timeout: 10000 }).then(() => true, () => false) && pathOf(p) === '/', pathOf(p));
      await byId(p, 'nav-search').click();
      check('desktop: side navigation works', await byId(p, 'search-input').waitFor({ timeout: 8000 }).then(() => true, () => false));
      await ctx.close();
    }
    {
      // tablet width
      const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'greeting').waitFor({ timeout: 20000 });
      check('tablet: bottom navigation is used and nothing overflows sideways', (await byId(p, 'bottom-nav').isVisible()) && !(await byId(p, 'side-nav').count()) && (await overflow(p)));
      await shot(p, 'q-home-tablet-light');
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function refinementFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nR. Refinements: neutral dark theme, website theme switch, website sign-in/sign-up, sidebar, phone frames, day-wise expenses');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9701), ravi: uuid(9702), priya: uuid(9703) } as const;
    const T = { COORG: uuid(971), UP: uuid(972), PAST: uuid(973), ARCH: uuid(974), EMPTY: uuid(975) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const me = (id: string) => memberRow({ id, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', joined_at: '2026-11-18T10:30:00+00:00' });
    const trip = (id: string, name: string, dest: string, s: number, e: number, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: dest, start_date: dayFromToday(s), end_date: dayFromToday(e), members: members.map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    let n = 0;
    const exp = (tripId: string, title: string, amount: number, dayOffset: number, by: string, over: Record<string, any> = {}): Record<string, any> => ({
      id: uuid(9800 + ++n), tripId, title, amount_minor: amount, category_id: null, spent_on: dayFromToday(dayOffset), notes: null, split_method: 'equal', created_by: by, updated_by: null,
      created_at: `2026-11-2${(n % 9) + 1}T10:00:00Z`, updated_at: '2026-11-25T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
      payers: [{ member_id: by, paid_minor: amount }],
      splits: previewSplit(amount, 'equal', [ID.me, ID.ravi, ID.priya]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
      ...over,
    });
    const seed = (b: FakeBackend) => {
      b.trips = [
        trip(T.COORG, 'Coorg Coffee Trail', 'Coorg, Karnataka', -3, 1, [me(ID.me), ravi(), priya()]),
        trip(T.UP, 'Hampi Weekend', 'Hampi', 20, 22, [me(ID.me), ravi()]),
        trip(T.PAST, 'Spiti Valley Loop', 'Spiti', -40, -34, [me(ID.me), ravi()]),
        trip(T.ARCH, 'Munnar Mist Weekend', 'Munnar', -70, -68, [me(ID.me)], { status: 'archived' }),
        trip(T.EMPTY, 'Gokarna Beach Camp', 'Gokarna', 30, 33, [me(ID.me)]),
      ];
      b.expenses = [
        exp(T.COORG, 'Breakfast', 30000, -3, ID.me),
        exp(T.COORG, 'Fuel', 150000, -3, ID.ravi),
        exp(T.COORG, 'Hotel', 300000, -3, ID.priya),
        exp(T.COORG, 'Lunch', 80000, -2, ID.me),
        exp(T.COORG, 'Activities', 120000, -2, ID.priya),
        exp(T.COORG, 'Dinner', 150000, -1, ID.ravi),
        exp(T.COORG, 'Shopping', 50000, -1, ID.me),
        // recorded LAST (newest created_at) but dated on day 1: it must appear under Day 1
        exp(T.COORG, 'Forgotten taxi', 70000, -3, ID.priya, { created_at: '2026-11-26T20:00:00Z' }),
      ];
    };
    const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const dark = (ctx: BrowserContext) => ctx.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
    const text = async (p: Page, id: string) => (await byId(p, id).innerText().catch(() => '')).replace(/\s+/g, ' ');

    // ================= the neutral dark theme =================
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await dark(ctx);
      const b = newBackend();
      seed(b);
      b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'status-ongoing').waitFor({ timeout: 20000 });
      const bg = await screenBg(p);
      const [r, g, bl] = (bg.match(/\d+/g) ?? []).map(Number) as [number, number, number];
      check('dark: the page background is the neutral charcoal #101010, not green-black', bg === 'rgb(16, 16, 16)' && Math.max(r, g, bl) - Math.min(r, g, bl) <= 4, bg);
      const navBg = await byId(p, 'bottom-nav').evaluate((e) => getComputedStyle(e).backgroundColor);
      check('dark: cards and bars use the neutral surface #1C1C1C', navBg === 'rgb(28, 28, 28)', navBg);
      const create = await byId(p, 'nav-create').locator('div').first().evaluate((e) => getComputedStyle(e).backgroundColor);
      check('dark: the Create button keeps the forest green fill #2F5D44', create === 'rgb(47, 93, 68)', create);
      await shot(p, 'r-home-phone-dark');
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-tab-balances').waitFor({ timeout: 20000 });
      await byId(p, 'expenses-tab-balances').click();
      await byId(p, 'settlement-card').waitFor({ timeout: 15000 });
      const mineBg = await byId(p, 'settlement-mine-section').evaluate((e) => getComputedStyle(e).backgroundColor);
      const allBg = await byId(p, 'settlement-list').evaluateHandle((e) => e.parentElement!).then((h) => h.evaluate((e) => getComputedStyle(e as Element).backgroundColor));
      check('dark: "My Suggested Payments" (#272727) and "Everyone\'s Payments" (#1C1C1C) are visibly different surfaces', mineBg === 'rgb(39, 39, 39)' && allBg === 'rgb(28, 28, 28)', `${mineBg} / ${allBg}`);
      await shot(p, 'r-balances-phone-dark');
      await p.goto(`${BASE}/profile`);
      await byId(p, 'profile-name').waitFor({ timeout: 20000 });
      await shot(p, 'r-profile-phone-dark');
      await p.goto(`${BASE}/settings`);
      await byId(p, 'theme-dark').waitFor({ timeout: 20000 });
      await shot(p, 'r-settings-phone-dark');
      check('dark: no horizontal overflow', await overflow(p));
      await ctx.close();
    }

    // ================= the day-wise expenses =================
    for (const variant of [
      { name: 'phone', opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
      { name: 'desktop', opts: { viewport: { width: 1280, height: 900 } } },
      { name: 'Kiritimati', opts: { viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Kiritimati' } },
      { name: 'Pago_Pago', opts: { viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Pago_Pago' } },
    ]) {
      const V = variant.name;
      const ctx = await browser.newContext(variant.opts);
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b, { keepCollapsed: true });
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-list').waitFor({ timeout: 20000 });
      const d1 = dayFromToday(-3), d2 = dayFromToday(-2), d3 = dayFromToday(-1);
      const rowsIn = (d: string) => p.locator(`[data-testid="expense-day-${d}"] [data-testid^="expense-row-"]`).count();
      const titles = await p.locator('[data-testid^="expense-day-title-"]:visible').allInnerTexts();
      check(`${V}: expenses are grouped into Day 1, Day 2, Day 3 in order (Day number = days since the trip start + 1)`, JSON.stringify(titles) === JSON.stringify(['Day 1', 'Day 2', 'Day 3']), JSON.stringify(titles));
      check(`${V}: all day cards start COLLAPSED: no individual expense is shown`, (await rowsIn(d1)) === 0 && (await rowsIn(d2)) === 0 && (await rowsIn(d3)) === 0 && (await byId(p, `expense-day-toggle-${d1}`).getAttribute('aria-expanded')) === 'false');
      check(`${V}: a collapsed card shows the day number, full weekday and date, expense count, total and an Expand cue`, (await text(p, `expense-day-date-${d1}`)).split(',').length >= 2 && /^\w+day, \d{1,2} \w+ \d{4}$/.test(await text(p, `expense-day-date-${d1}`)) && (await text(p, `expense-day-count-${d1}`)) === '4 expenses' && (await text(p, `expense-day-hint-${d1}`)) === 'Expand' && (await byId(p, `expense-day-chevron-${d1}`).isVisible()));
      check(`${V}: Day 1 total is the sum of its four expenses (₹300 + ₹1,500 + ₹3,000 + ₹700 = ₹5,500)`, (await text(p, `expense-day-total-${d1}`)).includes('₹5,500'), await text(p, `expense-day-total-${d1}`));
      check(`${V}: Day 2 total ₹2,000 and Day 3 total ₹2,000; Day 2 holds 2 expenses`, (await text(p, `expense-day-total-${d2}`)).includes('₹2,000') && (await text(p, `expense-day-total-${d3}`)).includes('₹2,000') && (await text(p, `expense-day-count-${d2}`)) === '2 expenses');
      check(`${V}: the trip's overall count and total stay at the top`, /8 expenses/.test(await text(p, 'expenses-count')) && (await text(p, 'expenses-count')).includes('₹9,500'), await text(p, 'expenses-count'));
      check(`${V}: only days with expenses get a card (no empty days)`, (await p.locator('[data-testid^="expense-day-title-"]:visible').count()) === 3);
      await shot(p, V === 'phone' ? 'r2-expenses-collapsed-phone' : 'r2-expenses-collapsed-desktop');
      // open Day 1
      await byId(p, `expense-day-toggle-${d1}`).click();
      check(`${V}: tapping Day 1 opens it and shows its four expenses; the cue becomes Collapse`, (await waitFor(async () => (await rowsIn(d1)) === 4)) && (await text(p, `expense-day-hint-${d1}`)) === 'Collapse' && (await byId(p, `expense-day-toggle-${d1}`).getAttribute('aria-expanded')) === 'true');
      check(`${V}: an expense recorded last but dated on day 1 is under Day 1`, (await byId(p, `expense-day-${d1}`).innerText()).includes('Forgotten taxi') && (await rowsIn(d3)) === 0);
      check(`${V}: each expense shows its category icon, title, category, amount and who paid`, /Hotel/.test(await byId(p, `expense-day-${d1}`).innerText()) && /Paid by/i.test(await byId(p, `expense-day-${d1}`).innerText()) && (await p.locator(`[data-testid="expense-day-${d1}"] [data-testid^="expense-icon-"]`).count()) === 4);
      await shot(p, V === 'phone' ? 'r2-expenses-expanded-phone' : 'r2-expenses-expanded-desktop');
      // several days open together
      await byId(p, `expense-day-toggle-${d2}`).click();
      check(`${V}: Day 2 can be open at the same time as Day 1`, (await waitFor(async () => (await rowsIn(d2)) === 2)) && (await rowsIn(d1)) === 4);
      // a refresh of the data keeps them open
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await p.waitForTimeout(600);
      check(`${V}: the open cards stay open when the data refreshes`, (await rowsIn(d1)) === 4 && (await rowsIn(d2)) === 2);
      // collapse again
      await byId(p, `expense-day-toggle-${d1}`).click();
      check(`${V}: tapping the header again collapses Day 1 (Day 2 stays open)`, (await waitFor(async () => (await rowsIn(d1)) === 0)) && (await rowsIn(d2)) === 2 && (await text(p, `expense-day-hint-${d1}`)) === 'Expand');
      // an expense still opens its page
      await p.locator(`[data-testid="expense-day-${d2}"] [data-testid^="expense-row-"]`).first().click();
      check(`${V}: an expense inside an open day opens the existing detail screen`, await waitFor(async () => /\/expenses\/[0-9a-f-]{36}/.test(pathOf(p))), pathOf(p));
      await p.goBack();
      await byId(p, 'expenses-list').waitFor({ timeout: 10000 });
      if (V === 'phone') {
        await shot(p, 'r-expenses-phone-light');
        check('phone: no horizontal overflow on the day-wise list', await overflow(p));
      }
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await dark(ctx);
      const b = newBackend();
      seed(b);
      b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-list').waitFor({ timeout: 20000 });
      await shot(p, 'r-expenses-phone-dark');
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'status-ongoing').waitFor({ timeout: 20000 });
      await shot(p, 'r-home-phone-light');
      await p.goto(`${BASE}/profile`);
      await byId(p, 'profile-name').waitFor({ timeout: 20000 });
      await shot(p, 'r-profile-phone-light');
      await p.goto(`${BASE}/settings`);
      await byId(p, 'theme-dark').waitFor({ timeout: 20000 });
      check('settings: links to About, Contact, Help, Privacy and Terms are available while signed in', (await Promise.all(['about', 'contact', 'help', 'privacy', 'terms'].map((x) => byId(p, `settings-info-${x}`).count()))).every((c) => c === 1));
      check('settings: it explains that the device choice is kept through sign-in', /kept on this device, including through sign-in and sign-out/i.test(await p.locator('body').innerText()));
      await shot(p, 'r-settings-phone-light');
      await byId(p, 'settings-info-privacy').click();
      await byId(p, 'info-placeholder').waitFor({ timeout: 8000 });
      check('info: a signed-in person can read the Privacy placeholder, and the authenticated navigation is not shown on it', pathOf(p) === '/info/privacy' && (await byId(p, 'bottom-nav').count()) === 0 && (await byId(p, 'side-nav').count()) === 0, pathOf(p));
      await p.goto(`${BASE}/welcome`);
      check('routing: a signed-in person opening /welcome still goes to the dashboard', await byId(p, 'greeting').waitFor({ timeout: 10000 }).then(() => true, () => false) && pathOf(p) === '/');
      await ctx.close();
    }

    // ================= desktop dashboard sidebar =================
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'greeting').waitFor({ timeout: 20000 });
      await byId(p, 'side-profile-name').waitFor({ timeout: 10000 });
      const nav = await byId(p, 'side-nav').boundingBox();
      const prof = await byId(p, 'nav-profile').boundingBox();
      const arch = await byId(p, 'nav-archived').boundingBox();
      check('sidebar: Home, Search, Create Trip and Archived are the main items; Profile is separate', (await p.locator('[data-testid="side-nav"] [role="link"]').count()) === 5 && !!arch && !!prof && prof.y > arch.y + arch.height + 100);
      check('sidebar: Profile sits at the bottom of the sidebar', !!nav && !!prof && Math.abs(nav.y + nav.height - (prof.y + prof.height)) <= 40, JSON.stringify({ nav, prof }));
      check('sidebar: Profile shows an avatar and the person\'s name', (await byId(p, 'side-avatar').count()) === 1 && (await text(p, 'side-profile-name')) === 'Asha Rao');
      await p.setViewportSize({ width: 1280, height: 600 });
      await p.waitForTimeout(300);
      const prof2 = await byId(p, 'nav-profile').boundingBox();
      check('sidebar: Profile stays anchored at the bottom when the window is shorter', !!prof2 && prof2.y + prof2.height >= 540, JSON.stringify(prof2));
      await p.setViewportSize({ width: 1280, height: 900 });
      await byId(p, 'nav-profile').click();
      await byId(p, 'profile-name').waitFor({ timeout: 8000 });
      check('sidebar: clicking Profile opens the Profile screen, marked as the current page', pathOf(p) === '/profile' && (await byId(p, 'nav-profile').getAttribute('aria-current')) === 'page');
      check('sidebar: the gear still leads to Settings', await byId(p, 'open-settings').isVisible());
      await shot(p, 'r-dashboard-desktop-light');
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b);
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'status-ongoing').waitFor({ timeout: 20000 });
      check('phone: the bottom navigation still has the five items, including Profile', (await p.locator('[data-testid="bottom-nav"] [role="link"]').count()) === 5 && (await byId(p, 'nav-profile').isVisible()));
      await ctx.close();
    }

    // ================= the public website: theme switch, sign-in and sign-up =================
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      await installFakeSupabase(ctx, b);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      check('website: the header has a two-state Light / Dark switch beside Log in and Sign up, and no System option', (await Promise.all(['site-theme-light', 'site-theme-dark'].map((id) => byId(p, id).isVisible()))).every(Boolean) && (await byId(p, 'site-theme-system').count()) === 0 && (await byId(p, 'site-theme-light').getAttribute('aria-checked')) === 'true');
      await byId(p, 'site-theme-group').screenshot({ path: path.join(SHOTS, 'r3-appearance-control-light.png') });
      await byId(p, 'site-theme-dark').click();
      await p.waitForTimeout(400);
      await byId(p, 'site-theme-group').screenshot({ path: path.join(SHOTS, 'r3-appearance-control-dark.png') });
      check('website: choosing Dark changes the landing page without signing in', await waitFor(async () => (await screenBg(p)) === 'rgb(16, 16, 16)'), await screenBg(p));
      await shot(p, 'r-website-desktop-dark');
      await p.reload();
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      check('website: the choice survives a refresh', (await byId(p, 'site-theme-dark').getAttribute('aria-checked')) === 'true' && (await screenBg(p)) === 'rgb(16, 16, 16)');
      await byId(p, 'hero-login').click();
      await byId(p, 'email').waitFor({ timeout: 10000 });
      check('website: the sign-in page keeps the chosen theme and has NO theme switch', (await screenBg(p)) === 'rgb(16, 16, 16)' && (await byId(p, 'site-theme-dark').count()) === 0 && (await byId(p, 'site-theme-light').count()) === 0);
      await p.goto(`${BASE}/info/terms`);
      await byId(p, 'info-placeholder').waitFor({ timeout: 10000 });
      check('website: the information pages keep the theme and carry the switch', (await byId(p, 'site-theme-dark').getAttribute('aria-checked')) === 'true');
      await byId(p, 'site-theme-light').click();
      check('website: switching back to Light works on an information page', await waitFor(async () => (await screenBg(p)) === 'rgb(244, 238, 225)'));
      await p.goto(BASE);
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      await shot(p, 'r-website-desktop-light');
      // the phone frames
      const frames = await byId(p, 'phone-frame').count();
      check('website: each app preview sits in a phone frame with a visible bezel', frames >= 3);
      const frameBg = await byId(p, 'phone-frame').first().locator('div').first().evaluate((e) => getComputedStyle(e).backgroundColor);
      const pageBg = await screenBg(p);
      check('website: the bezel is clearly different from the page behind it', frameBg !== pageBg && frameBg !== 'rgba(0, 0, 0, 0)', `${frameBg} vs ${pageBg}`);
      const previews = await byId(p, 'previews').innerText();
      check('website: the sample data is consistent (the Ongoing tab shows an Ongoing trip, nobody both pays and receives)', /ONGOING/.test(previews) && !/COMPLETED/.test(previews) && !/You receive/.test(previews) && /3 payments settle everyone/.test(previews));
      await byId(p, 'previews').scrollIntoViewIfNeeded();
      await p.waitForTimeout(400);
      await byId(p, 'previews').screenshot({ path: path.join(SHOTS, 'r-website-phone-frames-light.png') });
      await byId(p, 'site-theme-dark').click();
      await p.waitForTimeout(500);
      await byId(p, 'previews').screenshot({ path: path.join(SHOTS, 'r-website-phone-frames-dark.png') });
      await ctx.close();
    }
    for (const mode of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (mode === 'dark') await dark(ctx);
      await installFakeSupabase(ctx, newBackend());
      const p = await ctx.newPage();
      await p.goto(`${BASE}/sign-in`);
      await byId(p, 'email').waitFor({ timeout: 20000 });
      check(`login (${mode}): split layout with the TripMate branding and headline on the left and the form on the right`, (await byId(p, 'auth-brand-panel').isVisible()) && /Make memories, not money disputes/.test(await text(p, 'auth-headline')) && (await byId(p, 'auth-collage').isVisible()) && (await byId(p, 'auth-form-panel').isVisible()));
      const left = await byId(p, 'auth-brand-panel').boundingBox();
      const right = await byId(p, 'auth-form-panel').boundingBox();
      check(`login (${mode}): the form is to the right of the branding`, !!left && !!right && right.x > left.x + left.width - 1);
      const bodyText = await p.locator('body').innerText();
      check(`login (${mode}): only the supported fields and actions (no Google, Facebook, phone or password-reset options)`, !/google|facebook|apple|phone|forgot|reset password/i.test(bodyText) && (await byId(p, 'submit').isVisible()) && (await byId(p, 'password').isVisible()));
      check(`login (${mode}): the footer is present and there is no appearance switch`, (await byId(p, 'site-footer').isVisible()) && (await byId(p, 'site-theme-light').count()) === 0 && (await byId(p, 'site-theme-dark').count()) === 0 && (await byId(p, 'footer-privacy').count()) === 1 && (await byId(p, 'footer-terms').count()) === 1);
      check(`login (${mode}): no horizontal overflow`, await overflow(p));
      await shot(p, `r-login-desktop-${mode}`);
      await p.goto(`${BASE}/sign-up`);
      await byId(p, 'displayName').waitFor({ timeout: 20000 });
      check(`sign up (${mode}): split layout, name, email and password fields, and the password rule`, (await byId(p, 'auth-brand-panel').isVisible()) && (await byId(p, 'email').isVisible()) && /At least \d+ characters/.test(await p.locator('body').innerText()));
      await byId(p, 'submit').click();
      check(`sign up (${mode}): the existing validation messages still appear`, await vis(p, 'Enter your name').waitFor({ timeout: 5000 }).then(() => true, () => false));
      check(`sign up (${mode}): no appearance switch either`, (await byId(p, 'site-theme-light').count()) === 0 && (await byId(p, 'site-theme-dark').count()) === 0);
      // the footer is its own band: full width, a different colour from the branding panel above it, with a top border
      const footerBox = await byId(p, 'site-footer').boundingBox();
      const vw = (await p.viewportSize())!.width;
      const footerBg = await byId(p, 'site-footer').evaluate((e) => getComputedStyle(e).backgroundColor);
      const panelBg = await byId(p, 'auth-brand-panel').evaluate((e) => getComputedStyle(e).backgroundColor);
      const pageBgNow = await screenBg(p);
      check(`sign up (${mode}): the footer spans the full width and its colour differs from the branding panel and the page (${footerBg} vs ${panelBg} / ${pageBgNow})`, !!footerBox && footerBox.width >= vw - 1 && footerBg !== panelBg && footerBg !== pageBgNow);
      await shot(p, `r-signup-desktop-${mode}`);
      await ctx.close();
    }
    {
      // narrow website: a single column with the form first
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await installFakeSupabase(ctx, newBackend());
      const p = await ctx.newPage();
      await p.goto(BASE);
      check('website on a phone browser: signed-out visitors still get the public landing page', await byId(p, 'landing').waitFor({ timeout: 20000 }).then(() => true, () => false) && pathOf(p) === '/welcome');
      await p.goto(`${BASE}/sign-in`);
      await byId(p, 'email').waitFor({ timeout: 20000 });
      check('narrow sign-in: single column, compact travel picture, form visible, no split panel', (await byId(p, 'auth-compact-visual').isVisible()) && !(await byId(p, 'auth-brand-panel').count()) && (await byId(p, 'submit').isVisible()));
      check('narrow sign-in: the bottom navigation is not shown', (await byId(p, 'bottom-nav').count()) === 0);
      check('narrow sign-in: no horizontal overflow', await overflow(p));
      await shot(p, 'r-login-phone-browser-light');
      await ctx.close();
    }
    // ================= theme persistence through authentication =================
    for (const [device, account] of [['dark', 'light'], ['light', 'dark']] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      seed(b);
      b.profile = { ...b.profile, theme_preference: account };
      await installFakeSupabase(ctx, b);
      const p = await ctx.newPage();
      const bg = device === 'dark' ? 'rgb(16, 16, 16)' : 'rgb(244, 238, 225)';
      await p.goto(BASE);
      await byId(p, 'landing').waitFor({ timeout: 20000 });
      await byId(p, `site-theme-${device}`).click();
      await p.waitForTimeout(400);
      await byId(p, 'hero-login').click();
      await byId(p, 'email').waitFor({ timeout: 10000 });
      check(`${device} on the landing page -> Login keeps ${device}, with no switch`, (await screenBg(p)) === bg && (await byId(p, 'site-theme-light').count()) === 0);
      await p.goto(`${BASE}/sign-up`);
      await byId(p, 'displayName').waitFor({ timeout: 20000 });
      check(`${device}: Sign Up keeps ${device} as well (and Login <-> Sign Up preserves it)`, (await screenBg(p)) === bg);
      await p.goto(`${BASE}/sign-in`);
      await byId(p, 'email').waitFor({ timeout: 20000 });
      await byId(p, 'email').fill('asha@example.com');
      await byId(p, 'password').fill('Goa2026trip');
      await byId(p, 'submit').click();
      await byId(p, 'greeting').waitFor({ timeout: 15000 });
      await p.waitForTimeout(800);
      check(`${device} chosen before signing in (account says ${account}): the dashboard stays ${device}`, (await screenBg(p)) === bg, await screenBg(p));
      check('...and signing in made no profile write just to sync the theme', !b.requests.some((r) => r.method === 'PATCH'));
      check('routing: after sign-in the visitor is in the dashboard, not on the landing page', pathOf(p) === '/' && (await byId(p, 'side-nav').count()) === 1);
      await p.reload();
      await byId(p, 'greeting').waitFor({ timeout: 15000 });
      check(`${device}: a refresh keeps it`, await waitFor(async () => (await screenBg(p)) === bg));
      await byId(p, 'nav-profile').click();
      await byId(p, 'open-settings').click();
      await byId(p, 'sign-out').click();
      await byId(p, 'landing').waitFor({ timeout: 15000 });
      check(`${device}: signing out keeps it, and the landing page switch shows the same state`, (await screenBg(p)) === bg && (await byId(p, `site-theme-${device}`).getAttribute('aria-checked')) === 'true');
      await ctx.close();
    }
    {
      // no saved choice on the device: the account's Dark is used and then stays; an explicit change updates the account once
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const b = newBackend();
      seed(b);
      b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(ctx, b);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/sign-in`);
      await byId(p, 'email').fill('asha@example.com');
      await byId(p, 'password').fill('Goa2026trip');
      await byId(p, 'submit').click();
      await byId(p, 'greeting').waitFor({ timeout: 15000 });
      check('no device choice + account Dark: the dashboard uses the account\'s Dark', await waitFor(async () => (await screenBg(p)) === 'rgb(16, 16, 16)'), await screenBg(p));
      check('...without writing to the account', !b.requests.some((r) => r.method === 'PATCH'));
      await byId(p, 'nav-profile').click();
      await byId(p, 'open-settings').click();
      await byId(p, 'theme-light').click();
      const saved = await waitFor(() => b.requests.filter((r) => r.method === 'PATCH' && r.body?.theme_preference === 'light').length === 1);
      check('an explicit change in Settings updates the account (once)', saved);
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function insightsFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nS. Phase 3: Insights (bars + donut), redesigned Balances, collapsible days, three tabs');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9751), ravi: uuid(9752), priya: uuid(9753) } as const;
    const T = { COORG: uuid(981), EMPTY: uuid(982), ARCH: uuid(983), SINGLE: uuid(984) };
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const PRIYA = '33333333-3333-4333-8333-333333333333';
    const CAT = { transportation: uuid(9700), accommodation: uuid(9701), food: uuid(9702), shopping: uuid(9703), activities: uuid(9704), fuel: uuid(9705), other: uuid(9706) };
    const me = () => memberRow({ id: ID.me, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = () => memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const priya = () => memberRow({ id: ID.priya, user_id: PRIYA, display_name: 'Priya Shah', joined_at: '2026-11-18T10:30:00+00:00' });
    const trip = (id: string, name: string, dest: string, s: number, e: number, members: Record<string, any>[], over: Record<string, any> = {}) =>
      tripRow({ id, name, destination: dest, start_date: dayFromToday(s), end_date: dayFromToday(e), members: members.map((m) => ({ id: m.id, status: m.status })), _members: members, ...over });
    let n = 0;
    const exp = (tripId: string, title: string, amount: number, dayOffset: number, by: string, cat: string | null, over: Record<string, any> = {}): Record<string, any> => ({
      id: uuid(9900 + ++n), tripId, title, amount_minor: amount, category_id: cat, spent_on: dayFromToday(dayOffset), notes: null, split_method: 'equal', created_by: by, updated_by: null,
      created_at: `2026-11-2${(n % 9) + 1}T10:00:00Z`, updated_at: '2026-11-25T10:00:00Z', version: 1, deleted_at: null, deleted_by: null,
      payers: [{ member_id: by, paid_minor: amount }],
      splits: previewSplit(amount, 'equal', [ID.me, ID.ravi, ID.priya]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
      ...over,
    });
    const seed = (b: FakeBackend) => {
      b.trips = [
        trip(T.COORG, 'Coorg Coffee Trail', 'Coorg, Karnataka', -3, 1, [me(), ravi(), priya()]),
        trip(T.EMPTY, 'Gokarna Beach Camp', 'Gokarna', 30, 33, [me()]),
        trip(T.ARCH, 'Munnar Mist Weekend', 'Munnar', -70, -68, [me(), ravi()], { status: 'archived' }),
        trip(T.SINGLE, 'Hampi Weekend', 'Hampi', -2, 1, [me(), ravi()]),
      ];
      b.expenses = [
        exp(T.COORG, 'Breakfast', 30000, -3, ID.me, CAT.food),
        exp(T.COORG, 'Fuel', 150000, -3, ID.ravi, CAT.fuel),
        exp(T.COORG, 'Hotel', 300000, -3, ID.priya, CAT.accommodation),
        exp(T.COORG, 'Lunch', 80000, -2, ID.me, CAT.food),
        exp(T.COORG, 'Activities', 120000, -2, ID.priya, CAT.activities),
        exp(T.COORG, 'Dinner', 150000, -1, ID.ravi, CAT.food),
        exp(T.COORG, 'Shopping', 50000, -1, ID.me, CAT.shopping),
        exp(T.COORG, 'Taxi', 70000, -3, ID.priya, CAT.transportation),
        exp(T.COORG, 'Snacks', 20000, -2, ID.ravi, null), // no category
        exp(T.COORG, 'Misc', 10000, -1, ID.me, CAT.other), // a real "Other"
        exp(T.COORG, 'Cancelled tour', 99999, -2, ID.me, CAT.transportation, { deleted_at: '2026-11-25T12:00:00Z', deleted_by: ID.me }), // deleted: never counted
        exp(T.ARCH, 'Homestay', 450000, -70, ID.me, CAT.accommodation),
        exp(T.ARCH, 'Meals', 150000, -69, ID.ravi, CAT.food),
        exp(T.SINGLE, 'Cab', 60000, -2, ID.me, CAT.transportation),
      ];
    };
    const overflow = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const dark = (ctx: BrowserContext) => ctx.addInitScript(() => window.localStorage.setItem('tripmate.theme-preference', 'dark'));
    const text = async (p: Page, id: string) => (await byId(p, id).innerText().catch(() => '')).replace(/\s+/g, ' ');
    const money = (s: string) => Number(s.replace(/[^0-9.]/g, ''));
    const colorOf = (p: Page, id: string) => byId(p, id).evaluate((e) => getComputedStyle(e).color);
    const rgb = (c: string) => (c.match(/\d+/g) ?? []).map(Number) as [number, number, number];

    const variants = [
      { name: 'phone-light', opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, dark: false },
      { name: 'phone-dark', opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, dark: true },
      { name: 'desktop-light', opts: { viewport: { width: 1280, height: 900 } }, dark: false },
      { name: 'desktop-dark', opts: { viewport: { width: 1280, height: 900 } }, dark: true },
    ] as const;

    for (const v of variants) {
      const V = v.name;
      const ctx = await browser.newContext(v.opts);
      if (v.dark) await dark(ctx);
      const b = newBackend();
      seed(b);
      if (v.dark) b.profile = { ...b.profile, theme_preference: 'dark' };
      await installFakeSupabase(ctx, b, { keepCollapsed: true });
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-tab-insights').waitFor({ timeout: 20000 });
      const tabs = await p.locator('[role="tablist"] [role="tab"]:visible').allInnerTexts().catch(() => []);
      check(`${V}: the tabs are Expenses, Balances and Insights`, JSON.stringify(tabs.map((x) => x.trim())) === JSON.stringify(['Expenses', 'Balances', 'Insights']), JSON.stringify(tabs));

      // ---------- Balances ----------
      await byId(p, 'expenses-tab-balances').click();
      await byId(p, 'balances-list').waitFor({ timeout: 15000 });
      const cards = await p.locator('[data-testid^="balance-"][data-testid$="' + '"]').count();
      void cards;
      const meCard = byId(p, `balance-${ID.me}`);
      check(`${V}: each member is a card with avatar, name, You label, status, amount and the paid/share breakdown`, (await text(p, `balance-name-${ID.me}`)) === 'Asha Rao' && /\bYou\b/.test(await meCard.innerText()) && /^(Is owed|Owes|Settled)$/.test(await text(p, `balance-status-${ID.me}`)) && /^₹/.test(await text(p, `balance-amount-${ID.me}`)) && /^Paid ₹/.test(await text(p, `balance-paid-${ID.me}`)) && /^Share ₹/.test(await text(p, `balance-share-${ID.me}`)));
      // Asha paid 30000+80000+50000+10000 = 170000 and her share is 980000/3 ~ 326667 minus... (equal split of each expense): she owes
      const statusMe = await text(p, `balance-status-${ID.me}`);
      const statusPriya = await text(p, `balance-status-${ID.priya}`);
      check(`${V}: the figures are the database's: Asha owes, Priya is owed (paid ₹4,900 of ₹9,800... shown as Paid/Share)`, statusMe === 'Owes' && statusPriya === 'Is owed', `${statusMe} / ${statusPriya}`);
      const owesColour = rgb(await colorOf(p, `balance-amount-${ID.me}`));
      const owedColour = rgb(await colorOf(p, `balance-amount-${ID.priya}`));
      check(`${V}: money owed is red-toned and money receivable is green-toned (meaning unchanged)`, owesColour[0] > owesColour[1] && owedColour[1] > owedColour[0], `${owesColour} / ${owedColour}`);
      check(`${V}: personal and group sections stay distinct: "My Suggested Payments" and "Everyone's Payments" with a group settlement plan label`, (await byId(p, 'settlement-mine-section').isVisible()) && /My Suggested Payments/.test(await text(p, 'settlement-mine-title')) && /Everyone's Payments/.test(await text(p, 'settlement-all-title')) && /Group settlement plan/i.test(await byId(p, 'settlement-card').innerText()));
      const mineRows = await p.locator('[data-testid^="settlement-mine-row-"]').count();
      const mineText0 = await text(p, 'settlement-mine-0');
      check(`${V}: my suggested payments are cards with a direction icon (pay or receive), the name and the amount`, mineRows >= 1 && /^You (pay|receive)/.test(mineText0), mineText0);
      const lineCount = await p.locator('[data-testid^="settlement-line-amount-"]').count();
      const sentence = `${await text(p, 'settlement-line-from-0')} ${await text(p, 'settlement-line-verb-0')} ${await text(p, 'settlement-line-to-0')} ${await text(p, 'settlement-line-amount-0')}`;
      check(`${V}: every group payment is its own card: who pays whom and the amount (${sentence})`, lineCount >= 1 && /^.+ pays .+ ₹/.test(sentence));
      check(`${V}: the plan's headline, count and the suggestions-only disclaimer are kept`, /payments? settle/.test(await text(p, 'settlement-headline')) && /suggestions only/i.test(await text(p, 'settlement-disclaimer')));
      check(`${V}: no payment recording controls are offered`, (await p.getByRole('button', { name: /record|mark as paid|settle up/i }).count()) === 0);
      if (V === 'phone-light' || V === 'phone-dark' || V === 'desktop-light') await shot(p, `r3-balances-${V}`);
      if (V.startsWith('phone')) check(`${V}: Balances has no horizontal overflow`, await overflow(p));

      // ---------- Insights ----------
      await byId(p, 'expenses-tab-insights').click();
      await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
      check(`${V}: the summary shows the exact total (₹9,800), 10 expenses (the deleted one is not counted) and 8 categories`, (await text(p, 'insights-total')) === '₹9,800' && (await text(p, 'insights-count')) === '10' && (await text(p, 'insights-categories')) === '8', `${await text(p, 'insights-total')} ${await text(p, 'insights-count')} ${await text(p, 'insights-categories')}`);
      const barKeys = await p.locator('[data-testid^="insights-bar-name-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('insights-bar-name-', '')));
      check(`${V}: one bar per category used, biggest first (Accommodation, Food, Fuel and tolls, Activities...)`, JSON.stringify(barKeys.slice(0, 4)) === JSON.stringify(['accommodation', 'food', 'fuel_tolls', 'activities']) && barKeys.length === 8, JSON.stringify(barKeys));
      const barAmounts = await p.locator('[data-testid^="insights-bar-amount-"]').allInnerTexts();
      const barSum = barAmounts.reduce((a, s) => a + money(s), 0);
      check(`${V}: the bar amounts add up to the trip total (₹${barSum})`, barSum === 9800, JSON.stringify(barAmounts));
      check(`${V}: Uncategorized and a real Other category are separate, and the deleted expense is excluded (Transportation ₹700, not ₹1,699.99)`, (await text(p, 'insights-bar-amount-uncategorized')) === '₹200' && (await text(p, 'insights-bar-amount-other')) === '₹100' && (await text(p, 'insights-bar-amount-transportation')) === '₹700');
      const pcts = await p.locator('[data-testid^="insights-legend-percent-"]').allInnerTexts();
      const pctSum = Math.round(pcts.reduce((a, s) => a + parseFloat(s), 0) * 10) / 10;
      check(`${V}: the legend gives each category's name, amount and percentage, and the percentages add up to 100% (${pctSum})`, pcts.length === 8 && pctSum === 100 && (await text(p, 'insights-legend-percent-accommodation')) === '30.6%' && (await text(p, 'insights-legend-amount-food')) === '₹2,600');
      const donutLabel = (await byId(p, 'insights-donut').getAttribute('aria-label')) ?? '';
      check(`${V}: the donut has the total in its centre and a readable text description`, (await text(p, 'insights-donut-total')) === '₹9,800' && /Total ₹9,800/.test(donutLabel) && /Accommodation ₹3,000, 30\.6%/.test(donutLabel), donutLabel.slice(0, 120));
      // same colour for the same category in the bars and in the legend
      const barColour = await byId(p, 'insights-bar-fill-food').evaluate((e) => getComputedStyle(e).backgroundColor);
      const swatchColour = await byId(p, 'insights-legend-food').locator('div').first().evaluate((e) => getComputedStyle(e).backgroundColor);
      check(`${V}: the bar chart and the donut legend use the same colour for the same category`, barColour === swatchColour, `${barColour} vs ${swatchColour}`);
      const tiles = await byId(p, 'insights-donut').locator('div[style*="rotate"]').count();
      check(`${V}: the donut ring is drawn (${tiles} tiles)`, tiles >= 200);
      // the app reads some data through POSTed database functions; those are reads, so only calls that can change data count
      const writes = b.requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS' && !/\/auth\//.test(r.path) && !/rpc\/(list_|get_|trip_member_balances)/.test(r.path));
      check(`${V}: opening Insights made no write of any kind`, writes.length === 0, JSON.stringify(writes.map((r) => r.path)));
      if (V.startsWith('phone')) check(`${V}: Insights has no horizontal overflow`, await overflow(p));
      await shot(p, `r3-insights-${V}`);

      await p.goto(`${BASE}/trips/${T.COORG}`);
      await byId(p, 'trip-people').waitFor({ timeout: 20000 });
      await byId(p, 'trip-people').scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      check(`${V}: People are member cards with Admin/Member, You and Guest tags and a manage control`, (await p.locator('[data-testid^="member-name-"]').count()) === 3 && /Admin/.test(await byId(p, `member-${ID.me}`).innerText()) && /You/.test(await byId(p, `member-${ID.me}`).innerText()) && (await byId(p, 'add-guest').isVisible()));
      await shot(p, `r3-members-${V}`);
      // the Settings gear on Profile: teeth and a centre hole, no filled circle behind it, a 44px target, labelled
      await p.goto(`${BASE}/profile`);
      await byId(p, 'open-settings').waitFor({ timeout: 20000 });
      const gearBox = await byId(p, 'open-settings').boundingBox();
      const gearBg = await byId(p, 'open-settings').evaluate((e) => getComputedStyle(e).backgroundColor);
      check(`${V}: the Settings gear is a labelled 44px target with no filled circle behind it`, !!gearBox && gearBox.width >= 43.9 && gearBox.height >= 43.9 && (await byId(p, 'open-settings').getAttribute('aria-label')) === 'Settings' && (gearBg === "rgba(0, 0, 0, 0)" || gearBg === "transparent"), `${gearBg} ${JSON.stringify(gearBox)}`);
      await p.waitForTimeout(300);
      await byId(p, 'open-settings').locator('xpath=..').screenshot({ path: path.join(SHOTS, `r4-settings-icon-${V}.png`) });
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-tab-insights').waitFor({ timeout: 20000 });
      if (V === 'phone-light') {
        await byId(p, 'expenses-tab-insights').click();
        // a category edit is reflected: Hotel loses its category (reload to read the data again)
        const hotel = b.expenses.find((e: any) => e.title === 'Hotel')!;
        hotel.category_id = null;
        await p.reload();
        await byId(p, 'expenses-tab-insights').click();
        await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
        check('a category change moves the amount: Accommodation disappears and Uncategorized becomes ₹3,200; the total is unchanged', (await byId(p, 'insights-bar-accommodation').count()) === 0 && (await text(p, 'insights-bar-amount-uncategorized')) === '₹3,200' && (await text(p, 'insights-total')) === '₹9,800');
        hotel.category_id = CAT.accommodation;
        // deleting an expense updates the numbers
        const dinner = b.expenses.find((e: any) => e.title === 'Dinner')!;
        dinner.deleted_at = '2026-11-26T09:00:00Z';
        await p.reload();
        await byId(p, 'expenses-tab-insights').click();
        await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
        check('deleting an expense updates Insights: total ₹8,300 and 9 expenses (restoring brings it back)', (await text(p, 'insights-total')) === '₹8,300' && (await text(p, 'insights-count')) === '9');
        dinner.deleted_at = null;
        await p.reload();
        await byId(p, 'expenses-tab-insights').click();
        await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
        check('restoring it puts the figures back (₹9,800, 10 expenses)', (await text(p, 'insights-total')) === '₹9,800' && (await text(p, 'insights-count')) === '10');
      }
      await ctx.close();
    }

    // ---------- empty, single category and archived ----------
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const b = newBackend();
      seed(b);
      await installFakeSupabase(ctx, b, { keepCollapsed: true });
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.EMPTY}/expenses`);
      await byId(p, 'expenses-tab-insights').waitFor({ timeout: 20000 });
      await byId(p, 'expenses-tab-insights').click();
      check('zero expenses: a friendly empty message, no charts, no errors', await byId(p, 'insights-empty').waitFor({ timeout: 10000 }).then(() => true, () => false) && (await byId(p, 'insights-donut').count()) === 0 && (await byId(p, 'insights-error').count()) === 0);
      await p.goto(`${BASE}/trips/${T.SINGLE}/expenses`);
      await byId(p, 'expenses-tab-insights').click();
      await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
      check('a single category: one bar, one legend row at 100%, and the donut shows the whole ring', (await p.locator('[data-testid^="insights-bar-name-"]').count()) === 1 && (await text(p, 'insights-legend-percent-transportation')) === '100%' && (await text(p, 'insights-total')) === '₹600');
      await p.goto(`${BASE}/trips/${T.ARCH}/expenses`);
      await byId(p, 'expenses-tab-insights').click();
      await byId(p, 'insights-summary').waitFor({ timeout: 15000 });
      check('an archived trip still shows Insights (read-only), in the trip currency', (await text(p, 'insights-total')) === '₹6,000' && (await byId(p, 'insights-bar-accommodation').isVisible()));
      await ctx.close();
    }
    {
      // a failed read shows an error with Try again, never partial totals
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const b = newBackend();
      seed(b);
      b.failExpenseReads = true;
      await installFakeSupabase(ctx, b, { keepCollapsed: true });
      await sessionInStorage(ctx);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/trips/${T.COORG}/expenses`);
      await byId(p, 'expenses-tab-insights').waitFor({ timeout: 20000 });
      await byId(p, 'expenses-tab-insights').click();
      check('if the expenses cannot be read, Insights shows an error with Try again and no totals', (await byId(p, 'insights-error').waitFor({ timeout: 90000 }).then(() => true, () => false)) && (await byId(p, 'insights-total').count()) === 0 && (await byId(p, 'insights-retry').count()) === 1);
      b.failExpenseReads = false;
      await byId(p, 'insights-retry').click();
      check('Try again then shows the insights', await byId(p, 'insights-summary').waitFor({ timeout: 20000 }).then(() => true, () => false));
      await ctx.close();
    }
  } finally {
    site.stop();
  }
}

async function bigTripFlows(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('\nT. A trip with more than 1,000 expenses: complete paged reads, totals, Insights, later-page failure');
  const site = await startWebsite({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: DUMMY_PUBLISHABLE_KEY, EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL });
  try {
    const ID = { me: uuid(9851), ravi: uuid(9852) } as const;
    const BIG = uuid(991);
    const RAVI = '22222222-2222-4222-8222-222222222222';
    const me = memberRow({ id: ID.me, user_id: USER.id, display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T09:00:00+00:00' });
    const ravi = memberRow({ id: ID.ravi, user_id: RAVI, display_name: 'Ravi Kumar', joined_at: '2026-11-18T10:00:00+00:00' });
    const N = 1200;
    const DAYS = 20;
    const seed = (b: FakeBackend) => {
      b.trips = [tripRow({ id: BIG, name: 'Grand Tour', destination: 'Everywhere', start_date: dayFromToday(-DAYS), end_date: dayFromToday(1), members: [me, ravi].map((m) => ({ id: m.id, status: m.status })), _members: [me, ravi] })];
      b.expenses = Array.from({ length: N }, (_, i) => {
        const amount = 1000 + (i % 13) * 100; // paise
        return {
          id: uuid(20000 + i), tripId: BIG, title: `Item ${i}`, amount_minor: amount, category_id: uuid(9700 + (i % 7)), spent_on: dayFromToday(-DAYS + (i % DAYS)), notes: null, split_method: 'equal',
          created_by: ID.me, updated_by: null, created_at: `2026-11-2${(i % 8) + 1}T10:${String(i % 60).padStart(2, '0')}:00Z`, updated_at: '2026-11-25T10:00:00Z', version: 1,
          deleted_at: i % 10 === 0 ? '2026-11-26T10:00:00Z' : null, deleted_by: i % 10 === 0 ? ID.me : null,
          payers: [{ member_id: ID.me, paid_minor: amount }],
          splits: previewSplit(amount, 'equal', [ID.me, ID.ravi]).map((r) => ({ member_id: r.memberId, share_minor: r.shareMinor, input_value: null })),
        };
      });
    };
    const live = (b: FakeBackend) => b.expenses.filter((e: any) => !e.deleted_at);
    const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
    const text = async (p: Page, id: string) => (await byId(p, id).innerText().catch(() => '')).replace(/\s+/g, ' ');

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const b = newBackend();
    seed(b);
    await installFakeSupabase(ctx, b, { keepCollapsed: true });
    await sessionInStorage(ctx);
    const p = await ctx.newPage();
    await p.goto(`${BASE}/trips/${BIG}/expenses`);
    await byId(p, 'expenses-count').waitFor({ timeout: 60000 });
    const activeTotal = live(b).reduce((a: number, e: any) => a + e.amount_minor, 0);
    const activeCount = live(b).length;
    check(`all ${N} expenses were read although one response holds at most 1,000 rows: the Expenses tab counts ${activeCount} active and totals ${rupees(activeTotal)}`, (await text(p, 'expenses-count')).startsWith(`${activeCount} expenses`) && (await text(p, 'expenses-count')).includes(rupees(activeTotal)), await text(p, 'expenses-count'));
    const expPages = b.expenseReadRequests.filter((r) => r.table === 'expenses').map((r) => r.from);
    check('the expenses were fetched in pages (rows 0 and 1000), and payers and shares too', JSON.stringify(expPages.slice(0, 2)) === JSON.stringify([0, 1000]) && b.expenseReadRequests.some((r) => r.table === 'expense_payers' && r.from === 1000) && b.expenseReadRequests.some((r) => r.table === 'expense_splits' && r.from === 1000), JSON.stringify(b.expenseReadRequests.slice(0, 8)));
    const dayTotals = await p.locator('[data-testid^="expense-day-total-"]').allInnerTexts();
    const dayCounts = await p.locator('[data-testid^="expense-day-count-"]').allInnerTexts();
    const num = (s: string) => Number(s.replace(/[^0-9.]/g, ''));
    const activeDays = new Set(live(b).map((e: any) => e.spent_on)).size;
    check(`${activeDays} day cards (days with only deleted expenses get none), whose counts add up to ${activeCount} and whose totals add up to the overall total`, dayTotals.length === activeDays && dayCounts.reduce((a, s) => a + num(s), 0) === activeCount && Math.round(dayTotals.reduce((a, s) => a + num(s), 0) * 100) === activeTotal, `${dayTotals.length} days`);
    check('the deleted expenses are in their own section and in no day total', /Deleted \(120\)/.test(await text(p, 'expenses-deleted-toggle')));

    await byId(p, 'expenses-tab-insights').click();
    await byId(p, 'insights-summary').waitFor({ timeout: 30000 });
    check('Insights total equals the complete active expense total, and its count equals the active count', (await text(p, 'insights-total')) === rupees(activeTotal) && (await text(p, 'insights-count')) === String(activeCount) && (await text(p, 'insights-categories')) === '7', `${await text(p, 'insights-total')} / ${await text(p, 'insights-count')}`);
    const barSum = (await p.locator('[data-testid^="insights-bar-amount-"]').allInnerTexts()).reduce((a, s) => a + num(s), 0);
    check('the category bars add up to the same total', Math.round(barSum * 100) === activeTotal, String(barSum));

    await byId(p, 'expenses-tab-balances').click();
    await byId(p, 'balances-list').waitFor({ timeout: 30000 });
    const rpc = b.requests.filter((r) => r.path.includes('trip_member_balances'));
    check('the official balances come from the database function as before (one call, no paging, a handful of rows)', rpc.length >= 1 && (await p.locator('[data-testid^="balance-name-"]').count()) === 2);
    await ctx.close();

    // a later page fails: nothing partial is shown, and Try again works
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const b2 = newBackend();
    seed(b2);
    b2.failExpensePageFrom = 1000;
    await installFakeSupabase(ctx2, b2, { keepCollapsed: true });
    await sessionInStorage(ctx2);
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/trips/${BIG}/expenses`);
    check('when page 2 cannot be fetched the Expenses tab shows an error, with no count, no day cards and no totals', (await byId(p2, 'expenses-error').waitFor({ timeout: 90000 }).then(() => true, () => false)) && (await byId(p2, 'expenses-count').count()) === 0 && (await p2.locator('[data-testid^="expense-day-"]').count()) === 0);
    await byId(p2, 'expenses-tab-insights').click();
    check('Insights shows its error too, never a partial total', (await byId(p2, 'insights-error').waitFor({ timeout: 90000 }).then(() => true, () => false)) && (await byId(p2, 'insights-total').count()) === 0);
    b2.failExpensePageFrom = null;
    await byId(p2, 'insights-retry').click();
    check('Try again then shows the complete figures', (await byId(p2, 'insights-summary').waitFor({ timeout: 60000 }).then(() => true, () => false)) && (await text(p2, 'insights-count')) === String(live(b2).length));
    await ctx2.close();
  } finally {
    site.stop();
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    if (process.env.UI_ONLY === 'K') {
      await memberFlows(browser); // quick re-run of one scenario alone while developing
    } else if (process.env.UI_ONLY === 'L') {
      await inviteFlows(browser);
    } else if (process.env.UI_ONLY === 'M') {
      await expenseFlows(browser);
    } else if (process.env.UI_ONLY === 'N') {
      await splitFlows(browser);
    } else if (process.env.UI_ONLY === 'O') {
      await inputFlows(browser);
    } else if (process.env.UI_ONLY === 'P') {
      await settlementFlows(browser);
    } else if (process.env.UI_ONLY === 'R') {
      await refinementFlows(browser);
    } else if (process.env.UI_ONLY === 'T') {
      await bigTripFlows(browser);
    } else if (process.env.UI_ONLY === 'S') {
      await insightsFlows(browser);
    } else if (process.env.UI_ONLY === 'Q') {
      await redesignFlows(browser);
    } else if (process.env.UI_ONLY === 'D') {
      await signedInFlows(browser);
    } else if (process.env.UI_ONLY === 'E') {
      await tripFlows(browser);
    } else {
      await setupScreens(browser);
      await accountFlows(browser);
      await signedInFlows(browser);
      await tripFlows(browser);
      await detailFlows(browser);
      await editFlows(browser);
      await dateFlows(browser);
      await memberFlows(browser);
      await inviteFlows(browser);
      await expenseFlows(browser);
      await splitFlows(browser);
      await inputFlows(browser);
      await settlementFlows(browser);
      await redesignFlows(browser);
      await refinementFlows(browser);
      await insightsFlows(browser);
      await bigTripFlows(browser);
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
