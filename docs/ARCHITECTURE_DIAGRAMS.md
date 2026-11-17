# TripMate — Architecture Diagrams

Status: **Proposed (v0.1).** All diagrams use Mermaid (rendered by GitHub and the VS Code Markdown preview with a Mermaid extension). They show the design in [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md). The ERD is in [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).

Note: these were written by hand and have not yet been rendered in a Mermaid viewer. Preview them once and report any rendering errors.

---

## 1. High-level system architecture

```mermaid
flowchart LR
    subgraph Clients["Clients - one universal codebase"]
        M["Mobile app<br/>iOS / Android"]
        W["Website<br/>desktop / tablet / phone"]
    end

    CORE["packages/core<br/>money, splits, settlement, schemas<br/>shared code"]

    subgraph Backend["Supabase"]
        AUTH["Auth"]
        API["REST API<br/>Edge Function"]
        DB[("PostgreSQL<br/>RLS + constraints")]
        RT["Realtime"]
        ST["Storage<br/>private buckets"]
    end

    subgraph External["External services"]
        UPI["UPI apps<br/>deep link only"]
        PUSH["Expo Push<br/>post-MVP"]
        MAPS["Maps<br/>later"]
        OCR["OCR / vision<br/>later"]
        AI["Claude API<br/>later, read-only"]
        SENTRY["Sentry"]
    end

    M --> AUTH
    W --> AUTH
    M --> API
    W --> API
    M -. "direct reads, RLS" .-> DB
    W -. "direct reads, RLS" .-> DB
    API --> DB
    API --> ST
    DB --> RT
    RT -. "change events" .-> M
    RT -. "change events" .-> W
    M --> UPI
    API -.-> PUSH
    API -.-> OCR
    API -.-> AI
    M --> SENTRY
    W --> SENTRY
    API --> SENTRY
    CORE -. "imported by" .-> M
    CORE -. "imported by" .-> W
    CORE -. "imported by" .-> API
```

---

## 2. Frontend, backend and database communication

```mermaid
flowchart TB
    UI["UI screens<br/>Expo Router"] --> RQ["TanStack Query<br/>cache + invalidation"]
    UI --> FORM["React Hook Form<br/>+ Zod from core"]
    FORM --> PREVIEW["core.allocate<br/>instant share preview"]
    RQ --> READ["Direct reads<br/>lists, feed"]
    RQ --> WRITE["API client<br/>writes + computed reads"]

    READ -->|"JWT + RLS"| PGREST["PostgREST"]
    WRITE -->|"JWT"| HONO["Hono API"]

    HONO --> MW["Middleware<br/>request id, rate limit,<br/>JWT, authorization"]
    MW --> VAL["Zod validation"]
    VAL --> LOGIC["Business logic<br/>core.allocate, core.settle"]
    LOGIC --> FN["Postgres write function<br/>one transaction"]

    PGREST --> DB[("PostgreSQL")]
    FN --> DB
    DB -->|"commit-time<br/>sum constraints"| DB
    DB --> RT["Realtime"]
    RT -->|"invalidate queries"| RQ
```

---

## 3. Authentication flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client app
    participant A as Supabase Auth
    participant D as PostgreSQL
    participant P as API

    U->>C: Enter email + password, or tap Google
    C->>A: Sign up or sign in
    A->>A: Hash and verify credentials, rate limit
    A-->>D: Create auth user, trigger creates profile with theme light
    A-->>C: Access token about 1h + rotating refresh token
    C->>C: Store session in secure storage
    C->>P: API request with Authorization Bearer token
    P->>A: Verify JWT signature and expiry
    P-->>C: Response, or 401 if invalid
    Note over C,A: Before expiry the client refreshes with the refresh token and receives a new pair
    U->>C: Log out
    C->>A: Revoke refresh token
    C->>C: Clear local session
```

---

## 4. Expense creation and splitting flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Client
    participant P as API
    participant E as core engine
    participant D as PostgreSQL

    U->>C: Enter amount, title, payer, participants, split method
    C->>E: allocate for live preview
    E-->>C: Per-person shares in paise
    U->>C: Tap Save
    C->>P: PUT expense with client UUID, payers, split inputs
    P->>P: Verify JWT, check active member
    P->>P: Validate with Zod
    P->>D: Check payers and participants belong to this trip
    P->>E: allocate again, server is the authority
    E-->>P: Final shares, sum equals amount
    P->>D: Write function: one transaction
    D->>D: Insert expense, payers, splits
    D->>D: Insert revision v1 and activity log row
    D->>D: Commit-time check: sum paid = amount, sum shares = amount
    alt Check fails or same id with different payload
        D-->>P: Error, transaction rolled back
        P-->>C: 422 or 409 with error code
    else Success
        D-->>P: Stored expense, version 1
        P-->>C: 200 with expense and server shares
        D-->>C: Realtime event to all trip members
        C->>P: Refetch balances
        P-->>C: Updated balances
    end
    Note over C,P: A retry with the same UUID returns the existing expense, no duplicate
```

