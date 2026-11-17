import {
  ProfileDetailsSchema,
  THEME_PREFERENCES,
  profileDetailsToRow,
  profileFromRow,
  validate,
  type Profile,
  type ProfileRow,
  type ThemePreference,
} from '@tripmate/core';

/**
 * Reading and editing the signed-in user's own profile.
 *
 * Who may do what is decided by the database (row-level security: you can see
 * and edit only your own row, and only certain columns). This code adds
 * validation and friendly errors on top; it is not the only line of defence.
 *
 * `ProfilesClient` describes only the slice of Supabase's query builder we
 * use, so tests can supply a fake. The real client is passed in through one
 * cast in profileApi.ts.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}
type Reply = PromiseLike<{ data: ProfileRow | null; error: PgError | null }>;

export interface ProfilesClient {
  from(table: 'profiles'): {
    select(columns: string): { eq(column: string, value: string): { maybeSingle(): Reply } };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): { select(): { maybeSingle(): Reply } };
    };
  };
}

export class ProfileError extends Error {
  constructor(
    public readonly kind: 'not_found' | 'network' | 'invalid' | 'forbidden' | 'unknown',
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

function toProfileError(error: PgError): ProfileError {
  if (error.code === '23514') return new ProfileError('invalid', 'Some details are not allowed. Please check them and try again.');
  if (error.code === '42501') return new ProfileError('forbidden', "You don't have permission to do that.");
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(error.message ?? '')) {
    return new ProfileError('network', "Can't reach the server. Check your internet connection and try again.");
  }
  return new ProfileError('unknown', 'Something went wrong. Please try again.');
}

export async function fetchProfile(client: ProfilesClient, userId: string): Promise<Profile> {
  let reply: Awaited<Reply>;
  try {
    reply = await client.from('profiles').select('*').eq('id', userId).maybeSingle();
  } catch (e) {
    throw toProfileError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toProfileError(reply.error);
  if (!reply.data) {
    throw new ProfileError('not_found', "We couldn't find your profile. Try signing out and back in.");
  }
  return profileFromRow(reply.data);
}

/** Saves the profile form (name, UPI ID, currency). Validates first; the theme is not part of this. */
export async function updateProfileDetails(client: ProfilesClient, userId: string, input: unknown): Promise<Profile> {
  const v = validate(ProfileDetailsSchema, input);
  if (!v.ok) throw new ProfileError('invalid', 'Please fix the highlighted fields.', v.errors);
  return runUpdate(client, userId, profileDetailsToRow(v.data));
}

/** Saves the theme choice (light / dark / system) to the account so it follows the user to other devices. */
export async function updateThemePreference(client: ProfilesClient, userId: string, theme: ThemePreference): Promise<Profile> {
  if (!(THEME_PREFERENCES as readonly string[]).includes(theme)) {
    throw new ProfileError('invalid', 'Choose Light, Dark or System.');
  }
  return runUpdate(client, userId, { theme_preference: theme });
}

async function runUpdate(client: ProfilesClient, userId: string, values: Record<string, unknown>): Promise<Profile> {
  let reply: Awaited<Reply>;
  try {
    reply = await client.from('profiles').update(values).eq('id', userId).select().maybeSingle();
  } catch (e) {
    throw toProfileError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toProfileError(reply.error);
  // No row came back: the database hid the row from us (not ours) or it does not exist.
  if (!reply.data) throw new ProfileError('not_found', "We couldn't save your changes. Try signing out and back in.");
  return profileFromRow(reply.data);
}
