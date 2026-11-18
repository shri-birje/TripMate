# TripMate — Architecture Decisions Log

Status: **Proposed (v0.1) — pending approval.**
Date: 2026-11-17

This log records what was decided, what was assumed, what is unresolved, and the result of the final architecture review. "Proposed" means I recommend it; nothing here is final until you approve.

---

## 1. Source documents

The project folder was empty when this work began. The three briefs (Product Vision, UI/UX Design Direction, Technology Selection and Development Instructions) exist only in the conversation. **Recommendation:** save them as `docs/PRODUCT_REQUIREMENTS.md`, `docs/UI_UX_GUIDELINES.md` and `docs/DEVELOPMENT_PROCESS.md` so the repository itself holds the source of truth. This was not done because it was outside the eight documents requested.

---

## 2. Decisions (ADRs)

| ID | Decision | Why | Status |
|---|---|---|---|
| ADR-001 | TypeScript monorepo (pnpm workspaces): `apps/app`, `packages/core`, `supabase/` | One language; shared money logic | Proposed |
| ADR-002 | Expo universal app for iOS, Android **and** web | One codebase and one design system; no drift between platforms | **Proposed — needs approval (Q-1)** |
| ADR-003 | Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions) | Relational integrity for money; least operational work | Proposed |
| ADR-004 | **Reads/writes split:** simple reads direct under RLS; all writes and computed reads through a REST API that calls Postgres write functions; clients have SELECT only on financial tables | One choke point for validation, authorization and audit; single TS implementation of split logic | Proposed |
| ADR-005 | Money = `bigint` minor units; split allocation by **largest remainder**; no floats | Exact sums, deterministic results | Proposed |
| ADR-006 | Balances are **derived** from the ledger, never stored | Edit/delete/remove cannot leave stale numbers | Proposed |
| ADR-007 | Ledger rows reference `trip_members.id`, not `user_id`; `user_id` nullable (guests) | Handles removal, guests, deleted accounts without breaking history | Proposed |
| ADR-008 | Soft delete + append-only `expense_revisions` and `activity_log` | Audit, undo, future disputes | Proposed |
| ADR-009 | Client-generated UUIDs + `version` + `expectedVersion` | Idempotent retries, safe concurrency, offline-ready | Proposed |
| ADR-010 | Repayment states `pending → paid → confirmed` (+ `cancelled`); expose both `net_confirmed` and `net_projected` | Implements rule 12 and lets the UI choose how to present it | Proposed |
| ADR-011 | Settlement suggestions are computed on demand, not stored | Always consistent with the ledger | Proposed |
| ADR-012 | One table `expense_splits` serves as both "participants" and "split details" | Two tables would be able to disagree | Proposed |
| ADR-013 | Personal expenses are `scope='personal'` rows visible only to their creator and excluded from balances | Implements rule 9 while keeping rule 1 (belongs to a trip) | Proposed — confirm (Q-10) |
| ADR-014 | Realtime events trigger **refetch**, never carry authoritative numbers | Prevents drift if events are missed or reordered | Proposed |
| ADR-015 | Invites: random token, only SHA-256 hash stored, expiry/max-uses/revoke; links open the app via universal/app links | Security and good WhatsApp experience | Proposed |
| ADR-016 | Three separate environments; web on Vercel, backend on Supabase, mobile via EAS | Meets "dev/preview/prod separate" rule | Proposed |
| ADR-017 | UPI via deep links only; the app never holds or moves money | MVP rule; avoids payment regulation | Proposed |
| ADR-018 | No queues, cache layer, microservices or GraphQL in MVP | Avoid overengineering | Proposed |
| ADR-019 | **(Implementation change, 2026-11-17)** Use **npm workspaces** instead of pnpm | pnpm not installed; Expo + pnpm needs extra configuration; fewer moving parts for a learner. Replaces the pnpm part of ADR-001. | Applied in M0 |
| ADR-020 | **(Implementation change)** API is a **Hono app running on Node locally**, deployable to a free edge host (e.g. Cloudflare Workers) later, instead of Supabase Edge Functions | Docker is not installed (needed to run Supabase locally); free-only rule; avoids the Deno/shared-package risk R-1. This is the fallback already described in Q-11/R-1. ADR-004 (reads direct under RLS, writes via the API) is unchanged. | Applied in M0 |
| ADR-021 | **(Free-only rule, from you)** Only free tiers/tools are used. Consequences: no Apple Developer account (so no iOS App Store/TestFlight; iOS testing via Expo Go), Google Play's one-time fee deferred, Supabase **free** tier for production at first with scheduled manual backups, no paid domain until you choose to buy one (free `*.vercel.app` / `*.pages.dev` URLs meanwhile), no paid SMS/OTP | Your instruction | Applied |
| ADR-022 | **(Implementation change)** Zod **4** and Vitest **5** (latest majors) instead of Zod 3 / Vitest 2 | `npm audit` flagged Zod 3 (memory exhaustion on oversized collections) and Vitest 2's toolchain; moving early costs almost nothing | Applied in M0 |
| ADR-023 | **(Implementation change)** `apps/app/metro.config.js` explicitly maps `@tripmate/core` and watches the workspace | The Expo dev server could not follow the Windows symlink to the shared package (found by testing); the production export had worked, which hid it | Applied in M0 |
| ADR-024 | **(M2)** No API changes for accounts. Sign-up/sign-in go from the app straight to Supabase Auth; the profile is read/edited directly under row-level security (own row, named columns only). The service-role key is not used anywhere. | Matches ADR-004 (simple reads and own-profile edits are direct); keeps the secret key out of the project until a server step truly needs it | Applied in M2 |
| ADR-025 | **(M2)** The app accepts only the **publishable** Supabase key and refuses to start if it detects a secret/service-role key | A secret key in a website or app bundle exposes every user's data | Applied in M2 |
| ADR-026 | **(M2)** Protected routes use Expo Router `Stack.Protected` with explicit `redirectTo` targets; the database remains the real authority on data access | Guards only control what the app shows | Applied in M2 |
| ADR-027 | **(M2)** Session storage: phone = OS secure storage in chunks of 1800 characters; website = `localStorage` | Secure storage works best with small values; browsers offer nothing stronger, so strict security headers are planned for deployment | Applied in M2 (phone path not yet run on a device) |
| ADR-028 | **(M2)** Theme: instant from device storage, saved to the profile, account value wins after sign-in; first launch is always Light even if the device is dark; both palettes verified for WCAG AA contrast | Product rule: Light is the default; theme should follow the user across devices | Applied in M2 |
| ADR-029 | **(M2)** TanStack Query added now; React Hook Form deferred (forms use plain state + the shared Zod rules in `packages/core`) | Two small forms do not justify another dependency yet; revisit at expenses | Applied in M2 |
| ADR-030 | **(M2)** Database rules are tested by running the real migration in PGlite (Postgres inside Node) with a stand-in for Supabase's `auth` schema; UI flows are tested with Playwright + Edge against simulated Supabase answers. Both are supplements to, not replacements for, a live check against the real project | No Docker available; free-only rule | Applied in M2 |
| ADR-031 | **(M2)** Deferred from M2: avatar upload, forgot-password, account deletion, Google sign-in, phone deep links | Outside the M2 scope you listed; needed before public launch | Open (see progress doc) |
| ADR-032 | **(M3, APPROVED 2026-11-18 with the conditions listed below)** Trip and member changes are **database functions that check `auth.uid()`** and are callable by signed-in users (e.g. `create_trip`), not an API using Supabase's secret key. Clients still have SELECT only on the tables. This changes the "write functions callable only by the service credential" part of ADR-004 for trips and members. | Atomic and tested like profiles; **no secret key needed anywhere**. An API becomes necessary at M5 (the money engine's TypeScript must run server-side) and can then forward the user's own login, so a secret key may never be needed. | **Approved and applied** (M3.1). Conditions enforced automatically by `supabase/tests/security-audit.test.ts` |
| ADR-033 | **(M3.1)** Trip dates are typed as `DD/MM/YYYY` (also `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`; day first) and stored as plain calendar dates; no date picker yet | A native date picker needs extra libraries and differs on web; Indian format is what users type | Applied; date picker deferred to the polish milestone |
| ADR-034 | **(M3.1)** A trip's Upcoming / Ongoing / Completed state is derived from its dates and today, never stored; only `active` / `archived` is stored | A stored phase would go stale overnight | Applied |
| ADR-036 | **(M3.2, approved 2026-11-18)** A trip the signed-in person cannot open (unknown, not theirs, removed from, left, or a malformed link) always shows the **same** "Trip not available" message; only genuine connection problems differ | The database returns nothing for hidden trips and must not reveal whether a trip exists; separate "not found" and "access denied" states would let anyone probe which trip ids exist | Applied |
| ADR-037 | **(M3.2)** Reads that show other people's data name their columns explicitly (no `*`), ask only for current members, and never read profiles; names come from the trip's own member list | Member privacy: no email addresses or UPI IDs are requested; a future column can never leak by accident | Applied |
| ADR-038 | **(M3.2)** Trip length and phase use plain calendar days: length by pure calendar arithmetic (UTC day numbers), phase by comparing `YYYY-MM-DD` text against the person's own local "today" | No time-zone or daylight-saving off-by-one; tested in six zones and in a real browser in three | Applied |
| ADR-035 | **(M3.1)** `create_trip` uses a server-generated id (not a client UUID) and the screen locks the button while saving | Simpler for MVP; client-generated ids matter for money records and offline entry | Applied; revisit with offline mode |

