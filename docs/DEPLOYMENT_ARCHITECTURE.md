# TripMate — Deployment Architecture

Status: **Proposed (v0.1) — pending approval.** Nothing is deployed; no accounts have been created.

> **Update 2026-11-17:** free-only rule and Milestone 0 changes apply. The API deploys as a Hono app to a free edge host (not a Supabase Edge Function); production starts on Supabase's **free** tier with scheduled manual backups (no paid plan); iOS store distribution is out of scope (needs a paid Apple account); the web app uses a free `*.vercel.app` or `*.pages.dev` URL until you choose to buy a domain. See ADR-019 to ADR-023 in [ARCHITECTURE_DECISIONS_LOG.md](ARCHITECTURE_DECISIONS_LOG.md). Where this document and the log disagree, the log is current.

Objective: a **real, internet-accessible application** — a live website and installable mobile builds — not a localhost demo. No deployment is called successful until its live URL has been opened and exercised end to end.

---

## 1. Environments

| | **Development** | **Staging (preview)** | **Production** |
|---|---|---|---|
| Purpose | Daily coding | Test merged changes with real hosting, safe data | Real users |
| Backend / DB | Local Supabase via CLI (Docker) | Separate Supabase project | Separate Supabase project |
| Web | Local dev server | Vercel preview deployment per pull request + a stable staging URL | Vercel production |
| Mobile | Expo dev client / Expo Go | EAS "preview" build channel (internal testers) | EAS "production" channel → stores |
| Data | Seed/fake data | Fake data only | Real data |
| Keys/secrets | Local `.env` (git-ignored) | Staging secrets | Production secrets |
| Deploy trigger | — | Every pull request / merge to `develop` | Manual approval after staging passes, from `main` |

Rules:
- The three environments **never share** databases, Auth users, storage buckets or keys.
- Every environment is created **only** by applying the repository's migrations — no manual dashboard schema edits.
- Localhost success is not evidence of production readiness; each release is verified on staging (live URL) before production.

---

## 2. Deployment topology

```
Users ─► Browser ─► https://app.<your-domain>      (Vercel, static Expo web build, CDN)
Users ─► Phone   ─► Store/TestFlight app ─────────┐
                                                   ├─► https://<project>.supabase.co
Web ──────────────────────────────────────────────┘      ├─ Auth
                                                           ├─ REST/Realtime (Postgres)
                                                           ├─ Edge Function: /api/v1
                                                           └─ Storage (private buckets)
Errors ─► Sentry        Uptime ping ─► /api/v1/health
```

(Diagram version in [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md).)

---

## 3. Component deployment

### 3.1 Website
- Build: Expo web **static export** (`expo export --platform web`).
- Host: **Vercel** (free tier initially): global CDN, automatic HTTPS, preview URL per pull request, instant rollback. Alternative: Cloudflare Pages (Q-8).
- SPA routing fallback to `index.html`; security headers (CSP, HSTS, etc.) configured in the host's config file.

### 3.2 Backend (API)
- Supabase Edge Function `api`, deployed from `supabase/functions/api` via the Supabase CLI in CI.
- Secrets set per environment with `supabase secrets set` (service-role key, etc.).
- Health endpoint `/health` for monitoring.
- **Fallback:** if the Deno/shared-package spike fails (risk R-1), the same Hono app deploys as a small Node service on Render/Railway/Fly (~US$5–7/month); client code is unchanged because only the base URL differs.

### 3.3 Database
- Managed PostgreSQL in the Supabase project; schema from `supabase/migrations`, applied by CI (`supabase db push`) to staging, then production after approval.
- Region: closest to Indian users (verify Mumbai/Singapore availability) — Q-9.
- Connection pooling: use Supabase's pooler for Edge Functions.
- **Production uses a paid plan** before real users: no auto-pause, daily backups.

### 3.4 File storage
- Supabase Storage private buckets `avatars` and `receipts`, with policies from migrations; identical per environment.

### 3.5 Domain and HTTPS
- Register one domain (name pending — Q-8).
- `app.<domain>` → Vercel (HTTPS certificate automatic). Optional `staging.<domain>`.
- API stays on the Supabase-provided HTTPS URL initially (custom API domain is a paid add-on; later `api.<domain>`).
- **Invite links** `https://app.<domain>/join/<token>` must open the **app** when installed, via:
  - iOS: Associated Domains + `/.well-known/apple-app-site-association`
  - Android: App Links + `/.well-known/assetlinks.json`
  both hosted on the web domain. Without this, WhatsApp invite links only open the website.
- Email deliverability for auth emails: configure a custom SMTP sender (e.g. a transactional email provider) with SPF/DKIM on the domain, since default Supabase email has strict rate limits.

