# Supabase Setup (for Milestone M2: accounts and profiles)

You do this once. It uses only free features. **You never need your Supabase or GitHub password in the code, and you never need the secret key.** Menu names in the Supabase dashboard change occasionally; if one differs slightly, look for the closest match.

## The one rule about keys

| Key | Starts with | Where it may be used |
|---|---|---|
| **Publishable** key | `sb_publishable_` | In the app (`apps/app/.env`). It is designed to be public: it can only do what the database's security rules allow. |
| **Secret** key / `service_role` | `sb_secret_` / (a long `eyJ...` code) | **Nowhere in this project yet.** It bypasses every security rule. Never put it in the app, in Git, in chat, or in a screenshot. |

The app checks this for you: if it finds a secret key in its settings, it refuses to start and shows a warning (the key is never displayed). If you ever paste a secret key somewhere public by mistake, rotate it immediately in the Supabase dashboard (Project Settings, API Keys).

## Step 1 - Copy the publishable key

1. Open your project in the Supabase dashboard.
2. **Project Settings -> API Keys** (sometimes shown under "Data API").
3. Find **Publishable key** (`sb_publishable_...`) and click copy. Do **not** copy the "Secret" key.

## Step 2 - Put it in your local settings file

The file `apps/app/.env` already exists on your computer with the project URL filled in. It is **git-ignored**, so it will never be committed.

In the VS Code terminal (from `E:\TripMate`):

```powershell
code apps\app\.env
```

Make the last line look like this (no quotes, no spaces, your real key after the `=`), then save with Ctrl+S:

```
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxx
```

Do not paste the key into chat. Nobody needs to see it.

## Step 3 - Check the connection (safe)

```powershell
npm run verify:supabase
```

It never prints your key. **Before Step 4** you should see `OK` for configuration and for the Auth service, and a `WARN` that the profiles table does not exist yet. That is expected.

## Step 4 - Create the profiles table

1. In VS Code open `supabase/migrations/20261118000000_profiles.sql`, select all (Ctrl+A) and copy (Ctrl+C).
2. Supabase dashboard -> **SQL Editor -> New query**, paste, click **Run**.
3. Expect "Success. No rows returned". It is safe to run again.

This creates the `profiles` table, makes a profile automatically at sign-up, and turns on the security rules (each person can read and edit only their own profile; signed-out visitors can do nothing).

## Step 5 - Tell Supabase where the website lives

Supabase puts a link in confirmation emails. It must point to your local website.

Dashboard -> **Authentication -> URL Configuration**:
- **Site URL:** `http://localhost:8081`
- **Redirect URLs:** add `http://localhost:8081/**`

(When the real website is deployed later, its address is added here too.)

## Step 6 - Check the sign-up settings

Dashboard -> **Authentication -> Sign In / Providers -> Email**:
- Leave **Confirm email** **ON** (people must prove they own the address).
- Set **Minimum password length** to **8** (the app already requires 8, letters and a number; this makes the server agree).

**Free-tier email limit:** Supabase's built-in email sender allows only a few emails per hour. If sign-up says "Too many emails were requested", wait a while. For quick local testing you may temporarily switch **Confirm email** off, but **switch it back on before real users**. `npm run verify:supabase` warns you if it is off.

## Step 7 - Verify again

```powershell
npm run verify:supabase
```

Expect `Result: PASSED`. It also proves two security facts from outside: a signed-out visitor cannot read or create profiles.

## Step 8 - Try the real thing

```powershell
npm run app:web
```

Open http://localhost:8081 and walk through:

1. **Create an account** (use an email you can open). Expect "Check your email".
2. Open the email, click the link. You return to the website.
3. **Sign in.** Expect "Hello, <your first name>".
4. **Profile and settings:** change your name, add a UPI ID, press **Save changes** (expect "Saved.").
5. Choose **Dark**, then **System**, then **Light**. The whole screen changes each time.
6. Reload the page: you stay signed in and the theme stays.
7. Open the app in a **second browser** and sign in: your theme choice appears there too.
8. **Sign out.** Typing `http://localhost:8081/profile` now sends you to sign-in.

## Troubleshooting

| You see | Meaning and fix |
|---|---|
| "Setup needed" screen | The key or URL in `apps/app/.env` is missing or wrong. Fix the file, then stop and restart `npm run app:web`. |
| "A SECRET Supabase key was found" | You pasted the wrong key. Replace it with the publishable key; rotate the secret one if it was ever shared. |
| "We couldn't find your profile" after signing in | Step 4 was not run (or the account was created before it). Run the SQL again; it fills in missing profiles. |
| "Too many emails were requested" | Free-tier email limit. Wait, or see Step 6. |
| Confirmation link opens a broken page | Step 5 not done, or the link was opened on a different address than `http://localhost:8081`. |
| `verify:supabase` says it cannot reach Supabase | Check internet and the URL in `.env`. |
| You edited `.env` but nothing changed | Settings are read when the app starts. Stop it (Ctrl+C) and start it again. |
