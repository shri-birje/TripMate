# TripMate

Group travel and shared-expense management for Indian travellers. One backend and one codebase serving a mobile app and a responsive website. TripMate never holds or moves money; repayments happen in external UPI apps and are only tracked here.

Planning and design documents are in [docs/](docs/). Start with [docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md).

## Repository layout

```
apps/
  api/        REST API (Hono + TypeScript)
  app/        Expo app: iOS, Android and web from one codebase
packages/
  core/       Shared business logic and API contracts (no UI)
docs/         Architecture, decisions, progress
```

## Requirements
- Node.js 20 or newer (Node 24 is used in development)
- npm (comes with Node)
- Everything used is free.

## First-time setup
```powershell
npm install
```

## Everyday commands (run from the repository root)

| Command | What it does |
|---|---|
| `npm run api:dev` | Start the API at http://localhost:8787 (restarts on change) |
| `npm run app:web` | Start the website at http://localhost:8081 |
| `npm run app:start` | Start Expo (press `a` for Android emulator, or scan the QR code with Expo Go) |
| `npm run typecheck` | Type-check every package |
| `npm test` | Run every test (core, API, app, database rules) |
| `npm run ui:check` | Real-browser run of sign-up, sign-in, profile and themes (simulated Supabase; takes a few minutes) |
| `npm run verify:supabase` | Check your Supabase project is connected and secured (never prints keys) |

## Configuration
Accounts need a free Supabase project. Follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md): it covers the publishable key, `apps/app/.env`, the one SQL step and the dashboard settings.

Real `.env` files are git-ignored. **Never commit secrets.** Variables beginning with `EXPO_PUBLIC_` are visible to anyone who opens the app or website, so they may hold only public values (the Supabase *publishable* key is fine; a *secret* key must never go there, and the app refuses to start if it finds one).

## Checking that it works
1. `npm run app:web`, open http://localhost:8081. With no Supabase key yet you will see a clear "Setup needed" screen; after setup you will see sign-in.
2. `npm run api:dev` and http://localhost:8787/v1/health still work (the API is not used by accounts yet).
