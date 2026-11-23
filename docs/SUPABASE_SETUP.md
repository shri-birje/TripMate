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

## Step 9 - Trips (added with Milestone M3.1)

M3.1 adds a second database update. **Run it after Step 4** (it needs the profiles table).

1. In VS Code open `supabase/migrations/20261118100000_trips_and_members.sql`, select all, copy.
2. Supabase dashboard -> **SQL Editor -> New query**, paste, **Run**. Expect "Success. No rows returned". It is safe to run again.
3. Check it from the outside:

   ```powershell
   npm run verify:supabase
   ```

   Section 4 should now show `OK` for: trips and members exist and signed-out visitors are denied, nobody can insert a trip directly, and `create_trip()` cannot be run by signed-out visitors.
4. Try it: `npm run app:web`, sign in, **Create a trip** (for example *Goa Trip 2026*, *Goa, India*, start `27/12/2026`, end `30/12/2026`, budget `60000`). It should appear on Home under **Upcoming** with "1 person".
5. Privacy check: sign in as a **different** account in another browser. It must **not** see the first account's trip.

If you create a trip *before* running this update, the app says "Trips aren't set up on the server yet" instead of failing mysteriously.

## Step 10 - Edit and archive trips (added with Milestone M3.3)

M3.3 adds a third database update. **Run it after Steps 4 and 9** (it needs the trips tables).

1. In VS Code open `supabase/migrations/20261118200000_trip_edit_archive.sql`, select all, copy.
2. Supabase dashboard -> **SQL Editor -> New query**, paste, **Run**. Expect "Success. No rows returned". It is safe to run again.
3. Check it from the outside:

   ```powershell
   npm run verify:supabase
   ```

   Expect `PASSED` with **0 warnings**. Section 4 now also confirms that `update_trip()`, `set_trip_archived()` and the internal helper `trip_role_of()` cannot be run by signed-out visitors. (Before this step you will see three "not available yet" warnings, which is expected.)
4. Try it: `npm run app:web`, sign in, open a trip you created, then **Edit trip** (change the name and budget, **Save changes**), then **Archive trip** (read the confirmation, confirm). Home now shows **Archived (1)**; expand it, open the trip and **Restore trip**.
5. Privacy check: in a second browser as another account, open that trip's address and its `/edit` address. Both must say "Trip not available".

If you try to edit or archive *before* running this update, the app says "Editing trips isn't set up on the server yet" instead of failing mysteriously.

## Step 11 - People and roles (added with Milestone M3.4 step b)

M3.4 step (b) adds a fourth database update. **Run it after Step 10.**

1. In VS Code open `supabase/migrations/20261118300000_member_management.sql`, select all, copy.
2. Supabase dashboard -> **SQL Editor -> New query**, paste, **Run**. Expect "Success. No rows returned". It is safe to run again. (It adds a rule that guests can never be admins, an append-only record of membership changes, a safety net that a trip always keeps an admin, and six functions.)
3. Check it from the outside:

   ```powershell
   npm run verify:supabase
   ```

   Expect `PASSED` with **0 warnings**. Section 4 now also confirms that the six member functions and their internal helper cannot be run by signed-out visitors. (Before this step you will see seven "not available yet" warnings, which is expected.)
4. Try it: `npm run app:web`, sign in, open a trip you created. Under **People**: add a friend by name, rename them, **Remove** them (read the confirmation), then expand **Former members**. With a second admin or member you cannot create yet (invitations arrive in M3.5), the role buttons and **Leave trip** can only be tried on trips where you have another admin; the screen explains why **Leave trip** is disabled when you are the only admin.
5. If you open the trip page *before* running this update, the app says "Members aren't set up on the server yet" instead of failing mysteriously.

## Step 12 - Invitations (added with Milestone M3.5; already applied on your project)

Run `supabase/migrations/20261118400000_invitations.sql` in the SQL Editor (safe to run again). It is already applied on your project; **leave that file as it is** and continue with Step 13.

