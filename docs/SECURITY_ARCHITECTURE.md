# TripMate — Security and Privacy Architecture

Status: **Proposed (v0.1) — pending approval.** Design only.

TripMate stores accounts and financial records among groups of friends. The security goal is simple: **a user can see and change only what they are authorized to, and nobody can silently alter financial history.**

---

## 1. Threat model (what we defend against)

| Threat | Example | Primary defence |
|---|---|---|
| Unauthorized trip access | Guessing a trip id to read someone else's expenses | RLS + API membership check; 404 for non-members |
| Privilege escalation | Member trying to remove an admin or confirm someone else's repayment | Role/ownership checks in API **and** write functions |
| Tampered financial data | Client sends shares that don't add up, or edits a confirmed repayment | Server recomputes shares; DB sum constraints; state machine |
| Silent history rewriting | Editing an expense to hide something | Append-only revisions + activity log |
| Invite abuse | Brute-forcing or reusing invite links | 256-bit random tokens, hashed storage, expiry, max uses, revocation, rate limits |
| Credential attacks | Credential stuffing, weak passwords | Managed Auth, rate limits, strong-password rule, breach-password check where available |
| Data leakage via files | Public receipt URLs | Private buckets, signed short-lived URLs |
| Injection / XSS | Malicious text in titles/notes | Parameterised queries, Zod validation, text rendered as plain text, no HTML rendering |
| Secret leakage | Service key in app bundle or Git | Secrets only in server-side stores; `.env` ignored; secret scanning in CI |
| API abuse / cost abuse | Scripted flooding; AI/OCR spam | Rate limits, per-user quotas |
| Lost data | Bad migration, accidental deletion | Backups, soft deletes, migrations in CI, staging first |

---

## 2. Authentication

| Topic | Design |
|---|---|
| Provider | Supabase Auth (managed). No custom password handling in TripMate code. |
| Methods at launch | Email + password, Google sign-in. Phone OTP deferred (SMS cost/DLT; Q-2). |
| Password storage | Hashed (bcrypt) by the Auth service; TripMate never sees or stores plaintext. |
| Sessions | Short-lived JWT access token (~1 hour) + rotating refresh token. Refresh reuse detection enabled. |
| Token storage | Mobile: OS secure storage (Keychain/Keystore via SecureStore). Web: Auth library's browser storage; strict CSP to limit XSS exposure. |
| Email verification | Required before the account can create/join trips (prevents impersonation by typing someone else's email). |
| Password reset | Via Auth email flow; tokens single-use and short-lived. |
| Logout | Clears local session, revokes refresh token. "Log out everywhere" in settings. |
| Rate limiting | Provided by Auth for sign-in/up/reset; additional API limits (see API_DESIGN §4). |

---

## 3. Authorization

Three layers, so one mistake cannot expose data:

1. **API layer:** verifies JWT, loads user id, checks membership/role/ownership, validates input.
2. **Write functions:** re-check membership and role using the verified actor id passed in; they are executable only by the server credential, not by `anon` or `authenticated` clients.
3. **RLS on every table:** reads restricted to the data a user may see.

### 3.1 Resource-based rules

- A trip's data (members, expenses, payers, splits, repayments, budgets, itinerary, activity, attachments) is visible only to **active members** of that trip: `is_trip_member(trip_id)` (a `SECURITY DEFINER`, `STABLE` helper with a fixed `search_path`).
- `personal` expenses are visible **only to their creator**; no other member, including admins, can read them, and they never enter group totals.
- Admin-only actions use `is_trip_admin(trip_id)`.
- A user cannot read other users' profiles except `display_name` and `avatar` of people who share an active trip with them (a view limits columns; **`upi_id` is visible only to members of a shared trip**, since it's needed to pay them).
- Removed/left members lose access to the trip's data (Q-7: they can optionally keep read-only access to their own settlement summary if you want; default is no access).
- `trip_invites.token_hash` is never exposed to clients; the public preview endpoint returns only non-financial trip info.

### 3.2 Table grants