---

### ADR-032: conditions approved by the project owner (2026-11-18)

Use authenticated Supabase database functions instead of a Supabase secret / service-role key for normal signed-in operations, **provided all of the following hold**. Each is checked automatically by the audit test, so a future migration that breaks one fails the test suite.

| # | Condition | How it is met and enforced |
|---|---|---|
| 1 | Identify the signed-in user with `auth.uid()` | Every function a signed-in user can run reads the caller from `auth.uid()` and never from a parameter (`create_trip` has no "creator" argument). **Audit test 6** fails if such a function does not use `auth.uid()`. |
| 2 | Check authorization and ownership on every operation | Each function checks who is allowed before acting (`create_trip`: caller must be signed in and have a profile; reads: must be an active member). **Rule for every future function:** membership/role/ownership checks are written inside the function and covered by tests for the allowed and the forbidden caller. |
| 3 | Row-Level Security enforced | RLS is on for every table; direct writes are not granted to anyone. **Audit tests 1, 2, 3, 3b.** |
| 4 | Restrict function execution to the right roles | Functions are revoked from `PUBLIC` and `anon` and granted only to `authenticated`; internal helpers are callable by nobody from the app. **Audit tests 5 and 7** (7 is an explicit allow-list: adding a function means consciously editing the list, i.e. a security review). |
| 5 | Safe `search_path` in security-definer functions | Every function pins `set search_path = ''`. **Audit tests 4 and 4b.** |
| 6 | Never expose a secret / service-role key in the frontend, mobile app, public repository or client-side environment variables | The app refuses to start if it detects a secret key (ADR-025); only the publishable key is used; `.env` files and key/certificate files are git-ignored; every commit is secret-scanned; the built website is checked for secret-type strings; `npm run verify:supabase` checks the setup. The repository is public. |
| 7 | Use a secret key only for trusted backend operations that genuinely need elevated privileges | **No secret key is used anywhere today.** Introducing one requires a written justification of the specific operation, an ADR, and your approval first. |
| 8 | No unnecessary elevated privileges | `SECURITY DEFINER` is used only where required: `is_trip_member` (to read membership without the security rules recursing) and `create_trip` (callers deliberately have no insert permission). Reads use plain RLS with no elevated function. |

