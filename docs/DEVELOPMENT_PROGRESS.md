# TripMate — Development Progress

Last updated: 2026-11-18

Rule: a feature is **Complete** only when it works **and has been tested**. "Code written" is not complete. Each milestone stops for your approval before the next begins.

---

## Status summary

| Milestone | Status |
|---|---|
| **M0 — Project foundation** | ✅ **Complete (approved 2026-11-17)** |
| **M1 — Core money engine (`packages/core`)** | ✅ **Complete (approved 2026-11-17)** |
| **M2 — Accounts, profiles, theme** | ✅ **Complete** (live check passed and approved 2026-11-18; committed and pushed as `f90d1a6`) |
| **M3 — Trips and members** | 🔵 **In progress, 5 small features** (see M3 plan): **M3.1 Create a trip ✅ complete (approved 2026-11-18)**; **M3.2 View trip details ✅ complete (live-verified and approved 2026-11-18)**; M3.3-M3.5 not started |
| M4 — Invites + guest claim | Not started |
| M5 — Expenses + split types | Not started |
| M6 — Balances + settlement plan | Not started |
| M7 — Repayment lifecycle | Not started |
| M8 — Dashboard, activity feed, basic budgets | Not started |
| M9 — Web layouts, dark mode, polish | Not started |
| M10 — Hardening + live deployment | Not started |

---

## M0 — Project foundation

### What was built
- npm-workspaces monorepo: `apps/api`, `apps/app`, `packages/core`.
- **API** (Hono): `GET /v1/health`, validated configuration, central error handler with the standard error body, request ids, CORS allow-list, security headers, JSON access logs, and a database-reachability check (reports `not_configured` until Supabase exists).
- **Shared contract** in `packages/core`: `HealthResponseSchema` (Zod), used by the server to build its response and by the app to validate it.
- **App** (Expo + Expo Router, one codebase for web and mobile): one temporary screen that calls the API and shows the result, with loading, success and error states. First slice of design tokens (light palette only).
- Environment structure: `.env.example` files (names only); real `.env` files are git-ignored.

### What was tested (all run, results observed)
| Check | Result |
|---|---|
| Type-check, all 3 packages | Clean |
| Unit/integration tests | **31 passing** (API 17, app 10, core 4) |
| API over real HTTP (`curl`) | 200 + valid JSON; standard 404 body; CORS allowed for configured origin, absent for an unknown origin; one JSON log line per request |
| Web dev server serves the app | Yes — page renders in headless Edge, shows "Server is running" from the live API |
| API down | App shows red status, plain message, the URL tried and the command to start the API |
| Production web build (`expo export`) | Succeeds |
| `npm audit` | 0 vulnerabilities in API/core/tooling; 3 moderate remain in Expo's own build tooling (see Known issues) |
| Secrets check | No `.env` files would be committed |

### Files created
Root: `package.json`, `tsconfig.base.json`, `.gitignore`, `README.md`.
`packages/core/`: `package.json`, `tsconfig.json`, `src/index.ts`, `src/health.ts`, `src/health.test.ts`.
`apps/api/`: `package.json`, `tsconfig.json`, `.env.example`, `src/{app,config,database,errors,logger,server}.ts`, `src/routes/health.ts`, `src/app.test.ts`.
`apps/app/`: `package.json`, `app.json`, `tsconfig.json`, `metro.config.js`, `.env.example`, `assets/` (Expo placeholder icons), `src/app/{_layout,index}.tsx`, `src/lib/{api,config}.ts`, `src/lib/api.test.ts`, `src/theme/tokens.ts`.
`docs/`: this file and updates to `ARCHITECTURE_DECISIONS_LOG.md`.

