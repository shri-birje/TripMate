# M7 — Repayment tracking: architecture and requirements (Checkpoint 1, revision 4.2 — final; V1 and the R4a/R4b and `requested_for` approvals applied)

**ADR-066: APPROVED (architecture), 2026-11-26. Revision 4.2 records the V1 decision for `counterparty_account_inaccessible` (deferred, not executable), the approved R4a/R4b split and the `requested_for` column. Migration #12 is NOT written; it waits for your authorization.**
**Implementation has NOT started.** Checkpoint 2 (the database) begins only when you say so. Nothing in this document is built: no migration, no database function, no application code, no test.

**Labels used in this document**

| Label | Meaning |
|---|---|
| **APPROVED** | You decided it. It is a requirement. |
| **DEFERRED** | Moved out of M7. Not built, not designed in detail. |
| **Implementation check** | A fact to verify while building, not a decision. If the check fails, it comes back to you before anything is built on it. |

---

## 1. What already exists (kept, not duplicated)

| Area | Today | M7 effect |
|---|---|---|
| **M1 `computeBalances`** (`packages/core/src/balances.ts`) | Defines `LedgerRepayment` (line 39), accepts a `repayments` argument (line 111) and processes repayments (lines 138–152). Has a **confirmed** figure (`netConfirmedMinor`, status `confirmed`) and a **projected** figure (`netProjectedMinor`, statuses `paid` and `confirmed`). Tested in `balances.test.ts`. | **Unchanged and unused by M7** (decision 7). M1 is the reference for the expense-derived balance, called with no repayments. Its `paid` state and projected figure belong to the superseded semantics (section 18, item 7). Not refactored or deleted without separate approval. |
| **M5 `member_net_minor(trip, member)`** | `sum(paid) − sum(share)` over non-deleted expenses. The single internal net used by `trip_member_balances`, the ADR-047 guard, Rule I-1 and the expense functions. | Its body is kept verbatim as `member_expense_net_minor`. `member_net_minor` becomes the sum with the repayment adjustment (section 6.4). |
| **`trip_member_balances(trip)`** | Per member `paid`, `share`, `net`; active members only; allowed on archived trips. | Gains `sent_minor` and `received_minor`; `net_minor` includes confirmed, unreversed repayments. |
| **M6 `planSettlement`** | Pure; the app derives plans from `trip_member_balances.net_minor`. | Unchanged. Sees confirmed balances only. |
| **ADR-047 trigger** | Refuses leave or removal with a non-zero balance (`balance_not_settled`). | Unchanged; a new trigger adds the pending-item rule (D5). |
| **Rule I-1** | Former members stay at exactly zero over the complete ledger. | Unchanged; applies to the new net. |
| **Write pattern** (ADR-063) | SECURITY DEFINER, `auth.uid()`, `search_path = ''`, `authenticated` only, trip row lock then row lock, client-generated ids, expected version, SELECT-only RLS, preflight plus triggers. | Followed exactly. |
| **Audit** | `expense_revisions`, `trip_member_events` (member ids only). | `repayment_events` added in the same style. |
| **Profile** | `profiles.upi_id` owner-only. | Unchanged (D7). |

---

## 2. Product principles (fixed)

1. TripMate is not a payment processor: no wallet, gateway, escrow or money holding.
2. **The payer records; the receiver confirms or rejects.** No repayment is ever created already confirmed.
3. **Only confirmed repayments change official balances.** A reversal stops a confirmed repayment from counting only when it is applied.
4. M1 is unchanged. The settlement plan is deterministic and uses confirmed balances only; pending items appear beside it, never inside it.
5. Nothing is silently edited or deleted. Every change is an event with an actor, a time and, where relevant, a reason.
6. Nobody can fabricate a resolution. A stuck item stays visible and stuck until a permitted person acts; no automatic expiry exists.
7. The database is the authority; the app previews and displays.
8. M7 does not depend on UPI, push notifications, attachments or payment apps.

---

## 3. Repayment lifecycle

### 3.1 States — APPROVED (D1)

| State | Meaning | Counts in official balances? | Final? |
|---|---|---|---|
| `pending` | The payer says they paid; the receiver has not answered. Reserves capacity. | No | No |
| `confirmed` | The receiver confirmed it. | **Yes**, unless an applied reversal exists (section 14) | Yes. The repayment's own status never changes again; a reversal is a separate record. |
| `rejected` | The receiver says it was not received. Releases its reservation. | No | Yes |
| `cancelled` | Withdrawn while pending, by the people allowed under section 10.1. Releases its reservation. | No | Yes |

Only `pending` transitions. Nothing is deleted. An amount is never edited.

### 3.2 Repayment state diagram

```
                       receiver confirms
 payer records ──▶ pending ─────────────────────────▶ confirmed   (its own status never changes again)
 (always pending)    │  │                                │
                     │  │                                └── reversal lifecycle (section 3.3)
                     │  └── payer or recorder cancels; or an admin under R3 (guest only) ──▶ cancelled (final)
                     └───── receiver rejects ───────────────────────────────────────────────▶ rejected  (final)
```

### 3.3 Reversal lifecycle — APPROVED (D13 Option B)

```
                 counterparty (or an R4b proxy) acknowledges
 request ──▶ requested ────────────────────────────────▶ applied        (final; the repayment stops counting)
    │          │   │
    │          │   └── counterparty (or an R4b proxy) declines ───▶ declined (final)
    │          │
    │          └── admin proposes override (section 14.4) ──▶ override_proposed
    │                                                          │
    │                                                          ├── second independent admin approves
    │                                                          │     (eligibility re-evaluated now) ─────▶ applied (is_override = true)
    │                                                          ├── second independent admin refuses ─────▶ override_refused (final)
    │                                                          ├── counterparty (or an R4b proxy)
    │                                                          │     acknowledges ───────────────────────▶ applied (is_override = false)
    │                                                          ├── counterparty (or an R4b proxy) declines ▶ declined (final)
    │                                                          └── requester withdraws ──────────────────▶ withdrawn (final)
    └── requester withdraws (from requested) ────────────────────────────────────────────────────────────▶ withdrawn (final)
```

- `applied`, `declined`, `withdrawn` and `override_refused` are final.
- The normal route (acknowledge or decline) stays open while an override is proposed; an unanswered override never blocks it.
- A declined or withdrawn request may be followed by a **new** request for the same repayment.
- At most one open request (`requested` or `override_proposed`) and at most one `applied` reversal exist per repayment, ever.
- Reminders (section 14.4) change no state. They are events only.

---

### 3.4 Cash and guests — APPROVED (D2, D6)

Cash is recorded by the payer (`method = cash`) and confirmed by the receiver.

| Rule | Who acts for a guest | Conflict rule |
|---|---|---|
| **R1 — recording** | For a guest **payer**: an admin | The admin is **not the receiver** of that repayment. |
| **R2 — deciding** | For a guest **receiver**: an admin (confirm, reject) | The admin is **not the payer** and **not the recorder**. |
| **R3 — cancelling** | For a pending repayment with a **guest party**: an admin who would be an eligible proxy under R1 or R2 | Same conflict rules as R1 or R2. Never for a repayment between two signed-in members. |
| **R4a — guest participant representation** (request, remind, withdraw) | An eligible admin acts on behalf of a **guest who is a party** to the repayment. | The admin is **not a party**, **not the recorder**, and is **not acting for the other side**. The admin is recorded as the authenticated actor (`requested_by`); the guest is the represented participant (`requested_for`). |
| **R4b — guest counterparty representation** (acknowledge, decline) | An eligible admin acts on behalf of a **guest counterparty** of a reversal request. | The admin is **not a party**, **not the recorder**, **not the requester** (`requested_by`), and **has no action on the requesting side**. No admin ever acts on both sides of the same repayment. |