## Step 13 - Approval-based joining (the M3.5 revision)

This sixth database update changes how invitation links work: **a link only lets someone ASK to join, and an admin approves each request.** **Run it after Step 12.**

1. In VS Code open `supabase/migrations/20261123000000_join_requests.sql`, select all, copy.
2. Supabase dashboard -> **SQL Editor -> New query**, paste, **Run**. Expect "Success. No rows returned". It is safe to run again. **It cancels every invitation link made before it** (people who already joined through them stay on their trips); you then make one new link per trip.
3. Check it from the outside:

   ```powershell
   npm run verify:supabase
   ```

   Expect `PASSED` with **0 warnings**. It now confirms the three new functions are closed to signed-out visitors, that `preview_invite()` still gives an empty answer for an unknown link, and that the old `accept_invite()` **no longer exists**. (Before this step you will see four warnings, which is expected.)
4. Try it with two accounts. First account: open a trip you created, **People -> Invite people -> Create invitation link** (choose how long it lasts), **Copy link**, **Done**. Second account (a private window): open the link, see the trip's name and dates, sign in or create an account, press **Request to join**. The second account sees "Request sent" and **cannot see the trip**. First account: open **Join requests (1)**, **Approve** (read the question). Only now does the trip appear on the second account's Home screen. To test a friend's place: add a friend by name, **Manage -> Invite to claim this spot**, send that link to a third account, which asks to take the place; approve it, and the friend's place becomes that account's.
5. If you try to create a link or ask to join *before* running this update, the app says "Invitations aren't set up on the server yet".
6. **Before you put TripMate in front of real users you must add rate limiting** on the invitation preview and join-request calls (ADR-054). The database does not do it.

## Step 14 - Reusable, copyable invitation link (migration #7, Supabase Vault)

This seventh database update lets an admin **copy the trip's invitation link as often as they like** (the same link every time). The link's token is kept **encrypted in Supabase Vault** (already installed on your project). **Run it after Step 13.** Do not edit the earlier files.

1. In VS Code open `supabase/migrations/20261123100000_reusable_general_link.sql`, select all, copy.
2. Supabase dashboard -> **SQL Editor -> New query**, paste, **Run**. Expect "Success. No rows returned". If it stops with a message about the Vault, do not continue: send me the message. Existing links stay valid but **cannot be copied again** (the app says so); revoke one and create a new link to get a copyable one.
3. Check the Vault permissions yourself (read-only, changes nothing). Paste and Run; **every value must be `false`**:

   ```sql
   select has_schema_privilege('anon', 'vault', 'USAGE')                          as anon_schema,
          has_schema_privilege('authenticated', 'vault', 'USAGE')                 as signed_in_schema,
          has_table_privilege('anon', 'vault.decrypted_secrets', 'SELECT')        as anon_reads_secrets,
          has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT') as signed_in_reads_secrets,
          has_table_privilege('authenticated', 'vault.secrets', 'SELECT')         as signed_in_reads_table;
   ```

   Then, also read-only, who can run the new function (expect `anon_can_run = false`, `signed_in_can_run = true`):

   ```sql
   select has_function_privilege('anon', 'public.get_general_invite_link(uuid)', 'EXECUTE')          as anon_can_run,
          has_function_privilege('authenticated', 'public.get_general_invite_link(uuid)', 'EXECUTE') as signed_in_can_run;
   ```
4. Run `npm run verify:supabase`: expect `PASSED` with **0 warnings** (it now also checks `get_general_invite_link` is closed to signed-out visitors).
5. Try it with a real admin account: **People -> Invite people -> Create invitation link**, **Done**, then press **Copy link** several times and paste each time: it is the same link. Open it in a private window to confirm it still works. **Revoke link**: Copy link disappears and the old link says it is not valid. The Vault secret is deleted too (you can confirm in the dashboard under Integrations -> Vault: no `trip-invite-...` secret remains for a revoked link).
6. Rate limiting is still required before real users (ADR-054).

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
