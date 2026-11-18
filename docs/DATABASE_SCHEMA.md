# TripMate — Database Schema

Status: **Design v0.1, being implemented one milestone at a time.** Implemented so far: `profiles` (migration `20261118000000`), `trips` + `trip_members` (migration `20261118100000`) and trip editing/archiving (migration `20261118200000`: a version trigger on `trips`, `update_trip`, `set_trip_archived`, and the internal helper `trip_role_of`; no table or policy changes). `trips.version` now adds 1 on every real change and never on a no-op. **Obligation for the expenses milestone (ADR-043): `update_trip` must refuse trip date changes that would leave an existing expense outside the trip, and expenses must be refused on archived trips.** Everything else is still design. Where the migrations differ from this document, the migrations and the decisions log win. One difference so far: trips and members are written by `create_trip()`-style database functions that check `auth.uid()` (ADR-032) rather than by an API using the service credential.

Database: PostgreSQL (managed by Supabase). See [TECH_STACK_DECISIONS.md](TECH_STACK_DECISIONS.md) and [ARCHITECTURE_DECISIONS_LOG.md](ARCHITECTURE_DECISIONS_LOG.md).

---

## 1. Conventions

| Convention | Rule |
|---|---|
| Primary keys | `uuid`. Tables where clients create rows offline-safely (expenses, repayments) take the **client-generated UUID** so retries are idempotent (ADR-009). Others use `gen_random_uuid()`. |
| Money | **`bigint` in minor units** (paise for INR). Never `float`/`numeric` for money. Column suffix `_minor`. |
| Currency | `char(3)` ISO 4217 (`INR`). MVP: one currency per trip; every amount in a trip is in the trip's currency. |
| Time | `timestamptz` (UTC). Trip dates (`start_date`, `end_date`) are `date`. |
| Deletes | Financial rows are **soft-deleted** (`deleted_at`). History is kept (ADR-008). |
| Concurrency | Mutable financial rows carry `version int` for optimistic locking (ADR-009). |
| Enums | Implemented as `text` + `CHECK` (easier to evolve than Postgres enum types). |
| Naming | `snake_case`, plural table names. |
| Security | RLS enabled on **every** table in the `public` schema. See [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md). |

---

## 2. Entity overview

Mapping from the entities named in the brief to tables:

| Brief entity | Table(s) | Note |
|---|---|---|
| Users | `auth.users` (Supabase-managed) | Credentials live here only. |
| User profiles | `profiles` | 1:1 with `auth.users`. |
| Trips | `trips` | |
| Trip members | `trip_members` | Membership **and** identity inside a trip (supports guests and removed members). |
| Trip invitations | `trip_invites` | |
| Expenses | `expenses`, `expense_payers`, `expense_revisions` | |
| Expense participants **and** split details | `expense_splits` | One table: a participant *is* a row with a share (ADR-012). Avoids two tables drifting apart. |
| Settlements | *(computed, not stored)* | Suggested transfers are derived on demand (ADR-011). |
| Repayments | `repayments` | The real, recorded money movements between members. |
| Budgets | `trips.budget_minor` + `budgets` | |
| Itinerary items | `itinerary_items` | |
| Notifications | `notifications`, `device_tokens` | |
| Receipt attachments | `attachments` | |
| Activity history | `activity_log` | Append-only. |
| (Supporting) | `categories` | |

---

## 3. Entity Relationship Diagram

