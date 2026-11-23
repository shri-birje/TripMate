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
| **M3 — Trips and members** | 🔵 **In progress, 5 small features** (see M3 plan): **M3.1 Create a trip ✅ complete (approved 2026-11-18)**; **M3.2 View trip details ✅ complete (live-verified and approved 2026-11-18)**; **M3.3 Edit and archive, with the date input and calendar refinement: approved, committed (`84ec09e`) and pushed**; **M3.4 members and roles: plan approved (D1-D10); steps (a) and (b) approved, committed (`b3d8baf`), pushed, and migration #4 applied live**; **M3.5 invitations: v1 built (uncommitted; migration #5 applied live); revised to approval-based joining, built and tested, awaiting your review (migration #6 not applied live)**; M3.5 not started |
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
| M3.3 | Edit and archive a trip (admin only, conflict-safe) | ✅ Complete, approved, committed `84ec09e` and pushed |
| M3.4 | Members and roles: add guest members, remove, make/remove admin, leave, last-admin protection | ✅ Complete, approved, committed `b3d8baf`, pushed, migration #4 applied live |
| M3.5 | Invitation links: create, revoke, preview, join | 🟡 v1 built (uncommitted, migration #5 live). Approval-based revision built and tested; awaiting your review (uncommitted; migration #6 not applied live) |

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


---

## M3.4 — Members and roles (PLAN ONLY: nothing implemented, awaiting your approval)

**Status: planning. No M3.4 code, migration or test has been written.** M3.3 (including the date refinement) is approved, committed as `84ec09e` and pushed.

### What I inspected
Product rules (permission matrix in API_DESIGN §2), SYSTEM/SECURITY architecture, DATABASE_SCHEMA §4.3 and §6, decisions Q-4 to Q-7 and ADR-032/036/043, the live `trip_members` table and its RLS (migration 2), `create_trip`, `trip_role_of`/`update_trip`/`set_trip_archived` (migration 3), the M3.2 details read and member display, the security-audit test, and the M1 money engine.

**Facts that shape the plan**
1. `trip_members` already has everything a member model needs: `role` (admin/member), `status` (active/removed/left), `left_at`, `invited_by`, nullable `user_id` (NULL = guest), one row per person per trip. **No DML is granted to the app**: all writes must be functions. RLS lets any current member read **all** rows of their trip, including former members (so history can show names).
2. **Expenses do not exist yet** (M5). So no balances exist and Q-4 ("can someone with a balance be removed?") cannot be enforced yet. The plan makes the rule an explicit M5 obligation, like ADR-043.
3. Money history will point at `trip_members.id` (ADR-007), never at `user_id`, and **no code path may delete a member row**. Removing someone only changes `status`, so shares/repayments stay intact by construction.
4. The M3.2 screen currently requests **active members only**, so former members are not shown yet (M3.2 limit 2: "appear in M3.4").
5. Account deletion (not built) is documented as detaching `user_id`, which would turn a member into a guest-like placeholder; if that member were the last admin, the trip would have no admin. Recorded as an obligation below.

### 1. Proposed member and role model
- **Two roles, as already stored:** `admin` and `member`. No "owner": the creator is just the first admin (`trips.created_by` stays informational).
- **Two kinds of person:** a *signed-up member* (`user_id` set) and a *guest* (name only, `user_id` NULL; a friend who has not joined, claimable in M3.5).
- **Three statuses:** `active`, `left` (chose to go), `removed` (an admin removed them). Rows are never deleted.
- **Invariant (database-enforced):** every trip always has **at least one active admin who is a signed-up person**. Guests can never be admins (they cannot sign in), so a trip can never become unmanageable.
- **Permissions (all enforced in the database, the screens only hide buttons):**

| Action | Admin | Member | Guest/removed/left/stranger |
|---|---|---|---|
| See current members, roles, "you", former members | yes | yes | no (the single "not available" answer) |
| Add a guest, rename a guest | yes | no | no |
| Make admin / remove admin rights | yes | no | no |
| Remove someone | yes | no | no |
| Leave the trip | yes, only if another active admin exists | yes | no |
| Any of the above on an **archived** trip | refused (read-only), **except leaving** | leaving only | no |

### 2. Recommended business rules (decisions for you are marked **D**)
- **Promote** (member to admin): admin only; target must be an active, signed-up member of that trip (not a guest).
- **Demote** (admin to member): admin only; refused if the target is the last admin. An admin may demote themselves only if another admin exists.
- **D1. Admins are peers.** Any admin may promote, demote or remove another admin (simple, matches "who is trusted to manage"). The risk is an admin demoting a co-admin; mitigated by the audit trail below. The alternative (only the creator may demote/remove admins) is stricter but makes a creator who leaves a problem. *Recommendation: peers.*
- **Remove:** admin only; target must be active and **in this trip**; an admin cannot remove themselves (they use Leave) so the caller always stays an admin. Removed people lose all access (existing RLS, Q-7 default); the row stays.
- **Leave:** any active member for themselves. **D2. A sole admin cannot leave**; they must make someone else admin first (clear message). There is no "delete trip" (archive only), so an abandoned trip cannot appear.
- **D3. Archived trips:** member changes refused (`trip_archived`) except **leaving**, so nobody is trapped in a trip they cannot restore.
- **Guests:** added by name by an admin (Q-5/Q-6: admins only; configurable later). Name 1 to 60 characters, trimmed (existing table rule). **D4. Duplicate active names (ignoring case) are refused** so two "Rahul" can never confuse a ledger; checked inside the locked function, not by a unique index, so M3.5 joins are not blocked unexpectedly. **D5. Guest renaming is included** (typos are likely and names appear in the ledger); signed-up members cannot be renamed by an admin (their name comes from their profile; no impersonation). **D6. Cap of 50 active people per trip** (abuse bound).
- **D7. Former members are shown to every current member** (name, "Left"/"Removed", date; **not** who removed them), in a collapsed "Former members" list. They are never shown any other detail and never get access.
- **D8. Q-4 (balances).** Because no balances exist yet, M3.4 allows removal and leaving. **M5 must refuse removal/leaving while the person has a non-zero balance** (confirmed or projected) until it is settled or an admin records an explicit settlement; this becomes ADR-047 (obligation). Please confirm this is the rule you want.
- **D9. Audit trail:** add a small append-only table `trip_member_events` (who did what to whom and when: added_guest, renamed_guest, made_admin, removed_admin, removed, left). Written only by the functions, readable by current members of the trip, no direct writes. This fills the "historical records must remain auditable" requirement now instead of retrofitting later. *Alternative:* defer to the future activity log.
- **D10. Size:** M3.4 is large. I can build it in one go, or as two reviewable steps: **(a)** read side: current + former members, roles, "you", admin tags; **(b)** the write actions. *Recommendation: two steps, each tested, one approval at the end* (say if you would rather approve between them).

### 3. Database migration requirements (one new migration, additive)
- `trip_members`: add `removed_by uuid null references trip_members(id)`; add CHECK `user_id is not null or role = 'member'` (guests are never admins). Existing rows already satisfy it (only creators' admin rows exist).
- New table `trip_member_events` (see D9) with RLS: members select; no DML grants.
- **Backstop trigger:** deferred constraint trigger on `trip_members` verifying "at least one active admin with a user" per existing trip after any change (checked at commit, so `create_trip` is unaffected, and a trip deleted by cascade is skipped). It is a safety net behind the function checks, not the main defence.
- **Internal helpers (not callable by the app):** member id of a user on a trip; active-admin count.

### 4. Database functions and RLS changes
New functions (all `SECURITY DEFINER`, `search_path=''`, `auth.uid()`, revoked from public/anon, granted to authenticated only; same pattern as M3.3):
- `add_guest_member(p_trip_id, p_display_name)`
- `rename_guest_member(p_trip_id, p_member_id, p_display_name)`
- `set_member_role(p_trip_id, p_member_id, p_role, p_expected_role)`
- `remove_member(p_trip_id, p_member_id, p_expected_status)`
- `leave_trip(p_trip_id)`

Common order of checks: signed in → active member (else `trip_not_found`, the same answer for strangers/removed/left, so existence stays hidden) → admin where required (`not_admin`) → **lock the trip row** `FOR UPDATE` (this serialises every membership change on that trip, so two admins demoting each other at the same moment cannot both succeed and leave zero admins) → target belongs to **this** trip (`member_not_found`, prevents using another trip's member id) → archived check → state check against the caller's expectation (`member_changed`, so a stale screen never overwrites a newer change) → rule checks (`last_admin`, `guest_cannot_be_admin`, `name_taken`, `trip_full`, `use_leave_instead`) → change + event row, repeat-safe (asking for the state already true changes nothing).
No policy changes to `trips`/`trip_members` reads. No new grants besides EXECUTE on the five functions. Membership changes do **not** bump `trips.version` (editing a trip must not conflict with someone adding a friend). `security-audit.test.ts` allow-list gains the five names (and its other rules stay).
No secret/service-role key anywhere (ADR-032).

### 5. API and frontend changes
- **core:** `memberManagement.ts` (+test): guest-name validation (reuses the 1-60 rule), RPC argument builders, `canPromote/canDemote/canRemove/canLeave` helpers used only to show or hide buttons (the database stays the authority), former-member partition. Small additive change to `tripDetails.ts`: rows also carry `left_at`, and `TripDetails` gains `formerMembers` (existing active-member behaviour and tests unchanged).
- **app:** `tripMemberService.ts` (+test; typed errors like `tripEditService`: last_admin, conflict, not_admin, archived, unavailable, name_taken, full, auth, network, setup, unknown), `tripMemberApi.ts` (hooks; refresh details + Home list), `tripDetailsService.ts` (stop filtering out former members at the query; select `left_at`; partition in core).
- **UI on the trip page:** "People" card: each person with Admin / You / Guest tags; admins get a per-person action menu (Make admin, Remove admin rights, Remove, Rename for guests) and an "Add a friend by name" row; everyone gets **Leave trip** (disabled with an explanation for a sole admin); all destructive actions use the existing `ConfirmDialog` with plain language ("Removing Asha keeps everything she paid or owes; she just stops having access"). Conflicts offer "Reload latest". Collapsed "Former members" list. After leaving, return to Home.
- `scripts/verify-supabase.ts` probes the five functions as signed-out visitors (must be refused).
- **Unchanged:** M1 money engine, M2 auth/profile, trip create/edit/archive functions and screens (apart from where the People card sits), migrations 1-3.

### 6. Security and privacy
- Every rule lives in SQL; hidden buttons are cosmetic. Identity only from `auth.uid()`; no user id parameter anywhere (the caller is never "told" who they are).
- Existence hiding preserved; cross-trip member ids refused; role escalation impossible (a member cannot call any admin function successfully; a guest cannot be made admin; no function sets role to anything but 'admin'/'member').
- Privacy: the People list shows only display names, roles, join/left dates. No emails, UPI IDs or profile reads (co-member profiles stay unreadable). Events table stores member ids and action names only.
- Former members keep **no** access (Q-7 default); their historical rows stay for ledger display only.
- Backstop trigger and function checks are independent, so one bug cannot remove the last admin.

### 7. Edge cases and failure scenarios (each gets a test)
Last admin tries to leave / demote self / be removed; two admins act on each other at once (second is refused); stale screen (someone else changed the role first); target from another trip; removing someone already removed/left (safe repeat, no new event); promoting a guest; adding a duplicate name (different case, extra spaces); 51st person; archived trip actions (refused) and leaving an archived trip (allowed); removed/left/stranger/signed-out callers; admin removing themselves via remove; leaving while another admin exists; signed-up member whose profile was soft-deleted; connection failure keeps dialogs open for retry; double-tap on every confirm (the synchronous guard added in M3.3).

### 8. Test strategy
- **Database (real Postgres engine, PGlite):** full allow/deny matrix per function (admin, ordinary member, guest row, stranger, removed, left, signed-out); invariants after every operation; **model-based property test**: thousands of random action sequences, asserting at every step: at least one active signed-up admin, no member row ever deleted or count reduced, guests never admin, names unique among active, events match changes; balances-integrity check that the M1 engine files and money tables are untouched (no financial tables yet: asserted by schema checks that no function can delete a member row and that ids stay stable); security-audit update.
- **Mutation tests (≈12 deliberate SQL breaks, each must fail a test, then be restored byte-for-byte):** drop the last-admin check, drop the same-trip check, drop the admin check, drop the row lock, drop the guest rule, drop the archived rule, allow sole-admin leave, skip event writing, remove the backstop trigger, wrong status transition, role set from a parameter, skip the duplicate-name check.
- **Core/app unit tests:** validation, button-visibility helpers, service error mapping, former-member partition, details compatibility (existing 165+367 tests keep passing).
- **Real browser (Edge, simulated Supabase):** admin vs member views, every action with its confirmation (Cancel vs confirm), the exact request sent, conflict/last-admin/duplicate/full/archived/not-available/connection-failure paths, former members list, leaving then landing on Home, double-tap, Light/Dark, phone-sized touch screen. Your live check with two accounts becomes possible only after M3.5 (invitations); until then live checks cover the admin-only paths and guests.
- Full suite, type-check, `verify:supabase` (0 warnings) and a secret scan before reporting.

### 9. Files expected to change
**New:** one migration (members and roles); `supabase/tests/trip-members.test.ts`; `packages/core/src/memberManagement.ts` + test; `apps/app/src/features/trips/tripMemberService.ts` + test, `tripMemberApi.ts`, `PeopleCard.tsx` (and small row/menu components).
**Changed (additively):** `packages/core/src/tripDetails.ts` (+ its test: former members), `tripDetailsService.ts` (select/filter), the trip details screen (People card replaces the plain list), `security-audit.test.ts` (allow-list), `core/index.ts`, `scripts/ui-check.ts`, `scripts/verify-supabase.ts`, docs (progress, decisions log ADR-047 onward, database schema, API design, security architecture, Supabase setup step 11).
**Not touched:** M1 engine, M2 code, trip create/edit/archive logic and migrations 1-3.

### 10. Dependencies and M3.5 considerations
- Needs M3.2/M3.3 (done). Adds migration #4 for you to apply in the SQL Editor (same ritual; the migration is safe to re-run).
- **M3.5 (invitations) must reuse the same rules:** joining takes the trip lock; refuses archived trips and full trips; claims a guest by turning that row into a signed-up member with role `member` (never admin); **rejoining a left/removed row reactivates it with role reset to `member`** and clears `left_at`/`removed_by`; a joiner whose name equals an active member's gets a clear disambiguation path (this is why duplicate names are a function check, not an index); invites are created by admins only by default (Q-6); an event row is written.
- **M5 obligations (to record as ADR-047/048):** refuse remove/leave with a non-zero balance (D8); only **active** members may be payers or share-holders on new expenses, while history keeps references to former members; expenses/repayments refused on archived trips (ADR-043); all money-changing functions use the same lock + expected-state pattern.
- **Account deletion (future):** must be refused or must first hand over administration when the person is the last admin; a detached admin must never leave a trip admin-less (the guest-never-admin CHECK would reject it, which is the intended safety stop).

### Decisions I need from you
D1 peer admins; D2 sole admin cannot leave; D3 archived = read-only except leaving; D4 duplicate names refused; D5 guest rename included; D6 cap 50; D7 former members visible to current members; D8 balance rule deferred to M5 (Q-4); D9 audit events table now; D10 one build or two steps. Each has my recommendation above; "approve with the recommendations" is enough.


---

## M3.4 step (a) — Members and roles: read side (built and tested; awaiting your review; nothing committed)

**Scope: read only.** Your decisions D1-D10 are recorded as ADR-048, the mandatory M5 balance rule as **ADR-047**, and the read-side design as ADR-049. **No write action, no migration, no new database function, no new table, no permission change** was made in this step. Step (b) (add/rename guest, make/remove admin, remove, leave, audit trail) is not started.

### What it does
- **Current members and roles:** the People card on the trip page already listed current people with Admin / You / Guest tags; it now also says what **your** role is ("You are an admin of this trip." / "You are a member of this trip.").
- **Former members (D7):** a collapsed **"Former members (n)"** list inside the People card, shown only when someone has left or been removed. Each row shows the **name**, a **Guest** tag where it applies, and **"Left 21 Nov 2026"** or **"Removed 20 Nov 2026"** (the day in the viewer's own time zone; just "Left"/"Removed" if the day is unknown). Most recent first. A short note says they no longer have access and that anything they paid or owe stays in the trip's history.
- **Privacy:** a former member is reduced to name, status, day and guest flag. **No user id, no role, no email, no UPI**; a removed admin shows no Admin tag. Former members are not counted in "People (n)", the trip card's head-count or the admin list, and they get no access (unchanged).
- Everyone who is on the trip sees the same list (administrators and ordinary members); people who are not on the trip still get the single "Trip not available" answer.

### How (small, additive)
- The details request now asks for **all** of the trip's members with their `left_at` date, instead of filtering to active ones in the request; the shared rules separate them. Row-level security is unchanged: it already let a current member read their trip's former-member rows (as the M3.2 report noted), so this shows nothing the database did not already allow.
- The M3.2 rule "former members' names never appear" is **intentionally replaced** by your D7; the M3.2 tests that asserted it (one in core, three in the app service test, the matching browser checks) were rewritten to the new rule; the existing database tests are unchanged (only the fixtures gained leave dates). Everything else in M3.2 is unchanged.

### Tests and verification (only what this change affects)
| Check | Result |
|---|---|
| Type-check | Clean |
| Whole repo | **725 tests pass**: API 17, app 165, core 380 (+13), database 163 (+8); every earlier test still passes except those rewritten to D7 (listed above) |
| Core (new/changed) | former members built only from left/removed rows (unknown status is treated as current, never former); they carry only name/status/day/guest flag (no user id, no role); unreadable or missing leave times give "no date"; ordering (recent first, unknown last, name, id); wording "Left"/"Removed" with the day; the day is the **viewer's local day in 5 time zones**; `myRole` (current members only; nothing for strangers, signed-out, removed or left people); head-count and admins exclude former members |
| App service | the request names its columns, includes `left_at`, no longer filters by status, never asks for profiles/email/UPI; former members separated, no user id or role |
| Database (real Postgres engine, 8 new) | admin and ordinary member see the same current + former rows with leave dates; former guests recognisable; strangers, other-trip members, removed, left and signed-out callers see **nothing**; a former member's trip stays invisible to them; other trips never show these people; no email/UPI in the rows; **reading changes nothing and the reader cannot write or delete member rows** |
| Security conditions | no new function, table, grant or policy; security-audit allow-list unchanged and passing; `verify:supabase` passes with 0 warnings; secret scan clean |
| **Mutation check (10 deliberate breaks)** | all caught: an active person counted as former; former people in the current list; user id leaked into a former member; role leaked; oldest-first ordering; UTC day instead of the viewer's day; "Removed" described as "Left"; a stranger told they are a member; the request forgetting `left_at`; the request going back to filtering active-only. Files restored byte-for-byte. |
| Real browser (Edge), `npm run ui:check` | **391 checks pass** (375 earlier + 16 new): collapsed by default with `aria-expanded`; expands and collapses; names, order, notes and guest tag; no Admin/You tag on a former admin; no email/UPI/ids; head-count "People (3)" unchanged; role line for an administrator and for an ordinary member (who sees no Edit/Archive); a very long former name wraps on a **360 px phone screen with no sideways scrolling**; 44 px touch target; no section when nobody left; **Dark theme**; request columns |

### Limitations / unresolved
- The server still sends a former member's user id and role to the browser in the same response (the database allows a member to read those rows, and the shared rules discard them immediately, so they are never stored in the screen's state or shown). Narrowing the request further would need either a second filtered request or a database view; I recommend leaving it as is.
- A former member's name is the snapshot taken when they joined; it does not follow later profile changes (as for current members).
- "Left"/"Removed" days are computed from `left_at` in the viewer's time zone; rows with no `left_at` show no day.
- Web only in a real browser (Edge) with simulated Supabase answers; not run on a phone or emulator. Live check: you cannot produce a former member from the app until step (b) exists (the only way today is editing the database directly), so the live check of this step is limited to "nothing changed for current members".
- Who removed someone is not shown (and not recorded yet): the audit trail arrives in step (b).

### Files changed (nothing else)
**Changed:** `packages/core/src/tripDetails.ts` (+ `tripDetails.test.ts`), `apps/app/src/features/trips/tripDetailsService.ts` (+ `tripDetailsService.test.ts`), `apps/app/src/app/(app)/trips/[tripId]/index.tsx` (role line, collapsed Former members list), `supabase/tests/trip-details-access.test.ts` (8 new tests, fixtures with leave dates), `scripts/ui-check.ts` (fake server returns all members; 16 new checks), docs (`DEVELOPMENT_PROGRESS.md`, `ARCHITECTURE_DECISIONS_LOG.md` ADR-047 to ADR-049 and Q-4, `DATABASE_SCHEMA.md`).
**Not touched:** every migration, the M1 engine, M2 code, trip create/edit/archive code, the security-audit test, `core/index.ts` (exports are automatic).

### Next
Your review of step (a). Then, only on your approval, step (b): the five write functions, the append-only audit table, and the controls on the People card.


---

## M3.4 step (b) — Members and roles: write actions, audit trail and People card controls (built and tested; awaiting your review; nothing committed)

**Scope:** add a friend, rename a friend, make/remove admin, remove, leave; the append-only audit table; the controls on the People card. Implements your approved D1-D10 and ADR-047 to ADR-049, plus ADR-050 to ADR-053 recorded in this step. **Not started: M3.5 (invitations).** M1 engine, M2 code and the trip create/edit/archive code are unchanged.

### What it does
- **For administrators (active trips only):** each person has a **Manage** button (never on yourself unless you can step down). Actions offered only where they can work: **Make admin** (signed-up members), **Remove admin rights** (another admin, or yourself when another admin exists), **Rename** (friends added by name only), **Remove from trip**. **"Add a friend by name"** box (hidden at 50 people, with a note). Every change of role, removal and leaving asks first, in plain words (what is kept, who loses access).
- **For everyone on the trip:** **Leave trip**. The only admin sees it disabled with the reason ("make someone else an admin first"). Allowed on archived trips (the one exception to read-only). After leaving you go Home and the trip is gone from your list.
- **Former members** keep appearing under "Former members" (name, Left/Removed, day); nothing about them is deleted.
- **Failures are explained and recoverable:** a connection failure keeps the dialog or box open to retry; refusals (rights changed, someone changed things first, trip archived, last admin) close it and explain on the card with **Reload latest**. Names are checked at once on the screen (nothing sent for an empty, taken or too-long name). Double taps send one request.

### Rules enforced inside the database (migration `20261118300000_member_management.sql`, migration #4 for you to run)
- Six functions, all `SECURITY DEFINER`, `search_path` pinned, caller from `auth.uid()` only (**no function takes a user id**), signed-in users only: `list_trip_members`, `add_guest_member`, `rename_guest_member`, `set_member_role`, `remove_member`, `leave_trip`. One internal helper (not callable by the app) does, in order: identify the caller, refuse strangers **before** locking, **lock the trip row**, re-check membership under the lock, then admin and archived checks. A stranger, removed or departed person, or unknown trip always gets the same `trip_not_found`.
- **Always at least one active, signed-up administrator**, enforced twice and independently: inside the functions, and by a deferred trigger on `trip_members` (checked at commit). Guests can never be admins (table rule). Cross-trip member ids are refused. Duplicate active names (ignoring case and surrounding whitespace) refused; 50 active people maximum; archived trips refused except leaving; admins are equal peers (D1) and cannot remove themselves (they leave).
- **Nothing is ever deleted**: removing/leaving sets status and `left_at` only. **No expense/share/repayment history can be touched** (none exists yet; a stand-in ledger table pointing at members is used in a test to prove it stays valid, and that deleting a referenced member is blocked).
- **Audit trail `trip_member_events` is append-only:** no write rights for any app role; readable only by current members of that trip; triggers refuse update, delete and truncate even for the database owner (except the automatic clean-up if a whole trip is removed); strict `seq` order; member ids and words only. One record per successful change; refusals and safe repeats record nothing.
- **Privacy:** the trip page now reads people through `list_trip_members`, which sends a former member's **name, status, dates and guest flag but NULL user id and NULL role**. The browser never receives them (checked in a real browser). The trip request no longer touches the members table.
- ADR-047 (M5 must block removal/leaving with a non-zero balance) stays mandatory; membership changes never touch the trip itself (its version is unchanged).

### Verification (only what this change affects)
| Check | Result |
|---|---|
| Type-check | Clean |
| Whole repo | **834 tests pass**: API 17, app 191 (+26), core 403 (+23), database 223 (+60) |
| Database (real Postgres engine, 60 new in `trip-members.test.ts`) | allow/deny matrix per function for admin, ordinary member, guest, stranger, other trip's member, removed, left, signed out; read data minimised; every rule (last admin, peers, self-removal, guests, names incl. tabs/non-breaking spaces, 50 limit, archived, repeats, stale role); audit trail contents, protection and ordering; history preserved; nothing deletes; earlier trip functions unaffected; **each function refuses on its own with the safety-net trigger switched off**; and a **model test: 1,500 random actions by admins, members and strangers** compared against an independently written copy of the rules, checking after every step: nobody deleted, always a signed-up admin, guests never admin, active names unique, `left_at` set exactly when someone is gone |
| Security audit | allow-list now exactly the 10 reviewed functions; RLS on every table; no anon/PUBLIC rights; `search_path` pinned; `auth.uid()` in every callable definer function; **no secret key anywhere** |
| Core / app | button rules (what is offered to whom), names, the exact arguments (no user id), message mapping (including "only admin" wording for leaving), service checks before anything is sent, details read through `list_trip_members`, former members arrive without user id or role |
| **Mutation check (37 deliberate breaks)** | **all caught**, files restored byte-for-byte: 23 in the SQL (leave/demote as last admin, self-removal, cross-trip ids x3, no lock, no admin check, archived editable, guest admin, duplicate names, no limit, names trimmed of spaces only, removal not recorded, safety net disabled, audit trail editable, former user id and role sent, strangers can list, stale role, repeat removal, rename accounts, signed-out can leave) plus 14 in the screen rules and services. **Two survived at first** (the function-level last-admin check was masked by the trigger raising the same error); I added the independent-defence test and both are now caught. |
| Real browser (Edge), `npm run ui:check` | **480 checks pass** (391 earlier + 89 new): admin vs member views, every action with its confirmation (Cancel vs confirm), exact requests (no user ids), count/tag/notice updates, former members with privacy check, only-admin state, step-down, leaving and landing on Home, archived and 50-person states, every failure path with retry/Reload latest, stale screen refused by the database, double taps, phone width (44 px targets, confirmation inside the screen, long name), Dark theme |
| `verify:supabase` | PASSED with **0 failures and 7 warnings**: the 7 new functions "not available yet" because **migration #4 is not applied to your live project** (Step 11 in SUPABASE_SETUP). Earlier functions confirmed closed to signed-out visitors. |
| Secret scan | clean (only the existing fake test key and a doc sentence) |

### Found while testing (and fixed)
- Postgres's `btrim` trims only spaces: a name of only tabs/new lines would have been accepted. Added `name_trim` (all whitespace incl. non-breaking space) and tests.
- Timestamps can tie, so audit events needed a strict `seq` order.
- Two approved M3.1 test fixtures conflicted with the new rules for legitimate reasons (a direct SQL update removed a trip's only admin; an invalid-role insert was a guest) and got minimal fixture fixes keeping their intent; three function allow-lists were updated.
- Checking names inside the mutation delayed the message until a refresh finished; names are now validated at once on the screen.

### Deviations from the written plan
No `removed_by` column (the events table records who removed whom); `remove_member` has no expected-status argument (removing someone already gone is a safe repeat); the details read changed to `list_trip_members` to meet "minimise data returned to the browser" (ADR-050, supersedes part of ADR-049). The unreachable "last admin" guard inside `remove_member` (the caller is always another admin) is kept as belt and braces.

### Limitations / unresolved
- **Migration #4 is not applied live.** Until you run Step 11, the trip page says "Members aren't set up on the server yet". Live two-account checks need invitations (M3.5); until then a live check covers adding, renaming and removing friends, and the screens' states.
- Real simultaneous callers cannot be run in this test engine. Concurrency is covered by stale-screen simulations, a source check that every write takes the lock (strangers are refused before it, membership re-checked under it), the deferred trigger, and Postgres's own row-lock guarantee.
- A current member can still read the raw `trip_members` rows of their own trip through row-level security (including former members' user ids and roles); the app never asks for them. Closing that fully needs column-level grants touching approved M3.1/M3.2 reads (recommended later hardening, ADR-050).
- No screen shows the audit trail yet (it is recorded and readable by members of the trip).
- Browser tests use a simulated Supabase in Edge only; not run on a phone or emulator. The Android back button and native modal behaviour are unverified.
- Admins are equal peers by your decision D1: any admin can demote or remove another (recorded in the audit trail).
- M5 obligations unchanged: ADR-047 (block remove/leave with a balance), only active members on new expenses, expenses refused on archived trips (ADR-043).

### Files
**New:** `supabase/migrations/20261118300000_member_management.sql`; `supabase/tests/trip-members.test.ts`; `packages/core/src/memberManagement.ts` + test; `apps/app/src/features/trips/PeopleCard.tsx`, `tripMemberService.ts` + test, `tripMemberApi.ts`.
**Changed:** `packages/core/src/tripDetails.ts` (list rows, former-member flag) + `index.ts` (+1 line); `tripDetailsService.ts` + test (people via `list_trip_members`); trip page `trips/[tripId]/index.tsx` (the People card moved into `PeopleCard`); `supabase/tests/security-audit.test.ts` (allow-list), `trip-details-access.test.ts`, `trip-edit.test.ts` (function lists), `trips.test.ts` (two fixtures); `scripts/verify-supabase.ts` (7 probes), `scripts/ui-check.ts` (fake server + scenario K + `UI_ONLY=K` switch); docs (progress, decisions log ADR-050 to 053, database schema, API design, security architecture, Supabase setup Step 11).
**Not touched:** M1 engine, M2 code, migrations 1 to 3, trip create/edit/archive code.

### Next
Your review. Then, only on approval: commit/push, and you apply migration #4 (Step 11). M3.5 (invitations) is not started.


---

## M3.5 — Invitations and guest claiming (PLAN UPDATED with your decisions; nothing implemented, awaiting approval to build)

**Status: plan updated with your decisions D1-D10. No M3.5 code, migration or test exists yet.** M3.4 (steps a and b) is approved, committed as `b3d8baf` and pushed; migration #4 is live.

**Decisions recorded (approved):** D1 expiry 7 days by default, admin may choose up to 30. D2 single-use by default, admin may choose a higher limit. D3 only admins create invites. D4 duplicate display names ARE allowed for registered accounts (genuine users are never blocked because a name matches); guest-name uniqueness is unchanged; accounts are always identified by authenticated user id, never by display name. D5 no database rate limiting now, **recorded as a mandatory requirement before public deployment**. D10 any admin may revoke any invite (recommended approach approved).

### What I inspected
`docs/DATABASE_SCHEMA.md` §4.4 (the `trip_invites` table sketched at the architecture stage), `API_DESIGN.md` §5.4 (the original invite endpoints, written before ADR-032), `SECURITY_ARCHITECTURE.md` (the "invite abuse" threat row and residual risks), Q-5/Q-6/Q-8 in the decisions log, and the M3.4 migration, functions, audit table and `PeopleCard` this builds on.

**What M3.5 reuses from M3.4, unchanged:** the row lock + re-check pattern, the last-admin invariant, the 50-person and unique-active-name rules, `trip_member_events`, and the existence-hiding answer for anyone not on a trip. **What is new:** the only database function in the whole project callable by a **signed-out** visitor (the public invite preview), and a cryptographically random token that must never be guessable or stored in the clear.

### 1. Model
- A **trip invite** is a row in `trip_invites`: a trip, who made it, when it expires, how many times it may be used, how many times it has been, and whether it was revoked. The **raw token is shown to the admin once and never stored**; only its SHA-256 hash is kept, so a database leak cannot be turned into working invites.
- An invite is either **general** (anyone who opens the link and accepts becomes an ordinary member) or **a claim invite** for one named guest (`claim_member_id` set): accepting it turns that exact guest row into a signed-up member, keeping its id so expense history never moves.
- Accepting is **idempotent** per person: already being an active member is a safe no-op: the same person clicking twice, or a claim link opened by someone who already joined normally, changes nothing.

### 2. Feature scope
- **Create an invite** (admin only, D3): a link, an optional expiry (D1) and optional use limit (D2), optionally tied to one existing guest.
- **List invites** (admin only): active and used-up/expired/revoked ones, with their usage, so an admin can see what is out there.
- **Revoke an invite** (any admin, D10, consistent with M3.4 D1's peer model).
- **Public preview** (no account needed): trip name, destination, dates, who invited, how many people are on the trip. No budget, no money, no member list, no email.
- **Accept** (must be signed in first; if not, the screen sends them to sign up/sign in and back): joins as an ordinary member, or claims the named guest if the invite was made for one. A registered person whose display name matches an existing member is **allowed in** (D4); only guest names stay unique.
- **Not in scope:** inviting by email/SMS (link-only), changing an invite's expiry/limit after creation (revoke and make a new one instead), and anything about expenses or balances.

### 3. Database migration requirements (one new migration, additive)
- **`trip_invites`** as sketched in `DATABASE_SCHEMA.md` §4.4: `id`, `trip_id` (cascade), `token_hash` (unique, SHA-256), `claim_member_id` (nullable, → `trip_members.id`), `created_by` (→ `trip_members.id`), `expires_at`, `max_uses` (nullable = unlimited until expiry), `use_count`, `revoked_at`, `created_at`.
- **RLS, deliberately stricter than `trips`/`trip_members`:** no `SELECT` grant on the table at all, for anyone, including the admin who made it. Nobody but the function layer ever sees `token_hash`, even hashed. Listing and reading invites only ever happens through functions that return the few safe columns.
- `trip_member_events`'s action list gains `joined` and `guest_claimed` (an additive change to the existing `CHECK`, like adding `set_member_role` was for M3.3→M3.4; every row written so far stays valid).
- The token is generated with `gen_random_bytes(32)` (pgcrypto, already available) inside the database, base64url-encoded, and returned once; nothing about it is logged anywhere (and the `verify:supabase` script, which never prints keys, sets the pattern to follow).

### 4. Functions (ADR-032 pattern throughout)
- `create_invite(trip_id, claim_member_id?, expires_in_hours?, max_uses?)` — admin only (via `member_change_context`), archived trips refused; if `claim_member_id` is given it must be an active guest on that trip; returns the raw token once.
- `list_trip_invites(trip_id)` — admin only; returns id, who it is for (if a claim), expiry, uses, revoked, created — never the hash.
- `revoke_invite(trip_id, invite_id)` — admin only; safe to repeat.
- `preview_invite(token)` — **the one function open to signed-out callers (`anon`)**: hashes the token, checks it exists, is not expired, not revoked, not used up, and returns only the public fields. An invalid, expired, revoked, used-up, or entirely made-up token all give the **same** "This invite link isn't valid" answer (existence-hiding, extended to tokens).
- `accept_invite(token)` — signed-in only: re-validates the token exactly as the preview does, then either reactivates/creates the caller's own membership (general invite) or claims the named guest (claim invite); enforces the 50-person cap and the name-uniqueness rule for a brand-new join; increments `use_count`; writes one `trip_member_events` row (`joined` or `guest_claimed`). Already being an active member is a safe no-op.
- `security-audit.test.ts` gains a **second, explicit allow-list for `anon`** (today it only asserts anon can run *nothing*; `preview_invite` becomes the first and, I expect, only exception) so this stays a deliberate, reviewed decision rather than a silent one.

### 5. API and frontend changes
- **core:** `invite.ts` (+test): token/link shaping, expiry and use-limit validation, the RPC argument builders, and a pure `inviteState` helper mirroring `memberManagement.ts`'s button logic.
- **app:** `tripInviteService.ts` (+test, typed errors on the same pattern as `tripMemberService`), `tripInviteApi.ts` (hooks), an **"Invite people"** section on `PeopleCard` (admins: create/copy/revoke/list; shows the link only once, right after creation, with a clear "copy it now" warning), and a new **public** screen at `/join/:token` that works signed-out (shows the preview and a sign-up/sign-in prompt) and signed-in (shows the preview with an Accept button).
- **Unchanged:** every M3.1-M3.4 function, screen and test.

### 6. Security and privacy
- The 256-bit random token is the primary defence against guessing; it is never logged, never returned a second time, and compared only by its hash.
- `preview_invite` is the **only** anon-callable function in the project; it is pinned to a short, explicit column list (no budget, no members, no admin's user id — only their display name) and reviewed the same way M3.3/M3.4 functions were.
- No rate limiting exists inside Postgres itself. **Open risk (D5 below):** without an edge/CDN layer, nothing stops many preview or accept attempts per second beyond the token's own entropy. I recommend accepting this for M3.5 and revisiting at deployment (Q-8), since Vercel/Cloudflare can both rate-limit by path with no app code.
- Claiming a guest never creates a second member row; the claimed row's id, join date and history are unchanged, only `user_id` and (if useful) the name are updated.
- Revoked/expired/used-up tokens are indistinguishable from fake ones in the preview's answer.
- **Raw tokens are never logged** anywhere: not in database logs (the functions never write them), not in `trip_member_events`, not in the app's error reporting (the service maps every failure to a fixed message), and not in test output (tests assert the token does not appear in any error text).
- **Account identity** is always the authenticated user id (`auth.uid()`); display names are presentation only, never used to match or authorise anyone.
- **Mandatory before public deployment (D5, recorded):** rate limiting on `preview_invite` and `accept_invite` at the edge (Vercel/Cloudflare path-based rules or Supabase's own limits), because the database itself has none.

### 7. Edge cases and failure scenarios
Expired, revoked, used-up, and syntactically-invalid tokens (same message); an invite opened by an account already on the trip (safe no-op, D4 means a name match is never a reason to refuse); a claim invite whose guest was removed or renamed before it was used (the claim follows the guest's id, not their name); accepting while already an active member (no-op); accepting while the trip is archived (refused, matching the "no new members on an archived trip" rule); the 50-person cap at the moment of accepting (the duplicate-name rule applies to guests only, per D4); a signed-out visitor trying to accept (sent to sign in, then returned to the same link); two people racing to use the last remaining slot of a `max_uses` invite (the trip lock makes this safe, same as every M3.4 write); an admin revoking an invite the instant before someone accepts it.

### 8. Test strategy
Database tests (PGlite) for every function and every caller kind, including the **first-ever anon-callable function** audit case; a model-based test extending M3.4's random-sequence approach with create/accept/revoke; mutation checks on the token hashing, expiry/use-limit checks, and the claim-vs-general branching; core/app unit tests for validation and error mapping; browser tests covering create → copy → open the link signed-out → sign up → accept, and the claim-a-guest path, plus every failure message.

### 9. Files expected to change
**New:** one migration; `supabase/tests/trip-invites.test.ts`; `packages/core/src/invite.ts` + test; `apps/app/src/features/trips/tripInviteService.ts` + test, `tripInviteApi.ts`; the `/join/[token]` screen.
**Changed (additively):** `PeopleCard.tsx` (an "Invite people" section), `security-audit.test.ts` (the new anon allow-list and the extended authenticated one), `scripts/verify-supabase.ts`, `scripts/ui-check.ts`, docs.
**Not touched:** M1, M2, and every M3.1-M3.4 database function, screen and test.

### 10. Dependencies and decisions
Needs M3.4 (done). No further milestone depends on exactly this one, though M5 (expenses) will want every active member — joined by invite or not — to be an equal payer/share-holder, which is already true by construction.

**Decisions approved (recorded above and in ADR-054):** D1 expiry 7 days, admin may choose up to 30; D2 single-use by default; D3 admins only create invites; D4 duplicate display names allowed for registered accounts, guest names unique, identity always by user id; D5 no database rate limiting now, mandatory before public deployment; D10 any admin may revoke any invite.

**Remaining decisions needing your approval:** none for the design. Approving the plan means I may start building M3.5 (migration, functions, service, UI, tests) when you say so.


---

## M3.5 — Invitations and guest claiming (built and tested; awaiting your review; nothing committed)

**Scope:** invitation links (create, copy, list, cancel), the public preview, accepting a link, and claiming a guest's place with history preserved. Built in the four parts you asked for. Implements your approved D1-D5 and D10, ADR-054, and records ADR-055 to ADR-058. **Not started: M4 or any other milestone.** M1 engine, M2 code and every M3.1-M3.4 function, screen and test are unchanged except where listed under "Files".

### Part 1 - Database (migration `20261118400000_invitations.sql`, migration #5 for you to run)
- **`trip_invites`**: stores only the **SHA-256 hash** of a **256-bit random token**; the table has **no grants and no policy for anyone**, not even the administrator who made an invitation. Limits: 1 hour to 30 days (default 7 days), 1 to 50 uses (default 1), a claim link always 1, at most 50 outstanding links per trip, `revoked_by` recorded. The audit trail gains `joined` and `guest_claimed` (never a token).
- **Five functions**, `SECURITY DEFINER`, `search_path` pinned: `create_invite`, `list_trip_invites`, `revoke_invite` (administrator of an active trip; any admin may cancel any link), `accept_invite` (signed in; locks the trip then the invitation), and `preview_invite`.
- **`preview_invite` is the only function in the project signed-out visitors may run.** It returns at most one row of eight fixed facts (trip name, place, dates, inviter's name, head-count, whether it is for a friend, that friend's name): no ids, budget, people, account data or hashes. Every unusable token (unknown, malformed, expired, cancelled, used up, archived trip, claimed guest gone) gives the **identical empty answer**; `accept_invite` gives the single `invite_invalid`. No error text, log line or audit row ever contains a token.
- The security audit now has an **explicit signed-out allow-list** (just `preview_invite`) with its own stricter rules (token format and hash, expiry, cancellation, use count, active trip; fixed result shape; no budget/account data) and asserts the invitations table has no permission for anyone.

### Part 2 - Rules, service and hooks
Core `invite.ts` (token pattern, options and limits, link and token-from-pasted-text helpers, argument builders, wording); `tripInviteService.ts` (typed errors with **fixed sentences only**: a token can never reach a message even if the database text contains it); `tripInviteApi.ts` (hooks; the preview's cache entry is dropped when the screen closes, the created token lives only in the mutation result that the screen clears); `lib/pendingInvite.ts` (remembers a link across sign-in: well-formed tokens only, expires after 1 hour, cleared once used or found invalid, memory fallback).

### Part 3 - Screens
- **Invite people** (administrators, active trips) inside the People card: choose 1 day / 7 days / 30 days and 1 / 5 / 10 people (defaults 7 days, 1 person, reset for every new link), **Create link**; the link is shown **once** with a clear warning, **Copy link** (Share sheet on phones), **Done** drops it. Active links listed ("For anyone · 0 of 1 used · Expires in 7 days") with **Cancel this link** (asks first); past links in a collapsed list. Failures explained (50 links, connection, rights changed).
- **Public `/join/<token>` screen:** works signed out and signed in. Signed out: a preview card, then **Sign in to join** or **Create an account**; the link is remembered and the person is **brought straight back after signing in**. Joining is **always an explicit press**. Every unusable link shows the same "This invite link isn't valid" page. Failures (trip full, claim conflict, connection) are explained and retryable.

### Part 4 - Guest claiming and history
**Invite to claim this spot** on a friend added by name makes a single-use link for that friend. Accepting turns **that same row** into the person: same member id, join date, name and role (ordinary member), now tied to the account; nobody is added, so the 50-person limit does not apply and anything that points at the member stays intact (tested with a stand-in ledger). A **returning** person gets their old row back with role reset to member; someone **already on the trip** is a safe no-op that does not use the link up; a person who was on the trip before cannot take a friend's place (`claim_conflict`, they need a general link); two links for one friend: the first claims, the second is useless. **Duplicate display names never block a registered account (D4)**; guest-name uniqueness is unchanged; accounts are matched by user id only.

### Verification (only what this change affects)
| Check | Result |
|---|---|
| Type-check | Clean |
| Whole repo | **927 tests pass**: API 17, app 223 (+32), core 415 (+12), database 272 (+49) |
| Database (real Postgres engine, 47 new in `trip-invites.test.ts`) | allow/deny per function for every caller kind incl. signed-out; the table is unreadable; tokens are 64 hex, hashed, appear nowhere in the database, and 200 tokens are all different; create rules and limits; list/revoke; **preview** shows exactly the fixed facts and gives the identical empty answer for every kind of unusable token; accept: join, single/multi use, expiry boundary, cancellation, archived, full trip, already-member, returning person, same-name accounts, **claim keeps member id/name/join date/role**, claim conflicts, two links one friend, stand-in ledger stays valid; no error text contains a token; earlier features unaffected; a **model test** (25 random sequences of 40 create/accept/revoke/expire/leave actions) against an independent copy of the rules, checking after every step who is on the trip, one row per person, always an administrator, and each invitation's use count |
| Security audit | allow-lists updated (15 signed-in functions, 1 signed-out); no secret key anywhere; `verify:supabase` PASSED with 0 failures and **6 warnings** = migration #5 not yet applied to your live project (it also probes that `preview_invite` gives an empty answer for an unknown link once applied) |
| **Mutation check (51 deliberate breaks)** | **all 51 caught**, every file restored: 39 in the SQL (non-admin/archived creation, missing limits, token not random, raw token stored, hash not a hash, cross-trip cancel, preview and accept ignoring expiry/cancellation/use count/archived/claimed guest, missing token check, unlocked trip/invitation, no-op treated as new, claim over an account or an old row, missing cap, administrator not demoted on return, joiner made admin, unrecorded join, uncounted use, overwritten friend name, signed-out grants, readable table, missing audit word) plus 6 in the shared rules, 4 in the service and 2 in the remembered link |
| Real browser (Edge), `npm run ui:check` | **554 checks pass** (480 earlier + 74 new, scenario L): create/copy/done/reload (the token is nowhere afterwards: not in the page, not in browser storage, not in any response from the list), options and defaults, claim links, cancel (Keep it vs confirm), failures, who sees the panel, double taps; **signed-out preview** (exact facts, no budget/people/ids, only the token in the request body, public key not a login, no other requests), seven kinds of unusable link look **identical** and malformed ones never contact the server; **sign in from the link, brought back, Join is explicit, joined, remembered link cleared, no duplicate on a second use**; claiming (same member, name kept, tagged You not Guest, nobody added); full trip, claim conflict, connection failure and retry, link used up between preview and Join, double-tap Join; **no token ever in the console or a request URL, no user id in any invitation request**; phone width (44 px targets) and Dark theme |

### Found while testing (and fixed)
- A freshly made 7-day link would have read "Expires in 6 days" (rounding down); days now round to the nearest day.
- The options panel kept the previous choice (a 30-day setting leaked into the next, claim link); options now reset to the defaults for every new link.
- A browser test switched a network failure on before the join page had loaded (so the preview failed instead of the Join press); the test was reordered, the app was right.
- Test data: the browser harness's fake members needed UUID-shaped ids (as real ones are).

### Deviations from the plan (all recorded as ADR-058)
`max_uses` is NOT NULL between 1 and 50 (no "unlimited"); a `revoked_by` column; a cap of 50 outstanding links per trip; the link base is the app's own address (until a web address is chosen, Q-8).

### Limitations / unresolved
- **Migration #5 is not applied live.** Until you run Step 12 of `SUPABASE_SETUP.md`, creating a link says "Invitations aren't set up on the server yet". A real second account (and a third for a claim) is needed for the live check; the screens and every rule are otherwise tested.
- **Rate limiting is NOT implemented and is mandatory before public deployment (ADR-054).** The database has none; add edge rate limits on `preview_invite` and `accept_invite`.
- Real simultaneous callers cannot be run in this test engine; races are covered by "second caller after the first" simulations, source checks that every write takes the trip lock first, and Postgres's own row lock.
- The token is in the page address of a link (`/join/<token>`) and, for a signed-out visitor, in browser local storage for up to an hour; cleared as soon as it is used or found invalid.
- Browser tests use a simulated Supabase in Edge only: not run on a phone or emulator (the native Share sheet, native back button and an email-confirmation round trip for new accounts are unverified).
- The link base is the address the app runs on until a domain is chosen (Q-8), so a link made on `localhost` only works on that computer.
- No screen shows the audit trail yet.
- ADR-047 (block removal/leaving with a balance) and ADR-043 remain mandatory for M5.

### Files
**New:** `supabase/migrations/20261118400000_invitations.sql`; `supabase/tests/trip-invites.test.ts`; `packages/core/src/invite.ts` + test; `apps/app/src/features/trips/tripInviteService.ts` + test, `tripInviteApi.ts`, `InvitePanel.tsx`; `apps/app/src/lib/pendingInvite.ts` + test; `apps/app/src/app/join/[token].tsx`.
**Changed (additively):** `PeopleCard.tsx` (Invite section, Invite to claim this spot), `app/_layout.tsx` (open `/join` route, return to the link after sign-in), `packages/core/src/memberManagement.ts` + test (`canInviteToClaim`), `core/index.ts` (+1 line), `supabase/tests/security-audit.test.ts` (signed-out allow-list, new rules) and the function lists in `trip-details-access.test.ts`, `trip-edit.test.ts`, `trip-members.test.ts`; `scripts/verify-supabase.ts` (probes), `scripts/ui-check.ts` (fake invitation functions, scenario L, `UI_ONLY=L`); docs (progress, decisions log ADR-054 status + ADR-055 to 058, database schema, API design, security architecture, Supabase setup Step 12).
**Not touched:** M1 engine, M2 code, migrations 1 to 4, trip create/edit/archive code.

### Next
Your review. Then, only on approval: commit/push, and you apply migration #5 (Step 12) and try it with real accounts. No other milestone is started.


---

## M3.5 revision — Approval-based joining (REVISED PLAN ONLY: nothing implemented, awaiting your approval)

**Status: plan.** Requested 2026-11-23. The M3.5 v1 implementation above (multi-use general links joined immediately) is built and tested but **not committed**; HEAD is `b3d8baf`. **Migration #5 (`20261118400000_invitations.sql`) is already applied to the live project** (`verify:supabase` finds all its functions with 0 warnings), so it must **not** be edited; the revision is a new, forward-only **migration #6**.

### 1. Revised workflow
1. An admin creates the trip's **one** general invitation link (expiry 1 / 7 / 30 days, default 7; no usage limit).
2. The admin shares it anywhere (WhatsApp...). The link is shown once (only a hash is stored).
3. A visitor opens `/join/<token>`, sees the narrow public preview (unchanged), signs in or creates an account, and is brought back.
4. The visitor presses **Request to join**. This creates a **pending join request**. It does **not** create any membership, so the visitor still cannot read anything about the trip (no row in `trip_members` means the existing row-level security hides the trip, its people and, later, its money).
5. Admins see **Join requests (n)** in the People section and **Approve** or **Reject**.
6. Only approval creates (or restores) the membership, atomically, with all checks re-run under the trip lock.

Admins can **revoke** the link or **replace** it (a new link, the old one stops working). Revoking or replacing never removes anyone and never deletes requests.

### 2. General link versus guest claiming
| | General link | Guest-claim link (kept) |
|---|---|---|
| Made from | Invite people → Create link | the guest's Manage → Invite to claim this spot |
| How many | one live link per trip | one live link per guest |
| Uses | unlimited until expiry or revocation | single use (consumed when a request is made with it) |
| Result of using it | a **join request** | a **claim request** for that guest |
| On approval | a new ordinary member, or the person's own old row restored (role reset to member) | **the guest's own row** gets the account: same member id, name, join date, role, history; nobody added |
| Refused when | trip archived, link unusable, 50 members on approval | guest gone or already claimed, account already on the trip, account has a former row (`claim_conflict`) |

**Recommendation for claims (decision A below): claims also need admin approval.** The claim link is still tied to one guest and single use, but the person who uses it only *requests* to take the spot; an admin sees "Ravi Kumar (account) wants to claim Gita's place" and approves. This stops a forwarded or leaked claim link from handing a guest's history to the wrong person, gives one approval queue for everything, and needs no email lookup. (The identity-bound alternative, binding the link to an email or phone in advance, needs access to account emails, which TripMate deliberately never exposes; not recommended.)

### 3. Database changes (migration #6, forward-only)
- **`trip_invites` (kept):** keep `token_hash`, `claim_member_id`, `created_by`, `expires_at`, `revoked_at`, `revoked_by`, `use_count` (now just "requests made"). **Drop `max_uses`** and its two constraints. **One live general link per trip** enforced by a partial unique index (`trip_id` where it is general and not revoked); `create_invite` revokes the previous general link in the same locked transaction ("replace"). Same for one live claim link per guest. Existing links on the live project are **all revoked** by the migration (they were made under the old rules); members who joined through them stay members.
- **New `trip_join_requests`:** `id`, `trip_id`, `invite_id`, `user_id` (the requester's auth id; never shown to anyone), `requester_name` (profile name snapshot, shown to admins), `claim_member_id` (null for a general request), `status` (`pending` / `approved` / `rejected`), `created_at`, `decided_at`, `decided_by` (admin's member id), `member_id` (the membership that approval created or restored). Unique **one pending request per account per trip**, and **one pending claim per guest**. At most 50 pending requests per trip. RLS on, **no grants at all** (functions only, like `trip_invites`); rows are never deleted.
- **Functions:** `create_invite(trip, claim_member?, expires_in_hours)` (no uses argument), `list_trip_invites`, `revoke_invite`, `preview_invite` (unchanged; still the only signed-out function), **`request_to_join(token)`** (signed in; replaces `accept_invite`), **`list_join_requests(trip)`** (admins; name, when, which guest for a claim; no user ids), **`decide_join_request(trip, request, approve)`** (admins). **`accept_invite` is dropped.**
- **Audit:** request creation, approval and rejection live on the request row (`created_at`, `decided_at`, `decided_by`, `status`); link creation and revocation on the invite row (`created_by`, `revoked_by`); the resulting membership change in `trip_member_events` (`joined` / `guest_claimed`, now with the **approving admin as the actor** and the request id as the value).

### 4. Security and authorization
- All rules inside the functions; caller only from `auth.uid()`; no secret key; ADR-032 pattern (definer, pinned `search_path`, explicit grants, audit allow-lists updated).
- **`request_to_join`:** token format and hash, link not expired or revoked, trip active, claim guest still an unclaimed guest; already an active member: safe no-op; already pending: returns the same request (no duplicate). Never creates membership.
- **`decide_join_request`:** uses the existing member-change helper (active admin, trip row locked, archived refused), then **re-checks under the lock**: request is in this trip and still pending (a second admin deciding at the same moment gets "already decided", no double membership), requester's profile still exists, requester not already active (then the request is marked approved with no change), **50-member cap**, and for claims: guest still an active unclaimed guest, requester has no other row on the trip. Approval and membership change are one transaction.
- **Pending people get nothing:** no membership row, so every existing trip, member and (future) expense rule already hides everything. Tested explicitly.
- Tokens: unchanged (256-bit, SHA-256 only, shown once, never logged; preview identical empty answer for any unusable link). Rate limiting stays **mandatory before public deployment (ADR-054)**.

### 5. UI changes
- **Invite people:** no link yet: expiry choice (1 / 7 / 30 days, default 7) and **Create invitation link**. Link exists: "Invitation link · expires in 6 days · created ...", **Replace link** and **Revoke link** (both ask first). The show-once box stays (with a note: to share again later, Replace it; the old link stops working). Usage-limit chips and wording removed. Claim links listed per guest.
- **Join requests (n)** (admins, collapsed by default, count always visible): name, when, "wants to claim Gita's place" for claims; **Approve** / **Reject** with confirmation; clear messages for full trip, already decided, archived, guest gone.
- **Join screen:** signed in: **Request to join** (or **Request to claim Gita's place**); afterwards "Request sent. An admin needs to approve it; the trip will appear on your Home screen when they do." Re-opening shows the same. Already a member: goes to the trip. Rejected: "This request wasn't accepted."

### 6. What is reused (as is)
Token generation and hashing, `preview_invite`, `trip_invites` (minus `max_uses`), `invite_token_hash`, `revoke_invite`, `list_trip_invites` (smaller result), `member_change_context`, the signed-out allow-list and its stricter audit rules, the membership-restoring and claim logic of `accept_invite` (moved into `decide_join_request`), `tripInviteService` error pattern and fixed messages, `pendingInvite` and the return-after-sign-in route guard, the `/join/[token]` screen shell, `InvitePanel` (show-once box, copy, expiry chips, collapsible lists, creation time), the guest "Invite to claim this spot" button, the fake-server and browser-scenario structure, DB test helpers and the mutation runner.

### 7. What changes or is removed
- **Removed:** usage limits (`max_uses`, `USE_CHOICES`, "Maximum people who can join using this link", the 50-outstanding-links cap), `accept_invite` and its immediate-join path, the multi-use tests.
- **Changed:** `create_invite` (no uses, replace semantics), `list_trip_invites` result, core `invite.ts` (options without uses; request outcomes), `tripInviteService`/`tripInviteApi` (`requestToJoin`, `listJoinRequests`, `decideJoinRequest`), `InvitePanel`, `PeopleCard` (Join requests section), the join screen, `security-audit.test.ts` allow-lists, `trip-invites.test.ts` (accept sections rewritten as request + decide), scenario L (join part), docs.
- **Invalidated assumptions:** "using a link makes you a member" (now never); "a general link has a use limit"; ADR-054 D2 and ADR-057's general-join rule (superseded); ADR-058's `max_uses` deviation (superseded).

### 8. Migration strategy
- Keep migration #5 exactly as applied. New **migration #6** (`20261123000000_join_requests.sql`): drop `accept_invite`; drop and recreate `create_invite` and `list_trip_invites` (their signatures change); revoke all existing links; drop `max_uses`; add the one-live-link indexes; create `trip_join_requests`; add `request_to_join`, `list_join_requests`, `decide_join_request`. Safe to run more than once; nothing about trips, members or the audit trail is deleted.
- Order for you: run #6 after #5 (Step 13 in `SUPABASE_SETUP.md`); `verify:supabase` will probe the new functions and confirm `accept_invite` is gone.
- One commit for all of M3.5 (v1 + revision) after your review, as before.

### 9. Essential tests and edge cases
Pending requester reads nothing (trips, members, invites, requests); duplicate request returns the same one; two admins deciding the same request (the second is "already decided", one membership); approval at 50 members refused and the request stays pending; approval after the requester joined another way; requester's profile deleted; rejected then re-request (per decision B); link revoked or replaced while a request is pending (per decision C); archived trip refuses requests and decisions; one live general link and one live claim link per guest enforced by the database; replacing a link stops the old one; claim: same member id and history kept, guest removed or claimed before approval, requester already a member, requester with a former row, two people trying to claim one guest; returning member gets the old row back as an ordinary member; audit rows have the right actor; no user id or token in any admin-facing answer; tokens never in logs, URLs or errors; signed-out allow-list still exactly `preview_invite`; mutation checks on each rule; browser: create/replace/revoke, request flow with sign-in return, admin approve/reject, pending visitor sees nothing, phone and Dark.

### 10. Decisions needing your approval
- **A. Guest claims:** require admin approval (recommended) or keep the immediate claim of v1?
- **B. After a rejection:** the same account cannot request again with the **same link**; it needs the replacement link (recommended, stops re-request spam). Alternative: may re-request any time.
- **C. Pending requests when a link is revoked or replaced:** stay in the queue for an admin to decide (recommended; approval is the real gate). Alternative: revoking auto-rejects them.
- **D. Show-once link:** because only a hash is stored, an admin can copy the general link only when it is created; to share it again later they must **Replace** it (the old one stops working). Recommended (as your security rules require); please confirm this is acceptable.
- **E. Existing live links:** migration #6 revokes all links made under the old rules (recommended; members who joined through them stay).


---

## M3.5 revision — Approval-based joining (BUILT AND TESTED; awaiting your review; nothing committed; migration #6 NOT applied to live Supabase)

**Scope:** one reusable general invitation link per trip; using a link only ever creates a **pending join request**; an active administrator approves or rejects it; guest claims also need approval and keep the guest's member record and history. Implements your approved plan, ADR-059, decisions A to E and the additional rule (ADR-060). M1 engine, M2 code and M3.1 to M3.4 behaviour are unchanged. **Not started: M4.**

### What was built
- **Database (forward-only migration #6, `20261123000000_join_requests.sql`; migration #5 is untouched):** `accept_invite` is removed; `trip_invites` loses `max_uses`; one live general link per trip and one live claim link per guest (the database refuses a second); `create_invite` now replaces the previous link of its kind; new `trip_join_requests` table (no grants for anyone); new functions `request_to_join`, `list_join_requests`, `decide_join_request`. All links made under the old rules are revoked once, the first time it runs (memberships untouched; running the file again never cancels newer links).
- **Core** (`invite.ts`): options are only "how long it lasts" (1 / 7 / 30 days, 7 default), argument builders for the new functions, request and approval wording, local-time labels ("Created ...", "Asked ...").
- **Service and hooks:** `createInvite` (replace semantics), `listInvites`, `revokeInvite`, `previewInvite`, **`requestToJoin`**, **`listJoinRequests`**, **`decideJoinRequest`**; fixed-sentence errors only (a token can never reach a message); hooks refresh only what an *approval* changes.
- **Screens:**
  - **Invite people:** no usage-limit chips; one link: **Create invitation link / Replace link / Revoke link** (the link is shown once; to share again, replace it); friend links from **Invite to claim this spot** (single use); Active and Past invitations collapsible with creation times.
  - **Join requests (n)** in the People section (admins; collapsed by default, count visible): name, when asked, and "Wants to take Gita's place"; **Approve** / **Reject** each ask first in plain words; clear messages for a full trip, "another admin already answered", missing account, and connection retry.
  - **Join screen:** **Request to join** (or "Ask to take Gopal's place") -> "Request sent. An admin needs to approve it...", with "until then you cannot see anything about the trip"; asking again says "already asked".

### How each decision is enforced (all inside the database)
- **A, claims need approval:** a claim link only creates a claim request; the friend's row is untouched until approval, then it becomes the person (same member id, name, join date, role; nobody added; the 50-person limit does not apply). Tested with a stand-in ledger pointing at the guest.
- **B, no second ask with the same link after a rejection:** one request per account per link (`request_used`); a replacement link allows a new request. Also true after approval followed by leaving.
- **C and the additional rule, expiry/revocation/replacement never touch submitted requests:** they only stop new requests; an administrator can still approve a request made with a link that has since expired, been revoked or replaced (tested).
- **D:** the link is shown once; if lost, replace it. **E:** the migration revokes old links once.
- **Pending people see nothing:** no membership row, so every trip, member, link, request and audit rule hides everything (tested against every trip function, including that they cannot approve themselves).
- **Races:** deciding locks the trip, then the request, and re-checks everything (still pending, trip active, requester's profile, the 50-member limit, the friend's place still free). Two administrators on one request: the second is told "already decided", one membership, one audit event with the **approving administrator as the actor**.
- **Duplicates:** one pending request per account per trip (a person waiting through an old link who opens the replacement is told it is the same request); one pending claim per guest; at most 50 waiting requests per trip.

### Verification (only what this change affects)
| Check | Result |
|---|---|
| Type-check | Clean |
| Whole repo | **967 tests pass**: API 17, app 234 (+11), core 424 (+9), database 292 (+20 over the earlier 272) |
| Database (real Postgres engine; `trip-invites.test.ts`, 67 tests) | every caller kind incl. signed out; tables unreadable and unwritable by anyone; tokens (64 hex, hash only, nowhere in the database, 150 distinct); one live link per trip / per friend and replacement; limits (1 hour to 30 days); preview shows exactly the fixed facts and gives one identical empty answer for every unusable token; requests never make a membership; a pending person sees nothing (every trip function refuses or returns nothing); duplicate and same-link rules; the 50-pending cap; approval, rejection, returning member (old row, role reset), claim (same row kept), full trip, archived trip, missing account, two administrators, expiry/revocation after asking; audit actors; model test of random request / approve / reject / replace / revoke / expire / leave sequences |
| Security audit | allow-lists updated (17 signed-in functions, still exactly one signed-out function: `preview_invite`); no grants on the invitations or requests tables; `accept_invite` proven gone |
| **Mutation checks** | **51 database / rules / service breaks, all caught** (one survivor, "approval can take over a person with an account", led to a new test and is now caught), plus **4 screen breaks, all caught** (Approve sending a rejection, asking taking the person straight to the trip, join offered without signing in, secret link left on screen); every file restored. Includes: asking also creating a membership, a rejected person asking again, two people queuing for one place, ignoring expiry/cancellation/archived, an ordinary member deciding, a returning administrator keeping admin, a missing audit actor, signed-out grants |
| Real browser (Edge), `npm run ui:check` | **585 checks pass**, scenario L 105: create / copy / done / reload (token nowhere), replace (old link dead, one active), revoke (asks, requests stay), friend links, failures, who sees what; join requests (collapsed with count, local times, claim wording, approve / reject with confirmations, exact requests, no user ids, stale "already answered", retry, full trip, archived); visitor flow (signed-out preview, eight kinds of unusable link look identical, sign in and come back, explicit Request to join, **no membership, trip invisible and absent from Home until approval**, asking twice, claim request leaves the friend untouched, rejected / waiting / earlier-member / connection / cancelled-in-between / double-tap); no token in console or URL, no user id in any request; phone width and Dark theme |
| Live check (`verify:supabase`) | PASSED, 0 failures, **4 warnings** = migration #6 not applied yet (three new functions missing, `accept_invite` still exists); once applied it checks all four |
| Secret scan | clean (only the known fake test key and a doc sentence) |

### Found while testing (and fixed)
- A claim by someone already linked elsewhere had no test; added, with the database check proven.
- Test data: guests on different fake trips shared an id (real ids are unique per row).
- Earlier UI request, kept: Active / Past invitations collapsible, creation times, options reset to 7 days.

### Limitations / unresolved
- **Migration #6 is applied live** (Step 13; it cancelled the old links). The real-account check (ask, approve, claim) was carried out as part of the final M3.5 test (see the UX finalisation section). Until then the live app would still show the old M3.5 v1 behaviour.
- **Rate limiting is NOT implemented and is mandatory before public deployment (ADR-054):** the database has none.
- A waiting person has no indication on their own Home screen (the database gives them no way to see anything about the trip, including their request); they see "Request sent" once, and when approved the trip appears.
- Real simultaneous callers cannot be run in this test engine: races are covered by "second caller after the first" simulations and source checks that every write locks first.
- Browser tests use a simulated Supabase in Edge only: not run on a phone or emulator (native Share sheet, back button and the email-confirmation round trip for new accounts are unverified).
- The link base is the address the app runs on until a domain is chosen (Q-8): a link made on `localhost` only works on that computer.
- The token is in the page address, and for a signed-out visitor in browser local storage for up to an hour (cleared once they ask or the link proves invalid).
- A rejected friend-claim needs a fresh claim link (single use), a direct result of decision B.
- No screen shows the audit trail yet.
- ADR-047 (block removal/leaving with a balance) and ADR-043 remain mandatory for M5.

### Files
**New:** `supabase/migrations/20261123000000_join_requests.sql`; `apps/app/src/features/trips/JoinRequestsPanel.tsx`.
**Rewritten for the approval model:** `supabase/tests/trip-invites.test.ts`; `packages/core/src/invite.ts` + `invite.test.ts`; `tripInviteService.ts` + test, `tripInviteApi.ts`; `InvitePanel.tsx`; `apps/app/src/app/join/[token].tsx`.
**Changed:** `PeopleCard.tsx` (Join requests section); the audit and function lists in `supabase/tests/security-audit.test.ts`, `trip-details-access.test.ts`, `trip-edit.test.ts`, `trip-members.test.ts`; `scripts/verify-supabase.ts` (new probes, `accept_invite` must be gone); `scripts/ui-check.ts` (approval-based fake functions, scenario L rewritten); docs (progress, decisions log ADR-059 approved and ADR-060, database schema, API design, security architecture, Supabase setup Step 13).
**Not touched:** migrations 1 to 5, M1 engine, M2 code, trip create/edit/archive code.

### Next
Your review. Then, only on approval: you apply migration #6 (Step 13) and try it with real accounts, and I commit and push (M3.5 v1 and the revision together). M4 is not started.


---

## M3.5 UX finalisation: one reusable, copyable link (proposal, approved as Option 1 = Supabase Vault; see the built report at the end)

**Requested 2026-11-23:** one WhatsApp-style general link per trip that an admin can **copy repeatedly (the same token)**; Replace link removed; Revoke link kept; Past invitations section removed; Former members, guests and guest claim links untouched; submitted requests never invalidated; approval always mandatory.

### The one thing that needs a design decision
Today `create_invite` builds the token inside the database, stores **only its SHA-256** and returns the raw token **once**; nothing can ever give it back. **Repeated copying of the same link is therefore impossible with the current design:** a hash cannot be turned back into a token. Something must keep the token in recoverable form. The minimal options:

| Option | How | Security | Cost |
|---|---|---|---|
| **1. Supabase Vault (recommended if your project has it)** | Keep the token as an **encrypted** secret in Supabase Vault (the encryption key is managed by Supabase and is not readable through SQL/tables); the invitation row only stores the secret's id. A new admin-only function returns it on demand; Revoke (and replacing an expired link) deletes the secret. Validation still uses the hash exactly as now | Encrypted at rest with a key outside the tables; hash validation unchanged; only admins of that trip can fetch; never logged; the browser drops it right after copying | new migration #7; a platform feature to confirm is enabled (`select extname from pg_extension where extname = 'supabase_vault'`); cannot be exercised by the local test engine, so tests use a stand-in and the real encryption is checked live |
| **2. Plain column** | Store the raw token in a column, readable only through the admin-only function | **Weakens the hash-only rule**: a database leak or backup shows live links. Harm is limited because every request still needs admin approval (an attacker can only queue up to 50 requests and see the public preview) | smallest change; fully testable; needs your explicit approval because it relaxes an earlier rule |
| **3. Remember it in the browser** | The creating device keeps the token | Token sits in browser storage; other admins and other devices cannot copy it; lost with the browser data | no database change but does not meet "any admin, every time" |

**Recommendation:** Option 1, with Option 2 only if Vault is unavailable and you accept the trade-off in writing. Only the **general** link would be stored this way; guest claim links stay show-once and hash-only.

### Everything else (independent of that decision)
- **Migration #7 (forward-only, #1 to #6 untouched):** needed for the token storage and the function. It would also change `create_invite` so that creating a general link **refuses when a live one exists** (`invite_exists`); with Replace gone, a stale screen must not be able to silently kill a link people already received. An expired or revoked link can be followed by Create invitation link.
- **Expiry:** keep 1 / 7 / 30 days, default 7. **No never-expiring link:** with a reusable, retrievable link, expiry is the only automatic safety net (a leaked link would otherwise stay usable forever; each use is still approval-gated and capped at 50 waiting requests). Admins can create a fresh link after expiry.
- **UI:** `InvitePanel.tsx`: remove Replace link and its notes; remove the Past invitations section; add **Copy link** to the active link (fetches the link on click, copies it, never shows it or keeps it in memory); keep Revoke link, claim links and the creation time. `PeopleCard`, `JoinRequestsPanel`, the join screen: unchanged.
- **Core/service/hooks:** wording and a `getInviteLink` call and hook.
- **Tests:** database (retrieval admin-only, same token every time, hash unchanged, gone after revoke, one live link refused, requests survive revoke/expiry), security audit allow-list, mutation checks, scenario L, type-check.
- **Not touched:** former members, guest add/claim/approval, the financial engine, member rules, RLS, requests and approval logic, the existing migrations.

---

## M3.5 UX finalisation: COMPLETE (migration #7 applied live and verified; real-account test passed; approved and committed)

**What changed for an admin:** the trip has one reusable invitation link; **Copy link** works every time and gives the **same link**; **Revoke link** ends it for good; **Replace link** and **Past invitations** are gone; creating a link is refused while a valid one exists (revoke first, or wait for expiry); a link made before this update stays valid but shows a note that it cannot be copied (revoke it and create a new one); friends' single-use links stay show-once and are listed under **Links for friends**. Expiry 1/7/30 days (default 7). Joining still needs admin approval; submitted requests are never touched by revoke or expiry. Former members, guest creation, guest claiming and approval flows are unchanged.

**How repeated copying works securely (ADR-061/062):** the general link's token is stored only as an **encrypted Supabase Vault secret**; the invitation row keeps its SHA-256 hash (validation unchanged) and the secret's id. `get_general_invite_link(trip)` is `SECURITY DEFINER`, `search_path = ''`, uses `auth.uid()`, requires an **active administrator**, and returns the token only for a live, unexpired link on an active trip whose SHA-256 matches the stored hash. Revoking (or making a new link after expiry, or deleting the trip) deletes the secret. The app asks on each press, copies, then drops the token from memory; it is never in a list, URL, log, cache or error message.

**Migration #7** (`20261123100000_reusable_general_link.sql`, forward-only; #1 to #6 untouched) is needed because a hash cannot be reversed: it adds `token_secret_id`, the claim-link constraint, the clean-up trigger, `get_general_invite_link`, and updates `create_invite`, `revoke_invite`, `list_trip_invites`. It refuses to run unless the Vault exists and `anon`/`authenticated` cannot read it. **You apply it with Step 14 of `SUPABASE_SETUP.md`**, which includes read-only Vault permission checks.

**Tests:** database suite 313 pass (new Vault tests: secret creation, retrieval, expiry, deletion, trip cascade; unauthorised callers; repeated copy returns exactly the same link; two admins get the same link; revoked/expired links cannot be retrieved or used; legacy links; claim links never stored; swapped-secret integrity; Vault closed to the app; no raises containing tokens) plus new Vault rules in the security audit; app 238, core 425, API 17 pass; type-check clean; scenario L 109 browser checks pass; mutation checks: 7 breaks of the new migration (no admin check, ignoring expiry, ignoring revocation, no hash check, signed-out grant, secret kept after revoke, no one-link refusal) all caught (one survivor led to a new test); `verify:supabase` PASSED with 1 warning until #7 is applied.

**Live status (2026-11-23):** migration #7 applied in the Supabase SQL Editor; Step 14 Vault permission checks all `false` for signed-in and signed-out roles; `npm run verify:supabase` PASSED with 0 failures and 0 warnings; real-account test passed (copy repeated, same link; second admin; join request; pending user sees nothing; approval; revoke; new link; guest claim preserves the guest record).

**Limitations:** real Vault encryption was verified live only by the permission checks and the real-account test (the local engine uses a stand-in); anyone with dashboard/service-role access can read Vault secrets; a leaked live link only allows requests (admin-approved, 50 waiting maximum) until it expires; rate limiting (ADR-054) is still mandatory before public deployment; ADR-047 and ADR-043 remain mandatory for M5. M4 not started.