**Hard bans (approved):** nobody confirms or rejects a repayment in which they are the payer; nobody both records and decides the same repayment; an admin never confirms their own payment on behalf of the receiver.

Consequence (accepted): a trip with a guest and only one admin who is a party to that repayment cannot settle it in the app until another admin exists. An admin can promote any account member with the existing function.

---

## 4. Permission matrix — APPROVED

Three identities are distinguished everywhere:
- **Authenticated actor** (`actor_member_id` in events; `requested_by` on a request): the member whose `auth.uid()` made the call. For a proxy this is the admin.
- **Represented participant** (`requested_for` on a request; `represented_member_id` in events): the party of the repayment the action is made for. For an ordinary signed-in person acting personally it equals the actor. For a guest proxy it is the guest.
- **Counterparty**: the other party of the same repayment. Derived, never supplied by the caller.

"Member" = active member. Strangers, former members and signed-out visitors are refused everywhere. Identity comes from `auth.uid()` inside the function.

| Action | Who may do it | Never allowed |
|---|---|---|
| **Record** a repayment (always `pending`) | The payer. An admin for a guest payer (R1). | Recording as the receiver. Creating one already confirmed. |
| **Confirm** a pending repayment | The receiver. An admin for a guest receiver (R2). | The payer. The recorder. Any third member. |
| **Reject** a pending repayment | The receiver. An admin for a guest receiver (R2). | The payer. Any third member. |
| **Cancel** a pending repayment | The payer (own). The recorder. An admin **only** under R3, for a repayment with a guest party. | Any admin acting on a repayment between two signed-in members (D5). The receiver (they reject). |
| **Read** repayments, reversals, events | Every active member (D8). | Former members. Strangers. Signed-out visitors. |
| **Request** a reversal (`requested`) | An ordinary party acting personally (actor = represented). An eligible admin under **R4a** for a guest party. Reason 1–200 characters. Repayment must be `confirmed`, unreversed, trip not archived. | Third members. A proxy for the counterparty side. An admin who is a party or the recorder. |
| **Acknowledge** or **decline** (while `requested` **or** `override_proposed`) | The counterparty, acting personally. An eligible admin under **R4b** for a guest counterparty. | The requester (`requested_by`). Anyone acting for the requester's side. Any party of the repayment acting on the requesting side. |
| **Remind** (`requested` only; reminders stop once an override is proposed) | **The requester** (`requested_by`), or an eligible **R4a** proxy acting for the requester. | Anyone else. The counterparty. Archived trips. |
| **Withdraw** (`requested` or `override_proposed`) | The requester (`requested_by`). | Anyone else. |
| **Propose an admin override** (`counterparty_unresponsive` only, section 14.4) | An active admin who is **not a Participant** of the repayment and meets the 14-day evidence. | A Participant. Any category other than `counterparty_unresponsive` (deferred, not executable). |
| **Approve or refuse** an admin override | An active admin who is a **second independent admin**: not a Participant, not the proposer. Evidence is re-checked at that moment. | The proposer. Any Participant. |
| Anything on a `rejected`, `cancelled`, or reversed (`applied`) repayment | Nobody | Everything |

**Requested_for rules (approved):** `requested_for` is one of the two parties of the repayment, set at creation, **immutable** afterwards (trigger), and never a third member. The counterparty is always the other party.

**Consistency of D5 and D13:** a pending repayment can only be resolved by its parties (payer cancels, receiver rejects) or, for guests, by R2/R3 proxies. A reversal can only be resolved by the counterparty, the requester (withdraw), or a second independent admin on an override. No function lets an admin resolve a pending item between signed-in members, and no function lets an admin resolve a reversal alone.

**Archived trip (D4):** refused: recording, requesting a reversal, reminding, proposing an override. Allowed for already open items: confirm, reject, cancel a pending repayment; acknowledge, decline, withdraw a reversal request; approve or refuse an override already proposed (section 10.3).

---

## 5. Data model

### 5.1 `repayments` — APPROVED (D11: no `from_suggestion`; no attachments)

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | PK, client-generated (safe retry) |
| `trip_id` | uuid | NOT NULL, FK `trips` ON DELETE CASCADE |
| `from_member_id` | uuid | NOT NULL, the payer; `(id, trip_id)` FK to `trip_members` |
| `to_member_id` | uuid | NOT NULL, the receiver; `(id, trip_id)` FK to `trip_members` |
| `amount_minor` | bigint | NOT NULL, `> 0`, safe integer; never edited |
| `method` | text | NOT NULL: `upi`, `cash`, `bank` or `other` (a label only) |
| `note` | text | NULL, **optional, at most 200 characters** (D14) |
| `status` | text | NOT NULL DEFAULT `pending`: one of the four states |
| `created_by` | uuid | NOT NULL, the member who recorded it |
| `created_at` | timestamptz | NOT NULL (transaction time) |
| `decided_by`, `decided_at` | uuid, timestamptz | NULL until a decision |
| `decision_note` | text | NULL, at most 200 characters |
| `version` | int | NOT NULL DEFAULT 1 |

Constraints: `from_member_id <> to_member_id`; `amount_minor > 0`; `pending` has no decider; every other status has one with a time; unique `(id, trip_id)`; indexes on `(trip_id, status)`, `(trip_id, from_member_id)`, `(trip_id, to_member_id)`.

### 5.2 `repayment_reversals` — APPROVED (D13 Option B)

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | PK, client-generated |
| `trip_id` | uuid | NOT NULL |
| `repayment_id` | uuid | NOT NULL; `(repayment_id, trip_id)` FK to `repayments` |
| `status` | text | NOT NULL: `requested`, `override_proposed`, `applied`, `declined`, `withdrawn`, `override_refused` |
| `requested_by` | uuid | NOT NULL, the **authenticated actor** (the member whose `auth.uid()` made the request; an admin for a guest under R4a) |
| `requested_for` | uuid | NOT NULL, the **represented participant**: one of the two parties of the repayment (equal to `requested_by` for an ordinary person acting personally; the guest for a proxy). **Immutable** after creation. Never a third member. |
| `requested_at` | timestamptz | NOT NULL, set by `now()` inside `request_reversal` (the clock of section 14.4 starts here; a client clock is never used) |
| `reason` | text | NOT NULL, **1 to 200 characters** |
| `override_proposed_by` | uuid | NULL, the admin who proposed the override |
| `override_category` | text | NULL: `counterparty_account_inaccessible` or `counterparty_unresponsive` |
| `override_reason` | text | NULL; **at least 20 characters** when an override is proposed |
| `override_proposed_at` | timestamptz | NULL, set by `now()` |
| `decided_by`, `decided_at` | uuid, timestamptz | NULL; the acknowledger, decliner, withdrawer, or the second admin |
| `decision_note` | text | NULL, at most 200 characters |
| `is_override` | boolean | NOT NULL DEFAULT false; true only when applied through an override |
| `version` | int | NOT NULL DEFAULT 1 |

Constraints: partial unique index: at most one row per `repayment_id` with status in (`requested`, `override_proposed`); at most one row per `repayment_id` with status `applied`. `is_override` true requires `override_proposed_by` and `override_category`. `applied` requires `decided_by` and `decided_at`. The applying member must not be a Participant (checked in the function and by a trigger).

### 5.3 `repayment_events` — APPROVED (append-only; member ids only)

One row per change: `id` (identity), `trip_id`, `repayment_id`, `reversal_id` (nullable), `action`, `from_status`, `to_status`, `actor_member_id` (the authenticated actor), `represented_member_id` (the party the action was made for; equal to the actor when acting personally), `reason` (nullable), `acted_at` (`now()`).