```mermaid
erDiagram
    AUTH_USERS ||--|| PROFILES : "has one"
    PROFILES ||--o{ TRIPS : "creates"
    TRIPS ||--o{ TRIP_MEMBERS : "has"
    PROFILES |o--o{ TRIP_MEMBERS : "is (null for guests)"
    TRIPS ||--o{ TRIP_INVITES : "has"
    TRIPS ||--o{ EXPENSES : "contains"
    TRIPS ||--o{ REPAYMENTS : "contains"
    TRIPS ||--o{ BUDGETS : "has"
    TRIPS ||--o{ ITINERARY_ITEMS : "plans"
    TRIPS ||--o{ ACTIVITY_LOG : "records"
    TRIPS ||--o{ CATEGORIES : "defines custom"
    CATEGORIES ||--o{ EXPENSES : "classifies"
    EXPENSES ||--|{ EXPENSE_PAYERS : "paid by"
    EXPENSES ||--o{ EXPENSE_SPLITS : "shared by"
    EXPENSES ||--o{ EXPENSE_REVISIONS : "history"
    EXPENSES ||--o{ ATTACHMENTS : "has receipts"
    TRIP_MEMBERS ||--o{ EXPENSE_PAYERS : "pays"
    TRIP_MEMBERS ||--o{ EXPENSE_SPLITS : "owes share"
    TRIP_MEMBERS ||--o{ REPAYMENTS : "from"
    TRIP_MEMBERS ||--o{ REPAYMENTS : "to"
    REPAYMENTS ||--o{ ATTACHMENTS : "has proof"
    PROFILES ||--o{ NOTIFICATIONS : "receives"
    PROFILES ||--o{ DEVICE_TOKENS : "registers"

    PROFILES {
        uuid id PK
        text display_name
        text upi_id
        text theme_preference
    }
    TRIPS {
        uuid id PK
        text name
        char currency
        bigint budget_minor
        uuid created_by FK
    }
    TRIP_MEMBERS {
        uuid id PK
        uuid trip_id FK
        uuid user_id FK
        text role
        text status
    }
    EXPENSES {
        uuid id PK
        uuid trip_id FK
        bigint amount_minor
        text split_method
        text scope
        int version
    }
    EXPENSE_PAYERS {
        uuid expense_id PK
        uuid trip_member_id PK
        bigint paid_minor
    }
    EXPENSE_SPLITS {
        uuid expense_id PK
        uuid trip_member_id PK
        bigint share_minor
    }
    REPAYMENTS {
        uuid id PK
        uuid from_member_id FK
        uuid to_member_id FK
        bigint amount_minor
        text status
    }
```

### Relationship summary

| Relationship | Type | Notes |
|---|---|---|
| `auth.users` ↔ `profiles` | **1 : 1** | `profiles.id` is both PK and FK to `auth.users.id`. |
| `profiles` → `trips` | 1 : many | `trips.created_by`. Creator is also an admin member. |
| `trips` ↔ `profiles` (via `trip_members`) | **many : many** | A user is in many trips; a trip has many users. `trip_members` is the join table and carries role/status. |
| `trips` → `expenses`, `repayments`, `budgets`, `itinerary_items`, `activity_log` | 1 : many | |
| `expenses` ↔ `trip_members` via `expense_payers` | **many : many** | Supports several payers on one expense. |
| `expenses` ↔ `trip_members` via `expense_splits` | **many : many** | Only members with a row participate and owe. |
| `repayments` → `trip_members` | many : 1 (twice) | `from_member_id` and `to_member_id`. |
| `expenses` → `attachments` | 1 : many | Receipts. |

---

## 4. Tables

### 4.1 `profiles`
**Purpose:** App-level identity and preferences for each account. 1:1 with `auth.users`.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK**, FK → `auth.users(id)` ON DELETE CASCADE |
| `display_name` | text | NOT NULL, length 1–60 |
| `avatar_path` | text | NULL (Storage path, not a public URL) |
| `upi_id` | text | NULL, format-checked (`name@bank`). Used only to build UPI deep links. |
| `preferred_currency` | char(3) | NOT NULL DEFAULT `'INR'` |
| `theme_preference` | text | NOT NULL DEFAULT `'light'`, CHECK IN (`light`,`dark`,`system`) |
| `deleted_at` | timestamptz | NULL (account anonymised, see Security doc) |
| `created_at`, `updated_at` | timestamptz | NOT NULL DEFAULT now() |

**Indexes:** PK only.
**Notes:** Default theme is `light`, matching the UI brief. A trigger creates the profile row on sign-up.