**Checklist for every new database function** (review before adding it to the allow-list): Who may call it? Where does it get the caller (`auth.uid()`)? What does it verify before changing data? Is `search_path` pinned? Is execute revoked from `PUBLIC` and `anon`? Is there a test for an allowed caller, a signed-in stranger and a signed-out visitor? Is it atomic? Does it need `SECURITY DEFINER` at all?

## 3. Assumptions

| # | Assumption |
|---|---|
| A-1 | MVP is single-currency per trip (INR default). Multi-currency adds columns later without changing balance logic. |
| A-2 | A trip's expected size is small (≤ ~20 members, ≤ a few thousand expenses), so on-demand aggregation is fast enough. |
| A-3 | Offline entry, receipt OCR, AI assistant, maps, push, disputes and reports are **post-MVP**; the schema leaves room but no code is planned for them in the first milestones. |
| A-4 | Itinerary and per-category/daily budgets are post-MVP (the product brief places them after the MVP); basic overall and per-person budgets are in the MVP. |
| A-5 | "Unequal splitting" is delivered as both `exact` and `shares` (weights). |
| A-6 | The website is the full app, not a marketing site; a landing page is a separate later task. |
| A-7 | You will own the cloud accounts (GitHub, Supabase, Vercel, Expo, domain). Nothing is created without you. |

