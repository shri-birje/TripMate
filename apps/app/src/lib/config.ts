import { publicEnv, type PublicEnv } from './env';

/**
 * App configuration. Values come from EXPO_PUBLIC_* environment variables
 * (see env.ts). These are PUBLIC: never read secrets here.
 */
const DEFAULT_API_BASE_URL = 'http://localhost:8787';

export function getApiBaseUrl(env: PublicEnv = publicEnv): string {
  const raw = env.EXPO_PUBLIC_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, ''); // remove trailing slashes
}