Actions: `repayment.create`, `repayment.confirm`, `repayment.reject`, `repayment.cancel`, `reversal.request`, `reversal.remind`, `reversal.acknowledge`, `reversal.decline`, `reversal.withdraw`, `reversal.override_propose`, `reversal.override_approve`, `reversal.override_refuse`, `reversal.apply`.

Member ids only, never names, user ids or e-mails. Readable by active members (D8). No write grant or policy; a trigger rejects update and delete. Every reversal step is recorded, so the complete history can be reconstructed.

**Evidence for the override is derived from these events**, not from client input, so it cannot be faked (section 14.4).

### 5.4 Relationships

```
trips 1──* repayments *──1 trip_members (from / to)
repayments 1──* repayment_reversals 1──* repayment_events
repayments 1──* repayment_events
```

Nothing is deleted. A former member's rows stay visible to remaining members, with the person shown as "(left)".

---

## 6. Balance and capacity rules

### 6.1 Balance — APPROVED

```
expense_net(m) = sum(paid) − sum(share)     over the trip's non-deleted shared expenses   (M5 formula; M1 reference)
net(m)         = expense_net(m) + confirmed_sent(m) − confirmed_received(m)

confirmed_sent(m)     = sum of amount_minor of CONFIRMED repayments with from_member_id = m
                        that have NO applied reversal
confirmed_received(m) = the same, with to_member_id = m
```

`pending`, `rejected`, `cancelled`, requested or overridden-but-unapplied reversals, declined and withdrawn reversals **never change `net`**. Over a trip, `Σ net = 0`.

### 6.2 Capacity and reservations — APPROVED (D3, D10)

```
debt(p)   = max(0, −net(p))          credit(q) = max(0, net(q))        (confirmed net)
reserved_out(p) = Σ amount of ALL pending repayments with from_member_id = p    (to anyone)
reserved_in(q)  = Σ amount of ALL pending repayments with to_member_id   = q    (from anyone)

available_out(p) = max(0, debt(p)   − reserved_out(p))
available_in(q)  = max(0, credit(q) − reserved_in(q))
capacity(p → q)  = min(available_out(p), available_in(q))
```

- Any eligible payer may repay any eligible receiver within capacity (D10).
- **At recording:** `amount ≤ capacity(p → q)`, otherwise `repayment_exceeds_outstanding` with the remaining capacity in the detail.
- **Release:** reservations are computed from pending rows; rejecting or cancelling releases them.
- **At confirmation (revalidation):** `amount ≤ debt(payer)` and `amount ≤ credit(receiver)` on the real confirmed balances now. Other pending items are not subtracted again, because confirmations serialise on the trip lock.
- **Pending items never affect official balances.** They only reserve capacity.
- **Reversal never reduces capacity.** An applied reversal raises the payer's debt and the receiver's credit by the same amount, so existing reservations stay within limits.
- All of this runs under the trip lock.

### 6.3 Worked examples (rupees; stored as paise)

**Example 1 — reservations across payers and receivers.** Ledger: A −1,000, D −500, B +1,000, C +500.
1. A records ₹600 to B (pending). `reserved_out(A) = 600`, `reserved_in(B) = 600`. No official balance moves.
2. A tries ₹500 to **C**: `available_out(A) = 400`, so capacity = min(400, 500) = 400. **Refused**, maximum 400.
3. D tries ₹500 to **B**: `available_in(B) = 400`, so capacity = min(500, 400) = 400. **Refused**, maximum 400. D records ₹400: accepted.
4. A cancels the ₹600: reservations released; `available_out(A)` is 1,000 again.

**Example 2 — confirmation revalidation.** A owes ₹1,000, B is owed ₹1,000.
1. A records ₹600 to B (pending).
2. An expense edit reduces A's debt to ₹400.
3. B tries to confirm ₹600: `600 ≤ debt(A) = 400` fails. **Refused**, the transaction rolls back, and the message gives the maximum confirmable amount (400). The record stays `pending`; no balance changed; nothing becomes negative or flips direction.
4. **Resolution:** B rejects it (D5: the receiver may reject), or A cancels it (the payer may cancel). A then records at most ₹400 if they want it counted. Partial confirmation is not offered: it would change the amount the payer claimed.

**Example 3 — partial repayment and the plan.** A −500, B −300, C +800. A records ₹300 to C; C confirms: A −200, B −300, C +500. The plan now says A pays C ₹200 and B pays C ₹300. While ₹300 was pending, the plan was unchanged and showed "₹300 awaiting C's confirmation" beside A's line.

**Example 4 — an expense changes after a confirmed repayment.** One ₹1,000 expense paid by C, shared equally by A and C: A −500, C +500. A pays ₹500 and C confirms: both 0. The expense is deleted: A is +500 and C is −500 (the plan says C pays A). Allowed and visible. If C had left meanwhile, the deletion is refused by Rule I-1.

**Example 5 — leaving with a pending item.** B's net is 0 but B has a pending repayment: leaving is refused with `repayment_pending` (section 10.1).

---

## 6.4 Exact integration with the existing functions — APPROVED (approach)

| Piece | Change |
|---|---|
| `member_net_minor(trip, member)` | Current body moves unchanged into `member_expense_net_minor(trip, member)`. New `member_repayment_adjustment_minor(trip, member)` returns `confirmed_sent − confirmed_received` over confirmed repayments with no applied reversal. `member_net_minor` is replaced with `create or replace` (same signature, return type and privileges) as the sum of the two. |
| ADR-047 trigger, `assert_member_settled`, `assert_former_members_settled` (Rule I-1), expense functions | **No change.** They call `member_net_minor` and see confirmed, unreversed repayments automatically. |
| `trip_member_balances(trip)` | Return type changes (adds `sent_minor` and `received_minor`): **dropped and recreated** with the same grants and caller checks. The app reads columns by name. |
| `repayment_capacity(trip, from, to)` | New internal function (section 6.2). |
| M6 `planSettlement` and `SettlementPlanCard` | **No algorithm change.** Input stays `net_minor`, now the confirmed, unreversed net. Pending items appear as information (checkpoint 4). |
| **New TypeScript ledger module** (checkpoint 3), for example `repaymentLedger.ts` | Pure. Takes the expense-derived balances from **M1 `computeBalances` called with no repayments**, applies the approved formula, excludes applied reversals, and returns the confirmed net and capacities. Separately tested against the expense-derived balances and the formula on shared golden vectors and random ledgers. **M1's repayment path is never called.** |
| Balances screen wording | Must say confirmed repayments are included (checkpoint 4). |

**Applied reversals and M1:** a reversal changes only the repayment adjustment. M1's expense function is not touched, and the new module's expense input is M1's own output.

---

## 7. Database functions and transaction flow

All SECURITY DEFINER, `search_path = ''`, `auth.uid()`, `authenticated` only, no anon or public access. Clients have SELECT under RLS and no write grant.

| # | Function | Purpose |
|---|---|---|
| 1 | `create_repayment(trip, id, from, to, amount, method, note)` | Records a repayment. Always `pending`. Returns `(repayment_id, version, status, created)`. |
| 2 | `confirm_repayment(trip, id, expected_version)` | `pending → confirmed`, with revalidation. |
| 3 | `reject_repayment(trip, id, expected_version, reason)` | `pending → rejected`. |
| 4 | `cancel_repayment(trip, id, expected_version)` | `pending → cancelled`, under the matrix in section 4 (D5). |
| 5 | `request_reversal(trip, reversal_id, repayment_id, reason)` | Opens a `requested` reversal of a confirmed repayment. |
| 6 | `respond_reversal(trip, reversal_id, expected_version, decision)` | `acknowledge` (→ `applied`) or `decline` (→ `declined`). |
| 7 | `withdraw_reversal(trip, reversal_id, expected_version)` | → `withdrawn` from `requested` or `override_proposed`. |
| 8 | `remind_reversal(trip, reversal_id)` | Records a `reversal.remind` event. **Requester only**, or an eligible R4a proxy acting for the requester. No state change (section 14.4). |
| 9 | `propose_override(trip, reversal_id, expected_version, category, reason)` | → `override_proposed`. **The only executable category is `counterparty_unresponsive`** (section 14.4). Any other value is refused. |
| 10 | `decide_override(trip, reversal_id, expected_version, decision, note)` | Second independent admin: `approve` (→ `applied`, `is_override = true`) or `refuse` (→ `override_refused`). **Category, evidence and proxy eligibility are re-evaluated at this moment.** |