---

## 4. Unresolved questions (need your decision)

| ID | Question | My recommendation | Blocks |
|---|---|---|---|
| **Q-1** | Expo **universal app** (one codebase for mobile+web) vs Expo mobile + separate Next.js website? | Universal app (less work, no drift). Choose Next.js only if SEO/rich desktop UX matters more. | Everything |
| **Q-2** | Launch login methods: email + Google only, or add phone OTP now? | Email + Google; add phone OTP later (SMS cost, DLT registration). | Auth milestone |
| **Q-3** | Do "Paid" (unconfirmed) repayments count toward balances? | Architecture supports both. UI headline shows `net_projected` (Paid + Confirmed) labelled "awaiting confirmation"; `net_confirmed` is the final figure. | Settlement UI |
| **Q-4** | Can a member with a non-zero balance be removed? | Block until settled or an admin explicitly settles/forgives the balance. | Members milestone |
| **Q-5** | Support **guest members** (name-only placeholders who can later claim their record by joining)? | Yes in MVP — otherwise nobody can log an expense involving a friend who hasn't signed up yet. The schema already supports it. | Members, invites |
| **Q-6** | Who may invite, and who may edit/delete expenses? | Admins invite by default (configurable); members edit/delete only their own expenses; admins any. | Permissions |
| **Q-7** | Do removed/left members keep any read access? | No access by default; optionally read-only summary of their own settlement. | RLS |
| **Q-8** | Web host (Vercel vs Cloudflare Pages) and **domain name**? | Vercel; you choose the domain. | Deployment, invite links |
| **Q-9** | Supabase region and when to move production to a paid plan? | Region nearest India (verify Mumbai/Singapore); paid plan before any real user data. | Deployment |
| **Q-10** | Confirm **personal expense** semantics (private to creator, outside balances, still tied to a trip)? | Yes as designed (ADR-013). | Expenses |
| **Q-11** | API runtime: Supabase Edge Functions (Deno) vs a small Node service? | **Provisionally resolved in M0 (ADR-020):** Hono on Node locally, free edge host later. Confirm when we reach deployment. | — |
| **Q-12** | Add a `cancelled` repayment status to the brief's three? | Yes — lets mistakes be voided without deleting history. | Repayments |
| **Q-13** | Destination photography source (own images vs licence-safe stock with attribution)? | Decide at UI milestone. | UI |
| **Q-14** | Publish to the App Store / Play Store at launch, or ship web + test builds first? | Web + test builds first; stores when stable (stores add cost and review time). | Deployment |
| **Q-15** | Is `shares` (weights) acceptable as the meaning of "unequal split" alongside `exact`? | Yes, offer both. | Expense UI |
| **Q-16** | How to treat a repayment larger than the current debt? | Allow with a clear warning (it reverses the direction of the debt). | Settlement UI |

---

## 5. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Sharing `packages/core` (workspace TypeScript) with Supabase Edge Functions (Deno) is awkward | Medium | Medium | Milestone 0 spike; keep `core` dependency-free (Zod only); fallback to Node service |
| R-2 | Universal Expo web feels less polished on desktop | Medium | Medium | Dedicated desktop layouts; reserve Next.js as a later option if needed |
| R-3 | Rounding or settlement bug erodes trust | Low (if tested) | High | Property-based tests; DB sum constraints; worked brief example as a test |
| R-4 | RLS mistake exposes another trip's data | Low | Very high | pgTAP isolation tests on every table; default-deny; security checklist per milestone |
| R-5 | Invite deep links don't open the app (domain association misconfigured) | Medium | Medium | Verify on real devices before launch; website join page as fallback |
| R-6 | Supabase free-tier limits (auto-pause, no backups) | Certain | Medium | Paid plan + scheduled dumps before real users |
| R-7 | Auth emails rate-limited or land in spam | Medium | Medium | Custom SMTP with SPF/DKIM |
| R-8 | UPI deep links behave differently across UPI apps | Medium | Low | "Copy UPI ID" fallback; manual Paid/Confirm flow never depends on the link |
| R-9 | Scope creep from the large post-MVP list | High | High | Strict milestone gating; approval after every feature |
| R-10 | Store review/compliance delays (privacy policy, account deletion, data-safety forms) | Medium | Medium | Plan these early; ship web and test builds first |