---

## 5. Settlement and repayment confirmation flow

```mermaid
sequenceDiagram
    autonumber
    actor R as Rahul, debtor
    actor S as Shri, creditor
    participant C as Client
    participant P as API
    participant D as PostgreSQL
    participant U as UPI app

    R->>C: Open Settlements
    C->>P: GET settlement-plan
    P->>D: Read ledger, expenses and repayments
    P->>P: Compute nets, then greedy minimal transfers using core
    P-->>C: Rahul pays Shri 2000 rupees
    R->>C: Tap Pay
    C->>P: PUT repayment, status pending, from_suggestion true
    P->>D: Insert repayment as pending
    P-->>C: Repayment created
    C->>U: Open UPI deep link, pre-filled payee, amount, note
    R->>U: Complete payment outside TripMate
    R->>C: Tap Mark as paid
    C->>P: POST mark-paid with expectedVersion
    P->>D: UPDATE where id and status = pending
    D-->>P: 1 row updated, status paid
    Note over D: Balance projected now includes it,<br/>confirmed balance does not yet
    S->>C: Sees Rahul says paid, verifies in bank app
    S->>C: Tap Confirm
    C->>P: POST confirm
    P->>P: Check caller is the receiver
    P->>D: UPDATE where id and status = paid
    alt Already confirmed or cancelled, or double tap
        D-->>P: 0 rows updated
        P-->>C: 409 INVALID_STATE_TRANSITION, nothing double counted
    else Success
        D-->>P: status confirmed
        P-->>C: Confirmed
        D-->>C: Realtime event, balances refetched, both screens update
    end
```

State machine:

```mermaid
stateDiagram-v2
    [*] --> pending: create
    pending --> paid: payer marks paid
    paid --> confirmed: receiver confirms
    pending --> cancelled: cancel
    paid --> cancelled: cancel before confirmation
    confirmed --> [*]
    cancelled --> [*]
```

---

## 6. Mobile and web synchronization

```mermaid
sequenceDiagram
    autonumber
    participant M as Mobile app, Asha
    participant P as API
    participant D as PostgreSQL
    participant R as Realtime
    participant W as Web app, Ravi

    Note over M,W: Both signed in, both viewing Goa trip, both subscribed to trip_id changes
    M->>P: PUT expense Lunch 1200 rupees
    P->>D: Transaction commit
    D-->>M: Response with new expense and version
    D->>R: Row change on expenses, filtered by RLS
    R-->>W: Event for trip, expenses
    R-->>M: Same event, ignored if already up to date
    W->>W: Invalidate expenses, balances, summary, activity
    W->>P: Refetch balances
    P-->>W: Authoritative numbers
    W->>W: UI updates
    Note over W: If the connection drops, on reconnect or app foreground the client invalidates everything for the open trip
    W->>P: PATCH same expense with old expectedVersion
    P-->>W: 409 VERSION_CONFLICT with current version, prompt to reload
```

---

## 7. Deployment architecture

```mermaid
flowchart TB
    DEV["Developer<br/>VS Code"] -->|"git push, pull request"| GH["GitHub repository"]

    subgraph CI["GitHub Actions"]
        T["Lint, type-check, tests<br/>core, pgTAP, API, web E2E"]
        DS["Deploy staging"]
        DP["Deploy production<br/>manual approval"]
    end
    GH --> T
    T -->|"merge to develop"| DS
    DS -->|"smoke tests pass + approval"| DP

    subgraph STG["Staging"]
        VS["Vercel preview / staging web"]
        SS["Supabase staging project<br/>DB, Auth, Storage, Edge Function"]
        EP["EAS preview build<br/>internal testers"]
    end

    subgraph PRD["Production"]
        VP["Vercel production<br/>app.your-domain, HTTPS"]
        SP["Supabase production project<br/>paid plan, daily backups"]
        STORE["App Store / Play Store<br/>EAS production build + OTA updates"]
    end

    DS --> VS
    DS --> SS
    DS --> EP
    DP --> VP
    DP --> SP
    DP --> STORE

    USERS["Users"] --> VP
    USERS --> STORE
    VP --> SP
    STORE --> SP

    SP -.-> BK["Scheduled pg_dump<br/>private encrypted storage"]
    SP -.-> SEN["Sentry"]
    VP -.-> SEN
    UP["Uptime monitor"] -.-> VP
    UP -.-> SP
```
