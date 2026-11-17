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
  };
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
    ...over,
  };
}

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
      if (backend.failTripsList) return route.abort('connectionfailed');
      return json(200, backend.trips);
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
      const { members: _members, ...plain } = created;
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

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    await setupScreens(browser);
    await accountFlows(browser);
    await signedInFlows(browser);
    await tripFlows(browser);
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