---

## 6. Final architecture review

Reviewed all eight documents against the briefs. Findings and what I did about them:

| Review area | Finding | Resolution |
|---|---|---|
| Missing components | Original plan had no guest members, though expenses involving not-yet-registered friends are common | Added `trip_members` identity model (ADR-007) and Q-5 |
| Missing components | Invite links need universal/app-link setup and an auth-email sender | Added to deployment doc (§3.5) and risks R-5, R-7 |
| Missing components | App stores require account deletion | Designed anonymisation (Security §7) |
| Conflicting decisions | "Brief: Participants and Split details as separate entities" vs one-table design | Kept one table (ADR-012) and documented the mapping |
| Conflicting decisions | Trip budget: `trips.budget_minor` vs `budgets` table could duplicate the overall budget | Overall budget lives only on `trips`; `budgets` holds per-person/daily/category |
| Unnecessary complexity | Redis for rate limiting, queues, cache | Rejected; Postgres counter table (ADR-018) |
| Security gaps | Clients writing financial tables under RLS would bypass split verification and auditing | ADR-004: SELECT-only grants, API-only writes, defence in depth |
| Security gaps | Public invite preview could leak trip info | Limited to name/destination/dates/inviter/member count; rate-limited; hashed tokens |
| Database problems | Member removal could orphan history if keyed by user | Ledger keyed by `trip_members.id` |
| Database problems | `trips.currency` change after expenses would corrupt amounts | Made immutable once expenses exist |
| Financial risks | Greedy settlement is not always the theoretical minimum | Documented; optimal for the brief's example; exact search possible later |
| Financial risks | Rounding favours the lowest member id by ≤ 1 paise per expense | Accepted and documented; negligible, revisit if complaints arise |
| Financial risks | "Paid" repayments could be false claims | Distinct Paid vs Confirmed (rule 12), receiver-only confirmation |
| Mobile/web inconsistencies | Possible divergence of validation | Same Zod schemas and `core` engine on all clients and server |
| Unclear API responsibilities | Two read paths could confuse | Explicit table in SYSTEM_ARCHITECTURE §3 and API_DESIGN endpoint flags (R/W) |
| Deployment limitations | Free tier lacks backups and pauses when idle | Paid prod plan + scheduled dump; restore drill before launch |
| Deployment limitations | Custom API domain is a paid add-on | Use the Supabase URL first (documented) |

**Not verified yet:**
- Mermaid diagrams have not been rendered in a viewer.
- Provider pricing, free-tier limits and region availability are from general knowledge and need re-checking before commitment.
- The Deno/`core` sharing approach (R-1) is untested until the Milestone 0 spike.
- No SQL, API or app code exists, so nothing here has been executed or tested.

---

## 7. Proposed milestone order (for approval)

| # | Milestone | Done when |
|---|---|---|
| 0 | Repo, tooling, environments, CI skeleton, **R-1 spike** | Both clients start; function deploys and imports `core`; CI green |
| 1 | `core` money engine (no UI) | Property tests and the brief's ₹8,000 example pass |
| 2 | Auth + profiles (+ theme persistence) | Sign-up/in/out on web and mobile |
| 3 | Trips + members (+ RLS tests) | Create/manage trips; isolation proven |
| 4 | Invites + guest claim | WhatsApp link joins a second account |
| 5 | Expenses + all split types | Atomic writes; edit/delete correct |
| 6 | Balances + settlement plan + explanation | Matches hand-calculated cases |
| 7 | Repayment lifecycle | Pending → Paid → Confirmed incl. race tests |
| 8 | Dashboard, activity feed, filters, basic budgets | Totals reconcile with ledger |
| 9 | Web layouts, dark mode polish, accessibility | Mobile↔web sync verified |
| 10 | Hardening + **live deployment** | Live URLs verified end to end |

Each milestone ends with: explanation, implementation, tests, verification, documentation update, and **your approval before the next one.**
