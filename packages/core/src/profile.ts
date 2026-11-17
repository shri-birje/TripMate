import { z } from 'zod';

/**
 * Rules for accounts and profiles. Used by the app's forms now and by the API
 * later, so both sides always agree. The database enforces the same limits
 * independently (see supabase/migrations) as a second line of defence.
 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light'; // product rule: Light is the default

export const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export const DISPLAY_NAME_MAX = 60;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // longer passwords are silently cut short by the hashing method used by Supabase

// Same pattern as the profiles_upi_id_format check in the database.
const UPI_PATTERN = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$/;
// Control characters (tabs, newlines, invisible junk) have no place in a name.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, { error: `Use at least ${PASSWORD_MIN} characters` })
  .max(PASSWORD_MAX, { error: `Use at most ${PASSWORD_MAX} characters` })
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), { error: 'Include at least one letter and one number' });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Enter your name' })
  .max(DISPLAY_NAME_MAX, { error: `Name can be at most ${DISPLAY_NAME_MAX} characters` })
  .refine((n) => !CONTROL_CHARS.test(n), { error: 'Name contains characters that are not allowed' });

/** Optional UPI ID: blank means "none". Stored as null. */
export const upiIdSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.string().regex(UPI_PATTERN, { error: 'UPI ID looks like name@bank' }).nullable());

export const SignUpSchema = z
  .object({
    displayName: displayNameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    path: ['password'],
    error: 'Password must be different from your email',
  });
export type SignUpInput = z.infer<typeof SignUpSchema>;

export const SignInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: 'Enter your password' }),
});
export type SignInInput = z.infer<typeof SignInSchema>;

export const ProfileUpdateSchema = z.object({
  displayName: displayNameSchema,
  upiId: upiIdSchema,
  preferredCurrency: z.enum(SUPPORTED_CURRENCIES, { error: 'Choose a currency from the list' }),
  themePreference: z.enum(THEME_PREFERENCES),
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

/** The profile form (name, UPI ID, currency). The theme is saved separately, the moment it is chosen. */
export const ProfileDetailsSchema = ProfileUpdateSchema.omit({ themePreference: true });
export type ProfileDetails = z.infer<typeof ProfileDetailsSchema>;

export interface Profile {
  id: string;
  displayName: string;
  upiId: string | null;
  avatarPath: string | null;
  preferredCurrency: string;
  themePreference: ThemePreference;
  createdAt: string;
  updatedAt: string;
}

/** The profiles table row, exactly as the database returns it. */
export interface ProfileRow {
  id: string;
  display_name: string;
  upi_id: string | null;
  avatar_path: string | null;
  preferred_currency: string;
  theme_preference: string;
  created_at: string;
  updated_at: string;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Database row -> app object. An unknown theme value falls back to the default instead of breaking the app. */
export function profileFromRow(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    upiId: row.upi_id,
    avatarPath: row.avatar_path,
    preferredCurrency: row.preferred_currency.trim(),
    themePreference: isThemePreference(row.theme_preference) ? row.theme_preference : DEFAULT_THEME_PREFERENCE,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function profileDetailsToRow(details: ProfileDetails) {
  return {
    display_name: details.displayName,
    upi_id: details.upiId,
    preferred_currency: details.preferredCurrency,
  };
}

/** Validated edits -> the column names the database expects. Only editable columns can appear here. */
export function profileUpdateToRow(update: ProfileUpdate) {
  return {
    display_name: update.displayName,
    upi_id: update.upiId,
    preferred_currency: update.preferredCurrency,
    theme_preference: update.themePreference,
  };
}