### 4.2 `trips`
**Purpose:** A group trip; the root of all shared financial data.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** DEFAULT gen_random_uuid() |
| `name` | text | NOT NULL, 1–100 chars |
| `destination` | text | NOT NULL |
| `start_date`, `end_date` | date | NOT NULL, CHECK `end_date >= start_date` |
| `description` | text | NULL |
| `budget_minor` | bigint | NULL, CHECK `>= 0` (overall budget — the single source for the overall budget) |
| `currency` | char(3) | NOT NULL DEFAULT `'INR'`; **immutable once the trip has expenses** |
| `cover_image_path` | text | NULL |
| `status` | text | NOT NULL DEFAULT `'active'`, CHECK IN (`active`,`archived`) |
| `created_by` | uuid | NOT NULL, FK → `profiles(id)` |
| `created_at`, `updated_at` | timestamptz | |
| `version` | int | NOT NULL DEFAULT 1 |

Display states "Upcoming / Ongoing / Completed" are **derived from dates**, not stored, so they can never go stale.

**Indexes:** `(created_by)`.

### 4.3 `trip_members`
**Purpose:** Who is in a trip and in what role. Also the identity used by every expense and repayment (ADR-007).

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** DEFAULT gen_random_uuid() |
| `trip_id` | uuid | NOT NULL, FK → `trips(id)` ON DELETE CASCADE |
| `user_id` | uuid | NULL, FK → `profiles(id)`. **NULL = guest** (name-only placeholder, claimable later) |
| `display_name` | text | NOT NULL (snapshot; for guests it is the entered name) |
| `role` | text | NOT NULL DEFAULT `'member'`, CHECK IN (`admin`,`member`) |
| `status` | text | NOT NULL DEFAULT `'active'`, CHECK IN (`active`,`removed`,`left`) |
| `joined_at` | timestamptz | NOT NULL DEFAULT now() |
| `left_at` | timestamptz | NULL |
| `invited_by` | uuid | NULL, FK → `trip_members(id)` |

**Constraints:**
- `UNIQUE (trip_id, user_id) WHERE user_id IS NOT NULL` — a user appears once per trip (rejoin reactivates the same row, preserving history).
- Every active trip must keep **≥ 1 active admin** (enforced inside the write functions; a trigger is the backstop).

**Indexes:** `(trip_id, status)`, `(user_id) WHERE status = 'active'` (the "my trips" query).

**Why `trip_members.id` instead of `user_id` everywhere else?** Removed members, guests and (later) deleted accounts all need a stable identity inside a ledger. Expenses reference `trip_members.id`, so historical balances never break when someone leaves.

### 4.4 `trip_invites`
**Purpose:** Shareable join links.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** |
| `trip_id` | uuid | NOT NULL, FK → `trips` ON DELETE CASCADE |
| `token_hash` | text | NOT NULL, **UNIQUE** (SHA-256 of the token; the raw token is shown once and never stored) |
| `claim_member_id` | uuid | NULL, FK → `trip_members(id)` — if set, accepting the invite claims that guest member |
| `created_by` | uuid | NOT NULL, FK → `trip_members(id)` |
| `expires_at` | timestamptz | NOT NULL |
| `max_uses` | int | NULL (NULL = unlimited until expiry) |
| `use_count` | int | NOT NULL DEFAULT 0, CHECK `use_count <= max_uses` when max_uses set |
| `revoked_at` | timestamptz | NULL |
| `created_at` | timestamptz | |

**Indexes:** UNIQUE `(token_hash)`, `(trip_id)`.

### 4.5 `categories`
**Purpose:** System and custom expense categories.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** |
| `trip_id` | uuid | NULL, FK → `trips` ON DELETE CASCADE. **NULL = system category** |
| `key` | text | NOT NULL (stable slug, e.g. `food`) |
| `name` | text | NOT NULL |
| `icon` | text | NOT NULL (icon name from the app icon set) |
| `sort_order` | int | NOT NULL DEFAULT 0 |
| `archived_at` | timestamptz | NULL (custom categories are archived, not deleted, if in use) |

Seeded system categories (MVP): `transportation`, `accommodation`, `food`, `shopping`, `activities`, `fuel_tolls`, `other`. Indian-specific sub-categories (Feature 10) are added later as seed data, with no schema change.
**Constraints:** `UNIQUE (COALESCE(trip_id, zero-uuid), key)`.

