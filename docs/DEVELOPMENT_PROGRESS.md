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
| **M3 — Trips and members** | 🔵 **In progress, 5 small features** (see M3 plan): **M3.1 Create a trip ✅ complete (approved 2026-11-18)**; **M3.2 View trip details ✅ complete (live-verified and approved 2026-11-18)**; **M3.3 Edit and archive: built and tested, plus a date input and calendar refinement requested in review; awaiting your review (migration not yet applied to your live project, nothing committed)**; M3.4-M3.5 not started |
| M4 — Invites + guest claim | Not started |
| M5 — Expenses + split types | Not started. **Must (ADR-043):** make `update_trip` refuse trip date changes that would leave an existing expense outside the trip; refuse expenses and repayments on archived trips; keep currency unchangeable; use the lock + version pattern for every money-changing function |
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
| M3.3 | Edit and archive a trip (admin only, conflict-safe) | 🟡 Built and tested; awaiting your review. Migration #3 not yet applied live; nothing committed |
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


---

## M3.3 — Edit and archive a trip

**Status: built and tested. Awaiting your review.** The plan and all six decisions were approved on 2026-11-18, with extra conditions on concurrency, restore, Home, the shared form, routing, security and a future M5 dependency (all addressed below). **It has NOT been applied to your live Supabase project and NOT checked live** (see "Live check for you"). Nothing is committed or pushed.

### What was implemented
- **Edit a trip** (administrators only): name, destination, start and end dates, description, budget. Same validation and messages as Create (it uses the identical rules). Currency is shown but **cannot be changed** (the edit function has no input for it).
- **Archive a trip**, with a confirmation dialog ("Nothing is deleted: history and expenses are kept, and you can restore it later").
- **Restore a trip**, with its own confirmation. Restore changes only the status; the trip returns to whichever Home group its dates belong to.
- **Archived trips are read-only in the database** and are clearly marked: banner on the trip page, "Archived" tag and muted title on Home cards, and a collapsed **"Archived (n)"** section on Home (n = the archived trips the database returned for this person; trips they cannot access are never counted).
- **Concurrency:** the edit form remembers the version it started from. If someone else changed the trip first, the save is refused ("This trip was changed by someone else. Reload to see the latest, then try again."), nothing is overwritten, and **Reload latest** restarts the form from the newest version.
- **Routing:** the details page is now `trips/[tripId]/index.tsx` (same address, `/trips/<id>`), with `/trips/<id>/edit` beside it. Direct addresses and refresh work for both.
- **Shared form:** the six trip fields are one component used by Create and Edit.

### Database changes (one migration, `20261118200000_trip_edit_archive.sql`)
No table, column, policy or table-permission was changed. Row-level security is untouched; the first two migrations are byte-identical.
- **Version trigger:** adds 1 to `trips.version` on every REAL change (ignoring `version` and `updated_at` themselves); a change that alters nothing does not. Whatever version a writer tries to set is overridden.
- **`update_trip(...)`** and **`set_trip_archived(...)`**, callable by signed-in users, `SECURITY DEFINER`, pinned `search_path`, revoked from `PUBLIC` and `anon`, using `auth.uid()`. In order: signed in; active member (else the single existence-hiding answer `trip_not_found`); administrator (else `not_admin`); **row locked**; archived (edits only: `trip_archived`); version matches (else `version_conflict`, nothing changed); nothing to change (return as is, no new version); otherwise a version-guarded UPDATE. Archive/restore: same checks, change **only** `status`, and asking for the state it is already in is a safe no-op.
- **`trip_role_of(trip, user)`**: internal helper, **not callable by the app** (only the two functions above use it).
- Audit allow-list: exactly `update_trip` and `set_trip_archived` were added (two reviewed lines in `security-audit.test.ts`). **No secret key** is used or mentioned.