### Key technical decisions (also in the decisions log)
- **Free-only rule** (your instruction) changed several choices — see decisions log ADR-019 to ADR-022.
- **npm workspaces instead of pnpm** (pnpm isn't installed and Expo + pnpm needs extra configuration).
- **API runs on Node locally with Hono** instead of Supabase Edge Functions: Docker is not installed (needed for local Supabase), and Hono also deploys to free hosts such as Cloudflare Workers.
- **Zod 4** (Zod 3 had a reported memory-exhaustion vulnerability).
- **`metro.config.js`** added: without it the dev server could not find the shared `@tripmate/core` package through Windows symlinks (found and fixed during testing).

### How to test it yourself (VS Code terminal, from `E:\TripMate`)
```powershell
npm install                 # once
npm run typecheck           # expect no errors
npm test                    # expect 31 passing

# Terminal 1 - start the API
npm run api:dev             # prints {"msg":"api_started","port":8787,...}

# Terminal 2 - start the website
npm run app:web             # opens http://localhost:8081
```
Open http://localhost:8787/v1/health in a browser: you should see JSON with `"status":"ok"`.
Open http://localhost:8081: you should see "TripMate" and a green "Server is running". Stop the API (Ctrl+C in terminal 1) and press "Check again": you should see the red message.

### Known limitations / not done yet
- Placeholder screen only; no navigation, accounts, trips or data.
- No database yet (needs a free Supabase project — see blockers).
- Only the light palette exists; Dark/System themes come in a later milestone.
- Not tested on a real phone or emulator yet (web only). Headless-browser screenshots at phone width were cropped by the browser's minimum window size, so a true 420 px viewport has not been checked.
- No ESLint/Prettier yet (type-checking and tests only).
- Assets are Expo's placeholder icons.
- No CI yet.

### Known issues
- `npm audit` shows 3 moderate findings (minimatch denial-of-service) inside Expo's build tooling (`@expo/fingerprint`). It is not shipped in the app and the suggested "fix" downgrades Expo to SDK 52, so it is intentionally not applied. Re-check when Expo publishes an update.

### Blockers / prerequisites for upcoming milestones
| Needed | For | Free? |
|---|---|---|
| GitHub account + repository (to push code) | Version control, CI | Free |
| Supabase account with a free **dev** project (URL + keys) | M2 onward (auth, database) | Free tier |
| A second free Supabase project (staging) | Before deployment | Free tier |
| Expo account | Mobile builds later | Free tier |
| Expo Go app on your phone | Testing on a real phone now | Free |
| Cloudflare and/or Vercel account | Deployment (M10) | Free tier |

M1 (core money engine) needs **none** of these, which is why it is the recommended next step.

---

## M1 — Core money engine

### What was built
Pure TypeScript in `packages/core/src` (no UI, database or AI). Full explanation in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md).
- `money.ts` — paise integers; `parseRupees` (text → paise, no floating point), `formatINR` (Indian grouping), exact-sum helpers.
- `allocate.ts` — largest-remainder rounding (BigInt inside) so shares always add up exactly.
- `split.ts` — equal, percentage, exact and shares splits; payer validation; `computeExpense`.
- `balances.ts` — paid/share/net per member, confirmed vs projected (rule 12), ignores deleted and personal expenses, refuses corrupt data.
- `settle.ts` — suggested repayments (greedy, deterministic).
- `explain.ts` — the records behind each balance.
- `errors.ts` — one `CoreError` with stable codes.

### What was tested (run, results observed)
| Check | Result |
|---|---|
| Core tests | **131 passing** (worked examples + thousands of random property cases) |
| Whole repo | Type-check clean; **158 tests pass** (core 131, API 17, app 10) |
| Brief example (six friends, ₹8,000 each) | Nets +7,000 / +4,000 / +2,000 / −3,000 / −4,000 / −6,000; plan of 4 transfers; applying the plan zeroes everyone |
| Mutation check | 3 deliberate bugs (drop leftover paise; flip a repayment sign; wrong settlement amount) caused 13, 7 and 4 test failures; originals restored byte-for-byte and tests green again |
| Web build | Still builds; engine is included in the website bundle |
| `npm audit` | 0 new findings (fast-check added; the same 3 moderate Expo-tooling findings remain) |

### Files created
`packages/core/src/`: `errors.ts`, `money.ts`, `allocate.ts`, `split.ts`, `balances.ts`, `settle.ts`, `explain.ts`, `testkit.ts` (tests only, not exported), and `*.test.ts` for each. `index.ts` updated to export the engine. `docs/BUSINESS_LOGIC.md` added. New dev dependency: `fast-check` (free; random-case testing).

### Decisions made
- **Weights/percentages are whole numbers** (basis points for percentages: 33.33 % = 3333). No decimals anywhere.
- **Tie-break for spare paise = lowest member id** (deterministic, order-independent).
- **Settlement is greedy**, not an exact minimum search; always correct, almost always minimal (documented limit). Exact search deferred.
- **A payer may be outside the participants** (paid on behalf of others).
- **Zero shares allowed only in `exact` splits**; percentages and weights must be positive.
- **Engine throws on inconsistent data** instead of guessing.

### How to test it yourself
```powershell
npm test --workspace @tripmate/core        # expect 131 passing
```
Read `docs/BUSINESS_LOGIC.md`, then open `packages/core/src/balances.test.ts` — the first tests are the brief's six-friend example in plain code.

### Known limitations
- Nothing visible in the app yet: this milestone has no screens, and nothing is stored (that arrives with the database and expense milestones).
- Settlement may use one more transfer than the theoretical best in unusual cases.
- Bill-by-bill entry can differ from a pooled calculation by a few paise per person (correct; see BUSINESS_LOGIC §6).
- Not yet used by the API or app (first used in M5/M6).
- Multi-currency, rounding rotation and exact-minimum settlement are not implemented.