### 4.6 `expenses`
**Purpose:** The central record: one shared (or personal) spend.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** — **client-generated** (idempotent create) |
| `trip_id` | uuid | NOT NULL, FK → `trips(id)` ON DELETE CASCADE |
| `title` | text | NOT NULL, 1–120 chars |
| `amount_minor` | bigint | NOT NULL, CHECK `> 0` (trip currency) |
| `category_id` | uuid | NULL, FK → `categories(id)` |
| `spent_at` | timestamptz | NOT NULL |
| `notes` | text | NULL, ≤ 1000 chars |
| `scope` | text | NOT NULL DEFAULT `'shared'`, CHECK IN (`shared`,`personal`) |
| `split_method` | text | NOT NULL, CHECK IN (`equal`,`exact`,`percentage`,`shares`) |
| `created_by` | uuid | NOT NULL, FK → `trip_members(id)` |
| `updated_by` | uuid | NULL, FK → `trip_members(id)` |
| `created_at`, `updated_at` | timestamptz | |
| `version` | int | NOT NULL DEFAULT 1 |
| `deleted_at` | timestamptz | NULL |
| `deleted_by` | uuid | NULL, FK → `trip_members(id)` |

**Scope semantics (rule 9):**
- `shared` — has payers and splits, counts toward balances, visible to all members.
- `personal` — visible **only to its creator** (via RLS), has **no** payer/split rows, and is excluded from every group figure and balance. It still belongs to a trip (rule 1) so it appears in the creator's trip and personal history.

**Split methods:** "equal", "selected members only" (= equal over the chosen participants), "percentage" and "exact amount" map directly. The brief's "unequal splitting" maps to `shares` (weights, e.g. 2:1:1) in addition to `exact`. See open question Q-15.

**Indexes:**
- `(trip_id, spent_at DESC) WHERE deleted_at IS NULL` — main list and day-wise views
- `(trip_id, category_id) WHERE deleted_at IS NULL` — category breakdown
- `(trip_id, created_by)` — "my expenses" and permission checks

Multi-currency (Feature 15) later adds nullable columns (`original_amount_minor`, `original_currency`, `fx_rate`, `fx_rate_date`) **without** changing balance logic, because `amount_minor` is always in the trip's reporting currency.

### 4.7 `expense_payers`
**Purpose:** Who actually paid, and how much (supports several payers).

| Column | Type | Constraints |
|---|---|---|
| `expense_id` | uuid | FK → `expenses` ON DELETE CASCADE |
| `trip_member_id` | uuid | FK → `trip_members` |
| `paid_minor` | bigint | NOT NULL, CHECK `> 0` |
| | | **PK (`expense_id`, `trip_member_id`)** |

**Invariants (deferred constraint trigger, checked at commit):**
1. `SUM(paid_minor) = expenses.amount_minor`
2. Every payer belongs to the same trip as the expense and is an active member at write time.
3. A `shared` expense has ≥ 1 payer; a `personal` expense has none.

**Indexes:** `(trip_member_id)`.

### 4.8 `expense_splits`
**Purpose:** Participants and each participant's computed share. **A member with no row does not participate and is never charged (rule 4).**

| Column | Type | Constraints |
|---|---|---|
| `expense_id` | uuid | FK → `expenses` ON DELETE CASCADE |
| `trip_member_id` | uuid | FK → `trip_members` |
| `share_minor` | bigint | NOT NULL, CHECK `>= 0` (final computed amount) |
| `input_value` | numeric | NULL — what the user entered (percentage in basis points, share weight, exact amount) so the form can be re-opened faithfully and the UI can explain the split |
| | | **PK (`expense_id`, `trip_member_id`)** |

**Invariants (deferred constraint trigger):**
1. `SUM(share_minor) = expenses.amount_minor` — **splits add up exactly**.
2. Every participant belongs to the expense's trip.
3. A `shared` expense has ≥ 1 split row; a `personal` expense has none.

`share_minor` is always stored as the **final integer result** computed by the shared TypeScript engine; the database never re-derives it, it only verifies the sum (ADR-004, ADR-005).

**Indexes:** `(trip_member_id)`.