| Table group | `authenticated` clients may | Writes happen via |
|---|---|---|
| `profiles` | SELECT (limited), UPDATE own non-sensitive fields | API / direct (own row only) |
| Trips, members, invites, expenses, payers, splits, revisions, repayments, budgets, itinerary, attachments, activity | **SELECT only** (RLS-filtered) | API → write functions (service credential) |
| `activity_log`, `expense_revisions` | SELECT only | Append-only; no UPDATE/DELETE for any app role |
| `notifications` | SELECT, UPDATE `read_at` on own rows | API |

### 3.3 Financial-edit protection
- Confirmed repayments are terminal; no endpoint modifies them.
- Expense edits require `expectedVersion`; every edit stores a full snapshot revision with actor and time.
- Deleted expenses are soft-deleted and restorable by admin/creator; deletion and restoration are logged.
- Only the receiver can confirm; only the payer (or admin) can mark paid.
- Last-admin protection prevents orphaned trips.

---

### 3.4 Database functions (ADR-032, approved 2026-11-18)

For ordinary signed-in operations (creating trips, and later changing members, edits and so on) TripMate uses **database functions that run inside Postgres and decide for themselves who is calling**, instead of a server holding a Supabase secret key. This supersedes the "write functions callable only by the service credential" wording in §3 and §3.2 for trips and members. The layers are now:

1. **Row-Level Security** on every table (reads limited to what a person may see).
2. **No direct write permissions** for signed-in users (and none at all for signed-out visitors).
3. **Functions** callable only by signed-in users that identify the caller with `auth.uid()`, check membership/role/ownership, pin `search_path`, and make each change atomically.
4. **An automatic audit** (`supabase/tests/security-audit.test.ts`) that fails if any migration breaks these rules, including an explicit allow-list of functions a signed-in user may run.

**Administrator checks (M3.3):** role-restricted functions (`update_trip`, `set_trip_archived`) look up the caller's role with an internal helper (`trip_role_of`) that only counts ACTIVE members and that the app cannot call. A person who is not on the trip, or a trip that does not exist, always gets the same `trip_not_found` answer, so trip existence is never revealed; a member who is not an administrator gets `not_admin`. Edits take a row lock and check the caller's expected version in the same transaction, so a stale edit can never overwrite a newer one. Archived trips are read-only. The two functions were added to the audit allow-list as a deliberate review step.

The service-role / secret key is **not used anywhere**. It may be introduced only for a specific trusted backend operation that genuinely needs elevated privileges, with a written justification and the owner's approval (see the ADR-032 conditions and checklist in the decisions log). It must never appear in the frontend, mobile app, public repository or any `EXPO_PUBLIC_` variable.

## 4. Input validation and sanitisation

- Every request body/query is validated by a strict Zod schema (types, lengths, ranges, enums, safe-integer money, UUID format). Unknown fields are rejected.
- Titles/notes/names have length limits; control characters stripped; **output is always rendered as text** (no `dangerouslySetInnerHTML`, no Markdown/HTML rendering of user content).
- UPI ID checked against a conservative pattern before being placed in a deep link, and URL-encoded when building it.
- Uploads: MIME allow-list (JPEG, PNG, WebP, PDF), ≤ 5 MB, content type verified server-side, random file names (user-supplied names never used as paths).
- All SQL parameterised; dynamic identifiers never built from user input.
- Web: Content-Security-Policy, `X-Content-Type-Options`, `Referrer-Policy`, frame protection (`frame-ancestors 'none'`), HSTS, CORS restricted to the TripMate web origin(s).

---

## 5. File and receipt security

- Buckets are **private**. Object path: `{tripId}/{ownerMemberId}/{uuid}.{ext}`.
- Storage policies mirror trip membership: only active members of the trip can read; only the uploader (or admin) can delete.
- Downloads use signed URLs valid for ~60 seconds; upload URLs are single-use.
- Clients compress/resize images before upload; EXIF location data stripped client-side.
- On expense/trip deletion or account deletion, related files are queued for removal.

---

## 6. Secrets management