### 3.6 Mobile distribution
| Stage | Method |
|---|---|
| Early testing | EAS internal distribution: Android APK link; iOS needs Apple Developer membership (TestFlight) |
| Beta | Google Play internal/closed testing; TestFlight |
| Launch | Play Store (~US$25 one-time) and App Store (~US$99/year) |
| Hotfixes | EAS Update (over-the-air JS changes; native changes need a new build and store review) |

Store requirements to plan for: privacy policy URL, in-app account deletion, data-safety/nutrition-label forms, app icons/screenshots, reviewer demo account.

---

## 4. Environment variables and secrets

| Variable | Where used | Public? | Stored in |
|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | App/web | Yes | EAS env, Vercel env, local `.env` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | App/web | Yes (RLS-protected) | same |
| `EXPO_PUBLIC_API_BASE_URL` | App/web | Yes | same |
| `EXPO_PUBLIC_SENTRY_DSN` | App/web | Yes | same |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function only | **No** | Supabase secrets |
| `SENTRY_AUTH_TOKEN` | CI source-map upload | **No** | GitHub secrets |
| `EXPO_TOKEN`, `VERCEL_TOKEN`, `SUPABASE_ACCESS_TOKEN` | CI | **No** | GitHub secrets |
| AI/OCR keys (later) | Edge Function only | **No** | Supabase secrets |

Anything prefixed `EXPO_PUBLIC_` is embedded in the app bundle and **must be treated as public**. Only `.env.example` (names, no values) is committed.

---

## 5. CI/CD pipeline

```
Pull request
  → install → lint → type-check → unit tests (core) → DB tests (pgTAP on local Supabase)
  → API tests → web build → Playwright smoke tests
  → Vercel preview URL commented on the PR
Merge to develop
  → apply migrations to STAGING → deploy Edge Function to STAGING → deploy staging web
  → EAS preview build (when native changes)
Release (manual approval)
  → apply migrations to PRODUCTION → deploy function → deploy web → EAS production build/update
  → post-deploy smoke test against the live production URL
```

Controls: `main` protected (reviews + passing checks required); migrations run before code that depends on them and are written backward-compatible for one release; rollbacks use Vercel instant rollback, redeploy of the previous function version, and forward-fix migrations (no destructive down-migrations in production).

---

## 6. Monitoring, logging and maintenance

| Need | Tool | Notes |
|---|---|---|
| Crash/error reporting | Sentry (app, web, Edge Function) | Alert on new error types and spikes |
| API and DB logs | Supabase dashboard logs | Structured JSON with request id |
| Uptime | External free monitor on `/health` and the web URL | Notify by email/phone |
| Performance | Sentry performance traces (sampled), Supabase query stats | Check slow queries monthly |
| Usage/cost | Provider dashboards | Budget alerts |
| Dependency health | Dependabot + CI audit | Weekly review |

Maintenance routine: weekly dependency PRs, monthly backup-restore drill (staging), quarterly key rotation, review of slow queries and storage growth.

---

## 7. Backups and recovery

| Stage | Approach |
|---|---|
| Development | Reproducible from migrations + seed |
| Beta on free tier | No managed backups → **scheduled `pg_dump`** via GitHub Actions to private storage (encrypted), plus storage-bucket export |
| Production (paid plan) | Supabase daily backups (point-in-time recovery add-on optional) + the scheduled dump as a second copy |
| Restore test | Restore into a scratch project and verify balances reconcile **before launch** and then monthly |

Recovery targets (initial, informal): lose at most 24 h of data; restore within a few hours.

---

## 8. Cost evolution

| Phase | Setup | Approx. monthly |
|---|---|---|
| Build/test | Free tiers, local Supabase | ~US$0 |
| Closed beta | Free Supabase staging + prod, Vercel free, Sentry free, domain | ~US$0 + domain |
| Launch | Supabase paid (prod), store fees, SMTP provider | ~US$25–45 |
| Growth | Supabase compute upgrade, Vercel Pro, push/AI/OCR usage, R2/S3 if storage grows | Usage-based |

Evolution path without redesign: add read replica/caching, move API to a dedicated service, move files to R2/S3, add queues for notifications/OCR.

---

## 9. Go-live checklist (used in the deployment milestone)

1. Production Supabase project created; migrations applied; RLS tests pass against it.
2. Secrets set; no secrets in the repository (scan clean).
3. Auth: email provider configured, Google OAuth redirect URLs set for staging and production.
4. Web deployed; HTTPS valid; security headers present; custom domain resolves.
5. Invite deep links verified on a real iOS and Android device.
6. Two real accounts on two devices: create trip → add expense on phone → appears on web → settle → confirm.
7. Backups configured and a restore drill completed.
8. Monitoring, alerts and uptime checks live; a test error reaches Sentry.
9. Privacy policy and terms published; account deletion works.
10. **Live URLs opened and verified before anything is reported as deployed.**
