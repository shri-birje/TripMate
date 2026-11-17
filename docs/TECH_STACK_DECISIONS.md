# TripMate — Technology Stack Decisions

Status: **Proposed (v0.1) — pending your approval.** The stack was first proposed in chat; you have not yet confirmed it, so nothing is installed. If you approve, no change is needed. If you reject a choice, this document and the other seven are updated together.

Costs below are approximate and must be re-checked on the provider's pricing page before launch.

> **Update 2026-11-17 (Milestone 0):** the project is built with **free tiers only** (your rule). Implementation changes versus this document: **npm workspaces** (not pnpm), the **API is Hono running on Node** locally and deployable to a free edge host (not Supabase Edge Functions), **Zod 4 / Vitest 5**. Paid items below (Supabase paid plan, Apple Developer, paid domain, SMS OTP) are **not used**. See ADR-019 to ADR-023 in [ARCHITECTURE_DECISIONS_LOG.md](ARCHITECTURE_DECISIONS_LOG.md). Where this document and the log disagree, the log is current.

---

## 1. Selection criteria (in priority order)

1. Ease of development and learning
2. Reliability
3. Maintainability
4. Shared business logic (mobile + web)
5. Mobile and web compatibility
6. Security
7. Reasonable development and hosting cost
8. Ability to scale

Guiding rule: **no technology is added unless it solves a real requirement.**

---

## 2. Summary

| Area | Choice | Phase |
|---|---|---|
| Language | TypeScript | MVP |
| Repo | Monorepo (pnpm workspaces) | MVP |
| Mobile + web client | Expo (React Native) + Expo Router, one universal codebase | MVP |
| Server state / caching | TanStack Query | MVP |
| Forms + validation | React Hook Form + Zod | MVP |
| Shared business logic | `packages/core` (money, splits, settlement, schemas) | MVP |
| Database | PostgreSQL via Supabase | MVP |
| Backend / API | Supabase Edge Functions with Hono (REST) + Postgres functions | MVP |
| Auth | Supabase Auth (email + Google at launch) | MVP |
| Authorization | Postgres Row-Level Security + role checks in write functions | MVP |
| Realtime | Supabase Realtime | MVP |
| File storage | Supabase Storage (private buckets) | MVP (avatars), receipts after |
| Push notifications | Expo Push Service (FCM/APNs) | Post-MVP |
| UPI | Deep links only (no payment processing) | MVP |
| Maps | Deferred; MapLibre/OSM or Google Maps when needed | Later |
| OCR / receipts | Vision-capable LLM via Edge Function, draft only | Later |
| AI assistant | Claude API, read-only tools | Later |
| Testing | Vitest, pgTAP, Playwright, Maestro | MVP / later |
| CI/CD | GitHub Actions + EAS | MVP |
| Web hosting | Vercel (static export) | MVP |
| Mobile build/distribution | EAS Build, EAS Update, then App Store / Play Store | MVP → launch |
| Monitoring | Sentry + Supabase logs + uptime check | MVP |

---

## 3. Decisions in detail

### 3.1 TypeScript (end to end)
- **What:** One language for the app, the API and the shared money logic.
- **Why:** The settlement and split code must be identical on mobile, web and server. A single language makes that a plain import rather than a re-implementation.
- **Advantages:** Shared types and validation; strong typing for money-handling code; one skill set to learn.
- **Disadvantages:** Type safety stops at the database boundary (mitigated by generated DB types and Zod validation).
- **Alternatives:** Kotlin/Swift + separate web (three codebases, rejected); Dart/Flutter (good UI but a different language from the web/API and weaker web fit for desktop layouts).
- **Cost:** none.

### 3.2 Expo (React Native) universal app for mobile **and** web
- **What:** A single React Native codebase that runs on iOS, Android and, through React Native for Web, in the browser.
- **Why:** You require two platforms with one design identity, shared accounts and shared logic. One codebase means one set of screens, one theme system and one set of bugs.
- **Advantages:** Biggest reduction in work; web and mobile cannot drift; Expo handles builds, OTA updates, push, deep links; large ecosystem and docs; good fit for a developer who wants to understand the system.
- **Disadvantages:** The web version is an app-style experience, not an SEO content site; some web polish (hover states, keyboard navigation, dense desktop tables) needs explicit effort; a few native libraries have no web equivalent (wrapped behind small adapters).
- **Alternatives considered:**
  - *Expo for mobile + Next.js for web:* better web control and SEO, but doubles UI work and splits the design system. Recommended only if SEO or a rich desktop experience becomes a priority. **This is the main choice awaiting your approval (Q-1).**
  - *Flutter (mobile + web):* strong UI toolkit, but heavier web output and a language that cannot share code with the API.
  - *PWA only:* simplest, but you asked for a real mobile app.