### Remaining work for this area
Wiring into the API and database happens in M5 (expenses) and M6 (balances/settlement), where the same functions are called server-side as the authority.

---

## M2 — Accounts, profiles and themes

**Status: complete.** Built and tested; you completed the live check against your real Supabase project and approved it on 2026-11-18. Committed and pushed to GitHub as `f90d1a6` (104 files; a secret scan of the commit found no keys or `.env` files).

### What was built
- **Safe Supabase configuration.** The app reads only the PUBLISHABLE key from `apps/app/.env` (git-ignored). A secret/service-role key is detected and refused (the app shows a setup screen and never prints the key). `npm run verify:supabase` checks the connection without printing anything secret.
- **Database.** `supabase/migrations/20261118000000_profiles.sql`: the `profiles` table, an automatic profile at sign-up (and a backfill for accounts that already exist), and row-level security: you can read and edit only your own profile, only these columns (name, UPI ID, currency, theme, avatar path), nobody can insert or delete from the app.
- **Accounts.** Sign-up (with email confirmation), sign-in, sign-out (this device only), session kept across reloads and renewed automatically, friendly error messages, validation that matches the server.
- **Protected routes.** Signed-out visitors can only see sign-in/sign-up; signed-in people can only see the app screens.
- **Profile.** View and edit name, UPI ID (optional) and preferred currency, with validation.
- **Themes.** Light (default), Dark and System. Applied across the whole app, remembered on the device, saved to the account so it follows you to other devices. Both palettes pass WCAG AA contrast.
- **Reusable UI pieces:** text, button, text field, card, banner, segmented control, screen.