| Secret | Where it lives | Never in |
|---|---|---|
| Supabase URL + anon key | Public client config (safe by design; protected by RLS) | — |
| Supabase **service-role / secret key** | **Not used.** If ever needed (ADR-032 condition 7): a trusted backend's own secret store only | Client code, Git, logs, `EXPO_PUBLIC_` variables, chat |
| Google OAuth client secret | Supabase Auth config | Git |
| Sentry DSN | Public-ish client config; auth token only in CI | Git |
| AI / OCR API keys (later) | Edge Function secrets | Client code |
| CI/CD tokens (EAS, Vercel, Supabase) | GitHub encrypted secrets | Repository |

Rules: `.env*` files ignored by Git; a committed `.env.example` documents variable **names** only; each environment (dev/staging/prod) has distinct credentials; secret scanning (GitHub secret scanning/gitleaks) runs in CI; rotate keys immediately if exposed.

---

## 7. Privacy and data protection

- **Data minimisation:** collect name, email, optional photo, optional UPI ID. No contacts access, no precise location in MVP, no payment credentials ever.
- **Transparency among members:** by design (rule 8), all members of a trip see that trip's shared financial records. Users are told this at trip creation/join.
- **UPI ID:** optional, visible only to co-members, never logged.
- **Account deletion** (required by app stores and good practice): the profile is anonymised and `trip_members.user_id` detached so the person becomes "Former member" in others' records. Other members' ledgers remain correct and intact. Personal expenses and uploaded files are deleted; revisions of shared expenses keep the anonymised actor.
- **Data export:** a user can request their data (later milestone).
- **Regulatory awareness:** users are in India, so the Digital Personal Data Protection Act, 2023 applies in principle: clear consent and privacy notice, purpose limitation, deletion on request, breach response plan. A privacy policy and terms are required before public launch and should be reviewed by a qualified person; this document is not legal advice.
- **Data location:** Supabase region chosen for latency to India (e.g. Mumbai if available; verify) — Q-9.
- **Logs:** no tokens, passwords, UPI IDs, or receipt contents.
- **AI/OCR (later):** only data the asking user could already read is sent to the provider; users are informed; provider data-retention settings reviewed before launch.

---

## 8. Audit and accountability

- `expense_revisions`: full snapshot per change (who, when, what).
- `activity_log`: who did what, written in the same transaction as the change.
- Both are append-only at the database permission level.
- `repayments` retain `paid_at`, `confirmed_at`, `cancelled_at` plus actor ids in the activity log.
- Admin actions (remove member, role change) are logged.

---

## 9. Operational security

- Production and staging are **separate projects** with separate keys and data. No production data in dev.
- Migrations reviewed in pull requests and applied to staging before production.
- Dependency updates automated (Dependabot) and audited in CI (`npm audit` equivalent).
- Least privilege on every CI token; production deploys only from the `main` branch.
- Error responses never reveal stack traces, SQL, or internal ids beyond the request id.
- Incident basics: Sentry alerts, key rotation checklist, backup restore procedure documented and tested **before** launch.

---

## 10. Security test plan (to be implemented with each milestone)

| Test | Milestone |
|---|---|
| User B cannot read or write User A's trip (pgTAP + API tests) | Trips |
| Non-admin cannot remove members/change roles | Members |
| Expired/revoked/over-used invite is rejected; token not stored in plaintext | Invites |
| Member cannot edit another member's expense (if "own only") | Expenses |
| Personal expense invisible to others, excluded from balances | Expenses |
| Direct client INSERT/UPDATE on financial tables is denied | Expenses |
| Only receiver can confirm; repeat confirm doesn't double-apply | Repayments |
| Stale `expectedVersion` returns 409 and does not overwrite | Expenses |
| Receipt URL of another trip is inaccessible; URLs expire | Receipts |
| Rate limits trigger 429 | Hardening |
| CSP/headers present on the web build | Deployment |

---

## 11. Known residual risks (accepted for MVP)

- Members of a trip can see each other's shared financial records and (co-members') UPI IDs — intended.
- A member can mark a repayment **Paid** without actually paying; mitigated by the receiver's explicit **Confirm** step and the Paid/Confirmed distinction.
- Email-only sign-up allows throwaway accounts; mitigated by email verification and invite-based joining.
- No MFA at launch (can be enabled later via Supabase Auth).
