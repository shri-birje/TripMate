# TripMate — System Architecture

Status: **Proposed (v0.1) — pending approval.** Architecture only; no application code exists.

Companion documents: [TECH_STACK_DECISIONS.md](TECH_STACK_DECISIONS.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [API_DESIGN.md](API_DESIGN.md) · [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) · [DEPLOYMENT_ARCHITECTURE.md](DEPLOYMENT_ARCHITECTURE.md) · [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md) · [ARCHITECTURE_DECISIONS_LOG.md](ARCHITECTURE_DECISIONS_LOG.md)

Source of truth for requirements: the TripMate Product Vision brief, the UI/UX Design Direction brief and the Technology Selection brief (provided in the project conversation; not yet saved as files — see decisions log).

---

## 1. System at a glance

TripMate is one product with **one backend and one database**, reached by **one universal client codebase** that runs as an iOS/Android app and as a responsive website.

```
 iOS / Android app ─┐
                    ├──►  REST API (writes, computed reads)  ──►  PostgreSQL  ◄── Realtime ──┐
 Responsive website ┘     + direct reads under RLS                 (source of truth)         │
        ▲                                                                                      │
        └──────────────────────────── change notifications ────────────────────────────────────┘
```

### Architectural principles

1. **One source of truth for money.** All financial data lives in PostgreSQL. Balances are derived, never stored.
2. **One implementation of the rules.** Split and settlement logic exists once, in `packages/core`, used by both clients (preview) and the server (authority).
3. **Writes go through one door.** Clients cannot write financial tables directly; the API validates, authorizes, computes and commits atomically.
4. **The database defends itself.** Constraints and RLS make wrong data and cross-trip access impossible even if application code has a bug.
5. **AI never touches money.** AI features are read-only explainers or draft producers.
6. **Simple first.** No queues, no microservices, no cache layer in the MVP.

---

## 2. Components and responsibilities

| Component | Responsibility | Does **not** do |
|---|---|---|
| **Client app** (Expo; mobile + web) | UI, navigation, theme, form validation, instant split preview (via `core`), local caching, realtime subscription, UPI deep links | Authority over money; direct financial writes; secrets |
| **API layer** (Edge Function, Hono REST) | Verify JWT, authorize, validate (Zod), run `core` split engine, call write functions, return results; computed reads (balances, settlement plan, summaries); signed upload URLs | Storing state of its own |
| **Postgres write functions** | Perform each financial change in **one transaction**: write rows, bump `version`, write revision + activity log; re-check membership | Trust the caller (they re-check) |
| **PostgreSQL** | Persist data; enforce constraints (sums, state machine, FKs); RLS read isolation | Business rules that need the split algorithm (kept in TS) |
| **Auth** (Supabase Auth) | Sign-up, login, sessions, password reset, Google sign-in, issuing JWTs | App authorization (RLS/API do that) |
| **Realtime** | Notify subscribed clients of row changes (RLS-filtered) | Carry authoritative numbers |
| **Storage** | Private files (avatars, receipts, repayment proof) with membership-based policies | Public hosting of receipts |
| **Notification service** (post-MVP) | Turn activity events into push messages via Expo Push | Block the request that caused the event |
| **External UPI apps** | Execute the actual payment | Report success back (user confirms manually) |
| **Maps service** (later) | Location search / display for itinerary | MVP |
| **OCR service** (later) | Extract a **draft** expense from a receipt image | Create expenses automatically |
| **AI service** (later) | Answer questions from trip data (read-only tools, user's credentials) | Compute or modify balances |

---

## 3. Two paths: reads and writes (ADR-004)

| Path | Used for | Route | Protection |
|---|---|---|---|
| **Direct read** | Lists and simple records: my trips, members, expenses list, activity feed, notifications | Client → PostgREST → DB | RLS (`is_trip_member`), only `SELECT` granted |
| **Computed read** | Balances, settlement plan, balance explanation, dashboard summary | Client → API → DB | JWT + membership check |
| **Write** | Everything that changes trips, members, expenses, repayments, budgets, itinerary | Client → API → write function → DB | JWT + role check + Zod + transaction + constraints |

Why not let clients write straight to tables under RLS? RLS alone cannot compute and verify split amounts, write the audit rows in the same transaction, or give clean validation errors. Funnelling writes through one API removes that whole class of bugs.

---

## 4. Request lifecycle (generic write)

```
UI action
 → API request (JWT, JSON body)
 → Auth: verify JWT → user id
 → Authorization: is the user an active member? right role / owner of this record?
 → Validation: Zod schema (types, lengths, ranges, integer minor units)
 → Business logic: run core engine (e.g. compute shares), check members belong to trip
 → Database: one transaction (rows + version check + revision + activity log)
 → DB constraints verify sums at commit
 → Response: new resource + new version
 → Realtime event → other clients refetch → UI updates
```

---

## 5. Key flows

(Visual versions are in [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md).)

### 5.1 Registration and login
1. Client calls Supabase Auth (email+password or Google).
2. Auth creates `auth.users`; a database trigger creates the `profiles` row (theme defaults to `light`).
3. Client stores the session (access token ~1 h + rotating refresh token) in secure storage (mobile) / the Auth library's browser storage (web).
4. Every API/DB call carries the access token; refresh happens automatically.
5. Log out clears the session locally and revokes the refresh token.

### 5.2 Create a trip
`POST /trips` → validate → one transaction: insert `trips`, insert creator as `trip_members(role=admin, status=active)`, write `activity_log` → return trip. The creator is the administrator.

### 5.3 Invite members
1. Admin (or any member, if allowed by trip settings — Q-6) calls `POST /trips/:id/invites`.
2. Server generates a random token, stores **only its SHA-256 hash**, returns a link `https://<domain>/join/<token>` once.
3. Admin shares it via WhatsApp (system share sheet).
4. Invitee opens the link: if the app is installed, **universal/app link** opens it; otherwise the website's join page opens. If not logged in they sign up/log in first.
5. `GET /invites/:token` shows trip name and inviter (no financial data). `POST /invites/:token/accept` checks expiry, revocation and `use_count < max_uses`, then creates or reactivates the `trip_members` row (or claims a guest) and increments `use_count` — **atomically**.

### 5.4 Add an expense
1. Client shows the form and previews each person's share instantly using `core`.
2. `PUT /trips/:id/expenses/:expenseId` (client-generated UUID). Body: title, amount (paise), category, time, payers, participants, split method and inputs.
3. API authorizes, validates, **recomputes shares with `core`** (it does not trust client-sent shares), and calls the write function.
4. Function inserts expense, payers, splits, revision v1, activity entry in one transaction.
5. Commit-time constraints verify `Σ paid = amount` and `Σ share = amount`.
6. Repeating the same request returns the existing expense (idempotent) — no duplicates on retry.

### 5.5 Splitting
Handled by `core.allocate(...)`:
- **equal / selected members only:** equal over chosen participants.
- **percentage:** inputs in basis points, must sum to 10 000.
- **exact:** inputs in paise, must sum to the amount.
- **shares:** positive weights.
- All methods use **largest-remainder** rounding so results are integers that sum exactly (see §6).

### 5.6 Record a repayment
`PUT /trips/:id/repayments/:id` creates a row with status `pending` (optionally `from_suggestion=true`). The payer opens their UPI app via the deep link, pays, then calls `POST …/mark-paid` → `paid`.

### 5.7 Confirm a repayment
Only the **receiver** calls `POST …/confirm` → `confirmed`. The transition is `UPDATE … WHERE status='paid'`; a second tap or a race affects zero rows and returns 409 instead of double-applying. Balances recompute automatically because they are derived.

### 5.8 Mobile ↔ web synchronization
Both clients subscribe to Realtime changes filtered by `trip_id` on `expenses`, `repayments`, `trip_members`, `activity_log`. On any event, the client **invalidates the relevant queries** (expenses, balances, summary) and refetches. On reconnect or app foreground, it invalidates everything for the open trip. The event payload is never trusted for numbers.

---

## 6. Financial engine (`packages/core`)

### 6.1 Money
- Represent amounts as integers in paise. Parse user input (₹ with up to 2 decimals) to paise with string handling, never floating-point multiplication. Reject non-safe integers.
- Format for display only at the UI edge (`₹1,23,456.00` with Indian digit grouping).

### 6.2 Allocation (largest remainder)
For total `T` and weights `w₁…wₙ` (equal split = all weights 1):
1. `exact_i = T × wᵢ / Σw`; `base_i = floor(exact_i)` (integer arithmetic).
2. `leftover = T − Σ base_i`.
3. Give 1 paise to each of the `leftover` members with the largest fractional remainder; ties are broken by ascending member id (deterministic).
Result: integers that **always sum to T**. Example: ₹1,000.00 ÷ 3 → 33333, 33333, 33334 paise.

### 6.3 Balances
Defined in [DATABASE_SCHEMA.md §5](DATABASE_SCHEMA.md): `net = paid − share + sent − received`; `Σ net = 0`. Two views: `net_confirmed` and `net_projected`.

### 6.4 Settlement suggestion (minimal transfers)
1. Collect members with `net ≠ 0` (using the chosen figure).
2. Sort creditors (net > 0) and debtors (net < 0) by amount desc, ties by member id.
3. Repeatedly pay the largest debtor → largest creditor `min(|debt|, credit)`, until all are zero.

This yields at most *(non-zero members − 1)* transfers. The theoretical minimum is *(non-zero members − number of zero-sum groups)*; finding it is NP-hard in general, so the greedy result is used (optimal in most small groups); an exact subset search for groups ≤ ~12 can be added later without changing the API.

**Worked example from the product brief** (each share ₹8,000; paid: Shri 15,000 · Rahul 12,000 · Amit 10,000 · Kiran 5,000 · Rohan 4,000 · Akash 2,000):

| Member | Net |
|---|---|
| Shri | +₹7,000 |
| Rahul | +₹4,000 |
| Amit | +₹2,000 |
| Kiran | −₹3,000 |
| Rohan | −₹4,000 |
| Akash | −₹6,000 |

Greedy plan: Akash→Shri ₹6,000 · Rohan→Rahul ₹4,000 · Kiran→Amit ₹2,000 · Kiran→Shri ₹1,000 = **4 transfers** (also the theoretical minimum here: two zero-sum groups among 6 people). This will be a unit test.

### 6.5 Explanation
`GET …/balances/:memberId/explanation` returns the line items behind a balance (each expense: amount paid, share, effect; each repayment: effect), so the UI can answer "why do I owe this?" with real records, never with generated text.

### 6.6 Invariants asserted in tests
- Σ shares = amount for every method and every input, including awkward totals (1 paise, primes, 3-way and 7-way splits).
- Σ net across a trip = 0.
- Applying the suggested plan makes every net 0.
- Edit then revert = original balances.
- SQL balance view and TS engine agree on randomised data.

---

## 7. Backend modules

| Module | Responsibility | Main tables |
|---|---|---|
| Auth | Session verification middleware; account deletion | `auth.users`, `profiles` |
| Users | Profile read/update, avatar upload URL, preferences | `profiles` |
| Trips | Create, update, archive, list | `trips` |
| Members & invitations | Invite links, accept, add guest, role change, remove/leave | `trip_members`, `trip_invites` |
| Expenses | Create/update/delete/restore, attachments, revisions | `expenses`, `expense_payers`, `expense_splits`, `expense_revisions`, `attachments` |
| Split engine | Allocation (shared from `core`) | — |
| Balances | Derived balances, explanation, summary | views/functions over ledger |
| Settlements & repayments | Settlement plan, repayment lifecycle | `repayments` |
| Budgets | Overall/per-person/daily/category budgets and progress | `trips`, `budgets` |
| Itinerary | Day-wise items | `itinerary_items` |
| Notifications | In-app inbox, device tokens, push dispatch (post-MVP) | `notifications`, `device_tokens` |
| File uploads | Signed upload/download URLs, type/size policy | Storage, `attachments` |
| Activity history | Feed queries | `activity_log` |

Cross-cutting: Zod validation, error mapping, structured logging with request id, rate limiting, idempotency by client UUID, optimistic concurrency by `version`. Details in [API_DESIGN.md](API_DESIGN.md).

Background jobs: **none required for MVP** (everything is request-driven). Later: notification dispatch, budget-threshold alerts (scheduled function), receipt OCR (async), data export, nightly backup.

---

## 8. Frontend architecture (mobile + web)

### 8.1 One app, adaptive layouts
Single Expo Router app. Layout switches on screen width:

| Width | Layout |
|---|---|
| < 768 px (phones) | Bottom tab bar: Home · My Trips · **Add Expense** (prominent centre) · Activity · Profile |
| 768–1023 px (tablets) | Tab bar or collapsible rail; content max-width centred |
| ≥ 1024 px (desktop) | Left sidebar navigation; two-pane layouts (trip list + trip detail); Add Expense as side panel/modal; tables for expense lists |

### 8.2 Planned structure (to be created in Milestone 0, not yet created)

```
TripMate/
├─ apps/
│  └─ app/                        Expo universal app
│     ├─ app/                     Expo Router routes
│     │  ├─ (auth)/               welcome, sign-in, sign-up
│     │  ├─ (tabs)/               home, trips, add-expense, activity, profile
│     │  ├─ trip/[tripId]/        dashboard, expenses, members, settlements, budget, itinerary, activity
│     │  └─ join/[token].tsx      invite landing
│     └─ src/
│        ├─ components/           shared UI (Button, Card, AmountText, Avatar, …)
│        ├─ features/             trips, expenses, settlements, budgets, itinerary (screens + hooks)
│        ├─ lib/                  api client, supabase client, realtime, storage adapters
│        ├─ theme/                tokens (light/dark), ThemeProvider
│        └─ hooks/                useBreakpoint, useAuth, …
├─ packages/
│  └─ core/                       money, allocate, balances, settle, zod schemas, types
├─ supabase/
│  ├─ migrations/                 numbered SQL migrations
│  ├─ functions/api/              Hono REST API
│  ├─ tests/                      pgTAP tests
│  └─ seed.sql                    system categories
├─ docs/                          these documents
└─ .github/workflows/             CI/CD
```

### 8.3 State, data and forms
- **Server state:** TanStack Query; query keys scoped by trip (`['trip', id, 'expenses']`, `['trip', id, 'balances']`). Realtime events invalidate keys.
- **Auth state:** `AuthProvider` exposes session/user; route groups redirect unauthenticated users to `(auth)`.
- **Forms:** React Hook Form + the **same Zod schemas** the API uses (imported from `core`), so client and server validate identically.
- **Loading/error:** every list/detail has skeleton, empty state, error with retry; mutations show inline errors from the API's error codes; 409 conflicts prompt "this was changed — reload".

### 8.4 Theme management
- Design tokens (colour, spacing, radius, type scale) defined once with **light** and **dark** value sets from the approved palette (forest/sage greens, warm ivory, earthy neutrals; restrained amber/green/red for status).
- `ThemeProvider` resolves `light | dark | system`. **First launch = light** regardless of device setting. Choice persists locally (AsyncStorage / localStorage) for instant start, and to `profiles.theme_preference` when logged in so it follows the user across devices.
- No hard-coded colours in components; everything reads tokens, so one switch updates cards, nav, forms, charts, modals and inputs together.
- Numbers use tabular figures; amounts use Indian grouping.

### 8.5 Shared vs platform-specific

| Shared (≈95 %) | Platform-specific (thin adapters) |
|---|---|
| All screens/components, theme, `core` logic, API client, validation, query layer | Secure session storage (SecureStore vs browser), push registration, share sheet (native vs Web Share/clipboard), image picker/camera, UPI deep link (native intent vs "copy UPI ID/QR" on desktop), universal-link config, desktop hover/keyboard behaviour |

---

## 9. Scalability and reliability

| Concern | MVP approach | Later |
|---|---|---|
| Many users/trips | Stateless API, indexed queries; RLS check uses `trip_members` index | Read replicas; caching; connection pooling tuning |
| Frequent expense updates | Single-transaction writes; optimistic concurrency | Batching |
| Balance computation | Aggregate per trip on demand (trips are small: tens to low thousands of rows) | Materialized/cached summary if a trip grows large |
| Mobile/web sync | Realtime + refetch | Delta sync |
| Temporary disconnection | Queries cached; clear offline banner; writes fail with retry | **Offline entry:** local outbox of mutations, client UUIDs already make replay idempotent, `version` detects conflicts, conflict UI for edits to expenses changed meanwhile |
| Growing database | Indexes; soft deletes; paginated feeds | Partition/archive old `activity_log` |
| Background processing | None | Scheduled/queued functions |
| Backups/recovery | Daily backups (paid plan) or scheduled dump on free tier; restore drill before launch | Point-in-time recovery |

Offline mode is intentionally **not** built in the MVP, but the data model (client UUIDs, versions, idempotent writes) is shaped now so it needs no redesign.

---

## 10. External integrations summary

| Integration | When | Data crossing the boundary |
|---|---|---|
| Google sign-in | MVP | OAuth identity (name, email, avatar) |
| UPI apps | MVP | Deep link with payee UPI ID, amount, note — no response |
| Expo push / FCM / APNs | Post-MVP | Notification text + device token |
| Maps | Later | Location queries |
| OCR / vision model | Later | The receipt image the user chose to scan |
| Claude API | Later | Only trip data the asking user may already see, via read-only tools |
| WhatsApp | MVP (sharing only) | Share-sheet text/links; no WhatsApp API integration |

---

## 11. Out of scope for this architecture version
Payment processing/wallet, public APIs, admin back-office, analytics warehouse, multi-currency conversion logic (schema ready), offline sync engine, WhatsApp bot. Each can be added without restructuring the core described here.
