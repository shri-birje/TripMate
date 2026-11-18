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
  /** Set to make the fake server wrongly send former members too (the app must still not show them). */
  leakFormerMembers: boolean;
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
    leakFormerMembers: false,
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
        const activeOnly = url.searchParams.get('trip_members.status') === 'eq.active' && !backend.leakFormerMembers;
        const members = (found._members as Record<string, any>[]).filter((m) => !activeOnly || m.status === 'active');
        return json(200, [{ ...publicRow(found), trip_members: members }]); // arrays, exactly as the real server answers
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
          memberRow({ id: 'g4', user_id: '44444444-4444-4444-8444-444444444444', display_name: 'Removed Rahul', status: 'removed' }),
          memberRow({ id: 'g5', user_id: '55555555-5555-4555-8555-555555555555', display_name: 'Departed Dev', status: 'left' }),
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
    check('former members (removed, left) are not shown', !/Removed Rahul|Departed Dev/.test(all));
    check('privacy: no email addresses or UPI IDs anywhere on the page', !/@|example\.com|okhdfcbank|upi/i.test(all.replace(/\bTripMate\b/g, '')), all.slice(0, 200));
    const req = detailRequests(GOA)[0];
    const decoded = decodeURIComponent(req?.path ?? '').replace(/\+/g, ' ');
    check('the request names its columns (no "select everything")', !!req && !decoded.includes('select=*') && decoded.includes('display_name') && decoded.includes('trip_members('), decoded.slice(0, 160));
    check('the request asks only for CURRENT members', decoded.includes('trip_members.status=eq.active'), decoded);
    check('the request never touches profiles or emails', !/profiles|email|upi/i.test(decoded));
    check('it carries the user\'s login, not a secret key', !!req?.auth?.startsWith('Bearer ') && !req.auth.includes('sb_secret'));
    await shot(page, 'details-light');

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

    // ---- a misbehaving server cannot make former members appear
    backend.leakFormerMembers = true;
    await open(GOA);
    check('even if the server wrongly sent former members, they are not shown', !/Removed Rahul|Departed Dev/.test(await body()) && (await vis(page, 'People (3)').isVisible()));
    backend.leakFormerMembers = false;

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

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await setupScreens(browser);
    await accountFlows(browser);
    await signedInFlows(browser);
    await tripFlows(browser);
    await detailFlows(browser);
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