### Files
- **Database:** new `supabase/migrations/20261118200000_trip_edit_archive.sql`, `supabase/tests/trip-edit.test.ts`. Changed (as approved): `security-audit.test.ts` (allow-list +2 names) and `trip-details-access.test.ts` (its "callable functions" assertion now lists the 4 reviewed functions; it previously said "unchanged since M3.1", which M3.3 deliberately changes).
- **Shared rules:** new `packages/core/src/tripEdit.ts` + test; `index.ts` (+1 export line). `trip.ts` and `tripDetails.ts` are untouched.
- **App (new):** `tripEditService.ts` (+ test), `tripEditApi.ts`, `TripFormFields.tsx`, `ConfirmDialog.tsx`, `trips/[tripId]/edit.tsx`.
- **App (changed, approved):** details page (moved to `[tripId]/index.tsx` and extended with Manage / Archive / Restore), Home (archived section), `TripCard.tsx` (Archived tag, muted title), `new.tsx` (now uses `TripFormFields`; behaviour unchanged).
- **Scripts/docs:** `scripts/ui-check.ts` (new scenarios H and I), `scripts/verify-supabase.ts` (checks the new functions on your real project), docs.
- **Verified unchanged since the last commit (`2653ae3`):** the M1 money engine, all M2 code and its migration and test, `trip.ts`, `tripDetails.ts`, the M3.1/M3.2 services and hooks, and migrations 1 and 2.

### Tests and results (all run)
| Check | Result |
|---|---|
| Type-check, all packages | Clean |
| Whole repo | **632 tests pass**: API 17, app 165 (+30), core 295 (+30), database 155 (+54) |
| Database (real Postgres engine, +54) | every function as administrator, second administrator, ordinary member, stranger, removed, left, signed out and "no login"; identical answer for a nonexistent trip; stale versions (two administrators replayed in sequence); atomicity (invalid data leaves the trip exactly as it was); no-op edits and repeated archive/restore don't add versions; archive and restore change only the status and don't touch members; archived trips refuse edits until restored; nobody can set the version; the helper and trigger function are closed to the app; the migration can be re-run |
| **Mutation check (14 deliberate breaks of the new migration)** | **all caught**: admin check removed (twice), archived check removed, version check + guard removed (twice), row lock removed, no-op skip removed, existence leak, restore wiping a field, non-idempotent archive, trigger bumping on no-ops, trigger removed, helper made callable, an unreviewed extra function. A control (only the early version check removed) correctly passed because the guard inside the UPDATE still protects: defence in depth. Migration restored byte-for-byte after each. |
| Security audit (ADR-032), 12 tests | all pass against all three migrations |
| Shared rules (+30) | same validation as Create (identical messages), form pre-fill round trip, exact RPC argument names, no currency/status/creator, admin detection (former admins excluded), archived list and the approved Home grouping unchanged, restored trips fall in the right group |
| Data layer (+30) | exact requests, version handling, malformed ids and bad versions never sent, every database answer mapped to a plain message, raw database text never shown |
| Real browser (Edge), `npm run ui:check` | **225 checks pass**: the 133 earlier checks **unchanged and all passing** (including every Create Trip check after the shared-form extraction, details, time zones) plus **92 new** |
| Live project check (`npm run verify:supabase`) | PASSED with 3 warnings: the three new functions are "not available yet" on your real project, as expected before you apply the migration |
| Production build | succeeds; 0 secret keys, 0 service-role tokens, 0 connection strings; 1 copy of the publishable key (expected, public by design) |

### The new browser checks (92) cover
Administrators see Edit/Archive, members don't and are told why; pre-fill; Save disabled until something changes and again after reverting; every validation message (same as Create, nothing sent while invalid); the exact request (approved fields, cleaned, starting version; never currency/status/creator); trip page and Home update; the second edit starts from version 2; removing the budget; **another admin changing the trip first** (refused, nothing overwritten, Reload latest, retry keeps their changes); not-admin, not-found, archived and connection failures each explained, form kept, Save works after the connection returns; double taps (edit and archive each send one request); direct addresses (member, stranger, malformed, archived, signed out); Home's Archived section (count equals trips this person can access, hidden trips excluded, collapsed by default, tagged, accessible state, opens the trip); archive dialog (Cancel does nothing, names the trip, alert-dialog role); archive and **restore requests exactly as specified**; restore changes nothing else and returns the trip to Ongoing / Upcoming / Completed by its dates; archiving an already-archived trip is safe; archive from an outdated page is refused with Reload; failures inside the dialog; members cannot restore; Dark theme; and **editing dates, archiving and restoring in three time zones (UTC+14, UTC-11, India)**: starting today and ending today are Ongoing, ended yesterday Completed, starting tomorrow Upcoming.