- **Cost:** Free framework; Apple Developer ~US$99/year and Google Play ~US$25 one-time when you publish; EAS free tier is limited in build minutes.

### 3.3 `packages/core` — shared business logic
- **What:** A plain TypeScript package (no UI, no framework dependencies) holding: money helpers, split allocation, balance computation, settlement suggestion, and Zod schemas for API contracts.
- **Why:** Financial rules must exist **once**. The apps use it for instant previews, the server uses it as the authority, and the test suite proves it.
- **Advantages:** Deterministic, easy to test exhaustively; zero platform risk.
- **Disadvantages:** Must stay free of Node-only or React-only APIs so it can also run in the Edge Function runtime (see risk R-1 in the decisions log).

### 3.4 TanStack Query + React Context + React Hook Form/Zod
- **What:** TanStack Query for server data (caching, refetch, invalidation); Context for auth/theme; React Hook Form + Zod for forms.
- **Why:** Covers loading/error states, cache invalidation from realtime events, and typed validation without a heavy global store.
- **Disadvantages:** Another concept to learn.
- **Alternatives:** Redux Toolkit/RTK Query (heavier than needed); Zustand (fine for local UI state, added only if needed).
- **Cost:** none.

### 3.5 PostgreSQL (via Supabase)
- **What:** Relational database for all data.
- **Why:** Expenses, splits and repayments are relational and must be consistent. Postgres gives transactions, foreign keys, CHECK constraints, deferred constraint triggers and Row-Level Security — exactly the tools needed to make financial corruption structurally impossible.
- **Advantages:** Mature, strongly consistent, great tooling.
- **Disadvantages:** Schema changes require migrations (a good discipline here).
- **Alternatives:** Firestore/NoSQL (weak at cross-document consistency and aggregation — rejected for financial data); MongoDB (same concern); SQLite-only (no multi-user sync).
- **Cost:** Free tier for development; a paid plan (about US$25/month) is recommended before real users, mainly for daily backups and no auto-pause.

### 3.6 Supabase as the backend platform
- **What:** Managed Postgres plus Auth, Storage, Realtime and Edge Functions in one service.
- **Why:** Gives you almost every backend building block without operating servers, while keeping a standard Postgres database (no lock-in to a proprietary data model).
- **Advantages:** Fast to start; RLS integrates with Auth; realtime works on both platforms; local development with the Supabase CLI.
- **Disadvantages:** Platform dependency (mitigated: it is open-source Postgres, so data and schema are portable); free-tier projects pause when idle; Edge Functions run on Deno (see 3.7).
- **Alternatives:** Custom Node/Express (or NestJS) + managed Postgres + separate auth/storage/realtime services (more control, much more to build and secure); Firebase (document model, see above); Appwrite/PocketBase (smaller ecosystems).
- **Cost:** see 3.5.

### 3.7 API layer: Hono REST on Supabase Edge Functions, plus Postgres write functions
- **What:** A REST API (single Edge Function, Hono router) is the only way clients **write** financial data. It validates input with Zod, runs the shared split engine, then calls a Postgres function that performs the change atomically. Simple **reads** (lists, feed) go straight to the database under RLS.
- **Why:** Gives you the REST contract you asked for, keeps one authoritative implementation of the split logic (TypeScript, not duplicated in SQL), and keeps clients away from direct financial writes (ADR-004).
- **Advantages:** One choke point for validation, authorization and auditing; stateless and cheap; shares code with `packages/core`.
- **Disadvantages:** Deno runtime and workspace-package sharing needs a spike (R-1); cold starts add small latency; two read paths (REST + direct) must be documented (they are).
- **Alternatives:** Dedicated Node API on Render/Railway/Fly (no Deno risk, simpler sharing, but one more service to run and pay for ~US$5–7/month — **the documented fallback if the spike fails**); Postgres RPC only with all logic in PL/pgSQL (duplicates the TS engine, rejected).

### 3.8 Supabase Auth
- **What:** Managed sign-up, login, sessions, password reset, OAuth.
- **Why:** Authentication is security-critical; a mature managed service is safer than a custom one.
- **Advantages:** Passwords hashed by the service (bcrypt), JWT access tokens with refresh-token rotation, Google sign-in, integrates with RLS (`auth.uid()`).
- **Disadvantages:** Phone OTP needs an SMS provider and Indian DLT registration (extra cost/setup) — deferred (Q-2).
- **Alternatives:** Clerk/Auth0 (polished, but a second paid vendor); Firebase Auth; custom JWT (rejected — unnecessary risk).

### 3.9 Supabase Realtime
- **What:** Pushes database changes to subscribed clients over WebSocket.
- **Why:** Delivers "expense added on mobile appears on web" with no extra infrastructure. Subscriptions respect RLS.
- **Design rule:** The client treats an event as a signal to **refetch**, not as truth (balances are always recomputed server-side).
- **Disadvantages:** Connection limits on free tier; reconnect logic needed (handled by invalidating queries on reconnect).

