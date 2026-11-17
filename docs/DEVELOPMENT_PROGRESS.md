# TripMate — Development Progress

Last updated: 2026-11-18

Rule: a feature is **Complete** only when it works **and has been tested**. "Code written" is not complete. Each milestone stops for your approval before the next begins.

---

## Status summary

| Milestone | Status |
|---|---|
| **M0 — Project foundation** | ✅ **Complete (approved 2026-11-17)** |
| **M1 — Core money engine (`packages/core`)** | ✅ **Complete (approved 2026-11-17)** |
| **M2 — Accounts, profiles, theme** | 🟡 **Built and tested with simulated Supabase answers — awaiting (a) your live check against your real Supabase project and (b) your approval.** See the M2 section. |
| M3 — Trips + members | Not started |
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

**Status: built and tested with simulated Supabase answers. Not yet checked against your real Supabase project** (that needs your publishable key and the SQL step in [SUPABASE_SETUP.md](SUPABASE_SETUP.md)). It is not complete until you have done that live check.

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
Once you have (1) done the live check in SUPABASE_SETUP.md and (2) approved M2: **M3 - Trips and members** (create/edit trips, member list, roles, with database security rules tested the same way as profiles). I have not started it.

**Also ready when you want it:** committing M0-M2 to your GitHub repository (it is empty and the remote is already connected locally; nothing has been pushed).