Internal, not callable by the app: `repayment_capacity`, `repayment_actor` (who may act and why, including R1–R4 and the Participant rules), `repayment_participants` (section 14.3), `member_expense_net_minor`, `member_repayment_adjustment_minor`, and the trigger functions (state machines, reversal party check, append-only events, pending-item guard).

### 7.1 Transaction flow (every write)

1. `auth.uid()` must exist (`not_authenticated`).
2. `member_change_context(trip, uid, need_admin, allow_archived)`: caller must be an active member; **the trip row is locked first**; the archived rule applies (section 10.3).
3. Lock the repayment row, then (if any) the reversal row `FOR UPDATE`. Order: trip, repayment, reversal.
4. Preflight with coded errors: same trip, active members, the matrix (section 4), status, expected version, capacity, thresholds and evidence.
5. Write the row, bump `version`, append the `repayment_events` row(s).
6. Independent triggers enforce the final invariants (section 11).

### 7.2 Idempotent actions

`create_repayment` and `request_reversal` with an existing id compare canonical content: identical content returns the existing row (`created = false`) whatever its status now is; different content raises `repayment_id_taken` (or `reversal_id_taken`). Reminders are not idempotent by design: each is an event subject to the 24-hour rule.

### 7.3 Double actions and stale versions

The same action by the same person after it succeeded returns `changed = false` with no new event. A stale version raises `version_conflict`; an action on an item in the wrong state raises `repayment_not_pending`, `reversal_not_open` or `reversal_already_applied`. Concurrent actions serialise on the trip lock: exactly one wins.

---

## 8. Settlement plan integration

- The plan is a pure function of **confirmed, unreversed** balances. A confirmation or an applied reversal changes `net_minor`; the existing cache refresh runs; suggestions update on their own.
- **Pending and requested items are information, never deductions.** A suggestion can show "(₹300 awaiting Ravi's confirmation)"; the personal line can show "You have ₹300 waiting for Ravi to confirm". An open reversal request can show "A correction is requested for a ₹500 payment". The plan never reads these rows.
- Recording is always an explicit action and only ever creates `pending`.

---

## 9. UPI — DEFERRED (D7)

No UPI link, deep link, payment-app integration, migration #13 or function exposing a member's UPI id. `profiles.upi_id` keeps its owner-only visibility. If a handoff is approved later, it must never create or confirm a repayment, and any widening of UPI id visibility needs its own design and approval.

---

## 10. Member lifecycle and archived trips

### 10.1 Pending repayments and leaving or removal — APPROVED (D5)

**Resolution order (approved):**
1. **The payer may cancel their own pending repayment.**
2. **The receiver may reject a pending repayment.**
3. **Guest repayments** follow the strict admin proxy rules R1–R3 (section 3.4). An admin acts only as an eligible proxy for a guest party.
4. **Admins cannot unilaterally cancel pending repayments involving ordinary signed-in members.** No admin path exists for them.
5. **Leaving or removal** (`leave_trip`, `remove_member`) is possible only when (a) no pending repayment has the member as payer or receiver, (b) no open reversal request involves the member, and (c) the ADR-047 balance requirement is satisfied (net exactly zero).
6. **Unreachable participants:** nothing expires automatically and nothing is fabricated. The item stays pending, and the member cannot leave or be removed until a permitted person acts. For a pending repayment between two unreachable signed-in members, neither party can act and no admin can cancel it: the item stays and blocks leaving. This is accepted (section 19, item 1) and is the price of the "no admin unilateral cancel" rule. For open reversal requests, section 14.4 gives the only exceptional route, and it never applies to pending repayments.

The check is a new trigger on `trip_members` (`repayment_pending`), placed beside the ADR-047 trigger; existing functions are not rewritten.

**History is preserved after leaving:** rows are never deleted; remaining members see them with the person shown as "(left)". Rule I-1 keeps the former member's net at zero, so no applied reversal or confirmed repayment can leave them non-zero.

### 10.2 Other members

| Situation | Rule |
|---|---|
| Guest | Cannot act; admin proxies under R1–R4. A guest who later claims the spot keeps the member row, so repayments and balance carry over. |
| Former member | Cannot act; history stays; no new access (D8). |
| Account deleted | Member row detached and shown as a named placeholder; repayments untouched. Whether that state is identifiable is an implementation check (section 14.4). |
| Expense edit, delete, restore | Unchanged. Rule I-1 refuses changes that leave a former member non-zero. Pending items are revalidated at confirmation. |

### 10.3 Archived trips — APPROVED (D4; refines ADR-043(b))

- **Refused on archived trips (`trip_archived`):** recording a repayment, requesting a reversal, reminding, proposing an override.
- **Still allowed for already open items:** confirm, reject, cancel a pending repayment; acknowledge, decline, withdraw a reversal request; approve or refuse an override already proposed.
- Expenses stay refused entirely, as in M5.
- Implementation: `member_change_context(..., allow_archived => true)` for resolution functions; an explicit archived check inside `create_repayment`, `request_reversal`, `remind_reversal` and `propose_override`.

---

## 11. Security

- **Functions:** SECURITY DEFINER, `search_path = ''`, identity only from `auth.uid()`, `authenticated` only, helpers revoked from everyone. Security-audit allow-lists and the live probe name the new functions.
- **RLS:** `repayments`, `repayment_reversals` and `repayment_events` are readable by active members (D8); no INSERT, UPDATE or DELETE grant or policy; revoked from `anon` and `public`.
- **Two layers:** functions preflight with coded errors; triggers enforce legal transitions, consistent decision columns, the reversal uniqueness rules, the Participant rule for appliers and approvers, both members in the trip, the pending-item rule for leaving and removal, and append-only events. Direct SQL outside the functions is a documented residual, as in M5.
- **Locking:** trip row, then repayment, then reversal; helpers and triggers only read.
- **Clocks:** every timestamp that matters (`requested_at`, `override_proposed_at`, reminder times, `acted_at`) is set by `now()` inside the database. No client time is trusted.
- **Four-eyes:** an override needs a second, independent admin (section 14.3); the function and a trigger both check it.
- **No secret keys** and no service role in any client.
- **Privacy:** rows and events carry member ids only; names come from the trip's members. `note`, `reason`, `decision_note` and `override_reason` are plain text, shown escaped; the screens warn against private content (D14).
- **Abuse:** text is length-limited. **ADR-054 rate limiting is not implemented and is not part of M7; it remains mandatory before public deployment.** Reminders are limited to one per 24 hours per request.
- **Money:** integer paise, safe-integer checks, `bigint` arithmetic. No floating point.

### Error codes

`not_authenticated`, `trip_not_found`, `not_allowed`, `trip_archived`, `repayment_not_found`, `repayment_id_taken`, `reversal_id_taken`, `invalid_repayment`, `member_not_active`, `repayment_exceeds_outstanding` (capacity in the detail), `repayment_not_pending`, `version_conflict`, `repayment_pending` (leaving or removal blocked by a pending repayment or open reversal), `reversal_not_allowed`, `reversal_not_open`, `reversal_already_open`, `reversal_already_applied`, `reversal_reason_required`, `reminder_too_soon`, `override_not_eligible`, `override_threshold_not_met` (14 days not reached), `override_evidence_missing` (reminder evidence incomplete), `override_requires_second_admin`, `override_proposer_cannot_approve`, `party_cannot_act`, plus the existing `balance_not_settled` and `former_member_balance`.

