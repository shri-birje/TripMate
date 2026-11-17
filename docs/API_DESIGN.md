# TripMate — API Design

Status: **Proposed (v0.1) — pending approval.** No endpoints are implemented.

See [SYSTEM_ARCHITECTURE.md §3](SYSTEM_ARCHITECTURE.md) for why the API is split into direct reads and API writes.

> **Update (M3.1):** no REST API exists yet for accounts, profiles or trips. Those are served directly by Supabase (Auth, row-level-secured reads, and database functions such as `create_trip` called through PostgREST), see ADR-032. `POST /trips` below therefore corresponds to the `create_trip` function for now. The REST API described here is still the plan for expenses and money (M5 onward), where the money engine must run on a server.

---

## 1. Principles

| Principle | Detail |
|---|---|
| REST over HTTPS, JSON | Base URL: `https://<project>.supabase.co/functions/v1/api/v1` (a custom API domain is a later, paid option). |
| Auth | `Authorization: Bearer <Supabase access token>` on every endpoint except the public invite preview. Sign-up/login/refresh are **Supabase Auth** endpoints, not part of this API. |
| Resource IDs | Expenses and repayments use **client-generated UUIDs** and are created with `PUT`, making create **idempotent** (same request twice → same resource, one row). |
| Optimistic concurrency | Mutable resources return `version`. `PATCH`/state-changing calls send `expectedVersion`; a mismatch returns **409 CONFLICT** with the current version. |
| Money | Always **integer minor units** (`amountMinor`) plus `currency`. Never decimals. |
| Dates | ISO 8601 UTC for timestamps; `YYYY-MM-DD` for trip/itinerary dates. |
| Pagination | Cursor-based: `?limit=30&cursor=<opaque>`; response `{ items, nextCursor }`. |
| Validation | Every body/query validated by a Zod schema from `packages/core` (the same schemas the forms use). Unknown fields rejected. |
| Versioning | `/v1` prefix; breaking changes ship as `/v2`. |
| Naming | camelCase in JSON; snake_case in the database (mapped at the API boundary). |

---

## 2. Authentication and authorization

**Middleware order:** request id → rate limit → verify JWT (reject 401) → load user id → route handler → **resource authorization** (membership/role/ownership; reject 403/404) → Zod validation (reject 422) → business logic.