### 4.9 `expense_revisions`
**Purpose:** Immutable audit/history of every create, edit, delete and restore (feeds activity feed, trust features and the future dispute feature).

| Column | Type | Constraints |
|---|---|---|
| `id` | bigint | **PK** identity |
| `expense_id` | uuid | NOT NULL, FK → `expenses` ON DELETE CASCADE |
| `version` | int | NOT NULL, **UNIQUE (`expense_id`, `version`)** |
| `action` | text | NOT NULL, CHECK IN (`create`,`update`,`delete`,`restore`) |
| `snapshot` | jsonb | NOT NULL (full expense + payers + splits at that version) |
| `changed_by` | uuid | NOT NULL, FK → `trip_members(id)` |
| `changed_at` | timestamptz | NOT NULL DEFAULT now() |

Append-only: `UPDATE` and `DELETE` are revoked from all application roles.

### 4.10 `repayments`
**Purpose:** Recorded money transfers between two members. Reduces outstanding balances according to its status.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** — client-generated (idempotent) |
| `trip_id` | uuid | NOT NULL, FK → `trips` ON DELETE CASCADE |
| `from_member_id` | uuid | NOT NULL, FK → `trip_members` (the payer/debtor) |
| `to_member_id` | uuid | NOT NULL, FK → `trip_members` (the receiver) |
| `amount_minor` | bigint | NOT NULL, CHECK `> 0` |
| `method` | text | NOT NULL DEFAULT `'upi'`, CHECK IN (`upi`,`cash`,`bank`,`other`) |
| `note` | text | NULL (e.g. UPI reference), ≤ 200 chars |
| `status` | text | NOT NULL DEFAULT `'pending'`, CHECK IN (`pending`,`paid`,`confirmed`,`cancelled`) |
| `from_suggestion` | boolean | NOT NULL DEFAULT false (created from a suggested settlement) |
| `created_by` | uuid | NOT NULL, FK → `trip_members(id)` |
| `created_at` | timestamptz | |
| `paid_at`, `confirmed_at`, `cancelled_at` | timestamptz | NULL |
| `version` | int | NOT NULL DEFAULT 1 |

**Constraints:** `CHECK (from_member_id <> to_member_id)`; both members must belong to `trip_id`; allowed transitions only (see below).

**State machine:**

```
pending ──mark paid (by payer)──▶ paid ──confirm (by receiver)──▶ confirmed
   │                               │
   └──────────cancel───────────────┘   (cancelled is terminal; confirmed is terminal)
```

Transitions are performed with conditional updates (`UPDATE … WHERE id = $1 AND status = $2`), so two simultaneous clicks cannot double-apply (see Financial integrity §6). `cancelled` is an addition to the brief's three statuses so that mistakes can be voided without deleting history (Q-12).

**Partial repayments:** any amount `> 0` is valid; multiple repayment rows between the same pair are normal. A repayment larger than the current debt is allowed but flagged by the UI (it would flip the direction of the debt) (Q-16).

**Indexes:** `(trip_id, status)`, `(from_member_id)`, `(to_member_id)`.

### 4.11 `budgets`
**Purpose:** Sub-budgets. The **overall** budget lives on `trips.budget_minor` (one source of truth).

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** |
| `trip_id` | uuid | NOT NULL, FK → `trips` ON DELETE CASCADE |
| `scope` | text | NOT NULL, CHECK IN (`per_person`,`daily`,`category`) |
| `category_id` | uuid | NULL, FK → `categories` — required when `scope='category'`, otherwise NULL |
| `amount_minor` | bigint | NOT NULL, CHECK `>= 0` |
| `updated_at` | timestamptz | |

**Constraints:** `UNIQUE (trip_id, scope, COALESCE(category_id, zero-uuid))`.