---

## 12. Notifications — APPROVED (D9)

In-app only: a **"Payments to confirm"** list and a **count badge** on the trip, listing pending repayments addressed to the signed-in person (as receiver, or as payer for cancellation) and open reversal requests waiting for them. Refreshed on screen focus and by the existing cache rules. Push notifications are **DEFERRED**.

---

## 13. Migration #12 — exact contents — APPROVED (reversal tables included)

One forward-only migration, **#12 `20261126000000_repayments.sql`**, never editing #1 to #11. Depends on #2 (`is_trip_member`), #4 (`member_change_context`), #8 (`member_net_minor`, expense helpers) and #11 (current balances).

It contains, in dependency order:
1. **Tables:** `repayments`, `repayment_reversals` (with `requested_by`, `requested_for`), `repayment_events` (with `represented_member_id`) — columns, constraints, partial unique indexes, indexes, comments. `repayment_reversals.override_category` is checked against **`counterparty_unresponsive` only**.
2. **RLS:** SELECT for active members only; all write privileges revoked from `anon`, `public` and `authenticated`.
3. **Internal helpers:** `repayment_participants`, `repayment_actor`, `repayment_capacity`, `member_expense_net_minor` (the current net body, moved unchanged), `member_repayment_adjustment_minor`.
4. **`create or replace member_net_minor`** (same signature, return type and privileges), as the sum of the two helpers.
5. **Triggers:** state machine on `repayments`; reversal state machine; the **Participant rule** for appliers and approvers; **`requested_for` immutability and party check**; the **actor / represented-participant consistency check** (an ordinary actor must equal the represented participant; a proxy must be an eligible admin for that guest); append-only on `repayment_events`; the pending-item guard on `trip_members`.
6. **Ten public functions** (section 7, items 1–10), each granted to `authenticated` only.
7. **`drop` and recreate `trip_member_balances`** with `sent_minor` and `received_minor` (same grants and caller checks).

**Why reversals are in #12 (approved):** the balance function must exclude applied reversals from the start. Splitting them would mean rewriting the balance function twice and leaving a window where the official balance could not be corrected.

Run by you in the SQL Editor, safe to re-run, as for earlier migrations. No migration #13 (UPI deferred). M1 (`balances.ts`) is not in this migration and not changed.

---

## 14. Correction of confirmed repayments — APPROVED: Option B

### 14.1 Principles (approved)

- The original confirmed repayment is **preserved permanently**; no edit, no delete; its status stays `confirmed`.
- Every step is recorded: initiator, reason, timestamps, each state change and the actor of each.
- **Normal reversal requires the counterparty's acknowledgement.**
- **The admin override is for exceptional cases only**, never an ordinary disagreement.
- **An admin cannot override a repayment in which they took part** (the Participant rule).
- **A second, independent admin must approve** any override.
- **Single-admin fallback (approved):** if no second independent admin exists, the override remains pending; **no balance change is permitted**; **one admin never approves their own proposal.**
- Reversal preserves Rule I-1, ADR-047, the archived-trip rules and every balance invariant.

### 14.2 Normal reversal (two parties)

1. **Request** (`request_reversal`): an ordinary party acting personally, or an eligible admin under **R4a** for a guest party. Records `requested_by` (the authenticated actor) and `requested_for` (the represented party). Reason 1–200 characters. Requires the repayment to be `confirmed`, unreversed, and the trip not archived. Status `requested`; `requested_at = now()`.
2. **Acknowledge** (`respond_reversal(acknowledge)`): the counterparty acting personally, or an eligible admin under **R4b** for a guest counterparty. Allowed from `requested` and from `override_proposed`. Status `applied`, `is_override = false`. The repayment stops counting.
3. **Decline** (`respond_reversal(decline)`): the same people. Status `declined`; nothing changes; a new request may be opened later.
4. **Remind** (`remind_reversal`): the requester, or an eligible R4a proxy acting for the requester; section 14.4.
5. **Withdraw** (`withdraw_reversal`): the requester, from `requested` or `override_proposed`. Status `withdrawn`; nothing changes.

At most one open request per repayment at a time; at most one applied reversal per repayment, ever. Every step records the authenticated actor and the represented participant.

### 14.3 Participants and the second independent admin — APPROVED

**Participants of a repayment R** are every member who appears in R's history or its reversals' history in any role: the payer, the receiver, the recorder (`created_by`), `requested_by`, `requested_for`, any acknowledger, decliner or withdrawer, the override proposer, and any second admin who acted. The set is computed from `repayment_events` and the reversal rows, so it cannot be manipulated.

- **Override proposer P:** an active admin who is **not a Participant** of R at the time of the proposal.
- **Second independent admin S:** an active admin who is **not a Participant** of R, **not P**, and has taken no action on R's reversal.
- **Approval rule:** `decide_override` rejects S when S is a Participant or S = P (`override_proposer_cannot_approve`), when S is not an active admin (`override_requires_second_admin`), and when the category no longer holds at that moment (`override_not_eligible`).

### 14.4 Override categories, the 14-day clock and the evidence — APPROVED (categories, 14 days, and the clarification of 2026-11-26)

The approved category list has **two** entries. For migration #12, **only one is executable**:

| Category | Status | Executable in migration #12? |
|---|---|---|
| `counterparty_unresponsive` | APPROVED | **Yes: the only executable override reason.** |
| `counterparty_account_inaccessible` | APPROVED as a concept; **DEFERRED (V1)** | **No.** Not in the executable reason constraint; no authorization code; no tests for a successful path. |

**Why it is deferred (V1, approved 2026-11-26):** a valid override proposer must not be a Participant, and any such admin is an eligible D6 proxy (R4b), which forbids the override. The category therefore cannot succeed under the approved rules. It is not weakened, and no deletion marker is added. `user_id IS NULL` alone is never treated as proof of account deletion (a member may simply be a guest). Reaching this category would need a separately approved design change and a forward migration.

Ordinary disagreements ("I never received it", "the amount is wrong") are never eligible for any override; they stay as open requests until acknowledged, declined or withdrawn.

#### `counterparty_account_inaccessible` — deferred, non-executable (reference only)

> The repayment counterparty has no linked account (`trip_members.user_id IS NULL`) and no admin is eligible to act as their proxy under D6 at the time the override is proposed.

Recorded for the record; not implemented.

#### `counterparty_unresponsive` — approved, unchanged

The counterparty **has a linked account** (`user_id IS NOT NULL`). For a counterparty with no account the proxy route applies instead, which is what condition 2 above requires; this category is not available for them.

- **The clock** starts at `requested_at` (set by `now()` when the request is made); the threshold is **14 full days**.
- **Evidence**, all checked by the database from `repayment_events` at proposal time and again at approval:
  1. `now() ≥ requested_at + 14 days`.
  2. The reversal is still open (`requested` or `override_proposed`) and the counterparty has taken no action of any kind.
  3. **Documented unresponsiveness:** at least **two** `reversal.remind` events for this request, the **first on or after `requested_at + 7 days`**, the **second at least 24 hours after the first**, both on or before the proposal time.
- **Reminder rule:** the requester (`requested_by`), or an eligible R4a proxy acting for the requester; at most one reminder per 24 hours per request (`reminder_too_soon` otherwise); reminders change no state and expire nothing.
- Missing time: `override_threshold_not_met`; missing reminders: `override_evidence_missing`.

#### What no override can do (approved)

