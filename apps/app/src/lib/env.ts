/**
 * The ONLY place the app reads environment variables.
 *
 * Why a separate file: Expo copies EXPO_PUBLIC_* values into the app at build
 * time, but ONLY when the code reads them literally as
 * `process.env.EXPO_PUBLIC_NAME`. Reading `process.env` as a whole object (or
 * with a variable name) silently gives `undefined` in a production build.
 *
 * Everything here is PUBLIC: it ends up inside the app and website bundle and
 * anyone can read it. Never put a secret in an EXPO_PUBLIC_ variable.
 */
export interface PublicEnv {
  EXPO_PUBLIC_API_BASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
}

export const publicEnv: PublicEnv = {
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};