### 4.12 `itinerary_items`
**Purpose:** Day-wise plan (post-MVP). Days are derived from `day_date`, not a separate table.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** |
| `trip_id` | uuid | NOT NULL, FK → `trips` ON DELETE CASCADE |
| `day_date` | date | NOT NULL (must fall inside the trip's dates) |
| `title` | text | NOT NULL |
| `location_text` | text | NULL (free text for now; map coordinates added with the maps feature) |
| `start_time`, `end_time` | time | NULL |
| `notes` | text | NULL |
| `sort_order` | int | NOT NULL DEFAULT 0 |
| `created_by` | uuid | FK → `trip_members(id)` |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |

**Indexes:** `(trip_id, day_date, sort_order) WHERE deleted_at IS NULL`.
**Link to expenses (later):** a nullable `expenses.itinerary_item_id` FK, added by migration when the itinerary milestone arrives. Until then, "expenses for Day 2" is answered by `spent_at`.

### 4.13 `attachments`
**Purpose:** Receipt / payment-proof file metadata (the file itself is in private Storage).

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | **PK** |
| `expense_id` | uuid | NULL, FK → `expenses` ON DELETE CASCADE |
| `repayment_id` | uuid | NULL, FK → `repayments` ON DELETE CASCADE |
| `storage_path` | text | NOT NULL (`{trip_id}/{owner_id}/{uuid}.{ext}`) |
| `mime_type` | text | NOT NULL, CHECK IN (`image/jpeg`,`image/png`,`image/webp`,`application/pdf`) |
| `size_bytes` | int | NOT NULL, CHECK `<= 5242880` (5 MB) |
| `uploaded_by` | uuid | NOT NULL, FK → `trip_members(id)` |
| `created_at` | timestamptz | |

**Constraint:** `CHECK (num_nonnulls(expense_id, repayment_id) = 1)`.
**Indexes:** `(expense_id)`, `(repayment_id)`.

### 4.14 `activity_log`
**Purpose:** Human-readable, chronological feed per trip. Written in the **same transaction** as the change it describes, so it can never disagree with the data.

| Column | Type | Constraints |
|---|---|---|
| `id` | bigint | **PK** identity (also the stable pagination cursor) |
| `trip_id` | uuid | NOT NULL, FK → `trips` ON DELETE CASCADE |
| `actor_member_id` | uuid | NULL, FK → `trip_members(id)` |
| `type` | text | NOT NULL (e.g. `expense.created`, `expense.updated`, `expense.deleted`, `repayment.paid`, `repayment.confirmed`, `member.joined`, `member.removed`) |
| `entity_type` | text | NULL |
| `entity_id` | uuid | NULL |
| `payload` | jsonb | NOT NULL DEFAULT `{}` (e.g. title, amount, category — enough to render the sentence without joins) |
| `created_at` | timestamptz | NOT NULL DEFAULT now() |

Append-only (no UPDATE/DELETE grants).
**Indexes:** `(trip_id, id DESC)`; optional `(trip_id, actor_member_id, id DESC)` for the member filter.

### 4.15 `notifications` and `device_tokens`
**`notifications`:** `id uuid PK`, `user_id uuid FK → profiles`, `trip_id uuid NULL`, `type text`, `payload jsonb`, `read_at timestamptz NULL`, `created_at`. Index `(user_id, read_at, created_at DESC)`.
**`device_tokens`:** `id uuid PK`, `user_id uuid FK`, `expo_push_token text UNIQUE`, `platform text CHECK IN (ios,android,web)`, `last_seen_at`. Index `(user_id)`.

Both are post-MVP in use, but in the model so no restructuring is needed later.

---

## 5. Deriving balances (never stored)

Balances are **computed from the ledger** on every read (ADR-006). There is no editable "balance" column anywhere, so edits, deletes and member changes cannot leave a stale number behind.

For member `m` in trip `T`, over **non-deleted `shared`** expenses:

```
paid(m)      = Σ expense_payers.paid_minor      where trip_member_id = m
share(m)     = Σ expense_splits.share_minor     where trip_member_id = m
sent(m)      = Σ repayments.amount_minor        where from_member_id = m and status counts
received(m)  = Σ repayments.amount_minor        where to_member_id   = m and status counts

net(m) = paid(m) − share(m) + sent(m) − received(m)
         net > 0  → m should receive money
         net < 0  → m owes money
         Σ net(m) over all members of T = 0   (invariant, asserted in tests)
```

Two figures are exposed (ADR-010; resolves open question Q-3 by providing both):

| Figure | "status counts" means | Used for |
|---|---|---|
| `net_confirmed` | `status = 'confirmed'` | Final, authoritative balance |
| `net_projected` | `status IN ('paid','confirmed')` | "Where we'll be once pending confirmations land"; default headline in the UI |

`pending` and `cancelled` never affect either figure. This directly implements rule 12 (recorded ≠ confirmed).

Implemented as a SQL view/function (`trip_member_balances`) plus the TypeScript engine in `packages/core`; a test asserts both give identical results for the same data.

---

## 6. Financial data integrity

| Requirement | Mechanism |
|---|---|
| Every expense belongs to a trip | `expenses.trip_id NOT NULL` + FK |
| Every shared expense has a valid payer | `expense_payers` rows required; constraint trigger; FK to `trip_members` of the same trip |
| Only selected participants share the cost | Only members with an `expense_splits` row are charged |
| Splits add up exactly | Deferred constraint trigger: `Σ share_minor = amount_minor` (also `Σ paid_minor = amount_minor`), checked at commit |
| Rounding handled | Integer paise; **largest-remainder allocation** in the shared TS engine (see SYSTEM_ARCHITECTURE §6) |
| Edit/delete updates balances | Balances are derived; edit = replace payer/split rows in one transaction + new revision; delete = soft delete |
| Repayments not counted twice | One row per repayment; client UUID makes retries idempotent; status transitions are conditional updates; balance formulas count each row once |
| Partial repayments | Any amount `> 0`; many rows per pair |
| Confirmed repayments update balances | `net_confirmed` includes only `confirmed`; `net_projected` includes `paid` + `confirmed` |
| Concurrent updates cannot silently corrupt | `version` column + `UPDATE … WHERE version = $expected`; mismatch ⇒ HTTP 409 and the client must refetch. Row lock (`SELECT … FOR UPDATE`) on the expense during edit. Sum invariants verified at commit regardless of races. |
| No floating point | `bigint` minor units everywhere; `number`s in TS are safe-integer checked (`Number.isSafeInteger`) at the engine boundary |
| Clients cannot bypass rules | Clients have **no direct INSERT/UPDATE/DELETE** on financial tables; only service-side write functions (ADR-004) |
| Auditable | `expense_revisions` + `activity_log`, append-only |

**Removing a member** sets `status='removed'`; their rows in payers/splits/repayments remain, so history is intact. Whether a member with a non-zero balance may be removed is open question Q-4 (recommendation: block until settled or until an admin explicitly forgives the balance by recording a settlement).

**Deleting an account** anonymises the profile and detaches `trip_members.user_id`, converting the member into a named placeholder ("Former member"); other members' ledgers are unaffected.

---

## 7. Index summary

| Table | Index | Serves |
|---|---|---|
| `trip_members` | `(trip_id, status)`; `(user_id) WHERE status='active'` | Member lists; "my trips"; RLS membership checks (hot path) |
| `trip_invites` | UNIQUE `(token_hash)` | Invite lookup |
| `expenses` | `(trip_id, spent_at DESC) WHERE deleted_at IS NULL` | Expense list, day views |
| `expenses` | `(trip_id, category_id) WHERE deleted_at IS NULL` | Category breakdown |
| `expense_payers`, `expense_splits` | `(trip_member_id)` | Per-member balance sums |
| `repayments` | `(trip_id, status)`, `(from_member_id)`, `(to_member_id)` | Settlement screen, balances |
| `activity_log` | `(trip_id, id DESC)` | Feed with cursor pagination |
| `notifications` | `(user_id, read_at, created_at DESC)` | Inbox and unread badge |

The RLS membership check (`is_trip_member(trip_id)`) runs on almost every query, so the `trip_members` index is the most important one in the system.

---

## 8. Reference data and migrations

- System categories are seed data inserted by a migration.
- Every schema change is a numbered, reviewed migration file in version control; no manual changes in the dashboard.
- Each environment (dev, staging, prod) is built **only** by applying the same migrations.
- Tests (pgTAP) must cover: sum constraints, RLS isolation between two trips, state-machine transitions, and the append-only guarantees.