It never fabricates a settlement, creates a repayment, changes an amount, or bypasses Rule I-1, ADR-047, the archived-trip rule or the proxy process. An applied override has the same effect as an applied acknowledgement (the repayment stops counting; the payer's debt and the receiver's credit rise by the same amount).

Lifecycle: `requested` → `override_proposed` (by admin P: category, reason of at least 20 characters, evidence) → `applied` (by admin S, `is_override = true`) or `override_refused` (by S). Nothing expires.

### 14.5 Single-admin fallback — APPROVED

- If no second independent admin exists, the override **remains `override_proposed`**. **No balance change is permitted.** The repayment keeps counting. The trip shows "A correction is awaiting a second admin".
- **One admin never approves their own proposal** (enforced by the function and a trigger).
- To progress, the trip can promote another account member to admin through the existing function; that admin can then approve as the second independent admin, **provided the category still holds when they approve** (section 14.4 condition 4).
- The normal route stays open: the counterparty (or an eligible proxy) can acknowledge or decline at any time, and the requester can withdraw.

### 14.6 Interactions

- **Rule I-1:** a reversal that would leave a **former** member non-zero is refused (`former_member_balance`). A mistake involving someone who has left cannot be corrected in the app (inherent in Rule I-1).
- **ADR-047:** an applied reversal can make a member non-zero; if that member is leaving, the ADR-047 check refuses. Acceptable: no one may leave non-zero.
- **Pending capacity:** unaffected (section 6.2).
- **Settlement plan:** recomputed automatically from the new confirmed, unreversed balances.
- **History:** the original repayment, all events and every reversal step are kept permanently.

### 14.7 Numerical examples

**Normal reversal.** A −500, B +500. A records ₹500, B confirms: both 0. In fact A had paid ₹50. B requests a reversal ("only ₹50 received"). A acknowledges: the ₹500 stops counting; A is −500, B is +500 again; the plan says A pays B ₹500. A then records ₹50; B confirms: A −450, B +450. History: the original ₹500, the request (B, reason, time), the acknowledgement (A), the later ₹50.

**Override by unresponsiveness.** Day 0: B requests a reversal. Day 7 (on or after): the requester (B, or an admin acting for B under R4a if B is a guest) sends reminder 1. Day 8: reminder 2 is at least 24 hours after reminder 1. Day 14: admin X (not a Participant) proposes `counterparty_unresponsive` with a 20-character reason; evidence is checked; status `override_proposed`. Admin Y (not a Participant, not X) approves: `applied`, `is_override = true`. If Y does not exist, nothing is applied and the repayment keeps counting.

**Override by inaccessibility (deferred, not executable, V1).** For a guest counterparty with no eligible proxy, no override can be proposed in M7, and no admin can acknowledge. The reversal request stays open until a second admin exists to act as proxy, or the requester withdraws. See section 14.4 and section 20.4.

---

## 15. Implementation checkpoints — PROPOSED (sequence approved)

| # | Checkpoint | Scope | Database change | Depends on |
|---|---|---|---|---|
| 2 | **Database** | Migration #12 exactly as section 13: three tables; state and reversal machines; helpers; `member_net_minor` split; `trip_member_balances` recreated; the pending-item guard; ten functions; **only `counterparty_unresponsive` executable as an override category**; RLS and privileges; security-audit allow-lists and live probe additions; database tests (section 16); mutation checks. **No application code.** | Yes (#12; you apply it in the SQL Editor) | Your authorization |
| 3 | **Core ledger and services** | New pure `repaymentLedger` module, tests against M1 expense balances and the formula on shared golden vectors and random ledgers; coded-error mapping to fixed sentences; services and hooks; cache invalidation. **No screens.** | No | After #2 |
| 4 | **Screens** | Record "I paid" (capacity shown), "Payments to confirm" list and badge, confirm, reject, cancel, reversal request, acknowledge, decline, withdraw, remind, override propose and approve screens, repayment history per trip, pending information beside the plan, balances wording. No UPI. | No | After #3 |
| 5 | **Browser and regression** | Focused browser scenarios per screen (desktop, 360 px phone, dark): every state, capacity refusals, revalidation failure, archived trip, reminder spacing, the single-admin fallback, the Participant block; re-run affected expense, member and settlement scenarios. | No | After #4 |
| 6 | **Close-out** | Security review against this document, live steps for you (SQL Editor and a two-session race check), documentation and progress record. | No | After #5 |

---

## 16. Testing strategy

- **Database (PGlite):** every legal and illegal transition for repayments and reversals; the matrix (payer, receiver, admin, guest proxies R1–R4, former member, stranger, signed-out); the D5 resolution order (payer cancel, receiver reject, admin cannot cancel signed-in items, admin cancel only under R3 for guests); the Participant rule and the four-eyes rule; the 14-day clock (using controlled database time), reminder count, 24-hour spacing, the 7-day first-reminder rule and evidence failure modes; both override categories; the single-admin fallback (nothing applied); capacity scenarios of section 6.3; revalidation at confirmation; balance parity (`member_expense_net_minor` equals the M5 and M1 expense result; the new net equals the formula on random ledgers with repayments and reversals; `Σ net = 0`); ADR-047 and Rule I-1 with confirmed and reversed repayments; `repayment_pending` for pending repayments and open reversals; archived behaviour; privileges and RLS; events carry no user ids and reject update and delete; the original repayment is unchanged after every reversal path; mutation checks on the migration, as in M5.
- **Concurrency and duplicates:** idempotent create and request, double confirm, confirm after cancel, cancel after confirm, stale versions, acknowledgement racing a withdrawal. **Honest limit:** PGlite runs one session; true races cannot be produced. Tests interleave calls in every order and lock order is checked by review and mutation. A real two-session check is a manual step in checkpoint 6, which I will describe rather than run.
- **Core ledger module:** tested against M1 expense balances (`computeBalances` with no repayments) and the formula, with shared golden vectors and random ledgers.
- **App:** service and hook tests (error mapping, retries, cache keys).
- **Browser:** per screen checkpoint, as in section 15.

---

## 17. Complete decision table — final status (D1–D14)

Each entry gives the question and recommendation exactly as written in revision 1, the final decision, and the status. "Blocks CP2" is now **No** for every entry: all decisions are settled.

