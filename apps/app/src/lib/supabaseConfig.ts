/**
 * Validates the Supabase settings the app is given - and refuses dangerous ones.
 *
 * The app is allowed exactly ONE kind of Supabase key: the PUBLISHABLE key
 * (starts with "sb_publishable_"; older projects call it the "anon" key).
 * It is designed to be public: it can only do what the database's row-level
 * security rules allow.
 *
 * A SECRET key (starts with "sb_secret_") or a legacy "service_role" key
 * bypasses all those rules. If one ever ends up in app code, anyone who opens
 * the website could read or delete every user's data. So we detect it and
 * refuse to start.
 *
 * Messages never contain the key itself.
 */
export type KeyKind = 'publishable' | 'legacy_anon' | 'secret' | 'service_role' | 'unknown';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function classifySupabaseKey(key: string): KeyKind {
  const k = key.trim();
  if (k.startsWith('sb_publishable_')) return 'publishable';
  if (k.startsWith('sb_secret_')) return 'secret';
  const payload = decodeJwtPayload(k);
  if (payload?.role === 'anon') return 'legacy_anon';
  if (payload?.role === 'service_role') return 'service_role';
  return 'unknown';
}

export type SupabaseConfigResult =
  | { ok: true; url: string; key: string; keyKind: 'publishable' | 'legacy_anon' }
  | {
      ok: false;
      reason: 'missing_url' | 'missing_key' | 'invalid_url' | 'secret_key_in_frontend' | 'unrecognized_key';
      message: string;
    };

export interface SupabaseEnv {
  EXPO_PUBLIC_SUPABASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
}

function isAcceptableUrl(u: URL): boolean {
  if (u.protocol === 'https:') return u.hostname.endsWith('.supabase.co');
  // Plain http is only acceptable for a Supabase instance on this computer.
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

export function readSupabaseConfig(env: SupabaseEnv): SupabaseConfigResult {
  const rawUrl = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const rawKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!rawUrl) {
    return { ok: false, reason: 'missing_url', message: 'EXPO_PUBLIC_SUPABASE_URL is not set in apps/app/.env' };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url', message: 'EXPO_PUBLIC_SUPABASE_URL is not a valid web address' };
  }
  if (!isAcceptableUrl(url)) {
    return {
      ok: false,
      reason: 'invalid_url',
      message: 'EXPO_PUBLIC_SUPABASE_URL must look like https://<project-ref>.supabase.co',
    };
  }
  if (!rawKey) {
    return {
      ok: false,
      reason: 'missing_key',
      message: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set in apps/app/.env',
    };
  }

  const kind = classifySupabaseKey(rawKey);
  if (kind === 'secret' || kind === 'service_role') {
    return {
      ok: false,
      reason: 'secret_key_in_frontend',
      message:
        'A SECRET Supabase key was found in the app settings. Remove it immediately and use the PUBLISHABLE key instead. ' +
        'If this key was ever committed or shared, rotate it in the Supabase dashboard.',
    };
  }
  if (kind === 'unknown') {
    return {
      ok: false,
      reason: 'unrecognized_key',
      message: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY does not look like a Supabase publishable key (sb_publishable_...)',
    };
  }

  return { ok: true, url: `${url.origin}`, key: rawKey, keyKind: kind };
}
