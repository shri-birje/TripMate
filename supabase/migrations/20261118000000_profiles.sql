-- ============================================================================
-- TripMate migration 20261118000000: user profiles (Milestone M2)
--
-- WHAT THIS DOES
--   1. Creates public.profiles: one row per account (name, UPI ID, currency,
--      theme preference). Credentials stay in Supabase's own auth.users table.
--   2. Creates a profile automatically whenever someone signs up.
--   3. Turns on Row-Level Security so a signed-in user can read and edit ONLY
--      their own row, and signed-out visitors can do nothing.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste this whole
-- file -> Run. It is safe to run more than once.
-- ============================================================================

create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  display_name       text not null
                       constraint profiles_display_name_length check (char_length(display_name) between 1 and 60),
  avatar_path        text,
  upi_id             text
                       constraint profiles_upi_id_format check (
                         upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$'
                       ),
  preferred_currency char(3) not null default 'INR'
                       constraint profiles_currency_format check (preferred_currency ~ '^[A-Z]{3}$'),
  theme_preference   text not null default 'light'
                       constraint profiles_theme_values check (theme_preference in ('light', 'dark', 'system')),
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.profiles is 'One row per TripMate account. Created by trigger at sign-up.';
comment on column public.profiles.theme_preference is 'light is the default for new users (product requirement).';

-- ---------------------------------------------------------------------------
-- Keep updated_at honest: the database sets it, never the client.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Create the profile when an account is created.
-- SECURITY DEFINER = runs with the owner's rights, because the new user has no
-- permission to insert profiles themselves (by design). search_path is pinned
-- to prevent a classic privilege-escalation trick.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'Traveller'
      ),
      60
    )
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts created BEFORE this migration was applied have no profile yet.
-- Give each of them one (does nothing for accounts that already have one).
insert into public.profiles (id, display_name)
select
  u.id,
  left(
    coalesce(
      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Traveller'
    ),
    60
  )
from auth.users u
on conflict (id) do nothing;

-- Nobody should be able to call these directly from the app.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Security: Row-Level Security + minimal permissions.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Supabase grants broad default permissions on new tables. Remove them all,
-- then grant back only what the app needs:
--   * signed-in users may READ (their own row, via the policy above)
--   * signed-in users may UPDATE only these editable columns (never id,
--     created_at, deleted_at)
--   * nobody can INSERT or DELETE from the app; the sign-up trigger creates
--     rows and deleting an account removes the profile automatically
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_path, upi_id, preferred_currency, theme_preference)
  on public.profiles to authenticated;