| # | Decision (rev. 1 question) | Rev. 1 recommendation | **Final status** | Final decision and consequences |
|---|---|---|---|---|
| **D1** | States: four (`pending`, `confirmed`, `rejected`, `cancelled`) or keep ADR-010's five (`pending`, `paid`, `confirmed`, `cancelled` plus a rejected one) and its projected balance? | Four. Only confirmed counts; no projected figure. | **APPROVED** | Four states; only pending transitions; UPI never creates or confirms a repayment. Affects schema and balance function. |
| **D2** | May the receiver record a repayment created already confirmed (cash received)? | Yes. | **APPROVED** (opposite to recommendation) | No. Payer records; receiver confirms or rejects. Affects permissions. |
| **D3** | Refuse overpayment, with reservations, replacing Q-16? | Yes, refuse. | **APPROVED** | Refused. Pending repayments reserve capacity globally per payer and per receiver; released on reject or cancel; rechecked at confirmation. |
| **D4** | Archived trips: refuse everything (ADR-043 literally) or refuse only creating? | Refuse creating only. | **APPROVED** | Creating, reminding, requesting and proposing refused; open items resolvable. Refines ADR-043(b). |
| **D5** | Leaving or removal while a repayment is pending: refuse or auto-cancel? | Refuse (`repayment_pending`). | **APPROVED**, including the resolution order | Refuse. Order: payer cancels own; receiver rejects; guests under R1–R3; admins cannot cancel signed-in items; leaving only when nothing is pending or open and ADR-047 is satisfied; no automatic expiry or fabrication. |
| **D6** | Guests: admin proxy; an admin may not confirm their own payment; a guest receiver needs a different admin. OK? | Yes, with that rule. | **APPROVED** (strict) | Strict R1–R4; nobody confirms their own payment; nobody records and decides the same repayment. |
| **D7** | Show a receiver's UPI id to trip members for the handoff? Include the handoff at all? | Optional, last, only with explicit approval. | **DEFERRED** | No UPI in M7; no migration #13; no exposure. |
| **D8** | Who may read repayments: every active member or only the parties and admins? | Every active member. | **APPROVED** | Every active member reads repayments, reversals and events; former members get no new access. |
| **D9** | Notifications: in-app list and badge only in M7, push later? | Yes. | **APPROVED** | In-app list and badge only. Push deferred. |
| **D10** | May anyone repay anyone within capacity, or only the plan's pairs? | Anyone within capacity. | **APPROVED** | Any eligible payer may repay any eligible receiver within capacity. |
| **D11** | Drop `from_suggestion`, and keep proof attachments out of M7? | Yes to both. | **APPROVED** | Both dropped from M7. |
| **D12** | No automatic expiry of old pending repayments? | No expiry. | **APPROVED** | No automatic expiry for any item. The 14-day threshold is an eligibility clock for an override, not an expiry. |
| **D13** | How is a mistaken confirmed repayment undone? (a) final, documented workaround; (b) admin "void" with reason. | (a) for M7; revisit (b). | **APPROVED: Option B** (your instruction superseded the recommendation) | Two-party acknowledged reversal; restricted two-admin override in two categories, 14-day clock with reminder evidence; Participant rule; four-eyes; single-admin fallback with no balance change; reversal tables in migration #12. |
| **D14** | Free-text `note`: allow, and warn against private content? | Allow, with a warning. | **APPROVED** | Optional, 200 characters, with a warning against private content. |

### Summary

| Status | Decisions |
|---|---|
| **APPROVED** | D1, D2, D3, D4, D5, D6, D8, D9, D10, D11, D12, D13, D14 (13 decisions) |
| **DEFERRED** | D7 (UPI handoff and UPI id visibility). Push notifications (part of D9). |
| **Open decisions** | None. |
| **Still blocking Checkpoint 2** | None. Implementation checks in section 20 remain to be verified while building. |

---

## 18. Contradictions with existing ADRs and documents — final classification

| # | Existing text | Final classification | Resolution |
|---|---|---|---|
| 1 | **ADR-010**: states `pending → paid → confirmed` (+ `cancelled`); exposes `net_confirmed` and `net_projected` | **Superseded** | `paid` and the projected figure are removed; `rejected` added (D1). ADR-010's text is not edited; ADR-066 governs once approved. |
| 2 | **Q-3**: "Paid" repayments count toward balances | **Superseded** | Only confirmed, unreversed repayments count. |
| 3 | **Q-16**: allow a repayment larger than the debt, with a warning | **Superseded** | Overpayment refused (D3). |
| 4 | **ADR-043(b)**: expenses and repayments MUST be refused on archived trips | **Refined** | Creating, reminding, requesting and proposing refused; resolving open items allowed (D4). ADR-043 text not edited. |
| 5 | **ADR-047**: refuse non-zero balance "until it is settled or an admin records an explicit settlement" | **Refined, with the limitation ACCEPTED** | "Explicit settlement" means a confirmed, unreversed repayment only. An admin cannot record or confirm a settlement for an account holder. An unreachable account holder with a non-zero balance cannot be removed through an admin override (approved, item 5 of your decision list). |
| 6 | ADR-047 wording "(confirmed or projected)" | **Superseded** | Confirmed net only, plus the pending-item rule (D5). |
| 7 | **M1 `computeBalances`** repayment path (`LedgerRepayment`, `paid`, projected figure, `balances.ts` lines 39–152) | **Preserved** (unchanged and unused by M7); its M7-facing semantics are **superseded** | Kept as-is, not removed or refactored. Any future cleanup needs your separate approval (decision 7). M7 uses a separate, separately tested module. |
| 8 | `DATABASE_SCHEMA.md` 4.10, section 5 (`net_projected`), section 9.4 ("M7 extends the same function ... projected figure") | **Superseded** | Marked with notes; rewritten when migration #12 is built. |
| 9 | Balances screen note "Each balance adds up every expense: what a person paid, minus their share" | **Refined** | Wording changed at checkpoint 4 to include confirmed repayments. |
| 10 | M6 / ADR-065: the plan uses `net_minor` | **Preserved** | `net_minor` becomes the confirmed, unreversed net; the plan stays confirmed-only. No change to M6. |

---

## 19. Resolved items (formerly "still needed")

| # | Item | Resolution |
|---|---|---|
| 1 | 14-day override threshold | **Approved**: 14 days of documented counterparty unresponsiveness, with the evidence in section 14.4. |
| 2 | Override categories | **Approved exactly**: `counterparty_account_inaccessible`, `counterparty_unresponsive`. |
| 3 | Single-admin fallback | **Approved**: the override stays pending; no balance change; one admin never approves their own proposal (section 14.5). |
| 4 | Reversal tables in migration #12 | **Approved**: included. |
| 5 | ADR-047 limitation | **Approved**: an unreachable account holder with a non-zero outstanding balance cannot be removed through an admin override. No admin may fabricate settlement or bypass the financial invariant. |
| 6 | D5 resolution order | **Approved** (section 10.1). |
| 7 | M1 legacy path | **Approved**: unchanged and unused by M7; no refactoring or deletion without separate approval. |
| 8 | ADR-066 overall | **Approved** as the architecture, subject to the consistency review in section 20. |

---

## 20. Consistency review (revision 4)

Checked across `M7_REPAYMENTS_DESIGN.md`, `ARCHITECTURE_DECISIONS_LOG.md`, `DEVELOPMENT_PROGRESS.md`, `DATABASE_SCHEMA.md`, `API_DESIGN.md` and `SECURITY_ARCHITECTURE.md`.

### 20.1 Problems found and fixed in this revision

| # | Problem | Fix |
|---|---|---|
| 1 | Revision 3 let an **admin cancel any pending repayment** (matrix, R3 and the "fallback" in section 10.1), which contradicts the approved D5 rule that admins cannot unilaterally cancel items between ordinary members. | R3 now applies only to pending repayments with a guest party, and only for an admin who is an eligible proxy under R1 or R2. Section 4 and section 10.1 updated. |
| 2 | The 14-day clock had **no start point**, no reminders and no evidence, so "documented unresponsiveness" could not be proven. | Clock starts at `requested_at` set by `now()`. Evidence is derived from `reversal.remind` events (two, spaced 24 hours apart, the first on or after day 7) and the still-`requested` state. |
| 3 | "Independent admin" was **undefined**, and reminder senders could otherwise propose or approve. | Participant set defined from the events (section 14.3); proposer and approver must not be Participants; the approver must not be the proposer. |
| 4 | **Reminders were needed but had no function**, so the function set was incomplete. | `remind_reversal` added. The function count is **ten** (sections 7, 13, 15 updated). |
| 5 | **API_DESIGN.md** and **DATABASE_SCHEMA.md** notes still described the earlier function set and open decisions. | Updated to the final function set and status (see the files below). |
| 6 | **SECURITY_ARCHITECTURE.md** note still described the UPI and capacity points as open. | Updated. |
| 7 | **Archived trips**: reminders were not covered. | Reminders refused on archived trips (section 10.3). |

### 20.2 Checked and consistent