Authorization is checked **twice**: in the API and again inside the Postgres write function (which receives the verified actor id and re-checks membership). Also see [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

**Not-a-member policy:** a user requesting a trip they do not belong to gets **404**, not 403, so trip existence is not leaked.

### Permission matrix (proposed; Q-6)

| Action | Admin | Member | Notes |
|---|---|---|---|
| Edit trip details, settings, archive | ✅ | ❌ | |
| Invite / add guest | ✅ | ✅* | *Configurable per trip; default: admins only (open question Q-6) |
| Remove member / change role | ✅ | ❌ | Cannot remove last admin |
| Leave trip | ✅ (if another admin) | ✅ | |
| Add expense | ✅ | ✅ | |
| Edit / delete expense | ✅ any | ✅ own only | "Own" = `created_by` |
| Add/edit/delete personal expense | own only | own only | Invisible to others |
| Create repayment | ✅ | ✅ (involving themselves) | Admin may create for any pair |
| Mark repayment **paid** | payer or admin | payer only | |
| **Confirm** repayment | receiver only | receiver only | Admin override not allowed in MVP, to protect the confirmed state |
| Cancel repayment | creator or admin | creator | Only while not confirmed |
| Set budgets | ✅ | ❌ | |
| Add/edit itinerary | ✅ | ✅ | |
| View all shared financial records | ✅ | ✅ | Transparency (rule 8) |

---

## 3. Error format

HTTP status plus a stable machine-readable code:

```json
{
  "error": {
    "code": "SPLIT_SUM_MISMATCH",
    "message": "Participant shares must add up to the expense amount.",
    "details": { "expectedMinor": 300000, "actualMinor": 299999 },
    "requestId": "req_01H…"
  }
}
```

| HTTP | Code examples | Meaning |
|---|---|---|
| 400 | `MALFORMED_REQUEST` | Not valid JSON |
| 401 | `UNAUTHENTICATED` | Missing/expired token |
| 403 | `FORBIDDEN`, `NOT_ADMIN`, `NOT_OWNER` | Member but not allowed |
| 404 | `NOT_FOUND` | Missing, or no access |
| 409 | `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION`, `ALREADY_EXISTS_DIFFERENT` | Concurrency/state problems |
| 410 | `INVITE_EXPIRED`, `INVITE_REVOKED` | Invite no longer valid |
| 422 | `VALIDATION_FAILED`, `SPLIT_SUM_MISMATCH`, `PAYER_NOT_MEMBER`, `PARTICIPANT_NOT_MEMBER`, `PERCENT_SUM_INVALID` | Valid JSON, invalid content |
| 429 | `RATE_LIMITED` (with `Retry-After`) | Too many requests |
| 500 | `INTERNAL` | Unexpected; logged with `requestId`; details never leaked to the client |

---

## 4. Rate limiting

| Scope | Limit (initial) |
|---|---|
| Per user, general | 120 requests / minute |
| Writes | 60 / minute |
| Invite accept / preview (per IP) | 20 / minute |
| Attachment upload URLs | 20 / minute |
| AI / OCR (later) | Per-user daily quota |

Sign-in/sign-up/password-reset limits are provided by Supabase Auth. API limits use a small Postgres counter table (fixed window) to avoid adding Redis; revisit if load requires. Numbers are tunable starting points.

---

## 5. Endpoint catalogue

Legend: **R** = also available as a direct RLS read from the client; **W** = write (API only). `:tripId`, `:expenseId` etc. are UUIDs. Phase: **M** = MVP, **P** = post-MVP.

### 5.1 Health
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/health` | Liveness/readiness for uptime monitor (no auth, no data) | M |

### 5.2 Users and profile
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/me` | Current profile + preferences | M |
| PATCH | `/me` | Update name, UPI ID, currency, theme | M |
| POST | `/me/avatar-upload-url` | Signed URL to upload avatar | M |
| GET | `/me/expenses` | My personal expense history across trips (cursor) | M |
| GET | `/me/balances` | My outstanding balance per trip (home screen) | M |
| DELETE | `/me` | Delete account (anonymise; see Security doc) | M |

### 5.3 Trips
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips` | My trips (upcoming/ongoing/completed derived) **R** | M |
| POST | `/trips` | Create trip (creator → admin) **W** | M |
| GET | `/trips/:tripId` | Trip details **R** | M |
| PATCH | `/trips/:tripId` | Update details/budget (admin; `expectedVersion`) **W** | M |
| POST | `/trips/:tripId/archive` | Archive / unarchive (admin) | M |
| GET | `/trips/:tripId/summary` | Dashboard: total spend, counts, per-member paid/share, category totals, remaining budget | M |

### 5.4 Members and invitations
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/members` | List members **R** | M |
| POST | `/trips/:tripId/members` | Add guest member by name (Q-5) | M |
| PATCH | `/trips/:tripId/members/:memberId` | Change role / rename guest | M |
| DELETE | `/trips/:tripId/members/:memberId` | Remove member (rules per Q-4) | M |
| POST | `/trips/:tripId/leave` | Current user leaves | M |
| POST | `/trips/:tripId/invites` | Create invite → returns link once | M |
| GET | `/trips/:tripId/invites` | List active invites (admin) | M |
| DELETE | `/trips/:tripId/invites/:inviteId` | Revoke | M |
| GET | `/invites/:token` | Public preview: trip name, destination, dates, inviter, member count (rate-limited, no financial data) | M |
| POST | `/invites/:token/accept` | Join (or claim a guest) | M |

### 5.5 Expenses
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/expenses` | List with filters: `memberId`, `categoryId`, `from`, `to`, `minMinor`, `maxMinor`, `q`, `includeDeleted` **R** | M |
| PUT | `/trips/:tripId/expenses/:expenseId` | **Create** (idempotent) **W** | M |
| GET | `/trips/:tripId/expenses/:expenseId` | Detail incl. payers, splits **R** | M |
| PATCH | `/trips/:tripId/expenses/:expenseId` | Edit (`expectedVersion` required) **W** | M |
| DELETE | `/trips/:tripId/expenses/:expenseId` | Soft delete (`expectedVersion`) **W** | M |
| POST | `/trips/:tripId/expenses/:expenseId/restore` | Undo delete | M |
| GET | `/trips/:tripId/expenses/:expenseId/revisions` | History | M |
| POST | `/trips/:tripId/expenses/preview-split` | Stateless: compute shares for given inputs (same engine as server) | M |
| POST | `/trips/:tripId/expenses/:expenseId/attachments` | Get signed upload URL + register attachment | P |
| GET | `/attachments/:attachmentId/url` | Short-lived signed download URL | P |
| DELETE | `/attachments/:attachmentId` | Remove attachment | P |

**Create/edit body (shared expense):**
```json
{
  "title": "Petrol",
  "amountMinor": 300000,
  "currency": "INR",
  "categoryId": "…",
  "spentAt": "2026-12-27T09:30:00Z",
  "notes": null,
  "scope": "shared",
  "payers": [{ "memberId": "…", "paidMinor": 300000 }],
  "split": {
    "method": "equal",
    "participants": ["…", "…", "…", "…"]
  }
}
```
For `percentage`: `split.inputs = [{ memberId, basisPoints }]` (sum 10000). For `exact`: `inputs = [{ memberId, amountMinor }]`. For `shares`: `inputs = [{ memberId, weight }]`.
**Response** returns the stored expense with `payers`, **server-computed** `splits[{memberId, shareMinor}]`, and `version`.
The server never accepts client-computed shares as authoritative.

### 5.6 Balances and settlement
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/balances` | Per member: `paidMinor`, `shareMinor`, `netConfirmedMinor`, `netProjectedMinor` | M |
| GET | `/trips/:tripId/balances/:memberId/explanation` | Line items behind a member's balance | M |
| GET | `/trips/:tripId/settlement-plan?basis=projected\|confirmed` | Suggested minimal transfers `[{fromMemberId,toMemberId,amountMinor}]` | M |

All three are **computed on read** from the ledger; nothing is cached or stored.

### 5.7 Repayments
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/repayments` | List, filter by `status`, `memberId` **R** | M |
| PUT | `/trips/:tripId/repayments/:repaymentId` | Create `pending` (idempotent) **W** | M |
| POST | `/trips/:tripId/repayments/:repaymentId/mark-paid` | Payer marks paid (`expectedVersion`) | M |
| POST | `/trips/:tripId/repayments/:repaymentId/confirm` | Receiver confirms | M |
| POST | `/trips/:tripId/repayments/:repaymentId/cancel` | Cancel before confirmation | M |

State changes are single conditional updates; invalid or repeated transitions return `409 INVALID_STATE_TRANSITION`.

### 5.8 Categories
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/categories` | System + custom **R** | M |
| POST / PATCH / DELETE | `/trips/:tripId/categories[/:id]` | Custom categories (archive if in use) | P |

### 5.9 Budgets
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/budgets` | All budgets + progress (actual vs budget, remaining, overrun flags) | M (overall, per-person) / P (daily, category) |
| PUT | `/trips/:tripId/budgets/:scope` | Set per-person / daily / category budget (admin) | as above |
| DELETE | `/trips/:tripId/budgets/:budgetId` | Remove | as above |

### 5.10 Activity
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/activity` | Feed, newest first; filters `memberId`, `type`, `from`, `to`; cursor **R** | M |

Filtering by *category, amount, payment status* applies to the expense and repayment lists above; the feed shows events.

### 5.11 Itinerary
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/trips/:tripId/itinerary` | All items grouped by day **R** | P |
| POST | `/trips/:tripId/itinerary` | Add item | P |
| PATCH | `/trips/:tripId/itinerary/:itemId` | Edit / reorder | P |
| DELETE | `/trips/:tripId/itinerary/:itemId` | Remove | P |
| GET | `/trips/:tripId/itinerary/:day/expenses` | Expenses for a day | P |

### 5.12 Notifications
| Method | Path | Description | Phase |
|---|---|---|---|
| GET | `/me/notifications` | Inbox **R** | P |
| POST | `/me/notifications/read` | Mark read | P |
| PUT | `/me/devices/:token` | Register push token | P |
| DELETE | `/me/devices/:token` | Unregister | P |

### 5.13 Future (reserved, not designed in detail)
`POST /trips/:tripId/receipts/scan` (returns a **draft**, never saves an expense) · `POST /trips/:tripId/assistant/query` (read-only AI) · `GET /trips/:tripId/report` (trip report/export) · expense comments and disputes · currency rates.

---

## 6. Idempotency and concurrency rules

| Case | Behaviour |
|---|---|
| `PUT` create, same id, same payload | 200 with the existing resource (no duplicate) |
| `PUT` create, same id, **different** payload | 409 `ALREADY_EXISTS_DIFFERENT` |
| `PATCH` with stale `expectedVersion` | 409 `VERSION_CONFLICT`, body includes current resource |
| Two users edit the same expense simultaneously | First commit wins; second gets 409 and must reload |
| Repeat confirm/mark-paid | 409 `INVALID_STATE_TRANSITION` (no double-apply) |
| Duplicate-looking expenses with different ids (same title, amount, payer within minutes) | Allowed, but API response includes a `possibleDuplicate` hint so the UI can warn (rule 7, "where possible") |

---

## 7. Logging

Each request logs: request id, user id, method, path, status, duration, error code. **Never** logged: tokens, passwords, UPI IDs, receipt contents, request bodies of expense notes. Errors go to Sentry with the request id.

---

## 8. Database access from the API

- Reads inside the API use the caller's JWT so RLS stays in force.
- Writes call Postgres functions via the service credential **only after** the API has verified the JWT; the verified user id is passed as an argument and re-checked inside the function.
- The service-role key exists only in the Edge Function environment, never in any client bundle.
- All SQL uses parameters; no string-built queries.