### What was tested (all run; results observed)
| Check | Result |
|---|---|
| Type-check, all packages | Clean |
| Whole repo | **281 tests pass**: API 17, app 90, core 151, database 23 |
| Database rules (real Postgres engine via PGlite) | 23 tests: profile creation, own-row-only reads, no signed-out access, no inserts/deletes from the app, protected columns, data-format rules, backfill, safe re-run. **4 deliberate weakenings of the SQL were each caught**, then restored byte-for-byte. |
| Real-browser run (Edge, `npm run ui:check`) | **54 checks pass**: setup screens, secret-key refusal, protected routes, validation (nothing sent when invalid), sign-up, sign-in (wrong and right password), session survives reload, profile edit (only 3 columns sent, only your row), Light/Dark/System incl. live system change, theme saved to account and picked up on a second device, failed theme save message, sign-out, protected again afterwards, no unexpected network calls |
| Production web build | Succeeds; bundle contains no secret keys (only the validator's own prefix checks) |
| `npm audit` | See Known issues |

**Important limit of the browser run:** Supabase's answers were simulated by the test script. It proves the app does the right thing *given* correct Supabase answers and sends exactly the right requests. It does **not** prove your project is configured right; `npm run verify:supabase` and the manual checklist in SUPABASE_SETUP.md do that.

### Bugs found by testing and fixed
1. **Signed-out visitors landed on an "Unmatched Route" page** (the guard redirected to a group with no screen). Fixed with explicit redirect targets.
2. **Buttons and theme options were not announced to screen readers on the website** (this React Native Web version ignores the older accessibility props). Switched to `aria-*` props; tests now assert `aria-disabled` and `aria-checked`.
3. **M0 config bug:** environment variables were read in a way Expo skips in production builds. Centralised in `apps/app/src/lib/env.ts`.
4. Several test-selector issues, all in the tests and not the app.

### Files created or changed
- `apps/app/src/lib/`: `env.ts`, `config.ts` (changed), `supabaseConfig.ts`, `chunkedStorage.ts`, `sessionStorage.ts`, `supabase.ts` (+ tests)
- `apps/app/src/theme/`: `tokens.ts` (light + dark), `contrast.ts`, `scheme.ts`, `ThemeProvider.tsx` (+ tests)
- `apps/app/src/features/auth/`: `authErrors.ts`, `authService.ts`, `AuthProvider.tsx` (+ tests)
- `apps/app/src/features/profile/`: `profileService.ts`, `profileApi.ts`, `themeSync.tsx` (+ tests)
- `apps/app/src/components/`: `AppText`, `Button`, `TextField`, `SegmentedControl`, `Banner`, `Card`, `Screen`, `StatusScreens`
- `apps/app/src/app/`: `_layout.tsx` (providers + route guard), `(auth)/sign-in`, `(auth)/sign-up`, `(app)/index` (temporary home), `(app)/profile`. The M0 "connection check" screen was removed (the API client and its tests remain).
- `packages/core/src/`: **new files only** `validation.ts`, `profile.ts`, `profile.test.ts`; `index.ts` gained two export lines. **The M1 money engine files are untouched** (last modified 2026-11-17 17:03-17:07, during M1).
- `supabase/` (new workspace): migration, `tests/profiles.test.ts`, `package.json`
- `scripts/verify-supabase.ts`, `scripts/ui-check.ts`; `.env.example` updated; `.gitignore` updated
- `docs/SUPABASE_SETUP.md` (new), this file, decisions log, README

### Key decisions (details in the decisions log)
- No API changes in M2: sign-up/sign-in go straight to Supabase Auth and the profile is protected by database rules. The service-role key is not used anywhere.
- TanStack Query introduced now (approved stack). Forms use plain state + the shared Zod rules; React Hook Form is deferred until forms get complex (expenses).
- On phones the session is stored in secure storage (Keychain/Keystore) in small pieces; on the website in `localStorage`.
- The theme applies instantly from device storage, then the account's saved choice wins after sign-in.

### How to test it yourself
Follow [SUPABASE_SETUP.md](SUPABASE_SETUP.md) (steps 1-8). Quick commands from `E:\TripMate`:
```powershell
npm test                  # 281 tests
npm run ui:check          # real-browser run with simulated Supabase (takes a few minutes)
npm run verify:supabase   # checks YOUR Supabase project (needs the key in apps/app/.env)
npm run app:web           # the real app at http://localhost:8081
```

### Known limitations (not done in M2)
- **Not tested on a phone or emulator.** Only the website was run in a real browser. The phone secure-storage path is unit-tested but not run on a device.
- **Email-confirmation links on phones** (deep links) are not set up; on the website they work once Step 5 of the setup guide is done.
- **Profile picture upload** is not built (the column exists). Deferred to its own small step (needs file storage and an image picker).
- **Forgot password, Google sign-in, "log out everywhere", account deletion, email change** are not built (outside the M2 scope you listed; account deletion and password reset are needed before a public launch).
- The signed-in **Home screen is a temporary placeholder** (greeting only) until trips exist.
- The API (`apps/api`) does not yet check login tokens (nothing needs it until M3).
- Supabase's free email sender allows only a few emails per hour.

### Known issues
- `npm audit` currently reports **36 findings, all inside Expo/React Native build tooling**, traced to one advisory (`picomatch` ReDoS, published 2026-11-18, affects versions up to 4.0.7). **No patched version exists yet** (4.0.7 is the newest). The code involved is file-pattern matching used while building, not shipped to users. The suggested "fix" would downgrade Expo to an old SDK, so it is intentionally not applied. Re-check regularly; M0's earlier "3 moderate" note is superseded by this.
- `npm install` occasionally prints "Cannot read properties of null (reading 'location')"; running `npm install` again clears it.

### Remaining work for the whole "accounts" area
Avatar upload, forgot-password, account deletion, Google sign-in, phone deep links, then a live check on a real phone.

### Next recommended milestone
Superseded: M2 is approved, M0-M2 are committed and pushed (`f90d1a6`), and M3 has begun. See the M3 sections below.


---

## M3 — Trips and members (plan)

M3 is delivered as five small features, one at a time, each ending with your approval.

| # | Feature | Status |
|---|---|---|
| **M3.1** | **Create a trip** (+ your trips on Home) | ✅ Complete (live-verified and approved 2026-11-18) |
| M3.2 | View trip details (dates, budget, members list) | ✅ Complete (live-verified and approved 2026-11-18) |
| M3.3 | Edit and archive a trip (admin only, conflict-safe) | Not started |
| M3.4 | Members and roles: add guest members, remove, make/remove admin, leave, last-admin protection | Not started |
| M3.5 | Invitation links: create, revoke, preview, join | Not started |

**Design decision for M3 (recorded as ADR-032):** trip and member changes are **database functions that check who is calling** (`auth.uid()`), not an API using Supabase's secret key. Each is atomic and tested with the same real-Postgres method as profiles. This means **no secret key is needed anywhere**. The original plan (API + secret key, ADR-004) only becomes necessary at expenses (M5) where the money engine must run on a server, and even then the server can forward the user's own login. **ADR-032 was approved by you on 2026-11-18, with eight security conditions** (listed in the decisions log). They are enforced by an automatic audit test (`supabase/tests/security-audit.test.ts`) that runs against every migration.

Dependencies: M3.2 needs M3.1; M3.3 and M3.4 need M3.2 (they live on the trip screen); M3.5 needs M3.4 (joining creates a member).

---

## M3.1 — Create a trip

**Status: complete.** Approved 2026-11-18.
- **Implementation:** built and tested (database rules on a real Postgres engine; screens in a real browser against simulated Supabase answers).
- **Live migration:** you applied `20261118100000_trips_and_members.sql` to your real Supabase project.
- **Live verification:** `npm run verify:supabase` passes in all four sections. I re-ran it myself on 2026-11-18 after you applied the migration: 0 failures, 0 warnings. It confirms from the outside that the trips and members tables exist and signed-out visitors are denied, nobody can insert a trip directly, and `create_trip()` cannot be run by signed-out visitors.
- **Trip creation in the live app:** tested by you and reported working. (I have not seen your live data, only the checks above.)
- **Committed to git** as `0ca32e6` (2026-11-18), as its own commit before M3.2 began; pushed to GitHub together with M3.2.
- **Close-out addition:** `supabase/tests/security-audit.test.ts` (12 tests) turns the ADR-032 conditions into automatic checks. Five deliberate violations (lost `search_path`, function open to signed-out users, RLS switched off, a new function that skips `auth.uid()`, a direct INSERT grant) were each caught and then removed. Database tests are now 82; the whole repo has 416.

### What was built
- **Database** (`supabase/migrations/20261118100000_trips_and_members.sql`):
  - `trips` and `trip_members` tables as in the approved schema.
  - Row-level security: you can see a trip and its members only while you are an **active member** of it. Removed or departed members lose access.
  - **No one can insert, edit or delete trips or members directly** (not even a trip's own admin). Everything goes through functions.
  - `create_trip()`: creates the trip **and** makes the caller its administrator in one step (both or neither). The creator comes from the login, never from a parameter. Signed-out callers cannot run it.
  - `is_trip_member()` helper used by the security rules.
- **Shared rules** (`packages/core/src/trip.ts`): the form validation, date reading (`27/12/2026`, `27-12-2026`, `2026-12-27`; day first; impossible dates rejected), budget conversion to paise using the approved M1 `parseRupees`, trip phase (Upcoming / Ongoing / Completed, derived from dates), date-range formatting, Home grouping.
- **App:** Home now lists your trips grouped Ongoing / Upcoming / Completed, with an empty state ("Your next adventure starts here.") and a **New trip** button; a **Create trip** screen (name, destination, start and end dates, optional description and budget, currency defaulting to your profile's). Error messages are friendly, including a clear message if the database update has not been applied yet.

### What was tested (all run; results observed)
| Check | Result |
|---|---|
| Type-check, all packages | Clean |
| Whole repo | **404 tests pass**: API 17, app 107, core 210, database 70 |
| Database (real Postgres engine) | 47 new tests: creating a trip makes the admin; atomicity (a forced failure halfway leaves nothing behind); every invalid input is rejected and leaves nothing behind; members see only their trips; strangers, removed and departed members see nothing; signed-out visitors denied; **nobody can write directly**; one membership per person; guests allowed; cascade delete. **6 deliberate breaks of the SQL were each caught**, then restored byte-for-byte. |
| Real-browser run (Edge, `npm run ui:check`) | **86 checks pass** (54 earlier + 32 new): empty state; every validation message; nothing sent while invalid; successful create with the exact request checked (ISO dates, budget in paise, no creator/id/status); grouping and ordering of Ongoing/Upcoming/Completed; archived trips hidden; member counts; double-tap sends one request; server rule shown next to the right field; "database update missing" message; currency from profile; load failure then Try again |
| Live project check (`npm run verify:supabase`) | Before the migration: sections 1-3 PASS and section 4 correctly reported "not applied yet". **After you applied it: all four sections PASS (0 failures, 0 warnings).** |

**Limit of the browser run:** Supabase's answers are simulated. It proves the app sends the right requests and shows the right screens given correct answers. The database tests prove the SQL is right. Only your live check proves your project has the update applied.

### Bugs found by testing and fixed
1. When the name or budget was also wrong, the "end before start" error was not shown (the form library skips whole-form checks if a field failed). Now every problem shows at once; the check was hardened so malformed input cannot crash it.
2. A test I wrote first expected a database error message that PostgREST words differently; the service maps by constraint name instead.

### Files created or changed
- `supabase/migrations/20261118100000_trips_and_members.sql`; `supabase/tests/harness.ts` (shared test set-up), `supabase/tests/trips.test.ts`
- `packages/core/src/trip.ts`, `trip.test.ts`; `index.ts` (+1 export line). **M1 money engine files untouched.**
- `apps/app/src/features/trips/`: `tripService.ts` (+ test), `tripApi.ts`, `TripCard.tsx` (the card is covered by the browser run, not a unit test)
- `apps/app/src/lib/`: `format.ts`, `today.ts` (+ test)
- `apps/app/src/app/(app)/index.tsx` (Home rewritten), `(app)/trips/new.tsx` (new)
- `apps/app/src/components/TextField.tsx`: added optional multi-line support only. **M2 authentication code untouched.**
- `scripts/ui-check.ts` (trip scenarios), `scripts/verify-supabase.ts` (section 4)
- Docs: this file, `SUPABASE_SETUP.md` (step 9), decisions log, schema/API notes

### Key decisions
- Writes via database functions (ADR-032); date text input in Indian format instead of a date picker for now (ADR-033); trip phase derived from dates (ADR-034); server-generated trip id with a button lock against double-taps (ADR-035).

### How to test it yourself
1. Do **Step 9** in [SUPABASE_SETUP.md](SUPABASE_SETUP.md) (run the second SQL file), then `npm run verify:supabase` (expect `PASSED` with section 4 all `OK`).
2. `npm run app:web`, sign in, tap **Create a trip**, enter e.g. *Goa Trip 2026 / Goa, India / 27/12/2026 / 30/12/2026 / 60000*, press **Create trip**. The trip appears on Home under Upcoming with "1 person" and "Budget ₹60,000".
3. Create a second account in another browser: it must **not** see your trip.
4. Try an end date before the start date, and 30/02/2026: both show clear messages.
5. Automated: `npm test` and `npm run ui:check`.

### Known limitations (deliberate, for later M3 features)
- Trip cards are not tappable yet (details screen is M3.2).
- No editing, archiving, members, roles or invitations yet (M3.3 to M3.5).
- Dates are typed as DD/MM/YYYY (no date picker yet; polish milestone).
- No cover photos, no budget progress bar (needs expenses).
- Not tested on a phone or emulator; web only.
- `create_trip` is not idempotent across network retries (the screen prevents double-taps; revisit with offline entry).
- Trip creation fails with a clear message for an account that somehow lacks a profile.

### Remaining work for M3
M3.2 to M3.5 as listed above.

### Next recommended step
M3.1 is closed. Next is **M3.2 - View trip details**; its plan is in the next section and nothing has been built.


---

## M3.2 — View trip details

**Status: complete.** Built and tested; you ran the live check against your real Supabase project (reported passed) and approved M3.2 on 2026-11-18. The plan and all your defaults were approved on 2026-11-18 (combined not-found/access-denied message; current members only; archived trips viewable with a notice; no database change; direct web addresses; deep-link restoration after sign-in out of scope). Two extra requirements were added and met: member privacy and calendar-date correctness.

### What was implemented
- Tap a trip card on Home to open `/trips/<id>`; the address also works directly and after a reload.
- The page shows: name, destination, a phase badge (Upcoming / Ongoing / Completed), date range and length in days, description (or "No description"), budget and currency (or "No budget set"), "Created by …" (you / a name / "a former member"), and the people currently on the trip (administrators first, with **Admin**, **You** and **Guest** tags). An "Archived" notice shows for archived trips.
- States: loading; the **single combined "Trip not available"** message for unknown, not-yours, removed, left and malformed links; a separate connection-failure message with **Try again**; a clear message if the database update were missing.
- **No database change:** no migration, no function, no new permission, no secret key. The existing row-level security decides who can read a trip and its members.
- **Member privacy:** the request names its columns (no "select everything"), asks only for current members' id, name, role and join date, and never touches profiles, so no email addresses or UPI IDs are requested or shown. Co-members' profiles stay unreadable. (An unrelated, intentional detail: the database lets a current member read the rows of former members of their own trip; the screen neither requests nor shows them.)
- **Calendar-date correctness:** trip length is counted with pure calendar arithmetic on plain `YYYY-MM-DD` days, and the phase compares plain calendar days against the person's own local "today". Neither depends on time zone or daylight saving.

### Files changed
- **New:** `packages/core/src/tripDetails.ts` (+ `tripDetails.test.ts`); `apps/app/src/features/trips/tripDetailsService.ts` (+ test), `tripDetailsApi.ts`, `PhaseBadge.tsx`; `apps/app/src/app/(app)/trips/[tripId].tsx`; `apps/app/src/lib/today.test.ts`; `supabase/tests/trip-details-access.test.ts`.
- **Changed (as planned, nothing else):** `apps/app/src/features/trips/TripCard.tsx` (tappable card), `apps/app/src/app/(app)/index.tsx` (passes the open handler), `packages/core/src/index.ts` (+1 export line), `scripts/ui-check.ts` (new scenarios), docs.
- **Verified unchanged since the M3.1 commit (`0ca32e6`):** the M1 money engine, all M2 auth/profile/theme/session code, every migration and existing database test, and the M3.1 service, hooks, create screen and trip rules.

### Tests added and results (all run)
| Check | Result |
|---|---|
| Type-check, all packages | Clean |
| Whole repo | **518 tests pass**: API 17, app 135 (+28), core 265 (+55), database 101 (+19) |
| Shared rules (55) | calendar days (leap year, month/year ends, daylight-saving changes), `daysLabel`, trip-id validation (valid and 14 kinds of invalid), member mapping and sorting, creator lookup, only-current-members, no email/UPI in the output, and **time-zone independence in six zones (UTC+14 to UTC-11)** |
| Data layer (23) | exact query (columns, filters), no `*`, no profile/email columns, zero rows and malformed ids give the identical combined error, malformed ids never reach the server, errors mapped, raw database text and "permission denied" never shown |
| Time-zone "today" (5) | the same instant is a different day in different places; the day changes at local midnight (India 23:59:59 vs 00:00:00); daylight-saving days; trips starting/ending "today" |
| Database (19, real Postgres engine) | the exact read as a member, ordinary member, stranger, member of another trip, removed member, member who left, signed out; unknown id looks identical to a hidden one; a co-member's profile and UPI cannot be read; emails unreachable; no email/UPI columns exist; no new function or permission. **4 deliberate weakenings were each caught** (trips/members visible to all, removed members counted, and the M2 profile rule opened up), then restored byte-for-byte. |
| Date logic mutation | rewriting the day counter to use local midnight made 14 tests fail; restored |
| Security audit (ADR-032) | all 12 tests pass unchanged against all migrations |
| Real browser (Edge, `npm run ui:check`) | **133 checks pass** (86 earlier + 47 new, see below) |
| Live project check (`npm run verify:supabase`) | PASSED, 0 failures, 0 warnings |
| Production build | succeeds; 0 secret keys, 0 service-role tokens, 0 connection strings; 1 copy of the publishable key (expected, public by design) |

### Browser testing (47 new checks)
Card opens details (and is a labelled button); every field with and without description/budget; "1 day"; USD budget; Admin/You/Guest tags and ordering; former members hidden **even when the fake server wrongly sends them**; no email/UPI text on the page; the request's columns, filters and login (never a secret key); back, direct address and reload; creator-left and archived pages; **the identical message for someone else's trip, a nonexistent trip and a malformed address, revealing nothing and (for malformed) not contacting the server**; Back to Home; connection failure then Try again; loading state; signed-out visit goes to sign-in and requests no trip data; Dark theme; and **time-zone boundary checks in three zones (Pacific/Kiritimati UTC+14, Pacific/Pago_Pago UTC-11, Asia/Kolkata)**: trips starting today and ending today are Ongoing, starting tomorrow Upcoming, ended yesterday Completed, lengths right, and the Home list agrees with the details page. The fake server answers single-trip requests in the real array form.

### Bugs found
- No application bugs. Two test-side problems: a typing flaw in a test helper, and a theme check that forgot the account's saved theme wins after sign-in (correct, designed behaviour).

### Not tested / not done / limits
- **Live check is yours** (steps below). I could not sign in as a real user, so the details page has not been exercised against your real Supabase with a session. I probed the real server as a signed-out caller: the exact request is refused for *permission* (not "relationship not found"), which shows the trips-to-members link resolves, **but my control with a deliberately broken filter was refused the same way, so this probe does not prove the "current members only" filter syntax is accepted.** It is standard PostgREST behaviour, and the screen also filters to current members in code, so the worst case is the filter being ignored with no visible difference.
- The database tests run the equivalent SQL join, not PostgREST itself.
- Web only; not tested on a phone or emulator.
- The phase badge is computed when the page renders; a page left open across midnight updates on the next load.
- Returning to a deep link after sign-in is not built (you land on Home).
- No editing, archiving, member changes, invitations, budget progress or expenses (M3.3 to M3.5 and later).
- Source control: committed separately from M3.1 (which was left unchanged) and pushed to GitHub `main` together with it; see the git history for the hashes.

### Live check (passed by you, 2026-11-18)
1. `npm run app:web`, sign in, tap a trip card: the details page opens and shows what you entered, you as **Admin** and **You**, "Created by you".
2. Press reload on that page: it stays.
3. In a second browser sign in as a **different** account and paste the first account's trip address: you must see "Trip not available", with no trip name anywhere. Paste a made-up address like `/trips/not-a-real-id`: the **same** message.
4. Check no email address appears on the page.

### Next recommended step
M3.2 is closed. When you approve starting it: **M3.3 - Edit and archive a trip** (not started).

### Approved plan (as presented, kept for reference)

### Goal
Tap a trip card on Home to open that trip's details page showing: name, destination, dates, description (if any), budget and currency (if any), who created it, and the people currently on the trip.

### What I inspected (facts, not assumptions)
- The `trips` row already holds everything except the people; `trip_members` already holds each person's name (a snapshot, so no other table is needed), role, status and join date. Members can read both tables through the existing security rules.
- **No database change is needed.** The existing rules already limit both tables to active members of the trip. No new function, table, permission or migration, and no secret key.
- For a trip you cannot see, the database returns **zero rows with no error** (confirmed in the installed library's code). It cannot, and should not, say whether the trip exists.
- Home's trip card is currently not interactive; the router has `(app)/trips/new.tsx` and will gain `(app)/trips/[tripId].tsx` (the fixed `new` route takes priority over the variable one).

### Decisions I need from you
1. **Not found vs access denied: one combined state (recommended).** Telling "this trip doesn't exist" apart from "it exists but isn't yours" would let anyone test which trip IDs exist, which is an information leak. So an unknown trip, a trip you're not on, a trip you were removed from, and a malformed link all show the same message: *"We couldn't open this trip. It may have been removed, or you may not be a member."* with a button back to Home. Genuine connection problems are a separate state with **Try again**. This slightly differs from your request for separate states because separating them would weaken security. If you disagree, tell me.
2. **People list shows only current members** (active). People who left or were removed appear in M3.4 (member management).
3. **Archived trips** can still be opened by members, with an "Archived" notice (the archive action itself is M3.3).

### What will change
| Area | Change |
|---|---|
| Database | **None.** (No migration, no function, no new permission.) Only new tests. |
| Shared rules (`packages/core`, **new file only**) | `tripDetails.ts`: trip + member types and mapping; people sorted (admins first, then by join date); creator's name found from the member list; "is this a valid trip link" check. **M1 money engine untouched.** |
| App data layer (**new files**) | `tripDetailsService.ts`, `tripDetailsApi.ts`. One query asking for the trip and its members, with an explicit list of columns (no `*`, so future columns can never leak accidentally); the id filter is checked client-side first. `tripService.ts` and `tripApi.ts` from M3.1 are **not touched**. |
| Screens | **New:** `(app)/trips/[tripId].tsx`. **Small edits to two M3.1 files, nothing else:** `TripCard.tsx` becomes tappable (optional `onPress`), `(app)/index.tsx` passes the handler. |
| Not touched | M1 engine, M2 authentication, profile, theme, storage, migrations. |

### The screen
- Header: "← Home", trip name, destination, a phase badge (Upcoming / Ongoing / Completed), "Archived" notice if archived.
- **When:** date range and length ("4 days").
- **About:** description (or "No description"), budget with currency (or "No budget set").
- **People (N):** each person's name, an **Admin** tag, and "You" next to yourself; "Created by <name>".
- States: loading, details, **not available** (combined state above), **connection problem with Try again**, and a clear message if the database update were missing.
- Works as a direct web address (`/trips/<id>`) and after a reload. Opening it signed out sends you to sign-in (returning you to that exact trip afterwards is **not** built; it lands on Home).
- Light and Dark themes, accessible roles and labels, same components as the rest of the app.

### Security (how each requirement is met)
- Access is decided by the database's security rules, not by the screen; the screen only reflects the answer.
- No other person's private trip data can be returned: a stranger's query yields nothing, and the message does not reveal existence.
- Only names and roles of fellow members are shown. No emails, no UPI IDs (not even requested).
- No secret key; no new privileges; the ADR-032 audit test still must pass unchanged (it would catch accidental new functions or grants).

### Tests I will write
- **Shared rules:** member sorting, creator lookup, "you" detection, removed members excluded, odd inputs, valid/invalid trip ids.
- **Data layer (fake client):** exact query shape; zero rows becomes "not available"; malformed id never sent; network, setup and unexpected errors mapped; raw database text never shown.
- **Database (real Postgres engine):** the exact read the screen performs, as a member, as a stranger, as a removed member, as a member who left, signed out; one trip's members never appear when reading another trip; the embedded members query respects the same rules.
- **Real browser (about 25 checks):** tapping a card opens the details; every field shown, with and without description and budget; Admin and You tags; removed members hidden; Back works; direct address and reload work; stranger and malformed address show the combined message and **no trip data**; connection failure then Try again; loading state visible; archived notice; signed-out visit goes to sign-in; request carries the user's login (never a secret key) and asks only for the listed columns; no unexpected network calls; Light and Dark screenshots. The fake server will answer in the same array form as the real one.
- **Security checks:** full audit test, secret scan of the build and of what would be committed, `verify:supabase`.

### Not in M3.2
Editing or archiving (M3.3), adding, removing or re-roling members (M3.4), invitations (M3.5), budget progress, expenses, cover photos, pull-to-refresh, returning to a deep link after sign-in.

### Known limitations to expect
- Web only; not tested on a phone or emulator.
- Real-browser tests use simulated Supabase answers; the live check for M3.2 is yours (open a trip from Home; open that trip's address as a second account and confirm you get the combined message).

### Risks
Low. No database change; additive code; the main risk is the "embedded members" query interacting with the security rules, which the database tests cover directly.