- **D5 and D13 do not contradict each other**: pending items are resolved only by their parties (or R2/R3 proxies for guests); reversals only by the counterparty, the requester, or a second independent admin on an override. No admin resolves a signed-in item alone.
- **Second admin independence:** Participant rule and proposer rule are both enforced in the function and a trigger.
- **Reversal preserves the original and its history:** the repayment row is never updated by a reversal; every step is an event; the applied reversal is a separate row.
- **Applied reversals affect the ledger correctly without changing M1:** the adjustment helper excludes applied reversals; `Σ net = 0` holds; M1's expense function is not touched and its output is the new module's input.
- **Pending repayments reserve capacity and never affect official balances:** `net` excludes them; capacity uses them.
- **Migration #12** contains: tables, RLS, helpers, `member_net_minor` split, the three triggers plus the pending-item guard, ten functions, `trip_member_balances` recreation. Nothing required by the approved design is outside it.
- **Ten contradictions** are classified in section 18 and match the ADR log.

### 20.3 Implementation checks (results)

- **Deleted-account marker (investigated 2026-11-26): none exists.** There is no account-deletion function or flow anywhere. `profiles.deleted_at` exists but nothing writes it, and the documented design (anonymise the profile and detach `trip_members.user_id`) would leave the member with `user_id IS NULL`, indistinguishable from a guest and no longer linked to the profile. **Resolved by your clarification:** the category uses `user_id IS NULL` plus the absence of an eligible proxy; no deletion marker is added or inferred (section 14.4).
- **Membership status writers (investigated): no design change.** Only `remove_member` (to `removed`) and `leave_trip` (to `left`) move a member from active to inactive. The old invite flow and `decide_join_request` only reactivate. The pending-item guard is an `active → non-active` trigger on `trip_members`, so it covers every path, including direct SQL, and only reads (lock order preserved).
- **Balance function callers (investigated): no design change.** SQL callers of `member_net_minor` are `assert_member_settled`, `assert_former_members_settled` and `trip_member_balances`. Consumers of `trip_member_balances` read columns by name, so the added columns are harmless; only the security-audit and three `trip-*` allow-lists need the ten new function names.

### 20.4 Finding of the revision 4.1 review — RESOLVED (V1 approved 2026-11-26)

`counterparty_account_inaccessible` cannot be satisfied under the approved D6 and D13 rules (any valid override proposer is an eligible proxy, which forbids the override). **V1 approved:** the category is kept as an approved concept, **deferred from migration #12**, **unreachable under the current rules**, and **not an executable override reason** in M7. The D6 proxy rules and D13 proposer independence are not weakened.

**Remaining ambiguity (not decided, flagged for you):** a reversal request on a repayment whose **guest counterparty has no eligible proxy admin** has no executable route. The counterparty cannot acknowledge, no admin may act for them, and `counterparty_unresponsive` applies only to account holders. The request stays open; the requester may withdraw; nothing expires and nothing is changed. The likely cases are a trip with one admin who is a party to the repayment, or a trip with no second admin. The fix is to promote another member to admin. If you want a different route, it needs a separate decision.

### 20.5 Recheck of D13 and D6 against the clarification

| Rule | Result |
|---|---|
| D6 R1 (recording for a guest payer), R2 (deciding for a guest receiver), R3 (cancelling guest repayments) | Consistent; unchanged. |
| D6 R4 as written in revision 4 | **Fixed.** It listed "remind" for a guest counterparty (meaningless) and did not name the requesting side. Split into **R4a** (an admin acting for a guest party when requesting, reminding or withdrawing) and **R4b** (an admin answering for a guest counterparty, with the "never on both sides" rule). |
| Counterparty of a proxy-made request | **Fixed.** Added the `requested_for` column to `repayment_reversals` so the counterparty is always known. This is a small addition to migration #12's schema, needed for D6 to be enforceable. |
| Normal route while an override is proposed | **Fixed.** The diagram and matrix now allow acknowledge and decline from `override_proposed` (revision 4 allowed them only in prose). |
| Reminders | **Fixed.** Only the requester (`requested_by`) may remind. |
| Override evaluated at proposal and at approval (condition 4) | Added to `propose_override`, `decide_override` and the matrix. |
| `counterparty_unresponsive` for guest counterparties | Not available (the proxy route applies); this follows from condition 2. |
| D13 principles (original preserved, every step recorded, acknowledgement required, exceptional-only override, no participant override, second independent admin, fallback, Rule I-1, ADR-047, archived-trip rules, balance invariants) | Consistent. |
| D5 and D13 together | Consistent (section 4). |
| `counterparty_account_inaccessible` reachability | **DEFERRED (V1)**: approved concept, not executable in M7 (section 14.4). |

---

## 21. Files changed for revision 4.1

- `docs/M7_REPAYMENTS_DESIGN.md` (this file): sections 3.3, 3.4, 4, 5.2, 7, 14.2 to 14.5, 14.7, 20.3 to 20.5.
- `docs/ARCHITECTURE_DECISIONS_LOG.md` (ADR-066 wording and the open item).
- `docs/DEVELOPMENT_PROGRESS.md` (M7 status and implementation checks).
- `docs/API_DESIGN.md` and `docs/SECURITY_ARCHITECTURE.md` (override eligibility re-evaluation).

Nothing else changed. No code, tests, migrations, database functions or live Supabase changes. No commits or pushes. Checkpoint 2 has not started.


---

## 22. Checkpoint 2 implementation notes (built and tested locally; migration #12 NOT applied live)

The database part of this design is implemented in `supabase/migrations/20261126000000_repayments.sql`. Everything in sections 3 to 14 is implemented as written. The differences and additions below are the only places where the build differs from, or adds to, the design text. None changes an approved decision.

| # | Difference or addition | Why |
|---|---|---|
| 1 | `request_reversal` has a fifth, optional parameter `p_requested_for` (null means "myself"). | R4a needs the represented participant to be named when an admin requests for a guest; this is the approved `requested_for`. |
| 2 | New error codes beyond section 11: `reversal_not_found`, `reversal_id_taken`, `repayment_transition_invalid`, `reversal_transition_invalid`. The code `override_requires_second_admin` is **not** used: a caller who is not an admin gets the existing `not_admin`, and the absence of a second independent admin is simply the absence of anyone who can approve. | The table triggers need their own codes, and an unknown reversal needs a clear answer. |
| 3 | An audit-consistency trigger on `repayment_events`: an ordinary actor must equal the represented participant; only an active admin may differ, and only for a guest. | A third independent layer under R1 to R4b (it is why the single-layer mutation of R2 still failed to let an admin confirm for a signed-in receiver). |
| 4 | An applied reversal writes two events (`reversal.acknowledge` or `reversal.override_approve`, then `reversal.apply`). | Records both the decision and the ledger effect, as listed in section 5.3. |
| 5 | `created_at`, `decided_at`, `requested_at`, `override_proposed_at` and every event's `acted_at` are set by the database's clock in triggers. | A caller can never supply a time. |
| 6 | The pending guard trigger is named `trip_members_a_repayment_pending_guard` so it fires before the ADR-047 balance guard and the clearer reason (`repayment_pending`) is reported first. | Both guards still run on every path. |
| 7 | The test "a proxy who becomes eligible between the override proposal and the approval blocks the override" is **not applicable under V1**: only an account-holder counterparty can be overridden, and the proxy route never applies to one. It is replaced by an approval-time re-evaluation test (the counterparty stops being an account holder, simulated as owner; approval is refused with `override_not_eligible`). | `counterparty_account_inaccessible` is deferred. |
| 8 | `decide_override` with `refuse` does not re-evaluate the evidence (only approval does). | A refusal changes no balance. |

**Verification:** 65 new database tests; the full database suite (540 tests) passes; 26 mutation checks of the critical rules are all caught; the live probe reports 0 failures and 17 warnings (all "not applied yet"). **Not yet done:** applying migration #12 live (you do this, Step 17 of `SUPABASE_SETUP.md`), Checkpoints 3 to 6, and a real two-session race check.