### Bugs found
No application bugs. Two test-side problems, fixed: an enabled button simply has no "disabled" marker (my check assumed an explicit "false"), and a check ran before the dialog finished fading out. The first screenshots of the dialog were captured mid-fade, so I made the check wait and re-viewed them: the finished dialog is legible in both themes.

### Not tested, not done, limits (honest)
- **Not applied or checked on your live Supabase project.** I could not sign in as a real user, so edit/archive/restore have only been exercised against a real Postgres engine (database rules) and simulated Supabase answers (screens). Live steps below.
- **A true simultaneous race** cannot be staged on a single-connection test engine. The tests replay the exact sequence a race produces and check the row lock and version-guarded UPDATE are in the function bodies; that the lock makes a real race behave the same way is Postgres' documented behaviour.
- The simulated server in the browser run implements the same rules as the functions, but it is a re-implementation; the database tests are the authority for the rules.
- Web only: not tested on a phone or emulator (the dialog uses React Native's Modal, which should behave the same, but is unverified there). The Escape key closes the dialogs on the web (tested); the Android back button is not tested.
- A page left open across midnight updates its phase on the next load.
- Deep-link restoration after sign-in is still out of scope. No deleting trips (archive only). No member management (M3.4) or invitations (M3.5).

### Live check for you
1. Do **Step 10** in [SUPABASE_SETUP.md](SUPABASE_SETUP.md) (run the third SQL file), then `npm run verify:supabase`: expect `PASSED` with **0 warnings**.
2. `npm run app:web`, sign in, open a trip you created: you should see **Edit trip** and **Archive trip**.
3. Edit it (change the name and the budget), Save: the trip page and Home show the new details.
4. Archive it (check the confirmation text), then open Home: it left its group and **Archived (1)** appears; expand it, open the trip, **Restore** it: it returns to the right group.
5. In a second browser as another account: open the trip's address (it must say "Trip not available"), and its `/edit` address (same).
6. (Needs two accounts on one trip, which arrives in M3.4/M3.5) a non-admin member must not see Edit or Archive.

### Obligations for later milestones (recorded so they cannot be forgotten)
- **M5 (expenses): changing a trip's dates must be checked against existing expense dates.** `update_trip` has no expenses to look at today. When the expenses table is added, `update_trip` must refuse any date range that would leave an existing expense outside the trip (and the screens must show a clear message), with tests. See ADR-043.
- Archived trips must refuse new expenses and repayments (read-only), and currency must stay unchangeable.
- Every new money-changing function must use the same pattern: caller identity, active-member and role checks, row lock, version check, atomic change.

### Next recommended step
Your review of M3.3 and the live check above. After approval, and a decision on committing: **M3.4 - Members and roles** (not started).

### Refinement requested during M3.3 review: date typing and calendar picker

**Status: built and tested. Nothing committed or pushed. No database, API or date-logic change.**

**What it does (Create Trip and Edit Trip, identically, because it lives in the shared `TripFormFields`):**
- **Calendar button** beside Start date and End date. It opens a calendar dialog (month grid, previous/next month and year, Today, Close). Choosing a day writes it into the box as `DD/MM/YYYY`. The box and the calendar always agree (the box is the single source of truth): the calendar opens on the date typed, and a half-typed date selects nothing.
- **End date calendar** opens on the start date's month and does not offer days before the start date (a convenience; a typed end date before the start is still rejected by the unchanged validation). "Today" is unavailable if today is before the start date.
- **Automatic formatting:** `27122026` becomes `27/12/2026`, `05012027` becomes `05/01/2027`. Slashes appear when the third digit is typed; correctly formatted dates typed with slashes are accepted; `5/1/2027` becomes `05/01/2027`.
- **Restrictions:** only digits and the automatic slashes are kept. Letters, spaces, symbols and digits from other scripts are rejected. Nothing beyond `DD/MM/YYYY` is accepted. Phones get the number keypad.
- **Paste:** `27122026`, `27/12/2026` and (as whole dates) `27-12-2026`, `27.12.2026` and ISO `2026-12-27` all become `DD/MM/YYYY`; pasted text with letters keeps only its digits.
- **Backspace and cursor:** backspace removes one thing at a time and steps over automatic slashes; deleting or typing in the middle keeps the cursor beside the edit. The edit position is worked out from the old and new text, not from selection events (which can lag).
- **Validation is unchanged and not weakened.** The formatter only shapes text; it never corrects or judges a date (`31/02/2026` stays `31/02/2026` and is rejected as before). Impossible dates, wrong months, non-leap 29 February, partial and empty dates all still fail exactly as in M3.1.

**Choice of calendar (dependencies inspected first):** no picker library was installed. The standard Expo/React Native picker (`@react-native-community/datetimepicker`) supports iOS, Android and Windows but **not the web**, so it would have needed a new dependency plus a second, different implementation for the browser, neither matching the TripMate theme nor testable in the browser harness. I built **one calendar from React Native's own building blocks** (a dialog and a grid): no new dependency, identical on web and phones, themed with the design tokens (both themes verified), accessible. Weekday maths uses the same timezone-free calendar-day arithmetic as the rest of the date code (1 Jan 1970 was a Thursday); first day of the week is Sunday; supported years are 2000 to 2100 (the range the validation already accepts, tied together by a test).

**Files:** new `packages/core/src/dateInput.ts` (+ test), `calendar.ts` (+ test); `apps/app/src/components/CalendarIcon.tsx`, `DatePickerModal.tsx`; `apps/app/src/features/trips/DateField.tsx`. Changed: `TripFormFields.tsx` (the two date boxes now use `DateField`), `TextField.tsx` (additive optional props only: `trailing`, `selection`, `onSelectionChange`, `inputMode`), `packages/core/src/index.ts` (+2 export lines), `scripts/ui-check.ts`. **Unchanged:** `trip.ts`, `tripDetails.ts`, `tripEdit.ts` and their tests, the money engine, the M2 code, every migration, the M3.1/M3.2/M3.3 services and hooks, and `new.tsx` and `edit.tsx` themselves (they get the behaviour only through `TripFormFields`). No dependency was added.

**Tests (all run):**
| Check | Result |
|---|---|
| Type-check | Clean |
| Whole repo | **704 tests pass**: API 17, app 165, core 367 (+72), database 155 |
| Typing formatter (49) | digits-only grouping and every partial step; slashes and padding; letters, symbols, emoji and non-ASCII digits rejected; pasting (plain, slashes, dashes, dots, ISO, with junk); valid dates stay valid and invalid ones are never "fixed" (including 29 February in leap years 2000, 2024, 2028 and not 2100, 2027); **properties over thousands of cases**: any 8 digits give valid text exactly when that calendar date exists, every real date from 2000 to 2100 round-trips, output always well-shaped and at most 10 characters, shaping is idempotent (so editing a saved date never marks the form changed), only digits and "/" ever appear, the cursor is always inside the text; a text-box simulator for typing, backspace, middle edits and paste |
| Calendar maths (23) | every month's grid (leading blanks, 4 to 6 rows, each day once in order, real dates, 1st under the right weekday) for every month 2000 to 2100; weekday of every day 2000 to 2100 checked against JavaScript's own calendar; leap years; month and year shifting with bounds |
| **Mutation check (13 deliberate breaks)** | all caught (letters accepted, no padding, extra digits, cursor jumping, silently "correcting" a day over 31, ISO paste, stray slashes, cursor after slash, edit position, weekday off by one, February always 28, no year bounds, unpadded weeks). It first found a **gap** in my tests (doubled slashes with single-digit parts); I added the case and re-ran: all 13 caught. Files restored byte-for-byte. |
| Real browser (Edge), `npm run ui:check` | **375 checks pass** (225 earlier unchanged + **150 new**: 149 for dates, 1 more for the archive dialog) |

**Browser checks for dates (run on Create and again on Edit):** real key presses and a **real clipboard paste**; every example from your brief; letters/symbols; slashes; paste variants; backspace sequence and caret positions (`selectionStart`) for end, middle and over-a-slash edits; editing an existing date; 11 invalid dates (invalid day/month, 31 April, 30 February, non-leap 29 February, 29 February 2100, years 1999 and 2101) all rejected and none reaching the server; partial and empty dates rejected; 29 February 2028 accepted and sent as `2028-02-29`; calendar open/select/navigate (month, year), Today, Close, Escape, keyboard Enter to open; typing then calendar and calendar then typing, both ways; End calendar opens on the start month, blocks earlier days and blocked clicks do nothing; Edit specifics: saved dates unchanged in the new field, moving around or opening and closing the calendar does not mark the form changed, a calendar choice enables Save and saves as an ISO date; accessibility names (button, dialog, each day, selected state); **Light and Dark** (theme surface and selected-day colours); **phone-sized touch screen**: no sideways scroll, number keypad (`inputmode=numeric`), 44 px touch targets, dialog inside the screen, tapping a day fills the box.

**Bug found and resolved:** none in the app. The first run failed the Escape-key check because my test pressed Escape before React Native Web's modal had finished fading in (it only listens afterwards, on key release). With the wait, Escape closes the calendar. I added the same check to the archive dialog (same modal component), which resolves the M3.3 limit "Escape not tested".

**Limits (honest):**
- **Not run on a real phone or emulator.** The phone checks are a phone-sized, touch-enabled browser. Unverified on devices: the native cursor control (`selection`) on iOS/Android, the native modal, the number keypad (note: iOS's number keypad has no "/" key, which is fine because slashes are inserted automatically), and the Android back button closing the calendar.
- Typing a digit in the **middle** of a full date shifts the later digits right and the last one falls off (masked-field behaviour); deleting in the middle keeps the date tidy.
- Dashes and dots are accepted only in a **whole pasted date** (`27-12-2026`); typed one at a time they are rejected, as asked.
- Digits from other scripts (for example Devanagari) are rejected; only 0-9 are accepted.
- No live "that date does not exist" message while typing: invalid dates are reported on Create/Save with the same messages as before (kept so nothing in M3.1/M3.3 changes).
- Calendar: Sunday first, no month or year drop-down (use the arrows), years 2000 to 2100.
- Web only in a real browser (Edge).

### Approved plan (as presented, kept for reference)

### Goal
Let a trip's **administrators** edit its details and archive it (with a confirmation), while ordinary members cannot, enforced by the database. Archived trips are clearly marked, cannot be mistaken for active ones, and keep all their history.

### What I inspected (facts)
- `trips.status` already allows `active` / `archived`. **No new column needed.**
- `trips.version` exists (default 1) but **nothing ever changes it**: the only trigger on `trips` stamps `updated_at`. A guard against overwriting someone else's newer edit therefore needs a new mechanism (below).
- **No expenses (or other money) table exists yet**, so there is no financial data to disturb today. The schema document says currency is *immutable once a trip has expenses*; that rule cannot be enforced until expenses exist.
- **Home hides archived trips completely** (`groupTripsByPhase` skips them; tested and approved in M3.1). The details screen already shows an "Archived" banner (M3.2).
- Nobody can write `trips` directly (no grants). The callable-function allow-list in the audit test is exactly `create_trip` and `is_trip_member`.
- Design documents already say: admins edit and archive; members cannot (`API_DESIGN` permission matrix); edits carry an `expectedVersion` and a stale one is a conflict (409); archive and unarchive are one pair of actions.
- The trip details data already tells the screen who is an admin (members with role `admin`), so the screen can hide buttons from members. **Hiding is only a convenience; the database is the authority.**

### Decisions I need from you
1. **Restore (un-archive): include it (recommended).** You asked for archive only, but if archived trips are read-only (decision 4) and there is no way back, archiving by mistake would be permanent. Restore is the same function with the opposite value, with its own confirmation.
2. **Currency is NOT editable in M3.3 (recommended).** Budget amounts are stored in the trip's currency; changing the currency would silently change what every amount means, and once expenses exist (M5) it would be dangerous. Making the edit function simply have no currency input makes the rule true *by construction*. The edit screen shows the currency read-only with a one-line reason. Alternative: allow it until the first expense exists, which needs a guard that can't be written until M5. The M5 plan must also guard shrinking a trip's dates below existing expense dates (recorded as obligations in the docs).
3. **Archived trips appear on Home in a collapsed "Archived (n)" section at the bottom (recommended)**, each card tagged "Archived" and visually muted, tappable. They never count as Ongoing, Upcoming or Completed. Today they are simply invisible, which would make restore impossible to find. The existing grouping rule stays exactly as approved.
4. **Archived trips are read-only in the database:** editing is refused while a trip is archived (restore first). This is what stops an archived trip being treated as active.
5. **Edit form code:** to avoid pasting ~100 lines of the Create form into a second screen, I'd extract the shared fields into one small component used by both. That means a mechanical edit to the approved Create screen, guarded by the existing browser checks (they exercise every Create field and message and must stay green, unchanged). If you would rather not touch Create at all, I'll duplicate the fields instead.
6. **Route change:** the edit page is `/trips/<id>/edit`. That needs the details file to move from `trips/[tripId].tsx` to `trips/[tripId]/index.tsx`: **same address, same content**, just a different place in the folder.

### Database changes (one new migration `20261118200000_trip_edit_archive.sql`)
No table, column, policy or table-permission changes. Row-level security is untouched.
- **Version counter:** a `BEFORE UPDATE` trigger on `trips` adds 1 to `version` on every change (so any future writer is covered too).
- **`trip_role_of(trip, user)`** (internal helper): returns the user's role if they are an *active* member, else nothing. Used by these functions. **Not callable by the app** (execute revoked from everyone but the owner), so it adds no new surface.
- **`update_trip(trip_id, expected_version, name, destination, start_date, end_date, description, budget_minor)`** (callable by signed-in users). In order:
  1. caller must be signed in (`auth.uid()`), else `not_authenticated`;
  2. caller must be an **active member**, else `trip_not_found` (the same answer for a trip that doesn't exist, isn't theirs, or they left or were removed, so existence is never revealed);
  3. caller must be an **administrator**, else `not_admin`;
  4. the trip row is locked; if it is **archived** → `trip_archived`;
  5. if `version` differs from `expected_version` → `version_conflict` (nothing is changed);
  6. if nothing actually changes, return the trip as is (no needless version bump);
  7. otherwise update; the existing table rules (lengths, dates, budget) validate; all-or-nothing.
  It has **no currency, status or creator input**, so those cannot be changed through it.
- **`set_trip_archived(trip_id, archived, expected_version)`** (callable by signed-in users): same steps 1 to 3, then locks, checks the version, is idempotent (asking for the state it's already in changes nothing), and otherwise flips `status`.
- Both are `SECURITY DEFINER`, pinned `search_path`, revoked from `PUBLIC` and `anon`, granted to `authenticated`, and use `auth.uid()` (the ADR-032 checklist, answered per function in the decisions log). **No secret key.**
- The audit test's allow-list will be edited **consciously** to add exactly `update_trip` and `set_trip_archived`; every other audit rule stays as is.

### App changes
- **Shared rules (new core file):** edit validation reuses the existing Create rules unchanged (the form's own currency is passed through), date text helpers for pre-filling the form (`2026-12-27` to `27/12/2026`), "is this person an admin of this trip", and the archived-trips helper. The approved `trip.ts` is not modified.
- **Data layer (new files):** `tripEditService.ts`, `tripEditApi.ts`, with friendly mapping: not signed in, not available (the same combined message as M3.2), **not admin**, **archived**, **version conflict**, connection failure (Try again), invalid fields shown next to the right input.
- **Screens:**
  - Details (M3.2 file, moved): admins see **Edit trip** and **Archive trip**; members see neither (just a note that only admins can change a trip); an archived trip shows its banner, hides Edit/Archive, and offers **Restore trip** to admins.
  - **Edit page:** the form pre-filled (dates as DD/MM/YYYY), same validation and messages as Create, currency shown read-only, **Save** disabled until something changes, duplicate-tap protection.
  - **Confirmation dialog** (new small component, works on web and phones): *"Archive 'Goa Trip 2026'? It leaves your active trips. Nothing is deleted: history and expenses are kept, and you can restore it later."* with Cancel / Archive (and a matching one for Restore).
  - Home: archived section (decision 3) and an "Archived" tag on those cards.
- **Conflicts:** if someone else changed the trip while you were editing, you get *"This trip was changed by someone else. Reload to see the latest, then try again."* with a Reload button; nothing is overwritten.

### Security implications
- Only active administrators can edit or archive; enforced inside the functions. The UI hiding buttons is not relied on.
- Ordinary members, strangers, removed and departed members, and signed-out callers are all refused by the database. Strangers/removed get the existence-hiding answer; members get "not an admin".
- Old data can't be overwritten silently (version check), and edits can't touch creator, status, currency or id.
- No new table permissions, no new policies, no secret key; the 12 audit tests still run against the new migration.

### Edge cases I will test
Two admins editing at once; the editor losing admin rights or being removed mid-edit; someone archiving the trip while another edits; editing an archived trip; archiving twice; restoring an active trip; clearing the description or budget; dates that move a trip between Ongoing/Upcoming/Completed (including starting or ending today, in different time zones); invalid dates and budgets; whitespace; very long text; nothing changed; double-taps; connection failure on save and on archive; direct address `/trips/<id>/edit` as a member, as a stranger, signed out.

### Tests I will write
- **Database (real Postgres engine, ~35):** each function as admin, ordinary member, stranger, removed, left, signed out; stale version leaves data untouched; archived trip refuses edits; no-op doesn't bump version; version trigger; atomicity; validation constraints; no way to change currency, status or creator through `update_trip`; members and history rows untouched by archive/restore; direct writes still denied; the helper is not callable by the app. Mutation checks (weaken each rule and confirm a test fails). Audit tests re-run with the updated allow-list.
- **Shared rules (~20)** and **data layer (~25)** with a fake client.
- **Real browser (~50 new checks):** admin sees and uses Edit/Archive/Restore; members do not see them; pre-fill; every validation message; the exact request sent; Home and details refresh; archived section; confirmation Cancel vs confirm; conflict, forbidden, not-available and connection-failure paths with Try again; double-tap; date-boundary movement between sections in three time zones; Dark theme.

### Files (expected)
**New:** one migration; `trip-edit.test.ts` (database); `tripEdit.ts` + test (core); `tripEditService.ts` + test, `tripEditApi.ts`, `TripFormFields.tsx`; `ConfirmDialog.tsx`; the edit screen.
**Changed:** the details screen (moved and extended); Home (archived section); `TripCard.tsx` (Archived tag); the Create screen (uses the shared fields; decision 5); `security-audit.test.ts` (allow-list only); `core/index.ts` (+1 line); `ui-check.ts`; docs.
**Not touched:** M1 engine, M2 auth/profile/theme/session code, `trip.ts`, `tripDetails.ts`, the M3.1 and M3.2 services, and the existing migrations.

### Not in M3.3
Member management and roles (M3.4), invitations (M3.5), deleting a trip (not planned: archive only), expenses, cover photos, editing currency.

### Limitations to expect
Web only; real-browser tests use simulated Supabase answers (the live check is yours); a page left open across midnight updates on next load; deep-link restoration after sign-in is still out of scope.