### 3.10 Supabase Storage
- **What:** File storage for avatars and receipts, with policies tied to trip membership.
- **Design:** Private buckets, short-lived signed URLs, type and size limits (JPEG/PNG/WebP/PDF, ≤ 5 MB), client-side compression.
- **Alternatives:** S3/Cloudflare R2 (cheaper at scale, more setup). Revisit if storage costs grow.

### 3.11 UPI integration
- **What:** TripMate **never touches money**. For a suggested repayment it builds a standard UPI deep link (`upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…`) so the user's UPI app opens pre-filled, and offers "copy UPI ID" as a fallback.
- **Why:** Matches the MVP rule (no money processing) and avoids payment-regulation scope.
- **Limitation:** The app cannot reliably know whether the payment succeeded; the payer marks **Paid** and the receiver **Confirms**. Some UPI apps restrict links for P2P transfers; the fallback covers this. Web cannot open UPI apps on desktop (show UPI ID/QR instead).
- **Alternatives:** Payment gateway (Razorpay etc.) — out of MVP scope, adds compliance and fees.

### 3.12 Maps and location (deferred)
- **What:** Not in the MVP; itinerary locations are free text.
- **Later options:** MapLibre with OpenStreetMap tiles (free, more setup) or Google Maps/Places (best autocomplete, paid beyond free credit).
- **Why defer:** Not required by any MVP rule; avoids an API key, cost and permissions prompt.

### 3.13 OCR and receipt extraction (deferred)
- **What:** An Edge Function sends an uploaded receipt image to a vision-capable model and returns a **draft** (amount, merchant, date, suggested category). The user must review and confirm; nothing is saved as an expense automatically.
- **Alternatives:** Google Cloud Vision / on-device ML Kit (cheaper per scan, more parsing work).
- **Cost:** Pay-per-scan.

### 3.14 AI assistant (deferred)
- **What:** Claude API with **read-only** tools that query trip data using the **user's own** credentials (so RLS applies). It explains and summarises; it has no write path and does not compute balances (rule 10).
- **Cost:** Pay-per-token; rate-limit per user.

### 3.15 Push notifications (post-MVP)
- **What:** Expo Push Service, which fronts FCM (Android) and APNs (iOS). Triggered from the server when relevant `activity_log` events occur.
- **Why:** One API for both OS targets. Web push is optional later.

### 3.16 Testing
| Layer | Tool | Focus |
|---|---|---|
| Core logic | **Vitest** (+ property-based tests with fast-check) | Splits sum exactly; Σ balances = 0; settlement zeroes everyone |
| Database | **pgTAP** (`supabase test db`) | Constraints, RLS isolation, state machine |
| API | Vitest against local Supabase | Auth, permissions, idempotency, 409 conflicts |
| Web E2E | **Playwright** | Critical journeys; mobile↔web sync |
| Mobile E2E | **Maestro** (later) | Core flows on device |

### 3.17 CI/CD
- **GitHub Actions:** lint, type-check, unit tests, DB tests on every pull request; deploy on merge.
- **EAS (Expo Application Services):** mobile builds and over-the-air JS updates.
- **Cost:** GitHub Actions free minutes are sufficient initially.

### 3.18 Hosting
- **Web:** Vercel (static export of the Expo web build, preview deployment per pull request, automatic HTTPS). Alternative: Cloudflare Pages (also free, very fast; marginally more setup). (Q-8)
- **Backend + DB + storage:** Supabase (separate projects for staging and production).
- **Mobile:** EAS Build → internal testers (APK / TestFlight) → store release.

### 3.19 Monitoring and logging
- **Sentry:** crash and error reporting for app and Edge Functions (free tier available).
- **Supabase logs:** API, Postgres and Edge Function logs.
- **Uptime check:** a free external ping on a `/health` endpoint.
- **Structured logs:** JSON with request id; **never** log tokens, passwords or full receipt contents.

---

## 4. Things deliberately not chosen (to avoid overengineering)

- Microservices, message queues, Kubernetes, GraphQL, Redis — none is needed at MVP scale.
- A separate admin dashboard, CDN configuration beyond Vercel's, or a data warehouse.
- Native modules that are not needed by an MVP feature.

---

## 5. Indicative monthly cost

| Stage | Items | Approx. cost |
|---|---|---|
| Development | Free tiers (Supabase, Vercel, GitHub, EAS, Sentry) | ~US$0 |
| Closed beta | Same, with backups handled manually (see DEPLOYMENT_ARCHITECTURE) | ~US$0 + domain (~₹700–1,000/yr) |
| Public launch | Supabase paid plan (~US$25), optional Vercel Pro, store fees (one-time/annual) | ~US$25–50 |
| Later | AI/OCR usage, push volume, storage growth | Usage-based |
